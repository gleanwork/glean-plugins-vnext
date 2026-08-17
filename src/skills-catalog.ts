// MCP skills extension (`io.modelcontextprotocol/skills`, draft SEP-2640),
// backed by Glean's Platform Skills API.
//
// Hosts that support the extension (e.g. ChatGPT's plugin importer) call
// `skills/list` to get a catalog of skills, each entry naming its SKILL.md
// plus every supporting resource with a sha256 digest, then `resources/read`
// to fetch the bytes. We build that catalog from:
//
//   GET /api/skills                  → skill metadata, cursor-paginated
//   GET /api/skills/{id}/content     → the installable bundle (zip or a bare
//                                      SKILL.md)
//
// Both are experimental Platform APIs, so requests carry
// `X-Glean-Include-Experimental: true`. Auth reuses the OAuth access token
// `setup` already captured — the Platform API lives on the same origin as the
// MCP gateway and takes the same bearer token.
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import yaml from "yaml";
// Match the MCP SDK's own zod entrypoint (`zod/v4`) so the bundle carries one
// copy of zod, not two.
import * as z from "zod/v4";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ErrorCode,
  McpError,
  RequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { isZip, unzip } from "./zip.js";

export const SKILLS_CAPABILITY = "io.modelcontextprotocol/skills";

/** `skill://<server>/<skill-name>/<path>` — the dir must match the skill name. */
const URI_PREFIX = "skill://glean/";

const PAGE_SIZE = 10;

// Import limits from the MCP-skills spec. Anything over is dropped (and
// logged) here rather than failing the whole catalog on the importer side.
const MAX_SKILL_MD_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SKILL_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 100;

// Bound the crawl a `resources/read` cache miss can trigger (see read()).
const MAX_CRAWL_PAGES = 10;

type LogFn = (label: string, detail?: Record<string, unknown>) => void;

export interface CatalogAuth {
  /** Glean backend origin, e.g. `https://acme-be.glean.com`. */
  origin: string;
  /** OAuth access token captured by `setup`. */
  token: string;
}

export interface CatalogDeps {
  /** Undefined when Glean is unconfigured or the user isn't signed in. */
  getAuth: () => CatalogAuth | undefined;
  log: LogFn;
  fetchImpl?: typeof fetch;
}

export interface SkillResourceRef {
  uri: string;
  digest: string;
}

export interface SkillCatalogEntry {
  uri: string;
  frontmatter: Record<string, unknown>;
  resources: SkillResourceRef[];
}

interface CachedResource {
  uri: string;
  bytes: Buffer;
  mimeType: string;
}

interface PlatformSkill {
  id: string;
  display_name?: string;
  description?: string;
  status?: string;
}

export interface SkillsCatalog {
  list(cursor?: string): Promise<{
    skills: SkillCatalogEntry[];
    nextCursor?: string;
  }>;
  get(uri: string): Promise<SkillCatalogEntry>;
  read(uri: string): Promise<CachedResource>;
  listResources(): SkillResourceRef[];
}

