import { Console } from "node:console";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Writable } from "node:stream";
import vm from "node:vm";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { callRemoteTool } from "../remote-client.js";
import {
  discoverTools,
  findToolMetaByName,
  normalizeSkillsBaseDirs,
  writeCoreTools,
  type HeadTool,
  type SkillsBaseDirInput,
  type ToolMeta,
} from "../skill-tools.js";
import { invokeTool, requestToolApproval } from "./run-tool.js";
import { TIMEOUT_MS, MAX_CALLS, TOOL_ERROR_MAX } from "./run-code/limits.js";
import { shapeStr } from "./run-code/shape.js";
import { extractText, normalizeForSummary } from "./run-code/output.js";
import {
  type RunCodeEnvelope,
  makeEnvelope,
  envelopeError,
} from "./run-code/envelope.js";
import { PREAMBLE, scanReferencedTools, bindingsSource } from "./run-code/preamble.js";

// ---------------------------------------------------------------------------
// run_code engine: the persistent node:vm context, the host dispatch bridge,
// and the orchestrator. The stateless pieces (limits, shape inference, value
// serialization, envelope assembly, the in-VM PREAMBLE + PTC_ binding
// generation) live in ./run-code/*. This file owns the MUTABLE singletons
// (`ctx`, `current`) and the closure (`ptcDispatch`) the VM calls, which is
// why they stay together.
// ---------------------------------------------------------------------------

// Per-process persistent session. Intentionally simple: ONE vm context that
// lives for the lifetime of the plugin process. Only a BARE assignment
// (no var/let/const) attaches to the context global and persists across
// run_code calls — var/let/const are all function-local to the wrapping async
// IIFE and do NOT persist. Persists until the process exits or
// run_code({reset:true}). No TTL / LRU / heap eviction — host owns lifecycle.

let ctx: vm.Context | undefined;
let ctxFresh = false;
const sessionApproved = new Set<string>();

// PoC runtime: make a real CommonJS loader available inside the VM. This is
// intentionally unrestricted — `require("node:child_process")`, process access,
// networking, and every other Node builtin are all possible. Third-party
// packages resolve from the installed bundle's location and only work when a
// physical node_modules tree is present there or in a parent directory; packages
// inlined into our single-file bundle are not dynamically requireable by name.
const runtimeRequire = createRequire(import.meta.url);

// A normal Node Console API whose output is captured in the run_code envelope
// rather than written to process.stdout. The latter is the MCP JSON-RPC transport
// and would be corrupted by ordinary console.log output. Direct process.stdout
// remains reachable in this deliberately unrestricted PoC and is documented as
// unsafe to write to.
const consoleStream = new Writable({
  write(chunk, _encoding, callback) {
    const text = String(chunk).replace(/\r?\n$/, "");
    if (current && text) current.stdout.push(text);
    callback();
  },
});
const runtimeConsole = new Console({
  stdout: consoleStream,
  stderr: consoleStream,
  colorMode: false,
});

// node:vm starts with JavaScript language intrinsics but omits most familiar
// Node/web globals. Pass through the host's standard globals so model-generated
// code can look like ordinary Node 20+ code instead of learning a custom API.
const NODE_GLOBAL_NAMES = [
  "process",
  "Buffer",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "setImmediate",
  "clearImmediate",
  "queueMicrotask",
  "URL",
  "URLSearchParams",
  "TextEncoder",
  "TextDecoder",
  "fetch",
  "Headers",
  "Request",
  "Response",
  "FormData",
  "Blob",
  "File",
  "AbortController",
  "AbortSignal",
  "structuredClone",
  "atob",
  "btoa",
  "performance",
  "crypto",
] as const;

function nodeRuntimeGlobals(): Record<string, unknown> {
  const host = globalThis as Record<string, unknown>;
  return Object.fromEntries(
    NODE_GLOBAL_NAMES.flatMap((name) =>
      host[name] === undefined ? [] : [[name, host[name]]],
    ),
  );
}

interface CallState {
  remoteClient: Client;
  mcpServer: Server;
  skillsBaseDirs: string[];
  canonicalToolNames: string[];
  toolsByName: Map<string, ToolMeta>;
  approved: Set<string>;
  stdout: string[];
  calls: number;
  deadline: number;
  aborted: boolean;
}

