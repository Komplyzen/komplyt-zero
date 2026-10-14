#!/usr/bin/env bash
# The meta-model computation (methodology extraction, Poincaré training) is private and runs as a
# batch job in a private repository; this repository only reads the stored result (kg_meta_model,
# table meta_model). Fail if any of that code comes back.
#
# Looks at tracked and untracked (not ignored) files, so it also works before a commit.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

fail=0

# Any language, and variants such as poincare-train.py or methodology.v2.js.
files=$(git ls-files --cached --others --exclude-standard | grep -E \
  '(^|/)(methodology|poincare)[^/]*\.(ts|tsx|js|mjs|cjs|py)$|(^|/)(resiliency|process)[-_.](model|lens)[^/]*\.(ts|tsx|js|mjs|cjs|py)$|(^|/)lenses?/[^/]+\.(ts|tsx|js|mjs|cjs|py)$' || true)
if [ -n "$files" ]; then
  echo "::error::Private compute files are back in the public tree:"
  echo "$files"
  fail=1
fi

# This script, its self-test and the workflow that runs it name the identifiers, so they are excluded.
# The database schema legitimately names the poincare_* columns, so database/ is excluded.
hits=$(git grep --untracked -n -E \
  'trainPoincare|extractMethodology|analyzeHierarchy|savePoincareEmbeddings|extractOrganizingConcepts|buildOrganizingConcepts|extractResiliencyModel|extractProcessModel|getQualityMetrics|determineStatus' -- . \
  ':(exclude)scripts/check-no-private-compute.sh' ':(exclude)src/scripts-guard.test.ts' ':(exclude).github' ':(exclude)database' || true)
if [ -n "$hits" ]; then
  echo "::error::Private compute identifiers are back in the public tree:"
  echo "$hits"
  fail=1
fi

if [ "$fail" -eq 0 ]; then echo "ok: no private meta-model compute in the public tree"; fi
exit "$fail"
