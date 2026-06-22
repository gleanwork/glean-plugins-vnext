import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(
  here,
  "../plugins/glean/hooks/auto-approve-run-tool.mjs",
);

async function runHook(
  toolName: string,
  env: Record<string, string>,
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "approve-hook-"));
  await fs.writeFile(
    path.join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { glean: { env } } }),
  );
  try {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn("node", [HOOK], {
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: root },
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.on("error", reject);
      child.on("close", () => resolve(out));
      child.stdin.write(JSON.stringify({ tool_name: toolName }));
      child.stdin.end();
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("auto-approve-run-tool hook (prototype, flag-gated)", () => {
  const RUN_TOOL = "mcp__plugin_glean-vnext_glean__run_tool";
  const onOn = { ENABLE_HITL: "true", HITL_AUTO_APPROVE: "true" };

  it("allows run_tool when HITL is on and the flag is on", async () => {
    const out = await runHook(RUN_TOOL, onOn);
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe("allow");
  });

  it("does nothing when the flag is off", async () => {
    const out = await runHook(RUN_TOOL, {
      ENABLE_HITL: "true",
      HITL_AUTO_APPROVE: "false",
    });
    expect(out.trim()).toBe("");
  });

  it("never allows when HITL is off, even with the flag on (safety)", async () => {
    const out = await runHook(RUN_TOOL, {
      ENABLE_HITL: "false",
      HITL_AUTO_APPROVE: "true",
    });
    expect(out.trim()).toBe("");
  });

  it("ignores tools other than run_tool", async () => {
    const out = await runHook("mcp__plugin_glean-vnext_glean__search", onOn);
    expect(out.trim()).toBe("");
  });
});
