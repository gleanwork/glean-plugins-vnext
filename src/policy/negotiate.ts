import { CAPABILITY_POLICY_KEY, FEATURE_NAMES } from "./key.js";
import type {
  NegotiationOutcome,
  NegotiationRequest,
  PolicyResponse,
} from "./types.js";

/**
 * Wrap the negotiation payload in the `_meta` envelope carried on every outgoing
 * request. Verified against MCP SDK 1.12 over StreamableHTTP: `_meta` on
 * `tools/list` and `tools/call` params reaches the server, and `result._meta`
 * survives Zod parsing on the way back, with nested objects intact.
 */
export function metaFor(request: NegotiationRequest): {
  _meta: Record<string, unknown>;
} {
  return { _meta: { [CAPABILITY_POLICY_KEY]: request } };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Keys this version understands, by object. Anything outside these sets is still
// ACCEPTED -- forward compatibility requires that a remote may add fields without an
// older plugin calling the response malformed -- but it is collected and reported so
// the ignoring becomes observable. Silence is the failure mode worth avoiding: an
// unrecognized key's type is never checked, so a renamed or misspelled field carrying
// a bad value is indistinguishable from an absent one.
const KNOWN_TOP_LEVEL: ReadonlySet<string> = new Set([
  "plugin",
  "features",
  "message",
]);
const KNOWN_PLUGIN: ReadonlySet<string> = new Set([
  "latestVersion",
  "minimumSupportedVersion",
  "blockedVersions",
  "upgradeRecommendation",
]);
const KNOWN_UPGRADE: ReadonlySet<string> = new Set([
  "show",
  "dailyCap",
  "weeklyCap",
  "message",
]);

function unknownIn(
  obj: unknown,
  known: ReadonlySet<string>,
  prefix: string,
): string[] {
  if (!isRecord(obj)) return [];
  return Object.keys(obj)
    .filter((k) => !known.has(k))
    .map((k) => `${prefix}${k}`);
}

/**
 * Validate a candidate policy object. Deliberately shallow: it rejects shapes
 * that would make `evaluate` misbehave and ignores everything else, so a remote
 * can add fields without old plugins calling the response malformed.
 *
 * On success it also returns the keys it did not recognize. Those are still ignored
 * for evaluation; the caller logs them so a shape mismatch during a rollout is
 * greppable instead of invisible.
 */
export function validatePolicy(
  value: unknown,
):
  | { ok: true; policy: PolicyResponse; unknownKeys: string[] }
  | { ok: false; reason: string } {
  if (!isRecord(value)) return { ok: false, reason: "policy is not an object" };

  const plugin = value.plugin;
  if (plugin !== undefined) {
    if (!isRecord(plugin)) {
      return { ok: false, reason: "plugin must be an object" };
    }
    for (const key of ["latestVersion", "minimumSupportedVersion"] as const) {
      const v = plugin[key];
      if (v !== undefined && typeof v !== "string") {
        return { ok: false, reason: `plugin.${key} must be a string` };
      }
    }
    const blocked = plugin.blockedVersions;
    if (
      blocked !== undefined &&
      (!Array.isArray(blocked) || blocked.some((b) => typeof b !== "string"))
    ) {
      return { ok: false, reason: "plugin.blockedVersions must be string[]" };
    }
    const rec = plugin.upgradeRecommendation;
    if (rec !== undefined && !isRecord(rec)) {
      return { ok: false, reason: "plugin.upgradeRecommendation must be an object" };
    }
  }

  const features = value.features;
  if (features !== undefined) {
    if (!isRecord(features)) {
      return { ok: false, reason: "features must be an object" };
    }
    for (const [name, entry] of Object.entries(features)) {
      if (!isRecord(entry)) {
        return { ok: false, reason: `features.${name} must be an object` };
      }
      if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") {
        return { ok: false, reason: `features.${name}.enabled must be boolean` };
      }
    }
  }

  if (value.message !== undefined && typeof value.message !== "string") {
    return { ok: false, reason: "message must be a string" };
  }

  // Unrecognized feature NAMES are collected too. A policy naming a feature this
  // build does not implement means the plugin is older than the policy -- worth
  // seeing, even though `evaluate` correctly ignores it.
  const unknownKeys = [
    ...unknownIn(value, KNOWN_TOP_LEVEL, ""),
    ...unknownIn(value.plugin, KNOWN_PLUGIN, "plugin."),
    ...unknownIn(
      isRecord(value.plugin) ? value.plugin.upgradeRecommendation : undefined,
      KNOWN_UPGRADE,
      "plugin.upgradeRecommendation.",
    ),
    ...unknownIn(value.features, new Set<string>(FEATURE_NAMES), "features."),
  ];

  return { ok: true, policy: value as PolicyResponse, unknownKeys };
}

/**
 * Classify what came back from a successful request.
 *
 * The distinction between "succeeded but no policy" and "could not reach the
 * remote" is the subtlest part of the contract and is NOT decided here -- an
 * unreachable remote never produces a result to classify, so the caller reports
 * that case separately. Conflating them silently disables version enforcement,
 * because no-policy clears version rules while unreachable must keep applying
 * the last synced ones.
 */
export function classifyResult(result: unknown): NegotiationOutcome {
  const meta = isRecord(result) ? result._meta : undefined;
  const candidate = isRecord(meta) ? meta[CAPABILITY_POLICY_KEY] : undefined;

  if (candidate === undefined) return { kind: "no-policy" };

  const validated = validatePolicy(candidate);
  if (!validated.ok) return { kind: "malformed", reason: validated.reason };
  return {
    kind: "policy",
    policy: validated.policy,
    unknownKeys: validated.unknownKeys,
  };
}
