import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { execFile, spawn } from "node:child_process";
import { platform } from "node:os";
import { getCallbackUrl, setExpectedState } from "./auth-callback-server.js";
import {
  clearCredentials,
  credentialsMtimeMs,
  loadCredentials,
  saveCredentials,
} from "./token-store.js";

export type InvalidationScope = "all" | "client" | "tokens" | "verifier";

/**
 * Open `url` in the user's default browser. Used for the self-open sign-in
 * path when the client does not support URL-mode elicitation (where the client
 * itself opens the URL after consent).
 */
export function openBrowser(url: string): void {
  if (platform() === "win32") {
    // Open via `cmd /c start`, which routes through ShellExecute -> the default
    // browser. The catch: cmd.exe treats a bare `&` as a command separator, so
    // the OAuth authorize URL would be truncated at the first `&` -- dropping
    // client_id and everything after it, which the server rejects as
    // invalid_client. We escape every `&` as `^&` and pass the args verbatim
    // (windowsVerbatimArguments) so Node doesn't re-wrap them in quotes, inside
    // which cmd stops honoring the `^` escape. cmd then un-escapes `^&` back to
    // a literal `&`, so the browser receives the full URL intact. The empty
    // `""` is start's window-title arg; `/b` avoids spawning a console window.
    spawn("cmd", ["/c", "start", '""', "/b", url.replace(/&/g, "^&")], {
      detached: true,
      stdio: "ignore",
      windowsVerbatimArguments: true,
    }).unref();
  } else {
    const cmd = platform() === "darwin" ? "open" : "xdg-open";
    execFile(cmd, [url]);
  }
}

export class GleanOAuthClientProvider implements OAuthClientProvider {
  private _clientInfo: OAuthClientInformationMixed | undefined;
  private _tokens: OAuthTokens | undefined;
  private _codeVerifier = "";
  private _pendingAuthCode: string | undefined;
  // True between issuing an authorize URL and either receiving tokens or
  // explicitly invalidating. Used to detect when a previous auth URL didn't
  // complete — likely because the server rejected the (stale) client_id.
  private _authUrlPending = false;
  // mtime (epoch ms) of the credentials file at the point our in-memory
  // _tokens/_clientInfo snapshot was last taken from disk. Undefined until the
  // first successful read. Used to detect sibling rewrites — see syncFromDisk.
  private _credentialsMtimeMs: number | undefined;

  authorizationUrl: string | undefined;

  /**
   * Optional hook invoked whenever the in-memory token state changes —
   * either tokens were saved (auth completed) or invalidated (logout /
   * refresh failure). Used by the plugin to push a tools/list_changed
   * notification so the host re-fetches the dynamic tool surface.
   */
  onTokensChanged?: (tokens: OAuthTokens | undefined) => void;

  constructor() {
    const stored = loadCredentials();
    if (stored) {
      this._tokens = stored.tokens as OAuthTokens | undefined;
      this._clientInfo = stored.clientInfo as OAuthClientInformationMixed | undefined;
    }
    this._credentialsMtimeMs = credentialsMtimeMs();
  }

