import { describe, it, expect, afterEach } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  buildGatewayMetadataHeader,
  callRemoteTool,
  remoteToolTimeoutMs,
} from "../src/remote-client.js";

describe("buildGatewayMetadataHeader", () => {
  it("produces stable output without session ID", () => {
    const a = buildGatewayMetadataHeader();
    const b = buildGatewayMetadataHeader();
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("produces different output with session ID", () => {
    const without = buildGatewayMetadataHeader();
    const with1 = buildGatewayMetadataHeader("session-abc");
    const with2 = buildGatewayMetadataHeader("session-xyz");
    expect(with1).not.toBe(without);
    expect(with1).not.toBe(with2);
  });

  it("output is valid base64", () => {
    const header = buildGatewayMetadataHeader("test-session");
    const decoded = Buffer.from(header, "base64");
    expect(decoded.length).toBeGreaterThan(0);
    expect(Buffer.from(decoded).toString("base64")).toBe(header);
  });

  it("encodes workflow_id and source_info without session", () => {
    const header = buildGatewayMetadataHeader();
    const bytes = Buffer.from(header, "base64");

    // The proto bytes should contain "GLEAN_PLUGIN" (workflow_id, platform,
    // client_initiator) but no session ID string.
    const content = bytes.toString("utf-8");
    const matches = content.match(/GLEAN_PLUGIN/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(3); // workflow_id + platform + client_initiator
  });

  // Cross-language parity: must match Go's proto.Marshal output captured in
  // scio's go/core/mcp/server/proxy_tools_provider_test.go::
  // TestPluginGatewayRequestMetadata_NoSession. If this constant drifts, the
  // hand-rolled TS encoder has diverged from the proto schema — re-derive by
  // running the Go test and copying the asserted base64 here.
  it("matches Go proto.Marshal output (cross-language parity)", () => {
    expect(buildGatewayMetadataHeader()).toBe(
      "CgxHTEVBTl9QTFVHSU4iHBIMR0xFQU5fUExVR0lOGgxHTEVBTl9QTFVHSU4=",
    );
  });

  it("encodes session ID into the proto bytes", () => {
    const header = buildGatewayMetadataHeader("my-session-42");
    const bytes = Buffer.from(header, "base64");
    const content = bytes.toString("utf-8");
    expect(content).toContain("my-session-42");
  });
});

describe("remoteToolTimeoutMs", () => {
  const KEY = "GLEAN_REMOTE_TOOL_TIMEOUT_MS";
  const original = process.env[KEY];

  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  it("defaults to 300000ms when unset", () => {
    delete process.env[KEY];
    expect(remoteToolTimeoutMs()).toBe(300_000);
  });

  it("honors a valid positive override", () => {
    process.env[KEY] = "120000";
    expect(remoteToolTimeoutMs()).toBe(120_000);
  });

  it("falls back to default on a non-numeric value", () => {
    process.env[KEY] = "not-a-number";
    expect(remoteToolTimeoutMs()).toBe(300_000);
  });

  it("falls back to default on zero or negative values", () => {
    process.env[KEY] = "0";
    expect(remoteToolTimeoutMs()).toBe(300_000);
    process.env[KEY] = "-5";
    expect(remoteToolTimeoutMs()).toBe(300_000);
  });
});

describe("callRemoteTool", () => {
  const KEY = "GLEAN_REMOTE_TOOL_TIMEOUT_MS";
  const original = process.env[KEY];

  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  it("passes the configured timeout to client.callTool", async () => {
    const calls: Array<{ params: unknown; schema: unknown; options: unknown }> =
      [];
    const fakeClient = {
      callTool: async (params: unknown, schema: unknown, options: unknown) => {
        calls.push({ params, schema, options });
        return { content: [{ type: "text", text: "ok" }] };
      },
    } as unknown as Client;

    process.env[KEY] = "12345";
    const result = await callRemoteTool(fakeClient, "some_tool", { a: 1 });

    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual({
      name: "some_tool",
      arguments: { a: 1 },
    });
    expect(calls[0].options).toEqual({ timeout: 12345 });
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
  });

  it("normalizes a result with no content field", async () => {
    const fakeClient = {
      callTool: async () => ({}),
    } as unknown as Client;

    const result = await callRemoteTool(fakeClient, "some_tool", {});
    expect(result).toEqual({ content: [] });
  });
});
