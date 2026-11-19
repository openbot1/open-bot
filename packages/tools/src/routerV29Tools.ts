/**
 * Router v29 tools (v1.42, Doi T5) — registered in ALL_TOOLS
 * (see tools.ts).
 *
 * 15 tools (thuan tren state in-memory mac dinh; host co the
 * truyen state rieng qua createRouterV29Tools):
 * - `router_v29_catalog_list` / `router_v29_catalog_get` /
 *   `router_v29_catalog_refresh` — xem/loc/cap nhat danh muc model
 *   (Gemini 3.x live, gpt-realtime-2.1/2.1-mini, GPT-Live,
 *   Gemini 3.8 Live — chi metadata/config, khong goi API live).
 * - `router_v29_route` — chon model theo latency/cost/capability
 *   (voice realtime vs text) + giai thich quyet dinh.
 * - `router_v29_architecture_recommend` — goi y kien truc voice
 *   (cascaded / turn-based realtime / full-duplex) theo muc tieu
 *   do tre + barge-in.
 * - `router_v29_cost_record` / `router_v29_cost_report` /
 *   `router_v29_cost_budget_set` — ghi so chi phi theo model,
 *   bao cao theo ngay/phien, dat ngan sach ngay/phien.
 * - `router_v29_fallback_plan` / `router_v29_fallback_run` — lap
 *   ke hoach + chay fallback chain (executor mock xac dinh qua
 *   `failModels`; khong goi model that).
 * - `router_v29_health_probe` / `router_v29_health_summary` —
 *   mock probe suc khoe tung provider + tom tat suc khoe.
 * - `router_v29_provider_config` — xem/dat/bat/tat cau hinh tung
 *   provider (uu tien, xac thuc, timeout, retry).
 * - `router_v29_cost_forecast` — du bao chi phi tu lich su ledger
 *   (trung binh/ngay, 7/30 ngay toi, toc do dot ngan sach, xu huong
 *   model, model thay the re hon).
 * - `router_v29_policy` — xem/dat chinh sach routing theo bot
 *   (provider/model cho phep, tran gia/do tre, cam voice).
 *
 * Khong goi model that, khong goi API that, khong doc/gui credential.
 */

import type { Tool } from '@open-bot/core';
import {
  BotRoutingPolicyStoreV29,
  FallbackChainRegistryV29,
  ModelCostLedgerV29,
  ProviderConfigStoreV29,
  ProviderHealthTrackerV29,
  applyPolicyToRoutingRequestV29,
  buildDefaultFallbackChainV29,
  budgetBurnV29,
  cheaperAlternativeV29,
  classifyProviderErrorV29,
  defaultMockProberV29,
  defaultModelCatalogV29,
  emptyCapabilitiesV29,
  estimateModelCostV29,
  explainRoutingDecisionV29,
  filterCatalogV29,
  findModelV29,
  forecastCostV29,
  isRetryableProviderErrorV29,
  modelTrendsV29,
  planFallbackChainV29,
  recommendVoiceArchitectureV29,
  refreshModelCatalogV29,
  routeModelV29,
  runFallbackChainV29,
  summarizeCatalogV29,
  validateFallbackChainV29,
  type BotRoutingPolicyV29,
  type FallbackChainConfigV29,
  type FallbackStepV29,
  type ModelCatalogEntryV29,
  type ModelFamilyV29,
  type ModelKindV29,
  type ProviderAuthKindV29,
  type ProviderConfigV29,
  type RealtimeArchitectureV29,
  type RoutingProfileV29,
  type RoutingRequestV29,
} from '@open-bot/core';

export const ROUTER_V29_TOOL_NAMES = [
  'router_v29_catalog_list',
  'router_v29_catalog_get',
  'router_v29_catalog_refresh',
  'router_v29_route',
  'router_v29_architecture_recommend',
  'router_v29_cost_record',
  'router_v29_cost_report',
  'router_v29_cost_budget_set',
  'router_v29_fallback_plan',
  'router_v29_fallback_run',
  'router_v29_health_probe',
  'router_v29_health_summary',
  'router_v29_provider_config',
  'router_v29_cost_forecast',
  'router_v29_policy',
] as const;

export function isRouterV29ToolName(name: string): boolean {
  return (ROUTER_V29_TOOL_NAMES as readonly string[]).includes(name);
}

/** State dung chung cua bo tool (host co the truyen state rieng). */
export interface RouterV29State {
  catalog: ModelCatalogEntryV29[];
  ledger: ModelCostLedgerV29;
  health: ProviderHealthTrackerV29;
  chains: FallbackChainRegistryV29;
  providers: ProviderConfigStoreV29;
  policies: BotRoutingPolicyStoreV29;
}