export function createSkillsCatalog(deps: CatalogDeps): SkillsCatalog {
  const doFetch = deps.fetchImpl ?? fetch;
  const entries = new Map<string, SkillCatalogEntry>(); // SKILL.md uri → entry
  const resources = new Map<string, CachedResource>(); // resource uri → bytes
  const skillIdByName = new Map<string, string>();
  let crawled = false;

  async function apiGet(pathAndQuery: string): Promise<Response> {
    const auth = deps.getAuth();
    if (!auth) throw new NotSignedInError();
    const res = await doFetch(`${auth.origin}${pathAndQuery}`, {
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "X-Glean-Include-Experimental": "true",
        Accept: "*/*",
      },
    });
    if (!res.ok) {
      throw new Error(`GET ${pathAndQuery} failed: ${res.status}`);
    }
    return res;
  }

  async function fetchPage(
    cursor?: string,
  ): Promise<{ skills: PlatformSkill[]; nextCursor?: string }> {
    const params = new URLSearchParams({ page_size: String(PAGE_SIZE) });
    if (cursor) params.set("cursor", cursor);
    const res = await apiGet(`/api/skills?${params.toString()}`);
    const body = (await res.json()) as {
      skills?: PlatformSkill[];
      has_more?: boolean;
      next_cursor?: string | null;
    };
    return {
      skills: Array.isArray(body.skills) ? body.skills : [],
      nextCursor:
        body.has_more && body.next_cursor ? body.next_cursor : undefined,
    };
  }

  async function fetchBundle(skillId: string): Promise<Map<string, Buffer>> {
    const res = await apiGet(
      `/api/skills/${encodeURIComponent(skillId)}/content`,
    );
    const buf = Buffer.from(await res.arrayBuffer());
    // A single-file skill can come back as a bare SKILL.md rather than an
    // archive.
    return isZip(buf) ? unzip(buf) : new Map([["SKILL.md", buf]]);
  }

  /** Cache an entry + its bytes, so `resources/read` needs no refetch. */
  function cache(entry: SkillCatalogEntry, files: CachedResource[]): void {
    entries.set(entry.uri, entry);
    for (const file of files) resources.set(file.uri, file);
  }

  async function loadSkill(
    skill: PlatformSkill,
  ): Promise<SkillCatalogEntry | undefined> {
    if (skill.status && skill.status !== "ENABLED") {
      deps.log("skills.skipped", { id: skill.id, reason: skill.status });
      return undefined;
    }
    let bundle: Map<string, Buffer>;
    try {
      bundle = await fetchBundle(skill.id);
    } catch (err) {
      deps.log("skills.bundle-failed", { id: skill.id, msg: message(err) });
      return undefined;
    }
    const built = buildSkillEntry(skill, bundle, deps.log);
    if (!built) return undefined;

    const owner = skillIdByName.get(built.name);
    if (owner && owner !== skill.id) {
      // Importers require unique skill names; keep the first one we saw.
      deps.log("skills.duplicate-name", { id: skill.id, name: built.name });
      return undefined;
    }
    skillIdByName.set(built.name, skill.id);
    cache(built.entry, built.files);
    return built.entry;
  }

  async function list(
    cursor?: string,
  ): Promise<{ skills: SkillCatalogEntry[]; nextCursor?: string }> {
    const page = await fetchPage(cursor);
    const loaded = await Promise.all(
      page.skills.map((skill) => loadSkill(skill).catch(() => undefined)),
    );
    const skills = loaded.filter((e): e is SkillCatalogEntry => !!e);
    deps.log("skills-list.served", {
      requested: page.skills.length,
      served: skills.length,
      hasMore: !!page.nextCursor,
    });
    return { skills, nextCursor: page.nextCursor };
  }

  /**
   * Walk every page once. Only used to recover from a `resources/read` for a
   * URI this process never listed (e.g. the host reconnected between
   * `skills/list` and the reads).
   */
  async function crawl(): Promise<void> {
    let cursor: string | undefined;
    try {
      for (let page = 0; page < MAX_CRAWL_PAGES; page++) {
        const res = await list(cursor);
        cursor = res.nextCursor;
        if (!cursor) break;
      }
    } catch (err) {
      if (err instanceof NotSignedInError) {
        throw new McpError(ErrorCode.InvalidRequest, err.message);
      }
      throw err;
    }
    crawled = true;
  }

  return {
    list,

    async get(uri: string): Promise<SkillCatalogEntry> {
      const hit = entries.get(uri);
      if (hit) return hit;
      if (!crawled) await crawl();
      const entry = entries.get(uri);
      if (!entry) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown skill: ${uri}`);
      }
      return entry;
    },

    async read(uri: string): Promise<CachedResource> {
      const hit = resources.get(uri);
      if (hit) return hit;
      if (!crawled) await crawl();
      const resource = resources.get(uri);
      if (!resource) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${uri}`);
      }
      return resource;
    },

    // ponytail: only what this process has already listed. Enumerating every
    // skill here would mean downloading every bundle on the host's startup
    // resources/list — the skills flow (skills/list → resources/read) never
    // needs it.
    listResources(): SkillResourceRef[] {
      return [...resources.values()].map((r) => ({
        uri: r.uri,
        digest: digestOf(r.bytes),
      }));
    },
  };
}

class NotSignedInError extends Error {
  constructor() {
    super("Glean is not configured or not signed in — run the `setup` tool.");
  }
}

/**
 * Turn a downloaded bundle into a catalog entry plus its resource bytes.
 * Returns undefined (after logging) for bundles we can't serve.
 */
export function buildSkillEntry(
  skill: PlatformSkill,
  bundle: Map<string, Buffer>,
  log: LogFn,
): { name: string; entry: SkillCatalogEntry; files: CachedResource[] } | undefined {
  const files = normalizeBundle(bundle);
  const skillMd = files.get("SKILL.md");
  if (!skillMd) {
    log("skills.no-skill-md", { id: skill.id });
    return undefined;
  }
  if (skillMd.length > MAX_SKILL_MD_BYTES) {
    log("skills.skill-md-too-large", { id: skill.id, bytes: skillMd.length });
    return undefined;
  }

  const frontmatter = parseFrontmatter(skillMd.toString("utf-8"));
  const name = resolveSkillName(frontmatter.name, skill);
  frontmatter.name = name; // the directory in the URI must match the name
  if (typeof frontmatter.description !== "string" || !frontmatter.description) {
    frontmatter.description = skill.description ?? "";
  }

  const resources: CachedResource[] = [];
  let total = 0;
  for (const [relPath, bytes] of files) {
    if (bytes.length > MAX_FILE_BYTES) {
      log("skills.file-too-large", { id: skill.id, path: relPath });
      continue;
    }
    if (resources.length >= MAX_FILES) {
      log("skills.file-count-capped", { id: skill.id, path: relPath });
      continue;
    }
    total += bytes.length;
    if (total > MAX_SKILL_BYTES) {
      log("skills.bundle-too-large", { id: skill.id, bytes: total });
      return undefined;
    }
    resources.push({
      uri: `${URI_PREFIX}${name}/${relPath}`,
      bytes,
      mimeType: mimeTypeFor(relPath, bytes),
    });
  }

  const uri = `${URI_PREFIX}${name}/SKILL.md`;
  return {
    name,
    entry: {
      uri,
      frontmatter,
      resources: resources.map((r) => ({
        uri: r.uri,
        digest: digestOf(r.bytes),
      })),
    },
    files: resources,
  };
}

