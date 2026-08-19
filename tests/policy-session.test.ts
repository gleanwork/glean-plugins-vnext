import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CAPABILITY_POLICY_KEY } from "../src/policy/key.js";

// session.ts holds module state, so every test gets a fresh module graph and its own
// PLUGIN_DATA_DIR. cachePath() reads the env per call, so stubbing it is enough to
// isolate the cache file.
async function freshSession(dir: string) {
  vi.resetModules();
  vi.stubEnv("PLUGIN_DATA_DIR", dir);
  const session = await import("../src/policy/session.js");
  const cache = await import("../src/policy/cache.js");
  return { session, cache };
}

const URL_A = "https://a-be.glean.com/mcp/gateway/proxy";

interface FakeServer {
  getClientVersion: () => { name: string; version: string };
  getClientCapabilities: () => Record<string, unknown>;
  sendToolListChanged: ReturnType<typeof vi.fn>;
}

function fakeServer(): FakeServer {
  return {
    getClientVersion: () => ({ name: "claude-code", version: "1.2.3" }),
    getClientCapabilities: () => ({ elicitation: {} }),
    sendToolListChanged: vi.fn().mockResolvedValue(undefined),
  };
}

function resultWith(policy: unknown) {
  return { tools: [], _meta: { [CAPABILITY_POLICY_KEY]: policy } };
}

describe("decisionInForce", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-session-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("enables everything supported when there is no configured remote", async () => {
    const { session } = await freshSession(dir);
    session.initPolicySession(fakeServer() as never, () => {});

    const d = session.decisionInForce();

    expect(d.deactivated).toBe(false);
    expect(d.versionState).toBe("unenforced");
    expect(Object.values(d.features).every((v) => v === true)).toBe(true);
  });

  it("enables everything supported when the URL has no cached policy", async () => {
    const { session } = await freshSession(dir);
    session.initPolicySession(fakeServer() as never, () => {});
    session.setPolicyServerUrl(URL_A);

    expect(session.decisionInForce().features.metaTools).toBe(true);
  });

  // The fresh-process regression the design calls out by name: a cached metaTools:false,
  // or a cached deactivation, must not be undone just because this process has not talked
  // to the remote yet. tools/list returns before negotiating on three of its five paths.
  it("applies a cached policy before any exchange happens", async () => {
    const { session, cache } = await freshSession(dir);
    cache.savePolicy(URL_A, { features: { metaTools: { enabled: false } } });

    session.initPolicySession(fakeServer() as never, () => {});
    session.setPolicyServerUrl(URL_A);

    expect(session.decisionInForce().features.metaTools).toBe(false);
  });

  it("reads the cache once per process, not per call", async () => {
    const { session, cache } = await freshSession(dir);
    cache.savePolicy(URL_A, { features: { metaTools: { enabled: false } } });
    session.initPolicySession(fakeServer() as never, () => {});
    session.setPolicyServerUrl(URL_A);

    expect(session.decisionInForce().features.metaTools).toBe(false);

    // Rewrite the file behind its back. A memoized decision ignores it; a per-call read
    // would pick it up.
    cache.savePolicy(URL_A, { features: { metaTools: { enabled: true } } });

    expect(session.decisionInForce().features.metaTools).toBe(false);
  });

  it("logs that the decision came from cache, so the seam is visible", async () => {
    const { session, cache } = await freshSession(dir);
    cache.savePolicy(URL_A, { features: { metaTools: { enabled: false } } });
    const labels: string[] = [];
    session.initPolicySession(fakeServer() as never, (l) => labels.push(l));
    session.setPolicyServerUrl(URL_A);

    session.decisionInForce();

    expect(labels).toContain("policy.seeded-from-cache");
  });

  it("does not claim a cache seed when there was no cached policy", async () => {
    const { session } = await freshSession(dir);
    const labels: string[] = [];
    session.initPolicySession(fakeServer() as never, (l) => labels.push(l));
    session.setPolicyServerUrl(URL_A);

    session.decisionInForce();

    expect(labels).not.toContain("policy.seeded-from-cache");
  });

  // A live response replaces a seeded decision. The no-policy case in particular must
  // clear a cached restriction rather than keep it, which is what separates "the remote
  // answered and has no policy" from "the remote was unreachable".
  it("lets a live no-policy response supersede a cached restriction", async () => {
    const { session, cache } = await freshSession(dir);
    cache.savePolicy(URL_A, { features: { metaTools: { enabled: false } } });
    session.initPolicySession(fakeServer() as never, () => {});
    session.setPolicyServerUrl(URL_A);

    expect(session.decisionInForce().features.metaTools).toBe(false);

    session.recordPolicyFromResult({ tools: [] }, "tools/list");

    expect(session.decisionInForce().features.metaTools).toBe(true);
  });

  it("keeps the cached policy on disk when a response carries none", async () => {
    const { session, cache } = await freshSession(dir);
    cache.savePolicy(URL_A, { features: { metaTools: { enabled: false } } });
    session.initPolicySession(fakeServer() as never, () => {});
    session.setPolicyServerUrl(URL_A);

    session.recordPolicyFromResult({ tools: [] }, "tools/list");

    expect(cache.loadCachedPolicy(URL_A)).toEqual({
      features: { metaTools: { enabled: false } },
    });
  });
});

