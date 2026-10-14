#!/usr/bin/env bash
# Shared phases for benchmark legs and the mcp-smoke job.
#
# Every function is runnable by hand with the same env the workflow sets.
# Source this file; do not execute it. Callers set:
#   RUN_ID       run identifier (github run id or local timestamp)
#   RUN_ATTEMPT  attempt number (default 1)
#   LEG_IDX      0-based leg index; drives port offsets and container names
#   LEG_DIR      writable directory for logs, phase marker, temp keys
#   REPO_ROOT    komplyt-zero checkout root
#
# Ports per leg: base + OFF, where OFF = (hash(RUN_ID) mod 10) * 10 + LEG_IDX. The run hash keeps two
# runs that happen to overlap on the same box (different concurrency groups, e.g. locomo and
# longmemeval) off each other's ports; LEG_IDX < 10 keeps legs of one run apart. Bases:
# SurrealDB 8000, KG 3000, JWKS 8200, Qdrant 6333, mem0 8888. All bound to 127.0.0.1.

set -euo pipefail

# Empty-array expansion under `set -u` needs bash >= 4.4 (stock macOS ships 3.2).
if (( BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4) )); then
  echo "lib.sh: bash >= 4.4 required (have ${BASH_VERSION})" >&2; exit 64
fi

: "${RUN_ID:?RUN_ID required}"
: "${LEG_IDX:?LEG_IDX required}"
: "${LEG_DIR:?LEG_DIR required}"
: "${REPO_ROOT:?REPO_ROOT required}"
RUN_ATTEMPT="${RUN_ATTEMPT:-1}"
if (( LEG_IDX < 0 || LEG_IDX > 9 )); then echo "lib.sh: LEG_IDX must be 0..9 (got ${LEG_IDX}); more than 10 concurrent legs is not supported" >&2; exit 64; fi

SURREAL_IMAGE="${SURREAL_IMAGE:-surrealdb/surrealdb:v3.2.4}"
RUN_HASH=$(( $(printf '%s' "${RUN_ID}" | cksum | cut -d' ' -f1) % 10 ))
PORT_OFF=$(( RUN_HASH * 10 + LEG_IDX ))
SURREAL_PORT=$((8000 + PORT_OFF))
KG_PORT=$((3000 + PORT_OFF))
JWKS_PORT=$((8200 + PORT_OFF))
QDRANT_PORT=$((6333 + PORT_OFF))
MEM0_PORT=$((8888 + PORT_OFF))

LEG_TAG="bench-${RUN_ID}-a${RUN_ATTEMPT}-${LEG_IDX}"
SURREAL_NAME="surreal-${LEG_TAG}"
# SurrealDB identifiers: a local RUN_ID ("local-<date>-<time>") has hyphens, which parse as subtraction.
KG_DB_NAME_LEG="$(tr -c 'A-Za-z0-9_\n' _ <<< "bench_${RUN_ID}_a${RUN_ATTEMPT}_${LEG_IDX}")"
KG_DB_URL_WS="ws://127.0.0.1:${SURREAL_PORT}"
KG_DB_URL_HTTP="http://127.0.0.1:${SURREAL_PORT}"
KG_URL="http://127.0.0.1:${KG_PORT}"
JWKS_DIR="${LEG_DIR}/jwks"
JWKS_ISSUER="http://127.0.0.1:${JWKS_PORT}"
JWKS_URL="${JWKS_ISSUER}/jwks.json"
PHASE_FILE="${LEG_DIR}/phase"
PIDS_FILE="${LEG_DIR}/pids"

mkdir -p "${LEG_DIR}"
: > "${PIDS_FILE}"

log() { printf '[%s] [%s] %s\n' "$(date -u +%H:%M:%S)" "${LEG_TAG}" "$*" >&2; }

# Record the current phase so a failing leg can be summarised in one line.
phase() { printf '%s\n' "$1" > "${PHASE_FILE}"; log "phase: $1"; }
current_phase() { cat "${PHASE_FILE}" 2>/dev/null || echo unknown; }

wait_http() { # url seconds
  local url="$1" secs="${2:-60}" i
  for ((i = 0; i < secs; i++)); do
    if curl -sf "${url}" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  log "timeout waiting for ${url}"
  return 1
}

track_pid() { printf '%s\n' "$1" >> "${PIDS_FILE}"; }

stop_leg() {
  log "tearing down"
  # Keep the evidence before removing anything: infra-phase failures are otherwise undiagnosable.
  docker logs "${SURREAL_NAME}" >"${LEG_DIR}/surreal.log" 2>&1 || true
  if [[ -n "${MEM0_COMPOSE_PROJECT:-}" && -n "${HARNESS_DIR:-}" ]]; then
    (cd "${HARNESS_DIR}" && compose_cmd -p "${MEM0_COMPOSE_PROJECT}" -f docker-compose.yml logs --no-color) >"${LEG_DIR}/mem0.log" 2>&1 || true
  fi
  if [[ -f "${PIDS_FILE}" ]]; then
    while read -r pid; do
      [[ -n "${pid}" ]] || continue
      kill "${pid}" 2>/dev/null || true
    done < "${PIDS_FILE}"
  fi
  docker rm -f "${SURREAL_NAME}" >/dev/null 2>&1 || true
  if [[ -n "${MEM0_COMPOSE_PROJECT:-}" && -n "${HARNESS_DIR:-}" ]]; then
    (cd "${HARNESS_DIR}" && compose_cmd -p "${MEM0_COMPOSE_PROJECT}" -f docker-compose.yml down -v) >/dev/null 2>&1 || true
  fi
  rm -f "${JWKS_DIR}/private.pem" 2>/dev/null || true
}

