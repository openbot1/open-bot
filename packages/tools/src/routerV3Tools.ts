/**
 * Router v3 tools (v1.18, Doi T3) — registered in ALL_TOOLS (see tools.ts).
 *
 * 10 tools (ham thuan tren state in-memory mac dinh; host co the
 * truyen state rieng qua createRouterV3Tools):
 * - `router_v3_providers_list` — catalog 100+ provider hop nhat
 *   (preset + dedicated + CLI), loc theo category/local/key/tu khoa.
 * - `router_v3_capability_check` — kiem tra model co du capability
 *   task can khong + de xuat model thay the.
 * - `router_v3_cost_estimate` — uoc tinh chi phi mot call (USD) tu
 *   bang cost cau hinh duoc (model local = 0).
 * - `router_v3_rank` — xep hang provider/model theo policy cua user
 *   (cheapest / fastest / balanced) + yeu cau capability.
 * - `router_v3_chat` — chat qua router v3: chon provider theo
 *   policy, fallback chain + retry + circuit breaker. Can key cua
 *   provider (host truyen qua state) hoac model local dang chay;
 *   khong co key thi tra guidance ro rang, khong throw.
 * - `router_v3_local_scan` — quet Ollama / vLLM / LM Studio /
 *   llama.cpp / textgen tren loopback, tu dang ky model tim duoc
 *   vao router (cost = 0).
 * - `router_v3_local_status` — health dinh ky cua cac server local
 *   + model local da dang ky.
 * - `router_v3_cost_set` — dat/ghi de gia mot model hoac gia mac
 *   dinh mot provider (user cau hinh, luu in-memory).
 * - `router_v3_circuit_status` — trang thai circuit breaker per
 *   provider + reset mot provider (user bat lai).
 * - `router_v3_latency_stats` — thong ke latency do that (p50/p90/
 *   error rate, rolling window) per provider+model.
 *
 * Khong goi API that khi test (executor/fetch inject duoc qua
 * state); khong doc credential — key do host truyen vao state.
 * Local scan chi goi HTTP loopback.
 */

import type { Tool } from '@open-bot/core';
import {
  CostTable,
  DEFAULT_LOCAL_SERVER_DEFS,
  LatencyTracker,
  LocalHealthMonitor,
  UnifiedRouterV3,
  buildRouterV3FailureGuidance,
  checkRequirements,
  checkRequirementsWithAlternative,
  listV3Providers,
  probesToLocalModels,
  scanAllLocalServers,
  searchV3Providers,
  suggestAlternative,
  type CapabilityRequirement,
  type LocalDetectFetch,
  type RouterV3LocalKind,
  type RouterV3Policy,
  type RouterV3ProviderCategory,
} from '@open-bot/core';

export const ROUTER_V3_TOOL_NAMES = [
  'router_v3_providers_list',
  'router_v3_capability_check',
  'router_v3_cost_estimate',
  'router_v3_rank',
  'router_v3_chat',
  'router_v3_local_scan',
  'router_v3_local_status',
  'router_v3_cost_set',
  'router_v3_circuit_status',
  'router_v3_latency_stats',
] as const;

export function isRouterV3ToolName(name: string): boolean {
  return (ROUTER_V3_TOOL_NAMES as readonly string[]).includes(name);
}

/** Fetch mac dinh cho local scan: global fetch (chi goi loopback). */
export const defaultRouterV3Fetch: LocalDetectFetch = (url, init) => fetch(url, init);

/** State dung chung cua bo tool router v3. */
export interface RouterV3State {
  router: UnifiedRouterV3;
  /** Monitor health dinh ky (tao luoi khi can, dung fetchFn cua state). */
  monitor: LocalHealthMonitor | null;
  /** Fetch dung cho local scan/monitor (mac dinh global fetch). */
  fetchFn: LocalDetectFetch;
  /** Key provider do host truyen vao (khong doc Vault o day). */
  apiKeys: Readonly<Record<string, string>>;
}

export function createDefaultRouterV3State(opts?: {
  apiKeys?: Readonly<Record<string, string>>;
  fetchFn?: LocalDetectFetch;
  config?: NonNullable<ConstructorParameters<typeof UnifiedRouterV3>[0]>['config'];
}): RouterV3State {
  return {
    router: new UnifiedRouterV3({ config: opts?.config, apiKeys: opts?.apiKeys }),
    monitor: null,
    fetchFn: opts?.fetchFn ?? defaultRouterV3Fetch,
    apiKeys: opts?.apiKeys ?? {},
  };
}