  // Re-read the credentials file if it has changed on disk since we last read
  // it. MCP servers are spawned per session, so several of our processes can be
  // alive at once sharing one credentials file. When one process refreshes an
  // (Ory-rotated, single-use) refresh token, it persists the new grant and
  // silently invalidates the old refresh token that every other process still
  // holds in memory. Without this, the next process to hit a 401 would refresh
  // with its now-dead token, get invalid_grant, and force a full re-auth
  // ([SETUP_REQUIRED]). Syncing here — right before the SDK reads tokens() at
  // the start of its auth flow — lets us pick up the sibling's fresh grant
  // instead. Guarded by mtime so the steady state is one stat(), not a re-parse.
  //
  // Conservative on removal: if the file is gone (undefined mtime) or has no
  // tokens, we keep our in-memory snapshot rather than logging ourselves out —
  // a transient stat failure or another process's explicit logout shouldn't
  // drop a token that still works for us; a genuinely revoked token self-heals
  // through the normal 401 path.
  private syncFromDisk(): void {
    const mtimeMs = credentialsMtimeMs();
    if (mtimeMs === undefined) return;
    if (
      this._credentialsMtimeMs !== undefined &&
      mtimeMs <= this._credentialsMtimeMs
    ) {
      return;
    }
    const stored = loadCredentials();
    this._credentialsMtimeMs = mtimeMs;
    if (!stored) return;
    if (stored.tokens) {
      this._tokens = stored.tokens as OAuthTokens;
    }
    if (stored.clientInfo) {
      this._clientInfo = stored.clientInfo as OAuthClientInformationMixed;
    }
  }

  get redirectUrl(): string {
    return getCallbackUrl();
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [getCallbackUrl()],
      client_name: "Glean Claude Code Plugin",
    };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this._clientInfo;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this._clientInfo = info;
    saveCredentials(this._tokens, this._clientInfo);
    this._credentialsMtimeMs = credentialsMtimeMs();
  }

  tokens(): OAuthTokens | undefined {
    this.syncFromDisk();
    return this._tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this._tokens = tokens;
    this._authUrlPending = false;
    saveCredentials(this._tokens, this._clientInfo);
    // Record the mtime of the file we just wrote so our own write doesn't look
    // like a sibling change on the next syncFromDisk.
    this._credentialsMtimeMs = credentialsMtimeMs();
    this.onTokensChanged?.(tokens);
  }

  async invalidateCredentials(scope: InvalidationScope): Promise<void> {
    console.error(`[auth] Invalidating credentials: scope=${scope}`);
    const tokensClearedBefore = this._tokens === undefined;
    switch (scope) {
      case "all":
        this._tokens = undefined;
        this._clientInfo = undefined;
        this._codeVerifier = "";
        this._authUrlPending = false;
        clearCredentials();
        break;
      case "client":
        this._clientInfo = undefined;
        saveCredentials(this._tokens, undefined);
        break;
      case "tokens":
        this._tokens = undefined;
        saveCredentials(undefined, this._clientInfo);
        break;
      case "verifier":
        this._codeVerifier = "";
        break;
    }
    if (
      (scope === "all" || scope === "tokens") &&
      !tokensClearedBefore
    ) {
      this.onTokensChanged?.(undefined);
    }
  }

  // True if we previously issued an authorize URL but never received tokens —
  // implying the URL was likely rejected by the server (e.g. stale client_id).
  needsFreshClient(): boolean {
    return (
      this._authUrlPending &&
      !this._tokens?.access_token &&
      this._pendingAuthCode === undefined
    );
  }

  get pendingAuthCode(): string | undefined {
    return this._pendingAuthCode;
  }

  setPendingAuthCode(code: string): void {
    this._pendingAuthCode = code;
  }

  clearPendingAuth(): void {
    this._pendingAuthCode = undefined;
    this.authorizationUrl = undefined;
  }

  // Called by the SDK when a 401 kicks off the OAuth flow. We do NOT open a
  // browser or redirect here — the setup orchestrator owns presenting the
  // sign-in URL (URL-mode elicitation, or self-open as a fallback) and awaiting
  // the loopback callback. All this does is record the authorize URL (which
  // propagates out as AuthRequiredError) and hand the loopback server the
  // `state` value to validate the redirect against.
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.authorizationUrl = authorizationUrl.toString();
    this._authUrlPending = true;
    setExpectedState(authorizationUrl.searchParams.get("state") ?? undefined);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this._codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    return this._codeVerifier;
  }

  async validateResourceURL(_serverUrl: string | URL, resource?: string): Promise<URL | undefined> {
    if (resource) {
      return new URL(resource);
    }
    return undefined;
  }
}
