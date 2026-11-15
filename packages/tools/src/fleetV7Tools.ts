/**
 * Fleet campaign v2 tools (v1.10, Đội T6) — registered in ALL_TOOLS
 * (see tools.ts).
 *
 * - `fleet_campaign_create` — tạo campaign v2: một mục tiêu chạy trên
 *   nhiều bot đặt trên nhiều node (máy) của fleet, theo chiến lược
 *   rollout canary → staged → full (hoặc staged-only / full-only).
 *   Lưu vào `<userData>/fleet/fleet-campaigns-v110.json`.
 * - `fleet_campaign_list` — liệt kê campaign v2 (tóm tắt: trạng thái,
 *   stage hiện tại, tiến độ, tỉ lệ thành công).
 * - `fleet_campaign_rollout` — advance sang stage kế khi cổng chất
 *   lượng mở (stage hiện tại xong hết bot, đạt tỉ lệ thành công tối
 *   thiểu, không vượt số fail tối đa, không có bot stage kế trên node
 *   offline). Cổng đóng thì trả lý do, không advance.
 * - `fleet_campaign_progress` — báo tiến độ một bot (0..100, trạng
 *   thái running/done/failed). Bot fail quá số lần thì failed hẳn và
 *   không tính vào cổng thành công nữa.
 * - `fleet_campaign_rollback` — lùi campaign về trước rollout: bot
 *   đang chạy/chờ ở stage hiện tại và stage sau về 'rolled-back',
 *   bot đã done giữ nguyên, snapshot ghi lại để báo cáo đọc được.
 * - `fleet_campaign_report` — báo cáo tổng hợp: theo trạng thái bot,
 *   theo stage, theo node, tỉ lệ thành công, thời gian chạy.
 * - `fleet_campaign_pause` / `fleet_campaign_resume` /
 *   `fleet_campaign_cancel` — tạm dừng / tiếp tục / huỷ campaign.
 * - `fleet_campaign_clone` — nhân bản campaign thành draft mới (cùng
 *   bot/node/stage/cổng, trạng thái chạy reset) để chạy lại đợt rollout.
 * - `fleet_campaign_plan` — kế hoạch rollout chỉ-đọc (dry-run): từng
 *   stage theo thứ tự + bot/node + cảnh báo node offline/draining/quá tải.
 * - `composio_mock_toolkit_list` — liệt kê 6 toolkit Composio MOCK
 *   v110 (figma/supabase/vercel/todoist/intercom/miro) + slug ứng viên của chúng.
 *   Chạy được ngay, không cần key — nhưng slug CHƯA xác nhận live.
 * - `composio_mock_toolkit_execute` — chạy một tool mock bằng dữ liệu
 *   mẫu local (không gọi mạng, không cần key). Response luôn mang
 *   `mock: true, live: false`.
 * - `provider_cerebras_models` — thông tin provider Cerebras mới
 *   (baseUrl, model mặc định, danh sách model fallback, Vault
 *   namespace). Không gọi mạng — model live lấy qua listModels()
 *   của provider khi có key.
 *
 * Như các tool fleet trước, 11 tool campaign là placeholder trong
 * ALL_TOOLS cho tới khi host bind: `createFleetV7Tools(getBaseDir)`
 * với userData dir của app. 3 tool còn lại (mock toolkit + cerebras
 * models) là hàm thuần — chạy được ngay cả khi chưa bind. Tool ghi
 * file cần approval; tool chỉ đọc thì không.
 */

import * as path from 'node:path';
import type { Tool } from '@open-bot/core';
import {
  CEREBRAS_BASE_URL,
  CEREBRAS_DEFAULT_MODEL,
  CEREBRAS_KNOWN_MODELS,
  COMPOSIO_V110_MOCK_TOOLKITS,
  MockComposioV110Executor,
  advanceFleetV7Rollout,
  cancelFleetV7Campaign,
  checkFleetV7AdvanceGate,
  cloneFleetV7Campaign,
  createFleetV7Campaign,
  findFleetV7Campaign,
  loadFleetV7Campaigns,
  mockComposioV110ToolNeedsApproval,
  pauseFleetV7Campaign,
  planFleetV7Rollout,
  reportFleetV7BotProgress,
  resumeFleetV7Campaign,
  rollbackFleetV7Campaign,
  saveFleetV7Campaigns,
  startFleetV7Campaign,
  summarizeFleetV7Campaign,
  type CreateFleetV7CampaignInput,
  type CreateFleetV7NodeInput,
  type FleetV7Campaign,
  type FleetV7Strategy,
} from '@open-bot/core';

