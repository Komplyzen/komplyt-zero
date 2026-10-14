#!/usr/bin/env bash
# Local SurrealDB in Docker with the kg namespace and database created. Schema is not applied.
#
# Usage:
#   scripts/local-db.sh up        start the container and create namespace + database
#   scripts/local-db.sh down      remove the container (a persistent volume is kept)
#   scripts/local-db.sh env       print the KG_DB_* lines for src/.env
#
# Env overrides:
#   SURREAL_IMAGE   default surrealdb/surrealdb:v3.2.4 (CI's engine; v3.0.0 has a PERMISSIONS closure bug)
#   SURREAL_PORT    default 8000 (bound to 127.0.0.1)
#   KG_DB_NAME      default local (integration tests refuse "main"; use "test" for them)
#   KG_LOCAL_PERSIST=1   keep data in the docker volume kg-local-data instead of memory

set -euo pipefail

SURREAL_IMAGE="${SURREAL_IMAGE:-surrealdb/surrealdb:v3.2.4}"
SURREAL_PORT="${SURREAL_PORT:-8000}"
KG_DB_NAME="${KG_DB_NAME:-local}"
CONTAINER=kg-local-surrealdb
VOLUME=kg-local-data
HTTP="http://127.0.0.1:${SURREAL_PORT}"

log() { printf '[local-db] %s\n' "$*" >&2; }
die() { log "$*"; exit 1; }

# -w puts the HTTP status on its own last line: SurrealDB answers a SQL parse error with HTTP 400 and no
# "status":"ERR" in the body, so check() has to look at the status as well.
sql() {
  curl -s --retry 3 --retry-connrefused --retry-delay 1 -X POST "${HTTP}/sql" -u root:root \
    -H "Accept: application/json" -w '\n%{http_code}' "$@"
}

check() { # label response-with-trailing-http-status-line
  local body="${2%$'\n'*}" code="${2##*$'\n'}"
  [[ -n "$body" ]] || die "empty response from SurrealDB ($1, HTTP ${code})"
  if [[ "$code" != 200 ]] || grep -q '"status":"ERR"' <<< "$body"; then die "$1 failed (HTTP ${code}): ${body:0:300}"; fi
}

up() {
  command -v docker >/dev/null || die "docker not found"
  if docker ps -a --format '{{.Names}}' | grep -qx "${CONTAINER}"; then
    die "${CONTAINER} already exists; run 'scripts/local-db.sh down' first"
  fi

  local storage=(memory) mount=()
  if [[ "${KG_LOCAL_PERSIST:-0}" == 1 ]]; then
    storage=(rocksdb:/data/kg.db)
    mount=(-v "${VOLUME}:/data")
  fi

  log "starting ${SURREAL_IMAGE} on 127.0.0.1:${SURREAL_PORT} (${storage[*]})"
  docker run -d --name "${CONTAINER}" -p "127.0.0.1:${SURREAL_PORT}:8000" ${mount[@]+"${mount[@]}"} \
    "${SURREAL_IMAGE}" start --user root --pass root "${storage[@]}" >/dev/null

  local i
  for ((i = 0; i < 60; i++)); do
    curl -sf "${HTTP}/health" >/dev/null 2>&1 && break
    sleep 1
  done
  (( i < 60 )) || die "SurrealDB did not become healthy; see: docker logs ${CONTAINER}"

  check "namespace/database bootstrap" "$(sql -d "DEFINE NAMESPACE IF NOT EXISTS kg; USE NS kg; DEFINE DATABASE IF NOT EXISTS ${KG_DB_NAME};")"

  log "ready; add these to src/.env:"
  env_lines
}

down() {
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 && log "removed ${CONTAINER}" || log "${CONTAINER} not running"
  if docker volume inspect "${VOLUME}" >/dev/null 2>&1; then
    log "data kept in volume ${VOLUME}; delete with: docker volume rm ${VOLUME}"
  fi
}

env_lines() {
  cat <<EOF
KG_DB_URL=ws://127.0.0.1:${SURREAL_PORT}
KG_DB_USER=root
KG_DB_PASS=root
KG_DB_NS=kg
KG_DB_NAME=${KG_DB_NAME}
EOF
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  env) env_lines ;;
  *) sed -n '2,14p' "$0"; exit 64 ;;
esac
