import { describe, expect, it } from "vitest";
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
  host: string;
  /** Text the stubbed CLI prints. Omit to stub a CLI that cannot run at all. */
  cliOutput?: string;
  /** Stored server URL, as `setup` would have written it. */
  configuredUrl?: string;
  sessionId?: string | null;
  /** Install the hook outside a plugin cache, so it has no provenance of its own. */
  devCheckout?: boolean;
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

  // Installed under a plugin-cache-shaped path, because that is what the hook reads its
  // own provenance from. The version differs from the fixtures' on purpose: matching is
  // at the marketplace/plugin level, so a second installed version is still ours.
  const hookDir = options.devCheckout
    ? path.join(root, "checkout", "hooks")
    : path.join(
        root,
        "plugins",
        "cache",
        "glean-plugins-vnext",
        "glean-vnext",
        "9.9.9",
        "hooks",
      );
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
      [hook, `--host=${options.host}`],
      {
        env: {
          CLAUDE_PLUGIN_DATA: dataDir,
          CLAUDE_CODE_EXECPATH: fakeCli,
          CODEX_EXECPATH: fakeCli,
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
// servers: our own plugin (stdio, identified by launch path), a Glean remote (by URL),
// and an unrelated stdio server that must be withheld.
const CLAUDE_REAL = [
  "Checking MCP server health\u2026",
  "",
  "plugin:glean-vnext:glean: node /Users/someone/.claude/plugins/cache/glean-plugins-vnext/glean-vnext/0.2.43/start.mjs - \u2714 Connected",
  "glean_default: https://scio-prod-be.glean.com/mcp/default (HTTP) - \u2714 Connected",
  "chrome-devtools: npx -y chrome-devtools-mcp@latest --autoConnect --channel=beta - \u2718 Failed to connect \u2014 -32000: MCP error -32000: Connection closed",
].join("\n");

// The real four-server payload from `codex mcp list --json` on the machine this was
// built on, credential fields included verbatim -- which is how Codex actually emits
// them, and therefore what the hook has to be trusted not to pass on.
const CODEX_REAL = JSON.stringify([
  {
    name: "computer-use",
    enabled: false,
    auth_status: "unsupported",
    transport: {
      type: "stdio",
      command: "node",
      args: ["./computer-use.mjs"],
      cwd: "/Users/someone/tools/computer-use",
      env: { OPENAI_API_KEY: "sk-must-not-appear" },
      env_vars: {},
    },
  },
  {
    name: "glean-local",
    enabled: true,
    auth_status: "unsupported",
    transport: {
      type: "stdio",
      command: "node",
      args: ["./start.mjs"],
      cwd: "/Users/someone/.codex/plugins/cache/glean-plugins-vnext/glean-vnext/0.2.43/.",
      env: { ENABLE_HITL: "true" },
      env_vars: {},
    },
  },
  {
    name: "glean_default",
    enabled: true,
    auth_status: "not_logged_in",
    transport: {
      type: "streamable_http",
      url: "https://scio-prod-be.glean.com/mcp/default?token=must-not-appear",
      bearer_token_env_var: "GLEAN_API_TOKEN",
      http_headers: { Authorization: "Bearer must-not-appear" },
      env_http_headers: { "X-Secret": "must-not-appear" },
    },
  },
  {
    name: "node_repl",
    enabled: true,
    auth_status: "unsupported",
    transport: {
      type: "stdio",
      command: "node",
      args: ["--experimental-repl-await"],
      cwd: "/Users/someone",
      env: {},
      env_vars: {},
    },
  },
]);

describe("claude mcp list capture", () => {
  it("reports our plugin by launch path and the Glean remote by URL", async () => {
    const { cache } = await runHook({ host: "claude", cliOutput: CLAUDE_REAL });

    expect(cache).toMatchObject({
      source: "host-cli",
      servers: [
        { name: "plugin:glean-vnext:glean", authStatus: "authenticated" },
        {
          name: "glean_default",
          url: "https://scio-prod-be.glean.com/mcp/default",
          authStatus: "authenticated",
        },
      ],
      withheld: 1,
    });
  });

  // A stdio entry has a launch path, and the path is what identifies it -- but reporting
  // the path would disclose filesystem layout for no policy benefit, so it is used and
  // discarded.
  it("never reports a launch path", async () => {
    const { raw } = await runHook({ host: "claude", cliOutput: CLAUDE_REAL });
    expect(raw).not.toContain("start.mjs");
    expect(raw).not.toContain("/Users/someone");
  });

  it("treats pending approval as unknown, not unauthenticated", async () => {
    const { cache } = await runHook({
      host: "claude",
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
      host: "claude",
      cliOutput:
        "glean_default: https://acme-be.glean.com/mcp (HTTP) - needs authentication",
    });
    expect(cache?.servers?.[0].authStatus).toBe("unauthenticated");
  });

  it("maps a connection failure to unknown", async () => {
    const { cache } = await runHook({
      host: "claude",
      cliOutput:
        "glean_default: https://acme-be.glean.com/mcp (HTTP) - \u2718 Failed to connect \u2014 -32000: MCP error -32000: Connection closed",
    });
    expect(cache?.servers?.[0].authStatus).toBe("unknown");
  });

  // All-or-nothing. One unrecognized line means the format shifted, and a truncated
  // inventory is indistinguishable from a user who genuinely has fewer servers.
  it("discards the whole inventory when any line does not parse", async () => {
    const { cache } = await runHook({
      host: "claude",
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
      host: "claude",
      cliOutput: "No MCP servers configured. Use `claude mcp add` to add one.",
    });
    expect(cache).toMatchObject({ source: "host-cli", servers: [], withheld: 0 });
  });

  // A marker rather than no file: "the hook never fired" and "the hook fired and could
  // not find the CLI" need different fixes and used to look identical.
  it("records that the CLI could not be run", async () => {
    const { cache, raw } = await runHook({ host: "claude" });
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
      host: "claude",
      cliOutput: CLAUDE_REAL,
    });

    expect(cache?.cwd).toBeUndefined();
    expect(raw).not.toContain(projectDir);
    expect(raw).not.toContain(os.homedir());
    expect(raw).not.toContain(os.tmpdir());
  });
});

