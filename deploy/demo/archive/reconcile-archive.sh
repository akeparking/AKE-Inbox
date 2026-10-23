#!/usr/bin/env bash
set -euo pipefail
cd /opt/ai-sales-demo
exec 9>/run/ake-inbox-archive.lock
flock -n 9 || exit 0
docker compose exec -T chatwoot-web bundle exec rails runner /opt/ake-archive/export_archive.rb
