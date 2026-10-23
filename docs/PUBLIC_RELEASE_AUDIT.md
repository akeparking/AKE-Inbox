# v0.2.0 public-source preparation

Date: 2026-10-23 (Asia/Shanghai). Scope: the supplied source snapshot and supplemental scripts, prepared as a new public repository. The original source directory, ZIP, research attachments, private deployments and running business services were not modified.

## Preservation and sanitization

- The snapshot contains 264 source files and eight supplemental files. All 272 remain represented; two installation-specific timer/service names became inert `.example` templates. No business module, migration or existing test directory was dropped.
- Original files were hashed before copying and checked again after preparation. Private metadata, old Git objects, handoff receipts and the original backup ZIP are not publication inputs.
- Account/destination/customer identifiers, an installation mailbox, personal paths and deployment links were removed or parameterized. No plaintext value is reproduced in this report.
- The Google acceptance workflow still has explicit opt-in, destination/evidence checks, expiry, one-upload-attempt state, status retrieval and reconciliation. Private report generation now uses actual receipts, without hardcoded customer claims or edits to unrelated installation handoff files.
- API/model/CRM credentials remain runtime inputs. Fictional test values and reserved example domains remain usable. Archives, databases, OAuth files, provider sessions, environment files and generated build keys are excluded from the public source.
- MIT copyright/license retained. Project provenance, third-party boundaries and commercial-product comparisons are documented without publishing the research attachments.

## Verification

| Check | Result |
|---|---|
| Requirement-engine tests | 4 passed |
| Contract tests | 2 passed |
| Core tests with three isolated PostgreSQL databases | 68 passed; persistence tests enabled, not skipped |
| Web formatting tests | 2 passed |
| WhatsApp/WAHA channel and send guards | 15 passed |
| Google task guards with mocked commands | 10 passed; no Google requests |
| Ruby archive tests | 5 passed, 15 assertions, isolated container |
| Ruby mailbox-suppression configuration regression | 5 passed, 5 assertions, no email transport |
| TypeScript checks and production build | Passed |
| Python source syntax | 25 existing Python files parsed successfully |
| Browser inquiry → review → opportunity → Qualified → Mock receipt | 14 checks passed, including login, replay deduplication, denied bridge/CSRF access and mobile layout |
| Public landing page | Source link and bundled fictional preview verified; no request for the absent demo video |
| Dependency audit after updates | 0 known advisories at audit time; Next.js 16.4.2, Vitest 4.1.12, Vite 8.3.5 |
| Public-file checks | Passed; private paths, non-example environments, database/key artifacts and symlinks rejected |

The automated test total above is **111**, plus the browser acceptance checks. This is not a blanket guarantee of identical behavior on every deployment.

Gitleaks 8.30.1 was obtained from the upstream release with its SHA-256 verified. The expanded original snapshot had no detected secrets. Before publication the exact staged source and the new Git history are scanned separately with redacted reports; release ZIP/TAR.GZ files are generated from the release tag and checksummed. Build-generated Next.js signing/encryption values are runtime artifacts, not source; `.next` is ignored and never packaged.

## Limits

This release did not contact production WordPress/Chatwoot/OKKI installations, send customer messages, access authenticated Google pages, upload advertising events, acquire OAuth/browser sessions or revalidate historical live receipts. The full native Chatwoot/WordPress deployment suites and real-channel acceptance need their separately configured environments. Old demonstration evidence remains explicitly historical. A clean secret scan and dependency audit do not constitute a penetration test.

For a new installation, generate fresh private secrets and configure its own channel IDs, mailbox exclusion, CRM dictionaries, approved knowledge and acceptance scope. Default Mock/disabled-write settings remain. See [FEATURE_STATUS.md](FEATURE_STATUS.md), [SECURITY.md](../SECURITY.md) and [VERSIONING.md](VERSIONING.md).
