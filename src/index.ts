import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type Tool,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import path from "node:path";
import fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import {
  AuthRequiredError,
  createRemoteClient,
  type RemoteClientOptions,
} from "./remote-client.js";
import { GleanOAuthClientProvider, openBrowser } from "./auth-provider.js";
import {
  startCallbackServer,
  closeCallbackServer,
} from "./auth-callback-server.js";
import { handleFindSkills } from "./tools/find-skills.js";
import { handleRunTool, runToolAnnotations } from "./tools/run-tool.js";
import { evictStaleSkills } from "./skill-writer.js";
import {
  loadServerUrl,
  saveServerUrl,
  clearServerUrl,
} from "./url-config-store.js";
import { clearCredentials } from "./token-store.js";
import {
  loadRemoteTools,
  saveRemoteTools,
  clearRemoteTools,
} from "./remote-tools-cache-store.js";
import {
  REMOTE_TOOLS_ALLOWLIST,
  dispatchRemoteTool,
  fetchAllowedRemoteTools,
  type DispatchContext,
} from "./tools/remote-passthrough.js";
import { resolveSessionId } from "./session-id.js";
import { resolveServerUrlFromEmail } from "./config-search.js";

function readEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = process.env[key];
    if (v === undefined || v === "") continue;
    if (v.startsWith("${")) continue;
    return v;
  }
  return undefined;
}

function resolveServerUrl(): string | undefined {
  const fromEnv = readEnv("GLEAN_MCP_SERVER_URL");
  if (fromEnv) return fromEnv;
  return loadServerUrl();
}

function normalizeServerUrl(raw: string): string {
  const parsed = new URL(raw);
  return `${parsed.origin}/mcp/gateway/proxy`;
}

const SETUP_REQUIRED_TEXT =
  `[SETUP_REQUIRED]\n\n` +
  `To connect, enter your work email (e.g. you@acme.com) and we'll find ` +
  `your Glean instance automatically.\n`;

// A failed lookup asks the user to retry with a corrected email. 
// Admins who must set the URL manually use
// the server_url parameter (documented in the README)
const EMAIL_RESOLVE_FAILED_TEXT =
  `Double-check the email for typos and try again with the corrected email.`;

const SETUP_NEEDED_ERROR =
  "Glean is not configured yet. Call the `setup` tool first to provide " +
  "your Glean Server URL before using find_skills or run_tool.";

// Returned by every non-setup tool when auth is missing or expired. The
// agent should respond by calling `setup` (which drives the OAuth sign-in
// via elicitation + the loopback callback), then retry the original tool
// call. Centralising auth in `setup` keeps the OAuth flow out of every
// other tool.
const AUTH_REDIRECT_TO_SETUP_TEXT =
  "[SETUP_REQUIRED]\n\nAuthentication is required. Call the `setup` tool " +
  "(no arguments) to sign in to Glean, then retry this tool.";

function resolveLogPath(): string {
  const base = process.env.PLUGIN_DATA_DIR || path.join(homedir(), ".glean");
  return path.join(base, "glean-server.log");
}

const LOG_PATH = resolveLogPath();
try {
  const logDir = path.dirname(LOG_PATH);
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(logDir, 0o700);
} catch {
  /* ignore */
}

function logLine(label: string, detail?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const suffix = detail ? ` ${JSON.stringify(detail)}` : "";
  const line = `${ts} ${label}${suffix}\n`;
  try {
    fs.appendFileSync(LOG_PATH, line, { mode: 0o600 });
    fs.chmodSync(LOG_PATH, 0o600);
  } catch {
    /* ignore */
  }
  console.error(line.trimEnd());
}

function resolveSkillsBaseDir(): string {
  if (process.env.SKILLS_BASE_DIR) {
    return process.env.SKILLS_BASE_DIR;
  }
  return path.join(tmpdir(), "glean-skills-cache");
}

const server = new Server(
  { name: "glean", version: "1.0.0" },
  { capabilities: { tools: { listChanged: true } } },
);

let oauthProvider: GleanOAuthClientProvider | undefined;

