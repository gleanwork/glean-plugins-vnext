import fs from "node:fs";
import path from "node:path";

import { resolveSessionId } from "../session-id.js";
import { hostSharedDataDir } from "../data-dir.js";
import type {
  AuthStatus,
  ConfiguredServer,
  ConfiguredServers,
  InventoryUnavailableReason,
} from "./types.js";

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
  /** The hook's own reason for having nothing, when source is `unavailable`. */
  reason?: unknown;
  /**
   * When the capture ran. A timestamp, and deliberately the only context recorded.
   *
   * The capture's working directory would be the other obvious thing to keep, because
   * `claude mcp list` is directory-sensitive in a way that surprised us: within one
   * project the server SET is stable, but per-server approval state is not -- the same
   * server reports "Connected" from a repo root and "Pending approval" from a
   * subdirectory. So a capture taken in the wrong directory yields a correct list with
   * wrong statuses.
   *
   * It is still not recorded. A path is filesystem layout -- `/Users/<name>/...` carries
   * a username, and project directory names carry customers' -- which is the same reason
   * a stdio server's launch path is used for identification and then discarded. And the
   * mismatch it would have diagnosed is one the session key already prevents, since the
   * hook's cwd and this process's cwd are both pinned at session start.
   */
  capturedAt?: unknown;
}

const AUTH_STATUSES: ReadonlySet<string> = new Set([
  "authenticated",
  "unauthenticated",
  "unknown",
]);

// The hook may be from a different plugin version, so its reason is untrusted input like
// everything else in the file. Validated against the closed set rather than passed
// through, because this value goes onto the wire -- an unchecked string here would let a
// hand-edited file put arbitrary text into a negotiation request.
const HOOK_REASONS: ReadonlySet<string> = new Set([
  "cli-unavailable",
  "cli-output-invalid",
]);

/**
 * Fine-grained detail about the most recent read, for the local log only.
 *
 * Deliberately separate from the reason that goes on the wire. Field paths, offending
 * value types and byte counts are what actually diagnose a rejection, and none of them
 * belong in a request the remote receives. Never carries a value read out of the file:
 * the file is the output of a privacy filter, so a rejected one is exactly the case where
 * its contents are least trustworthy and most sensitive -- an older build's unfiltered
 * list, or an entry still carrying the credential keys Codex emits verbatim.
 */
export interface InventoryDiagnostic {
  detail: string;
  entries?: number;
  badIndex?: number;
  badField?: string;
  badType?: string;
  badValue?: string;
  bytes?: number;
}

let lastDiagnostic: InventoryDiagnostic | undefined;

/** Detail for the most recent read, or undefined if it succeeded. */
export function lastInventoryDiagnostic(): InventoryDiagnostic | undefined {
  return lastDiagnostic;
}

/**
 * Path to the per-session inventory the SessionStart hook writes.
 *
 * Both halves of this path have to agree with a separate process: see hostSharedDataDir()
 * in ../data-dir.js for the directory, and the same session-id sanitization is repeated in
 * the hook. The agreement is pinned by a test rather than by this comment -- the hook is
 * run for real and the result read back through here.
 */
export function inventoryCachePath(): string {
  const sessionId = resolveSessionId()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 64);
  return path.join(hostSharedDataDir(), "inventory", `${sessionId}.json`);
}

function unavailable(
  reason: InventoryUnavailableReason,
  diagnostic: InventoryDiagnostic,
): ConfiguredServers {
  lastDiagnostic = diagnostic;
  return { source: "unavailable", reason };
}

/**
 * The inventory captured for this session, or `unavailable` with a reason.
 *
 * `unavailable` is a legitimate answer with a defined meaning -- it carries no servers
 * and implies nothing about the user's setup -- so every failure path returns it rather
 * than throwing or inventing an empty list. There are more of those paths than there are
 * error cases: a host with no MCP CLI never captures at all, and even on a supported host
 * the first `tools/list` typically precedes the capture, because SessionStart hooks fire
 * before servers finish connecting.
 *
 * The reason exists because those outcomes were otherwise indistinguishable, on the wire
 * and in the log alike. A fleet reporting `unavailable` for most sessions is either
 * working exactly as designed or completely broken, and nothing said which.
 *
 * Validated rather than trusted. The file is written by a separate process that may be
 * from a different plugin version, so a shape mismatch has to degrade to `unavailable`
 * instead of putting unchecked values into the negotiation payload. Partial validity is
 * not a state: one bad entry discards the batch, matching the all-or-nothing rule the
 * hook applies to CLI output, because a truncated inventory is indistinguishable from a
 * user who genuinely has fewer servers.
 */
