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
    delete process.env.CLAUDE_PLUGIN_DATA;
    delete process.env.GLEAN_AUTH_DATA_DIR;
    // Skip the rotation grace window by default so invalidation tests don't
    // wait out the real 2s poll; the grace test overrides this explicitly.
    process.env.GLEAN_ROTATION_GRACE_MS = "0";
    fs.rmSync(gleanDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.GLEAN_ROTATION_GRACE_MS;
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

  // --- Cross-process sync: tokens() must pick up a sibling's rewrite. ---

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

  it("invalidateCredentials('tokens') adopts a sibling's newer token instead of wiping the store", async () => {
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

    // A sibling refreshed + rotated: fresh grant now on disk with a newer mtime.
    writeCredFileNewer(
      { access_token: "T1", refresh_token: "R1" },
      { client_id: "cid" },
    );

    // The SDK calls this on invalid_grant. It must NOT clear — the failure was
    // just our stale token; adopt the sibling's fresh one and leave it on disk.
    await provider.invalidateCredentials("tokens");

    expect(provider.tokens()?.access_token).toBe("T1");
    expect(provider.tokens()?.refresh_token).toBe("R1");
    const raw = JSON.parse(fs.readFileSync(credFile, "utf-8"));
    expect(raw.tokens.access_token).toBe("T1"); // not clobbered with undefined
  });

  it("invalidateCredentials('tokens') clears when there is no newer token on disk", async () => {
    const provider = new GleanOAuthClientProvider();
    provider.saveTokens({ access_token: "T0", refresh_token: "R0" } as any);
    expect(provider.tokens()?.access_token).toBe("T0");

    // No sibling write since our snapshot → a genuine invalidation → clear.
    await provider.invalidateCredentials("tokens");

    expect(provider.tokens()).toBeUndefined();
    const raw = JSON.parse(fs.readFileSync(credFile, "utf-8"));
    expect(raw.tokens).toBeUndefined();
  });

  it("invalidateCredentials('tokens') adopts a token that lands during the grace window", async () => {
    // The winner's write lands just after the loser's invalid_grant.
    process.env.GLEAN_ROTATION_GRACE_MS = "2000";
    const provider = new GleanOAuthClientProvider();
    provider.saveTokens({ access_token: "T0", refresh_token: "R0" } as any);

    const invalidation = provider.invalidateCredentials("tokens");
    // Sibling's write lands mid-window.
    setTimeout(() => {
      writeCredFileNewer(
        { access_token: "T1", refresh_token: "R1" },
        { client_id: "cid" },
      );
    }, 150);
    await invalidation;

    expect(provider.tokens()?.access_token).toBe("T1");
    const raw = JSON.parse(fs.readFileSync(credFile, "utf-8"));
    expect(raw.tokens.access_token).toBe("T1"); // not clobbered with undefined
  });

  it("skips the grace window when no refresh token was held (no race possible)", async () => {
    process.env.GLEAN_ROTATION_GRACE_MS = "5000";
    const provider = new GleanOAuthClientProvider();
    provider.saveTokens({ access_token: "T0" } as any); // no refresh_token

    const start = Date.now();
    await provider.invalidateCredentials("tokens");

    expect(Date.now() - start).toBeLessThan(1000); // no 5s poll
    expect(provider.tokens()).toBeUndefined();
  });

  // --- Client reuse: an abandoned sign-in must not burn the DCR client.
  // Every registration permanently adds a client server-side, so the
  // existing one is retried first and a fresh DCR is the escalation path. ---

  it("clientInformation() adopts a sibling's registration from disk", () => {
    // Constructed with no credentials — this process would otherwise register.
    const provider = new GleanOAuthClientProvider();
    expect(provider.clientInformation()).toBeUndefined();

    // Sibling process wins the registration race and persists its client.
    writeCredFileNewer(undefined, { client_id: "cid_sibling" });

    expect(provider.clientInformation()).toEqual({ client_id: "cid_sibling" });
  });

  it("abandonPendingSignIn keeps the registered client and clears the pending flow", async () => {
    const provider = new GleanOAuthClientProvider();
    provider.saveClientInformation({ client_id: "cid" } as any);
    provider.saveCodeVerifier("v1");
    await provider.redirectToAuthorization(
      new URL("https://example.com/oauth/authorize?state=s1"),
    );
    expect(provider.needsFreshClient()).toBe(true);

    expect(provider.abandonPendingSignIn()).toBe(true);

    expect(provider.clientInformation()).toEqual({ client_id: "cid" });
    expect(provider.codeVerifier()).toBe("");
    expect(provider.authorizationUrl).toBeUndefined();
    expect(provider.needsFreshClient()).toBe(false);
    // Registration untouched on disk — nothing was wiped.
    const raw = JSON.parse(fs.readFileSync(credFile, "utf-8"));
    expect(raw.clientInfo.client_id).toBe("cid");
  });

  it("abandonPendingSignIn exhausts after two consecutive abandonments", () => {
    const provider = new GleanOAuthClientProvider();
    expect(provider.abandonPendingSignIn()).toBe(true);
    expect(provider.abandonPendingSignIn()).toBe(false);
  });

  it("a completed sign-in resets the abandonment budget", () => {
    const provider = new GleanOAuthClientProvider();
    expect(provider.abandonPendingSignIn()).toBe(true);
    provider.saveTokens({ access_token: "tok" } as any);
    // Fresh budget: the next abandonment retries the client again.
    expect(provider.abandonPendingSignIn()).toBe(true);
  });

  it("invalidateCredentials('all') resets the budget for the next registration", async () => {
    const provider = new GleanOAuthClientProvider();
    expect(provider.abandonPendingSignIn()).toBe(true);
    expect(provider.abandonPendingSignIn()).toBe(false);
    await provider.invalidateCredentials("all");
    // A freshly registered client gets a fresh retry budget.
    expect(provider.abandonPendingSignIn()).toBe(true);
  });

  it("resetAuthentication keeps the client for account switching", () => {
    const provider = new GleanOAuthClientProvider();
    provider.saveTokens({ access_token: "tok", refresh_token: "refresh" } as any);
    provider.saveClientInformation({ client_id: "cid" } as any);

    provider.resetAuthentication(
      "new-account@example.com",
      "https://example.com/mcp/gateway/proxy",
    );

    expect(provider.tokens()).toBeUndefined();
    expect(provider.clientInformation()).toEqual({ client_id: "cid" });
    expect(provider.accountEmail()).toBe("new-account@example.com");
    const raw = JSON.parse(fs.readFileSync(credFile, "utf-8"));
    expect(raw.tokens).toBeUndefined();
    expect(raw.clientInfo.client_id).toBe("cid");
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

  it("switches accounts without creating a new DCR client", () => {
    const provider = new GleanOAuthClientProvider();
    provider.saveClientInformation({ client_id: "cid" } as any);
    provider.setAccountContext(
      "Alice@Example.com",
      "https://acme-be.glean.com/mcp/gateway/proxy",
    );
    provider.saveTokens({ access_token: "alice-token" } as any);

    provider.resetAuthentication(
      "Bob@Example.com",
      "https://acme-be.glean.com/mcp/gateway/proxy",
    );

    expect(provider.tokens()).toBeUndefined();
    expect(provider.clientInformation()).toEqual({ client_id: "cid" });
    expect(provider.accountEmail()).toBe("bob@example.com");
    const raw = JSON.parse(fs.readFileSync(credFile, "utf-8"));
    expect(raw.clientInfo.client_id).toBe("cid");
    expect(raw.tokens).toBeUndefined();
    expect(raw.accountEmail).toBe("bob@example.com");
  });

  it("shares the abandoned-sign-in budget across provider instances", () => {
    const first = new GleanOAuthClientProvider();
    first.saveClientInformation({ client_id: "cid" } as any);
    expect(first.abandonPendingSignIn()).toBe(true);

    const second = new GleanOAuthClientProvider();
    expect(second.abandonPendingSignIn()).toBe(false);
  });

  it("immediately escalates when the server explicitly rejects the client", () => {
    const provider = new GleanOAuthClientProvider();
    expect(provider.abandonPendingSignIn(true)).toBe(false);
    const raw = JSON.parse(fs.readFileSync(credFile, "utf-8"));
    expect(raw.abandonedSignIns).toBe(2);
  });
});
