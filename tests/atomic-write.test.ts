import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileAtomicSync } from "../src/atomic-write.js";

describe("writeFileAtomicSync", () => {
  let dir: string;
  let target: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-write-test-"));
    target = path.join(dir, "store.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes the contents", () => {
    writeFileAtomicSync(target, '{"a":1}', 0o600);
    expect(JSON.parse(fs.readFileSync(target, "utf-8"))).toEqual({ a: 1 });
  });

  it("replaces existing contents rather than appending", () => {
    writeFileAtomicSync(target, '{"a":1}', 0o600);
    writeFileAtomicSync(target, '{"b":2}', 0o600);
    expect(JSON.parse(fs.readFileSync(target, "utf-8"))).toEqual({ b: 2 });
  });

  // A temp file left in the data dir would be picked up by nothing, but it would
  // accumulate one per crash and confuse anyone inspecting the directory.
  it("leaves no temp file behind", () => {
    writeFileAtomicSync(target, '{"a":1}', 0o600);
    expect(fs.readdirSync(dir)).toEqual(["store.json"]);
  });

  it("applies the requested mode", () => {
    writeFileAtomicSync(target, '{"a":1}', 0o600);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  // The file is only ever swapped in whole, so a reader either sees the previous
  // contents or the new ones. This is what keeps a mid-write kill from turning a
  // cached policy into an unparseable file that every store reads as "no data".
  it("never leaves the target parseable-but-partial", () => {
    writeFileAtomicSync(target, JSON.stringify({ first: true }), 0o600);
    const before = fs.readFileSync(target, "utf-8");

    // Simulate the failure mode: the rename target is a directory, so the swap fails
    // after the temp file was written.
    const blocked = path.join(dir, "blocked.json");
    fs.mkdirSync(blocked);
    expect(() =>
      writeFileAtomicSync(blocked, JSON.stringify({ second: true }), 0o600),
    ).toThrow();

    // The unrelated target is untouched, and no debris was left in the directory.
    expect(fs.readFileSync(target, "utf-8")).toBe(before);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("surfaces a failure instead of reporting success", () => {
    expect(() =>
      writeFileAtomicSync(
        path.join(dir, "missing-subdir", "store.json"),
        "{}",
        0o600,
      ),
    ).toThrow();
  });
});
