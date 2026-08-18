import { describe, expect, it } from "vitest";
import { pluginVersion, pluginVersionString } from "../src/version.js";

// These tests run through vitest, which does not apply esbuild's `define`, so the
// build constant is absent here exactly as it is during a `tsx` dev run. That makes
// the unknown path the one under test, and it is the path that matters: it must report
// honestly rather than invent a version.
describe("pluginVersion", () => {
  it("reports unknown when no build constant was substituted", () => {
    expect(pluginVersion()).toEqual({ version: "0.0.0", source: "unknown" });
  });

  it("does not throw on an undeclared identifier", () => {
    // `typeof` on a missing global is safe; a bare reference would be a
    // ReferenceError and would take the whole server down at import time.
    expect(() => pluginVersion()).not.toThrow();
  });

  it("exposes a bare string for MCP serverInfo/clientInfo", () => {
    expect(pluginVersionString()).toBe("0.0.0");
  });
});
