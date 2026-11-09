#!/bin/sh
# Guards versions that are pinned in more than one file, so a bump of one (Dependabot bumps the
# Dockerfile and the compose file on their own) cannot silently leave the others behind.
# Each `check` line below names one pinned thing, its single source of truth and the places that
# must match it. To guard another pinned version, add one `check` line.
#
# Exit 1 if any place differs, or if a source or a whole set of places is not found (a renamed
# file must not turn the guard into a no-op). Run from anywhere: it changes to the repo root.
set -eu
cd "$(dirname "$0")/.."

VER='[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*'
status=0
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

# "file line version" for each PREFIX<version> in the given files (the last one on a line).
occurrences() { # prefix files...
  prefix=$1; shift
  grep -H -n -E "${prefix}${VER}" "$@" 2>/dev/null \
    | sed -n "s|^\([^:]*\):\([0-9]*\):.*${prefix}\(${VER}\).*|\1 \2 \3|p" || true
}

check() { # name source-file source-prefix place-prefix mention place-files...
  # mention: text that marks a line as a pin of this thing; a line with it but no plain X.Y.Z pin
  # (a quoted "1.4.3", "latest", a two-part tag) would otherwise be skipped without a word.
  name=$1; src=$2; sprefix=$3; pprefix=$4; mention=$5; shift 5
  want=$(occurrences "$sprefix" "$src" | head -n 1 | cut -d' ' -f3)
  if [ -z "$want" ]; then
    echo "check-version-pins: $name: no '$sprefix<version>' in $src" >&2
    status=1
    return
  fi
  for f in "$@"; do
    if [ ! -e "$f" ]; then
      echo "check-version-pins: $name: $f does not exist" >&2
      status=1
    fi
  done
  occurrences "$pprefix" "$@" > "$tmp"
  found=0
  while read -r file line have; do
    found=$((found + 1))
    if [ "$have" != "$want" ]; then
      echo "check-version-pins: $name: $file:$line has $have, $src has $want" >&2
      status=1
    fi
  done < "$tmp"
  if [ "$found" -eq 0 ]; then
    echo "check-version-pins: $name: no '$pprefix<version>' found in: $*" >&2
    status=1
  fi
  # This script names the patterns it looks for, so it is not a place to check.
  grep -H -n -F "$mention" "$@" 2>/dev/null | grep -v -E "${pprefix}${VER}" \
    | grep -v '^scripts/check-version-pins\.sh:' > "$tmp" || true
  while IFS= read -r line; do
    echo "check-version-pins: $name: not a plain X.Y.Z pin: $line" >&2
    status=1
  done < "$tmp"
}

# Bun: both Dockerfile stages, and every setup-bun pin in the workflows.
check bun src/Dockerfile 'FROM oven/bun:' 'FROM oven/bun:' 'FROM oven/bun:' src/Dockerfile
check bun src/Dockerfile 'FROM oven/bun:' 'bun-version: ' 'bun-version:' .github/workflows/*.yml
# SurrealDB: the compose file decides; CI, the release boot check, the local scripts and the docs follow.
check surrealdb docker-compose.yml 'surrealdb/surrealdb:v' 'surrealdb/surrealdb:v' 'surrealdb/surrealdb:' \
  .github/workflows/*.yml scripts/*.sh bench/lib.sh docs/*.md

[ "$status" -eq 0 ] && echo "check-version-pins: ok"
exit "$status"
