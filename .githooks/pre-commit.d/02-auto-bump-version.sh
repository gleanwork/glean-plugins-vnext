#!/usr/bin/env bash
# Auto-bump patch version across all plugin manifests in lockstep when plugin files
# are staged. Uses the same path regex as scripts/check-version-bump.sh (the CI gate).
#
# The new version, v_new, is determined as follows:
#
#     v_main = max {version of each manifest on main}
#     v_current = max {version of each manifest in the working tree}
#     v_new = max {v_current, v_main + 0.0.1}
#
# where max is defined with respect to semver comparison and v_main + 0.0.1 is the patch
# increment of v_main. Versions are plain x.y.z (no pre-release or build metadata). A
# manifest whose version is not a plain x.y.z string is dropped from the max computation
# but still rewritten to v_new; a manifest that is not valid JSON aborts the commit with
# a message. A manifest listed below but missing from the working tree also aborts the
# commit, unless its deletion is staged (i.e. it is being removed) — this keeps MANIFESTS
# in lockstep with the files on disk and matches the CI gate (scripts/check-version-bump.sh).
set -e
cd "$(git rev-parse --show-toplevel)"

BASE_REF="origin/main"

# Per-host plugin manifests — kept in lockstep on a single version.
MANIFESTS=(
  "plugins/glean/.claude-plugin/plugin.json"
  "plugins/glean/.codex-plugin/plugin.json"
  "plugins/glean/.cursor-plugin/plugin.json"
)

PLUGIN_PATHS='^(src/|plugins/glean/(dist/|skills/|start\.sh|\.mcp\.json|\.mcp\.codex\.json|package\.json|\.(claude|codex|cursor)-plugin/plugin\.json))'

if ! git diff --cached --name-only | grep -qE "$PLUGIN_PATHS"; then
  exit 0
fi

# Versions on the base branch. Skip a manifest that is absent, unparseable, or whose
# version is not a plain x.y.z string — only valid semver versions form the floor.
base_versions=()
for m in "${MANIFESTS[@]}"; do
  blob=$(git show "$BASE_REF:$m" 2>/dev/null) || continue
  v=$(printf '%s' "$blob" | node -e '
    const fs = require("fs");
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(0, "utf-8")); } catch (e) { process.exit(0); }
    const v = pkg.version;
    if (typeof v === "string" && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(v)) process.stdout.write(v);
  ' 2>/dev/null)
  [ -n "$v" ] && base_versions+=("$v")
done

# Manifests staged for deletion in this commit. A missing manifest is tolerated only if
# its removal is staged here; any other absence is drift (an accidental delete or a stale
# MANIFESTS entry) and aborts the commit, matching the CI gate.
staged_deletes=$(git diff --cached --diff-filter=D --name-only)

# Versions in the working tree. A missing-but-not-being-deleted manifest aborts. Invalid
# JSON aborts. A valid-JSON manifest whose version is not a plain x.y.z string stays in the
# write set (so it gets rewritten to the target) but is dropped from the max so it cannot
# poison the result.
current_versions=()
existing_manifests=()
for m in "${MANIFESTS[@]}"; do
  if [ ! -f "$m" ]; then
    if printf '%s\n' "$staged_deletes" | grep -qxF "$m"; then
      continue
    fi
    echo "pre-commit: $m is listed in MANIFESTS but is missing and its removal is not staged." >&2
    echo "pre-commit: restore the file, or drop it from MANIFESTS (here and in scripts/check-version-bump.sh)." >&2
    exit 1
  fi
  if ! v=$(node -e '
    const fs = require("fs");
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf-8")); } catch (e) { process.exit(3); }
    const v = pkg.version;
    if (typeof v === "string" && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(v)) process.stdout.write(v);
  ' "$m"); then
    echo "pre-commit: $m is not valid JSON; fix it before committing." >&2
    exit 1
  fi
  existing_manifests+=("$m")
  [ -n "$v" ] && current_versions+=("$v")
done

# No manifests on disk => nothing to bump.
[ ${#existing_manifests[@]} -eq 0 ] && exit 0

# Non-semver versions were filtered out above,
# so only valid x.y.z values reach this stage. If neither base nor the working tree
# yielded a valid version, there is nothing to compute — abort with a message.
TARGET=$(node -e '
  const args = process.argv.slice(1);
  const sep = args.indexOf("--");
  const base = args.slice(0, sep);
  const cur = args.slice(sep + 1);
  const parse = v => v.split(".").map(Number);
  const cmp = (a, b) => { for (let i = 0; i < 3; i++) { if (a[i] > b[i]) return 1; if (a[i] < b[i]) return -1; } return 0; };
  const maxOf = vs => vs.map(parse).reduce((m, v) => cmp(v, m) > 0 ? v : m);
  const candidates = [];
  if (cur.length) candidates.push(maxOf(cur));
  if (base.length) { const b = maxOf(base); candidates.push([b[0], b[1], b[2] + 1]); }
  if (!candidates.length) process.exit(7);
  const target = candidates.reduce((m, v) => cmp(v, m) > 0 ? v : m);
  console.log(target.join("."));
' "${base_versions[@]}" -- "${current_versions[@]}") || {
  echo "pre-commit: no valid x.y.z version found on $BASE_REF or in the working tree; cannot determine a version to bump to." >&2
  exit 1
}

# Write target into every manifest (only the version field changes) and stage it.
for m in "${existing_manifests[@]}"; do
  node -e '
    const fs = require("fs");
    const [file, version] = process.argv.slice(1);
    const pkg = JSON.parse(fs.readFileSync(file, "utf-8"));
    pkg.version = version;
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  ' "$m" "$TARGET"
  git add "$m"
done

echo "Auto-bumped all plugin manifests to version $TARGET"
