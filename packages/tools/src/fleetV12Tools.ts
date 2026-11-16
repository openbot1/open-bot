/**
 * Fleet platform v12 tools (v1.15, Đội T6) — registered in ALL_TOOLS.
 *
 * Model pinning (3):
 * - `fleet_model_pin_v12` — pin model GGUF từ publisher vào manifest
 *   (kèm SHA-256) + gán cho node. Model do OS cung cấp bị từ chối.
 *   Cần approval, cần bind.
 * - `fleet_model_verify_v12` — verify hash file GGUF đã pin trên một
 *   node (verified / tampered / missing / size-mismatch), cập nhật
 *   manifest + đánh drift khi hash lệch. Cần bind.
 * - `fleet_model_pins_v12` — liệt kê model đã pin + pin từng node +
 *   tóm tắt drift (chỉ đọc, cần bind).
 *
 * Percentage rollout (3):
 * - `fleet_rollout_create_v12` — tạo rollout theo nhóm phần trăm
 *   (canary 1 node → 25% → 50% → 100%, cohort deterministic theo
 *   hash). Lưu vào <userData>/fleet/fleet-rollouts-v115.json.
 *   Cần approval, cần bind.
 * - `fleet_rollout_action_v12` — start / advance / pause / resume /
 *   complete / rollback. Advance kiểm tra gate trước (cohort trước
 *   xong, tỉ lệ lỗi dưới ngưỡng, không có alert critical ở cohort
 *   tiếp theo). Kèm quyết định pause/rollback tự động từ health
 *   check. Cần approval, cần bind.
 * - `fleet_rollout_status_v12` — liệt kê rollout + tiến độ từng cái
 *   (chỉ đọc, cần bind).
 *
 * Health dashboard v12 (1, hàm thuần khi chưa bind):
 * - `fleet_health_dashboard_v12` — dashboard từ sample node truyền
 *   vào (per-node CPU/RAM/disk/model, alert theo rule, history ngắn
 *   hạn từ state đã lưu khi bind).
 *
 * Panels (2, hàm thuần — chạy được ngay cả khi chưa bind, dữ liệu do
 * caller truyền vào; component desktop gọi tool này hoặc gọi trực
 * tiếp core để vẽ panel):
 * - `fleet_panel_agui_v12` — view-model AG-UI/A2UI: timeline theo
 *   run, interrupt đang chờ, generative surfaces.
 * - `fleet_panel_memory_router_v12` — view-model memory v12 (fact
 *   list, temporal KG, quarantine count, GDPR erasure plan) + router
 *   (model đang load, RAM, decision log, budget/spend).
 *
 * Như các tool fleet trước, tool cần file là placeholder trong
 * ALL_TOOLS cho tới khi host bind: `createFleetV12Tools(getBaseDir)`
 * với userData dir của app. Tool ghi file cần approval; tool chỉ đọc
 * thì không. KHÔNG chứa secret trong bất kỳ file nào ở trên.
 */

import * as path from 'node:path';
import type { Tool } from '@open-bot/core';
import {
  addFleetV12Rollout,
  applyFleetV12RolloutAction,
  applyFleetV12VerifyResult,
  assignFleetV12NodePin,
  buildFleetV12AguiPanel,
  buildFleetV12HealthDashboard,
  buildFleetV12MemoryPanel,
  buildFleetV12RouterPanel,
  checkFleetV12RolloutGate,
  createFleetV12HealthState,
  createFleetV12PinManifest,
  createFleetV12Rollout,
  decideFleetV12AutoAction,
  findFleetV12NodePin,
  findFleetV12PinnedModel,
  findFleetV12Rollout,
  isFleetV12OsProvidedModel,
  loadFleetV12HealthState,
  loadFleetV12PinManifest,
  loadFleetV12Rollouts,
  markFleetV12CohortDone,
  pinFleetV12Model,
  planFleetV12GdprErasure,
  recordFleetV12CohortProgress,
  recordFleetV12Sample,
  saveFleetV12HealthState,
  saveFleetV12PinManifest,
  saveFleetV12Rollouts,
  summarizeFleetV12Pins,
  summarizeFleetV12Rollout,
  updateFleetV12Rollout,
  validateFleetV12InterruptDecision,
  validateFleetV12QuarantineDecision,
  verifyFleetV12ModelFile,
  type AgUiEvent,
  type FleetV12AlertRule,
  type FleetV12KgEntity,
  type FleetV12KgRelation,
  type FleetV12MemoryFact,
  type FleetV12NodeSample,
  type FleetV12RolloutAction,
  type FleetV12RouterModel,
  type FleetV12RoutingDecision,
} from '@open-bot/core';

