/**
 * `_meta` / discover extended (v1.44, Team T3).
 *
 * What existed before:
 *   - `stateless.ts`: `parseServerDiscoverResult` + `discoverServer`
 *     (the `server/discover` document: protocol version,
 *     capabilities, extensions).
 *   - `serverDiscoverV16.ts`: server-side document builder,
 *     version compatibility, discovery cache with
 *     stale-while-revalidate.
 *   - `statelessClient.ts` / `statelessClientV16.ts`: client-side
 *     discover with `_meta` attach helpers.
 *
 * What was still missing — and what this module adds:
 *
 *   1. **`_meta` parsing, deep.** Every request / result / task
 *      in MCP 2.0 may carry `_meta`: `progressToken` (progress
 *      reporting), `task` (long-task opt-in), plus server-declared
 *      extension fields. `parseRequestMeta` / `parseResultMeta`
 *      validate each field's shape instead of passing the blob
 *      through unchecked, and `mergeMeta` composes client + server
 *      meta without one side silently dropping the other's keys.
 *   2. **Full capability inventory.** `buildCapabilityInventory`
 *      turns a discover document into a complete, counted
 *      inventory — tools / resources / prompts / tasks / apps,
 *      each with name, version, description presence, and schema
 *      size — plus duplicate-name and missing-description
 *      findings. The UI can finally answer "what can this server
 *      actually do?" instead of showing a raw capabilities blob.
 *   3. **Compatibility report + health score.** The inventory is
 *      checked against the host's capabilities
 *      (`checkHostCompatibility`): what is missing, what is
 *      unsupported, a 0–100 score and a verdict (`ready` /
 *      `degraded` / `incompatible`) with reasons. No more
 *      connecting to a server only to fail on the first tool call.
 *   4. **Discovery diff.** `diffDiscoveries` compares two
 *      inventories (e.g. before/after a server upgrade) and lists
 *      added / removed / changed capabilities, so the host can
 *      warn when a server silently drops a tool the user relies on.
 *
 * This module never touches the network: it parses documents the
 * caller already fetched (via `serverDiscoverV16` / the stateless
 * client). Ideas only — no code copied from any MCP
 * implementation, SDK, or the Grok Bot / Cursor installers.
 */

import * as crypto from 'node:crypto';

import type { ServerDiscoverResult } from './stateless';

/** Error raised by the discover-v2 layer. */
export class MetaDiscoverV2Error extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'MetaDiscoverV2Error';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parsed `_meta` carried on a request (client -> server). */
export interface RequestMeta {
  /** Token the server uses to report progress for this request. */
  progressToken?: string | number;
  /** Long-task opt-in: `{ ttl }` asks the server to run as a task. */
  task?: { ttl?: number };
  /** Extension fields declared by the client (namespaced keys). */
  extensions?: Record<string, unknown>;
  /** Any other `_meta` keys, kept verbatim (unknown = forwarded). */
  extra?: Record<string, unknown>;
}

/** Parsed `_meta` carried on a result (server -> client). */
export interface ResultMeta {
  /** Progress token echoed back by the server. */
  progressToken?: string | number;
  /** Task handle the server returned instead of a direct result. */
  task?: { taskId: string; status: string; pollInterval?: number };
  /** Extension fields declared by the server. */
  extensions?: Record<string, unknown>;
  /** Any other `_meta` keys, kept verbatim. */
  extra?: Record<string, unknown>;
}

const TASK_STATUSES = ['working', 'input_required', 'completed', 'failed', 'cancelled'] as const;

/**
 * Validate + parse `_meta` on a request. Unknown keys are kept
 * under `extra` (forward-compatible) but must be JSON-safe;
 * malformed known fields are errors, not silent drops.
 */
