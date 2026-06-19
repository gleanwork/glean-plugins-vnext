#!/bin/bash
# Invoked by the plugin host (Cowork or Claude Code) to launch the Glean MCP
# server. The plugin ships a single-file esbuild output at dist/index.js with
# every non-builtin inlined — no node_modules next to it. This script handles
# env sanitation before launching the Node process.
set -e
LAUNCH_CWD="$PWD"
PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"

# Resolve where discovered skill files are written.
# CLAUDE_PLUGIN_DATA is the managed lifecycle dir provided by the plugin host.
if [ -n "${CLAUDE_PLUGIN_DATA}" ]; then
  export SKILLS_BASE_DIR="$CLAUDE_PLUGIN_DATA/glean-skills-cache"
else
  export SKILLS_BASE_DIR="${HOME:-/tmp}/.claude/tmp/glean-skills-cache"
fi

# Opt-in: when USE_CLAUDE_PROJECT_DIR=1, route the skills cache under the
# launch project's .claude/tmp/ so the glean_run skill's allowed-tools Read
# glob can match cache files via a path anchored to the project root.
# PROJECT_DIR is the git repo root for the launch cwd, falling back to the
# launch cwd when it is not inside a git repo.
if [ "${USE_CLAUDE_PROJECT_DIR:-}" = "1" ]; then
  PROJECT_DIR=$(git -C "$LAUNCH_CWD" rev-parse --show-toplevel 2>/dev/null || true)
  if [ -z "$PROJECT_DIR" ]; then
    PROJECT_DIR="$LAUNCH_CWD"
  fi
  export SKILLS_BASE_DIR="$PROJECT_DIR/.claude/tmp/glean-skills-cache"
fi

# Resolve where credentials and pending auth state are stored.
if [ -n "${CLAUDE_PLUGIN_DATA}" ]; then
  export PLUGIN_DATA_DIR="$CLAUDE_PLUGIN_DATA"
else
  export PLUGIN_DATA_DIR="${HOME:-/tmp}/.glean"
fi

# Resolve the chat session id host-side. Host-awareness lives here, not in the
# plugin: the launcher reads whatever variable this host exposes and exports the
# normalized GLEAN_SESSION_ID that the Node bundle reads. Claude Code exposes
# CLAUDE_CODE_SESSION_ID; Cursor exposes CURSOR_CONVERSATION_ID. Hosts that
# expose no session id leave it unset, and the plugin falls back to a generated
# per-process id.
if [ -n "${CLAUDE_CODE_SESSION_ID:-}" ]; then
  export GLEAN_SESSION_ID="$CLAUDE_CODE_SESSION_ID"
elif [ -n "${CURSOR_CONVERSATION_ID:-}" ]; then
  export GLEAN_SESSION_ID="$CURSOR_CONVERSATION_ID"
fi

# DEBUG (remove before merge): trace which host var fed the session id.
echo "[glean][debug] CLAUDE_CODE_SESSION_ID=${CLAUDE_CODE_SESSION_ID:-<unset>} CURSOR_CONVERSATION_ID=${CURSOR_CONVERSATION_ID:-<unset>} -> GLEAN_SESSION_ID=${GLEAN_SESSION_ID:-<unset>}" >&2

exec node "$PLUGIN_DIR/dist/index.js"
