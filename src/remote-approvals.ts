import { loadServerUrl } from "./url-config-store.js";
import { loadCredentials } from "./token-store.js";
import { GRANTED, settingKey } from "./approval-keys.js";

// Remote "always allow" store: reads/writes tool approvals to Glean's per-user
// settings via the same REST surface Glean uses everywhere (POST
// /api/v1/{list,save}usersettings). Gated behind GLEAN_REMOTE_TOOL_APPROVALS in
// tool-permissions-store.ts; this module is a thin, best-effort transport.
//
// SCOPE CAVEAT: these endpoints require the `internal:web_api` OAuth scope,
// which a dynamically-registered MCP client does not hold today, so calls will
// 401/403 until that scope (or an MCP-gateway settings surface) is granted.
// Every function here is therefore BEST-EFFORT and NEVER throws — the store
// falls back to the local file on failure.

// One entry in Glean's UserSettings wire shape.
interface Setting {
  key?: string;
  value?: string;
}
interface UserSettings {
  settings?: Setting[];
}

// The Glean instance REST base (same origin as the MCP gateway), mirroring
// resolveServerUrl() in index.ts: env override first, else the stored URL.
function settingsBaseUrl(): string | undefined {
  const raw = process.env.GLEAN_MCP_SERVER_URL || loadServerUrl();
  if (!raw) return undefined;
  try {
    return `${new URL(raw).origin}/api/v1`;
  } catch {
    return undefined;
  }
}

function bearerToken(): string | undefined {
  const tokens = loadCredentials()?.tokens as
    | { access_token?: string }
    | undefined;
  const token = tokens?.access_token;
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

function authedHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

// Whether `toolName` is approved in Glean. Returns null on ANY failure (no
// URL/token, network error, non-200, bad JSON) so the caller can fall back to
// the local store. Never throws.
export async function remoteIsToolApproved(
  toolName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean | null> {
  const base = settingsBaseUrl();
  const token = bearerToken();
  if (!base || !token) return null;
  try {
    const resp = await fetchImpl(`${base}/listusersettings`, {
      method: "POST",
      headers: authedHeaders(token),
      body: "{}",
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as UserSettings;
    const settings = Array.isArray(data?.settings) ? data.settings : [];
    const want = settingKey(toolName);
    return settings.some((s) => s?.key === want && s?.value === GRANTED);
  } catch {
    return null;
  }
}

// Upserts an "always allow" grant for `toolName` to Glean (partial upsert of the
// single key). Returns true on success, false on any failure. Never throws.
export async function remoteSetToolApproved(
  toolName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const base = settingsBaseUrl();
  const token = bearerToken();
  if (!base || !token) return false;
  try {
    const resp = await fetchImpl(`${base}/saveusersettings`, {
      method: "POST",
      headers: authedHeaders(token),
      body: JSON.stringify({
        settings: [{ key: settingKey(toolName), value: GRANTED }],
      }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}
