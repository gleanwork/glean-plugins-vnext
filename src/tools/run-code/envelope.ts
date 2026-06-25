import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { serialize } from "./output.js";

// The result envelope returned to the model. Every field except `ok` is
// optional and omitted when empty, so the common success envelope is tiny.
// Large values are NOT redirected to files — the host/harness handles
// oversized tool output.
export interface RunCodeEnvelope {
  ok: boolean;
  value?: unknown; // the cell's return value, verbatim; omitted on error
  stdout?: string; // print(...) output; only when non-empty
  session?: { fresh: boolean }; // only on a fresh/just-reset context
  error?: { message: string }; // only on a throw
}

// Emit the envelope on BOTH MCP channels: `structuredContent` (the typed JSON
// object) and a `content[].text` JSON string. serialize() always returns valid
// JSON (bigint-safe, cycle-safe), so structuredContent is the parsed text and
// the two channels never disagree. The catch is a belt-and-suspenders guard:
// if parsing ever fails, we rewrite BOTH channels to a consistent valid value.
export function makeEnvelope(
  env: RunCodeEnvelope,
  isError: boolean,
): CallToolResult {
  let text = serialize(env);
  let structuredContent: { [key: string]: unknown };
  try {
    structuredContent = JSON.parse(text);
  } catch {
    structuredContent = { ok: env.ok, error: { message: "result not serializable" } };
    text = JSON.stringify(structuredContent); // keep both channels in sync + valid JSON
  }
  return {
    content: [{ type: "text", text }],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
}

// Canonical error envelope for the early-return paths (empty code, approval
// declined, approval channel broke) so the LLM always sees a consistent shape.
export function envelopeError(
  message: string,
  opts: { isError?: boolean } = {},
): CallToolResult {
  return makeEnvelope({ ok: false, error: { message } }, opts.isError ?? false);
}