describe("codex mcp list capture", () => {
  it("reports both Glean servers and withholds the rest", async () => {
    const { cache } = await runHook({ host: "codex", cliOutput: CODEX_REAL });

    expect(cache).toMatchObject({
      source: "host-cli",
      servers: [
        // stdio, so no URL -- identified by launching from our own plugin tree.
        { name: "glean-local", authStatus: "unknown" },
        {
          name: "glean_default",
          url: "https://scio-prod-be.glean.com/mcp/default",
          authStatus: "unauthenticated",
        },
      ],
      withheld: 2,
    });
  });

  // Codex emits transport.env, http_headers, env_http_headers and bearer_token_env_var
  // verbatim, so using the CLI instead of config files does not make the payload safe.
  // Every one of those appears in the fixture above.
  it("lets no credential-bearing value through", async () => {
    const { raw } = await runHook({ host: "codex", cliOutput: CODEX_REAL });

    expect(raw).not.toContain("must-not-appear");
    expect(raw).not.toContain("sk-");
    for (const key of [
      "env",
      "env_vars",
      "http_headers",
      "env_http_headers",
      "bearer_token_env_var",
      "Authorization",
    ]) {
      expect(raw).not.toContain(key);
    }
  });

  it("drops a query string that may carry a token", async () => {
    const { cache, raw } = await runHook({ host: "codex", cliOutput: CODEX_REAL });
    expect(raw).not.toContain("token=");
    expect(cache?.servers?.find((s) => s.name === "glean_default")?.url).toBe(
      "https://scio-prod-be.glean.com/mcp/default",
    );
  });

  it("maps the auth enum to the three-value contract", async () => {
    const { cache } = await runHook({
      host: "codex",
      cliOutput: JSON.stringify([
        { name: "a", auth_status: "oauth", transport: { type: "streamable_http", url: "https://a.glean.com/mcp" } },
        { name: "b", auth_status: "bearer_token", transport: { type: "streamable_http", url: "https://b.glean.com/mcp" } },
        { name: "c", auth_status: "not_logged_in", transport: { type: "streamable_http", url: "https://c.glean.com/mcp" } },
        { name: "d", auth_status: "unknown", transport: { type: "streamable_http", url: "https://d.glean.com/mcp" } },
      ]),
    });

    expect(cache?.servers?.map((s) => [s.name, s.authStatus])).toEqual([
      ["a", "authenticated"],
      ["b", "authenticated"],
      ["c", "unauthenticated"],
      ["d", "unknown"],
    ]);
  });

  it("writes nothing when the JSON is not the expected shape", async () => {
    const { cache } = await runHook({
      host: "codex",
      cliOutput: JSON.stringify({ servers: [] }),
    });
    // Valid JSON of the wrong shape, which is a validation failure rather than a parse
    // failure -- the same wire reason, because the remote cannot act on the difference,
    // and the log keeps it.
    expect(cache?.reason).toBe("cli-output-invalid");
  });
});