export function loadCachedInventory(): ConfiguredServers {
  let raw: string;
  try {
    raw = fs.readFileSync(inventoryCachePath(), "utf-8");
  } catch (err) {
    // Overwhelmingly ENOENT: no capture yet, which is the ordinary state early in a
    // session and the permanent one on a host that runs no hooks.
    const code = (err as { code?: string })?.code;
    return unavailable("capture-pending", {
      detail: code === "ENOENT" ? "no capture file" : `unreadable (${code ?? "unknown"})`,
    });
  }

  let parsed: InventoryCacheFile;
  try {
    parsed = JSON.parse(raw) as InventoryCacheFile;
  } catch {
    return unavailable("capture-invalid", { detail: "not JSON", bytes: raw.length });
  }

  // The hook writes a negative marker when it ran and had nothing, which is what
  // separates "the capture failed" from "the capture has not happened yet".
  if (parsed?.source === "unavailable") {
    if (typeof parsed.reason === "string" && HOOK_REASONS.has(parsed.reason)) {
      return unavailable(parsed.reason as InventoryUnavailableReason, {
        detail: "hook reported no inventory",
      });
    }
    return unavailable("capture-invalid", {
      detail: "hook reason not recognized",
      badField: "reason",
      badType: typeof parsed.reason,
    });
  }

  if (parsed?.source !== "host-cli") {
    return unavailable("capture-invalid", {
      detail: "source not recognized",
      badField: "source",
      badType: typeof parsed?.source,
    });
  }
  if (!Array.isArray(parsed.servers)) {
    return unavailable("capture-invalid", {
      detail: "servers is not an array",
      badField: "servers",
      badType: typeof parsed.servers,
    });
  }

  const servers: ConfiguredServer[] = [];
  for (const [index, entry] of parsed.servers.entries()) {
    const outcome = validateServer(entry);
    if ("bad" in outcome) {
      return unavailable("capture-invalid", {
        detail: "server entry rejected",
        entries: parsed.servers.length,
        badIndex: index,
        ...outcome.bad,
      });
    }
    servers.push(outcome.server);
  }

  const withheld =
    typeof parsed.withheld === "number" &&
    Number.isInteger(parsed.withheld) &&
    parsed.withheld >= 0
      ? parsed.withheld
      : undefined;

  lastDiagnostic = undefined;
  return withheld === undefined
    ? { source: "host-cli", servers }
    : { source: "host-cli", servers, withheld };
}

// Enum-shaped values only. authStatus is the one field where the offending VALUE earns
// its place -- "we saw `connected`, we expect `authenticated`" names a version skew
// outright -- but it is still untrusted text from a file, so it passes only if it could
// not be a token, a hostname, or a path.
const ENUM_SHAPED = /^[a-z_-]{1,32}$/;

type ServerOutcome =
  | { server: ConfiguredServer }
  | { bad: { badField: string; badType: string; badValue?: string } };

function validateServer(entry: unknown): ServerOutcome {
  if (!entry || typeof entry !== "object") {
    return { bad: { badField: "(entry)", badType: typeof entry } };
  }
  const { name, url, authStatus } = entry as Record<string, unknown>;
  if (typeof name !== "string" || !name) {
    // The name itself is never logged: in a rejected file it may be a third party's.
    return { bad: { badField: "name", badType: typeof name } };
  }
  if (typeof authStatus !== "string" || !AUTH_STATUSES.has(authStatus)) {
    return {
      bad: {
        badField: "authStatus",
        badType: typeof authStatus,
        badValue:
          typeof authStatus === "string" && ENUM_SHAPED.test(authStatus)
            ? authStatus
            : undefined,
      },
    };
  }
  if (url !== undefined && typeof url !== "string") {
    return { bad: { badField: "url", badType: typeof url } };
  }
  // Rebuilt field by field rather than spread, so a key the hook adds later -- or one
  // an older cache file still carries -- cannot reach the payload unreviewed.
  return {
    server:
      url === undefined
        ? { name, authStatus: authStatus as AuthStatus }
        : { name, url, authStatus: authStatus as AuthStatus },
  };
}
