import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  ServiceUnavailableException,
  ConflictException,
  BadRequestException,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import { Pool, type PoolClient } from "pg";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { tenantRoles, type TenantRole } from "@ake/contracts";
import { FieldCipher } from "../common/crypto";
import { tenantPool } from "./pool";
import {
  currentTenant,
  saasEnabled,
  tenantContext,
  type TenantContext,
} from "./context";

export const digest = (s: string) =>
  createHash("sha256").update(s).digest("hex");
export function checkServiceUrl(raw: string) {
  const url = new URL(raw);
  const allowed = (process.env.SAAS_CHATWOOT_ORIGINS || "")
    .split(",")
    .filter(Boolean);
  const test =
    process.env.NODE_ENV !== "production" &&
    process.env.SAAS_TEST_MODE === "true" &&
    ["127.0.0.1", "localhost"].includes(url.hostname);
  if ((!allowed.includes(url.origin) || url.protocol !== "https:") && !test)
    throw new BadRequestException("chatwoot_origin_not_allowed");
  if (url.username || url.password || url.search || url.hash)
    throw new BadRequestException("invalid_service_url");
  return url.origin;
}

@Injectable()
export class TenantsService implements OnApplicationBootstrap, OnModuleDestroy {
  readonly control?: Pool;
  readonly scoped?: Pool;
  constructor() {
    if (saasEnabled()) {
      if (
        !process.env.DATABASE_URL ||
        !process.env.FIELD_ENCRYPTION_KEY ||
        process.env.STORE_DRIVER !== "postgres"
      )
        throw new Error("SaaS requires PostgreSQL and a field encryption key");
      new FieldCipher(process.env.FIELD_ENCRYPTION_KEY);
      this.control = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: 4,
      });
      this.scoped = tenantPool({
        connectionString: process.env.DATABASE_URL,
        max: 8,
      });
    }
  }
  get registry() {
    if (!this.control) throw new ServiceUnavailableException("saas_disabled");
    return this.control;
  }
  get db() {
    if (!this.scoped) throw new ServiceUnavailableException("saas_disabled");
    return this.scoped;
  }
  cipher(workspace: string) {
    return new FieldCipher(
      createHmac("sha256", process.env.FIELD_ENCRYPTION_KEY || "")
        .update("saas:" + workspace)
        .digest("hex"),
    );
  }
  seal(workspace: string, value: unknown) {
    return this.cipher(workspace).encrypt(JSON.stringify(value));
  }
  unseal(workspace: string, value?: string | null): any {
    return value ? JSON.parse(this.cipher(workspace).decrypt(value)) : {};
  }
  async onApplicationBootstrap() {
    if (!saasEnabled()) return;
    const role = (
      await this.registry.query(
        "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
      )
    ).rows[0];
    if (role.rolsuper || role.rolbypassrls)
      throw new Error("SaaS runtime role must not bypass row security");
    const missing = (
      await this.registry
        .query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' AND (EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='workspace_id')
        OR ((c.relname LIKE 'inbox_v2_%' OR c.relname LIKE 'marketing_%') AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='account_id')))
      AND c.relname NOT IN ('saas_tenants','saas_members','saas_sessions','saas_invitations','saas_login_attempts')
      AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity OR pg_get_userbyid(c.relowner)=current_user)`)
    ).rows;
    if (missing.length)
      throw new Error("SaaS RLS deployment prerequisite failed");
  }
  async bySlug(slug: string) {
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug))
      throw new UnauthorizedException("organization_unavailable");
    const row = (
      await this.registry.query(
        "SELECT t.*,w.name FROM saas_tenants t JOIN workspaces w ON w.id=t.workspace_id WHERE t.slug=$1 AND t.enabled=true",
        [slug],
      )
    ).rows[0];
    if (!row) throw new UnauthorizedException("organization_unavailable");
    return row;
  }
  fromRow(row: any, userId: string, role: TenantRole): TenantContext {
    return {
      workspaceId: row.workspace_id,
      accountId: Number(row.chatwoot_account_id),
      userId,
      role,
      slug: row.slug,
      name: row.name,
      chatwootUrl: checkServiceUrl(row.chatwoot_url),
      effectiveFrom: new Date(row.effective_from).toISOString(),
      settings: row.settings || {},
    };
  }
  async fetchChatwoot(
    actor: TenantContext,
    path: string,
    init: RequestInit = {},
  ) {
    const headers = {
      "content-type": "application/json",
      ...(actor.credentials || {}),
      ...(init.headers || {}),
    };
    const response = await fetch(checkServiceUrl(actor.chatwootUrl) + path, {
      ...init,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403)
        throw new UnauthorizedException("chatwoot_access_revoked");
      throw new ServiceUnavailableException("chatwoot_unavailable");
    }
    if (actor.credentials && actor.sessionHash) {
      for (const key of ["access-token", "client", "uid", "token-type"]) {
        const value = response.headers.get(key);
        if (value) actor.credentials[key] = value;
      }
      await this.registry.query(
        "UPDATE saas_sessions SET credentials=$2 WHERE token_hash=$1",
        [actor.sessionHash, this.seal(actor.workspaceId, actor.credentials)],
      );
    }
    return response.json();
  }
  async login(input: any) {
    const slug = String(input.slug || ""),
      email = String(input.email || "")
        .trim()
        .toLowerCase(),
      password = String(input.password || "");
    if (!email || email.length > 254 || !password || password.length > 1024)
      throw new UnauthorizedException("invalid_login");
    const row = await this.bySlug(slug),
      hash = digest(email);
    const count = (
      await this.registry.query(
        `INSERT INTO saas_login_attempts VALUES($1,$2,1,now()) ON CONFLICT(workspace_id,identity_hash)
      DO UPDATE SET count=CASE WHEN saas_login_attempts.started_at<now()-interval '1 minute' THEN 1 ELSE saas_login_attempts.count+1 END,
      started_at=CASE WHEN saas_login_attempts.started_at<now()-interval '1 minute' THEN now() ELSE saas_login_attempts.started_at END RETURNING count`,
        [row.workspace_id, hash],
      )
    ).rows[0].count;
    if (count > 8) throw new ForbiddenException("login_rate_limited");
    const response = await fetch(
      checkServiceUrl(row.chatwoot_url) + "/auth/sign_in",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok) throw new UnauthorizedException("invalid_login");
    const profile = ((await response.json()) as any).data;
    if (
      !profile?.accounts?.some(
        (a: any) => Number(a.id) === Number(row.chatwoot_account_id),
      )
    )
      throw new ForbiddenException("organization_membership_required");
    const uid = String(profile.id),
      credentials: Record<string, string> = {};
    for (const key of ["access-token", "client", "uid", "token-type"]) {
      const value = response.headers.get(key);
      if (value) credentials[key] = value;
    }
    if (!credentials["access-token"])
      throw new UnauthorizedException("session_unavailable");
    if (input.invitation) {
      const client = await this.registry.connect();
      try {
        await client.query("BEGIN");
        const invitation = (
          await client.query(
            "UPDATE saas_invitations SET accepted_at=now() WHERE token_hash=$1 AND workspace_id=$2 AND user_id=$3 AND accepted_at IS NULL AND expires_at>now() RETURNING role",
            [digest(String(input.invitation)), row.workspace_id, uid],
          )
        ).rows[0];
        if (!invitation) throw new ForbiddenException("invitation_invalid");
        await client.query(
          "INSERT INTO saas_members(workspace_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role,active=true",
          [row.workspace_id, uid, invitation.role],
        );
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    }
    const member = (
      await this.registry.query(
        "SELECT role FROM saas_members WHERE workspace_id=$1 AND user_id=$2 AND active",
        [row.workspace_id, uid],
      )
    ).rows[0];
    if (!member) throw new ForbiddenException("invitation_required");
    const token = randomBytes(32).toString("hex");
    await this.registry.query(
      "INSERT INTO saas_sessions VALUES($1,$2,$3,$4,now()+interval '8 hours')",
      [
        digest(token),
        row.workspace_id,
        uid,
        this.seal(row.workspace_id, credentials),
      ],
    );
    await this.registry.query(
      "DELETE FROM saas_login_attempts WHERE workspace_id=$1 AND identity_hash=$2",
      [row.workspace_id, hash],
    );
    return {
      token,
      slug,
      name: row.name,
      role: member.role,
      userId: uid,
      accountId: Number(row.chatwoot_account_id),
    };
  }
  async authenticate(token: string): Promise<TenantContext> {
    if (!/^[a-f0-9]{64}$/.test(token))
      throw new UnauthorizedException("sign_in_required");
    const hash = digest(token),
      row = (
        await this.registry.query(
          `SELECT t.*,w.name,s.user_id,s.credentials,m.role FROM saas_sessions s
      JOIN saas_tenants t USING(workspace_id) JOIN workspaces w ON w.id=t.workspace_id
      JOIN saas_members m ON m.workspace_id=s.workspace_id AND m.user_id=s.user_id
      WHERE s.token_hash=$1 AND s.expires_at>now() AND t.enabled AND m.active`,
          [hash],
        )
      ).rows[0];
    if (!row) throw new UnauthorizedException("session_expired");
    const actor = this.fromRow(row, row.user_id, row.role);
    actor.credentials = this.unseal(row.workspace_id, row.credentials);
    actor.sessionHash = hash;
    const profile = await this.fetchChatwoot(actor, "/api/v1/profile");
    if (
      String(profile.id) !== actor.userId ||
      !profile.accounts?.some((a: any) => Number(a.id) === actor.accountId)
    )
      throw new ForbiddenException("organization_membership_revoked");
    return actor;
  }
  async logout() {
    const a = currentTenant();
    await this.registry.query("DELETE FROM saas_sessions WHERE token_hash=$1", [
      a.sessionHash,
    ]);
    return { ok: true };
  }
  async requireOwner(id: string) {
    if (
      !(
        await this.registry.query(
          "SELECT 1 FROM saas_members WHERE workspace_id=$1 AND user_id=$2 AND active",
          [currentTenant().workspaceId, id],
        )
      ).rowCount
    )
      throw new BadRequestException("owner_not_a_member");
  }
  requireRole(...roles: TenantRole[]) {
    if (!roles.includes(currentTenant().role))
      throw new ForbiddenException("role_not_allowed");
  }
  async transaction<T>(fn: (c: PoolClient) => Promise<T>) {
    const c = await this.db.connect();
    try {
      await c.query("BEGIN");
      const result = await fn(c);
      await c.query("COMMIT");
      return result;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async once(key: string, input: unknown, fn: (c: PoolClient) => Promise<any>) {
    const a = currentTenant(),
      hash = digest(JSON.stringify(input));
    return this.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        a.workspaceId + ":" + key,
      ]);
      const old = (
        await c.query(
          "SELECT * FROM saas_operations WHERE workspace_id=$1 AND operation_key=$2",
          [a.workspaceId, key],
        )
      ).rows[0];
      if (old) {
        if (old.request_hash !== hash)
          throw new ConflictException("idempotency_conflict");
        return old.result;
      }
      const result = await fn(c);
      await c.query(
        "INSERT INTO saas_operations(workspace_id,operation_key,request_hash,result) VALUES($1,$2,$3,$4)",
        [a.workspaceId, key, hash, result],
      );
      return result;
    });
  }
  async forEachTenant(fn: () => Promise<void>) {
    const rows = (
      await this.registry.query(
        "SELECT t.*,w.name FROM saas_tenants t JOIN workspaces w ON w.id=t.workspace_id WHERE t.enabled",
      )
    ).rows;
    for (const row of rows) {
      try {
        const actor = this.fromRow(row, "system:tenant-worker", "admin");
        actor.system = true;
        await tenantContext.run(actor, fn);
      } catch {
        /* Isolate failures. Sync/task state remains queryable in that tenant. */
      }
    }
  }
  async secretSettings() {
    const a = currentTenant();
    const row = (
      await this.registry.query(
        "SELECT secrets FROM saas_tenants WHERE workspace_id=$1",
        [a.workspaceId],
      )
    ).rows[0];
    return this.unseal(a.workspaceId, row?.secrets);
  }
  async members() {
    return (
      await this.registry.query(
        "SELECT user_id,role,active FROM saas_members WHERE workspace_id=$1 ORDER BY user_id",
        [currentTenant().workspaceId],
      )
    ).rows;
  }
  async status() {
    const a = currentTenant();
    const usage = (
      await this.db.query(
        `SELECT
      (SELECT count(*) FROM crm_ingestion_receipts WHERE workspace_id=$1 AND state='persisted' AND received_at>=date_trunc('month',now()))::int AS inquiries,
      (SELECT count(*) FROM crm_ai_suggestions WHERE workspace_id=$1 AND created_at>=date_trunc('month',now()))::int AS ai,
      (SELECT count(*) FROM ad_connections WHERE workspace_id=$1)::int AS ad_accounts,
      (SELECT count(*) FROM crm_outbound WHERE workspace_id=$1 AND state IN ('review','dispatching'))::int AS outbound_review,
      (SELECT count(*) FROM crm_tasks WHERE workspace_id=$1 AND status='open' AND due_at<now())::int AS overdue,
      (SELECT count(*) FROM leads WHERE workspace_id=$1 AND status='new')::int AS pending_inquiries`,
        [a.workspaceId],
      )
    ).rows[0];
    return {
      usage,
      limits: {
        inquiries: a.settings.monthlyInquiryLimit || 10000,
        ai: a.settings.monthlyAiLimit || 1000,
        adAccounts: a.settings.adAccountLimit || 10,
      },
      effectiveFrom: a.effectiveFrom,
    };
  }
  async invite(userId: string, role: TenantRole) {
    this.requireRole("admin");
    if (!tenantRoles.includes(role))
      throw new BadRequestException("invalid_role");
    const a = currentTenant(),
      users = await this.fetchChatwoot(
        a,
        `/api/v1/accounts/${a.accountId}/agents`,
      );
    if (
      !Array.isArray(users) ||
      !users.some((u: any) => String(u.id) === userId)
    )
      throw new BadRequestException("invite_user_to_chatwoot_account_first");
    const token = randomBytes(32).toString("hex");
    await this.registry.query(
      "INSERT INTO saas_invitations VALUES($1,$2,$3,$4,now()+interval '7 days',NULL)",
      [digest(token), a.workspaceId, userId, role],
    );
    return { invitation: token, userId, role, expiresInDays: 7 };
  }
  async updateMember(userId: string, role: TenantRole, active: boolean) {
    this.requireRole("admin");
    const a = currentTenant();
    if (userId === a.userId && (!active || role !== "admin"))
      throw new ConflictException("cannot_remove_own_admin_access");
    await this.registry.query(
      "UPDATE saas_members SET role=$3,active=$4 WHERE workspace_id=$1 AND user_id=$2",
      [a.workspaceId, userId, role, active],
    );
    await this.registry.query(
      "DELETE FROM saas_sessions WHERE workspace_id=$1 AND user_id=$2",
      [a.workspaceId, userId],
    );
    return { ok: true };
  }
  async onModuleDestroy() {
    await Promise.all([this.control?.end(), this.scoped?.end()]);
  }
}
