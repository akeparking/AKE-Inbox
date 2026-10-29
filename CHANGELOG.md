# Changelog

## [0.3.1] - 2026-10-29

- Reuse the current database transaction for Meta eligibility checks so six simultaneous sends cannot exhaust the shared pool.
- Lock and reload the latest inquiry before dispatch. Source corrections invalidate unsent prepared events and cannot race an in-flight upload.
- Check the legacy ledger in both Meta Test and Live modes. Quarantine legacy automatic Live Meta work and prohibit its replay; Mock and other advertising providers retain their existing paths.
- Share strict Meta transport receipt validation, bounded requests, sanitized errors and uncertain-outcome handling across adapters.
- Start a new visit when advertising consent is granted later, preserving old consent records and collecting only newly observed context.
- Add PostgreSQL and Mock regressions for all five audited failures. No new schema migration is needed when upgrading from v0.3.0; replace Core API and worker together.
- Keep advertising in Mock. Windows physical acceptance, the eight-hour soak and live provider acceptance are not claimed for this patch.

## [0.3.0] - 2026-10-28 (prerelease)

- Integrated the audited desktop/office branch and manual Meta feedback branch without replacing account data, channel bindings or encryption keys.
- Added an OKKI-inspired charcoal navigation, blue channel states, authenticated customer/inquiry context and consistent marketing navigation. Chinese staff UI and English customer widget remain separate.
- Added additive Meta feedback and legacy receipt migrations after the existing office reception migration; release version is visible in Core health.
- Deploy with Mock advertising and disabled OKKI writes. No real Meta acceptance, matching or connected email/WhatsApp acceptance is claimed.
- Added manual Meta Ads feedback to Inbox: reviewed stage preparation, direct CAPI delivery, durable receipts and duplicate-click protection, with independent Mock/Test/Live modes.
- Kept website attribution separate from native Instant Form CRM events, added consented Meta click capture and a shared optional Pixel/server Lead event ID.
- Added local blue-site acceptance tooling; existing Google feedback remains independently configured. No production Meta acceptance or old gateway shutdown is asserted.

## [0.2.2] - 2026-10-27 (prerelease)

- Preserve retryable native delivery failures when Core admission is unavailable before provider dispatch. Explicit policy blocks are visible as failed messages; final email admission failures cannot be recorded as successful sends.
- Require current Inbox membership as well as assignment for restricted conversation/contact reads and staff broadcasts. Preserve explicit administrator and visitor access.
- Count failed sign-ins per normalized login in the existing shared database, instead of counting successful office logins against one proxy IP. Concurrent Core processes share the same limit; success clears failures.
- Preserve the native session cookie expiry during token rotation, including expired-token deletion.
- Maintain marketing collector/consent scripts once and check generated WordPress copies during public-release validation.
- Add regression coverage for admission outages, human takeover, membership revocation, concurrent logins and rotated cookies. No database migration or channel rebinding is required.
- Windows physical acceptance and the eight-hour soak remain unexecuted for this version. Publish as a prerelease; live channel/CRM/advertising acceptance is not claimed.

## [0.2.0] - 2026-10-23

First public AKE-Inbox source release, based on the full supplied Inbox snapshot.

- Retained Inbox/CRM, AI requirements, marketing/WordPress, channel adapters, archives, exports, migrations and tests.
- Removed installation-specific account/case details and private paths; configurable mailbox suppression and inert Google acceptance timer templates preserve reusable behavior.
- Kept explicit opt-in and bounded single-event validation/upload/reconciliation guards; default advertising remains Mock and automatic sending/OKKI writes remain disabled.
- Added B2B scope, project attribution, feature boundaries, competitor references, roadmap, contribution/security guidance and old-version source retention rules.
- Expanded CI to include isolated persistence suites, channel guards, Google job guards and secret/history scanning.
- Updated vulnerable Next.js/Vitest dependencies and refreshed the affected transitive Vite dependency; see the release audit for exact checks.

Earlier v0.1 demonstration artifacts are historical reference material, not a previous release of this repository. See the provenance notice and versioning policy.

[0.2.0]: https://github.com/akeparking/AKE-Inbox/releases/tag/v0.2.0

[0.2.2]: https://github.com/akeparking/AKE-Inbox/releases/tag/v0.2.2
[0.3.1]: https://github.com/akeparking/AKE-Inbox/releases/tag/v0.3.1