/**
 * Bundles may wrap their files in a single top-level directory. Strip it so
 * SKILL.md sits at the root, and drop anything that escapes the bundle.
 */
export function normalizeBundle(
  bundle: Map<string, Buffer>,
): Map<string, Buffer> {
  const safe = new Map<string, Buffer>();
  for (const [rawPath, bytes] of bundle) {
    const relPath = rawPath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!relPath || relPath.split("/").includes("..")) continue;
    safe.set(relPath, bytes);
  }
  if (safe.has("SKILL.md")) return safe;

  const paths = [...safe.keys()];
  const prefix = paths[0]?.includes("/") ? `${paths[0].split("/")[0]}/` : "";
  if (!prefix || !paths.every((p) => p.startsWith(prefix))) return safe;
  return new Map(
    paths.map((p) => [p.slice(prefix.length), safe.get(p) as Buffer]),
  );
}

export function digestOf(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  try {
    const parsed = yaml.parse(match[1]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    // Round-trip so dates and other YAML scalars land on the wire as JSON.
    return JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const SAFE_NAME = /^[a-z0-9][a-z0-9._-]*$/;

function resolveSkillName(
  frontmatterName: unknown,
  skill: PlatformSkill,
): string {
  if (typeof frontmatterName === "string" && SAFE_NAME.test(frontmatterName)) {
    return frontmatterName;
  }
  const fallback =
    typeof frontmatterName === "string" && frontmatterName
      ? frontmatterName
      : skill.display_name || skill.id;
  return (
    fallback
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|-+$/g, "")
      .slice(0, 64) || skill.id
  );
}

function mimeTypeFor(relPath: string, bytes: Buffer): string {
  const ext = relPath.slice(relPath.lastIndexOf(".")).toLowerCase();
  switch (ext) {
    case ".md":
      return "text/markdown";
    case ".json":
      return "application/json";
    case ".yaml":
    case ".yml":
      return "application/yaml";
    case ".txt":
      return "text/plain";
    case ".csv":
      return "text/csv";
    default:
      return isUtf8(bytes) ? "text/plain" : "application/octet-stream";
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const SkillsListRequestSchema = RequestSchema.extend({
  method: z.literal("skills/list"),
  params: z.looseObject({ cursor: z.string().optional() }).optional(),
});

export const SkillsGetRequestSchema = RequestSchema.extend({
  method: z.literal("skills/get"),
  params: z.looseObject({ uri: z.string() }),
});

/**
 * Wire `skills/list`, `skills/get` and `resources/read` onto the server. The
 * caller must advertise both the `resources` capability and the
 * `io.modelcontextprotocol/skills` extension for hosts to use these.
 */
export function registerSkillsExtension(
  server: Server,
  deps: CatalogDeps,
): SkillsCatalog {
  const catalog = createSkillsCatalog(deps);

  server.setRequestHandler(SkillsListRequestSchema, async (request) => {
    try {
      const page = await catalog.list(request.params?.cursor);
      return { skills: page.skills, nextCursor: page.nextCursor };
    } catch (err) {
      // An unconfigured or signed-out user is the normal state on a fresh
      // install; an empty catalog beats a protocol error the host surfaces.
      if (err instanceof NotSignedInError) {
        deps.log("skills-list.not-signed-in");
        return { skills: [] };
      }
      deps.log("skills-list.failed", { msg: message(err) });
      throw err instanceof McpError
        ? err
        : new McpError(ErrorCode.InternalError, message(err));
    }
  });

  server.setRequestHandler(SkillsGetRequestSchema, async (request) => {
    return { skill: await catalog.get(request.params.uri) };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: catalog.listResources().map((r) => ({
      uri: r.uri,
      name: r.uri.slice(URI_PREFIX.length),
    })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const resource = await catalog.read(request.params.uri);
    const isText =
      resource.mimeType !== "application/octet-stream" &&
      isUtf8(resource.bytes);
    return {
      contents: [
        {
          uri: resource.uri,
          mimeType: resource.mimeType,
          ...(isText
            ? { text: resource.bytes.toString("utf-8") }
            : { blob: resource.bytes.toString("base64") }),
        },
      ],
    };
  });

  return catalog;
}
