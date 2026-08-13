const MCP_GATEWAY_PATH = "/mcp/gateway/proxy";

/**
 * Normalize either a normal QE origin or a path-prefixed experimental QE URL
 * to the MCP gateway endpoint.
 *
 * Examples:
 *   https://acme-be.glean.com
 *     -> https://acme-be.glean.com/mcp/gateway/proxy
 *   https://scio-prod-be.glean.com/qe-glean-exp-101
 *     -> https://scio-prod-be.glean.com/qe-glean-exp-101/mcp/gateway/proxy
 */
export function normalizeServerUrl(raw: string): string {
  const parsed = new URL(raw);
  const pathname = parsed.pathname.replace(/\/+$/, "");
  const prefix = pathname.endsWith(MCP_GATEWAY_PATH)
    ? pathname.slice(0, -MCP_GATEWAY_PATH.length)
    : pathname === "/"
      ? ""
      : pathname;
  return `${parsed.origin}${prefix}${MCP_GATEWAY_PATH}${parsed.search}`;
}
