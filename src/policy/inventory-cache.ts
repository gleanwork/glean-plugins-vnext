import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveSessionId } from "../session-id.js";
import type { AuthStatus, ConfiguredServer, ConfiguredServers } from "./types.js";

/**
 * Read side of the configured-server inventory.
 *
 * The inventory comes from the host's own CLI (`claude mcp list`, `codex mcp list
 * --json`), which cannot be invoked from here. `claude mcp list` health-checks every
 * server, and health-checking a stdio server means SPAWNING it -- including this
 * plugin, whose own log shows the spawned copy going on to serve a full `tools/list`
 * with a live remote fetch. So a shell-out from this module would recurse without
 * bound, costing a process and a backend call per level.
 *
 * Hence the split: a SessionStart hook runs the CLI once per session, off the request
 * path, and leaves the result here. **This module only ever reads a file.** That is the
 * invariant the recursion argument rests on, and tests/inventory-cache.test.ts asserts
 * it rather than trusting this comment.
 */

/** What the hook writes. Kept in sync with hooks/capture-inventory.mjs by its tests. */
interface InventoryCacheFile {
  source?: unknown;
  servers?: unknown;
  withheld?: unknown;
  /**
   * Where the capture ran. Recorded for diagnosis only, never compared.
   *
   * `claude mcp list` is directory-sensitive in a way that surprised us: within one
   * project the server SET is stable, but per-server approval state is not -- the same
   * `glean_default` reports "Connected" from a repo root and "Pending approval" from a
   * subdirectory. So a capture taken in the wrong directory yields a correct list with
   * wrong statuses, which is invisible without knowing where it ran.
   *
   * Not used to invalidate: the hook's cwd and this process's cwd are both pinned at
   * session start, so comparing them would add nothing the session key already gives,
   * and the statuses captured are the ones describing this session's own connections.
   */
  cwd?: unknown;
  capturedAt?: unknown;
}

const AUTH_STATUSES: ReadonlySet<string> = new Set([
  "authenticated",
  "unauthenticated",
  "unknown",
]);

/**
 * Path to the per-session inventory the SessionStart hook writes.
 *
 * This resolution MUST match the hook's exactly, the same coupling
 * `permissionModeMarkerPath()` in ../tools/run-tool.ts already carries: the hook is a
 * separate process that never sees the server-only PLUGIN_DATA_DIR start.mjs derives,
 * so both sides key off CLAUDE_PLUGIN_DATA, falling back to ~/.glean. Under start.mjs
 * PLUGIN_DATA_DIR resolves to this same directory.
 */
export function inventoryCachePath(): string {
  const base =
    process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), ".glean");
  const sessionId = resolveSessionId()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 64);
  return path.join(base, "inventory", `${sessionId}.json`);
}

/**
 * The inventory captured for this session, or `unavailable`.
 *
 * `unavailable` is a legitimate answer with a defined meaning -- it carries no servers
 * and implies nothing about the user's setup -- so every failure path returns it rather
 * than throwing or inventing an empty list. There are more of those paths than there
 * are error cases: Cursor has no MCP CLI at all, and even on a supported host the first
 * `tools/list` typically precedes the capture, because SessionStart hooks fire before
 * servers finish connecting.
 *
 * Validated rather than trusted. The file is written by a separate process that may be
 * from a different plugin version, so a shape mismatch has to degrade to `unavailable`
 * instead of putting unchecked values into the negotiation payload. Partial validity is
 * not a state: one bad entry discards the batch, matching the all-or-nothing rule the
 * hook applies to CLI output, because a truncated inventory is indistinguishable from a
 * user who genuinely has fewer servers.
 */
export function loadCachedInventory(): ConfiguredServers {
  try {
    const raw = fs.readFileSync(inventoryCachePath(), "utf-8");
    const parsed = JSON.parse(raw) as InventoryCacheFile;
    if (parsed?.source !== "host-cli" || !Array.isArray(parsed.servers)) {
      return { source: "unavailable" };
    }

    const servers: ConfiguredServer[] = [];
    for (const entry of parsed.servers) {
      const server = validateServer(entry);
      if (!server) return { source: "unavailable" };
      servers.push(server);
    }

    const withheld =
      typeof parsed.withheld === "number" &&
      Number.isInteger(parsed.withheld) &&
      parsed.withheld >= 0
        ? parsed.withheld
        : undefined;

    return withheld === undefined
      ? { source: "host-cli", servers }
      : { source: "host-cli", servers, withheld };
  } catch {
    return { source: "unavailable" };
  }
}

function validateServer(entry: unknown): ConfiguredServer | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const { name, url, authStatus } = entry as Record<string, unknown>;
  if (typeof name !== "string" || !name) return undefined;
  if (typeof authStatus !== "string" || !AUTH_STATUSES.has(authStatus)) {
    return undefined;
  }
  if (url !== undefined && typeof url !== "string") return undefined;
  // Rebuilt field by field rather than spread, so a key the hook adds later -- or one
  // an older cache file still carries -- cannot reach the payload unreviewed.
  return url === undefined
    ? { name, authStatus: authStatus as AuthStatus }
    : { name, url, authStatus: authStatus as AuthStatus };
}
