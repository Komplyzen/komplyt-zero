#!/usr/bin/env bash
# One-command benchmark run.
#
#   bench.sh <profile> <benchmark> [--shards 0|0,1|all] [--shard-size 25] [--backends kg-full,...]
#            [--cutoffs 20,100] [--budget EUR] [--dry-run] [--parallel N] [--rpm-budget 500]
#            [--question-workers N]
#            [--timeout-minutes 300] [--max-questions N] [--allow-partial] [--expected-sha256 HEX]
#            [--answerer-model M] [--judge-model M] [--agent-model M] [--agent-provider P]
#
# profile:   cheap | head-to-head | small-model      benchmark: locomo | longmemeval
# --question-workers N  questions processed concurrently inside a leg (locomo only; default 1 =
#               sequential). Needs a harness with --question-workers; LLM calls stay bounded by the
#               leg's rpm. Omitted from the harness command when 1, so older harness checkouts work.
# --budget EUR  the money you are willing to spend on this run (default 5). If the gate's forecast
#               is higher, bench.sh puts the choice to you at the terminal: run anyway, drop
#               backends, fewer shards, fewer cutoffs, cap questions, or abort; scope changes are
#               re-forecast. No flag can answer for you; with no terminal the run is refused.
#               Nothing is spent before that decision, which is recorded in approval.json.
# Env: HARNESS_DIR (default ~/workspace/Komplyzen/memory-benchmarks); for kg legs the embedding
#      provider's settings: EMBEDDING_PROVIDER (default cohere, never fixture) with EMBEDDING_API_KEY
#      (COHERE_API_KEY accepted as the fallback), EMBEDDING_BASE_URL / EMBEDDING_MODEL as needed;
#      whatever the profile's endpoints need (the gate lists them), optional RUN_ID.
#      BENCH_ENV=dotenv (default, reads <repo>/.env or BENCH_ENV_FILE) | op (resolves bench/op.env
#      via the 1Password CLI). Already-set variables are never overwritten.
# Output: bench-results/<run_id>/{gate.json,legs/,merged/,SUMMARY.md}
#
# Local only. Nothing here knows about GitHub.

set -euo pipefail
REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export REPO_ROOT
export HARNESS_DIR="${HARNESS_DIR:-${HOME}/workspace/Komplyzen/memory-benchmarks}"
SCRIPTS="${REPO_ROOT}/bench"
source "${SCRIPTS}/env.sh"
load_bench_env

usage() { sed -n '2,25p' "${BASH_SOURCE[0]}" >&2; exit 64; }
(($# >= 2)) || usage
PROFILE="$1"; BENCHMARK="$2"; shift 2
SHARDS=0 SHARD_SIZE=25 BACKENDS=kg-full CUTOFFS=20,100 BUDGET=5 DRY_RUN="" PARALLEL=1 RPM_BUDGET=500 QUESTION_WORKERS=1
TIMEOUT_MIN=300 MAX_QUESTIONS="" ALLOW_PARTIAL="" EXPECTED_SHA="" OVERRIDES=()
while (($#)); do
  case "$1" in
    --shards) SHARDS="$2"; shift 2 ;;
    --shard-size) SHARD_SIZE="$2"; shift 2 ;;
    --backends) BACKENDS="$2"; shift 2 ;;
    --cutoffs) CUTOFFS="$2"; shift 2 ;;
    --budget) BUDGET="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --parallel) PARALLEL="$2"; shift 2 ;;
    --rpm-budget) RPM_BUDGET="$2"; shift 2 ;;
    --question-workers) QUESTION_WORKERS="$2"; shift 2 ;;
    --timeout-minutes) TIMEOUT_MIN="$2"; shift 2 ;;
    --max-questions) MAX_QUESTIONS="$2"; shift 2 ;;
    --allow-partial) ALLOW_PARTIAL=1; shift ;;
    --expected-sha256) EXPECTED_SHA="$2"; shift 2 ;;
    --answerer-model|--judge-model|--agent-model|--agent-provider) OVERRIDES+=("$1" "$2"); shift 2 ;;
    *) echo "bench.sh: unknown argument $1" >&2; usage ;;
  esac
