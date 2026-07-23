import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  resolveFileArgs,
  buildRemoteArgs,
  FileArgsError,
  handleRunTool,
  runToolAnnotations,
  approvalRequestedSchema,
  readApprovalScope,
} from "../src/tools/run-tool.js";
import {
  buildCompactArgs,
  formatArgumentsForFile,
} from "../src/tools/approval-args.js";
import {
  isToolAlwaysAllowed,
  setToolAlwaysAllowed,
  clearToolPermissions,
} from "../src/tool-permissions-store.js";

describe("resolveFileArgs", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-args-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    delete process.env.GLEAN_FILE_ARG_MAX_BYTES;
  });

  it("returns base args unchanged when file_args is undefined", async () => {
    const result = await resolveFileArgs(undefined, { a: 1 });
    expect(result).toEqual({ a: 1 });
  });

  it("returns base args unchanged when file_args is null", async () => {
    const result = await resolveFileArgs(null, { a: 1 });
    expect(result).toEqual({ a: 1 });
  });

  it("returns base args unchanged when file_args is empty", async () => {
    const result = await resolveFileArgs({}, { a: 1 });
    expect(result).toEqual({ a: 1 });
  });

  it("reads file content and merges into args", async () => {
    const file = path.join(tmpDir, "draft.md");
    await fs.writeFile(file, "# Hello world\n\nlong content");

    const result = await resolveFileArgs({ body: file }, { channel: "C1" });

    expect(result).toEqual({
      channel: "C1",
      body: "# Hello world\n\nlong content",
    });
  });

  it("supports multiple file_args entries", async () => {
    const a = path.join(tmpDir, "a.md");
    const b = path.join(tmpDir, "b.md");
    await fs.writeFile(a, "content A");
    await fs.writeFile(b, "content B");

    const result = await resolveFileArgs(
      { body: a, summary: b },
      { channel: "C1" },
    );

    expect(result).toEqual({
      channel: "C1",
      body: "content A",
      summary: "content B",
    });
  });

  it("throws when file_args is not an object", async () => {
    await expect(resolveFileArgs("nope", {})).rejects.toThrow(FileArgsError);
    await expect(resolveFileArgs("nope", {})).rejects.toThrow(
      /must be an object/,
    );
  });

  it("throws when file_args is an array", async () => {
    await expect(resolveFileArgs(["a", "b"], {})).rejects.toThrow(
      /must be an object/,
    );
  });

  it("throws when path is not a string", async () => {
    await expect(
      resolveFileArgs({ body: 42 }, {}),
    ).rejects.toThrow(/non-empty string/);
  });

  it("throws when path is empty string", async () => {
    await expect(
      resolveFileArgs({ body: "" }, {}),
    ).rejects.toThrow(/non-empty string/);
  });

  it("throws when path is not absolute", async () => {
    await expect(
      resolveFileArgs({ body: "draft.md" }, {}),
    ).rejects.toThrow(/absolute/);
  });

  it("throws when file does not exist", async () => {
    await expect(
      resolveFileArgs({ body: path.join(tmpDir, "nope.md") }, {}),
    ).rejects.toThrow(FileArgsError);
  });

  it("throws when path is a directory", async () => {
    await expect(
      resolveFileArgs({ body: tmpDir }, {}),
    ).rejects.toThrow(/regular file/);
  });

  it("throws when file exceeds size cap", async () => {
    process.env.GLEAN_FILE_ARG_MAX_BYTES = "10";
    const file = path.join(tmpDir, "big.md");
    await fs.writeFile(file, "this is more than 10 bytes");

    await expect(resolveFileArgs({ body: file }, {})).rejects.toThrow(
      /exceeds.*limit/,
    );
  });

  it("respects GLEAN_FILE_ARG_MAX_BYTES override", async () => {
    process.env.GLEAN_FILE_ARG_MAX_BYTES = "100";
    const file = path.join(tmpDir, "ok.md");
    await fs.writeFile(file, "small content");

    const result = await resolveFileArgs({ body: file }, {});
    expect(result.body).toBe("small content");
  });

  it("throws when file_args key conflicts with arguments key", async () => {
    const file = path.join(tmpDir, "draft.md");
    await fs.writeFile(file, "content");

    await expect(
      resolveFileArgs({ body: file }, { body: "existing" }),
    ).rejects.toThrow(/conflicts/);
  });

  it("parses JSON into an object when the param type is object", async () => {
    const file = path.join(tmpDir, "spec.json");
    await fs.writeFile(file, '{"name":"agent","steps":[1,2,3]}');

    const result = await resolveFileArgs({ spec: file }, {}, {
      properties: { spec: { type: "object" } },
    });

    expect(result.spec).toEqual({ name: "agent", steps: [1, 2, 3] });
  });

  it("parses JSON into an array when the param type is array", async () => {
    const file = path.join(tmpDir, "items.json");
    await fs.writeFile(file, '["a","b"]');

    const result = await resolveFileArgs({ items: file }, {}, {
      properties: { items: { type: "array" } },
    });

    expect(result.items).toEqual(["a", "b"]);
  });

  it("parses when type is given as an array including object", async () => {
    const file = path.join(tmpDir, "spec.json");
    await fs.writeFile(file, '{"k":1}');

    const result = await resolveFileArgs({ spec: file }, {}, {
      properties: { spec: { type: ["object", "null"] } },
    });

    expect(result.spec).toEqual({ k: 1 });
  });

  it("keeps raw string for a string param even when content is JSON", async () => {
    const file = path.join(tmpDir, "body.json");
    await fs.writeFile(file, '{"looks":"like json"}');

    const result = await resolveFileArgs({ body: file }, {}, {
      properties: { body: { type: "string" } },
    });

    expect(result.body).toBe('{"looks":"like json"}');
  });

  it("keeps raw string when no schema is provided (backward compat)", async () => {
    const file = path.join(tmpDir, "body.json");
    await fs.writeFile(file, '{"a":1}');

    const result = await resolveFileArgs({ body: file }, {});

    expect(result.body).toBe('{"a":1}');
  });

  it("throws a clear error when an object-typed param gets invalid JSON", async () => {
    const file = path.join(tmpDir, "spec.json");
    await fs.writeFile(file, "not json {");

    await expect(
      resolveFileArgs({ spec: file }, {}, {
        properties: { spec: { type: "object" } },
      }),
    ).rejects.toThrow(/must contain valid JSON/);
  });

  it("falls back to the raw string for a string|object union with invalid JSON", async () => {
    const file = path.join(tmpDir, "val.txt");
    await fs.writeFile(file, "plain text");

    const result = await resolveFileArgs({ val: file }, {}, {
      properties: { val: { type: ["string", "object"] } },
    });

    expect(result.val).toBe("plain text");
  });
});

