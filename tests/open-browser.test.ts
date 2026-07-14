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

  it("passes the full authorize URL as one argument on Windows without routing through cmd", () => {
    platformMock.mockReturnValue("win32");

    openBrowser(authUrl);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args] = spawnMock.mock.calls[0] as [string, string[]];
    // cmd.exe would split the URL on `&`, dropping client_id; the launcher must not be cmd.
    expect(command).not.toMatch(/^cmd(\.exe)?$/i);
    // The URL must reach the browser intact, including everything after the first `&`.
    expect(args).toContain(authUrl);
    expect(args).not.toContain("/c");
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
