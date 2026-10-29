# Inbox + CRM SaaS implementation

This module extends the existing Next.js + NestJS + PostgreSQL + Chatwoot application. Enable it with `SAAS_MODE=true` on a dedicated database. Office mode remains the default. The SaaS browser entry is `/saas`; its BFF is `/api/saas/*`, and business routes are `/api/v1/saas/*`.

## Identity and isolation

Chatwoot validates the personal identity and Account membership on every request. The business membership maps that identity to one workspace with admin, marketing, sales or viewer role. Browser-supplied workspace/user headers do not select the tenant. Sessions are opaque, hashed in PostgreSQL, expire after eight hours and use an HttpOnly SameSite=Strict browser cookie. BFF writes require an allowed Origin.

The runtime role is neither owner, superuser nor BYPASSRLS. Every business connection is initialized with workspace/account context and reset before reuse. RLS fails closed without context. Composite tenant foreign keys protect CRM references. The registry is a deliberate control plane, with explicit workspace checks on membership/configuration operations. It is not a second business store. Encryption is derived per workspace; secrets are never returned by configuration endpoints.

## Business facts

A persistent inquiry, manual qualification, opportunity, quote revision and outcome are independent facts. An idempotency key identifies an opportunity command; it does not merge separate projects because they share a contact. Quote revisions are immutable and reference the previous latest version. Expected versions prevent concurrent overwrites. Outcomes retain evidence and timestamps; reopening or correcting a win recalculates current reports and puts any prior win event into review instead of sending it again.

Existing `LeadQualified` events and delivery rows are reused. `OpportunityWon` adds a transactional business outbox. SaaS dispatch is an explicit reviewed operation with a durable intent written before transport. Unknown sends are never automatically retried. Only explicit authorization/rate rejections can be rearmed, preserving the prior attempt in history. Google processing is polled without re-upload; matching stays unknown unless separately verified.

## Marketing

Meta Insights and Google Ads Search are independent read adapters. Account metadata is verified before readback. Metrics are stored by workspace, connection, local date and campaign. API version and exact Meta conversion action are configured, not inferred. Costs retain original precision/currency; absent values remain NULL. A daily completion table distinguishes a completed empty day from an unread day. Partial runs checkpoint completed days; replacement by date avoids double accumulation.

The default schedule is hourly with daily 30-day rechecking. The report uses an inquiry cohort by tenant timezone and current winning facts for that cohort. First-touch and last-non-direct views count each opportunity once. No exchange rate is invented; mismatched timezone/currency or incomplete spend suppresses ratios. This is attributed won amount / advertising spend, not financial revenue or profit ROI.

## Integrations and limitations

Normalized server-side intake is signed and replay-protected. Chatwoot messages are verified through the official Account API before creating CRM records. Native Meta lead capture has its own HMAC verifier and official lead retrieval adapter. Existing website collectors must be connected to the signed tenant intake endpoint during deployment; browser code must never receive the signing key.

This first implementation retains six stable stage semantics with editable names, one primary contact per opportunity, company-level multiple contacts, JSON exports and recorded quote versions. Arbitrary stage creation, opportunity contact role lists, no-code form building, new attachment storage, automatic subscriptions and historical migration are follow-up scope. Native Chatwoot remains responsible for mailbox/WhatsApp channels, attachments, collaboration and mailbox bounce protection. AI suggestions do not overwrite human fields or send replies.

## Verification

Run the standard root checks. `npm run test:saas` additionally requires an isolated, disposable PostgreSQL database, `SAAS_MODE=true`, `SAAS_TEST_MODE=true`, `STORE_DRIVER=postgres`, `FIELD_ENCRYPTION_KEY`, a nonowner `DATABASE_URL` with role `saas_runtime`, and an owner `SAAS_TEST_ADMIN_URL`. The acceptance test resets only its supplied dedicated test schema; never use production credentials. It boots the real Nest application, fake Chatwoot, real RLS, API requests and controlled provider fixtures. Real ad API authorization, Google propagation/matching and external-company pilot approval remain separate acceptance gates.

Deployment, provisioning, rollback and backup: [deployment guide](../../deploy/saas/README.md).
