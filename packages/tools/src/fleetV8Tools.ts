/**
 * Fleet v8 + Composio v111 tools (v1.11, Đội T6) — registered in
 * ALL_TOOLS (see tools.ts).
 *
 * Fleet v8 (6):
 * - `fleet_node_probe` — probe tài nguyên thật của máy local (CPU
 *   cores, load 1m, RAM, đĩa) bằng node:os/statfs. Không ghi file,
 *   không cần baseDir — chạy được ngay cả khi chưa bind.
 * - `fleet_node_health` — đánh giá sức khoẻ một node từ số liệu
 *   probe/heartbeat (healthy/degraded/unhealthy/down + từng check).
 *   Hàm thuần — chạy được ngay cả khi chưa bind.
 * - `fleet_node_rebalance` — kế hoạch dry-run chuyển bot khỏi node
 *   down/unhealthy/draining/quá tải sang node khoẻ còn chỗ. Hàm
 *   thuần — chạy được ngay cả khi chưa bind.
 * - `fleet_dashboard` — snapshot dashboard v8: node v8 + bot v6 có
 *   vấn đề + campaign v7 đang chạy + incident v8 mới nhất. Cần bind
 *   (`createFleetV8Tools(getBaseDir)` với userData dir của app).
 * - `fleet_incident_list` — liệt kê incident log v8 (mới nhất
 *   trước, lọc theo kind/node). Cần bind. Chỉ đọc.
 * - `fleet_incident_record` — ghi một incident v8 vào JSONL (cần
 *   approval). Cần bind.
 *
 * Composio v111 (5):
 * - `composio_mock_toolkit_list_v111` — liệt kê 6 toolkit Composio
 *   MOCK v111 (sentry/datadog/posthog/snowflake/amplitude/mixpanel)
 *   + slug ứng viên. Chạy được ngay, không cần key.
 * - `composio_mock_toolkit_execute_v111` — chạy một tool mock bằng
 *   dữ liệu mẫu local (không gọi mạng, không cần key). Response luôn
 *   mang `mock: true, live: false`.
 * - `composio_connection_list` — liệt kê vòng đời connection từng
 *   toolkit (active/initiated/disconnected/reconnecting/failed) +
 *   tóm tắt. Cần bind (đọc `<userData>/composio/`).
 * - `composio_connection_disconnect` — user ngắt một connection
 *   (không tự nối lại). Cần bind + approval. Chỉ ghi trạng thái
 *   local — việc gọi API Composio thật do host làm.
 * - `composio_connection_reconnect` — user nối lại một connection
 *   (ghi lần thử + quyết định auto-reconnect). Cần bind + approval.
 * - `composio_poll_policy` — tính interval poll kế tiếp (adaptive:
 *   trúng rút lại, trượt/lỗi giãn ra) + tóm tắt catch-up (số lần
 *   poll đã lỡ). Hàm thuần — chạy được ngay cả khi chưa bind.
 *
 * Provider mới (1):
 * - `provider_sambanova_models` — thông tin provider SambaNova mới
 *   (baseUrl, model mặc định, danh sách model fallback, Vault
 *   namespace). Không gọi mạng — model live lấy qua listModels()
 *   của provider khi có key.
 *
 * Như các tool fleet trước, 5 tool cần file là placeholder trong
 * ALL_TOOLS cho tới khi host bind: `createFleetV8Tools(getBaseDir)`
 * với userData dir của app. 8 tool còn lại là hàm thuần — chạy được
 * ngay cả khi chưa bind. Tool ghi file cần approval; tool chỉ đọc
 * thì không.
 */

