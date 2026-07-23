import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { EmptyResultSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { callRemoteTool } from "../remote-client.js";
import { buildCompactArgs, writeApprovalArgsFile } from "./approval-args.js";
import { resolveSessionId } from "../session-id.js";
import {
  isToolAlwaysAllowed,
  setToolAlwaysAllowed,
} from "../tool-permissions-store.js";

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

// A downstream tool parameter's JSON Schema, narrowed to the bits we use.
// `type` may be a single string or an array (e.g. ["object", "null"]).
interface ParamSchema {
  type?: string | string[];
}
interface ToolInputSchema {
  properties?: Record<string, ParamSchema>;
}

// The set of JSON Schema types declared for a top-level parameter. file_args
// keys always map to top-level argument names, so a direct properties lookup
// is sufficient — no need to walk nested schemas.
function declaredParamTypes(
  inputSchema: ToolInputSchema | undefined,
  argName: string,
): Set<string> {
  const t = inputSchema?.properties?.[argName]?.type;
  if (typeof t === "string") return new Set([t]);
  if (Array.isArray(t)) {
    return new Set(t.filter((x): x is string => typeof x === "string"));
  }
  return new Set();
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
 * Reads each `file_args` entry from disk and merges its content into
 * `baseArgs` under the given key. The downstream tool's `inputSchema` decides
 * how the content is injected: a parameter typed `object`/`array` is JSON-
 * parsed into structured data (a raw string would fail the downstream schema
 * with "Expected object, given string"), while everything else — the common
 * case of long-form text bodies — is injected verbatim as a UTF-8 string.
 * Throws FileArgsError on any validation failure so the caller can surface the
 * message verbatim to the model.
 */
export async function resolveFileArgs(
  fileArgs: unknown,
  baseArgs: Record<string, unknown>,
  inputSchema?: ToolInputSchema,
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

    const content = await fs.readFile(filePathRaw, "utf-8");
    const types = declaredParamTypes(inputSchema, argName);
    if (types.has("object") || types.has("array")) {
      try {
        merged[argName] = JSON.parse(content);
      } catch (err) {
        // A union like ["string", "object"] can legitimately take raw text, so
        // keep the string. A pure object/array param cannot — fail with a clear
        // message before the opaque downstream "Expected object, given string".
        if (types.has("string")) {
          merged[argName] = content;
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          throw new FileArgsError(
            `file_args.${argName}: "${filePathRaw}" must contain valid JSON for the object/array-typed parameter, but parsing failed: ${msg}`,
          );
        }
      }
    } else {
      merged[argName] = content;
    }
  }

  return merged;
}

interface ToolMetadata {
  requires_approval?: boolean;
  name?: string;
  description?: string;
  server_id?: string;
  inputSchema?: ToolInputSchema;
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
export function isCursorClient(mcpServer: Server): boolean {
  return (mcpServer.getClientVersion()?.name ?? "")
    .toLowerCase()
    .startsWith("cursor");
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
  // Indent argument lines under "Arguments:" so the structural labels stay
  // distinct from values; keys are uppercased (in compactArgLine) so a key
  // reads distinctly from its value — plain-text cues that cost no vertical
  // space.
  const message = [
    `Action: ${toolName}`,
    "Arguments:",
    ...lines.map((line) => `  ${line}`),
  ];
  if (needsFile) {
    // Best-effort: a failed spill (e.g. a sandbox blocking writes outside the
    // project dir) must never break the approval gate, so fall back to a note.
    try {
      const filePath = await writeApprovalArgsFile(toolName, args);
      message.push(`  Full arguments: ${filePath}`);
    } catch {
      message.push("  (some arguments truncated; full-args file unavailable)");
    }
  }
  return message.join("\n");
}

// The approval scope resolved from the prompt.
//   task   – approve just this one call (Accept with the box unticked).
//   always – approve this tool for all future calls (tool-permissions-store).
// "decline" is the prompt's built-in Decline action, handled by the caller via
// result.action, not a content field.
//
// We deliberately keep only "allow once" (Accept) + "always allow" (the box),
// mirroring the Glean Assistant approval model. A per-session scope was dropped:
// it can't be represented on a remote MCP server (no client-local session
// state), and we don't want the plugin to diverge from Assistant here.
export type ApprovalScope = "task" | "always";

// The elicitation schema for the approval prompt. A single BOOLEAN field renders
// as an INLINE checkbox in Claude Code (toggle with Space), shown upfront above
// the built-in Accept/Decline buttons — unlike a string enum, which Claude Code
// renders as a collapse/expand ("▶") accordion that hides the choice. So the
// user sees: [ ] Always allow this tool / Accept / Decline. Accept with the box
// unticked = allow once; tick it = always allow; Decline = reject.
export function approvalRequestedSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      always: {
        type: "boolean",
        title: "Always allow this tool",
        default: false,
      },
    },
  };
}

