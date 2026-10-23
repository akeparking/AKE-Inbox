# Website conversation experience

The Chatwoot 4.18 extension shows a local-time timestamp under every public
message, the human sender's configured display name, and `AI Agent` for an
AgentBot sender. Visitor messages show `Delivered` after persistence and `Read`
after an authenticated human opens the conversation. A bot/native automatic
last-seen update cannot create a human read receipt. Marking a thread unread
does not retract a receipt already shown to a visitor. Failed sends retain
their native retry behavior and show `Not sent`.

The widget requests metadata through its existing authenticated visitor token.
The metadata endpoint uses native contact-inbox/HMAC scope, excludes private
notes, and returns neither message text nor email addresses. UI labels are
inserted as text. The scoped addon uses the pinned native `cwmsg-<id>` DOM
contract; its browser acceptance check must pass before upgrading Chatwoot.

## Email continuity

A Website inbox opts in by setting
`auto_assignment_config.ake_continuity_email_inbox_id` to an Email inbox in the
same account with working IMAP and SMTP. Native Website
`continuity_via_email` must also be enabled. No new email service or inbound
DNS delegation is needed for this deployment path.

Unread agent replies use the mapped mailbox for SMTP, From, and Reply-To. The
native two-minute notification delay and viewed-message suppression remain.
Replies arriving through that mailbox's existing IMAP poller are matched to
an actual public outgoing message reference, the same account and the original
contact email. The reply, attachment and native email metadata are appended to
the original Website conversation. An unrelated sender or invalid reference
uses the ordinary Email inbox behavior. IMAP deduplication recognizes replies
stored in Website inboxes, preventing later polls from replaying them.

Private notes are excluded by native recap filtering. The existing delivery
guard checks block/opt-out state after the queue delay, and the independent
archive retains raw incoming/outgoing MIME. Customer replies resume the
existing conversation; this does not import an agent's separate Sent folder.
The offline form no longer covers an existing visitor conversation.

## Deployment and recovery

Back up the native database, attachments, independent archive and configuration
with the deployment's existing Inbox backup script and verify its manifest.
Check deployed addon hashes against the baseline before replacing files.

Ship the addon files under `deploy/demo/archive` together, then recreate only
Chatwoot web/worker to refresh bind mounts and initializers. The separate sales
application and its release pointer do not change. Run
`configure-conversation-experience.rb` via Rails runner with JSON on stdin:
`account_id`, `website_inbox_id`, `email_inbox_id`, `bot_id`, `human_user_id`, and
`human_display_name`. The script preserves prior settings in a root-private
rollback receipt and makes email mandatory for new online conversations.
Copy that receipt out of the container into the verified backup directory.

Recovery restores the previous addon files, the Website inbox mapping and
pre-chat settings, and the two display-name fields from the receipt, followed
by web/worker recreation. Existing conversations, email and other channels
must remain intact; a database-wide restore is not needed for this change.

## Validation

`test/inbox-channels/conversation-experience.rb` runs only against a disposable
`chatwoot_test` database with `AKE_SEAT_TEST=true`. It checks visitor isolation,
real human receipts, sender names, timestamps, native recap/SMTP configuration,
same-conversation email replies, attachments, replay deduplication, invalid
references, and viewed-message suppression without sending email.

`test/inbox-channels/conversation-widget.py` uses the generated fictional
fixture to check the actual native widget in Chromium, including an operator
opening the conversation, mobile layout and a failed-send scenario. It never
prints its visitor token or login credentials. A production release also needs
an isolated self-mailbox SMTP/IMAP round trip and native widget smoke check.
