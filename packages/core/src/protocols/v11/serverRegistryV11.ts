/**
 * Protocols v11 — multi-server registry + routing resolution (v1.42, Team T2).
 *
 * Idea only, learned from the public MCP 2.0 description in
 * docs/repo-survey-v142.md (section 2): routing headers steer
 * a request to the right server behind one endpoint, and
 * `server/discover` publishes each server's routing table.
 * A routing header is only useful if the host can resolve
 * the routing key to a server — that is what this module
 * owns. No code, text or asset from any other repo is copied
 * here. No network is opened: servers are registered from
 * discover documents the host already fetched.
 *
 * What this module owns:
 *  - `McpV11ServerRegistry`: register servers from their
 *    discover results (id, endpoint, version, extensions,
 *    routing key, cacheable lists), look one up by id or by
 *    routing key, mark health (ok / degraded / down with a
 *    reason + timestamp), remove, list, snapshot/restore.
 *  - Routing resolution: `resolveRoutingKey()` maps a
 *    `mcp-routing-key` header value to the server that
 *    should handle the request; unknown keys resolve to a
 *    named error instead of silently hitting the wrong
 *    server.
 *  - Version-aware capability lookup: the registry answers
 *    "which registered servers speak stateless 2026-07-28?"
 *    and "which need the handshake fallback?" so the host
 *    can pick a client per server instead of guessing.
 *  - Health-aware routing: a `down` server is never
 *    returned by resolution (the caller gets a
 *    `server-unavailable` problem); a `degraded` server is
 *    returned with a warning attached.
 */

import {
  MCP_V11_CURRENT_VERSION,
  mcpV11InteropMode,
  mcpV11NeedsHandshake,
  type McpV11InteropMode,
} from './versionsV11';
import type { McpV11DiscoverResult } from './statelessV11';

/** Health states a registered server can be in. */
export type McpV11ServerHealth = 'ok' | 'degraded' | 'down';

/** One registered server. */
export interface McpV11RegisteredServer {
  /** Stable server id (from discover serverInfo.name, or host-assigned). */
  id: string;
  /** Endpoint the host reaches the server at (loopback URL or in-process name). */
  endpoint: string;
  /** Protocol version the server speaks. */
  protocolVersion: string;
  /** Extensions the server offers (tasks, ui, ...). */
  extensions: string[];
  /** Routing key the server published in discover (if any). */
  routingKey?: string;
  /** Lists the server serves as cacheable. */
  cacheableLists: string[];
  /** Current health. */
  health: McpV11ServerHealth;
  /** Why the server is degraded/down (when known). */
  healthReason?: string;
  /** Last time the health was updated (ms since epoch). */
  healthUpdatedAtMs: number;
  /** When the server was registered (ms since epoch). */
  registeredAtMs: number;
  /** The full discover document (kept for capability lookups). */
  discover: McpV11DiscoverResult;
}

/** Outcome of resolving a routing key. */
export type McpV11RoutingResolution =
  | { ok: true; server: McpV11RegisteredServer; warning?: string }
  | { ok: false; code: 'unknown-routing-key' | 'server-unavailable'; message: string };

/** Error raised by the server registry. */
export class McpV11RegistryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'McpV11RegistryError';
    this.code = code;
  }
}

/** In-memory registry of MCP servers the host knows about. */
export class McpV11ServerRegistry {
  private servers = new Map<string, McpV11RegisteredServer>();

  /** Register (or re-register) a server from its discover result. */
  register(discover: McpV11DiscoverResult, endpoint: string, id?: string): McpV11RegisteredServer {
    const serverId = id ?? discover.serverInfo.name;
    if (!serverId) throw new McpV11RegistryError('invalid-server', 'Server id is required.');
    if (!endpoint) throw new McpV11RegistryError('invalid-server', 'Server endpoint is required.');
    const now = Date.now();
    const existing = this.servers.get(serverId);
    const routingKey = discover.routing[serverId] ?? discover.routing[discover.serverInfo.name];
    const server: McpV11RegisteredServer = {
      id: serverId,
      endpoint,
      protocolVersion: discover.protocolVersion,
      extensions: [...discover.extensions],
      ...(routingKey ? { routingKey } : {}),
      cacheableLists: [...discover.cacheableLists],
      health: existing?.health ?? 'ok',
      ...(existing?.healthReason ? { healthReason: existing.healthReason } : {}),
      healthUpdatedAtMs: existing?.healthUpdatedAtMs ?? now,
      registeredAtMs: existing?.registeredAtMs ?? now,
      discover,
    };
    this.servers.set(serverId, server);
    return server;
  }

