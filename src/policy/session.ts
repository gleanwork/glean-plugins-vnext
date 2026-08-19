import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { hostIdentityFromHandshake, buildNegotiationRequest, supportedFeatures } from "./context.js";
import { classifyResult, metaFor } from "./negotiate.js";
import { evaluate } from "./evaluate.js";
import { loadCachedPolicy, savePolicy } from "./cache.js";
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
 * This module owns the decision's lifecycle: it reports context, records the policy a
 * response carried, and resolves the decision now in force. It does not itself withhold
 * or refuse anything -- the gates are pure functions in ./enforce.ts, applied by the
 * handlers in index.ts.
 */
let mcpServer: Server | undefined;
let logLine: LogFn = () => {};
let decision: Decision | undefined;
// Labels already logged in this process, so each negotiation path reports itself once
// even when the resolved decision never changes. See recordPolicyFromResult.
const loggedLabels = new Set<string>();
let lastRequest: NegotiationRequest | undefined;
// The remote the policy cache is keyed by. Held here rather than threaded through
// every call site so that `callRemoteTool` -- the single funnel every remote tool call
// passes through -- can record policy without knowing about configuration resolution.
// Keyed by URL so switching Glean instances cannot apply one instance's policy to
// another.
let cacheKeyUrl: string | undefined;

export const protocolVersion = new ProtocolVersionObserver();

// The label recordPolicyFromResult receives for a tools/list exchange. Exported so the
// caller and the notification guard cannot drift apart on a string literal — the guard
// depends on distinguishing that path from tools/call.
export const TOOLS_LIST_LABEL = "tools/list";

export function initPolicySession(server: Server, log: LogFn): void {
  mcpServer = server;
  logLine = log;
}

/** Called whenever the configured server URL is resolved or changed. */
export function setPolicyServerUrl(url: string | undefined): void {
  cacheKeyUrl = url;
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
  const cachedPolicy = loadCachedPolicy(serverUrl);
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
      policy = cachedPolicy;
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

  const previous = decision;
  const changed =
    !previous || surfaceKey(previous) !== surfaceKey(next);
  decision = next;

  // Log on a change, and once per label per process.
  //
  // The second condition is what makes the mechanism observable at all. A steady-state
  // exchange changes nothing -- against a remote with no policy support, every response
  // resolves to the same decision -- so change-only logging goes silent after the first
  // tools/list and never says a word about tools/call again. The result is a feature
  // whose entire job is remote control, with no evidence in the log that it ran on a
  // given path. Labels are bounded (one per distinct remote method plus tool name), so
  // this is a handful of lines per process, not per call.
  const firstForLabel = !loggedLabels.has(label);
  loggedLabels.add(label);

  if (changed || firstForLabel) {
    logLine("policy.resolved", {
      label,
      outcome: outcome.kind,
      versionState: next.versionState,
      deactivated: next.deactivated,
      features: next.features,
      reasons: next.reasons,
    });
  }

  // Tell the host to re-fetch, but only from the tools/call path and only once a
  // previous decision existed.
  //
  // Not from tools/list: there the response IS the update -- the host has just asked and
  // is about to receive the freshly filtered surface, so a notification would only make
  // it ask again for what it already holds, and notify -> tools/list -> resolve ->
  // notify would be a cycle. A policy arriving on a tools/call response is the case that
  // needs this, because the surface changed and the host has no reason to re-fetch.
  //
  // Not on the first decision either: `!previous` counts as changed, so without that
  // guard every process's first gated call would notify, costing a host tools/list and a
  // remote round-trip for every user in a world where no policy exists. The stale-list
  // window on a first call is closed by the refusal, which is the real gate anyway.
  if (changed && previous && label !== TOOLS_LIST_LABEL) {
    logLine("policy.surface-changed", {
      label,
      from: { deactivated: previous.deactivated, features: previous.features },
      to: { deactivated: next.deactivated, features: next.features },
    });
    mcpServer?.sendToolListChanged().catch(() => {
      // Transport not connected, or the host does not support the notification.
      // Harmless: the next tools/list is correct, and calls are refused regardless.
    });
  }
}

// The fields that determine what the agent can reach. Reasons and messages churn between
// otherwise-equivalent responses without changing the surface, and every spurious
// notification costs a host tools/list and therefore a remote round-trip.
function surfaceKey(d: Decision): string {
  return JSON.stringify([d.deactivated, d.features]);
}

/**
 * The decision now in force, seeded from the cached policy on first read.
 *
 * A fresh process has no decision until a remote exchange happens, and `tools/list` does
 * not always reach the remote -- the unconfigured, unauthenticated and connect-error
 * paths all return before any negotiation. Treating that as "no policy, everything on"
 * would mean a cached deactivation, or a cached `metaTools: false`, was silently undone
 * by every process start, which is exactly what the design forbids.
 *
 * So the first read evaluates the cached policy and memoizes the result. The cache is
 * touched once per process, never per gated call: `_meta` rides every remote request, so
 * a process that talks to the remote refreshes its own decision constantly and needs no
 * re-read. With no configured URL there is nothing to key by, which yields the
 * all-supported decision.
 *
 * Never throws. A failure here would break every tool call, and for a feature that is
 * inert for every install today, failing open is the only defensible direction.
 */
export function decisionInForce(): Decision {
  if (decision) return decision;
  try {
    const policy = cacheKeyUrl ? loadCachedPolicy(cacheKeyUrl) : undefined;
    const request = lastRequest ?? negotiationRequest();
    decision = evaluate({
      pluginVersion: request.plugin.version,
      versionSource: request.plugin.versionSource,
      supportedFeatures: request.plugin.supportedFeatures,
      policy,
    });
    if (policy) {
      logLine("policy.seeded-from-cache", {
        versionState: decision.versionState,
        deactivated: decision.deactivated,
        features: decision.features,
      });
    }
    return decision;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logLine("policy.seed-failed", { msg });
    decision = evaluate({
      pluginVersion: "0.0.0",
      versionSource: "unknown",
      supportedFeatures: supportedFeatures(),
      policy: undefined,
    });
    return decision;
  }
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
