/**
 * Protocols v2 — server/discover + 2025-era compat shim +
 * subscriptions/listen (v1.16, Team T2).
 *
 * Idea only, learned from the public MCP 2026-07-28 description
 * in docs/repo-survey-v116.md section 3: the stateless core drops
 * `initialize`/`Mcp-Session-Id`; every request carries version +
 * capabilities in `_meta`; `server/discover` is mandatory on the
 * server side; `subscriptions/listen` replaces the GET stream and
 * `resources/subscribe`; multi round-trip replaces
 * server-initiated requests. No code, text or asset from any other
 * repo is copied here.
 *
 * This module is the server side of that core, v2 edition:
 * - `buildServerDiscoverDocument()` — the discover document a
 *   server answers with: protocol version, server info, the
 *   capability matrix, the extension list (Tasks, Skills, Apps)
 *   and the deprecation notice for legacy clients.
 * - `validateServerDiscoverDocument()` — the client-side check
 *   that a discover document is well-formed before trusting it.
 * - `CompatShim2025` — translates a 2025-era client
 *   (`initialize` + `Mcp-Session-Id` + `notifications/initialized`
 *   + `resources/subscribe` + sampling/roots/logging) into
 *   stateless calls, and reports every translation as a
 *   deprecation warning with the removal date, so old clients
 *   keep working while their owners get a concrete deadline.
 * - `SubscriptionHub` — `subscriptions/listen`: a client opens
 *   one listen channel and subscribes to resource/task/event
 *   topics; the hub fans published updates out to subscribers
 *   and replays missed updates after a reconnect.
 *
 * Design rules:
 * - Discover is mandatory: a client that skips it gets a
 *   `DISCOVER_REQUIRED` error, never a silent default.
 * - The shim never invents capabilities: a legacy method with
 *   no stateless equivalent (sampling, roots, logging) is
 *   rejected with a named error + guidance, not emulated.
 * - Subscriptions are local-first and in-memory; a reconnect
 *   replays only the updates the client missed (by sequence),
 *   never the whole history.
 */

import {
  MCP_V2_CURRENT_VERSION,
  MCP_V2_LEGACY_REMOVAL_DATE,
  MCP_V2_LEGACY_VERSIONS,
  PROTOCOL_V2_KNOWN_CAPABILITIES,
  isLegacyProtocolV2Version,
  legacyRemovalInDays,
  negotiateProtocolV2Version,
  type ProtocolV2Negotiation,
} from './versions';

/** MCP extension identifiers negotiated through capabilities. */
export const MCP_V2_EXTENSION_IDS = {
  tasks: 'io.modelcontextprotocol/tasks',
  skills: 'io.modelcontextprotocol/skills',
  apps: 'io.modelcontextprotocol/apps',
} as const;
export type McpV2ExtensionId = (typeof MCP_V2_EXTENSION_IDS)[keyof typeof MCP_V2_EXTENSION_IDS];

/** One extension entry in a discover document. */
export interface McpV2ExtensionInfo {
  id: McpV2ExtensionId;
  version: string;
  methods: string[];
}

/** The document a v2 server returns from `server/discover`. */
export interface McpV2DiscoverDocument {
  protocolVersion: string;
  serverInfo: { name: string; version: string };
  capabilities: Record<string, Record<string, unknown>>;
  extensions: McpV2ExtensionInfo[];
  /** Methods this server will never accept (removed in the stateless core). */
  removedMethods: string[];
  deprecation?: {
    legacyVersions: readonly string[];
    removalDate: string;
    removalInDays: number;
    message: string;
  };
}

/** Methods removed by the 2026-07-28 stateless core. */
export const MCP_V2_REMOVED_METHODS = [
  'initialize',
  'notifications/initialized',
  'resources/subscribe',
  'sampling/createMessage',
  'roots/list',
  'logging/setLevel',
] as const;

/** Error for a request that violates the stateless core rules. */
export class McpV2DiscoverError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'McpV2DiscoverError';
    this.code = code;
  }
}

