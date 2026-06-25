import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleRunCode } from "../src/tools/run-code.js";

type Responder = (toolName: string, args: unknown) => unknown;

// Client that returns each responder result as a successful JSON tool output.
function makeClient(responder: Responder): Client {
  return {
    async callTool(req: { name: string; arguments: Record<string, unknown> }) {
      const isGateway = req.name === "run_tool";
      const toolName = isGateway ? (req.arguments.tool_name as string) : req.name;
      const inner = isGateway ? req.arguments.arguments : req.arguments;
      return { content: [{ type: "text", text: JSON.stringify(responder(toolName, inner)) }] };
    },
  } as unknown as Client;
}

// Client where every call reports isError:true with a fixed message.
function clientFailing(message: string): Client {
  return {
    async callTool() {
      return { content: [{ type: "text", text: message }], isError: true };
    },
  } as unknown as Client;
}

// Client where every call throws (network-class failure).
function clientThrowing(message: string): Client {
  return {
    async callTool(): Promise<never> {
      throw new Error(message);
    },
  } as unknown as Client;
}

function makeServer(elicitation: boolean, action: "accept" | "decline" = "accept"): Server {
  return {
    getClientCapabilities: () => (elicitation ? { elicitation: {} } : {}),
    async elicitInput() {
      return { action };
    },
  } as unknown as Server;
}