import * as path from 'node:path';
import type { Tool } from '@open-bot/core';
import {
  COMPOSIO_V111_MOCK_TOOLKITS,
  MockComposioV111Executor,
  SAMBANOVA_BASE_URL,
  SAMBANOVA_DEFAULT_MODEL,
  SAMBANOVA_KNOWN_MODELS,
  appendComposioV111Audit,
  appendFleetV8Incident,
  buildFleetV8Dashboard,
  checkFleetV8NodeHealth,
  createComposioV111AuditEntry,
  createFleetV8Incident,
  decideComposioV111AutoReconnect,
  disconnectComposioV111Connection,
  emptyComposioV111ConnectionEntry,
  emptyComposioV111PollPolicyState,
  isComposioV111ManagedToolkit,
  listComposioV111Audit,
  listFleetV8Incidents,
  loadComposioV111Connections,
  mockComposioV111ToolNeedsApproval,
  missedPollsBetween,
  nextComposioV111Poll,
  planFleetV8Rebalance,
  probeFleetV8LocalNode,
  reconnectComposioV111Connection,
  saveComposioV111Connections,
  summarizeComposioV111CatchUp,
  summarizeComposioV111Connections,
  summarizeComposioV111PollState,
  summarizeFleetV8Dashboard,
  type ComposioV111LifecycleStatus,
  type ComposioV111PollOutcome,
  type ComposioV111PollPolicyState,
  type FleetV8IncidentKind,
  type FleetV8NodeHealthStatus,
  type FleetV8RebalanceBot,
  type FleetV8RebalanceNode,
} from '@open-bot/core';

export const FLEET_V8_TOOL_NAMES = [
  'fleet_node_probe',
  'fleet_node_health',
  'fleet_node_rebalance',
  'fleet_dashboard',
  'fleet_incident_list',
  'fleet_incident_record',
  'composio_mock_toolkit_list_v111',
  'composio_mock_toolkit_execute_v111',
  'composio_connection_list',
  'composio_connection_disconnect',
  'composio_connection_reconnect',
  'composio_poll_policy',
  'provider_sambanova_models',
] as const;

export function isFleetV8ToolName(name: string): boolean {
  return (FLEET_V8_TOOL_NAMES as readonly string[]).includes(name);
}

function toolDef(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Tool['definition'] {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  };
}

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function okResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getNumberArg(args: Record<string, unknown>, name: string, fallback: number): number {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a number.`);
  }
  return value;
}

function getNullableNumberArg(args: Record<string, unknown>, name: string): number | null {
  const value = args[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a number or null.`);
  }
  return value;
}

function getObjectArrayArg(args: Record<string, unknown>, name: string, required = false): Record<string, unknown>[] {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return [];
  }
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'object' || v === null || Array.isArray(v))) {
    throw new Error(`Argument "${name}" must be an array of objects.`);
  }
  return [...(value as Record<string, unknown>[])];
}

