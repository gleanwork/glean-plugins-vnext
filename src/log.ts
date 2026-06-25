import path from "node:path";
import fs from "node:fs";
import { homedir } from "node:os";

// Append-only diagnostic log shared by every module. Lives next to the
// plugin's credentials/cache so a single PLUGIN_DATA_DIR locates everything;
// falls back to ~/.glean when the host provides no managed data dir.
//
// Resolved per call (not captured at module load) so it tracks a
// PLUGIN_DATA_DIR set after import — and so importing this module has NO
// filesystem side effects, keeping it safe to pull into any unit under test.
function resolveLogPath(): string {
  const base = process.env.PLUGIN_DATA_DIR || path.join(homedir(), ".glean");
  return path.join(base, "glean-server.log");
}

// Create + lock down the log dir lazily, on the first write to a given dir.
// Guarding by dir (not a bare boolean) re-runs if the path changes between
// calls, which tests do by remapping homedir / PLUGIN_DATA_DIR.
let ensuredDir: string | undefined;
function ensureLogDir(logPath: string): void {
  const dir = path.dirname(logPath);
  if (ensuredDir === dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  } catch {
    /* ignore */
  }
  ensuredDir = dir;
}

// One structured line per event: ISO timestamp, a dotted label, and an
// optional JSON detail object. Mirrored to stderr so it also shows up in the
// host's MCP server logs. Never throws — logging must not break the server.
// Callers must keep `detail` free of secrets/PII (argument values, tokens).
export function logLine(label: string, detail?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const suffix = detail ? ` ${JSON.stringify(detail)}` : "";
  const line = `${ts} ${label}${suffix}\n`;
  const logPath = resolveLogPath();
  ensureLogDir(logPath);
  try {
    fs.appendFileSync(logPath, line, { mode: 0o600 });
    fs.chmodSync(logPath, 0o600);
  } catch {
    /* ignore */
  }
  console.error(line.trimEnd());
}