  get(id: string): McpV11RegisteredServer | undefined {
    return this.servers.get(id);
  }

  require(id: string): McpV11RegisteredServer {
    const server = this.servers.get(id);
    if (!server) throw new McpV11RegistryError('server-not-found', `No registered server "${id}".`);
    return server;
  }

  /** Remove a server. Returns true when something was removed. */
  remove(id: string): boolean {
    return this.servers.delete(id);
  }

  /** All servers, sorted by id. */
  list(): McpV11RegisteredServer[] {
    return [...this.servers.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  /** Servers filtered by health. */
  listByHealth(health: McpV11ServerHealth): McpV11RegisteredServer[] {
    return this.list().filter((s) => s.health === health);
  }

  /** Servers speaking the given protocol version. */
  listByVersion(protocolVersion: string): McpV11RegisteredServer[] {
    return this.list().filter((s) => s.protocolVersion === protocolVersion);
  }

  /** Servers offering the given extension. */
  listByExtension(extension: string): McpV11RegisteredServer[] {
    return this.list().filter((s) => s.extensions.includes(extension));
  }

  /** Update a server's health (records the reason + timestamp). */
  setHealth(id: string, health: McpV11ServerHealth, reason?: string): McpV11RegisteredServer {
    if (!['ok', 'degraded', 'down'].includes(health)) {
      throw new McpV11RegistryError('invalid-health', `Unknown health "${String(health)}" (ok | degraded | down).`);
    }
    const server = this.require(id);
    server.health = health;
    server.healthUpdatedAtMs = Date.now();
    if (reason !== undefined) server.healthReason = reason;
    else delete server.healthReason;
    return server;
  }

  /**
   * Resolve a routing key to a server. Unknown keys and `down`
   * servers are errors, never silent misroutes; a `degraded`
   * server resolves with a warning.
   */
  resolveRoutingKey(routingKey: string): McpV11RoutingResolution {
    const server = this.list().find((s) => s.routingKey === routingKey);
    if (!server) {
      return {
        ok: false,
        code: 'unknown-routing-key',
        message: `No registered server publishes routing key "${routingKey}".`,
      };
    }
    if (server.health === 'down') {
      return {
        ok: false,
        code: 'server-unavailable',
        message: `Server "${server.id}" is down${server.healthReason ? `: ${server.healthReason}` : ''}.`,
      };
    }
    if (server.health === 'degraded') {
      return {
        ok: true,
        server,
        warning: `Server "${server.id}" is degraded${server.healthReason ? `: ${server.healthReason}` : ''}.`,
      };
    }
    return { ok: true, server };
  }

  /** How the current client talks to a registered server. */
  interopFor(id: string): { mode: McpV11InteropMode; handshakeRequired: boolean } {
    const server = this.require(id);
    const row = mcpV11InteropMode(MCP_V11_CURRENT_VERSION, server.protocolVersion);
    return { mode: row.mode, handshakeRequired: row.handshakeRequired };
  }

  /** Servers that need the handshake fallback (old versions). */
  legacyServers(): McpV11RegisteredServer[] {
    return this.list().filter((s) => mcpV11NeedsHandshake(s.protocolVersion));
  }

  counts(): { total: number; ok: number; degraded: number; down: number; stateless: number; legacy: number } {
    const all = this.list();
    return {
      total: all.length,
      ok: all.filter((s) => s.health === 'ok').length,
      degraded: all.filter((s) => s.health === 'degraded').length,
      down: all.filter((s) => s.health === 'down').length,
      stateless: all.filter((s) => s.protocolVersion === MCP_V11_CURRENT_VERSION).length,
      legacy: all.filter((s) => mcpV11NeedsHandshake(s.protocolVersion)).length,
    };
  }

  /** Serialisable snapshot (the host mirrors it; the registry never writes to disk). */
  snapshot(): { servers: McpV11RegisteredServer[]; savedAtMs: number } {
    return { servers: this.list(), savedAtMs: Date.now() };
  }

  /** Restore from a snapshot (replaces the whole registry). */
  restore(snapshot: { servers: McpV11RegisteredServer[] }): number {
    this.servers.clear();
    for (const server of snapshot.servers ?? []) this.servers.set(server.id, { ...server });
    return this.servers.size;
  }
}