compose_cmd() {
  if docker compose version >/dev/null 2>&1; then docker compose "$@"; else docker-compose "$@"; fi
}

# GNU `timeout -k 30 SECS cmd...` where available (Linux, or coreutils' gtimeout on macOS);
# otherwise the same semantics via python3 (stock macOS has neither). Exit 124 on timeout.
run_with_timeout() {
  local secs="$1"; shift
  if command -v timeout >/dev/null; then timeout -k 30 "${secs}" "$@"; return; fi
  if command -v gtimeout >/dev/null; then gtimeout -k 30 "${secs}" "$@"; return; fi
  python3 - "${secs}" "$@" <<'PY'
import subprocess, sys
secs, cmd = float(sys.argv[1]), sys.argv[2:]
p = subprocess.Popen(cmd)
try:
    sys.exit(p.wait(timeout=secs))
except subprocess.TimeoutExpired:
    p.terminate()
    try:
        p.wait(timeout=30)
    except subprocess.TimeoutExpired:
        p.kill(); p.wait()
    sys.exit(124)
PY
}

# --- Preflight -----------------------------------------------------------

# A leg killed before its EXIT trap (OOM, runner restart) leaves a container on our port under
# an old attempt's name. Remove stale bench containers on our ports; refuse if anything else
# holds them. Never kill unknown processes.
preflight_ports() {
  phase preflight
  local port cid
  for port in "${SURREAL_PORT}" "${QDRANT_PORT}" "${MEM0_PORT}"; do
    for cid in $(docker ps -q --filter "publish=${port}"); do
      if docker inspect --format '{{.Name}}' "${cid}" | grep -qE 'surreal-bench-|mem0-bench-'; then
        log "removing stale bench container on port ${port}: $(docker inspect --format '{{.Name}}' "${cid}")"
        docker rm -f "${cid}" >/dev/null
      fi
    done
  done
  for port in "${SURREAL_PORT}" "${KG_PORT}" "${JWKS_PORT}" "${QDRANT_PORT}" "${MEM0_PORT}"; do
    if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -qE "[:.]${port}\b"; then
      log "port ${port} is in use by something that is not a stale bench container; refusing to start this leg"
      return 1
    fi
  done
}

# --- SurrealDB -----------------------------------------------------------

start_surreal() {
  preflight_ports
  phase surrealdb
  docker rm -f "${SURREAL_NAME}" >/dev/null 2>&1 || true
  docker run -d --name "${SURREAL_NAME}" -p "127.0.0.1:${SURREAL_PORT}:8000" \
    "${SURREAL_IMAGE}" start --user root --pass root memory >/dev/null
  wait_http "${KG_DB_URL_HTTP}/health" 60
  local out
  out=$(curl -s --retry 3 --retry-connrefused --retry-delay 1 -X POST "${KG_DB_URL_HTTP}/sql" -u root:root \
    -H "Accept: application/json" \
    -d "DEFINE NAMESPACE IF NOT EXISTS kg; USE NS kg; DEFINE DATABASE IF NOT EXISTS ${KG_DB_NAME_LEG};")
  # A parse error comes back as a bare {"code":400,...} object with no per-statement status.
  if [[ -z "${out}" || "${out}" != "["* ]] || grep -q '"status":"ERR"' <<< "${out}"; then log "namespace/database bootstrap failed: ${out:0:300}"; return 1; fi
}