export function createDefaultRouterV29State(): RouterV29State {
  return {
    catalog: defaultModelCatalogV29(),
    ledger: new ModelCostLedgerV29(),
    health: new ProviderHealthTrackerV29(),
    chains: new FallbackChainRegistryV29(),
    providers: new ProviderConfigStoreV29(),
    policies: new BotRoutingPolicyStoreV29(),
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

function getObjectArg(args: Record<string, unknown>, name: string, required = true): Record<string, unknown> {
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

function getObjectArrayArg(args: Record<string, unknown>, name: string): Record<string, unknown>[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'object' || v === null || Array.isArray(v))) {
    throw new Error(`Argument "${name}" must be an array of objects.`);
  }
  return value as Record<string, unknown>[];
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) throw new Error(`"${field}" phai la number.`);
  return value;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`"${field}" phai la string khong rong.`);
  return value;
}

/** Parse mot muc catalog tu args (tra loi neu sai dinh dang). */
function parseCatalogEntryV29(raw: Record<string, unknown>, index: number): ModelCatalogEntryV29 {
  const prefix = `updates[${index}]`;
  const capabilitiesRaw = raw.capabilities;
  const capabilities = { ...emptyCapabilitiesV29() };
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
  const entry: ModelCatalogEntryV29 = {
    modelId: asString(raw.modelId, `${prefix}.modelId`),
    provider: asString(raw.provider, `${prefix}.provider`),
    family: (typeof raw.family === 'string' && raw.family !== '' ? raw.family : 'other') as ModelFamilyV29,
    displayName: asString(raw.displayName, `${prefix}.displayName`),
    kind: (typeof raw.kind === 'string' && raw.kind !== '' ? raw.kind : 'text') as ModelKindV29,
    architecture: (typeof raw.architecture === 'string' && raw.architecture !== ''
      ? raw.architecture
      : 'cascaded') as RealtimeArchitectureV29,
    contextTokens: asNumber(raw.contextTokens, `${prefix}.contextTokens`),
    maxOutputTokens: asNumber(raw.maxOutputTokens, `${prefix}.maxOutputTokens`),
    inputPricePer1kUsd: asNumber(raw.inputPricePer1kUsd, `${prefix}.inputPricePer1kUsd`),
    outputPricePer1kUsd: asNumber(raw.outputPricePer1kUsd, `${prefix}.outputPricePer1kUsd`),
    quality: asNumber(raw.quality, `${prefix}.quality`),
    typicalLatencyMs: asNumber(raw.typicalLatencyMs, `${prefix}.typicalLatencyMs`),
    capabilities,
  };
  if (typeof raw.perMinuteUsd === 'number') entry.perMinuteUsd = raw.perMinuteUsd;
  if (typeof raw.released === 'string') entry.released = raw.released;
  if (typeof raw.notes === 'string') entry.notes = raw.notes;
  if (typeof raw.deprecated === 'boolean') entry.deprecated = raw.deprecated;
  return entry;
}

/** Parse mot buoc fallback tu args. */
function parseFallbackStepV29(raw: Record<string, unknown>, index: number): FallbackStepV29 {
  const step: FallbackStepV29 = {
    modelId: asString(raw.modelId, `steps[${index}].modelId`),
    provider: asString(raw.provider, `steps[${index}].provider`),
  };
  if (typeof raw.reason === 'string') step.reason = raw.reason;
  return step;
}

/** Parse cau hinh provider tu args (field thieu lay mac dinh). */
function parseProviderConfigV29(raw: Record<string, unknown>): ProviderConfigV29 {
  const authKinds: readonly string[] = ['api-key', 'cli-login', 'oauth', 'none', 'local'];
  const authKind = typeof raw.authKind === 'string' ? raw.authKind : 'api-key';
  if (!authKinds.includes(authKind)) throw new Error(`authKind phai la mot trong: ${authKinds.join(', ')}.`);
  const config: ProviderConfigV29 = {
    provider: asString(raw.provider, 'config.provider'),
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    priority: typeof raw.priority === 'number' ? raw.priority : 5,
    authKind: authKind as ProviderAuthKindV29,
    timeoutMs: typeof raw.timeoutMs === 'number' ? raw.timeoutMs : 60000,
    maxRetries: typeof raw.maxRetries === 'number' ? raw.maxRetries : 2,
    local: typeof raw.local === 'boolean' ? raw.local : false,
  };
  if (typeof raw.rateLimitPerMin === 'number') config.rateLimitPerMin = raw.rateLimitPerMin;
  if (typeof raw.notes === 'string') config.notes = raw.notes;
  return config;
}

