export const RUN_CODE_ENV_VAR =
  "DANGEROUSLY_ENABLE_UNSTABLE_RUN_CODE_FEATURE" as const;

/**
 * Experimental code mode is fail-closed and opt-in. Only the exact lowercase
 * string "true" enables it; missing, empty, placeholder, and truthy-ish values
 * all preserve the baseline run_tool-only experience.
 */
export function isRunCodeEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env[RUN_CODE_ENV_VAR] === "true";
}
