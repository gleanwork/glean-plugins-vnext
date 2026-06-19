import http from "node:http";
import type { AddressInfo } from "node:net";

// OAuth redirect target. We bind a FIXED loopback port and register this exact
// URL via DCR. Glean exact-matches the redirect_uri against the registered
// client (it does NOT wildcard the loopback port), so the port must stay
// stable across runs — an ephemeral port would drift and fail to match.
// Running in-context means the browser reaches this server directly, which is
// what lets us drop the old paste-back flow.
const CALLBACK_PATH = "/glean-cli-callback";

// Fixed loopback port for the OAuth redirect. Overridable via
// GLEAN_CALLBACK_PORT for environments where 29107 is already taken; the port
// is registered via DCR, so any stable value works.
function callbackPort(): number {
  const raw = process.env.GLEAN_CALLBACK_PORT;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : 29107;
}

export function getCallbackUrl(): string {
  return `http://127.0.0.1:${callbackPort()}${CALLBACK_PATH}`;
}

export interface CallbackHandle {
  /** Redirect URI the browser will land on. */
  url: string;
  /** Resolves with the authorization `code` once the browser redirect lands. */
  code: Promise<string>;
}

interface ActiveServer {
  server: http.Server;
  handle: CallbackHandle;
}

let active: ActiveServer | undefined;

// Set by the OAuth provider once the authorize URL (and its `state`) is known,
// just before the browser opens. Validated against the redirect to guard
// against CSRF. Reset on close.
let expectedState: string | undefined;

export function setExpectedState(state: string | undefined): void {
  expectedState = state;
}

/**
 * Bind a loopback HTTP server on an ephemeral port and return its concrete URL
 * plus a promise that resolves with the OAuth `code`. Idempotent within a flow:
 * repeated calls return the same handle until closeCallbackServer() is called.
 */
export function startCallbackServer(): Promise<CallbackHandle> {
  if (active) return Promise.resolve(active.handle);

  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    if (reqUrl.pathname !== CALLBACK_PATH) {
      res.writeHead(404);
      res.end();
      return;
    }

    if (expectedState !== undefined) {
      const returnedState = reqUrl.searchParams.get("state");
      if (returnedState !== expectedState) {
        res.writeHead(403, { "Content-Type": "text/html" });
        res.end(
          "<html><body><h1>Error</h1><p>Invalid OAuth state parameter.</p></body></html>",
        );
        rejectCode(new Error("OAuth state mismatch — possible CSRF attack"));
        return;
      }
    }

    const codeParam = reqUrl.searchParams.get("code");
    if (!codeParam) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(
        "<html><body><h1>Error</h1><p>No authorization code received.</p></body></html>",
      );
      rejectCode(new Error("no authorization code in OAuth callback"));
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      "<html><body><h1>Authentication successful</h1><p>You can close this tab.</p></body></html>",
    );
    resolveCode(codeParam);
  });

  return new Promise<CallbackHandle>((resolve, reject) => {
    // Bind errors (e.g. EADDRINUSE — the fixed port is already taken) reject
    // the start; later runtime errors surface on the `code` promise instead.
    server.once("error", reject);
    server.listen(callbackPort(), "127.0.0.1", () => {
      server.removeListener("error", reject);
      server.on("error", (err) => rejectCode(err));
      // Reflect the actually-bound port. Equals callbackPort() for the fixed
      // production port; differs only when port 0 is configured (tests).
      const { port } = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
      const handle: CallbackHandle = { url, code };
      active = { server, handle };
      console.error(`[auth] Callback server listening on ${url}`);
      resolve(handle);
    });
  });
}

export function closeCallbackServer(): void {
  if (active) {
    active.server.close();
    active.server.closeAllConnections?.();
    active = undefined;
  }
  expectedState = undefined;
}