export const FLEET_V7_TOOL_NAMES = [
  'fleet_campaign_create',
  'fleet_campaign_list',
  'fleet_campaign_rollout',
  'fleet_campaign_progress',
  'fleet_campaign_rollback',
  'fleet_campaign_report',
  'fleet_campaign_pause',
  'fleet_campaign_resume',
  'fleet_campaign_cancel',
  'fleet_campaign_clone',
  'fleet_campaign_plan',
  'composio_mock_toolkit_list',
  'composio_mock_toolkit_execute',
  'provider_cerebras_models',
] as const;

export function isFleetV7ToolName(name: string): boolean {
  return (FLEET_V7_TOOL_NAMES as readonly string[]).includes(name);
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

function getStringArrayArg(args: Record<string, unknown>, name: string, required = false): string[] {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return [];
  }
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings.`);
  }
  return [...(value as string[])];
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

const NOT_WIRED =
  'fleet v7 tools are not wired in this host (no userData dir configured) — open the fleet console UI instead.';

/** Fleet root derived from the app userData dir. */
function dirs(baseDir: string): { fleetRoot: string } {
  return { fleetRoot: path.join(baseDir, 'fleet') };
}

const FLEET_V7_STRATEGIES: FleetV7Strategy[] = ['canary-staged-full', 'staged-only', 'full-only'];

function parseBotsArg(args: Record<string, unknown>): { botId: string; nodeId: string }[] {
  const raw = getObjectArrayArg(args, 'bots', true);
  if (raw.length === 0) throw new Error('Argument "bots" must be a non-empty array.');
  return raw.map((entry, i) => {
    const botId = entry['botId'];
    const nodeId = entry['nodeId'];
    if (typeof botId !== 'string' || botId.trim().length === 0) {
      throw new Error(`bots[${i}].botId must be a non-empty string.`);
    }
    if (typeof nodeId !== 'string' || nodeId.trim().length === 0) {
      throw new Error(`bots[${i}].nodeId must be a non-empty string.`);
    }
    return { botId: botId.trim(), nodeId: nodeId.trim() };
  });
}

function parseNodesArg(args: Record<string, unknown>): CreateFleetV7NodeInput[] {
  const raw = getObjectArrayArg(args, 'nodes');
  return raw.map((entry, i) => {
    const id = entry['id'];
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new Error(`nodes[${i}].id must be a non-empty string.`);
    }
    const node: CreateFleetV7NodeInput = { id: id.trim() };
    if (entry['label'] !== undefined) {
      if (typeof entry['label'] !== 'string') throw new Error(`nodes[${i}].label must be a string.`);
      node.label = entry['label'];
    }
    if (entry['maxBots'] !== undefined) {
      if (entry['maxBots'] !== null && (typeof entry['maxBots'] !== 'number' || !Number.isInteger(entry['maxBots']))) {
        throw new Error(`nodes[${i}].maxBots must be null or an integer.`);
      }
      node.maxBots = entry['maxBots'] as number | null;
    }
    if (entry['status'] !== undefined) {
      if (entry['status'] !== 'online' && entry['status'] !== 'offline' && entry['status'] !== 'draining') {
        throw new Error(`nodes[${i}].status must be one of: online, offline, draining.`);
      }
      node.status = entry['status'] as 'online' | 'offline' | 'draining';
    }
    return node;
  });
}

function loadCampaignOrError(fleetRoot: string, campaignId: string): { campaigns: FleetV7Campaign[]; campaign: FleetV7Campaign } {
  const campaigns = loadFleetV7Campaigns(fleetRoot);
  const campaign = findFleetV7Campaign(campaigns, campaignId);
  if (!campaign) throw new Error(`Không có campaign v7 "${campaignId}".`);
  return { campaigns, campaign };
}

/**
 * Build the 14 fleet v7 tools. `getBaseDir` resolves the app userData
 * dir (null/undefined = unbound placeholders for the 11 file-backed
 * campaign tools; the 3 pure tools work unbound).
 */
export function createFleetV7Tools(
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

  const campaignCreateTool: Tool = {
    definition: toolDef(
      'fleet_campaign_create',
      'Create a fleet campaign v2: one goal run by many bots on many fleet nodes (machines), with a canary → staged → full rollout. Each stage only opens when the current stage passes its quality gate (min success rate, max failures, next-stage nodes online). Saved to <userData>/fleet/fleet-campaigns-v110.json.',
      {
        goal: { type: 'string', description: 'Campaign goal (non-empty).' },
        bots: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              botId: { type: 'string', description: 'Bot id.' },
              nodeId: { type: 'string', description: 'Node (machine) the bot runs on.' },
            },
            required: ['botId', 'nodeId'],
            additionalProperties: false,
          },
          description: 'Bots in rollout order (first bots are the canary).',
        },
        nodes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Node id.' },
              label: { type: 'string', description: 'Display label (default = id).' },
              maxBots: { type: 'number', description: 'Max bots on this node (null = unlimited).' },
              status: { type: 'string', enum: ['online', 'offline', 'draining'], description: 'Node status (default online).' },
            },
            required: ['id'],
            additionalProperties: false,
          },
          description: 'Optional explicit node declarations (nodes only seen via bots default to online).',
        },
        strategy: { type: 'string', enum: [...FLEET_V7_STRATEGIES], description: 'Rollout strategy (default canary-staged-full).' },
        canaryCount: { type: 'number', description: 'Canary bots (default 1; at least 1 and at least 10% of bots).' },
        stagedPercents: { type: 'array', items: { type: 'number' }, description: 'Staged milestones in % of total bots (default [25, 50, 75]).' },
        minSuccessRate: { type: 'number', description: 'Min success rate per stage, 0..1 (default 0.8).' },
        maxFailures: { type: 'number', description: 'Max failed bots per stage before the gate closes (default 1).' },
      },
      ['goal', 'bots'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const input: CreateFleetV7CampaignInput = {
          goal: getStringArg(args, 'goal'),
          bots: parseBotsArg(args),
        };
        const nodes = parseNodesArg(args);
        if (nodes.length > 0) input.nodes = nodes;
        const strategy = args['strategy'];
        if (strategy !== undefined && strategy !== null) {
          if (typeof strategy !== 'string' || !(FLEET_V7_STRATEGIES as readonly string[]).includes(strategy)) {
            throw new Error(`strategy phải là một trong: ${FLEET_V7_STRATEGIES.join(', ')}.`);
          }
          input.strategy = strategy as FleetV7Strategy;
        }
        if (args['canaryCount'] !== undefined && args['canaryCount'] !== null) {
          input.canaryCount = getNumberArg(args, 'canaryCount', 1);
        }
        if (args['stagedPercents'] !== undefined && args['stagedPercents'] !== null) {
          const percents = args['stagedPercents'];
          if (!Array.isArray(percents) || percents.some((p) => typeof p !== 'number')) {
            throw new Error('Argument "stagedPercents" must be an array of numbers.');
          }
          input.stagedPercents = [...(percents as number[])];
        }
        if (args['minSuccessRate'] !== undefined && args['minSuccessRate'] !== null) {
          input.minSuccessRate = getNumberArg(args, 'minSuccessRate', 0.8);
        }
        if (args['maxFailures'] !== undefined && args['maxFailures'] !== null) {
          input.maxFailures = getNumberArg(args, 'maxFailures', 1);
        }
        const campaigns = loadFleetV7Campaigns(fleetRoot);
        const campaign = createFleetV7Campaign(input);
        startFleetV7Campaign(campaign);
        campaigns.push(campaign);
        saveFleetV7Campaigns(fleetRoot, campaigns);
        return okResult({
          id: campaign.id,
          goal: campaign.goal,
          strategy: campaign.strategy,
          status: campaign.status,
          stages: campaign.stages.map((s) => ({ stage: s.stage, bots: s.botIds.length, botIds: s.botIds })),
          totalBots: campaign.assignments.length,
          nodes: campaign.nodes.length,
          note: 'Campaign created and started (stage canary active). Report bot progress with fleet_campaign_progress, then advance with fleet_campaign_rollout.',
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const campaignListTool: Tool = {
    definition: toolDef(
      'fleet_campaign_list',
      'List fleet campaign v2 summaries (status, current stage, progress %, success rate, per-stage bot counts).',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const campaigns = loadFleetV7Campaigns(fleetRoot);
        return okResult(
          campaigns.map((c) => {
            const report = summarizeFleetV7Campaign(c);
            return {
              id: report.id,
              goal: report.goal,
              strategy: report.strategy,
              status: report.status,
              currentStage: report.currentStage,
              totalBots: report.totalBots,
              done: report.done,
              failed: report.failed,
              running: report.running,
              pending: report.pending,
              rolledBack: report.rolledBack,
              progressPercent: report.progressPercent,
              successRate: report.successRate,
              stages: report.stages.map((s) => ({ stage: s.stage, status: s.status, bots: s.botIds.length })),
            };
          }),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const campaignRolloutTool: Tool = {
    definition: toolDef(
      'fleet_campaign_rollout',
      'Advance a fleet campaign v2 to the next rollout stage (canary → staged → full). The gate must pass: current stage finished all bots, success rate >= minSuccessRate, failures <= maxFailures, next-stage nodes online. A closed gate returns the reason instead of advancing.',
      {
        campaignId: { type: 'string', description: 'Campaign id.' },
      },
      ['campaignId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const campaignId = getStringArg(args, 'campaignId');
        const { campaigns, campaign } = loadCampaignOrError(fleetRoot, campaignId);
        const gate = checkFleetV7AdvanceGate(campaign);
        if (!gate.pass) {
          return okResult({ advanced: false, campaignId, reason: gate.reason, gate });
        }
        const result = advanceFleetV7Rollout(campaign);
        saveFleetV7Campaigns(fleetRoot, campaigns);
        return okResult({ advanced: true, campaignId, stage: result.stage, warnings: result.warnings });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const campaignProgressTool: Tool = {
    definition: toolDef(
      'fleet_campaign_progress',
      'Report one bot\'s progress in a fleet campaign v2 (0..100, status running/done/failed). First report moves the bot pending → running; done sets progress to 100; failed requeues the bot until maxAttempts, then marks it failed.',
      {
        campaignId: { type: 'string', description: 'Campaign id.' },
        botId: { type: 'string', description: 'Bot id.' },
        progressPercent: { type: 'number', description: 'Progress 0..100.' },
        status: { type: 'string', enum: ['running', 'done', 'failed'], description: 'New status (default: keep running).' },
        note: { type: 'string', description: 'Optional note recorded in history.' },
        error: { type: 'string', description: 'Error text when status=failed.' },
        maxAttempts: { type: 'number', description: 'Max fail attempts before the bot is failed for good (default 3).' },
      },
      ['campaignId', 'botId', 'progressPercent'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const campaignId = getStringArg(args, 'campaignId');
        const botId = getStringArg(args, 'botId');
        const progressPercent = getNumberArg(args, 'progressPercent', 0);
        const { campaigns, campaign } = loadCampaignOrError(fleetRoot, campaignId);
        const status = args['status'];
        if (status !== undefined && status !== null && status !== 'running' && status !== 'done' && status !== 'failed') {
          throw new Error('status phải là một trong: running, done, failed.');
        }
        const assignment = reportFleetV7BotProgress(campaign, botId, {
          progressPercent,
          ...(status !== undefined && status !== null ? { status: status as 'running' | 'done' | 'failed' } : {}),
          ...(args['note'] !== undefined && args['note'] !== null ? { note: String(args['note']) } : {}),
          ...(args['error'] !== undefined && args['error'] !== null ? { error: String(args['error']) } : {}),
          ...(args['maxAttempts'] !== undefined && args['maxAttempts'] !== null
            ? { maxAttempts: getNumberArg(args, 'maxAttempts', 3) }
            : {}),
        });
        saveFleetV7Campaigns(fleetRoot, campaigns);
        return okResult({
          campaignId,
          botId: assignment.botId,
          status: assignment.status,
          progressPercent: assignment.progressPercent,
          attempts: assignment.attempts,
          campaignStatus: campaign.status,
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const campaignRollbackTool: Tool = {
    definition: toolDef(
      'fleet_campaign_rollback',
      'Roll back a fleet campaign v2: bots still running/pending in the current and later stages go to rolled-back, finished bots stay done, and a snapshot is recorded for the report. The campaign becomes rolled-back and cannot advance afterwards.',
      {
        campaignId: { type: 'string', description: 'Campaign id.' },
        reason: { type: 'string', description: 'Why the campaign is rolled back (non-empty, recorded in history + snapshot).' },
      },
      ['campaignId', 'reason'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const campaignId = getStringArg(args, 'campaignId');
        const reason = getStringArg(args, 'reason');
        const { campaigns, campaign } = loadCampaignOrError(fleetRoot, campaignId);
        const result = rollbackFleetV7Campaign(campaign, reason);
        saveFleetV7Campaigns(fleetRoot, campaigns);
        return okResult({
          campaignId,
          status: campaign.status,
          rolledBackBots: result.rolledBackBots,
          keptDoneBots: result.keptDoneBots,
          snapshotAt: result.snapshot.at,
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const campaignReportTool: Tool = {
    definition: toolDef(
      'fleet_campaign_report',
      'Aggregate report for a fleet campaign v2: bot counts by status, per-stage breakdown (success rate, gate), per-node breakdown, overall progress %, elapsed time, rollback count.',
      {
        campaignId: { type: 'string', description: 'Campaign id.' },
      },
      ['campaignId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const campaignId = getStringArg(args, 'campaignId');
        const { campaign } = loadCampaignOrError(fleetRoot, campaignId);
        return okResult(summarizeFleetV7Campaign(campaign));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const campaignPauseTool: Tool = {
    definition: toolDef(
      'fleet_campaign_pause',
      'Pause an active fleet campaign v2 (bots keep their current status — the host decides whether to stop running bots).',
      {
        campaignId: { type: 'string', description: 'Campaign id.' },
      },
      ['campaignId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const campaignId = getStringArg(args, 'campaignId');
        const { campaigns, campaign } = loadCampaignOrError(fleetRoot, campaignId);
        pauseFleetV7Campaign(campaign);
        saveFleetV7Campaigns(fleetRoot, campaigns);
        return okResult({ campaignId, status: campaign.status });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const campaignResumeTool: Tool = {
    definition: toolDef(
      'fleet_campaign_resume',
      'Resume a paused fleet campaign v2.',
      {
        campaignId: { type: 'string', description: 'Campaign id.' },
      },
      ['campaignId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const campaignId = getStringArg(args, 'campaignId');
        const { campaigns, campaign } = loadCampaignOrError(fleetRoot, campaignId);
        resumeFleetV7Campaign(campaign);
        saveFleetV7Campaigns(fleetRoot, campaigns);
        return okResult({ campaignId, status: campaign.status });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const campaignCancelTool: Tool = {
    definition: toolDef(
      'fleet_campaign_cancel',
      'Cancel a fleet campaign v2 (draft/active/paused). Pending/running bots become skipped; finished bots stay as they are.',
      {
        campaignId: { type: 'string', description: 'Campaign id.' },
        note: { type: 'string', description: 'Optional reason recorded in history.' },
      },
      ['campaignId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const campaignId = getStringArg(args, 'campaignId');
        const { campaigns, campaign } = loadCampaignOrError(fleetRoot, campaignId);
        cancelFleetV7Campaign(
          campaign,
          Date.now(),
          args['note'] !== undefined && args['note'] !== null ? String(args['note']) : undefined,
        );
        saveFleetV7Campaigns(fleetRoot, campaigns);
        return okResult({ campaignId, status: campaign.status });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const campaignCloneTool: Tool = {
    definition: toolDef(
      'fleet_campaign_clone',
      'Clone a fleet campaign v2 into a new draft campaign with the same goal (or a new goal), bots, nodes, stages and gates — but all run state reset, so the same rollout can run again.',
      {
        campaignId: { type: 'string', description: 'Campaign id to clone.' },
        goal: { type: 'string', description: 'Goal for the clone (default: same goal).' },
      },
      ['campaignId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const campaignId = getStringArg(args, 'campaignId');
        const { campaigns, campaign } = loadCampaignOrError(fleetRoot, campaignId);
        const goal = args['goal'];
        if (goal !== undefined && goal !== null && (typeof goal !== 'string' || goal.trim().length === 0)) {
          throw new Error('Argument "goal" must be a non-empty string.');
        }
        const cloned = cloneFleetV7Campaign(
          campaign,
          Date.now(),
          typeof goal === 'string' ? goal : undefined,
        );
        campaigns.push(cloned);
        saveFleetV7Campaigns(fleetRoot, campaigns);
        return okResult({
          id: cloned.id,
          clonedFrom: campaignId,
          goal: cloned.goal,
          strategy: cloned.strategy,
          status: cloned.status,
          totalBots: cloned.assignments.length,
          stages: cloned.stages.map((s) => ({ stage: s.stage, bots: s.botIds.length })),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const campaignPlanTool: Tool = {
    definition: toolDef(
      'fleet_campaign_plan',
      'Dry-run rollout plan for a fleet campaign v2: each stage in run order with its bots and nodes, plus warnings (offline/draining/overloaded nodes). Read-only — changes nothing.',
      {
        campaignId: { type: 'string', description: 'Campaign id.' },
      },
      ['campaignId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const campaignId = getStringArg(args, 'campaignId');
        const { campaign } = loadCampaignOrError(fleetRoot, campaignId);
        return okResult(planFleetV7Rollout(campaign));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const composioMockListTool: Tool = {
    definition: toolDef(
      'composio_mock_toolkit_list',
      'List the 4 Composio MOCK toolkits v110 (figma, supabase, vercel, todoist) with their candidate tool slugs. Mock-only: no live Composio call, no API key needed. Candidate slugs are NOT live-verified — verify against the live Composio catalog before enabling live.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      try {
        return okResult(
          COMPOSIO_V110_MOCK_TOOLKITS.map((t) => ({
            slug: t.slug,
            label: t.label,
            icon: t.icon,
            description: t.description,
            mockOnly: t.mockOnly,
            liveVerified: t.liveVerified,
            toolSlugs: [...t.candidateToolSlugs],
            needsApprovalBySlug: Object.fromEntries(
              t.candidateToolSlugs.map((slug) => [slug, mockComposioV110ToolNeedsApproval(slug)]),
            ),
          })),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const composioMockExecuteTool: Tool = {
    definition: toolDef(
      'composio_mock_toolkit_execute',
      'Execute one Composio MOCK toolkit tool (figma/supabase/vercel/todoist/intercom/miro) with local sample data. No network, no API key. The response always carries mock: true, live: false. Write tools need approval; read tools do not.',
      {
        slug: { type: 'string', description: 'Candidate tool slug, e.g. FIGMA_GET_FILE.' },
        args: { type: 'object', description: 'Tool arguments (echoed back in the mock response).' },
      },
      ['slug'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const slug = getStringArg(args, 'slug');
        const rawArgs = args['args'];
        if (rawArgs !== undefined && rawArgs !== null && (typeof rawArgs !== 'object' || Array.isArray(rawArgs))) {
          throw new Error('Argument "args" must be an object.');
        }
        const executor = new MockComposioV110Executor();
        const result = executor.execute(slug, (rawArgs ?? {}) as Record<string, unknown>);
        return okResult(result);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const providerCerebrasModelsTool: Tool = {
    definition: toolDef(
      'provider_cerebras_models',
      'Cerebras provider info: base URL, default model, known-model fallback list, Vault namespace. No network call — the live model list comes from the provider listModels() when a key is configured.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      try {
        return okResult({
          id: 'cerebras',
          label: 'Cerebras',
          baseUrl: CEREBRAS_BASE_URL,
          defaultModel: CEREBRAS_DEFAULT_MODEL,
          knownModels: [...CEREBRAS_KNOWN_MODELS],
          needsKey: true,
          vaultNamespace: 'provider',
          vaultKey: 'cerebras',
          liveModelsNote:
            'Known models are a fallback only (public catalog Nov 2026: gpt-oss-120b + qwen-3.8-27b; the catalog rotates). listModels() returns the live /v1/models catalog when the endpoint answers.',
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    campaignCreateTool,
    campaignListTool,
    campaignRolloutTool,
    campaignProgressTool,
    campaignRollbackTool,
    campaignReportTool,
    campaignPauseTool,
    campaignResumeTool,
    campaignCancelTool,
    campaignCloneTool,
    campaignPlanTool,
    composioMockListTool,
    composioMockExecuteTool,
    providerCerebrasModelsTool,
  ];
}

/**
 * All fourteen are placeholders in ALL_TOOLS until the host binds them —
 * the 11 file-backed campaign tools answer NOT_WIRED, the 3 pure tools
 * (mock toolkit list/execute, cerebras models) already work.
 */
export const FLEET_V7_TOOLS: Tool[] = createFleetV7Tools();
