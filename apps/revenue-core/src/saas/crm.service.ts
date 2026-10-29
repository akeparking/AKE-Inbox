import {
  Injectable,
  Inject,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  companyInputSchema,
  personInputSchema,
  quoteInputSchema,
  outcomeInputSchema,
  taskUpdateSchema,
  createOpportunitySchema,
  qualifyOpportunitySchema,
  createTaskSchema,
  createNoteSchema,
  knowledgeInputSchema,
  defaultPipeline,
  pipelineSettingsSchema,
  normalizeEmail,
  normalizePhone,
} from "@ake/contracts";
import { REVENUE_STORE, type RevenueStore } from "../store/store.types";
import { currentTenant } from "./context";
import { TenantsService, digest } from "./tenants.service";
import type { PoolClient } from "pg";
import { leadMessages } from "./messages";

const id = (kind: string) => kind + "_" + randomUUID();
const versionSchema = z.number().int().nonnegative();
const tables: Record<string, { table: string; search: string }> = {
  companies: { table: "companies", search: "name" },
  people: { table: "people", search: "display_name" },
  leads: { table: "leads", search: "display_name" },
  opportunities: { table: "opportunities", search: "name" },
  tasks: { table: "crm_tasks", search: "title" },
  notes: { table: "crm_notes", search: "body" },
  quotes: { table: "crm_quotes", search: "title" },
  knowledge: { table: "crm_knowledge", search: "title" },
};
@Injectable()
export class SaasCrmService {
  constructor(
    readonly tenants: TenantsService,
    @Inject(REVENUE_STORE) readonly store: RevenueStore,
  ) {}
  async list(resource: string, q = "", page = 1) {
    const def = tables[resource];
    if (!def) throw new NotFoundException();
    const a = currentTenant(),
      p = Math.max(1, Math.min(Number(page) || 1, 100000));
    const where = `workspace_id=$1 AND ($2='' OR ${def.search} ILIKE $3)`;
    const args = [
      a.workspaceId,
      String(q).slice(0, 200),
      "%" +
        String(q)
          .slice(0, 200)
          .replace(/[\\%_]/g, "\\$&") +
        "%",
    ];
    const data = await this.tenants.db.query(
      `SELECT * FROM ${def.table} WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET $4`,
      [...args, (p - 1) * 50],
    );
    const total = Number(
      (
        await this.tenants.db.query(
          `SELECT count(*) FROM ${def.table} WHERE ${where}`,
          args,
        )
      ).rows[0].count,
    );
    return {
      items: data.rows.map((row) => this.publicRow(resource, row)),
      total,
      page: p,
      pageSize: 50,
    };
  }
  private publicRow(resource: string, row: any) {
    if (resource === "knowledge")
      return {
        ...row,
        body: this.tenants.unseal(currentTenant().workspaceId, row.body),
      };
    if (resource === "leads") {
      const { email_ciphertext, phone_ciphertext, wa_id_ciphertext, ...safe } =
        row;
      return safe;
    }
    return row;
  }
  async audit(
    client: PoolClient,
    action: string,
    target: string,
    detail: any = {},
  ) {
    const a = currentTenant();
    await client.query(
      `INSERT INTO audit_log(id,workspace_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1,$2,$3,$4,'crm',$5,$6)`,
      [id("audit"), a.workspaceId, a.userId, action, target, detail],
    );
  }
  async company(body: any, companyId?: string) {
    this.tenants.requireRole("admin", "sales");
    const a = currentTenant(),
      v = companyInputSchema.parse(body);
    await this.tenants.requireOwner(v.ownerId);
    return this.tenants.transaction(async (c) => {
      const args = [
        a.workspaceId,
        v.name,
        v.country || null,
        v.website || null,
        v.industry || null,
        v.ownerId,
        v.fields,
      ];
      const result = companyId
        ? await c.query(
            `UPDATE companies SET name=$2,country=$3,website=$4,industry=$5,owner_id=$6,custom_fields=$7,version=version+1 WHERE workspace_id=$1 AND id=$8 AND version=$9 RETURNING *`,
            [...args, companyId, versionSchema.parse(body.expectedVersion)],
          )
        : await c.query(
            "INSERT INTO companies(workspace_id,name,country,website,industry,owner_id,custom_fields,id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
            [...args, id("company")],
          );
      if (!result.rowCount)
        throw new ConflictException("record_changed_or_unavailable");
      await this.audit(
        c,
        companyId ? "company.updated" : "company.created",
        result.rows[0].id,
      );
      return result.rows[0];
    });
  }
  async person(body: any, personId?: string) {
    this.tenants.requireRole("admin", "sales");
    const a = currentTenant(),
      v = personInputSchema.parse(body);
    await this.tenants.requireOwner(v.ownerId);
    const email = normalizeEmail(v.email || undefined) || null,
      phone = normalizePhone(v.phone || undefined) || null;
    return this.tenants.transaction(async (c) => {
      if (
        v.companyId &&
        !(
          await c.query(
            "SELECT 1 FROM companies WHERE id=$1 AND workspace_id=$2",
            [v.companyId, a.workspaceId],
          )
        ).rowCount
      )
        throw new NotFoundException("company_unavailable");
      const args = [
        a.workspaceId,
        v.displayName,
        v.companyId || null,
        email,
        phone,
        email ? digest(email) : null,
        phone ? digest(phone) : null,
        v.ownerId,
        v.language,
        v.buyingRole || null,
      ];
      const result = personId
        ? await c.query(
            `UPDATE people SET display_name=$2,company_id=$3,normalized_email=$4,normalized_phone=$5,email_hash=$6,phone_hash=$7,owner_id=$8,language=$9,buying_role=$10,version=version+1 WHERE workspace_id=$1 AND id=$11 AND version=$12 RETURNING *`,
            [...args, personId, versionSchema.parse(body.expectedVersion)],
          )
        : await c.query(
            `INSERT INTO people(workspace_id,display_name,company_id,normalized_email,normalized_phone,email_hash,phone_hash,owner_id,language,buying_role,id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
            [...args, id("person")],
          );
      if (!result.rowCount)
        throw new ConflictException("record_changed_or_unavailable");
      await this.audit(
        c,
        personId ? "person.updated" : "person.created",
        result.rows[0].id,
      );
      return result.rows[0];
    });
  }
  async createOpportunity(body: any) {
    this.tenants.requireRole("admin", "sales");
    const a = currentTenant();
    const v = z
      .object({
        primarySourceLeadId: z.string().min(1),
        name: z.string().trim().min(3).max(300),
        direction: z.string().max(300).nullable().default(null),
        country: z.string().length(2).nullable().default(null),
        ownerId: z.string().min(1),
        nextAction: z.string().trim().min(2).max(1000),
        amount: z.number().finite().nonnegative().nullable().default(null),
        currency: z
          .string()
          .regex(/^[A-Z]{3}$/)
          .nullable()
          .default(null),
        idempotencyKey: z.string().min(8).max(180),
      })
      .parse({ ...body, ownerId: body.ownerId || a.userId });
    if (v.amount !== null && !v.currency)
      throw new BadRequestException("amount_requires_currency");
    await this.tenants.requireOwner(v.ownerId);
    return this.tenants.once(
      "opportunity:" + v.idempotencyKey,
      v,
      async (c) => {
        const lead = (
          await c.query(
            "SELECT * FROM leads WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
            [a.workspaceId, v.primarySourceLeadId],
          )
        ).rows[0];
        if (!lead) throw new NotFoundException("lead_unavailable");
        if (lead.merge_review_required)
          throw new ConflictException("resolve_contact_identity_first");
        const row = (
          await c.query(
            `INSERT INTO opportunities(id,workspace_id,primary_source_lead_id,person_id,company_id,name,direction,country,owner_id,next_action,amount,currency)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
            [
              id("opp"),
              a.workspaceId,
              lead.id,
              lead.person_id,
              lead.company_id,
              v.name,
              v.direction,
              v.country,
              v.ownerId,
              v.nextAction,
              v.amount,
              v.currency,
            ],
          )
        ).rows[0];
        await c.query(
          "INSERT INTO opportunity_stage_history(id,workspace_id,opportunity_id,to_stage,actor_id) VALUES($1,$2,$3,'discovery',$4)",
          [id("stage"), a.workspaceId, row.id, a.userId],
        );
        await this.audit(c, "opportunity.created", row.id, { leadId: lead.id });
        return { opportunity: row };
      },
    );
  }
  async link(leadId: string, body: any) {
    this.tenants.requireRole("admin", "sales");
    const a = currentTenant();
    const v = z
      .object({
        companyId: z.string().nullable(),
        personId: z.string().min(1),
        expectedRevision: versionSchema,
      })
      .parse(body);
    return this.tenants.transaction(async (c) => {
      const person = (
        await c.query(
          "SELECT company_id FROM people WHERE workspace_id=$1 AND id=$2",
          [a.workspaceId, v.personId],
        )
      ).rows[0];
      if (!person || person.company_id !== v.companyId)
        throw new BadRequestException("contact_company_mismatch");
      if (
        (
          await c.query(
            "SELECT 1 FROM opportunities WHERE workspace_id=$1 AND primary_source_lead_id=$2",
            [a.workspaceId, leadId],
          )
        ).rowCount
      )
        throw new ConflictException("project_links_already_in_use");
      const lead = (
        await c.query(
          "UPDATE leads SET company_id=$3,person_id=$4,merge_review_required=false,qualification_revision=qualification_revision+1 WHERE workspace_id=$1 AND id=$2 AND qualification_revision=$5 RETURNING id",
          [a.workspaceId, leadId, v.companyId, v.personId, v.expectedRevision],
        )
      ).rows[0];
      if (!lead) throw new ConflictException("record_changed_or_unavailable");
      await this.audit(c, "lead.contact_linked", leadId, {
        companyId: v.companyId,
        personId: v.personId,
      });
      return lead;
    });
  }
  async stage(oid: string, body: any) {
    this.tenants.requireRole("admin", "sales");
    const v = z
        .object({
          stage: z.enum([
            "discovery",
            "solution_fit",
            "quotation",
            "negotiation",
          ]),
          expectedVersion: versionSchema,
        })
        .parse(body),
      a = currentTenant();
    const previous = (
      await this.tenants.db.query(
        "SELECT stage FROM opportunities WHERE workspace_id=$1 AND id=$2",
        [a.workspaceId, oid],
      )
    ).rows[0];
    if (!previous) throw new NotFoundException();
    if (["won", "lost"].includes(previous.stage))
      throw new ConflictException("use_reopen_to_preserve_outcome_history");
    return this.store.updateOpportunityStage({
      ...v,
      workspaceId: a.workspaceId,
      actorId: a.userId,
      opportunityId: oid,
    });
  }
  async opportunity(oid: string, body: any) {
    this.tenants.requireRole("admin", "sales");
    const v = z
        .object({
          name: z.string().trim().min(3).max(300),
          ownerId: z.string().min(1),
          nextAction: z.string().trim().min(2).max(1000),
          amount: z.number().nonnegative().nullable(),
          currency: z
            .string()
            .regex(/^[A-Z]{3}$/)
            .nullable(),
          expectedVersion: versionSchema,
        })
        .refine(
          (v) => v.amount === null || !!v.currency,
          "amount_requires_currency",
        )
        .parse(body),
      a = currentTenant();
    await this.tenants.requireOwner(v.ownerId);
    return this.tenants.transaction(async (c) => {
      const row = (
        await c.query(
          "UPDATE opportunities SET name=$3,owner_id=$4,next_action=$5,amount=$6,currency=$7,version=version+1 WHERE workspace_id=$1 AND id=$2 AND version=$8 RETURNING *",
          [
            a.workspaceId,
            oid,
            v.name,
            v.ownerId,
            v.nextAction,
            v.amount,
            v.currency,
            v.expectedVersion,
          ],
        )
      ).rows[0];
      if (!row) throw new ConflictException("record_changed_or_unavailable");
      await this.audit(c, "opportunity.updated", oid);
      return row;
    });
  }
  async qualify(leadId: string, body: any) {
    this.tenants.requireRole("admin", "sales", "marketing");
    const a = currentTenant(),
      v = qualifyOpportunitySchema.parse(body);
    return this.store.qualifyLead({
      ...v,
      leadId,
      workspaceId: a.workspaceId,
      actorId: a.userId,
    });
  }
  async task(body: any, taskId?: string) {
    this.tenants.requireRole("admin", "sales");
    const a = currentTenant();
    await this.tenants.requireOwner(String(body.ownerId || a.userId));
    if (!taskId)
      return this.store.createTask(
        createTaskSchema.parse({
          ...body,
          workspaceId: a.workspaceId,
          ownerId: body.ownerId || a.userId,
        }),
      );
    const v = taskUpdateSchema.parse(body);
    return this.tenants.transaction(async (c) => {
      const row = (
        await c.query(
          "UPDATE crm_tasks SET title=$3,owner_id=$4,due_at=$5,status=$6,result=$7,version=version+1 WHERE workspace_id=$1 AND id=$2 AND version=$8 RETURNING *",
          [
            a.workspaceId,
            taskId,
            v.title,
            v.ownerId,
            v.dueAt,
            v.status,
            v.result || null,
            v.expectedVersion,
          ],
        )
      ).rows[0];
      if (!row) throw new ConflictException("record_changed_or_unavailable");
      await this.audit(c, "task.updated", taskId, { status: v.status });
      return row;
    });
  }
  async note(body: any) {
    this.tenants.requireRole("admin", "sales", "marketing");
    const a = currentTenant();
    return this.store.createNote(
      createNoteSchema.parse({
        ...body,
        workspaceId: a.workspaceId,
        authorId: a.userId,
      }),
    );
  }
  async quote(body: any) {
    this.tenants.requireRole("admin", "sales");
    const v = quoteInputSchema.parse(body),
      a = currentTenant();
    return this.tenants.once("quote:" + v.idempotencyKey, v, async (c) => {
      const opportunity = (
        await c.query(
          "SELECT id FROM opportunities WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [a.workspaceId, v.opportunityId],
        )
      ).rows[0];
      if (!opportunity) throw new NotFoundException();
      const previous = (
        await c.query(
          "SELECT id,version FROM crm_quotes WHERE workspace_id=$1 AND opportunity_id=$2 ORDER BY version DESC LIMIT 1",
          [a.workspaceId, v.opportunityId],
        )
      ).rows[0];
      if ((previous?.id || null) !== (v.previousId || null))
        throw new ConflictException("quote_version_changed");
      const row = (
        await c.query(
          "INSERT INTO crm_quotes(id,workspace_id,opportunity_id,version,title,amount,currency,notes,previous_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
          [
            id("quote"),
            a.workspaceId,
            v.opportunityId,
            (previous?.version || 0) + 1,
            v.title,
            v.amount,
            v.currency,
            v.notes,
            v.previousId || null,
            a.userId,
          ],
        )
      ).rows[0];
      await this.audit(c, "quote.version_created", row.id);
      return row;
    });
  }
  async outcome(opportunityId: string, body: any) {
    this.tenants.requireRole("admin", "sales");
    const v = outcomeInputSchema.parse(body),
      a = currentTenant();
    if (Date.parse(v.occurredAt) > Date.now() + 60000)
      throw new BadRequestException("future_outcome_not_allowed");
    return this.tenants.once(
      "outcome:" + v.idempotencyKey,
      { ...v, opportunityId },
      async (c) => {
        const old = (
          await c.query(
            "SELECT * FROM opportunities WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
            [a.workspaceId, opportunityId],
          )
        ).rows[0];
        if (!old) throw new NotFoundException();
        if (old.version !== v.expectedVersion)
          throw new ConflictException("record_changed");
        if (v.status === "reopened" && !["won", "lost"].includes(old.stage))
          throw new ConflictException("opportunity_already_open");
        const stage = v.status === "reopened" ? "discovery" : v.status;
        await c.query(
          "UPDATE opportunities SET stage=$3,lost_reason=$4,version=version+1 WHERE workspace_id=$1 AND id=$2",
          [
            a.workspaceId,
            opportunityId,
            stage,
            v.status === "lost" ? v.evidence : null,
          ],
        );
        await c.query(
          "INSERT INTO opportunity_stage_history(id,workspace_id,opportunity_id,from_stage,to_stage,actor_id) VALUES($1,$2,$3,$4,$5,$6)",
          [
            id("stage"),
            a.workspaceId,
            opportunityId,
            old.stage,
            stage,
            a.userId,
          ],
        );
        const outcome = (
          await c.query(
            "INSERT INTO crm_outcomes(id,workspace_id,opportunity_id,status,amount,currency,occurred_at,evidence,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
            [
              id("outcome"),
              a.workspaceId,
              opportunityId,
              v.status,
              v.status === "won" ? v.amount : null,
              v.status === "won" ? v.currency : null,
              v.occurredAt,
              v.evidence,
              a.userId,
            ],
          )
        ).rows[0];
        if (v.status === "won") {
          const created = await c.query(
            `INSERT INTO crm_business_events(id,workspace_id,opportunity_id,lead_id,kind,occurred_at,payload) VALUES($1,$2,$3,$4,'OpportunityWon',$5,$6) ON CONFLICT(workspace_id,opportunity_id,kind) DO NOTHING RETURNING id`,
            [
              id("event"),
              a.workspaceId,
              opportunityId,
              old.primary_source_lead_id,
              v.occurredAt,
              { outcomeId: outcome.id, amount: v.amount, currency: v.currency },
            ],
          );
          if (created.rowCount)
            await c.query(
              "UPDATE crm_business_events SET mode=$3 WHERE workspace_id=$1 AND id=$2",
              [
                a.workspaceId,
                created.rows[0].id,
                a.settings.feedbackMode === "live" ? "live" : "mock",
              ],
            );
          else
            await c.query(
              "UPDATE crm_business_events SET status='review' WHERE workspace_id=$1 AND opportunity_id=$2",
              [a.workspaceId, opportunityId],
            );
        } else
          await c.query(
            "UPDATE crm_business_events SET status='review' WHERE workspace_id=$1 AND opportunity_id=$2",
            [a.workspaceId, opportunityId],
          );
        await this.audit(c, "opportunity." + v.status, opportunityId, {
          outcomeId: outcome.id,
        });
        return { ...outcome, opportunityVersion: old.version + 1 };
      },
    );
  }
  async detail(leadId: string) {
    const a = currentTenant(),
      lead = await this.store.getLeadInternal(a.workspaceId, leadId);
    if (!lead) throw new NotFoundException();
    const [opportunities, touches, notes, tasks, messages, links] =
      await Promise.all([
        this.tenants.db.query(
          "SELECT * FROM opportunities WHERE workspace_id=$1 AND primary_source_lead_id=$2 ORDER BY created_at",
          [a.workspaceId, leadId],
        ),
        this.tenants.db.query(
          "SELECT id,provider,source_kind,occurred_at,landing_url,referrer,utm,consent_status,metadata FROM attribution_touches WHERE workspace_id=$1 AND lead_id=$2 ORDER BY occurred_at,id",
          [a.workspaceId, leadId],
        ),
        this.tenants.db.query(
          "SELECT * FROM crm_notes WHERE workspace_id=$1 AND (lead_id=$2 OR opportunity_id IN (SELECT id FROM opportunities WHERE primary_source_lead_id=$2)) ORDER BY created_at DESC",
          [a.workspaceId, leadId],
        ),
        this.tenants.db.query(
          "SELECT * FROM crm_tasks WHERE workspace_id=$1 AND (lead_id=$2 OR opportunity_id IN (SELECT id FROM opportunities WHERE primary_source_lead_id=$2)) ORDER BY due_at NULLS LAST",
          [a.workspaceId, leadId],
        ),
        leadMessages(this.tenants, leadId),
        this.tenants.db.query(
          "SELECT conversation_id FROM crm_conversation_links WHERE workspace_id=$1 AND lead_id=$2",
          [a.workspaceId, leadId],
        ),
      ]);
    const quotes = (
      await this.tenants.db.query(
        "SELECT * FROM crm_quotes WHERE workspace_id=$1 AND opportunity_id IN (SELECT id FROM opportunities WHERE primary_source_lead_id=$2) ORDER BY created_at DESC",
        [a.workspaceId, leadId],
      )
    ).rows;
    const outcomes = (
      await this.tenants.db.query(
        "SELECT * FROM crm_outcomes WHERE workspace_id=$1 AND opportunity_id IN (SELECT id FROM opportunities WHERE primary_source_lead_id=$2) ORDER BY created_at DESC",
        [a.workspaceId, leadId],
      )
    ).rows;
    const history = (
      await this.tenants.db.query(
        "SELECT h.* FROM opportunity_stage_history h JOIN opportunities o ON o.id=h.opportunity_id AND o.workspace_id=h.workspace_id WHERE h.workspace_id=$1 AND o.primary_source_lead_id=$2 ORDER BY h.occurred_at DESC",
        [a.workspaceId, leadId],
      )
    ).rows;
    return {
      lead: {
        ...lead,
        rawAttribution: undefined,
        email: undefined,
        phone: undefined,
        waId: undefined,
      },
      opportunities: opportunities.rows,
      touches: touches.rows,
      notes: notes.rows,
      tasks: tasks.rows,
      messages: messages.items,
      messagesTruncated: messages.truncated,
      quotes,
      outcomes,
      conversations: links.rows,
      history,
    };
  }
  async customer(id: string) {
    const a = currentTenant(),
      company = (
        await this.tenants.db.query(
          "SELECT * FROM companies WHERE workspace_id=$1 AND id=$2",
          [a.workspaceId, id],
        )
      ).rows[0];
    if (!company) throw new NotFoundException();
    const contacts = (
      await this.tenants.db.query(
        "SELECT * FROM people WHERE workspace_id=$1 AND company_id=$2 ORDER BY display_name LIMIT 201",
        [a.workspaceId, id],
      )
    ).rows;
    const leads = (
      await this.tenants.db.query(
        "SELECT * FROM leads WHERE workspace_id=$1 AND company_id=$2 ORDER BY created_at DESC LIMIT 201",
        [a.workspaceId, id],
      )
    ).rows;
    const opportunities = (
      await this.tenants.db.query(
        "SELECT * FROM opportunities WHERE workspace_id=$1 AND company_id=$2 ORDER BY created_at DESC LIMIT 201",
        [a.workspaceId, id],
      )
    ).rows;
    return {
      company,
      contacts: contacts.slice(0, 200),
      leads: leads.slice(0, 200).map((row) => this.publicRow("leads", row)),
      opportunities: opportunities.slice(0, 200),
      truncated: [contacts, leads, opportunities].some(
        (rows) => rows.length > 200,
      ),
    };
  }
  async knowledge(body: any, kid?: string) {
    this.tenants.requireRole("admin");
    const v = knowledgeInputSchema.parse(body),
      a = currentTenant();
    const result = kid
      ? await this.tenants.db.query(
          "UPDATE crm_knowledge SET title=$3,body=$4,source=$5,source_hash=$6,state=$7,reviewed_by=$8,version=version+1 WHERE workspace_id=$1 AND id=$2 AND version=$9 RETURNING *",
          [
            a.workspaceId,
            kid,
            v.title,
            this.tenants.seal(a.workspaceId, v.body),
            v.source,
            digest(v.body),
            v.state,
            v.state === "approved" ? a.userId : null,
            versionSchema.parse(body.expectedVersion),
          ],
        )
      : await this.tenants.db.query(
          "INSERT INTO crm_knowledge(id,workspace_id,title,body,source,source_hash,state,reviewed_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
          [
            id("knowledge"),
            a.workspaceId,
            v.title,
            this.tenants.seal(a.workspaceId, v.body),
            v.source,
            digest(v.body),
            v.state,
            v.state === "approved" ? a.userId : null,
          ],
        );
    if (!result.rowCount) throw new ConflictException("record_changed");
    return { ...result.rows[0], body: v.body };
  }
  async pipeline(body?: unknown) {
    const a = currentTenant();
    if (body) {
      this.tenants.requireRole("admin");
      const stages = pipelineSettingsSchema.parse(body);
      await this.tenants.registry.query(
        "UPDATE saas_tenants SET settings=jsonb_set(settings,'{pipeline}',$2) WHERE workspace_id=$1",
        [a.workspaceId, JSON.stringify(stages)],
      );
      return stages;
    }
    return a.settings.pipeline || defaultPipeline;
  }
  async export(resource: string) {
    this.tenants.requireRole("admin", "marketing", "sales");
    const def = tables[resource];
    if (!def || ["knowledge"].includes(resource))
      throw new ForbiddenException();
    const a = currentTenant();
    const rows = (
      await this.tenants.db.query(
        `SELECT * FROM ${def.table} WHERE workspace_id=$1 ORDER BY created_at,id LIMIT 10001`,
        [a.workspaceId],
      )
    ).rows;
    if (rows.length > 10000)
      throw new BadRequestException("export_requires_narrower_scope");
    return {
      workspace: a.slug,
      resource,
      exportedAt: new Date().toISOString(),
      complete: true,
      rows: rows.map((row) => this.publicRow(resource, row)),
    };
  }
}
