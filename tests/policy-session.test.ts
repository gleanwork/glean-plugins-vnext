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

  // A response carrying no policy is silence, not revocation. The compatibility path --
  // everything enabled, no version rule -- is for a remote that does not implement
  // negotiation at all, and the cached policy is the evidence of whether this one does.
  it("keeps a cached restriction when a later response carries no policy", async () => {
    const { session, cache } = await freshSession(dir);
    cache.savePolicy(URL_A, { features: { metaTools: { enabled: false } } });
    session.initPolicySession(fakeServer() as never, () => {});
    session.setPolicyServerUrl(URL_A);

    expect(session.decisionInForce().features.metaTools).toBe(false);

    session.recordPolicyFromResult({ tools: [] }, "tools/list");

    expect(session.decisionInForce().features.metaTools).toBe(false);
  });

  // ...and the remote can still lift it, by saying so rather than by going quiet.
  it("lets an explicit re-enable lift a cached restriction", async () => {
    const { session, cache } = await freshSession(dir);
    cache.savePolicy(URL_A, { features: { metaTools: { enabled: false } } });
    session.initPolicySession(fakeServer() as never, () => {});
    session.setPolicyServerUrl(URL_A);

    expect(session.decisionInForce().features.metaTools).toBe(false);

    session.recordPolicyFromResult(
      resultWith({ features: { metaTools: { enabled: true } } }),
      "tools/list",
    );

    expect(session.decisionInForce().features.metaTools).toBe(true);
  });

  // Two levels of omission, deliberately different:
  //
  //   a feature omitted INSIDE a policy  -> no opinion, so enabled
  //   the policy object omitted entirely -> silence, so the cache stands
  //
  // The first depends on savePolicy REPLACING the cached entry rather than merging into
  // it, so every policy is evaluated as a complete statement of intent. Turning that into
  // a merge would make restrictions sticky and leave a remote unable to lift one at all.
  it("lets a later policy lift a restriction by omitting the feature", async () => {
    const { session } = await freshSession(dir);
    session.initPolicySession(fakeServer() as never, () => {});
    session.setPolicyServerUrl(URL_A);

    session.recordPolicyFromResult(
      resultWith({ features: { metaTools: { enabled: false } } }),
      "tools/list",
    );
    expect(session.decisionInForce().features.metaTools).toBe(false);

    // Names only toolPromotion; says nothing at all about metaTools.
    session.recordPolicyFromResult(
      resultWith({ features: { toolPromotion: { enabled: false } } }),
      "tools/list",
    );

    const f = session.decisionInForce().features;
    expect(f.metaTools).toBe(true);
    expect(f.toolPromotion).toBe(false);

    // And the same must hold once the CACHE is what answers, not the incoming policy.
    // evaluate() runs on the response's policy, so the two assertions above pass even if
    // savePolicy merged rather than replaced — the merge would only surface here, or on a
    // later process start. This is the assertion that actually pins replace-not-merge.
    session.recordPolicyFromResult({ content: [] }, "tools/call(search)");
    expect(session.decisionInForce().features.metaTools).toBe(true);
  });

  it("takes the compatibility path when no policy was ever received", async () => {
    const { session } = await freshSession(dir);
    session.initPolicySession(fakeServer() as never, () => {});
    session.setPolicyServerUrl(URL_A);

    session.recordPolicyFromResult({ tools: [] }, "tools/list");

    const d = session.decisionInForce();
    expect(d.features.metaTools).toBe(true);
    expect(d.versionState).toBe("unenforced");
  });

  // The regression this replaced a wrong assumption for: a remote that attaches policy to
  // tools/list but not to tools/call is a plausible split, since a list is answered once
  // while calls are the hot path. Reading omission as revocation made every call clear the
  // policy and every following list restore it -- and each clear changed the surface, so
  // the host re-fetched on every tool call and the advertised list visibly flickered.
  it("does not flip-flop when the remote only attaches policy to tools/list", async () => {
    const { session } = await freshSession(dir);
    const server = fakeServer();
    session.initPolicySession(server as never, () => {});
    session.setPolicyServerUrl(URL_A);

    const policy = { features: { metaTools: { enabled: false } } };
    const seen: boolean[] = [];

    for (const label of ["tools/list", "tools/call(search)", "tools/list", "tools/call(chat)"]) {
      const isList = label === "tools/list";
      session.recordPolicyFromResult(
        isList ? resultWith(policy) : { content: [] },
        label,
        // Mirrors the real handlers: a host-requested list suppresses the notification,
        // a tool call does not. Without this the test would exercise a combination that
        // never occurs in production.
        isList ? { hostReceivingList: true } : undefined,
      );
      seen.push(session.decisionInForce().features.metaTools);
    }

    expect(seen).toEqual([false, false, false, false]);
    expect(server.sendToolListChanged).not.toHaveBeenCalled();
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
  // The suppression is about whether the HOST is receiving the surface, not about which
  // remote method produced it. When it asked for the list, the response is the update, and
  // notifying would make it ask again -- notify -> list -> resolve -> notify is a cycle.
  it("does not notify when the host is receiving the list it asked for", async () => {
    const { session, server } = await armed();

    session.recordPolicyFromResult(
      resultWith({ features: { metaTools: { enabled: false } } }),
      "tools/list",
      { hostReceivingList: true },
    );

    expect(server.sendToolListChanged).not.toHaveBeenCalled();
  });

  // The regression this replaced a label check for. `setup` fetches the remote catalog
  // through the same helper, so it carries the same "tools/list" label -- but the host is
  // receiving setup's text, not a tool list. Keying suppression off the label therefore
  // left the host holding a stale list with nothing to prompt a refresh. Observed against
  // a real remote: setup learned toolPromotion: true and the promoted tools stayed
  // invisible until some later unrelated list.
  it("notifies when setup learns a surface change, despite the tools/list label", async () => {
    const { session, server } = await armed();

    session.recordPolicyFromResult(
      resultWith({ features: { metaTools: { enabled: false } } }),
      "tools/list",
    );

    expect(server.sendToolListChanged).toHaveBeenCalledTimes(1);
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

// dailyCap/weeklyCap are tolerated rather than rejected -- the design has the remote send
// them for forward compatibility and only `show` needs honouring in v0. Tolerating them
// silently is the problem: a remote setting dailyCap: 1 and seeing the recommendation on
// every setup has no way to learn why. So it is stated once, in the log.
describe("unenforced display caps", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-caps-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  async function record(policy: unknown) {
    const { session } = await freshSession(dir);
    const labels: string[] = [];
    session.initPolicySession(fakeServer() as never, (l) => labels.push(l));
    session.setPolicyServerUrl(URL_A);
    session.recordPolicyFromResult(resultWith(policy), "tools/call(search)");
    return { session, labels };
  }

  it("says so when the remote sets a cap", async () => {
    const { labels } = await record({
      plugin: { upgradeRecommendation: { show: true, dailyCap: 1 } },
    });
    expect(labels).toContain("policy.caps-not-enforced");
  });

  it("still accepts the policy rather than calling it malformed", async () => {
    const { labels } = await record({
      plugin: { upgradeRecommendation: { show: true, weeklyCap: 3 } },
    });
    // Tolerated, not rejected: no malformed, and not reported as an unknown key either.
    expect(labels).not.toContain("policy.malformed");
    expect(labels).not.toContain("policy.unknown-keys");
  });

  it("says nothing when the remote sets no cap", async () => {
    const { labels } = await record({
      plugin: { upgradeRecommendation: { show: true } },
    });
    expect(labels).not.toContain("policy.caps-not-enforced");
  });

  // Policy rides every remote response, so an unconditional log here would be one line
  // per tool call for the life of the process.
  it("says it once per process, not once per exchange", async () => {
    const { session, labels } = await record({
      plugin: { upgradeRecommendation: { show: true, dailyCap: 1 } },
    });

    session.recordPolicyFromResult(
      resultWith({ plugin: { upgradeRecommendation: { show: true, dailyCap: 1 } } }),
      "tools/call(chat)",
    );

    expect(labels.filter((l) => l === "policy.caps-not-enforced")).toHaveLength(1);
  });
});
