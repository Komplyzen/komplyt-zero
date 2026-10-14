#!/usr/bin/env bash
# Compare the schema of two SurrealDB databases (records and JWT keys ignored).
#
#   SURREAL_AUTH=user:pass scripts/schema-diff.sh <http-url> <ns> <db-a> <db-b>
#
# Exits 0 when the schemas are identical, 1 with a unified diff otherwise.
# Reads only INFO FOR DB / INFO FOR TABLE (scripts/schema-info.py), so it is
# safe against populated databases. Use it to check that a database built from
# database/migrations matches another one, e.g. a long-lived environment.
set -euo pipefail

if (( $# != 4 )) || [[ -z "${SURREAL_AUTH:-}" ]]; then
  sed -n '2,9p' "$0" >&2
  exit 2
fi

url="${1%/}" ns="$2" a="$3" b="$4"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

python3 -I "${here}/schema-info.py" "${url}" "${ns}" "${a}" > "${tmp}/a.surql"
python3 -I "${here}/schema-info.py" "${url}" "${ns}" "${b}" > "${tmp}/b.surql"

if ! diff -u --label "${a}" --label "${b}" "${tmp}/a.surql" "${tmp}/b.surql"; then
  echo "schema differs: ${a} != ${b}" >&2
  exit 1
fi
echo "schema identical: ${a} == ${b} ($(wc -l < "${tmp}/a.surql") definitions)"