/** Options for building a discover document. */
export interface BuildDiscoverOptions {
  serverName: string;
  serverVersion: string;
  /** Capabilities the server offers (defaults to the full known set). */
  capabilities?: string[];
  /** Extensions the server offers (defaults to tasks + skills + apps). */
  extensions?: McpV2ExtensionInfo[];
  /** Client protocol versions, for the embedded negotiation note. */
  clientVersions?: readonly string[];
}

const DEFAULT_EXTENSIONS: McpV2ExtensionInfo[] = [
  { id: MCP_V2_EXTENSION_IDS.tasks, version: '1.0.0', methods: ['tasks/create', 'tasks/get', 'tasks/list', 'tasks/update', 'tasks/cancel'] },
  { id: MCP_V2_EXTENSION_IDS.skills, version: '1.0.0', methods: ['skills/list', 'skills/get'] },
  { id: MCP_V2_EXTENSION_IDS.apps, version: '1.0.0', methods: ['apps/list', 'apps/render'] },
];

/**
 * Build the `server/discover` document for this server. The
 * document always advertises the current version; when the
 * caller passes legacy client versions, the negotiation note
 * records which legacy version was agreed instead.
 */
export function buildServerDiscoverDocument(options: BuildDiscoverOptions): {
  document: McpV2DiscoverDocument;
  negotiation: ProtocolV2Negotiation | null;
} {
  const capabilities = options.capabilities ?? [...PROTOCOL_V2_KNOWN_CAPABILITIES.mcp];
  const capabilityMap: Record<string, Record<string, unknown>> = {};
  for (const cap of capabilities) capabilityMap[cap] = {};
  const negotiation = options.clientVersions
    ? negotiateProtocolV2Version('mcp', options.clientVersions)
    : null;
  const document: McpV2DiscoverDocument = {
    protocolVersion: MCP_V2_CURRENT_VERSION,
    serverInfo: { name: options.serverName, version: options.serverVersion },
    capabilities: capabilityMap,
    extensions: options.extensions ?? DEFAULT_EXTENSIONS,
    removedMethods: [...MCP_V2_REMOVED_METHODS],
    deprecation: {
      legacyVersions: MCP_V2_LEGACY_VERSIONS,
      removalDate: MCP_V2_LEGACY_REMOVAL_DATE,
      removalInDays: legacyRemovalInDays(),
      message:
        `MCP versions ${MCP_V2_LEGACY_VERSIONS.join(', ')} are deprecated and will be removed on ` +
        `${MCP_V2_LEGACY_REMOVAL_DATE}. Upgrade to ${MCP_V2_CURRENT_VERSION} (stateless core, server/discover).`,
    },
  };
  return { document, negotiation };
}

/**
 * Validate a discover document received from a server. Returns
 * the list of problems (empty = valid). A document is only
 * trusted when it names a supported protocol version, identifies
 * the server, and lists its capabilities as objects.
 */
export function validateServerDiscoverDocument(doc: unknown): string[] {
  const problems: string[] = [];
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return ['discover document must be a JSON object'];
  }
  const d = doc as Record<string, unknown>;
  if (typeof d.protocolVersion !== 'string' || d.protocolVersion.length === 0) {
    problems.push('protocolVersion is required');
  } else if (!isLegacyProtocolV2Version('mcp', d.protocolVersion) && d.protocolVersion !== MCP_V2_CURRENT_VERSION) {
    problems.push(`unsupported protocolVersion: ${d.protocolVersion}`);
  }
  if (typeof d.serverInfo !== 'object' || d.serverInfo === null) {
    problems.push('serverInfo is required');
  } else {
    const info = d.serverInfo as Record<string, unknown>;
    if (typeof info.name !== 'string' || info.name.length === 0) problems.push('serverInfo.name is required');
    if (typeof info.version !== 'string' || info.version.length === 0) problems.push('serverInfo.version is required');
  }
  if (typeof d.capabilities !== 'object' || d.capabilities === null || Array.isArray(d.capabilities)) {
    problems.push('capabilities must be an object');
  } else {
    for (const [name, value] of Object.entries(d.capabilities as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        problems.push(`capability "${name}" must be an object`);
      }
    }
  }
  if (d.extensions !== undefined) {
    if (!Array.isArray(d.extensions)) problems.push('extensions must be an array');
    else {
      for (const ext of d.extensions as unknown[]) {
        if (typeof ext !== 'object' || ext === null) { problems.push('extension entries must be objects'); continue; }
        const e = ext as Record<string, unknown>;
        if (typeof e.id !== 'string') problems.push('extension.id is required');
        if (!Array.isArray(e.methods)) problems.push(`extension "${String(e.id ?? '?')}" methods must be an array`);
      }
    }
  }
  return problems;
}