/** Parse chinh sach routing theo bot tu args. */
function parseBotRoutingPolicyV29(raw: Record<string, unknown>): BotRoutingPolicyV29 {
  const policy: BotRoutingPolicyV29 = { botId: asString(raw.botId, 'policy.botId') };
  const stringList = (value: unknown, field: string): string[] | undefined => {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
      throw new Error(`policy.${field} phai la array string.`);
    }
    return value as string[];
  };
  policy.allowedProviders = stringList(raw.allowedProviders, 'allowedProviders');
  policy.deniedProviders = stringList(raw.deniedProviders, 'deniedProviders');
  policy.allowedModels = stringList(raw.allowedModels, 'allowedModels');
  policy.deniedModels = stringList(raw.deniedModels, 'deniedModels');
  if (typeof raw.defaultProfile === 'string') {
    policy.defaultProfile = raw.defaultProfile as BotRoutingPolicyV29['defaultProfile'];
  }
  if (typeof raw.maxCostPerTurnUsd === 'number') policy.maxCostPerTurnUsd = raw.maxCostPerTurnUsd;
  if (typeof raw.maxLatencyMs === 'number') policy.maxLatencyMs = raw.maxLatencyMs;
  if (typeof raw.minQuality === 'number') policy.minQuality = raw.minQuality;
  if (typeof raw.voiceAllowed === 'boolean') policy.voiceAllowed = raw.voiceAllowed;
  if (typeof raw.preferLocal === 'boolean') policy.preferLocal = raw.preferLocal;
  if (typeof raw.fallbackChainId === 'string') policy.fallbackChainId = raw.fallbackChainId;
  return policy;
}

