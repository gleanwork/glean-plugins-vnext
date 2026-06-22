#!/usr/bin/env node
// PROTOTYPE (flag-gated). PreToolUse hook for Claude Code.
//
// When HITL is the approval gate, the plugin's own elicitation prompt is the
// single source of truth for approving a run_tool call — so Claude Code's
// separate native "allow this tool?" prompt is redundant (the double-prompt).
// When HITL_AUTO_APPROVE=true AND ENABLE_HITL=true, auto-approve the run_tool
// call so only the HITL prompt remains.
//
// Safety: never auto-approves when ENABLE_HITL is not "true" — otherwise a
// write action could run with no approval at all. Default flag is off.
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
// Only this plugin's run_tool meta-tool (exposed as mcp__<server>__run_tool).
if (!toolName.endsWith("run_tool")) process.exit(0);

// The hook process does not inherit the MCP server's env, so read the flags
// from the plugin's own .mcp.json.
let env = {};
try {
  const root = process.env.CLAUDE_PLUGIN_ROOT ?? ".";
  const cfg = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf-8"));
  env = cfg?.mcpServers?.glean?.env ?? {};
} catch {
  // No readable config: do nothing.
}

const hitlOn = env.ENABLE_HITL === "true";
const autoApprove = env.HITL_AUTO_APPROVE === "true";

if (hitlOn && autoApprove) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason:
          "Glean HITL gates run_tool via its own elicitation prompt; suppressing the redundant native prompt (HITL_AUTO_APPROVE).",
      },
    }),
  );
}
process.exit(0);
