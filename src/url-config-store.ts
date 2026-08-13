import fs from "node:fs";
import path from "node:path";
import {
  ensureDataDir,
  migrateLegacyData,
  resolveDataDir,
} from "./data-dir.js";

const CONFIG_FILENAME = "mcp-server-url.json";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function resolveConfigDir(): string {
  return resolveDataDir();
}

function configFile(): string {
  return path.join(resolveConfigDir(), CONFIG_FILENAME);
}

interface StoredConfig {
  serverUrl: string;
}

export function loadServerUrl(): string | undefined {
  migrateLegacyData();
  try {
    const raw = fs.readFileSync(configFile(), "utf-8");
    const data = JSON.parse(raw) as StoredConfig;
    if (typeof data.serverUrl !== "string" || !data.serverUrl) return undefined;
    return data.serverUrl;
  } catch {
    return undefined;
  }
}

export function saveServerUrl(url: string): void {
  migrateLegacyData();
  const filePath = configFile();
  const dir = ensureDataDir();
  fs.chmodSync(dir, DIR_MODE);
  const data: StoredConfig = { serverUrl: url };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), {
    encoding: "utf-8",
    mode: FILE_MODE,
  });
  fs.chmodSync(filePath, FILE_MODE);
}

export function clearServerUrl(): void {
  migrateLegacyData();
  try {
    fs.rmSync(configFile(), { force: true });
  } catch {
    /* ignore */
  }
}
