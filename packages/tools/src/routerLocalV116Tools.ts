/**
 * Router local v116 tools (v1.39, Doi T3) — registered in ALL_TOOLS
 * (see tools.ts).
 *
 * 11 tools (ham thuan tren state in-memory mac dinh; host co the
 * truyen state rieng qua createRouterLocalV116Tools):
 * - `router_local_score_rank` — xep hang model theo profile scoring
 *   (balanced/cost-first/latency-first/quality-first/privacy-first/
 *   custom) kem ly do tung ung vien + log quyet dinh.
 * - `router_local_policy_profile_list` — liet ke cac scoring profile.
 * - `router_local_policy_profile_set` — dat profile scoring hien hanh.
 * - `router_local_fallback_run` — chay fallback chain qua cac endpoint
 *   local (probe health tung endpoint theo thu tu, breaker ghi loi).
 * - `router_local_fallback_status` — trang thai circuit breaker cac model/endpoint.
 * - `router_local_cli_sources_list` — liet ke CLI agent da phat hien
 *   (18 CLI: 12 cu + 6 moi V116) kem nhan tai khoan + trang thai bat/tat.
 * - `router_local_cli_source_detect` — quet lai CLI agent tren may.
 * - `router_local_cli_source_set` — bat/tat mot nguon CLI (opt-in).
 * - `router_local_batch_estimate` — uoc tinh continuous batching
 *   (TTFT/throughput/KV/nut that) cho mot batch request.
 * - `router_local_batch_schedule` — xep lich hang doi request thanh batch.
 * - `router_local_health_probe` — probe suc khoe endpoint local
 *   (chi loopback) + lich su uptime.
 * - `router_local_picker_list` — danh sach model cho UI picker: local
 *   + cloud + CLI sources, kem nhan tai khoan + co dung duoc khong.
 * - `router_local_decision_log` — lich su quyet dinh route gan nhat
 *   (de audit vi sao model A thang model B).
 *
 * Khong goi model that, khong doc/gui credential: CLI detect chi hoi
 * chinh CLI bang lenh status cua no; health probe chi GET loopback
 * khong auth; fallback executor mac dinh la probe health.
 */

import type { Tool } from '@open-bot/core';
import {
  BatchScheduler,
  CliSourceRegistry,
  LocalEndpointHealthHistory,
  LocalFallbackChain,
  ScoringPolicyV116,
  buildPickerEntries,
  cliSourceModelId,
  compareBatchVsSolo,
  estimateBatch,
  getRoutingProfile,
  isCliSourceV116Kind,
  parseVllmMetrics,
  probeEndpoints,
  probeLocalEndpoint,
  probeVllmMetrics,
  rankCandidatesV116,
  summarizePicker,
  ROUTING_PROFILES,
  type BatchRequest,
  type ContinuousBatchingConfig,
  type RoutingProfileId,
  type RouterTask,
  type RouterWeights,
  type RouteCandidate,
} from '@open-bot/core';

export const ROUTER_LOCAL_V116_TOOL_NAMES = [
  'router_local_score_rank',
  'router_local_policy_profile_list',
  'router_local_policy_profile_set',
  'router_local_fallback_run',
  'router_local_fallback_status',
  'router_local_cli_sources_list',
  'router_local_cli_source_detect',
  'router_local_cli_source_set',
  'router_local_batch_estimate',
  'router_local_batch_schedule',
  'router_local_health_probe',
  'router_local_picker_list',
  'router_local_decision_log',
] as const;

export function isRouterLocalV116ToolName(name: string): boolean {
  return (ROUTER_LOCAL_V116_TOOL_NAMES as readonly string[]).includes(name);
}

/** State dung chung cua bo tool (host co the truyen state rieng). */
export interface RouterLocalV116State {
  scoring: ScoringPolicyV116;
  fallback: LocalFallbackChain;
  cli: CliSourceRegistry;
  batching: BatchScheduler;
  health: LocalEndpointHealthHistory;
}

