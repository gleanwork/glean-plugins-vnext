import { describe, it, expect, vi } from "vitest";
import { resolveServerUrlFromEmail } from "../src/config-search.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("resolveServerUrlFromEmail", () => {
  it("returns the tenant queryURL for a recognized domain", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        search_config: {
          queryURL: "https://acme-be.glean.com/",
          centralURL: "https://apps-be.glean.com/",
          isMultiTenant: false,
        },
      }),
    );

    const result = await resolveServerUrlFromEmail(
      "you@acme.com",
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toEqual({ ok: true, queryUrl: "https://acme-be.glean.com/" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://app.glean.com/config/search");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      email: "you@acme.com",
      emailDomain: "acme.com",
      isGleanApp: true,
    });
  });

  it("accepts a multi-tenant deployment served from the central URL", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        search_config: {
          queryURL: "https://apps-be.glean.com/",
          centralURL: "https://apps-be.glean.com/",
          isMultiTenant: true,
        },
      }),
    );

    const result = await resolveServerUrlFromEmail(
      "you@multitenant.example",
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toEqual({ ok: true, queryUrl: "https://apps-be.glean.com/" });
  });

  it("rejects an unrecognized domain that falls back to the central URL", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        search_config: {
          queryURL: "https://apps-be.glean.com/",
          centralURL: "https://apps-be.glean.com/",
          isMultiTenant: false,
        },
      }),
    );

    const result = await resolveServerUrlFromEmail(
      "you@unknown-domain.example",
      fetchImpl as unknown as typeof fetch,
    );

    expect(result.ok).toBe(false);
  });

  it("rejects a malformed email without calling the endpoint", async () => {
    const fetchImpl = vi.fn();
    const result = await resolveServerUrlFromEmail(
      "not-an-email",
      fetchImpl as unknown as typeof fetch,
    );

    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects when the endpoint returns no queryURL", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ search_config: { centralURL: "https://apps-be.glean.com/" } }),
    );

    const result = await resolveServerUrlFromEmail(
      "you@acme.com",
      fetchImpl as unknown as typeof fetch,
    );

    expect(result.ok).toBe(false);
  });

  it("surfaces a non-OK HTTP status as an error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, false, 500));

    const result = await resolveServerUrlFromEmail(
      "you@acme.com",
      fetchImpl as unknown as typeof fetch,
    );

    expect(result.ok).toBe(false);
  });

  it("surfaces a network failure as an error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection refused");
    });

    const result = await resolveServerUrlFromEmail(
      "you@acme.com",
      fetchImpl as unknown as typeof fetch,
    );

    expect(result.ok).toBe(false);
  });
});