// The control that keeps a customer's estate out of the payload. Its failure mode is
// disclosure, so it gets the most cases.
describe("the Glean-only filter", () => {
  const remote = (name: string, url: string) =>
    JSON.stringify([
      { name, auth_status: "oauth", transport: { type: "streamable_http", url } },
    ]);

  it("admits the exact host the plugin is configured against", async () => {
    const { cache } = await runHook({
      host: "codex",
      configuredUrl: "https://mcp.acme.com/glean/mcp",
      cliOutput: remote("white-labeled", "https://mcp.acme.com/glean/mcp"),
    });
    expect(cache?.servers).toHaveLength(1);
  });

  // Reducing mcp.acme.com to acme.com would admit every unrelated server the customer
  // runs on their own domain, turning the privacy control into a leak.
  it("does not admit a sibling host on the same domain", async () => {
    const { cache } = await runHook({
      host: "codex",
      configuredUrl: "https://mcp.acme.com/glean/mcp",
      cliOutput: remote("payroll", "https://other.acme.com/mcp"),
    });
    expect(cache).toMatchObject({ servers: [], withheld: 1 });
  });

  it("admits Glean's own domain with no configuration at all", async () => {
    const { cache } = await runHook({
      host: "codex",
      cliOutput: remote("glean_default", "https://anything-be.glean.com/mcp"),
    });
    expect(cache?.servers).toHaveLength(1);
  });

  it("is not fooled by a lookalike domain", async () => {
    const { cache } = await runHook({
      host: "codex",
      cliOutput: remote("phish", "https://glean.com.evil.example/mcp"),
    });
    expect(cache).toMatchObject({ servers: [], withheld: 1 });
  });

  // The name is never consulted, only the launch path. A directory called `gleanwork/`
  // would otherwise be as good a match as our own plugin cache.
  it("withholds a Glean-sounding stdio server from outside our plugin tree", async () => {
    const { cache } = await runHook({
      host: "codex",
      cliOutput: JSON.stringify([
        {
          name: "glean-totally-legit",
          auth_status: "unsupported",
          transport: {
            type: "stdio",
            command: "node",
            cwd: "/Users/someone/gleanwork/not-a-plugin",
          },
        },
      ]),
    });
    expect(cache).toMatchObject({ servers: [], withheld: 1 });
  });

  it("withholds a stdio server from a different plugin's cache", async () => {
    const { cache } = await runHook({
      host: "codex",
      cliOutput: JSON.stringify([
        {
          name: "someone-else",
          auth_status: "unsupported",
          transport: {
            type: "stdio",
            command: "node",
            cwd: "/Users/someone/.codex/plugins/cache/other-market/other-plugin/1.0.0/.",
          },
        },
      ]),
    });
    expect(cache).toMatchObject({ servers: [], withheld: 1 });
  });

  // Running from a source checkout there is no plugin cache to compare against, so no
  // stdio server can be positively identified. Under-reporting is the right direction.
  it("confirms no stdio server when it has no provenance of its own", async () => {
    const { cache } = await runHook({
      host: "claude",
      devCheckout: true,
      cliOutput: CLAUDE_REAL,
    });

    // The remote is still matched by URL; both stdio entries are withheld.
    expect(cache).toMatchObject({
      servers: [{ name: "glean_default" }],
      withheld: 2,
    });
  });
});

describe("hook preconditions", () => {
  it("writes nothing without a session id to key by", async () => {
    const { cache } = await runHook({
      host: "claude",
      cliOutput: CLAUDE_REAL,
      sessionId: null,
    });
    expect(cache).toBeNull();
  });

  // The host is passed in rather than sniffed, so a Claude session never probes for the
  // Codex binary. An unrecognized value must therefore do nothing at all rather than
  // fall back to trying everything.
  it("writes nothing when the host is not one it knows", async () => {
    const { cache } = await runHook({ host: "cursor", cliOutput: CLAUDE_REAL });
    expect(cache).toBeNull();
  });
});
