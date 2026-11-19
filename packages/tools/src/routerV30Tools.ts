/**
 * Router v30 tools (v1.44, Doi T5) — registered in ALL_TOOLS
 * (see tools.ts).
 *
 * 22 tools (thuan tren state in-memory mac dinh; host co the
 * truyen state rieng qua createRouterV30Tools):
 * - `router_v30_catalog_list` / `router_v30_catalog_get` /
 *   `router_v30_catalog_refresh` / `router_v30_catalog_stale` — xem/loc/
 *   cap nhat danh muc model co version (refresh thu cong tu snapshot
 *   host dua vao; stale marking; KHONG tu fetch mang).
 * - `router_v30_route` — chon model theo latency DO DUOC + chi phi
 *   uoc tinh + chat luong, theo policy user + giai thich quyet dinh.
 * - `router_v30_latency_record` / `router_v30_latency_stats` — ghi do
 *   tre that + xem thong ke EWMA/p50/p95 theo model.
 * - `router_v30_fallback_plan` / `router_v30_fallback_run` — lap ke
 *   hoach + chay fallback chain (executor mock xac dinh qua
 *   `failModels`; khong goi model that).
 * - `router_v30_health_probe` / `router_v30_health_summary` — probe
 *   suc khoe tung provider (prober mock mac dinh) + tom tat.
 * - `router_v30_cli_detect` / `router_v30_cli_list` /
 *   `router_v30_cli_consent` / `router_v30_cli_enable` /
 *   `router_v30_cli_label` — phat hien CLI agent v2 (Codex, Claude
 *   Code, OpenCode, Gemini CLI, Aider, Cursor CLI), dong y qua UI,
 *   bat/tat tung nguon, dat nhan account. KHONG doc credential.
 * - `router_v30_cli_invoke` — chay 1 prompt qua CLI da phat hien bang
 *   session goc cua no (chi khi user da dong y + nguon dang bat;
 *   mock runner mac dinh, host thay bang spawn that).
 * - `router_v30_route_history` — lich su quyet dinh routing + thong ke.
 * - `router_v30_budget_set` / `router_v30_budget_report` — dat ngan
 *   sach ngay theo provider + bao cao so da chi / con lai (route se
 *   tranh provider het ngan sach).
 * - `router_v30_policy_get` / `router_v30_policy_set` — xem/dat
 *   chinh sach routing cua user (profile, trong so, allow/block,
 *   tran gia/do tre, auto-refresh).
 *
 * Khong goi model that, khong goi API that, khong doc/gui credential.
 */

import type { Tool } from '@open-bot/core';
import {
  FallbackDecisionLogV30,
  LatencyStatsStoreV30,
  ProviderBudgetStoreV30,
  applyBudgetToDecisionV30,
  RoutingHistoryStoreV30,
  invokeCliAgentV30,
  ProviderHealthTrackerV30,
  defaultCliAgentConsentV30,
  defaultModelCatalogV30,
  defaultRoutingPolicyV30,
  detectCliAgentsV30,
  emptyCapabilitiesV30,
  estimateModelCostV30,
  explainRoutingDecisionV30,
  filterCatalogV30,
  findModelV30,
  mergeRoutingPolicyV30,
  planFallbackV30,
  refreshModelCatalogV30,
  resolveCliModelSourcesV30,
  routeModelV30,
  runFallbackChainV30,
  setCliAccountLabelV30,
  setCliConsentV30,
  setCliModelOverrideV30,
  setCliSourceEnabledV30,
  shouldAutoRefreshV30,
  staleCatalogEntriesV30,
  summarizeCatalogV30,
  summarizeCliSourcesV30,
  validateFallbackChainV30,
  validateRoutingPolicyV30,
  type CatalogSnapshotEntryV30,
  type CliAgentConsentV30,
  type CliAgentDetectionV30,
  type CliAgentKindV30,
  type CliDetectRunnerV30,
  type CliInvokeRunnerV30,
  type FallbackChainV30,
  type FallbackExecutorV30,
  type FallbackStepV30,
  type HealthProberV30,
  type ModelCatalogEntryV30,
  type ModelCatalogV30,
  type ModelFamilyV30,
  type ModelKindV30,
  type RoutingPolicyV30,
  type RoutingProfileV30,
} from '@open-bot/core';

export const ROUTER_V30_TOOL_NAMES = [
  'router_v30_catalog_list',
  'router_v30_catalog_get',
  'router_v30_catalog_refresh',
  'router_v30_catalog_stale',
  'router_v30_route',
  'router_v30_latency_record',
  'router_v30_latency_stats',
  'router_v30_fallback_plan',
  'router_v30_fallback_run',
  'router_v30_health_probe',
  'router_v30_health_summary',
  'router_v30_cli_detect',
  'router_v30_cli_list',
  'router_v30_cli_consent',
  'router_v30_cli_enable',
  'router_v30_cli_label',
  'router_v30_cli_invoke',
  'router_v30_route_history',
  'router_v30_budget_set',
  'router_v30_budget_report',
  'router_v30_policy_get',
  'router_v30_policy_set',
] as const;

