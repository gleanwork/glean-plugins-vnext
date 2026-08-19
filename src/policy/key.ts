// The vendor-prefixed `_meta` key carrying the policy exchange. This is an
// application-level Glean extension, not a core MCP method or capability: the
// host never needs to understand it, and the plugin both creates and consumes it.
export const CAPABILITY_POLICY_KEY = "com.glean.mcp/capabilityPolicy";

// The features whose enablement the remote controls. Keep in lockstep with
// FeatureName below -- the array exists so the plugin can declare support for
// exactly the features it implements, no more.
export const FEATURE_NAMES = [
  "toolPromotion",
  "metaTools",
  "hitl",
  "fileArgs",
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];
