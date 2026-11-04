#!/usr/bin/env bash
# Smoke test for docker-compose.yml: boots the database and the server (built from source through
# docker-compose.build.yml, fixture embeddings through docker-compose.fixture.yml, so no Ollama and no
# model download), makes MCP calls, and asserts the container hardening holds.
# Needs Docker with Compose 2.20 or later and jq. Cleans up after itself. Usage: scripts/compose-smoke.sh
set -euo pipefail
cd "$(dirname "$0")/.."

export COMPOSE_PROJECT_NAME=kg-smoke
# Secrets live in a temp env file passed with --env-file, the documented .env path: it also keeps a
# developer's real .env out of the run. The second start below reads the same file.
ENV_FILE=$(umask 077; mktemp)
DB_ROOT_PASS=$(openssl rand -hex 16)
KG_JWT_SECRET=$(openssl rand -hex 32)
printf 'KG_JWT_SECRET=%s\nDB_ROOT_PASS=%s\n' "$KG_JWT_SECRET" "$DB_ROOT_PASS" > "$ENV_FILE"
# dc: the stack under test (source build, fixture embeddings). dcf: any other file combination.
dcf() { docker compose --env-file "$ENV_FILE" "$@"; }
dc() { dcf -f docker-compose.yml -f docker-compose.build.yml -f docker-compose.fixture.yml "$@"; }

cleanup() { dc down -v --remove-orphans >/dev/null 2>&1 || true; rm -f "$ENV_FILE"; }
trap cleanup EXIT
fail() { echo "compose-smoke: $*" >&2; dc logs --tail 40 >&2 || true; exit 1; }

# Static guard: no hardcoded root credentials. (surreal-init legitimately runs as root to chown the
# volume; the runtime checks below cover the long-running services.)
! grep -nE 'root:root|--pass root' docker-compose.yml docker-compose.build.yml docker-compose.fixture.yml scripts/migrate.sh \
  || fail "hardcoded root credentials"

