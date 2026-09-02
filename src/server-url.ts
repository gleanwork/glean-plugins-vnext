const DEFAULT_MCP_PATH = "/mcp/gateway/proxy";

function parseServerUrl(raw: string): URL {
  const parsed = new URL(raw);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Server URL must use http or https.");
  }
  return parsed;
}

/** Preserve an explicitly supplied endpoint, including experiment path segments. */
export function preserveExplicitServerUrl(raw: string): string {
  parseServerUrl(raw);
  return raw;
}

/** Convert an email-discovered QE origin to the default MCP gateway endpoint. */
export function normalizeDiscoveredServerUrl(raw: string): string {
  const parsed = parseServerUrl(raw);
  return `${parsed.origin}${DEFAULT_MCP_PATH}`;
}
