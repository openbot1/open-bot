/**
 * Fleet platform v11 tools (v1.14, Đội T6) — registered in ALL_TOOLS.
 *
 * Fleet health (3):
 * - `fleet_health_snapshot_v11` — xây snapshot sức khỏe fleet (node/bot
 *   theo trạng thái, alert đang mở, tài nguyên trung bình) từ các sample
 *   truyền vào (hàm thuần, chạy được ngay cả khi chưa bind).
 * - `fleet_health_evaluate_v11` — đánh giá health + sinh alert từ
 *   sample, gộp với alert đang mở đã lưu, ghi incident cho alert
 *   critical mới. Cần bind (đọc/ghi <userData>/fleet/
 *   fleet-health-v114.json + fleet-incidents-v114.jsonl).
 * - `fleet_health_ack_v11` — đánh dấu alert đã xem (ack). Cần bind.
 *
 * Staged rollout (3):
 * - `fleet_rollout_create_v11` — tạo rollout theo nhóm (canary → nhóm
 *   nhỏ → toàn fleet). Lưu vào <userData>/fleet/fleet-rollouts-v114.json.
 *   Cần approval, cần bind.
 * - `fleet_rollout_action_v11` — start / advance / pause / resume /
 *   complete / rollback. Advance kiểm tra gate trước (nhóm trước xong,
 *   tỉ lệ lỗi dưới ngưỡng, không có alert critical ở nhóm tiếp theo).
 *   Cần approval, cần bind.
 * - `fleet_rollout_status_v11` — liệt kê rollout + tiến độ từng cái
 *   (chỉ đọc, cần bind).
 *
 * Panels (3, hàm thuần — chạy được ngay cả khi chưa bind, dữ liệu do
 * caller truyền vào; component desktop gọi tool này hoặc gọi trực tiếp
 * core để vẽ panel):
 * - `fleet_panel_memory_v11` — view-model memory panel: block đã lọc +
 *   ACL từng block + số version.
 * - `fleet_panel_voice_v11` — view-model voice panel: latency theo
 *   stage, barge-in, wake word, provider picker.
 * - `fleet_panel_mcp_apps_v11` — view-model MCP Apps panel: gallery +
 *   review quyền + CSP từng app.
 *
 * Như các tool fleet trước, tool cần file là placeholder trong ALL_TOOLS
 * cho tới khi host bind: `createFleetV11Tools(getBaseDir)` với userData
 * dir của app. Tool ghi file cần approval; tool chỉ đọc thì không.
 * KHÔNG chứa secret trong bất kỳ file nào ở trên.
 */

import * as path from 'node:path';
import type { Tool } from '@open-bot/core';
import {
  FLEET_V11_ROLLOUT_ACTIONS,
  acknowledgeFleetV11Alert,
  addFleetV11Rollout,
  appendFleetV11Incident,
  applyFleetV11RolloutAction,
  buildFleetV11Alerts,
  buildFleetV11HealthSnapshot,
  buildFleetV11McpAppsPanel,
  buildFleetV11MemoryPanel,
  buildFleetV11VoicePanel,
  checkFleetV11RolloutGate,
  createFleetV11Rollout,
  decideFleetV11AutoRollback,
  evaluateFleetV11BotHealth,
  evaluateFleetV11NodeHealth,
  findFleetV11Rollout,
  loadFleetV11HealthState,
  loadFleetV11Rollouts,
  readFleetV11Incidents,
  saveFleetV11HealthState,
  saveFleetV11Rollouts,
  summarizeFleetV11Rollout,
  trackFleetV11Downs,
  updateFleetV11Rollout,
  type FleetV11Alert,
  type FleetV11BotSample,
  type FleetV11HealthThresholds,
  type FleetV11NodeSample,
  type FleetV11RolloutAction,
} from '@open-bot/core';

export const FLEET_V11_TOOL_NAMES = [
  'fleet_health_snapshot_v11',
  'fleet_health_evaluate_v11',
  'fleet_health_ack_v11',
  'fleet_rollout_create_v11',
  'fleet_rollout_action_v11',
  'fleet_rollout_status_v11',
  'fleet_panel_memory_v11',
  'fleet_panel_voice_v11',
  'fleet_panel_mcp_apps_v11',
] as const;

