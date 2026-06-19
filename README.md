# Glean plugin

Glean's plugin for [Claude Code](https://code.claude.com/docs/en/overview),
[Claude Cowork](https://claude.com/cowork), Codex, and Cursor. This repo is a
single-plugin marketplace, shipping one manifest per host.

Today it ships one plugin:

- **`glean-vnext`** — adds three static tools, `find_skills`, `run_tool`, and
  `setup`, that let the agent discover Glean-hosted skills for enterprise apps
  (Jira, Slack, Google Workspace, Salesforce, etc.) and invoke their downstream
  tools via Glean's MCP gateway. Once the user has authenticated, the plugin
  also surfaces an allow-list of Glean's first-class tools — currently
  `search`, `read_document`, `chat`, `memory`, `memory_schema`,
  `user_activity`, and `employee_search` — directly, with schemas pulled from
  the remote MCP server.

## Install

### Claude Code (terminal)

```
/plugin marketplace add gleanwork/glean-plugins-vnext
/plugin install glean-vnext@glean-plugins-vnext
```

### Claude Cowork (desktop)

1. Open the plugin picker.
2. Click **Add marketplace**, choose **GitHub**, and enter
   `gleanwork/glean-plugins-vnext`.
3. Once the marketplace syncs, install the **glean-vnext** plugin from it.

### Codex and Cursor

The same plugin ships host-specific manifests so it can be installed from
Codex and Cursor as well:

- **Codex** reads `.agents/plugins/marketplace.json` (marketplace
  `glean-plugins-vnext`) and the per-host manifest at
  `plugins/glean/.codex-plugin/plugin.json`, which points the MCP server at
  `.mcp.codex.json`.
- **Cursor** reads `.cursor-plugin/marketplace.json` (marketplace
  `glean-plugins`) and `plugins/glean/.cursor-plugin/plugin.json`, which reuses
  the shared `.mcp.json`.

Point the host at this repo (`gleanwork/glean-plugins-vnext`) and install
**glean-vnext** through that host's plugin flow. The launcher, skills, and
server bundle are shared across all hosts.

## First run

Setup resolves your Glean instance automatically from your work email, then
triggers OAuth sign-in to Glean via the `setup` tool. 

### Setting the Server URL manually

You normally don't need this — `setup` derives the Server (QE) URL from your
work email. Set it explicitly only when you're testing a specific deployment
or your email domain isn't recognized. Two options:

- Pass `server_url` to the `setup` tool with your **Server instance (QE)** URL
  (e.g. `https://acme-be.glean.com`). Admins can find this at
  https://app.glean.com/admin/about-glean.
- Or set the `GLEAN_MCP_SERVER_URL` environment variable.

## Updates

```
# Claude Code
/plugin marketplace update glean-plugins-vnext

# Cowork: the plugin picker has a "Sync" / "Check for updates"
# button on the marketplace entry.
```

## Testing a specific branch or PR

You can point the marketplace at a specific git branch, tag, or commit:

```bash
# Install from a specific branch (e.g. a PR branch)
/plugin marketplace add gleanwork/glean-plugins-vnext@branch-name
/plugin install glean-vnext@glean-plugins-vnext

# Or update an existing marketplace to a different branch
/plugin marketplace remove glean-plugins-vnext
/plugin marketplace add gleanwork/glean-plugins-vnext@branch-name
```

You can also pin to a branch in `settings.json`:

```json
{
  "marketplaces": [
    {
      "name": "glean-plugins-vnext",
      "source": "https://github.com/gleanwork/glean-plugins-vnext",
      "sourceType": "git",
      "branch": "mohit-baseline-marketplace-layout"
    }
  ]
}
```

For local development, point the marketplace at your local checkout instead:

```bash
/plugin marketplace add /path/to/glean-plugins-vnext
```

Then just `git checkout` whichever branch you want to test.

## Configuration

The plugin is configured entirely through environment variables. None are
required for normal use — the launcher (`plugins/glean/start.sh`) derives the
storage and session variables from what the host provides, and the server URL
is captured by the `setup` tool on first run. The variables below are read
directly by the server bundle.

| Variable | Purpose | Default |
| --- | --- | --- |
| `GLEAN_MCP_SERVER_URL` | Overrides the Glean server URL. When unset, the URL saved by the `setup` tool is used. | (stored config from `setup`) |
| `ENABLE_HITL` | Enables human-in-the-loop confirmation before `run_tool` executes a downstream tool. Active only when set to exactly `true`. | disabled |
| `HITL_TIMEOUT_MS` | Timeout, in milliseconds, for a human-in-the-loop confirmation prompt. Must be a positive integer. | `300000` (5 min) |
| `GLEAN_FILE_ARG_MAX_BYTES` | Maximum size, in bytes, of each file read via `run_tool`'s `file_args`. Must be a positive integer. | `1048576` (1 MiB) |
| `PLUGIN_DATA_DIR` | Directory for cached credentials, pending-auth state, the remote-tools cache, the saved server URL, and `glean-server.log`. | `~/.glean` |
| `SKILLS_BASE_DIR` | Directory where discovered skill files are written. | `/tmp/glean-skills-cache` |
| `GLEAN_SESSION_ID` | Chat session id sent with backend calls. | a UUID generated once per process |

Empty values and un-interpolated `${VAR}` placeholders are ignored, so a host
that passes an unset variable through verbatim falls back to the default.

The defaults above are the bundle's built-in fallbacks. The shipped MCP
manifests (`plugins/glean/.mcp.json` and `.mcp.codex.json`) set
`ENABLE_HITL=true` and `HITL_TIMEOUT_MS=300000` in their `env` block, so
human-in-the-loop confirmation is **on by default** in the packaged plugin.

### Launcher-managed variables

`start.sh` runs host-side and normalizes the following host inputs into the
plugin variables above, keeping the server bundle host-agnostic:

| Host variable | Effect |
| --- | --- |
| `CLAUDE_PLUGIN_DATA` | Host-managed lifecycle dir. When set, both `PLUGIN_DATA_DIR` and `SKILLS_BASE_DIR` (as `<dir>/glean-skills-cache`) are anchored under it. |
| `USE_CLAUDE_PROJECT_DIR` | Opt-in (`=1`): routes the skills cache under the launch project's `.claude/tmp/` so the `glean_run` skill's `Read` glob can match cache files. |
| `CLAUDE_CODE_SESSION_ID` | Copied into `GLEAN_SESSION_ID` so the session id tracks the host conversation. |
| `HOME` | Fallback base for `PLUGIN_DATA_DIR` (`~/.glean`) and `SKILLS_BASE_DIR` when `CLAUDE_PLUGIN_DATA` is absent. |

## Troubleshooting

- **Sign-in loop** — the cached OAuth provider state may be stale. Delete
  `~/.glean/mcp-credentials.json` and retry.
- **Tools return `[SETUP_REQUIRED]`** — the plugin isn't configured or
  authenticated yet. Call the `setup` tool (no arguments) to advance through
  the next missing stage: saving the Server URL, signing in, then fetching the
  remote tool catalog.

## Development

Prerequisites: Node 22+, npm.

```bash
npm install
npm test            # vitest
npm run typecheck   # tsc --noEmit
npm run build       # esbuild → plugins/glean/dist/index.js
```

Source is at the repo root (`src/`, `tests/`, `scripts/`). Packaged
runtime lives under `plugins/glean/`. See the Layout section below.

## Release process

1. Bump `version` in all three host plugin manifests — they must match, and
   `scripts/check-version-bump.sh` enforces it:
   - `plugins/glean/.claude-plugin/plugin.json`
   - `plugins/glean/.codex-plugin/plugin.json`
   - `plugins/glean/.cursor-plugin/plugin.json`
2. `npm test && npm run typecheck` — verify clean.
3. Commit, tag, and push:
   ```bash
   git tag v<version>
   git push && git push --tags
   ```
4. Draft a release on GitHub.

## Layout

```
.claude-plugin/
  marketplace.json        Marketplace manifest for Claude Code / Cowork.
                          Points at ./plugins/glean as the plugin source.
.cursor-plugin/
  marketplace.json        Marketplace manifest for Cursor.
.agents/plugins/
  marketplace.json        Marketplace manifest for Codex.
plugins/glean/
  .claude-plugin/
    plugin.json           Claude plugin manifest — name, version, description
  .codex-plugin/
    plugin.json           Codex plugin manifest (skills, mcpServers, interface)
  .cursor-plugin/
    plugin.json           Cursor plugin manifest
  .mcp.json               MCP server invocation for Claude / Cursor. Source
                          of truth; sets ENABLE_HITL / HITL_TIMEOUT_MS.
  .mcp.codex.json         MCP server invocation for Codex
  assets/                 Shared brand assets (logo) referenced by manifests
  dist/index.js           Built server bundle (every dep inlined; produced
                          by `npm run build`; checked in)
  skills/glean_run/       Skill that tells the agent how to use the
                          tools. Uses the open SKILL.md standard.
  start.sh                Bash launcher: sanitizes env (SKILLS_BASE_DIR,
                          PLUGIN_DATA_DIR, GLEAN_SESSION_ID), then execs
                          node on the bundle
  package.json            Minimal "type": "module" manifest so Node
                          treats dist/index.js as ESM at runtime
src/                      TypeScript sources for the MCP server
tests/                    Vitest suite
scripts/                  build.mjs (esbuild bundler), check-version-bump.sh,
                          pack-plugin.sh
package.json              Top-level dev config — deps, npm scripts
tsconfig.json             TypeScript config for the dev tree
```

## License

Apache 2.0. See [LICENSE](./LICENSE).
