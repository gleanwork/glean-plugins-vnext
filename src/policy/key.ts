// The vendor-prefixed `_meta` key carrying the policy exchange. This is an
// application-level Glean extension, not a core MCP method or capability: the
// host never needs to understand it, and the plugin both creates and consumes it.
export const CAPABILITY_POLICY_KEY = "com.glean.mcp/capabilityPolicy";

// The features whose enablement the remote controls. Keep in lockstep with
// FeatureName below -- the array exists so the plugin can declare support for
// exactly the features it implements, no more.
//
// `hitl` is deliberately absent, though the design contract defines it. Disabling local
// HITL only makes sense once approval moves to the remote, and the remote is stateless:
// it has no back-channel to send `elicitation/create` on, so remote-side approval waits
// on MCP 2026-07-28 landing there. Until then a remote-disabled HITL would leave no gate
// at all -- and under Claude Code it would be worse than having no policy, because the
// plugin's PreToolUse hook auto-approves run_tool on the premise that the local prompt
// IS the gate. A remote that needs to stop such a plugin deactivates the version.
//
// Declaring it here is what would make the remote believe it is controllable, so the
// honest signal is to leave it out until a build can honour it. A remote that sends
// `features.hitl` anyway takes the unknown-key path: accepted, logged, ignored.
export const FEATURE_NAMES = [
  "toolPromotion",
  "metaTools",
  "fileArgs",
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];