export function createDefaultRouterLocalV116State(): RouterLocalV116State {
  return {
    scoring: new ScoringPolicyV116(),
    fallback: new LocalFallbackChain(),
    cli: new CliSourceRegistry(),
    batching: new BatchScheduler(),
    health: new LocalEndpointHealthHistory(),
  };
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

function getOptionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getNumberArg(args: Record<string, unknown>, name: string, required = true, fallback = 0): number {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return fallback;
  }
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`Argument "${name}" must be a number, got ${typeof value}`);
  }
  return value;
}

function getBoolArg(args: Record<string, unknown>, name: string, fallback = false): boolean {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean, got ${typeof value}`);
  }
  return value;
}

function getStringArrayArg(args: Record<string, unknown>, name: string, required = true): string[] {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return [];
  }
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings.`);
  }
  return value as string[];
}

const TASK_KINDS: readonly string[] = [
  'simple-chat', 'code', 'reasoning', 'research', 'creative', 'howto', 'summarize', 'translate',
];

const PROFILE_IDS: readonly string[] = [
  'balanced', 'cost-first', 'latency-first', 'quality-first', 'privacy-first', 'custom',
];

function taskFromArgs(args: Record<string, unknown>): RouterTask {
  const kind = getStringArg(args, 'kind');
  if (!TASK_KINDS.includes(kind)) {
    throw new Error(`kind phai la mot trong: ${TASK_KINDS.join(', ')}.`);
  }
  return {
    kind: kind as RouterTask['kind'],
    promptTokens: getNumberArg(args, 'promptTokens', false, 0),
    needsToolUse: getBoolArg(args, 'needsToolUse', false),
    needsLongContext: getBoolArg(args, 'needsLongContext', false),
    qualityNeed: getNumberArg(args, 'qualityNeed', false, 0.5),
    manualModelId: getOptionalStringArg(args, 'manualModelId'),
  };
}

function parseBatchRequests(args: Record<string, unknown>): BatchRequest[] {
  const raw = args.requests;
  if (!Array.isArray(raw)) throw new Error('Argument "requests" must be an array.');
  if (raw.length === 0) throw new Error('Argument "requests" khong duoc rong.');
  if (raw.length > 512) throw new Error('Toi da 512 request moi lan goi.');
  return raw.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`requests[${index}] phai la object.`);
    }
    const r = item as Record<string, unknown>;
    const promptTokens = r.promptTokens;
    const expectedCompletionTokens = r.expectedCompletionTokens;
    if (typeof promptTokens !== 'number' || promptTokens < 0) {
      throw new Error(`requests[${index}].promptTokens phai la so >= 0.`);
    }
    if (typeof expectedCompletionTokens !== 'number' || expectedCompletionTokens < 0) {
      throw new Error(`requests[${index}].expectedCompletionTokens phai la so >= 0.`);
    }
    const priority = r.priority;
    if (priority !== undefined && (typeof priority !== 'number' || Number.isNaN(priority))) {
      throw new Error(`requests[${index}].priority phai la so.`);
    }
    const arrivedAt = r.arrivedAt;
    if (arrivedAt !== undefined && (typeof arrivedAt !== 'number' || Number.isNaN(arrivedAt))) {
      throw new Error(`requests[${index}].arrivedAt phai la so.`);
    }
    return {
      id: typeof r.id === 'string' && r.id ? r.id : `req-${index}`,
      promptTokens,
      expectedCompletionTokens,
      priority: typeof priority === 'number' ? priority : 0,
      arrivedAt: typeof arrivedAt === 'number' ? arrivedAt : undefined,
    };
  });
}

