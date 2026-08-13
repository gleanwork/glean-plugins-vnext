import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock homedir before importing token-store so it uses a temp directory
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "token-store-test-"));
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => tmpDir };
});

const {
  acquireClientRegistrationLock,
  clearCredentials,
  credentialsMtimeMs,
  loadCredentials,
  releaseClientRegistrationLock,
  saveCredentials,
} = await import("../src/token-store.js");
const { acquireDataFileLockSync, releaseDataFileLock } = await import(
  "../src/data-dir.js"
);

describe("token-store", () => {
  const gleanDir = path.join(tmpDir, ".glean");
  const credFile = path.join(gleanDir, "mcp-credentials.json");
  const legacyDir = path.join(tmpDir, "managed-plugin-data");

  beforeEach(() => {
    delete process.env.PLUGIN_DATA_DIR;
    delete process.env.CLAUDE_PLUGIN_DATA;
    delete process.env.GLEAN_AUTH_DATA_DIR;
    fs.rmSync(gleanDir, { recursive: true, force: true });
    fs.rmSync(legacyDir, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(gleanDir, { recursive: true, force: true });
    fs.rmSync(legacyDir, { recursive: true, force: true });
  });

  it("returns undefined when credentials file does not exist", () => {
    expect(loadCredentials()).toBeUndefined();
  });

  it("saves and loads credentials round-trip", () => {
    const tokens = { access_token: "tok_123", token_type: "Bearer" };
    const clientInfo = { client_id: "cid_456" };

    saveCredentials(tokens, clientInfo);
    const loaded = loadCredentials();

    expect(loaded).toEqual({ tokens, clientInfo });
  });

  it("creates ~/.glean/ directory on first save", () => {
    expect(fs.existsSync(gleanDir)).toBe(false);

    saveCredentials({ access_token: "x" }, undefined);

    expect(fs.existsSync(gleanDir)).toBe(true);
  });

  it("sets credentials file to mode 0600", () => {
    saveCredentials({ access_token: "x" }, undefined);

    const stat = fs.statSync(credFile);
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("returns undefined for corrupted JSON", () => {
    fs.mkdirSync(gleanDir, { recursive: true });
    fs.writeFileSync(credFile, "not-json{{{", "utf-8");

    expect(loadCredentials()).toBeUndefined();
  });

  it("overwrites existing credentials on save", () => {
    saveCredentials({ access_token: "old" }, { client_id: "old" });
    saveCredentials({ access_token: "new" }, { client_id: "new" });

    const loaded = loadCredentials();
    expect(loaded).toEqual({
      tokens: { access_token: "new" },
      clientInfo: { client_id: "new" },
    });
  });

  it("clearCredentials removes the persisted file", () => {
    saveCredentials({ access_token: "x" }, { client_id: "y" });
    expect(fs.existsSync(credFile)).toBe(true);

    clearCredentials();

    expect(fs.existsSync(credFile)).toBe(false);
    expect(loadCredentials()).toBeUndefined();
  });

  it("clearCredentials is a no-op when file does not exist", () => {
    expect(fs.existsSync(credFile)).toBe(false);
    expect(() => clearCredentials()).not.toThrow();
  });

  it("credentialsMtimeMs returns undefined when file does not exist", () => {
    expect(credentialsMtimeMs()).toBeUndefined();
  });

  it("credentialsMtimeMs returns a number once credentials are saved", () => {
    saveCredentials({ access_token: "x" }, undefined);
    expect(typeof credentialsMtimeMs()).toBe("number");
  });

  it("credentialsMtimeMs advances when the file is rewritten", () => {
    saveCredentials({ access_token: "x" }, undefined);
    const first = credentialsMtimeMs()!;
    // Force a strictly-newer mtime rather than relying on filesystem timer
    // resolution between two quick writes.
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(credFile, future, future);
    expect(credentialsMtimeMs()!).toBeGreaterThan(first);
  });

  it("migrates a host-managed credentials store into the canonical store", () => {
    process.env.PLUGIN_DATA_DIR = legacyDir;
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyDir, "mcp-credentials.json"),
      JSON.stringify({
        tokens: { access_token: "legacy-token" },
        clientInfo: { client_id: "legacy-client" },
      }),
    );

    expect(loadCredentials()).toEqual({
      tokens: { access_token: "legacy-token" },
      clientInfo: { client_id: "legacy-client" },
    });
    expect(fs.existsSync(credFile)).toBe(true);
  });

  it("serializes cross-process lock acquisition", () => {
    const first = acquireDataFileLockSync("lock-test", { waitMs: 0 });
    expect(first).toBeTruthy();
    const second = acquireDataFileLockSync("lock-test", { waitMs: 0 });
    expect(second).toBeUndefined();
    releaseDataFileLock(first);
    const third = acquireDataFileLockSync("lock-test", { waitMs: 0 });
    expect(third).toBeTruthy();
    releaseDataFileLock(third);
  });

  it("holds a client registration lock until registration completes", () => {
    const first = acquireClientRegistrationLock();
    expect(first).toBeTruthy();
    const second = acquireDataFileLockSync("mcp-client-registration", { waitMs: 0 });
    expect(second).toBeUndefined();
    releaseClientRegistrationLock(first);
  });

  it("does not let a metadata write clobber a newer token grant", () => {
    saveCredentials(
      { access_token: "new-token", refresh_token: "new-refresh" },
      { client_id: "cid" },
      { tokenUpdatedAt: 200 },
    );
    saveCredentials(
      undefined,
      undefined,
      { accountEmail: "user@example.com", tokenUpdatedAt: 100 },
    );

    expect(loadCredentials()).toMatchObject({
      tokens: { access_token: "new-token", refresh_token: "new-refresh" },
      clientInfo: { client_id: "cid" },
      accountEmail: "user@example.com",
      tokenUpdatedAt: 200,
    });
  });
});