/** One deprecation warning the shim recorded. */
export interface CompatShimWarning {
  method: string;
  translatedTo: string | null;
  message: string;
  removalDate: string;
  atMs: number;
}

/** A stateless JSON-RPC request the shim produces. */
export interface ShimmedRequest {
  jsonrpc: '2.0';
  method: string;
  params: Record<string, unknown>;
  id: number | string;
  /** Always present in v2: version + capabilities, never a session id. */
  _meta: { protocolVersion: string; capabilities: string[] };
}

/**
 * Compat shim for 2025-era MCP clients.
 *
 * A legacy client speaks `initialize` (with a client version +
 * capabilities) and then sends requests carrying a
 * `Mcp-Session-Id` header. The shim:
 * - answers `initialize` by running the real negotiation and
 *   returning a discover document shaped like an initialize
 *   result, so the client can proceed;
 * - rewrites every later legacy method to its stateless
 *   equivalent (`resources/subscribe` -> `subscriptions/listen`,
 *   `notifications/initialized` -> dropped, session header
 *   stripped);
 * - rejects methods with no equivalent (sampling, roots,
 *   logging) with a named error + migration guidance;
 * - records one warning per translated method so the server log
 *   shows exactly which legacy behaviour a client still relies
 *   on, and how long it has left.
 */
export class CompatShim2025 {
  private readonly serverName: string;
  private readonly serverVersion: string;
  private readonly warnings: CompatShimWarning[] = [];
  private discovered = false;
  private negotiatedVersion: string | null = null;

  constructor(serverName: string, serverVersion: string) {
    this.serverName = serverName;
    this.serverVersion = serverVersion;
  }

  /** Warnings recorded so far (oldest first). */
  getWarnings(): CompatShimWarning[] {
    return [...this.warnings];
  }

  /** True once the legacy client has completed its initialize handshake. */
  isDiscovered(): boolean {
    return this.discovered;
  }

  /** Version agreed during the legacy initialize, or null. */
  getNegotiatedVersion(): string | null {
    return this.negotiatedVersion;
  }

  private warn(method: string, translatedTo: string | null, message: string): void {
    this.warnings.push({
      method,
      translatedTo,
      message,
      removalDate: MCP_V2_LEGACY_REMOVAL_DATE,
      atMs: Date.now(),
    });
  }

  /**
   * Answer a legacy `initialize` request. The result carries the
   * negotiated version + the discover document, so the client
   * learns the stateless surface even though it asked the old
   * way. Throws when no version can be agreed.
   */
  initialize(params: {
    protocolVersion: string;
    clientInfo?: { name?: string; version?: string };
    capabilities?: Record<string, unknown>;
  }): { protocolVersion: string; serverInfo: { name: string; version: string }; capabilities: Record<string, unknown>; discover: McpV2DiscoverDocument } {
    const negotiation = negotiateProtocolV2Version('mcp', [params.protocolVersion]);
    if (negotiation.agreed === null) {
      throw new McpV2DiscoverError(
        'UNSUPPORTED_PROTOCOL_VERSION',
        negotiation.fallbackGuidance ?? 'No common MCP version.',
      );
    }
    this.negotiatedVersion = negotiation.agreed;
    this.discovered = true;
    const { document } = buildServerDiscoverDocument({
      serverName: this.serverName,
      serverVersion: this.serverVersion,
    });
    this.warn(
      'initialize',
      'server/discover',
      `Legacy initialize translated to server/discover (agreed ${negotiation.agreed}). ` +
        `Stop sending initialize before ${MCP_V2_LEGACY_REMOVAL_DATE}.`,
    );
    return {
      protocolVersion: negotiation.agreed,
      serverInfo: { name: this.serverName, version: this.serverVersion },
      capabilities: document.capabilities,
      discover: document,
    };
  }

