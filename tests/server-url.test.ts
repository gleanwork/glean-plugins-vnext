import { describe, expect, it } from "vitest";
import {
  normalizeDiscoveredServerUrl,
  preserveExplicitServerUrl,
} from "../src/server-url.js";

describe("server URL handling", () => {
  it("preserves an explicitly supplied experiment path", () => {
    const url = "https://scio-prod-be.glean.com/qe-glean-exp/102";

    expect(preserveExplicitServerUrl(url)).toBe(url);
  });

  it("keeps the default gateway path for email-discovered URLs", () => {
    expect(normalizeDiscoveredServerUrl("https://acme-be.glean.com/")).toBe(
      "https://acme-be.glean.com/mcp/gateway/proxy",
    );
  });

  it("rejects non-HTTP server URLs", () => {
    expect(() => preserveExplicitServerUrl("ftp://example.com/mcp")).toThrow(
      "Server URL must use http or https.",
    );
  });
});
