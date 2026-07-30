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

// Grace window for a sibling's in-flight refresh to land on disk.
const ROTATION_GRACE_MS_DEFAULT = 2000;
const ROTATION_POLL_MS = 100;

function rotationGraceMs(): number {
  const raw = process.env.GLEAN_ROTATION_GRACE_MS;
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return ROTATION_GRACE_MS_DEFAULT;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  // mtime at last read; detects sibling rewrites of the shared store.
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

  // Re-read the shared store after a sibling process rewrites it, so we use
  // the rotated grant instead of a stale in-memory copy.
  private syncTokensFromDisk(): void {
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

  // On invalid_grant, adopt a sibling's newer on-disk token instead of
  // clearing. Returns false when nothing newer exists.
  private adoptNewerTokenFromDisk(): boolean {
    const diskMtime = credentialsMtimeMs();
    if (
      diskMtime === undefined ||
      this._credentialsMtimeMs === undefined ||
      diskMtime <= this._credentialsMtimeMs
    ) {
      return false;
    }
    const stored = loadCredentials();
    const diskTokens = stored?.tokens as OAuthTokens | undefined;
    if (
      !diskTokens?.access_token ||
      diskTokens.access_token === this._tokens?.access_token
    ) {
      return false;
    }
    this._tokens = diskTokens;
    this._credentialsMtimeMs = diskMtime;
    if (stored?.clientInfo) {
      this._clientInfo = stored.clientInfo as OAuthClientInformationMixed;
    }
    console.error(
      "[auth] invalid_grant, but a newer token is on disk " +
        "(sibling refresh) — adopting it instead of clearing",
    );
    return true;
  }

  // Poll briefly for the race winner's write before clearing. Skipped when
  // no refresh token was held (no race possible).
  private async adoptNewerTokenWithGrace(): Promise<boolean> {
    if (this.adoptNewerTokenFromDisk()) return true;
    if (!this._tokens?.refresh_token) return false;
    const deadline = Date.now() + rotationGraceMs();
    while (Date.now() < deadline) {
      await sleep(ROTATION_POLL_MS);
      if (this.adoptNewerTokenFromDisk()) return true;
    }
    return false;
  }

  // Grace-bounded wait for a sibling's refresh; covers failures the SDK does
  // not route through invalidateCredentials (e.g. invalid_request collisions).
  async waitForSiblingRefresh(
    previousAccessToken: string | undefined,
  ): Promise<boolean> {
    const deadline = Date.now() + rotationGraceMs();
    for (;;) {
      const current = this.tokens()?.access_token;
      if (current && current !== previousAccessToken) return true;
      if (Date.now() >= deadline) return false;
      await sleep(ROTATION_POLL_MS);
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
    this.syncTokensFromDisk();
    return this._tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this._tokens = tokens;
    this._authUrlPending = false;
    saveCredentials(this._tokens, this._clientInfo);
    // Own write must not look like a sibling change.
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
        // Usually a sibling's rotation — try adopting before clearing.
        if (await this.adoptNewerTokenWithGrace()) return;
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
