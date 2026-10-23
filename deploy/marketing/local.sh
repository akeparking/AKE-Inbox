#!/usr/bin/env bash
set -euo pipefail
action="${1:-status}"
runtime="${LOCAL_RUNTIME_ROOT:-${2:-}}"
if [[ -z "$runtime" || ! -f "$runtime/private/compose.env" ]]; then
  echo 'Usage: LOCAL_RUNTIME_ROOT=<private runtime directory> bash deploy/marketing/local.sh start|status|stop|build'
  exit 2
fi
source_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$source_root"
compose=(docker compose --env-file "$runtime/private/compose.env" -f deploy/marketing/compose.local.yaml --profile marketing)
# A fresh isolated installation deliberately has no provider sessions or WordPress copy.
# Existing acceptance runtimes keep their original profiles.
if [[ ! -f "$runtime/private/local-install.json" ]]; then
  compose+=(--profile wordpress --profile waha)
fi
case "$action" in
  start) node deploy/marketing/prepare-frame.mjs "$runtime"; "${compose[@]}" up -d --no-build ;;
  status) "${compose[@]}" ps ;;
  stop) "${compose[@]}" stop ;;
  build) npm run build ;;
  *) echo 'Supported actions: start, status, stop, build'; exit 2 ;;
esac
