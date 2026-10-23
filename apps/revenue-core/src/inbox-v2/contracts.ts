import { z } from 'zod';

export const channelSchema = z.enum(['website', 'email', 'whatsapp']);
export type Channel = z.infer<typeof channelSchema>;
export type Mode = 'ai' | 'human_pending' | 'human' | 'paused';
export const controlSchema = z.object({
  action: z.enum(['takeover', 'resume', 'pause', 'block', 'unblock', 'unsubscribe', 'cancel_followups','verify_identity']),
  expectedRevision: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(8).max(100), reason: z.string().max(500).default(''),
});
export const fieldsSchema = z.object({
  company: z.string().max(250).nullable().default(null),
  country: z.string().max(100).nullable().default(null), city: z.string().max(150).nullable().default(null),
  projectLocation: z.string().max(500).nullable().default(null),
  projectType: z.string().max(200).nullable().default(null),
  parkingSpaces: z.number().int().nonnegative().nullable().default(null),
  products: z.array(z.string().min(1).max(200)).max(30).default([]),
  estimatedAmount: z.number().finite().nonnegative().nullable().default(null),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable().default(null),
  timeline: z.string().max(200).nullable().default(null),
});
export type Fields = z.infer<typeof fieldsSchema>;
export const createCustomerSchema=z.object({
  name:z.string().trim().min(2).max(200),contactName:z.string().trim().min(1).max(200),
  country:z.string().regex(/^[A-Z]{2}$/).optional(),bizType:z.string().trim().min(1).max(100).optional(),
  intentionLevel:z.number().int().nonnegative().optional(),
});
export const opportunitySchema = z.object({
  idempotencyKey: z.string().min(8).max(100), confirmed: z.literal(true),
  name: z.string().trim().min(2).max(200),
  // User's release requirement: all four are required, including on direct API calls.
  projectLocation: z.string().trim().min(3).max(500).refine(v=>!/^(unknown|tbd|n\/a|待定|未知|待确认)$/i.test(v),'Actual project location required'),
  products: z.array(z.string().trim().min(2).max(200).refine(v=>!/^(unknown|tbd|tbc|tba|n\/a|待定|未知|待确认|待补充|暂无)$/i.test(v),'Specific products required')).min(1).max(30),
  estimatedAmount: z.number().finite().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/),
  closeDate:z.iso.date().optional(),exchangeRate:z.number().finite().positive().optional(),
  reconcileExisting:z.boolean().default(false),
  companyId: z.string().regex(/^\d+$/).optional(),
  createCustomer: createCustomerSchema.optional(),
  contactIds: z.array(z.string().regex(/^\d+$/)).default([]),
  businessTypeId: z.string().regex(/^\d+$/), flowId: z.string().regex(/^\d+$/),
  stageId: z.string().regex(/^\d+$/), ownerId: z.string().regex(/^\d+$/),
}).refine(v => Boolean(v.companyId) !== Boolean(v.createCustomer), 'Select an existing customer or confirm a new customer');
export type OpportunityInput = z.infer<typeof opportunitySchema>;
export const knowledgeSchema = z.object({
  id: z.string().max(100).optional(), title: z.string().min(2).max(300), body: z.string().min(5).max(16000),
  sourceId: z.string().min(1).max(500), sourceHash: z.string().regex(/^[a-f0-9]{64}$/i),
  tags: z.object({ keywords: z.array(z.string().max(100)).default([]), products: z.array(z.string()).default([]), countries: z.array(z.string()).default([]), conditions: z.string().max(2000).default('') }).default({ keywords: [], products: [], countries: [], conditions: '' }),
});
export const exportSchema = z.object({
  format: z.enum(['pdf', 'csv', 'xlsx', 'zip']),
  conversationIds: z.array(z.number().int().positive()).max(200).optional(),
  contactId: z.number().int().positive().optional(), channel: channelSchema.optional(),
  from: z.iso.datetime().optional(), to: z.iso.datetime().optional(),
  includePrivate: z.boolean().default(false),
});
export type Actor = { userId: number; role: string; accountId: number; credentials: Record<string, string> };
export type Conversation = { account_id: number; conversation_id: number; contact_id: number; inbox_id: number; channel: Channel; mode: Mode; revision: number; native_status: string; profile: string; summary: string | null; last_inbound_at: Date | null; followup_count: number; group_key: string; blocked: boolean; opted_out: boolean; timezone: string | null; contact_profile: string };
export type Job = { id: string; account_id: number; conversation_id: number; group_key: string; kind: string; revision: number; payload: string; attempts: number; result?: any };
export function emptyProfile() { return { fields: fieldsSchema.parse({}), confirmed: [] as string[], evidence: [] as any[], asked: [] as string[] }; }

export function config() {
  const channels: Record<string, Channel> = JSON.parse(process.env.INBOX_CHANNELS || '{}');
  for (const [id, channel] of Object.entries(channels)) if (!/^\d+$/.test(id) || !channelSchema.safeParse(channel).success) throw new Error('Invalid INBOX_CHANNELS');
  const enabled = process.env.INBOX_V2_ENABLED === 'true';
  const effectiveFrom = process.env.INBOX_EFFECTIVE_FROM || '';
  if (enabled && (!process.env.FIELD_ENCRYPTION_KEY || !process.env.DATABASE_URL || !process.env.INBOX_INTERNAL_KEY || !process.env.CHATWOOT_API_TOKEN || !Number.isFinite(Date.parse(effectiveFrom)))) throw new Error('Inbox v0.2 requires encryption, database, internal authentication, Chatwoot and cutover date');
  return { enabled, accountId: Number(process.env.INBOX_ACCOUNT_ID || 1), channels,
    excluded: (process.env.INBOX_EXCLUDED_CONVERSATIONS || '').split(',').filter(Boolean).map(Number),
    autoSend: process.env.INBOX_AUTO_SEND === 'true', autoChannels:(process.env.INBOX_AUTO_CHANNELS||'').split(',').filter(Boolean), testContacts:(process.env.INBOX_TEST_CONTACT_IDS||'').split(',').filter(Boolean).map(Number), okkiWrite: process.env.OKKI_WRITE_ENABLED === 'true',
    effectiveFrom, chatwootUrl: (process.env.CHATWOOT_URL || '').replace(/\/$/, ''),
    publicChatwootUrl: (process.env.CHATWOOT_PUBLIC_URL || process.env.CHATWOOT_URL || '').replace(/\/$/, ''),
    origins: JSON.parse(process.env.INBOX_OKKI_ORIGINS || '{"website":9,"email":19,"whatsapp":10}') as Record<Channel, number>,
    internalKey: process.env.INBOX_INTERNAL_KEY || '', modelUrl: process.env.INBOX_MODEL_URL || '',
    exportRoot: process.env.INBOX_EXPORT_ROOT || '/tmp/ake-inbox-exports', archiveRoot: process.env.INBOX_ARCHIVE_ROOT || '',
  };
}
