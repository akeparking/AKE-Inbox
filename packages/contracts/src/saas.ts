import { z } from "zod";

export const tenantRoles = ["admin", "marketing", "sales", "viewer"] as const;
export type TenantRole = (typeof tenantRoles)[number];
const text = z.string().trim().min(1).max(300);
const optional = z.string().trim().max(600).nullable().optional();
export const revisionSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
});
export const companyInputSchema = z.object({
  name: text,
  country: z.string().length(2).nullable().optional(),
  website: z.url().nullable().optional(),
  industry: optional,
  ownerId: z.string().min(1),
  fields: z
    .record(
      z.string().max(80),
      z.union([
        z.string().max(1000),
        z.number().finite(),
        z.boolean(),
        z.null(),
      ]),
    )
    .default({}),
});
export const personInputSchema = z.object({
  displayName: text,
  companyId: z.string().nullable().optional(),
  email: z.email().nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  language: z.string().max(20).default("en"),
  buyingRole: optional,
  ownerId: z.string().min(1),
});
export const taskUpdateSchema = revisionSchema.extend({
  title: text,
  ownerId: z.string().min(1),
  dueAt: z.iso.datetime().nullable(),
  status: z.enum(["open", "done", "cancelled"]),
  result: optional,
});
export const quoteInputSchema = z
  .object({
    opportunityId: z.string().min(1),
    title: text,
    amount: z.number().finite().nonnegative().nullable(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable()
      .default(null),
    notes: z.string().max(5000).default(""),
    previousId: z.string().nullable().optional(),
    idempotencyKey: z.string().min(8).max(180),
  })
  .refine((v) => v.amount === null || !!v.currency, {
    message: "金额需要币种",
  });
export const outcomeInputSchema = revisionSchema
  .extend({
    status: z.enum(["won", "lost", "reopened"]),
    amount: z.number().finite().nonnegative().nullable().optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable()
      .optional(),
    occurredAt: z.iso.datetime(),
    evidence: z.string().trim().min(3).max(2000),
    idempotencyKey: z.string().min(8).max(180),
  })
  .refine(
    (v) =>
      v.status !== "won" ||
      (v.amount !== null && v.amount !== undefined && !!v.currency),
    { message: "赢单需要实际金额与币种；未知金额不能填零" },
  );
export const adConnectionSchema = z.object({
  provider: z.enum(["meta", "google"]),
  name: text,
  accountId: z.string().regex(/^\d{3,30}$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  timezone: z.string().refine((v) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: v });
      return true;
    } catch {
      return false;
    }
  }),
  enabled: z.boolean().default(false),
  mode: z.enum(["mock", "live"]).default("mock"),
  conversionMetric: z.string().max(120).default(""),
  apiVersion: z.string().regex(/^v\d+(?:\.\d+)?$/),
  credentials: z.object({
    accessToken: z.string().min(1).max(12000),
    developerToken: z.string().max(1000).optional(),
    loginCustomerId: z.string().regex(/^\d+$/).optional(),
    refreshToken: z.string().max(4000).optional(),
    clientId: z.string().max(1000).optional(),
    clientSecret: z.string().max(4000).optional(),
  }),
});
export interface AdMetricRow {
  date: string;
  campaignId: string;
  campaignName: string;
  spend: string | null;
  impressions: string | null;
  clicks: string | null;
  platformConversions: string | null;
}
export const pipelineSettingsSchema = z
  .array(
    z.object({
      id: z.enum([
        "discovery",
        "solution_fit",
        "quotation",
        "negotiation",
        "won",
        "lost",
      ]),
      label: text,
    }),
  )
  .length(6)
  .refine(
    (v) => new Set(v.map((x) => x.id)).size === 6,
    "Stage IDs must remain unique",
  );
export const knowledgeInputSchema = z.object({
  title: text,
  body: z.string().trim().min(3).max(16000),
  source: text,
  state: z.enum(["draft", "approved", "retired"]).default("draft"),
});
export const defaultPipeline = [
  { id: "discovery", label: "需求确认" },
  { id: "solution_fit", label: "方案沟通" },
  { id: "quotation", label: "报价" },
  { id: "negotiation", label: "商务洽谈" },
  { id: "won", label: "赢单" },
  { id: "lost", label: "输单" },
];