function getStringArrayArg(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings.`);
  }
  return [...(value as string[])];
}

const NOT_WIRED =
  'fleet v8 tools are not wired in this host (no userData dir configured) — open the fleet console UI instead.';

/** Fleet root + Composio dir derived from the app userData dir. */
function dirs(baseDir: string): { fleetRoot: string; composioDir: string } {
  return { fleetRoot: path.join(baseDir, 'fleet'), composioDir: path.join(baseDir, 'composio') };
}

const FLEET_V8_INCIDENT_KINDS: FleetV8IncidentKind[] = [
  'node-down',
  'node-degraded',
  'node-recovered',
  'node-evacuated',
  'bot-restart',
  'bot-restart-exhausted',
  'rebalance',
];

function parseRebalanceNodes(args: Record<string, unknown>): FleetV8RebalanceNode[] {
  const raw = getObjectArrayArg(args, 'nodes', true);
  if (raw.length === 0) throw new Error('Argument "nodes" must be a non-empty array.');
  return raw.map((entry, i) => {
    const nodeId = entry['nodeId'];
    if (typeof nodeId !== 'string' || nodeId.trim() === '') {
      throw new Error(`nodes[${i}].nodeId must be a non-empty string.`);
    }
    const status = entry['status'];
    if (typeof status !== 'string' || !(['healthy', 'degraded', 'unhealthy', 'down'] as readonly string[]).includes(status)) {
      throw new Error(`nodes[${i}].status must be one of: healthy, degraded, unhealthy, down.`);
    }
    const maxBots = entry['maxBots'];
    if (maxBots !== undefined && maxBots !== null && (typeof maxBots !== 'number' || !Number.isInteger(maxBots) || maxBots < 0)) {
      throw new Error(`nodes[${i}].maxBots must be null or a non-negative integer.`);
    }
    const freeFraction = entry['freeFraction'];
    if (freeFraction !== undefined && freeFraction !== null && (typeof freeFraction !== 'number' || freeFraction < 0 || freeFraction > 1)) {
      throw new Error(`nodes[${i}].freeFraction must be null or a number in 0..1.`);
    }
    return {
      nodeId: nodeId.trim(),
      status: status as FleetV8NodeHealthStatus,
      loopback: entry['loopback'] === true,
      maxBots: (maxBots ?? null) as number | null,
      freeFraction: (freeFraction ?? null) as number | null,
      draining: entry['draining'] === true,
    };
  });
}

function parseRebalanceBots(args: Record<string, unknown>): FleetV8RebalanceBot[] {
  const raw = getObjectArrayArg(args, 'bots', true);
  if (raw.length === 0) throw new Error('Argument "bots" must be a non-empty array.');
  return raw.map((entry, i) => {
    const botId = entry['botId'];
    const nodeId = entry['nodeId'];
    if (typeof botId !== 'string' || botId.trim() === '') {
      throw new Error(`bots[${i}].botId must be a non-empty string.`);
    }
    if (typeof nodeId !== 'string' || nodeId.trim() === '') {
      throw new Error(`bots[${i}].nodeId must be a non-empty string.`);
    }
    return { botId: botId.trim(), nodeId: nodeId.trim() };
  });
}

export function createFleetV8Tools(
  getBaseDir?: () => string | null | undefined,
): Tool[] {
  const resolveBase = (): string | null => {
    try {
      const dir = getBaseDir?.();
      return typeof dir === 'string' && dir.trim().length > 0 ? dir : null;
    } catch {
      return null;
    }
  };

  const nodeProbeTool: Tool = {
    definition: toolDef(
      'fleet_node_probe',
      'Probe the real resources of the local machine (CPU cores, 1m load, RAM total/free, disk total/free) with node:os + statfs. No file writes, no network — runs even before the fleet tools are wired.',
      {
        diskPath: { type: 'string', description: 'Path to probe disk usage for (default: user home dir).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const diskPath = args['diskPath'];
        const probe =
          typeof diskPath === 'string' && diskPath.trim() !== ''
            ? probeFleetV8LocalNode(diskPath)
            : probeFleetV8LocalNode();
        return okResult({
          ...probe,
          ramFreePercent: probe.ramTotalBytes > 0 ? Math.round((probe.ramFreeBytes / probe.ramTotalBytes) * 1000) / 10 : null,
          diskFreePercent:
            probe.diskTotalBytes !== null && probe.diskFreeBytes !== null && probe.diskTotalBytes > 0
              ? Math.round((probe.diskFreeBytes / probe.diskTotalBytes) * 1000) / 10
              : null,
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const nodeHealthTool: Tool = {
    definition: toolDef(
      'fleet_node_health',
      'Evaluate one fleet node health from probe/heartbeat numbers (healthy/degraded/unhealthy/down + one check per signal: heartbeat, CPU load, RAM free, disk free, bot capacity). Pure function — runs even before the fleet tools are wired.',
      {
        nodeId: { type: 'string', description: 'Node id (non-empty).' },
        cpuCores: { type: 'number', description: 'CPU cores the node declares (0 = unknown).' },
        cpuLoad1m: { type: 'number', description: '1-minute load average (null when the node does not report it).' },
        ramTotalBytes: { type: 'number', description: 'Total RAM in bytes (null when unknown).' },
        ramFreeBytes: { type: 'number', description: 'Free RAM in bytes (null when unknown).' },
        diskTotalBytes: { type: 'number', description: 'Total disk in bytes (null when unknown).' },
        diskFreeBytes: { type: 'number', description: 'Free disk in bytes (null when unknown).' },
        heartbeatAgeMs: { type: 'number', description: 'ms since the last heartbeat (null = never seen).' },
        runningBots: { type: 'number', description: 'Bots currently running on the node (default 0).' },
        maxBots: { type: 'number', description: 'Max bots the node accepts (null = unlimited).' },
        draining: { type: 'boolean', description: 'True when the node is draining (default false).' },
      },
      ['nodeId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const result = checkFleetV8NodeHealth({
          nodeId: getStringArg(args, 'nodeId'),
          cpuCores: getNumberArg(args, 'cpuCores', 0),
          cpuLoad1m: getNullableNumberArg(args, 'cpuLoad1m'),
          ramTotalBytes: getNullableNumberArg(args, 'ramTotalBytes'),
          ramFreeBytes: getNullableNumberArg(args, 'ramFreeBytes'),
          diskTotalBytes: getNullableNumberArg(args, 'diskTotalBytes'),
          diskFreeBytes: getNullableNumberArg(args, 'diskFreeBytes'),
          heartbeatAgeMs: getNullableNumberArg(args, 'heartbeatAgeMs'),
          runningBots: getNumberArg(args, 'runningBots', 0),
          maxBots: getNullableNumberArg(args, 'maxBots'),
          draining: args['draining'] === true,
        });
        return okResult(result);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const nodeRebalanceTool: Tool = {
    definition: toolDef(
      'fleet_node_rebalance',
      'Dry-run rebalance plan: move bots off down/unhealthy/draining/overloaded nodes onto healthy nodes with free capacity (loopback first, then most free resources). Returns moves + unplaced bots + summary. Pure function — nothing is moved for real.',
      {
        nodes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              nodeId: { type: 'string', description: 'Node id.' },
              status: { type: 'string', enum: ['healthy', 'degraded', 'unhealthy', 'down'], description: 'Node health status.' },
              loopback: { type: 'boolean', description: 'True when the node is local/loopback.' },
              maxBots: { type: 'number', description: 'Max bots (null = unlimited).' },
              freeFraction: { type: 'number', description: 'Free-resource fraction 0..1 (null = unknown).' },
              draining: { type: 'boolean', description: 'True when draining (takes no new bots).' },
            },
            required: ['nodeId', 'status'],
            additionalProperties: false,
          },
          description: 'Nodes in the fleet (non-empty).',
        },
        bots: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              botId: { type: 'string', description: 'Bot id.' },
              nodeId: { type: 'string', description: 'Node the bot currently runs on.' },
            },
            required: ['botId', 'nodeId'],
            additionalProperties: false,
          },
          description: 'Current bot placements (non-empty).',
        },
      },
      ['nodes', 'bots'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const plan = planFleetV8Rebalance(parseRebalanceNodes(args), parseRebalanceBots(args));
        return okResult(plan);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const dashboardTool: Tool = {
    definition: toolDef(
      'fleet_dashboard',
      'Fleet v8 dashboard snapshot: v8 node rollup + problem bots (v6 health) + running v7 campaigns + latest v8 incidents + alerts. Read-only; saved state lives in <userData>/fleet.',
      {
        limit: { type: 'number', description: 'Max recent incidents to include (default 20).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const snapshot = buildFleetV8Dashboard(fleetRoot);
        const limit = getNumberArg(args, 'limit', 20);
        const trimmed = limit > 0 ? { ...snapshot, recentIncidents: snapshot.recentIncidents.slice(0, Math.floor(limit)) } : snapshot;
        return okResult({ ...trimmed, summary: summarizeFleetV8Dashboard(trimmed) });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const incidentListTool: Tool = {
    definition: toolDef(
      'fleet_incident_list',
      'List fleet v8 incidents (newest first) from <userData>/fleet/fleet-incidents-v111.jsonl. Filter by kind and/or node. Read-only.',
      {
        kind: { type: 'string', enum: [...FLEET_V8_INCIDENT_KINDS], description: 'Incident kind to filter by.' },
        nodeId: { type: 'string', description: 'Node id to filter by.' },
        limit: { type: 'number', description: 'Max incidents to return (default 20).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const kind = args['kind'];
        if (kind !== undefined && kind !== null && (typeof kind !== 'string' || !FLEET_V8_INCIDENT_KINDS.includes(kind as FleetV8IncidentKind))) {
          throw new Error(`kind must be one of: ${FLEET_V8_INCIDENT_KINDS.join(', ')}.`);
        }
        const nodeId = args['nodeId'];
        const incidents = listFleetV8Incidents(fleetRoot, {
          ...(typeof kind === 'string' ? { kind: kind as FleetV8IncidentKind } : {}),
          ...(typeof nodeId === 'string' && nodeId.trim() !== '' ? { nodeId: nodeId.trim() } : {}),
          limit: getNumberArg(args, 'limit', 20),
        });
        return okResult({ total: incidents.length, incidents });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const incidentRecordTool: Tool = {
    definition: toolDef(
      'fleet_incident_record',
      'Record one fleet v8 incident into <userData>/fleet/fleet-incidents-v111.jsonl (node-down / node-degraded / node-recovered / node-evacuated / bot-restart / bot-restart-exhausted / rebalance). Needs approval.',
      {
        kind: { type: 'string', enum: [...FLEET_V8_INCIDENT_KINDS], description: 'Incident kind.' },
        nodeId: { type: 'string', description: 'Node id (non-empty).' },
        botId: { type: 'string', description: 'Related bot id (optional).' },
        message: { type: 'string', description: 'Human-readable message (non-empty).' },
      },
      ['kind', 'nodeId', 'message'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const kind = getStringArg(args, 'kind');
        if (!FLEET_V8_INCIDENT_KINDS.includes(kind as FleetV8IncidentKind)) {
          throw new Error(`kind must be one of: ${FLEET_V8_INCIDENT_KINDS.join(', ')}.`);
        }
        const botId = args['botId'];
        const incident = createFleetV8Incident(kind as FleetV8IncidentKind, getStringArg(args, 'nodeId'), getStringArg(args, 'message'), {
          ...(typeof botId === 'string' && botId.trim() !== '' ? { botId: botId.trim() } : {}),
        });
        appendFleetV8Incident(fleetRoot, incident);
        return okResult({ recorded: true, incident });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const mockToolkitListTool: Tool = {
    definition: toolDef(
      'composio_mock_toolkit_list_v111',
      'List the 6 Composio MOCK toolkits v111 (sentry/datadog/posthog/snowflake/amplitude/mixpanel) with their candidate tool slugs. Mock-only, no key, no network — slugs are candidates, NOT live-verified.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      try {
        return okResult({
          mock: true,
          live: false,
          totalToolkits: COMPOSIO_V111_MOCK_TOOLKITS.length,
          totalSlugs: COMPOSIO_V111_MOCK_TOOLKITS.reduce((n, t) => n + t.candidateToolSlugs.length, 0),
          toolkits: COMPOSIO_V111_MOCK_TOOLKITS.map((t) => ({
            slug: t.slug,
            label: t.label,
            icon: t.icon,
            description: t.description,
            candidateToolSlugs: [...t.candidateToolSlugs],
            mockOnly: t.mockOnly,
            liveVerified: t.liveVerified,
          })),
          note: 'Mock-only: no live Composio call. To run for real, add a Composio API key to the Vault and verify each slug against the live Composio catalog first.',
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const mockToolkitExecuteTool: Tool = {
    definition: toolDef(
      'composio_mock_toolkit_execute_v111',
      'Run one mock Composio v111 tool with deterministic local sample data (no network, no key). The response always carries mock: true, live: false. Throws for unknown toolkits/slugs.',
      {
        toolkit: { type: 'string', description: 'Mock toolkit slug: sentry, datadog, posthog, snowflake, amplitude or mixpanel.' },
        slug: { type: 'string', description: 'Candidate tool slug of that toolkit, e.g. SENTRY_LIST_ISSUES.' },
        args: { type: 'object', description: 'Tool arguments (echoed back in data.echo; the mock never executes anything).' },
      },
      ['toolkit', 'slug'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const toolkit = getStringArg(args, 'toolkit');
        const slug = getStringArg(args, 'slug');
        const toolArgs = args['args'];
        if (toolArgs !== undefined && toolArgs !== null && (typeof toolArgs !== 'object' || Array.isArray(toolArgs))) {
          throw new Error('Argument "args" must be an object.');
        }
        const needsApproval = mockComposioV111ToolNeedsApproval(slug);
        const result = new MockComposioV111Executor().execute(toolkit, slug, (toolArgs ?? {}) as Record<string, unknown>);
        return okResult({ ...result, needsApproval });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const connectionListTool: Tool = {
    definition: toolDef(
      'composio_connection_list',
      'List Composio connection lifecycles (active/initiated/disconnected/reconnecting/failed per toolkit) + summary + latest audit entries. Reads <userData>/composio/composio-connections-v111.json. Read-only.',
      {
        limit: { type: 'number', description: 'Max audit entries to include (default 10).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { composioDir } = dirs(base);
        const entries = loadComposioV111Connections(composioDir);
        const summary = summarizeComposioV111Connections(entries);
        const audit = listComposioV111Audit(composioDir, { limit: getNumberArg(args, 'limit', 10) });
        return okResult({ entries, summary, audit });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const connectionDisconnectTool: Tool = {
    definition: toolDef(
      'composio_connection_disconnect',
      'Disconnect a Composio toolkit connection (user action). The connection is marked disconnected-by-user and will NOT auto-reconnect until the user reconnects it. Only local lifecycle state is written — the real Composio API call is made by the host. Needs approval.',
      {
        toolkit: { type: 'string', description: 'Toolkit slug, e.g. github, slack, sentry.' },
        reason: { type: 'string', description: 'Why the connection is disconnected (shown in the audit log).' },
      },
      ['toolkit'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { composioDir } = dirs(base);
        const toolkit = getStringArg(args, 'toolkit');
        if (!isComposioV111ManagedToolkit(toolkit)) {
          throw new Error(`Unknown Composio toolkit: ${toolkit}`);
        }
        const reason = args['reason'] !== undefined && args['reason'] !== null ? getStringArg(args, 'reason', false) : '';
        const entries = loadComposioV111Connections(composioDir);
        const idx = entries.findIndex((e) => e.toolkit === toolkit);
        const prev = idx === -1 ? emptyComposioV111ConnectionEntry(toolkit, 'active') : entries[idx];
        const next = disconnectComposioV111Connection(prev, toolkit, reason);
        if (idx === -1) entries.push(next);
        else entries[idx] = next;
        saveComposioV111Connections(composioDir, entries);
        appendComposioV111Audit(
          composioDir,
          createComposioV111AuditEntry(toolkit, 'disconnect', next.status, next.lastReason ?? 'disconnected by user'),
        );
        return okResult({ disconnected: true, entry: next });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const connectionReconnectTool: Tool = {
    definition: toolDef(
      'composio_connection_reconnect',
      'Reconnect a Composio toolkit connection (user action). Records one reconnect attempt and returns the auto-reconnect decision (allowed + backoff delay). Only local lifecycle state is written — the real Composio API call is made by the host. Needs approval.',
      {
        toolkit: { type: 'string', description: 'Toolkit slug, e.g. github, slack, sentry.' },
      },
      ['toolkit'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { composioDir } = dirs(base);
        const toolkit = getStringArg(args, 'toolkit');
        if (!isComposioV111ManagedToolkit(toolkit)) {
          throw new Error(`Unknown Composio toolkit: ${toolkit}`);
        }
        const entries = loadComposioV111Connections(composioDir);
        const idx = entries.findIndex((e) => e.toolkit === toolkit);
        const prev = idx === -1 ? emptyComposioV111ConnectionEntry(toolkit, 'none') : entries[idx];
        const next = reconnectComposioV111Connection(prev, toolkit);
        if (idx === -1) entries.push(next);
        else entries[idx] = next;
        saveComposioV111Connections(composioDir, entries);
        appendComposioV111Audit(composioDir, createComposioV111AuditEntry(toolkit, 'reconnect', next.status, 'reconnect requested by user'));
        const decision = decideComposioV111AutoReconnect(next);
        return okResult({ reconnected: true, entry: next, autoReconnectDecision: decision });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const pollPolicyTool: Tool = {
    definition: toolDef(
      'composio_poll_policy',
      'Adaptive Composio poll policy: given a poller state + outcome (hit/miss/error), compute the next poll interval (hits shrink it, misses/errors grow it, clamped + jittered) and the missed-poll catch-up summary. Pure function — runs even before the tools are wired.',
      {
        name: { type: 'string', description: 'Poller name (non-empty).' },
        outcome: { type: 'string', enum: ['hit', 'miss', 'error'], description: 'Outcome of the last poll.' },
        currentIntervalMs: { type: 'number', description: 'Current interval in ms (default 900000 = 15m).' },
        totalPolls: { type: 'number', description: 'Total polls run so far (default 0).' },
        totalHits: { type: 'number', description: 'Total hit polls so far (default 0).' },
        totalErrors: { type: 'number', description: 'Total error polls so far (default 0).' },
        consecutiveMisses: { type: 'number', description: 'Consecutive misses so far (default 0).' },
        consecutiveErrors: { type: 'number', description: 'Consecutive errors so far (default 0).' },
        lastPollAtMs: { type: 'number', description: 'Epoch ms of the last poll (null = never polled).' },
        seenIds: { type: 'array', items: { type: 'string' }, description: 'Ids already seen (for the catch-up/dedupe summary).' },
        error: { type: 'string', description: 'Last error message (when outcome is error).' },
        noJitter: { type: 'boolean', description: 'True = deterministic interval without jitter (default false).' },
      },
      ['name', 'outcome'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const outcome = getStringArg(args, 'outcome');
        if (!(['hit', 'miss', 'error'] as readonly string[]).includes(outcome)) {
          throw new Error('outcome must be one of: hit, miss, error.');
        }
        const lastPollAtMs = getNullableNumberArg(args, 'lastPollAtMs');
        const base: ComposioV111PollPolicyState = {
          ...emptyComposioV111PollPolicyState(getStringArg(args, 'name')),
          currentIntervalMs: getNumberArg(args, 'currentIntervalMs', 15 * 60 * 1000),
          totalPolls: getNumberArg(args, 'totalPolls', 0),
          totalHits: getNumberArg(args, 'totalHits', 0),
          totalErrors: getNumberArg(args, 'totalErrors', 0),
          consecutiveMisses: getNumberArg(args, 'consecutiveMisses', 0),
          consecutiveErrors: getNumberArg(args, 'consecutiveErrors', 0),
          lastPollAtMs,
          seenIds: getStringArrayArg(args, 'seenIds').map((id) => ({ id, atMs: lastPollAtMs ?? Date.now() })),
        };
        const { state, nextIntervalMs } = nextComposioV111Poll(base, outcome as ComposioV111PollOutcome, {
          jitterFraction: args['noJitter'] === true ? 0 : undefined,
        });
        return okResult({
          state,
          nextIntervalMs,
          nextPollInSeconds: Math.round(nextIntervalMs / 1000),
          catchUp: summarizeComposioV111CatchUp(state),
          missedPolls: missedPollsBetween(state),
          summary: summarizeComposioV111PollState(state),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sambanovaModelsTool: Tool = {
    definition: toolDef(
      'provider_sambanova_models',
      'Info about the new SambaNova provider (OpenAI-compatible, https://api.sambanova.ai/v1): default model, fallback model list, Vault namespace. No network call — the live model list comes from listModels() when a key is set.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      try {
        return okResult({
          id: 'sambanova',
          label: 'SambaNova',
          baseUrl: SAMBANOVA_BASE_URL,
          defaultModel: SAMBANOVA_DEFAULT_MODEL,
          knownModels: [...SAMBANOVA_KNOWN_MODELS],
          vaultNamespace: ['provider', 'sambanova'],
          needsKey: true,
          note: 'SambaNova Cloud speaks the OpenAI chat-completions API. Bring your own key in Settings — the free tier asks for a payment method before the first call.',
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    nodeProbeTool,
    nodeHealthTool,
    nodeRebalanceTool,
    dashboardTool,
    incidentListTool,
    incidentRecordTool,
    mockToolkitListTool,
    mockToolkitExecuteTool,
    connectionListTool,
    connectionDisconnectTool,
    connectionReconnectTool,
    pollPolicyTool,
    sambanovaModelsTool,
  ];
}

export const FLEET_V8_TOOLS: Tool[] = createFleetV8Tools();

/** Trạng thái vòng đời Composio cho UI (re-export tiện cho test/tools khác). */
export type { ComposioV111LifecycleStatus };