// The active call's state. Host functions injected into the vm read this; a
// module-level mutex guarantees only one run_code executes at a time, so a
// single slot is safe.
let current: CallState | undefined;

// Simple FIFO mutex so the shared context + `current` are never raced.
let lockTail: Promise<void> = Promise.resolve();
function acquireLock(): Promise<() => void> {
  let release!: () => void;
  const next = new Promise<void>((res) => (release = res));
  const prev = lockTail;
  lockTail = lockTail.then(() => next);
  return prev.then(() => release);
}

function ensureContext(reset: boolean): void {
  if (reset || !ctx) {
    ctx = vm.createContext({
      ...nodeRuntimeGlobals(),
      // Full local Node execution for this deliberately dangerous PoC. The
      // model can load any resolvable CommonJS/builtin module, including
      // node:child_process, and receives familiar Node globals. Dynamic import
      // is not configured; use require().
      require: runtimeRequire,
      console: runtimeConsole,
      // Keep the two most common modules available without a require call.
      fs,
      path,
      // Host bridges — stable closures reading module-level `current`.
      __ptcDispatch: ptcDispatch,
      __ptcShape: (v: unknown) => shapeStr(v),
      __ptcPrint: (s: string) => {
        if (current) current.stdout.push(s);
      },
    });
    // CommonJS code often refers to `global`; make it the context global rather
    // than leaking the host realm's global object.
    (ctx as unknown as Record<string, unknown>).global = ctx;
    vm.runInContext(PREAMBLE, ctx, { filename: "ptc-preamble.js" });
    sessionApproved.clear();
    ctxFresh = true;
  } else {
    ctxFresh = false;
  }
}

// The bridge each PTC_ binding calls. Enforces the runtime allowlist
// (just-in-time approval for any tool not bulk-approved), the call budget, and
// the wall-clock deadline. A failed tool call THROWS (`PTC_<tool> failed: …`)
// so the cell is self-contained: it either resolves to a ToolResult or throws.
async function ptcDispatch(
  toolName: string,
  args: unknown,
): Promise<{ content: unknown; text: string; structured?: unknown }> {
  const st = current;
  if (!st) throw new Error("PTC runtime is not active");
  if (st.aborted || Date.now() > st.deadline) {
    st.aborted = true;
    throw new Error("run_code wall-clock timeout exceeded");
  }
  const meta = st.toolsByName.get(toolName);
  if (!meta) {
    const folded = toolName.toLowerCase();
    const caseMatches = st.canonicalToolNames.filter(
      (name) => name.toLowerCase() === folded,
    );
    const caseHint =
      caseMatches.length > 1
        ? ` Case-insensitive name is ambiguous: ${caseMatches.map((n) => `PTC_${n}`).join(", ")}.`
        : "";
    throw new Error(
      `Unknown tool PTC_${toolName} — not found in discovered skills.` +
        caseHint +
        ` Call find_skills in this plugin/session first, then use the exact tool ` +
        `name. Scanned cache roots: ${st.skillsBaseDirs.join(", ")}.`,
    );
  }
  if (st.calls >= MAX_CALLS()) {
    throw new Error(`run_code tool-call budget exceeded (${MAX_CALLS()} calls)`);
  }

  // Runtime allowlist backstop: anything not bulk-approved prompts now.
  const canonicalToolName = meta.toolName;
  if (meta.requiresApproval && !st.approved.has(canonicalToolName)) {
    const outcome = await requestToolApproval(
      st.mcpServer,
      st.skillsBaseDirs,
      canonicalToolName,
      meta.serverId,
      {
        failClosed: true,
        // Pass what we already know so requestToolApproval doesn't re-scan the
        // whole skills tree from disk just to recheck requires_approval.
        requiresApproval: meta.requiresApproval,
        description: meta.description,
        message:
          `**${canonicalToolName}** (not pre-approved) is about to run.\n` +
          (meta.description ? `${meta.description}\n` : "") +
          `\nAccept to run it, or decline to stop.`,
      },
    );
    if (outcome.kind === "declined") {
      throw new Error(`Approval declined for PTC_${canonicalToolName}.`);
    }
    st.approved.add(canonicalToolName);
    sessionApproved.add(canonicalToolName);
  }

  st.calls++;

  let res;
  try {
    // Head/first-class tools dispatch directly by name; skill tools go through
    // the run_tool gateway (invokeTool handles file_args + server_id shaping).
    res = meta.direct
      ? await callRemoteTool(
          st.remoteClient,
          canonicalToolName,
          (args ?? {}) as Record<string, unknown>,
        )
      : await invokeTool(st.remoteClient, {
          serverId: meta.serverId,
          toolName: canonicalToolName,
          arguments: args ?? {},
        });
  } catch (err) {
    // Transport-level failure (network/timeout/lost response). Surface it as a
    // PTC_ failure so the cell sees a consistent error shape.
    const m = (err instanceof Error ? err.message : String(err)).slice(0, TOOL_ERROR_MAX);
    throw new Error(`PTC_${toolName} failed: ${m}`);
  }

  const text = extractText(res);
  const structured = (res as { structuredContent?: unknown }).structuredContent;
  if (res.isError) {
    // The tool ran but reported an error. Throw with the reason so the failure
    // is never silent — the model handles it with try/catch or lets it abort.
    throw new Error(
      `PTC_${toolName} failed: ${text.slice(0, TOOL_ERROR_MAX) || "(tool reported an error)"}`,
    );
  }
  return { content: res.content, text, structured };
}

