import type { Client } from "@modelcontextprotocol/client";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { EmptyResultSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { callRemoteTool } from "../remote-client.js";
import { FILE_ARGS_DISABLED_TEXT } from "../policy/enforce.js";
import { buildCompactArgs, writeApprovalArgsFile } from "./approval-args.js";
import { resolveSessionId } from "../session-id.js";
import { hostSharedDataDir } from "../data-dir.js";

const DEFAULT_FILE_ARG_MAX_BYTES = 5 * 1024 * 1024;

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

// A stdio server's only client signal is clientInfo.name; Cursor reports
// "cursor-vscode". Used to offer Cursor's version as a possible cause when an
// approval request waits out the clock (see elicitationFailureText).
export function isCursorClient(mcpServer: Server): boolean {
  return (mcpServer.getClientVersion()?.name ?? "")
    .toLowerCase()
    .startsWith("cursor");
}

// Plain text, NOT Markdown: Claude Code does not reliably render Markdown in
// elicitation prompts. Kept short (a few lines) so the Accept/Decline buttons
// stay in view; full argument detail spills to a file when it can't fit.
//
// Every host gets the same text, Cursor included. Cursor was an exception for good
// reason until recently: it rendered the tool and its arguments itself, directly above
// the prompt, so its message was only a review ask — "Review the tool and arguments
// shown above". As of August 2026 Cursor no longer renders them (confirmed by
// screenshot), which left that message pointing at nothing on screen. The shared text
// names the action and arguments itself, so it cannot go stale that way. Re-introducing
// a host-specific short form means first confirming that host still displays the
// arguments somewhere.
async function buildApprovalMessage(
  toolName: string,
  args: unknown,
): Promise<string> {
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
// The directory has to be the one the HOOK can compute, not the one this process
// would prefer -- see hostSharedDataDir() in ../data-dir.ts.
function permissionModeMarkerPath(): string {
  const sessionId = resolveSessionId()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 64);
  return path.join(hostSharedDataDir(), "glean-hitl-mode", `${sessionId}.json`);
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

// The HITL timeout defaults to 5 minutes, and "waited the full 300s" reads worse than
// "the full 5 minutes" in a message a model relays to a user verbatim.
function humanizeMs(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 120) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

// Text for a FAILED approval request — a rejection, not a user's decline or cancel.
// Those resolve with an action and are handled by the caller.
//
// A request that burned the whole timeout is AMBIGUOUS, and the message has to stay that
// way: the prompt may have been shown and left unanswered, or never delivered at all.
// Nothing observable from here separates the two, so the Cursor explanation is offered as
// a possibility for the user to check, never asserted. Cursor before 3.15 can silently
// drop server-initiated elicitations onto the auto-run lane, and its clientInfo.version
// is a hardcoded "1.0.0" (verified: the app reports 3.14.7 while the handshake says
// 1.0.0), so there is no version to compare and no way to confirm which case occurred.
//
// The duration check only keeps the note off plainly unrelated failures: an interrupted
// request fails early, a dropped one waits out the clock. It cannot carry more weight
// than that, because the SDK wraps every abort reason as ErrorCode.RequestTimeout
// (shared/protocol.js) — a user-driven abort and a real timeout arrive with the same code
// and message shape.
export function elicitationFailureText(
  mcpServer: Server,
  toolName: string,
  detail: string,
  elapsedMs: number,
  timeoutMs: number,
): string {
  const base =
    `Action ${toolName} was not approved — the approval request failed ` +
    `(${detail}). The action was NOT executed.`;

  // Only a request that waited out the clock is a candidate for the Cursor note; an
  // early failure was interrupted, which the dropped-prompt bug does not explain.
  const waitedFullTimeout = elapsedMs >= timeoutMs * 0.9;

  if (!waitedFullTimeout || !isCursorClient(mcpServer)) {
    return `${base} Ask the user to confirm, then retry.`;
  }

  return (
    `${base}\n\n` +
    `It waited the full ${humanizeMs(timeoutMs)} without an answer. Either the approval ` +
    `prompt was shown and went unanswered, or it was never shown at all — this end ` +
    `cannot tell which. One possible cause, if no prompt appeared, is a known Cursor ` +
    `issue before version 3.15: a server-initiated approval prompt can be dropped ` +
    `silently, leaving nothing on screen to accept or dismiss. Ask the user whether they ` +
    `saw an approval prompt. If they did not, suggest checking Cursor's version and ` +
    `updating if it is below 3.15 — otherwise a retry may wait out the clock again.`
  );
}

/**
 * The policy-controlled features this handler implements.
 *
 * Required rather than optional: an omitted argument would silently mean "enabled", and
 * the typechecker is the only thing that can stop a new call site forgetting it.
 */
export interface RunToolPolicy {
  fileArgs: boolean;
}

export async function handleRunTool(
  remoteClient: Client,
  mcpServer: Server,
  skillsBaseDir: string,
  args: Record<string, unknown>,
  policy: RunToolPolicy,
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

  // Refuse before resolveFileArgs, not alongside it. That function reads model-supplied
  // absolute paths off the user's disk, so a disabled feature has to mean the read does
  // not happen -- "advertised without file_args but still reading files" would make the
  // feature inert in name only.
  //
  // Refusing rather than ignoring the argument: silently dropping input the model
  // supplied invites it to retry the same call, so the text says to inline the values.
  // A call that passes no file_args is unaffected.
  if (!policy.fileArgs && args.file_args !== undefined) {
    return {
      content: [{ type: "text", text: FILE_ARGS_DISABLED_TEXT }],
      isError: true,
    };
  }

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
  // Cursor is deliberately NOT excepted here any more. It used to be: we omitted
  // run_tool's readOnlyHint so Cursor showed its own native prompt, and skipped our
  // elicitation entirely, because Cursor before 3.15 can silently drop server-initiated
  // elicitations onto the auto-run lane — no prompt appears and the call waits out the
  // HITL timeout. That workaround was permanent and silent, though: it left every Cursor
  // user on the weaker native prompt even on builds where elicitation works, with no
  // signal that upgrading would help. Cursor's clientInfo.version is a hardcoded "1.0.0"
  // (verified: the app reports 3.14.7 while the handshake says 1.0.0), so we cannot
  // detect the fixed build and switch back automatically. Instead we treat Cursor like
  // any other elicitation-capable host, and a timeout surfaces the version as a
  // possible cause — see elicitationFailureText.
  if (
    hitlEnabled &&
    toolMeta?.requires_approval &&
    mcpServer.getClientCapabilities()?.elicitation
  ) {
    // The Glean plugin owns write approval for run_tool on both legacy and
    // modern gateway paths. Remote elicitation is forwarded separately for
    // downstream tools that need additional user input; it does not replace
    // this pre-execution approval gate.
    // In bypassPermissions mode (`claude --dangerously-skip-permissions`) the
    // user has opted out of every approval prompt for the session, so our own
    // elicitation gate is just a redundant popup — skip it and execute
    // directly. The mode comes from the PreToolUse hook, which writes it keyed
    // by session id immediately before this call, so it reflects the current
    // call and never leaks across sessions. Any other or unknown mode keeps the
    // gate. Only bypassPermissions is skipped (deliberately narrow).
    const bypass = (await currentPermissionMode()) === "bypassPermissions";
    if (!bypass) {
      const message = await buildApprovalMessage(toolName, resolvedArgs);
      const timeout = hitlTimeoutMs();

      // Make a dummy empty request to burn JSON-RPC request id 0
      primeElicitationCancellation(mcpServer);

      const startedAt = Date.now();
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
              text: elicitationFailureText(
                mcpServer,
                toolName,
                detail,
                Date.now() - startedAt,
                timeout,
              ),
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
 * Cursor is no longer excepted here. It used to be, to route around its
 * pre-3.15 elicitation bug, but that traded a permanent weaker gate for a
 * transient bug and left users with no signal that upgrading would help. Cursor
 * now gets `readOnlyHint` like any other elicitation-capable host, so our prompt
 * is the single gate there too. If the prompt is dropped, the request waits out the HITL
 * timeout and `elicitationFailureText` raises the version as something to check.
 */
export function runToolAnnotations(
  enableHitl: boolean,
  clientSupportsElicitation: boolean,
): Tool["annotations"] {
  return enableHitl && clientSupportsElicitation
    ? { readOnlyHint: true }
    : undefined;
}
