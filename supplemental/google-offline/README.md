# Optional Google offline acceptance tools

These scripts preserve the bounded, single-event validation/upload/status/replay workflow from the source snapshot. They are **not** run by the application, normal tests, CI or installation. The public release supplies no account, customer, OAuth session, click ID or scheduled task. Advertising in the normal application remains Mock.

`python3 supplemental/google-offline/test-job.py` uses fictional receipts and mocked commands; it makes no Google requests. `google-job.py --check` checks a prepared private manifest without using the network. `inspect-case.mjs` reads only the explicitly configured isolated database. `update-google-report.py` renders private JSON/Markdown/HTML from actual receipts; it no longer modifies an installation's unrelated handoff reports.

## Private configuration contract

| Variable | Purpose |
|---|---|
| `GOOGLE_ACCEPTANCE_ROOT` | Absolute private directory containing `private/` and `evidence/` |
| `GOOGLE_AUTH_ROOT` | Private OAuth and operator-attestation directory |
| `GOOGLE_TEST_DATABASE_URL` | Dedicated **local** PostgreSQL URL; database name must start with `ake_google_acceptance` |
| `GOOGLE_OFFLINE_LIVE_ENABLED` | Must explicitly equal `true` before any OAuth or live acceptance operation |
| `GOOGLE_REPORT_ROOT` | Optional private report output; unset disables automatic reporting |
| `NODE_BINARY` | Optional Node 24+ executable; defaults to `node` on PATH |
| `GOOGLE_ACCEPTANCE_TIMER` | Optional installed timer name |

Use your existing proxy environment. Do not copy someone else's OAuth files, browser session or runtime database. Use an authorized Google account and explicit consent evidence for the specific event. These scripts do not acquire browser sessions.

Prepare these files privately; the descriptions below contain no live values:

- `private/acceptance-scope.json`: non-empty string fields `inquiry`, `serial`, `leadId`, `accountId`, `actionId`, `targetName`, `oauthProjectId`. Values must match the specific operator-approved event and destination.
- `evidence/google-conversion-target.json`: `accountId`, `actionId`, `name`, `optimization: "secondary"`, `settingsReadBack: true`, `count: "ONE"`, `value: "not_used"`, and an ISO `uploadNotBefore` timestamp established from the target's setup evidence.
- Under `GOOGLE_AUTH_ROOT`: `private/google-oauth-client.json` (installed-app client), `private/google-oauth-token.json` (including scope and expiry), `private/selected-attribution.json` (approved serial, lead ID, source URL, landing URL, UTM and existing GCLID), and `evidence/google-operator-confirmation.json` (`inquiry`, `confirmedAt`, `dataCollectionAndSharingAttested: true`, `qualification: "confirmed"`). These fields require actual evidence, not fabricated consent or click IDs.
- After explicit preparation, `private/google-case.json` stores the generated event/delivery IDs, private encryption key and durable attempt count. Never publish it.
- `private/execution-manifest.json`: `files` containing the absolute path and SHA-256 of every approved input and script, `eventId`, `deliveryId`, `target: { accountId, actionId }`, and an ISO `expiresAt`. Pin the scope, target, attestation and source attribution files; exclude rotating OAuth/receipt files. Review this manifest before activating a timer.

The explicit entry points are `google-acceptance.mjs prepare|validate|upload|status|replay`. Build Revenue Core first. Preparation creates a separate database if absent. Review scope and resulting state before generating the execution manifest. Upload requires a successful validation of the same payload, preserves the documented qualification time and permits at most one upload attempt. Uncertain results require reconciliation; receipt retrieval must never turn into a second upload.

The `.service.example` and `.timer.example` files are inert templates. Install them only after configuring a private mode-0600 environment file, updating the checkout path, verifying the manifest and expiry, and explicitly authorizing the schedule. This repository does not claim real-platform processing or attribution acceptance. An accepted or processed request does not establish successful ad matching.