export function isFleetV11ToolName(name: string): boolean {
  return (FLEET_V11_TOOL_NAMES as readonly string[]).includes(name);
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

function getBooleanArg(args: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean.`);
  }
  return value;
}

function getObjectArg(args: Record<string, unknown>, name: string, required = false): Record<string, unknown> {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return {};
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Argument "${name}" must be an object.`);
  }
  return value as Record<string, unknown>;
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
  'fleet v11 tools are not wired in this host (no userData dir configured) — open the fleet console UI instead.';

/** Fleet root derived from the app userData dir. */
function fleetRoot(baseDir: string): string {
  return path.join(baseDir, 'fleet');
}

function asNodeSamples(raw: Record<string, unknown>[]): FleetV11NodeSample[] {
  return raw.map((r) => ({
    nodeId: String(r['nodeId'] ?? ''),
    name: typeof r['name'] === 'string' ? r['name'] : undefined,
    cpuPct: typeof r['cpuPct'] === 'number' ? r['cpuPct'] : null,
    ramPct: typeof r['ramPct'] === 'number' ? r['ramPct'] : null,
    diskPct: typeof r['diskPct'] === 'number' ? r['diskPct'] : null,
    uptimeMs: typeof r['uptimeMs'] === 'number' ? r['uptimeMs'] : null,
    lastHeartbeatAt: typeof r['lastHeartbeatAt'] === 'number' ? r['lastHeartbeatAt'] : null,
    botCount: typeof r['botCount'] === 'number' ? r['botCount'] : 0,
    botCapacity: typeof r['botCapacity'] === 'number' ? r['botCapacity'] : 0,
  }));
}

function asBotSamples(raw: Record<string, unknown>[]): FleetV11BotSample[] {
  return raw.map((r) => ({
    botId: String(r['botId'] ?? ''),
    name: typeof r['name'] === 'string' ? r['name'] : undefined,
    nodeId: typeof r['nodeId'] === 'string' ? r['nodeId'] : '',
    cpuPct: typeof r['cpuPct'] === 'number' ? r['cpuPct'] : null,
    ramPct: typeof r['ramPct'] === 'number' ? r['ramPct'] : null,
    lastHeartbeatAt: typeof r['lastHeartbeatAt'] === 'number' ? r['lastHeartbeatAt'] : null,
    uptimeMs: typeof r['uptimeMs'] === 'number' ? r['uptimeMs'] : null,
    consecutiveFailures: typeof r['consecutiveFailures'] === 'number' ? r['consecutiveFailures'] : 0,
    recentRestarts: typeof r['recentRestarts'] === 'number' ? r['recentRestarts'] : 0,
    running: r['running'] === true,
  }));
}

function asThresholds(raw: Record<string, unknown>): Partial<FleetV11HealthThresholds> {
  const out: Partial<FleetV11HealthThresholds> = {};
  for (const key of [
    'cpuWarnPct',
    'cpuCritPct',
    'ramWarnPct',
    'ramCritPct',
    'diskWarnPct',
    'diskCritPct',
    'heartbeatTimeoutMs',
    'downAfterMs',
    'minUptimeMs',
    'unhealthyAfterFailures',
    'restartsDegraded',
  ] as const) {
    if (typeof raw[key] === 'number') out[key] = raw[key];
  }
  return out;
}

