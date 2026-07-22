import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { resolveSessionId } from "./session-id.js";

// Per-session "Allow in this session" store for HITL tool approvals.
//
// One JSON file per session (keyed by the resolved session id, sanitized for
// use as a filename exactly as run-tool.ts does for the permission-mode marker)
// so cleanup is a single unlink and the store never grows unbounded across
// sessions. Grants are keyed by tool name, matching the per-tool HITL gate, and
// stored in the same flat settingKey -> settingValue shape as the persistent
// "always" store (see tool-permissions-store.ts).
//
// Unlike the permission-mode marker (which a separate PreToolUse hook also
// writes, hence its CLAUDE_PLUGIN_DATA anchor), this file is written AND read
// only inside the server process — the "allow in this session" choice is
// captured during the in-server elicitation — so it uses PLUGIN_DATA_DIR like
// the other server-only stores.

const SUBDIR = "glean-session-allow";
const KEY_PREFIX = "pluginToolApprovals.";
const GRANTED = "true";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function resolveDir(): string {
  return process.env.PLUGIN_DATA_DIR || path.join(homedir(), ".glean");
}

function sessionFile(): string {
  const sessionId = resolveSessionId()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 64);
  return path.join(resolveDir(), SUBDIR, `${sessionId}.json`);
}

function settingKey(toolName: string): string {
  return `${KEY_PREFIX}${toolName}`;
}

interface SessionAllows {
  settings: Record<string, string>;
}

function readSettings(): Record<string, string> {
  try {
    const raw = fs.readFileSync(sessionFile(), "utf-8");
    const data = JSON.parse(raw) as Partial<SessionAllows>;
    if (!data || typeof data.settings !== "object" || data.settings === null) {
      return {};
    }
    return data.settings as Record<string, string>;
  } catch {
    return {};
  }
}

export function isAllowedInSession(toolName: string): boolean {
  return readSettings()[settingKey(toolName)] === GRANTED;
}

export function allowInSession(toolName: string): void {
  const key = settingKey(toolName);
  const settings = readSettings();
  if (settings[key] === GRANTED) return;
  settings[key] = GRANTED;
  const filePath = sessionFile();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  fs.chmodSync(dir, DIR_MODE);
  fs.writeFileSync(filePath, JSON.stringify({ settings }, null, 2), {
    encoding: "utf-8",
    mode: FILE_MODE,
  });
  fs.chmodSync(filePath, FILE_MODE);
}

export function clearSessionAllows(): void {
  try {
    fs.rmSync(sessionFile(), { force: true });
  } catch {
    /* best-effort */
  }
}
