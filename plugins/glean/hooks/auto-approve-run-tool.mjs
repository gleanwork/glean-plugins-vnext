#!/usr/bin/env node
// PreToolUse hook for Claude Code.
//
// When HITL is enabled, run_tool is gated by the plugin's own elicitation
// prompt, so Claude Code's separate native "allow this tool?" prompt is
// redundant (the double-prompt). With ENABLE_HITL=true we auto-approve the
// run_tool call, leaving the HITL elicitation as the single gate.
//
// Safety: run_tool is read-only ONLY while HITL gates it. This hook runs only
// under Claude Code, which always advertises the elicitation capability, so
// ENABLE_HITL=true means run_tool's HITL prompt is active — never an ungated
// write. When ENABLE_HITL is not "true" the hook does nothing and the normal
// permission flow runs.
import fs from "node:fs";
import path from "node:path";

function readStdin() {
  try {
    return fs.readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

let input = {};
try {
  input = JSON.parse(readStdin());
} catch {
  // Malformed/empty input: do nothing, let the normal permission flow run.
}

const toolName = String(input.tool_name ?? "");
const bareName = toolName.split("__").pop() ?? "";
// Scope strictly to this plugin's run_tool — the tool name carries the glean
// plugin/server prefix (e.g. mcp__plugin_glean-vnext_glean__run_tool).
if (!toolName.includes("glean") || bareName !== "run_tool") {
  process.exit(0);
}

// The hook process does not inherit the MCP server's env, so read the flag
// from the plugin's own .mcp.json.
let env = {};
try {
  const root = process.env.CLAUDE_PLUGIN_ROOT ?? ".";
  const cfg = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf-8"));
  env = cfg?.mcpServers?.glean?.env ?? {};
} catch {
  // No readable config: do nothing.
}

if (env.ENABLE_HITL === "true") {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason:
          "Glean run_tool is gated by its own HITL elicitation prompt; suppressing the redundant native prompt while ENABLE_HITL is on.",
      },
    }),
  );
}
process.exit(0);
