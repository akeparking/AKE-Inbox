#!/usr/bin/env bash
set -euo pipefail
umask 077
cd /opt/ai-sales-demo
inbox_backup_dir="backups/inbox-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$inbox_backup_dir"
for database in chatwoot whatsapp_web; do
  docker compose exec -T postgres pg_dump -U postgres -Fc "$database" > "$inbox_backup_dir/$database.dump"
  docker compose exec -T postgres pg_restore --list < "$inbox_backup_dir/$database.dump" > "$inbox_backup_dir/$database-contents.txt"
done
docker exec ai-sales-demo-whatsapp-archive-1 node --input-type=module -e '
import { DatabaseSync, backup } from "node:sqlite";
const db = new DatabaseSync("/data/events.sqlite");
await backup(db, "/data/backup.sqlite");
db.close();'
docker cp ai-sales-demo-whatsapp-archive-1:/data/backup.sqlite "$inbox_backup_dir/whatsapp-events.sqlite"
python3 - "$inbox_backup_dir/whatsapp-events.sqlite" <<'PY'
import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as database:
    assert database.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
PY
tar -czf "$inbox_backup_dir/original-archive.tar.gz" runtime/inbox-archive
tar -czf "$inbox_backup_dir/config-private.tar.gz" .env compose.yaml compose.sales.yaml compose.inbox.yaml deploy/archive deploy/whatsapp deploy/ake-mark.svg \
  private/chatwoot.env private/postgres.env private/redis.env private/whatsapp.env private/whatsapp-config.json private/whatsapp-chatwoot.json private/whatsapp-archive.json private/whatsapp-relay.json
for volume in chatwoot-storage whatsapp-sessions; do
  docker run --rm --network none --entrypoint sh \
    -v "ai-sales-demo_$volume:/source:ro" -v "$PWD/$inbox_backup_dir:/out" node:24-alpine \
    -c "tar -C /source -czf /out/$volume.tar.gz ."
done
(cd "$inbox_backup_dir" && sha256sum *.dump *.sqlite *.tar.gz > SHA256SUMS && sha256sum -c SHA256SUMS)
chmod -R go-rwx "$inbox_backup_dir"
printf 'Inbox backup verified: %s\n' "$inbox_backup_dir"
