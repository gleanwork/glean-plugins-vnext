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

  // The point of the temp-and-rename dance: a write that fails must leave the previous
  // contents readable, since every store treats an unparseable file as "no data" and
  // would otherwise silently discard a cached policy. Forced by pre-creating the temp
  // path as a directory, so writing it fails with EISDIR before the target is touched.
  it("preserves the existing file when the write fails", () => {
    writeFileAtomicSync(target, JSON.stringify({ keep: true }), 0o600);

    const tmpPath = path.join(dir, `.store.json.${process.pid}.tmp`);
    fs.mkdirSync(tmpPath);
    expect(() =>
      writeFileAtomicSync(target, JSON.stringify({ replaced: true }), 0o600),
    ).toThrow();

    expect(JSON.parse(fs.readFileSync(target, "utf-8"))).toEqual({ keep: true });
  });

  // Separately: when the write succeeds but the swap fails, the temp must not be left
  // behind — one would accumulate per failure in the user's data directory.
  it("removes the temp file when the swap fails", () => {
    const blocked = path.join(dir, "blocked.json");
    fs.mkdirSync(blocked);

    expect(() =>
      writeFileAtomicSync(blocked, JSON.stringify({ second: true }), 0o600),
    ).toThrow();

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
