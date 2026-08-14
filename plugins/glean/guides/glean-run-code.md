# Experimental Glean `run_code` Guide

This guide is operative only when the Glean MCP server currently exposes the
`run_code` tool. Its presence means
`DANGEROUSLY_ENABLE_UNSTABLE_RUN_CODE_FEATURE=true` was recognized by the MCP
server. If `run_code` is absent, ignore this entire guide and use the standard
`run_tool` workflow from the `glean_run` skill.

## Choose the Execution Path

Prefer `run_code` if **any** of these are true:

- The task reads, writes, creates, moves, extracts, archives, transforms, or
  deletes local files or directories.
- The task performs a local system operation, invokes a process, handles binary
  data, makes a network request, or otherwise benefits from normal Node.js APIs.
- Two or more Glean tools must be called.
- One tool's output feeds another tool's input.
- The workflow involves a loop, fan-out, filtering, aggregation, retries, or
  conditional execution.
- The task mixes Glean tool calls with filesystem/system operations.
- Keeping large intermediate results in the runtime avoids transferring them
  through model context.

Use `run_tool` only for exactly one isolated Glean call with no local Node work,
chaining, transformation, or intermediate state. Otherwise, perform the complete
workflow in **one `run_code` call** whenever practical. Do not split it across
Bash, filesystem tools, and separate `run_tool` calls. Never issue parallel
`run_code` calls; await one result before starting another.

## Node.js Runtime

`run_code` is a full local Node.js PoC:

- Use CommonJS `require()` for Node builtins, including `node:zlib`,
  `node:child_process`, `node:crypto`, streams, and networking modules.
- Familiar globals include `process`, `Buffer`, timers, `fetch`, URL/text APIs,
  and captured `console`; `fs` and `path` are prebound.
- Third-party packages work only when physically installed and resolvable from
  the plugin bundle. Dynamic `import()` is not configured; use `require()`.
- Use `return`, `print`, or `console.log` for output. Never write directly to
  `process.stdout`, because it carries MCP JSON-RPC.

## Calling Glean Tools with PTC Bindings

Each discovered Glean tool is available as:

```js
await PTC_<TOOL_NAME>(arguments)
```

Names match exactly first and then a unique case-insensitive spelling, so
`PTC_GET_AGENT` can invoke canonical `get_agent`; ambiguous case-only names fail
instead of guessing. The `server_id` is bound automatically, but arguments must
still match the tool JSON's `inputSchema` exactly.

Tool metadata is scanned from both the current managed plugin cache and the
launch project's `.claude/tmp/glean-skills-cache`, with current metadata taking
precedence.

A successful PTC call returns a `ToolResult` with:

- `.text`
- `.json()`
- `.get("a.b", fallback)`
- `.format` (`"json"`, `"text"`, or `"empty"`)

A failed PTC call throws `Error: PTC_<TOOL> failed: <reason>`. Use `try/catch`
when a batch should continue after an individual failure. Writes completed
before a failure are not rolled back.

Use `inspect(value)` to return a value's shape before drilling into an unknown
result. Return or print only the final data needed by the user; large
intermediate values can stay inside the runtime.

The runtime is stateful for the plugin process lifetime. To persist a value
between `run_code` calls, use a bare assignment:

```js
agents = await PTC_SEARCH_AGENTS({ query: "support" });
```

`var`, `let`, and `const` are temporary to one call. Pass `reset: true` to clear
persisted values. Prefer one self-contained call over relying on persistence.

## Example

Use exact PTC names and argument schemas discovered from tool JSON. The names in
this example are placeholders only.

```js
run_code({
  code: `
    const outputDir = path.resolve("results");
    await fs.promises.mkdir(outputDir, { recursive: true });

    const first = await PTC_SEARCH_TOOL({ query: "open issues" });
    const rows = first.get("items", []);
    const enriched = [];
    for (const row of rows) {
      const detail = await PTC_DETAIL_TOOL({ id: row.id });
      enriched.push(detail.json());
    }

    const output = path.join(outputDir, "report.json");
    await fs.promises.writeFile(output, JSON.stringify(enriched, null, 2));
    return { output, count: enriched.length };
  `
})
```

## Safety Requirements

- `run_code` has the plugin process's full OS permissions and can execute
  arbitrary commands. `node:vm` is not a security boundary.
- Filesystem changes, commands, network requests, and prior tool writes happen
  immediately and are not rolled back.
- Local Node operations and child processes are not individually HITL-gated.
- Perform only operations authorized by the user's intent.
- Always read discovered tool JSON before calling a PTC binding. Never guess
  tool names or parameters.
