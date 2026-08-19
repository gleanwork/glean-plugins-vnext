import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluate } from "../src/policy/evaluate.js";
import { classifyResult, validatePolicy } from "../src/policy/negotiate.js";
import { CAPABILITY_POLICY_KEY } from "../src/policy/key.js";
import { loadCached, savePolicy } from "../src/policy/cache.js";

const allSupported = {
  toolPromotion: true,
  metaTools: true,
  hitl: true,
  fileArgs: true,
};

describe("feature gating", () => {
  it("disables exactly the feature the remote turned off", () => {
    const d = evaluate({
      pluginVersion: "1.0.0",
      versionSource: "build",
      supportedFeatures: allSupported,
      policy: { features: { fileArgs: { enabled: false } } },
    });
    expect(d.features).toEqual({
      toolPromotion: true,
      metaTools: true,
      hitl: true,
      fileArgs: false,
    });
    expect(d.deactivated).toBe(false);
  });

  it("cannot enable a feature this build does not support", () => {
    const d = evaluate({
      pluginVersion: "1.0.0",
      versionSource: "build",
      supportedFeatures: { ...allSupported, hitl: false },
      policy: { features: { hitl: { enabled: true } } },
    });
    expect(d.features.hitl).toBe(false);
  });

  it("treats an omitted feature as no opinion, not as disabled", () => {
    const d = evaluate({
      pluginVersion: "1.0.0",
      versionSource: "build",
      supportedFeatures: allSupported,
      policy: { features: {} },
    });
    expect(d.features).toEqual(allSupported);
  });
});

describe("version gating", () => {
  it("deactivates below the minimum supported version", () => {
    const d = evaluate({
      pluginVersion: "0.2.43",
      versionSource: "build",
      supportedFeatures: allSupported,
      policy: { plugin: { minimumSupportedVersion: "9.0.0" } },
    });
    expect(d.deactivated).toBe(true);
    expect(d.versionState).toBe("below-minimum");
    // Every feature reads false so no caller can act on a stale enablement.
    expect(Object.values(d.features).every((v) => v === false)).toBe(true);
  });

  it("deactivates an explicitly blocked version while neighbours stay usable", () => {
    const policy = { plugin: { blockedVersions: ["1.2.0"] } };
    const blocked = evaluate({
      pluginVersion: "1.2.0",
      versionSource: "build",
      supportedFeatures: allSupported,
      policy,
    });
    const neighbour = evaluate({
      pluginVersion: "1.3.0",
      versionSource: "build",
      supportedFeatures: allSupported,
      policy,
    });
    expect(blocked.versionState).toBe("blocked");
    expect(neighbour.deactivated).toBe(false);
  });

  it("NEVER enforces version policy when the version source is unknown", () => {
    const d = evaluate({
      pluginVersion: "0.0.0",
      versionSource: "unknown",
      supportedFeatures: allSupported,
      policy: {
        plugin: {
          minimumSupportedVersion: "9.0.0",
          blockedVersions: ["0.0.0"],
        },
      },
    });
    expect(d.deactivated).toBe(false);
    expect(d.versionState).toBe("unenforced");
  });

  it("shows an upgrade notice only when outdated AND the remote asks", () => {
    const base = {
      pluginVersion: "1.0.0",
      versionSource: "build" as const,
      supportedFeatures: allSupported,
    };
    expect(
      evaluate({
        ...base,
        policy: {
          plugin: {
            latestVersion: "2.0.0",
            upgradeRecommendation: { show: true },
          },
        },
      }).showUpgrade,
    ).toBe(true);
    expect(
      evaluate({
        ...base,
        policy: {
          plugin: {
            latestVersion: "2.0.0",
            upgradeRecommendation: { show: false },
          },
        },
      }).showUpgrade,
    ).toBe(false);
    expect(
      evaluate({
        ...base,
        policy: {
          plugin: {
            latestVersion: "1.0.0",
            upgradeRecommendation: { show: true },
          },
        },
      }).showUpgrade,
    ).toBe(false);
  });
});

describe("no-policy compatibility path", () => {
  it("enables everything supported and applies no version rule", () => {
    const d = evaluate({
      pluginVersion: "0.0.1",
      versionSource: "build",
      supportedFeatures: allSupported,
      policy: undefined,
    });
    expect(d.features).toEqual(allSupported);
    expect(d.deactivated).toBe(false);
    expect(d.versionState).toBe("unenforced");
  });
});

