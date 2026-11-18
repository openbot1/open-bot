/**
 * Router v2 tools (v1.16, Doi T3) — module rieng, CHUA noi vao ALL_TOOLS
 * (tranh xung dot merge voi cac doi khac; coordinator noi khi gop).
 *
 * 8 tools (ham thuan tren state in-memory mac dinh; host co the truyen
 * state rieng qua createRouterV2Tools):
 * - `router_v2_discovery_scan` — quet models-dir (GGUF) + preset INI.
 * - `router_v2_model_load` — load model on-demand (evict LRU + preempt).
 * - `router_v2_model_unload` — unload model (tu choi khi dang chay task).
 * - `router_v2_model_status` — trang thai router: discovered/loaded/RAM/VRAM/nhom.
 * - `router_v2_route_suggest` — picker v2: goi y model + giai thich.
 * - `router_v2_cli_probe` — probe sau 6 CLI agent (version/login/model).
 * - `router_v2_cli_toggle` — bat/tat mot nguon CLI (opt-in).
 * - `router_v2_fallback_health` — health + circuit breaker cac nguon fallback.
 *
 * Khong goi mang ngoai, khong can GPU/model that de chay (load that chi
 * xay ra khi llama-server that ton tai — bao loi ro neu khong).
 */

import type { Tool } from '@open-bot/core';
import {
  LocalModelRouterV2,
  parsePresetIni,
  type CliAgentKind,
  type PickerTaskKind,
} from '@open-bot/core';

export const ROUTER_V2_TOOL_NAMES = [
  'router_v2_discovery_scan',
  'router_v2_model_load',
  'router_v2_model_unload',
  'router_v2_model_status',
  'router_v2_route_suggest',
  'router_v2_cli_probe',
  'router_v2_cli_toggle',
  'router_v2_fallback_health',
] as const;

export function isRouterV2ToolName(name: string): boolean {
  return (ROUTER_V2_TOOL_NAMES as readonly string[]).includes(name);
}

/** State dung chung cua bo tool router v2. */
export interface RouterV2State {
  router: LocalModelRouterV2;
}

