import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RUN_CODE_ENV_VAR,
  isRunCodeEnabled,
} from "../src/run-code-mode.js";
import { formatAvailableSkillsPrompt } from "../src/skill-writer.js";
import type { SkillIndex } from "../src/types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const index: SkillIndex[] = [
  {
    name: "agent_builder",
    description: "Build and retrieve agents",
    skillDir: "/tmp/skills/agent_builder",
    files: ["/tmp/skills/agent_builder/SKILL.md"],
  },
];

describe("experimental run_code feature gate", () => {
  it("enables only for the exact lowercase string true", () => {
    expect(isRunCodeEnabled({ [RUN_CODE_ENV_VAR]: "true" })).toBe(true);
    for (const value of [undefined, "", "false", "TRUE", "1", "yes", "${FLAG}"]) {
      expect(isRunCodeEnabled({ [RUN_CODE_ENV_VAR]: value })).toBe(false);
    }
  });

  it("keeps discovery output free of run_code/PTC guidance when disabled", () => {
    const output = formatAvailableSkillsPrompt(index, { codeMode: false });
    expect(output).not.toContain("<instructions>");
    expect(output).not.toContain("run_code");
    expect(output).not.toContain("PTC_");
  });

  it("adds run_code/PTC guidance to discovery only when enabled", () => {
    const output = formatAvailableSkillsPrompt(index, { codeMode: true });
    expect(output).toContain("<instructions>");
    expect(output).toContain("PREFER run_code");
    expect(output).toContain("PTC_<TOOL_NAME>");
  });

  it("does not force-enable run_code in the shipped Claude MCP config", async () => {
    const config = JSON.parse(
      await fs.readFile(path.join(repoRoot, "plugins/glean/.mcp.json"), "utf8"),
    ) as { mcpServers: { glean: { env?: Record<string, string> } } };
    expect(config.mcpServers.glean.env).not.toHaveProperty(RUN_CODE_ENV_VAR);
  });

  it("keeps the static skill baseline and lazily references the experimental guide", async () => {
    const skill = await fs.readFile(
      path.join(repoRoot, "plugins/glean/skills/glean_run/SKILL.md"),
      "utf8",
    );
    expect(skill).toContain(
      "description: Discover and run Glean skills for enterprise app tasks",
    );
    expect(skill).toContain("If and only if a `run_code` tool is present");
    expect(skill).toContain(
      "${CLAUDE_PLUGIN_ROOT}/guides/glean-run-code.md",
    );
    expect(skill).toContain("If `run_code` is absent, do not read the guide");

    // Detailed experimental instructions must not enter context with the static
    // skill. They are loaded through Read only after runtime tool detection.
    expect(skill).not.toContain("node:child_process");
    expect(skill).not.toContain("PTC_GET_AGENT");
    expect(skill).not.toContain("node:vm");
  });

  it("stores the detailed run_code guide outside every auto-discovered skills directory", async () => {
    const relativeGuide = "plugins/glean/guides/glean-run-code.md";
    const guide = await fs.readFile(path.join(repoRoot, relativeGuide), "utf8");
    expect(relativeGuide).not.toContain("/skills/");
    expect(guide).toContain("# Experimental Glean `run_code` Guide");
    expect(guide).toContain("node:child_process");
    expect(guide).toContain("PTC_GET_AGENT");
    expect(guide).toContain("node:vm");
    expect(guide).toContain("is not a security boundary");
  });
});
