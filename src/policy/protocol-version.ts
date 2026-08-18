import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/**
 * Observe the MCP revision the plugin and the host settle on.
 *
 * The SDK negotiates this internally -- it compares the host's requested version
 * against SUPPORTED_PROTOCOL_VERSIONS and answers with either that version or its
 * own latest -- but exposes no server-side accessor for the outcome. `Server` keeps
 * only clientInfo and client capabilities. So the value is recovered by watching the
 * `initialize` exchange on the transport, which is public API: `Transport` is a
 * plain interface, so wrapping it needs no private-field access and no subclassing.
 *
 * The NEGOTIATED value is read from the initialize *response*, not the request. The
 * request carries what the host proposed, which differs whenever the host asks for a
 * revision this build does not implement -- exactly the case worth reporting.
 */
export class ProtocolVersionObserver {
  private negotiated: string | undefined;
  private proposed: string | undefined;
  private initializeId: string | number | undefined;

  /** The agreed revision, or undefined when it could not be observed. */
  get version(): string | undefined {
    return this.negotiated;
  }

  /** What the host asked for. Retained for diagnostics, not reported as the answer. */
  get requested(): string | undefined {
    return this.proposed;
  }

  /**
   * Wrap a transport so the initialize exchange is observed as it passes through.
   * Delegates everything; the only additions are two taps that never throw, since a
   * failed observation must degrade to "unknown" rather than break the connection.
   */
  wrap(inner: Transport): Transport {
    const observer = this;

    const wrapped: Transport = {
      start: () => inner.start(),
      close: () => inner.close(),
      send: async (message, options) => {
        observer.observeOutgoing(message);
        return inner.send(message, options);
      },
      get sessionId() {
        return inner.sessionId;
      },
      set onmessage(handler) {
        inner.onmessage = handler
          ? (message, extra) => {
              observer.observeIncoming(message);
              handler(message, extra);
            }
          : undefined;
      },
      get onmessage() {
        return inner.onmessage;
      },
      set onclose(handler) {
        inner.onclose = handler;
      },
      get onclose() {
        return inner.onclose;
      },
      set onerror(handler) {
        inner.onerror = handler;
      },
      get onerror() {
        return inner.onerror;
      },
    };

    return wrapped;
  }

  private observeIncoming(message: JSONRPCMessage): void {
    try {
      const m = message as { id?: string | number; method?: string; params?: unknown };
      if (m.method !== "initialize" || m.id === undefined) return;
      this.initializeId = m.id;
      const params = m.params as { protocolVersion?: unknown } | undefined;
      if (typeof params?.protocolVersion === "string") {
        this.proposed = params.protocolVersion;
      }
    } catch {
      // Observation is best-effort; the field is omitted rather than guessed.
    }
  }

  private observeOutgoing(message: JSONRPCMessage): void {
    try {
      const m = message as { id?: string | number; result?: unknown };
      if (m.id === undefined || m.id !== this.initializeId) return;
      const result = m.result as { protocolVersion?: unknown } | undefined;
      if (typeof result?.protocolVersion === "string") {
        this.negotiated = result.protocolVersion;
      }
    } catch {
      // As above.
    }
  }
}
