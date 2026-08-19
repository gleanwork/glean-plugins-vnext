import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { PolicyResponse } from "./types.js";

// The last VALID policy, keyed by remote URL so switching instances does not
// cross-contaminate. It survives a response that carried no policy and survives a
// malformed one; only a valid policy replaces it.
//
// tools/list is deliberately NOT cached here, even though the design pairs a cached
// policy with a cached surface for the unreachable case. remote-tools-cache-store.ts
// already owns that: it is typed as Tool[] rather than unknown, and is wired into the
// startup, setup, and instance-switch paths. A second copy here would shadow a live
// subsystem, and the two could then disagree about which surface belongs with which
// policy. Anything replaying a cached surface reads it from there.
interface CacheEntry {
  policy?: PolicyResponse;
  updatedAt?: string;
}

type CacheFile = Record<string, CacheEntry>;

// Same anchor as url-config-store and token-store: PLUGIN_DATA_DIR when the host
// provides a managed data directory, else ~/.glean.
function cachePath(): string {
  const base = process.env.PLUGIN_DATA_DIR || path.join(os.homedir(), ".glean");
  return path.join(base, "policy-cache.json");
}

function readAll(): CacheFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(), "utf-8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(data: CacheFile): void {
  const file = cachePath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch {
    // A cache that cannot be written degrades to in-session-only behavior, which
    // is a worse experience but never a wrong policy decision.
  }
}

export function loadCached(serverUrl: string): CacheEntry {
  return readAll()[serverUrl] ?? {};
}

/** Replace the cached policy. Only ever called with a VALIDATED policy. */
export function savePolicy(serverUrl: string, policy: PolicyResponse): void {
  const all = readAll();
  const entry = all[serverUrl] ?? {};
  all[serverUrl] = {
    ...entry,
    policy,
    updatedAt: new Date().toISOString(),
  };
  writeAll(all);
}

export function clearCache(serverUrl?: string): void {
  if (!serverUrl) {
    writeAll({});
    return;
  }
  const all = readAll();
  delete all[serverUrl];
  writeAll(all);
}
