# Contributing

Use Linux/WSL, Node.js 24+ and npm. Read `AGENTS.md`, the root README and the feature-status matrix. Before editing, inspect the current branch/worktree and preserve unrelated changes.

Start with an issue describing the B2B workflow and expected outcome. Keep changes focused. Use only fictional data in tests, screenshots and issue reports. Never commit private environments, sessions, message archives or CRM exports.

Run `npm ci`, build `@ake/contracts`, then `npm test`, `npm run test:channels`, `npm run test:google-guards`, `npm run typecheck`, `npm run build` and `npm run check:public`. CI also runs independent PostgreSQL suites, Gitleaks against source/history and dependency auditing. A skipped integration test must be reported as skipped, not passed. Tests against live providers require separately authorized accounts and recipients.

Business invariants: preserve unknown versus explicit zero; keep company/contact/inquiry/opportunity/conversion IDs distinct; require evidence for suggested fields; preserve human review, authorization, idempotency, source attribution and durable receipts. Never reset uncertain sends to pending without reconciling the external result.

Describe the problem, resulting behavior, meaningful validation and any migration impact in the PR. Update documentation and CHANGELOG. Existing release tags and assets must remain intact; follow [VERSIONING.md](docs/VERSIONING.md).

Submit only contributions you are entitled to license under the project's MIT terms. Keep third-party notices. Report vulnerabilities through the private route in SECURITY.md.
