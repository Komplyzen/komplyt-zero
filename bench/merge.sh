#!/usr/bin/env bash
# Merge per-leg results into one file per backend and write SUMMARY.md.
#
#   merge.sh <benchmark> <run-dir> [--allow-partial] [--complete]
#
# --complete: the run covered every shard of the dataset (bench.sh derives it from the gate), so the
# summary drops its "dev-loop sample" notice.
#
# Expects <run-dir>/gate.json and <run-dir>/legs/<backend>-shard<idx>/ (leg_meta.json, results/predicted_*,
# optional `failed`). Called by bench.sh; also usable by hand to re-merge a run.
# Exit 1 if any leg failed or any merge was refused, after writing the summary.

set -euo pipefail
BENCHMARK="${1:?benchmark required}"; RUN_DIR="${2:?run dir required}"; shift 2
ALLOW_PARTIAL="" COMPLETE=""
while (($#)); do
  case "$1" in
    --allow-partial) ALLOW_PARTIAL=1; shift ;;
    --complete) COMPLETE=1; shift ;;
    *) echo "merge.sh: unknown argument $1" >&2; exit 64 ;;
  esac
done
export HARNESS_DIR="${HARNESS_DIR:-${HOME}/workspace/Komplyzen/memory-benchmarks}"
PY="${HARNESS_DIR}/.venv/bin/python"; [[ -x "${PY}" ]] || PY=python3
RUN_ID="${RUN_ID:-$(basename "${RUN_DIR}")}"; RUN_ATTEMPT="${RUN_ATTEMPT:-1}"
log() { printf '[%s] merge: %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
[[ -f "${RUN_DIR}/gate.json" ]] || { log "no gate.json in ${RUN_DIR}; nothing to merge"; exit 2; }
[[ -d "${RUN_DIR}/legs" ]] || { log "no legs/ in ${RUN_DIR}; nothing to merge"; exit 2; }
mkdir -p "${RUN_DIR}/merged"

FAILED_ARGS=(); refused=0
while IFS= read -r f; do FAILED_ARGS+=(--failed "$(cat "${f}")"); done < <(find "${RUN_DIR}/legs" -mindepth 2 -maxdepth 2 -name failed)
EXPECTED_SHARDS=$(python3 -c 'import json,sys; print(",".join(str(s["idx"]) for s in json.load(open(sys.argv[1]))["shards"]))' "${RUN_DIR}/gate.json")
MERGED=()
for backend in $(python3 -c 'import json,sys; print(" ".join(json.load(open(sys.argv[1]))["backends"]))' "${RUN_DIR}/gate.json"); do
  # merge_results.py takes the runner's predicted_<project>/ dirs (with the leg_meta.json sidecar inside).
  dirs=()
  for d in "${RUN_DIR}/legs/${backend}-shard"*/; do
    [[ -d "${d}" && ! -f "${d}/failed" ]] || continue
    for p in "${d}"results/predicted_*/; do [[ -d "${p}" ]] && dirs+=("${p%/}"); done
  done
  if (( ${#dirs[@]} == 0 )); then log "no successful legs for ${backend}; skipping merge"; refused=1; continue; fi
  out="${RUN_DIR}/merged/${BENCHMARK}_${backend}_results.json"
  args=(--benchmark "${BENCHMARK}" --backend "${backend}" --expected-shards "${EXPECTED_SHARDS}"
        --out "${out}" --run-id "${RUN_ID}" --run-attempt "${RUN_ATTEMPT}")
  [[ -n "${ALLOW_PARTIAL}" ]] && args+=(--allow-partial)
  if (cd "${HARNESS_DIR}" && "${PY}" -m scripts.merge_results "${args[@]}" "${dirs[@]}"); then
    MERGED+=("${out}"); log "merged ${backend}: ${#dirs[@]} leg(s)"
  else
    log "merge refused for ${backend}"; refused=1
  fi
done
summary_args=(--out "${RUN_DIR}/SUMMARY.md" --title "Public memory benchmark: ${BENCHMARK} (${RUN_ID})")
[[ -n "${COMPLETE}" ]] && summary_args+=(--full)   # summary_table.py's flag name for "not a sample"
(cd "${HARNESS_DIR}" && "${PY}" -m scripts.summary_table "${summary_args[@]}" "${FAILED_ARGS[@]}" "${MERGED[@]}") \
  || { log "summary_table failed"; refused=1; }
cat "${RUN_DIR}/SUMMARY.md" 2>/dev/null >&2 || true
(( ${#FAILED_ARGS[@]} == 0 && refused == 0 )) || exit 1
