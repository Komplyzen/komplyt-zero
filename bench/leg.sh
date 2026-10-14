#!/usr/bin/env bash
# One benchmark leg: one shard, one backend.
#
# Usage:
#   leg.sh --gate GATE_JSON --benchmark locomo|longmemeval --backend kg-full|kg-no-spread|kg-no-decay|mem0-oss|none \
#          --shard IDX [--shard-path FILE] --leg-idx N --run-dir DIR [--timeout-minutes 300] [--rpm 125] [--question-workers N] [--max-questions N]
#
# Env: RUN_ID, RUN_ATTEMPT, REPO_ROOT, HARNESS_DIR, OPENAI_API_KEY (and ANTHROPIC_API_KEY / MISTRAL_API_KEY
# for those providers); for kg backends the embedding provider's settings (EMBEDDING_PROVIDER, default
# cohere, which needs EMBEDDING_API_KEY or COHERE_API_KEY). KG_EMBED_FIXTURES must be unset and
# EMBEDDING_PROVIDER must not be fixture (gate asserts the former, this script both).
#
# Writes: <run-dir>/legs/<backend>-shard<idx>/{phase,leg_meta.json,results/predicted_*,*.log}
# and <run-dir>/legs/<backend>-shard<idx>/failed on error ("<backend>:<shard>:<phase>").

set -euo pipefail

GATE_JSON="" BENCHMARK="" BACKEND="" SHARD="" SHARD_PATH="" LEG_IDX_ARG="" RUN_DIR="" TIMEOUT_MIN=300 RPM=125 MAX_QUESTIONS=""
while (($#)); do
  case "$1" in
    --gate) GATE_JSON="$2"; shift 2 ;;
    --benchmark) BENCHMARK="$2"; shift 2 ;;
    --backend) BACKEND="$2"; shift 2 ;;
    --shard) SHARD="$2"; shift 2 ;;
    --shard-path) SHARD_PATH="$2"; shift 2 ;;
    --leg-idx) LEG_IDX_ARG="$2"; shift 2 ;;
    --run-dir) RUN_DIR="$2"; shift 2 ;;
    --timeout-minutes) TIMEOUT_MIN="$2"; shift 2 ;;
    --rpm) RPM="$2"; shift 2 ;;
    --question-workers) QUESTION_WORKERS="$2"; shift 2 ;;
    --max-questions) MAX_QUESTIONS="$2"; shift 2 ;;
    *) echo "leg.sh: unknown argument $1" >&2; exit 64 ;;
  esac
done
for v in GATE_JSON BENCHMARK BACKEND SHARD LEG_IDX_ARG RUN_DIR; do [[ -n "${!v}" ]] || { echo "leg.sh: --${v,,} required" >&2; exit 64; }; done
for v in SHARD LEG_IDX_ARG TIMEOUT_MIN RPM; do [[ "${!v}" =~ ^[0-9]+$ ]] || { echo "leg.sh: ${v} must be a non-negative integer (got '${!v}')" >&2; exit 64; }; done
[[ "${QUESTION_WORKERS:-1}" =~ ^[1-9][0-9]*$ ]] || { echo "leg.sh: --question-workers must be a positive integer" >&2; exit 64; }
[[ -z "${MAX_QUESTIONS}" || "${MAX_QUESTIONS}" =~ ^[0-9]+$ ]] || { echo "leg.sh: --max-questions must be an integer" >&2; exit 64; }
[[ "${BENCHMARK}" =~ ^(locomo|longmemeval)$ ]] || { echo "leg.sh: --benchmark must be locomo or longmemeval" >&2; exit 64; }
[[ "${BACKEND}" =~ ^(kg-full|kg-no-spread|kg-no-decay|mem0-oss|none)$ ]] || { echo "leg.sh: unknown backend ${BACKEND}" >&2; exit 64; }

export REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export HARNESS_DIR="${HARNESS_DIR:-${HOME}/workspace/Komplyzen/memory-benchmarks}"
export RUN_ID="${RUN_ID:?RUN_ID required}"
export RUN_ATTEMPT="${RUN_ATTEMPT:-1}"
export LEG_IDX="${LEG_IDX_ARG}"
export LEG_DIR="${RUN_DIR}/legs/${BACKEND}-shard${SHARD}"
mkdir -p "${LEG_DIR}/results"

# shellcheck source=lib.sh
source "${REPO_ROOT}/bench/lib.sh"

