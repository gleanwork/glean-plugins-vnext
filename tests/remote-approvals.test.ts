import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  remoteIsToolApproved,
  remoteSetToolApproved,
} from "../src/remote-approvals.js";

const BASE = "https://acme-be.glean.com";

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function statusResp(code: number): Response {
  return {
    ok: code >= 200 && code < 300,
    status: code,
    json: async () => ({}),
  } as unknown as Response;
}

describe("remote-approvals", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-approvals-test-"));
    vi.stubEnv("PLUGIN_DATA_DIR", tmpDir);
    vi.stubEnv("GLEAN_MCP_SERVER_URL", `${BASE}/mcp/gateway/proxy`);
    // Credentials file so bearerToken() resolves the access token.
    fs.writeFileSync(
      path.join(tmpDir, "mcp-credentials.json"),
      JSON.stringify({ tokens: { access_token: "tok123", token_type: "Bearer" } }),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("remoteSetToolApproved POSTs saveusersettings with bearer + single-key body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(statusResp(200));
    const ok = await remoteSetToolApproved(
      "jirasearch",
      fetchImpl as unknown as typeof fetch,
    );
    expect(ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE}/api/v1/saveusersettings`);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tok123");
    expect(JSON.parse(init.body)).toEqual({
      settings: [{ key: "pluginToolApprovals.jirasearch", value: "true" }],
    });
  });

  it("remoteSetToolApproved returns false (no throw) on non-200 and on network error", async () => {
    expect(
      await remoteSetToolApproved(
        "jirasearch",
        vi.fn().mockResolvedValue(statusResp(403)) as unknown as typeof fetch,
      ),
    ).toBe(false);
    expect(
      await remoteSetToolApproved(
        "jirasearch",
        vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch,
      ),
    ).toBe(false);
  });

  it("remoteIsToolApproved returns true when the key is present and 'true'", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okJson({
        settings: [{ key: "pluginToolApprovals.jirasearch", value: "true" }],
      }),
    );
    expect(
      await remoteIsToolApproved(
        "jirasearch",
        fetchImpl as unknown as typeof fetch,
      ),
    ).toBe(true);
    expect(fetchImpl.mock.calls[0][0]).toBe(`${BASE}/api/v1/listusersettings`);
  });

  it("remoteIsToolApproved returns false when the key is absent", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okJson({ settings: [] }));
    expect(
      await remoteIsToolApproved(
        "jirasearch",
        fetchImpl as unknown as typeof fetch,
      ),
    ).toBe(false);
  });

  it("remoteIsToolApproved returns null (→ caller falls back) on non-200 / error", async () => {
    expect(
      await remoteIsToolApproved(
        "jirasearch",
        vi.fn().mockResolvedValue(statusResp(403)) as unknown as typeof fetch,
      ),
    ).toBeNull();
    expect(
      await remoteIsToolApproved(
        "jirasearch",
        vi.fn().mockRejectedValue(new Error("boom")) as unknown as typeof fetch,
      ),
    ).toBeNull();
  });

  it("no token → null/false without calling fetch", async () => {
    fs.rmSync(path.join(tmpDir, "mcp-credentials.json"), { force: true });
    const fetchImpl = vi.fn();
    expect(
      await remoteIsToolApproved("jirasearch", fetchImpl as unknown as typeof fetch),
    ).toBeNull();
    expect(
      await remoteSetToolApproved("jirasearch", fetchImpl as unknown as typeof fetch),
    ).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("no server URL → null without calling fetch", async () => {
    vi.stubEnv("GLEAN_MCP_SERVER_URL", ""); // and no stored mcp-server-url.json
    const fetchImpl = vi.fn();
    expect(
      await remoteIsToolApproved("jirasearch", fetchImpl as unknown as typeof fetch),
    ).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
