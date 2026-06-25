// The in-VM source injected once per fresh context (defines ToolResult,
// inspect, print), plus the per-tool PTC_ binding generator and the static
// call-site scan. The __ptcDispatch / __ptcShape / __ptcPrint host bridges are
// injected separately (see ensureContext) and referenced by name in PREAMBLE.

export const PREAMBLE = `
class ToolResult {
  constructor(raw) {
    this.__isToolResult = true;
    // A failed tool call throws before a ToolResult is ever constructed, so if
    // you are holding an \`r\`, the call succeeded.
    this.content = (raw && raw.content) || [];
    this.text = (raw && typeof raw.text === "string") ? raw.text : "";
    this.__structured = raw ? raw.structured : undefined;
    this.__parsed = false;
    this.__json = undefined;
  }
  json() {
    // Prefer the tool's structuredContent; fall back to parsing .text as JSON
    // (undefined if it isn't JSON — use .text then).
    if (this.__structured !== undefined && this.__structured !== null) {
      return this.__structured;
    }
    if (!this.__parsed) {
      this.__parsed = true;
      try { this.__json = JSON.parse(this.text); } catch { this.__json = undefined; }
    }
    return this.__json;
  }
  get(p, fallback) {
    let cur = this.json();
    if (cur === undefined) return fallback;
    for (const part of String(p).split(".")) {
      if (cur == null) return fallback;
      cur = cur[part];
    }
    return cur === undefined ? fallback : cur;
  }
  // "json" if .json() yields data, "empty" if there's no text, else "text"
  // (the output is prose/non-JSON — work with .text). Branch on this instead
  // of if(r.json()), which is the truthiness trap.
  get format() {
    const j = this.json();
    if (j !== undefined && j !== null) return "json";
    return (this.text || "").length > 0 ? "text" : "empty";
  }
}
globalThis.ToolResult = ToolResult;
globalThis.__mkResult = (raw) => new ToolResult(raw);
// inspect(x): return (and print) the STRUCTURE/shape of any value — never the
// data itself. For a ToolResult, say plainly whether it's JSON (and its shape)
// or non-JSON text, so the model isn't left guessing from a bare "string".
globalThis.inspect = (x) => {
  let out;
  if (x && x.__isToolResult) {
    const j = x.json();
    if (j !== undefined && j !== null) {
      out = __ptcShape(j);
    } else if ((x.text || "").length === 0) {
      out = "ToolResult: empty (no content)";
    } else {
      out =
        "ToolResult: non-JSON text (~" + (x.text || "").length +
        " chars) — .json() is undefined; use .text and parse it";
    }
  } else {
    out = __ptcShape(x);
  }
  __ptcPrint(out);
  return out;
};
globalThis.print = (...a) => __ptcPrint(a.map(String).join(" "));
`;

export function scanReferencedTools(code: string): string[] {
  const re = /\bPTC_([A-Za-z0-9_]+)\s*\(/g;
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) found.add(m[1]);
  return [...found];
}

// Bindings are emitted on a SINGLE line (no internal newlines). Each PTC_<NAME>
// is a thin async thunk that forwards to the host bridge __ptcDispatch and
// wraps the result in a ToolResult; a failed call rejects (the bridge throws
// `PTC_<tool> failed: …`).
export function bindingsSource(toolNames: string[]): string {
  return toolNames
    .map(
      (n) =>
        `globalThis.PTC_${n} = async (args) => __mkResult(await __ptcDispatch(${JSON.stringify(n)}, args));`,
    )
    .join("");
}
