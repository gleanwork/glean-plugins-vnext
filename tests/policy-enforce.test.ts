import { describe, expect, it } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  advertisedTools,
  policyRefusal,
  withoutFileArgs,
} from "../src/policy/enforce.js";
import { evaluate } from "../src/policy/evaluate.js";
import type { Decision } from "../src/policy/types.js";

const allSupported = { toolPromotion: true, metaTools: true, fileArgs: true };

// Version rules cannot be exercised through evaluate() under vitest -- the build constant
// is absent, so versionSource is "unknown" and version policy is never enforced. The
// gates are therefore driven from a Decision directly, which is the reason enforce.ts is
// a pure module in the first place.
function decision(over: Partial<Decision> = {}): Decision {
  return {
    deactivated: false,
    versionState: "unenforced",
    features: { ...allSupported },
    showUpgrade: false,
    reasons: [],
    ...over,
  };
}

const setupTool: Tool = {
  name: "setup",
  inputSchema: { type: "object", properties: {} },
};
const findSkillsTool: Tool = {
  name: "find_skills",
  inputSchema: { type: "object", properties: { queries: { type: "array" } } },
};

function makeRunTool(): Tool {
  return {
    name: "run_tool",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        server_id: { type: "string" },
        tool_name: { type: "string" },
        arguments: { type: "object" },
        file_args: { type: "object" },
      },
      required: ["server_id", "tool_name"],
    },
  };
}

const promoted: Tool[] = [
  { name: "search", inputSchema: { type: "object", properties: {} } },
  { name: "chat", inputSchema: { type: "object", properties: {} } },
];
const promotedNames: ReadonlySet<string> = new Set(["search", "chat"]);

function advertise(d: Decision) {
  return advertisedTools({
    decision: d,
    setupTool,
    findSkillsTool,
    runTool: makeRunTool(),
    promoted,
  });
}

function names(d: Decision): string[] {
  return advertise(d).tools.map((t) => t.name);
}

function refusal(name: string, d: Decision) {
  return policyRefusal({ name, decision: d, promoted: promotedNames });
}

function fileArgsAdvertised(d: Decision): boolean {
  const tool = advertise(d).tools.find((t) => t.name === "run_tool");
  const props = (tool?.inputSchema as { properties?: Record<string, unknown> })
    ?.properties;
  return !!props && "file_args" in props;
}

// The regression that matters most: production returns no policy, so every install today
// resolves to this decision. The surface must be exactly what shipped before enforcement.
describe("no policy", () => {
  it("advertises the pre-policy surface, in the pre-policy order", () => {
    const d = evaluate({
      pluginVersion: "0.0.0",
      versionSource: "unknown",
      supportedFeatures: allSupported,
      policy: undefined,
    });
    expect(names(d)).toEqual([
      "find_skills",
      "run_tool",
      "setup",
      "search",
      "chat",
    ]);
    expect(advertise(d).withheld).toEqual([]);
    expect(fileArgsAdvertised(d)).toBe(true);
  });

  it("refuses nothing", () => {
    const d = evaluate({
      pluginVersion: "0.0.0",
      versionSource: "unknown",
      supportedFeatures: allSupported,
      policy: undefined,
    });
    for (const name of ["setup", "find_skills", "run_tool", "search", "chat"]) {
      expect(refusal(name, d)).toBeUndefined();
    }
  });
});

describe("deactivated", () => {
  const d = decision({
    deactivated: true,
    versionState: "blocked",
    // evaluate() reports every feature false when deactivated; the gates must not read
    // that as "the features were individually disabled".
    features: { toolPromotion: false, metaTools: false, fileArgs: false },
  });

  it("advertises setup and nothing else", () => {
    expect(names(d)).toEqual(["setup"]);
    expect(advertise(d).withheld.sort()).toEqual([
      "chat",
      "find_skills",
      "run_tool",
      "search",
    ]);
  });

  it("keeps setup callable -- it is the recovery path", () => {
    expect(refusal("setup", d)).toBeUndefined();
  });

  it("refuses everything else", () => {
    for (const name of ["find_skills", "run_tool", "search", "chat"]) {
      expect(refusal(name, d)?.isError).toBe(true);
    }
  });

  // The ordering guard: a deactivated plugin's problem is its version, and the only
  // remedy is an upgrade. Answering "metaTools is disabled" would send the model and the
  // user after the wrong thing.
  it("blames the version, not the features", () => {
    const text = (refusal("find_skills", d)!.content[0] as { text: string }).text;
    expect(text).toContain("[POLICY_DEACTIVATED]");
    expect(text).toContain("Upgrade the Glean plugin");
    expect(text).not.toContain("metaTools");
  });
});