# Dotted key lookup into gate.json; no eval, values printed verbatim.
gate() {
  python3 - "${GATE_JSON}" "$1" <<'EOF'
import json, sys
node = json.load(open(sys.argv[1]))
for key in sys.argv[2].split("."):
    node = node[key] if isinstance(node, dict) else None
if node is None:
    print("")
elif isinstance(node, list):
    print(",".join(str(v) for v in node))
else:
    print(node)
EOF
}
ANSWERER_MODEL=$(gate models.answerer_model)
ANSWERER_PROVIDER=$(gate models.answerer_provider)
JUDGE_MODEL=$(gate models.judge_model)
JUDGE_PROVIDER=$(gate models.judge_provider)
AGENT_MODEL=$(gate models.agent_model)
AGENT_PROVIDER=$(gate models.agent_provider)
MEM0_LLM_MODEL=$(gate models.mem0_llm_model)
CUTOFFS=$(gate cutoffs)
TOP_K=${CUTOFFS##*,}   # gate normalizes cutoffs ascending; the last is the max
PROFILE=$(gate profile)
for v in ANSWERER_MODEL ANSWERER_PROVIDER JUDGE_MODEL JUDGE_PROVIDER AGENT_MODEL AGENT_PROVIDER MEM0_LLM_MODEL CUTOFFS PROFILE; do
  [[ "${!v}" =~ ^[A-Za-z0-9_.,:/+-]+$ ]] || { echo "leg.sh: unsafe characters in ${v}='${!v}'" >&2; exit 65; }
done

# Which credentials this leg needs is decided by the profile's endpoint configs (the provider
# registry in profiles.json names the env var per provider), never by this script. The gate
# lists them; we only check they are present before anything is spent.
phase credentials
REQUIRED_ENV=$(gate required_env)
missing=()
IFS=',' read -r -a req_arr <<< "${REQUIRED_ENV}"
for name in "${req_arr[@]}"; do
  [[ "${name}" =~ ^[A-Z][A-Z0-9_]*$ ]] || { echo "leg.sh: bad env name from gate: ${name}" >&2; exit 65; }
  [[ -n "${!name:-}" ]] || missing+=("${name}")
done
if (( ${#missing[@]} > 0 )); then
  # This runs before the EXIT trap is armed, so leave the failure marker by hand.
  printf '%s:%s:credentials\n' "${BACKEND}" "${SHARD}" > "${LEG_DIR}/failed"
  echo "leg.sh: profile '${PROFILE}' needs these env vars and they are unset: ${missing[*]} (see providers in profiles.json)" >&2; exit 65
fi
# OpenAI-compatible answerer/judge endpoints: the OpenAI SDK honours OPENAI_BASE_URL / OPENAI_API_KEY,
# so map the generic pair onto them for the runner process (the agent loop reads LLM_* itself).
ANSWERER_KIND=$(gate endpoints.answerer.kind); ANSWERER_BASE_URL=$(gate endpoints.answerer.base_url)
if [[ "${ANSWERER_KIND}" == "openai-compatible" ]]; then
  export OPENAI_BASE_URL="${ANSWERER_BASE_URL:-${LLM_BASE_URL:-}}"
  [[ "${ANSWERER_PROVIDER}" == "mistral" ]] && export OPENAI_API_KEY="${MISTRAL_API_KEY:-}"
  [[ "${ANSWERER_PROVIDER}" == "openai-compatible" ]] && export OPENAI_API_KEY="${LLM_API_KEY:-}"
fi
PROJECT_NAME="${BACKEND}-${RUN_ID}-a${RUN_ATTEMPT}"
HARNESS_SHA=$(git -C "${HARNESS_DIR}" rev-parse HEAD)
KG_COMMIT=$(git -C "${REPO_ROOT}" rev-parse HEAD)
START_TS=$(date +%s)
STATUS=failed

# leg_meta.json is the sidecar merge_results.py reads (bench_common.load_leg). It is written
# into the runner's predicted_<project>/ directory next to the per-question files, and a copy
# stays at LEG_DIR for failed legs that never produced a predicted_ dir. The runner's own
# unified result carries the kg ingest metadata; it is copied in as kg_meta.
# Values reach Python through the environment, never by interpolation into source (peer review:
# a model name containing a quote would otherwise become Python code).
write_meta() {
  local now wall
  now=$(date +%s); wall=$(( now - START_TS ))
  META_WALL="${wall}" META_STATUS="${STATUS}" META_PHASE="$(current_phase)" META_PY="$(harness_python)" \
  BACKEND="${BACKEND}" SHARD="${SHARD}" BENCHMARK="${BENCHMARK}" PROFILE="${PROFILE}" \
  ANSWERER_MODEL="${ANSWERER_MODEL}" ANSWERER_PROVIDER="${ANSWERER_PROVIDER}" JUDGE_MODEL="${JUDGE_MODEL}" \
  JUDGE_PROVIDER="${JUDGE_PROVIDER}" AGENT_MODEL="${AGENT_MODEL}" AGENT_PROVIDER="${AGENT_PROVIDER}" \
  MEM0_LLM_MODEL="${MEM0_LLM_MODEL}" CUTOFFS="${CUTOFFS}" HARNESS_SHA="${HARNESS_SHA}" KG_COMMIT="${KG_COMMIT}" \
  LEG_DIR="${LEG_DIR}" RUN_ID="${RUN_ID}" RUN_ATTEMPT="${RUN_ATTEMPT}" LEG_IDX="${LEG_IDX}" \
  python3 - <<'EOF'
import json, glob, os, shutil, subprocess
E = os.environ
leg_dir = E["LEG_DIR"]
predicted = next(iter(glob.glob(os.path.join(leg_dir, "results", "predicted_*"))), None)
unified = next(iter(sorted(glob.glob(os.path.join(leg_dir, "results", "*_results_*.json")))), None)
kg_meta = {}
if unified:
    try:
        kg_meta = json.load(open(unified)).get("metadata", {}) or {}
    except Exception as exc:  # noqa: BLE001
        kg_meta = {"_unreadable": str(exc)}
def ver(*cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception:  # noqa: BLE001
        return None
backend = E["BACKEND"]
meta = {
  "backend": backend, "shard": int(E["SHARD"]), "benchmark": E["BENCHMARK"], "profile": E["PROFILE"],
  "models": {k: E[k.upper()] for k in ("answerer_model", "answerer_provider", "judge_model", "judge_provider",
                                        "agent_model", "agent_provider", "mem0_llm_model")},
  "cutoffs": [int(c) for c in E["CUTOFFS"].split(",")],
  "harness_sha": E["HARNESS_SHA"], "kg_commit": E["KG_COMMIT"],
  "kg_variant": {"kg-full": "full", "kg-no-spread": "no-spread", "kg-no-decay": "no-decay"}.get(backend),
  "kg_meta": kg_meta,
  "mem0": {"llm_model": E["MEM0_LLM_MODEL"]} if backend == "mem0-oss" else None,
  "run_id": E["RUN_ID"], "run_attempt": int(E["RUN_ATTEMPT"]), "leg_idx": int(E["LEG_IDX"]),
  "wall_seconds": int(E["META_WALL"]), "status": E["META_STATUS"],
  "phase_failed": None if E["META_STATUS"] == "ok" else E["META_PHASE"],
  "predicted_dir": predicted, "unified_result": unified,
  "versions": {"docker": ver("docker", "--version"), "bun": ver("bun", "--version"), "python": ver(E["META_PY"], "--version")},
}
json.dump(meta, open(os.path.join(leg_dir, "leg_meta.json"), "w"), indent=2)
if predicted:
    shutil.copyfile(os.path.join(leg_dir, "leg_meta.json"), os.path.join(predicted, "leg_meta.json"))
EOF
}

on_exit() {
  local rc=$?
  if (( rc != 0 )); then
    log "FAILED in phase: $(current_phase)"
    printf '%s:%s:%s\n' "${BACKEND}" "${SHARD}" "$(current_phase)" > "${LEG_DIR}/failed"
  else
    STATUS=ok
  fi
  write_meta || true
  stop_leg
  exit "${rc}"
}
trap on_exit EXIT

if [[ -n "${KG_EMBED_FIXTURES:-}" ]] || embedding_fixtures_selected; then
  log "KG_EMBED_FIXTURES or EMBEDDING_PROVIDER=fixture is set; benchmark legs never run with fixtures"; exit 65
fi

# Shard selector: locomo uses conversation indices; longmemeval uses a sliced dataset file.
shard_args=()
if [[ "${BENCHMARK}" == "locomo" ]]; then
  shard_args=(--conversations "${SHARD}")
else
  [[ -n "${SHARD_PATH}" ]] || { echo "leg.sh: --shard-path required for longmemeval" >&2; exit 64; }
  # The workflow passes the slice path relative to the repo root (artifact layout); the harness runs from HARNESS_DIR.
  [[ "${SHARD_PATH}" = /* ]] || SHARD_PATH="${REPO_ROOT}/${SHARD_PATH}"
  [[ -f "${SHARD_PATH}" ]] || { echo "leg.sh: shard file not found: ${SHARD_PATH}" >&2; exit 66; }
  shard_args=(--dataset-path "${SHARD_PATH}" --all-questions)
fi
common_args=(
  --project-name "${PROJECT_NAME}" --output-dir "${LEG_DIR}/results"
  --answerer-model "${ANSWERER_MODEL}" --provider "${ANSWERER_PROVIDER}"
  --judge-model "${JUDGE_MODEL}" --judge-provider "${JUDGE_PROVIDER}"
  --top-k "${TOP_K}" --top-k-cutoffs "${CUTOFFS}" --rpm "${RPM}"
)
[[ -n "${MAX_QUESTIONS}" ]] && common_args+=(--max-questions "${MAX_QUESTIONS}")
# Only the locomo runner has the flag, and only when asked: 1 is the harness default, and leaving it out
# keeps older harness checkouts (no --question-workers) working.
[[ "${BENCHMARK}" == "locomo" && "${QUESTION_WORKERS:-1}" -gt 1 ]] && common_args+=(--question-workers "${QUESTION_WORKERS}")

run_harness() {
  phase harness
  # run_with_timeout SIGKILLs a harness that ignores SIGTERM, so a local run cannot hang past the timeout.
  (cd "${HARNESS_DIR}" && run_with_timeout "$((TIMEOUT_MIN * 60))" "$(harness_python)" -m "benchmarks.${BENCHMARK}.run" "$@") 2>&1 | tee "${LEG_DIR}/harness.log" >&2
}

case "${BACKEND}" in
  kg-full|kg-no-spread|kg-no-decay)
    require_embedding_key || { echo "leg.sh: kg legs need real embeddings" >&2; exit 65; }
    spread=on; decay=on
    [[ "${BACKEND}" == "kg-no-spread" ]] && spread=off
    [[ "${BACKEND}" == "kg-no-decay" ]] && decay=off
    start_surreal
    apply_migrations
    start_jwks "$((TIMEOUT_MIN + 10))"
    start_kg
    # Proves token, provisioning, and read-only before any LLM spend; wipes its own project.
    run_smoke --stub-agent >/dev/null
    export_harness_env
    run_harness "${shard_args[@]}" "${common_args[@]}" \
      --backend kg --kg-url "${KG_URL}" --kg-spread "${spread}" --kg-decay "${decay}" \
      --kg-agent-model "${AGENT_MODEL}" --kg-agent-provider "${AGENT_PROVIDER}" --max-workers 1
    ;;
  mem0-oss)
    # Credentials were checked above from the gate's required_env; the compose file forwards the
    # provider env vars it knows (OPENAI_API_KEY, ANTHROPIC_API_KEY, AZURE_*) into the container.
    phase mem0-up
    export MEM0_COMPOSE_PROJECT="mem0-${LEG_TAG}"
    # The fork's compose file already takes MEM0_PORT / QDRANT_PORT / LLM_MODEL from env.
    # A host prefix in the port var keeps both bound to loopback on a public box.
    (cd "${HARNESS_DIR}" && MEM0_PORT="127.0.0.1:${MEM0_PORT}" QDRANT_PORT="127.0.0.1:${QDRANT_PORT}" \
      LLM_MODEL="${MEM0_LLM_MODEL}" ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
      compose_cmd -p "${MEM0_COMPOSE_PROJECT}" -f docker-compose.yml up -d --build) >"${LEG_DIR}/mem0-up.log" 2>&1
    wait_http "http://127.0.0.1:${MEM0_PORT}/health" 180
    run_harness "${shard_args[@]}" "${common_args[@]}" --backend oss --mem0-host "http://127.0.0.1:${MEM0_PORT}"
    ;;
  none)
    run_harness "${shard_args[@]}" "${common_args[@]}" --backend none
    ;;
  *) echo "leg.sh: unknown backend ${BACKEND}" >&2; exit 64 ;;
esac
phase done