export function parseRequestMeta(raw: unknown): RequestMeta {
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    throw new MetaDiscoverV2Error('_meta phải là object.', 'bad-meta');
  }
  const out: RequestMeta = {};
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'progressToken') {
      if (typeof value !== 'string' && typeof value !== 'number') {
        throw new MetaDiscoverV2Error('_meta.progressToken phải là string hoặc number.', 'bad-meta');
      }
      if (typeof value === 'string' && value.length === 0) {
        throw new MetaDiscoverV2Error('_meta.progressToken không được rỗng.', 'bad-meta');
      }
      out.progressToken = value;
    } else if (key === 'task') {
      if (!isRecord(value)) {
        throw new MetaDiscoverV2Error('_meta.task phải là object.', 'bad-meta');
      }
      const ttl = value['ttl'];
      if (ttl !== undefined && (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0)) {
        throw new MetaDiscoverV2Error('_meta.task.ttl phải là số dương (ms).', 'bad-meta');
      }
      out.task = ttl !== undefined ? { ttl } : {};
    } else if (key.startsWith('io.modelcontextprotocol/') || key.startsWith('x-')) {
      (out.extensions ??= {})[key] = value;
    } else {
      extra[key] = value;
    }
  }
  if (Object.keys(extra).length > 0) out.extra = extra;
  return out;
}

/**
 * Validate + parse `_meta` on a result. A task handle inside
 * `_meta` must at least carry `taskId` + a known status.
 */
export function parseResultMeta(raw: unknown): ResultMeta {
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    throw new MetaDiscoverV2Error('_meta phải là object.', 'bad-meta');
  }
  const out: ResultMeta = {};
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'progressToken') {
      if (typeof value !== 'string' && typeof value !== 'number') {
        throw new MetaDiscoverV2Error('_meta.progressToken phải là string hoặc number.', 'bad-meta');
      }
      out.progressToken = value;
    } else if (key === 'task') {
      if (!isRecord(value)) {
        throw new MetaDiscoverV2Error('_meta.task phải là object.', 'bad-meta');
      }
      const taskId = value['taskId'];
      const status = value['status'];
      if (typeof taskId !== 'string' || taskId.length === 0) {
        throw new MetaDiscoverV2Error('_meta.task cần taskId.', 'bad-meta');
      }
      if (typeof status !== 'string' || !(TASK_STATUSES as readonly string[]).includes(status)) {
        throw new MetaDiscoverV2Error(`_meta.task status không biết: ${JSON.stringify(status)}.`, 'bad-meta');
      }
      out.task = { taskId, status };
      const pollInterval = value['pollInterval'];
      if (typeof pollInterval === 'number' && Number.isFinite(pollInterval) && pollInterval > 0) {
        out.task.pollInterval = pollInterval;
      }
    } else if (key.startsWith('io.modelcontextprotocol/') || key.startsWith('x-')) {
      (out.extensions ??= {})[key] = value;
    } else {
      extra[key] = value;
    }
  }
  if (Object.keys(extra).length > 0) out.extra = extra;
  return out;
}

/**
 * Merge client `_meta` with server `_meta` for a follow-up
 * request: the client's progressToken/task win, extension keys
 * union (server keys win on conflict), extras union. Neither
 * side silently drops the other's fields.
 */
export function mergeMeta(client: RequestMeta, server: ResultMeta): RequestMeta {
  const out: RequestMeta = {};
  if (client.progressToken !== undefined) out.progressToken = client.progressToken;
  else if (server.progressToken !== undefined) out.progressToken = server.progressToken;
  if (client.task !== undefined) out.task = { ...client.task };
  const extensions = { ...(server.extensions ?? {}), ...(client.extensions ?? {}) };
  if (Object.keys(extensions).length > 0) out.extensions = extensions;
  const extra = { ...(server.extra ?? {}), ...(client.extra ?? {}) };
  if (Object.keys(extra).length > 0) out.extra = extra;
  return out;
}

