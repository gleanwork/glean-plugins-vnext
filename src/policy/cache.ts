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
interface PolicyCacheEntry {
  policy?: PolicyResponse;
  updatedAt?: string;
}

type PolicyCacheFile = Record<string, PolicyCacheEntry>;

// Same anchor as url-config-store and token-store: PLUGIN_DATA_DIR when the host
// provides a managed data directory, else ~/.glean.
function cachePath(): string {
  const base = process.env.PLUGIN_DATA_DIR || path.join(os.homedir(), ".glean");
  return path.join(base, "policy-cache.json");
}

function readAll(): PolicyCacheFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(), "utf-8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(data: PolicyCacheFile): void {
  const file = cachePath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch {
    // A cache that cannot be written degrades to in-session-only behavior, which
    // is a worse experience but never a wrong policy decision.
  }
}

/**
 * The cached policy for a remote, or undefined if none has been stored.
 *
 * Returns the policy itself rather than the stored entry: `updatedAt` is written for
 * anyone reading the file by hand and is deliberately not part of the API, so callers
 * cannot come to depend on a timestamp that says nothing about the policy's validity.
 */
export function loadCachedPolicy(serverUrl: string): PolicyResponse | undefined {
  return readAll()[serverUrl]?.policy;
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

// There is deliberately no clear function. Only a valid policy replaces a cached
// policy, and nothing removes one — including `setup({reset})`, which clears the
// server URL, credentials, and tools cache. A cached policy may carry a deactivation
// or a version block, so any local way to discard it is a way to shed one, and the
// remote may be unreachable afterwards with nothing to re-fetch from. The design makes
// the same point about process starts: a fresh plugin with no connection is not a
// licence to ignore a cached policy, or every restart would silently undo it.
//
// Switching instances needs no clear either: entries are keyed by remote URL, so a
// different instance simply reads a different (absent) entry.
