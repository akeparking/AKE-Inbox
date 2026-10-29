import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHmac, randomUUID } from "node:crypto";
import { secretEquals } from "../inbox-v2/chatwoot";
import { TenantsService } from "./tenants.service";
import { IntakeService } from "./intake.service";
import { tenantContext, currentTenant } from "./context";

/** Native Lead Ads ingestion is independent from Insights and CRM-stage feedback. */
@Injectable()
export class MetaLeadsService {
  constructor(
    private readonly tenants: TenantsService,
    private readonly intake: IntakeService,
  ) {}
  private async read(page: any, object: string, params: Record<string, string>) {
    const url = new URL(`https://graph.facebook.com/${page.apiVersion}/${object}`);
    url.search = new URLSearchParams(params).toString();
    let response: Response;
    try {
      response = await fetch(url, { headers: { authorization: "Bearer " + page.accessToken }, redirect: "error", signal: AbortSignal.timeout(20000) });
    } catch { throw new ServiceUnavailableException("meta_lead_network_unavailable"); }
    const data: any = await response.json().catch(() => null);
    if (!response.ok || data?.error) throw new ServiceUnavailableException(
      response.status === 401 || response.status === 403 || data?.error?.code === 190 ? "meta_lead_access_revoked" :
        response.status === 429 || [4,17,32,613].includes(data?.error?.code) ? "meta_lead_rate_limited" : "meta_lead_retrieval_failed");
    if (!data) throw new ServiceUnavailableException("invalid_meta_lead_response");
    return data;
  }
  private async *pages(page: any, object: string, params: Record<string, string>): AsyncGenerator<any[]> {
    let after = "";
    const seen = new Set<string>();
    for (let n = 0; n < 100; n++) {
      const data = await this.read(page, object, { ...params, limit: "100", ...(after ? { after } : {}) });
      if (!Array.isArray(data.data)) throw new ServiceUnavailableException("invalid_meta_lead_response");
      yield data.data;
      if (!data.paging?.next) return;
      after = data.paging?.cursors?.after;
      if (!after || seen.has(after)) throw new ServiceUnavailableException("meta_lead_pagination_invalid");
      seen.add(after);
    }
    throw new ServiceUnavailableException("meta_lead_pagination_limit");
  }
  async pollDue() {
    const config = (await this.tenants.secretSettings()).metaLeads;
    if (!config?.pollingEnabled) return null;
    const a = currentTenant();
    await this.tenants.db.query("INSERT INTO crm_lead_sync_state(workspace_id,provider) VALUES($1,'meta') ON CONFLICT DO NOTHING", [a.workspaceId]);
    // The row lock prevents overlapping polls, including across process restarts.
    return this.tenants.transaction(async db => {
      const state = (await db.query("SELECT * FROM crm_lead_sync_state WHERE workspace_id=$1 AND provider='meta' AND next_run_at<=now() FOR UPDATE SKIP LOCKED", [a.workspaceId])).rows[0];
      if (!state) return null;
      const id = "lead_sync_" + randomUUID(), started = new Date(),
        since = Math.max(Date.parse(a.effectiveFrom), state.last_success_at ? new Date(state.last_success_at).getTime() - 600000 : 0);
      let count = 0, error: string | null = null;
      await db.query("INSERT INTO crm_lead_sync_runs(id,workspace_id,provider,state) VALUES($1,$2,'meta','running')", [id,a.workspaceId]);
      try {
        for (const page of config.pages) {
          const forms: string[] = [...(page.formIds || [])];
          if (!forms.length) for await (const rows of this.pages(page, page.pageId + "/leadgen_forms", { fields: "id,status" }))
            for (const form of rows) if (form.status === "ACTIVE" && /^\d+$/.test(String(form.id))) forms.push(String(form.id));
          for (const formId of forms) for await (const rows of this.pages(page, formId + "/leads", {
            fields: "id,created_time,field_data,form_id,ad_id,campaign_id,adset_id",
            filtering: JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: Math.floor(since / 1000) - 1 }]),
          })) for (const lead of rows) {
            if (!Number.isFinite(Date.parse(lead.created_time))) throw new ServiceUnavailableException("invalid_meta_lead_response");
            if (Date.parse(lead.created_time) < since) continue;
            const receipt = await this.intake.receive(metaLeadInquiry(page, lead));
            if (receipt.state === "persisted" && !receipt.deduplicated) count++;
          }
        }
      } catch (e) {
        error = e instanceof ServiceUnavailableException ? e.message : "meta_lead_sync_failed";
      }
      await db.query("UPDATE crm_lead_sync_state SET next_run_at=now()+interval '5 minutes',last_success_at=CASE WHEN $2 THEN $3 ELSE last_success_at END WHERE workspace_id=$1 AND provider='meta'", [a.workspaceId,!error,started]);
      await db.query("UPDATE crm_lead_sync_runs SET state=$2,finished_at=now(),received_count=$3,error_code=$4 WHERE id=$1", [id,error ? "failed" : "complete",count,error]);
      return { id, state: error ? "failed" : "complete", receivedCount: count, errorCode: error };
    });
  }
  async challenge(slug: string, query: any) {
    const row = await this.tenants.bySlug(slug),
      config = this.tenants.unseal(row.workspace_id, row.secrets).metaLeads;
    if (
      !config?.verifyToken ||
      query["hub.mode"] !== "subscribe" ||
      !secretEquals(
        String(query["hub.verify_token"] || ""),
        config?.verifyToken || "",
      )
    )
      throw new UnauthorizedException();
    return String(query["hub.challenge"] || "");
  }
  async receive(slug: string, body: any, raw: Buffer, signature: string) {
    const row = await this.tenants.bySlug(slug),
      config = this.tenants.unseal(row.workspace_id, row.secrets).metaLeads;
    if (
      !config?.appSecret ||
      !raw ||
      !secretEquals(
        signature,
        "sha256=" +
          createHmac("sha256", config.appSecret).update(raw).digest("hex"),
      )
    )
      throw new UnauthorizedException("invalid_meta_signature");
    if (
      body.object !== "page" ||
      !Array.isArray(body.entry) ||
      body.entry.length > 100
    )
      throw new BadRequestException("invalid_page_events");
    const a = this.tenants.fromRow(row, "system:meta-leads", "admin");
    a.system = true;
    return tenantContext.run(a, async () => {
      const receipts = [];
      for (const entry of body.entry) {
        const page = config.pages.find(
          (p: any) => p.pageId === String(entry.id),
        );
        if (!page) throw new UnauthorizedException("page_not_enrolled");
        for (const change of entry.changes || []) {
          if (change.field !== "leadgen") continue;
          const leadId = String(change.value?.leadgen_id || "");
          if (!/^\d+$/.test(leadId))
            throw new BadRequestException("invalid_leadgen_id");
          const url = new URL(
            `https://graph.facebook.com/${page.apiVersion}/${leadId}`,
          );
          url.searchParams.set(
            "fields",
            "id,created_time,field_data,form_id,ad_id,campaign_id,adset_id",
          );
          const response = await fetch(url, {
            headers: { authorization: "Bearer " + page.accessToken },
            redirect: "error",
            signal: AbortSignal.timeout(20000),
          });
          if (!response.ok)
            throw new ServiceUnavailableException(
              response.status === 401 || response.status === 403
                ? "meta_lead_access_revoked"
                : "meta_lead_retrieval_failed",
            );
          const lead: any = await response.json();
          if (String(lead.id) !== leadId || !Array.isArray(lead.field_data))
            throw new ServiceUnavailableException("invalid_meta_lead_response");
          receipts.push(await this.intake.receive(metaLeadInquiry(page, lead)));
        }
      }
      return { receipts };
    });
  }
}