describe("buildRemoteArgs", () => {
  // Regression: a no-argument downstream call (e.g. slack_read_user_profile)
  // must forward `arguments: {}`, not omit the key. An absent field serializes
  // to null downstream, which strict MCP servers reject.
  it("always includes arguments, even when empty", () => {
    expect(buildRemoteArgs("srv", "tool", {})).toEqual({
      server_id: "srv",
      tool_name: "tool",
      arguments: {},
    });
  });

  it("forwards populated arguments unchanged", () => {
    expect(
      buildRemoteArgs("srv", "tool", { response_format: "detailed" }),
    ).toEqual({
      server_id: "srv",
      tool_name: "tool",
      arguments: { response_format: "detailed" },
    });
  });
});

function makeRemote() {
  return {
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    }),
    close: vi.fn(),
  } as any;
}

function makeServer(opts: {
  elicitation?: boolean;
  clientName?: string;
  elicit?: ReturnType<typeof vi.fn>;
  request?: ReturnType<typeof vi.fn>;
}) {
  return {
    getClientCapabilities: vi
      .fn()
      .mockReturnValue(opts.elicitation ? { elicitation: {} } : {}),
    getClientVersion: vi
      .fn()
      .mockReturnValue({ name: opts.clientName ?? "claude-code", version: "1" }),
    elicitInput: opts.elicit ?? vi.fn().mockResolvedValue({ action: "accept" }),
    // Used by primeElicitationCancellation to burn request id 0.
    request: opts.request ?? vi.fn().mockResolvedValue({}),
  } as any;
}

