/**
 * Router local v118 tools (v1.41, Doi T3) — registered in ALL_TOOLS
 * (see tools.ts).
 *
 * 15 tools (ham thuan tren state in-memory mac dinh; host co the
 * truyen state rieng qua createRouterLocalV118Tools):
 * - `router_local_v118_tool_choice_resolve` — ep tool_choice theo
 *   ma tran provider/model (Claude lon chi auto/none, Ollama khong
 *   co tool_choice, Gemini ha tool->any...).
 * - `router_local_v118_request_params` — xay bo tham so request an
 *   toan: ep tool_choice + loai temperature/top_p/top_k o API version
 *   >= 2026-10-21 + beta inline-tools chi khi ho tro.
 * - `router_local_v118_capability_matrix` — bang ma tran capability
 *   (tool_choice, parallel, max tools, inline-tools) theo provider.
 * - `router_local_v118_toolset_create` / `router_local_v118_toolset_update`
 *   — tao/cap nhat tool set co versioning (add/remove/replace).
 * - `router_local_v118_toolset_cache_key` — cache key tach doi
 *   (prefix + tool): chung minh doi tool khong doi prefixKey.
 * - `router_local_v118_thread_lock` — khoa/kiem tra tool list cua
 *   server-side thread (chong thread_fingerprint_mismatch).
 * - `router_local_v118_script_validate` — quet tinh script (cam
 *   identifier, loi cu phap) truoc khi chay.
 * - `router_local_v118_script_run` — chay script programmatic tool
 *   calling trong sandbox DSL (chi ket qua cuoi vao context);
 *   loi -> fallback goi tool thuong.
 * - `router_local_v118_script_audit` — log audit cac tool call
 *   trong script.
 * - `router_local_v118_bot_policy_get` / `router_local_v118_bot_policy_set`
 *   — xem/dat policy router theo bot (allow/deny tool + provider,
 *   script, gioi han chi phi).
 * - `router_local_v118_cost_route` — chon model re nhat dat nguong
 *   chat luong cho task (cost-aware routing).
 * - `router_local_v118_cost_report` — tong chi phi / tiet kiem da
 *   ghi trong ledger.
 * - `router_local_v118_retry_plan` — phan loai loi provider + lich
 *   retry/backoff (ha cap tool_choice, loai sampling, thread moi).
 *
 * Khong goi model that, khong goi API that, khong doc/gui credential.
 * Script chi chay qua executor do host dang ky (mac dinh khong co
 * executor nao — script_run fail-closed neu chua dang ky).
 */

import type { Tool } from '@open-bot/core';
import {
  BotPolicyStore,
  CostLedger,
  ProviderCooldownTracker,
  ScriptAuditStore,
  applyToolSetChange,
  buildProviderRequestParams,
  checkThreadToolSet,
  chooseCostAwareModel,
  computeSplitCacheKey,
  createToolSet,
  defaultBotRouterPolicy,
  defaultCostCandidates,
  effectiveCapability,
  effectiveRateLimitDelayMs,
  estimateTurnCost,
  filterToolsByPolicy,
  isToolAllowed,
  lockThreadToolSet,
  normalizeBotRouterPolicy,
  planRetry,
  prefixCacheSurvivesToolChange,
  resolveToolChoice,
  runScript,
  summarizeCapabilityMatrix,
  summarizeCostSaving,
  validateBotRouterPolicy,
  validateScript,
  type BotRouterPolicyInput,
  type InlineToolDef,
  type InlineToolSetState,
  type ProviderRetryConfig,
  type ScriptToolExecutor,
  type ServerThreadToolLock,
} from '@open-bot/core';

export const ROUTER_LOCAL_V118_TOOL_NAMES = [
  'router_local_v118_tool_choice_resolve',
  'router_local_v118_request_params',
  'router_local_v118_capability_matrix',
  'router_local_v118_toolset_create',
  'router_local_v118_toolset_update',
  'router_local_v118_toolset_cache_key',
  'router_local_v118_thread_lock',
  'router_local_v118_script_validate',
  'router_local_v118_script_run',
  'router_local_v118_script_audit',
  'router_local_v118_bot_policy_get',
  'router_local_v118_bot_policy_set',
  'router_local_v118_cost_route',
  'router_local_v118_cost_report',
  'router_local_v118_retry_plan',
] as const;

