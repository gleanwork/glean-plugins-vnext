import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Applied to the whole file, deliberately. `claude mcp list` health-checks every server,
// which SPAWNS each stdio one -- including this plugin, whose spawned copy goes on to
// serve a full tools/list with a live remote fetch. So a shell-out from the read path
// would recurse without bound, one process and one backend call per level. Every entry
// point is replaced with one that records and throws, so any attempt is both counted and
// fatal rather than quietly retried.
const { spawnAttempts } = vi.hoisted(() => ({ spawnAttempts: [] as string[] }));
vi.mock("node:child_process", () => {
  const refuse =
    (name: string) =>
    (..._args: unknown[]) => {
      spawnAttempts.push(name);
      throw new Error(`inventory-cache must never spawn a process (tried ${name})`);
    };
  return {
    spawn: refuse("spawn"),
    spawnSync: refuse("spawnSync"),
    exec: refuse("exec"),
    execFile: refuse("execFile"),
    execSync: refuse("execSync"),
    execFileSync: refuse("execFileSync"),
    default: {},
  };
});

async function freshCache(dir: string, sessionId = "sess-1") {
  vi.resetModules();
  vi.stubEnv("CLAUDE_PLUGIN_DATA", dir);
  vi.stubEnv("GLEAN_SESSION_ID", sessionId);
  return await import("../src/policy/inventory-cache.js");
}

function seed(dir: string, sessionId: string, body: unknown) {
  const target = path.join(dir, "inventory");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(
    path.join(target, `${sessionId}.json`),
    typeof body === "string" ? body : JSON.stringify(body),
  );
}

const VALID = {
  source: "host-cli",
  servers: [
    { name: "glean_default", url: "https://acme-be.glean.com/mcp/default", authStatus: "authenticated" },
    { name: "glean-local", authStatus: "unknown" },
  ],
  withheld: 2,
  cwd: "/repo",
  capturedAt: "2026-08-20T00:00:00Z",
};

