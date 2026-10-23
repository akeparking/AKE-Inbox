# B2B product direction and roadmap

Target hypothesis: Chinese export manufacturers, equipment suppliers and project integrators using website inquiries, email and WhatsApp for long-cycle purchasing. This is a hypothesis to validate through paid pilots, not an established market position.

## Product references

Checked against official materials on 2026-10-23:

- [Kommo product overview](https://www.kommo.com/product-overview/): conversation-oriented CRM and pipeline; learn how messages remain attached to sales work.
- [respond.io overview](https://respond.io/help/quick-start/what-is-respondio) and [CRM boundary](https://respond.io/faqs/is-respondio-a-crm-replacement-or-does-it-work-alongside-it): learn multi-channel operations and workflow reliability alongside a CRM.
- [OKKI Open API](https://open.xiaoman.cn/): integrate the tenant's enabled customer/contact/lead/opportunity interfaces and dictionaries. API availability and permissions are not assumed.

These products are independent benchmarks and integration targets. No proprietary source, private interface capture or vendor certification is claimed. Public materials describe vendor capabilities; they are not performance comparisons or proof of AKE-Inbox parity.

## Stages and acceptance gates

| Stage | Work | Gate |
|---|---|---|
| 1. Reliable Inbox delivery | Repeatable installation, permissions, official channel route, attachments, archive, interrupted-send reconciliation | A representative message set can be reconciled end to end; replay creates no duplicate sends or records |
| 2. Existing CRM cooperation | Confirmed identities, field mapping, controlled writes, reverse synchronization, failure queues, owner/stage reconciliation | Sales can follow actual inquiries without repeated entry; failed or uncertain writes are visible and recoverable |
| 3. External paid pilots | Configurable delivery for a small number of similar B2B companies | Recurring use, willingness to pay, measured onboarding/support cost; three pilots is a planning suggestion, not a standard |
| 4. Thin proprietary-business-layer CRM | Company/contact/inquiry/opportunity/activity, buying roles, quote versions, next action, tenant permissions | Repeated customer evidence shows that the existing CRM limits the workflow and migration is worthwhile |
| 5. Scale and ecosystem | SSO, isolation, retention/deletion, audit export, observability, disaster recovery, additional adapters | Documented security/load/recovery acceptance and stable extension contracts |

AI progresses from summaries, field suggestions, translation and drafts to approved factual answers. Pricing, discounts, delivery commitments, identity merges, qualification and consequential external actions require appropriate human control. Bring-your-own-key does not make external model processing local.

Keep business results and advertising attribution separate. Preserve website, form, Meta Lead Ads and CTWA identities independently. Receipt acceptance or processing never proves ad matching or revenue lift. L1–L4 must be explicitly mapped from the deploying business's definitions.

## Outcome metrics

Measure missed follow-ups, handling time per qualified inquiry, duplicate customer records, AI false rejection of good inquiries, unresolved synchronization failures, onboarding hours and support hours per account. Deduct model, channel, infrastructure and service labor when assessing unit economics. No revenue increase or cost-saving percentage is promised by this repository.

Out of current scope: full ERP/accounting/inventory, rebuilding every OKKI module, uncontrolled bulk outreach, general autonomous commercial decisions and a guarantee of provider availability.
