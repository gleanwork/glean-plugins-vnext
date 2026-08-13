import { describe, it, expect, vi, beforeEach } from "vitest";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";

// Control client.connect() across (re)tries.
const { connectMock } = vi.hoisted(() => ({ connectMock: vi.fn() }));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect(...args: unknown[]) {
      return connectMock(...args);
    }
  },
}));

// Keep buildTransport cheap and side-effect free.
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor() {}
    async close() {}
  },
}));

const { createRemoteClient, AuthRequiredError } = await import(
  "../src/remote-client.js"
);

/**
 * Minimal OAuthClientProvider stand-in. tokens() returns the next value in
 * `seq` on each call, mirroring how the real provider re-reads disk: the
 * pre-connect snapshot, then the value after a sibling may have rewritten it.
 */
function makeProvider(seq: Array<{ access_token?: string } | undefined>) {
  let i = 0;
  return {
    tokens() {
      const t = seq[Math.min(i, seq.length - 1)];
      i += 1;
      return t;
    },
    authorizationUrl: "https://example.com/oauth/authorize?state=s1",
    pendingAuthCode: undefined,
    needsFreshClient: () => false,
  } as any;
}

describe("createRemoteClient sibling-refresh retry", () => {
  beforeEach(() => {
    connectMock.mockReset();
  });

  it("retries once and succeeds when a newer token appears on disk", async () => {
    connectMock
      .mockRejectedValueOnce(new UnauthorizedError("401"))
      .mockResolvedValueOnce(undefined);

    // pre-connect snapshot T0, post-failure re-read T1 (rotated), retry snapshot T1.
    const provider = makeProvider([
      { access_token: "T0" },
      { access_token: "T1" },
      { access_token: "T1" },
    ]);

    const client = await createRemoteClient(
      "https://acme-be.glean.com/mcp/gateway/proxy",
      { authProvider: provider },
      "sess-1",
    );

    expect(client).toBeTruthy();
    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry when the on-disk token is unchanged", async () => {
    connectMock.mockRejectedValue(new UnauthorizedError("401"));

    const provider = makeProvider([
      { access_token: "T0" },
      { access_token: "T0" },
    ]);

    await expect(
      createRemoteClient(
        "https://acme-be.glean.com/mcp/gateway/proxy",
        { authProvider: provider },
        "sess-2",
      ),
    ).rejects.toBeInstanceOf(AuthRequiredError);

    expect(connectMock).toHaveBeenCalledTimes(1);
  });
});

describe("createRemoteClient abandoned sign-in client reuse", () => {
  beforeEach(() => {
    connectMock.mockReset();
  });

  function makeAbandonedProvider(budgetLeft: boolean) {
    return {
      tokens: () => ({ access_token: "T0" }),
      authorizationUrl: undefined,
      pendingAuthCode: undefined,
      needsFreshClient: () => true,
      abandonPendingSignIn: vi.fn(() => budgetLeft),
      invalidateCredentials: vi.fn(),
    } as any;
  }

  it("reuses the existing client on the first abandoned sign-in", async () => {
    connectMock.mockResolvedValueOnce(undefined);
    const provider = makeAbandonedProvider(true);

    await createRemoteClient(
      "https://acme-be.glean.com/mcp/gateway/proxy",
      { authProvider: provider },
      "sess-3",
    );

    expect(provider.abandonPendingSignIn).toHaveBeenCalledTimes(1);
    // The registration survives — no wipe, no fresh DCR.
    expect(provider.invalidateCredentials).not.toHaveBeenCalled();
  });

  it("falls back to a fresh DCR once the retry budget is exhausted", async () => {
    connectMock.mockResolvedValueOnce(undefined);
    const provider = makeAbandonedProvider(false);

    await createRemoteClient(
      "https://acme-be.glean.com/mcp/gateway/proxy",
      { authProvider: provider },
      "sess-4",
    );

    expect(provider.invalidateCredentials).toHaveBeenCalledWith("all");
  });
});

describe("createRemoteClient same-process registration gate", () => {
  beforeEach(() => {
    connectMock.mockReset();
  });

  it("allows only one concurrent first-time DCR registration", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let registrationCount = 0;
    const provider: any = {
      clientInfo: undefined,
      tokens: () => ({ access_token: "T0" }),
      authorizationUrl: undefined,
      pendingAuthCode: undefined,
      needsFreshClient: () => false,
      clientInformation() {
        return this.clientInfo;
      },
      saveClientInformation(info: unknown) {
        this.clientInfo = info;
        registrationCount += 1;
      },
    };

    connectMock.mockImplementation(async () => {
      if (registrationCount === 0) {
        await gate;
        provider.saveClientInformation({ client_id: "cid" });
      }
    });

    const first = createRemoteClient(
      "https://acme-be.glean.com/mcp/gateway/proxy",
      { authProvider: provider },
      "same-process-1",
    );
    // Let the first call enter its async connect and publish the pending gate.
    await Promise.resolve();
    const second = createRemoteClient(
      "https://acme-be.glean.com/mcp/gateway/proxy",
      { authProvider: provider },
      "same-process-2",
    );
    await Promise.resolve();
    release();

    await Promise.all([first, second]);
    expect(registrationCount).toBe(1);
    expect(connectMock).toHaveBeenCalledTimes(2);
  });
});

describe("createRemoteClient refresh-collision retry", () => {
  beforeEach(() => {
    connectMock.mockReset();
  });

  // Fosite fails concurrent-refresh losers with invalid_request (SDK rethrows raw).
  const collisionError = new Error(
    "The request is missing a required parameter, includes an invalid " +
      "parameter value, includes a parameter more than once, or is " +
      "otherwise malformed. Failed to refresh token",
  );

  function makeCollisionProvider(siblingRefreshed: boolean) {
    return {
      tokens: () => ({ access_token: "T0" }),
      authorizationUrl: undefined,
      pendingAuthCode: undefined,
      needsFreshClient: () => false,
      waitForSiblingRefresh: vi.fn(async () => siblingRefreshed),
      invalidateCredentials: vi.fn(),
    } as any;
  }

  it("retries once when a sibling's refresh lands during the grace wait", async () => {
    connectMock
      .mockRejectedValueOnce(collisionError)
      .mockResolvedValueOnce(undefined);
    const provider = makeCollisionProvider(true /*siblingRefreshed*/);

    const client = await createRemoteClient(
      "https://acme-be.glean.com/mcp/gateway/proxy",
      { authProvider: provider },
      "sess-5",
    );

    expect(client).toBeTruthy();
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(provider.waitForSiblingRefresh).toHaveBeenCalledWith("T0");
  });

  it("rethrows when no sibling token appears within the grace window", async () => {
    connectMock.mockRejectedValue(collisionError);
    const provider = makeCollisionProvider(false /*siblingRefreshed*/);

    await expect(
      createRemoteClient(
        "https://acme-be.glean.com/mcp/gateway/proxy",
        { authProvider: provider },
        "sess-6",
      ),
    ).rejects.toBe(collisionError);

    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it("does not treat unrelated connect errors as refresh failures", async () => {
    connectMock.mockRejectedValue(new Error("socket hang up"));
    const provider = makeCollisionProvider(true /*siblingRefreshed*/);

    await expect(
      createRemoteClient(
        "https://acme-be.glean.com/mcp/gateway/proxy",
        { authProvider: provider },
        "sess-7",
      ),
    ).rejects.toThrow("socket hang up");

    expect(provider.waitForSiblingRefresh).not.toHaveBeenCalled();
  });
});
