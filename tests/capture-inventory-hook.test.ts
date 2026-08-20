import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK_SOURCE = path.resolve(
  here,
  "../plugins/glean/hooks/capture-inventory.mjs",
);

interface Run {
  cache: {
    source?: string;
    servers?: { name: string; url?: string; authStatus: string }[];
    withheld?: number;
    cwd?: string;
    reason?: string;
  } | null;
  raw: string | null;
  projectDir: string;
}

interface Options {
  /** Text the stubbed CLI prints. Omit to stub a CLI that cannot run at all. */
  cliOutput?: string;
  /**
   * Stored server URL, as `setup` would have written it. The hook no longer reads it --
   * that is the point of the test that sets it, which fails the moment someone
   * reintroduces configured-host matching.
   */
  configuredUrl?: string;
  sessionId?: string | null;
}

/**
 * Run the real hook against a stubbed host CLI.
 *
 * The CLI is stubbed through CLAUDE_CODE_EXECPATH / CODEX_EXECPATH, which the hook's
 * candidate lists try first, and PATH is emptied so a bare-name lookup cannot reach a
 * real CLI installed on the machine running the tests. That matters more than it looks:
 * `claude mcp list` output is not even stable between consecutive invocations from one
 * directory -- a server present in one run was absent from the next -- so a test that
 * touched the real CLI would be a test that fails on someone else's laptop.
 */
async function runHook(options: Options): Promise<Run> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "capture-inv-"));
  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir, { recursive: true });

  const hookDir = path.join(root, "hooks");
  await fs.mkdir(hookDir, { recursive: true });
  const hook = path.join(hookDir, "capture-inventory.mjs");
  await fs.copyFile(HOOK_SOURCE, hook);

  if (options.configuredUrl) {
    await fs.writeFile(
      path.join(dataDir, "mcp-server-url.json"),
      JSON.stringify({ serverUrl: options.configuredUrl }),
    );
  }

  const fakeCli = path.join(root, "fake-cli");
  if (options.cliOutput === undefined) {
    // Exists but is not executable, so every candidate fails and the hook must conclude
    // `unavailable` rather than writing something.
    await fs.writeFile(fakeCli, "not executable", { mode: 0o600 });
  } else {
    // /bin/sh by absolute path in the shebang, so an emptied PATH cannot break it.
    const payload = options.cliOutput.replaceAll("'", "'\"'\"'");
    await fs.writeFile(fakeCli, `#!/bin/sh
printf '%s' '${payload}'
`, { mode: 0o755 });
  }

  const sessionId =
    options.sessionId === undefined ? "sess-1" : options.sessionId;
  // A real directory: the hook hands this to execFile as the CLI's cwd, and a path that
  // does not exist fails the spawn outright (which is itself a correct degrade to
  // `unavailable`, but not what these tests are checking).
  const projectDir = path.join(root, "project");
  await fs.mkdir(projectDir, { recursive: true });
  const input: Record<string, unknown> = { cwd: projectDir };
  if (sessionId !== null) input.session_id = sessionId;

  await new Promise<void>((resolve) => {
    const child = spawn(
      process.execPath,
      [hook],
      {
        env: {
          CLAUDE_PLUGIN_DATA: dataDir,
          CLAUDE_CODE_EXECPATH: fakeCli,
          CLAUDE_CODE_EXECPATH: fakeCli,
          PATH: path.join(root, "no-such-bin"),
          HOME: root,
        },
        stdio: ["pipe", "ignore", "ignore"],
      },
    );
    child.stdin.end(JSON.stringify(input));
    child.on("close", () => resolve());
  });

  const file = path.join(dataDir, "inventory", `${sessionId}.json`);
  let raw: string | null = null;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch {
    raw = null;
  }
  await fs.rm(root, { recursive: true, force: true });
  return { cache: raw === null ? null : JSON.parse(raw), raw, projectDir };
}