export function metaLeadInquiry(page: any, lead: any) {
  const leadId = String(lead.id || "");
  if (!/^\d+$/.test(leadId) || !Number.isFinite(Date.parse(lead.created_time)) || !Array.isArray(lead.field_data))
    throw new ServiceUnavailableException("invalid_meta_lead_response");
  const values = new Map<string, string>(
            lead.field_data
              .filter(
                (f: any) =>
                  typeof f.name === "string" && Array.isArray(f.values),
              )
              .map((f: any) => [f.name, String(f.values[0] || "")]),
          );
          const occurredAt = new Date(lead.created_time).toISOString();
          const identifiers = [
            ["meta_leadgen_id", leadId],
            ["form_id", lead.form_id],
            ["page_id", page.pageId],
            ["ad_id", lead.ad_id],
            ["campaign_id", lead.campaign_id],
            ["ad_set_id", lead.adset_id],
          ]
            .filter(([, v]) => v !== undefined && v !== null)
            .map(([type, value]) => ({ type, value: String(value) }));

  return {
              source: "meta",
              eventId: leadId,
              occurredAt,
              displayName:
                values.get("full_name") ||
                [values.get("first_name"), values.get("last_name")]
                  .filter(Boolean)
                  .join(" ") ||
                "Meta inquiry",
              message:
                lead.field_data
                  .map((f: any) => f.name + ": " + (f.values || []).join(", "))
                  .join("\n")
                  .slice(0, 6000) || "Meta form received",
              ...(values.get("email") ? { email: values.get("email") } : {}),
              ...(values.get("phone_number")
                ? { phone: values.get("phone_number") }
                : {}),
              ...(values.get("company_name")
                ? { companyName: values.get("company_name") }
                : {}),
              attribution: {
                provider: "meta",
                sourceKind: "instant_form",
                occurredAt,
                identifiers,
                consentStatus: "unknown",
                metadata: {
                  accountId: page.accountId,
                  ...(lead.campaign_id
                    ? { campaignId: String(lead.campaign_id) }
                    : {}),
                  pageId: page.pageId,
                },
              },
            };
}
