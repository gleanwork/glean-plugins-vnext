import { FEATURE_NAMES, type FeatureName } from "./key.js";
import type {
  Decision,
  PolicyResponse,
  VersionSource,
  VersionState,
} from "./types.js";

// Plain x.y.z comparison. The plugin's own version scheme is plain semver with no
// pre-release or build metadata (enforced by the release tooling), so a full
// semver implementation would be dead weight. A version that does not parse is
// treated as unknown rather than guessed at.
export function parseVersion(v: string): [number, number, number] | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** -1 if a < b, 0 if equal, 1 if a > b; undefined if either is unparseable. */
export function compareVersions(a: string, b: string): number | undefined {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return undefined;
  for (let i = 0; i < 3; i++) {
    const x = pa[i] as number;
    const y = pb[i] as number;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function allFeatures(value: boolean): Record<FeatureName, boolean> {
  return Object.fromEntries(FEATURE_NAMES.map((f) => [f, value])) as Record<
    FeatureName,
    boolean
  >;
}

export interface EvaluateInput {
  /** The plugin's own version, and how much that value can be trusted. */
  pluginVersion: string;
  versionSource: VersionSource;
  /** Features this build actually implements. */
  supportedFeatures: Record<FeatureName, boolean>;
  /** The policy to apply, or undefined for the no-policy / first-run case. */
  policy?: PolicyResponse;
}

/**
 * Resolve a policy against the local build into an enforceable Decision.
 *
 * Two rules drive everything here:
 *   1. A feature is enabled only if this build supports it AND the remote has not
 *      disabled it. The remote cannot switch on something that is not built.
 *   2. No policy means everything supported is enabled and no version rule
 *      applies -- that is the compatibility path for a remote that does not
 *      implement negotiation yet.
 */
export function evaluate(input: EvaluateInput): Decision {
  const { pluginVersion, versionSource, supportedFeatures, policy } = input;
  const reasons: string[] = [];

  if (!policy) {
    reasons.push(
      "no policy available: enabling all supported features, applying no version policy",
    );
    return {
      deactivated: false,
      versionState: "unenforced",
      features: { ...supportedFeatures },
      showUpgrade: false,
      reasons,
    };
  }

  // ---- version eligibility ------------------------------------------------
  // Enforcement is gated on provenance. Deactivating a plugin on a version we
  // cannot actually vouch for would break working installs for no benefit.
  let versionState: VersionState = "ok";
  let deactivated = false;

  if (versionSource === "unknown") {
    versionState = "unenforced";
    reasons.push(
      "version source is unknown: version policy not enforced (never deactivate on an unverifiable version)",
    );
  } else {
    const blocked = policy.plugin?.blockedVersions ?? [];
    const min = policy.plugin?.minimumSupportedVersion;

    // Minimum first: it is the compatibility floor, and "too old" is a more
    // actionable message than "specifically blocked".
    if (min) {
      const cmp = compareVersions(pluginVersion, min);
      if (cmp === undefined) {
        reasons.push(
          `cannot compare ${pluginVersion} against minimum ${min}: skipping minimum check`,
        );
      } else if (cmp < 0) {
        versionState = "below-minimum";
        deactivated = true;
        reasons.push(
          `version ${pluginVersion} is below the minimum supported ${min}: deactivated`,
        );
      }
    }

    // Exact-match list, not a threshold -- it exists for non-contiguous bad
    // releases (block 1.2 while 1.1 and 1.3 stay usable).
    if (!deactivated && blocked.includes(pluginVersion)) {
      versionState = "blocked";
      deactivated = true;
      reasons.push(`version ${pluginVersion} is explicitly blocked: deactivated`);
    }

    if (!deactivated) {
      const latest = policy.plugin?.latestVersion;
      if (latest && compareVersions(pluginVersion, latest) === -1) {
        versionState = "outdated-supported";
        reasons.push(
          `version ${pluginVersion} is older than latest ${latest} but supported`,
        );
      }
    }
  }

  // ---- feature policy -----------------------------------------------------
  // A deactivated plugin exposes only setup, so every feature is inert. Reported
  // as all-false so no caller can accidentally act on a stale enablement.
  if (deactivated) {
    return {
      deactivated: true,
      versionState,
      features: allFeatures(false),
      showUpgrade: true,
      message: policy.message,
      reasons,
    };
  }

  const features = {} as Record<FeatureName, boolean>;
  for (const name of FEATURE_NAMES) {
    const supported = supportedFeatures[name] === true;
    if (!supported) {
      features[name] = false;
      continue;
    }
    // An omitted feature is left enabled: the remote naming fewer features than
    // the plugin supports means it has no opinion, not that it said no.
    const entry = policy.features?.[name];
    const enabled = entry?.enabled !== false;
    features[name] = enabled;
    if (!enabled) reasons.push(`feature "${name}" disabled by remote policy`);
  }

  return {
    deactivated: false,
    versionState,
    features,
    showUpgrade:
      versionState === "outdated-supported" &&
      policy.plugin?.upgradeRecommendation?.show === true,
    message: policy.message,
    reasons,
  };
}