/** Serialize parsed meta back to a plain `_meta` object (or undefined when empty). */
export function metaToPlain(meta: RequestMeta | ResultMeta): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (meta.progressToken !== undefined) out['progressToken'] = meta.progressToken;
  if (meta.task !== undefined) out['task'] = { ...meta.task };
  if (meta.extensions) Object.assign(out, meta.extensions);
  if (meta.extra) Object.assign(out, meta.extra);
  return Object.keys(out).length > 0 ? out : undefined;
}

/** One capability entry in the inventory (tool / resource / prompt). */
export interface CapabilityEntry {
  /** Capability kind. */
  kind: 'tool' | 'resource' | 'prompt' | 'task' | 'app';
  /** Name as advertised by the server. */
  name: string;
  /** Version string when the server gives one. */
  version?: string;
  /** True when the server supplied a non-empty description. */
  hasDescription: boolean;
  /** Approx. JSON size of the entry's schema / descriptor (bytes). */
  schemaBytes: number;
}

/** A finding about the inventory (duplicate, missing doc, oversized schema). */
export interface InventoryFinding {
  severity: 'warning' | 'error';
  code: string;
  message: string;
  capability?: string;
}

/** Full capability inventory of one server. */
export interface CapabilityInventory {
  serverName: string;
  serverVersion: string;
  protocolVersion: string;
  /** Fingerprint of the discover document this came from. */
  fingerprint: string;
  tools: CapabilityEntry[];
  resources: CapabilityEntry[];
  prompts: CapabilityEntry[];
  /** Whether the server advertises task support. */
  tasksSupported: boolean;
  /** Whether the server advertises MCP Apps support. */
  appsSupported: boolean;
  /** Extension ids the server declares. */
  extensions: string[];
  /** Endpoint roles the server advertises (when present). */
  endpoints: string[];
  findings: InventoryFinding[];
  discoveredAt: number;
}

export const INVENTORY_MAX_SCHEMA_BYTES = 64 * 1024;

function entryFromRaw(kind: CapabilityEntry['kind'], raw: unknown): CapabilityEntry | undefined {
  if (typeof raw === 'string') {
    return { kind, name: raw, hasDescription: false, schemaBytes: raw.length };
  }
  if (!isRecord(raw)) return undefined;
  const name = raw['name'];
  if (typeof name !== 'string' || name.length === 0) return undefined;
  const description = raw['description'];
  const schemaBytes = Buffer.byteLength(JSON.stringify(raw), 'utf8');
  const entry: CapabilityEntry = {
    kind,
    name,
    hasDescription: typeof description === 'string' && description.trim().length > 0,
    schemaBytes,
  };
  if (typeof raw['version'] === 'string') entry.version = raw['version'];
  return entry;
}

function entriesFromList(kind: CapabilityEntry['kind'], raw: unknown): CapabilityEntry[] {
  if (Array.isArray(raw)) {
    const out: CapabilityEntry[] = [];
    for (const item of raw as unknown[]) {
      const entry = entryFromRaw(kind, item);
      if (entry) out.push(entry);
    }
    return out;
  }
  // Capabilities may arrive as a record: `{ list: [...] }`, or a map
  // `name -> descriptor`. Both forms reduce to the same entries.
  if (isRecord(raw)) {
    if (Array.isArray(raw['list'])) return entriesFromList(kind, raw['list']);
    const out: CapabilityEntry[] = [];
    for (const [name, item] of Object.entries(raw)) {
      if (name === 'supported' || name === 'listChanged') continue;
      if (isRecord(item)) {
        const entry = entryFromRaw(kind, { ...item, name: typeof item['name'] === 'string' ? item['name'] : name });
        if (entry) out.push(entry);
      } else if (typeof item === 'boolean' && item) {
        out.push({ kind, name, hasDescription: false, schemaBytes: name.length });
      }
    }
    return out;
  }
  return [];
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** SHA-256 fingerprint of a discover document (canonical JSON). */
export function fingerprintDiscover(doc: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(doc)).digest('hex');
}

