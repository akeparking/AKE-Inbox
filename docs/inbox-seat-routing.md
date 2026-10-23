# Inbox seats, channels and customer workspace

Chatwoot 4.18 remains the conversation store and permission boundary. The extension
adds a channel navigation bar, an authenticated `/ake/channels` page, a customer
workspace at `/ake/customers`, and an offline form inside the website widget.

## Reception rules

- Administrators see every conversation. Existing historical email and WhatsApp
  inboxes remain assigned to the administrator, outside website rotation.
- An agent can read only conversations currently assigned to that agent. The same
  boundary covers direct URLs, lists, search, contact history, notes, notifications,
  live broadcasts and the customer workspace.
- Website inquiries rotate across confirmed, online agents. A database lock
  serializes the native Redis rotation for concurrent arrivals. Pending invitations,
  offline agents and administrators are excluded.
- Presence updates enqueue a bounded backlog assignment job. Offline website
  inquiries stay unassigned until a confirmed agent becomes available.
- Each personal channel has `ake_owner_id` in its inbox assignment configuration.
  WhatsApp instances are separate. Mailboxes are created only after IMAP and SMTP
  login verification succeeds. A failed update preserves prior credentials.
- Personal channels use human reception and the existing CRM intake rules.
  Automatic reception on new personal channels requires an explicit future channel
  configuration and the same sending controls used by the original channels.

## Customer records and offline intake

The customer table includes contacts with visible conversations. OKKI is the
primary CRM source: existing links supply company, owner, stage and opportunity
snapshots. Refresh reads official customer and follow-up APIs. This view does not
bulk-import, overwrite CRM records or change existing customer-creation rules.

The widget shows an email/name/company/message form when no eligible agent is
online. Submissions are validated, stored with an idempotency key and placed in the
human callback queue. They do not trigger an immediate AI reply. The native
website color and AKE branding are retained.

Official WhatsApp Web is available through an external link. Its frame policy
prevents embedding it in this application's iframe. Synchronizing conversations
still requires the independently paired connector; adding a URL alone does not
provide access to messages.

## Deployment and rollback

Back up the three application databases, the private channel configuration, all
existing archive extensions, WhatsApp relay files and the two changed compiled
Core modules. Compare their hashes before applying updates.

Deploy `archive/ake_*.rb`, the associated `ake-*.js`/HTML assets, the updated
WhatsApp relay, and the compiled Inbox automation/controller modules. The archive
directory must be mounted at `/opt/ake-archive` in web and worker containers.
Run `configure-seat-channels.py` from the deployment root. It preserves a private
provision receipt, creates unpaired instances, saves signed relay bindings and
sets `AKE_SEAT_ROUTING_ENABLED` and `AKE_WHATSAPP_API_KEY` in the existing private
environment file. It does not activate invitations, send email or pair a phone.

Restart Core and the WhatsApp relay; recreate Chatwoot web/worker to load the
updated environment. Verify native login, the five administrator channel choices,
each agent's own settings, QR generation, widget availability and customer views.
The user's phone scan and mailbox authorization codes remain required.

Rollback restores saved code and private configuration, then restarts the same
services. The provision receipt contains prior memberships and assignments.
Review any new conversations before restoring ownership; do not restore an old
whole database over new customer activity. Newly created, unpaired instances can
remain disabled while investigating rather than deleting channel history.

## Verification

Run from the repository root on Linux with Node 24+:

```bash
node --test test/inbox-channels/whatsapp.test.mjs
INBOX_TEST_DATABASE_URL=postgresql://... npx vitest run apps/revenue-core/src/inbox-v2/inbox-v2.test.ts
CHATWOOT_TEST_IMAGE=your-local-chatwoot-4.18-image test/inbox-channels/run-seat-tests.sh
npm run build -w @ake/revenue-core
```

The native test script creates a private Docker network and disposable databases,
never starts a mail worker, and uses fictional records. Browser acceptance also
checks the native channel bar, customer detail, QR controls and a 360px widget.

Design references: [respond.io Inbox](https://respond.io/help/inbox/getting-started-with-inbox),
[OKKI form guide](https://xiaomanhelp.yuque.com/qrqrfu/ig3ops/zx6gam6lzzqrytim),
[OKKI API index](https://open.xiaoman.cn/llms.txt). The user's supplied message,
customer-list and offline-form screenshots informed the layout.
