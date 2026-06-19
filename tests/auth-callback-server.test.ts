import { describe, it, expect, afterEach } from "vitest";
import {
  startCallbackServer,
  closeCallbackServer,
  setExpectedState,
} from "../src/auth-callback-server.js";

// Use an ephemeral port in tests so the suite never collides with a
// locally-running Glean plugin (which binds the default 29107). The handle
// reports the actually-bound port, which is what the tests fetch against.
process.env.GLEAN_CALLBACK_PORT = "0";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Tests share a fixed loopback port, so they run sequentially and wait briefly
// for the port to be released between cases.
afterEach(async () => {
  closeCallbackServer();
  setExpectedState(undefined);
  await sleep(50);
});

describe("auth-callback-server", () => {
  it("binds a loopback callback URL at /glean-cli-callback", async () => {
    const { url } = await startCallbackServer();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/glean-cli-callback$/);
  });

  it("resolves with the authorization code", async () => {
    const { url, code } = await startCallbackServer();
    const res = await fetch(`${url}?code=abc123`);

    expect(res.status).toBe(200);
    expect(await code).toBe("abc123");
  });

  it("rejects when code is missing", async () => {
    const { url, code } = await startCallbackServer();
    code.catch(() => {});
    const res = await fetch(url);

    expect(res.status).toBe(400);
    await expect(code).rejects.toThrow("no authorization code");
  });

  it("accepts callback when state matches", async () => {
    setExpectedState("expected-state");
    const { url, code } = await startCallbackServer();
    const res = await fetch(`${url}?code=abc&state=expected-state`);

    expect(res.status).toBe(200);
    expect(await code).toBe("abc");
  });

  it("rejects callback when state does not match", async () => {
    setExpectedState("expected-state");
    const { url, code } = await startCallbackServer();
    code.catch(() => {});
    const res = await fetch(`${url}?code=abc&state=wrong-state`);

    expect(res.status).toBe(403);
    await expect(code).rejects.toThrow("state mismatch");
  });

  it("skips state validation when no expected state is set", async () => {
    const { url, code } = await startCallbackServer();
    const res = await fetch(`${url}?code=abc&state=any-state`);

    expect(res.status).toBe(200);
    expect(await code).toBe("abc");
  });

  it("returns 404 for non-callback paths", async () => {
    const { url, code } = await startCallbackServer();
    const base = url.replace("/glean-cli-callback", "");
    const res = await fetch(`${base}/other`);

    expect(res.status).toBe(404);

    // Clean up: a valid request resolves the code promise.
    await fetch(`${url}?code=cleanup`);
    await code;
  });

  it("is idempotent within a flow: repeated start returns the same handle", async () => {
    const first = await startCallbackServer();
    const second = await startCallbackServer();
    expect(second.url).toBe(first.url);
  });
});
