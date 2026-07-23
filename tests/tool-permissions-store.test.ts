import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock the remote transport so we can drive the store's flag dispatch without
// real network. (House convention: vi.mock the remote module — see
// remote-passthrough.test.ts.)
vi.mock("../src/remote-approvals.js", () => ({
  remoteIsToolApproved: vi.fn(),
  remoteSetToolApproved: vi.fn(),
}));

import {
  isToolAlwaysAllowed,
  setToolAlwaysAllowed,
  clearToolPermissions,
} from "../src/tool-permissions-store.js";
import {
  remoteIsToolApproved,
  remoteSetToolApproved,
} from "../src/remote-approvals.js";

const mockRemoteIs = vi.mocked(remoteIsToolApproved);
const mockRemoteSet = vi.mocked(remoteSetToolApproved);

describe("tool-permissions-store dispatch", () => {
  let tmpDir: string;
  const localFile = () => path.join(tmpDir, "mcp-tool-permissions.json");
  const seedLocal = (tool: string) =>
    fs.writeFileSync(
      localFile(),
      JSON.stringify({ settings: { [`pluginToolApprovals.${tool}`]: "true" } }),
    );

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tps-test-"));
    vi.stubEnv("PLUGIN_DATA_DIR", tmpDir);
    mockRemoteIs.mockReset().mockResolvedValue(null);
    mockRemoteSet.mockReset().mockResolvedValue(true);
    await clearToolPermissions(); // reset the in-process remote cache + local file
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  describe("flag OFF (local only)", () => {
    it("reads/writes the local file and never touches remote", async () => {
      expect(await isToolAlwaysAllowed("t1")).toBe(false);
      await setToolAlwaysAllowed("t1");
      expect(await isToolAlwaysAllowed("t1")).toBe(true);
      expect(fs.existsSync(localFile())).toBe(true);
      expect(mockRemoteIs).not.toHaveBeenCalled();
      expect(mockRemoteSet).not.toHaveBeenCalled();
    });
  });

  describe("flag ON (remote + local fallback)", () => {
    beforeEach(() => vi.stubEnv("GLEAN_REMOTE_TOOL_APPROVALS", "true"));

    it("write goes to BOTH remote and the local file", async () => {
      await setToolAlwaysAllowed("t1");
      expect(mockRemoteSet).toHaveBeenCalledWith("t1");
      const data = JSON.parse(fs.readFileSync(localFile(), "utf-8"));
      expect(data.settings["pluginToolApprovals.t1"]).toBe("true");
    });

    it("read prefers remote and caches (one remote call across repeats)", async () => {
      mockRemoteIs.mockResolvedValue(true);
      expect(await isToolAlwaysAllowed("t1")).toBe(true);
      expect(await isToolAlwaysAllowed("t1")).toBe(true);
      expect(mockRemoteIs).toHaveBeenCalledTimes(1);
    });

    it("remote 'false' overrides a stale local grant", async () => {
      seedLocal("t1");
      mockRemoteIs.mockResolvedValue(false);
      expect(await isToolAlwaysAllowed("t1")).toBe(false);
    });

    it("falls back to the local file when the remote read fails (null)", async () => {
      seedLocal("t1");
      mockRemoteIs.mockResolvedValue(null);
      expect(await isToolAlwaysAllowed("t1")).toBe(true);
    });

    it("a remote write failure keeps the local grant and does not throw", async () => {
      mockRemoteSet.mockResolvedValue(false);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(setToolAlwaysAllowed("t1")).resolves.toBeUndefined();
      const data = JSON.parse(fs.readFileSync(localFile(), "utf-8"));
      expect(data.settings["pluginToolApprovals.t1"]).toBe("true");
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });
  });
});
