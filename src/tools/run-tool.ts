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

const DEFAULT_FILE_ARG_MAX_BYTES = 1 * 1024 * 1024;

// Fast path after successful preference persistence.
const sessionApproved = new Set<string>();
function approvalKey(serverId: string, toolName: string): string {
  return JSON.stringify([serverId, toolName]);
}

const defaultHitlTimeoutMs = 300_000;

export class FileArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileArgsError";
  }
}

interface ParamSchema {
  type?: string | string[];
}
interface ToolInputSchema {
  properties?: Record<string, ParamSchema>;
}

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
        // Preserve raw text for unions; parse only object/array parameters.
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
  }
  return null;
}

// Cursor renders tool details itself, so use a one-line approval message.
function isCursorClient(mcpServer: Server): boolean {
  return (mcpServer.getClientVersion()?.name ?? "")
    .toLowerCase()
    .startsWith("cursor");
}

// Keep prompts plain-text and compact; large arguments spill to a file.
async function buildApprovalMessage(
  mcpServer: Server,
  toolName: string,
  args: unknown,
): Promise<string> {
  if (isCursorClient(mcpServer)) {
    return `Review the tool and arguments shown above, click on Submit to allow and Cancel to deny.`;
  }

  const { lines, needsFile } = buildCompactArgs(args);
  const message = [
    `Action: ${toolName}`,
    "Arguments:",
    ...lines.map((line) => `  ${line}`),
  ];
  if (needsFile) {
    try {
      const filePath = await writeApprovalArgsFile(toolName, args);
      message.push(`  Full arguments: ${filePath}`);
    } catch {
      message.push("  (some arguments truncated; full-args file unavailable)");
    }
  }
  return message.join("\n");
}

// The follow-up only persists approval for future calls.
const alwaysAllowFollowUpTimeoutMs = 5_000;

async function requestAlwaysAllowFollowUp(
  mcpServer: Server,
  toolName: string,
): Promise<boolean> {
  // Avoid request id 0, which some MCP clients cannot cancel correctly.
  primeElicitationCancellation(mcpServer);

  try {
    const result = await mcpServer.elicitInput(
      {
        message: `Always allow ${toolName} for future calls?`,
        // Empty form preserves the host-native Yes/No actions.
        requestedSchema: { type: "object", properties: {} } as any,
      },
      { timeout: alwaysAllowFollowUpTimeoutMs },
    );
    return result.action === "accept";
  } catch {
    return false;
  }
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

const elicitationIdPrimed = new WeakSet<object>();
function primeElicitationCancellation(mcpServer: Server): void {
  if (elicitationIdPrimed.has(mcpServer)) return;
  elicitationIdPrimed.add(mcpServer);
  void mcpServer.request({ method: "ping" }, EmptyResultSchema).catch(() => {});
}

// Must match the hook's shared CLAUDE_PLUGIN_DATA marker.
function permissionModeMarkerPath(): string {
  const base =
    process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), ".glean");
  const sessionId = resolveSessionId()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 64);
  return path.join(base, "glean-hitl-mode", `${sessionId}.json`);
}

// Missing or malformed markers return null and keep the approval gate active.
// The hook rewrites the marker before each call, preventing stale bypass state.
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

  const toolMeta = await findToolJson(skillsBaseDir, toolName);

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
  if (
    hitlEnabled &&
    toolMeta?.requires_approval &&
    mcpServer.getClientCapabilities()?.elicitation
  ) {
    // Only bypassPermissions disables this gate; unknown modes remain gated.
    const bypass = (await currentPermissionMode()) === "bypassPermissions";
    // Covers the interval before find_skills refreshes server-side grants.
    const preApproved = sessionApproved.has(approvalKey(serverId, toolName));
    if (!bypass && !preApproved) {
      const message = await buildApprovalMessage(
        mcpServer,
        toolName,
        resolvedArgs,
      );
      const timeout = hitlTimeoutMs();

      primeElicitationCancellation(mcpServer);

      try {
        const result = await mcpServer.elicitInput(
          {
            message,
            requestedSchema: { type: "object", properties: {} } as any,
          },
          { timeout },
        );

        if (result.action !== "accept") {
          return notExecutedResult(toolName, result.action);
        }

        const alwaysAllow = await requestAlwaysAllowFollowUp(
          mcpServer,
          toolName,
        );
        if (alwaysAllow) {
          try {
            await callRemoteTool(remoteClient, "set_tool_approval", {
              server_id: serverId,
              tool_name: toolName,
              value: "ALWAYS_ALLOWED",
            });
            sessionApproved.add(approvalKey(serverId, toolName));
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            console.error(
              `[set_tool_approval] failed to persist "${toolName}" to Glean: ${detail}`,
            );
          }
        }
      } catch (err) {
        // Initial elicitation errors are fail-closed.
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

export function runToolAnnotations(
  enableHitl: boolean,
  clientSupportsElicitation: boolean,
): Tool["annotations"] {
  return enableHitl && clientSupportsElicitation
    ? { readOnlyHint: true }
    : undefined;
}