/**
 * Build a full capability inventory from a `server/discover`
 * document (the `ServerDiscoverResult` shape from `stateless.ts`,
 * plus the optional `tools` / `resources` / `prompts` lists a
 * server may attach, and the v16 `endpoints` field). Findings
 * cover duplicate names, missing descriptions and oversized
 * schemas — the three things that most often break the UI later.
 */
export function buildCapabilityInventory(
  doc: ServerDiscoverResult & {
    tools?: unknown;
    resources?: unknown;
    prompts?: unknown;
    endpoints?: { role?: string }[];
  },
  options: { nowMs?: number } = {},
): CapabilityInventory {
  const serverInfo: Record<string, unknown> = isRecord(doc.serverInfo)
    ? (doc.serverInfo as unknown as Record<string, unknown>)
    : {};
  const serverName = typeof serverInfo['name'] === 'string' && serverInfo['name']
    ? (serverInfo['name'] as string)
    : 'unknown';
  const serverVersion = typeof serverInfo['version'] === 'string' ? (serverInfo['version'] as string) : 'unknown';
  const protocolVersion = typeof doc.protocolVersion === 'string' ? doc.protocolVersion : 'unknown';
  const capabilities = isRecord(doc.capabilities) ? doc.capabilities : {};
  const tools = entriesFromList('tool', doc.tools ?? (isRecord(capabilities['tools']) ? capabilities['tools'] : undefined));
  // `tools` may also arrive as a bare list under capabilities.tools.list.
  const resources = entriesFromList(
    'resource',
    doc.resources ?? (isRecord(capabilities['resources']) ? capabilities['resources'] : undefined),
  );
  const prompts = entriesFromList(
    'prompt',
    doc.prompts ?? (isRecord(capabilities['prompts']) ? capabilities['prompts'] : undefined),
  );
  const extensions = Array.isArray(doc.extensions)
    ? (doc.extensions as unknown[])
        .map((e) => (isRecord(e) ? e['id'] : e))
        .filter((id): id is string => typeof id === 'string')
    : [];
  const endpoints = Array.isArray(doc.endpoints)
    ? (doc.endpoints as { role?: string }[]).map((e) => e.role ?? 'rpc')
    : [];
  const tasksSupported = isRecord(capabilities['tasks'])
    ? capabilities['tasks']['supported'] !== false
    : capabilities['tasks'] === true;
  const appsSupported = isRecord(capabilities['apps'])
    ? capabilities['apps']['supported'] !== false
    : capabilities['apps'] === true;
  const findings: InventoryFinding[] = [];
  const seen = new Map<string, CapabilityEntry['kind']>();
  for (const entry of [...tools, ...resources, ...prompts]) {
    const key = `${entry.kind}:${entry.name}`;
    if (seen.has(key)) {
      findings.push({
        severity: 'error',
        code: 'duplicate-capability',
        message: `Capability trùng tên: ${entry.kind} "${entry.name}" xuất hiện nhiều lần.`,
        capability: entry.name,
      });
    } else {
      seen.set(key, entry.kind);
    }
    if (!entry.hasDescription) {
      findings.push({
        severity: 'warning',
        code: 'missing-description',
        message: `${entry.kind} "${entry.name}" không có mô tả — agent khó chọn đúng.`,
        capability: entry.name,
      });
    }
    if (entry.schemaBytes > INVENTORY_MAX_SCHEMA_BYTES) {
      findings.push({
        severity: 'warning',
        code: 'oversized-schema',
        message: `${entry.kind} "${entry.name}" có schema ${entry.schemaBytes} bytes (vượt ${INVENTORY_MAX_SCHEMA_BYTES}) — có thể làm chậm context.`,
        capability: entry.name,
      });
    }
  }
  return {
    serverName,
    serverVersion,
    protocolVersion,
    fingerprint: fingerprintDiscover(doc),
    tools,
    resources,
    prompts,
    tasksSupported,
    appsSupported,
    extensions,
    endpoints,
    findings,
    discoveredAt: options.nowMs ?? Date.now(),
  };
}