export async function handleRunCode(
  remoteClient: Client,
  mcpServer: Server,
  skillsBaseDirInput: SkillsBaseDirInput,
  args: Record<string, unknown>,
  headTools: HeadTool[] = [],
): Promise<CallToolResult> {
  const code = args.code;
  if (typeof code !== "string" || code.trim() === "") {
    return envelopeError("`code` must be a non-empty string.", { isError: true });
  }

  const reset = args.reset === true;
  const skillsBaseDirs = normalizeSkillsBaseDirs(skillsBaseDirInput);
  const primarySkillsBaseDir = skillsBaseDirs[0];
  if (!primarySkillsBaseDir) {
    return envelopeError("No skills cache root is configured.", { isError: true });
  }

  const release = await acquireLock();
  try {
    ensureContext(reset);

    // Materialize head/first-class tools in the primary/write cache, then read
    // metadata from every configured root (primary first, project fallback).
    await writeCoreTools(primarySkillsBaseDir, headTools);

    const allTools = await discoverTools(skillsBaseDirs);
    const toolsByName = new Map<string, ToolMeta>();
    // Bind direct (head) tools FIRST so they own the bare PTC_<name>; on any
    // name overlap the first binding wins (deterministic).
    const ordered = [
      ...allTools.filter((t) => t.direct),
      ...allTools.filter((t) => !t.direct),
    ];
    for (const t of ordered) {
      if (!toolsByName.has(t.toolName)) toolsByName.set(t.toolName, t);
    }

    const referenced = scanReferencedTools(code);

    // Tool names are MCP identifiers and canonically preserve case, but models
    // frequently uppercase placeholder examples (PTC_GET_AGENT vs get_agent).
    // Add an alias only when the case-insensitive match is unique; exact names
    // and primary-root precedence remain unchanged. ptcDispatch always sends
    // meta.toolName (the canonical spelling) to the backend.
    for (const requestedName of referenced) {
      if (toolsByName.has(requestedName)) continue;
      const match = findToolMetaByName(ordered, requestedName);
      if (match) toolsByName.set(requestedName, match);
    }

    // ---- Bulk pre-scan approval -------------------------------------------
    const hitl = process.env.ENABLE_HITL === "true";
    const canElicit = !!mcpServer.getClientCapabilities()?.elicitation;
    const approved = new Set<string>(sessionApproved);
    const needApproval = referenced
      .map((n) => toolsByName.get(n))
      .filter((m): m is ToolMeta => !!m && m.requiresApproval && !approved.has(m.toolName));

    if (needApproval.length && hitl && canElicit) {
      const list = needApproval
        .map((m) => `• PTC_${m.toolName} — ${m.description?.split("\n")[0] || m.serverId}`)
        .join("\n");
      const message =
        `This code will run the following approval-required tools:\n\n${list}\n\n` +
        `Some may run inside loops — exact counts depend on data fetched at runtime.\n` +
        `Accept to approve all of them for this session, or decline to run nothing.`;
      try {
        const result = await mcpServer.elicitInput({
          message,
          requestedSchema: { type: "object", properties: {} } as never,
        });
        if (result.action !== "accept") {
          return envelopeError("Bulk approval declined; nothing ran.", {
            isError: true,
          });
        }
        for (const m of needApproval) {
          approved.add(m.toolName);
          sessionApproved.add(m.toolName);
        }
      } catch {
        // Elicitation channel broke — fail closed for code mode.
        return envelopeError(
          "Approval channel unavailable; refusing to run approval-required tools.",
          { isError: true },
        );
      }
    } else if (needApproval.length) {
      // No HITL configured (parity with run_tool): run without prompting.
      for (const m of needApproval) approved.add(m.toolName);
    }

    const state: CallState = {
      remoteClient,
      mcpServer,
      skillsBaseDirs,
      canonicalToolNames: [...new Set(ordered.map((tool) => tool.toolName))],
      toolsByName,
      approved,
      stdout: [],
      calls: 0,
      deadline: Date.now() + TIMEOUT_MS(),
      aborted: false,
    };
    current = state;

    // Refresh bindings (tool set may have changed) + run the user cell wrapped
    // in an async IIFE so top-level await and `return` work. Non-strict so a
    // bare assignment (`x = ...`) attaches to the persistent context global.
    // Bind every known tool plus any referenced-but-unknown name, so an
    // unknown PTC_ call yields a clear "Unknown tool" error from the bridge
    // rather than a raw ReferenceError.
    const bindNames = [...new Set([...toolsByName.keys(), ...referenced])];
    // Bindings on line 1, the async wrapper on line 2, user code from line 3.
    // Bare assignment inside the async arrow attaches to the context global
    // (persists); top-level await + `return` work.
    const prefix = bindingsSource(bindNames) + "\n__ptcCell = (async () => {\n";
    const script = prefix + code + "\n})();\n";

    let value: unknown;
    let threw = false;
    let errorMessage = "";
    let timer: NodeJS.Timeout | undefined;
    try {
      // The `timeout` option only bounds the SYNCHRONOUS portion (guards an
      // infinite sync loop before the first await); the real wall-clock guard
      // for async tool calls is the Promise.race below + the ptcDispatch deadline.
      vm.runInContext(script, ctx as vm.Context, {
        filename: "ptc-cell.js",
        timeout: TIMEOUT_MS(),
      });
      const cellPromise = (ctx as unknown as Record<string, unknown>)
        .__ptcCell as Promise<unknown>;
      const timeoutPromise = new Promise<never>((_res, rej) => {
        timer = setTimeout(() => {
          state.aborted = true;
          rej(new Error("run_code wall-clock timeout exceeded"));
        }, TIMEOUT_MS());
      });
      value = await Promise.race([cellPromise, timeoutPromise]);
    } catch (err) {
      // The error may originate in the vm realm, so `instanceof Error` is false
      // — read .message as a property (works cross-realm). Track `threw`
      // separately: `ok` must reflect did-NOT-throw, not the truthiness of the
      // message (a `throw new Error("")` is still a failure).
      threw = true;
      const e = err as { message?: unknown };
      const m = typeof e?.message === "string" ? e.message : String(err);
      errorMessage = m === "" ? "(error)" : m;
    } finally {
      if (timer) clearTimeout(timer);
      state.aborted = true;
    }

    // The cell is self-contained: it either returned a value or threw. A failed
    // tool call throws (`PTC_<tool> failed: …`), so `ok` is simply "didn't throw".
    // Value and stdout come back VERBATIM — the host/harness handles oversized
    // output; we no longer redirect to files.
    const ok = !threw;
    const stdout = state.stdout.join("\n");

    const envelope: RunCodeEnvelope = { ok };
    if (ok) envelope.value = normalizeForSummary(value);
    if (stdout) envelope.stdout = stdout;
    if (ctxFresh) envelope.session = { fresh: true };
    if (threw) envelope.error = { message: errorMessage };

    return makeEnvelope(envelope, !ok);
  } finally {
    current = undefined;
    release();
  }
}
