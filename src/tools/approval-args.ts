import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resolveSessionId } from "../session-id.js";

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

  // Sanitize the KEY the same way as values: collapse all whitespace (incl.
  // newlines) to single spaces. A prompt-injected model can otherwise add an
  // argument whose key embeds newlines (e.g. "note\nACTION: read_only\n...") to
  // forge extra structural lines in the approval message and spoof what the
  // user is approving. Uppercased so a key reads distinctly from its value.
  const safeKey = key.replace(/\s+/g, " ").trim().toUpperCase();
  return { line: `${safeKey}: ${rendered}`, truncated };
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
  // Reserve one line for the spill-file path (buildApprovalMessage appends it).
  const fileReserve =
    entries.length > maxArgSectionLines || anyTruncated ? 1 : 0;
  const capacity = maxArgSectionLines - fileReserve;
  // If not everything fits, reserve one more line for the "(+N more)" marker so
  // hidden arguments are always disclosed — a prompt-injected extra arg can't
  // silently pad the list past the cap and vanish.
  const willOmit = entries.length > capacity;
  const inlineCount = willOmit ? capacity - 1 : capacity;
  const lines = rendered.slice(0, inlineCount).map((r) => r.line);
  const omitted = entries.length - lines.length;
  if (omitted > 0) {
    lines.push(
      `(+${omitted} more argument${omitted === 1 ? "" : "s"} — see full arguments file)`,
    );
  }
  const needsFile = omitted > 0 || anyTruncated;
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

// The full arguments are written to a per-session file under the plugin's data
// dir (CLAUDE_PLUGIN_DATA, set by start.mjs as PLUGIN_DATA_DIR). The file is
// scoped to the chat session id so parallel sessions don't overwrite each
// other; within a session it is intentionally overwritten on each approval —
// only the most recent prompt's arguments need to be inspectable.
export async function writeApprovalArgsFile(
  toolName: string,
  args: unknown,
): Promise<string> {
  const base =
    process.env.PLUGIN_DATA_DIR ||
    process.env.CLAUDE_PLUGIN_DATA ||
    os.tmpdir();
  const sessionId = resolveSessionId().replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
  const dir = path.join(base, "glean-approvals", sessionId);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "glean-approval-args.md");
  await fs.writeFile(file, formatArgumentsForFile(toolName, args), "utf-8");
  return file;
}
