import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// The argument section of the approval prompt is capped to this many lines so
// the Accept/Decline buttons stay in view. When a spill file is needed, one of
// these lines is the file path (so up to maxArgSectionLines-1 arguments show).
const maxArgSectionLines = 8;
// Per-argument inline width before a value is cut and marked (truncated).
const maxApprovalArgChars = 120;

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isEmptyArgs(args: unknown): boolean {
  return (
    args == null ||
    (typeof args === "object" &&
      !Array.isArray(args) &&
      Object.keys(args as object).length === 0)
  );
}

// Render one argument as a single line. Multi-line strings are collapsed to
// spaces; values past the inline width are cut and suffixed with "(truncated)".
// `truncated` is true whenever the inline form is not the faithful full value,
// so the caller knows to spill the full content to a file.
function compactArgLine(
  key: string,
  value: unknown,
): { line: string; truncated: boolean } {
  let rendered: string;
  let truncated = false;

  if (typeof value === "string") {
    const collapsed = value.replace(/\s+/g, " ").trim();
    if (value.includes("\n") || collapsed.length > maxApprovalArgChars) {
      truncated = true;
    }
    rendered =
      collapsed.length > maxApprovalArgChars
        ? `${collapsed.slice(0, maxApprovalArgChars)}… (truncated)`
        : collapsed;
  } else if (value !== null && typeof value === "object") {
    const json = safeJson(value);
    if (json.length > maxApprovalArgChars) {
      rendered = `${json.slice(0, maxApprovalArgChars)}… (truncated)`;
      truncated = true;
    } else {
      rendered = json;
    }
  } else {
    rendered = String(value);
  }

  return { line: `${key.toUpperCase()}: ${rendered}`, truncated };
}

// Build the compact, viewport-friendly argument lines for the approval prompt.
// Caps the number of lines and sets needsFile when anything was truncated or
// any argument was omitted, so the caller can spill the full set to a file.
export function buildCompactArgs(args: unknown): {
  lines: string[];
  needsFile: boolean;
} {
  if (isEmptyArgs(args)) {
    return { lines: ["(none)"], needsFile: false };
  }
  if (typeof args !== "object" || Array.isArray(args)) {
    const { line, truncated } = compactArgLine("value", args);
    return { lines: [line], needsFile: truncated };
  }

  const entries = Object.entries(args as Record<string, unknown>);
  const rendered = entries.map(([key, value]) => compactArgLine(key, value));
  const anyTruncated = rendered.some((r) => r.truncated);
  const needsFile = entries.length > maxArgSectionLines || anyTruncated;
  // Reserve one line for the file path when spilling.
  const inlineCount = needsFile ? maxArgSectionLines - 1 : maxArgSectionLines;
  const lines = rendered.slice(0, inlineCount).map((r) => r.line);
  return { lines, needsFile };
}

// Full, untruncated rendering for the spill file. Markdown so it reads well
// when opened: string values are written verbatim (so any Markdown — tables,
// headings — renders), and nested values are pretty-printed JSON in a code
// block.
export function formatArgumentsForFile(
  toolName: string,
  args: unknown,
): string {
  const out: string[] = [`# Approval request: ${toolName}`, ""];
  if (isEmptyArgs(args)) {
    out.push("_(no arguments)_", "");
    return out.join("\n");
  }
  if (typeof args !== "object" || Array.isArray(args)) {
    out.push("```json", JSON.stringify(args, null, 2), "```", "");
    return out.join("\n");
  }
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    out.push(`## ${key}`, "");
    if (typeof value === "string") {
      out.push(value, "");
    } else {
      out.push("```json", JSON.stringify(value, null, 2), "```", "");
    }
  }
  return out.join("\n");
}

// The full arguments are written to a single fixed file under the plugin's
// data dir (CLAUDE_PLUGIN_DATA, exported by start.sh as PLUGIN_DATA_DIR). It is
// intentionally overwritten on each approval — only the most recent prompt's
// arguments need to be inspectable.
export async function writeApprovalArgsFile(
  toolName: string,
  args: unknown,
): Promise<string> {
  const dir =
    process.env.PLUGIN_DATA_DIR ||
    process.env.CLAUDE_PLUGIN_DATA ||
    os.tmpdir();
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "glean-approval-args.md");
  await fs.writeFile(file, formatArgumentsForFile(toolName, args), "utf-8");
  return file;
}