export function isRouterLocalV118ToolName(name: string): boolean {
  return (ROUTER_LOCAL_V118_TOOL_NAMES as readonly string[]).includes(name);
}

/** State dung chung cua bo tool (host co the truyen state rieng). */
export interface RouterLocalV118State {
  toolSets: Map<string, InlineToolSetState>;
  threadLocks: Map<string, ServerThreadToolLock>;
  audit: ScriptAuditStore;
  policies: BotPolicyStore;
  ledger: CostLedger;
  cooldowns: ProviderCooldownTracker;
  executors: Map<string, ScriptToolExecutor>;
}

export function createDefaultRouterLocalV118State(): RouterLocalV118State {
  return {
    toolSets: new Map(),
    threadLocks: new Map(),
    audit: new ScriptAuditStore(),
    policies: new BotPolicyStore(),
    ledger: new CostLedger(),
    cooldowns: new ProviderCooldownTracker(),
    executors: new Map(),
  };
}

/** Dang ky executor cho mot tool de script co the goi (host dang ky tool that). */
export function registerRouterLocalV118Executor(
  state: RouterLocalV118State,
  toolName: string,
  executor: ScriptToolExecutor,
): void {
  state.executors.set(toolName, executor);
}

export function unregisterRouterLocalV118Executor(
  state: RouterLocalV118State,
  toolName: string,
): boolean {
  return state.executors.delete(toolName);
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

function parseToolDef(raw: unknown, index: number): InlineToolDef {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`tools[${index}] phai la object.`);
  }
  const item = raw as Record<string, unknown>;
  if (typeof item.name !== 'string' || item.name.trim() === '') {
    throw new Error(`tools[${index}].name phai la string khong rong.`);
  }
  const def: InlineToolDef = { name: item.name };
  if (item.description !== undefined) {
    if (typeof item.description !== 'string') throw new Error(`tools[${index}].description phai la string.`);
    def.description = item.description;
  }
  if (item.parameters !== undefined) {
    if (typeof item.parameters !== 'object' || item.parameters === null || Array.isArray(item.parameters)) {
      throw new Error(`tools[${index}].parameters phai la object.`);
    }
    def.parameters = item.parameters as Record<string, unknown>;
  }
  return def;
}

function parseToolDefArray(value: unknown, field: string): InlineToolDef[] {
  if (!Array.isArray(value)) throw new Error(`Argument "${field}" phai la array.`);
  return value.map((item, i) => parseToolDef(item, i));
}

const TOOL_CHOICE_MODES: readonly string[] = ['auto', 'none', 'any', 'tool'];

