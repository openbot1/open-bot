/**
 * Inference broker v2 tools (v1.33, Doi T5) — registered in ALL_TOOLS
 * (see tools.ts).
 *
 * 7 tools (ham thuan tren broker in-memory mac dinh; host co the
 * truyen state rieng qua createInferenceBrokerV2Tools):
 * - `inference_broker_v2_matrix` — capability matrix 4 engine local
 *   (llama.cpp / Ollama / vLLM / SGLang): tool calling, structured
 *   output, context, batching (khai bao — chua probe).
 * - `inference_broker_v2_route` — chon engine + model theo task
 *   (coding -> tool calling native + context >= 64k; extract ->
 *   grammar-constrained) + chuoi fallback.
 * - `inference_broker_v2_probe` — probe tool-call parser that luc
 *   khoi dong: gui 1 call mau toi tung engine dang chay (chi
 *   loopback), ghi capability that vao registry.
 * - `inference_broker_v2_probe_status` — capability that da probe
 *   (engine nao chay, parser that co tot khong, het han chua).
 * - `inference_broker_v2_validate` — validate 1 tool call truoc khi
 *   thuc thi (schema + allowlist); call sai bi chan + ly do.
 * - `inference_broker_v2_prefix_cache` — do / xem hit rate prefix
 *   cache cho multi-turn agent loop; xoa cache.
 * - `inference_broker_v2_voice_status` — trang thai voice realtime
 *   v22 (mock khi chua co key that) + chay 1 turn mock.
 *
 * Khong goi API that khi test (fetch inject duoc qua state; probe chi
 * goi loopback); khong doc credential — key do host truyen vao state
 * (voice live chi bat khi host truyen hasLiveKey = true).
 */

import type { Tool } from '@open-bot/core';
import {
  InferenceBrokerV2,
  VoiceV22Session,
  createInferenceBrokerV2,
  createVoiceV22Session,
  inferenceBrokerV2CapabilityFor,
  inferenceBrokerV2EngineLabel,
  listInferenceBrokerV2Capabilities,
  requirementsForTask,
  type InferenceBrokerV2EngineKind,
  type InferenceBrokerV2ProbeFetch,
  type InferenceBrokerV2TaskKind,
  type InferenceBrokerV2TaskRequirements,
  type InferenceBrokerV2ToolDefinition,
} from '@open-bot/core';

export const INFERENCE_BROKER_V2_TOOL_NAMES = [
  'inference_broker_v2_matrix',
  'inference_broker_v2_route',
  'inference_broker_v2_probe',
  'inference_broker_v2_probe_status',
  'inference_broker_v2_validate',
  'inference_broker_v2_prefix_cache',
  'inference_broker_v2_voice_status',
] as const;

export function isInferenceBrokerV2ToolName(name: string): boolean {
  return (INFERENCE_BROKER_V2_TOOL_NAMES as readonly string[]).includes(name);
}

/** Fetch mac dinh cho probe: global fetch (chi goi loopback). */
export const defaultInferenceBrokerV2Fetch: InferenceBrokerV2ProbeFetch = (url, init) =>
  fetch(url, init as never);

/** Cac loai task hop le cho tool route. */
export const INFERENCE_BROKER_V2_TASK_KINDS: readonly InferenceBrokerV2TaskKind[] = [
  'coding',
  'extract',
  'chat',
  'planning',
  'vision',
  'long-context',
  'batch',
  'voice',
];

export function isInferenceBrokerV2TaskKind(value: string): value is InferenceBrokerV2TaskKind {
  return (INFERENCE_BROKER_V2_TASK_KINDS as readonly string[]).includes(value);
}

export function isInferenceBrokerV2EngineKind(value: string): value is InferenceBrokerV2EngineKind {
  return value === 'ollama' || value === 'llamacpp' || value === 'vllm' || value === 'sglang';
}

/** State dung chung cua bo tool inference broker v2. */
export interface InferenceBrokerV2State {
  broker: InferenceBrokerV2;
  /** Voice session v22 (tao luoi khi can). */
  voiceSession: VoiceV22Session | null;
  /** Fetch dung cho probe (mac dinh global fetch). */
  fetchFn: InferenceBrokerV2ProbeFetch;
  /** true = host co key that cua provider voice (live); false = mock. */
  hasLiveKey: boolean;
}

export function createDefaultInferenceBrokerV2State(opts?: {
  fetchFn?: InferenceBrokerV2ProbeFetch;
  hasLiveKey?: boolean;
  broker?: InferenceBrokerV2;
}): InferenceBrokerV2State {
  return {
    broker: opts?.broker ?? createInferenceBrokerV2({ probeFetch: opts?.fetchFn }),
    voiceSession: null,
    fetchFn: opts?.fetchFn ?? defaultInferenceBrokerV2Fetch,
    hasLiveKey: opts?.hasLiveKey ?? false,
  };
}