done

for v in SHARD_SIZE PARALLEL RPM_BUDGET TIMEOUT_MIN QUESTION_WORKERS; do
  [[ "${!v}" =~ ^[0-9]+$ && "${!v}" -gt 0 ]] || { echo "bench.sh: ${v} must be a positive integer (got '${!v}')" >&2; usage; }
done
[[ -z "${MAX_QUESTIONS}" || "${MAX_QUESTIONS}" =~ ^[0-9]+$ ]] || { echo "bench.sh: --max-questions must be an integer" >&2; usage; }
[[ "${BUDGET}" =~ ^[0-9]+([.][0-9]+)?$ ]] || { echo "bench.sh: --budget must be a number of euros (got '${BUDGET}')" >&2; usage; }
[[ "${PROFILE}" =~ ^(cheap|head-to-head|small-model)$ ]] || { echo "bench.sh: profile must be cheap, head-to-head, or small-model" >&2; usage; }
[[ "${BENCHMARK}" =~ ^(locomo|longmemeval)$ ]] || { echo "bench.sh: benchmark must be locomo or longmemeval" >&2; usage; }
# Everything else that came from the CLI or workflow inputs is validated by the gate (backends, cutoffs, shards, models).

# Pinned dataset checksums. LoCoMo is downloaded at run time (CC BY-NC 4.0);
# a swapped file must fail the gate. Update deliberately, with a commit message saying why.
LOCOMO_SHA256_PINNED="79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4"
if [[ -z "${EXPECTED_SHA}" && "${BENCHMARK}" == "locomo" ]]; then EXPECTED_SHA="${LOCOMO_SHA256_PINNED}"; fi

