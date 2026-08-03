import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import {
  createSkillsCatalog,
  normalizeBundle,
  digestOf,
} from "../src/skills-catalog.js";
import { unzip, isZip } from "../src/zip.js";

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const b of buf) {
    let c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Build a real ZIP so the reader is exercised end to end. */
function makeZip(entries: [string, string, number][]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content, method] of entries) {
    const raw = Buffer.from(content);
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc32(raw), 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc32(raw), 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const localBuf = Buffer.concat(locals);
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, cdBuf, eocd]);
}

const SKILL_MD =
  "---\nname: search-jira\ndescription: Search Jira issues\nallowed-tools:\n  - Read\n---\n# Search Jira\n";

interface StubOptions {
  pages?: {
    skills: unknown[];
    has_more?: boolean;
    next_cursor?: string | null;
  }[];
  bundles?: Record<string, Buffer>;
}

function stubFetch(opts: StubOptions) {
  const calls: string[] = [];
  const pages = opts.pages ?? [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const target = String(url);
    calls.push(target);
    void init;
    const contentMatch = target.match(/\/api\/skills\/([^/]+)\/content$/);
    if (contentMatch) {
      const bundle = opts.bundles?.[decodeURIComponent(contentMatch[1])];
      if (!bundle) return new Response(null, { status: 404 });
      return new Response(new Uint8Array(bundle), { status: 200 });
    }
    const cursor = new URL(target).searchParams.get("cursor");
    const page = cursor ? pages[Number(cursor)] : pages[0];
    return new Response(JSON.stringify(page ?? { skills: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function catalogWith(opts: StubOptions, signedIn = true) {
  const { fetchImpl, calls } = stubFetch(opts);
  const logs: string[] = [];
  const catalog = createSkillsCatalog({
    getAuth: () =>
      signedIn
        ? { origin: "https://acme-be.glean.com", token: "tok" }
        : undefined,
    log: (label) => logs.push(label),
    fetchImpl,
  });
  return { catalog, calls, logs };
}

describe("unzip", () => {
  it("reads stored and deflated entries and skips directories", () => {
    const zip = makeZip([
      ["SKILL.md", SKILL_MD, 0],
      ["references/notation.md", "deflate me ".repeat(50), 8],
      ["refs/", "", 0],
    ]);
    expect(isZip(zip)).toBe(true);

    const files = unzip(zip);
    expect([...files.keys()]).toEqual(["SKILL.md", "references/notation.md"]);
    expect(files.get("SKILL.md")!.toString()).toBe(SKILL_MD);
    expect(files.get("references/notation.md")!.toString()).toBe(
      "deflate me ".repeat(50),
    );
  });

  it("rejects a buffer with no end-of-central-directory record", () => {
    expect(() => unzip(Buffer.from("not a zip at all........"))).toThrow(
      /end-of-central-directory/,
    );
  });
});

describe("normalizeBundle", () => {
  it("strips a single wrapping directory", () => {
    const normalized = normalizeBundle(
      new Map([
        ["search-jira/SKILL.md", Buffer.from("a")],
        ["search-jira/tools/x.json", Buffer.from("b")],
      ]),
    );
    expect([...normalized.keys()]).toEqual(["SKILL.md", "tools/x.json"]);
  });

  it("drops path traversal entries", () => {
    const normalized = normalizeBundle(
      new Map([
        ["SKILL.md", Buffer.from("a")],
        ["../escape.md", Buffer.from("b")],
      ]),
    );
    expect([...normalized.keys()]).toEqual(["SKILL.md"]);
  });
});

describe("skills catalog", () => {
  const bundle = makeZip([
    ["SKILL.md", SKILL_MD, 8],
    ["references/notation.md", "see the notation", 0],
  ]);

  const onePage: StubOptions = {
    pages: [
      {
        skills: [
          {
            id: "skill-1",
            display_name: "Search Jira",
            description: "api description",
            status: "ENABLED",
          },
        ],
        has_more: false,
        next_cursor: null,
      },
    ],
    bundles: { "skill-1": bundle },
  };

  it("lists skills with frontmatter and digested resources", async () => {
    const { catalog } = catalogWith(onePage);
    const page = await catalog.list();

    expect(page.nextCursor).toBeUndefined();
    expect(page.skills).toHaveLength(1);
    const entry = page.skills[0];
    expect(entry.uri).toBe("skill://glean/search-jira/SKILL.md");
    expect(entry.frontmatter.name).toBe("search-jira");
    expect(entry.frontmatter.description).toBe("Search Jira issues");
    // Every frontmatter entry is forwarded, not just name/description.
    expect(entry.frontmatter["allowed-tools"]).toEqual(["Read"]);
    expect(entry.resources.map((r) => r.uri)).toEqual([
      "skill://glean/search-jira/SKILL.md",
      "skill://glean/search-jira/references/notation.md",
    ]);
    const expected = `sha256:${createHash("sha256")
      .update(Buffer.from(SKILL_MD))
      .digest("hex")}`;
    expect(entry.resources[0].digest).toBe(expected);
  });

  it("serves resource bytes for a listed uri", async () => {
    const { catalog } = catalogWith(onePage);
    await catalog.list();

    const resource = await catalog.read(
      "skill://glean/search-jira/references/notation.md",
    );
    expect(resource.bytes.toString()).toBe("see the notation");
    expect(resource.mimeType).toBe("text/markdown");
    expect(digestOf(resource.bytes)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("crawls pages when a read misses the cache", async () => {
    const { catalog, calls } = catalogWith({
      pages: [
        {
          skills: [{ id: "skill-1", status: "ENABLED" }],
          has_more: true,
          next_cursor: "1",
        },
        { skills: [], has_more: false, next_cursor: null },
      ],
      bundles: { "skill-1": bundle },
    });

    const resource = await catalog.read("skill://glean/search-jira/SKILL.md");
    expect(resource.bytes.toString()).toBe(SKILL_MD);
    expect(calls.some((c) => c.includes("cursor=1"))).toBe(true);
  });

  it("reports an unknown resource once the crawl finds nothing", async () => {
    const { catalog } = catalogWith(onePage);
    await expect(catalog.read("skill://glean/nope/SKILL.md")).rejects.toThrow(
      /Unknown resource/,
    );
  });

  it("skips skills that are not enabled and bundles that fail", async () => {
    const { catalog, logs } = catalogWith({
      pages: [
        {
          skills: [
            { id: "skill-1", status: "DRAFT" },
            { id: "missing", status: "ENABLED" },
          ],
          has_more: false,
          next_cursor: null,
        },
      ],
      bundles: {},
    });

    const page = await catalog.list();
    expect(page.skills).toEqual([]);
    expect(logs).toContain("skills.skipped");
    expect(logs).toContain("skills.bundle-failed");
  });

  it("passes the cursor through and reports the next one", async () => {
    const { catalog, calls } = catalogWith({
      pages: [
        { skills: [], has_more: true, next_cursor: "1" },
        { skills: [], has_more: true, next_cursor: "2" },
      ],
    });

    const page = await catalog.list("1");
    expect(page.nextCursor).toBe("2");
    expect(calls[0]).toContain("cursor=1");
    expect(calls[0]).toContain("page_size=10");
  });

  it("sends the bearer token and experimental header", async () => {
    let seen: Headers | undefined;
    const catalog = createSkillsCatalog({
      getAuth: () => ({ origin: "https://acme-be.glean.com", token: "tok" }),
      log: () => {},
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        seen = new Headers(init?.headers);
        return new Response(JSON.stringify({ skills: [] }), { status: 200 });
      }) as unknown as typeof fetch,
    });

    await catalog.list();
    expect(seen?.get("authorization")).toBe("Bearer tok");
    expect(seen?.get("x-glean-include-experimental")).toBe("true");
  });

  it("fails the list when the user is not signed in", async () => {
    const { catalog } = catalogWith(onePage, false);
    await expect(catalog.list()).rejects.toThrow(/setup/);
  });
});