describe("outcome classification", () => {
  it("reads a valid policy off result._meta", () => {
    const outcome = classifyResult({
      tools: [],
      _meta: {
        [CAPABILITY_POLICY_KEY]: { features: { hitl: { enabled: false } } },
      },
    });
    expect(outcome.kind).toBe("policy");
  });

  it("distinguishes a successful response with NO policy object", () => {
    expect(classifyResult({ tools: [] }).kind).toBe("no-policy");
    expect(classifyResult({ tools: [], _meta: {} }).kind).toBe("no-policy");
  });

  it("rejects a malformed policy instead of acting on it", () => {
    const outcome = classifyResult({
      _meta: {
        [CAPABILITY_POLICY_KEY]: {
          plugin: { latestVersion: 123 },
          features: "everything-on",
        },
      },
    });
    expect(outcome.kind).toBe("malformed");
  });

  it("accepts unknown extra fields so a newer remote is not called malformed", () => {
    const v = validatePolicy({ somethingNew: { nested: true }, features: {} });
    expect(v.ok).toBe(true);
  });
});

// Leniency is required for forward compatibility, but silent leniency hides a
// renamed or misspelled field: an unrecognized key's type is never checked, so a bad
// value in one is indistinguishable from its absence. The keys are therefore still
// ignored for evaluation AND reported, so the ignoring is greppable.
describe("unknown-key reporting", () => {
  it("still accepts the policy, and names what it ignored", () => {
    const v = validatePolicy({
      somethingNew: true,
      plugin: { latestVersion: "1.0.0", futureRule: 1 },
      features: { toolPromotion: { enabled: true }, notAFeature: {} },
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.unknownKeys.sort()).toEqual([
      "features.notAFeature",
      "plugin.futureRule",
      "somethingNew",
    ]);
  });

  it("reports the exact case the response rename created", () => {
    // A key that WAS valid before the response was nested. It is accepted, because
    // rejecting unrecognized keys would break forward compatibility -- but its bad
    // value would otherwise pass in total silence, which is what the report fixes.
    const v = validatePolicy({ latestPluginVersion: 123 });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.unknownKeys).toEqual(["latestPluginVersion"]);
  });

  it("reports nothing when the policy uses only known keys", () => {
    const v = validatePolicy({
      plugin: {
        latestVersion: "1.0.0",
        minimumSupportedVersion: "0.1.0",
        blockedVersions: [],
        upgradeRecommendation: { show: true, dailyCap: 1, weeklyCap: 3, message: "x" },
      },
      features: { hitl: { enabled: false } },
      message: "x",
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.unknownKeys).toEqual([]);
  });
});

describe("policy cache", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-cache-test-"));
    vi.stubEnv("PLUGIN_DATA_DIR", dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("keys by remote URL so switching instances cannot cross-contaminate", () => {
    savePolicy("https://a.glean.com", { features: { hitl: { enabled: false } } });
    savePolicy("https://b.glean.com", { features: { hitl: { enabled: true } } });

    expect(loadCached("https://a.glean.com").policy).toEqual({
      features: { hitl: { enabled: false } },
    });
    expect(loadCached("https://b.glean.com").policy).toEqual({
      features: { hitl: { enabled: true } },
    });
  });

  // Reset clears the server URL, credentials and tools cache, but NOT this. A cached
  // policy can carry a deactivation or a version block, so a user-invokable way to
  // discard it would be a way to shed one — and the remote may be unreachable
  // afterwards, with nothing to re-fetch from. Hence no clear function at all; a
  // future one would reintroduce exactly that.
  it("exposes no way to discard a cached policy", async () => {
    const mod = await import("../src/policy/cache.js");
    expect(Object.keys(mod).sort()).toEqual(["loadCached", "savePolicy"]);
  });

  // Design: "A response without a policy object does not update or erase the
  // corresponding cache entry."
  it("keeps the cached policy when a later response carries none", () => {
    savePolicy("https://a.glean.com", { features: { hitl: { enabled: false } } });

    // A no-policy round writes nothing, so the entry is untouched.
    expect(loadCached("https://a.glean.com").policy).toEqual({
      features: { hitl: { enabled: false } },
    });
  });

  // tools/list belongs to remote-tools-cache-store.ts. Caching it here too would
  // shadow a live subsystem and let the two disagree about which surface goes with
  // which policy.
  it("stores policy only, never a tools list", () => {
    savePolicy("https://a.glean.com", { features: { hitl: { enabled: false } } });

    const entry = loadCached("https://a.glean.com") as Record<string, unknown>;
    expect(Object.keys(entry).sort()).toEqual(["policy", "updatedAt"]);
  });

  it("returns an empty entry for an unknown URL rather than throwing", () => {
    expect(loadCached("https://never-seen.glean.com")).toEqual({});
  });
});
