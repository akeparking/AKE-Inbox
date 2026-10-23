# Native Inbox channels and original-message archive

This deployment layer adds IMAP/SMTP email, a WhatsApp Web connector and an
independent archive to the existing Chatwoot demo. The sales application's
fictional email/WhatsApp fixtures remain fictional; real conversations live in
the native Inbox. OKKI writes and advertising delivery are unchanged.

## Runtime and installation

Use the existing Chatwoot 4.18.0 deployment and the reviewed Evolution API 2.3.7
image pinned by digest in `deploy/demo/compose.inbox.yaml`. Copy the deployment
files into the existing deployment root; preserve all existing volumes. The
working `.env` must select all overlays:

```dotenv
COMPOSE_FILE=compose.yaml:compose.sales.yaml:compose.inbox.yaml
```

Back up first. Create `runtime/inbox-archive` and `runtime/whatsapp-archive` with
mode 700. Install the archive initializer, capture job, exporter and timer before
connecting a real mailbox. Do not use `docker compose down -v`.

The email verification script accepts JSON on stdin with `account_id`, `brand`,
`brand_url`, and `email` (`address`, `password`, `imap_host`, `smtp_host`). It
checks IMAP and SMTP authentication without sending mail, writes a temporary
root-only configuration, and never prints passwords. Feed that configuration to
`configure-inbox.rb` through Rails runner stdin, then remove the temporary file.
The included helper uses IMAPS 993 and SMTPS 465. Other standard IMAP/SMTP port
and TLS combinations remain available through native Inbox settings.

`import-mailbox.rb` imports the current INBOX in batches bounded by Chatwoot's
500-message fetch limit. It archives original MIME before parsing, uses
BODY.PEEK, and does not delete source mail. Set `AKE_IMPORT_MAILBOX` to the
selected address. Repeat for larger mailboxes and verify counts; this does not
import a separate Sent folder. Newly received mail uses the existing native
minute-by-minute IMAP scheduler.

Run `configure-whatsapp.py`, start `whatsapp-web`, and run
`bootstrap-whatsapp.rb` through Rails. Move its temporary output to
`private/whatsapp-chatwoot.json` with mode 600, and delete the temporary copy.
`link-whatsapp.py` creates the API inbox and protected callback configuration.
Start `whatsapp-archive`. Add this handler ahead of the default Inbox proxy:

```caddyfile
handle /whatsapp/dispatch {
  reverse_proxy whatsapp-archive:4312
}
```

Validate and reload Caddy. Set Chatwoot's `WEBHOOK_TIMEOUT` to 25 seconds. The
relay verifies Chatwoot's native timestamped HMAC signature and account/inbox
scope before forwarding to the private connector. Its URL contains no secret.
The unsigned API-inbox webhook is disabled to prevent duplicate deliveries. Do not enable global
`SAFE_FETCH_ALLOW_PRIVATE_NETWORK`: Chatwoot 4.18.0 blocks the connector's default
private webhook URL. The relay surfaces uncertain sends for human review and
does not blindly retry external messages. Duplicate callbacks are claimed once in SQLite; an interrupted send is retained for review.

Use the **AKE WhatsApp Connection** conversation to scan a QR code. `/init`
generates a new QR code; `/status` reports connector state. Pairing is incomplete
until the phone confirms the linked device. Start with new one-to-one messages;
historical import and groups are disabled in the shipped configuration. QR
creation alone is not a real WhatsApp send/receive acceptance test.

## Data retained

- Chatwoot's PostgreSQL database and original attachment volume remain the
  primary conversation store, including incoming, outgoing, private notes and
  state changes.
- `runtime/inbox-archive/messages/<id>/<sha256>.json` retains message versions.
  Conversation snapshots include source IDs, timestamps, state and contact data.
- Attachments are copied by their SHA-256 into `blobs/`; filenames and MIME types
  remain in the metadata. An asynchronous retry handles Active Storage's
  upload-after-commit timing. The 15-minute reconciliation timer repairs missed
  copies and fails explicitly if a required file cannot be read.
- `email/raw/<sha256>.eml` preserves the exact inbound IMAP MIME bytes before
  conversion into Inbox messages. Copies are independent of later source edits.
- WhatsApp's session and provider database are persistent. The separate SQLite
  event archive retains incoming/outgoing payloads, media metadata, deletion and
  update events. Transport API keys are excluded.
- Delivery callbacks and database reconciliation update each mapped outgoing
  API-inbox message. Read status does not regress to sent on an older callback.

This is an operational archive, not immutable/WORM storage. Native updates
observed after installation retain earlier versions; already-lost source data
cannot be recreated. History/attachments that WhatsApp does not supply are not
claimed as archived. Group history and messages sent in other email clients are
outside the current import scope.

## Verification and recovery

The Ruby tests cover exact MIME bytes, original/edit versions, attachment hashes,
path-safe filenames and account isolation. Node tests cover durable reopening,
event deduplication, secret removal, authorization and monotonic status mapping.
`verify_archive.rb` creates labeled synthetic private notes and an attachment.
`verify_status.rb` and `verify_status.mjs` exercise delivery/read updates using
private synthetic API-inbox messages without contacting a WhatsApp recipient.

Run `backup-inbox.sh` from the deployment root. It validates PostgreSQL dumps,
SQLite integrity, archive files, attachment/session volumes and configuration
checksums. The secret callback configuration and Compose `.env` are included.
The separate existing sales backup remains necessary for the sales workspace.

Restore to an isolated copy first: verify SHA256SUMS, restore both databases and
the attachment/session volumes, restore archive directories and protected
configuration, and start with the same image digests and all Compose overlays.
Re-run reconciliation and read an old message and attachment. Local VPS backups
do not constitute an off-site backup.

References: [Chatwoot widget branding source](https://github.com/chatwoot/chatwoot/blob/v4.18.0/app/javascript/shared/components/Branding.vue),
[Chatwoot IMAP source](https://github.com/chatwoot/chatwoot/blob/v4.18.0/app/services/imap/base_fetch_email_service.rb),
[Evolution API release](https://github.com/evolution-foundation/evolution-api/releases/tag/2.3.7).