// Recorded from a real `claude mcp list`, including the preamble and blank line. Three
// servers: our own plugin and an unrelated tool, both stdio and both withheld, plus one
// Glean remote that is reported.
const CLAUDE_REAL = [
  "Checking MCP server health\u2026",
  "",
  "plugin:glean-vnext:glean: node /Users/someone/.claude/plugins/cache/glean-plugins-vnext/glean-vnext/0.2.43/start.mjs - \u2714 Connected",
  "glean_default: https://scio-prod-be.glean.com/mcp/default (HTTP) - \u2714 Connected",
  "chrome-devtools: npx -y chrome-devtools-mcp@latest --autoConnect --channel=beta - \u2718 Failed to connect \u2014 -32000: MCP error -32000: Connection closed",
].join("\n");

describe("claude mcp list capture", () => {
  // Only the remote Glean server is reported. Both stdio entries are withheld, including
  // this plugin's own: a stdio server exposes no URL and so can never be confirmed, and
  // reporting ours would add nothing the request's own plugin block does not already say.
  it("reports the Glean remote and withholds every stdio server", async () => {
    const { cache } = await runHook({ cliOutput: CLAUDE_REAL });

    expect(cache).toMatchObject({
      source: "host-cli",
      servers: [
        {
          name: "glean_default",
          url: "https://scio-prod-be.glean.com/mcp/default",
          authStatus: "authenticated",
        },
      ],
      withheld: 2,
    });
  });

  // A stdio entry's target is a launch command, and it is dropped at parse time rather
  // than carried and filtered later: a path discloses filesystem layout for no policy
  // benefit, and the surest way not to leak it is never to hold it.
  it("never reports a launch path", async () => {
    const { raw } = await runHook({ cliOutput: CLAUDE_REAL });
    expect(raw).not.toContain("start.mjs");
    expect(raw).not.toContain("/Users/someone");
  });

  it("treats pending approval as unknown, not unauthenticated", async () => {
    const { cache } = await runHook({
      cliOutput:
        "glean_default: https://acme-be.glean.com/mcp (HTTP) - \u23f8 Pending approval (run `claude` to approve)",
    });

    // Never connected, so nothing was learned about credentials. Calling it
    // unauthenticated would be a wrong answer rather than a cautious one.
    expect(cache?.servers).toEqual([
      { name: "glean_default", url: "https://acme-be.glean.com/mcp", authStatus: "unknown" },
    ]);
  });

  it("maps an explicit authentication prompt to unauthenticated", async () => {
    const { cache } = await runHook({
      cliOutput:
        "glean_default: https://acme-be.glean.com/mcp (HTTP) - needs authentication",
    });
    expect(cache?.servers?.[0].authStatus).toBe("unauthenticated");
  });

  it("maps a connection failure to unknown", async () => {
    const { cache } = await runHook({
      cliOutput:
        "glean_default: https://acme-be.glean.com/mcp (HTTP) - \u2718 Failed to connect \u2014 -32000: MCP error -32000: Connection closed",
    });
    expect(cache?.servers?.[0].authStatus).toBe("unknown");
  });

  // All-or-nothing. One unrecognized line means the format shifted, and a truncated
  // inventory is indistinguishable from a user who genuinely has fewer servers.
  it("discards the whole inventory when any line does not parse", async () => {
    const { cache } = await runHook({
      cliOutput: [
        "glean_default: https://acme-be.glean.com/mcp (HTTP) - \u2714 Connected",
        "a brand new output format nobody taught us",
      ].join("\n"),
    });
    // The one recognized line is discarded with the rest, and the marker names why so a
    // format shift is diagnosable rather than merely absent.
    expect(cache?.reason).toBe("cli-output-invalid");
    expect(cache?.servers).toBeUndefined();
  });

  it("distinguishes a host with no servers from a host it could not ask", async () => {
    const { cache } = await runHook({
      cliOutput: "No MCP servers configured. Use `claude mcp add` to add one.",
    });
    expect(cache).toMatchObject({ source: "host-cli", servers: [], withheld: 0 });
  });

  // A marker rather than no file: "the hook never fired" and "the hook fired and could
  // not find the CLI" need different fixes and used to look identical.
  it("records that the CLI could not be run", async () => {
    const { cache, raw } = await runHook({});
    expect(cache?.reason).toBe("cli-unavailable");
    // Never the exec error: it carries an absolute binary path, and on a normal install
    // that path contains the user's name. Nor the working directory.
    expect(raw).not.toContain("ENOENT");
    expect(raw).not.toContain("EACCES");
    expect(raw).not.toContain("fake-cli");
    expect(raw).not.toContain(os.tmpdir());
  });

  // The working directory is passed to the CLI, because the output depends on it, and then
  // NOT recorded. A path is filesystem layout: /Users/<name>/... carries a username and
  // project directory names carry customers'. Same reason a stdio server's launch path is
  // used for identification and discarded.
  it("writes no filesystem path of any kind", async () => {
    const { cache, raw, projectDir } = await runHook({
      cliOutput: CLAUDE_REAL,
    });

    expect(cache?.cwd).toBeUndefined();
    expect(raw).not.toContain(projectDir);
    expect(raw).not.toContain(os.homedir());
    expect(raw).not.toContain(os.tmpdir());
  });
});

