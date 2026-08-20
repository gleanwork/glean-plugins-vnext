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

  // Only the fields the contract defines reach the payload. capturedAt is local
  // bookkeeping; `cwd` is a path an earlier build recorded and this one does not, so a
  // file left by that build still carries it. It has to be tolerated and dropped rather
  // than rejected -- refusing a removed field would turn it into an outage on upgrade --
  // and dropped rather than forwarded, because a path is filesystem layout.
  it("passes through only the contract's fields", async () => {
    seed(dir, "sess-1", { ...VALID, cwd: "/Users/someone/acme-migration" });
    const { loadCachedInventory } = await freshCache(dir);

    const result = loadCachedInventory();
    expect(Object.keys(result).sort()).toEqual(["servers", "source", "withheld"]);
    expect(JSON.stringify(result)).not.toContain("acme-migration");
  });

  // The one case asserting the exact shape, so a stray `servers` or `withheld` alongside
  // an unavailable result would be caught somewhere. The rest name only the code.
  it("is unavailable when no capture has happened", async () => {
    const { loadCachedInventory } = await freshCache(dir);
    expect(loadCachedInventory()).toEqual({
      source: "unavailable",
      reason: "capture-pending",
    });
  });

  // The first tools/list of a session normally lands here: SessionStart hooks fire
  // before servers finish connecting, and the Claude capture takes seconds.
  it("is unavailable for a session other than the one captured", async () => {
    seed(dir, "someone-elses-session", VALID);
    const { loadCachedInventory } = await freshCache(dir, "sess-1");
    // Indistinguishable from never having captured, and correctly so: this session has
    // no capture of its own, whatever other sessions did.
    expect(loadCachedInventory().reason).toBe("capture-pending");
  });

  // The one failure this mechanism cannot rule out by construction. The hook is handed
  // `session_id` by the host on stdin; this side reads GLEAN_SESSION_ID, which the launcher
  // sets from the host's own variable. Nothing guarantees those are the same identifier --
  // they are on Claude Code, where the HITL marker has depended on it in production, but
  // Codex names its variable for a thread and its hook field for a session, and the two are
  // unconfirmed. If they ever differ the capture lands under a key nothing reads, so the
  // miss has to be distinguishable from "the hook has not run yet".
  it("distinguishes a capture under another key from none at all", async () => {
    seed(dir, "the-hook-used-this-key", VALID);
    const { loadCachedInventory, lastInventoryDiagnostic } = await freshCache(
      dir,
      "the-server-wants-this-key",
    );

    expect(loadCachedInventory().reason).toBe("capture-pending");
    expect(lastInventoryDiagnostic()).toEqual({
      detail: "no capture file",
      sessionKey: "the-server-wants-this-key",
      // Narrows the cause without proving it. A second concurrent session whose own capture
      // has not landed yet produces the same count -- observed on Claude Code, which ran
      // three plugin processes at once. What it does rule out is the hook never having run
      // on this host at all, which is the question for a host whose support is unconfirmed.
      otherCaptures: 1,
    });
  });

  it("reports no other captures when the hook simply has not run", async () => {
    const { loadCachedInventory, lastInventoryDiagnostic } = await freshCache(dir);
    loadCachedInventory();

    // Absent rather than zero: the directory does not exist, so there was nothing to count.
    expect(lastInventoryDiagnostic()?.otherCaptures).toBeUndefined();
  });

  it("is unavailable when the file is not JSON", async () => {
    seed(dir, "sess-1", "{not json");
    const { loadCachedInventory } = await freshCache(dir);
    expect(loadCachedInventory().reason).toBe("capture-invalid");
  });

  it("is unavailable when source is not host-cli", async () => {
    seed(dir, "sess-1", { ...VALID, source: "files" });
    const { loadCachedInventory } = await freshCache(dir);
    expect(loadCachedInventory().reason).toBe("capture-invalid");
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
    // Not a one-server inventory: the good entry goes with the bad one.
    expect(loadCachedInventory().reason).toBe("capture-invalid");
    expect(loadCachedInventory().servers).toBeUndefined();
  });

  it("rejects a server with no name", async () => {
    seed(dir, "sess-1", { ...VALID, servers: [{ authStatus: "unknown" }] });
    const { loadCachedInventory } = await freshCache(dir);
    expect(loadCachedInventory().reason).toBe("capture-invalid");
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

  // The hook writes a negative marker when it ran and came back with nothing, which is
  // what separates "the hook never fired" from "the hook fired and the CLI was missing".
  it("surfaces the reason the hook recorded", async () => {
    seed(dir, "sess-1", { source: "unavailable", reason: "cli-unavailable" });
    const { loadCachedInventory } = await freshCache(dir);
    expect(loadCachedInventory().reason).toBe("cli-unavailable");
  });

  // The reason goes onto the wire, and the file is untrusted input like everything else
  // in it -- a hook from another build, or anything with write access to the directory.
  // Passing it through unchecked would let a file put arbitrary text in a request.
  it("does not pass an unrecognized reason through to the wire", async () => {
    seed(dir, "sess-1", {
      source: "unavailable",
      reason: "cli-unavailable\" injected: \"see https://internal.acme.com",
    });
    const { loadCachedInventory } = await freshCache(dir);

    const result = loadCachedInventory();
    expect(result.reason).toBe("capture-invalid");
    expect(JSON.stringify(result)).not.toContain("internal.acme.com");
  });

  it("names the field that failed, for the log only", async () => {
    seed(dir, "sess-1", {
      ...VALID,
      servers: [VALID.servers[0], { name: "whatever", authStatus: "connected" }],
    });
    const { loadCachedInventory, lastInventoryDiagnostic } = await freshCache(dir);
    loadCachedInventory();

    // "We saw connected, we expect authenticated" names a version skew outright, so this
    // one value earns its place -- it passes an enum-shaped guard first.
    expect(lastInventoryDiagnostic()).toMatchObject({
      detail: "server entry rejected",
      entries: 2,
      badIndex: 1,
      badField: "authStatus",
      badValue: "connected",
    });
  });

  // The same field, holding something that is not enum-shaped. A rejected file is exactly
  // where its contents are least trustworthy, so anything that could be a token, a
  // hostname, or a path is withheld even from the local log.
  it("withholds a bad value that is not enum-shaped", async () => {
    seed(dir, "sess-1", {
      ...VALID,
      servers: [{ name: "x", authStatus: "Bearer sk-abc123/internal.acme.com" }],
    });
    const { loadCachedInventory, lastInventoryDiagnostic } = await freshCache(dir);
    loadCachedInventory();

    const diagnostic = lastInventoryDiagnostic();
    expect(diagnostic?.badField).toBe("authStatus");
    expect(diagnostic?.badValue).toBeUndefined();
    expect(JSON.stringify(diagnostic)).not.toContain("sk-abc123");
  });

  // A server name may be a third party's, so it is never logged even though it is the
  // most obvious thing to reach for when an entry is rejected.
  it("never logs a server name", async () => {
    seed(dir, "sess-1", {
      ...VALID,
      servers: [{ name: "acme-payroll-internal", authStatus: 42 }],
    });
    const { loadCachedInventory, lastInventoryDiagnostic } = await freshCache(dir);
    loadCachedInventory();

    expect(JSON.stringify(lastInventoryDiagnostic())).not.toContain("payroll");
  });

  it("clears the diagnostic once a read succeeds", async () => {
    seed(dir, "sess-1", { ...VALID, source: "nonsense" });
    const { loadCachedInventory, lastInventoryDiagnostic } = await freshCache(dir);
    loadCachedInventory();
    expect(lastInventoryDiagnostic()).toBeDefined();

    seed(dir, "sess-1", VALID);
    loadCachedInventory();
    expect(lastInventoryDiagnostic()).toBeUndefined();
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
    expect(loadCachedInventory().source).toBe("unavailable");

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
