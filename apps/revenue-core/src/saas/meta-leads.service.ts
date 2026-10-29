import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHmac } from "node:crypto";
import { secretEquals } from "../inbox-v2/chatwoot";
import { TenantsService } from "./tenants.service";
import { IntakeService } from "./intake.service";
import { tenantContext } from "./context";

/** Native Lead Ads ingestion is independent from Insights and CRM-stage feedback. */
@Injectable()
export class MetaLeadsService {
  constructor(
    private readonly tenants: TenantsService,
    private readonly intake: IntakeService,
  ) {}
  async challenge(slug: string, query: any) {
    const row = await this.tenants.bySlug(slug),
      config = this.tenants.unseal(row.workspace_id, row.secrets).metaLeads;
    if (
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
            ["page_id", entry.id],
            ["ad_id", lead.ad_id],
            ["campaign_id", lead.campaign_id],
            ["ad_set_id", lead.adset_id],
          ]
            .filter(([, v]) => v !== undefined && v !== null)
            .map(([type, value]) => ({ type, value: String(value) }));
          // Form submission is not itself proof of permission for ad user-data uploads.
          receipts.push(
            await this.intake.receive({
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
            }),
          );
        }
      }
      return { receipts };
    });
  }
}