// Cache of the last successful remote tools/list fetch. Persists for the
// lifetime of the process — and across restarts via the on-disk
// remote-tools-cache-store keyed by server URL — so a transient
// auth/network blip or a fresh process spawn doesn't make `chat` /
// `search` / `read_document` disappear from the surface. Cleared on
// `setup({reset})` and on `setup({server_url})` switching instances.
// Empty until `setup` (or any prior process for this URL) has driven a
// successful tool fetch.
let cachedRemoteTools: Tool[] = loadRemoteTools(resolveServerUrl() ?? "");

function getOAuthProvider(): GleanOAuthClientProvider {
  if (!oauthProvider) {
    oauthProvider = new GleanOAuthClientProvider();
    // Wire onTokensChanged on every fresh provider instance — after a
    // setup({reset}) we recreate the provider, and the new one needs the
    // same tools/list_changed signal so the host re-fetches the dynamic
    // surface as soon as auth flips.
    oauthProvider.onTokensChanged = () => {
      server.sendToolListChanged().catch(() => {
        // Transport not connected yet, or notification serialization
        // failed — the agent still sees the right tools on its next
        // list_tools call.
      });
    };
  }
  return oauthProvider;
}

function getRemoteClientOpts(): RemoteClientOptions {
  return { authProvider: getOAuthProvider() };
}

const FIND_SKILLS_TOOL: Tool = {
  name: "find_skills",
  annotations: { readOnlyHint: true },
  description:
    "Discover available Glean skills and their resolved tool dependencies. " +
    "This is a search engine over skill blueprints and the tools they expose: " +
    "match on the core action, not the full request. " +
    "Call this tool FIRST whenever the user's request cannot be fulfilled by your " +
    "current tools — especially for tasks involving enterprise apps (Jira, Slack, " +
    "Google Workspace, Salesforce, etc.) or any action you don't already have a " +
    "tool for. Before calling, break the user's request into small, task-atomic " +
    "queries — keep only the action and drop the surrounding context (recipients, " +
    "timing, reasons, constraints) — and pass each as a separate entry in the " +
    "'queries' array. For example, for \"Send an email to X for tomorrow's demo " +
    "meeting as leadership will be visiting\", the single query is \"send an email\". " +
    "Discovered skills are written to local files and an XML skill " +
    "index with usage instructions is returned. " +
    "If a returned skill lists no tools and its playbook does not let you " +
    "complete the task, first check whether tools already in scope can do it — " +
    "tools from other skills in this response, tools from earlier find_skills " +
    "calls, or tools you can already call directly. If none fit, call find_skills " +
    "again with reworded or additional queries. " +
    "If a previously-cached skill file referenced from memory or instructions " +
    "is missing on disk, call find_skills again to re-fetch it before failing. " +
    "To use a returned skill: (1) pick the most relevant from the returned " +
    "skills; (2) read its SKILL.md for instructions; (3) read each tool's JSON " +
    "file (tools/TOOL_NAME.json) for the exact server_id, name, and inputSchema " +
    "(exact parameter names and types); (4) call run_tool with the server_id, " +
    "tool_name (from the name field), and arguments matching the inputSchema. " +
    "Never guess parameter names — read the tool JSON file first.",
  inputSchema: {
    type: "object" as const,
    properties: {
      queries: {
        type: "array",
        items: { type: "string" },
        maxItems: 3,
        description:
          "Atomic sub-task descriptions broken down from the user's request. " +
          "Each query should describe one specific action (e.g., 'search emails', " +
          "'create calendar event').",
      },
    },
    required: ["queries"],
  },
};

const RUN_TOOL_TOOL: Tool = {
  name: "run_tool",
  description:
    "Execute a tool on a downstream MCP server. Before calling this tool, " +
    "you MUST read the tool's JSON file from the find_skills output to get " +
    "the exact server_id, tool_name, and input_schema. Pass arguments that match " +
    "the input_schema exactly — do not guess parameter names.",
  inputSchema: {
    type: "object" as const,
    properties: {
      server_id: {
        type: "string",
        description: "The ID of the downstream MCP server.",
      },
      tool_name: {
        type: "string",
        description: "The name of the tool to invoke.",
      },
      arguments: {
        type: "object",
        description: "Optional arguments to pass to the downstream tool.",
      },
      file_args: {
        type: "object",
        description:
          "Optional map from argument name to absolute local file path. " +
          "The plugin reads each file and substitutes its contents into the " +
          "corresponding key in `arguments` before calling the remote tool. " +
          "If the target parameter is typed as an object or array in the " +
          "tool's inputSchema, the file is parsed as JSON and injected as " +
          "structured data; otherwise its contents are injected as a UTF-8 " +
          "string. Use this to keep large values out of the inline call — " +
          "long-form text (Slack message bodies, Confluence pages, doc " +
          "contents) or a large structured argument (e.g. an agent spec). " +
          "Paths must be absolute. Each file must be ≤ 1 MB (override " +
          "via GLEAN_FILE_ARG_MAX_BYTES). A key in `file_args` must not " +
          "also appear in `arguments`.",
        additionalProperties: { type: "string" },
      },
    },
    required: ["server_id", "tool_name"],
  },
};

