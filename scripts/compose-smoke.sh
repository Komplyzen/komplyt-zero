#!/usr/bin/env bash
# Smoke test for docker-compose.yml: boots the database and the server (fixture embeddings, so no
# Ollama and no model download), makes one MCP call, and asserts the container hardening holds.
# Needs Docker with the Compose plugin. Cleans up after itself. Usage: scripts/compose-smoke.sh
set -euo pipefail
cd "$(dirname "$0")/.."

export COMPOSE_PROJECT_NAME=kg-smoke
export DB_ROOT_PASS KG_JWT_SECRET EMBEDDING_PROVIDER=fixture
DB_ROOT_PASS=$(openssl rand -hex 16)
KG_JWT_SECRET=$(openssl rand -hex 32)

cleanup() { docker compose down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT
fail() { echo "compose-smoke: $*" >&2; docker compose logs --tail 40 >&2 || true; exit 1; }

# Static guard: no hardcoded root credentials. (surreal-init legitimately runs as root to chown the
# volume; the runtime checks below cover the long-running services.)
! grep -nE 'root:root|--pass root' docker-compose.yml scripts/compose-migrate.sh || fail "hardcoded root credentials"

docker compose up -d --wait surrealdb
docker compose run --rm migrate
docker compose up -d --build --no-deps --wait kg

[ "$(docker compose exec -T kg id -u)" != 0 ] || fail "kg runs as root"
[ "$(docker inspect -f '{{.Config.User}}' "$(docker compose ps -q surrealdb)")" != root ] || fail "surrealdb runs as root"
for s in surrealdb kg; do
  docker inspect -f '{{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}}' "$(docker compose ps -q $s)" \
    | grep -q 'ALL.*no-new-privileges' || fail "$s is missing cap_drop ALL / no-new-privileges"
done
# The password must not be in any process argument (`docker top` lists the host-side process args).
procs=$(docker top "$(docker compose ps -q surrealdb)") || fail "docker top failed"
echo "$procs" | grep -q surreal || fail "docker top shows no surreal process (check is blind): $procs"
! echo "$procs" | grep -q -- "$DB_ROOT_PASS" || fail "DB password is in a process argument"

# The backend network is internal, the database sits on nothing else and publishes nothing.
[ "$(docker network inspect -f '{{.Internal}}' "${COMPOSE_PROJECT_NAME}_backend")" = true ] || fail "backend network is not internal"
[ "$(docker inspect -f '{{len .NetworkSettings.Networks}}' "$(docker compose ps -q surrealdb)")" = 1 ] || fail "surrealdb is on more than one network"
[ -z "$(docker port "$(docker compose ps -q surrealdb)")" ] || fail "surrealdb publishes a port"

# One real MCP call through the published loopback port, then the database it reads.
out=$(curl -fsS -m10 -X POST http://127.0.0.1:3000/mcp -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"kg_status","arguments":{}}}')
echo "$out" | grep -q total_nodes || fail "kg_status returned: $out"

# Second start: data written before a `down` (volumes kept) is still there after `up`, migrations are
# skipped, and the unprivileged users can still write the volume that surreal-init chowned.
mcp() { # tool arguments-json
  curl -fsS -m15 -X POST http://127.0.0.1:3000/mcp -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}"
}
mcp kg_session_start '{"project":"smoke","create_project":true}' >/dev/null
mcp kg_node_create '{"type":"observation","content":"survives a restart"}' | grep -q '"action\\":\\"created' \
  || fail "kg_node_create did not create a node"
docker compose down
docker compose up -d --wait surrealdb
migrated=$(docker compose run --rm migrate 2>&1) || fail "second migrate failed: $migrated"
echo "$migrated"
echo "$migrated" | grep -q "already applied" && ! echo "$migrated" | grep -q "applying" || fail "second start re-applied migrations"
docker compose up -d --no-deps --wait kg
mcp kg_query '{"query":"survives a restart","project":"smoke"}' | grep -q "survives a restart" \
  || fail "node written before the restart is gone"
echo "compose-smoke: ok"
