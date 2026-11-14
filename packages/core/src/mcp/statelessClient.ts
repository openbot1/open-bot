/**
 * MCP 2.0 stateless auto-negotiation (v1.04, Team T2).
 *
 * v0.97 built the stateless primitives (`stateless.ts`:
 * `server/discover`, per-request `_meta`); this module is the layer
 * that makes them the default path instead of an opt-in:
 *
 *   1. `stateless: 'auto'` — try `server/discover` first. A 2026
 *      server answers with its discovery document and the client
 *      stays stateless. A pre-2.0 server (2025-11-25 or older)
 *      answers `-32601` / no document (`discover()` returns null)
 *      and the client **falls back to the `initialize` handshake**
 *      instead of forcing stateless mode onto a server that does
 *      not understand it. The negotiated outcome
 *      (`StatelessNegotiation`) records which path was taken, so
 *      the UI / logs can say exactly what happened.
 *   2. Per-request `_meta` — once stateless mode is negotiated,
 *      every request carries the protocol version + client
 *      capabilities in `_meta` (`attachStatelessMetaToParams`),
 *      merged with whatever `_meta` the caller already set
 *      (notably `progressToken` — attaching stateless meta must
 *      never drop progress tracking).
 *
 * Ideas only — no code copied from any MCP implementation, SDK,
 * or the Grok Bot / Cursor installers. Nothing here touches the
 * network: it drives a minimal client surface (`discover` /
 * `initialize`), so tests use a fake client.
 */

import {
  buildStatelessMeta,
  MCP_PROTOCOL_VERSION_2026,
  type ServerDiscoverResult,
  type StatelessClientCapabilities,
  type StatelessRequestMeta,
} from './stateless';

/**
 * How a client connects to one MCP server (v1.04):
 *  - `false` (default): legacy `initialize` handshake, session id.
 *  - `true`: stateless only — `server/discover`, no handshake.
 *    A pre-2.0 server still works (every request carries `_meta`),
 *    but the client never handshakes.
 *  - `'auto'`: try `server/discover`; fall back to the `initialize`
 *    handshake when the server does not know discovery (pre-2.0).
 *    This is the recommended value for servers of unknown age.
 */
export type StatelessConnectMode = boolean | 'auto';

/** Which connection path was actually negotiated. */
export type StatelessNegotiatedMode = 'stateless' | 'handshake';

/** Outcome of one auto-negotiation attempt. */
export interface StatelessNegotiation {
  /** The path actually taken. */
  mode: StatelessNegotiatedMode;
  /** Protocol version in effect after negotiation. */
  protocolVersion: string;
  /** Discovery document when the server answered `server/discover`. */
  discovered: ServerDiscoverResult | null;
  /** True when `'auto'` fell back to the handshake (pre-2.0 server). */
  fellBack: boolean;
  /** True when the server answered discovery but with an older version. */
  discoveredOlderVersion: boolean;
}

/** Minimal client surface the negotiator drives. */
export interface StatelessNegotiableClient {
  discover(): Promise<ServerDiscoverResult | null>;
  initialize(): Promise<{ protocolVersion?: string }>;
}

/**
 * Negotiate how to talk to a server (v1.04).
 *
 * `mode` decides the strategy:
 *  - `'auto'`: `discover()` first. Document → stateless.
 *    `null` (pre-2.0 server, `-32601`) → `initialize()` handshake.
 *    A `discover()` throw is treated like "no discovery" and also
 *    falls back to the handshake; only when the handshake fails too
 *    does this throw (with the handshake error — the discover error
 *    is attached as `cause` context on the message).
 *  - `true`: stateless only — `discover()` (best-effort, its null is
 *    fine) and never handshake.
 *  - `false`: handshake only — `initialize()` straight away.
 *
 * `negotiatedProtocolVersion` lets the caller say which version a
 * previous step already agreed (e.g. a cached discovery); it is
 * only used as the fallback version when discovery returns null
 * and no handshake result is available (never happens in practice
 * — the handshake always reports a version).
 */
export async function negotiateStatelessConnection(
  client: StatelessNegotiableClient,
  mode: StatelessConnectMode,
  options: {
    /** Protocol version to report when nothing else says otherwise. */
    fallbackVersion?: string;
  } = {},
): Promise<StatelessNegotiation> {
  const fallbackVersion = options.fallbackVersion ?? MCP_PROTOCOL_VERSION_2026;
  if (mode === false) {
    const info = await client.initialize();
    return {
      mode: 'handshake',
      protocolVersion: info.protocolVersion || fallbackVersion,
      discovered: null,
      fellBack: false,
      discoveredOlderVersion: false,
    };
  }

  let discovered: ServerDiscoverResult | null = null;
  let discoverError: unknown = null;
  try {
    discovered = await client.discover();
  } catch (err) {
    discoverError = err;
  }

  if (discovered) {
    const older = discovered.protocolVersion !== MCP_PROTOCOL_VERSION_2026;
    return {
      mode: 'stateless',
      protocolVersion: discovered.protocolVersion || fallbackVersion,
      discovered,
      fellBack: false,
      discoveredOlderVersion: older,
    };
  }

  if (mode === true) {
    // Stateless-only: no discovery document, but the client still
    // works — every later request carries `_meta` and needs no
    // session. Nothing to fall back to by configuration.
    return {
      mode: 'stateless',
      protocolVersion: fallbackVersion,
      discovered: null,
      fellBack: false,
      discoveredOlderVersion: false,
    };
  }

  // 'auto': pre-2.0 server — fall back to the initialize handshake.
  try {
    const info = await client.initialize();
    return {
      mode: 'handshake',
      protocolVersion: info.protocolVersion || fallbackVersion,
      discovered: null,
      fellBack: true,
      discoveredOlderVersion: false,
    };
  } catch (handshakeError) {
    const detail =
      discoverError instanceof Error ? ` (discover cũng lỗi: ${discoverError.message})` : '';
    throw new Error(
      `MCP auto-negotiation thất bại: handshake initialize lỗi: ${
        handshakeError instanceof Error ? handshakeError.message : String(handshakeError)
      }${detail}`,
    );
  }
}

