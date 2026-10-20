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
docker inspect -f '{{.Config.Cmd}}' "$(docker compose ps -q surrealdb)" | grep -q -- "$DB_ROOT_PASS" \
  && fail "DB password is on the surrealdb command line"

# The backend network is internal: no route out for the database.
docker run --rm --network "${COMPOSE_PROJECT_NAME}_backend" --entrypoint "" busybox:1.37 \
  sh -c 'wget -T3 -qO- http://1.1.1.1 >/dev/null 2>&1' && fail "backend network has a route out"

# One real MCP call through the published loopback port, then the database it reads.
out=$(curl -fsS -m10 -X POST http://127.0.0.1:3000/mcp -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"kg_status","arguments":{}}}')
echo "$out" | grep -q total_nodes || fail "kg_status returned: $out"
echo "compose-smoke: ok"