async function writeToolJson(
  baseDir: string,
  toolName: string,
  meta: Record<string, unknown>,
) {
  const toolsDir = path.join(baseDir, "some-skill", "tools");
  await fs.mkdir(toolsDir, { recursive: true });
  await fs.writeFile(
    path.join(toolsDir, `${toolName}.json`),
    JSON.stringify(meta),
    "utf-8",
  );
}

// Mirrors the marker the PreToolUse hook writes: <dataDir>/glean-hitl-mode/
// <sessionId>.json. The server reads it via CLAUDE_PLUGIN_DATA + GLEAN_SESSION_ID.
async function writeModeMarker(
  dataDir: string,
  sessionId: string,
  mode: string,
) {
  const dir = path.join(dataDir, "glean-hitl-mode");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${sessionId}.json`),
    JSON.stringify({ permission_mode: mode, ts: Date.now() }),
    "utf-8",
  );
}

describe("handleRunTool (HITL)", () => {
  let tmpDir: string;
  const baseArgs = {
    server_id: "composio/jira-pack",
    tool_name: "jirasearch",
    arguments: { project: "ABC", summary: "fix login" },
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "run-tool-hitl-test-"));
    // Isolate the session/always approval stores to this test's tmp dir so they
    // never read or pollute the real ~/.glean.
    vi.stubEnv("PLUGIN_DATA_DIR", tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("does not elicit when the client lacks elicitation capability", async () => {
    vi.stubEnv("ENABLE_HITL", "true");
    const remote = makeRemote();
    const server = makeServer({ elicitation: false });
    await writeToolJson(tmpDir, "jirasearch", { requires_approval: true });

    await handleRunTool(remote, server, tmpDir, baseArgs);

    expect(server.elicitInput).not.toHaveBeenCalled();
    expect(remote.callTool).toHaveBeenCalledTimes(1);
  });

  it("does not elicit when the tool does not require approval", async () => {
    vi.stubEnv("ENABLE_HITL", "true");
    const remote = makeRemote();
    const server = makeServer({ elicitation: true });
    await writeToolJson(tmpDir, "jirasearch", { requires_approval: false });

    await handleRunTool(remote, server, tmpDir, baseArgs);

    expect(server.elicitInput).not.toHaveBeenCalled();
    expect(remote.callTool).toHaveBeenCalledTimes(1);
  });

  it("prompts with action name + arguments and forwards on accept", async () => {
    vi.stubEnv("ENABLE_HITL", "true");
    const remote = makeRemote();
    const elicit = vi.fn().mockResolvedValue({ action: "accept" });
    const server = makeServer({ elicitation: true, elicit });
    await writeToolJson(tmpDir, "jirasearch", {
      requires_approval: true,
      description: "Search Jira issues",
    });

    await handleRunTool(remote, server, tmpDir, baseArgs);

    const [params, options] = elicit.mock.calls[0];
    expect(params.message).toContain("Action: jirasearch");
    expect(params.message).toContain("PROJECT: ABC");
    expect(params.message).not.toContain("Server:");
    expect(params.message).not.toContain("Search Jira issues");
    expect(params.message).not.toContain("**");
    expect(options.timeout).toBe(300_000);
    expect(remote.callTool).toHaveBeenCalledTimes(1);
  });

  it("pings to burn request id 0 before the first elicitation (so timeout cancellation is honored), once per server", async () => {
    // The MCP SDK's _oncancel drops notifications/cancelled with a falsy
    // requestId, so an elicitation that lands on request id 0 never gets
    // dismissed on timeout. We burn id 0 with a ping before the first prompt.
    vi.stubEnv("ENABLE_HITL", "true");
    const remote = makeRemote();
    const request = vi.fn().mockResolvedValue({});
    const elicit = vi.fn().mockResolvedValue({ action: "accept" });
    const server = makeServer({ elicitation: true, elicit, request });
    await writeToolJson(tmpDir, "jirasearch", { requires_approval: true });

    await handleRunTool(remote, server, tmpDir, baseArgs);
    await handleRunTool(remote, server, tmpDir, baseArgs);

    // Ping fired exactly once for this server, and it is a ping.
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toEqual({ method: "ping" });
    // Both prompts still ran.
    expect(elicit).toHaveBeenCalledTimes(2);
  });

  it("does not ping when the tool requires no approval (no elicitation)", async () => {
    vi.stubEnv("ENABLE_HITL", "true");
    const remote = makeRemote();
    const request = vi.fn().mockResolvedValue({});
    const server = makeServer({ elicitation: true, request });
    await writeToolJson(tmpDir, "jirasearch", { requires_approval: false });

    await handleRunTool(remote, server, tmpDir, baseArgs);

    expect(request).not.toHaveBeenCalled();
  });

  it("honors the HITL_TIMEOUT_MS override", async () => {
    vi.stubEnv("ENABLE_HITL", "true");
    vi.stubEnv("HITL_TIMEOUT_MS", "5000");
    const remote = makeRemote();
    const elicit = vi.fn().mockResolvedValue({ action: "accept" });
    const server = makeServer({ elicitation: true, elicit });
    await writeToolJson(tmpDir, "jirasearch", { requires_approval: true });

    await handleRunTool(remote, server, tmpDir, baseArgs);

    expect(elicit.mock.calls[0][1].timeout).toBe(5000);
  });

  it("falls back to the default timeout for invalid HITL_TIMEOUT_MS", async () => {
    vi.stubEnv("ENABLE_HITL", "true");
    await writeToolJson(tmpDir, "jirasearch", { requires_approval: true });

    for (const bad of ["0", "-1", "abc", ""]) {
      vi.stubEnv("HITL_TIMEOUT_MS", bad);
      const remote = makeRemote();
      const elicit = vi.fn().mockResolvedValue({ action: "accept" });
      const server = makeServer({ elicitation: true, elicit });

      await handleRunTool(remote, server, tmpDir, baseArgs);

      expect(elicit.mock.calls[0][1].timeout).toBe(300_000);
    }
  });

  it("does not execute when the user declines", async () => {
    vi.stubEnv("ENABLE_HITL", "true");
    const remote = makeRemote();
    const elicit = vi.fn().mockResolvedValue({ action: "decline" });
    const server = makeServer({ elicitation: true, elicit });
    await writeToolJson(tmpDir, "jirasearch", { requires_approval: true });

    const result = await handleRunTool(remote, server, tmpDir, baseArgs);

    expect(remote.callTool).not.toHaveBeenCalled();
    expect((result.content[0] as { text: string }).text).toContain("declined");
  });

  it("fails closed and does NOT execute when elicitation times out", async () => {
    vi.stubEnv("ENABLE_HITL", "true");
    const remote = makeRemote();
    const elicit = vi.fn().mockRejectedValue(new Error("Request timed out"));
    const server = makeServer({ elicitation: true, elicit });
    await writeToolJson(tmpDir, "jirasearch", { requires_approval: true });

    const result = await handleRunTool(remote, server, tmpDir, baseArgs);

    expect(remote.callTool).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("not approved");
    expect(text).toContain("NOT executed");
  });

  it("gives Cursor a one-line prompt without an arguments block", async () => {
    vi.stubEnv("ENABLE_HITL", "true");
    const remote = makeRemote();
    const elicit = vi.fn().mockResolvedValue({ action: "accept" });
    const server = makeServer({
      elicitation: true,
      clientName: "cursor-vscode",
      elicit,
    });
    await writeToolJson(tmpDir, "jirasearch", { requires_approval: true });

    await handleRunTool(remote, server, tmpDir, baseArgs);

    const message = elicit.mock.calls[0][0].message as string;
    expect(message).toContain("Submit to allow and Cancel to deny");
    expect(message).not.toContain("Arguments:");
    expect(remote.callTool).toHaveBeenCalledTimes(1);
  });

  it("spills large arguments to a file and keeps the prompt short", async () => {
    vi.stubEnv("ENABLE_HITL", "true");
    const remote = makeRemote();
    const elicit = vi.fn().mockResolvedValue({ action: "accept" });
    const server = makeServer({ elicitation: true, elicit });
    await writeToolJson(tmpDir, "create_doc", { requires_approval: true });

    const bigBody = "| A | B |\n|---|---|\n" + "| x | y |\n".repeat(50);
    await handleRunTool(remote, server, tmpDir, {
      server_id: "s",
      tool_name: "create_doc",
      arguments: { title: "Report", body: bigBody },
    });

    const message = elicit.mock.calls[0][0].message as string;
    expect(message).toContain("Action: create_doc");
    expect(message).toContain("TITLE: Report");
    expect(message.split("\n").length).toBeLessThanOrEqual(10);

    const fileLine = message
      .split("\n")
      .find((l) => l.includes("Full arguments: "));
    expect(fileLine).toBeDefined();
    const marker = "Full arguments: ";
    const filePath = fileLine!.slice(fileLine!.indexOf(marker) + marker.length).trim();
    const fileContent = await fs.readFile(filePath, "utf-8");
    expect(fileContent).toContain(bigBody);
    expect(fileContent).toContain("## body");
    await fs.rm(filePath, { force: true });
  });

  it("surfaces file_args content in the approval prompt", async () => {
    vi.stubEnv("ENABLE_HITL", "true");
    const remote = makeRemote();
    const elicit = vi.fn().mockResolvedValue({ action: "accept" });
    const server = makeServer({ elicitation: true, elicit });
    await writeToolJson(tmpDir, "create_doc", { requires_approval: true });
    const bodyFile = path.join(tmpDir, "draft.md");
    await fs.writeFile(bodyFile, "FILE_SOURCED_BODY", "utf-8");

    await handleRunTool(remote, server, tmpDir, {
      server_id: "s",
      tool_name: "create_doc",
      arguments: { title: "Doc" },
      file_args: { body: bodyFile },
    });

    const message = elicit.mock.calls[0][0].message as string;
    expect(message).toContain("TITLE: Doc");
    expect(message).toContain("BODY: FILE_SOURCED_BODY"); // file-sourced arg shown
    expect(remote.callTool).toHaveBeenCalledTimes(1); // executed on accept
  });

  it("parses an object-typed file_arg from the tool schema and forwards it as structured data", async () => {
    vi.stubEnv("ENABLE_HITL", "false");
    const remote = makeRemote();
    const server = makeServer({ elicitation: false });
    await writeToolJson(tmpDir, "save_agent", {
      requires_approval: false,
      inputSchema: { properties: { spec: { type: "object" } } },
    });
    const specFile = path.join(tmpDir, "spec.json");
    await fs.writeFile(specFile, '{"name":"my-agent","steps":[1,2]}', "utf-8");

    await handleRunTool(remote, server, tmpDir, {
      server_id: "default",
      tool_name: "save_agent",
      arguments: {},
      file_args: { spec: specFile },
    });

    const call = remote.callTool.mock.calls[0][0];
    expect(call.name).toBe("run_tool");
    expect(call.arguments.arguments.spec).toEqual({
      name: "my-agent",
      steps: [1, 2],
    });
  });

  it("fails before prompting when a file_args path is unreadable", async () => {
    vi.stubEnv("ENABLE_HITL", "true");
    const remote = makeRemote();
    const elicit = vi.fn().mockResolvedValue({ action: "accept" });
    const server = makeServer({ elicitation: true, elicit });
    await writeToolJson(tmpDir, "create_doc", { requires_approval: true });

    const result = await handleRunTool(remote, server, tmpDir, {
      server_id: "s",
      tool_name: "create_doc",
      arguments: {},
      file_args: { body: "/no/such/abs/path.md" },
    });

    expect(result.isError).toBe(true);
    expect(elicit).not.toHaveBeenCalled(); // no prompt for unreadable input
    expect(remote.callTool).not.toHaveBeenCalled();
  });

  it("approvalRequestedSchema exposes a single 'always' boolean checkbox", () => {
    const schema = approvalRequestedSchema() as any;
    expect(schema.properties.always.type).toBe("boolean");
    // No string enum (which CC renders as a collapsed accordion) and no session
    // field (dropped — can't work on a remote MCP server).
    expect(schema.properties.session).toBeUndefined();
    expect(schema.properties.choice).toBeUndefined();
  });

  it("readApprovalScope: box ticked = always; unticked/missing = task", () => {
    expect(readApprovalScope({ always: true })).toBe("always");
    expect(readApprovalScope({ always: false })).toBe("task");
    expect(readApprovalScope({})).toBe("task");
    expect(readApprovalScope(undefined)).toBe("task");
  });

  it("prompts with a single 'always' checkbox field", async () => {
    vi.stubEnv("ENABLE_HITL", "true");
    const remote = makeRemote();
    const elicit = vi.fn().mockResolvedValue({ action: "accept", content: {} });
    const server = makeServer({ elicitation: true, elicit });
    await writeToolJson(tmpDir, "jirasearch", { requires_approval: true });

    await handleRunTool(remote, server, tmpDir, baseArgs);

    const schema = elicit.mock.calls[0][0].requestedSchema;
    expect(schema.properties.always.type).toBe("boolean");
    expect(schema.properties.session).toBeUndefined();
  });

  it("Accept with the box unticked executes once and persists nothing", async () => {
    vi.stubEnv("ENABLE_HITL", "true");
    const remote = makeRemote();
    const elicit = vi.fn().mockResolvedValue({ action: "accept", content: {} });
    const server = makeServer({ elicitation: true, elicit });
    await writeToolJson(tmpDir, "jirasearch", { requires_approval: true });

    await handleRunTool(remote, server, tmpDir, baseArgs);

    expect(remote.callTool).toHaveBeenCalledTimes(1);
    expect(await isToolAlwaysAllowed("jirasearch")).toBe(false);
  });

  it("ticking 'Always allow' persists and then skips the prompt for that tool", async () => {
    vi.stubEnv("ENABLE_HITL", "true");
    const remote = makeRemote();
    const elicit = vi
      .fn()
      .mockResolvedValue({ action: "accept", content: { always: true } });
    const server = makeServer({ elicitation: true, elicit });
    await writeToolJson(tmpDir, "jirasearch", { requires_approval: true });

    await handleRunTool(remote, server, tmpDir, baseArgs);
    expect(await isToolAlwaysAllowed("jirasearch")).toBe(true);

    // Second call to the same tool is pre-approved → no prompt.
    await handleRunTool(remote, server, tmpDir, baseArgs);
    expect(elicit).toHaveBeenCalledTimes(1);
    expect(remote.callTool).toHaveBeenCalledTimes(2);
  });

  it("treats an accept with no content (accept/decline-only client) as a one-time approval", async () => {
    vi.stubEnv("ENABLE_HITL", "true");
    const remote = makeRemote();
    const elicit = vi.fn().mockResolvedValue({ action: "accept" });
    const server = makeServer({ elicitation: true, elicit });
    await writeToolJson(tmpDir, "jirasearch", { requires_approval: true });

    await handleRunTool(remote, server, tmpDir, baseArgs);

    expect(remote.callTool).toHaveBeenCalledTimes(1);
    expect(await isToolAlwaysAllowed("jirasearch")).toBe(false);
  });

  it("skips the prompt when the tool is already always-allowed", async () => {
    vi.stubEnv("ENABLE_HITL", "true");
    await setToolAlwaysAllowed("jirasearch");
    const remote = makeRemote();
    const elicit = vi.fn().mockResolvedValue({ action: "accept" });
    const server = makeServer({ elicitation: true, elicit });
    await writeToolJson(tmpDir, "jirasearch", { requires_approval: true });

    await handleRunTool(remote, server, tmpDir, baseArgs);

    expect(elicit).not.toHaveBeenCalled();
    expect(remote.callTool).toHaveBeenCalledTimes(1);
  });

  it("clearToolPermissions removes an always grant", async () => {
    await setToolAlwaysAllowed("jirasearch");
    expect(await isToolAlwaysAllowed("jirasearch")).toBe(true);

    await clearToolPermissions();

    expect(await isToolAlwaysAllowed("jirasearch")).toBe(false);
  });

  it("skips the elicitation gate and executes directly in bypassPermissions mode", async () => {
    vi.stubEnv("ENABLE_HITL", "true");
    vi.stubEnv("CLAUDE_PLUGIN_DATA", tmpDir);
    vi.stubEnv("GLEAN_SESSION_ID", "sess-bypass");
    await writeToolJson(tmpDir, "jirasearch", { requires_approval: true });
    await writeModeMarker(tmpDir, "sess-bypass", "bypassPermissions");
    const remote = makeRemote();
    const elicit = vi.fn().mockResolvedValue({ action: "accept" });
    const server = makeServer({ elicitation: true, elicit });

    await handleRunTool(remote, server, tmpDir, baseArgs);

    expect(elicit).not.toHaveBeenCalled();
    expect(remote.callTool).toHaveBeenCalledTimes(1);
  });

  it("still elicits when the session's permission mode is not bypass", async () => {
    vi.stubEnv("ENABLE_HITL", "true");
    vi.stubEnv("CLAUDE_PLUGIN_DATA", tmpDir);
    vi.stubEnv("GLEAN_SESSION_ID", "sess-default");
    await writeToolJson(tmpDir, "jirasearch", { requires_approval: true });
    await writeModeMarker(tmpDir, "sess-default", "default");
    const remote = makeRemote();
    const elicit = vi.fn().mockResolvedValue({ action: "accept" });
    const server = makeServer({ elicitation: true, elicit });

    await handleRunTool(remote, server, tmpDir, baseArgs);

    expect(elicit).toHaveBeenCalledTimes(1);
    expect(remote.callTool).toHaveBeenCalledTimes(1);
  });

  it("still elicits when no permission-mode marker exists (fails toward the gate)", async () => {
    vi.stubEnv("ENABLE_HITL", "true");
    vi.stubEnv("CLAUDE_PLUGIN_DATA", tmpDir);
    vi.stubEnv("GLEAN_SESSION_ID", "sess-none");
    await writeToolJson(tmpDir, "jirasearch", { requires_approval: true });
    // Deliberately write no marker.
    const remote = makeRemote();
    const elicit = vi.fn().mockResolvedValue({ action: "accept" });
    const server = makeServer({ elicitation: true, elicit });

    await handleRunTool(remote, server, tmpDir, baseArgs);

    expect(elicit).toHaveBeenCalledTimes(1);
  });

  it("ignores a bypass marker written for a different session (no cross-session leak)", async () => {
    vi.stubEnv("ENABLE_HITL", "true");
    vi.stubEnv("CLAUDE_PLUGIN_DATA", tmpDir);
    vi.stubEnv("GLEAN_SESSION_ID", "sess-A");
    await writeToolJson(tmpDir, "jirasearch", { requires_approval: true });
    // Another concurrent session opted into bypass; ours did not.
    await writeModeMarker(tmpDir, "sess-B", "bypassPermissions");
    const remote = makeRemote();
    const elicit = vi.fn().mockResolvedValue({ action: "accept" });
    const server = makeServer({ elicitation: true, elicit });

    await handleRunTool(remote, server, tmpDir, baseArgs);

    expect(elicit).toHaveBeenCalledTimes(1); // gate preserved for THIS session
  });
});

describe("buildCompactArgs", () => {
  it("returns (none) for empty or null args, no file", () => {
    expect(buildCompactArgs(null)).toEqual({ lines: ["(none)"], needsFile: false });
    expect(buildCompactArgs({})).toEqual({ lines: ["(none)"], needsFile: false });
  });

  it("renders short scalars inline, uppercased keys, one line each, no file", () => {
    expect(buildCompactArgs({ project: "ABC", limit: 10, dryRun: true })).toEqual({
      lines: ["PROJECT: ABC", "LIMIT: 10", "DRYRUN: true"],
      needsFile: false,
    });
  });

  it("collapses a multi-line string to a single line and flags a file", () => {
    const { lines, needsFile } = buildCompactArgs({
      body: "# Title\n\n| A | B |\n|---|---|\n| 1 | 2 |",
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
    expect(lines[0].startsWith("BODY: ")).toBe(true);
    expect(needsFile).toBe(true);
  });

  it("truncates a long single-line string with a (truncated) suffix and flags a file", () => {
    const { lines, needsFile } = buildCompactArgs({ note: "x".repeat(300) });
    expect(lines[0].endsWith("(truncated)")).toBe(true);
    expect(lines[0].length).toBeLessThan(150);
    expect(needsFile).toBe(true);
  });

  it("caps inline arg lines at the budget and flags a file when omitted", () => {
    const { lines, needsFile } = buildCompactArgs({
      a: 1,
      b: 2,
      c: 3,
      d: 4,
      e: 5,
      f: 6,
      g: 7,
      h: 8,
      i: 9,
    });
    expect(lines).toHaveLength(7);
    expect(needsFile).toBe(true);
  });

  it("renders a small nested object as compact JSON inline", () => {
    expect(buildCompactArgs({ filters: { status: ["open", "wip"] } })).toEqual({
      lines: ['FILTERS: {"status":["open","wip"]}'],
      needsFile: false,
    });
  });
});

describe("formatArgumentsForFile", () => {
  it("writes string values verbatim and nested values as JSON blocks", () => {
    const out = formatArgumentsForFile("create_doc", {
      title: "Hi",
      filters: { status: ["open"] },
    });
    expect(out).toContain("# Approval request: create_doc");
    expect(out).toContain("## title");
    expect(out).toContain("Hi");
    expect(out).toContain("## filters");
    expect(out).toContain('"status"');
  });

  it("preserves multi-line Markdown content verbatim (so it renders when opened)", () => {
    const table = "| A | B |\n|---|---|\n| 1 | 2 |";
    const out = formatArgumentsForFile("x", { body: table });
    expect(out).toContain(table);
    expect(out).not.toContain("\\n");
  });
});

describe("runToolAnnotations", () => {
  it("marks run_tool read-only when HITL gates an elicitation-capable client", () => {
    expect(runToolAnnotations(true, true)).toEqual({ readOnlyHint: true });
  });

  it("leaves annotations unset when HITL is disabled", () => {
    expect(runToolAnnotations(false, true)).toBeUndefined();
  });

  it("leaves annotations unset when the client cannot elicit", () => {
    expect(runToolAnnotations(true, false)).toBeUndefined();
  });
});
