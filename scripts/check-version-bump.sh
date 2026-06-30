#!/usr/bin/env bash
# CI check: verify the plugin version was incremented when plugin files change.
#
# The plugin ships one manifest per host (Claude, Codex, Cursor). They must
# stay in lockstep: every manifest carries the same version, and that version
# must increase whenever plugin runtime files change. This check enforces:
#   1. all manifests exist and hold a valid semver triplet,
#   2. all manifests share one aligned version,
#   3. that version is strictly greater than the highest version on the base
#      branch (rejects both "changed but not bumped" and downgrades).
set -euo pipefail

BASE_REF="${1:-origin/main}"

# Per-host plugin manifests — kept in lockstep on a single version.
MANIFESTS=(
  "plugins/glean/.claude-plugin/plugin.json"
  "plugins/glean/.codex-plugin/plugin.json"
  "plugins/glean/.cursor-plugin/plugin.json"
)

# Only trigger on files that affect the plugin runtime — not CI or tooling.
PLUGIN_PATHS='^(src/|plugins/glean/(dist/|skills/|start\.mjs|\.mcp\.json|\.mcp\.codex\.json|package\.json|\.(claude|codex|cursor)-plugin/plugin\.json))'

if ! git diff --name-only "$BASE_REF"...HEAD | grep -qE "$PLUGIN_PATHS"; then
  echo "No plugin files changed — skipping version check."
  exit 0
fi

SEMVER_RE='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'

# semver_cmp A B -> prints 1 if A>B, -1 if A<B, 0 if equal (exits 0).
semver_cmp() {
  node -e "
    const a='$1'.split('.').map(Number), b='$2'.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if (a[i] > b[i]) { console.log(1); process.exit(0); }
      if (a[i] < b[i]) { console.log(-1); process.exit(0); }
    }
    console.log(0);
  "
}

# --- Current versions (working tree): every manifest must exist, be valid semver,
# and agree on one version.
CURRENT=""
for m in "${MANIFESTS[@]}"; do
  if [ ! -f "$m" ]; then
    echo "ERROR: Expected plugin manifest '$m' is missing."
    exit 1
  fi
  v=$(node -p "require('./$m').version")
  if ! [[ "$v" =~ $SEMVER_RE ]]; then
    echo "ERROR: Version '$v' in $m is not a valid semver triplet (x.y.z)."
    exit 1
  fi
  if [ -z "$CURRENT" ]; then
    CURRENT="$v"
  elif [ "$v" != "$CURRENT" ]; then
    echo "ERROR: Plugin manifest versions are not aligned. All manifests must share one version:"
    for mm in "${MANIFESTS[@]}"; do
      echo "  $(node -p "require('./$mm').version")  $mm"
    done
    exit 1
  fi
done

# --- Base versions: read each manifest from the base ref. A manifest may be
# absent there (plugin or host being introduced) — those are skipped. The floor
# the current version must beat is the highest version present on the base.
# Capturing each blob separately (instead of piping git into node) keeps
# `set -o pipefail` from turning a missing path into an opaque parse error.
BASE_MAX=""
for m in "${MANIFESTS[@]}"; do
  if ! base_json=$(git show "$BASE_REF:$m" 2>/dev/null); then
    continue
  fi
  bv=$(node -p "JSON.parse(require('fs').readFileSync(0,'utf-8')).version" <<<"$base_json")
  if ! [[ "$bv" =~ $SEMVER_RE ]]; then
    echo "ERROR: Base version '$bv' in $m is not a valid semver triplet (x.y.z)."
    exit 1
  fi
  if [ -z "$BASE_MAX" ] || [ "$(semver_cmp "$bv" "$BASE_MAX")" = "1" ]; then
    BASE_MAX="$bv"
  fi
done

if [ -z "$BASE_MAX" ]; then
  echo "No plugin manifests present on $BASE_REF — new plugin, skipping version-bump check (current version: $CURRENT)."
  exit 0
fi

CMP=$(semver_cmp "$CURRENT" "$BASE_MAX")
if [ "$CMP" = "0" ]; then
  echo "ERROR: Plugin files changed but version was not bumped."
  echo "  Base version:    $BASE_MAX"
  echo "  Current version: $CURRENT"
  echo ""
  echo "Bump the version in every plugin manifest (keep them aligned):"
  printf '  %s\n' "${MANIFESTS[@]}"
  exit 1
fi
if [ "$CMP" = "-1" ]; then
  echo "ERROR: Version was downgraded."
  echo "  Base version:    $BASE_MAX"
  echo "  Current version: $CURRENT"
  echo ""
  echo "The version must be higher than the base branch."
  exit 1
fi

echo "Version bump verified: $BASE_MAX → $CURRENT (all manifests aligned)."
