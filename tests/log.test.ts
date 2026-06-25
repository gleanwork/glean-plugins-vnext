import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { logLine } from "../src/log.js";

describe("logLine", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "glean-log-test-"));
    process.env.PLUGIN_DATA_DIR = dir;
  });

  afterEach(() => {
    delete process.env.PLUGIN_DATA_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const readLog = (): string =>
    fs.readFileSync(path.join(dir, "glean-server.log"), "utf8");

  it("appends a timestamped label with its JSON detail", () => {
    logLine("setup.complete", { sessionId: "abc", toolCount: 3 });
    const log = readLog();
    expect(log).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z setup\.complete /m);
    expect(log).toContain('{"sessionId":"abc","toolCount":3}');
  });

  it("writes the label alone when there is no detail", () => {
    logLine("server.start");
    const log = readLog();
    expect(log).toContain("server.start");
    expect(log).not.toContain("undefined");
  });

  it("appends successive events as separate lines", () => {
    logLine("auth.code-exchange-start", { sessionId: "s1" });
    logLine("auth.code-exchange-complete", { sessionId: "s1" });
    const lines = readLog().trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("auth.code-exchange-start");
    expect(lines[1]).toContain("auth.code-exchange-complete");
  });
});