export const FLEET_V12_TOOL_NAMES = [
  'fleet_model_pin_v12',
  'fleet_model_verify_v12',
  'fleet_model_pins_v12',
  'fleet_rollout_create_v12',
  'fleet_rollout_action_v12',
  'fleet_rollout_status_v12',
  'fleet_health_dashboard_v12',
  'fleet_panel_agui_v12',
  'fleet_panel_memory_router_v12',
] as const;

export function isFleetV12ToolName(name: string): boolean {
  return (FLEET_V12_TOOL_NAMES as readonly string[]).includes(name);
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
  'fleet v12 tools are not wired in this host (no userData dir configured) — open the fleet console UI instead.';

/** Fleet root derived from the app userData dir. */
function fleetRoot(baseDir: string): string {
  return path.join(baseDir, 'fleet');
}

function asNodeSamples(raw: Record<string, unknown>[]): FleetV12NodeSample[] {
  return raw.map((r) => ({
    nodeId: String(r['nodeId'] ?? ''),
    at: typeof r['at'] === 'number' ? r['at'] : Date.now(),
    cpuPct: typeof r['cpuPct'] === 'number' ? r['cpuPct'] : 0,
    ramPct: typeof r['ramPct'] === 'number' ? r['ramPct'] : 0,
    diskPct: typeof r['diskPct'] === 'number' ? r['diskPct'] : 0,
    uptimeMs: typeof r['uptimeMs'] === 'number' ? r['uptimeMs'] : 0,
    lastHeartbeatAt: typeof r['lastHeartbeatAt'] === 'number' ? r['lastHeartbeatAt'] : null,
    botCount: typeof r['botCount'] === 'number' ? r['botCount'] : 0,
    botCapacity: typeof r['botCapacity'] === 'number' ? r['botCapacity'] : 0,
    loadedModelId: typeof r['loadedModelId'] === 'string' ? r['loadedModelId'] : '',
    modelStatus:
      r['modelStatus'] === 'verified' ||
      r['modelStatus'] === 'drift' ||
      r['modelStatus'] === 'unverified' ||
      r['modelStatus'] === 'none'
        ? r['modelStatus']
        : 'none',
    tokensPerSec: typeof r['tokensPerSec'] === 'number' ? r['tokensPerSec'] : null,
    pendingRequests: typeof r['pendingRequests'] === 'number' ? r['pendingRequests'] : 0,
  }));
}

function asAgUiEvents(raw: Record<string, unknown>[]): AgUiEvent[] {
  return raw
    .filter((r) => typeof r['type'] === 'string' && typeof r['runId'] === 'string')
    .map((r) => ({
      protocol: 'agui/1.0' as const,
      type: r['type'] as AgUiEvent['type'],
      runId: String(r['runId']),
      ...(typeof r['botId'] === 'string' ? { botId: r['botId'] } : {}),
      ...(typeof r['threadId'] === 'string' ? { threadId: r['threadId'] } : {}),
      ...(typeof r['sequence'] === 'number' ? { sequence: r['sequence'] } : {}),
      timestamp: typeof r['timestamp'] === 'string' ? r['timestamp'] : new Date().toISOString(),
      data:
        r['data'] && typeof r['data'] === 'object'
          ? (r['data'] as Record<string, unknown>)
          : {},
    }));
}

function asMemoryFacts(raw: Record<string, unknown>[]): FleetV12MemoryFact[] {
  return raw.map((r) => ({
    id: String(r['id'] ?? ''),
    text: typeof r['text'] === 'string' ? r['text'] : '',
    confidence: typeof r['confidence'] === 'number' ? r['confidence'] : 0,
    source: typeof r['source'] === 'string' ? r['source'] : '',
    createdBy: typeof r['createdBy'] === 'string' ? r['createdBy'] : '',
    createdAt: typeof r['createdAt'] === 'number' ? r['createdAt'] : 0,
    quarantined: r['quarantined'] === true,
    quarantineReason: typeof r['quarantineReason'] === 'string' ? r['quarantineReason'] : '',
  }));
}

function asKgEntities(raw: Record<string, unknown>[]): FleetV12KgEntity[] {
  return raw.map((r) => ({
    id: String(r['id'] ?? ''),
    name: typeof r['name'] === 'string' ? r['name'] : '',
    kind: typeof r['kind'] === 'string' ? r['kind'] : '',
    validFrom: typeof r['validFrom'] === 'string' ? r['validFrom'] : '',
    validTo: typeof r['validTo'] === 'string' ? r['validTo'] : '',
    superseded: r['superseded'] === true,
    supersededBy: typeof r['supersededBy'] === 'string' ? r['supersededBy'] : '',
    quarantined: r['quarantined'] === true,
  }));
}

function asKgRelations(raw: Record<string, unknown>[]): FleetV12KgRelation[] {
  return raw.map((r) => ({
    id: String(r['id'] ?? ''),
    fromId: typeof r['fromId'] === 'string' ? r['fromId'] : '',
    toId: typeof r['toId'] === 'string' ? r['toId'] : '',
    label: typeof r['label'] === 'string' ? r['label'] : '',
    validFrom: typeof r['validFrom'] === 'string' ? r['validFrom'] : '',
    validTo: typeof r['validTo'] === 'string' ? r['validTo'] : '',
    superseded: r['superseded'] === true,
    quarantined: r['quarantined'] === true,
  }));
}

function asRouterModels(raw: Record<string, unknown>[]): FleetV12RouterModel[] {
  return raw.map((r) => ({
    modelId: String(r['modelId'] ?? ''),
    kind: r['kind'] === 'cloud' ? ('cloud' as const) : ('local' as const),
    status:
      r['status'] === 'loaded' ||
      r['status'] === 'loading' ||
      r['status'] === 'unloaded' ||
      r['status'] === 'error'
        ? r['status']
        : 'unloaded',
    ramMb: typeof r['ramMb'] === 'number' ? r['ramMb'] : 0,
    contextTokens: typeof r['contextTokens'] === 'number' ? r['contextTokens'] : 0,
    requestsServed: typeof r['requestsServed'] === 'number' ? r['requestsServed'] : 0,
    loadedAt: typeof r['loadedAt'] === 'number' ? r['loadedAt'] : null,
  }));
}

function asRoutingDecisions(raw: Record<string, unknown>[]): FleetV12RoutingDecision[] {
  return raw.map((r) => ({
    at: typeof r['at'] === 'number' ? r['at'] : 0,
    taskKind: typeof r['taskKind'] === 'string' ? r['taskKind'] : '',
    chosenModelId: typeof r['chosenModelId'] === 'string' ? r['chosenModelId'] : '',
    reason: typeof r['reason'] === 'string' ? r['reason'] : '',
    estimatedCostUsd: typeof r['estimatedCostUsd'] === 'number' ? r['estimatedCostUsd'] : 0,
    latencyMs: typeof r['latencyMs'] === 'number' ? r['latencyMs'] : null,
  }));
}

export function createFleetV12Tools(
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

  const pinTool: Tool = {
    definition: toolDef(
      'fleet_model_pin_v12',
      'Pin a publisher GGUF model (with SHA-256 hash) into the fleet v12 pin manifest and assign it to a fleet node. OS-provided models (Apple Foundation Models, Phi Silica / Foundry Local, os-provided) are rejected.',
      {
        modelId: { type: 'string', description: 'Model id, e.g. qwen3-4b-q4_k_m.' },
        publisher: { type: 'string', description: 'Publisher of the model, e.g. Qwen.' },
        license: { type: 'string', description: 'Model license, e.g. Apache-2.0.' },
        quant: { type: 'string', description: 'GGUF quant, e.g. Q4_K_M (optional).' },
        sha256: { type: 'string', description: 'SHA-256 hex (64 lowercase chars) of the GGUF file.' },
        sizeBytes: { type: 'number', description: 'GGUF file size in bytes (optional).' },
        ggufPath: { type: 'string', description: 'Path to the .gguf file on this machine.' },
        contextTokens: { type: 'number', description: 'Context window in tokens (optional).' },
        nodeId: { type: 'string', description: 'Fleet node to assign the model to (optional — pin only when omitted).' },
        pinnedBy: { type: 'string', description: 'User id pinning the model.' },
      },
      ['modelId', 'publisher', 'license', 'sha256', 'ggufPath', 'pinnedBy'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const base = resolveBase();
        if (!base) return errorResult(NOT_WIRED);
        const root = fleetRoot(base);
        const modelId = getStringArg(args, 'modelId');
        if (isFleetV12OsProvidedModel(modelId)) {
          return errorResult(
            `model "${modelId}" is OS-provided — the fleet only runs publisher-pinned GGUF models`,
          );
        }
        let manifest = loadFleetV12PinManifest(root) ?? createFleetV12PinManifest(getStringArg(args, 'pinnedBy'));
        const pinnedBy = getStringArg(args, 'pinnedBy');
        const res = pinFleetV12Model(manifest, {
          modelId,
          publisher: getStringArg(args, 'publisher'),
          license: getStringArg(args, 'license'),
          quant: typeof args['quant'] === 'string' ? args['quant'] : undefined,
          sha256: getStringArg(args, 'sha256'),
          sizeBytes: typeof args['sizeBytes'] === 'number' ? args['sizeBytes'] : undefined,
          ggufPath: getStringArg(args, 'ggufPath'),
          contextTokens: typeof args['contextTokens'] === 'number' ? args['contextTokens'] : undefined,
          pinnedBy,
        });
        if (!res.ok) return errorResult(res.error);
        manifest = res.manifest;
        let pin = null;
        const nodeId = typeof args['nodeId'] === 'string' ? args['nodeId'] : '';
        if (nodeId) {
          const assigned = assignFleetV12NodePin(manifest, nodeId, modelId, pinnedBy);
          if (!assigned.ok) return errorResult(assigned.error);
          manifest = assigned.manifest;
          pin = assigned.pin;
        }
        saveFleetV12PinManifest(root, manifest);
        return okResult({ model: res.model, pin, summary: summarizeFleetV12Pins(manifest) });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const verifyTool: Tool = {
    definition: toolDef(
      'fleet_model_verify_v12',
      'Verify the pinned GGUF file hash (SHA-256) for a fleet node: verified / tampered / missing / size-mismatch. Updates the pin manifest and marks drift when the hash differs.',
      {
        nodeId: { type: 'string', description: 'Fleet node whose pinned model file to verify.' },
      },
      ['nodeId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const base = resolveBase();
        if (!base) return errorResult(NOT_WIRED);
        const root = fleetRoot(base);
        const nodeId = getStringArg(args, 'nodeId');
        const manifest = loadFleetV12PinManifest(root);
        if (!manifest) return errorResult('no fleet v12 pin manifest yet — pin a model first');
        const pin = findFleetV12NodePin(manifest, nodeId);
        if (!pin) return errorResult(`node "${nodeId}" has no pinned model`);
        const model = findFleetV12PinnedModel(manifest, pin.modelId);
        if (!model) return errorResult(`pinned model "${pin.modelId}" not found in manifest`);
        const result = await verifyFleetV12ModelFile(model);
        const next = applyFleetV12VerifyResult(manifest, nodeId, result);
        saveFleetV12PinManifest(root, next);
        return okResult({ nodeId, modelId: pin.modelId, ...result });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const pinsTool: Tool = {
    definition: toolDef(
      'fleet_model_pins_v12',
      'List pinned GGUF models + per-node pins + drift summary for fleet v12 (read-only).',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      try {
        const base = resolveBase();
        if (!base) return errorResult(NOT_WIRED);
        const root = fleetRoot(base);
        const manifest = loadFleetV12PinManifest(root);
        if (!manifest) return okResult({ models: [], pins: [], summary: summarizeFleetV12Pins(createFleetV12PinManifest('system')) });
        return okResult({ models: manifest.models, pins: manifest.pins, summary: summarizeFleetV12Pins(manifest) });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const rolloutCreateTool: Tool = {
    definition: toolDef(
      'fleet_rollout_create_v12',
      'Create a fleet v12 percentage rollout (canary 1 node -> 25% -> 50% -> 100%, deterministic cohorts by hash) for a feature/config version.',
      {
        name: { type: 'string', description: 'Rollout name.' },
        description: { type: 'string', description: 'Short description of what is deployed (optional).' },
        feature: { type: 'string', description: 'Feature/config name being rolled out.' },
        version: { type: 'string', description: 'Version being deployed, e.g. 2.4.0.' },
        previousVersion: { type: 'string', description: 'Version currently running (rollback target).' },
        allNodeIds: { type: 'array', items: { type: 'string' }, description: 'All fleet node ids (cohorts are computed from these).' },
        createdBy: { type: 'string', description: 'User id creating the rollout.' },
      },
      ['name', 'feature', 'version', 'previousVersion', 'allNodeIds', 'createdBy'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const base = resolveBase();
        if (!base) return errorResult(NOT_WIRED);
        const root = fleetRoot(base);
        const rollout = createFleetV12Rollout({
          name: getStringArg(args, 'name'),
          description: typeof args['description'] === 'string' ? args['description'] : '',
          feature: getStringArg(args, 'feature'),
          version: getStringArg(args, 'version'),
          previousVersion: getStringArg(args, 'previousVersion'),
          allNodeIds: getStringArrayArg(args, 'allNodeIds'),
          createdBy: getStringArg(args, 'createdBy'),
        });
        const rollouts = addFleetV12Rollout(loadFleetV12Rollouts(root), rollout);
        saveFleetV12Rollouts(root, rollouts);
        return okResult({ rollout, progress: summarizeFleetV12Rollout(rollout) });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const rolloutActionTool: Tool = {
    definition: toolDef(
      'fleet_rollout_action_v12',
      'Apply an action (start / advance / pause / resume / complete / rollback) to a fleet v12 rollout. Advance checks the health gate first; the response also includes the automatic pause/rollback suggestion from the current health signal.',
      {
        rolloutId: { type: 'string', description: 'Rollout id.' },
        action: { type: 'string', description: 'Action: start | advance | pause | resume | complete | rollback.' },
        actorUserId: { type: 'string', description: 'User id performing the action.' },
        reason: { type: 'string', description: 'Reason for the action.' },
        appliedCount: { type: 'number', description: 'Nodes applied in the active cohort (optional, recorded before advance).' },
        errorCount: { type: 'number', description: 'Nodes errored in the active cohort (optional, recorded before advance).' },
        downNodeIds: { type: 'array', items: { type: 'string' }, description: 'Node ids currently down (for gate + auto-action).' },
        criticalAlertNodeIds: { type: 'array', items: { type: 'string' }, description: 'Node ids with a critical alert open (for gate + auto-action).' },
        healthyNodeIds: { type: 'array', items: { type: 'string' }, description: 'Node ids currently healthy (for the gate on the next cohort).' },
      },
      ['rolloutId', 'action', 'actorUserId', 'reason'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const base = resolveBase();
        if (!base) return errorResult(NOT_WIRED);
        const root = fleetRoot(base);
        const rolloutId = getStringArg(args, 'rolloutId');
        const action = getStringArg(args, 'action') as FleetV12RolloutAction;
        const actorUserId = getStringArg(args, 'actorUserId');
        const reason = getStringArg(args, 'reason');
        const rollouts = loadFleetV12Rollouts(root);
        let rollout = findFleetV12Rollout(rollouts, rolloutId);
        if (!rollout) return errorResult(`rollout not found: ${rolloutId}`);
        const downNodeIds = getStringArrayArg(args, 'downNodeIds');
        const criticalAlertNodeIds = getStringArrayArg(args, 'criticalAlertNodeIds');
        const healthyNodeIds = getStringArrayArg(args, 'healthyNodeIds');
        if (typeof args['appliedCount'] === 'number' || typeof args['errorCount'] === 'number') {
          const idx = rollout.activeCohortIndex;
          if (idx !== null && rollout.cohorts[idx]) {
            rollout = recordFleetV12CohortProgress(
              rollout,
              rollout.cohorts[idx].percentage,
              typeof args['appliedCount'] === 'number' ? args['appliedCount'] : rollout.cohorts[idx].appliedCount,
              typeof args['errorCount'] === 'number' ? args['errorCount'] : rollout.cohorts[idx].errorCount,
            );
          }
        }
        // Advance: khi tiến độ đã bao hết cohort (applied + error >= số
        // node) thì cohort được đánh done trước khi kiểm tra gate — nếu
        // chưa bao hết thì advance vẫn bị từ chối ở máy trạng thái.
        if (action === 'advance') {
          const idx = rollout.activeCohortIndex;
          if (idx !== null && rollout.cohorts[idx]) {
            const cohort = rollout.cohorts[idx];
            if (
              cohort.status === 'active' &&
              cohort.appliedCount + cohort.errorCount >= cohort.nodeIds.length
            ) {
              rollout = markFleetV12CohortDone(rollout, cohort.percentage);
            }
          }
        }
        const autoAction = decideFleetV12AutoAction(rollout, { downNodeIds, criticalAlertNodeIds });
        if (action === 'advance') {
          const gate = checkFleetV12RolloutGate(rollout, { criticalAlertNodeIds, downNodeIds, healthyNodeIds });
          if (!gate.allowed) {
            return okResult({ ok: false, gate, autoAction, error: 'gate blocked the advance — see gate checks' });
          }
        }
        const res = applyFleetV12RolloutAction(rollout, action, actorUserId, reason);
        if (!res.ok) return okResult({ ok: false, autoAction, error: res.error });
        saveFleetV12Rollouts(root, updateFleetV12Rollout(rollouts, res.rollout));
        return okResult({
          ok: true,
          rollout: res.rollout,
          progress: summarizeFleetV12Rollout(res.rollout),
          autoAction,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const rolloutStatusTool: Tool = {
    definition: toolDef(
      'fleet_rollout_status_v12',
      'List fleet v12 rollouts with progress per rollout (read-only). Pass rolloutId to get one rollout.',
      {
        rolloutId: { type: 'string', description: 'Optional rollout id (omit to list all).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const base = resolveBase();
        if (!base) return errorResult(NOT_WIRED);
        const root = fleetRoot(base);
        const rollouts = loadFleetV12Rollouts(root);
        const rolloutId = typeof args['rolloutId'] === 'string' ? args['rolloutId'] : '';
        if (rolloutId) {
          const rollout = findFleetV12Rollout(rollouts, rolloutId);
          if (!rollout) return errorResult(`rollout not found: ${rolloutId}`);
          return okResult({ rollout, progress: summarizeFleetV12Rollout(rollout) });
        }
        return okResult(
          rollouts.map((r) => ({ rollout: r, progress: summarizeFleetV12Rollout(r) })),
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const healthDashboardTool: Tool = {
    definition: toolDef(
      'fleet_health_dashboard_v12',
      'Build a fleet v12 health dashboard (per-node status + loaded model, alerts by rule, short-term history) from node samples. When wired, samples are recorded into the persisted health state (alert rules + cooldowns apply).',
      {
        nodes: { type: 'array', items: { type: 'object' }, description: 'Node samples: {nodeId, at?, cpuPct, ramPct, diskPct, uptimeMs?, lastHeartbeatAt?, botCount?, botCapacity?, loadedModelId?, modelStatus?, tokensPerSec?, pendingRequests?}.' },
        recordSamples: { type: 'boolean', description: 'Record the samples into the persisted health state (default false).' },
        now: { type: 'number', description: 'Evaluation time in epoch ms (default now).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const now = getNumberArg(args, 'now', Date.now());
        const samples = asNodeSamples(getObjectArrayArg(args, 'nodes'));
        const recordSamples = getBooleanArg(args, 'recordSamples', false);
        const base = resolveBase();
        let state = createFleetV12HealthState(now);
        if (base) {
          state = loadFleetV12HealthState(fleetRoot(base)) ?? state;
        }
        if (recordSamples && base) {
          const firedAll: unknown[] = [];
          const resolvedAll: unknown[] = [];
          for (const sample of samples) {
            const res = recordFleetV12Sample(state, sample, now);
            state = res.state;
            firedAll.push(...res.fired);
            resolvedAll.push(...res.resolved);
          }
          saveFleetV12HealthState(fleetRoot(base), state);
          const dashboard = buildFleetV12HealthDashboard(samples, state, now);
          return okResult({ dashboard, fired: firedAll, resolved: resolvedAll });
        }
        const dashboard = buildFleetV12HealthDashboard(samples, state, now);
        return okResult({ dashboard });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const aguiPanelTool: Tool = {
    definition: toolDef(
      'fleet_panel_agui_v12',
      'Build the AG-UI/A2UI panel view-model (run timeline, pending interrupts, generative surfaces) from an AG-UI event stream. Pure: works without the fleet tools wired.',
      {
        events: { type: 'array', items: { type: 'object' }, description: 'AG-UI events: {type, runId, botId?, sequence?, timestamp?, data?}.' },
        interruptDecision: { type: 'object', description: 'Optional interrupt decision to validate: {interruptId, decision: approve|reject, actor}.' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const panel = buildFleetV12AguiPanel(asAgUiEvents(getObjectArrayArg(args, 'events')));
        const decision = getObjectArg(args, 'interruptDecision');
        if (Object.keys(decision).length > 0) {
          const interruptId = typeof decision['interruptId'] === 'string' ? decision['interruptId'] : '';
          const dec = typeof decision['decision'] === 'string' ? decision['decision'] : '';
          const actor = typeof decision['actor'] === 'string' ? decision['actor'] : '';
          const validation = validateFleetV12InterruptDecision(panel, interruptId, dec, actor);
          return okResult({ panel, interruptValidation: validation });
        }
        return okResult({ panel });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const memoryRouterPanelTool: Tool = {
    definition: toolDef(
      'fleet_panel_memory_router_v12',
      'Build the memory v12 + router panel view-models (fact list, temporal KG view, quarantine counts, GDPR erasure plan, loaded models, RAM, routing decision log, budget/spend). Pure: works without the fleet tools wired.',
      {
        facts: { type: 'array', items: { type: 'object' }, description: 'Memory facts: {id, text, confidence, source, createdBy, createdAt, quarantined?, quarantineReason?}.' },
        entities: { type: 'array', items: { type: 'object' }, description: 'Temporal KG entities: {id, name, kind, validFrom?, validTo?, superseded?, supersededBy?, quarantined?}.' },
        relations: { type: 'array', items: { type: 'object' }, description: 'Temporal KG relations: {id, fromId, toId, label, validFrom?, validTo?, superseded?, quarantined?}.' },
        memoryFilter: { type: 'object', description: 'Optional memory filter: {query?, minConfidence?, source?, quarantined?: all|quarantined|clean}.' },
        gdprUserId: { type: 'string', description: 'Optional user id to plan a GDPR erasure for.' },
        quarantineReview: { type: 'object', description: 'Optional quarantine decision to validate: {factId, decision: restore|delete, actor}.' },
        routerModels: { type: 'array', items: { type: 'object' }, description: 'Router models: {modelId, kind: local|cloud, status, ramMb?, contextTokens?, requestsServed?, loadedAt?}.' },
        routingDecisions: { type: 'array', items: { type: 'object' }, description: 'Routing decision log: {at, taskKind, chosenModelId, reason, estimatedCostUsd?, latencyMs?}.' },
        ramLimitMb: { type: 'number', description: 'RAM limit for local models in MB (optional).' },
        budgetUsd: { type: 'number', description: 'Spend budget in USD (optional).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const facts = asMemoryFacts(getObjectArrayArg(args, 'facts'));
        const entities = asKgEntities(getObjectArrayArg(args, 'entities'));
        const relations = asKgRelations(getObjectArrayArg(args, 'relations'));
        const filterRaw = getObjectArg(args, 'memoryFilter');
        const memoryPanel = buildFleetV12MemoryPanel(facts, entities, relations, {
          query: typeof filterRaw['query'] === 'string' ? filterRaw['query'] : undefined,
          minConfidence: typeof filterRaw['minConfidence'] === 'number' ? filterRaw['minConfidence'] : undefined,
          source: typeof filterRaw['source'] === 'string' ? filterRaw['source'] : undefined,
          quarantined:
            filterRaw['quarantined'] === 'quarantined' || filterRaw['quarantined'] === 'clean'
              ? filterRaw['quarantined']
              : 'all',
        });
        const gdprUserId = typeof args['gdprUserId'] === 'string' ? args['gdprUserId'] : '';
        const erasure = gdprUserId
          ? planFleetV12GdprErasure(gdprUserId, facts, entities, relations)
          : null;
        const reviewRaw = getObjectArg(args, 'quarantineReview');
        let quarantineValidation = null;
        if (Object.keys(reviewRaw).length > 0) {
          const factId = typeof reviewRaw['factId'] === 'string' ? reviewRaw['factId'] : '';
          const fact = facts.find((f) => f.id === factId) ?? null;
          quarantineValidation = validateFleetV12QuarantineDecision(
            fact,
            typeof reviewRaw['decision'] === 'string' ? reviewRaw['decision'] : '',
            typeof reviewRaw['actor'] === 'string' ? reviewRaw['actor'] : '',
          );
        }
        const routerPanel = buildFleetV12RouterPanel(
          asRouterModels(getObjectArrayArg(args, 'routerModels')),
          asRoutingDecisions(getObjectArrayArg(args, 'routingDecisions')),
          {
            ramLimitMb: typeof args['ramLimitMb'] === 'number' ? args['ramLimitMb'] : undefined,
            budgetUsd: typeof args['budgetUsd'] === 'number' ? args['budgetUsd'] : undefined,
          },
        );
        return okResult({ memoryPanel, erasure, quarantineValidation, routerPanel });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  return [
    pinTool,
    verifyTool,
    pinsTool,
    rolloutCreateTool,
    rolloutActionTool,
    rolloutStatusTool,
    healthDashboardTool,
    aguiPanelTool,
    memoryRouterPanelTool,
  ];
}

export const FLEET_V12_TOOLS: Tool[] = createFleetV12Tools();
