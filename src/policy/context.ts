import { FEATURE_NAMES, type FeatureName } from "./key.js";
import { pluginVersion } from "../version.js";
import type {
  ConfiguredServers,
  HostIdentity,
  NegotiationRequest,
} from "./types.js";

/**
 * Host identity from the MCP `initialize` handshake -- clientInfo, declared
 * capabilities, and the negotiated protocol revision.
 *
 * This is the reliable path and needs no host-specific code: no host is known to
 * expose its own version through an environment variable, and no hook payload carries
 * one either, so the handshake is the only place this information exists.
 */
export function hostIdentityFromHandshake(
  clientInfo: { name?: string; version?: string } | undefined,
  capabilities: Record<string, unknown> | undefined,
  mcpProtocolVersion?: string,
): HostIdentity {
  if (!clientInfo?.name) {
    // Report the revision even when clientInfo is unusable: it is the field most
    // worth having when diagnosing a host we cannot otherwise identify.
    return { id: "unknown", mcpProtocolVersion, source: "unknown" };
  }
  return {
    id: clientInfo.name,
    version: clientInfo.version,
    mcpProtocolVersion,
    capabilities,
    source: "handshake",
  };
}

/**
 * The configured-MCP-server inventory. Not reported yet.
 *
 * Reconstructing it from host configuration files was evaluated and rejected: it means
 * reimplementing host merge semantics -- multiple config scopes, enablement and
 * approval state, plugin installation state, two different `.mcp.json` schemas, and
 * enterprise managed settings -- and every failure in that reimplementation is silent,
 * producing a plausible list with wrong contents rather than an error.
 *
 * The accurate source is the host's own CLI (`claude mcp list`, `codex mcp list
 * --json`), which is deferred because it cannot be called from this path: those
 * commands health-check every server by spawning it, including this one, so invoking
 * them during `tools/list` would make the plugin recursively launch itself. It needs a
 * SessionStart hook that runs once per session and caches the result.
 *
 * Until then the field reports `unavailable`, which by contract says nothing about the
 * user's setup rather than implying an empty list.
 */
export function inventory(): ConfiguredServers {
  return { source: "unavailable" };
}

/** The features this build implements. Static: it changes only when a release does. */
export function supportedFeatures(): Record<FeatureName, boolean> {
  return Object.fromEntries(FEATURE_NAMES.map((f) => [f, true])) as Record<
    FeatureName,
    boolean
  >;
}

export function buildNegotiationRequest(host: HostIdentity): NegotiationRequest {
  const { version, source } = pluginVersion();
  return {
    plugin: {
      id: "glean",
      version,
      versionSource: source,
      supportedFeatures: supportedFeatures(),
    },
    host,
    configuredServers: inventory(),
  };
}
