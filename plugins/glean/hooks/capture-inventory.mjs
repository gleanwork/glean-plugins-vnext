#!/usr/bin/env node
// SessionStart hook: capture the configured-MCP-server inventory from the host's own
// CLI and leave it where the MCP server can read it.
//
//   node capture-inventory.mjs --host=claude
//   node capture-inventory.mjs --host=codex
//
// The host is passed in rather than sniffed, so a Claude session never probes for the
// Codex binary and vice versa. One script serves both because the privacy filter and
// the credential handling below are a security control, and two copies of a security
// control drift.
//
// WHY A HOOK AT ALL. `claude mcp list` health-checks every server, and health-checking a
// stdio server means spawning it -- including this plugin. Verified: the spawned copy
// goes on to serve a full tools/list with a live remote fetch. Calling the CLI from the
// request path would therefore recurse without bound, one process and one backend call
// per level. A hook is a separate process that the MCP server never invokes, so the
// recursion has no edge to travel along.
//
// Failure is never fatal and never loud: the hook exits 0 whatever happens, because a
// hook that cannot capture an inventory must not be a hook that breaks a session. But it
// is no longer silent. When the capture runs and comes back with nothing it writes a
// negative marker carrying an enumerated reason, so "the hook never fired" and "the hook
// fired and the CLI was missing" stop looking identical. Only codes are written, never an
// error string: an exec failure carries an absolute binary path, which on a normal install
// contains the user's name.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// How long the whole capture may take. The CLI spawns and health-checks every
// configured server on Claude Code, so this scales with server count and network
// latency; the hook is declared async so the wait costs the session nothing.
const CLI_TIMEOUT_MS = 60_000;

const hostArg = process.argv
  .slice(2)
  .find((a) => a.startsWith("--host="))
  ?.slice("--host=".length);

function readStdin() {
  try {
    return fs.readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Base directory shared with the MCP server.
 *
 * MUST match inventoryCachePath() in src/policy/inventory-cache.ts. This process does
 * not inherit the server's env, so it cannot see the PLUGIN_DATA_DIR that start.mjs
 * derives; CLAUDE_PLUGIN_DATA (else ~/.glean) is the one anchor both sides have.
 */
function dataDir() {
  return process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), ".glean");
}

/** Origin plus path only: query and fragment can carry tokens. */
function safeUrl(raw) {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return undefined;
  }
}

/**
 * Whether a URL is one of Glean's own.
 *
 * Glean's own domain only, for v0. Admitting the host the plugin is configured against
 * would additionally cover white-labeled deployments, but it admits everything else
 * sharing that host too: a customer fronting several MCP servers off one gateway under
 * different paths would have the unrelated ones reported, origin and path. Matching the
 * exact host does not help there, because it is the same host.
 *
 * So the trade runs one way. Under-reporting a white-labeled instance costs the remote
 * some visibility; over-reporting discloses a customer's internal estate.
 */
function isGleanUrl(target) {
  if (typeof target !== "string") return false;
  let host;
  try {
    host = new URL(target).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "glean.com" || host.endsWith(".glean.com");
}

// ------------------------------------------------------------------ Claude Code

// Shell ALIASES are a non-issue: execFile does not spawn a shell, so
// `alias claude='claude --dangerously-skip-permissions'` never applies. PATH is the real
// concern, and CLAUDE_CODE_EXECPATH is a better anchor -- it is exported into the MCP
// server's environment and points at the real binary (a Mach-O executable despite its
// .exe name). Undocumented, so it is a hint rather than a contract, but when present it
// sidesteps PATH entirely.
//
// WINDOWS: an npm global install exposes claude.cmd, and since the CVE-2024-27980 fix
// Node refuses to spawn .cmd/.bat without shell:true. So a bare-name invocation needs
// the shell there, which is a further reason to prefer an absolute path.
function claudeCandidates() {
  const candidates = [];
  if (process.env.CLAUDE_CODE_EXECPATH) {
    candidates.push({ file: process.env.CLAUDE_CODE_EXECPATH, shell: false });
  }
  candidates.push({ file: "claude", shell: process.platform === "win32" });
  return candidates;
}

/**
 * Parse one `claude mcp list` line. Returns undefined if it does not fit the format.
 *
 * Two traps, both of which a naive regex drops silently:
 *   - the NAME can contain colons (`plugin:glean-vnext:glean`), so the delimiter is the
 *     first colon followed by whitespace, not the first colon.
 *   - the `(TRANSPORT)` parenthetical is present for remote servers and ABSENT for
 *     stdio ones.
 *
 * The status separator is located from the right because a command can contain flags;
 * status text uses an em dash (`— -32000: …`) rather than " - ", so the rightmost
 * " - " is the separator.
 */
function parseClaudeMcpLine(line) {
  const head = /^(?<name>.+?):\s+(?<rest>.+)$/.exec(line);
  if (!head) return undefined;
  const { name, rest } = head.groups;

  const sep = rest.lastIndexOf(" - ");
  if (sep < 0) return undefined;
  const status = rest.slice(sep + 3).trim();
  let target = rest.slice(0, sep).trim();

  const transport = /\s*\((?<t>[^)]+)\)$/.exec(target);
  if (transport) target = target.slice(0, transport.index).trim();

  return {
    name: name.trim(),
    // Only a remote server can be confirmed as Glean's, so the stdio target -- a launch
    // command -- is not carried past this point. It would disclose filesystem layout for
    // no policy benefit.
    url: transport ? target : undefined,
    status,
  };
}

