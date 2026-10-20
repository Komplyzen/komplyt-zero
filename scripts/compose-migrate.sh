#!/bin/sh
# Used by docker-compose.yml (`migrate` service): apply database/migrations/*.surql, in filename
# order, to a self-hosted SurrealDB, skipping files already recorded in `_migrations` (a table
# the baseline defines). POSIX sh: it runs in the curl image.
# Env: SURREAL_HTTP, KG_DB_NS, KG_DB_NAME, SURREAL_USER, SURREAL_PASS (the compose DB_ROOT_PASS).
set -eu

HTTP="${SURREAL_HTTP:?}"
NS="${KG_DB_NS:?}"
DB="${KG_DB_NAME:?}"
DIR="${MIGRATIONS_DIR:-/migrations}"
USER_="${SURREAL_USER:?}"
PASS_="${SURREAL_PASS:?}"

# -w puts the HTTP status on its own last line: SurrealDB answers a SQL parse error with HTTP 400 and no
# "status":"ERR" in the body, so fail_on_err has to look at the status as well.
post() { curl -sS --retry 5 --retry-connrefused --retry-delay 1 -X POST "$HTTP/sql" -u "$USER_:$PASS_" \
  -H "Accept: application/json" -w '\n%{http_code}' "$@"; }
scoped() { post -H "surreal-ns: $NS" -H "surreal-db: $DB" "$@"; }
fail_on_err() { # label response-with-trailing-http-status-line
  code=$(printf '%s\n' "$2" | tail -n 1)
  body=$(printf '%s\n' "$2" | sed '$d')
  if [ -z "$body" ] || [ "$code" != 200 ] || printf '%s' "$body" | grep -q '"status":"ERR"'; then
    echo "[migrate] $1 failed (HTTP $code): $(printf '%s' "$body" | cut -c1-400)" >&2
    if [ "$code" = 401 ]; then
      echo "[migrate] DB_ROOT_PASS does not match the one this database was created with (SurrealDB keeps the first). Use the original value, or remove the surreal-data volume for a fresh install." >&2
    fi
    exit 1
  fi
}

fail_on_err "bootstrap" "$(post -d "DEFINE NAMESPACE IF NOT EXISTS $NS; USE NS $NS; DEFINE DATABASE IF NOT EXISTS $DB;")"

# Before the baseline there is no _migrations table: the database is fresh.
tracked=0
if scoped -d "INFO FOR DB;" | grep -q '"_migrations"'; then tracked=1; fi

for f in "$DIR"/*.surql; do
  name=$(basename "$f")
  if [ "$tracked" = 1 ]; then
    seen=$(scoped -d "SELECT VALUE filename FROM _migrations WHERE filename = '$name';")
    if printf '%s' "$seen" | grep -q "\"$name\""; then
      echo "[migrate] $name already applied" >&2
      continue
    fi
  fi
  echo "[migrate] applying $name" >&2
  fail_on_err "$name" "$(scoped --data-binary @"$f")"
  sum=$(sha256sum "$f" | cut -d' ' -f1)
  fail_on_err "record $name" "$(scoped -d "INSERT INTO _migrations { filename: '$name', checksum: '$sum', applied_by: 'compose' };")"
  tracked=1
done
echo "[migrate] done" >&2
