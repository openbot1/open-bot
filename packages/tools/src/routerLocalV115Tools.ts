/**
 * Router local v115 tools (v1.15, Doi T3) — registered in ALL_TOOLS
 * (see tools.ts).
 *
 * 10 tools (ham thuan tren state in-memory mac dinh; host co the
 * truyen state rieng qua createRouterLocalV115Tools):
 * - `router_local_catalog_list` — liet ke catalogue Qwen3/Llama/Gemma
 *   (loc theo family/use-case/RAM, kem license + RAM yeu cau).
 * - `router_local_catalog_validate` — validate license mot model
 *   truoc khi tai/cai (chan model khong ro license).
 * - `router_local_model_load` — load model local (Ollama/llama.cpp,
 *   LRU eviction khi vuot gioi han).
 * - `router_local_model_unload` — unload model (tu choi khi dang chay task).
 * - `router_local_model_status` — trang thai registry: backend health,
 *   model loaded, RAM, gioi han LRU.
 * - `router_local_route_decide` — policy router: chon local/cloud theo
 *   cost/latency/quality + override + fallback.
 * - `router_local_budget_set` — dat budget ngay/thang (toan cuc hoac theo bot).
 * - `router_local_budget_report` — bao cao spend + trang thai budget.
 * - `router_local_spend_record` — ghi mot dong spend thu cong.
 * - `router_local_gateway_key_create` — tao virtual key cho bot.
 *
 * Khong goi mang ngoai, khong can GPU/model that de chay (load that
 * chi xay ra khi Ollama/llama-server that khong chay — bao loi ro).
 */

import type { Tool } from '@open-bot/core';
import {
  LocalBudgetTracker,
  DEFAULT_CLOUD_PRICES,
  DEFAULT_GATEWAY_CONFIG,
  LOCAL_MODEL_CATALOG,
  LocalGateway,
  LocalModelRegistry,
  PolicyRouter,
  bestLocalModelFor,
  explainDecision,
  findLocalModel,
  localModelsFittingRam,
  localModelsForUseCase,
  validateModelLicense,
  type LocalModelEntry,
  type RouterTaskKind,
} from '@open-bot/core';

export const ROUTER_LOCAL_V115_TOOL_NAMES = [
  'router_local_catalog_list',
  'router_local_catalog_validate',
  'router_local_model_load',
  'router_local_model_unload',
  'router_local_model_status',
  'router_local_route_decide',
  'router_local_budget_set',
  'router_local_budget_report',
  'router_local_spend_record',
  'router_local_gateway_key_create',
] as const;

export function isRouterLocalV115ToolName(name: string): boolean {
  return (ROUTER_LOCAL_V115_TOOL_NAMES as readonly string[]).includes(name);
}

/** State dung chung cua bo tool (host co the truyen state rieng). */
export interface RouterLocalV115State {
  registry: LocalModelRegistry;
  budget: LocalBudgetTracker;
  policy: PolicyRouter;
  gateway: LocalGateway;
}

