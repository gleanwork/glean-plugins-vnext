import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Decision } from "./types.js";

// The tool that policy can never withdraw. A deactivated plugin advertises only this,
// because it is how a user restores the connection that would lift the deactivation.
export const SETUP_TOOL_NAME = "setup";

// Gated together by `metaTools`, and gated as a pair on purpose: a surface with
// find_skills but no run_tool can discover work it cannot perform.
export const META_TOOL_NAMES: ReadonlySet<string> = new Set([
  "find_skills",
  "run_tool",
]);

/**
 * `run_tool` with `file_args` removed from its advertised schema, so a disabled
 * fileArgs feature is genuinely inert rather than present-and-rejected.
 *
 * Returns a NEW tool at every level it changes. The caller clones RUN_TOOL_TOOL with a
 * shallow spread, so `inputSchema.properties` is shared with that module-level const --
 * deleting from it would drop `file_args` for the life of the process and survive a
 * later policy flip back to enabled.
 */
export function withoutFileArgs(tool: Tool): Tool {
  const schema = tool.inputSchema as { properties?: Record<string, unknown> };
  if (!schema?.properties || !("file_args" in schema.properties)) return tool;
  const { file_args: _dropped, ...rest } = schema.properties;
  return {
    ...tool,
    inputSchema: { ...schema, properties: rest } as Tool["inputSchema"],
  };
}

export interface Advertisement {
  tools: Tool[];
  /** Names policy withheld, for the served log line. */
  withheld: string[];
}

/**
 * The tool surface policy allows, composed from the decision and the tools on offer.
 *
 * Order is preserved from the pre-policy implementation so that the no-policy case --
 * every install today -- produces a byte-identical list.
 */
export function advertisedTools(input: {
  decision: Decision;
  setupTool: Tool;
  findSkillsTool: Tool;
  runTool: Tool;
  promoted: Tool[];
}): Advertisement {
  const { decision, setupTool, findSkillsTool, runTool, promoted } = input;

  if (decision.deactivated) {
    return {
      tools: [setupTool],
      withheld: [
        findSkillsTool.name,
        runTool.name,
        ...promoted.map((t) => t.name),
      ],
    };
  }

  const tools: Tool[] = [];
  const withheld: string[] = [];

  if (decision.features.metaTools) {
    tools.push(
      findSkillsTool,
      decision.features.fileArgs ? runTool : withoutFileArgs(runTool),
    );
  } else {
    withheld.push(findSkillsTool.name, runTool.name);
  }

  tools.push(setupTool);

  if (decision.features.toolPromotion) {
    tools.push(...promoted);
  } else {
    withheld.push(...promoted.map((t) => t.name));
  }

  return { tools, withheld };
}

function refuse(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * The refusal policy requires for a call, or undefined when the call may proceed.
 *
 * Advertisement is not the gate; this is. A host may re-fetch its tool list late or
 * never, and a model can call a tool still sitting in its context from an earlier list,
 * so a feature withdrawn from `tools/list` stays reachable until it is also refused
 * here. `toolPromotion` is the clearest case: a promoted tool would otherwise keep
 * working indefinitely after being withdrawn.
 *
 * Covers only the gates that make a tool uncallable. `fileArgs` is argument-level and
 * belongs next to the code that reads the files; `hitl` changes how run_tool executes,
 * never whether it runs, and is not declared by this build at all.
 */
export function policyRefusal(input: {
  name: string;
  decision: Decision;
  promoted: ReadonlySet<string>;
}): CallToolResult | undefined {
  const { name, decision, promoted } = input;

  // Before every other check: setup is the recovery path, so it stays callable in
  // states where nothing else is -- including deactivation.
  if (name === SETUP_TOOL_NAME) return undefined;

  // Ahead of the feature checks deliberately. `evaluate` reports every feature as false
  // when deactivated, so testing features first would answer "metaTools is disabled"
  // for a plugin whose actual problem, and only remedy, is its version.
  if (decision.deactivated) {
    // The remote's own upgrade text when it supplied one -- the design assigns
    // upgradeRecommendation.message this job as well as the soft recommendation, since
    // the remedy is an upgrade either way, and it may carry instructions we do not know.
    const remedy =
      decision.upgradeMessage ??
      "Upgrade the Glean plugin, then call `setup` to confirm the connection.";
    return refuse(
      `[POLICY_DEACTIVATED]\n\nThis version of the Glean plugin is not supported by ` +
        `your Glean instance, so only \`setup\` is available and ${name} will not run. ` +
        `Do not retry. ${remedy}`,
    );
  }

  if (META_TOOL_NAMES.has(name) && !decision.features.metaTools) {
    return refuse(
      `${name} is disabled for your Glean instance by remote policy and will not run. ` +
        `Do not retry — this is not a transient failure. Call \`setup\` to see the ` +
        `policy currently in force.`,
    );
  }

  if (promoted.has(name) && !decision.features.toolPromotion) {
    return refuse(
      `${name} is not available: Glean tool promotion is disabled for your instance by ` +
        `remote policy, so this call will not run. Do not retry. Call \`setup\` to see ` +
        `the policy currently in force.`,
    );
  }

  return undefined;
}

/** Refusal for a `run_tool` call that passes `file_args` while the feature is disabled. */
export const FILE_ARGS_DISABLED_TEXT =
  "`file_args` is disabled for your Glean instance by remote policy, so no file was " +
  "read and the tool was not executed. Retry `run_tool` with the values inline in " +
  "`arguments` instead.";

/**
 * The closing sentence of `setup`: exactly what the caller may invoke right now.
 *
 * There used to be two lists here, and they disagreed the moment policy withheld
 * anything -- `setup` printed the remote's whole catalog ("Remote tools: search, chat,
 * ...") and then closed with "You can now use find_skills, run_tool". A model reading
 * that has been handed names it may call, most of which are not advertised and would be
 * refused on call. The remote's catalog is the remote's business, so it is gone and this
 * is the single authoritative list.
 *
 * Scoped to naming tools and nothing else. Deactivation status and the remote's upgrade
 * message belong to policySummary(), which prints them a few lines above -- stating the
 * consequence here as well duplicated it, and when the remote supplied its own wording
 * the specific instruction ("Run `claude plugin update glean`") was immediately followed
 * by a vaguer restatement of it.
 *
 * No deactivation branch is needed to achieve that: evaluate() reports every feature as
 * false when deactivated, so the empty case below is reached without asking. Meta-tool
 * names come from META_TOOL_NAMES so this cannot drift from what advertisedTools()
 * actually serves.
 */
export function setupClosingLine(input: {
  decision: Decision;
  promoted: readonly string[];
}): string {
  const { decision, promoted } = input;
  const usable = [
    ...(decision.features.metaTools ? [...META_TOOL_NAMES] : []),
    ...(decision.features.toolPromotion ? promoted : []),
  ];
  // Two ways to get here, deliberately answered the same way: a deactivated plugin, and
  // a policy that disables metaTools and toolPromotion together without deactivating.
  // The cause is on the `Policy:`/`Deactivated:` lines above; this states only the
  // consequence, because without it the second case leaves the feature JSON as the sole
  // hint that nothing is callable. Unguarded, the sentence degrades to "You can now use ."
  if (usable.length === 0) {
    return `No tools are available beyond \`${SETUP_TOOL_NAME}\`.`;
  }
  return `You can now use ${usable.join(", ")}.`;
}