// The control that keeps a customer's estate out of the payload. Its failure mode is
// disclosure, so it gets the most cases.
//
// One risk left with the Codex parser: `codex mcp list --json` emits transport.env,
// http_headers, env_http_headers and bearer_token_env_var verbatim, so entries had to be
// rebuilt field by field rather than trusted. `claude mcp list` prints only
// `name: target - status`, so there is no credential-bearing field to leak in the first
// place. Dropping Codex removed that whole class of exposure from the shipping path; the
// tests for it live on mohit/inventory-codex-followup with the parser.
describe("the Glean-only filter", () => {
  const remote = (name: string, url: string) =>
    `${name}: ${url} (HTTP) - \u2714 Connected`;

  it("admits Glean's own domain", async () => {
    const { cache } = await runHook({
      cliOutput: remote("glean_default", "https://anything-be.glean.com/mcp"),
    });
    expect(cache?.servers).toHaveLength(1);
  });

  // A white-labeled deployment on the customer's own domain is NOT admitted, even though
  // the plugin could read its configured URL and match on it. That would also admit
  // anything else fronted off the same host under a different path, and a corporate
  // gateway multiplexing several MCP servers is entirely ordinary. Under-reporting is the
  // side to fail on.
  it("does not admit a customer domain, even the configured one", async () => {
    const { cache } = await runHook({
      configuredUrl: "https://mcp.acme.com/glean/mcp",
      cliOutput: remote("white-labeled", "https://mcp.acme.com/glean/mcp"),
    });
    expect(cache).toMatchObject({ servers: [], withheld: 1 });
  });

  it("is not fooled by a lookalike domain", async () => {
    const { cache } = await runHook({
      cliOutput: remote("phish", "https://glean.com.evil.example/mcp"),
    });
    expect(cache).toMatchObject({ servers: [], withheld: 1 });
  });

  // Query strings on MCP URLs carry credentials and search-config parameters in the wild,
  // so a URL is reduced to origin plus path. This is the one scrubbing rule that still
  // applies with Codex gone, because Claude prints URLs verbatim.
  it("drops a query string that may carry a token", async () => {
    const { cache, raw } = await runHook({
      cliOutput: remote("glean_default", "https://acme-be.glean.com/mcp?token=must-not-appear"),
    });
    expect(raw).not.toContain("must-not-appear");
    expect(cache?.servers?.[0].url).toBe("https://acme-be.glean.com/mcp");
  });

  // The name is never consulted, only the URL. Otherwise a server label containing "glean"
  // would be as good as proof.
  it("withholds a Glean-sounding stdio server", async () => {
    const { cache } = await runHook({
      cliOutput: "glean-totally-legit: node /Users/someone/gleanwork/server.mjs - \u2714 Connected",
    });
    expect(cache).toMatchObject({ servers: [], withheld: 1 });
  });
});

