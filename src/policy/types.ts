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

/**
 * Why no inventory was obtained. Sent so the remote can tell an expected absence from a
 * broken one -- without it, a fleet reporting 60% `unavailable` cannot be read at all.
 *
 * Deliberately COARSE. There are far more internal failure branches than these, and
 * mirroring them here would freeze the implementation's shape into the wire contract; the
 * local log carries the fine-grained detail instead. Deliberately a CLOSED SET, never
 * free text: a reason carrying an exec error would ship an absolute binary path, which on
 * a normal install contains the user's name.
 *
 * There is no `host-unsupported`. On a host with no MCP CLI the hook never runs at all,
 * so nothing is there to write a marker, and `host.id` already identifies the host -- the
 * remote joins the two itself. Encoding the mapping here would put host-specific
 * knowledge in a plugin that otherwise has none.
 */
export type InventoryUnavailableReason =
  /** No capture on disk. The ordinary state of a session's first tools/list, since
   *  SessionStart hooks fire before servers finish connecting -- and the permanent state
   *  on a host that runs no hooks. */
  | "capture-pending"
  /** The host CLI could not be located, could not be run, or timed out. */
  | "cli-unavailable"
  /** The CLI ran and its output could not be used, so it was discarded whole. Covers a
   *  parse failure and a well-formed response of an unexpected shape alike: which of the
   *  two it was matters to us and not to the remote, so the distinction lives in the log
   *  rather than in this name. */
  | "cli-output-invalid"
  /** A capture exists but failed validation. Unlike `cli-output-invalid` the bad data is
   *  OURS, not the host's -- version skew between the hook and this build, corruption, or
   *  something else writing to the path -- so the fix is different in kind. */
  | "capture-invalid";

export type AuthStatus = "authenticated" | "unauthenticated" | "unknown";

export interface ConfiguredServer {
  name: string;
  url?: string;
  authStatus: AuthStatus;
}

export interface ConfiguredServers {
  source: InventorySource;
  servers?: ConfiguredServer[];
  /**
   * How many servers were found but withheld by the Glean-only filter.
   *
   * Reported as a bare count because the excluded entries are exactly the ones that
   * must not be named -- a third party's server name or hostname is the disclosure the
   * filter exists to prevent. The count still tells the remote that filtering happened,
   * which is the difference between "this user has one Glean server" and "we could only
   * confirm one of the servers this user has".
   */
  withheld?: number;
  /** Present only when `source` is `unavailable`. */
  reason?: InventoryUnavailableReason;
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
  /**
   * Text shown with a recommendation, and also the text used when version policy
   * deactivates the plugin -- the remedy is an upgrade either way.
   *
   * The remote owns the wording, including whether to name a version. Nothing here
   * interpolates `latestVersion` into it: a plugin that composed its own sentence would
   * be second-guessing a message the remote wrote for its own users.
   */
  message?: string;
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
  /**
   * The remote's upgrade text, carried separately from `message` because they answer
   * different questions: `message` is about this session, this is about the installed
   * artifact. Used for the recommendation and for the deactivation refusal.
   */
  upgradeMessage?: string;
  /** Human-readable trail of why this decision came out the way it did. */
  reasons: string[];
}