export function createRouterV29Tools(
  state: RouterV29State = createDefaultRouterV29State(),
): Tool[] {
  const { ledger, health, chains, providers, policies } = state;

  const catalogListTool: Tool = {
    definition: toolDef(
      'router_v29_catalog_list',
      'List the v29 model catalog (metadata only — Gemini 3.x live family, gpt-realtime-2.1/2.1-mini, GPT-Live, Gemini 3.8 Live, text fallbacks, local models). Filter by provider, family, kind, architecture, realtime-only, min context, min quality. No live API call.',
      {
        provider: { type: 'string', description: 'Filter by provider (openai, gemini, anthropic, xai, ollama).' },
        family: { type: 'string', description: 'Filter by family (gpt-realtime, gpt-live, gemini-live, gemini, openai, anthropic, grok, local, other).' },
        kind: { type: 'string', description: 'Filter by kind (text, realtime, live, embedding, image, audio).' },
        architecture: { type: 'string', description: 'Filter by voice architecture (cascaded, turn-based-realtime, full-duplex).' },
        realtimeOnly: { type: 'boolean', description: 'Only realtime/live (voice) models.' },
        minContextTokens: { type: 'number', description: 'Minimum context tokens.' },
        minQuality: { type: 'number', description: 'Minimum quality 0..1.' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const models = filterCatalogV29(state.catalog, {
          provider: getOptionalStringArg(args, 'provider'),
          family: getOptionalStringArg(args, 'family') as ModelFamilyV29 | undefined,
          kind: getOptionalStringArg(args, 'kind') as ModelKindV29 | undefined,
          architecture: getOptionalStringArg(args, 'architecture') as RealtimeArchitectureV29 | undefined,
          realtimeOnly: getBoolArg(args, 'realtimeOnly', false),
          minContextTokens: getOptionalNumberArg(args, 'minContextTokens'),
          minQuality: getOptionalNumberArg(args, 'minQuality'),
        });
        return okResult({ models, summary: summarizeCatalogV29(state.catalog), count: models.length });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const catalogGetTool: Tool = {
    definition: toolDef(
      'router_v29_catalog_get',
      'Get one v29 catalog entry by modelId, plus a sample cost estimate (1000 input / 500 output tokens, 0 minutes by default).',
      {
        modelId: { type: 'string', description: 'Model id, e.g. gpt-realtime-2.1.' },
        inputTokens: { type: 'number', description: 'Sample input tokens for the estimate (default 1000).' },
        outputTokens: { type: 'number', description: 'Sample output tokens for the estimate (default 500).' },
        minutes: { type: 'number', description: 'Sample voice minutes for the estimate (default 0).' },
      },
      ['modelId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const modelId = getStringArg(args, 'modelId');
        const entry = findModelV29(state.catalog, modelId);
        if (!entry) return errorResult(`Khong co model "${modelId}" trong catalog v29.`);
        const estimate = estimateModelCostV29(entry, {
          inputTokens: getOptionalNumberArg(args, 'inputTokens') ?? 1000,
          outputTokens: getOptionalNumberArg(args, 'outputTokens') ?? 500,
          minutes: getOptionalNumberArg(args, 'minutes') ?? 0,
        });
        return okResult({ entry, sampleEstimate: estimate });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const catalogRefreshTool: Tool = {
    definition: toolDef(
      'router_v29_catalog_refresh',
      'Refresh the v29 catalog by merging host-supplied entries (metadata only, no network fetch): new entries are added, changed ones updated, identical ones unchanged, invalid ones rejected with reasons. Set removeMissing to drop entries absent from updates.',
      {
        updates: { type: 'array', description: 'Catalog entries to merge (each needs modelId, provider, displayName, kind, contextTokens, maxOutputTokens, prices, quality, typicalLatencyMs, capabilities).', items: { type: 'object' } },
        removeMissing: { type: 'boolean', description: 'Remove catalog entries absent from updates (default false).' },
      },
      ['updates'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const rawUpdates = getObjectArrayArg(args, 'updates');
        const parsed: ModelCatalogEntryV29[] = [];
        const parseRejected: { modelId: string; errors: string[] }[] = [];
        rawUpdates.forEach((raw, i) => {
          try {
            parsed.push(parseCatalogEntryV29(raw, i));
          } catch (err) {
            const id = typeof raw.modelId === 'string' ? raw.modelId : `(updates[${i}])`;
            parseRejected.push({ modelId: id, errors: [(err as Error).message] });
          }
        });
        const result = refreshModelCatalogV29(state.catalog, parsed, {
          removeMissing: getBoolArg(args, 'removeMissing', false),
        });
        state.catalog = result.catalog;
        return okResult({ ...result, rejected: [...result.rejected, ...parseRejected] });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const routeTool: Tool = {
    definition: toolDef(
      'router_v29_route',
      'Route a request to the best v29 model by latency/cost/capability: realtime voice requests only consider realtime/live models, cheap requests prefer cheap/local models, long-context requests need 128k+ models. Returns the chosen model, ranked alternatives, rejected models with reasons, and a readable explanation.',
      {
        needsRealtimeVoice: { type: 'boolean', description: 'Needs speech-to-speech voice realtime.' },
        needsFullDuplex: { type: 'boolean', description: 'Needs full-duplex (speak + listen at once).' },
        needsBargeIn: { type: 'boolean', description: 'Needs barge-in (interrupt while the model speaks).' },
        needsAsyncFunctionCalling: { type: 'boolean', description: 'Needs async function calling.' },
        needsProactiveAudio: { type: 'boolean', description: 'Needs proactive audio.' },
        needsToolCalling: { type: 'boolean', description: 'Needs tool/function calling.' },
        needsVision: { type: 'boolean', description: 'Needs vision.' },
        minContextTokens: { type: 'number', description: 'Minimum context tokens.' },
        minQuality: { type: 'number', description: 'Minimum quality 0..1.' },
        maxLatencyMs: { type: 'number', description: 'Maximum acceptable latency in ms.' },
        maxCostUsd: { type: 'number', description: 'Maximum cost per turn in USD.' },
        estimatedInputTokens: { type: 'number', description: 'Estimated input tokens (default 1000).' },
        estimatedOutputTokens: { type: 'number', description: 'Estimated output tokens (default 500).' },
        estimatedMinutes: { type: 'number', description: 'Estimated voice minutes (default 0).' },
        profile: { type: 'string', description: 'Scoring profile: fastest, cheapest, balanced, quality (default balanced).' },
        excludeModelIds: { type: 'array', items: { type: 'string' }, description: 'Model ids to exclude (e.g. just failed).' },
        excludeProviders: { type: 'array', items: { type: 'string' }, description: 'Providers to exclude.' },
        preferLocal: { type: 'boolean', description: 'Prefer free local models on ties.' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const profile = getOptionalStringArg(args, 'profile');
        const profiles: readonly string[] = ['fastest', 'cheapest', 'balanced', 'quality'];
        if (profile !== undefined && !profiles.includes(profile)) {
          return errorResult(`profile phai la mot trong: ${profiles.join(', ')}.`);
        }
        const decision = routeModelV29(state.catalog, {
          needsRealtimeVoice: getBoolArg(args, 'needsRealtimeVoice', false),
          needsFullDuplex: getBoolArg(args, 'needsFullDuplex', false),
          needsBargeIn: getBoolArg(args, 'needsBargeIn', false),
          needsAsyncFunctionCalling: getBoolArg(args, 'needsAsyncFunctionCalling', false),
          needsProactiveAudio: getBoolArg(args, 'needsProactiveAudio', false),
          needsToolCalling: getBoolArg(args, 'needsToolCalling', false),
          needsVision: getBoolArg(args, 'needsVision', false),
          minContextTokens: getOptionalNumberArg(args, 'minContextTokens'),
          minQuality: getOptionalNumberArg(args, 'minQuality'),
          maxLatencyMs: getOptionalNumberArg(args, 'maxLatencyMs'),
          maxCostUsd: getOptionalNumberArg(args, 'maxCostUsd'),
          estimatedInputTokens: getOptionalNumberArg(args, 'estimatedInputTokens'),
          estimatedOutputTokens: getOptionalNumberArg(args, 'estimatedOutputTokens'),
          estimatedMinutes: getOptionalNumberArg(args, 'estimatedMinutes'),
          profile: (profile ?? 'balanced') as RoutingProfileV29,
          excludeModelIds: getStringArrayArg(args, 'excludeModelIds'),
          excludeProviders: getStringArrayArg(args, 'excludeProviders'),
          preferLocal: getBoolArg(args, 'preferLocal', false),
        });
        return okResult({ ...decision, explanation: explainRoutingDecisionV29(decision) });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const architectureRecommendTool: Tool = {
    definition: toolDef(
      'router_v29_architecture_recommend',
      'Recommend a voice architecture (cascaded ~500-800ms, turn-based realtime, or full-duplex ~300ms) from the latency target and required features (barge-in, full-duplex, proactive audio), with suggested realtime models from the catalog.',
      {
        targetLatencyMs: { type: 'number', description: 'Latency target in ms (default 800).' },
        needsBargeIn: { type: 'boolean', description: 'Needs barge-in.' },
        needsFullDuplex: { type: 'boolean', description: 'Needs full-duplex.' },
        needsProactiveAudio: { type: 'boolean', description: 'Needs proactive audio.' },
        textOnlyAvailable: { type: 'boolean', description: 'Only text models + STT/TTS are available (forces cascaded).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const rec = recommendVoiceArchitectureV29(
          {
            targetLatencyMs: getOptionalNumberArg(args, 'targetLatencyMs'),
            needsBargeIn: getBoolArg(args, 'needsBargeIn', false),
            needsFullDuplex: getBoolArg(args, 'needsFullDuplex', false),
            needsProactiveAudio: getBoolArg(args, 'needsProactiveAudio', false),
            textOnlyAvailable: getBoolArg(args, 'textOnlyAvailable', false),
          },
          state.catalog,
        );
        return okResult(rec);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const costRecordTool: Tool = {
    definition: toolDef(
      'router_v29_cost_record',
      'Record one model usage in the per-model cost ledger (tokens + voice minutes). Prices come from the catalog when the model is known; pass prices explicitly for unknown models. Returns the record and the day/session totals so far.',
      {
        modelId: { type: 'string', description: 'Model id.' },
        provider: { type: 'string', description: 'Provider (defaults to the catalog provider when the model is known).' },
        sessionId: { type: 'string', description: 'Session id.' },
        inputTokens: { type: 'number', description: 'Input tokens (default 0).' },
        outputTokens: { type: 'number', description: 'Output tokens (default 0).' },
        minutes: { type: 'number', description: 'Voice minutes (default 0).' },
        inputPricePer1kUsd: { type: 'number', description: 'Override input price USD/1k (default: catalog price).' },
        outputPricePer1kUsd: { type: 'number', description: 'Override output price USD/1k (default: catalog price).' },
        perMinuteUsd: { type: 'number', description: 'Override per-minute price USD (default: catalog price).' },
        label: { type: 'string', description: 'Optional label for the record.' },
      },
      ['modelId', 'sessionId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const modelId = getStringArg(args, 'modelId');
        const entry = findModelV29(state.catalog, modelId);
        const provider = getOptionalStringArg(args, 'provider') ?? entry?.provider ?? '';
        if (!provider) return errorResult(`Khong biet provider cua model "${modelId}" — truyen provider hoac them model vao catalog truoc.`);
        const record = ledger.recordUsage({
          modelId,
          provider,
          sessionId: getStringArg(args, 'sessionId'),
          inputTokens: getOptionalNumberArg(args, 'inputTokens') ?? 0,
          outputTokens: getOptionalNumberArg(args, 'outputTokens') ?? 0,
          minutes: getOptionalNumberArg(args, 'minutes') ?? 0,
          inputPricePer1kUsd: getOptionalNumberArg(args, 'inputPricePer1kUsd') ?? entry?.inputPricePer1kUsd,
          outputPricePer1kUsd: getOptionalNumberArg(args, 'outputPricePer1kUsd') ?? entry?.outputPricePer1kUsd,
          perMinuteUsd: getOptionalNumberArg(args, 'perMinuteUsd') ?? entry?.perMinuteUsd,
          label: getOptionalStringArg(args, 'label'),
        });
        return okResult({
          record,
          dayTotalUsd: ledger.costByDay(record.day),
          sessionTotalUsd: ledger.costBySession(record.sessionId),
          modelTotalUsd: ledger.costByModel(modelId),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const costReportTool: Tool = {
    definition: toolDef(
      'router_v29_cost_report',
      'Cost ledger report: totals by model/day/session/provider, top model and top day, plus the daily/session budget check (over-budget and near-limit warnings).',
      {
        day: { type: 'string', description: 'Day YYYY-MM-DD for the budget check (default today).' },
        sessionId: { type: 'string', description: 'Focus one session (also returns its total).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const summary = ledger.summary();
        const budget = ledger.checkBudget(getOptionalStringArg(args, 'day'));
        const sessionId = getOptionalStringArg(args, 'sessionId');
        return okResult({
          summary,
          budget,
          ...(sessionId !== undefined ? { sessionTotalUsd: ledger.costBySession(sessionId) } : {}),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const costBudgetSetTool: Tool = {
    definition: toolDef(
      'router_v29_cost_budget_set',
      'Set budgets for the cost ledger: a daily budget in USD (use -1 to clear it) and/or a per-session budget for one session. Returns the budget check after the change.',
      {
        dailyBudgetUsd: { type: 'number', description: 'Daily budget in USD (-1 clears it).' },
        sessionId: { type: 'string', description: 'Session id for a per-session budget.' },
        sessionBudgetUsd: { type: 'number', description: 'Per-session budget in USD.' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const daily = getOptionalNumberArg(args, 'dailyBudgetUsd');
        if (daily !== undefined) {
          if (daily < 0 && daily !== -1) return errorResult('dailyBudgetUsd phai >= 0 hoac -1 (xoa).');
          ledger.setDailyBudget(daily === -1 ? null : daily);
        }
        const sessionId = getOptionalStringArg(args, 'sessionId');
        const sessionBudget = getOptionalNumberArg(args, 'sessionBudgetUsd');
        if (sessionId !== undefined && sessionBudget !== undefined) {
          ledger.setSessionBudget(sessionId, sessionBudget);
        } else if (sessionId !== undefined || sessionBudget !== undefined) {
          return errorResult('Can ca sessionId va sessionBudgetUsd de dat ngan sach phien.');
        }
        return okResult({ dailyBudgetUsd: ledger.getDailyBudget(), budget: ledger.checkBudget() });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const fallbackPlanTool: Tool = {
    definition: toolDef(
      'router_v29_fallback_plan',
      'Plan a fallback after a model failed: classify the error (rate-limit/auth/server/timeout/not-found/invalid-request), say whether another model is worth trying, and list the next steps in the chain. Auth/invalid-request errors stop the chain.',
      {
        chainId: { type: 'string', description: 'Registered chain id (default: build a default chain for failedModelId).' },
        failedModelId: { type: 'string', description: 'Model that just failed.' },
        status: { type: 'number', description: 'HTTP status of the failure (e.g. 429, 500, 401).' },
        code: { type: 'string', description: 'Error code (e.g. ETIMEDOUT).' },
        message: { type: 'string', description: 'Error message.' },
        steps: { type: 'array', description: 'Explicit chain steps [{modelId, provider, reason?}] when no chainId is given.', items: { type: 'object' } },
      },
      ['failedModelId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const failedModelId = getStringArg(args, 'failedModelId');
        const chainId = getOptionalStringArg(args, 'chainId');
        let config: FallbackChainConfigV29 | undefined;
        if (chainId !== undefined) {
          config = chains.get(chainId);
          if (!config) return errorResult(`Khong co chain "${chainId}" — dang ky bang router_v29_fallback_run truoc hoac truyen steps.`);
        } else {
          const rawSteps = getObjectArrayArg(args, 'steps');
          if (rawSteps.length > 0) {
            const steps = rawSteps.map((raw, i) => parseFallbackStepV29(raw, i));
            const validation = validateFallbackChainV29({ chainId: 'inline', steps });
            if (!validation.ok) return errorResult(validation.errors.join('; '));
            config = { chainId: 'inline', steps };
          } else {
            config = buildDefaultFallbackChainV29(state.catalog, failedModelId, `default-${failedModelId}`);
          }
        }
        const plan = planFallbackChainV29(config, failedModelId, {
          status: getOptionalNumberArg(args, 'status'),
          code: getOptionalStringArg(args, 'code'),
          message: getOptionalStringArg(args, 'message'),
        });
        return okResult({
          ...plan,
          errorKind: plan.errorKind,
          retryable: plan.retryable,
          kindRetryable: isRetryableProviderErrorV29(plan.errorKind),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const fallbackRunTool: Tool = {
    definition: toolDef(
      'router_v29_fallback_run',
      'Run a fallback chain with a deterministic mock executor (no live model call): models listed in failModels fail with the given error (default 500 server error), every other model succeeds with a mock output. The run (attempts, reasons, fallback count) is recorded in the chain registry.',
      {
        chainId: { type: 'string', description: 'Chain id to register/run under (default "mock-run").' },
        steps: { type: 'array', description: 'Chain steps [{modelId, provider, reason?}]. Defaults to the default chain for primaryModelId.', items: { type: 'object' } },
        primaryModelId: { type: 'string', description: 'Primary model for the default chain when steps are omitted.' },
        failModels: { type: 'array', description: 'Models that must fail in the mock run: [{modelId, status?, code?, message?}].', items: { type: 'object' } },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const chainId = getOptionalStringArg(args, 'chainId') ?? 'mock-run';
        const rawSteps = getObjectArrayArg(args, 'steps');
        let config: FallbackChainConfigV29;
        if (rawSteps.length > 0) {
          const steps = rawSteps.map((raw, i) => parseFallbackStepV29(raw, i));
          config = { chainId, steps };
        } else {
          const primaryModelId = getOptionalStringArg(args, 'primaryModelId') ?? 'gpt-realtime-2.1';
          config = buildDefaultFallbackChainV29(state.catalog, primaryModelId, chainId);
        }
        const validation = chains.register(config);
        if (!validation.ok) return errorResult(validation.errors.join('; '));
        const failRaw = getObjectArrayArg(args, 'failModels');
        const failMap = new Map<string, { status?: number; code?: string; message?: string }>();
        for (const raw of failRaw) {
          const modelId = typeof raw.modelId === 'string' ? raw.modelId : '';
          if (!modelId) return errorResult('failModels[].modelId phai la string khong rong.');
          failMap.set(modelId, {
            status: typeof raw.status === 'number' ? raw.status : undefined,
            code: typeof raw.code === 'string' ? raw.code : undefined,
            message: typeof raw.message === 'string' ? raw.message : undefined,
          });
        }
        const result = await runFallbackChainV29(config, async (modelId) => {
          const fail = failMap.get(modelId);
          if (fail) {
            return {
              ok: false,
              error: {
                status: fail.status ?? 500,
                code: fail.code,
                message: fail.message ?? `mock loi ${fail.status ?? 500} cho ${modelId}.`,
              },
              latencyMs: 50,
            };
          }
          return { ok: true, output: `mock-ok (${modelId})`, latencyMs: 120 };
        });
        chains.recordRun(result);
        return okResult({
          ...result,
          errorKinds: result.attempts.map((a) => ({ modelId: a.modelId, errorKind: a.errorKind ?? null })),
          classified: result.attempts
            .filter((a) => a.errorMessage)
            .map((a) => ({ modelId: a.modelId, kind: classifyProviderErrorV29({ message: a.errorMessage }) })),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const healthProbeTool: Tool = {
    definition: toolDef(
      'router_v29_health_probe',
      'Mock-probe provider health (no network): each provider gets a deterministic mock latency from its name, or fails when listed in failProviders. Records status (healthy/degraded/unhealthy), latency, and last error in the tracker.',
      {
        providers: { type: 'array', items: { type: 'string' }, description: 'Providers to probe (default: all providers in the catalog).' },
        failProviders: { type: 'array', items: { type: 'string' }, description: 'Providers the mock prober must report as failed.' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const providers = getStringArrayArg(args, 'providers') ??
          [...new Set(state.catalog.map((m) => m.provider))];
        const failProviders = getStringArrayArg(args, 'failProviders') ?? [];
        const results = await health.probeAll(providers, defaultMockProberV29(failProviders));
        return okResult({ results, summary: health.summary() });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const healthSummaryTool: Tool = {
    definition: toolDef(
      'router_v29_health_summary',
      'Health summary for all probed providers: counts by status, worst status, per-provider record (last latency, consecutive failures, uptime ratio, last error), healthiest providers first, and stale providers not probed within maxAgeMs.',
      {
        maxAgeMs: { type: 'number', description: 'Staleness threshold in ms (default 60000).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const maxAgeMs = getOptionalNumberArg(args, 'maxAgeMs') ?? 60000;
        return okResult({
          summary: health.summary(),
          healthiest: health.healthiestProviders(),
          staleProviders: health.staleProviders(maxAgeMs),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const providerConfigTool: Tool = {
    definition: toolDef(
      'router_v29_provider_config',
      'Manage per-provider config for the v29 router: list all providers (sorted by priority), get one, set/replace one, or enable/disable one. Config holds priority, auth kind (name only, never a key), rate limit, timeout and retries — no live call, no credential.',
      {
        action: { type: 'string', description: 'list, get, set, enable or disable (default list).' },
        provider: { type: 'string', description: 'Provider id (required for get/set/enable/disable).' },
        config: { type: 'object', description: 'Provider config object for set (provider, enabled, priority, authKind, timeoutMs, maxRetries, local, rateLimitPerMin?, notes?).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getOptionalStringArg(args, 'action') ?? 'list';
        const actions: readonly string[] = ['list', 'get', 'set', 'enable', 'disable'];
        if (!actions.includes(action)) return errorResult(`action phai la mot trong: ${actions.join(', ')}.`);
        if (action === 'list') {
          return okResult({ providers: providers.list(), routingOrder: providers.routingOrder() });
        }
        const provider = getStringArg(args, 'provider');
        if (action === 'get') {
          const config = providers.get(provider);
          if (!config) return errorResult(`Khong co provider "${provider}".`);
          return okResult({ config, defaults: providers.defaultsFor(provider) });
        }
        if (action === 'set') {
          const raw = getObjectArg(args, 'config');
          const config = parseProviderConfigV29({ ...raw, provider });
          const validation = providers.upsert(config);
          if (!validation.ok) return errorResult(validation.errors.join('; '));
          return okResult({ config: providers.get(provider), providers: providers.list() });
        }
        const existing = providers.get(provider);
        if (!existing) return errorResult(`Khong co provider "${provider}".`);
        const validation = providers.patch(provider, { enabled: action === 'enable' });
        if (!validation.ok) return errorResult(validation.errors.join('; '));
        return okResult({ config: providers.get(provider) });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const costForecastTool: Tool = {
    definition: toolDef(
      'router_v29_cost_forecast',
      'Forecast spend from the per-model cost ledger history: average daily cost, 7/30-day projections, budget burn rate (days until a monthly budget runs out, daily over-budget warning), per-model 7-day trends, and a cheaper alternative for one model.',
      {
        windowDays: { type: 'number', description: 'History window in days for the average (default 30).' },
        endDay: { type: 'string', description: 'Last day YYYY-MM-DD for the window (default today).' },
        dailyBudgetUsd: { type: 'number', description: 'Daily budget in USD for the burn check.' },
        monthlyBudgetUsd: { type: 'number', description: 'Monthly budget in USD for the burn check.' },
        modelId: { type: 'string', description: 'Model id to find a cheaper alternative for.' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const records = ledger.allRecords();
        const forecast = forecastCostV29(records, {
          windowDays: getOptionalNumberArg(args, 'windowDays'),
          endDay: getOptionalStringArg(args, 'endDay'),
        });
        const burn = budgetBurnV29(records, {
          dailyBudgetUsd: getOptionalNumberArg(args, 'dailyBudgetUsd') ?? ledger.getDailyBudget(),
          monthlyBudgetUsd: getOptionalNumberArg(args, 'monthlyBudgetUsd'),
          windowDays: getOptionalNumberArg(args, 'windowDays'),
          endDay: getOptionalStringArg(args, 'endDay'),
        });
        const trends = modelTrendsV29(records, { endDay: getOptionalStringArg(args, 'endDay') });
        const modelId = getOptionalStringArg(args, 'modelId');
        return okResult({
          forecast,
          burn,
          trends,
          ...(modelId !== undefined
            ? { cheaperAlternative: cheaperAlternativeV29(state.catalog, modelId) }
            : {}),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const policyTool: Tool = {
    definition: toolDef(
      'router_v29_policy',
      'Get or set a per-bot routing policy: allowed/denied providers and models, default profile, per-turn cost/latency caps, minimum quality, voice allowed, prefer-local, fallback chain. Set validates (allow/deny overlap is rejected); get returns the default open policy when the bot has none.',
      {
        action: { type: 'string', description: 'get or set (default get).' },
        botId: { type: 'string', description: 'Bot id.' },
        policy: { type: 'object', description: 'Policy object for set (botId, allowedProviders?, deniedProviders?, allowedModels?, deniedModels?, defaultProfile?, maxCostPerTurnUsd?, maxLatencyMs?, minQuality?, voiceAllowed?, preferLocal?, fallbackChainId?).' },
        previewRequest: { type: 'object', description: 'Optional routing request to preview how the policy constrains it (returns the merged request + applied rules).' },
      },
      ['botId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getOptionalStringArg(args, 'action') ?? 'get';
        if (action !== 'get' && action !== 'set') return errorResult('action phai la get hoac set.');
        const botId = getStringArg(args, 'botId');
        if (action === 'get') {
          const policy = policies.get(botId);
          const previewRaw = args.previewRequest;
          if (previewRaw !== undefined && previewRaw !== null) {
            if (typeof previewRaw !== 'object' || Array.isArray(previewRaw)) {
              return errorResult('previewRequest phai la object.');
            }
            const preview = applyPolicyToRoutingRequestV29(policy, previewRaw as unknown as RoutingRequestV29);
            return okResult({ policy, preview });
          }
          return okResult({ policy, hasCustomPolicy: policies.has(botId) });
        }
        const raw = getObjectArg(args, 'policy');
        const policy = parseBotRoutingPolicyV29({ ...raw, botId });
        const validation = policies.set(policy);
        if (!validation.ok) return errorResult(validation.errors.join('; '));
        return okResult({ policy: policies.get(botId) });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    catalogListTool,
    catalogGetTool,
    catalogRefreshTool,
    routeTool,
    architectureRecommendTool,
    costRecordTool,
    costReportTool,
    costBudgetSetTool,
    fallbackPlanTool,
    fallbackRunTool,
    healthProbeTool,
    healthSummaryTool,
    providerConfigTool,
    costForecastTool,
    policyTool,
  ];
}

/** Placeholder tools (default in-memory state) for ALL_TOOLS. */
export const ROUTER_V29_TOOLS: Tool[] = createRouterV29Tools();