// Maps an ACCEPTED elicitation result's content to a scope: box ticked =
// "always"; otherwise (unticked, or missing/garbled content) a one-time "task"
// approval. Decline is a non-accept action, handled upstream.
export function readApprovalScope(content: unknown): ApprovalScope {
  if (
    content &&
    typeof content === "object" &&
    (content as Record<string, unknown>).always === true
  ) {
    return "always";
  }
  return "task";
}

function notExecutedResult(toolName: string, action: string): CallToolResult {
  const verb = action === "cancel" ? "cancelled" : "declined";
  return {
    content: [
      {
        type: "text",
        text: `Action ${toolName} was ${verb} by the user.`,
      },
    ],
  };
}

// A WeakSet so a short-lived server in tests doesn't leak,
// and so the burn happens exactly once per server instance.
const elicitationIdPrimed = new WeakSet<object>();
function primeElicitationCancellation(mcpServer: Server): void {
  if (elicitationIdPrimed.has(mcpServer)) return;
  elicitationIdPrimed.add(mcpServer);
  void mcpServer.request({ method: "ping" }, EmptyResultSchema).catch(() => {
    // Ping rejection is fine: request id 0 is already consumed by this call
  });
}

// Path to the per-session permission-mode marker the PreToolUse hook writes
// immediately before each run_tool call (see hooks/auto-approve-run-tool.mjs).
// This resolution MUST match the hook's exactly. The hook cannot see the
// server-only PLUGIN_DATA_DIR that start.sh derives, so both sides key off
// CLAUDE_PLUGIN_DATA (falling back to ~/.glean) — the one anchor available to
// both processes. Under start.sh, PLUGIN_DATA_DIR resolves to this same path.
function permissionModeMarkerPath(): string {
  const base =
    process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), ".glean");
  const sessionId = resolveSessionId()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 64);
  return path.join(base, "glean-hitl-mode", `${sessionId}.json`);
}

