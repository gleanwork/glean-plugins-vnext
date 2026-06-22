const CONFIG_SEARCH_URL = "https://app.glean.com/config/search";

// Shape of the deployment config returned by the config/search endpoint.
interface DeploymentConfig {
  queryURL?: string;
  centralURL?: string;
  isMultiTenant?: boolean;
}

interface ConfigSearchResponse {
  search_config?: DeploymentConfig;
}

export type ResolveResult =
  | { ok: true; queryUrl: string }
  | { ok: false; error: string };

const emailPattern = /^[^@\s]+@([^@\s]+\.[^@\s]+)$/;

export async function resolveServerUrlFromEmail(
  email: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolveResult> {
  const trimmed = email.trim();
  const match = emailPattern.exec(trimmed);
  if (!match) {
    return { ok: false, error: `"${email}" is not a valid email address.` };
  }
  const emailDomain = match[1].toLowerCase();

  let resp: Response;
  try {
    resp = await fetchImpl(CONFIG_SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ email: trimmed, emailDomain, isGleanApp: true }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Could not reach Glean to look up your instance: ${msg}`,
    };
  }

  if (!resp.ok) {
    return {
      ok: false,
      error: `Glean instance lookup failed (HTTP ${resp.status}).`,
    };
  }

  let data: ConfigSearchResponse;
  try {
    data = (await resp.json()) as ConfigSearchResponse;
  } catch {
    return {
      ok: false,
      error: "Glean instance lookup returned an unexpected response.",
    };
  }

  const cfg = data.search_config;
  const queryUrl = cfg?.queryURL;

  // No usable instance if there's no queryURL, or the endpoint returned the
  // shared central URL for an unknown domain or typo in email
  if (
    !queryUrl ||
    (cfg?.centralURL &&
      cfg.isMultiTenant !== true &&
      sameOrigin(queryUrl, cfg.centralURL))
  ) {
    return {
      ok: false,
      error: `No Glean instance is registered for "${emailDomain}".`,
    };
  }

  return { ok: true, queryUrl };
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}
