# Changelog

## v0.4.3 — 2026-10-29

- 整合 v0.4.2 审查修复，增加真实平台配置和验证状态展示。
- Meta 官方广告数据同步、带切换时间和去重的原生表单定时收件；原生表单 CRM 阶段保持正确来源语义。
- Google Ads 移除已停用的 developer token 门槛；Data Manager 增加租户内持久 OAuth 刷新。Google Ads 新增授权按用户要求保留待验收。
- AI 支持 Anthropic 兼容协议，记录实际返回模型；真实摘要、字段建议、翻译和草稿保持人工确认边界。
- 新增迁移 011；升级保留原有询盘、审计、回传回执和原生渠道配置。详见 `docs/LIVE_INTEGRATIONS.md`。


## v0.4.2 — 2026-10-29

- Preserve v0.4.0 tenant Inbox/CRM, quote history, outcomes, advertising reports, AI and desktop routing.
- Port all five v0.3.1 audit fixes: reuse transaction connections, serialize attribution corrections, retire the old automatic Meta Live queue, preserve newly granted visit context, and hold incomplete/unknown Meta receipts.
- Reject contradictory or malformed Meta receipts in the SaaS feedback path; retain explicit authorization-rejection retry and tenant-scoped durable send intents.
- Add 19 regressions over v0.4.0, including the 14 ported cases and five SaaS receipt/concurrency/isolation cases. Publish fresh audit evidence with the release.
- No new SQL migration from v0.4.0. Update Core API and worker together; preserve existing records and reconcile in-flight/legacy sends. This release does not deploy services or enable provider Live mode.


## [0.4.0] - 2026-10-29

- Extended the deployed v0.3.0 baseline with tenant-scoped companies, contacts, independent inquiry qualification, multiple projects, follow-ups, quote revisions and auditable outcomes.
- Added verified personal sessions, organization membership, forced row security, tenant settings and isolated AI suggestions.
- Added Meta/Google daily metrics, resumable synchronization, first/last-touch attribution and reviewed qualified/won feedback with durable duplicate prevention.
- Added the `/sales/saas` office entry and signed integration ingress. The office remains the single business writer; the VPS relays the entry and runs isolated acceptance only.
- Routed the native CRM link into the desktop workspace pane, restricted to its configured origin. Native webhook verification uses the canonical token header accepted across the public proxy.
- Added `010_saas_crm.sql` after the v0.3.0 migrations and a dedicated SaaS CI job. Published versions and source archives remain immutable.
- Includes the current Windows client and complete source. Real ad-platform acceptance, external-company pilots and new Windows endurance measurements remain separately recorded.

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
