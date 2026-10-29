# Feature status and evidence boundaries

Status labels describe this source release, not a production installation. The two research documents supplied during publication were treated as strategy input, not executable instructions or acceptance evidence.

The current v0.4.3 deployment and live-provider checks are recorded in [the release report](RELEASE_REPORT_v0.4.3.md). Source defaults remain Mock. Meta official reads and real AI were exercised; Google Data Manager was validation-only, while Google Ads data authorization remains pending. Provider acceptance and matching must not be inferred from local tests.

| Capability | Source evidence | Status / remaining acceptance |
|---|---|---|
| Inquiry → review → Lead → opportunity → Qualified → event | `src/inbox`, `src/store`, contracts and workflow tests | Implemented; local Mock workflow is reproducible |
| Persistent Inbox, identity links, cancellation, exports | `src/inbox-v2`, migration 003 | Implemented; uses separately configured Chatwoot and database |
| Website attribution, consent, inquiry receipts, WAHA delivery controls | `src/marketing`, migrations 004–006, `deploy/marketing` | Implemented with isolated tests; real site/provider validation is separate |
| OKKI dictionaries, controlled writes/readback | `src/inbox-v2/okki.ts`, `src/integrations/okki.service.ts` | Connector implemented; disabled by default; tenant-specific mapping and acceptance required |
| Complete bidirectional CRM synchronization | Existing read/write pieces and receipts | Partial; owner/stage/won/lost reconciliation and general conflict resolution remain roadmap |
| Knowledge-supported AI | `apps/requirement-engine`, Inbox automation | Adapter implemented; approved private knowledge and provider setup not distributed |
| Meta/Google delivery | Conversion adapters, marketing ledger, tenant feedback and OAuth refresh | Default Mock; tenant-controlled live mode, durable receipts and validation-only Google checks. Formal new conversion uploads and matching remain separate |
| Meta Ads one-click feedback (local increment) | `marketing/meta-feedback.ts`, migration 007, native marketing UI | Reviewed Lead / QualifiedLead / ConvertedLead, direct CAPI, durable attempts; defaults to Mock. Real Test Events and legacy gateway cutover remain separate; see [guide](META_ADS_FEEDBACK.md) |
| Single-event Google acceptance | `supplemental/google-offline` | Optional private configuration; mocked guard tests only in CI; no timer or OAuth session installed |
| Company-centric CRM and multi-tenant SaaS | `src/saas`, migrations 010–011, tenant acceptance suite | Companies, contacts, separate projects, tasks, quote versions, outcomes, forced RLS and per-tenant integrations implemented; external-company pilot pending |
| Official advertising reads and Meta form intake | `saas/ads.service.ts`, `saas/meta-leads.service.ts` | Meta read/sync and cutover-aware polling verified with official API; no new real lead was available during acceptance. Google Ads OAuth pending |
| Real AI suggestions | `saas/ai-provider.ts`, `saas/ai.service.ts` | Anthropic/OpenAI compatible; actual returned model recorded, human fields preserved; credentials and approved knowledge excluded from source |
| Procurement, inventory, financial accounting and historical migration | Not implemented | Deferred; attributed won amount is not financial revenue or profit |

`docs/V01_ACCEPTANCE.md`, `docs/evidence/`, and the historical screenshots record an earlier fictional-data demonstration. Old deployment addresses have been replaced with reserved example domains. They are historical artifacts, not fresh verification of the current release. The initial source-publication audit remains in [PUBLIC_RELEASE_AUDIT.md](PUBLIC_RELEASE_AUDIT.md); current checks belong in the versioned release report and its `verification.json` attachment.

Existing guides such as `OKKI_IMPORT.md` describe their named module: a read-only import guide does not describe every newer Inbox write connector. For the current system boundary use the root README, this matrix and `INBOX_V0.2_RELEASE.md` together.