export function createFleetV11Tools(
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

  const healthSnapshotTool: Tool = {
    definition: toolDef(
      'fleet_health_snapshot_v11',
      'Build a fleet v11 health snapshot (node/bot counts by status, open alerts by level, average CPU/RAM/disk) from node + bot samples passed in. Pure: works without the fleet tools wired.',
      {
        nodes: { type: 'array', items: { type: 'object' }, description: 'Node samples: {nodeId, name?, cpuPct?, ramPct?, diskPct?, uptimeMs?, lastHeartbeatAt?, botCount?, botCapacity?}.' },
        bots: { type: 'array', items: { type: 'object' }, description: 'Bot samples: {botId, name?, nodeId?, cpuPct?, ramPct?, lastHeartbeatAt?, uptimeMs?, consecutiveFailures?, recentRestarts?, running?}.' },
        thresholds: { type: 'object', description: 'Optional health thresholds (cpuWarnPct, cpuCritPct, ramWarnPct, ramCritPct, diskWarnPct, diskCritPct, heartbeatTimeoutMs, downAfterMs).' },
        now: { type: 'number', description: 'Evaluation time in epoch ms (default now).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const now = getNumberArg(args, 'now', Date.now());
        const thresholds = asThresholds(getObjectArg(args, 'thresholds'));
        const nodes = asNodeSamples(getObjectArrayArg(args, 'nodes'));
        const bots = asBotSamples(getObjectArrayArg(args, 'bots'));
        const nodeResults = nodes.map((n) => evaluateFleetV11NodeHealth(n, thresholds, now));
        const botResults = bots.map((b) => evaluateFleetV11BotHealth(b, thresholds, now));
        const alerts = buildFleetV11Alerts([...nodeResults, ...botResults], [], now);
        return okResult(buildFleetV11HealthSnapshot(nodes, nodeResults, botResults, alerts, now));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const healthEvaluateTool: Tool = {
    definition: toolDef(
      'fleet_health_evaluate_v11',
      'Evaluate fleet v11 health from node + bot samples, merge with previously open alerts, persist tracking state, and append incidents for newly raised critical alerts. Needs the fleet tools wired.',
      {
        nodes: { type: 'array', items: { type: 'object' }, description: 'Node samples (see fleet_health_snapshot_v11).' },
        bots: { type: 'array', items: { type: 'object' }, description: 'Bot samples (see fleet_health_snapshot_v11).' },
        thresholds: { type: 'object', description: 'Optional health thresholds.' },
        previousAlerts: { type: 'array', items: { type: 'object' }, description: 'Previously open alerts to carry occurrences/acks from (optional; overrides the stored ack list).' },
        now: { type: 'number', description: 'Evaluation time in epoch ms (default now).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const now = getNumberArg(args, 'now', Date.now());
        const thresholds = asThresholds(getObjectArg(args, 'thresholds'));
        const nodes = asNodeSamples(getObjectArrayArg(args, 'nodes'));
        const bots = asBotSamples(getObjectArrayArg(args, 'bots'));
        const nodeResults = nodes.map((n) => evaluateFleetV11NodeHealth(n, thresholds, now));
        const botResults = bots.map((b) => evaluateFleetV11BotHealth(b, thresholds, now));
        const results = [...nodeResults, ...botResults];
        const root = fleetRoot(base);
        const state = loadFleetV11HealthState(root);
        const passed = getObjectArrayArg(args, 'previousAlerts') as unknown as FleetV11Alert[];
        const previous: FleetV11Alert[] = passed.length > 0 ? passed : [];
        // Khôi phục ack đã lưu vào alert đang mở (theo id).
        const alerts = buildFleetV11Alerts(results, previous, now).map((a) => {
          const acked = state.acknowledgedAlerts[a.id];
          return acked ? { ...a, acknowledged: true, acknowledgedBy: acked.by, acknowledgedAt: acked.at } : a;
        });
        const prevIds = new Set(previous.map((a) => a.id));
        for (const a of alerts) {
          if (a.level === 'critical' && !prevIds.has(a.id)) {
            appendFleetV11Incident(root, {
              at: now,
              kind: a.targetKind === 'node' ? 'node-degraded' : 'bot-unhealthy',
              targetKind: a.targetKind,
              targetId: a.targetId,
              message: a.message,
              level: 'critical',
            });
          }
        }
        const nextState = trackFleetV11Downs(state, results, now);
        saveFleetV11HealthState(root, nextState);
        return okResult({
          snapshot: buildFleetV11HealthSnapshot(nodes, nodeResults, botResults, alerts, now),
          alerts,
          consecutiveDowns: nextState.consecutiveDowns,
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const healthAckTool: Tool = {
    definition: toolDef(
      'fleet_health_ack_v11',
      'Acknowledge a fleet v11 alert by id (alert stays open until the next evaluation clears it; ack only records who saw it). Needs the fleet tools wired.',
      {
        alertId: { type: 'string', description: 'Alert id (<kind>:<targetId>:<rule>).' },
        actorUserId: { type: 'string', description: 'User acknowledging the alert.' },
        previousAlerts: { type: 'array', items: { type: 'object' }, description: 'Currently open alerts (ack is applied to the matching one).' },
        now: { type: 'number', description: 'Ack time in epoch ms (default now).' },
      },
      ['alertId', 'actorUserId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const now = getNumberArg(args, 'now', Date.now());
        const alertId = getStringArg(args, 'alertId');
        const actorUserId = getStringArg(args, 'actorUserId');
        const previous = getObjectArrayArg(args, 'previousAlerts') as unknown as FleetV11Alert[];
        const updated = acknowledgeFleetV11Alert(previous, alertId, actorUserId, now);
        if (updated === previous) return errorResult(`no open alert with id "${alertId}"`);
        const root = fleetRoot(base);
        const state = loadFleetV11HealthState(root);
        state.acknowledgedAlerts[alertId] = { by: actorUserId, at: now };
        saveFleetV11HealthState(root, state);
        appendFleetV11Incident(root, {
          at: now,
          kind: 'alert-acked',
          targetKind: 'node',
          targetId: alertId,
          message: `alert ${alertId} đã được ${actorUserId} xác nhận`,
          level: 'info',
        });
        return okResult(updated.find((a) => a.id === alertId) ?? null);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const rolloutCreateTool: Tool = {
    definition: toolDef(
      'fleet_rollout_create_v11',
      'Create a staged fleet v11 rollout (groups in order: canary, then small groups, then the whole fleet) for a feature/config version. Persisted to <userData>/fleet/fleet-rollouts-v114.json. Needs approval; needs the fleet tools wired.',
      {
        name: { type: 'string', description: 'Rollout name (non-empty).' },
        description: { type: 'string', description: 'Short description of what is being rolled out.' },
        targetKind: { type: 'string', enum: ['node', 'bot'], description: 'Whether targets are nodes or bots.' },
        feature: { type: 'string', description: 'Feature/config name being rolled out.' },
        version: { type: 'string', description: 'Version being rolled out.' },
        previousVersion: { type: 'string', description: 'Version to roll back to.' },
        groups: {
          type: 'array',
          items: { type: 'object' },
          description: 'Groups in rollout order: [{name, targets: [ids...]}]. The "all" group (if any) must be last.',
        },
        createdBy: { type: 'string', description: 'User creating the rollout.' },
        now: { type: 'number', description: 'Creation time in epoch ms (default now).' },
      },
      ['name', 'targetKind', 'feature', 'version', 'previousVersion', 'groups', 'createdBy'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const now = getNumberArg(args, 'now', Date.now());
        const groups = getObjectArrayArg(args, 'groups', true).map((g) => ({
          name: String(g['name'] ?? ''),
          targets: Array.isArray(g['targets']) ? (g['targets'] as unknown[]).map(String) : [],
        }));
        const rollout = createFleetV11Rollout(
          {
            name: getStringArg(args, 'name'),
            description: getStringArg(args, 'description', false),
            targetKind: getStringArg(args, 'targetKind') as 'node' | 'bot',
            feature: getStringArg(args, 'feature'),
            version: getStringArg(args, 'version'),
            previousVersion: getStringArg(args, 'previousVersion'),
            groups,
            createdBy: getStringArg(args, 'createdBy'),
          },
          now,
        );
        const root = fleetRoot(base);
        const rollouts = addFleetV11Rollout(loadFleetV11Rollouts(root), rollout);
        saveFleetV11Rollouts(root, rollouts);
        return okResult(rollout);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const rolloutActionTool: Tool = {
    definition: toolDef(
      'fleet_rollout_action_v11',
      'Apply a control action (start / advance / pause / resume / complete / rollback) to a fleet v11 rollout. Advance checks the rollout gate first (previous group done, error rate under threshold, no critical alert on the next group). Needs approval; needs the fleet tools wired.',
      {
        rolloutId: { type: 'string', description: 'Rollout id.' },
        action: { type: 'string', enum: [...FLEET_V11_ROLLOUT_ACTIONS], description: 'Action to apply.' },
        actorUserId: { type: 'string', description: 'User performing the action.' },
        reason: { type: 'string', description: 'Reason for the action.' },
        criticalAlertTargetIds: { type: 'array', items: { type: 'string' }, description: 'Target ids with a critical alert (gate input for advance).' },
        healthyTargetIds: { type: 'array', items: { type: 'string' }, description: 'Target ids currently healthy (gate input for advance).' },
        maxErrorRate: { type: 'number', description: 'Max error rate allowed by the gate (default 0.05).' },
        now: { type: 'number', description: 'Action time in epoch ms (default now).' },
      },
      ['rolloutId', 'action', 'actorUserId', 'reason'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const now = getNumberArg(args, 'now', Date.now());
        const root = fleetRoot(base);
        const rollouts = loadFleetV11Rollouts(root);
        const rollout = findFleetV11Rollout(rollouts, getStringArg(args, 'rolloutId'));
        if (!rollout) return errorResult(`no rollout with id "${getStringArg(args, 'rolloutId')}"`);
        const action = getStringArg(args, 'action') as FleetV11RolloutAction;
        if (action === 'advance') {
          const gate = checkFleetV11RolloutGate(rollout, {
            criticalAlertTargetIds: getStringArrayArg(args, 'criticalAlertTargetIds'),
            healthyTargetIds: getStringArrayArg(args, 'healthyTargetIds'),
            maxErrorRate: args['maxErrorRate'] === undefined ? undefined : getNumberArg(args, 'maxErrorRate', 0.05),
          });
          if (!gate.allowed) {
            return errorResult(
              `rollout gate chặn mở rộng: ${gate.checks.filter((c) => !c.passed).map((c) => c.detail).join('; ')}`,
            );
          }
        }
        const result = applyFleetV11RolloutAction(
          rollout,
          action,
          getStringArg(args, 'actorUserId'),
          getStringArg(args, 'reason'),
          now,
        );
        if (!result.ok) return errorResult(result.error);
        saveFleetV11Rollouts(root, updateFleetV11Rollout(rollouts, result.rollout));
        return okResult({
          rollout: result.rollout,
          progress: summarizeFleetV11Rollout(result.rollout),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const rolloutStatusTool: Tool = {
    definition: toolDef(
      'fleet_rollout_status_v11',
      'List fleet v11 rollouts with progress per rollout (and auto-rollback suggestion for the active group when down targets are given). Read-only; needs the fleet tools wired.',
      {
        rolloutId: { type: 'string', description: 'Only show this rollout (omit to list all).' },
        downTargetIds: { type: 'array', items: { type: 'string' }, description: 'Target ids currently down (for the auto-rollback suggestion).' },
        now: { type: 'number', description: 'Evaluation time in epoch ms (default now).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const root = fleetRoot(base);
        const rollouts = loadFleetV11Rollouts(root);
        const downTargetIds = getStringArrayArg(args, 'downTargetIds');
        const id = args['rolloutId'] === undefined ? '' : getStringArg(args, 'rolloutId', false);
        const selected = id ? rollouts.filter((r) => r.id === id) : rollouts;
        return okResult(
          selected.map((r) => ({
            rollout: r,
            progress: summarizeFleetV11Rollout(r),
            autoRollback: decideFleetV11AutoRollback(r, downTargetIds),
          })),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const panelMemoryTool: Tool = {
    definition: toolDef(
      'fleet_panel_memory_v11',
      'Build the memory panel v11 view-model: filtered memory blocks with per-block ACL, version counts, and a summary. Pure: works without the fleet tools wired; blocks + history are passed in.',
      {
        blocks: { type: 'array', items: { type: 'object' }, description: 'Memory blocks: {id, label, description, content, charLimit, readOnly, systemOwned?, createdByBotId, version, createdAt, updatedAt}.' },
        history: { type: 'object', description: 'Block id -> version snapshots [{blockId, label, version, content, description, charLimit, readOnly, action, actor, at}].' },
        actor: { type: 'string', description: 'Actor viewing the panel: "user" or "agent:<botId>".' },
        filter: { type: 'string', enum: ['all', 'system', 'user', 'read-only'], description: 'Block filter (default all).' },
        query: { type: 'string', description: 'Search text (default empty).' },
      },
      ['blocks', 'actor'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const blocks = getObjectArrayArg(args, 'blocks', true) as unknown as Parameters<
          typeof buildFleetV11MemoryPanel
        >[0];
        const historyRaw = getObjectArg(args, 'history');
        const history: Record<string, Parameters<typeof buildFleetV11MemoryPanel>[1][string]> = {};
        for (const [k, v] of Object.entries(historyRaw)) {
          if (Array.isArray(v)) history[k] = v as never;
        }
        const filter = args['filter'] === undefined ? undefined : (getStringArg(args, 'filter', false) as 'all' | 'system' | 'user' | 'read-only');
        return okResult(
          buildFleetV11MemoryPanel(blocks, history, getStringArg(args, 'actor'), {
            filter,
            query: args['query'] === undefined ? undefined : getStringArg(args, 'query', false),
          }),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const panelVoiceTool: Tool = {
    definition: toolDef(
      'fleet_panel_voice_v11',
      'Build the voice panel v11 view-model: per-stage latency, slowest stage, budget check, barge-in config, wake word validation, and the voice provider picker. Pure: works without the fleet tools wired; the latency report is passed in (or omitted when no session ran yet).',
      {
        report: { type: 'object', description: 'Voice latency report {sessionId, mode, turns, stages: {capture|vad|stt|llm|tts|playback: {count, minMs, maxMs, meanMs, p50Ms, p95Ms, p99Ms, lastMs, buckets}}, endToEnd, slowestStage, jitterBufferMs, at} (omit when no data).' },
        bargeIn: { type: 'object', description: 'Barge-in config {enabled, threshold (0-1), minSpeechMs}.' },
        wakeWord: { type: 'string', description: 'Wake word to validate (1-3 words).' },
        providersWithKey: { type: 'array', items: { type: 'string' }, description: 'Provider ids that already have a key.' },
        selectedProviderId: { type: 'string', description: 'Provider id selected in the picker.' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const reportRaw = getObjectArg(args, 'report');
        const report = Object.keys(reportRaw).length > 0 ? (reportRaw as never) : null;
        return okResult(
          buildFleetV11VoicePanel(report, {
            bargeIn: getObjectArg(args, 'bargeIn') as never,
            wakeWord: args['wakeWord'] === undefined ? undefined : getStringArg(args, 'wakeWord', false),
            providersWithKey: getStringArrayArg(args, 'providersWithKey'),
            selectedProviderId: args['selectedProviderId'] === undefined ? undefined : getStringArg(args, 'selectedProviderId', false),
          }),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const panelMcpAppsTool: Tool = {
    definition: toolDef(
      'fleet_panel_mcp_apps_v11',
      'Build the MCP Apps panel v11 view-model: app gallery (search / category / compatible-only) with install state, per-app permission review, and CSP/sandbox summary. Pure: works without the fleet tools wired; installs are passed in (omit for the built-in catalogue only).',
      {
        query: { type: 'string', description: 'Search text (default empty).' },
        category: { type: 'string', enum: ['all', 'productivity', 'data', 'developer', 'communication', 'utility'], description: 'Category filter (default all).' },
        onlyCompatible: { type: 'boolean', description: 'Only show apps compatible with this host (default false).' },
        installs: { type: 'array', items: { type: 'object' }, description: 'Installed apps: [{appId, version, serverId, installedAtMs, enabled}].' },
        hostCaps: { type: 'object', description: 'Host capabilities {hostVersion, grantedPermissions, allowNetwork, sandboxStrict} (default built-in caps).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const installs = getObjectArrayArg(args, 'installs') as never;
        const capsRaw = getObjectArg(args, 'hostCaps');
        return okResult(
          buildFleetV11McpAppsPanel({
            query: args['query'] === undefined ? undefined : getStringArg(args, 'query', false),
            category: args['category'] === undefined ? undefined : (getStringArg(args, 'category', false) as never),
            onlyCompatible: getBooleanArg(args, 'onlyCompatible', false),
            installs,
            hostCaps: Object.keys(capsRaw).length > 0 ? (capsRaw as never) : undefined,
          }),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    healthSnapshotTool,
    healthEvaluateTool,
    healthAckTool,
    rolloutCreateTool,
    rolloutActionTool,
    rolloutStatusTool,
    panelMemoryTool,
    panelVoiceTool,
    panelMcpAppsTool,
  ];
}

/** Unbound placeholders for ALL_TOOLS (bound by createDefaultTools when wired). */
export const FLEET_V11_TOOLS: Tool[] = createFleetV11Tools();