export function createDefaultRouterLocalV115State(): RouterLocalV115State {
  const registry = new LocalModelRegistry();
  const budget = new LocalBudgetTracker();
  const policy = new PolicyRouter();
  const gateway = new LocalGateway({ registry, budget, policy });
  gateway.start();
  return { registry, budget, policy, gateway };
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

function catalogSummary(entry: LocalModelEntry): Record<string, unknown> {
  const license = validateModelLicense(entry);
  return {
    id: entry.id,
    label: entry.label,
    family: entry.family,
    paramsB: entry.paramsB,
    quantization: entry.quantization,
    ggufSizeGB: +(entry.ggufSizeBytes / (1024 ** 3)).toFixed(2),
    ramRequiredGB: +(entry.ramRequiredBytes / (1024 ** 3)).toFixed(2),
    contextTokens: entry.contextTokens,
    license: entry.license.name,
    licenseKind: license.kind,
    licenseAllowed: license.allowed,
    licenseWarnings: license.warnings,
    ollamaTag: entry.ollamaTag,
    useCases: entry.useCases,
    toolUse: entry.toolUse,
    qualityTier: entry.qualityTier,
    estTokensPerSec: entry.estTokensPerSec,
  };
}

const TASK_KINDS: readonly string[] = [
  'simple-chat', 'code', 'reasoning', 'research', 'creative', 'howto', 'summarize', 'translate',
];

export function createRouterLocalV115Tools(state: RouterLocalV115State = createDefaultRouterLocalV115State()): Tool[] {
  const { registry, budget, policy, gateway } = state;

  const catalogListTool: Tool = {
    definition: toolDef(
      'router_local_catalog_list',
      'List the local model catalogue (Qwen3/Llama/Gemma, GGUF) with license, GGUF/RAM size, context and recommended use-cases. Optional filters: family, useCase, fitsRamGB.',
      {
        family: { type: 'string', description: 'Filter by family: qwen3, llama, gemma, qwen2.5-coder.' },
        useCase: { type: 'string', description: 'Filter by use-case: chat, code, reasoning, summarize, translate, embed, tool-use, long-context.' },
        fitsRamGB: { type: 'number', description: 'Only models whose RAM requirement fits in this many GB.' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const family = getOptionalStringArg(args, 'family');
        const useCase = getOptionalStringArg(args, 'useCase');
        const fitsRamGB = args.fitsRamGB === undefined ? undefined : getNumberArg(args, 'fitsRamGB');
        let list: LocalModelEntry[] = [...LOCAL_MODEL_CATALOG];
        if (family) {
          list = list.filter((m) => m.family === family);
        }
        if (useCase) {
          list = localModelsForUseCase(useCase as LocalModelEntry['useCases'][number])
            .filter((m) => list.includes(m));
        }
        if (fitsRamGB !== undefined) {
          const fitting = new Set(localModelsFittingRam(fitsRamGB * (1024 ** 3)).map((m) => m.id));
          list = list.filter((m) => fitting.has(m.id));
        }
        return okResult({
          total: list.length,
          models: list.map(catalogSummary),
          note: 'Chi model co license ro rang (Apache 2.0 / Llama Community / Gemma Terms) moi duoc phep tai/cai.',
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const catalogValidateTool: Tool = {
    definition: toolDef(
      'router_local_catalog_validate',
      'Validate the license of one local model before download/install. Blocks models with unknown or unapproved licenses.',
      { modelId: { type: 'string', description: 'Catalogue model id, e.g. qwen3-4b.' } },
      ['modelId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const modelId = getStringArg(args, 'modelId');
        const entry = findLocalModel(modelId);
        if (!entry) return errorResult(`Khong co model "${modelId}" trong catalogue local.`);
        const v = validateModelLicense(entry);
        return okResult({
          modelId,
          license: entry.license.name,
          allowed: v.allowed,
          kind: v.kind,
          reasons: v.reasons,
          warnings: v.warnings,
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const modelLoadTool: Tool = {
    definition: toolDef(
      'router_local_model_load',
      'Load a local model via Ollama or llama.cpp (on-demand, LRU eviction when over the limit). Requires the Ollama daemon or llama-server to be running.',
      {
        modelId: { type: 'string', description: 'Catalogue model id, e.g. qwen3-4b.' },
        backend: { type: 'string', description: 'Backend: ollama (default) or llamacpp.' },
        pin: { type: 'boolean', description: 'Pin the model so LRU never unloads it.' },
      },
      ['modelId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const modelId = getStringArg(args, 'modelId');
        const backend = getOptionalStringArg(args, 'backend');
        if (backend && backend !== 'ollama' && backend !== 'llamacpp') {
          return errorResult(`backend phai la "ollama" hoac "llamacpp", nhan "${backend}".`);
        }
        const pin = getBoolArg(args, 'pin', false);
        const result = await registry.load(modelId, { backend: backend as 'ollama' | 'llamacpp' | undefined, pin });
        return okResult(result);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const modelUnloadTool: Tool = {
    definition: toolDef(
      'router_local_model_unload',
      'Unload a loaded local model to free RAM. Refused while the model is running tasks.',
      { modelId: { type: 'string', description: 'Catalogue model id, e.g. qwen3-4b.' } },
      ['modelId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const modelId = getStringArg(args, 'modelId');
        return okResult({ modelId, ...registry.unload(modelId) });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const modelStatusTool: Tool = {
    definition: toolDef(
      'router_local_model_status',
      'Show local router status: backend health, loaded models, RAM usage and LRU limits.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      try {
        const status = await registry.healthCheck();
        return okResult({
          backends: status.backends,
          models: status.models,
          ram: {
            totalGB: +(status.ram.totalBytes / 1e9).toFixed(2),
            freeGB: +(status.ram.freeBytes / 1e9).toFixed(2),
            budgetGB: +(status.ram.budgetBytes / 1e9).toFixed(2),
            usedByModelsGB: +(status.ram.usedByModelsBytes / 1e9).toFixed(2),
          },
          maxLoadedModels: status.maxLoadedModels,
          loadedCount: status.loadedCount,
          gatewayStarted: gateway.isStarted(),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const routeDecideTool: Tool = {
    definition: toolDef(
      'router_local_route_decide',
      'Decide which model serves a task: small/fast tasks go to a local 3-4B model, heavy code/reasoning goes to cloud. Scores cost/latency/quality, honors manual overrides, returns fallbacks.',
      {
        kind: { type: 'string', description: 'Task kind: simple-chat, code, reasoning, research, creative, howto, summarize, translate.' },
        promptTokens: { type: 'number', description: 'Estimated prompt tokens.' },
        needsToolUse: { type: 'boolean', description: 'Whether the task needs tool-use.' },
        needsLongContext: { type: 'boolean', description: 'Whether the task needs >32k context.' },
        qualityNeed: { type: 'number', description: 'Required quality 0..1 (0.85+ forces cloud).' },
        manualModelId: { type: 'string', description: 'Manual model override (local catalogue id or cloud model name).' },
      },
      ['kind'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const kind = getStringArg(args, 'kind');
        if (!TASK_KINDS.includes(kind)) {
          return errorResult(`kind phai la mot trong: ${TASK_KINDS.join(', ')}.`);
        }
        const promptTokens = getNumberArg(args, 'promptTokens', false, 0);
        const needsToolUse = getBoolArg(args, 'needsToolUse', false);
        const needsLongContext = getBoolArg(args, 'needsLongContext', false);
        const qualityNeed = getNumberArg(args, 'qualityNeed', false, 0.5);
        const manualModelId = getOptionalStringArg(args, 'manualModelId');
        const loaded = new Set(
          registry.listInstances().filter((i) => i.state === 'loaded').map((i) => i.entry.id),
        );
        const ram = registry.ramSnapshot();
        const decision = policy.decide(
          {
            kind: kind as RouterTaskKind,
            promptTokens,
            needsToolUse,
            needsLongContext,
            qualityNeed,
            manualModelId,
          },
          { loadedModelIds: loaded, availableRamBytes: ram.budgetBytes - ram.usedByModelsBytes },
        );
        return okResult({
          chosen: decision.chosen,
          fallbacks: decision.fallbacks,
          reason: decision.reason,
          manualOverride: decision.manualOverride,
          explanation: explainDecision(decision),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const budgetSetTool: Tool = {
    definition: toolDef(
      'router_local_budget_set',
      'Set a daily/monthly budget (USD) globally or per bot. Warns at warnAt ratio, blocks new calls when exceeded (unless blockOnExceed is false).',
      {
        botId: { type: 'string', description: 'Bot id for a per-bot budget; omit for the global budget.' },
        period: { type: 'string', description: 'daily or monthly.' },
        limitUsd: { type: 'number', description: 'Budget limit in USD (0 = unlimited).' },
        warnAt: { type: 'number', description: 'Warn ratio 0..1 (default 0.8).' },
        blockOnExceed: { type: 'boolean', description: 'Block new calls when exceeded (default true).' },
      },
      ['period', 'limitUsd'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const period = getStringArg(args, 'period');
        if (period !== 'daily' && period !== 'monthly') {
          return errorResult('period phai la "daily" hoac "monthly".');
        }
        const limitUsd = getNumberArg(args, 'limitUsd');
        if (limitUsd < 0) return errorResult('limitUsd khong duoc am.');
        const warnAt = getNumberArg(args, 'warnAt', false, 0.8);
        if (warnAt <= 0 || warnAt > 1) return errorResult('warnAt phai trong (0, 1].');
        const blockOnExceed = getBoolArg(args, 'blockOnExceed', true);
        const botId = getOptionalStringArg(args, 'botId');
        const limit = { period: period as 'daily' | 'monthly', limitUsd, warnAt, blockOnExceed };
        if (botId) budget.setBotBudget(botId, limit);
        else budget.setGlobalBudget(limit);
        return okResult({ botId: botId ?? null, budget: limit, status: budget.status(botId) });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const budgetReportTool: Tool = {
    definition: toolDef(
      'router_local_budget_report',
      'Report spend for a daily/monthly window: totals, spend by model and by bot, local vs cloud split, and budget status.',
      {
        period: { type: 'string', description: 'daily or monthly.' },
        botId: { type: 'string', description: 'Optional bot id to filter the report.' },
      },
      ['period'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const period = getStringArg(args, 'period');
        if (period !== 'daily' && period !== 'monthly') {
          return errorResult('period phai la "daily" hoac "monthly".');
        }
        const botId = getOptionalStringArg(args, 'botId');
        const report = budget.report(period as 'daily' | 'monthly', Date.now(), botId);
        return okResult({ ...report, status: budget.status(botId) });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const spendRecordTool: Tool = {
    definition: toolDef(
      'router_local_spend_record',
      'Record one spend line manually (e.g. a call made outside the gateway): tokens x configured price.',
      {
        botId: { type: 'string', description: 'Bot id.' },
        modelId: { type: 'string', description: 'Model id.' },
        kind: { type: 'string', description: 'local or cloud.' },
        promptTokens: { type: 'number', description: 'Prompt tokens.' },
        completionTokens: { type: 'number', description: 'Completion tokens.' },
      },
      ['botId', 'modelId', 'kind', 'promptTokens', 'completionTokens'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const botId = getStringArg(args, 'botId');
        const modelId = getStringArg(args, 'modelId');
        const kind = getStringArg(args, 'kind');
        if (kind !== 'local' && kind !== 'cloud') {
          return errorResult('kind phai la "local" hoac "cloud".');
        }
        const promptTokens = getNumberArg(args, 'promptTokens');
        const completionTokens = getNumberArg(args, 'completionTokens');
        const record = budget.recordSpend({ botId, modelId, kind, promptTokens, completionTokens });
        return okResult({ record, status: budget.status(botId) });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const gatewayKeyTool: Tool = {
    definition: toolDef(
      'router_local_gateway_key_create',
      'Create a virtual key for a bot on the local gateway (LiteLLM-style). The secret is returned once — store it in the Vault.',
      {
        botId: { type: 'string', description: 'Bot id the key belongs to.' },
        limitUsd: { type: 'number', description: 'Monthly budget limit in USD for this key.' },
      },
      ['botId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const botId = getStringArg(args, 'botId');
        const limitUsd = args.limitUsd === undefined ? undefined : getNumberArg(args, 'limitUsd');
        const created = gateway.createKey(botId, limitUsd !== undefined ? { limitUsd } : undefined);
        return okResult({
          ...created,
          gatewayPort: gateway.getConfig().port,
          note: 'Secret chi tra 1 lan — luu vao Vault ngay. Gateway chi listen loopback.',
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    catalogListTool,
    catalogValidateTool,
    modelLoadTool,
    modelUnloadTool,
    modelStatusTool,
    routeDecideTool,
    budgetSetTool,
    budgetReportTool,
    spendRecordTool,
    gatewayKeyTool,
  ];
}

/** Unbound placeholders for ALL_TOOLS (bound by createDefaultTools when wired). */
export const ROUTER_LOCAL_V115_TOOLS: Tool[] = createRouterLocalV115Tools();

/** Re-export helpers huu ich cho test/host. */
export { bestLocalModelFor, DEFAULT_CLOUD_PRICES, DEFAULT_GATEWAY_CONFIG };