function parseEnvelope(result: { content: { type: string; text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

describe("handleRunCode", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "run-code-test-"));
    const toolsDir = path.join(dir, "demo", "tools");
    await fs.mkdir(toolsDir, { recursive: true });
    await fs.writeFile(
      path.join(toolsDir, "DEMO_SEARCH.json"),
      JSON.stringify({ server_id: "srv-1", requires_approval: false, description: "Search" }),
    );
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(path.resolve(dir, "..", "glean-run-code-results"), {
      recursive: true,
      force: true,
    });
  });

  it("returns value verbatim; no ledger field; reports a fresh session", async () => {
    const client = makeClient(() => ({
      items: [{ id: 1, name: "alpha" }, { id: 2, name: "beta" }],
      total: 2,
    }));
    const env = parseEnvelope(
      (await handleRunCode(client, makeServer(false), dir, {
        reset: true,
        code: `const r = await PTC_DEMO_SEARCH({ q: "x" }); return r.get("total");`,
      })) as never,
    );
    expect(env.ok).toBe(true);
    expect(env.value).toBe(2);
    expect(env.ledger).toBeUndefined(); // ledger concept removed entirely
    expect(env.session.fresh).toBe(true);
  });

  it("returns a ToolResult's underlying data verbatim (unwrapped)", async () => {
    const client = makeClient(() => ({ items: [{ id: 1, name: "alpha" }], total: 1 }));
    const env = parseEnvelope(
      (await handleRunCode(client, makeServer(false), dir, {
        reset: true,
        code: `return await PTC_DEMO_SEARCH({});`,
      })) as never,
    );
    expect(env.ok).toBe(true);
    expect(env.value.total).toBe(1);
    expect(env.value.items[0].name).toBe("alpha");
    expect("__isToolResult" in env.value).toBe(false);
  });

  it("inspect() prints SHAPE only — no sample values", async () => {
    const client = makeClient(() => ({ items: [{ id: 1, name: "alpha" }], total: 1 }));
    const env = parseEnvelope(
      (await handleRunCode(client, makeServer(false), dir, {
        reset: true,
        code: `const r = await PTC_DEMO_SEARCH({}); inspect(r);`,
      })) as never,
    );
    expect(env.stdout).toContain("id: number");
    expect(env.stdout).not.toContain("alpha");
  });

  it(".format is 'json' / 'empty' / 'text' appropriately", async () => {
    const j = parseEnvelope(
      (await handleRunCode(makeClient(() => ({ ok: true })), makeServer(false), dir, {
        reset: true,
        code: `const r = await PTC_DEMO_SEARCH({}); return r.format;`,
      })) as never,
    );
    expect(j.value).toBe("json");

    const empty = {
      async callTool() {
        return { content: [{ type: "text", text: "" }] };
      },
    } as unknown as Client;
    const e = parseEnvelope(
      (await handleRunCode(empty, makeServer(false), dir, {
        reset: true,
        code: `const r = await PTC_DEMO_SEARCH({}); return r.format;`,
      })) as never,
    );
    expect(e.value).toBe("empty");
  });

  it("prefers structuredContent for .json()", async () => {
    const client = {
      async callTool() {
        return {
          content: [{ type: "text", text: "not json" }],
          structuredContent: { hits: 5 },
        };
      },
    } as unknown as Client;
    const env = parseEnvelope(
      (await handleRunCode(client, makeServer(false), dir, {
        reset: true,
        code: `const r = await PTC_DEMO_SEARCH({}); return r.get("hits");`,
      })) as never,
    );
    expect(env.value).toBe(5);
  });

  it("non-JSON output: .format=text, inspect says so", async () => {
    const client = {
      async callTool() {
        return { content: [{ type: "text", text: "cursor: abc\ndocuments[2]:" }] };
      },
    } as unknown as Client;
    const env = parseEnvelope(
      (await handleRunCode(client, makeServer(false), dir, {
        reset: true,
        code: `const r = await PTC_DEMO_SEARCH({}); print("format:", r.format); inspect(r);`,
      })) as never,
    );
    expect(env.ok).toBe(true);
    expect(env.stdout).toContain("format: text");
    expect(env.stdout).toContain("non-JSON text");
  });

  it("merges shapes across heterogeneous array elements (optional keys)", async () => {
    const client = makeClient(() => ({ rows: [{ a: 1, b: 2 }, { a: 3 }] }));
    const env = parseEnvelope(
      (await handleRunCode(client, makeServer(false), dir, {
        reset: true,
        code: `const r = await PTC_DEMO_SEARCH({}); print(inspect(r.get("rows"))); return r.get("rows", []).length;`,
      })) as never,
    );
    expect(env.value).toBe(2);
    // inspect() still surfaces the heterogeneous-array merge (b is optional).
    expect(env.stdout).toContain("b?: number");
  });

  it("returns a large value VERBATIM (no file redirection / overflow pointer)", async () => {
    const client = makeClient(() => ({ blob: "x".repeat(6000) }));
    const env = parseEnvelope(
      (await handleRunCode(client, makeServer(false), dir, {
        reset: true,
        code: `return await PTC_DEMO_SEARCH({});`,
      })) as never,
    );
    expect(env.ok).toBe(true);
    expect(env.value.blob).toBe("x".repeat(6000)); // verbatim, not a {shape,path} pointer
    expect(env.value.__overflow).toBeUndefined(); // overflow concept removed
    expect(env.stdout_path).toBeUndefined();
    expect(env.hints).toBeUndefined(); // hints removed
  });

  it("emits the envelope on BOTH channels: structuredContent + content text", async () => {
    const client = makeClient(() => ({ total: 7 }));
    const result = (await handleRunCode(client, makeServer(false), dir, {
      reset: true,
      code: `const r = await PTC_DEMO_SEARCH({}); return r.get("total");`,
    })) as { content: { text: string }[]; structuredContent?: unknown };
    // structuredContent is the typed object; content[0].text is the same JSON string
    expect(result.structuredContent).toEqual({ ok: true, value: 7, session: { fresh: true } });
    expect(result.structuredContent).toEqual(JSON.parse(result.content[0].text));
  });

  it("persists bare-assigned vars; session present only when fresh; reset clears", async () => {
    const client = makeClient(() => ({ items: [{ id: 1, name: "alpha" }], total: 1 }));
    const server = makeServer(false);

    const first = parseEnvelope(
      (await handleRunCode(client, server, dir, {
        reset: true,
        code: `saved = await PTC_DEMO_SEARCH({}); return saved.get("total");`,
      })) as never,
    );
    expect(first.value).toBe(1);
    expect(first.session.fresh).toBe(true);

    const second = parseEnvelope(
      (await handleRunCode(client, server, dir, {
        code: `return saved.get("items.0.name");`,
      })) as never,
    );
    expect(second.value).toBe("alpha");
    expect(second.session).toBeUndefined(); // not fresh → omitted

    const third = parseEnvelope(
      (await handleRunCode(client, server, dir, {
        reset: true,
        code: `return saved.get("total");`,
      })) as never,
    );
    expect(third.ok).toBe(false);
    expect(third.error.message).toMatch(/saved is not defined/);
  });

  it("get() returns fallback on a wrong path", async () => {
    const env = parseEnvelope(
      (await handleRunCode(makeClient(() => ({ total: 5 })), makeServer(false), dir, {
        reset: true,
        code: `const r = await PTC_DEMO_SEARCH({}); return r.get("nope.deep", "FB");`,
      })) as never,
    );
    expect(env.ok).toBe(true);
    expect(env.value).toBe("FB");
  });

  it("runs a batch of 2+ calls (success → no ledger field)", async () => {
    const env = parseEnvelope(
      (await handleRunCode(makeClient(() => ({ ok: true })), makeServer(false), dir, {
        reset: true,
        code: `await PTC_DEMO_SEARCH({}); await PTC_DEMO_SEARCH({}); return "done";`,
      })) as never,
    );
    expect(env.ok).toBe(true);
    expect(env.value).toBe("done");
    expect(env.ledger).toBeUndefined(); // ledger concept removed entirely
  });

  it("runs a call inside a loop (fan-out)", async () => {
    const env = parseEnvelope(
      (await handleRunCode(makeClient(() => ({ ok: true })), makeServer(false), dir, {
        reset: true,
        code: `let n=0; for (const x of [1,2,3]) { await PTC_DEMO_SEARCH({x}); n++; } return n;`,
      })) as never,
    );
    expect(env.ok).toBe(true);
    expect(env.value).toBe(3);
  });

  it("clear error when calling an unknown PTC_ tool", async () => {
    const env = parseEnvelope(
      (await handleRunCode(makeClient(() => ({})), makeServer(false), dir, {
        reset: true,
        code: `return await PTC_DOES_NOT_EXIST({});`,
      })) as never,
    );
    expect(env.ok).toBe(false);
    expect(env.error.message).toMatch(/Unknown tool PTC_DOES_NOT_EXIST/);
  });

  // ---- failure visibility: a failed PTC_ call throws (self-contained) -------
  describe("failure visibility", () => {
    it("a failed tool call THROWS (PTC_<tool> failed: <reason>) → ok:false", async () => {
      const env = parseEnvelope(
        (await handleRunCode(clientFailing("EE-2: 403 Forbidden"), makeServer(false), dir, {
          reset: true,
          // the await throws — `return` is never reached
          code: `const r = await PTC_DEMO_SEARCH({}); return "unreached";`,
        })) as never,
      );
      expect(env.ok).toBe(false);
      expect(env.value).toBeUndefined(); // cell threw → no value
      expect(env.error.message).toBe("PTC_DEMO_SEARCH failed: EE-2: 403 Forbidden");
      expect(env.ledger).toBeUndefined(); // no ledger
    });

    it("an empty-message throw still reports ok:false (not a silent success)", async () => {
      for (const thrown of [`new Error("")`, `""`, `{ message: "" }`]) {
        const env = parseEnvelope(
          (await handleRunCode(makeClient(() => ({})), makeServer(false), dir, {
            reset: true,
            code: `throw ${thrown};`,
          })) as never,
        );
        // `ok` reflects did-NOT-throw, not the truthiness of the message string.
        expect(env.ok).toBe(false);
        expect(env.value).toBeUndefined();
        expect(typeof env.error.message).toBe("string");
        expect(env.error.message.length).toBeGreaterThan(0); // never empty
      }
    });

    it("a circular return value keeps both channels valid + in sync", async () => {
      const result = (await handleRunCode(makeClient(() => ({})), makeServer(false), dir, {
        reset: true,
        code: `const o = { a: 1 }; o.self = o; return o;`,
      })) as { content: { text: string }[]; structuredContent?: unknown };
      // text channel is valid JSON and equals structuredContent (no "[object Object]")
      const parsed = JSON.parse(result.content[0].text);
      expect(result.structuredContent).toEqual(parsed);
      expect(parsed.ok).toBe(true);
      expect(parsed.value.a).toBe(1);
      expect(parsed.value.self).toBe("[circular]"); // cycle rendered safely
    });

    it("empty-text isError falls back to the default reason", async () => {
      const emptyErr = {
        async callTool() {
          return { content: [], isError: true };
        },
      } as unknown as Client;
      const env = parseEnvelope(
        (await handleRunCode(emptyErr, makeServer(false), dir, {
          reset: true,
          code: `const r = await PTC_DEMO_SEARCH({}); return "unreached";`,
        })) as never,
      );
      expect(env.ok).toBe(false);
      expect(env.error.message).toBe("PTC_DEMO_SEARCH failed: (tool reported an error)");
    });

    it("try/catch makes a batch self-contained (the recommended pattern)", async () => {
      const env = parseEnvelope(
        (await handleRunCode(clientFailing("gateway 500"), makeServer(false), dir, {
          reset: true,
          code: `const out=[];
            for (const k of ["a","b"]) {
              try { const r = await PTC_DEMO_SEARCH({k}); out.push({k, ok:true}); }
              catch (e) { out.push({k, error: String(e.message)}); }
            }
            return out;`,
        })) as never,
      );
      // no uncaught throw → ok:true; the failures are captured IN the return value
      expect(env.ok).toBe(true);
      expect(env.value).toHaveLength(2);
      expect(env.value[0].error).toContain("PTC_DEMO_SEARCH failed: gateway 500");
      expect(env.value[1].error).toContain("gateway 500");
      expect(env.ledger).toBeUndefined();
    });

    it("a transport throw is wrapped with the tool name → ok:false, error.message", async () => {
      const env = parseEnvelope(
        (await handleRunCode(clientThrowing("ECONNRESET"), makeServer(false), dir, {
          reset: true,
          code: `return await PTC_DEMO_SEARCH({});`,
        })) as never,
      );
      expect(env.ok).toBe(false);
      expect(env.error.message).toBe("PTC_DEMO_SEARCH failed: ECONNRESET");
      expect(env.ledger).toBeUndefined();
    });

    it("uncaught throw mid-batch: prior bare-assigned state persists, no rollback", async () => {
      // DEMO_SEARCH succeeds; DEMO_FAIL reports isError.
      await fs.writeFile(
        path.join(dir, "demo", "tools", "DEMO_FAIL.json"),
        JSON.stringify({ server_id: "srv-1", requires_approval: false, description: "Fails" }),
      );
      const client = {
        async callTool(req: { name: string; arguments: Record<string, unknown> }) {
          const tool =
            req.name === "run_tool" ? (req.arguments.tool_name as string) : req.name;
          return tool === "DEMO_FAIL"
            ? { content: [{ type: "text", text: "boom" }], isError: true }
            : { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
        },
      } as unknown as Client;

      // Cell 1: accumulate, succeed, then hit a failing call (uncaught).
      const first = parseEnvelope(
        (await handleRunCode(client, makeServer(false), dir, {
          reset: true,
          code: `acc = []; await PTC_DEMO_SEARCH({}); acc.push(1); await PTC_DEMO_FAIL({}); acc.push(2); return "unreached";`,
        })) as never,
      );
      expect(first.ok).toBe(false);
      expect(first.error.message).toBe("PTC_DEMO_FAIL failed: boom");

      // Cell 2 (no reset): the bare-assigned `acc` survived; push(1) ran, push(2) did not.
      const second = parseEnvelope(
        (await handleRunCode(client, makeServer(false), dir, {
          code: `return acc;`,
        })) as never,
      );
      expect(second.ok).toBe(true);
      expect(second.value).toEqual([1]); // committed-before-throw persists; nothing rolled back
    });
  });

  // ---- approval (ENABLE_HITL) ---------------------------------------------
  describe("approval (ENABLE_HITL)", () => {
    let prev: string | undefined;
    beforeEach(async () => {
      prev = process.env.ENABLE_HITL;
      process.env.ENABLE_HITL = "true";
      await fs.writeFile(
        path.join(dir, "demo", "tools", "DEMO_WRITE.json"),
        JSON.stringify({ server_id: "srv-1", requires_approval: true, description: "Writes" }),
      );
    });
    afterEach(() => {
      if (prev === undefined) delete process.env.ENABLE_HITL;
      else process.env.ENABLE_HITL = prev;
    });

    it("bulk approval accepted → runs", async () => {
      const env = parseEnvelope(
        (await handleRunCode(makeClient(() => ({ ok: true })), makeServer(true, "accept"), dir, {
          reset: true,
          code: `const r = await PTC_DEMO_WRITE({}); return r.get("ok");`,
        })) as never,
      );
      expect(env.ok).toBe(true);
      expect(env.value).toBe(true);
    });

    it("bulk approval declined → ok:false, nothing dispatched", async () => {
      let dispatched = false;
      const client = {
        async callTool() {
          dispatched = true;
          return { content: [{ type: "text", text: "{}" }] };
        },
      } as unknown as Client;
      const env = parseEnvelope(
        (await handleRunCode(client, makeServer(true, "decline"), dir, {
          reset: true,
          code: `return await PTC_DEMO_WRITE({});`,
        })) as never,
      );
      expect(env.ok).toBe(false);
      expect(env.error.message).toMatch(/declined/i);
      expect(dispatched).toBe(false);
    });

    it("just-in-time decline (dynamic call) → throws Approval declined", async () => {
      // `const f = PTC_DEMO_WRITE` isn't a PTC_*( call site, so the bulk
      // pre-scan misses it; the runtime allowlist backstop prompts at dispatch.
      const env = parseEnvelope(
        (await handleRunCode(makeClient(() => ({ ok: true })), makeServer(true, "decline"), dir, {
          reset: true,
          code: `const f = PTC_DEMO_WRITE; return await f({});`,
        })) as never,
      );
      expect(env.ok).toBe(false);
      expect(env.error.message).toMatch(/Approval declined for PTC_DEMO_WRITE/);
      expect(env.ledger).toBeUndefined();
    });
  });
});
