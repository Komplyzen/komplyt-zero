#!/usr/bin/env bash
# One line per leg of a local benchmark run. Read the files bench.sh leaves behind;
# nothing here talks to the KG or the harness.
#
#   bench/status.sh [run-dir]        default: newest bench-results/*
#
# Columns: leg, phase (or done/FAILED:phase), elapsed, questions evaluated so far, harness log tail.

set -euo pipefail
REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
RUN_DIR="${1:-}"
if [[ -z "${RUN_DIR}" ]]; then
  RUN_DIR=$(command ls -1dt "${REPO_ROOT}"/bench-results/*/ 2>/dev/null | head -1 || true)
  RUN_DIR="${RUN_DIR%/}"
fi
[[ -n "${RUN_DIR}" && -d "${RUN_DIR}" ]] || { echo "no run directory (bench-results/ is empty)" >&2; exit 1; }

echo "run: ${RUN_DIR}"
if [[ -f "${RUN_DIR}/gate.json" ]]; then
  python3 - "${RUN_DIR}/gate.json" <<'EOF'
import json, sys
g = json.load(open(sys.argv[1]))
print(f"gate: {g['benchmark']} profile={g['profile']} backends={','.join(g['backends'])} shards={[s['idx'] for s in g['shards']]} "
      f"estimate={g['totals']['calls']} calls ~EUR {g['totals']['eur']:.2f}")
EOF
fi
shopt -s nullglob
legs=("${RUN_DIR}"/legs/*/)
if (( ${#legs[@]} == 0 )); then echo "no legs started yet"; exit 0; fi
printf '%-24s %-18s %-9s %-8s %s\n' LEG PHASE ELAPSED JUDGED LAST
now=$(date +%s)
for d in "${legs[@]}"; do
  d="${d%/}"; name=$(basename "${d}")
  phase=$(cat "${d}/phase" 2>/dev/null || echo "-")
  if [[ -f "${d}/failed" ]]; then phase="FAILED:${phase}"; fi
  if [[ -f "${d}/leg_meta.json" ]]; then
    wall=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("wall_seconds",""))' "${d}/leg_meta.json")
  else
    start=$(stat -c %Y "${d}/phase" 2>/dev/null || echo "${now}")
    first=$(stat -c %W "${d}" 2>/dev/null); [[ "${first}" =~ ^[0-9]+$ && "${first}" -gt 0 ]] || first="${start}"
    wall=$(( now - first ))
  fi
  judged=0
  if [[ -d "${d}/results" ]]; then
    judged=$(find "${d}/results" -path '*predicted_*' -name '*.json' ! -name '_*' ! -name 'leg_meta.json' 2>/dev/null | wc -l)
  fi
  last=""
  if [[ -f "${d}/harness.log" ]]; then last=$(tail -n 1 "${d}/harness.log" | cut -c1-70); fi
  printf '%-24s %-18s %-9s %-8s %s\n' "${name}" "${phase}" "$(( wall / 60 ))m$(( wall % 60 ))s" "${judged}" "${last}"
done
[[ -f "${RUN_DIR}/SUMMARY.md" ]] && echo "summary: ${RUN_DIR}/SUMMARY.md"
exit 0
