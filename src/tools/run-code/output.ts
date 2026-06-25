import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// Always returns VALID JSON: bigints become "<n>n" strings, cycles become
// "[circular]", and any residual stringify failure falls back to a JSON string
// literal (never a bare "[object Object]"). So JSON.parse(serialize(v)) always
// succeeds — callers rely on the text and structured channels staying in sync.
export function serialize(v: unknown): string {
  const seen = new WeakSet<object>();
  try {
    const s = JSON.stringify(v, (_k, val) => {
      if (typeof val === "bigint") return `${val}n`;
      if (val && typeof val === "object") {
        if (seen.has(val as object)) return "[circular]";
        seen.add(val as object);
      }
      return val;
    });
    return s === undefined ? JSON.stringify(String(v)) : s;
  } catch {
    return JSON.stringify(String(v));
  }
}

export function extractText(res: CallToolResult): string {
  if (!Array.isArray(res.content)) return "";
  return res.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
}

// If the model returns a ToolResult directly, operate on the underlying data
// (parsed JSON, else raw text) rather than the wrapper's internal fields.
export function normalizeForSummary(v: unknown): unknown {
  if (
    v &&
    typeof v === "object" &&
    (v as { __isToolResult?: boolean }).__isToolResult
  ) {
    const tr = v as { text?: string; __structured?: unknown };
    if (tr.__structured !== undefined && tr.__structured !== null) {
      return tr.__structured;
    }
    try {
      if (tr.text) return JSON.parse(tr.text);
    } catch {
      /* not JSON */
    }
    return tr.text ?? null;
  }
  return v;
}
