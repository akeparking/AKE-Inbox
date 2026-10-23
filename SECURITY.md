# Security policy

Do not open a public issue containing credentials, customer data, raw messages, private knowledge, database dumps, or production screenshots.

For a security vulnerability, use GitHub's private vulnerability reporting for this repository. Include the affected component, a minimal reproduction, expected impact, and a suggested containment step. Remove all real tokens and personal data from the report.

The latest v0.2.x release receives best-effort security fixes; there is no contracted response-time commitment. Older source remains available for reproducibility, but is not automatically safe to deploy.

Use [private vulnerability reporting](https://github.com/akeparking/AKE-Inbox/security/advisories/new). Do not put actual credentials or customer records in a reproduction. If credentials have already escaped, revoke or rotate them before further sharing. The public-release audit is a source/secret review, not a penetration test or a guarantee that all vulnerabilities are absent.

Local development defaults to in-memory demo data and Mock advertising. It is not an internet-facing deployment configuration. Production requires private API/session/encryption keys, protected operator routes, PostgreSQL, TLS, configured origins and appropriate network isolation. Example values are not production credentials. Inbox automatic sending and OKKI writes require explicit per-installation enablement. Never publish runtime environment files, archives, exports, OAuth clients/tokens, private knowledge or WhatsApp sessions.

CI checks source and reachable Git history with Gitleaks and runs dependency auditing. Keep screenshots, logs and examples fictional. Git tags and source assets remain available for normal version retention; an actual secret/PII exposure is handled under the security exception in [VERSIONING.md](docs/VERSIONING.md).
