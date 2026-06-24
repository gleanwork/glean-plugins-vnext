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

const glean = (tool: string) => `mcp__plugin_glean-vnext_glean__${tool}`;
const hitlOn = { ENABLE_HITL: "true" };
const hitlOff = { ENABLE_HITL: "false" };

describe("auto-approve-run-tool hook (Claude Code PreToolUse)", () => {
  it("allows glean run_tool when HITL is on", async () => {
    const out = await runHook(glean("run_tool"), hitlOn);
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe("allow");
  });

  it("never allows when HITL is off (safety)", async () => {
    const out = await runHook(glean("run_tool"), hitlOff);
    expect(out.trim()).toBe("");
  });

  it("ignores a non-glean run_tool (scoped to this plugin)", async () => {
    const out = await runHook("mcp__other-server__run_tool", hitlOn);
    expect(out.trim()).toBe("");
  });

  it("ignores glean tools other than run_tool (e.g. find_skills)", async () => {
    const out = await runHook(glean("find_skills"), hitlOn);
    expect(out.trim()).toBe("");
  });
});