# Apply the migrations exactly as the platform runner does on a fresh database:
# every database/migrations/*.surql in filename order (000_baseline first).
apply_migrations() {
  phase migrations
  local f out fails=0 n=0
  for f in "${REPO_ROOT}"/database/migrations/*.surql; do
    n=$((n + 1))
    # No -f: SurrealDB answers some statement errors with a non-2xx status and a body we want to
    # read; the per-statement "status":"ERR" check below is the real guard. --retry covers a
    # transient connection blip on a loaded box.
    out=$(curl -s --retry 3 --retry-connrefused --retry-delay 1 -X POST "${KG_DB_URL_HTTP}/sql" -u root:root \
      -H "Accept: application/json" -H "surreal-ns: kg" -H "surreal-db: ${KG_DB_NAME_LEG}" --data-binary @"${f}")
    [[ -n "${out}" ]] || { log "empty response from SurrealDB for $(basename "${f}")"; fails=$((fails + 1)); continue; }
    if grep -q '"status":"ERR"' <<< "${out}"; then
      log "migration ERR in $(basename "${f}"): $(grep -o '"result":"[^"]*"' <<< "${out}" | head -2)"
      fails=$((fails + 1))
    fi
  done
  if (( fails > 0 )); then log "${fails} migration file(s) returned ERR"; return 1; fi
  log "applied ${n} migration files"
}

# --- Job-local issuer ----------------------------------------------------

start_jwks() { # ttl_minutes
  phase jwks
  local ttl="${1:-310}"
  mkdir -p "${JWKS_DIR}"
  KG_TOKEN=$(bun run --cwd "${REPO_ROOT}/src" bin/bench-token.ts \
    --out-dir "${JWKS_DIR}" --issuer "${JWKS_ISSUER}" --audience kg-server \
    --tenant "${KG_DB_NAME_LEG}" --sub bench --ttl-minutes "${ttl}" 2>"${LEG_DIR}/jwks.log")
  export KG_TOKEN
  # exec so $! is the python process itself, not a subshell wrapper; otherwise stop_leg kills
  # the wrapper and the server survives on the port (peer review finding).
  (cd "${JWKS_DIR}" && exec python3 -m http.server --bind 127.0.0.1 "${JWKS_PORT}" >"${LEG_DIR}/jwks-server.log" 2>&1) &
  track_pid $!
  wait_http "${JWKS_URL}" 30
}

# --- KG server -----------------------------------------------------------

# True when the KG server would embed with fixtures (hash vectors): either the
# legacy KG_EMBED_FIXTURES switch or EMBEDDING_PROVIDER=fixture.
embedding_fixtures_selected() {
  local flag="${KG_EMBED_FIXTURES:-}" provider="${EMBEDDING_PROVIDER:-}"
  [[ "${flag,,}" =~ ^(true|1|yes|on)$ || "${provider,,}" == "fixture" ]]
}

# Fail unless the selected embedding provider has its API key. Only cohere (the
# default) needs one; EMBEDDING_API_KEY or the legacy COHERE_API_KEY both count.
require_embedding_key() {
  embedding_fixtures_selected && return 0
  local provider="${EMBEDDING_PROVIDER:-cohere}"
  if [[ "${provider,,}" == "cohere" && -z "${EMBEDDING_API_KEY:-}" && -z "${COHERE_API_KEY:-}" ]]; then
    echo "EMBEDDING_API_KEY (or COHERE_API_KEY) required for EMBEDDING_PROVIDER=cohere" >&2
    return 1
  fi
}

# Extra env is passed by the caller (EMBEDDING_* / COHERE_API_KEY, KG_EMBED_FIXTURES for smoke only).
start_kg() {
  phase kg-server
  require_embedding_key
  (
    cd "${REPO_ROOT}/src"
    KG_DB_URL="${KG_DB_URL_WS}" KG_DB_USER=root KG_DB_PASS=root KG_DB_NS=kg KG_DB_NAME="${KG_DB_NAME_LEG}" \
    KG_JWT_SECRET="${KG_JWT_SECRET:-bench-local-secret-not-used-for-tokens-0000}" \
    KOMPLYT_ISSUER="${JWKS_ISSUER}" KOMPLYT_JWKS_URL="${JWKS_URL}" KOMPLYT_AUDIENCE=kg-server \
    LISTEN_ADDR="127.0.0.1:${KG_PORT}" LOG_LEVEL="${LOG_LEVEL:-warn}" \
    exec bun run index.ts
  ) >"${LEG_DIR}/kg-server.log" 2>&1 &
  track_pid $!
  # Longer than the embedding boot probe's worst case (ollama: at most 60s, see
  # src/embed.ts) plus server startup, so a slow but healthy boot is not cut off.
  wait_http "${KG_URL}/health" 90
}

# --- Harness helpers -----------------------------------------------------

harness_python() {
  : "${HARNESS_DIR:?HARNESS_DIR required (Komplyzen/memory-benchmarks checkout)}"
  if [[ -x "${HARNESS_DIR}/.venv/bin/python" ]]; then echo "${HARNESS_DIR}/.venv/bin/python"; else echo python3; fi
}

# Env the harness's kg backend reads. KG_DB_URL is the HTTP form for the root wipe.
export_harness_env() {
  export KG_URL KG_TOKEN
  export KG_DB_URL="${KG_DB_URL_HTTP}" KG_DB_USER=root KG_DB_PASS=root KG_DB_NS=kg KG_DB_NAME="${KG_DB_NAME_LEG}"
  export KG_REPO="${REPO_ROOT}"
  # CI mode in the harness: a 401 reads "token or JWKS server" with one retry, not "run kg auth login".
  export KG_CI=1
}

run_smoke() { # [--stub-agent]
  phase smoke
  export_harness_env
  (cd "${HARNESS_DIR}" && "$(harness_python)" -m scripts.kg_smoke --kg-url "${KG_URL}" "$@") 2>&1 | tee "${LEG_DIR}/smoke.log" >&2
}
