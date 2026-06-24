#!/bin/bash
# Invoked by the plugin host (Claude Code, Codex, or Cursor) to launch the Glean
# MCP server. The plugin ships a single-file esbuild output at dist/index.js with
# every non-builtin inlined — no node_modules next to it. This script handles
# env sanitation before launching the Node process.
set -e
LAUNCH_CWD="$PWD"
PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"

# Resolve where credentials, caches, and config are stored.
# CLAUDE_PLUGIN_DATA is the managed lifecycle dir provided by the plugin host.
if [ -n "${CLAUDE_PLUGIN_DATA}" ]; then
  export PLUGIN_DATA_DIR="$CLAUDE_PLUGIN_DATA"
else
  export PLUGIN_DATA_DIR="${HOME:-/tmp}/.glean"
fi

# Discovered skill files are written under the data dir by default, so the
# skills cache tracks PLUGIN_DATA_DIR instead of being resolved separately.
export SKILLS_BASE_DIR="$PLUGIN_DATA_DIR/glean-skills-cache"

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

# Resolve the chat session id host-side. Host-awareness lives here, not in the
# plugin: the launcher reads whatever variable this host exposes and exports the
# normalized GLEAN_SESSION_ID that the Node bundle reads. Claude Code exposes
# CLAUDE_CODE_SESSION_ID; Codex exposes the conversation id as CODEX_THREAD_ID;
# GitHub Copilot (CLI and VS Code) exposes COPILOT_AGENT_SESSION_ID to MCP
# servers. Hosts that expose no session id (Cursor) leave it unset, and the
# plugin falls back to a generated per-process id.
if [ -n "${CLAUDE_CODE_SESSION_ID:-}" ]; then
  export GLEAN_SESSION_ID="$CLAUDE_CODE_SESSION_ID"
elif [ -n "${CODEX_THREAD_ID:-}" ]; then
  export GLEAN_SESSION_ID="$CODEX_THREAD_ID"
elif [ -n "${COPILOT_AGENT_SESSION_ID:-}" ]; then
  export GLEAN_SESSION_ID="$COPILOT_AGENT_SESSION_ID"
fi

exec node "$PLUGIN_DIR/dist/index.js"
