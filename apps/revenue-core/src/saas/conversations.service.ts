import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { z } from "zod";
import { secretEquals } from "../inbox-v2/chatwoot";
import { currentTenant, tenantContext } from "./context";
import { TenantsService, digest } from "./tenants.service";
import { IntakeService } from "./intake.service";

@Injectable()
export class ConversationsService {
  constructor(
    private readonly tenants: TenantsService,
    private readonly intake: IntakeService,
  ) {}
  async allowed(cid: number) {
    const a = currentTenant();
    if (!Number.isSafeInteger(cid) || cid < 1) throw new BadRequestException();
    const conversation = await this.tenants.fetchChatwoot(
      a,
      `/api/v1/accounts/${a.accountId}/conversations/${cid}`,
    );
    const channel = (
      await this.tenants.db.query(
        "SELECT channel FROM crm_channels WHERE workspace_id=$1 AND inbox_id=$2 AND enabled",
        [a.workspaceId, conversation.inbox_id],
      )
    ).rows[0];
    if (
      Number(conversation.account_id ?? a.accountId) !== a.accountId ||
      !channel
    )
      throw new ForbiddenException("channel_not_enrolled");
    return { ...conversation, channel: channel.channel };
  }
  async list(page = 1) {
    const a = currentTenant(),
      data = await this.tenants.fetchChatwoot(
        a,
        `/api/v1/accounts/${a.accountId}/conversations?status=all&page=${Math.max(1, Math.floor(page) || 1)}`,
      );
    const channels = (
      await this.tenants.db.query(
        "SELECT inbox_id FROM crm_channels WHERE workspace_id=$1 AND enabled",
        [a.workspaceId],
      )
    ).rows.map((r) => Number(r.inbox_id));
    const payload = data.data?.payload || data.payload || [];
    return {
      items: payload.filter((c: any) => channels.includes(Number(c.inbox_id))),
      page,
      hasMore: payload.length > 0,
    };
  }
  async messages(cid: number) {
    await this.allowed(cid);
    const a = currentTenant();
    return this.tenants.fetchChatwoot(
      a,
      `/api/v1/accounts/${a.accountId}/conversations/${cid}/messages`,
    );
  }
  async send(cid: number, body: any) {
    this.tenants.requireRole("admin", "sales");
    await this.allowed(cid);
    const a = currentTenant(),
      v = z
        .object({
          content: z.string().trim().min(1).max(6000),
          private: z.boolean().default(false),
          idempotencyKey: z.string().min(8).max(180),
        })
        .parse(body);
    const key = "reply:" + v.idempotencyKey,
      hash = digest(
        JSON.stringify({ cid, content: v.content, private: v.private }),
      );
    const attempt = await this.tenants.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        a.workspaceId + key,
      ]);
      const prior = (
        await c.query(
          "SELECT * FROM crm_outbound WHERE workspace_id=$1 AND operation_key=$2",
          [a.workspaceId, key],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_hash !== hash)
          throw new ConflictException("idempotency_conflict");
        return { prior };
      }
      await c.query(
        "INSERT INTO crm_outbound(workspace_id,operation_key,conversation_id,request_hash,state) VALUES($1,$2,$3,$4,'dispatching')",
        [a.workspaceId, key, cid, hash],
      );
      return { prior: null };
    });
    if (attempt.prior)
      return {
        state: attempt.prior.state,
        providerId: attempt.prior.provider_id,
        deduplicated: true,
      };
    try {
      const receipt = await this.tenants.fetchChatwoot(
        a,
        `/api/v1/accounts/${a.accountId}/conversations/${cid}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            content: v.content,
            message_type: "outgoing",
            private: v.private,
            content_attributes: { ake_operation_key: key },
          }),
        },
      );
      if (!Number.isSafeInteger(receipt.id)) throw new Error("missing_receipt");
      await this.tenants.db.query(
        "UPDATE crm_outbound SET state='accepted',provider_id=$3 WHERE workspace_id=$1 AND operation_key=$2",
        [a.workspaceId, key, String(receipt.id)],
      );
      return { state: "accepted", providerId: String(receipt.id) };
    } catch {
      await this.tenants.db.query(
        "UPDATE crm_outbound SET state='review',error_code='delivery_requires_reconciliation' WHERE workspace_id=$1 AND operation_key=$2",
        [a.workspaceId, key],
      );
      return {
        state: "review",
        message: "发送结果待核对，请在原会话检查；不会自动重发。",
      };
    }
  }
  async takeOver(cid: number) {
    this.tenants.requireRole("admin", "sales");
    await this.allowed(cid);
    const a = currentTenant();
    return this.tenants.fetchChatwoot(
      a,
      `/api/v1/accounts/${a.accountId}/conversations/${cid}/assignments`,
      {
        method: "POST",
        body: JSON.stringify({ assignee_id: Number(a.userId) }),
      },
    );
  }
  async channels() {
    const a = currentTenant();
    const remote = await this.tenants.fetchChatwoot(
      a,
      `/api/v1/accounts/${a.accountId}/inboxes`,
    );
    return {
      available: (remote.payload || []).map((x: any) => ({
        id: x.id,
        name: x.name,
        channelType: x.channel_type,
      })),
      enrolled: (
        await this.tenants.db.query(
          "SELECT * FROM crm_channels WHERE workspace_id=$1",
          [a.workspaceId],
        )
      ).rows,
    };
  }
  async enroll(body: any) {
    this.tenants.requireRole("admin");
    const v = z
        .object({
          inboxId: z.number().int().positive(),
          channel: z.enum(["website", "email", "whatsapp"]),
          enabled: z.boolean(),
        })
        .parse(body),
      a = currentTenant();
    const all = await this.channels();
    if (!all.available.some((x: any) => Number(x.id) === v.inboxId))
      throw new NotFoundException("account_inbox_not_found");
    await this.tenants.db.query(
      "INSERT INTO crm_channels(workspace_id,inbox_id,channel,enabled) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,inbox_id) DO UPDATE SET channel=excluded.channel,enabled=excluded.enabled",
      [a.workspaceId, v.inboxId, v.channel, v.enabled],
    );
    return v;
  }
  async webhook(slug: string, token: string, body: any) {
    const row = await this.tenants.bySlug(slug),
      secrets = this.tenants.unseal(row.workspace_id, row.secrets);
    if (
      !secretEquals(token, secrets.chatwootWebhookToken || "") ||
      !secrets.chatwootServiceToken
    )
      throw new UnauthorizedException();
    if (body.event !== "message_created") return { state: "ignored_event" };
    const cid = Number(body.conversation?.id),
      mid = Number(body.id);
    if (!Number.isSafeInteger(mid) || mid < 1) throw new BadRequestException();
    const actor = this.tenants.fromRow(row, "system:chatwoot", "admin");
    // Rails accepts this canonical wire header; public proxies may remove
    // underscore-named headers before the request reaches Chatwoot.
    actor.credentials = { "api-access-token": secrets.chatwootServiceToken };
    actor.system = true;
    return tenantContext.run(actor, async () => {
      const conversation = await this.allowed(cid);
      const data = await this.tenants.fetchChatwoot(
        actor,
        `/api/v1/accounts/${actor.accountId}/conversations/${cid}/messages?before=${mid + 1}`,
      );
      const message = (data.payload || []).find(
        (m: any) => Number(m.id) === mid,
      );
      if (!message) throw new NotFoundException("source_message_not_verified");
      if (message.message_type !== 0 || message.private)
        return { state: "ignored_non_customer_message" };
      const sender = message.sender || conversation.meta?.sender || {};
      if (/^(mailer-daemon|postmaster)@/i.test(String(sender.email || "")))
        return { state: "automatic_mail_preserved_in_inbox" };
      const occurredAt = new Date(
        Number(message.created_at) * 1000,
      ).toISOString();
      const startedAt = new Date(
        Number(conversation.created_at) * 1000,
      ).toISOString();
      return this.intake.receive({
        source: conversation.channel,
        eventId: String(mid),
        projectId: "chatwoot:" + cid,
        conversationId: cid,
        inboxId: Number(conversation.inbox_id),
        occurredAt,
        projectStartedAt: startedAt,
        displayName: sender.name || "Unnamed contact",
        message: message.content || "[Attachment received]",
        ...(sender.email ? { email: sender.email } : {}),
        ...(sender.phone_number ? { phone: sender.phone_number } : {}),
        isTest: false,
        attribution: {
          provider: "organic",
          sourceKind:
            conversation.channel === "website" ? "chat" : conversation.channel,
          occurredAt,
          identifiers: [],
          consentStatus: "unknown",
          metadata: { verifiedChatwootMessageId: mid },
        },
      });
    });
  }
}
