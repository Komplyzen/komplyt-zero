#!/usr/bin/env bash
# Scan for committed secrets with gitleaks and the repo's .gitleaks.toml.
#
#   scripts/gitleaks-scan.sh staged        changes staged for commit (pre-commit hook)
#   scripts/gitleaks-scan.sh diff <base>   commits in <base>..HEAD (CI on pull requests)
#   scripts/gitleaks-scan.sh tree          the working tree as it is (no history)
#
# Install gitleaks: https://github.com/gitleaks/gitleaks#installing
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

mode="${1:-staged}"

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks is not installed; cannot scan for secrets." >&2
  echo "Install it from https://github.com/gitleaks/gitleaks#installing" >&2
  exit 127
fi

common=(--config .gitleaks.toml --redact --no-banner)

case "$mode" in
  staged) exec gitleaks git "${common[@]}" --staged ;;
  diff)
    base="${2:?usage: gitleaks-scan.sh diff <base-ref>}"
    exec gitleaks git "${common[@]}" --log-opts="${base}..HEAD"
    ;;
  tree) exec gitleaks dir "${common[@]}" . ;;
  *)
    echo "unknown mode: $mode (staged | diff <base> | tree)" >&2
    exit 2
    ;;
esac