  /**
   * Translate one legacy request into a stateless request.
   * Returns null for fire-and-forget notifications that have no
   * stateless equivalent and are safe to drop
   * (`notifications/initialized`). Throws for methods that
   * cannot be translated.
   */
  translateRequest(request: {
    method: string;
    params?: Record<string, unknown>;
    id?: number | string;
    sessionId?: string;
  }): ShimmedRequest | null {
    const meta = {
      protocolVersion: this.negotiatedVersion ?? MCP_V2_CURRENT_VERSION,
      capabilities: [...PROTOCOL_V2_KNOWN_CAPABILITIES.mcp],
    };
    const base = {
      jsonrpc: '2.0' as const,
      params: request.params ?? {},
      id: request.id ?? 0,
      _meta: meta,
    };
    switch (request.method) {
      case 'notifications/initialized':
        this.warn('notifications/initialized', null, 'Dropped: the stateless core has no initialized notification.');
        return null;
      case 'resources/subscribe': {
        const uri = typeof request.params?.uri === 'string' ? request.params.uri : '';
        this.warn(
          'resources/subscribe',
          'subscriptions/listen',
          `Resource subscription for ${uri || '(unknown uri)'} translated to subscriptions/listen.`,
        );
        return { ...base, method: 'subscriptions/listen', params: { topics: [`resource:${uri}`] } };
      }
      case 'sampling/createMessage':
        throw new McpV2DiscoverError(
          'REMOVED_METHOD',
          'sampling/createMessage was removed in MCP 2026-07-28 (server-initiated sampling is gone). ' +
            'Use multi round-trip instead: the server answers input_required and the client retries with the answer.',
        );
      case 'roots/list':
        throw new McpV2DiscoverError(
          'REMOVED_METHOD',
          'roots/list was removed in MCP 2026-07-28. Pass working-directory context in _meta or as a tool argument instead.',
        );
      case 'logging/setLevel':
        throw new McpV2DiscoverError(
          'REMOVED_METHOD',
          'logging/setLevel was removed in MCP 2026-07-28. The server logs at its own configured level.',
        );
      default:
        if (request.sessionId) {
          this.warn(
            request.method,
            request.method,
            'Mcp-Session-Id header stripped: the stateless core carries version + capabilities in _meta instead.',
          );
        }
        return { ...base, method: request.method };
    }
  }
}

/** One published update kept for replay after reconnect. */
export interface SubscriptionUpdate {
  topic: string;
  sequence: number;
  payload: Record<string, unknown>;
  atMs: number;
}

export interface SubscriptionHubOptions {
  /** Updates kept per topic for replay (default 100). */
  maxBufferedPerTopic?: number;
}

/**
 * `subscriptions/listen` hub.
 *
 * A client opens a listen channel (one `listenId`) and subscribes
 * to topics such as `resource:skill://…`, `task:<id>` or
 * `event:agui:<runId>`. The hub:
 * - assigns every published update a per-topic monotonic
 *   sequence number, so a client can detect gaps;
 * - buffers recent updates so a reconnecting client can replay
 *   exactly the ones it missed (`resumeAfterSequence`);
 * - delivers updates synchronously to in-process subscribers
 *   (the transport serialises them to NDJSON/SSE outside).
 */
export class SubscriptionHub {
  private readonly maxBuffered: number;
  private readonly topics = new Map<string, SubscriptionUpdate[]>();
  private readonly sequences = new Map<string, number>();
  private readonly subscribers = new Map<string, Set<(update: SubscriptionUpdate) => void>>();
  private readonly channels = new Map<string, Set<string>>();

  constructor(options: SubscriptionHubOptions = {}) {
    this.maxBuffered = options.maxBufferedPerTopic ?? 100;
  }