export function isRouterV30ToolName(name: string): boolean {
  return (ROUTER_V30_TOOL_NAMES as readonly string[]).includes(name);
}

/** State dung chung cua bo tool (host co the truyen state rieng). */
export interface RouterV30State {
  catalog: ModelCatalogV30;
  stats: LatencyStatsStoreV30;
  health: ProviderHealthTrackerV30;
  fallbackLog: FallbackDecisionLogV30;
  policy: RoutingPolicyV30;
  cliConsent: CliAgentConsentV30;
  cliDetections: CliAgentDetectionV30[];
  history: RoutingHistoryStoreV30;
  budget: ProviderBudgetStoreV30;
  /** Prober suc khoe host cung cap (mac dinh mock tra unknown). */
  prober: HealthProberV30;
  /** Executor fallback host cung cap (mac dinh mock theo failModels). */
  executor: FallbackExecutorV30<string>;
  /** Runner phat hien CLI host cung cap (mac dinh spawn that). */
  cliRunner: CliDetectRunnerV30;
  /** Runner invoke CLI host cung cap (mac dinh mock). */
  invokeRunner: CliInvokeRunnerV30;
}

export function createDefaultRouterV30State(): RouterV30State {
  return {
    catalog: defaultModelCatalogV30(),
    stats: new LatencyStatsStoreV30(),
    health: new ProviderHealthTrackerV30(),
    fallbackLog: new FallbackDecisionLogV30(),
    policy: defaultRoutingPolicyV30(),
    cliConsent: defaultCliAgentConsentV30(),
    cliDetections: [],
    history: new RoutingHistoryStoreV30(),
    budget: new ProviderBudgetStoreV30(),
    prober: async () => ({
      ok: false,
      latencyMs: 0,
      detail: 'no prober configured (mock)',
    }),
    executor: async (step) => ({
      ok: true,
      value: `mock-ok:${step.provider}::${step.modelId}`,
    }),
    cliRunner: async () => null,
    invokeRunner: async (binary, argv) => ({
      stdout: `mock-invoke:${binary}:${argv.join(' ').slice(0, 120)}`,
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }),
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

function okResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function errorResult(message: string): string {
  return `Error: ${message}`;
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

function getOptionalNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
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

function getStringArrayArg(args: Record<string, unknown>, name: string): string[] | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings.`);
  }
  return value as string[];
}

function getObjectArrayArg(args: Record<string, unknown>, name: string): Record<string, unknown>[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'object' || v === null || Array.isArray(v))) {
    throw new Error(`Argument "${name}" must be an array of objects.`);
  }
  return value as Record<string, unknown>[];
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`"${field}" phai la string khong rong.`);
  return value;
}

/** Parse 1 muc catalog snapshot tu args. */
function parseCatalogSnapshotEntryV30(raw: Record<string, unknown>, index: number): CatalogSnapshotEntryV30 {
  const prefix = `entries[${index}]`;
  const capabilities = { ...emptyCapabilitiesV30() };
  const capabilitiesRaw = raw.capabilities;
  if (capabilitiesRaw !== undefined && capabilitiesRaw !== null) {
    if (typeof capabilitiesRaw !== 'object' || Array.isArray(capabilitiesRaw)) {
      throw new Error(`${prefix}.capabilities phai la object.`);
    }
    for (const [key, value] of Object.entries(capabilitiesRaw as Record<string, unknown>)) {
      if (key in capabilities) {
        if (typeof value !== 'boolean') throw new Error(`${prefix}.capabilities.${key} phai la boolean.`);
        (capabilities as Record<string, boolean>)[key] = value;
      }
    }
  }
  const entry: CatalogSnapshotEntryV30 = {
    provider: asString(raw.provider, `${prefix}.provider`),
    modelId: asString(raw.modelId, `${prefix}.modelId`),
    family: (typeof raw.family === 'string' && raw.family !== '' ? raw.family : 'other') as ModelFamilyV30,
    kind: (typeof raw.kind === 'string' && raw.kind !== '' ? raw.kind : 'text') as ModelKindV30,
    contextTokens: typeof raw.contextTokens === 'number' ? raw.contextTokens : 8192,
    maxOutputTokens: typeof raw.maxOutputTokens === 'number' ? raw.maxOutputTokens : 4096,
    inputPricePerMillionUsd: typeof raw.inputPricePerMillionUsd === 'number' ? raw.inputPricePerMillionUsd : 0,
    outputPricePerMillionUsd: typeof raw.outputPricePerMillionUsd === 'number' ? raw.outputPricePerMillionUsd : 0,
    qualityScore: typeof raw.qualityScore === 'number' ? raw.qualityScore : 0.5,
    estimatedLatencyMs: typeof raw.estimatedLatencyMs === 'number' ? raw.estimatedLatencyMs : 1000,
    capabilities,
    tags: Array.isArray(raw.tags) ? (raw.tags as unknown[]).filter((t): t is string => typeof t === 'string') : [],
    deprecated: typeof raw.deprecated === 'boolean' ? raw.deprecated : false,
  };
  if (typeof raw.perMinuteUsd === 'number') entry.perMinuteUsd = raw.perMinuteUsd;
  if (typeof raw.deprecatedReason === 'string') entry.deprecatedReason = raw.deprecatedReason;
  return entry;
}

/** Parse 1 buoc fallback tu args. */
function parseFallbackStepV30(raw: Record<string, unknown>, index: number): FallbackStepV30 {
  const step: FallbackStepV30 = {
    provider: asString(raw.provider, `steps[${index}].provider`),
    modelId: asString(raw.modelId, `steps[${index}].modelId`),
  };
  if (typeof raw.maxAttempts === 'number') step.maxAttempts = raw.maxAttempts;
  if (typeof raw.cooldownMs === 'number') step.cooldownMs = raw.cooldownMs;
  return step;
}

const CLI_KINDS_V30: readonly string[] = [
  'codex',
  'claude-code',
  'opencode',
  'gemini-cli',
  'aider',
  'cursor-cli',
];

function parseCliKindV30(value: unknown): CliAgentKindV30 {
  if (typeof value !== 'string' || !CLI_KINDS_V30.includes(value)) {
    throw new Error(`kind phai la mot trong: ${CLI_KINDS_V30.join(', ')}.`);
  }
  return value as CliAgentKindV30;
}

export function createRouterV30Tools(
  state: RouterV30State = createDefaultRouterV30State(),
): Tool[] {
  const catalogListTool: Tool = {
    definition: toolDef(
      'router_v30_catalog_list',
      'List the v30 versioned model catalog (metadata only — OpenAI-compatible, Gemini, Ollama, local). Filter by provider, family, kind, tag, capability, min context, max input price. No live API call.',
      {
        provider: { type: 'string', description: 'Filter by provider (openai, gemini, anthropic, xai, deepseek, ollama, local).' },
        family: { type: 'string', description: 'Filter by family.' },
        kind: { type: 'string', description: 'Filter by kind (text, reasoning, realtime, embedding, image, audio).' },
        tag: { type: 'string', description: 'Filter by tag (flagship, cheap, local, free, realtime, vision).' },
        toolCalling: { type: 'boolean', description: 'Only models with tool calling.' },
        vision: { type: 'boolean', description: 'Only models with vision.' },
        realtimeVoice: { type: 'boolean', description: 'Only realtime-voice models.' },
        minContextTokens: { type: 'number', description: 'Minimum context tokens.' },
        maxInputPricePerMillionUsd: { type: 'number', description: 'Maximum input price USD/1M tokens.' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const entries = filterCatalogV30(state.catalog, {
          provider: getOptionalStringArg(args, 'provider'),
          family: getOptionalStringArg(args, 'family') as ModelFamilyV30 | undefined,
          kind: getOptionalStringArg(args, 'kind') as ModelKindV30 | undefined,
          tag: getOptionalStringArg(args, 'tag'),
          toolCalling: getBoolArg(args, 'toolCalling', false) || undefined,
          vision: getBoolArg(args, 'vision', false) || undefined,
          realtimeVoice: getBoolArg(args, 'realtimeVoice', false) || undefined,
          minContextTokens: getOptionalNumberArg(args, 'minContextTokens'),
          maxInputPricePerMillionUsd: getOptionalNumberArg(args, 'maxInputPricePerMillionUsd'),
        });
        return okResult({
          summary: summarizeCatalogV30(state.catalog),
          count: entries.length,
          entries,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const catalogGetTool: Tool = {
    definition: toolDef(
      'router_v30_catalog_get',
      'Get one v30 catalog entry by provider + modelId, with estimated cost for a token count.',
      {
        provider: { type: 'string', description: 'Provider id.' },
        modelId: { type: 'string', description: 'Model id.' },
        inputTokens: { type: 'number', description: 'Input tokens to price (default 1000).' },
        outputTokens: { type: 'number', description: 'Output tokens to price (default 500).' },
      },
      ['provider', 'modelId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const provider = getStringArg(args, 'provider');
        const modelId = getStringArg(args, 'modelId');
        const entry = findModelV30(state.catalog, provider, modelId);
        if (!entry) return errorResult(`Model not found: ${provider}::${modelId}`);
        const inputTokens = getNumberArg(args, 'inputTokens', false, 1000);
        const outputTokens = getNumberArg(args, 'outputTokens', false, 500);
        return okResult({
          entry,
          estimatedCostUsd: estimateModelCostV30(entry, inputTokens, outputTokens),
          catalogVersion: state.catalog.catalogVersion,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const catalogRefreshTool: Tool = {
    definition: toolDef(
      'router_v30_catalog_refresh',
      'Manually refresh the v30 catalog from a host-supplied snapshot (list of entries). Returns the diff (added/updated/unchanged/rejected/removed) and bumps catalogVersion when changed. Never fetches from the network; removeMissing=false by default.',
      {
        entries: { type: 'array', description: 'Snapshot entries (provider + modelId required; other fields optional).' },
        removeMissing: { type: 'boolean', description: 'Remove catalog entries missing from the snapshot (default false).' },
      },
      ['entries'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const rawEntries = getObjectArrayArg(args, 'entries');
        const snapshot = rawEntries.map((raw, i) => parseCatalogSnapshotEntryV30(raw, i));
        const removeMissing = getBoolArg(args, 'removeMissing', false);
        const { catalog, report } = refreshModelCatalogV30(state.catalog, snapshot, {
          removeMissing,
          source: 'manual',
        });
        state.catalog = catalog;
        return okResult(report);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const catalogStaleTool: Tool = {
    definition: toolDef(
      'router_v30_catalog_stale',
      'Check whether the v30 catalog should auto-refresh (controlled policy: disabled by default, min interval, stale entries) and list stale entries older than maxAgeMs.',
      {
        maxAgeMs: { type: 'number', description: 'Entries older than this (ms) count as stale (default 86400000 = 24h).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const maxAgeMs = getNumberArg(args, 'maxAgeMs', false, 24 * 60 * 60 * 1000);
        const auto = shouldAutoRefreshV30(state.catalog, state.policy.autoRefreshCatalog);
        const stale = staleCatalogEntriesV30(state.catalog, maxAgeMs);
        return okResult({
          catalogVersion: state.catalog.catalogVersion,
          source: state.catalog.source,
          autoRefresh: auto,
          autoRefreshPolicy: state.policy.autoRefreshCatalog,
          staleCount: stale.length,
          stale: stale.map((e) => `${e.provider}::${e.modelId}`),
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const routeTool: Tool = {
    definition: toolDef(
      'router_v30_route',
      'Route a request to the best v30 model by measured latency (EWMA when samples exist, else catalog estimate) + estimated cost + quality, under the user policy. Returns the chosen model, top alternatives, rejected models and a human-readable explanation.',
      {
        needsRealtimeVoice: { type: 'boolean', description: 'Needs realtime voice.' },
        needsToolCalling: { type: 'boolean', description: 'Needs tool/function calling.' },
        needsVision: { type: 'boolean', description: 'Needs vision.' },
        needsReasoning: { type: 'boolean', description: 'Needs deep reasoning.' },
        needsJsonMode: { type: 'boolean', description: 'Needs JSON structured output.' },
        needsEmbedding: { type: 'boolean', description: 'Needs an embedding model.' },
        inputTokens: { type: 'number', description: 'Expected input tokens (default 1000).' },
        outputTokens: { type: 'number', description: 'Expected output tokens (default 500).' },
        minContextTokens: { type: 'number', description: 'Minimum context tokens.' },
        maxLatencyMs: { type: 'number', description: 'Max latency accepted for this call (ms, overrides policy).' },
        maxCostUsd: { type: 'number', description: 'Max cost accepted for this call (USD, overrides policy).' },
        forceProvider: { type: 'string', description: 'Force a provider.' },
        forceModel: { type: 'string', description: 'Force a model as provider::modelId.' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const routingRequest = {
          needsRealtimeVoice: getBoolArg(args, 'needsRealtimeVoice', false),
          needsToolCalling: getBoolArg(args, 'needsToolCalling', false),
          needsVision: getBoolArg(args, 'needsVision', false),
          needsReasoning: getBoolArg(args, 'needsReasoning', false),
          needsJsonMode: getBoolArg(args, 'needsJsonMode', false),
          needsEmbedding: getBoolArg(args, 'needsEmbedding', false),
          inputTokens: getOptionalNumberArg(args, 'inputTokens'),
          outputTokens: getOptionalNumberArg(args, 'outputTokens'),
          minContextTokens: getOptionalNumberArg(args, 'minContextTokens'),
          maxLatencyMs: getOptionalNumberArg(args, 'maxLatencyMs'),
          maxCostUsd: getOptionalNumberArg(args, 'maxCostUsd'),
          forceProvider: getOptionalStringArg(args, 'forceProvider'),
          forceModel: getOptionalStringArg(args, 'forceModel'),
        };
        const rawDecision = routeModelV30(
          state.catalog,
          routingRequest,
          state.policy,
          state.stats,
        );
        // Ap ngan sach ngay theo provider (neu co dat): bo qua model
        // cua provider het ngan sach, chon ung vien tiep theo.
        const decision = applyBudgetToDecisionV30(rawDecision, state.budget);
        state.history.record(decision, routingRequest);
        return okResult({
          ok: decision.ok,
          chosen: decision.chosen
            ? {
                provider: decision.chosen.entry.provider,
                modelId: decision.chosen.entry.modelId,
                score: decision.chosen.score,
                effectiveLatencyMs: decision.chosen.effectiveLatencyMs,
                latencyMeasured: decision.chosen.latencyMeasured,
                estimatedCostUsd: decision.chosen.estimatedCostUsd,
                reasons: decision.chosen.reasons,
              }
            : null,
          alternatives: decision.candidates.slice(1).map((c) => ({
            provider: c.entry.provider,
            modelId: c.entry.modelId,
            score: c.score,
          })),
          rejected: decision.rejected,
          explanation: explainRoutingDecisionV30(decision),
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const latencyRecordTool: Tool = {
    definition: toolDef(
      'router_v30_latency_record',
      'Record one measured latency sample for a model (ms + success/failure). Feeds the EWMA/p50/p95 stats the router uses.',
      {
        provider: { type: 'string', description: 'Provider id.' },
        modelId: { type: 'string', description: 'Model id.' },
        latencyMs: { type: 'number', description: 'Measured latency in ms.' },
        success: { type: 'boolean', description: 'Whether the call succeeded (default true).' },
      },
      ['provider', 'modelId', 'latencyMs'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const provider = getStringArg(args, 'provider');
        const modelId = getStringArg(args, 'modelId');
        const latencyMs = getNumberArg(args, 'latencyMs');
        const success = getBoolArg(args, 'success', true);
        state.stats.record(provider, modelId, latencyMs, success);
        return okResult({ recorded: true, stats: state.stats.stats(provider, modelId) });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const latencyStatsTool: Tool = {
    definition: toolDef(
      'router_v30_latency_stats',
      'Show measured latency stats (EWMA, mean, p50, p95, failure rate) for one model or all models with samples.',
      {
        provider: { type: 'string', description: 'Provider id (omit for all).' },
        modelId: { type: 'string', description: 'Model id (omit for all).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const provider = getOptionalStringArg(args, 'provider');
        const modelId = getOptionalStringArg(args, 'modelId');
        if (provider && modelId) {
          const s = state.stats.stats(provider, modelId);
          return okResult({ stats: s, modelCount: state.stats.modelCount });
        }
        return okResult({ modelCount: state.stats.modelCount, all: state.stats.allStats() });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const fallbackPlanTool: Tool = {
    definition: toolDef(
      'router_v30_fallback_plan',
      'Plan a v30 fallback chain (list of provider/model steps with maxAttempts + cooldown). Returns total attempts and steps skipped while cooling down. Validates the chain first.',
      {
        name: { type: 'string', description: 'Chain name.' },
        steps: { type: 'array', description: 'Steps: [{provider, modelId, maxAttempts?, cooldownMs?}].' },
        maxTotalAttempts: { type: 'number', description: 'Cap on total attempts across the chain.' },
      },
      ['name', 'steps'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const name = getStringArg(args, 'name');
        const steps = getObjectArrayArg(args, 'steps').map((raw, i) => parseFallbackStepV30(raw, i));
        const chain: FallbackChainV30 = { name, steps };
        const maxTotal = getOptionalNumberArg(args, 'maxTotalAttempts');
        if (maxTotal !== undefined) chain.maxTotalAttempts = maxTotal;
        const errors = validateFallbackChainV30(chain);
        if (errors.length > 0) return errorResult(`Invalid chain: ${errors.join('; ')}`);
        return okResult(planFallbackV30(chain));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const fallbackRunTool: Tool = {
    definition: toolDef(
      'router_v30_fallback_run',
      'Run a v30 fallback chain with the configured executor (default mock: fails models listed in failModels with the given error). Fatal errors (401/403/404) stop the chain; retryable errors (429/5xx/timeout/network) move to the next step. Every attempt is written to the decision log.',
      {
        name: { type: 'string', description: 'Chain name.' },
        steps: { type: 'array', description: 'Steps: [{provider, modelId, maxAttempts?, cooldownMs?}].' },
        failModels: { type: 'array', description: 'Mock: model keys (provider::modelId) that fail.' },
        failStatus: { type: 'number', description: 'Mock: HTTP status of the failure (default 429).' },
        failMessage: { type: 'string', description: 'Mock: failure message.' },
        maxTotalAttempts: { type: 'number', description: 'Cap on total attempts (default: policy maxFallbackAttempts).' },
      },
      ['name', 'steps'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const name = getStringArg(args, 'name');
        const steps = getObjectArrayArg(args, 'steps').map((raw, i) => parseFallbackStepV30(raw, i));
        const chain: FallbackChainV30 = { name, steps };
        const maxTotal = getOptionalNumberArg(args, 'maxTotalAttempts');
        if (maxTotal !== undefined) chain.maxTotalAttempts = maxTotal;
        const failModels = new Set(getStringArrayArg(args, 'failModels') ?? []);
        const failStatus = getNumberArg(args, 'failStatus', false, 429);
        const failMessage = getOptionalStringArg(args, 'failMessage') ?? 'mock provider error';
        const mockExecutor: FallbackExecutorV30<string> = async (step) => {
          const key = `${step.provider}::${step.modelId}`;
          if (failModels.has(key)) {
            return { ok: false, error: { status: failStatus, message: failMessage } };
          }
          return { ok: true, value: `mock-ok:${key}` };
        };
        const result = await runFallbackChainV30(chain, mockExecutor, {
          maxTotalAttempts:
            chain.maxTotalAttempts ?? state.policy.maxFallbackAttempts,
          log: state.fallbackLog,
        });
        return okResult({
          ok: result.ok,
          value: result.value,
          succeededStep: result.succeededStep,
          attemptsMade: result.attemptsMade,
          triedSteps: result.triedSteps,
          lastError: result.lastError,
          logLength: state.fallbackLog.length,
          recentDecisions: state.fallbackLog.entries.slice(-5),
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const healthProbeTool: Tool = {
    definition: toolDef(
      'router_v30_health_probe',
      'Probe the health of one v30 provider (or one model) with the configured lightweight prober (default mock). Results are cached for the TTL; 3 consecutive failures mark it down.',
      {
        provider: { type: 'string', description: 'Provider id.' },
        modelId: { type: 'string', description: 'Model id (optional).' },
        force: { type: 'boolean', description: 'Probe even if the cached result is still fresh (default false).' },
      },
      ['provider'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const provider = getStringArg(args, 'provider');
        const modelId = getOptionalStringArg(args, 'modelId');
        const force = getBoolArg(args, 'force', false);
        if (!force && !state.health.needsProbe(provider, modelId)) {
          return okResult({
            cached: true,
            status: state.health.getStatus(provider, modelId),
          });
        }
        const status = await state.health.probe(provider, state.prober, modelId);
        return okResult({ cached: false, status });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const healthSummaryTool: Tool = {
    definition: toolDef(
      'router_v30_health_summary',
      'Summarize v30 provider health: counts by status (healthy/degraded/down/unknown), healthy ratio, worst provider, and all tracked statuses.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      try {
        return okResult({
          summary: state.health.summary(),
          statuses: state.health.allStatuses(),
          downProviders: state.health.downProviders(),
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const cliDetectTool: Tool = {
    definition: toolDef(
      'router_v30_cli_detect',
      'Detect CLI agents v2 on this machine (Codex CLI, Claude Code, OpenCode, Gemini CLI, Aider, Cursor CLI) by spawning each binary --version. Never reads credential/config files. Stores the detection for later use.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      try {
        state.cliDetections = await detectCliAgentsV30(state.cliRunner);
        return okResult({
          detections: state.cliDetections,
          summary: summarizeCliSourcesV30(state.cliDetections, state.cliConsent),
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const cliListTool: Tool = {
    definition: toolDef(
      'router_v30_cli_list',
      'List detected CLI agent sources v2 with consent state: which model runs through which account, which sources are enabled/disabled. Empty until router_v30_cli_detect has run.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      try {
        return okResult({
          consented: state.cliConsent.consented,
          enabledSources: resolveCliModelSourcesV30(state.cliDetections, state.cliConsent),
          summary: summarizeCliSourcesV30(state.cliDetections, state.cliConsent),
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const cliConsentTool: Tool = {
    definition: toolDef(
      'router_v30_cli_consent',
      'Grant or revoke the user consent to use CLI agents on this machine (v2). Revoking stops all CLI-based model use immediately. Also sets a display account label and/or model override for one CLI source.',
      {
        consented: { type: 'boolean', description: 'true = user consents; false = revoke.' },
        kind: { type: 'string', description: 'CLI kind to label/override (codex, claude-code, opencode, gemini-cli, aider, cursor-cli).' },
        accountLabel: { type: 'string', description: 'Display account label the user typed (never read from disk).' },
        modelOverride: { type: 'string', description: 'Model id override for this CLI source.' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const consented = getBoolArg(args, 'consented', state.cliConsent.consented);
        let consent = setCliConsentV30(state.cliConsent, consented);
        const kindRaw = getOptionalStringArg(args, 'kind');
        if (kindRaw !== undefined) {
          const kind = parseCliKindV30(kindRaw);
          const label = getOptionalStringArg(args, 'accountLabel');
          if (label !== undefined) consent = setCliAccountLabelV30(consent, kind, label);
          const modelOverride = getOptionalStringArg(args, 'modelOverride');
          if (modelOverride !== undefined) consent = setCliModelOverrideV30(consent, kind, modelOverride);
        }
        state.cliConsent = consent;
        return okResult({
          consented: consent.consented,
          consentedAt: consent.consentedAt,
          enabledSources: resolveCliModelSourcesV30(state.cliDetections, consent),
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const cliEnableTool: Tool = {
    definition: toolDef(
      'router_v30_cli_enable',
      'Enable or disable one CLI agent source v2 (only takes effect while the user consent is granted).',
      {
        kind: { type: 'string', description: 'CLI kind (codex, claude-code, opencode, gemini-cli, aider, cursor-cli).' },
        enabled: { type: 'boolean', description: 'true = enable, false = disable.' },
      },
      ['kind', 'enabled'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const kind = parseCliKindV30(getStringArg(args, 'kind'));
        const enabled = getBoolArg(args, 'enabled', true);
        state.cliConsent = setCliSourceEnabledV30(state.cliConsent, kind, enabled);
        return okResult({
          kind,
          enabled,
          enabledSources: resolveCliModelSourcesV30(state.cliDetections, state.cliConsent),
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const cliLabelTool: Tool = {
    definition: toolDef(
      'router_v30_cli_label',
      'Set the display account label and/or model override for one CLI agent source v2. Labels are typed by the user, never read from credential files.',
      {
        kind: { type: 'string', description: 'CLI kind (codex, claude-code, opencode, gemini-cli, aider, cursor-cli).' },
        accountLabel: { type: 'string', description: 'Display account label (empty clears it).' },
        modelOverride: { type: 'string', description: 'Model id override (empty clears it).' },
      },
      ['kind'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const kind = parseCliKindV30(getStringArg(args, 'kind'));
        let consent = state.cliConsent;
        const label = getOptionalStringArg(args, 'accountLabel');
        if (label !== undefined) consent = setCliAccountLabelV30(consent, kind, label);
        const modelOverride = getOptionalStringArg(args, 'modelOverride');
        if (modelOverride !== undefined) consent = setCliModelOverrideV30(consent, kind, modelOverride);
        state.cliConsent = consent;
        return okResult({
          kind,
          accountLabel: consent.accountLabelByKind[kind] ?? null,
          modelOverride: consent.modelOverrideByKind[kind] ?? null,
          enabledSources: resolveCliModelSourcesV30(state.cliDetections, consent),
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const cliInvokeTool: Tool = {
    definition: toolDef(
      'router_v30_cli_invoke',
      'Run one prompt through a detected CLI agent v2 (Codex CLI, Claude Code, OpenCode, Gemini CLI, Aider, Cursor CLI) using that CLI own logged-in session. Requires user consent + an enabled source; otherwise returns an error without spawning. Default runner is a mock; the host replaces it with the real spawn runner.',
      {
        kind: { type: 'string', description: 'CLI kind (codex, claude-code, opencode, gemini-cli, aider, cursor-cli).' },
        prompt: { type: 'string', description: 'Prompt to send to the model through the CLI.' },
        modelId: { type: 'string', description: 'Model override (optional; the CLI uses its own default otherwise).' },
        timeoutMs: { type: 'number', description: 'Timeout in ms (default 120000).' },
      },
      ['kind', 'prompt'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const kind = parseCliKindV30(getStringArg(args, 'kind'));
        const prompt = getStringArg(args, 'prompt');
        const result = await invokeCliAgentV30(
          {
            kind,
            prompt,
            modelId: getOptionalStringArg(args, 'modelId'),
            timeoutMs: getOptionalNumberArg(args, 'timeoutMs'),
          },
          state.cliDetections,
          state.cliConsent,
          state.invokeRunner,
        );
        return okResult(result);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const routeHistoryTool: Tool = {
    definition: toolDef(
      'router_v30_route_history',
      'Show v30 routing decision history: summary (total, succeeded/failed, per-model counts, total/average estimated cost, measured-latency ratio, most chosen model) plus the most recent decisions.',
      {
        count: { type: 'number', description: 'How many recent decisions to return (default 10).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const count = getNumberArg(args, 'count', false, 10);
        return okResult({
          summary: state.history.summary(),
          recent: state.history.recent(count),
          length: state.history.length,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const budgetSetTool: Tool = {
    definition: toolDef(
      'router_v30_budget_set',
      'Set (or update) the daily spending cap for one v30 provider (USD/day, UTC day). Optionally record spend already made today. Route avoids providers that are over budget.',
      {
        provider: { type: 'string', description: 'Provider id.' },
        dailyCapUsd: { type: 'number', description: 'Daily cap in USD (0 = unlimited).' },
        recordSpendUsd: { type: 'number', description: 'Spend to record for today (USD, optional).' },
      },
      ['provider', 'dailyCapUsd'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const provider = getStringArg(args, 'provider');
        const dailyCapUsd = getNumberArg(args, 'dailyCapUsd');
        const budget = state.budget.setBudget(provider, dailyCapUsd);
        const spend = getOptionalNumberArg(args, 'recordSpendUsd');
        const updated = spend !== undefined ? state.budget.recordSpend(provider, spend) : budget;
        return okResult({ budget: updated ?? budget });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const budgetReportTool: Tool = {
    definition: toolDef(
      'router_v30_budget_report',
      'Report v30 provider budgets: daily cap, spent today, remaining, and over-budget providers (UTC day).',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      try {
        const budgets = state.budget.allBudgets();
        return okResult({
          budgets: budgets.map((b) => ({
            ...b,
            remainingUsd: state.budget.remainingUsd(b.provider),
            overBudget: state.budget.isOverBudget(b.provider),
          })),
          overBudgetProviders: budgets
            .filter((b) => state.budget.isOverBudget(b.provider))
            .map((b) => b.provider),
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const policyGetTool: Tool = {
    definition: toolDef(
      'router_v30_policy_get',
      'Show the current v30 routing policy (profile, weights, allow/block lists, cost/latency caps, fallback, auto-refresh) plus validation errors if any.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      try {
        return okResult({
          policy: state.policy,
          errors: validateRoutingPolicyV30(state.policy),
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const policySetTool: Tool = {
    definition: toolDef(
      'router_v30_policy_set',
      'Update the v30 routing policy (partial merge). Invalid patches are rejected and the old policy is kept. Weights are 0..1; profile is fastest | cheapest | balanced | quality.',
      {
        profile: { type: 'string', description: 'Routing profile (fastest, cheapest, balanced, quality).' },
        latencyWeight: { type: 'number', description: 'Custom latency weight 0..1.' },
        costWeight: { type: 'number', description: 'Custom cost weight 0..1.' },
        qualityWeight: { type: 'number', description: 'Custom quality weight 0..1.' },
        allowedProviders: { type: 'array', description: 'Allowed providers (empty = all).' },
        allowedModels: { type: 'array', description: 'Allowed models as provider::modelId (empty = all).' },
        blockedModels: { type: 'array', description: 'Blocked models as provider::modelId.' },
        maxCostPerRequestUsd: { type: 'number', description: 'Max estimated cost per request (USD, 0 = no cap).' },
        maxLatencyMs: { type: 'number', description: 'Max latency accepted (ms, 0 = no cap).' },
        preferLocal: { type: 'boolean', description: 'Prefer free/local models on near-ties.' },
        allowDeprecated: { type: 'boolean', description: 'Allow deprecated models.' },
        fallbackEnabled: { type: 'boolean', description: 'Enable fallback chains.' },
        maxFallbackAttempts: { type: 'number', description: 'Max fallback attempts per call (0..10).' },
        autoRefreshEnabled: { type: 'boolean', description: 'Enable controlled catalog auto-refresh (default off).' },
        autoRefreshMinIntervalMs: { type: 'number', description: 'Minimum ms between auto-refreshes (>= 60000).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const patch: Partial<RoutingPolicyV30> = {};
        const profile = getOptionalStringArg(args, 'profile');
        if (profile !== undefined) {
          const profiles: RoutingProfileV30[] = ['fastest', 'cheapest', 'balanced', 'quality'];
          if (!profiles.includes(profile as RoutingProfileV30)) {
            return errorResult(`profile must be one of: ${profiles.join(', ')}`);
          }
          patch.profile = profile as RoutingProfileV30;
        }
        const lat = getOptionalNumberArg(args, 'latencyWeight');
        const cost = getOptionalNumberArg(args, 'costWeight');
        const qual = getOptionalNumberArg(args, 'qualityWeight');
        if (lat !== undefined || cost !== undefined || qual !== undefined) {
          patch.customWeights = {
            latency: lat ?? state.policy.customWeights?.latency ?? 0.35,
            cost: cost ?? state.policy.customWeights?.cost ?? 0.35,
            quality: qual ?? state.policy.customWeights?.quality ?? 0.3,
          };
        }
        const allowedProviders = getStringArrayArg(args, 'allowedProviders');
        if (allowedProviders !== undefined) patch.allowedProviders = allowedProviders;
        const allowedModels = getStringArrayArg(args, 'allowedModels');
        if (allowedModels !== undefined) patch.allowedModels = allowedModels;
        const blockedModels = getStringArrayArg(args, 'blockedModels');
        if (blockedModels !== undefined) patch.blockedModels = blockedModels;
        const maxCost = getOptionalNumberArg(args, 'maxCostPerRequestUsd');
        if (maxCost !== undefined) patch.maxCostPerRequestUsd = maxCost;
        const maxLatency = getOptionalNumberArg(args, 'maxLatencyMs');
        if (maxLatency !== undefined) patch.maxLatencyMs = maxLatency;
        if (args.preferLocal !== undefined) patch.preferLocal = getBoolArg(args, 'preferLocal', false);
        if (args.allowDeprecated !== undefined) patch.allowDeprecated = getBoolArg(args, 'allowDeprecated', false);
        if (args.fallbackEnabled !== undefined) patch.fallbackEnabled = getBoolArg(args, 'fallbackEnabled', true);
        const maxFallback = getOptionalNumberArg(args, 'maxFallbackAttempts');
        if (maxFallback !== undefined) patch.maxFallbackAttempts = maxFallback;
        const arEnabled = args.autoRefreshEnabled !== undefined
          ? getBoolArg(args, 'autoRefreshEnabled', false)
          : undefined;
        const arInterval = getOptionalNumberArg(args, 'autoRefreshMinIntervalMs');
        if (arEnabled !== undefined || arInterval !== undefined) {
          patch.autoRefreshCatalog = {
            ...state.policy.autoRefreshCatalog,
            enabled: arEnabled ?? state.policy.autoRefreshCatalog.enabled,
            minIntervalMs: arInterval ?? state.policy.autoRefreshCatalog.minIntervalMs,
          };
        }
        const { policy, errors } = mergeRoutingPolicyV30(state.policy, patch);
        if (errors.length > 0) return errorResult(`Invalid policy: ${errors.join('; ')}`);
        state.policy = policy;
        return okResult({ policy, errors: [] });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  return [
    catalogListTool,
    catalogGetTool,
    catalogRefreshTool,
    catalogStaleTool,
    routeTool,
    latencyRecordTool,
    latencyStatsTool,
    fallbackPlanTool,
    fallbackRunTool,
    healthProbeTool,
    healthSummaryTool,
    cliDetectTool,
    cliListTool,
    cliConsentTool,
    cliEnableTool,
    cliLabelTool,
    cliInvokeTool,
    routeHistoryTool,
    budgetSetTool,
    budgetReportTool,
    policyGetTool,
    policySetTool,
  ];
}

export const ROUTER_V30_TOOLS: Tool[] = createRouterV30Tools();
