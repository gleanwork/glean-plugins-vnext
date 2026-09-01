import fs from "node:fs";
import path from "node:path";
import { serverDataDir } from "./data-dir.js";

const CREDENTIALS_FILENAME = "mcp-credentials.json";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function credentialsFile(): string {
  return path.join(serverDataDir(), CREDENTIALS_FILENAME);
}

interface StoredCredentials {
  tokens?: unknown;
  clientInfo?: unknown;
}

export function loadCredentials(): StoredCredentials | undefined {
  try {
    const raw = fs.readFileSync(credentialsFile(), "utf-8");
    return JSON.parse(raw) as StoredCredentials;
  } catch {
    return undefined;
  }
}

export function saveCredentials(tokens: unknown, clientInfo: unknown): void {
  try {
    const filePath = credentialsFile();
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    fs.chmodSync(dir, DIR_MODE);
    const data: StoredCredentials = { tokens, clientInfo };
    // Temp-file + rename: concurrent readers never see a half-written store.
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), {
      encoding: "utf-8",
      mode: FILE_MODE,
    });
    fs.chmodSync(tmpPath, FILE_MODE);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[auth] Failed to persist credentials: ${msg}`);
  }
}

export function clearCredentials(): void {
  try {
    fs.rmSync(credentialsFile(), { force: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[auth] Failed to clear credentials: ${msg}`);
  }
}
