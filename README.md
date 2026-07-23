# Glean plugin

Glean's plugin for [Claude Code](https://code.claude.com/docs/en/overview),
Codex, and Cursor. This repo is a single-plugin marketplace, shipping one
manifest per host.

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

### Codex and Cursor

This repo is also a plugin marketplace for **Codex** and **Cursor**: point the
host at `gleanwork/glean-plugins-vnext` and install **glean-vnext** through that
host's plugin flow. The launcher, skills, and server bundle are shared across
all hosts. For Cursor, see
[Team marketplaces](https://cursor.com/docs/plugins#team-marketplaces).

## First run

Setup resolves your Glean instance automatically from your work email, then
triggers OAuth sign-in to Glean via the `setup` tool. `setup` opens the Glean
sign-in page in your browser and captures the authorization code in-context
through a local loopback callback. After sign-in, OAuth credentials are cached
to `~/.glean/` and reused across sessions — you won't be prompted again until
the refresh token expires.

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
/plugin marketplace update glean-plugins-vnext
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

Configuration is interactive: the `setup` tool captures your Glean Server URL
and drives OAuth sign-in on first run (see [First run](#first-run)), persisting
both under `~/.glean/`. No environment variables are required.

A few optional variables let you override behavior. Set them in the host's MCP
server `env` block — the shipped `.mcp.json` / `.mcp.codex.json` already set the
HITL ones — or in your shell:

| Variable | Purpose | Default |
| --- | --- | --- |
| `GLEAN_MCP_SERVER_URL` | Overrides the Glean server URL captured by `setup`. | URL saved by `setup` |
| `ENABLE_HITL` | Human-in-the-loop confirmation before `run_tool` runs a downstream tool. Active only when set to exactly `true`. | `true` (set in the shipped `.mcp.json`) |
| `HITL_TIMEOUT_MS` | Timeout in milliseconds for a HITL confirmation prompt. Positive integer. | `300000` (5 min), set in `.mcp.json` |
| `GLEAN_REMOTE_TOOL_TIMEOUT_MS` | Timeout in milliseconds for a downstream tool call made via `run_tool` (overrides the MCP SDK's 60s default). Positive integer. | `300000` (5 min), bundle default |
| `GLEAN_FILE_ARG_MAX_BYTES` | Maximum size in bytes of each file read via `run_tool`'s `file_args`. Positive integer. | `1048576` (1 MiB), bundle default |
| `GLEAN_REMOTE_TOOL_APPROVALS` | When exactly `true`, persist "always allow this tool" grants to Glean's per-user settings (`saveusersettings`/`listusersettings`, key `pluginToolApprovals.<tool>`) in addition to the local file, and prefer the remote value on read (falling back to the local file when the remote call fails). **Requires the `internal:web_api` OAuth scope**, which a dynamically-registered MCP client does not hold today — so the call will 401/403 until that scope (or an MCP-gateway settings surface) is available. Ships **off**; the local file remains the source of truth when unset. | unset (local only) |
| `USE_CLAUDE_PROJECT_DIR` | Set to `1` to route the skills cache under the launch project's `.claude/tmp/`, so the `glean_run` skill's `Read` glob can match cache files. | unset |

Empty values and un-interpolated `${VAR}` placeholders are ignored, falling back
to the default.

The launcher (`plugins/glean/start.mjs`) also derives and **exports** three more
variables the bundle reads, so these are internal — start.mjs overwrites them on
every launch and setting them yourself has no effect:

- `PLUGIN_DATA_DIR` — directory for credentials, caches, the saved server URL,
  and `glean-server.log`. Defaults to `~/.glean`, or the host's
  `CLAUDE_PLUGIN_DATA` dir when provided.
- `SKILLS_BASE_DIR` — where discovered skill files are written; defaults to
  `<PLUGIN_DATA_DIR>/glean-skills-cache`, or redirected under the launch
  project's `.claude/tmp/` when `USE_CLAUDE_PROJECT_DIR=1`.
- `GLEAN_SESSION_ID` — the host's conversation id: `CLAUDE_CODE_SESSION_ID` for
  Claude Code, `CODEX_THREAD_ID` for Codex, otherwise a generated UUID.

## Troubleshooting

- **Sign-in loop or stale auth** — prompt the agent to reset and sign in again
  (e.g. "reset the Glean setup"). It calls the `setup` tool with `reset=true` to
  clear the saved configuration and credentials, then runs `setup` again to
  re-authenticate.
- **Tools return `[SETUP_REQUIRED]`** — the plugin isn't configured or
  authenticated yet. Prompt the agent to set up Glean (e.g. "set up Glean").
  The `setup` tool, called with no arguments, advances through the next missing
  stage: saving the Server URL, signing in, then fetching the remote tool
  catalog.

## Development

Prerequisites: Node >=22 <26, npm.

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
  marketplace.json        Marketplace manifest for Claude Code.
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
  start.mjs               Cross-platform Node launcher: sanitizes env
                          (SKILLS_BASE_DIR, PLUGIN_DATA_DIR, GLEAN_SESSION_ID),
                          then imports the dist/index.js bundle in-process
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
