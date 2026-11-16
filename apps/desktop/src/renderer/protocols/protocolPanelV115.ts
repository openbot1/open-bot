/**
 * Protocol panel view models (v1.15, Team T2 — protocol triad).
 *
 * Renderer-local mirror of the core protocol shapes (the
 * BudgetMeter pattern): the renderer must NOT value-import from
 * `@open-bot/core` — the core bundles are CJS and vite inlines
 * them verbatim, which throws `ReferenceError: exports is not
 * defined` at startup and leaves a blank screen. This module
 * owns the view contract instead: defensive parsing of the IPC
 * payloads (`protocols:*` returns plain JSON), run rows, pending
 * interrupt rows, surface rows, signed-card rows and MCP server
 * rows. Pure functions, no React, no DOM, no IPC — unit-tested
 * with plain node --test (see tests/protocols-v115.test.mjs).
 *
 * The data source is the core protocol layer in
 * packages/core/src/protocols/ (AG-UI 1.0 stream, interrupt
 * manager, A2UI surface registry, A2A signed cards, stateless
 * MCP client). Until the coordinator wires the real IPC
 * channels, every view carries `source: 'local'` so the UI can
 * label it honestly.
 */

/** Run status shown in the panel. */
export type ProtocolRunStatusView = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

/** One AG-UI run row. */
export interface ProtocolRunRowView {
  runId: string;
  status: ProtocolRunStatusView;
  eventCount: number;
  lastEventType: string | null;
  startedAt: string | null;
  /** "provider/model: 1,234 tokens" or null when no usage yet. */
  usageLabel: string | null;
  /** Pending interrupts on this run. */
  pendingInterrupts: number;
  /** Pending surfaces on this run. */
  pendingSurfaces: number;
}

/** One pending interrupt row. */
export interface ProtocolInterruptRowView {
  interruptId: string;
  runId: string;
  kind: 'approval' | 'form' | 'choice';
  title: string;
  detail: string | null;
  /** Milliseconds left before auto-cancel, or null when unknown. */
  msLeft: number | null;
  /** True when the interrupt is about to time out (< 60s left). */
  urgent: boolean;
}

/** One A2UI surface row. */
export interface ProtocolSurfaceRowView {
  componentId: string;
  runId: string;
  kind: string;
  title: string;
  status: 'pending' | 'answered' | 'dismissed' | 'expired';
  blocking: boolean;
}

/** One signed A2A card row. */
export interface ProtocolCardRowView {
  name: string;
  url: string;
  protocolVersion: string;
  /** Signature trust model — always internal-hmac in v1.15. */
  trust: string;
  keyId: string;
  /** True when the card's signature verified against the local key. */
  verified: boolean | null;
  bindings: string[];
}

/** One MCP server row (stateless 2026-07-28). */
export interface ProtocolMcpServerRowView {
  name: string;
  endpoint: string;
  protocolVersion: string;
  /** True when server/discover answered. */
  discovered: boolean;
  /** True when the server still needs the legacy adapter. */
  legacy: boolean;
  tools: number;
  tasks: number;
}

/** Whole-panel view. */
export interface ProtocolPanelView {
  runs: ProtocolRunRowView[];
  interrupts: ProtocolInterruptRowView[];
  surfaces: ProtocolSurfaceRowView[];
  cards: ProtocolCardRowView[];
  mcpServers: ProtocolMcpServerRowView[];
  summary: {
    runsActive: number;
    interruptsPending: number;
    surfacesPending: number;
    cardsVerified: number;
    mcpDiscovered: number;
    mcpLegacy: number;
  };
  source: string;
}