function batchingConfigFromArgs(
  args: Record<string, unknown>,
  base: ContinuousBatchingConfig,
): ContinuousBatchingConfig {
  const config: ContinuousBatchingConfig = { ...base };
  const maxNumSeqs = args.maxNumSeqs;
  if (maxNumSeqs !== undefined) {
    if (typeof maxNumSeqs !== 'number' || maxNumSeqs < 1) throw new Error('maxNumSeqs phai la so >= 1.');
    config.maxNumSeqs = Math.floor(maxNumSeqs);
  }
  const kvCacheGB = args.kvCacheGB;
  if (kvCacheGB !== undefined) {
    if (typeof kvCacheGB !== 'number' || kvCacheGB < 0) throw new Error('kvCacheGB phai la so >= 0.');
    config.kvCacheBytes = Math.floor(kvCacheGB * 1024 * 1024 * 1024);
  }
  const maxModelLen = args.maxModelLen;
  if (maxModelLen !== undefined) {
    if (typeof maxModelLen !== 'number' || maxModelLen < 1) throw new Error('maxModelLen phai la so >= 1.');
    config.maxModelLen = Math.floor(maxModelLen);
  }
  return config;
}

export function createRouterLocalV116Tools(state: RouterLocalV116State = createDefaultRouterLocalV116State()): Tool[] {
  const { scoring, fallback, cli, batching, health } = state;

  const scoreRankTool: Tool = {
    definition: toolDef(
      'router_local_score_rank',
      'Rank local/cloud models for a task with a configurable scoring profile (balanced/cost-first/latency-first/quality-first/privacy-first/custom). Returns the full ranking with per-candidate reasons and a decision log id.',
      {
        kind: { type: 'string', description: 'Task kind: simple-chat, code, reasoning, research, creative, howto, summarize, translate.' },
        promptTokens: { type: 'number', description: 'Estimated prompt tokens.' },
        needsToolUse: { type: 'boolean', description: 'Whether the task needs tool-use.' },
        needsLongContext: { type: 'boolean', description: 'Whether the task needs >32k context.' },
        qualityNeed: { type: 'number', description: 'Required quality 0..1.' },
        manualModelId: { type: 'string', description: 'Manual model override.' },
        profileId: { type: 'string', description: 'Scoring profile id (default: current profile).' },
        customCost: { type: 'number', description: 'Custom weight for cost (only with profileId=custom).' },
        customLatency: { type: 'number', description: 'Custom weight for latency (only with profileId=custom).' },
        customQuality: { type: 'number', description: 'Custom weight for quality (only with profileId=custom).' },
        loadedModelIds: { type: 'array', items: { type: 'string' }, description: 'Local model ids currently loaded.' },
        availableRamGB: { type: 'number', description: 'Free RAM available for models in GB (default 8).' },
        includeCliSources: { type: 'boolean', description: 'Include enabled CLI-agent sources as routable models (default false).' },
      },
      ['kind'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const task = taskFromArgs(args);
        const profileId = getOptionalStringArg(args, 'profileId');
        if (profileId && !PROFILE_IDS.includes(profileId)) {
          return errorResult(`profileId phai la mot trong: ${PROFILE_IDS.join(', ')}.`);
        }
        let profile = scoring.getProfile();
        if (profileId) {
          const customWeights: RouterWeights | undefined = profileId === 'custom'
            ? {
              cost: getNumberArg(args, 'customCost', false, 0.4),
              latency: getNumberArg(args, 'customLatency', false, 0.3),
              quality: getNumberArg(args, 'customQuality', false, 0.3),
            }
            : undefined;
          profile = getRoutingProfile(profileId as RoutingProfileId, customWeights);
        }
        const loadedModelIds = new Set<string>(
          args.loadedModelIds === undefined ? [] : getStringArrayArg(args, 'loadedModelIds', false),
        );
        const availableRamGB = getNumberArg(args, 'availableRamGB', false, 8);
        if (availableRamGB < 0) return errorResult('availableRamGB khong duoc am.');
        const candidates = scoring.buildCandidates(task, {
          loadedModelIds,
          availableRamBytes: availableRamGB * 1024 * 1024 * 1024,
        });
        if (getBoolArg(args, 'includeCliSources', false)) {
          for (const m of cli.routableModels()) candidates.push(m);
        }
        const ranked = rankCandidatesV116(candidates, task, profile, scoring.getConfig());
        // Chon theo decide() (giu luat V115: task nhe -> local, nang ->
        // cloud, override) — bang `ranked` chi la bang diem thuan de
        // giai thich. `reason` va `decisionLogId` cung tu decide() nen
        // chosen/reason/log luon nhat quan voi nhau. Truyen profile
        // duoc yeu cau vao decide() de ca bang xep hang lan quyet
        // dinh deu dung cung mot profile.
        const log = scoring.decide(task, { loadedModelIds, availableRamBytes: availableRamGB * 1024 * 1024 * 1024 }, profile, candidates);
        return okResult({
          profile: profile.id,
          weights: profile.weights,
          chosen: log.chosen,
          fallbacks: log.fallbacks,
          ranked: ranked.map((c) => ({
            modelId: c.modelId,
            kind: c.kind,
            score: +c.score.toFixed(4),
            excluded: c.excluded,
            breakdown: c.breakdown,
            reasons: c.reasons,
          })),
          reason: log.reason,
          decisionLogId: log.id,
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const profileListTool: Tool = {
    definition: toolDef(
      'router_local_policy_profile_list',
      'List the available scoring profiles (weights, description, local-only flag, min quality).',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      try {
        const profiles = Object.values(ROUTING_PROFILES).map((p) => ({
          id: p.id,
          label: p.label,
          description: p.description,
          weights: p.weights,
          localOnly: p.localOnly ?? false,
          minQuality: p.minQuality ?? 0,
          kindOverrides: Object.keys(p.kindOverrides ?? {}),
        }));
        return okResult({ current: scoring.getProfile().id, profiles });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const profileSetTool: Tool = {
    definition: toolDef(
      'router_local_policy_profile_set',
      'Set the active scoring profile. For profileId=custom, pass customCost/customLatency/customQuality weights (normalized to sum 1).',
      {
        profileId: { type: 'string', description: 'Profile id: balanced, cost-first, latency-first, quality-first, privacy-first, custom.' },
        customCost: { type: 'number', description: 'Custom weight for cost.' },
        customLatency: { type: 'number', description: 'Custom weight for latency.' },
        customQuality: { type: 'number', description: 'Custom weight for quality.' },
      },
      ['profileId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const profileId = getStringArg(args, 'profileId');
        if (!PROFILE_IDS.includes(profileId)) {
          return errorResult(`profileId phai la mot trong: ${PROFILE_IDS.join(', ')}.`);
        }
        const customWeights: RouterWeights | undefined = profileId === 'custom'
          ? {
            cost: getNumberArg(args, 'customCost', false, 0.4),
            latency: getNumberArg(args, 'customLatency', false, 0.3),
            quality: getNumberArg(args, 'customQuality', false, 0.3),
          }
          : undefined;
        const profile = scoring.setProfile(profileId as RoutingProfileId, customWeights);
        return okResult({ current: profile.id, label: profile.label, weights: profile.weights, description: profile.description });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const fallbackRunTool: Tool = {
    definition: toolDef(
      'router_local_fallback_run',
      'Run a fallback chain across local endpoints in order: probe each endpoint health (loopback only), first healthy endpoint wins; failures are recorded on its circuit breaker and skipped while open.',
      {
        endpoints: { type: 'array', items: { type: 'string' }, description: 'Endpoint base URLs in fallback order, e.g. ["http://127.0.0.1:11434", "http://127.0.0.1:8000"].' },
        timeoutMs: { type: 'number', description: 'Probe timeout per endpoint in ms (default 3000).' },
      },
      ['endpoints'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const endpoints = getStringArrayArg(args, 'endpoints');
        if (endpoints.length === 0) return errorResult('endpoints khong duoc rong.');
        if (endpoints.length > 8) return errorResult('Toi da 8 endpoint moi lan goi.');
        const timeoutMs = getNumberArg(args, 'timeoutMs', false, 3000);
        if (timeoutMs <= 0) return errorResult('timeoutMs phai > 0.');
        const candidates: RouteCandidate[] = endpoints.map((url) => ({
          kind: 'local',
          modelId: url,
          costPer1kTokensUsd: 0,
          estLatencyMs: 0,
          quality: 0,
        }));
        const result = await fallback.attempt(candidates, async (candidate) => {
          const probe = await probeLocalEndpoint(candidate.modelId, { timeoutMs });
          health.record(probe);
          if (probe.status !== 'healthy') {
            throw new Error(probe.error ?? `Endpoint ${candidate.modelId} khong healthy (${probe.status}).`);
          }
          return probe;
        });
        return okResult({
          succeeded: result.succeeded,
          endpoint: result.modelId,
          attempts: result.attempts,
          totalLatencyMs: result.totalLatencyMs,
          breakers: fallback.breakerSnapshots(),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const fallbackStatusTool: Tool = {
    definition: toolDef(
      'router_local_fallback_status',
      'Show fallback chain config and circuit breaker state per endpoint/model (closed/open/half-open, failures, next retry).',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      try {
        return okResult({
          config: fallback.getConfig(),
          breakers: fallback.breakerSnapshots(),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const cliListTool: Tool = {
    definition: toolDef(
      'router_local_cli_sources_list',
      'List detected CLI-agent sources (Claude Code, Codex, OpenCode, Gemini CLI, Aider, Cursor CLI, Continue, Crush, Goose, Qwen Code, Amp, Factory Droid, Pi, ...) with install status, account label and enabled state. No credentials are read or shown.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      try {
        const snapshot = cli.snapshot();
        const sources = cli.listSources().map((s) => ({
          ...s,
          modelId: cliSourceModelId(s.kind),
          describe: cli.describeSource(s.kind),
        }));
        return okResult({
          detectedAt: snapshot?.detectedAt ?? null,
          detected: snapshot !== null,
          total: sources.length,
          newInV116: sources.filter((s) => isCliSourceV116Kind(s.kind)).length,
          usable: sources.filter((s) => s.usable).length,
          sources,
          note: snapshot === null
            ? 'Chua quet — goi router_local_cli_source_detect de quet CLI tren may.'
            : 'Chi nhan (ten, version, nhan tai khoan) — khong doc/gui credential.',
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const cliDetectTool: Tool = {
    definition: toolDef(
      'router_local_cli_source_detect',
      'Re-scan the machine for CLI agents (PATH binaries + version + login check via each CLI own status command). New V116 CLIs (Crush, Goose, Qwen Code, Amp, Factory Droid, Pi) report status unknown until their login check is verified.',
      {
        force: { type: 'boolean', description: 'Force a fresh scan, ignoring the 60s cache (default false).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const force = getBoolArg(args, 'force', false);
        const snapshot = await cli.detect(force);
        const sources = cli.listSources();
        return okResult({
          detectedAt: snapshot.detectedAt,
          total: sources.length,
          available: sources.filter((s) => s.status === 'available').length,
          unknown: sources.filter((s) => s.status === 'unknown').length,
          unavailable: sources.filter((s) => s.status === 'unavailable').length,
          usable: sources.filter((s) => s.usable).map((s) => s.kind),
          sources: sources.map((s) => ({
            kind: s.kind,
            label: s.label,
            status: s.status,
            reason: s.reason,
            accountLabel: s.accountLabel,
            enabled: s.enabled,
            usable: s.usable,
            isNewInV116: s.isNewInV116,
          })),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const cliSetTool: Tool = {
    definition: toolDef(
      'router_local_cli_source_set',
      'Enable or disable one CLI-agent source (opt-in, default off). A disabled source never appears in the picker and is never routed to, even if installed and signed in.',
      {
        kind: { type: 'string', description: 'CLI source kind, e.g. codex, claude, crush, goose.' },
        enabled: { type: 'boolean', description: 'true = enable, false = disable.' },
      },
      ['kind', 'enabled'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const kind = getStringArg(args, 'kind');
        const enabled = getBoolArg(args, 'enabled');
        cli.setEnabled(kind, enabled);
        const source = cli.getSource(kind);
        return okResult({
          kind,
          enabled,
          usable: source?.usable ?? false,
          describe: cli.describeSource(kind),
          note: enabled
            ? 'Nguon da bat — chi dung duoc khi CLI da cai + da dang nhap (hoac status unknown doi voi CLI moi V116).'
            : 'Nguon da tat — router se khong dung CLI nay nua.',
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const batchEstimateTool: Tool = {
    definition: toolDef(
      'router_local_batch_estimate',
      'Estimate continuous batching (vLLM-style) for a batch of requests: average/max TTFT, total duration, throughput, KV cache use and bottleneck (prefill/decode/KV), plus batch-vs-solo speedup.',
      {
        requests: { type: 'array', items: { type: 'object' }, description: 'Requests: [{id?, promptTokens, expectedCompletionTokens, priority?}].' },
        maxNumSeqs: { type: 'number', description: 'Max concurrent sequences (default 32).' },
        kvCacheGB: { type: 'number', description: 'KV cache size in GB (default 8).' },
        maxModelLen: { type: 'number', description: 'Max model length in tokens (default 32768).' },
        queueWaitMs: { type: 'number', description: 'Queue wait before the batch starts in ms (default 0).' },
      },
      ['requests'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const requests = parseBatchRequests(args);
        const config = batchingConfigFromArgs(args, batching.getConfig());
        const queueWaitMs = getNumberArg(args, 'queueWaitMs', false, 0);
        if (queueWaitMs < 0) return errorResult('queueWaitMs khong duoc am.');
        const estimate = estimateBatch(requests, config, queueWaitMs);
        const comparison = compareBatchVsSolo(requests, config);
        return okResult({
          estimate: {
            batchSize: estimate.batchSize,
            avgTtftMs: Math.round(estimate.avgTtftMs),
            maxTtftMs: Math.round(estimate.maxTtftMs),
            totalDurationMs: Math.round(estimate.totalDurationMs),
            throughputTokensPerSec: Math.round(estimate.throughputTokensPerSec),
            kvCacheBytesUsed: estimate.kvCacheBytesUsed,
            kvCacheUtilization: +estimate.kvCacheUtilization.toFixed(3),
            bottleneck: estimate.bottleneck,
            overCapacity: estimate.overCapacity,
            notes: estimate.notes,
            perRequest: estimate.perRequest.map((r) => ({
              id: r.id,
              ttftMs: Math.round(r.ttftMs),
              completionMs: Math.round(r.completionMs),
              finishMs: Math.round(r.finishMs),
            })),
          },
          vsSolo: {
            soloTotalMs: Math.round(comparison.soloTotalMs),
            speedup: +comparison.speedup.toFixed(2),
            savedMs: Math.round(comparison.savedMs),
          },
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const batchScheduleTool: Tool = {
    definition: toolDef(
      'router_local_batch_schedule',
      'Schedule a queue of requests into continuous-batching batches (FIFO or short-job-first), each with its own time estimate.',
      {
        requests: { type: 'array', items: { type: 'object' }, description: 'Requests: [{id?, promptTokens, expectedCompletionTokens, priority?, arrivedAt?}].' },
        shortJobFirst: { type: 'boolean', description: 'Sort short requests first within the same priority (default false = FIFO).' },
        maxNumSeqs: { type: 'number', description: 'Max concurrent sequences (default 32).' },
        kvCacheGB: { type: 'number', description: 'KV cache size in GB (default 8).' },
        maxModelLen: { type: 'number', description: 'Max model length in tokens (default 32768).' },
      },
      ['requests'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const requests = parseBatchRequests(args);
        const config = batchingConfigFromArgs(args, batching.getConfig());
        const shortJobFirst = getBoolArg(args, 'shortJobFirst', false);
        const scheduler = new BatchScheduler(config);
        const batches = scheduler.schedule(requests, { shortJobFirst });
        return okResult({
          totalRequests: requests.length,
          batches: batches.length,
          batchesDetail: batches.map((b) => ({
            index: b.index,
            requestIds: b.requests.map((r) => r.id),
            startsAtMs: Math.round(b.startsAtMs),
            estimate: {
              batchSize: b.estimate.batchSize,
              avgTtftMs: Math.round(b.estimate.avgTtftMs),
              totalDurationMs: Math.round(b.estimate.totalDurationMs),
              throughputTokensPerSec: Math.round(b.estimate.throughputTokensPerSec),
              bottleneck: b.estimate.bottleneck,
              overCapacity: b.estimate.overCapacity,
            },
          })),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const healthProbeTool: Tool = {
    definition: toolDef(
      'router_local_health_probe',
      'Probe health of local endpoints (loopback only: 127.0.0.1/localhost). Returns reachability, latency, models served and uptime history. Non-loopback URLs are refused.',
      {
        baseUrls: { type: 'array', items: { type: 'string' }, description: 'Endpoint base URLs, e.g. ["http://127.0.0.1:11434", "http://127.0.0.1:8000"].' },
        timeoutMs: { type: 'number', description: 'Probe timeout per endpoint in ms (default 3000).' },
        metricsText: { type: 'string', description: 'Optional raw vLLM /metrics text to parse (running/waiting/TTFT) — no network call is made for this.' },
        vllmMetricsUrl: { type: 'string', description: 'Optional loopback vLLM base URL to fetch live /metrics from (e.g. http://127.0.0.1:8000). Non-loopback URLs are ignored.' },
      },
      ['baseUrls'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const baseUrls = getStringArrayArg(args, 'baseUrls');
        if (baseUrls.length === 0) return errorResult('baseUrls khong duoc rong.');
        if (baseUrls.length > 8) return errorResult('Toi da 8 endpoint moi lan goi.');
        const timeoutMs = getNumberArg(args, 'timeoutMs', false, 3000);
        if (timeoutMs <= 0) return errorResult('timeoutMs phai > 0.');
        const { results, healthiest } = await probeEndpoints(baseUrls, { timeoutMs });
        for (const result of results) health.record(result);
        const metricsText = getOptionalStringArg(args, 'metricsText');
        const metrics = metricsText !== undefined ? parseVllmMetrics(metricsText) : null;
        const vllmMetricsUrl = getOptionalStringArg(args, 'vllmMetricsUrl');
        const liveMetrics = vllmMetricsUrl !== undefined
          ? await probeVllmMetrics(vllmMetricsUrl, { timeoutMs })
          : null;
        return okResult({
          results,
          healthiest: healthiest?.baseUrl ?? null,
          summaries: health.summaries().filter((s) => baseUrls.includes(s.baseUrl)),
          vllmMetrics: metrics,
          liveVllmMetrics: liveMetrics,
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const pickerListTool: Tool = {
    definition: toolDef(
      'router_local_picker_list',
      'List every routable model for the UI picker: local catalogue + cloud + enabled CLI-agent sources, each with its source, account label, cost/latency/quality and whether it fits the task.',
      {
        kind: { type: 'string', description: 'Optional task kind to filter by: simple-chat, code, reasoning, research, creative, howto, summarize, translate.' },
        promptTokens: { type: 'number', description: 'Estimated prompt tokens.' },
        needsToolUse: { type: 'boolean', description: 'Whether the task needs tool-use.' },
        needsLongContext: { type: 'boolean', description: 'Whether the task needs >32k context.' },
        qualityNeed: { type: 'number', description: 'Required quality 0..1.' },
        profileId: { type: 'string', description: 'Scoring profile id for ranking (default: current profile).' },
        loadedModelIds: { type: 'array', items: { type: 'string' }, description: 'Local model ids currently loaded.' },
        availableRamGB: { type: 'number', description: 'Free RAM available for models in GB (default 8).' },
        includeCliSources: { type: 'boolean', description: 'Include enabled CLI-agent sources as routable models (default false).' },
        hideUnavailable: { type: 'boolean', description: 'Hide models that do not fit the task (default false).' },
        limit: { type: 'number', description: 'Max entries to return (0 = all).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const kind = getOptionalStringArg(args, 'kind');
        let task: RouterTask | undefined;
        if (kind !== undefined) {
          if (!TASK_KINDS.includes(kind)) {
            return errorResult(`kind phai la mot trong: ${TASK_KINDS.join(', ')}.`);
          }
          task = {
            kind: kind as RouterTask['kind'],
            promptTokens: getNumberArg(args, 'promptTokens', false, 0),
            needsToolUse: getBoolArg(args, 'needsToolUse', false),
            needsLongContext: getBoolArg(args, 'needsLongContext', false),
            qualityNeed: getNumberArg(args, 'qualityNeed', false, 0.5),
          };
        }
        const profileId = getOptionalStringArg(args, 'profileId');
        if (profileId && !PROFILE_IDS.includes(profileId)) {
          return errorResult(`profileId phai la mot trong: ${PROFILE_IDS.join(', ')}.`);
        }
        const profile = profileId
          ? getRoutingProfile(profileId as RoutingProfileId)
          : scoring.getProfile();
        const loadedModelIds = new Set<string>(
          args.loadedModelIds === undefined ? [] : getStringArrayArg(args, 'loadedModelIds', false),
        );
        const availableRamGB = getNumberArg(args, 'availableRamGB', false, 8);
        if (availableRamGB < 0) return errorResult('availableRamGB khong duoc am.');
        const limit = getNumberArg(args, 'limit', false, 0);
        if (limit < 0) return errorResult('limit khong duoc am.');
        const cliModels = getBoolArg(args, 'includeCliSources', false) ? cli.routableModels() : [];
        const entries = buildPickerEntries(
          { loadedModelIds, availableRamBytes: availableRamGB * 1024 * 1024 * 1024 },
          {
            task,
            profile,
            cliModels,
            hideUnavailable: getBoolArg(args, 'hideUnavailable', false),
            limit,
          },
          scoring.getConfig(),
        );
        return okResult({ entries, summary: summarizePicker(entries), profile: profile.id });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const decisionLogTool: Tool = {
    definition: toolDef(
      'router_local_decision_log',
      'Show recent routing decisions (why model A won over model B): full ranking with reasons per decision, newest first. Pass id to fetch one decision.',
      {
        id: { type: 'string', description: 'Decision log id (e.g. route-3) to fetch one entry.' },
        limit: { type: 'number', description: 'Max entries to return (default 10).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const store = scoring.getLogStore();
        const id = getOptionalStringArg(args, 'id');
        if (id !== undefined) {
          const entry = store.get(id);
          if (!entry) return errorResult(`Khong co quyet dinh nao co id "${id}".`);
          return okResult({ entry });
        }
        const limit = getNumberArg(args, 'limit', false, 10);
        if (limit < 0) return errorResult('limit khong duoc am.');
        const entries = store.list().slice(-Math.max(0, limit)).reverse();
        return okResult({ total: store.size(), entries });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    scoreRankTool,
    profileListTool,
    profileSetTool,
    fallbackRunTool,
    fallbackStatusTool,
    cliListTool,
    cliDetectTool,
    cliSetTool,
    batchEstimateTool,
    batchScheduleTool,
    healthProbeTool,
    pickerListTool,
    decisionLogTool,
  ];
}

/** Unbound placeholders for ALL_TOOLS (bound by createDefaultTools when wired). */
export const ROUTER_LOCAL_V116_TOOLS: Tool[] = createRouterLocalV116Tools();

/** Re-export huu ich cho test/host. */
export { ROUTING_PROFILES, cliSourceModelId };