/** Lay (hoac tao) voice session v22 cua state. */
export function inferenceBrokerV2VoiceSessionFor(state: InferenceBrokerV2State): VoiceV22Session {
  if (!state.voiceSession) {
    state.voiceSession = createVoiceV22Session({
      hasLiveKey: state.hasLiveKey,
      broker: state.broker,
    });
  }
  return state.voiceSession;
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

function getBoolArg(args: Record<string, unknown>, name: string, fallback = false): boolean {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean, got ${typeof value}`);
  }
  return value;
}

function getNumberArg(args: Record<string, unknown>, name: string, fallback = 0): number {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`Argument "${name}" must be a number, got ${typeof value}`);
  }
  return value;
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

/** Gom flag task tu args thanh TaskRequirements. */
function taskRequirementsFromArgs(
  args: Record<string, unknown>,
): InferenceBrokerV2TaskRequirements {
  const kindRaw = getStringArg(args, 'taskKind');
  if (!isInferenceBrokerV2TaskKind(kindRaw)) {
    throw new Error(
      `taskKind khong hop le: "${kindRaw}" (hop le: ${INFERENCE_BROKER_V2_TASK_KINDS.join(', ')}).`,
    );
  }
  const overrides: Partial<InferenceBrokerV2TaskRequirements> = {};
  if (getBoolArg(args, 'needsToolCalling', false)) overrides.needsToolCalling = true;
  if (getBoolArg(args, 'needsStrictToolCalling', false)) overrides.needsStrictToolCalling = true;
  if (getBoolArg(args, 'needsParallelCalls', false)) overrides.needsParallelCalls = true;
  if (getBoolArg(args, 'needsGrammar', false)) overrides.needsGrammar = true;
  if (getBoolArg(args, 'needsVision', false)) overrides.needsVision = true;
  if (getBoolArg(args, 'latencySensitive', false)) overrides.latencySensitive = true;
  if (getBoolArg(args, 'preferThroughput', false)) overrides.preferThroughput = true;
  if (getBoolArg(args, 'multiTurn', false)) overrides.multiTurn = true;
  const minContext = getNumberArg(args, 'minContext', 0);
  if (minContext > 0) overrides.minContext = Math.floor(minContext);
  return requirementsForTask(kindRaw, overrides);
}

/** Parse 1 doi so JSON (chuoi hoac object san). */
function parseJsonArg(args: Record<string, unknown>, name: string): unknown {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as unknown;
    } catch (err) {
      throw new Error(`Argument "${name}" khong phai JSON hop le: ${(err as Error).message}`);
    }
  }
  return value;
}

/** Tao bo tool inference broker v2 tren 1 state (mac dinh: state moi). */
export function createInferenceBrokerV2Tools(
  state: InferenceBrokerV2State = createDefaultInferenceBrokerV2State(),
): Tool[] {
  const broker = state.broker;
  const defs: { name: string; description: string; properties: Record<string, unknown>; required: string[]; fn: (args: Record<string, unknown>) => unknown }[] = [
    {
      name: 'inference_broker_v2_matrix',
      description:
        'Xem capability matrix 4 engine local (llama.cpp / Ollama / vLLM / SGLang): tool calling, structured output, context, batching. Day la capability KHAI BAO — capability THAT xem bang inference_broker_v2_probe_status.',
      properties: {
        engine: {
          type: 'string',
          enum: ['ollama', 'llamacpp', 'vllm', 'sglang'],
          description: 'Chi xem 1 engine (bo trong = xem ca 4).',
        },
      },
      required: [],
      fn: (args) => {
        const engine = getOptionalStringArg(args, 'engine');
        if (engine !== undefined) {
          if (!isInferenceBrokerV2EngineKind(engine)) {
            throw new Error(`engine khong hop le: "${engine}".`);
          }
          return inferenceBrokerV2CapabilityFor(engine);
        }
        return { engines: listInferenceBrokerV2Capabilities() };
      },
    },
    {
      name: 'inference_broker_v2_route',
      description:
        'Chon engine (+ fallback chain) cho 1 task: coding can tool calling native + context >= 64k; extract can grammar-constrained; batch uu tien throughput; voice/chat uu tien latency + multi-turn.',
      properties: {
        taskKind: {
          type: 'string',
          enum: [...INFERENCE_BROKER_V2_TASK_KINDS],
          description: 'Loai task: coding | extract | chat | planning | vision | long-context | batch | voice.',
        },
        needsToolCalling: { type: 'boolean', description: 'Task can tool-calling.' },
        needsStrictToolCalling: { type: 'boolean', description: 'Task can tool-calling native + strict.' },
        needsParallelCalls: { type: 'boolean', description: 'Task can goi nhieu tool song song.' },
        needsGrammar: { type: 'boolean', description: 'Task can ep output khop schema (grammar).' },
        needsVision: { type: 'boolean', description: 'Task co anh dinh kem.' },
        latencySensitive: { type: 'boolean', description: 'Task nhay cam latency (voice/chat).' },
        preferThroughput: { type: 'boolean', description: 'Task uu tien throughput (batch).' },
        multiTurn: { type: 'boolean', description: 'Task chay nhieu turn lien tiep (agent loop).' },
        minContext: { type: 'number', description: 'Context toi thieu task can (token).' },
      },
      required: ['taskKind'],
      fn: (args) => {
        const req = taskRequirementsFromArgs(args);
        const routed = broker.rankEnginesForTask(req);
        return {
          taskKind: req.kind,
          primary: routed.primary
            ? { engine: routed.primary.engine, label: inferenceBrokerV2EngineLabel(routed.primary.engine), score: routed.primary.score, reason: routed.primary.reason }
            : null,
          fallbackChain: routed.fallbackChain,
          ranked: routed.ranked.map((r) => ({
            engine: r.engine,
            score: r.score,
            eligible: r.eligible,
            missing: r.missing,
            reason: r.reason,
          })),
          reason: routed.reason,
        };
      },
    },
    {
      name: 'inference_broker_v2_probe',
      description:
        'Probe tool-call parser THAT cua cac engine local dang chay: gui 1 call mau toi tung engine (chi loopback), ghi capability that vao registry. Khong tin doc/quang cao cua engine.',
      properties: {
        engine: {
          type: 'string',
          enum: ['ollama', 'llamacpp', 'vllm', 'sglang'],
          description: 'Chi probe 1 engine (bo trong = probe tat ca engine ung vien, tuan tu).',
        },
        forceToolCall: { type: 'boolean', description: 'Ep tool_choice de do xem engine co ton trong khong.' },
        timeoutMs: { type: 'number', description: 'Timeout moi engine (ms, mac dinh 10000).' },
      },
      required: [],
      fn: async (args) => {
        const engine = getOptionalStringArg(args, 'engine');
        const forceToolCall = getBoolArg(args, 'forceToolCall', false);
        const timeoutMs = getNumberArg(args, 'timeoutMs', 0) || undefined;
        if (engine !== undefined && !isInferenceBrokerV2EngineKind(engine)) {
          throw new Error(`engine khong hop le: "${engine}".`);
        }
        // Probe 1 engine: dung probeAll roi loc (don gian, tuan tu,
        // tranh qua tai may 1.5 CPU) — registry giu ket qua tat ca.
        const results = await broker.probeAll({ fetchFn: state.fetchFn, timeoutMs, forceToolCall });
        const picked = engine ? results.filter((r) => r.engine === engine) : results;
        return {
          probed: picked.map((r) => ({
            engine: r.engine,
            label: inferenceBrokerV2EngineLabel(r.engine),
            baseUrl: r.baseUrl,
            reachable: r.reachable,
            toolCallParsed: r.toolCallParsed,
            argumentsParseable: r.argumentsParseable,
            argumentsMatchExpected: r.argumentsMatchExpected,
            toolCallsObserved: r.toolCallsObserved,
            parallelObserved: r.parallelObserved,
            latencyMs: r.latencyMs,
            error: r.error,
            note: r.note,
          })),
          workingCount: broker.registry.workingCount(),
        };
      },
    },
    {
      name: 'inference_broker_v2_probe_status',
      description: 'Xem capability THAT da probe cua cac engine local (engine nao chay, parser that co tot khong, het han chua) + tom tat markdown.',
      properties: {},
      required: [],
      fn: () => ({
        entries: broker.registry.entriesAll().map((e) => ({
          engine: e.engine,
          label: inferenceBrokerV2EngineLabel(e.engine),
          probed: !!e.probed,
          fresh: e.fresh,
          reachable: e.probed?.reachable ?? null,
          toolCallWorks: e.effectiveToolCallWorks,
          strictWorks: e.effectiveStrictWorks,
          latencyMs: e.probed?.latencyMs,
          note: e.probed?.note,
        })),
        workingCount: broker.registry.workingCount(),
        markdown: broker.registry.markdown(),
      }),
    },
    {
      name: 'inference_broker_v2_validate',
      description:
        'Validate 1 tool call truoc khi thuc thi (schema + allowlist). Tool call sai schema hoac khong trong allowlist bi CHAN — tra ly do, khong thuc thi.',
      properties: {
        toolName: { type: 'string', description: 'Ten tool can validate.' },
        arguments: {
          description: 'Arguments cua tool call (object hoac chuoi JSON).',
        },
        toolDefinitions: {
          type: 'string',
          description: 'JSON: mang dinh nghia tool [{ name, description?, parameters? }] de dang ky tam cho lan validate nay (bo trong = dung dinh nghia da dang ky trong broker).',
        },
      },
      required: ['toolName'],
      fn: (args) => {
        const toolName = getStringArg(args, 'toolName');
        const rawArgs = parseJsonArg(args, 'arguments');
        const defsRaw = parseJsonArg(args, 'toolDefinitions');
        if (Array.isArray(defsRaw)) {
          for (const d of defsRaw) {
            if (d && typeof d === 'object' && typeof (d as { name?: unknown }).name === 'string') {
              broker.gate.registerTool(d as InferenceBrokerV2ToolDefinition);
            }
          }
        }
        const input = {
          name: toolName,
          arguments: (rawArgs ?? {}) as Record<string, unknown>,
        };
        const result = broker.gate.validate(input);
        return {
          ok: result.ok,
          toolName: result.toolName,
          call: result.call ?? null,
          blockedReasons: result.blockedReasons,
          warnings: result.warnings,
          gateStats: broker.gate.stats(),
        };
      },
    },
    {
      name: 'inference_broker_v2_prefix_cache',
      description:
        'Prefix cache cho multi-turn agent loop (RadixAttention-style, phia client): xem hit rate / do prefix cua 1 prompt / xoa cache.',
      properties: {
        action: {
          type: 'string',
          enum: ['stats', 'measure', 'clear'],
          description: 'stats = xem thong ke; measure = do prefix cua prompt; clear = xoa cache.',
        },
        messages: {
          type: 'string',
          description: 'JSON (action=measure): mang message [{ role, content, name? }] can do prefix.',
        },
        toolDefinitions: {
          type: 'string',
          description: 'JSON (action=measure, tuy chon): mang ten tool definition de dua vao prefix.',
        },
        sessionId: { type: 'string', description: 'Id session agent loop (de theo doi).' },
      },
      required: ['action'],
      fn: (args) => {
        const action = getStringArg(args, 'action');
        if (action === 'stats') {
          return { ...broker.prefixCache.stats(), markdown: broker.prefixCache.markdown() };
        }
        if (action === 'clear') {
          broker.prefixCache.clear();
          return { cleared: true, stats: broker.prefixCache.stats() };
        }
        if (action === 'measure') {
          const raw = parseJsonArg(args, 'messages');
          if (!Array.isArray(raw)) throw new Error('action=measure can "messages" la mang JSON [{ role, content }].');
          const messages = raw as { role: string; content: string; name?: string }[];
          const toolsRaw = parseJsonArg(args, 'toolDefinitions');
          const toolDefs = Array.isArray(toolsRaw) ? (toolsRaw as string[]) : undefined;
          const sessionId = getOptionalStringArg(args, 'sessionId');
          const lookup = broker.prefixCache.beginTurn(messages, { toolDefinitions: toolDefs, sessionId });
          return { ...lookup, stats: broker.prefixCache.stats() };
        }
        throw new Error(`action khong hop le: "${action}" (stats | measure | clear).`);
      },
    },
    {
      name: 'inference_broker_v2_voice_status',
      description:
        'Voice realtime v22 qua inference broker v2: xem trang thai session (mock khi chua co key that) hoac chay 1 turn mock. Khong goi provider that khi chua co key.',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'turn'],
          description: 'status = xem trang thai; turn = chay 1 turn voice mock.',
        },
        userText: { type: 'string', description: 'Transcript mock cua user (action=turn).' },
      },
      required: ['action'],
      fn: async (args) => {
        const action = getStringArg(args, 'action');
        const session = inferenceBrokerV2VoiceSessionFor(state);
        if (action === 'status') {
          return { ...session.stats(), markdown: session.markdown() };
        }
        if (action === 'turn') {
          const userText = getStringArg(args, 'userText');
          if (session.currentState === 'idle') session.open();
          const turn = await session.turn(userText);
          return {
            turn,
            session: session.stats(),
          };
        }
        throw new Error(`action khong hop le: "${action}" (status | turn).`);
      },
    },
  ];
  return defs.map((d) => {
    const tool = runTool(d.fn);
    tool.definition = toolDef(d.name, d.description, d.properties, d.required);
    return tool;
  });
}

/** Placeholder chua bind trong ALL_TOOLS (state mac dinh, mock). */
export const INFERENCE_BROKER_V2_TOOLS: Tool[] = createInferenceBrokerV2Tools();