describe("metaTools disabled", () => {
  const d = decision({ features: { ...allSupported, metaTools: false } });

  it("withdraws both meta tools but keeps setup and promoted tools", () => {
    expect(names(d)).toEqual(["setup", "search", "chat"]);
    expect(advertise(d).withheld).toEqual(["find_skills", "run_tool"]);
  });

  it("refuses both by name, and nothing else", () => {
    expect(refusal("find_skills", d)?.isError).toBe(true);
    expect(refusal("run_tool", d)?.isError).toBe(true);
    expect(refusal("search", d)).toBeUndefined();
    expect(refusal("setup", d)).toBeUndefined();
  });
});

describe("toolPromotion disabled", () => {
  const d = decision({ features: { ...allSupported, toolPromotion: false } });

  it("promotes none, and keeps the meta tools", () => {
    expect(names(d)).toEqual(["find_skills", "run_tool", "setup"]);
    expect(advertise(d).withheld).toEqual(["search", "chat"]);
  });

  // This is the case that motivated call-time enforcement at all: a host holding a stale
  // list still shows `search` to the model, and without the refusal the call would be
  // forwarded happily.
  it("refuses every promoted name even though none are advertised", () => {
    expect(refusal("search", d)?.isError).toBe(true);
    expect(refusal("chat", d)?.isError).toBe(true);
  });

  it("does not refuse a name outside the promoted set", () => {
    // Left to the handler's existing "Unknown tool" branch.
    expect(refusal("something_else", d)).toBeUndefined();
  });
});

describe("fileArgs disabled", () => {
  const d = decision({ features: { ...allSupported, fileArgs: false } });

  it("keeps run_tool but drops file_args from its schema", () => {
    expect(names(d)).toEqual([
      "find_skills",
      "run_tool",
      "setup",
      "search",
      "chat",
    ]);
    expect(fileArgsAdvertised(d)).toBe(false);
  });

  it("leaves the rest of the schema intact", () => {
    const tool = advertise(d).tools.find((t) => t.name === "run_tool")!;
    const schema = tool.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties).sort()).toEqual([
      "arguments",
      "server_id",
      "tool_name",
    ]);
    expect(schema.required).toEqual(["server_id", "tool_name"]);
    expect(tool.annotations).toEqual({ readOnlyHint: true });
  });

  // run_tool itself stays callable -- only a call that passes file_args is rejected, and
  // that check lives beside the code that reads the files.
  it("does not refuse run_tool at the funnel", () => {
    expect(refusal("run_tool", d)).toBeUndefined();
  });
});

// The shared-schema hazard: index.ts clones RUN_TOOL_TOOL with a shallow spread, so
// inputSchema.properties is the module const's own object. A delete would drop file_args
// for the life of the process and survive a policy flip back to enabled.
describe("withoutFileArgs", () => {
  it("does not mutate the tool it is given", () => {
    const base = makeRunTool();
    withoutFileArgs(base);
    const props = (base.inputSchema as { properties: Record<string, unknown> })
      .properties;
    expect("file_args" in props).toBe(true);
  });

  it("survives a flip back to enabled on the same base tool", () => {
    const base = makeRunTool();
    const off = advertisedTools({
      decision: decision({ features: { ...allSupported, fileArgs: false } }),
      setupTool,
      findSkillsTool,
      runTool: base,
      promoted,
    });
    const on = advertisedTools({
      decision: decision(),
      setupTool,
      findSkillsTool,
      runTool: base,
      promoted,
    });
    const propsOf = (a: typeof off) => {
      const t = a.tools.find((x) => x.name === "run_tool")!;
      return (t.inputSchema as { properties: Record<string, unknown> }).properties;
    };
    expect("file_args" in propsOf(off)).toBe(false);
    expect("file_args" in propsOf(on)).toBe(true);
  });

  it("is a no-op for a tool that never had file_args", () => {
    expect(withoutFileArgs(findSkillsTool)).toBe(findSkillsTool);
  });
});
