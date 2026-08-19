import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { hostIdentityFromHandshake, buildNegotiationRequest } from "./context.js";
import { classifyResult, metaFor } from "./negotiate.js";
import { evaluate } from "./evaluate.js";
import { clearCache, loadCached, savePolicy } from "./cache.js";
import { ProtocolVersionObserver } from "./protocol-version.js";
import type { Decision, NegotiationRequest, PolicyResponse } from "./types.js";

type LogFn = (label: string, detail?: Record<string, unknown>) => void;

/**
 * Session-scoped state for the capability/policy exchange.
 *
 * Kept out of index.ts so the wiring there stays to a few lines, and so the pieces a
 * later change needs -- the resolved decision, the `_meta` to attach -- have one
 * obvious home.
 *
 * This module reports context and records the resolved policy. It does not enforce
 * anything: nothing here changes which tools are advertised or which calls succeed.
 * Enforcement is a separate change, deliberately, so the exchange can be observed in
 * production before it is allowed to alter behaviour.
 */
let mcpServer: Server | undefined;
let logLine: LogFn = () => {};
let decision: Decision | undefined;
let lastRequest: NegotiationRequest | undefined;
// The remote the policy cache is keyed by. Held here rather than threaded through
// every call site so that `callRemoteTool` -- the single funnel every remote tool call
// passes through -- can record policy without knowing about configuration resolution.
// Keyed by URL so switching Glean instances cannot apply one instance's policy to
// another.
let cacheKeyUrl: string | undefined;

export const protocolVersion = new ProtocolVersionObserver();

export function initPolicySession(server: Server, log: LogFn): void {
  mcpServer = server;
  logLine = log;
}

/** Called whenever the configured server URL is resolved or changed. */
export function setPolicyServerUrl(url: string | undefined): void {
  cacheKeyUrl = url;
}

/**
 * Discard every cached policy, for `setup({reset})`.
 *
 * Deliberately global, with no URL argument, to match clearRemoteTools() on the same
 * path: reset wipes the tools cache for every URL, and a per-URL policy clear here
 * would leave the two stores disagreeing about what "reset" cleared. The two caches
 * are separate files, so nothing but this pairing keeps them consistent — a new clear
 * path has to touch both.
 */
export function clearPolicyCache(): void {
  clearCache();
  decision = undefined;
}

/**
 * The negotiation payload for the current session, rebuilt per request so a late
 * `initialize` (the handshake completes after the transport is wired) is reflected
 * rather than captured as undefined at startup.
 */
export function negotiationRequest(): NegotiationRequest {
  const host = hostIdentityFromHandshake(
    mcpServer?.getClientVersion(),
    mcpServer?.getClientCapabilities() as Record<string, unknown> | undefined,
    protocolVersion.version,
  );
  lastRequest = buildNegotiationRequest(host);
  return lastRequest;
}

/** The `_meta` envelope to attach to an outgoing remote request. */
export function negotiationMeta(): { _meta: Record<string, unknown> } {
  return metaFor(negotiationRequest());
}

/**
 * Record the policy carried on a remote response, if any.
 *
 * The four outcomes are distinct on purpose:
 *   policy      - persist it and re-evaluate.
 *   no-policy   - the remote does not implement negotiation yet. Every supported
 *                 feature is treated as enabled and no version rule applies. The
 *                 cache is NOT erased.
 *   malformed   - keep the last valid policy and treat this round as no-policy, so a
 *                 bad response can never deactivate a working plugin.
 *   unreachable - decided by the caller, not here: an unreachable remote produces no
 *                 result to classify. Conflating it with no-policy would silently
 *                 drop a previously synced version rule on any network blip.
 */
export function recordPolicyFromResult(result: unknown, label: string): void {
  // No configured remote yet means nothing to key the cache by, and no exchange to
  // record. Silent no-op rather than an error: this runs on every remote call.
  const serverUrl = cacheKeyUrl;
  if (!serverUrl) return;

  const outcome = classifyResult(result);
  const cached = loadCached(serverUrl);
  let policy: PolicyResponse | undefined;

  switch (outcome.kind) {
    case "policy":
      policy = outcome.policy;
      savePolicy(serverUrl, outcome.policy);
      // Unknown keys are accepted and ignored -- a newer remote must be able to add
      // fields without an older plugin rejecting the response -- but reported, since
      // an unrecognized key's type is never checked and a renamed field carrying a
      // bad value would otherwise pass in total silence.
      if (outcome.unknownKeys.length > 0) {
        logLine("policy.unknown-keys", { label, keys: outcome.unknownKeys });
      }
      break;
    case "malformed":
      logLine("policy.malformed", { label, reason: outcome.reason });
      policy = cached.policy;
      break;
    case "no-policy":
      policy = undefined;
      break;
  }

  const request = lastRequest ?? negotiationRequest();
  const next = evaluate({
    pluginVersion: request.plugin.version,
    versionSource: request.plugin.versionSource,
    supportedFeatures: request.plugin.supportedFeatures,
    policy,
  });

  const changed =
    !decision ||
    JSON.stringify([decision.deactivated, decision.features]) !==
      JSON.stringify([next.deactivated, next.features]);
  decision = next;

  if (changed) {
    logLine("policy.resolved", {
      label,
      outcome: outcome.kind,
      versionState: next.versionState,
      deactivated: next.deactivated,
      features: next.features,
      reasons: next.reasons,
    });
  }
}

/** The policy currently in force, or undefined before the first exchange. */
export function currentDecision(): Decision | undefined {
  return decision;
}

/** For `setup` output: what was reported, and what came back. */
export function policySummary(): string[] {
  const r = lastRequest;
  const d = decision;
  const lines = [
    `Plugin version: ${r?.plugin.version ?? "?"} (source: ${r?.plugin.versionSource ?? "?"})`,
    `Host: ${r?.host.id ?? "?"} ${r?.host.version ?? ""} (source: ${r?.host.source ?? "?"})`,
    `MCP revision: ${r?.host.mcpProtocolVersion ?? "not observed"}`,
    `Server inventory: ${r?.configuredServers.source ?? "?"}`,
  ];
  if (d) {
    lines.push(`Policy: version ${d.versionState}, features ${JSON.stringify(d.features)}`);
    if (d.message) lines.push(`Notice: ${d.message}`);
  } else {
    lines.push("Policy: not yet negotiated");
  }
  return lines;
}
