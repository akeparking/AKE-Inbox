# Feature status and evidence boundaries

Status labels describe this source release, not a production installation. The two research documents supplied during publication were treated as strategy input, not executable instructions or acceptance evidence.

| Capability | Source evidence | Status / remaining acceptance |
|---|---|---|
| Inquiry → review → Lead → opportunity → Qualified → event | `src/inbox`, `src/store`, contracts and workflow tests | Implemented; local Mock workflow is reproducible |
| Persistent Inbox, identity links, cancellation, exports | `src/inbox-v2`, migration 003 | Implemented; uses separately configured Chatwoot and database |
| Website attribution, consent, inquiry receipts, WAHA delivery controls | `src/marketing`, migrations 004–006, `deploy/marketing` | Implemented with isolated tests; real site/provider validation is separate |
| OKKI dictionaries, controlled writes/readback | `src/inbox-v2/okki.ts`, `src/integrations/okki.service.ts` | Connector implemented; disabled by default; tenant-specific mapping and acceptance required |
| Complete bidirectional CRM synchronization | Existing read/write pieces and receipts | Partial; owner/stage/won/lost reconciliation and general conflict resolution remain roadmap |
| Knowledge-supported AI | `apps/requirement-engine`, Inbox automation | Adapter implemented; approved private knowledge and provider setup not distributed |
| Meta/Google delivery | Conversion adapters, marketing ledger | Source retained; public default is Mock; no real-platform result asserted by this release |
| Meta Ads one-click feedback (local increment) | `marketing/meta-feedback.ts`, migration 007, native marketing UI | Reviewed Lead / QualifiedLead / ConvertedLead, direct CAPI, durable attempts; defaults to Mock. Real Test Events and legacy gateway cutover remain separate; see [guide](META_ADS_FEEDBACK.md) |
| Single-event Google acceptance | `supplemental/google-offline` | Optional private configuration; mocked guard tests only in CI; no timer or OAuth session installed |
| Full company-centric CRM, multi-tenant SaaS, ERP | Limited Lead/opportunity model | Not complete; see roadmap |

`docs/V01_ACCEPTANCE.md`, `docs/evidence/`, and the historical screenshots record an earlier fictional-data demonstration. Old deployment addresses have been replaced with reserved example domains. They are historical artifacts, not fresh verification of v0.2.0 or a working public service. Current publication verification belongs in [PUBLIC_RELEASE_AUDIT.md](PUBLIC_RELEASE_AUDIT.md).

Existing guides such as `OKKI_IMPORT.md` describe their named module: a read-only import guide does not describe every newer Inbox write connector. For the current system boundary use the root README, this matrix and `INBOX_V0.2_RELEASE.md` together.