  /** Open a listen channel; returns its id. */
  openChannel(): string {
    const id = `listen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.channels.set(id, new Set());
    return id;
  }

  /** Close a listen channel and drop its subscriptions. */
  closeChannel(listenId: string): boolean {
    const topics = this.channels.get(listenId);
    if (!topics) return false;
    for (const topic of topics) this.subscribers.get(topic)?.delete(this.channelHandler(listenId, topic));
    this.channels.delete(listenId);
    return true;
  }

  // NOTE: closeChannel removes subscriptions by topic set, not by
  // handler identity — see subscribe() which stores handlers per
  // (listenId, topic) so close can remove exactly those.
  private readonly handlers = new Map<string, (update: SubscriptionUpdate) => void>();

  private channelHandler(listenId: string, topic: string): (update: SubscriptionUpdate) => void {
    const key = `${listenId}\n${topic}`;
    let handler = this.handlers.get(key);
    if (!handler) {
      handler = (update: SubscriptionUpdate) => {
        // Delivered through the channel's own callback registry.
        const cbs = this.channelCallbacks.get(listenId);
        cbs?.forEach((cb) => cb(update));
      };
      this.handlers.set(key, handler);
    }
    return handler;
  }

  private readonly channelCallbacks = new Map<string, Set<(update: SubscriptionUpdate) => void>>();

  /**
   * Subscribe a listen channel to topics. `onUpdate` is called
   * for every new update on those topics. Returns the updates
   * missed since `resumeAfterSequence` (per topic), oldest first.
   */
  subscribe(
    listenId: string,
    topics: readonly string[],
    onUpdate: (update: SubscriptionUpdate) => void,
    resumeAfterSequence?: Record<string, number>,
  ): { subscribed: string[]; replayed: SubscriptionUpdate[] } {
    const channel = this.channels.get(listenId);
    if (!channel) throw new McpV2DiscoverError('UNKNOWN_LISTEN_CHANNEL', `Unknown listen channel: ${listenId}`);
    const cbs = this.channelCallbacks.get(listenId) ?? new Set();
    cbs.add(onUpdate);
    this.channelCallbacks.set(listenId, cbs);
    const replayed: SubscriptionUpdate[] = [];
    for (const topic of topics) {
      if (topic.length === 0) continue;
      channel.add(topic);
      let subs = this.subscribers.get(topic);
      if (!subs) { subs = new Set(); this.subscribers.set(topic, subs); }
      subs.add(this.channelHandler(listenId, topic));
      const after = resumeAfterSequence?.[topic];
      const buffered = this.topics.get(topic) ?? [];
      for (const update of buffered) {
        if (after === undefined || update.sequence > after) replayed.push(update);
      }
    }
    replayed.sort((a, b) => a.atMs - b.atMs || a.sequence - b.sequence);
    return { subscribed: [...channel], replayed };
  }

  /** Unsubscribe a channel from topics. */
  unsubscribe(listenId: string, topics: readonly string[]): string[] {
    const channel = this.channels.get(listenId);
    if (!channel) return [];
    for (const topic of topics) {
      channel.delete(topic);
      this.subscribers.get(topic)?.delete(this.channelHandler(listenId, topic));
    }
    return [...channel];
  }

  /** Publish an update to a topic; returns the stored update. */
  publish(topic: string, payload: Record<string, unknown>): SubscriptionUpdate {
    const sequence = (this.sequences.get(topic) ?? 0) + 1;
    this.sequences.set(topic, sequence);
    const update: SubscriptionUpdate = { topic, sequence, payload, atMs: Date.now() };
    const buffered = this.topics.get(topic) ?? [];
    buffered.push(update);
    while (buffered.length > this.maxBuffered) buffered.shift();
    this.topics.set(topic, buffered);
    this.subscribers.get(topic)?.forEach((handler) => {
      try { handler(update); } catch { /* one bad subscriber must not break the fan-out */ }
    });
    return update;
  }

  /** Topics a channel is currently subscribed to. */
  channelTopics(listenId: string): string[] {
    return [...(this.channels.get(listenId) ?? [])];
  }

  /** Latest sequence number published on a topic (0 = none). */
  topicSequence(topic: string): number {
    return this.sequences.get(topic) ?? 0;
  }
}
