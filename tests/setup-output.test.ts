import { describe, expect, it, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CAPABILITY_POLICY_KEY } from "../src/policy/key.js";

// policySummary() and setupClosingLine() are only ever printed together, by the setup
// handler, and the defect they had was one of composition rather than of either half:
// each said "only `setup` is available" and each restated the upgrade instruction, so a
// deactivated install was told twice -- and when the remote supplied its own wording, its
// specific instruction was followed by a vaguer generic one. Neither unit test could see
// that. This asserts the assembled text.
//
// Deactivation is gated on version provenance, and the build constant is absent under
// vitest, which is why policy-session.test.ts documents these lines as unreachable there.
// Mocking the version module is what unlocks them.
vi.mock("../src/version.js", () => ({
  pluginVersion: () => ({ version: "0.2.49", source: "build" }),
  pluginVersionString: () => "0.2.49",
}));

const URL_A = "https://a-be.glean.com/mcp/gateway/proxy";
const REMOTE_UPGRADE_TEXT = "Run `claude plugin update glean` to reach 9.9.9 or later.";

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** The setup handler's text, assembled exactly as index.ts assembles it. */
async function setupText(policy: unknown, promoted: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-output-"));
  vi.resetModules();
  vi.stubEnv("PLUGIN_DATA_DIR", dir);
  const session = await import("../src/policy/session.js");
  const { setupClosingLine } = await import("../src/policy/enforce.js");

  session.initPolicySession(
    {
      getClientVersion: () => ({ name: "claude-code", version: "1.2.3" }),
      getClientCapabilities: () => ({}),
      sendToolListChanged: async () => {},
    } as never,
    () => {},
  );
  session.setPolicyServerUrl(URL_A);
  session.recordPolicyFromResult(
    { tools: [], _meta: { [CAPABILITY_POLICY_KEY]: policy } },
    "tools/call(search)",
  );

  const text =
    `Glean setup is complete.\n` +
    `Server URL: ${URL_A}\n` +
    `Authenticated: yes\n` +
    `${session.policySummary().join("\n")}\n\n` +
    setupClosingLine({ decision: session.decisionInForce(), promoted });

  fs.rmSync(dir, { recursive: true, force: true });
  return text;
}

describe("the assembled setup output", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const deactivating = {
    plugin: {
      minimumSupportedVersion: "9.9.9",
      upgradeRecommendation: { show: true, message: REMOTE_UPGRADE_TEXT },
    },
  };

  it("gives the remote's upgrade instruction exactly once when deactivated", async () => {
    const text = await setupText(deactivating, ["search", "chat"]);

    expect(text).toContain("Deactivated:");
    expect(occurrences(text, REMOTE_UPGRADE_TEXT)).toBe(1);
    // The generic fallback must not appear alongside the remote's own wording, which is
    // what the closing used to add.
    expect(text).not.toContain("Upgrade the Glean plugin");
  });

  it("names no tools when deactivated, and states it once", async () => {
    const text = await setupText(deactivating, ["search", "chat"]);

    expect(text).toContain("No tools are available beyond `setup`.");
    expect(text).not.toContain("You can now use");
    for (const name of ["find_skills", "run_tool", "search", "chat"]) {
      expect(text).not.toContain(name);
    }
  });

  it("never prints the remote's catalog alongside the usable list", async () => {
    const text = await setupText(
      { features: { toolPromotion: { enabled: false } } },
      ["search", "chat", "employee_search"],
    );

    expect(text).toContain("You can now use find_skills, run_tool.");
    // The regression: a withheld feature used to leave these named in "Remote tools: ..."
    // while being unusable and unadvertised.
    expect(text).not.toContain("Remote tools:");
    for (const name of ["search", "chat", "employee_search"]) {
      expect(text).not.toContain(name);
    }
  });

  it("promotes the remote's tools into the one usable list when policy allows", async () => {
    const text = await setupText({ features: {} }, ["search", "chat"]);

    expect(text).toContain("You can now use find_skills, run_tool, search, chat.");
    expect(text).not.toContain("Remote tools:");
  });
});
