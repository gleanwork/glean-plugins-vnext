// run_code limits + shape-inference tuning. All execution limits are
// env-overridable (read at call time, mirroring GLEAN_FILE_ARG_MAX_BYTES).
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const TIMEOUT_MS = () => envInt("GLEAN_PTC_TIMEOUT_MS", 60_000);
export const MAX_CALLS = () => envInt("GLEAN_PTC_MAX_CALLS", 200);

export const SHAPE_MAX_DEPTH = 6;
export const SHAPE_MAX_KEYS = 40;
export const ARRAY_SAMPLE = 5; // how many array elements to merge when inferring shape

// Excerpt cap for a failed tool's error text in the thrown `PTC_<tool> failed:` message.
export const TOOL_ERROR_MAX = 300;