const SETUP_TOOL: Tool = {
  name: "setup",
  annotations: { readOnlyHint: true },
  description:
    "Check or configure the Glean connection. Setup completes in three " +
    "stages: (1) resolve and save the Server URL, (2) authenticate, " +
    "(3) fetch the remote tool catalog. Call with no arguments to advance " +
    "through the next missing stage. Call with email to look up and " +
    "(re)configure user's Glean instance. Call with reset=true to clear " +
    "all configuration.",
  inputSchema: {
    type: "object" as const,
    properties: {
      email: {
        type: "string",
        description:
          "User's work email (e.g. you@acme.com). Used to look up and " +
          "configure your Glean Server instance (QE) URL automatically.",
      },
      server_url: {
        type: "string",
        description:
          "Advanced. Sets the Glean Server (QE) URL directly instead of " +
          "resolving it from email. Do not suggest this to users — email " +
          "is the preferred path. Documented in the README for technical " +
          "users who ask for it explicitly.",
      },
      reset: {
        type: "boolean",
        description: "Clear cached URL, credentials, and remote tool cache.",
      },
    },
    required: [],
  },
};

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const runTool: Tool = {
    ...RUN_TOOL_TOOL,
    annotations: runToolAnnotations(
      process.env.ENABLE_HITL === "true",
      !!server.getClientCapabilities()?.elicitation,
    ),
  };
  const staticTools: Tool[] = [FIND_SKILLS_TOOL, runTool, SETUP_TOOL];

  // One structured line on every return path, so "why don't my tools appear?"
  // is answerable from the log alone: `static` is constant, `names` lists the
  // dynamic tools we actually surfaced (freshly fetched or served from cache),
  // and `state` names the path we took. The allow-list only ever drops tools
  // outside our fixed set, so a missing allow-listed name (e.g. `chat`) means
  // the backend never returned it. Only tool *names*, counts and the state
  // tag are logged — never argument values, which can carry PII/secrets.
  const serve = (state: string, dynamic: Tool[]): { tools: Tool[] } => {
    logLine("tools-list.served", {
      static: staticTools.length,
      dynamic: dynamic.length,
      names: dynamic.map((t) => t.name),
      state,
    });
    return { tools: [...staticTools, ...dynamic] };
  };

  // Pre-auth gate: tokens() is sync. When unauthenticated (or unconfigured)
  // skip the remote round-trip — but keep surfacing whatever we successfully
  // fetched earlier in this process so a token expiry doesn't make the
  // dynamic surface vanish. Calls to non-setup tools route through
  // [SETUP_REQUIRED] / setup when URL or tokens are missing; only setup
  // emits [AUTHENTICATION_REQUIRED] during the sign-in step.
  const serverUrl = resolveServerUrl();
  if (!serverUrl) {
    return serve("unconfigured", cachedRemoteTools);
  }
  const provider = getOAuthProvider();
  if (!provider.tokens()) {
    return serve("unauthenticated", cachedRemoteTools);
  }

  let remoteClient;
  try {
    remoteClient = await createRemoteClient(
      serverUrl,
      getRemoteClientOpts(),
      `tools-list-${process.pid}`,
    );
  } catch (err) {
    // Auth expired mid-session, network blip, schema parse error — serve
    // static + last-known dynamic tools. Agent isn't blocked.
    const msg = err instanceof Error ? err.message : String(err);
    logLine("connect.backend-error", { label: "tools/list", msg });
    return serve("connect-error", cachedRemoteTools);
  }

  try {
    const remoteTools = await fetchAllowedRemoteTools(remoteClient);
    cachedRemoteTools = remoteTools;
    saveRemoteTools(serverUrl, remoteTools);
    return serve("fetched", remoteTools);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logLine("tools-list.fetch-failed", { label: "tools/list", msg });
    return serve("fetch-failed", cachedRemoteTools);
  } finally {
    await remoteClient.close();
  }
});

