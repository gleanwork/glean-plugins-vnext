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

interface HookResult {
  out: string;
  // Parsed contents of the single permission-mode marker the hook wrote, or
  // null when none was written. markerFiles lists the filenames present.
  marker: { permission_mode?: string; ts?: number } | null;
  markerFiles: string[];
}

async function runHook(
  toolName: string,
  env: Record<string, string>,
  extraInput: Record<string, unknown> = {},
  seed?: { sessionId: string; mode: string },
): Promise<HookResult> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "approve-hook-"));
  await fs.writeFile(
    path.join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { glean: { env } } }),
  );
  // Isolate the marker under a throwaway CLAUDE_PLUGIN_DATA so the hook never
  // touches the developer's real ~/.glean during tests.
  const dataDir = path.join(root, "plugin-data");
  // Optionally pre-seed a leftover marker (e.g. from a prior
  // --dangerously-skip-permissions session) to prove the hook overwrites it.
  if (seed) {
    const dir = path.join(dataDir, "glean-hitl-mode");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${seed.sessionId}.json`),
      JSON.stringify({ permission_mode: seed.mode, ts: 0 }),
    );
  }
  try {
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn("node", [HOOK], {
        env: {
          ...process.env,
          CLAUDE_PLUGIN_ROOT: root,
          CLAUDE_PLUGIN_DATA: dataDir,
        },
      });
      let o = "";
      child.stdout.on("data", (d) => (o += d.toString()));
      child.on("error", reject);
      child.on("close", () => resolve(o));
      child.stdin.write(JSON.stringify({ tool_name: toolName, ...extraInput }));
      child.stdin.end();
    });

    let markerFiles: string[] = [];
    let marker: HookResult["marker"] = null;
    try {
      const dir = path.join(dataDir, "glean-hitl-mode");
      markerFiles = await fs.readdir(dir);
      if (markerFiles.length) {
        marker = JSON.parse(
          await fs.readFile(path.join(dir, markerFiles[0]), "utf-8"),
        );
      }
    } catch {
      // No marker directory: nothing was written.
    }
    return { out, marker, markerFiles };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const glean = (tool: string) => `mcp__plugin_glean-vnext_glean__${tool}`;
const hitlOn = { ENABLE_HITL: "true" };
const hitlOff = { ENABLE_HITL: "false" };
const bypass = { permission_mode: "bypassPermissions", session_id: "sess-1" };

describe("auto-approve-run-tool hook (Claude Code PreToolUse)", () => {
  it("allows glean run_tool when HITL is on", async () => {
    const { out } = await runHook(glean("run_tool"), hitlOn);
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe("allow");
  });

  it("never allows when HITL is off (safety)", async () => {
    const { out } = await runHook(glean("run_tool"), hitlOff);
    expect(out.trim()).toBe("");
  });

  it("ignores a non-glean run_tool (scoped to this plugin)", async () => {
    const { out } = await runHook("mcp__other-server__run_tool", hitlOn);
    expect(out.trim()).toBe("");
  });

  it("ignores glean tools other than run_tool (e.g. find_skills)", async () => {
    const { out } = await runHook(glean("find_skills"), hitlOn);
    expect(out.trim()).toBe("");
  });
});

describe("auto-approve-run-tool hook (permission-mode marker)", () => {
  it("records the permission_mode marker for run_tool when HITL is on", async () => {
    const { marker, markerFiles } = await runHook(
      glean("run_tool"),
      hitlOn,
      bypass,
    );
    expect(marker).toMatchObject({ permission_mode: "bypassPermissions" });
    expect(typeof marker?.ts).toBe("number");
    expect(markerFiles).toContain("sess-1.json");
  });

  it("keys the marker file by session id (parallel sessions don't collide)", async () => {
    const { markerFiles } = await runHook(glean("run_tool"), hitlOn, {
      permission_mode: "default",
      session_id: "other-session",
    });
    expect(markerFiles).toEqual(["other-session.json"]);
  });

  it("does not write a marker when HITL is off", async () => {
    const { out, marker } = await runHook(glean("run_tool"), hitlOff, bypass);
    expect(out.trim()).toBe("");
    expect(marker).toBeNull();
  });

  it("does not write a marker for a non-glean run_tool", async () => {
    const { marker } = await runHook(
      "mcp__other-server__run_tool",
      hitlOn,
      bypass,
    );
    expect(marker).toBeNull();
  });

  it("writes no marker when permission_mode is absent from the payload", async () => {
    const { out, marker } = await runHook(glean("run_tool"), hitlOn, {
      session_id: "sess-1",
    });
    // Still auto-approves, just has no mode to record.
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe("allow");
    expect(marker).toBeNull();
  });

  it("sanitizes the session id used for the marker filename", async () => {
    const { markerFiles } = await runHook(glean("run_tool"), hitlOn, {
      permission_mode: "default",
      session_id: "weird/../id with spaces",
    });
    expect(markerFiles).toHaveLength(1);
    expect(markerFiles[0]).toMatch(/^[a-zA-Z0-9_-]+\.json$/);
  });

  it("overwrites a leftover bypass marker when the session is resumed without the flag", async () => {
    // Session was first launched with --dangerously-skip-permissions (leftover
    // marker = bypassPermissions), then resumed WITHOUT the flag (current mode
    // = default). The hook rewrites the same per-session marker, clearing the
    // stale bypass so the server re-engages its gate on this call.
    const { marker } = await runHook(
      glean("run_tool"),
      hitlOn,
      { permission_mode: "default", session_id: "sess-1" },
      { sessionId: "sess-1", mode: "bypassPermissions" },
    );
    expect(marker).toMatchObject({ permission_mode: "default" });
  });
});
