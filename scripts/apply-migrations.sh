#!/usr/bin/env bash
# Apply database/migrations/*.surql, in filename order, to a SurrealDB over HTTP.
# For local test databases and CI service containers only: it keeps no record of
# what was applied, so it is NOT the production migration path (migrate-db.yml).
# Fails on the first statement error. Run it against a FRESH database: the
# baseline is not idempotent (re-running it fails with 'already exists').
#
# Usage: scripts/apply-migrations.sh
#
# Env (defaults match scripts/local-db.sh and the CLAUDE.md test flow):
#   SURREAL_HTTP   default http://localhost:8000
#   SURREAL_USER   default root
#   SURREAL_PASS   default root
#   KG_DB_NS       default kg
#   KG_DB_NAME     default test (created if missing)

set -euo pipefail

HTTP="${SURREAL_HTTP:-http://localhost:8000}"
USER_="${SURREAL_USER:-root}"
PASS_="${SURREAL_PASS:-root}"
NS="${KG_DB_NS:-kg}"
DB="${KG_DB_NAME:-test}"
DIR="$(cd "$(dirname "$0")/.." && pwd)/database/migrations"

post() { # extra curl args...
  # -w appends the HTTP status on its own last line; SurrealDB answers a SQL parse error
  # with HTTP 400 and no "status":"ERR" in the body, so the status has to be checked too.
  curl -sS --retry 5 --retry-connrefused --retry-delay 1 -X POST "${HTTP}/sql" \
    -u "${USER_}:${PASS_}" -H "Accept: application/json" -w '\n%{http_code}' "$@"
}

fail_on_err() { # label response-with-trailing-http-status-line
  local body="${2%$'\n'*}" code="${2##*$'\n'}"
  if [[ -z "$body" || "$code" != 200 ]] || grep -q '"status":"ERR"' <<< "$body"; then
    echo "[apply-migrations] $1 failed (HTTP ${code}): ${body:0:400}" >&2
    exit 1
  fi
}

# A just-started container resets connections before it listens; curl's own retry
# does not cover that, so wait for /health first.
for ((i = 0; i < 60; i++)); do
  curl -sf "${HTTP}/health" >/dev/null 2>&1 && break
  sleep 1
done
(( i < 60 )) || { echo "[apply-migrations] ${HTTP} did not become healthy" >&2; exit 1; }

fail_on_err "namespace/database bootstrap" \
  "$(post -d "DEFINE NAMESPACE IF NOT EXISTS ${NS}; USE NS ${NS}; DEFINE DATABASE IF NOT EXISTS ${DB};")"

for f in "${DIR}"/*.surql; do
  echo "[apply-migrations] $(basename "$f")" >&2
  fail_on_err "$(basename "$f")" \
    "$(post -H "surreal-ns: ${NS}" -H "surreal-db: ${DB}" --data-binary @"$f")"
done
