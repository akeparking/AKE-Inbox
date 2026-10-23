# Repository instructions

- Run development, test, and build commands from the repository root with Node.js 24+.
- Read `DESIGN.md` for visual changes. Use `design-md-orchestrator` when selecting or changing the design direction; focused edits can follow the existing design directly.
- Never log access tokens, raw webhook secrets, full phone numbers, full email addresses, or raw customer messages.
- Keep Meta Lead Ads ingestion, website CAPI, CRM-stage feedback, and Google Data Manager ingestion as separate adapters.
- `Lead`, platform lead IDs, click IDs, CRM IDs, and conversion event IDs are distinct identifiers.
- The v0.2 Inbox may write OKKI only through the account-scoped, explicitly enabled live connector with durable receipts and readback. Other adapters retain Shadow Pilot defaults; Feishu writes are not enabled. Advertising remains Mock for this Inbox release.
- Public examples must remain fictional; never commit CRM exports, customer messages, credentials, local knowledge files, or machine-specific paths.