export RUN_ID="${RUN_ID:-local-$(date +%Y%m%d-%H%M%S)}"
export RUN_ATTEMPT="${RUN_ATTEMPT:-1}"
RUN_DIR="${REPO_ROOT}/bench-results/${RUN_ID}"
mkdir -p "${RUN_DIR}/legs" "${RUN_DIR}/merged"
PY="${HARNESS_DIR}/.venv/bin/python"; [[ -x "${PY}" ]] || PY=python3
log() { printf '[%s] bench: %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }

# --- Gate ----------------------------------------------------------------
# Runs the fork's gate for the current scope, prints the forecast, returns 0 (within budget) or
# 4 (forecast above budget). Any other exit is a hard refusal. Nothing is spent here.
run_gate() {
  log "gate: profile=${PROFILE} benchmark=${BENCHMARK} shards=${SHARDS} backends=${BACKENDS} cutoffs=${CUTOFFS} budget=EUR ${BUDGET}"
  local gate_args=(--benchmark "${BENCHMARK}" --shards "${SHARDS}" --shard-size "${SHARD_SIZE}" --cutoffs "${CUTOFFS}"
                   --backends "${BACKENDS}" --profile "${PROFILE}" --budget-eur "${BUDGET}" "${OVERRIDES[@]}")
  [[ -n "${MAX_QUESTIONS}" ]] && gate_args+=(--max-questions "${MAX_QUESTIONS}")
  [[ -n "${EXPECTED_SHA}" ]] && gate_args+=(--expected-sha256 "${EXPECTED_SHA}")
  # errexit-safe capture: an `if` context never triggers set -e, and the status lands in GATE_RC
  # (a nonzero `return` from here would exit the script under set -e before the menu could show).
  if (cd "${HARNESS_DIR}" && "${PY}" -m scripts.gate_estimate "${gate_args[@]}") > "${RUN_DIR}/gate.json"; then
    GATE_RC=0
  else
    GATE_RC=$?
  fi
  if (( GATE_RC != 0 && GATE_RC != 4 )); then
    log "gate refused (exit ${GATE_RC}: 2=bad input, 3=dataset checksum, 5=fixtures set)"
    exit "${GATE_RC}"
  fi
  python3 - "${RUN_DIR}/gate.json" <<'EOF' >&2
import json, sys
g = json.load(open(sys.argv[1]))
m = g["models"]
print(f"  models: answerer={m['answerer_model']} judge={m['judge_model']} agent={m['agent_model']}@{m['agent_provider']} mem0={m['mem0_llm_model']}")
print(f"  shards: {[s['idx'] for s in g['shards']]}  questions={g['totals']['questions']} sessions={g['totals']['sessions']}")
print(f"  forecast: {g['totals']['calls']} LLM calls, about EUR {g['totals']['eur']:.2f} (prices of {g['prices_recorded_on']}); budget EUR {g['budget_eur']:.2f}")
for b, v in g["per_backend"].items():
    print(f"    {b}: {v['calls']} calls, EUR {v['eur']:.2f}")
EOF
}
# Dotted lookup into gate.json (no eval).
gate_value() {
  python3 - "${RUN_DIR}/gate.json" "$1" <<'EOF'
import json, sys
node = json.load(open(sys.argv[1]))
for key in sys.argv[2].split("."):
    node = node[key]
print(node)
EOF
}

GATE_RC=0
run_gate

# --- Budget approval -----------------------------------------------------
# Exit 4 = forecast above --budget. A person at the terminal decides: run anyway, cut scope
# (re-forecast), or abort. No flag can answer for them. Without a terminal the run is refused.
# Every change and the final decision are written to approval.json before anything is spent.
APPROVED_BY="within-budget"
CHANGES=()
while (( GATE_RC == 4 )); do
  forecast=$(gate_value totals.eur)
  if [[ -n "${DRY_RUN}" ]]; then APPROVED_BY="dry-run (forecast above budget, not asked)"; break; fi
  if [[ ! -t 0 ]]; then
    log "forecast EUR ${forecast} is above the budget of EUR ${BUDGET} and there is no terminal to ask; refusing"
    exit 4
  fi
  echo >&2
  echo "Forecast EUR ${forecast} is above your budget of EUR ${BUDGET}. What now?" >&2
  echo "  1) Run it anyway and spend about EUR ${forecast}" >&2
  echo "  2) Drop backends        (now: ${BACKENDS})" >&2
  echo "  3) Fewer shards         (now: ${SHARDS})" >&2
  echo "  4) Fewer cutoffs        (now: ${CUTOFFS})" >&2
  echo "  5) Cap questions/shard  (now: ${MAX_QUESTIONS:-no cap})" >&2
  echo "  6) Abort, spend nothing" >&2
  read -r -p "Choose 1-6: " choice
  case "${choice}" in
    1) APPROVED_BY="terminal: approved EUR ${forecast} over budget EUR ${BUDGET}"; log "approved at the terminal"; break ;;
    2) read -r -p "Backends to keep (comma list): " BACKENDS; CHANGES+=("backends=${BACKENDS}") ;;
    3) read -r -p "Shards (e.g. 0 or 0,1 or all): " SHARDS; CHANGES+=("shards=${SHARDS}") ;;
    4) read -r -p "Cutoffs (e.g. 20 or 20,100): " CUTOFFS; CHANGES+=("cutoffs=${CUTOFFS}") ;;
    5) read -r -p "Max questions per shard: " MAX_QUESTIONS; CHANGES+=("max_questions=${MAX_QUESTIONS}") ;;
    6|q|Q|"") log "aborted at the terminal; nothing spent"; exit 4 ;;
    *) echo "  1-6 please" >&2; continue ;;
  esac
  GATE_RC=0
run_gate
done
FORECAST_EUR=$(gate_value totals.eur)
CHANGES_JSON=$(printf '%s\n' "${CHANGES[@]+"${CHANGES[@]}"}" | python3 -c 'import json,sys; print(json.dumps([l for l in sys.stdin.read().split("\n") if l]))')
python3 - "${RUN_DIR}/approval.json" "${BUDGET}" "${FORECAST_EUR}" "${APPROVED_BY}" "${CHANGES_JSON}" "${SHARDS}" "${BACKENDS}" "${CUTOFFS}" "${MAX_QUESTIONS}" <<'EOF'
import json, sys, datetime
json.dump({"budget_eur": float(sys.argv[2]), "forecast_eur": float(sys.argv[3]), "approved_by": sys.argv[4],
           "scope_changes": json.loads(sys.argv[5]),
           "final_scope": {"shards": sys.argv[6], "backends": sys.argv[7], "cutoffs": sys.argv[8], "max_questions": sys.argv[9] or None},
           "at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")}, open(sys.argv[1], "w"), indent=2)