/** Raw run payload as it arrives over IPC (defensive parsing). */
export interface ProtocolRunPayload {
  runId?: unknown;
  status?: unknown;
  eventCount?: unknown;
  lastEventType?: unknown;
  startedAt?: unknown;
  usage?: unknown;
  pendingInterrupts?: unknown;
  pendingSurfaces?: unknown;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function asNonNegativeInt(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function asRunStatus(value: unknown): ProtocolRunStatusView {
  if (
    value === 'running' || value === 'paused' || value === 'completed' ||
    value === 'failed' || value === 'cancelled'
  ) {
    return value;
  }
  return 'running';
}

/** Format token usage as "provider/model: 1,234 tokens". */
export function formatProtocolUsage(usage: unknown): string | null {
  if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) return null;
  const record = usage as Record<string, unknown>;
  const provider = asNonEmptyString(record['provider']);
  const model = asNonEmptyString(record['model']);
  const total = record['totalTokens'];
  if (provider === null || model === null) return null;
  if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) return null;
  return `${provider}/${model}: ${Math.floor(total).toLocaleString('en-US')} tokens`;
}

/** Build one run row from a defensive IPC payload; null when unusable. */
export function protocolRunRowFromPayload(payload: unknown): ProtocolRunRowView | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const record = payload as ProtocolRunPayload;
  const runId = asNonEmptyString(record['runId']);
  if (runId === null) return null;
  return {
    runId,
    status: asRunStatus(record['status']),
    eventCount: asNonNegativeInt(record['eventCount']),
    lastEventType: asNonEmptyString(record['lastEventType']),
    startedAt: asNonEmptyString(record['startedAt']),
    usageLabel: formatProtocolUsage(record['usage']),
    pendingInterrupts: asNonNegativeInt(record['pendingInterrupts']),
    pendingSurfaces: asNonNegativeInt(record['pendingSurfaces']),
  };
}

/** Build one interrupt row; null when the payload is unusable. */
export function protocolInterruptRowFromPayload(payload: unknown, nowMs: number): ProtocolInterruptRowView | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const interruptId = asNonEmptyString(record['id']);
  const runId = asNonEmptyString(record['runId']);
  const title = asNonEmptyString(record['title']);
  if (interruptId === null || runId === null || title === null) return null;
  const kind = record['kind'];
  if (kind !== 'approval' && kind !== 'form' && kind !== 'choice') return null;
  const payloadRecord = (record['payload'] as Record<string, unknown> | undefined) ?? record;
  const createdAt = typeof payloadRecord['createdAt'] === 'string' ? Date.parse(payloadRecord['createdAt'] as string) : NaN;
  const timeoutMs = typeof payloadRecord['timeoutMs'] === 'number'
    ? (payloadRecord['timeoutMs'] as number)
    : (typeof (record['payload'] as Record<string, unknown> | undefined)?.['timeoutMs'] === 'number'
      ? ((record['payload'] as Record<string, unknown>)['timeoutMs'] as number)
      : null);
  let msLeft: number | null = null;
  if (timeoutMs !== null && !Number.isNaN(createdAt)) {
    msLeft = Math.max(0, createdAt + timeoutMs - nowMs);
  }
  return {
    interruptId,
    runId,
    kind,
    title,
    detail: asNonEmptyString(record['detail'] ?? payloadRecord['detail']),
    msLeft,
    urgent: msLeft !== null && msLeft < 60_000,
  };
}

/** Build one surface row; null when the payload is unusable. */
export function protocolSurfaceRowFromPayload(payload: unknown): ProtocolSurfaceRowView | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const spec = (record['spec'] as Record<string, unknown> | undefined) ?? record;
  const componentId = asNonEmptyString(spec['componentId']);
  const runId = asNonEmptyString(spec['runId']);
  const kind = asNonEmptyString(spec['kind']);
  const title = asNonEmptyString(spec['title']);
  if (componentId === null || runId === null || kind === null || title === null) return null;
  const status = record['status'];
  if (status !== 'pending' && status !== 'answered' && status !== 'dismissed' && status !== 'expired') {
    return null;
  }
  return {
    componentId,
    runId,
    kind,
    title,
    status,
    blocking: spec['blocking'] === true,
  };
}

