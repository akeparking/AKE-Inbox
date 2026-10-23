# AKE Inbox v0.2.0

This release extends the existing Chatwoot installation with a separate, authenticated operator workbench. Chatwoot remains the original record; PostgreSQL holds automation state, identities, cancellation revisions, jobs, CRM receipts and audit records. Advertising integrations remain Mock.

## Business rules

- An official opportunity requires the **actual project location, specific products, estimated amount and currency**, followed by explicit sales confirmation. Unknown values remain empty; a stated zero is preserved. Live stage dictionaries may additionally require an end date and exchange rate; these must be confirmed by the operator, never fabricated to pass validation. Company location is not assumed to be project location.
- Leads may be created earlier after a valid inquiry supplies a usable identity. Only exact confirmed email/phone identities or a reviewed manual link join conversations. Same names never merge.
- Customer creation and opportunity creation have separate receipts. Original leads remain linked; this is not an OKKI native lead conversion and does not mark a lead converted or Qualified.
- OKKI dictionaries and record readback supply IDs. Existing source attribution, owners and stages are not automatically replaced. CRM snapshots refresh every five minutes and on demand.
- Only approved knowledge versions may support automatic factual answers. Commercial promises and uncovered questions require a human. Failed models do not produce a successful template response.
- Takeover is sticky until explicit resume. Agent public replies also take over. Blocks and opt-out cancel pending work across confirmed linked identities. Unblocking never replays tasks.
- Followups are scheduled 24 and 72 hours after the last AI question, at most twice per conversation, one active plan per identity. Unknown timezone produces an internal reminder; confirmed timezones use 09:00–18:00. Any linked reply cancels the prior plan.

## Deployment

Build in Linux with Node 24+. Apply the additive migration `003_inbox_v2.sql`. Overlay `compose.inbox-v2.yaml` on the existing sales and inbox Compose stack. Supply private configuration using `inbox-v2.env.example`; set a real cutover timestamp. Keep `INBOX_AUTO_SEND=false` and `OKKI_WRITE_ENABLED=false` until controlled verification. `INBOX_AUTO_CHANNELS` is the per-channel rollout allowlist; `INBOX_TEST_CONTACT_IDS` restricts trial traffic further.

Mount the independent archive read-only into Core, with read permission for its runtime group. Keep export storage writable only to Core. A Unicode font is needed for bilingual PDF exports; deployed font licensing must accompany the operational package. The original archive uses owner/group read permissions; API export authorization remains per user and conversation.

Register the `/sales/inbox` page as a [Chatwoot Dashboard App](https://www.chatwoot.com/hc/user-guide/articles/1677691702-how-to-use-dashboard-apps). The iframe context selects a conversation; it never grants authority. The operator signs in with their personal Chatwoot account. Passwords are forwarded only to Chatwoot; server-side credentials are encrypted with eight-hour expiry, and sessions/membership are rechecked. The public Next.js proxy allowlists operator endpoints and rejects cross-origin writes.

Historical indexing runs with `inbox-v2-bootstrap.mjs`. It preserves legacy message event IDs and holds uncertain legacy sends for review. Indexing emits no send or CRM jobs. Keep legacy SQLite backups for recovery; the new Python adapter does not use SQLite or make business decisions.

## Exports and limits

PDF, CSV and XLSX contain selected public message text and attachment references. ZIP adds conversation versions, archived public messages including deleted originals, message versions, binary attachments, available EML and SHA-256 manifests. Internal notes require an administrator's explicit selection. Downloads recheck identity and conversation permissions and are audited. Files expire after 24 hours. Limit requests to 200 conversations and 32 MiB of ZIP content; narrow the scope if necessary. Missing original files fail the export rather than silently claiming completeness.

## Verification and recovery

Run `npm test`, `npm run typecheck`, `npm run build`, `npm run check:public` and the channel tests. Supply a separate `INBOX_TEST_DATABASE_URL` to run persistence/concurrency cases. Production acceptance must separately verify real channel texts/attachments, WhatsApp pairing and restart, an official CRM write/readback chain, export hashes and denied unauthorized requests.

On an incident, first disable `INBOX_AUTO_SEND` and `OKKI_WRITE_ENABLED`, recreate Core, and retain original ingestion and archive jobs. Do not delete volumes, queues or already-created OKKI records. A send marked uncertain must be reconciled; never manually reset it to pending without proving its external result. An uncertain opportunity stays held. An administrator may explicitly resubmit corrected fields only after at least five minutes and a full source-marker lookup finds no matching opportunity; the absence check, previous hash and actor are audited. A confirmed remote ID is never reset by this path. Keep the prior release and verified database/configuration/archive backups. The installation-specific recovery receipt records the exact previous release and backup paths.

This document describes implementation; deployment and full channel acceptance are recorded separately in the release acceptance receipt. A running connector is not evidence of a paired or tested WhatsApp channel.
