#!/usr/bin/env bash
# mcp-smoke: the first CI check that sends a
# signed token through /mcp end to end. Fresh SurrealDB, migration chain, job-local
# JWKS, KG server from this checkout, stub agent (no LLM), fixture embeddings.
# Spends nothing. Same phases the benchmark legs use.
#
# Usage: bench/smoke.sh   (env: HARNESS_DIR, optional LEG_IDX, RUN_ID)

set -euo pipefail
REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export REPO_ROOT
export RUN_ID="${RUN_ID:-smoke$(date +%s)}"
export RUN_ATTEMPT="${RUN_ATTEMPT:-1}"
export LEG_IDX="${LEG_IDX:-0}"
export LEG_DIR="${LEG_DIR:-${REPO_ROOT}/bench-results/${RUN_ID}/smoke}"
export HARNESS_DIR="${HARNESS_DIR:-${HOME}/workspace/Komplyzen/memory-benchmarks}"

# Smoke is the one place fixtures are allowed: it proves transport and auth,
# not retrieval quality. Benchmark legs never select fixtures (leg.sh asserts it).
# Set explicitly, overriding whatever the caller exported: an inherited
# EMBEDDING_PROVIDER=cohere next to KG_EMBED_FIXTURES=true would be a config
# conflict, and the fixture provider needs no API key (EMBEDDING_API_KEY /
# COHERE_API_KEY are ignored).
export EMBEDDING_PROVIDER=fixture
unset KG_EMBED_FIXTURES

# shellcheck source=lib.sh
source "${REPO_ROOT}/bench/lib.sh"

on_exit() {
  local rc=$?
  if (( rc != 0 )); then
    log "FAILED in phase: $(current_phase)"
    printf 'smoke:%s:%s\n' "${LEG_IDX}" "$(current_phase)" > "${LEG_DIR}/failed"
    [[ -f "${LEG_DIR}/kg-server.log" ]] && tail -n 40 "${LEG_DIR}/kg-server.log" >&2
  fi
  stop_leg
  exit "${rc}"
}
trap on_exit EXIT

start_surreal
apply_migrations
start_jwks 30
start_kg
run_smoke --stub-agent
phase done
log "smoke OK: signed token accepted by /mcp, stub agent wrote and read back through the KG"
