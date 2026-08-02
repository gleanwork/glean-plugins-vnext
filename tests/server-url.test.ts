import { describe, expect, it } from "vitest";
import { normalizeServerUrl } from "../src/server-url.js";

describe("normalizeServerUrl", () => {
  it("adds the MCP gateway path to a normal QE origin", () => {
    expect(normalizeServerUrl("https://acme-be.glean.com")).toBe(
      "https://acme-be.glean.com/mcp/gateway/proxy",
    );
  });

  it("preserves an experimental QE path prefix", () => {
    expect(
      normalizeServerUrl("https://scio-prod-be.glean.com/qe-glean-exp-101"),
    ).toBe(
      "https://scio-prod-be.glean.com/qe-glean-exp-101/mcp/gateway/proxy",
    );
  });

  it("does not duplicate the gateway path", () => {
    expect(
      normalizeServerUrl(
        "https://scio-prod-be.glean.com/qe-glean-exp-101/mcp/gateway/proxy/",
      ),
    ).toBe(
      "https://scio-prod-be.glean.com/qe-glean-exp-101/mcp/gateway/proxy",
    );
  });

  it("preserves query parameters such as sc overrides", () => {
    expect(
      normalizeServerUrl(
        "https://scio-prod-be.glean.com/qe-glean-exp-101?sc=db.debug_mode%3D1",
      ),
    ).toBe(
      "https://scio-prod-be.glean.com/qe-glean-exp-101/mcp/gateway/proxy?sc=db.debug_mode%3D1",
    );
  });
});