describe("loadCachedInventory", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inv-cache-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("reads what the hook wrote", async () => {
    seed(dir, "sess-1", VALID);
    const { loadCachedInventory } = await freshCache(dir);

    expect(loadCachedInventory()).toEqual({
      source: "host-cli",
      servers: [
        { name: "glean_default", url: "https://acme-be.glean.com/mcp/default", authStatus: "authenticated" },
        { name: "glean-local", authStatus: "unknown" },
      ],
      withheld: 2,
    });
  });

  // cwd and capturedAt are written for whoever is diagnosing a surprising status by
  // hand. Letting them into the payload would put fields in a negotiation request that
  // the contract does not define, and a working directory is a filesystem detail.
  it("does not pass the diagnostic fields through to the payload", async () => {
    seed(dir, "sess-1", VALID);
    const { loadCachedInventory } = await freshCache(dir);

    expect(Object.keys(loadCachedInventory()).sort()).toEqual([
      "servers",
      "source",
      "withheld",
    ]);
  });

  it("is unavailable when no capture has happened", async () => {
    const { loadCachedInventory } = await freshCache(dir);
    expect(loadCachedInventory()).toEqual({ source: "unavailable" });
  });

  // The first tools/list of a session normally lands here: SessionStart hooks fire
  // before servers finish connecting, and the Claude capture takes seconds.
  it("is unavailable for a session other than the one captured", async () => {
    seed(dir, "someone-elses-session", VALID);
    const { loadCachedInventory } = await freshCache(dir, "sess-1");
    expect(loadCachedInventory()).toEqual({ source: "unavailable" });
  });

  it("is unavailable when the file is not JSON", async () => {
    seed(dir, "sess-1", "{not json");
    const { loadCachedInventory } = await freshCache(dir);
    expect(loadCachedInventory()).toEqual({ source: "unavailable" });
  });

  it("is unavailable when source is not host-cli", async () => {
    seed(dir, "sess-1", { ...VALID, source: "files" });
    const { loadCachedInventory } = await freshCache(dir);
    expect(loadCachedInventory()).toEqual({ source: "unavailable" });
  });

  // All-or-nothing, the same rule the hook applies to CLI output: a truncated inventory
  // is indistinguishable from a user who genuinely has fewer servers, so one bad entry
  // discards the batch rather than yielding a shorter list.
  it("discards the whole batch when one entry is invalid", async () => {
    seed(dir, "sess-1", {
      ...VALID,
      servers: [VALID.servers[0], { name: "broken", authStatus: "definitely-not-valid" }],
    });
    const { loadCachedInventory } = await freshCache(dir);
    expect(loadCachedInventory()).toEqual({ source: "unavailable" });
  });

  it("rejects a server with no name", async () => {
    seed(dir, "sess-1", { ...VALID, servers: [{ authStatus: "unknown" }] });
    const { loadCachedInventory } = await freshCache(dir);
    expect(loadCachedInventory()).toEqual({ source: "unavailable" });
  });

  // The file is written by a separate process which may be a different plugin version,
  // so an unrecognized key must not ride along into the payload unreviewed.
  it("drops keys it does not know about", async () => {
    seed(dir, "sess-1", {
      source: "host-cli",
      servers: [
        {
          name: "glean_default",
          url: "https://acme-be.glean.com/mcp",
          authStatus: "authenticated",
          env: { GLEAN_API_TOKEN: "leaked" },
          launchPath: "/Users/someone/secrets/start.mjs",
        },
      ],
    });
    const { loadCachedInventory } = await freshCache(dir);

    const result = loadCachedInventory();
    expect(result.servers).toEqual([
      { name: "glean_default", url: "https://acme-be.glean.com/mcp", authStatus: "authenticated" },
    ]);
    expect(JSON.stringify(result)).not.toContain("leaked");
    expect(JSON.stringify(result)).not.toContain("secrets");
  });

  it("omits withheld when it is not a sane count", async () => {
    seed(dir, "sess-1", { ...VALID, withheld: -3 });
    const { loadCachedInventory } = await freshCache(dir);
    expect(loadCachedInventory().withheld).toBeUndefined();
  });

  it("reports a genuinely empty inventory as host-cli, not unavailable", async () => {
    seed(dir, "sess-1", { source: "host-cli", servers: [], withheld: 0 });
    const { loadCachedInventory } = await freshCache(dir);

    // "The host says you have no Glean servers" and "we could not ask" are different
    // facts, and only the second one is `unavailable`.
    expect(loadCachedInventory()).toEqual({ source: "host-cli", servers: [], withheld: 0 });
  });
});

// The reason this module exists. `claude mcp list` health-checks every server, which
// SPAWNS each stdio one -- including this plugin, whose spawned copy goes on to serve a
// full tools/list with a live remote fetch. A shell-out from the read path would
// therefore recurse without bound, one process and one backend call per level. The
// invariant is load-bearing enough to be asserted rather than commented.
describe("the read path never runs a subprocess", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inv-nospawn-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("spawns nothing, on the hit path or the miss path", async () => {
    const { loadCachedInventory } = await freshCache(dir);
    expect(loadCachedInventory()).toEqual({ source: "unavailable" });

    seed(dir, "sess-1", VALID);
    expect(loadCachedInventory().source).toBe("host-cli");

    // Not merely "no spawn happened": the mock throws, and loadCachedInventory catches
    // everything to fail open, so an attempt would otherwise be swallowed into a
    // plausible `unavailable`. The counter is what distinguishes the two.
    expect(spawnAttempts).toEqual([]);
  });

  // A lazy require inside a catch block would defeat the spies above, so the source is
  // also checked for the imports that would make a spawn possible at all.
  it("does not even import a process-spawning module", async () => {
    const here = path.dirname(new URL(import.meta.url).pathname);
    const source = fs.readFileSync(
      path.join(here, "../src/policy/inventory-cache.ts"),
      "utf-8",
    );
    expect(source).not.toContain("child_process");
  });
});
