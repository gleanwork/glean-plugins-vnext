import fs from "node:fs";
import path from "node:path";
import { serverDataDir } from "./data-dir.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { writeFileAtomicSync } from "./atomic-write.js";

const CACHE_FILENAME = "remote-tools-cache.json";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function cacheFile(): string {
  return path.join(serverDataDir(), CACHE_FILENAME);
}

interface ToolsCacheEntry {
  tools: Tool[];
  fetchedAt: string;
}

type ToolsCacheFile = Record<string, ToolsCacheEntry>;

function readStore(): ToolsCacheFile {
  try {
    const raw = fs.readFileSync(cacheFile(), "utf-8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return data as ToolsCacheFile;
    }
    return {};
  } catch {
    return {};
  }
}

function writeStore(store: ToolsCacheFile): void {
  const filePath = cacheFile();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  fs.chmodSync(dir, DIR_MODE);
  writeFileAtomicSync(filePath, JSON.stringify(store, null, 2), FILE_MODE);
}

export function loadRemoteTools(serverUrl: string): Tool[] {
  if (!serverUrl) return [];
  const store = readStore();
  const entry = store[serverUrl];
  if (!entry || !Array.isArray(entry.tools)) return [];
  return entry.tools;
}

// Persist the remote catalog for a URL. Only ever the RAW allow-listed catalog, never
// a surface that capability policy has already been applied to.
//
// That distinction is what lets this cache and the policy cache (policy/cache.ts) be
// written and cleared independently: tools/list composes its answer by filtering this
// catalog through the policy in force, at read time, so a catalog from one moment and a
// policy from another still yield the surface the current policy dictates. Caching a
// post-policy surface here would reintroduce exactly the skew that avoids — a stored
// surface would keep advertising what a newer policy has withdrawn.
export function saveRemoteTools(serverUrl: string, tools: Tool[]): void {
  if (!serverUrl) return;
  try {
    const store = readStore();
    store[serverUrl] = { tools, fetchedAt: new Date().toISOString() };
    writeStore(store);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[remote-tools-cache] Failed to persist: ${msg}`);
  }
}

export function clearRemoteTools(serverUrl?: string): void {
  try {
    if (!serverUrl) {
      fs.rmSync(cacheFile(), { force: true });
      return;
    }
    const store = readStore();
    if (store[serverUrl] !== undefined) {
      delete store[serverUrl];
      if (Object.keys(store).length === 0) {
        fs.rmSync(cacheFile(), { force: true });
      } else {
        writeStore(store);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[remote-tools-cache] Failed to clear: ${msg}`);
  }
}