// Claude Code's live permission mode for THIS session, as captured by the hook
// on the current call. Returns null when the marker is missing, unreadable, or
// malformed — the caller treats null as "unknown" and keeps the approval gate,
// so any failure fails toward prompting, never toward a silent bypass.
//
// Resume safety: the PreToolUse hook rewrites this marker with the CURRENT mode
// on every run_tool call (see hooks/auto-approve-run-tool.mjs), and PreToolUse
// always runs before the tool executes, so the value read here is the one
// written for this exact call. A session first launched with
// --dangerously-skip-permissions and later resumed WITHOUT it (same session id)
// therefore has its stale bypass marker overwritten with the resumed mode on
// the resumed session's first run_tool call, re-engaging the gate.
async function currentPermissionMode(): Promise<string | null> {
  try {
    const raw = await fs.readFile(permissionModeMarkerPath(), "utf-8");
    const parsed = JSON.parse(raw) as { permission_mode?: unknown };
    return typeof parsed.permission_mode === "string"
      ? parsed.permission_mode
      : null;
  } catch {
    return null;
  }
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

  // Load the downstream tool's metadata once, up front: its inputSchema drives
  // file_args JSON-parsing (object/array params) and its requires_approval
  // drives the HITL gate. Both paths must see it regardless of ENABLE_HITL.
  const toolMeta = await findToolJson(skillsBaseDir, toolName);

  // Resolve file_args up front so the approval prompt shows the COMPLETE input
  // (file-sourced values included, not just the inline `arguments`), and so an
  // unreadable file_args path fails before we prompt the user.
  const baseArgs =
    args.arguments != null && typeof args.arguments === "object"
      ? (args.arguments as Record<string, unknown>)
      : {};
  let resolvedArgs: Record<string, unknown>;
  try {
    resolvedArgs = await resolveFileArgs(
      args.file_args,
      baseArgs,
      toolMeta?.inputSchema,
    );
  } catch (err) {
    if (err instanceof FileArgsError) {
      return {
        content: [{ type: "text", text: err.message }],
        isError: true,
      };
    }
    throw err;
  }

  const hitlEnabled = process.env.ENABLE_HITL === "true";
  // Cursor is gated by its OWN native run-tool approval, not our elicitation.
  // We omit run_tool's readOnlyHint for Cursor (see runToolAnnotations), so
  // Cursor prompts the user before it executes run_tool. Firing our elicitation
  // on top would be a redundant second gate — and worse, Cursor 3.12.x silently
  // drops server-initiated elicitations on the auto-run lane, hanging for the
  // full HITL timeout. So skip our gate for Cursor and let its native prompt
  // (already shown before this call) be the single approval.
  if (
    hitlEnabled &&
    toolMeta?.requires_approval &&
    !isCursorClient(mcpServer) &&
    mcpServer.getClientCapabilities()?.elicitation
  ) {
    // In bypassPermissions mode (`claude --dangerously-skip-permissions`) the
    // user has opted out of every approval prompt for the session, so our own
    // elicitation gate is just a redundant popup — skip it and execute
    // directly. The mode comes from the PreToolUse hook, which writes it keyed
    // by session id immediately before this call, so it reflects the current
    // call and never leaks across sessions. Any other or unknown mode keeps the
    // gate. Only bypassPermissions is skipped (deliberately narrow).
    const bypass = (await currentPermissionMode()) === "bypassPermissions";
    // Already "always allowed" for this tool (keyed by tool name) — skip the
    // prompt, just like bypassPermissions does.
    const preApproved = await isToolAlwaysAllowed(toolName);
    if (!bypass && !preApproved) {
      const message = await buildApprovalMessage(
        mcpServer,
        toolName,
        resolvedArgs,
      );
      const timeout = hitlTimeoutMs();

      // Make a dummy empty request to burn JSON-RPC request id 0
      primeElicitationCancellation(mcpServer);

      try {
        const result = await mcpServer.elicitInput(
          {
            message,
            requestedSchema: approvalRequestedSchema() as any,
          },
          { timeout },
        );

        // Dismissing the prompt (Esc, or the built-in Decline button) is never
        // an approval — fail closed.
        if (result.action !== "accept") {
          return notExecutedResult(toolName, result.action);
        }

        // Accept: if the box was ticked, remember this tool so future calls
        // skip the prompt; otherwise approve just this one call.
        if (readApprovalScope(result.content) === "always") {
          await setToolAlwaysAllowed(toolName);
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
 *
 * TEMP (Cursor): Cursor 3.12.x silently drops the server-initiated elicitation
 * for a `run_tool` marked `readOnlyHint` (it lands on the auto-run lane), so the
 * approval banner never shows and the call hangs to the HITL timeout. For Cursor
 * we therefore flip the whole strategy: do NOT advertise `readOnlyHint` (so
 * Cursor shows its OWN native run-tool approval before executing), and skip our
 * elicitation entirely (see handleRunTool) so Cursor's native prompt is the
 * single gate. Claude Code is unaffected: it keeps `readOnlyHint` (its native
 * prompt stays suppressed) and our elicitation remains its gate.
 */
export function runToolAnnotations(
  enableHitl: boolean,
  clientSupportsElicitation: boolean,
  isCursor: boolean,
): Tool["annotations"] {
  return enableHitl && clientSupportsElicitation && !isCursor
    ? { readOnlyHint: true }
    : undefined;
}
