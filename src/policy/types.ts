import type { FeatureName } from "./key.js";

// ---------------------------------------------------------------- request side

// VersionSource is defined alongside the build constant it describes, in
// ../version.ts. Imported for local use and re-exported so the payload types read
// as one unit.
import type { VersionSource } from "../version.js";
export type { VersionSource };

// Where host identity came from. `handshake` is the MCP initialize exchange,
// which is the reliable path and needs no host-specific code.
export type HostSource = "handshake" | "env" | "unknown";

// The inventory is all-or-nothing on purpose. A partial list is worse than none
// for policy, because it is indistinguishable from a user who genuinely has
// fewer servers.
export type InventorySource = "host-cli" | "unavailable";

export type AuthStatus = "authenticated" | "unauthenticated" | "unknown";

export interface ConfiguredServer {
  name: string;
  url?: string;
  authStatus: AuthStatus;
}

export interface ConfiguredServers {
  source: InventorySource;
  servers?: ConfiguredServer[];
}

/** The host block of the request, as observed from the MCP handshake. */
export interface HostIdentity {
  id: string;
  version?: string;
  /**
   * The MCP revision the plugin and host settled on for this session -- the value
   * from the initialize RESULT, not what the host proposed. Omitted rather than
   * guessed when it could not be observed; see protocol-version.ts.
   */
  mcpProtocolVersion?: string;
  capabilities?: Record<string, unknown>;
  source: HostSource;
}

export interface NegotiationRequest {
  // supportedFeatures lives HERE, not at the top level: the features a build
  // implements are a property of that build, fixed at compile time and changing
  // only when a new version ships -- exactly like `version` beside it. The
  // response's `features` map stays top level because it is a per-session policy
  // decision, not plugin metadata; the two are not peers despite the similar name.
  plugin: {
    id: string;
    version: string;
    versionSource: VersionSource;
    supportedFeatures: Record<FeatureName, boolean>;
  };
  host: HostIdentity;
  configuredServers: ConfiguredServers;
}

// --------------------------------------------------------------- response side

export interface UpgradeRecommendation {
  show?: boolean;
  dailyCap?: number;
  weeklyCap?: number;
}

// Plugin-scoped rules are grouped under `plugin`; session-scoped policy stays at
// the top level. Version rules and upgrade guidance describe the installed
// artifact and change only when a release changes, whereas `features` and
// `message` are decisions about this session that can differ between two calls
// from the same build. The grouping is also what removes the `Plugin` prefix these
// names used to carry to compensate for having no namespace, and it leaves a slot
// for the deferred host-version rules as a `host` sibling.
export interface PluginPolicy {
  latestVersion?: string;
  minimumSupportedVersion?: string;
  blockedVersions?: string[];
  upgradeRecommendation?: UpgradeRecommendation;
}

export interface PolicyResponse {
  plugin?: PluginPolicy;
  features?: Partial<Record<FeatureName, { enabled?: boolean }>>;
  message?: string;
}

// ------------------------------------------------------------------- outcomes

// Classification of a single negotiation round-trip. These four are genuinely
// different and conflating any two of them breaks the contract:
//
//   policy       - a valid policy object came back; persist and apply it.
//   no-policy    - the request SUCCEEDED but carried no policy object. The
//                  remote does not implement negotiation yet. All supported
//                  features are enabled and NO version policy applies. Must not
//                  erase the cache.
//   malformed    - a policy object came back but failed validation. Keep the
//                  last valid policy and treat this round as no-policy; garbage
//                  must never be able to deactivate a working plugin.
//   unreachable  - the request failed. Fall back to the CACHED policy and
//                  cached tools list, which is different from no-policy: here a
//                  previously synced version rule still applies.
export type NegotiationOutcome =
  | { kind: "policy"; policy: PolicyResponse; unknownKeys: string[] }
  | { kind: "no-policy" }
  | { kind: "malformed"; reason: string }
  | { kind: "unreachable"; reason: string };

// ------------------------------------------------------------------- decision

export type VersionState =
  | "ok"
  | "outdated-supported"
  | "below-minimum"
  | "blocked"
  | "unenforced";

export interface Decision {
  /** Deactivated plugins advertise ONLY the setup tool. */
  deactivated: boolean;
  versionState: VersionState;
  features: Record<FeatureName, boolean>;
  /** True when an upgrade recommendation should be surfaced this session. */
  showUpgrade: boolean;
  message?: string;
  /** Human-readable trail of why this decision came out the way it did. */
  reasons: string[];
}
