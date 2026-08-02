import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MIGRATION_MARKER = ".legacy-store-migrated-v1";
const MIGRATION_LOCK = ".legacy-store-migration.lock";

// These are the files that historically followed PLUGIN_DATA_DIR. Auth and
// setup state now live in the stable per-user directory so terminal, VS Code,
// Cursor, and managed plugin launches share one state store.
const MIGRATED_FILES = [
  "mcp-credentials.json",
  "mcp-server-url.json",
  "remote-tools-cache.json",
  "glean-server.log",
];

export interface DataLockOptions {
  waitMs?: number;
  staleMs?: number;
}

export interface DataLockHandle {
  path: string;
  token: string;
}

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  if (!value || value.startsWith("${")) return undefined;
  return value;
}

/**
 * Stable auth/config directory shared by every host and launcher.
 *
 * GLEAN_AUTH_DATA_DIR is intentionally an explicit escape hatch for tests and
 * controlled deployments. PLUGIN_DATA_DIR is deliberately not used here: it
 * is host-managed and was the source of the terminal/plugin store split.
 */
export function resolveDataDir(): string {
  return (
    envValue("GLEAN_AUTH_DATA_DIR") ??
    path.join(homedir() || process.env.TMPDIR || "/tmp", ".glean")
  );
}

function legacyDataDirs(): string[] {
  const canonical = path.resolve(resolveDataDir());
  const candidates = [envValue("PLUGIN_DATA_DIR"), envValue("CLAUDE_PLUGIN_DATA")];
  return [...new Set(candidates.filter((dir): dir is string => !!dir))]
    .map((dir) => path.resolve(dir))
    .filter((dir) => dir !== canonical);
}

function sleepSync(ms: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
}

function lockPath(name: string): string {
  return path.join(resolveDataDir(), `.${name}.lock`);
}

function isStale(lockFile: string, staleMs: number): boolean {
  try {
    return Date.now() - fs.statSync(lockFile).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

/**
 * Acquire a small cross-process lock using O_EXCL semantics. The returned
 * path must be released by the caller. Stale locks are recoverable after the
 * configured timeout so a crashed plugin cannot permanently block auth.
 */
export function acquireDataFileLockSync(
  name: string,
  options: DataLockOptions = {},
): DataLockHandle | undefined {
  const waitMs = options.waitMs ?? 30_000;
  const staleMs = options.staleMs ?? 120_000;
  const filePath = lockPath(name);
  const dir = path.dirname(filePath);

  try {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    fs.chmodSync(dir, DIR_MODE);
  } catch {
    return undefined;
  }

  const deadline = Date.now() + Math.max(0, waitMs);
  do {
    try {
      const token = randomUUID();
      const fd = fs.openSync(filePath, "wx", FILE_MODE);
      try {
        fs.writeFileSync(
          fd,
          JSON.stringify({
            pid: process.pid,
            token,
            createdAt: new Date().toISOString(),
          }),
          { encoding: "utf-8" },
        );
      } finally {
        fs.closeSync(fd);
      }
      return { path: filePath, token };
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err
        ? (err as { code?: string }).code
        : undefined;
      if (code !== "EEXIST") return undefined;
      if (isStale(filePath, staleMs)) {
        try {
          fs.rmSync(filePath, { force: true });
        } catch {
          /* another process may have replaced or removed the lock */
        }
        continue;
      }
      if (Date.now() >= deadline) return undefined;
      sleepSync(Math.min(25, Math.max(1, deadline - Date.now())));
    }
  } while (Date.now() <= deadline);

  return undefined;
}

export function releaseDataFileLock(lock: DataLockHandle | undefined): void {
  if (!lock) return;
  try {
    const contents = JSON.parse(fs.readFileSync(lock.path, "utf-8")) as {
      token?: string;
    };
    if (contents.token !== lock.token) return;
    fs.rmSync(lock.path, { force: true });
  } catch {
    /* best effort; stale-lock recovery handles a crashed owner */
  }
}

function copyFileAtomically(source: string, target: string): void {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  fs.chmodSync(dir, DIR_MODE);
  const tmp = `${target}.${process.pid}.migration.tmp`;
  try {
    fs.copyFileSync(source, tmp);
    fs.chmodSync(tmp, FILE_MODE);
    fs.renameSync(tmp, target);
    fs.chmodSync(target, FILE_MODE);
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore cleanup failures */
    }
  }
}

/**
 * Migrate files from the old host-managed store(s) once. If both stores exist,
 * the newest source file wins; after migration all current code writes only to
 * resolveDataDir(). The marker prevents an old, already-running process from
 * repeatedly overwriting the canonical store on every request.
 */
export function migrateLegacyData(): void {
  const canonical = resolveDataDir();
  const sources = legacyDataDirs();
  if (sources.length === 0) return;

  const marker = path.join(canonical, MIGRATION_MARKER);
  try {
    if (fs.existsSync(marker)) return;
  } catch {
    return;
  }

  const lock = acquireDataFileLockSync(
    MIGRATION_LOCK.slice(1),
    { waitMs: 5_000, staleMs: 60_000 },
  );
  if (!lock) return;

  try {
    if (fs.existsSync(marker)) return;
    fs.mkdirSync(canonical, { recursive: true, mode: DIR_MODE });
    fs.chmodSync(canonical, DIR_MODE);

    for (const filename of MIGRATED_FILES) {
      const candidates = sources
        .map((dir) => path.join(dir, filename))
        .filter((file) => {
          try {
            return fs.statSync(file).isFile();
          } catch {
            return false;
          }
        })
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      if (candidates.length === 0) continue;

      const target = path.join(canonical, filename);
      const newestSource = candidates[0];
      let targetIsOlder = true;
      try {
        targetIsOlder = fs.statSync(target).mtimeMs < fs.statSync(newestSource).mtimeMs;
      } catch {
        /* target does not exist */
      }
      if (!fs.existsSync(target) || targetIsOlder) {
        copyFileAtomically(newestSource, target);
        console.error(`[auth] Migrated legacy data: ${filename}`);
      }
    }

    fs.writeFileSync(
      marker,
      JSON.stringify({ migratedAt: new Date().toISOString(), sources }),
      { encoding: "utf-8", mode: FILE_MODE },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[auth] Failed to migrate legacy data: ${msg}`);
  } finally {
    releaseDataFileLock(lock);
  }
}

export function ensureDataDir(): string {
  const dir = resolveDataDir();
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  fs.chmodSync(dir, DIR_MODE);
  return dir;
}

export const dataDirConstants = {
  DIR_MODE,
  FILE_MODE,
  MIGRATION_MARKER,
};
