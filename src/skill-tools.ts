import fs from "node:fs/promises";
import path from "node:path";

/**
 * Metadata for a single downstream tool, read from a cached
 * <skillsBaseDir>/<skill>/tools/<TOOL>.json file. The find_skills flow writes
 * these files; both run_tool (for HITL lookup) and run_code (for binding
 * generation) read them through here.
 */
export interface ToolMeta {
  /** Tool name == the JSON filename stem (e.g. "JIRA_CREATE_ISSUE"). */
  toolName: string;
  /** Owning skill directory name. */
  skillName: string;
  /** Downstream MCP server id this tool dispatches to ("" for direct tools). */
  serverId: string;
  requiresApproval: boolean;
  /**
   * "Head"/first-class remote tools (search, read_document, …) are called
   * directly on the remote client by name, NOT via the run_tool gateway. The
   * run_code bridge checks this flag to pick the dispatch path.
   */
  direct: boolean;
  description: string;
}

interface RawToolJson {
  server_id?: string;
  requires_approval?: boolean;
  direct?: boolean;
  description?: string;
}

/** Minimal shape of a head/first-class remote tool (from tools/list). */
export interface HeadTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

// Head tools are written under this synthetic skill dir so discoverTools binds
// them uniformly. The leading "_" keeps it out of the way alphabetically and
// out of the find_skills response skill set (writeSkillsToDisk never rm's it).
export const CORE_SKILL = "_core";

export type SkillsBaseDirInput = string | readonly string[];

/** Normalize one or more cache roots, preserving caller-provided precedence. */
export function normalizeSkillsBaseDirs(input: SkillsBaseDirInput): string[] {
  const roots = typeof input === "string" ? [input] : [...input];
  return [...new Set(roots.filter(Boolean).map((root) => path.resolve(root)))];
}

/**
 * Discover every cached tool across one or more cache roots. Root precedence is
 * caller-defined (managed/current first, project-local fallback second); within
 * each root, skills and tool files are sorted for deterministic resolution.
 */
export async function discoverTools(
  skillsBaseDirs: SkillsBaseDirInput,
): Promise<ToolMeta[]> {
  const out: ToolMeta[] = [];

  for (const skillsBaseDir of normalizeSkillsBaseDirs(skillsBaseDirs)) {
    let skillDirs;
    try {
      skillDirs = await fs.readdir(skillsBaseDir, { withFileTypes: true });
    } catch {
      continue;
    }

    const sortedSkills = skillDirs
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();

    for (const skillName of sortedSkills) {
      const toolsDir = path.join(skillsBaseDir, skillName, "tools");
      let toolFiles;
      try {
        toolFiles = await fs.readdir(toolsDir);
      } catch {
        continue;
      }
      for (const file of toolFiles.filter((f) => f.endsWith(".json")).sort()) {
        const toolName = file.slice(0, -".json".length);
        try {
          const raw = JSON.parse(
            await fs.readFile(path.join(toolsDir, file), "utf-8"),
          ) as RawToolJson;
          const direct = raw.direct === true;
          // Gateway tools need a server_id; direct (head) tools don't.
          if (typeof raw.server_id !== "string" && !direct) continue;
          out.push({
            toolName,
            skillName,
            serverId: typeof raw.server_id === "string" ? raw.server_id : "",
            requiresApproval: raw.requires_approval === true,
            direct,
            description:
              typeof raw.description === "string" ? raw.description : "",
          });
        } catch {
          continue;
        }
      }
    }
  }
  return out;
}

/**
 * Resolve an exact tool name first, then a unique case-insensitive spelling.
 * Duplicate copies of the same canonical spelling across cache roots are fine;
 * genuinely distinct case-only names (e.g. foo + FOO) remain ambiguous/null.
 */
export function findToolMetaByName(
  all: readonly ToolMeta[],
  requestedName: string,
): ToolMeta | null {
  const exact = all.find((tool) => tool.toolName === requestedName);
  if (exact) return exact;

  const folded = requestedName.toLowerCase();
  const matches = all.filter(
    (tool) => tool.toolName.toLowerCase() === folded,
  );
  if (new Set(matches.map((tool) => tool.toolName)).size !== 1) return null;
  return matches[0] ?? null;
}

export async function findToolMeta(
  skillsBaseDirs: SkillsBaseDirInput,
  toolName: string,
): Promise<ToolMeta | null> {
  return findToolMetaByName(await discoverTools(skillsBaseDirs), toolName);
}

/**
 * Materialize the head/first-class remote tools as `_core/tools/<name>.json`
 * files (tagged direct:true) so discoverTools binds them and the model can read
 * their inputSchema like any other tool. rm-and-recreates so a tool dropped
 * from the allow-list disappears. No-op (and leaves any prior _core intact)
 * when the head-tool list is empty, so a transient empty cache doesn't wipe it.
 */
export async function writeCoreTools(
  skillsBaseDir: string,
  headTools: HeadTool[],
): Promise<void> {
  if (!headTools.length) return;
  const coreDir = path.join(skillsBaseDir, CORE_SKILL);
  const toolsDir = path.join(coreDir, "tools");
  try {
    await fs.rm(coreDir, { recursive: true, force: true });
    await fs.mkdir(toolsDir, { recursive: true });
    await Promise.all(
      headTools.map((t) =>
        fs.writeFile(
          path.join(toolsDir, `${t.name}.json`),
          JSON.stringify(
            {
              name: t.name,
              direct: true,
              requires_approval: false,
              description: t.description ?? "",
              inputSchema: t.inputSchema ?? { type: "object", properties: {} },
            },
            null,
            2,
          ),
          "utf-8",
        ),
      ),
    );
  } catch {
    /* best-effort */
  }
}

