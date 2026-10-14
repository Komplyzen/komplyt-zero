#!/usr/bin/env bash
# Load benchmark credentials. Sourced by bench.sh.
#   BENCH_ENV=dotenv (default)  source ${BENCH_ENV_FILE:-<repo>/.env}; a missing file is fine
#   BENCH_ENV=op                resolve bench/op.env (NAME=op://...) with `op read`
# Variables already set in the environment are never overwritten.

load_bench_env() {
  local mode="${BENCH_ENV:-dotenv}" repo="${REPO_ROOT}"
  case "${mode}" in
    dotenv)
      local f="${BENCH_ENV_FILE:-${repo}/.env}"
      [[ -f "${f}" ]] || return 0
      local name value
      while IFS= read -r line || [[ -n "${line}" ]]; do
        [[ "${line}" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
        name="${BASH_REMATCH[2]}"; value="${BASH_REMATCH[3]}"
        value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
        [[ -n "${!name:-}" ]] || export "${name}=${value}"
      done < "${f}"
      ;;
    op)
      command -v op >/dev/null || { echo "bench: BENCH_ENV=op but the 1Password CLI (op) is not installed" >&2; return 1; }
      local f="${BENCH_OP_FILE:-${repo}/bench/op.env}" line name ref value
      [[ -f "${f}" ]] || { echo "bench: ${f} not found" >&2; return 1; }
      while IFS= read -r line || [[ -n "${line}" ]]; do
        [[ "${line}" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(op://.+)$ ]] || continue
        name="${BASH_REMATCH[1]}"; ref="${BASH_REMATCH[2]}"
        [[ -z "${!name:-}" ]] || continue
        value="$(op read "${ref}")" || { echo "bench: op read failed for ${name} (${ref})" >&2; return 1; }
        export "${name}=${value}"
      done < "${f}"
      ;;
    *) echo "bench: BENCH_ENV must be 'dotenv' or 'op' (got '${mode}')" >&2; return 1 ;;
  esac
}
