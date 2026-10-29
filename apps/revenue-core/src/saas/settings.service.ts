import { Injectable, BadRequestException } from "@nestjs/common";
import { z } from "zod";
import { currentTenant } from "./context";
import { TenantsService } from "./tenants.service";

const token = z.string().min(1).max(12000),
  numeric = z.string().regex(/^\d+$/);
const feedbackSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(["mock", "live"]),
  meta: z
    .object({
      accessToken: token,
      datasetId: numeric,
      graphVersion: z.string().regex(/^v\d+\.\d+$/),
      leadEventSource: z.string().min(1).max(120),
    })
    .optional(),
  google: z
    .object({
      accessToken: token,
      adsAccountId: numeric,
      conversionActionId: numeric,
      wonConversionActionId: numeric.optional(),
      validateOnly: z.boolean().default(true),
      refreshToken: token.optional(),
      clientId: token.optional(),
      clientSecret: token.optional(),
      expiresAt: z.number().positive().optional(),
    })
    .optional(),
});
const modelSchema = z.object({
  provider: z.enum(["mock", "openai-compatible", "anthropic-compatible"]),
  baseUrl: z.url().optional(),
  model: z.string().min(1).max(200).optional(),
  apiKey: token.optional(),
  disableThinking: z.boolean().optional(),
});
const metaLeadSchema = z.object({
  appSecret: token.optional(),
  verifyToken: token.optional(),
  pollingEnabled: z.boolean().default(false),
  pages: z
    .array(
      z.object({
        pageId: numeric,
        accountId: numeric,
        accessToken: token,
        apiVersion: z.string().regex(/^v\d+\.\d+$/),
        formIds: z.array(numeric).max(100).default([]),
      }),
    )
    .min(1)
    .max(20),
}).refine(v => Boolean(v.appSecret) === Boolean(v.verifyToken), { message: "Both signed webhook credentials are required" });

@Injectable()
export class SaasSettingsService {
  constructor(private readonly tenants: TenantsService) {}
  async status() {
    this.tenants.requireRole("admin");
    const s = await this.tenants.secretSettings();
    return {
      feedback: {
        configured: !!s.feedback,
        enabled: s.feedback?.enabled || false,
        mode: currentTenant().settings.feedbackMode || "mock",
        meta: !!s.feedback?.meta,
        google: !!s.feedback?.google,
        googleValidateOnly: s.feedback?.google?.validateOnly ?? true,
      },
      model: {
        provider: s.model?.provider || "mock",
        model: s.model?.model || null,
      },
      intake: !!s.intakeSecret,
      chatwootWebhook: !!s.chatwootWebhookToken && !!s.chatwootServiceToken,
      metaLeads: !!s.metaLeads,
      metaLeadIntake: {
        pollingEnabled: s.metaLeads?.pollingEnabled || false,
        signedWebhookConfigured: !!s.metaLeads?.appSecret && !!s.metaLeads?.verifyToken,
        recentRuns: (await this.tenants.db.query("SELECT id,state,started_at,finished_at,received_count,error_code FROM crm_lead_sync_runs WHERE workspace_id=$1 ORDER BY started_at DESC LIMIT 10", [currentTenant().workspaceId])).rows,
      },
    };
  }
  async save(kind: string, body: unknown) {
    this.tenants.requireRole("admin");
    const a = currentTenant();
    let value: any;
    if (kind === "feedback") value = feedbackSchema.parse(body);
    else if (kind === "model") {
      value = modelSchema.parse(body);
      if (value.provider !== "mock") {
        if (!value.baseUrl || !value.model || !value.apiKey)
          throw new BadRequestException("model_configuration_required");
        const url = new URL(value.baseUrl);
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          !(process.env.SAAS_MODEL_ORIGINS || "https://api.openai.com")
            .split(",")
            .includes(url.origin)
        )
          throw new BadRequestException("model_origin_not_allowed");
      }
    } else if (kind === "metaLeads") value = metaLeadSchema.parse(body);
    else if (kind === "chatwoot")
      value = z
        .object({
          chatwootWebhookToken: z.string().regex(/^[a-f0-9]{64}$/),
          chatwootServiceToken: token,
        })
        .parse(body);
    else throw new BadRequestException("unknown_integration");
    const db = await this.tenants.registry.connect();
    try {
      await db.query("BEGIN");
      const row = (
          await db.query(
            "SELECT secrets FROM saas_tenants WHERE workspace_id=$1 FOR UPDATE",
            [a.workspaceId],
          )
        ).rows[0],
        secrets = this.tenants.unseal(a.workspaceId, row.secrets);
      if (kind === "chatwoot") Object.assign(secrets, value);
      else if (kind === "feedback")
        secrets.feedback = { ...secrets.feedback, ...value };
      else if (kind === "metaLeads")
        secrets.metaLeads = { ...secrets.metaLeads, ...value };
      else secrets[kind] = value;
      await db.query(
        "UPDATE saas_tenants SET secrets=$2 WHERE workspace_id=$1",
        [a.workspaceId, this.tenants.seal(a.workspaceId, secrets)],
      );
      if (kind === "feedback")
        await db.query(
          "UPDATE saas_tenants SET settings=jsonb_set(settings,'{feedbackMode}',$2) WHERE workspace_id=$1",
          [a.workspaceId, JSON.stringify(value.mode)],
        );
      await db.query("COMMIT");
      return { saved: true, credentialsReturned: false };
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
  }
}