# The overrides need Compose 2.20 (depends_on.required). Fail early with the reason, not mid-run.
compose_version=$(docker compose version --short)
compose_version=${compose_version#v}
compose_major=${compose_version%%.*}
compose_rest=${compose_version#*.}
compose_minor=${compose_rest%%.*}
{ [ "$compose_major" -gt 2 ] || { [ "$compose_major" -eq 2 ] && [ "$compose_minor" -ge 20 ]; }; } \
  || fail "Docker Compose $compose_version is too old: docker-compose.fixture.yml needs 2.20 or later (depends_on required: false)"

# Every file combination parses, and the files do what their headers say.
dcf config -q || fail "docker-compose.yml does not parse"
dcf -f docker-compose.yml -f docker-compose.build.yml config -q || fail "the build override does not parse"
dcf -f docker-compose.yml -f docker-compose.fixture.yml config -q || fail "the fixture override does not parse"
dcf config --format json | jq -e '
    .services.kg.image == "ghcr.io/komplyzen/komplyt-zero:1.0" and (.services.kg | has("build") | not)
    and (.services | has("ollama") and has("ollama-pull"))' >/dev/null \
  || fail "the default compose file must pull the published image and still start ollama"
dcf -f docker-compose.yml -f docker-compose.build.yml config --format json \
  | jq -e '.services.kg.build.context != null and .services.kg.image == "kg-zero-kg:local"' >/dev/null \
  || fail "the build override must build from source under a local tag"
dcf -f docker-compose.yml -f docker-compose.fixture.yml config --format json | jq -e '
    .services.kg.depends_on["ollama-pull"].required == false
    and (.services | has("ollama") or has("ollama-pull") | not)' >/dev/null \
  || fail "the fixture override must drop ollama and make kg not depend on ollama-pull"

dc up -d --wait surrealdb
dc run --rm migrate
dc up -d --build --no-deps --wait kg

[ "$(dc exec -T kg id -u)" != 0 ] || fail "kg runs as root"
[ "$(docker inspect -f '{{.Config.User}}' "$(dc ps -q surrealdb)")" != root ] || fail "surrealdb runs as root"
for s in surrealdb kg; do
  docker inspect -f '{{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}}' "$(dc ps -q $s)" \
    | grep -q 'ALL.*no-new-privileges' || fail "$s is missing cap_drop ALL / no-new-privileges"
done
# The password must not be in any process argument (`docker top` lists the host-side process args).
procs=$(docker top "$(dc ps -q surrealdb)") || fail "docker top failed"
echo "$procs" | grep -q surreal || fail "docker top shows no surreal process (check is blind): $procs"
! echo "$procs" | grep -q -- "$DB_ROOT_PASS" || fail "DB password is in a process argument"

# The backend network is internal, the database sits on nothing else and publishes nothing.
[ "$(docker network inspect -f '{{.Internal}}' "${COMPOSE_PROJECT_NAME}_backend")" = true ] || fail "backend network is not internal"
[ "$(docker inspect -f '{{len .NetworkSettings.Networks}}' "$(dc ps -q surrealdb)")" = 1 ] || fail "surrealdb is on more than one network"
[ -z "$(docker port "$(dc ps -q surrealdb)")" ] || fail "surrealdb publishes a port"

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
dc down
dc up -d --wait surrealdb
migrated=$(dc run --rm migrate 2>&1) || fail "second migrate failed: $migrated"
echo "$migrated"
echo "$migrated" | grep -q "already applied" && ! echo "$migrated" | grep -q "applying" || fail "second start re-applied migrations"
dc up -d --no-deps --wait kg
mcp kg_query '{"text":"survives a restart","project":"smoke"}' | grep -q "survives a restart" \
  || fail "node written before the restart is gone"
# A misspelled parameter is rejected and named (it used to be dropped, and every node came back).
rejected=$(mcp kg_query '{"query":"survives a restart","project":"smoke"}')
{ grep -q -- '-32602' <<<"$rejected" && grep -q 'Unrecognized key \\"query\\"' <<<"$rejected"; } \
  || fail "kg_query did not reject the unknown parameter query: $rejected"

# A different KG_JWT_SECRET on the same volume must fail loudly with the hint, not silently; restoring
# the original secret must recover.
OTHER=$(openssl rand -hex 32)
sed -i "s/^KG_JWT_SECRET=.*/KG_JWT_SECRET=$OTHER/" "$ENV_FILE"
! dc up -d --no-deps --wait --wait-timeout 60 --force-recreate kg >/dev/null 2>&1 || fail "kg started with a different KG_JWT_SECRET"
kg_logs=$(dc logs kg 2>&1) # captured first: `| grep -q` would SIGPIPE dc under pipefail
grep -q "docs/self-hosting.md#secrets" <<<"$kg_logs" || fail "the wrong-secret failure has no .env hint"
sed -i "s/^KG_JWT_SECRET=.*/KG_JWT_SECRET=$KG_JWT_SECRET/" "$ENV_FILE"
dc up -d --no-deps --wait --force-recreate kg

# The whole dependency graph with the fixture override (no --no-deps): Ollama is never created, and
# kg still starts. The migrate service runs again here; its output is not asserted.
dc down
dc up -d --wait
services=$(docker ps -a --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --format '{{.Label "com.docker.compose.service"}}')
! grep -qE '^ollama(-pull)?$' <<<"$services" || fail "the fixture override still created ollama containers: $services"
mcp kg_status '{}' | grep -q total_nodes || fail "kg_status did not answer after the full-graph start"

# `docker stop` sends SIGTERM and kills after 10 s (exit 137). A drained, idle server must exit by itself.
cid=$(dc ps -q kg)
started=$(date +%s)
dc stop kg >/dev/null
elapsed=$(( $(date +%s) - started ))
code=$(docker inspect -f '{{.State.ExitCode}}' "$cid")
[ "$code" = 0 ] || fail "kg exited with $code after SIGTERM (137 means it had to be killed)"
[ "$elapsed" -lt 8 ] || fail "kg took ${elapsed}s to stop"

# The image users actually get: the default compose file's published tag, with the fixture override and
# no source build. It is older than this branch's code, so only the compose wiring is checked (that the
# current compose file still starts it and it answers), not behaviour added since its release.
dcf -f docker-compose.yml -f docker-compose.fixture.yml up -d --wait
mcp kg_status '{}' | grep -q total_nodes || fail "the published image did not answer kg_status"
echo "compose-smoke: ok"
