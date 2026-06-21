import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

const PERMISSIONS_FILENAME = "mcp-tool-permissions.json";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function resolvePermissionsDir(): string {
  return process.env.PLUGIN_DATA_DIR || path.join(homedir(), ".glean");
}

function permissionsFile(): string {
  return path.join(resolvePermissionsDir(), PERMISSIONS_FILENAME);
}

interface StoredPermissions {
  autoApproved: string[];
}

function loadPermissions(): StoredPermissions {
  try {
    const raw = fs.readFileSync(permissionsFile(), "utf-8");
    const data = JSON.parse(raw) as StoredPermissions;
    if (!Array.isArray(data.autoApproved)) return { autoApproved: [] };
    return data;
  } catch {
    return { autoApproved: [] };
  }
}

function savePermissions(data: StoredPermissions): void {
  const filePath = permissionsFile();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  fs.chmodSync(dir, DIR_MODE);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), {
    encoding: "utf-8",
    mode: FILE_MODE,
  });
  fs.chmodSync(filePath, FILE_MODE);
}

export function isToolAutoApproved(toolName: string): boolean {
  return loadPermissions().autoApproved.includes(toolName);
}

export function setToolAutoApproved(toolName: string): void {
  const perms = loadPermissions();
  if (!perms.autoApproved.includes(toolName)) {
    perms.autoApproved.push(toolName);
    savePermissions(perms);
  }
}

export function clearToolPermissions(): void {
  try {
    fs.rmSync(permissionsFile(), { force: true });
  } catch {
    /* ignore */
  }
}
