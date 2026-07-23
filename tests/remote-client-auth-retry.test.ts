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
