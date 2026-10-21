#!/bin/sh
# Tracked migration runner: applies database/migrations/*.surql, in filename order, to a SurrealDB
# over HTTP, skipping files already recorded in `_migrations` (a table the baseline defines).
# Safe to re-run: a second run applies nothing. Used by the docker-compose `migrate` service
# and by self-hosters (docs/self-hosting.md). POSIX sh: it runs in the curl image.
#
# Each file is applied together with its `_migrations` row in ONE transaction (SurrealDB rolls DDL
# back), so a file that fails halfway leaves nothing behind and the next run retries it cleanly.
#
# Env: SURREAL_HTTP (e.g. http://127.0.0.1:8000), SURREAL_USER, SURREAL_PASS (all required),
#      KG_DB_NS (default kg), KG_DB_NAME (default main), MIGRATIONS_DIR (default: database/migrations
#      next to this script's parent, /migrations in the compose image), MIGRATED_BY (default manual).
set -eu

HTTP="${SURREAL_HTTP:?set SURREAL_HTTP, e.g. http://127.0.0.1:8000}"
USER_="${SURREAL_USER:?set SURREAL_USER}"
PASS_="${SURREAL_PASS:?set SURREAL_PASS}"
NS="${KG_DB_NS:-kg}"
DB="${KG_DB_NAME:-main}"
BY="${MIGRATED_BY:-manual}"
DIR="${MIGRATIONS_DIR:-$(cd "$(dirname "$0")/.." && pwd)/database/migrations}"

# -w puts the HTTP status on its own last line: SurrealDB answers a SQL parse error with HTTP 400 and no
# "status":"ERR" in the body, so fail_on_err has to look at the status as well.
# The credentials go through a curl config on stdin (-K -), not argv, so they stay out of `ps`.
cred=$(printf '%s:%s' "$USER_" "$PASS_" | sed 's/\\/\\\\/g; s/"/\\"/g')
post() { printf 'user = "%s"\n' "$cred" | curl -sS -K - --retry 5 --retry-connrefused --retry-delay 1 \
  -X POST "$HTTP/sql" -H "Accept: application/json" -w '\n%{http_code}' "$@"; }
scoped() { post -H "surreal-ns: $NS" -H "surreal-db: $DB" "$@"; }
fail_on_err() { # label response-with-trailing-http-status-line
  code=$(printf '%s\n' "$2" | tail -n 1)
  body=$(printf '%s\n' "$2" | sed '$d')
  if [ -z "$body" ] || [ "$code" != 200 ] || printf '%s' "$body" | grep -q '"status":"ERR"'; then
    # Inside a transaction every statement after the failing one reports "not executed": show the cause.
    cause=$(printf '%s' "$body" | grep -o '"result":"[^"]*","status":"ERR"' | grep -v 'failed transaction\|Cannot COMMIT\|cancelled' | head -n 3 || true)
    echo "[migrate] $1 failed (HTTP $code): ${cause:-$(printf '%s' "$body" | cut -c1-400)}" >&2
    if [ "$code" = 401 ]; then
      echo "[migrate] SURREAL_PASS does not match the one this database was created with (SurrealDB keeps the first). Use the original value, or remove the data volume for a fresh install." >&2
    fi
    exit 1
  fi
}
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

case "$NS$DB" in *[!A-Za-z0-9_-]*) echo "[migrate] KG_DB_NS/KG_DB_NAME may only contain letters, digits, _ and -" >&2; exit 1 ;; esac
[ -d "$DIR" ] || { echo "[migrate] migrations directory $DIR not found" >&2; exit 1; }

fail_on_err "bootstrap" "$(post -d "DEFINE NAMESPACE IF NOT EXISTS $NS; USE NS $NS; DEFINE DATABASE IF NOT EXISTS $DB;")"

# The baseline creates _migrations in the same transaction as its own row, so the table exists
# only after the baseline fully applied: before it, the database is fresh.
tracked=0
if scoped -d "INFO FOR DB;" | grep -q '"_migrations"'; then tracked=1; fi

work=$(mktemp)
trap 'rm -f "$work"' EXIT
for f in "$DIR"/*.surql; do
  name=$(basename "$f")
  case "$name" in *[!A-Za-z0-9_.-]*) echo "[migrate] unexpected file name $name" >&2; exit 1 ;; esac
  sum=$(sha256 "$f")
  if [ "$tracked" = 1 ]; then
    seen=$(scoped -d "SELECT VALUE checksum FROM _migrations WHERE filename = '$name';")
    if ! printf '%s' "$seen" | grep -q '"result":\[\]'; then
      if ! printf '%s' "$seen" | grep -q "\"$sum\""; then
        echo "[migrate] WARNING: $name differs from what was applied (checksum mismatch). Migrations are never edited; add a new numbered file instead." >&2
      fi
      echo "[migrate] $name already applied" >&2
      continue
    fi
  fi
  echo "[migrate] applying $name" >&2
  { echo "BEGIN;"; cat "$f"; printf '\n;\nINSERT INTO _migrations { filename: '"'%s'"', checksum: '"'%s'"', applied_by: '"'%s'"' };\nCOMMIT;\n' "$name" "$sum" "$BY"; } >"$work"
  fail_on_err "$name" "$(scoped --data-binary @"$work")"
  tracked=1
done
echo "[migrate] done" >&2
