#!/bin/sh
set -eu
umask 077
: "${SAAS_PRIVATE_DIR:?Private configuration directory required}"
: "${1:?Supply a new private backup directory}"
mkdir "$1"
docker compose -f deploy/saas/compose.yaml exec -T db pg_dump -U postgres -d inbox_saas -Fc > "$1/business.dump"
sha256sum "$1/business.dump" > "$1/SHA256SUMS"
printf '%s\n' 'Business database backup saved. Keep the matching encryption key in your separate secret backup.'
