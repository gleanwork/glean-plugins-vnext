import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { callRemoteTool } from "../remote-client.js";

const DEFAULT_FILE_ARG_MAX_BYTES = 1 * 1024 * 1024;

// How long a user has to respond to an approval prompt. The MCP SDK's own
// request timeout is 60s and, on expiry, elicitInput REJECTS — so unless we
// pass an explicit (longer) value the prompt errors out from under the user.
const defaultHitlTimeoutMs = 300_000;

export class FileArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileArgsError";
  }
}

function fileArgsMaxBytes(): number {
  const raw = process.env.GLEAN_FILE_ARG_MAX_BYTES;
  if (!raw) return DEFAULT_FILE_ARG_MAX_BYTES;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_FILE_ARG_MAX_BYTES;
}

function hitlTimeoutMs(): number {
  const raw = process.env.HITL_TIMEOUT_MS;
  if (!raw) return defaultHitlTimeoutMs;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultHitlTimeoutMs;
}

/**
 * Reads each `file_args` entry from disk and merges its UTF-8 content into
 * `baseArgs` under the given key. Throws FileArgsError on any validation
 * failure so the caller can surface the message verbatim to the model.
 */
export async function resolveFileArgs(
  fileArgs: unknown,
  baseArgs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (fileArgs === undefined || fileArgs === null) return baseArgs;
  if (
    typeof fileArgs !== "object" ||
    Array.isArray(fileArgs)
  ) {
    throw new FileArgsError(
      "file_args must be an object mapping arg name to absolute file path",
    );
  }

  const entries = Object.entries(fileArgs as Record<string, unknown>);
  if (entries.length === 0) return baseArgs;

  const merged: Record<string, unknown> = { ...baseArgs };
  const maxBytes = fileArgsMaxBytes();

  for (const [argName, filePathRaw] of entries) {
    if (typeof filePathRaw !== "string" || filePathRaw === "") {
      throw new FileArgsError(
        `file_args.${argName} must be a non-empty string path`,
      );
    }
    if (!path.isAbsolute(filePathRaw)) {
      throw new FileArgsError(
        `file_args.${argName} must be an absolute path; got "${filePathRaw}"`,
      );
    }
    if (argName in baseArgs) {
      throw new FileArgsError(
        `file_args.${argName} conflicts with arguments.${argName}; remove one`,
      );
    }

    let stat;
    try {
      stat = await fs.stat(filePathRaw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new FileArgsError(
        `file_args.${argName}: cannot read "${filePathRaw}": ${msg}`,
      );
    }
    if (!stat.isFile()) {
      throw new FileArgsError(
        `file_args.${argName}: "${filePathRaw}" is not a regular file`,
      );
    }
    if (stat.size > maxBytes) {
      throw new FileArgsError(
        `file_args.${argName}: "${filePathRaw}" is ${stat.size} bytes, exceeds ${maxBytes} byte limit (set GLEAN_FILE_ARG_MAX_BYTES to override)`,
      );
    }

    merged[argName] = await fs.readFile(filePathRaw, "utf-8");
  }

  return merged;
}

interface ToolMetadata {
  requires_approval?: boolean;
  name?: string;
  description?: string;
  server_id?: string;
}

async function findToolJson(
  skillsBaseDir: string,
  toolName: string,
): Promise<ToolMetadata | null> {
  try {
    const skillDirs = await fs.readdir(skillsBaseDir, { withFileTypes: true });
    for (const dir of skillDirs) {
      if (!dir.isDirectory()) continue;
      const toolPath = path.join(skillsBaseDir, dir.name, "tools", `${toolName}.json`);
      try {
        const content = await fs.readFile(toolPath, "utf-8");
        return JSON.parse(content) as ToolMetadata;
      } catch {
        continue;
      }
    }
  } catch {
    // Skills dir doesn't exist or can't be read
  }
  return null;
}

// A stdio server's only client signal is clientInfo.name. Cursor reports
// "cursor-vscode" and already renders the tool name + arguments in its own
// expandable UI, so its approval prompt only needs a one-line review ask.
function isCursorClient(mcpServer: Server): boolean {
  return (mcpServer.getClientVersion()?.name ?? "")
    .toLowerCase()
    .startsWith("cursor");
}

// Approval prompts must stay short enough that Claude Code keeps the
// Accept/Decline buttons in view. The inline message is therefore capped to a
// handful of one-line-per-argument entries; anything that can't be shown
// faithfully inline (multi-line, long, or extra arguments) is written in full
// to a file and the path is shown instead — never expanded inline.
const maxApprovalArgLines = 4;
const maxApprovalArgChars = 80;

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
// spaces; long strings/objects are truncated with an ellipsis. `truncated` is
// true whenever the inline form is not the faithful full value, so the caller
// knows to spill the full content to a file.
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
        ? `${collapsed.slice(0, maxApprovalArgChars)}…`
        : collapsed;
  } else if (value !== null && typeof value === "object") {
    const json = safeJson(value);
    if (json.length > maxApprovalArgChars) {
      rendered = `${json.slice(0, maxApprovalArgChars)}…`;
      truncated = true;
    } else {
      rendered = json;
    }
  } else {
    rendered = String(value);
  }

  return { line: `${key}: ${rendered}`, truncated };
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
  const shown = entries.slice(0, maxApprovalArgLines);
  let needsFile = entries.length > shown.length;
  const lines = shown.map(([key, value]) => {
    const { line, truncated } = compactArgLine(key, value);
    if (truncated) needsFile = true;
    return line;
  });
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

