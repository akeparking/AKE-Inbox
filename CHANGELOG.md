# Changelog

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
