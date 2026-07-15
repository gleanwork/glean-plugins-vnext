import { describe, it, expect, beforeEach, vi } from "vitest";

const platformMock = vi.fn();
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, platform: () => platformMock() };
});

const spawnMock = vi.fn(() => ({ unref: vi.fn() }));
const execFileMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  execFile: execFileMock,
}));

const { openBrowser } = await import("../src/auth-provider.js");

// A realistic authorize URL: response_type is first, then client_id after the
// first `&` — the exact shape the MCP SDK produces.
const authUrl =
  "https://acme-be.glean.com/oauth/authorize?response_type=code" +
  "&client_id=Glean_Claude_Cod_f345b80b" +
  "&redirect_uri=http%3A%2F%2F127.0.0.1%3A29107%2Fglean-cli-callback" +
  "&code_challenge=abc123&code_challenge_method=S256&state=s1";

describe("openBrowser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("escapes `&` as `^&` so the full authorize URL survives cmd on Windows", () => {
    platformMock.mockReturnValue("win32");

    openBrowser(authUrl);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { windowsVerbatimArguments?: boolean },
    ];
    expect(command).toMatch(/^cmd$/i);

    // The URL is the last arg. Every `&` must be escaped to `^&` so cmd does
    // not treat it as a command separator and truncate the URL.
    const urlArg = args[args.length - 1];
    expect(urlArg).toBe(authUrl.replace(/&/g, "^&"));
    // Guard the actual regression: client_id lives after the first `&`, so it
    // must survive, and no un-escaped `&` may remain in the argument.
    expect(urlArg).toContain("client_id=Glean_Claude_Cod_f345b80b");
    expect(urlArg.replace(/\^&/g, "").includes("&")).toBe(false);
    // Verbatim args are required so Node doesn't re-quote and break the `^`.
    expect(options.windowsVerbatimArguments).toBe(true);
  });

  it("opens with execFile on macOS", () => {
    platformMock.mockReturnValue("darwin");

    openBrowser(authUrl);

    expect(execFileMock).toHaveBeenCalledWith("open", [authUrl]);
  });

  it("opens with xdg-open on Linux", () => {
    platformMock.mockReturnValue("linux");

    openBrowser(authUrl);

    expect(execFileMock).toHaveBeenCalledWith("xdg-open", [authUrl]);
  });
});