async function writeApprovalArgsFile(
  toolName: string,
  args: unknown,
): Promise<string> {
  const dir = path.join(os.tmpdir(), "glean-approvals");
  await fs.mkdir(dir, { recursive: true });
  const safeName = toolName.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
  const file = path.join(dir, `${safeName}-${randomUUID().slice(0, 8)}.md`);
  await fs.writeFile(file, formatArgumentsForFile(toolName, args), "utf-8");
  return file;
}

// Plain text, NOT Markdown: Claude Code does not reliably render Markdown in
// elicitation prompts. Kept short (a few lines) so the Accept/Decline buttons
// stay in view; full argument detail spills to a file when it can't fit.
async function buildApprovalMessage(
  mcpServer: Server,
  toolName: string,
  args: unknown,
): Promise<string> {
  if (isCursorClient(mcpServer)) {
    return `Review the tool and arguments shown above, click on Submit to allow and Cancel to deny.`;
  }

  const { lines, needsFile } = buildCompactArgs(args);
  const message = [`Action: ${toolName}`, "Arguments:", ...lines];
  if (needsFile) {
    const filePath = await writeApprovalArgsFile(toolName, args);
    message.push(`Full arguments: ${filePath}`);
  }
  return message.join("\n");
}

export async function handleRunTool(
  remoteClient: Client,
  mcpServer: Server,
  skillsBaseDir: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const serverId = args.server_id;
  const toolName = args.tool_name;

  if (typeof serverId !== "string" || typeof toolName !== "string") {
    return {
      content: [
        { type: "text", text: "server_id and tool_name are required strings" },
      ],
      isError: true,
    };
  }

  const hitlEnabled = process.env.ENABLE_HITL === "true";
  if (hitlEnabled && mcpServer.getClientCapabilities()?.elicitation) {
    const toolMeta = await findToolJson(skillsBaseDir, toolName);

    if (toolMeta?.requires_approval) {
      const message = await buildApprovalMessage(
        mcpServer,
        toolName,
        args.arguments,
      );
      const timeout = hitlTimeoutMs();

      try {
        const result = await mcpServer.elicitInput(
          {
            message,
            requestedSchema: { type: "object", properties: {} } as any,
          },
          { timeout },
        );

        if (result.action !== "accept") {
          return {
            content: [
              {
                type: "text",
                text: `Action ${toolName} was ${result.action === "decline" ? "declined" : "cancelled"} by the user.`,
              },
            ],
          };
        }
      } catch (err) {
        // Fail CLOSED. An approval gate that executes the action when the
        // prompt times out or errors defeats its own purpose — and the SDK
        // rejects elicitInput precisely on request timeout.
        const detail = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Action ${toolName} was not approved — the approval request failed (${detail}). The action was NOT executed. Ask the user to confirm, then retry.`,
            },
          ],
          isError: true,
        };
      }
    }
  }

  const baseArgs =
    args.arguments != null && typeof args.arguments === "object"
      ? (args.arguments as Record<string, unknown>)
      : {};
  let resolvedArgs: Record<string, unknown>;
  try {
    resolvedArgs = await resolveFileArgs(args.file_args, baseArgs);
  } catch (err) {
    if (err instanceof FileArgsError) {
      return {
        content: [{ type: "text", text: err.message }],
        isError: true,
      };
    }
    throw err;
  }

  return callRemoteTool(
    remoteClient,
    "run_tool",
    buildRemoteArgs(serverId, toolName, resolvedArgs),
  );
}

/**
 * Assemble the payload for the backend `run_tool` meta-tool. `arguments` is
 * ALWAYS included, even when empty: the downstream MCP `tools/call` validates
 * `params.arguments` as an object, and an absent field serializes to `null`,
 * which strict downstream servers reject ("Expected: object, given: null").
 * Sending an explicit `{}` for no-argument tools matches what the MCP SDK
 * does for direct tool calls.
 */
export function buildRemoteArgs(
  serverId: string,
  toolName: string,
  resolvedArgs: Record<string, unknown>,
): Record<string, unknown> {
  return {
    server_id: serverId,
    tool_name: toolName,
    arguments: resolvedArgs,
  };
}

/**
 * Annotations for the `run_tool` meta-tool. When HITL is active for an
 * elicitation-capable client, our own approval prompt is the gate, so we mark
 * the tool `readOnlyHint` to suppress the client's native run-tool confirmation
 * and avoid a double prompt. Without HITL there is no gate of our own, so we
 * leave annotations unset and let the client decide.
 */
export function runToolAnnotations(
  enableHitl: boolean,
  clientSupportsElicitation: boolean,
): Tool["annotations"] {
  return enableHitl && clientSupportsElicitation
    ? { readOnlyHint: true }
    : undefined;
}