export function createRouterLocalV118Tools(
  state: RouterLocalV118State = createDefaultRouterLocalV118State(),
): Tool[] {
  const { toolSets, threadLocks, audit, policies, ledger, cooldowns, executors } = state;

  const getToolSet = (sessionId: string): InlineToolSetState => {
    const set = toolSets.get(sessionId);
    if (!set) throw new Error(`Chua co tool set cho session "${sessionId}" — tao bang router_local_v118_toolset_create truoc.`);
    return set;
  };

  const toolChoiceResolveTool: Tool = {
    definition: toolDef(
      'router_local_v118_tool_choice_resolve',
      'Resolve tool_choice for a provider/model against the v118 capability matrix: large Claude models (5.5/Fable/Mythos) only accept auto/none (any/tool returns 400), Ollama does not support tool_choice at all, Gemini downgrades tool to any. Returns the enforced mode, whether it changed, parallel-call support and max tools.',
      {
        provider: { type: 'string', description: 'Provider id (anthropic, openai, gemini, xai, deepseek, ollama, llamacpp, vllm, sglang, openai-compatible).' },
        modelId: { type: 'string', description: 'Model id (e.g. claude-sonnet-5-5, gpt-5-mini).' },
        requested: { type: 'string', description: 'Requested tool_choice: auto, none, any or tool (default: provider default).' },
        toolName: { type: 'string', description: 'Tool name to force when requested is "tool".' },
        toolCount: { type: 'number', description: 'How many tools will be sent (checked against maxTools).' },
      },
      ['provider', 'modelId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const provider = getStringArg(args, 'provider');
        const modelId = getStringArg(args, 'modelId');
        const requested = getOptionalStringArg(args, 'requested');
        if (requested !== undefined && !TOOL_CHOICE_MODES.includes(requested)) {
          return errorResult(`requested phai la mot trong: ${TOOL_CHOICE_MODES.join(', ')}.`);
        }
        const resolved = resolveToolChoice({
          provider,
          modelId,
          requested: requested as 'auto' | 'none' | 'any' | 'tool' | undefined,
          toolName: getOptionalStringArg(args, 'toolName'),
          toolCount: getOptionalNumberArg(args, 'toolCount'),
        });
        return okResult(resolved);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const requestParamsTool: Tool = {
    definition: toolDef(
      'router_local_v118_request_params',
      'Build a safe provider request: enforces tool_choice from the capability matrix and drops temperature/top_p/top_k when the API version is 2026-10-21 or newer (sending them returns 400 even at default values). On Ollama, tool_choice none is enforced by not sending tools. Beta inline-tools headers are only kept when the provider supports them.',
      {
        provider: { type: 'string', description: 'Provider id.' },
        modelId: { type: 'string', description: 'Model id.' },
        apiVersion: { type: 'string', description: 'API version, e.g. 2026-10-21 (empty = unknown).' },
        betaHeaders: { type: 'array', items: { type: 'string' }, description: 'Requested beta headers, e.g. ["inline-tools-2026-09-15"].' },
        toolChoice: { type: 'string', description: 'Requested tool_choice: auto, none, any or tool.' },
        toolName: { type: 'string', description: 'Tool name to force when toolChoice is "tool".' },
        toolCount: { type: 'number', description: 'How many tools will be sent.' },
        temperature: { type: 'number', description: 'Sampling temperature (dropped on API >= 2026-10-21).' },
        topP: { type: 'number', description: 'Sampling top_p (dropped on API >= 2026-10-21).' },
        topK: { type: 'number', description: 'Sampling top_k (dropped on API >= 2026-10-21).' },
        maxTokens: { type: 'number', description: 'Max output tokens.' },
      },
      ['provider', 'modelId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const provider = getStringArg(args, 'provider');
        const modelId = getStringArg(args, 'modelId');
        const toolChoice = getOptionalStringArg(args, 'toolChoice');
        if (toolChoice !== undefined && !TOOL_CHOICE_MODES.includes(toolChoice)) {
          return errorResult(`toolChoice phai la mot trong: ${TOOL_CHOICE_MODES.join(', ')}.`);
        }
        const built = buildProviderRequestParams({
          provider,
          modelId,
          apiVersion: getOptionalStringArg(args, 'apiVersion'),
          betaHeaders: getStringArrayArg(args, 'betaHeaders'),
          toolChoice: toolChoice as 'auto' | 'none' | 'any' | 'tool' | undefined,
          toolName: getOptionalStringArg(args, 'toolName'),
          toolCount: getOptionalNumberArg(args, 'toolCount'),
          temperature: getOptionalNumberArg(args, 'temperature'),
          topP: getOptionalNumberArg(args, 'topP'),
          topK: getOptionalNumberArg(args, 'topK'),
          maxTokens: getOptionalNumberArg(args, 'maxTokens'),
          tools: [],
        });
        return okResult(built);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const capabilityMatrixTool: Tool = {
    definition: toolDef(
      'router_local_v118_capability_matrix',
      'Show the v118 provider capability matrix: which tool_choice modes, parallel calls, max tools and inline-tools support each provider/model has. Use it before sending tool_choice to a new provider/model.',
      {
        provider: { type: 'string', description: 'Optional provider id to show one row for.' },
        modelId: { type: 'string', description: 'Optional model id (applies model overrides).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const provider = getOptionalStringArg(args, 'provider');
        const modelId = getOptionalStringArg(args, 'modelId');
        if (provider !== undefined) {
          return okResult({
            provider,
            modelId: modelId ?? '',
            capability: effectiveCapability(provider, modelId ?? ''),
            matrix: summarizeCapabilityMatrix(),
          });
        }
        return okResult({ matrix: summarizeCapabilityMatrix() });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const toolsetCreateTool: Tool = {
    definition: toolDef(
      'router_local_v118_toolset_create',
      'Create a versioned tool set for a conversation session (version 1). Later changes go through router_local_v118_toolset_update so the version and hash update and prompt-cache keys stay stable for the unchanged prefix.',
      {
        sessionId: { type: 'string', description: 'Conversation session id (default: "default").' },
        tools: { type: 'array', items: { type: 'object' }, description: 'Tools: [{name, description?, parameters?}].' },
      },
      ['tools'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const sessionId = getOptionalStringArg(args, 'sessionId') ?? 'default';
        const tools = parseToolDefArray(args.tools, 'tools');
        const set = createToolSet(tools);
        toolSets.set(sessionId, set);
        return okResult({ sessionId, version: set.current.version, hash: set.current.hash, toolNames: set.current.toolNames });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const toolsetUpdateTool: Tool = {
    definition: toolDef(
      'router_local_v118_toolset_update',
      'Update a versioned tool set mid-conversation (add/remove/replace tools). The version only bumps when something actually changes, so a no-op update never breaks the prompt cache. Returns the new version, hash and what changed.',
      {
        sessionId: { type: 'string', description: 'Conversation session id (default: "default").' },
        add: { type: 'array', items: { type: 'object' }, description: 'Tools to add: [{name, description?, parameters?}].' },
        remove: { type: 'array', items: { type: 'string' }, description: 'Tool names to remove.' },
        replace: { type: 'array', items: { type: 'object' }, description: 'Tools to redefine: [{name, description?, parameters?}].' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const sessionId = getOptionalStringArg(args, 'sessionId') ?? 'default';
        const current = getToolSet(sessionId);
        const result = applyToolSetChange(current, {
          add: args.add === undefined ? undefined : parseToolDefArray(args.add, 'add'),
          remove: getStringArrayArg(args, 'remove'),
          replace: args.replace === undefined ? undefined : parseToolDefArray(args.replace, 'replace'),
        });
        toolSets.set(sessionId, result.state);
        return okResult({
          sessionId,
          changed: result.changed,
          version: result.state.current.version,
          hash: result.state.current.hash,
          toolNames: result.state.current.toolNames,
          added: result.added,
          removed: result.removed,
          replaced: result.replaced,
          reason: result.reason,
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const toolsetCacheKeyTool: Tool = {
    definition: toolDef(
      'router_local_v118_toolset_cache_key',
      'Compute the split prompt-cache key for a turn: prefixKey (system prompt + history + model) and toolKey (tool set version + hash). Changing tools only changes toolKey — prefixKey stays identical, proving the rest of the prompt cache survives an inline tool change.',
      {
        sessionId: { type: 'string', description: 'Conversation session id (default: "default").' },
        systemPrompt: { type: 'string', description: 'System prompt.' },
        messages: { type: 'array', items: { type: 'object' }, description: 'History: [{role, content}].' },
        modelId: { type: 'string', description: 'Model id.' },
        apiVersion: { type: 'string', description: 'API version (optional).' },
      },
      ['systemPrompt', 'messages', 'modelId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const sessionId = getOptionalStringArg(args, 'sessionId') ?? 'default';
        const toolSet = getToolSet(sessionId);
        const systemPrompt = getStringArg(args, 'systemPrompt');
        const modelId = getStringArg(args, 'modelId');
        if (!Array.isArray(args.messages)) return errorResult('messages phai la array [{role, content}].');
        const messages = (args.messages as unknown[]).map((m, i) => {
          if (typeof m !== 'object' || m === null) throw new Error(`messages[${i}] phai la object.`);
          const item = m as Record<string, unknown>;
          if (typeof item.role !== 'string' || typeof item.content !== 'string') {
            throw new Error(`messages[${i}] can role + content la string.`);
          }
          return { role: item.role, content: item.content };
        });
        const key = computeSplitCacheKey({
          systemPrompt,
          messages,
          modelId,
          apiVersion: getOptionalStringArg(args, 'apiVersion'),
          toolSet,
        });
        return okResult({ sessionId, ...key });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const threadLockTool: Tool = {
    definition: toolDef(
      'router_local_v118_thread_lock',
      'Lock or check a server-side thread tool list. lock: freeze the current tool set fingerprint on the thread. check: report whether the current tool set still matches the locked fingerprint — a mismatch means a new thread is needed instead of sending the request and getting thread_fingerprint_mismatch.',
      {
        sessionId: { type: 'string', description: 'Conversation session id (default: "default").' },
        threadId: { type: 'string', description: 'Server-side thread id.' },
        action: { type: 'string', description: '"lock" or "check".' },
      },
      ['threadId', 'action'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const sessionId = getOptionalStringArg(args, 'sessionId') ?? 'default';
        const threadId = getStringArg(args, 'threadId');
        const action = getStringArg(args, 'action');
        if (action !== 'lock' && action !== 'check') {
          return errorResult('action phai la "lock" hoac "check".');
        }
        const toolSet = getToolSet(sessionId);
        if (action === 'lock') {
          const lock = lockThreadToolSet(threadId, toolSet);
          threadLocks.set(threadId, lock);
          return okResult({ threadId, action: 'lock', fingerprint: lock.fingerprint, toolSetVersion: lock.toolSetVersion, lockedAt: lock.lockedAt });
        }
        const lock = threadLocks.get(threadId) ?? null;
        const check = checkThreadToolSet(lock, toolSet);
        return okResult({ threadId, action: 'check', locked: lock !== null, ...check });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const scriptValidateTool: Tool = {
    definition: toolDef(
      'router_local_v118_script_validate',
      'Statically validate a programmatic tool-calling script without running it: rejects forbidden host identifiers (require/process/fetch/eval...), syntax errors and oversized scripts. Returns the tools the script would call.',
      {
        source: { type: 'string', description: 'Script source code.' },
      },
      ['source'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        return okResult(validateScript(getStringArg(args, 'source')));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const scriptRunTool: Tool = {
    definition: toolDef(
      'router_local_v118_script_run',
      'Run a programmatic tool-calling script in the sandboxed DSL: the agent script calls several tools via call("name", {...}) but only the final return value enters the context (saves tokens). The script has no filesystem/network access, a step budget, a call budget and a wall-clock limit. On error it returns a fallback plan to continue with normal tool calls.',
      {
        source: { type: 'string', description: 'Script source code.' },
        input: { type: 'object', description: 'Input object available as the read-only `input` variable.' },
        allowedTools: { type: 'array', items: { type: 'string' }, description: 'Optional allowlist: only these tools may be called.' },
        maxCalls: { type: 'number', description: 'Max tool calls in this script (default 32).' },
        maxWallMs: { type: 'number', description: 'Max wall-clock runtime in ms (default 5000).' },
        maxSteps: { type: 'number', description: 'Max execution steps (default 10000).' },
        botId: { type: 'string', description: 'Optional bot id — the bot policy is enforced (allowScript + tool allowlist).' },
      },
      ['source'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const source = getStringArg(args, 'source');
        const input = args.input === undefined ? null : getObjectArg(args, 'input', false);
        const allowedTools = getStringArrayArg(args, 'allowedTools');
        const limits: { maxCalls?: number; maxWallMs?: number; maxSteps?: number } = {};
        const maxCalls = getOptionalNumberArg(args, 'maxCalls');
        const maxWallMs = getOptionalNumberArg(args, 'maxWallMs');
        const maxSteps = getOptionalNumberArg(args, 'maxSteps');
        if (maxCalls !== undefined) limits.maxCalls = maxCalls;
        if (maxWallMs !== undefined) limits.maxWallMs = maxWallMs;
        if (maxSteps !== undefined) limits.maxSteps = maxSteps;
        // Bot policy: script chi chay khi policy cho phep (neu co policy).
        const botId = getOptionalStringArg(args, 'botId');
        if (botId !== undefined) {
          const policy = policies.effectivePolicy(botId);
          if (!policy.allowScript) {
            return errorResult(`Bot ${botId} khong duoc chay script (allowScript=false trong policy).`);
          }
          if (allowedTools !== undefined) {
            const filtered = filterToolsByPolicy(policy, allowedTools);
            if (filtered.denied.length > 0) {
              return errorResult(`Tool bi policy cua bot ${botId} cam: ${filtered.denied.map((d) => d.name).join(', ')}.`);
            }
          }
        }
        const executorsRecord: Record<string, ScriptToolExecutor> = {};
        for (const [name, fn] of executors) executorsRecord[name] = fn;
        const result = await runScript(
          source,
          {
            input,
            allowedTools,
            limits,
            executors: executorsRecord,
          },
          audit,
        );
        return okResult(result);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const scriptAuditTool: Tool = {
    definition: toolDef(
      'router_local_v118_script_audit',
      'List the audit log of tool calls made inside programmatic scripts (sequence, tool, args, duration, ok/error, result preview). Use it to review what a script actually called.',
      {
        toolName: { type: 'string', description: 'Optional tool name to filter by.' },
        limit: { type: 'number', description: 'Max entries (default 50).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const toolName = getOptionalStringArg(args, 'toolName');
        const limit = getOptionalNumberArg(args, 'limit') ?? 50;
        const entries = toolName !== undefined ? audit.byTool(toolName, limit) : audit.list(limit);
        return okResult({ runs: audit.getRuns(), count: entries.length, entries });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const botPolicyGetTool: Tool = {
    definition: toolDef(
      'router_local_v118_bot_policy_get',
      'Show the effective router policy for a bot: allowed/denied tools and providers, whether scripts may run, per-turn tool and cost limits, and tools that always need confirmation.',
      {
        botId: { type: 'string', description: 'Bot id.' },
      },
      ['botId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const botId = getStringArg(args, 'botId');
        const own = policies.getBot(botId);
        return okResult({
          botId,
          hasOwnPolicy: own !== null,
          global: policies.getGlobal(),
          own,
          effective: policies.effectivePolicy(botId),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const botPolicySetTool: Tool = {
    definition: toolDef(
      'router_local_v118_bot_policy_set',
      'Set the router policy for a bot: allow/deny tools and providers (deny always wins), allow or forbid scripts, per-turn tool/call/cost limits, and tools that always need confirmation. Invalid policies are rejected with the reason.',
      {
        botId: { type: 'string', description: 'Bot id.' },
        allowTools: { type: 'array', items: { type: 'string' }, description: 'Allowed tools (omit = no bot-level limit).' },
        denyTools: { type: 'array', items: { type: 'string' }, description: 'Denied tools (always win over allow).' },
        allowProviders: { type: 'array', items: { type: 'string' }, description: 'Allowed providers (omit = no bot-level limit).' },
        denyProviders: { type: 'array', items: { type: 'string' }, description: 'Denied providers (always win over allow).' },
        allowScript: { type: 'boolean', description: 'Whether programmatic scripts may run.' },
        maxToolsPerTurn: { type: 'number', description: 'Max tool calls per turn (0 = unlimited).' },
        maxScriptCalls: { type: 'number', description: 'Max tool calls per script (0 = default 32).' },
        maxCostUsdPerTurn: { type: 'number', description: 'Max cost in USD per turn (0 = unlimited).' },
        requireConfirmTools: { type: 'array', items: { type: 'string' }, description: 'Tools that always need confirmation.' },
        note: { type: 'string', description: 'Note for this policy.' },
      },
      ['botId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const input: BotRouterPolicyInput = { botId: getStringArg(args, 'botId') };
        const allowTools = getStringArrayArg(args, 'allowTools');
        const denyTools = getStringArrayArg(args, 'denyTools');
        const allowProviders = getStringArrayArg(args, 'allowProviders');
        const denyProviders = getStringArrayArg(args, 'denyProviders');
        const requireConfirmTools = getStringArrayArg(args, 'requireConfirmTools');
        if (allowTools !== undefined) input.allowTools = allowTools;
        if (denyTools !== undefined) input.denyTools = denyTools;
        if (allowProviders !== undefined) input.allowProviders = allowProviders;
        if (denyProviders !== undefined) input.denyProviders = denyProviders;
        if (requireConfirmTools !== undefined) input.requireConfirmTools = requireConfirmTools;
        const allowScript = args.allowScript;
        if (allowScript !== undefined) {
          if (typeof allowScript !== 'boolean') return errorResult('allowScript phai la boolean.');
          input.allowScript = allowScript;
        }
        const maxToolsPerTurn = getOptionalNumberArg(args, 'maxToolsPerTurn');
        const maxScriptCalls = getOptionalNumberArg(args, 'maxScriptCalls');
        const maxCostUsdPerTurn = getOptionalNumberArg(args, 'maxCostUsdPerTurn');
        if (maxToolsPerTurn !== undefined) input.maxToolsPerTurn = maxToolsPerTurn;
        if (maxScriptCalls !== undefined) input.maxScriptCalls = maxScriptCalls;
        if (maxCostUsdPerTurn !== undefined) input.maxCostUsdPerTurn = maxCostUsdPerTurn;
        const note = getOptionalStringArg(args, 'note');
        if (note !== undefined) input.note = note;
        const validation = validateBotRouterPolicy(input);
        if (!validation.ok) {
          return errorResult(`Policy khong hop le: ${validation.errors.join(' ')}`);
        }
        policies.setBot(input);
        return okResult({ botId: input.botId, effective: policies.effectivePolicy(input.botId) });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const costRouteTool: Tool = {
    definition: toolDef(
      'router_local_v118_cost_route',
      'Cost-aware routing: pick the cheapest model that meets the quality bar for the task difficulty, and estimate the saving versus the strongest model. Easy tasks go to a free local model; hard or multimodal tasks escalate. The decision is also recorded in the cost ledger.',
      {
        botId: { type: 'string', description: 'Bot id (for the cost ledger; default: "default").' },
        difficulty: { type: 'number', description: 'Task difficulty 0..1.' },
        hasImage: { type: 'boolean', description: 'Whether the task has an image.' },
        minQuality: { type: 'number', description: 'Minimum acceptable quality 0..1.' },
        estimatedInputTokens: { type: 'number', description: 'Estimated input tokens (default 1000).' },
        estimatedOutputTokens: { type: 'number', description: 'Estimated output tokens (default 500).' },
        budgetRemainingUsd: { type: 'number', description: 'Remaining budget in USD (0 = unlimited).' },
      },
      ['difficulty'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const botId = getOptionalStringArg(args, 'botId') ?? 'default';
        const difficulty = getNumberArg(args, 'difficulty');
        if (difficulty < 0 || difficulty > 1) return errorResult('difficulty phai trong 0..1.');
        const inputTokens = getOptionalNumberArg(args, 'estimatedInputTokens') ?? 1000;
        const outputTokens = getOptionalNumberArg(args, 'estimatedOutputTokens') ?? 500;
        const decision = chooseCostAwareModel(
          {
            difficulty,
            hasImage: getBoolArg(args, 'hasImage', false),
            minQuality: getOptionalNumberArg(args, 'minQuality'),
            estimatedInputTokens: inputTokens,
            estimatedOutputTokens: outputTokens,
            budgetRemainingUsd: getOptionalNumberArg(args, 'budgetRemainingUsd'),
          },
          defaultCostCandidates(),
        );
        const candidate = defaultCostCandidates().find((c) => c.modelId === decision.chosenModelId);
        if (candidate) {
          ledger.record({
            botId,
            modelId: candidate.modelId,
            provider: candidate.provider,
            inputTokens,
            outputTokens,
            costUsd: estimateTurnCost(candidate, inputTokens, outputTokens),
          });
        }
        return okResult({ botId, ...decision });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const costReportTool: Tool = {
    definition: toolDef(
      'router_local_v118_cost_report',
      'Cost report from the ledger: total spent, what the same turns would have cost on the strongest model, and the saving. Filter by bot id when given.',
      {
        botId: { type: 'string', description: 'Optional bot id to filter by.' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const botId = getOptionalStringArg(args, 'botId');
        const saving = summarizeCostSaving(ledger, defaultCostCandidates(), botId);
        return okResult({
          botId: botId ?? null,
          ...saving,
          byModel: ledger.byModel(botId),
          totalTokens: ledger.totalTokens(botId),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const retryPlanTool: Tool = {
    definition: toolDef(
      'router_local_v118_retry_plan',
      'Classify a provider error and plan the retry: 429/5xx/timeout retry with exponential backoff + jitter; 400 tool_choice downgrades to auto and retries once; 400 sampling-param drops temperature/top_p/top_k and retries once; thread_fingerprint_mismatch creates a new thread and retries once; 401/403/404 never retry. Also records the failure for the provider cooldown tracker.',
      {
        provider: { type: 'string', description: 'Provider id.' },
        status: { type: 'number', description: 'HTTP status code (omit for timeout/network errors).' },
        message: { type: 'string', description: 'Provider error message.' },
        isTimeout: { type: 'boolean', description: 'Whether this was a timeout.' },
        isNetwork: { type: 'boolean', description: 'Whether this was a network error.' },
        retryAfter: { type: 'string', description: 'Retry-After header value, if the provider sent one.' },
        seed: { type: 'number', description: 'Optional seed for deterministic jitter (tests).' },
        maxAttempts: { type: 'number', description: 'Optional max attempts override.' },
        baseDelayMs: { type: 'number', description: 'Optional base delay override (ms).' },
      },
      ['provider'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const provider = getStringArg(args, 'provider');
        const config: ProviderRetryConfig = {
          provider,
          maxAttempts: getOptionalNumberArg(args, 'maxAttempts') ?? (provider === 'ollama' || provider === 'llamacpp' ? 3 : 4),
          baseDelayMs: getOptionalNumberArg(args, 'baseDelayMs') ?? (provider === 'ollama' || provider === 'llamacpp' ? 200 : 500),
          maxDelayMs: 30000,
          multiplier: 2,
          jitterFactor: 0.25,
        };
        const plan = planRetry(
          {
            provider,
            status: getOptionalNumberArg(args, 'status'),
            message: getOptionalStringArg(args, 'message'),
            isTimeout: getBoolArg(args, 'isTimeout', false),
            isNetwork: getBoolArg(args, 'isNetwork', false),
          },
          config,
          getOptionalNumberArg(args, 'seed'),
        );
        const retryAfter = getOptionalStringArg(args, 'retryAfter');
        let effectiveFirstDelayMs: number | null = null;
        if (plan.steps.length > 0 && plan.kind === 'rate-limited' && retryAfter !== undefined) {
          effectiveFirstDelayMs = effectiveRateLimitDelayMs(retryAfter, plan.steps[0]?.delayMs ?? 0);
        }
        if (plan.retryable) {
          const tripped = cooldowns.recordFailure(provider);
          if (tripped) {
            // Ghi chu: provider vua bi cooldown sau nhieu loi lien tiep.
            plan.reason += ' Provider da vao cooldown (5 loi lien tiep).';
          }
        } else {
          cooldowns.recordSuccess(provider);
        }
        return okResult({
          ...plan,
          effectiveFirstDelayMs,
          coolingDown: cooldowns.isCoolingDown(provider),
          msUntilAvailable: cooldowns.msUntilAvailable(provider),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    toolChoiceResolveTool,
    requestParamsTool,
    capabilityMatrixTool,
    toolsetCreateTool,
    toolsetUpdateTool,
    toolsetCacheKeyTool,
    threadLockTool,
    scriptValidateTool,
    scriptRunTool,
    scriptAuditTool,
    botPolicyGetTool,
    botPolicySetTool,
    costRouteTool,
    costReportTool,
    retryPlanTool,
  ];
}

export const ROUTER_LOCAL_V118_TOOLS: Tool[] = createRouterLocalV118Tools();

// Re-export helpers ca tool can dung (de host kiem tra policy nhanh).
export { defaultBotRouterPolicy, isToolAllowed, normalizeBotRouterPolicy };
