import fs from "node:fs";
import path from "node:path";
import {
  acquireDataFileLockSync,
  ensureDataDir,
  type DataLockHandle,
  migrateLegacyData,
  releaseDataFileLock,
  resolveDataDir,
} from "./data-dir.js";

const CREDENTIALS_FILENAME = "mcp-credentials.json";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const CLIENT_REGISTRATION_LOCK = "mcp-client-registration";

export interface CredentialMetadata {
  /** Work account used for the last successful/initiated sign-in. */
  accountEmail?: string | null;
  /** OAuth clients are server-specific. */
  clientServerUrl?: string | null;
  /** Shared recovery budget across sibling plugin processes. */
  abandonedSignIns?: number | null;
  /** Local monotonic-ish timestamp for conflict-free token merging. */
  tokenUpdatedAt?: number | null;
}

export interface StoredCredentials extends CredentialMetadata {
  tokens?: unknown;
  clientInfo?: unknown;
}

export interface SaveCredentialsOptions {
  forceTokenUpdate?: boolean;
  forceClientUpdate?: boolean;
}

function credentialsFile(): string {
  return path.join(resolveDataDir(), CREDENTIALS_FILENAME);
}

function readCredentialsFile(filePath: string): StoredCredentials | undefined {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as StoredCredentials;
  } catch {
    return undefined;
  }
}

export function loadCredentials(): StoredCredentials | undefined {
  migrateLegacyData();
  return readCredentialsFile(credentialsFile());
}

/**
 * mtime of the credentials file (epoch ms), or undefined if unreadable.
 * Cheap change probe: a single stat, no read + parse.
 */
export function credentialsMtimeMs(): number | undefined {
  migrateLegacyData();
  try {
    return fs.statSync(credentialsFile()).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Acquire the registration lock before returning undefined from
 * clientInformation(). The MCP SDK interprets undefined as permission to call
 * /oauth/register, so the lock must span that asynchronous SDK operation and
 * is released by saveClientInformation() or the connection error path.
 */
export function acquireClientRegistrationLock(): DataLockHandle | undefined {
  return acquireDataFileLockSync(CLIENT_REGISTRATION_LOCK, {
    waitMs: 30_000,
    staleMs: 120_000,
  });
}

export function releaseClientRegistrationLock(lock: DataLockHandle | undefined): void {
  releaseDataFileLock(lock);
}

export function saveCredentials(
  tokens: unknown,
  clientInfo: unknown,
  metadata: CredentialMetadata = {},
  options: SaveCredentialsOptions = {},
): void {
  try {
    migrateLegacyData();
    const filePath = credentialsFile();
    const dir = ensureDataDir();
    const existing = readCredentialsFile(filePath);
    const incomingTokenTime = metadata.tokenUpdatedAt ?? undefined;
    const existingTokenTime = existing?.tokenUpdatedAt ?? undefined;
    const existingTokenIsNewer =
      !options.forceTokenUpdate &&
      existing?.tokens !== undefined &&
      (tokens === undefined ||
        (existingTokenTime !== undefined &&
          (incomingTokenTime === undefined ||
            existingTokenTime > incomingTokenTime)));
    const effectiveTokens = existingTokenIsNewer ? existing?.tokens : tokens;
    const effectiveTokenTime = existingTokenIsNewer
      ? existingTokenTime
      : metadata.tokenUpdatedAt !== undefined
        ? metadata.tokenUpdatedAt
        : existing?.tokenUpdatedAt;
    const effectiveClientInfo =
      !options.forceClientUpdate && clientInfo === undefined
        ? existing?.clientInfo
        : clientInfo;
    const data: StoredCredentials = {
      tokens: effectiveTokens,
      clientInfo: effectiveClientInfo,
      // Omitted metadata means preserve it; null explicitly clears it.
      accountEmail:
        metadata.accountEmail !== undefined
          ? metadata.accountEmail
          : existing?.accountEmail,
      clientServerUrl:
        metadata.clientServerUrl !== undefined
          ? metadata.clientServerUrl
          : existing?.clientServerUrl,
      abandonedSignIns:
        metadata.abandonedSignIns !== undefined
          ? metadata.abandonedSignIns
          : existing?.abandonedSignIns,
      tokenUpdatedAt: effectiveTokenTime,
    };
    // Temp-file + rename: concurrent readers never see a half-written store.
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), {
      encoding: "utf-8",
      mode: FILE_MODE,
    });
    fs.renameSync(tmpPath, filePath);
    fs.chmodSync(dir, DIR_MODE);
    fs.chmodSync(filePath, FILE_MODE);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[auth] Failed to persist credentials: ${msg}`);
  }
}

export function clearCredentials(): void {
  try {
    migrateLegacyData();
    fs.rmSync(credentialsFile(), { force: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[auth] Failed to clear credentials: ${msg}`);
  }
}