// How long to wait for the user to complete the browser sign-in (open the
// authorize URL, sign in, redirect to the loopback) before giving up. The
// loopback capture is the real wait; this bounds the blocking setup call.
const SIGN_IN_WAIT_MS = 300_000;

type RemoteClient = Awaited<ReturnType<typeof createRemoteClient>>;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function backendErrorResult(label: string, err: unknown): CallToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  logLine("connect.backend-error", { label, msg });
  return {
    content: [
      { type: "text", text: `Failed to connect to Glean backend: ${msg}` },
    ],
    isError: true,
  };
}

// Connect to the Glean backend, driving the OAuth sign-in if needed. The
// loopback callback server captures the authorization code in-context (no
// paste-back). The redirect URI is the fixed loopback URL the provider
// reports, so DCR + the authorize request use it directly.
async function connectWithSignIn(
  serverUrl: string,
): Promise<
  { ok: true; client: RemoteClient } | { ok: false; result: CallToolResult }
> {
  const provider = getOAuthProvider();

  // Happy path: already authenticated — connect directly, no callback server.
  if (provider.tokens()) {
    try {
      const client = await createRemoteClient(
        serverUrl,
        getRemoteClientOpts(),
        `setup-${process.pid}`,
      );
      return { ok: true, client };
    } catch (err) {
      if (!(err instanceof AuthRequiredError)) {
        return { ok: false, result: backendErrorResult("setup", err) };
      }
      // Tokens expired — fall through to the sign-in path below.
    }
  }

  let handle;
  try {
    handle = await startCallbackServer();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logLine("setup.callback-server-failed", { msg });
    return {
      ok: false,
      result: {
        content: [
          {
            type: "text",
            text: `Could not start the local sign-in listener: ${msg}. Retry setup.`,
          },
        ],
        isError: true,
      },
    };
  }

  try {
    let authUrl: string;
    try {
      const client = await createRemoteClient(
        serverUrl,
        getRemoteClientOpts(),
        `setup-${process.pid}`,
      );
      // Unexpectedly connected without needing auth — done.
      return { ok: true, client };
    } catch (err) {
      if (!(err instanceof AuthRequiredError)) {
        return { ok: false, result: backendErrorResult("setup", err) };
      }
      authUrl = err.authUrl;
    }

    // Open the Glean sign-in page; the loopback (already listening) captures
    // the redirect automatically once the user signs in.
    openBrowser(authUrl);

    let code: string;
    try {
      code = await withTimeout(handle.code, SIGN_IN_WAIT_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logLine("setup.sign-in-wait-failed", { msg });
      return {
        ok: false,
        result: {
          content: [
            {
              type: "text",
              text:
                "Timed out waiting for sign-in to complete. Run setup again " +
                "to retry.",
            },
          ],
          isError: true,
        },
      };
    }

    provider.setPendingAuthCode(code);
    try {
      const client = await createRemoteClient(
        serverUrl,
        getRemoteClientOpts(),
        `setup-${process.pid}`,
      );
      return { ok: true, client };
    } catch (err) {
      logLine("setup.finish-auth-failed", {
        msg: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, result: backendErrorResult("setup", err) };
    }
  } finally {
    closeCallbackServer();
  }
}

/**
 * Drive the setup flow forward until either complete (URL ✓ + tokens ✓ +
 * dynamic tools fetched ✓) or blocked on a user action. Used both by
 * `setup()` with no args and as the tail of `setup({server_url})`.
 */
async function advanceSetup(): Promise<CallToolResult> {
  const serverUrl = resolveServerUrl();
  if (!serverUrl) {
    return { content: [{ type: "text", text: SETUP_REQUIRED_TEXT }] };
  }

  const conn = await connectWithSignIn(serverUrl);
  if (!conn.ok) return conn.result;
  const remoteClient = conn.client;

  try {
    const remoteTools = await fetchAllowedRemoteTools(remoteClient);
    cachedRemoteTools = remoteTools;
    saveRemoteTools(serverUrl, remoteTools);
    const toolNames = remoteTools.map((t) => t.name).join(", ") || "(none)";
    return {
      content: [
        {
          type: "text",
          text:
            `Glean setup is complete.\n` +
            `Server URL: ${serverUrl}\n` +
            `Authenticated: yes\n` +
            `Remote tools: ${toolNames}\n\n` +
            `You can now use find_skills, run_tool, and any of the listed ` +
            `remote tools.`,
        },
      ],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logLine("setup.fetch-tools-failed", { msg });
    return {
      content: [
        {
          type: "text",
          text:
            `Authenticated, but failed to fetch the remote tool catalog: ${msg}.\n` +
            `Server URL: ${serverUrl}\n\n` +
            `Try calling setup again to retry, or setup({reset:true}) to ` +
            `start over.`,
        },
      ],
      isError: true,
    };
  } finally {
    await remoteClient.close();
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  // Allow-listed remote tools (chat/search/read_document) — only valid once
  // setup has provided a server URL. Auth is handled by dispatchRemoteTool
  // via the standard [AUTHENTICATION_REQUIRED] flow.
  if (REMOTE_TOOLS_ALLOWLIST.has(name)) {
    const serverUrl = resolveServerUrl();
    if (!serverUrl) {
      return {
        content: [{ type: "text", text: SETUP_NEEDED_ERROR }],
        isError: true,
      };
    }
    // Pre-check tokens so an unauth'd call doesn't reach
    // dispatchRemoteTool → createRemoteClient → SDK 401 →
    // redirectToAuthorization (which opens the browser). Only `setup`
    // is allowed to drive the OAuth flow.
    if (!getOAuthProvider().tokens()) {
      return {
        content: [{ type: "text", text: AUTH_REDIRECT_TO_SETUP_TEXT }],
      };
    }
    const dispatchCtx: DispatchContext = {
      serverUrl,
      remoteClientOpts: getRemoteClientOpts(),
      authRedirectText: AUTH_REDIRECT_TO_SETUP_TEXT,
      logLine,
    };
    return await dispatchRemoteTool(name, args, dispatchCtx);
  }

  switch (name) {
    case "find_skills": {
      const serverUrl = resolveServerUrl();
      if (!serverUrl) {
        return {
          content: [{ type: "text", text: SETUP_NEEDED_ERROR }],
          isError: true,
        };
      }

      // Pre-check tokens before connecting so an unauth'd call doesn't
      // trip the SDK's 401 → redirectToAuthorization path (which opens a
      // browser tab). Only `setup` should ever drive OAuth.
      if (!getOAuthProvider().tokens()) {
        return {
          content: [{ type: "text", text: AUTH_REDIRECT_TO_SETUP_TEXT }],
        };
      }

      const sessionId = resolveSessionId();

      const skillsBaseDir = resolveSkillsBaseDir();

      let remoteClient;
      try {
        remoteClient = await createRemoteClient(
          serverUrl,
          getRemoteClientOpts(),
          sessionId,
        );
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          return {
            content: [{ type: "text", text: AUTH_REDIRECT_TO_SETUP_TEXT }],
          };
        }
        const msg = err instanceof Error ? err.message : String(err);
        logLine("connect.backend-error", { label: "find_skills", msg });
        return {
          content: [
            {
              type: "text",
              text: `Failed to connect to Glean backend: ${msg}`,
            },
          ],
          isError: true,
        };
      }
      try {
        const text = await handleFindSkills(
          remoteClient,
          skillsBaseDir,
          args,
        );
        return { content: [{ type: "text", text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`find_skills: execution failed: ${msg}`);
        return {
          content: [{ type: "text", text: `find_skills failed: ${msg}` }],
          isError: true,
        };
      } finally {
        await remoteClient.close();
      }
    }

    case "run_tool": {
      const serverUrl = resolveServerUrl();
      if (!serverUrl) {
        return {
          content: [{ type: "text", text: SETUP_NEEDED_ERROR }],
          isError: true,
        };
      }

      // Pre-check tokens before connecting so an unauth'd call doesn't
      // trip the SDK's 401 → redirectToAuthorization path (which opens a
      // browser tab). Only `setup` should ever drive OAuth.
      if (!getOAuthProvider().tokens()) {
        return {
          content: [{ type: "text", text: AUTH_REDIRECT_TO_SETUP_TEXT }],
        };
      }

      const sessionId = resolveSessionId();

      let remoteClient;
      try {
        remoteClient = await createRemoteClient(
          serverUrl,
          getRemoteClientOpts(),
          sessionId,
        );
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          return {
            content: [{ type: "text", text: AUTH_REDIRECT_TO_SETUP_TEXT }],
          };
        }
        const msg = err instanceof Error ? err.message : String(err);
        logLine("connect.backend-error", { label: "run_tool", msg });
        return {
          content: [
            {
              type: "text",
              text: `Failed to connect to Glean backend: ${msg}`,
            },
          ],
          isError: true,
        };
      }
      try {
        const skillsBaseDir = resolveSkillsBaseDir();
        return await handleRunTool(remoteClient, server, skillsBaseDir, args);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`run_tool: execution failed: ${msg}`);
        return {
          content: [{ type: "text", text: `run_tool failed: ${msg}` }],
          isError: true,
        };
      } finally {
        await remoteClient.close();
      }
    }

    case "setup": {
      logLine("client.capabilities", {
        elicitation: server.getClientCapabilities()?.elicitation ?? null,
        clientInfo: server.getClientVersion() ?? null,
      });
      if (args.reset === true) {
        clearServerUrl();
        clearCredentials();
        clearRemoteTools();
        oauthProvider = undefined;
        cachedRemoteTools = [];
        logLine("setup.reset");
        // Fire-and-forget — tools list is shorter without the dynamic
        // surface; the host should re-fetch on its next idle cycle.
        server.sendToolListChanged().catch(() => {
          /* transport may not be connected yet; harmless */
        });
        return {
          content: [
            {
              type: "text",
              text:
                "Glean configuration has been reset. Call setup again with " +
                "your email to reconfigure.",
            },
          ],
        };
      }

      // An explicit server_url wins; otherwise derive the QE URL from the
      // user's email via the public config/search lookup.
      let rawUrl =
        typeof args.server_url === "string" ? args.server_url.trim() : "";
      const email = typeof args.email === "string" ? args.email.trim() : "";

      if (!rawUrl && email) {
        const resolved = await resolveServerUrlFromEmail(email);
        if (!resolved.ok) {
          logLine("setup.email-resolve-failed", { email, error: resolved.error });
          return {
            content: [
              {
                type: "text",
                text: `${resolved.error}\n\n${EMAIL_RESOLVE_FAILED_TEXT}`,
              },
            ],
            isError: true,
          };
        }
        rawUrl = resolved.queryUrl;
        logLine("setup.email-resolved", { email, queryUrl: rawUrl });
      }

      if (rawUrl) {
        let normalized: string;
        try {
          normalized = normalizeServerUrl(rawUrl);
        } catch {
          return {
            content: [
              {
                type: "text",
                text:
                  `Invalid URL: "${rawUrl}". Please provide the Server instance (QE) URL ` +
                  `(e.g. https://acme-be.glean.com), or pass your email instead.`,
              },
            ],
            isError: true,
          };
        }

        try {
          saveServerUrl(normalized);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [
              { type: "text", text: `Failed to save configuration: ${msg}` },
            ],
            isError: true,
          };
        }

        // New instance — clear stale auth state. The on-disk remote-tool
        // cache for the previous URL is left intact (so switching back is
        // instant); we just rehydrate from whatever cache exists for the
        // newly configured URL — empty for a first-time server.
        clearCredentials();
        oauthProvider = undefined;
        cachedRemoteTools = loadRemoteTools(normalized);
        logLine("setup.configured", { serverUrl: normalized });
        // Fall through to advanceSetup, which will now find URL ✓ and try
        // to drive auth + tool fetch in the same call.
      }

      return await advanceSetup();
    }

    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
});

async function main() {
  // Run once per session at MCP server startup.
  const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  try {
    await evictStaleSkills(resolveSkillsBaseDir(), ONE_WEEK_MS, logLine);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logLine("evict-stale-skills.failed", { msg });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
