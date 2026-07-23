import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { GRANTED, settingKey } from "./approval-keys.js";
import {
  remoteIsToolApproved,
  remoteSetToolApproved,
} from "./remote-approvals.js";

// "Always allow this tool" store for HITL approvals.
//
// Persistence has two modes, chosen by GLEAN_REMOTE_TOOL_APPROVALS (default
// off):
//   off → LOCAL only: a flat settingKey -> settingValue JSON file (shape in
//         approval-keys.ts) under PLUGIN_DATA_DIR || ~/.glean.
//   on  → REMOTE (Glean UserSettings) + LOCAL fallback: writes go to BOTH Glean
//         and the local file; reads prefer Glean and fall back to the local
//         file when the remote call fails (unscoped / offline). Transport +
//         scope caveat live in remote-approvals.ts.
//
// All three exported functions are async because the remote path awaits fetch;
// the local reads/writes underneath remain synchronous.

const PERMISSIONS_FILENAME = "mcp-tool-permissions.json";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function remoteApprovalsEnabled(): boolean {
  return process.env.GLEAN_REMOTE_TOOL_APPROVALS === "true";
}

// In-process cache of remote approval lookups (toolName -> approved) so we don't
// POST listusersettings before every gated tool call. Only consulted when the
// remote flag is on; updated on write, cleared on reset.
const remoteCache = new Map<string, boolean>();

function resolveDir(): string {
  return process.env.PLUGIN_DATA_DIR || path.join(homedir(), ".glean");
}

function permissionsFile(): string {
  return path.join(resolveDir(), PERMISSIONS_FILENAME);
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

function localIsAllowed(toolName: string): boolean {
  return readSettings()[settingKey(toolName)] === GRANTED;
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

export async function isToolAlwaysAllowed(toolName: string): Promise<boolean> {
  if (remoteApprovalsEnabled()) {
    const cached = remoteCache.get(toolName);
    if (cached !== undefined) return cached;
    const remote = await remoteIsToolApproved(toolName);
    if (remote !== null) {
      remoteCache.set(toolName, remote);
      return remote;
    }
    // Remote unavailable (unscoped / offline) -> fall back to the local file.
    return localIsAllowed(toolName);
  }
  return localIsAllowed(toolName);
}

export async function setToolAlwaysAllowed(toolName: string): Promise<void> {
  // Always persist locally so the grant survives even if the remote write fails
  // (and so it's readable as the fallback).
  writeSetting(settingKey(toolName), GRANTED);
  if (remoteApprovalsEnabled()) {
    remoteCache.set(toolName, true);
    const ok = await remoteSetToolApproved(toolName);
    if (!ok) {
      // Best-effort: the local grant already succeeded, so never fail the tool
      // call — just surface it on stderr (mirrors token-store's save logging).
      console.error(
        `[remote-approvals] failed to upsert "${toolName}" to Glean; kept local grant`,
      );
    }
  }
}

export async function clearToolPermissions(): Promise<void> {
  remoteCache.clear();
  try {
    fs.rmSync(permissionsFile(), { force: true });
  } catch {
    /* best-effort */
  }
  // Note: remote bulk-clear is unsupported (no delete endpoint); with the flag
  // on, server-side grants persist until overwritten.
}
