import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

const CREDENTIALS_FILENAME = "mcp-credentials.json";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function resolveCredentialsDir(): string {
  return process.env.PLUGIN_DATA_DIR || path.join(homedir(), ".glean");
}

function credentialsFile(): string {
  return path.join(resolveCredentialsDir(), CREDENTIALS_FILENAME);
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

/**
 * Last-modified time (epoch ms) of the credentials file, or undefined if it
 * doesn't exist / can't be stat'd. Used as a cheap change-detection probe so a
 * long-lived provider can notice when a sibling process has rewritten the
 * shared store (e.g. after a refresh-token rotation) and re-read it, instead of
 * serving a stale in-memory snapshot. Kept separate from loadCredentials so the
 * common "nothing changed" path is a single stat, not a full read + parse.
 */
export function credentialsMtimeMs(): number | undefined {
  try {
    return fs.statSync(credentialsFile()).mtimeMs;
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
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), {
      encoding: "utf-8",
      mode: FILE_MODE,
    });
    fs.chmodSync(filePath, FILE_MODE);
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
