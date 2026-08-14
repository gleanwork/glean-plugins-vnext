#!/usr/bin/env node
// @ts-check
// Invoked by the plugin host (Claude Code, Codex, or Cursor) to launch the Glean
// MCP server. The plugin ships a single-file esbuild output at dist/index.js with
// every non-builtin inlined — no node_modules next to it. This script handles
// env sanitation before launching the plugin proper.
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Treat empty strings and un-interpolated "${VAR}" placeholders (which a host
// may pass through verbatim when a variable is unset) as "not set" — matching
// the bundle's own readEnv / resolveSessionId guards.
/** @param {string | undefined} v @returns {string | undefined} */
function val(v) {
  if (v === undefined) return undefined;
  const t = v.trim();
  if (t === "" || t.startsWith("${")) return undefined;
  return t;
}

const launchCwd = process.cwd();

// Resolve where credentials, caches, and config are stored.
// CLAUDE_PLUGIN_DATA is the managed lifecycle dir provided by the plugin host.
const pluginDataDir =
  val(process.env.CLAUDE_PLUGIN_DATA) ??
  path.join(os.homedir() || os.tmpdir(), ".glean");
process.env.PLUGIN_DATA_DIR = pluginDataDir;

// Always resolve the launch project's cache as a readable fallback. Claude may
// have materialized skill/tool files under <project>/.claude/tmp in an earlier
// plugin process, while this install's managed data/cache lives under
// CLAUDE_PLUGIN_DATA. Export both roots so the server can read them in a stable
// order instead of declaring a known tool "unknown" merely because it is in the
// other Claude cache. The managed cache remains the default write target.
let projectDir = launchCwd;
try {
  const top = execFileSync(
    "git",
    ["-C", launchCwd, "rev-parse", "--show-toplevel"],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
  if (top) projectDir = top;
} catch {
  /* not a git repo or git missing: keep the launch cwd fallback */
}
const projectSkillsBaseDir = path.join(
  projectDir,
  ".claude",
  "tmp",
  "glean-skills-cache",
);
process.env.GLEAN_PROJECT_SKILLS_BASE_DIR = projectSkillsBaseDir;

// Discovered skill files are written under the managed data dir by default.
// The existing opt-in still switches the primary/write root to the project;
// read-side discovery de-duplicates the two roots when they are then identical.
let skillsBaseDir = path.join(pluginDataDir, "glean-skills-cache");
if (process.env.USE_CLAUDE_PROJECT_DIR === "1") {
  skillsBaseDir = projectSkillsBaseDir;
}
process.env.SKILLS_BASE_DIR = skillsBaseDir;

// Resolve the chat session id host-side. Host-awareness lives here, not in the
// plugin: the launcher reads whatever variable this host exposes and exports the
// normalized GLEAN_SESSION_ID that the Node bundle reads. Claude Code exposes
// CLAUDE_CODE_SESSION_ID; Codex exposes the conversation id as CODEX_THREAD_ID.
// Hosts that expose no session id (Cursor) leave it unset, and the plugin falls
// back to a generated per-process id.
const sessionId =
  val(process.env.CLAUDE_CODE_SESSION_ID) ?? val(process.env.CODEX_THREAD_ID);
if (sessionId !== undefined) {
  process.env.GLEAN_SESSION_ID = sessionId;
}

// Boot the server in-process. Import via a file URL resolved against this
// module so the dynamic specifier works regardless of cwd and on Windows paths.
await import(new URL("./dist/index.js", import.meta.url).href);
