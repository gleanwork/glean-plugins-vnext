import { FEATURE_NAMES, type FeatureName } from "./key.js";
import { pluginVersion } from "../version.js";
import { loadCachedInventory } from "./inventory-cache.js";
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
 * The configured-MCP-server inventory, as captured by the SessionStart hook.
 *
 * Reconstructing it from host configuration files was evaluated and rejected: it means
 * reimplementing host merge semantics -- multiple config scopes, enablement and
 * approval state, plugin installation state, two different `.mcp.json` schemas, and
 * enterprise managed settings -- and every failure in that reimplementation is silent,
 * producing a plausible list with wrong contents rather than an error. That holds for
 * Codex too: it merges plugin-contributed servers with its own config, and no host
 * exposes per-server auth state on disk at all.
 *
 * The accurate source is the host's own CLI, which cannot be called from here -- see
 * ./inventory-cache.ts for why doing so recurses into this plugin. So the hook captures
 * it once per session and this reads the result.
 *
 * `unavailable` is the answer on Cursor, which has no MCP CLI, and on any request that
 * arrives before the capture lands. By contract it says nothing about the user's setup
 * rather than implying an empty list.
 */
export function inventory(): ConfiguredServers {
  return loadCachedInventory();
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