// The one piece of duplication that cannot be removed. This hook is unbundled ESM the host
// spawns directly, while the read side is compiled into dist/, so the two independently
// compute the same path from the same environment variable. A divergence would be silent --
// the hook writing somewhere nothing ever looks -- so rather than a comment asserting they
// match, this runs the real hook and reads the result back through the real read path.
describe("the hook and the server agree on where the capture lives", () => {
  it("finds a capture the hook actually wrote", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "inv-agree-"));
    const hookDir = path.join(root, "hooks");
    await fs.mkdir(hookDir, { recursive: true });
    const hook = path.join(hookDir, "capture-inventory.mjs");
    await fs.copyFile(HOOK_SOURCE, hook);

    const fakeCli = path.join(root, "fake-claude");
    const payload = "glean_default: https://acme-be.glean.com/mcp (HTTP) - ✔ Connected";
    await fs.writeFile(
      fakeCli,
      `#!/bin/sh\nprintf '%s' '${payload}'\n`,
      { mode: 0o755 },
    );

    // Only CLAUDE_PLUGIN_DATA is set, because that is the only variable the hook can see.
    await new Promise<void>((resolve) => {
      const child = spawn(process.execPath, [hook], {
        env: {
          CLAUDE_PLUGIN_DATA: root,
          CLAUDE_CODE_EXECPATH: fakeCli,
          PATH: path.join(root, "no-such-bin"),
          HOME: root,
        },
        stdio: ["pipe", "ignore", "ignore"],
      });
      child.stdin.end(JSON.stringify({ session_id: "agree-1", cwd: root }));
      child.on("close", () => resolve());
    });

    // Read back through the module that resolves its own path, with no shared constant
    // between the two sides.
    vi.resetModules();
    vi.stubEnv("CLAUDE_PLUGIN_DATA", root);
    vi.stubEnv("GLEAN_SESSION_ID", "agree-1");
    const { loadCachedInventory } = await import("../src/policy/inventory-cache.js");

    expect(loadCachedInventory()).toMatchObject({
      source: "host-cli",
      servers: [{ name: "glean_default", url: "https://acme-be.glean.com/mcp" }],
    });

    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });
});

// The capture holds server names and URLs, so its permissions are part of the filter's
// job, not housekeeping. They also degrade silently: `mode` on writeFileSync and mkdirSync
// applies only on creation and is masked by umask, so a wrong umask or a pre-existing
// directory loosens them with nothing to notice.
describe("how the capture is written", () => {
  it("writes 0600 into a 0700 directory and leaves no temp behind", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "inv-perm-"));
    const dataDir = path.join(root, "data");
    // Pre-created wide open, so a mkdir that only passes `mode` would not tighten it.
    await fs.mkdir(path.join(dataDir, "inventory"), { recursive: true, mode: 0o777 });
    await fs.chmod(path.join(dataDir, "inventory"), 0o777);

    const hook = path.join(root, "capture-inventory.mjs");
    await fs.copyFile(HOOK_SOURCE, hook);
    const fakeCli = path.join(root, "fake-claude");
    await fs.writeFile(
      fakeCli,
      `#!/bin/sh\nprintf '%s' 'glean_default: https://acme-be.glean.com/mcp (HTTP) - ✔ Connected'\n`,
      { mode: 0o755 },
    );

    await new Promise<void>((resolve) => {
      const child = spawn(process.execPath, [hook], {
        env: {
          CLAUDE_PLUGIN_DATA: dataDir,
          CLAUDE_CODE_EXECPATH: fakeCli,
          PATH: path.join(root, "no-such-bin"),
          HOME: root,
        },
        stdio: ["pipe", "ignore", "ignore"],
      });
      child.stdin.end(JSON.stringify({ session_id: "perm-1", cwd: root }));
      child.on("close", () => resolve());
    });

    const invDir = path.join(dataDir, "inventory");
    const fileMode = (await fs.stat(path.join(invDir, "perm-1.json"))).mode & 0o777;
    const dirMode = (await fs.stat(invDir)).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);

    // Nothing else in the directory: no stray file, and no temp, since the write is a
    // plain one -- a per-session filename with a single writer has no race to guard.
    expect(await fs.readdir(invDir)).toEqual(["perm-1.json"]);

    await fs.rm(root, { recursive: true, force: true });
  });
});

describe("hook preconditions", () => {
  it("writes nothing without a session id to key by", async () => {
    const { cache } = await runHook({
      cliOutput: CLAUDE_REAL,
      sessionId: null,
    });
    expect(cache).toBeNull();
  });

});