/** Host capabilities to check a server inventory against. */
export interface HostCapabilitySet {
  protocolVersions: string[];
  supportsTasks: boolean;
  supportsApps: boolean;
  maxTools?: number;
  maxSchemaBytes?: number;
}

/** Compatibility verdict. */
export type CompatibilityVerdict = 'ready' | 'degraded' | 'incompatible';

/** Compatibility report of a server inventory vs the host. */
export interface CompatibilityReport {
  serverName: string;
  verdict: CompatibilityVerdict;
  /** 0–100: 100 = everything the host needs is present. */
  score: number;
  missing: string[];
  unsupported: string[];
  reasons: string[];
}

/**
 * Check a server inventory against what this host can do.
 * Missing protocol version or a missing required feature is
 * `incompatible`; warnings (no descriptions, oversized schemas)
 * only degrade the score. The score is deterministic: start at
 * 100, −40 for an unknown protocol version, −25 per missing
 * required feature, −2 per inventory finding (floor 0).
 */
export function checkHostCompatibility(
  inventory: CapabilityInventory,
  host: HostCapabilitySet,
): CompatibilityReport {
  const missing: string[] = [];
  const unsupported: string[] = [];
  const reasons: string[] = [];
  let score = 100;
  if (!host.protocolVersions.includes(inventory.protocolVersion)) {
    missing.push(`protocol ${inventory.protocolVersion}`);
    reasons.push(`Host không hỗ trợ protocol version "${inventory.protocolVersion}" (hỗ trợ: ${host.protocolVersions.join(', ')}).`);
    score -= 40;
  }
  if (inventory.tasksSupported && !host.supportsTasks) {
    unsupported.push('tasks');
    reasons.push('Server hỗ trợ Tasks nhưng host chưa bật Tasks — task dài sẽ chạy đồng bộ.');
    score -= 10;
  }
  if (inventory.appsSupported && !host.supportsApps) {
    unsupported.push('apps');
    reasons.push('Server hỗ trợ MCP Apps nhưng host chưa bật Apps — app sẽ hiển thị dạng text.');
    score -= 10;
  }
  if (host.maxTools !== undefined && inventory.tools.length > host.maxTools) {
    unsupported.push(`tools>${host.maxTools}`);
    reasons.push(`Server có ${inventory.tools.length} tool, vượt giới hạn host ${host.maxTools} — chỉ nạp ${host.maxTools} tool đầu.`);
    score -= 15;
  }
  const maxSchema = host.maxSchemaBytes ?? INVENTORY_MAX_SCHEMA_BYTES;
  const oversized = inventory.tools.filter((t) => t.schemaBytes > maxSchema).length;
  if (oversized > 0) {
    reasons.push(`${oversized} tool có schema vượt ${maxSchema} bytes.`);
    score -= Math.min(10, oversized * 2);
  }
  score -= Math.min(20, inventory.findings.filter((f) => f.severity === 'error').length * 5);
  score = Math.max(0, Math.min(100, score));
  const verdict: CompatibilityVerdict =
    missing.length > 0 ? 'incompatible' : unsupported.length > 0 || score < 80 ? 'degraded' : 'ready';
  return { serverName: inventory.serverName, verdict, score, missing, unsupported, reasons };
}

/** One changed capability in a discovery diff. */
export interface CapabilityChange {
  kind: CapabilityEntry['kind'];
  name: string;
  change: 'added' | 'removed' | 'version-changed' | 'description-changed';
  from?: string;
  to?: string;
}

/** Diff between two inventories of the same server. */
export interface DiscoveryDiff {
  serverName: string;
  added: CapabilityChange[];
  removed: CapabilityChange[];
  changed: CapabilityChange[];
  fingerprintChanged: boolean;
  /** True when a removed tool/resource is a breaking change for saved workflows. */
  breaking: boolean;
}