/** Lay (hoac tao) monitor health cua state. */
export function routerV3MonitorFor(state: RouterV3State): LocalHealthMonitor {
  if (!state.monitor) {
    state.monitor = new LocalHealthMonitor({ fetchFn: state.fetchFn });
  }
  return state.monitor;
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

function getNumberArg(args: Record<string, unknown>, name: string, required = false, fallback = 0): number {
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

/** Gom cac flag capability tu args thanh CapabilityRequirement (undefined khi rong). */
function requirementsFromArgs(args: Record<string, unknown>): CapabilityRequirement | undefined {
  const req: CapabilityRequirement = {};
  if (getBoolArg(args, 'needsToolCalling', false)) req.needsToolCalling = true;
  if (getBoolArg(args, 'needsVision', false)) req.needsVision = true;
  if (getBoolArg(args, 'needsStreaming', false)) req.needsStreaming = true;
  if (getBoolArg(args, 'needsJsonMode', false)) req.needsJsonMode = true;
  if (getBoolArg(args, 'needsReasoning', false)) req.needsReasoning = true;
  const minContext = getNumberArg(args, 'minContextWindow', false, 0);
  if (minContext > 0) req.minContextWindow = Math.floor(minContext);
  const minOutput = getNumberArg(args, 'minOutputTokens', false, 0);
  if (minOutput > 0) req.minOutputTokens = Math.floor(minOutput);
  return Object.keys(req).length > 0 ? req : undefined;
}

function runTool(fn: (args: Record<string, unknown>) => unknown): Tool {
  return {
    definition: { name: '', description: '', parameters: { type: 'object', properties: {}, required: [] } },
    needsApproval: false,
    execute: async (args: Record<string, unknown>) => {
      try {
        const value = await fn(args);
        return typeof value === 'string' ? value : okResult(value);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  } as Tool;
}

/** Tao bo tool router v3 tren state cho truoc. */
export function createRouterV3Tools(state: RouterV3State): Tool[] {
  const { router } = state;
  const defs: { name: string; description: string; properties: Record<string, unknown>; required: string[]; fn: (args: Record<string, unknown>) => unknown }[] = [
    {
      name: 'router_v3_providers_list',
      description: 'Liet ke catalog 100+ provider cua router v3 (preset OpenAI-compatible + dedicated + CLI); loc theo category, local, can key, tu khoa.',
      properties: {
        category: { type: 'string', enum: ['gateway', 'inference-cloud', 'model-vendor', 'regional', 'local', 'dedicated', 'cli'] },
        localOnly: { type: 'boolean' },
        needsKey: { type: 'boolean' },
        query: { type: 'string' },
        limit: { type: 'number' },
      },
      required: [],
      fn: (args) => {
        const category = getOptionalStringArg(args, 'category') as RouterV3ProviderCategory | undefined;
        const localOnly = getBoolArg(args, 'localOnly', false);
        const needsKey = args.needsKey === undefined ? undefined : getBoolArg(args, 'needsKey', false);
        const query = getOptionalStringArg(args, 'query');
        const limit = Math.max(1, Math.floor(getNumberArg(args, 'limit', false, 100)));
        let providers = query ? searchV3Providers(query, 1000) : listV3Providers();
        if (category) providers = providers.filter((p) => p.category === category);
        if (localOnly) providers = providers.filter((p) => p.local);
        if (needsKey !== undefined) providers = providers.filter((p) => p.needsKey === needsKey);
        const total = providers.length;
        return {
          total,
          providers: providers.slice(0, limit).map((p) => ({
            id: p.id,
            label: p.label,
            baseUrl: p.baseUrl,
            defaultModel: p.defaultModel,
            category: p.category,
            local: p.local,
            needsKey: p.needsKey,
            source: p.source,
          })),
        };
      },
    },
    {
      name: 'router_v3_capability_check',
      description: 'Kiem tra model co du capability task can khong (tool-calling, vision, streaming, JSON mode, reasoning, context/output toi thieu); de xuat model thay the khi thieu.',
      properties: {
        modelId: { type: 'string' },
        providerId: { type: 'string' },
        needsToolCalling: { type: 'boolean' },
        needsVision: { type: 'boolean' },
        needsStreaming: { type: 'boolean' },
        needsJsonMode: { type: 'boolean' },
        needsReasoning: { type: 'boolean' },
        minContextWindow: { type: 'number' },
        minOutputTokens: { type: 'number' },
      },
      required: ['modelId'],
      fn: (args) => {
        const modelId = getStringArg(args, 'modelId');
        const providerId = getOptionalStringArg(args, 'providerId');
        const requirements = requirementsFromArgs(args) ?? {};
        const candidates = listV3Providers()
          .filter((p) => p.source === 'preset' && p.defaultModel)
          .map((p) => ({ modelId: p.defaultModel, providerId: p.id }));
        const result = checkRequirementsWithAlternative(modelId, requirements, providerId, candidates);
        return {
          ok: result.ok,
          modelId: result.modelId,
          providerId: result.providerId,
          missing: result.missing,
          reason: result.reason,
          suggestedAlternative: result.suggestedAlternative,
        };
      },
    },
    {
      name: 'router_v3_cost_estimate',
      description: 'Uoc tinh chi phi mot call (USD) theo bang cost router v3: gia model / gia mac dinh provider / gia uoc luong; model local = 0.',
      properties: {
        modelId: { type: 'string' },
        providerId: { type: 'string' },
        inputTokens: { type: 'number' },
        outputTokens: { type: 'number' },
      },
      required: ['modelId', 'inputTokens', 'outputTokens'],
      fn: (args) => {
        const modelId = getStringArg(args, 'modelId');
        const providerId = getOptionalStringArg(args, 'providerId');
        const inputTokens = Math.max(0, Math.floor(getNumberArg(args, 'inputTokens', true)));
        const outputTokens = Math.max(0, Math.floor(getNumberArg(args, 'outputTokens', true)));
        const cost = router.costTable.costFor(modelId, providerId);
        return {
          modelId,
          providerId,
          inputTokens,
          outputTokens,
          inputPer1mUsd: cost.inputPer1mUsd,
          outputPer1mUsd: cost.outputPer1mUsd,
          estimatedPrice: cost.estimated,
          costPer1kTokensUsd: router.costTable.costPer1kTokensUsd(modelId, providerId),
          estimatedCostUsd: router.costTable.estimateCostUsd(modelId, providerId, inputTokens, outputTokens),
        };
      },
    },
    {
      name: 'router_v3_rank',
      description: 'Xep hang provider/model theo policy (cheapest / fastest / balanced) + yeu cau capability; tra diem, giai thich va ly do loai bo.',
      properties: {
        policy: { type: 'string', enum: ['cheapest', 'fastest', 'balanced'] },
        needsToolCalling: { type: 'boolean' },
        needsVision: { type: 'boolean' },
        needsStreaming: { type: 'boolean' },
        needsJsonMode: { type: 'boolean' },
        needsReasoning: { type: 'boolean' },
        minContextWindow: { type: 'number' },
        minOutputTokens: { type: 'number' },
        preferredProviderId: { type: 'string' },
        preferredModelId: { type: 'string' },
        limit: { type: 'number' },
      },
      required: [],
      fn: (args) => {
        const policy = (getOptionalStringArg(args, 'policy') as RouterV3Policy | undefined) ?? router.config.policy;
        const requirements = requirementsFromArgs(args);
        const limit = Math.max(1, Math.floor(getNumberArg(args, 'limit', false, 10)));
        const ranked = router.rankCandidates({
          policy,
          requirements,
          preferredProviderId: getOptionalStringArg(args, 'preferredProviderId'),
          preferredModelId: getOptionalStringArg(args, 'preferredModelId'),
        });
        return {
          policy,
          total: ranked.length,
          ranked: ranked.slice(0, limit).map((c) => ({
            providerId: c.providerId,
            modelId: c.modelId,
            score: c.score,
            costScore: c.breakdown.costScore,
            latencyScore: c.breakdown.latencyScore,
            capabilityScore: c.breakdown.capabilityScore,
            costPer1kTokensUsd: c.costPer1kTokensUsd,
            estLatencyMs: c.estLatencyMs,
            contextWindow: c.capability.contextWindow,
            local: c.local,
            excludedReason: c.excludedReason,
            explanation: c.explanation,
          })),
        };
      },
    },
    {
      name: 'router_v3_chat',
      description: 'Chat qua router v3: chon provider theo policy, fallback chain + retry co backoff + circuit breaker. Can key provider (host nap) hoac model local dang chay.',
      properties: {
        prompt: { type: 'string' },
        policy: { type: 'string', enum: ['cheapest', 'fastest', 'balanced'] },
        providerId: { type: 'string' },
        modelId: { type: 'string' },
        needsToolCalling: { type: 'boolean' },
        needsVision: { type: 'boolean' },
        needsStreaming: { type: 'boolean' },
        needsJsonMode: { type: 'boolean' },
        needsReasoning: { type: 'boolean' },
        minContextWindow: { type: 'number' },
        minOutputTokens: { type: 'number' },
      },
      required: ['prompt'],
      fn: async (args) => {
        const prompt = getStringArg(args, 'prompt');
        const requirements = requirementsFromArgs(args);
        const result = await router.chat({
          model: getOptionalStringArg(args, 'modelId') ?? router.config.fallbackOrder[0] ?? 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          policy: getOptionalStringArg(args, 'policy') as RouterV3Policy | undefined,
          requirements,
          preferredProviderId: getOptionalStringArg(args, 'providerId'),
          preferredModelId: getOptionalStringArg(args, 'modelId'),
        });
        if (!result.ok) {
          return {
            ok: false,
            attempts: result.attempts,
            guidance: result.guidance ?? buildRouterV3FailureGuidance(result.attempts),
            totalLatencyMs: result.totalLatencyMs,
          };
        }
        return {
          ok: true,
          servedByProviderId: result.servedByProviderId,
          servedByModelId: result.servedByModelId,
          text: result.response?.text,
          toolCalls: result.response?.toolCalls,
          usage: result.response?.usage,
          costUsd: result.costUsd,
          attempts: result.attempts,
          totalLatencyMs: result.totalLatencyMs,
        };
      },
    },
    {
      name: 'router_v3_local_scan',
      description: 'Quet server model local tren loopback (Ollama / vLLM / LM Studio / llama.cpp / textgen), liet ke model dang co, tu dang ky vao router (cost = 0).',
      properties: {
        kinds: { type: 'array', items: { type: 'string' } },
      },
      required: [],
      fn: async (args) => {
        const kindsRaw = args.kinds;
        let kinds: RouterV3LocalKind[] | undefined;
        if (Array.isArray(kindsRaw)) {
          const known: RouterV3LocalKind[] = ['ollama', 'vllm', 'lmstudio', 'llamacpp', 'textgen'];
          kinds = kindsRaw.filter((k): k is RouterV3LocalKind => typeof k === 'string' && (known as string[]).includes(k));
          if (kinds.length === 0) kinds = undefined;
        }
        const servers = kinds
          ? DEFAULT_LOCAL_SERVER_DEFS.filter((s) => kinds?.includes(s.kind))
          : undefined;
        const probes = await scanAllLocalServers({ fetchFn: state.fetchFn, servers });
        const models = probesToLocalModels(probes);
        router.registerLocalModels(models);
        return {
          servers: probes.map((p) => ({
            kind: p.kind,
            baseUrl: p.baseUrl,
            reachable: p.reachable,
            healthy: p.healthy,
            modelCount: p.models.length,
            models: p.models.map((m) => m.id),
            error: p.error,
            probeLatencyMs: p.probeLatencyMs,
          })),
          registeredLocalModels: models.length,
          localModels: models.map((m) => ({ modelId: m.modelId, providerId: m.providerId, serverKind: m.serverKind, running: m.running })),
        };
      },
    },
    {
      name: 'router_v3_local_status',
      description: 'Health dinh ky cua cac server model local (reachable, so model, loi lien tiep) + model local da dang ky vao router.',
      properties: { probeNow: { type: 'boolean' } },
      required: [],
      fn: async (args) => {
        const monitor = routerV3MonitorFor(state);
        const health = getBoolArg(args, 'probeNow', false) ? await monitor.checkNow() : monitor.snapshot();
        return {
          reachableCount: health.filter((h) => h.reachable).length,
          servers: health,
          localModels: router.listLocalModels().map((m) => ({
            modelId: m.modelId,
            providerId: m.providerId,
            serverKind: m.serverKind,
            baseUrl: m.baseUrl,
            running: m.running,
            discoveredAt: m.discoveredAt,
          })),
        };
      },
    },
    {
      name: 'router_v3_cost_set',
      description: 'Dat/ghi de gia mot model (USD / 1M token) hoac gia mac dinh mot provider trong bang cost router v3 (user cau hinh).',
      properties: {
        modelId: { type: 'string' },
        providerId: { type: 'string' },
        inputPer1mUsd: { type: 'number' },
        outputPer1mUsd: { type: 'number' },
        estimated: { type: 'boolean' },
      },
      required: ['inputPer1mUsd', 'outputPer1mUsd'],
      fn: (args) => {
        const inputPer1mUsd = getNumberArg(args, 'inputPer1mUsd', true);
        const outputPer1mUsd = getNumberArg(args, 'outputPer1mUsd', true);
        if (inputPer1mUsd < 0 || outputPer1mUsd < 0) {
          throw new Error('Gia khong duoc am.');
        }
        const modelId = getOptionalStringArg(args, 'modelId');
        const providerId = getOptionalStringArg(args, 'providerId');
        if (modelId) {
          const estimated = getBoolArg(args, 'estimated', false);
          router.costTable.setModelCost(modelId, { inputPer1mUsd, outputPer1mUsd, estimated });
          return { ok: true, modelId, cost: router.costTable.costFor(modelId, providerId) };
        }
        if (providerId) {
          router.costTable.setProviderDefault(providerId, { inputPer1mUsd, outputPer1mUsd });
          return { ok: true, providerId, cost: router.costTable.costFor('__unknown_model__', providerId) };
        }
        throw new Error('Can modelId (dat gia model) hoac providerId (dat gia mac dinh provider).');
      },
    },
    {
      name: 'router_v3_circuit_status',
      description: 'Trang thai circuit breaker per provider cua router v3; reset mot provider de bat lai sau khi user sua key/cau hinh.',
      properties: {
        providerId: { type: 'string' },
        reset: { type: 'boolean' },
      },
      required: [],
      fn: (args) => {
        const providerId = getOptionalStringArg(args, 'providerId');
        if (providerId && getBoolArg(args, 'reset', false)) {
          return { ok: true, providerId, reset: router.resetCircuit(providerId) };
        }
        const status = router.circuitStatus();
        return {
          providers: providerId ? status.filter((s) => s.providerId === providerId) : status,
        };
      },
    },
    {
      name: 'router_v3_latency_stats',
      description: 'Thong ke latency do that cua router v3 (p50/p90/mean/error rate, rolling window) per provider+model hoac toan bo.',
      properties: {
        providerId: { type: 'string' },
        modelId: { type: 'string' },
      },
      required: [],
      fn: (args) => {
        const providerId = getOptionalStringArg(args, 'providerId');
        const modelId = getOptionalStringArg(args, 'modelId');
        if (providerId && modelId) {
          const stats = router.latencyTracker.stats(providerId, modelId);
          return { providerId, modelId, stats: stats ?? null, sampleCount: router.latencyTracker.sampleCount(providerId, modelId) };
        }
        const snapshot = router.latencyTracker.snapshot();
        const entries = Object.entries(snapshot)
          .filter(([key]) => {
            if (providerId && !key.startsWith(`${providerId}::`)) return false;
            if (modelId && !key.endsWith(`::${modelId}`)) return false;
            return true;
          })
          .map(([key, stats]) => {
            const [pid, mid] = key.split('::');
            return { providerId: pid, modelId: mid, stats };
          });
        return { total: entries.length, entries };
      },
    },
  ];
  return defs.map((d) => {
    const tool = runTool(d.fn);
    tool.definition = toolDef(d.name, d.description, d.properties, d.required);
    return tool;
  });
}

export const ROUTER_V3_TOOLS: Tool[] = createRouterV3Tools(createDefaultRouterV3State());

/** Tien ich: bang cost + latency tracker mac dinh (de test / host dung truc tiep). */
export function createRouterV3CostTable(overrides?: ConstructorParameters<typeof CostTable>[0]): CostTable {
  return new CostTable(overrides);
}

export function createRouterV3LatencyTracker(windowSize?: number): LatencyTracker {
  return new LatencyTracker(windowSize === undefined ? undefined : { windowSize });
}

/** Re-export de test kiem tra loai loi ma khong can import tu core. */
export type { CapabilityRequirement, RouterV3Policy };
export { checkRequirements, suggestAlternative };