/** Build one signed-card row; null when the payload is unusable. */
export function protocolCardRowFromPayload(payload: unknown): ProtocolCardRowView | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const card = record['card'] as Record<string, unknown> | undefined;
  const signature = record['signature'] as Record<string, unknown> | undefined;
  if (!card || typeof card !== 'object' || !signature || typeof signature !== 'object') return null;
  const name = asNonEmptyString(card['name']);
  const url = asNonEmptyString(card['url']);
  if (name === null || url === null) return null;
  const bindings = Array.isArray(card['supportedInterfaces'])
    ? (card['supportedInterfaces'] as Array<Record<string, unknown>>)
      .map((i) => asNonEmptyString(i['protocolBinding']))
      .filter((b): b is string => b !== null)
    : [];
  return {
    name,
    url,
    protocolVersion: asNonEmptyString(card['protocolVersion']) ?? '1.0',
    trust: asNonEmptyString(signature['trust']) ?? 'unknown',
    keyId: asNonEmptyString(signature['keyId']) ?? 'unknown',
    verified: typeof record['verified'] === 'boolean' ? (record['verified'] as boolean) : null,
    bindings,
  };
}

/** Build one MCP server row; null when the payload is unusable. */
export function protocolMcpServerRowFromPayload(payload: unknown): ProtocolMcpServerRowView | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const name = asNonEmptyString(record['name']);
  const endpoint = asNonEmptyString(record['endpoint']);
  if (name === null || endpoint === null) return null;
  return {
    name,
    endpoint,
    protocolVersion: asNonEmptyString(record['protocolVersion']) ?? '2026-07-28',
    discovered: record['discovered'] === true,
    legacy: record['legacy'] === true,
    tools: asNonNegativeInt(record['tools']),
    tasks: asNonNegativeInt(record['tasks']),
  };
}

/** Raw panel payload as it arrives over IPC. */
export interface ProtocolPanelPayload {
  runs?: unknown;
  interrupts?: unknown;
  surfaces?: unknown;
  cards?: unknown;
  mcpServers?: unknown;
}

/** Build the whole panel view from a defensive IPC payload. */
export function buildProtocolPanelView(payload: unknown, nowMs = Date.now()): ProtocolPanelView {
  const record = (typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? payload
    : {}) as ProtocolPanelPayload;
  const runs = (Array.isArray(record['runs']) ? record['runs'] : [])
    .map((r) => protocolRunRowFromPayload(r))
    .filter((r): r is ProtocolRunRowView => r !== null);
  const interrupts = (Array.isArray(record['interrupts']) ? record['interrupts'] : [])
    .map((i) => protocolInterruptRowFromPayload(i, nowMs))
    .filter((i): i is ProtocolInterruptRowView => i !== null);
  const surfaces = (Array.isArray(record['surfaces']) ? record['surfaces'] : [])
    .map((s) => protocolSurfaceRowFromPayload(s))
    .filter((s): s is ProtocolSurfaceRowView => s !== null);
  const cards = (Array.isArray(record['cards']) ? record['cards'] : [])
    .map((c) => protocolCardRowFromPayload(c))
    .filter((c): c is ProtocolCardRowView => c !== null);
  const mcpServers = (Array.isArray(record['mcpServers']) ? record['mcpServers'] : [])
    .map((m) => protocolMcpServerRowFromPayload(m))
    .filter((m): m is ProtocolMcpServerRowView => m !== null);
  return {
    runs,
    interrupts,
    surfaces,
    cards,
    mcpServers,
    summary: {
      runsActive: runs.filter((r) => r.status === 'running' || r.status === 'paused').length,
      interruptsPending: interrupts.length,
      surfacesPending: surfaces.filter((s) => s.status === 'pending').length,
      cardsVerified: cards.filter((c) => c.verified === true).length,
      mcpDiscovered: mcpServers.filter((m) => m.discovered).length,
      mcpLegacy: mcpServers.filter((m) => m.legacy).length,
    },
    source: 'local',
  };
}
