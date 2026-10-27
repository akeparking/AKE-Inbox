#!/usr/bin/env bash
# Integration checks use an isolated network and fictional records. No worker runs.
set -euo pipefail
project=$(cd -- "$(dirname -- "$0")/../.." && pwd)
fixture=${1:-seat-routing}
case "$fixture" in
  seat-routing|conversation-experience|desktop-access) ;;
  *) echo 'Expected seat-routing, conversation-experience or desktop-access' >&2; exit 2 ;;
esac
office=false
if [[ "$fixture" == desktop-access ]]; then office=true; fi
name="ake-seat-tests-$$"
image="${CHATWOOT_TEST_IMAGE:-chatwoot/chatwoot@sha256:b419dded7e9d2f54a24fd427b74ba7e6069d601b500618045c1eb6c01a1cc9a1}"
cleanup() {
  docker rm -f "$name-app" "$name-db" "$name-redis" >/dev/null 2>&1 || true
  docker network rm "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker network create --internal "$name" >/dev/null
docker run -d --name "$name-db" --network "$name" -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=chatwoot_test pgvector/pgvector:pg16 >/dev/null
docker run -d --name "$name-redis" --network "$name" redis:7.4-alpine >/dev/null
for attempt in {1..30}; do
  if docker exec "$name-db" pg_isready -U postgres -d chatwoot_test >/dev/null; then break; fi
  sleep 1
done
args=(--rm --name "$name-app" --network "$name" -e RAILS_ENV=production
  -e SECRET_KEY_BASE=isolated-test-only-A1-4c270522319bbe444447685e84959659
  -e "POSTGRES_HOST=$name-db" -e POSTGRES_USERNAME=postgres -e POSTGRES_DATABASE=chatwoot_test
  -e "REDIS_URL=redis://$name-redis:6379" -e FRONTEND_URL=http://localhost -e ACTIVE_STORAGE_SERVICE=local
  -e AKE_SEAT_ROUTING_ENABLED=true -e AKE_SEAT_TEST=true
  -e "AKE_OFFICE_RECEPTION_ENABLED=$office"
  -v "$project/deploy/demo/archive:/opt/ake-archive:ro"
  -v "$project/deploy/demo/archive/ake_inbox_control.rb:/app/config/initializers/ake_inbox_control.rb:ro"
  -v "$project/test/inbox-channels/$fixture.rb:/tmp/$fixture.rb:ro"
  --entrypoint bundle "$image" exec rails)
docker run "${args[@]}" db:chatwoot_prepare
docker run "${args[@]}" runner "/tmp/$fixture.rb"