/**
 * Per-request stateless context: everything one request needs to
 * carry in `_meta` (protocol version + the capabilities this
 * client offers for this request).
 */
export interface StatelessRequestContext {
  protocolVersion: string;
  capabilities?: StatelessClientCapabilities;
  /** Round-trip continuation (MRTR) — carried through, see mrtr.ts. */
  roundTrip?: { roundTripId: string; round: number };
  /** Task continuation handle — carried through, see tasks.ts. */
  task?: { taskId: string };
}

/**
 * Build the `_meta` envelope for one request from a context.
 * Capabilities default to "can do MRTR + tasks + apps" — callers
 * that cannot honour a capability must pass a narrower object.
 */
export function buildRequestStatelessMeta(context: StatelessRequestContext): StatelessRequestMeta {
  return buildStatelessMeta({
    protocolVersion: context.protocolVersion,
    capabilities: context.capabilities ?? {
      multiRoundTrip: true,
      tasks: true,
      apps: true,
    },
    ...(context.roundTrip ? { roundTrip: context.roundTrip } : {}),
    ...(context.task ? { task: context.task } : {}),
  });
}

/**
 * Attach stateless `_meta` to request params, preserving whatever
 * `_meta` the caller already set. Existing keys win on conflict
 * (a caller-set `progressToken` is never dropped or overwritten),
 * and the original params object is never mutated — a copy is
 * returned. `undefined` params become `{ _meta }`.
 *
 * Returns the params to send (same reference when there is nothing
 * to attach — callers must not rely on a copy).
 */
export function attachStatelessMetaToParams(
  params: Record<string, unknown> | undefined,
  meta: StatelessRequestMeta,
): Record<string, unknown> {
  const base: Record<string, unknown> = params ? { ...params } : {};
  const existing = base['_meta'];
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    base['_meta'] = { ...meta, ...(existing as Record<string, unknown>) };
  } else if (existing === undefined) {
    base['_meta'] = { ...meta };
  } else {
    // A non-object `_meta` is a caller bug — keep the caller's
    // value intact and nest the stateless envelope under it is
    // impossible, so replace it: the stateless envelope is what
    // the server needs to route the request.
    base['_meta'] = { ...meta };
  }
  return base;
}

/**
 * Derive the stateless capabilities to declare in `_meta` from a
 * client's advertised `initialize` capabilities record. Only the
 * known boolean keys are picked up; anything else is ignored.
 * When the record is absent (or declares none of them), the
 * caller should pass `undefined` to `buildRequestStatelessMeta`
 * and get the full default surface instead.
 */
export function statelessCapabilitiesFor(
  capabilities: Record<string, unknown> | undefined,
): StatelessClientCapabilities | undefined {
  if (!capabilities) return undefined;
  const caps: StatelessClientCapabilities = {};
  let any = false;
  for (const key of ['multiRoundTrip', 'tasks', 'apps', 'deprecatedCallbacks'] as const) {
    if (capabilities[key] === true) {
      caps[key] = true;
      any = true;
    }
  }
  if (capabilities['experimental'] && typeof capabilities['experimental'] === 'object') {
    caps.experimental = capabilities['experimental'] as Record<string, unknown>;
    any = true;
  }
  return any ? caps : undefined;
}

/**
 * One-line human summary of a negotiation, for logs / the activity
 * feed (Vietnamese, like the rest of the MCP surface).
 */
export function describeStatelessNegotiation(negotiation: StatelessNegotiation): string {
  if (negotiation.mode === 'stateless' && negotiation.discovered) {
    return negotiation.discoveredOlderVersion
      ? `MCP stateless (server ${negotiation.protocolVersion}, cũ hơn 2026-07-28 — vẫn dùng được qua _meta).`
      : `MCP stateless 2026-07-28 (server/discover OK).`;
  }
  if (negotiation.mode === 'stateless') {
    return 'MCP stateless (server không trả discovery document — mọi request vẫn mang _meta).';
  }
  if (negotiation.fellBack) {
    return `MCP handshake initialize (fallback: server ${negotiation.protocolVersion}, pre-2.0 — không biết server/discover).`;
  }
  return `MCP handshake initialize (server ${negotiation.protocolVersion}).`;
}