// `✔ Connected` is treated as authenticated: for a remote server that requires auth,
// having connected means auth succeeded. The two never-connected states say nothing
// about credentials, so they map to unknown rather than to unauthenticated -- claiming a
// server is unauthenticated when it was merely unapproved would be a wrong answer, not
// a cautious one.
function claudeAuthStatus(status) {
  const s = status.toLowerCase();
  if (s.includes("connected")) return "authenticated";
  if (s.includes("authenticat")) return "unauthenticated";
  return "unknown";
}

async function claudeMcpList(cwd) {
  const run = await runCli(claudeCandidates(), ["mcp", "list"], cwd);
  if (!run.ok) return { reason: "cli-unavailable" };

  const rows = [];
  for (const line of run.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("Checking MCP server health")) continue;
    if (/^No MCP servers configured/i.test(trimmed)) return { rows: [] };
    const parsed = parseClaudeMcpLine(trimmed);
    // All-or-nothing. One unrecognized line means the format shifted, and a truncated
    // inventory is indistinguishable from a user who genuinely has fewer servers -- so
    // it is discarded entirely in favour of `unavailable`.
    if (!parsed) return { reason: "cli-output-invalid" };
    rows.push({
      name: parsed.name,
      url: parsed.url ? safeUrl(parsed.url) : undefined,
      authStatus: claudeAuthStatus(parsed.status),
    });
  }
  return { rows };
}

// ------------------------------------------------------------------------ Codex

// Installing the ChatGPT app puts the real codex binary INSIDE the app bundle and does
// NOT add it to PATH, so a bare-name lookup finds nothing on a machine that plainly has
// Codex installed. The bundle path is therefore a first-class candidate rather than a
// fallback curiosity, and there is no exec-path env var to lean on.
function codexCandidates() {
  const candidates = [];
  if (process.env.CODEX_EXECPATH) {
    candidates.push({ file: process.env.CODEX_EXECPATH, shell: false });
  }
  if (process.platform === "darwin") {
    for (const base of ["/Applications", path.join(os.homedir(), "Applications")]) {
      for (const app of ["ChatGPT.app", "Codex.app"]) {
        candidates.push({
          file: path.join(base, app, "Contents", "Resources", "codex"),
          shell: false,
        });
      }
    }
  }
  candidates.push({ file: "codex", shell: process.platform === "win32" });
  return candidates.filter((c) => !path.isAbsolute(c.file) || fs.existsSync(c.file));
}

// A closed enum, serialized snake_case. `unsupported` is NOT purely about
// authentication: Codex builds its server list from configured servers but its auth
// statuses from EFFECTIVE ones, defaulting to `unsupported` when a server is absent from
// the latter. So it can mean "not currently in effect" rather than "has no auth
// mechanism", and mapping it to anything but unknown would overstate what we know.
function codexAuthStatus(raw) {
  if (raw === "oauth" || raw === "bearer_token") return "authenticated";
  if (raw === "not_logged_in") return "unauthenticated";
  return "unknown";
}

async function codexMcpList(cwd) {
  const run = await runCli(codexCandidates(), ["mcp", "list", "--json"], cwd);
  if (!run.ok) return { reason: "cli-unavailable" };
  let parsed;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    return { reason: "cli-output-invalid" };
  }
  if (!Array.isArray(parsed)) return { reason: "cli-output-invalid" };

  const rows = parsed.map((server) => {
    const transport = server?.transport ?? {};
    // Codex emits transport.env, http_headers, env_http_headers and
    // bearer_token_env_var VERBATIM -- confirmed against a real configuration, on a
    // plugin-provided server as well as a user-configured one. Nothing here copies the
    // transport object; only the three fields the contract defines are read out of it,
    // so a credential-bearing key cannot reach the payload even if a future release
    // adds another one.
    return {
      name: String(server?.name ?? ""),
      url: transport.url ? safeUrl(transport.url) : undefined,
      authStatus: codexAuthStatus(server?.auth_status),
    };
  });
  return { rows };
}

