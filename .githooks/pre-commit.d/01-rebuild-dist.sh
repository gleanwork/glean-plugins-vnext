#!/bin/bash
# Rebuild dist/index.js and stage it on every commit that touches source files.
set -e
cd "$(git rev-parse --show-toplevel)"

# Skip rebuild if only non-source files are staged (docs, CI, git metadata).
IGNORE_PATHS="^(\.git(attributes|ignore|hooks/)|\.github/|README|LICENSE|CHANGELOG|\.node-version)"
if ! git diff --cached --name-only | grep -qvE "$IGNORE_PATHS"; then
  exit 0
fi

if [ ! -d node_modules ] || [ -L node_modules ]; then
  echo "pre-commit: node_modules missing or is a symlink; running npm ci" >&2
  npm ci --silent
fi

npm run build --silent
git add plugins/glean/dist/index.js