EOF

# --- Shards --------------------------------------------------------------
# After approval, since the scope may have changed at the prompt. LoCoMo shards are conversation
# indices (leg.sh passes --conversations). LongMemEval shards are dataset slices written under
# <run-dir>/slices; the gate only names them.
SLICES_JSON="[]"
if [[ "${BENCHMARK}" == "longmemeval" ]]; then
  log "slicing LongMemEval into shards of ${SHARD_SIZE}"
  SLICES_JSON=$(cd "${HARNESS_DIR}" && "${PY}" -m scripts.slice_dataset --benchmark longmemeval \
    --shard-size "${SHARD_SIZE}" --out-dir "${RUN_DIR}/slices")
fi
printf '%s\n' "${SLICES_JSON}" > "${RUN_DIR}/slices.json"

if [[ -n "${DRY_RUN}" ]]; then log "dry run: stopping after gate. ${RUN_DIR}/gate.json"; exit 0; fi

# --- Legs ----------------------------------------------------------------
mapfile -t LEGS < <(python3 - "${RUN_DIR}/gate.json" "${RUN_DIR}/slices.json" <<'EOF'
import json, sys
g = json.load(open(sys.argv[1]))
slices = {s["idx"]: s["path"] for s in json.load(open(sys.argv[2]))}
for b in g["backends"]:
    for s in g["shards"]:
        print(f"{b}\t{s['idx']}\t{slices.get(s['idx'], '')}")
EOF
)
RPM_PER_LEG=$(( RPM_BUDGET / (PARALLEL > 0 ? PARALLEL : 1) ))
log "running ${#LEGS[@]} legs, parallel=${PARALLEL}, rpm per leg=${RPM_PER_LEG}"

run_leg() { # idx "backend<TAB>shard<TAB>path"
  local idx="$1" backend shard path
  IFS=$'\t' read -r backend shard path <<< "$2"
  local args=(--gate "${RUN_DIR}/gate.json" --benchmark "${BENCHMARK}" --backend "${backend}" --shard "${shard}"
              --leg-idx "${idx}" --run-dir "${RUN_DIR}" --timeout-minutes "${TIMEOUT_MIN}" --rpm "${RPM_PER_LEG}"
              --question-workers "${QUESTION_WORKERS}")
  [[ -n "${path}" ]] && args+=(--shard-path "${path}")
  [[ -n "${MAX_QUESTIONS}" ]] && args+=(--max-questions "${MAX_QUESTIONS}")
  if bash "${SCRIPTS}/leg.sh" "${args[@]}" > "${RUN_DIR}/legs/${backend}-shard${shard}.out" 2>&1; then
    log "leg ok: ${backend} shard ${shard}"
  else
    log "leg FAILED: ${backend} shard ${shard} ($(cat "${RUN_DIR}/legs/${backend}-shard${shard}/failed" 2>/dev/null || echo unknown))"
  fi
}

i=0; running=0
for leg in "${LEGS[@]}"; do
  run_leg "${i}" "${leg}" &
  i=$((i + 1)); running=$((running + 1))
  if (( running >= PARALLEL )); then wait -n; running=$((running - 1)); fi
done
wait

# --- Merge + summary (same script the workflow's merge job runs) ---------
merge_args=()
[[ -n "${ALLOW_PARTIAL}" ]] && merge_args+=(--allow-partial)
# "Complete" (every shard of the dataset) is a fact the gate derives, not a flag a person sets.
if [[ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("complete", False))' "${RUN_DIR}/gate.json")" == "True" ]]; then
  merge_args+=(--complete)
fi
if bash "${SCRIPTS}/merge.sh" "${BENCHMARK}" "${RUN_DIR}" "${merge_args[@]}"; then
  log "done: ${RUN_DIR}/SUMMARY.md"
else
  log "done with failures: ${RUN_DIR}/SUMMARY.md"; exit 1
fi
