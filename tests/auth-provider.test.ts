import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-provider-test-"));
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => tmpDir };
});

vi.mock("node:child_process", () => ({
  exec: vi.fn(),
  execFile: vi.fn(),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

vi.mock("../src/auth-callback-server.js", () => ({
  getCallbackUrl: () => "http://127.0.0.1:29107/glean-cli-callback",
  setExpectedState: vi.fn(),
}));

const { GleanOAuthClientProvider } = await import("../src/auth-provider.js");
const { setExpectedState } = await import("../src/auth-callback-server.js");

describe("GleanOAuthClientProvider", () => {
  const gleanDir = path.join(tmpDir, ".glean");

  beforeEach(() => {
    delete process.env.PLUGIN_DATA_DIR;
    fs.rmSync(gleanDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(gleanDir, { recursive: true, force: true });
  });

  it("returns undefined tokens when no credentials file exists", () => {
    const provider = new GleanOAuthClientProvider();
    expect(provider.tokens()).toBeUndefined();
    expect(provider.clientInformation()).toBeUndefined();
  });

  it("loads persisted tokens on construction", () => {
    fs.mkdirSync(gleanDir, { recursive: true });
    fs.writeFileSync(
      path.join(gleanDir, "mcp-credentials.json"),
      JSON.stringify({
        tokens: { access_token: "saved_tok", token_type: "Bearer" },
        clientInfo: { client_id: "saved_cid" },
      }),
    );

    const provider = new GleanOAuthClientProvider();

    expect(provider.tokens()).toEqual({
      access_token: "saved_tok",
      token_type: "Bearer",
    });
    expect(provider.clientInformation()).toEqual({ client_id: "saved_cid" });
  });

  it("saveTokens persists to disk", () => {
    const provider = new GleanOAuthClientProvider();
    const tokens = { access_token: "new_tok", token_type: "Bearer" } as any;

    provider.saveTokens(tokens);

    expect(provider.tokens()).toEqual(tokens);
    const raw = JSON.parse(
      fs.readFileSync(path.join(gleanDir, "mcp-credentials.json"), "utf-8"),
    );
    expect(raw.tokens.access_token).toBe("new_tok");
  });

  // --- Cross-process sync: a per-session sibling server may rotate the
  // refresh token and rewrite the shared store; tokens() must pick that up
  // instead of serving the stale startup snapshot. ---

  const credFile = path.join(gleanDir, "mcp-credentials.json");

  function writeCredFileNewer(tokens: unknown, clientInfo?: unknown): void {
    fs.mkdirSync(gleanDir, { recursive: true });
    fs.writeFileSync(credFile, JSON.stringify({ tokens, clientInfo }));
    // Guarantee a strictly-newer mtime than any prior read, independent of
    // filesystem timestamp resolution.
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(credFile, future, future);
  }

  it("tokens() adopts a newer token written by another process", () => {
    fs.mkdirSync(gleanDir, { recursive: true });
    fs.writeFileSync(
      credFile,
      JSON.stringify({
        tokens: { access_token: "T0", refresh_token: "R0" },
        clientInfo: { client_id: "cid" },
      }),
    );
    const provider = new GleanOAuthClientProvider();
    expect(provider.tokens()?.access_token).toBe("T0");

    // Sibling refreshes: new access + rotated refresh token on disk.
    writeCredFileNewer(
      { access_token: "T1", refresh_token: "R1" },
      { client_id: "cid" },
    );

    expect(provider.tokens()?.access_token).toBe("T1");
    expect(provider.tokens()?.refresh_token).toBe("R1");
  });

  it("tokens() keeps the in-memory token when the file is deleted", () => {
    fs.mkdirSync(gleanDir, { recursive: true });
    fs.writeFileSync(
      credFile,
      JSON.stringify({ tokens: { access_token: "T0" }, clientInfo: {} }),
    );
    const provider = new GleanOAuthClientProvider();
    expect(provider.tokens()?.access_token).toBe("T0");

    // Transient disappearance / another process mid-write — don't self-evict.
    fs.rmSync(credFile, { force: true });
    expect(provider.tokens()?.access_token).toBe("T0");
  });

  it("tokens() does not adopt a rewrite that carries no tokens", () => {
    fs.mkdirSync(gleanDir, { recursive: true });
    fs.writeFileSync(
      credFile,
      JSON.stringify({ tokens: { access_token: "T0" }, clientInfo: {} }),
    );
    const provider = new GleanOAuthClientProvider();
    expect(provider.tokens()?.access_token).toBe("T0");

    // A client-only rewrite (tokens dropped) must not log us out in-memory.
    writeCredFileNewer(undefined, { client_id: "cid" });
    expect(provider.tokens()?.access_token).toBe("T0");
  });

  it("saveClientInformation persists to disk", () => {
    const provider = new GleanOAuthClientProvider();
    const info = { client_id: "cid", client_secret: "sec" } as any;

    provider.saveClientInformation(info);

    expect(provider.clientInformation()).toEqual(info);
    const raw = JSON.parse(
      fs.readFileSync(path.join(gleanDir, "mcp-credentials.json"), "utf-8"),
    );
    expect(raw.clientInfo.client_id).toBe("cid");
  });

  it("clearPendingAuth resets auth state", () => {
    const provider = new GleanOAuthClientProvider();
    provider.authorizationUrl = "https://example.com/auth";

    provider.clearPendingAuth();

    expect(provider.pendingAuthCode).toBeUndefined();
    expect(provider.authorizationUrl).toBeUndefined();
  });

  it("saveCodeVerifier and codeVerifier round-trip", () => {
    const provider = new GleanOAuthClientProvider();
    provider.saveCodeVerifier("verifier_abc");
    expect(provider.codeVerifier()).toBe("verifier_abc");
  });

  it("redirectUrl returns the fixed loopback callback URL", () => {
    const provider = new GleanOAuthClientProvider();
    expect(provider.redirectUrl).toBe(
      "http://127.0.0.1:29107/glean-cli-callback",
    );
    expect(provider.clientMetadata.redirect_uris).toEqual([
      "http://127.0.0.1:29107/glean-cli-callback",
    ]);
  });

  it("clientMetadata includes redirect URI and client name", () => {
    const provider = new GleanOAuthClientProvider();
    const meta = provider.clientMetadata;
    expect(meta.client_name).toBe("Glean Claude Code Plugin");
    expect(meta.redirect_uris).toHaveLength(1);
    expect(meta.redirect_uris![0]).toMatch(/127\.0\.0\.1/);
  });

  it("redirectToAuthorization records the URL and hands state to the loopback", async () => {
    const provider = new GleanOAuthClientProvider();
    await provider.redirectToAuthorization(
      new URL("https://example.com/oauth/authorize?state=s1"),
    );
    expect(provider.authorizationUrl).toBe(
      "https://example.com/oauth/authorize?state=s1",
    );
    expect(setExpectedState).toHaveBeenCalledWith("s1");
  });

  it("invalidateCredentials('all') clears all in-memory state and deletes file", async () => {
    const provider = new GleanOAuthClientProvider();
    provider.saveTokens({ access_token: "tok", token_type: "Bearer" } as any);
    provider.saveClientInformation({ client_id: "cid" } as any);
    provider.saveCodeVerifier("verifier");
    await provider.redirectToAuthorization(new URL("https://example.com/oauth/authorize?state=s1"));
    expect(fs.existsSync(path.join(gleanDir, "mcp-credentials.json"))).toBe(true);

    await provider.invalidateCredentials("all");

    expect(provider.tokens()).toBeUndefined();
    expect(provider.clientInformation()).toBeUndefined();
    expect(provider.codeVerifier()).toBe("");
    expect(provider.needsFreshClient()).toBe(false);
    expect(fs.existsSync(path.join(gleanDir, "mcp-credentials.json"))).toBe(false);
  });

  it("invalidateCredentials('client') drops client but keeps tokens", async () => {
    const provider = new GleanOAuthClientProvider();
    provider.saveTokens({ access_token: "tok" } as any);
    provider.saveClientInformation({ client_id: "cid" } as any);
    await provider.invalidateCredentials("client");
    expect(provider.tokens()).toEqual({ access_token: "tok" });
    expect(provider.clientInformation()).toBeUndefined();
  });

  it("invalidateCredentials('tokens') drops tokens but keeps client", async () => {
    const provider = new GleanOAuthClientProvider();
    provider.saveTokens({ access_token: "tok" } as any);
    provider.saveClientInformation({ client_id: "cid" } as any);
    await provider.invalidateCredentials("tokens");
    expect(provider.tokens()).toBeUndefined();
    expect(provider.clientInformation()).toEqual({ client_id: "cid" });
  });

  it("invalidateCredentials('verifier') resets codeVerifier only", async () => {
    const provider = new GleanOAuthClientProvider();
    provider.saveTokens({ access_token: "tok" } as any);
    provider.saveCodeVerifier("verifier");
    await provider.invalidateCredentials("verifier");
    expect(provider.codeVerifier()).toBe("");
    expect(provider.tokens()).toEqual({ access_token: "tok" });
  });

  it("needsFreshClient is false initially", () => {
    const provider = new GleanOAuthClientProvider();
    expect(provider.needsFreshClient()).toBe(false);
  });

  it("needsFreshClient becomes true after issuing an authorize URL without tokens", async () => {
    const provider = new GleanOAuthClientProvider();
    provider.saveClientInformation({ client_id: "cid" } as any);
    await provider.redirectToAuthorization(new URL("https://example.com/oauth/authorize?state=s1"));
    expect(provider.needsFreshClient()).toBe(true);
  });

  it("needsFreshClient is false once tokens are saved", async () => {
    const provider = new GleanOAuthClientProvider();
    await provider.redirectToAuthorization(new URL("https://example.com/oauth/authorize?state=s1"));
    expect(provider.needsFreshClient()).toBe(true);
    provider.saveTokens({ access_token: "tok" } as any);
    expect(provider.needsFreshClient()).toBe(false);
  });

  it("needsFreshClient is false while a pendingAuthCode is waiting to be exchanged", async () => {
    const provider = new GleanOAuthClientProvider();
    await provider.redirectToAuthorization(new URL("https://example.com/oauth/authorize?state=s1"));
    provider.setPendingAuthCode("code_xyz");
    expect(provider.needsFreshClient()).toBe(false);
  });

  it("needsFreshClient resets to false after invalidateCredentials('all')", async () => {
    const provider = new GleanOAuthClientProvider();
    await provider.redirectToAuthorization(new URL("https://example.com/oauth/authorize?state=s1"));
    expect(provider.needsFreshClient()).toBe(true);
    await provider.invalidateCredentials("all");
    expect(provider.needsFreshClient()).toBe(false);
  });

  it("setPendingAuthCode stores code for retrieval", () => {
    const provider = new GleanOAuthClientProvider();
    provider.setPendingAuthCode("code_abc");
    expect(provider.pendingAuthCode).toBe("code_abc");
  });

  it("fires onTokensChanged on saveTokens with the new tokens", () => {
    const provider = new GleanOAuthClientProvider();
    const observed: Array<unknown> = [];
    provider.onTokensChanged = (t) => observed.push(t);
    provider.saveTokens({ access_token: "tok", token_type: "Bearer" });
    expect(observed).toEqual([{ access_token: "tok", token_type: "Bearer" }]);
  });

  it("fires onTokensChanged with undefined when invalidateCredentials clears tokens", async () => {
    const provider = new GleanOAuthClientProvider();
    provider.saveTokens({ access_token: "tok", token_type: "Bearer" });
    const observed: Array<unknown> = [];
    provider.onTokensChanged = (t) => observed.push(t);
    await provider.invalidateCredentials("all");
    expect(observed).toEqual([undefined]);
  });

  it("does not fire onTokensChanged on invalidateCredentials when there were no tokens", async () => {
    const provider = new GleanOAuthClientProvider();
    const observed: Array<unknown> = [];
    provider.onTokensChanged = (t) => observed.push(t);
    await provider.invalidateCredentials("all");
    expect(observed).toEqual([]);
  });

  it("does not fire onTokensChanged on invalidateCredentials('client')", async () => {
    const provider = new GleanOAuthClientProvider();
    provider.saveTokens({ access_token: "tok", token_type: "Bearer" });
    const observed: Array<unknown> = [];
    provider.onTokensChanged = (t) => observed.push(t);
    await provider.invalidateCredentials("client");
    expect(observed).toEqual([]);
  });
});
