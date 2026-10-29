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
      wonConversionActionId: numeric,
      validateOnly: z.boolean().default(true),
    })
    .optional(),
});
const modelSchema = z.object({
  provider: z.enum(["mock", "openai-compatible"]),
  baseUrl: z.url().optional(),
  model: z.string().min(1).max(200).optional(),
  apiKey: token.optional(),
});
const metaLeadSchema = z.object({
  appSecret: token,
  verifyToken: token,
  pages: z
    .array(
      z.object({
        pageId: numeric,
        accountId: numeric,
        accessToken: token,
        apiVersion: z.string().regex(/^v\d+\.\d+$/),
      }),
    )
    .min(1)
    .max(20),
});

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
