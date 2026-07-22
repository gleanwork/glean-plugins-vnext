import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

// Persistent "Allow across sessions (always)" store for HITL tool approvals.
//
// SHAPE — deliberately mirrors Glean's per-user settings store (a flat
// settingKey -> settingValue string map, as in the backend `UserSettings`
// table). Each approved tool is one key:
//
//     pluginToolApprovals.<toolName> = "true"
//
// Values are strings (not booleans) so the serialized shape is byte-identical
// to what Glean's `POST /api/v1/saveusersettings` would persist. That keeps the
// eventual move server-side to a single-file change.
//
// WHY LOCAL FOR NOW — the plugin authenticates via dynamic MCP client
// registration and only holds the `MCP` OAuth scope; the user-settings REST
// endpoints require `internal:web_api`, which is not grantable to a dynamically
// registered client. Until an MCP-reachable settings read/write exists, we
// persist to a local file. TO MOVE SERVER-SIDE, replace the bodies of
// `readSettings`/`writeSetting` below with calls to that settings surface; the
// key namespace and the exported functions stay the same, so run-tool.ts is
// untouched.

const PERMISSIONS_FILENAME = "mcp-tool-permissions.json";
const KEY_PREFIX = "pluginToolApprovals.";
const GRANTED = "true";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function resolveDir(): string {
  return process.env.PLUGIN_DATA_DIR || path.join(homedir(), ".glean");
}

function permissionsFile(): string {
  return path.join(resolveDir(), PERMISSIONS_FILENAME);
}

function settingKey(toolName: string): string {
  return `${KEY_PREFIX}${toolName}`;
}

// A flat settingKey -> settingValue map, matching the Glean UserSettings store.
interface StoredPermissions {
  settings: Record<string, string>;
}

function readSettings(): Record<string, string> {
  try {
    const raw = fs.readFileSync(permissionsFile(), "utf-8");
    const data = JSON.parse(raw) as Partial<StoredPermissions>;
    if (!data || typeof data.settings !== "object" || data.settings === null) {
      return {};
    }
    return data.settings as Record<string, string>;
  } catch {
    // Missing/corrupt file degrades to "no grants" so a torn write can never
    // silently auto-approve.
    return {};
  }
}

function writeSetting(key: string, value: string): void {
  const settings = readSettings();
  if (settings[key] === value) return;
  settings[key] = value;
  const filePath = permissionsFile();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  fs.chmodSync(dir, DIR_MODE);
  fs.writeFileSync(filePath, JSON.stringify({ settings }, null, 2), {
    encoding: "utf-8",
    mode: FILE_MODE,
  });
  fs.chmodSync(filePath, FILE_MODE);
}

export function isToolAlwaysAllowed(toolName: string): boolean {
  return readSettings()[settingKey(toolName)] === GRANTED;
}

export function setToolAlwaysAllowed(toolName: string): void {
  writeSetting(settingKey(toolName), GRANTED);
}

export function clearToolPermissions(): void {
  try {
    fs.rmSync(permissionsFile(), { force: true });
  } catch {
    /* best-effort */
  }
}