// ------------------------------------------------------------------------ shared

async function runCli(candidates, args, cwd) {
  for (const { file, shell } of candidates) {
    try {
      const { stdout } = await execFileAsync(file, args, {
        cwd,
        timeout: CLI_TIMEOUT_MS,
        encoding: "utf-8",
        shell,
        // NO_COLOR because ANSI escapes would defeat the text parsing, and the
        // all-or-nothing rule would then discard a perfectly good inventory.
        env: { ...process.env, NO_COLOR: "1" },
      });
      return { ok: true, stdout };
    } catch {
      // Try the next candidate. A CLI that is absent, unrunnable, or times out is
      // indistinguishable from a host that has none, and both mean `unavailable`.
    }
  }
  return { ok: false };
}

async function main() {
  if (hostArg !== "claude" && hostArg !== "codex") return;

  let payload = {};
  try {
    payload = JSON.parse(readStdin());
  } catch {
    return;
  }

  const sessionId = String(payload.session_id ?? "")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 64);
  // Without a session id there is no key the server would look under, so a capture
  // could only be written somewhere nothing reads.
  if (!sessionId) return;

  // The CLIs are directory-sensitive, so the session's cwd is passed explicitly rather
  // than inherited from wherever the hook happened to be spawned. Within one project
  // the server SET is stable, but per-server approval state is not: the same server
  // reports Connected from a repo root and Pending approval from a subdirectory.
  const cwd =
    typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();

  const outcome =
    hostArg === "claude" ? await claudeMcpList(cwd) : await codexMcpList(cwd);

  // A negative marker rather than no file at all. "No capture happened" and "the capture
  // ran and came back with nothing" are different facts with different fixes -- the first
  // means the hook never fired, the second means the CLI could not be found or its output
  // was not understood -- and writing nothing made them indistinguishable, both on the
  // wire and in the log. Only enumerated codes are written: an exec error would carry an
  // absolute binary path, which on a normal install contains the user's name.
  if (outcome.reason) {
    writeCache(sessionId, { source: "unavailable", reason: outcome.reason });
    return;
  }

  const servers = [];
  let withheld = 0;
  for (const row of outcome.rows) {
    // A stdio server exposes no URL, so it can never be confirmed as Glean's and is
    // always withheld -- including this plugin's own entry. Reporting ours would add
    // nothing: `plugin.id` and `plugin.version` in the same request already say the
    // plugin is here, and the remote is talking to it.
    if (!row.url || !row.name || !isGleanUrl(row.url)) {
      withheld += 1;
      continue;
    }
    // Built field by field. The rows above already drop everything else, and this is the
    // second place that is true, so a field added to a row cannot become a field in the
    // payload by accident.
    servers.push({ name: row.name, url: row.url, authStatus: row.authStatus });
  }

  writeCache(sessionId, { source: "host-cli", servers, withheld });
}

/**
 * Write the capture.
 *
 * A plain write, not the temp-and-rename dance src/atomic-write.ts does for the stores.
 * Those files are shared: several processes read and modify them, so a torn write there
 * discards every entry until something rewrites it. This one is written exactly once, by
 * one process, under a filename keyed to the session -- there is no second writer to race.
 *
 * The remaining window is a reader catching the truncate: `writeFileSync` truncates before
 * writing, and the server does read while a session is starting. That costs one request,
 * which reports `capture-invalid` and recovers on the next one, for a field that is
 * optional by contract. Not worth a temp file and its cleanup.
 */
function writeCache(sessionId, body) {
  const dir = path.join(dataDir(), "inventory");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync applies `mode` only to directories it creates, and umask can mask it, so an
  // existing directory could otherwise stay world-readable. The capture holds server names
  // and URLs, which is exactly what the filter exists to keep narrow.
  fs.chmodSync(dir, 0o700);

  const file = path.join(dir, `${sessionId}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ ...body, capturedAt: new Date().toISOString() }, null, 2),
    { encoding: "utf-8", mode: 0o600 },
  );
  // Same reason as the directory: `mode` applies on creation only, and SessionStart fires
  // again on resume, rewriting an existing file.
  fs.chmodSync(file, 0o600);
}

try {
  await main();
} catch {
  // A hook that cannot capture the inventory must not be a hook that breaks the
  // session. Absence is a valid answer; a non-zero exit here would only produce noise
  // in the transcript for a field the remote treats as optional.
}
process.exit(0);