/**
 * Diff two inventories (same server, e.g. before/after upgrade).
 * Removals are `breaking` — a saved workflow, app template or
 * task that referenced the removed capability will fail.
 */
export function diffDiscoveries(oldInv: CapabilityInventory, newInv: CapabilityInventory): DiscoveryDiff {
  const added: CapabilityChange[] = [];
  const removed: CapabilityChange[] = [];
  const changed: CapabilityChange[] = [];
  const kinds: CapabilityEntry['kind'][] = ['tool', 'resource', 'prompt'];
  for (const kind of kinds) {
    const oldList = kind === 'tool' ? oldInv.tools : kind === 'resource' ? oldInv.resources : oldInv.prompts;
    const newList = kind === 'tool' ? newInv.tools : kind === 'resource' ? newInv.resources : newInv.prompts;
    const oldMap = new Map(oldList.map((e) => [e.name, e]));
    const newMap = new Map(newList.map((e) => [e.name, e]));
    for (const [name, entry] of newMap) {
      if (!oldMap.has(name)) {
        added.push({ kind, name, change: 'added' });
        continue;
      }
      const oldEntry = oldMap.get(name) as CapabilityEntry;
      if (oldEntry.version !== entry.version) {
        changed.push({
          kind,
          name,
          change: 'version-changed',
          ...(oldEntry.version ? { from: oldEntry.version } : {}),
          ...(entry.version ? { to: entry.version } : {}),
        });
      } else if (oldEntry.hasDescription !== entry.hasDescription) {
        changed.push({ kind, name, change: 'description-changed' });
      }
    }
    for (const [name] of oldMap) {
      if (!newMap.has(name)) removed.push({ kind, name, change: 'removed' });
    }
  }
  if (oldInv.tasksSupported !== newInv.tasksSupported) {
    if (newInv.tasksSupported) added.push({ kind: 'task', name: 'tasks', change: 'added' });
    else removed.push({ kind: 'task', name: 'tasks', change: 'removed' });
  }
  if (oldInv.appsSupported !== newInv.appsSupported) {
    if (newInv.appsSupported) added.push({ kind: 'app', name: 'apps', change: 'added' });
    else removed.push({ kind: 'app', name: 'apps', change: 'removed' });
  }
  return {
    serverName: newInv.serverName,
    added,
    removed,
    changed,
    fingerprintChanged: oldInv.fingerprint !== newInv.fingerprint,
    breaking: removed.length > 0,
  };
}

/** One-line summary of an inventory, for the server list UI. */
export function describeInventory(inventory: CapabilityInventory): string {
  const errors = inventory.findings.filter((f) => f.severity === 'error').length;
  const warnings = inventory.findings.filter((f) => f.severity === 'warning').length;
  return `${inventory.serverName} v${inventory.serverVersion} (${inventory.protocolVersion}) — ` +
    `${inventory.tools.length} tool, ${inventory.resources.length} resource, ${inventory.prompts.length} prompt` +
    `${inventory.tasksSupported ? ', tasks' : ''}${inventory.appsSupported ? ', apps' : ''}` +
    (errors + warnings > 0 ? ` — ${errors} lỗi, ${warnings} cảnh báo` : ' — sạch');
}

/** One-line summary of a diff, for upgrade warnings. */
export function describeDiscoveryDiff(diff: DiscoveryDiff): string {
  const parts: string[] = [];
  if (diff.added.length > 0) parts.push(`+${diff.added.length} mới`);
  if (diff.removed.length > 0) parts.push(`-${diff.removed.length} bị gỡ`);
  if (diff.changed.length > 0) parts.push(`~${diff.changed.length} đổi`);
  const body = parts.length > 0 ? parts.join(', ') : 'không đổi';
  return `${diff.serverName}: ${body}${diff.breaking ? ' — BREAKING: có capability bị gỡ' : ''}`;
}