export function createDefaultRouterV2State(config?: ConstructorParameters<typeof LocalModelRouterV2>[0]): RouterV2State {
  return { router: new LocalModelRouterV2(config) };
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

/** Tao bo tool router v2 tren state cho truoc. */
export function createRouterV2Tools(state: RouterV2State): Tool[] {
  const { router } = state;
  const defs: { name: string; description: string; properties: Record<string, unknown>; required: string[]; fn: (args: Record<string, unknown>) => unknown }[] = [
    {
      name: 'router_v2_discovery_scan',
      description: 'Quet models-dir tim file GGUF + preset INI, tra danh sach model da discovered kem footprint uoc tinh.',
      properties: {},
      required: [],
      fn: () => {
        const { models, presetErrors } = router.refreshDiscovery();
        return {
          total: models.length,
          presetErrors,
          models: models.map((m) => ({
            id: m.file.id,
            fileName: m.file.fileName,
            sizeBytes: m.file.sizeBytes,
            validGguf: m.file.validMagic,
            architecture: m.file.architecture,
            contextSize: m.effectiveFlags.contextSize,
            estimatedFootprintBytes: m.estimatedFootprintBytes,
            preset: m.preset?.name,
          })),
        };
      },
    },
    {
      name: 'router_v2_model_load',
      description: 'Load model local on-demand (evict LRU theo RAM/VRAM + preempt swap-group neu can).',
      properties: { modelId: { type: 'string' }, force: { type: 'boolean' } },
      required: ['modelId'],
      fn: async (args) => router.loadModel(getStringArg(args, 'modelId'), { force: getBoolArg(args, 'force', false) }),
    },
    {
      name: 'router_v2_model_unload',
      description: 'Unload model local (tu choi khi dang chay task, tru khi force).',
      properties: { modelId: { type: 'string' }, force: { type: 'boolean' } },
      required: ['modelId'],
      fn: (args) => router.unloadModel(getStringArg(args, 'modelId'), { force: getBoolArg(args, 'force', false) }),
    },
    {
      name: 'router_v2_model_status',
      description: 'Trang thai router v2: model discovered/loaded, RAM/VRAM that, swap-group, CLI, fallback health.',
      properties: {},
      required: [],
      fn: async () => router.status(),
    },
    {
      name: 'router_v2_route_suggest',
      description: 'Picker v2: goi y model tot nhat cho task theo cost/latency/quality, kem giai thich.',
      properties: {
        kind: { type: 'string', enum: ['simple-chat', 'code', 'reasoning', 'research', 'creative', 'howto', 'summarize', 'translate', 'embedding', 'vision'] },
        promptTokens: { type: 'number' },
        needsToolUse: { type: 'boolean' },
        needsLongContext: { type: 'boolean' },
        qualityNeed: { type: 'number' },
        preference: { type: 'string', enum: ['speed', 'cost', 'quality', 'balanced'] },
        manualModelId: { type: 'string' },
      },
      required: ['kind'],
      fn: (args) => {
        const suggestion = router.suggestForTask({
          kind: getStringArg(args, 'kind') as PickerTaskKind,
          promptTokens: getNumberArg(args, 'promptTokens', false, 500),
          needsToolUse: getBoolArg(args, 'needsToolUse', false),
          needsLongContext: getBoolArg(args, 'needsLongContext', false),
          qualityNeed: getNumberArg(args, 'qualityNeed', false, 0.5),
          preference: (getOptionalStringArg(args, 'preference') as 'speed' | 'cost' | 'quality' | 'balanced' | undefined) ?? 'balanced',
          manualModelId: getOptionalStringArg(args, 'manualModelId'),
        });
        return {
          best: suggestion.best.modelId,
          source: suggestion.best.source,
          score: suggestion.best.score,
          reason: suggestion.reason,
          ranked: suggestion.ranked.map((c) => ({ modelId: c.modelId, source: c.source, score: c.score, explanation: c.explanation })),
        };
      },
    },
    {
      name: 'router_v2_cli_probe',
      description: 'Probe sau CLI agent (Codex/Claude Code/OpenCode/Gemini CLI/Aider/Cursor CLI): version, login, model list. Chi probe, khong doc credential.',
      properties: {},
      required: [],
      fn: async () => {
        const results = await router.refreshCliProbes();
        return results.map((r) => ({
          kind: r.kind,
          label: r.label,
          exists: r.exists,
          version: r.version,
          versionSupported: r.versionSupported,
          formatStatus: r.formatStatus,
          loggedIn: r.loggedIn,
          accountLabel: r.accountLabel,
          models: r.models,
          warnings: r.warnings,
          enabled: r.enabled,
        }));
      },
    },
    {
      name: 'router_v2_cli_toggle',
      description: 'Bat/tat mot nguon CLI agent (opt-in; mac dinh tat).',
      properties: { kind: { type: 'string' }, enabled: { type: 'boolean' } },
      required: ['kind', 'enabled'],
      fn: (args) => {
        const kind = getStringArg(args, 'kind');
        const enabled = getBoolArg(args, 'enabled', true);
        const known: CliAgentKind[] = ['codex', 'claude', 'opencode', 'gemini', 'aider', 'cursor'];
        if (!known.includes(kind as CliAgentKind)) {
          return { ok: false, kind, enabled, error: `CLI khong biet: ${kind}` };
        }
        return { ok: router.setCliEnabled(kind as CliAgentKind, enabled), kind, enabled };
      },
    },
    {
      name: 'router_v2_fallback_health',
      description: 'Health + circuit breaker cua cac nguon fallback (cloud / CLI / local).',
      properties: {},
      required: [],
      fn: () => ({ sources: router.getFallback().healthSnapshot() }),
    },
  ];
  return defs.map((d) => {
    const tool = runTool(d.fn);
    tool.definition = toolDef(d.name, d.description, d.properties, d.required);
    return tool;
  });
}

export const ROUTER_V2_TOOLS: Tool[] = createRouterV2Tools(createDefaultRouterV2State());

/** Tien ich: parse text preset INI (de test / host dung truc tiep). */
export function parseRouterV2Preset(text: string, sourcePath: string): ReturnType<typeof parsePresetIni> {
  return parsePresetIni(text, sourcePath);
}
