#!/bin/sh
set -eu
: "${SAAS_RUNTIME_PASSWORD:?Runtime password required}"
# Values are passed through psql variables and quote_literal, never shell-expanded SQL.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v ON_ERROR_STOP=1 --set=runtime_password="$SAAS_RUNTIME_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE saas_runtime LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD %L', :'runtime_password')
WHERE NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='saas_runtime') \gexec
SQL
