import {
  Inject,
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { z } from "zod";
import { ingestLeadSchema } from "@ake/contracts";
import { REVENUE_STORE, type RevenueStore } from "../store/store.types";
import { currentTenant, tenantContext } from "./context";
import { TenantsService, digest } from "./tenants.service";

export const intakeSchema = z.object({
  source: z.enum(["website", "meta", "email", "whatsapp"]),
  eventId: z.string().min(1).max(180),
  projectId: z.string().min(1).max(180).optional(),
  conversationId: z.number().int().positive().optional(),
  inboxId: z.number().int().positive().optional(),
  occurredAt: z.iso.datetime(),
  projectStartedAt: z.iso.datetime().optional(),
  displayName: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(6000),
  email: z.email().optional(),
  phone: z.string().max(40).optional(),
  companyName: z.string().max(300).optional(),
  country: z.string().length(2).optional(),
  isTest: z.boolean().default(false),
  attribution: ingestLeadSchema.shape.attribution,
});

@Injectable()
export class IntakeService {
  constructor(
    private readonly tenants: TenantsService,
    @Inject(REVENUE_STORE) private readonly store: RevenueStore,
  ) {}
  async webhook(
    slug: string,
    body: unknown,
    raw: Buffer,
    timestamp: string,
    signature: string,
  ) {
    const row = await this.tenants.bySlug(slug),
      secret = this.tenants.unseal(row.workspace_id, row.secrets).intakeSecret;
    if (
      !secret ||
      secret.length < 32 ||
      !Buffer.isBuffer(raw) ||
      !/^\d{10}$/.test(timestamp) ||
      Math.abs(Date.now() / 1000 - Number(timestamp)) > 300
    )
      throw new UnauthorizedException("invalid_intake_signature");
    const expected = createHmac("sha256", secret)
      .update(timestamp + ".")
      .update(raw)
      .digest("hex");
    if (
      !/^[a-f0-9]{64}$/.test(signature) ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
    )
      throw new UnauthorizedException("invalid_intake_signature");
    const actor = this.tenants.fromRow(row, "system:intake", "admin");
    actor.system = true;
    return tenantContext.run(actor, () => this.receive(body));
  }
  async receive(body: unknown) {
    const v = intakeSchema.parse(body),
      a = currentTenant();
    if (
      Date.parse(v.occurredAt) > Date.now() + 300000 ||
      Date.parse(v.attribution.occurredAt) > Date.parse(v.occurredAt) + 300000
    )
      throw new BadRequestException("future_message");
    const receiptKey = v.source + ":" + v.eventId;
    const externalLeadId = v.source + ":" + (v.projectId || v.eventId),
      hash = digest(JSON.stringify(v));
    return this.tenants.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        a.workspaceId + ":intake:" + v.source + ":" + v.eventId,
      ]);
      const old = (
        await c.query(
          "SELECT * FROM crm_ingestion_receipts WHERE workspace_id=$1 AND source=$2 AND event_id=$3",
          [a.workspaceId, v.source, v.eventId],
        )
      ).rows[0];
      if (old) {
        if (old.payload_hash !== hash)
          throw new ConflictException("source_event_content_changed");
        return { leadId: old.lead_id, state: old.state, deduplicated: true };
      }
      if (
        Date.parse(v.projectStartedAt || v.occurredAt) <
        Date.parse(a.effectiveFrom)
      ) {
        await c.query(
          "INSERT INTO crm_ingestion_receipts(workspace_id,source,event_id,payload_hash,state,occurred_at) VALUES($1,$2,$3,$4,'legacy_okki',$5)",
          [a.workspaceId, v.source, v.eventId, hash, v.occurredAt],
        );
        return { state: "legacy_okki", leadId: null };
      }
      if (v.conversationId) {
        if (
          !v.inboxId ||
          !(
            await c.query(
              "SELECT 1 FROM crm_channels WHERE workspace_id=$1 AND inbox_id=$2 AND enabled",
              [a.workspaceId, v.inboxId],
            )
          ).rowCount
        )
          throw new BadRequestException("channel_not_registered");
      }
      const count = Number(
        (
          await c.query(
            "SELECT count(*) FROM crm_ingestion_receipts WHERE workspace_id=$1 AND received_at>=date_trunc('month',now()) AND state='persisted'",
            [a.workspaceId],
          )
        ).rows[0].count,
      );
      if (count >= Number(a.settings.monthlyInquiryLimit || 10000))
        throw new BadRequestException("monthly_intake_quota_reached");
      const attribution = {
        ...v.attribution,
        metadata: { ...v.attribution.metadata, receiptKey },
      };
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        a.workspaceId + ":intake-project:" + externalLeadId,
      ]);
      if (v.email || v.phone)
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          a.workspaceId +
            ":contact:" +
            digest((v.email || v.phone || "").trim().toLowerCase()),
        ]);
      const known = (
        await c.query(
          "SELECT id,is_test FROM leads WHERE workspace_id=$1 AND external_lead_id=$2",
          [a.workspaceId, externalLeadId],
        )
      ).rows[0];
      if (known && known.is_test !== v.isTest)
        throw new ConflictException("project_mode_changed");
      const lead = known
        ? await this.store.getLeadInternal(a.workspaceId, known.id)
        : await this.store.ingestLead(
            ingestLeadSchema.parse({
              workspaceId: a.workspaceId,
              provider: v.attribution.provider,
              sourceKind: v.attribution.sourceKind,
              externalLeadId,
              displayName: v.displayName,
              email: v.email,
              phone: v.phone,
              companyName: v.companyName,
              country: v.country,
              isTest: v.isTest,
              attribution,
            }),
          );
      if (!lead) throw new ConflictException("project_unavailable");
      const inquiry = await this.store.saveInquiry({
        workspaceId: a.workspaceId,
        leadId: lead.id,
        eventId: v.source + ":" + v.eventId,
        conversationId: String(v.conversationId || v.projectId || v.eventId),
        channel: v.source === "meta" ? "website" : v.source,
        displayName: v.displayName,
        message: v.message,
        email: v.email,
        isTest: v.isTest,
        occurredAt: v.occurredAt,
      });
      await c.query(
        "UPDATE leads SET received_at=coalesce(received_at,$3) WHERE workspace_id=$1 AND id=$2",
        [a.workspaceId, lead.id, v.occurredAt],
      );
      if (
        !(
          await c.query(
            "SELECT 1 FROM attribution_touches WHERE workspace_id=$1 AND lead_id=$2 AND metadata->>'receiptKey'=$3",
            [a.workspaceId, lead.id, receiptKey],
          )
        ).rowCount
      ) {
        const touchId = "touch_" + randomUUID();
        await c.query(
          "INSERT INTO attribution_touches(id,workspace_id,lead_id,provider,source_kind,occurred_at,landing_url,referrer,utm,consent_status,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [
            touchId,
            a.workspaceId,
            lead.id,
            attribution.provider,
            attribution.sourceKind,
            attribution.occurredAt,
            attribution.landingUrl || null,
            attribution.referrer || null,
            attribution.utm || {},
            attribution.consentStatus || "unknown",
            attribution.metadata,
          ],
        );
        for (const value of attribution.identifiers)
          await c.query(
            "INSERT INTO ad_identifiers(id,workspace_id,attribution_touch_id,identifier_type,value_ciphertext,value_hash,preview) VALUES($1,$2,$3,$4,$5,$6,$7)",
            [
              "identifier_" + randomUUID(),
              a.workspaceId,
              touchId,
              value.type,
              this.tenants.cipher(a.workspaceId).encrypt(value.value),
              digest(value.value),
              "[protected]",
            ],
          );
      }
      if (v.conversationId)
        await c.query(
          "INSERT INTO crm_conversation_links(workspace_id,conversation_id,lead_id) VALUES($1,$2,$3) ON CONFLICT(workspace_id,conversation_id) DO NOTHING",
          [a.workspaceId, v.conversationId, lead.id],
        );
      await c.query(
        "INSERT INTO crm_ingestion_receipts(workspace_id,source,event_id,payload_hash,lead_id,state,occurred_at) VALUES($1,$2,$3,$4,$5,'persisted',$6)",
        [a.workspaceId, v.source, v.eventId, hash, lead.id, v.occurredAt],
      );
      return {
        state: "persisted",
        leadId: lead.id,
        inquiryId: inquiry.id,
        deduplicated: false,
      };
    });
  }
}