describe("tools/list_changed notification", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-notify-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  async function armed() {
    const { session } = await freshSession(dir);
    const server = fakeServer();
    session.initPolicySession(server as never, () => {});
    session.setPolicyServerUrl(URL_A);
    // Establish a first decision, which must not itself notify.
    session.recordPolicyFromResult({ tools: [] }, "tools/call(search)");
    return { session, server };
  }

  it("does not notify on the first decision of a process", async () => {
    const { session } = await freshSession(dir);
    const server = fakeServer();
    session.initPolicySession(server as never, () => {});
    session.setPolicyServerUrl(URL_A);

    session.recordPolicyFromResult(
      resultWith({ features: { metaTools: { enabled: false } } }),
      "tools/call(run_tool)",
    );

    expect(server.sendToolListChanged).not.toHaveBeenCalled();
  });

  it("notifies when a tools/call response changes the reachable surface", async () => {
    const { session, server } = await armed();

    session.recordPolicyFromResult(
      resultWith({ features: { metaTools: { enabled: false } } }),
      "tools/call(search)",
    );

    expect(server.sendToolListChanged).toHaveBeenCalledTimes(1);
  });

  // The response to a tools/list IS the update -- the host asked and is about to receive
  // the filtered surface. Notifying would make it ask again, and notify -> list ->
  // resolve -> notify is a cycle.
  it("never notifies from the tools/list path, even on a change", async () => {
    const { session, server } = await armed();

    session.recordPolicyFromResult(
      resultWith({ features: { metaTools: { enabled: false } } }),
      "tools/list",
    );

    expect(server.sendToolListChanged).not.toHaveBeenCalled();
  });

  it("does not notify when only advisory fields differ", async () => {
    const { session, server } = await armed();

    // Same features and deactivated flag; only the message changes.
    session.recordPolicyFromResult(
      resultWith({ message: "a wholly different notice" }),
      "tools/call(search)",
    );

    expect(server.sendToolListChanged).not.toHaveBeenCalled();
  });

  it("does not notify when the same policy arrives twice", async () => {
    const { session, server } = await armed();
    const policy = { features: { metaTools: { enabled: false } } };

    session.recordPolicyFromResult(resultWith(policy), "tools/call(search)");
    session.recordPolicyFromResult(resultWith(policy), "tools/call(search)");

    expect(server.sendToolListChanged).toHaveBeenCalledTimes(1);
  });
});

// The recommendation is computed on every exchange but has exactly one surface: the setup
// tool's output. Without these, `showUpgrade` and the remote's upgrade text are values the
// remote sets and no user ever sees -- which is what they were before this change.
describe("policySummary", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-summary-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  async function summaryAfter(policy: unknown) {
    const { session } = await freshSession(dir);
    session.initPolicySession(fakeServer() as never, () => {});
    session.setPolicyServerUrl(URL_A);
    session.recordPolicyFromResult(resultWith(policy), "tools/call(search)");
    return session.policySummary().join("\n");
  }

  // Deliberately not asserting the upgrade or deactivation lines here. Both require
  // versionState to be version-derived, and the build constant is absent under vitest, so
  // pluginVersion() is {0.0.0, unknown} and no version rule ever fires through this
  // module. Their inputs are covered where they ARE reachable: evaluate() carrying
  // upgradeMessage (policy.test.ts) and the deactivation refusal consuming it
  // (policy-enforce.test.ts). The remaining uncovered hop is this function's string
  // assembly for those two branches.
  it("reports the negotiated context and the resolved policy", async () => {
    const summary = await summaryAfter({ features: { metaTools: { enabled: false } } });
    expect(summary).toContain("Plugin version: 0.0.0 (source: unknown)");
    expect(summary).toContain("Host: claude-code");
    expect(summary).toContain("version unenforced");
    expect(summary).toContain('"metaTools":false');
  });

  it("shows a session message as a notice", async () => {
    const summary = await summaryAfter({ message: "Maintenance window at 2am UTC." });
    expect(summary).toContain("Notice: Maintenance window at 2am UTC.");
  });

  it("says nothing about upgrades when the remote does not ask", async () => {
    const summary = await summaryAfter({ features: { metaTools: { enabled: true } } });
    expect(summary).not.toContain("Upgrade available");
    expect(summary).not.toContain("Deactivated:");
  });
});
