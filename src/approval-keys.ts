// Shared key namespace for HITL tool-approval settings. Kept in its own module
// so both the local store (tool-permissions-store.ts) and the remote store
// (remote-approvals.ts) share one source of truth without a circular import.
//
// Mirrors Glean's per-user `UserSettings` wire shape: a flat settingKey ->
// settingValue string map. Each approved tool is one key:
//     pluginToolApprovals.<toolName> = "true"
// The value is the string "true" (not a boolean) so the serialized shape is
// byte-identical to what `POST /api/v1/saveusersettings` persists.
export const KEY_PREFIX = "pluginToolApprovals.";
export const GRANTED = "true";

export function settingKey(toolName: string): string {
  return `${KEY_PREFIX}${toolName}`;
}
