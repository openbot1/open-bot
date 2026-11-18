/**
 * Sandbox v4 tools (v1.36, Team T4).
 *
 * 19 tools, bound through `createSandboxV4Tools(getBaseDir, opts)`:
 *
 *  - sandbox_v4_runtime_create   — create + start a per-conversation runtime (needs approval).
 *  - sandbox_v4_runtime_list     — list runtimes with state, profile, budget status (read-only).
 *  - sandbox_v4_runtime_report   — full report for a runtime: session, budget, processes (read-only).
 *  - sandbox_v4_runtime_stop     — stop a runtime (kills its processes, stops its v3 session).
 *  - sandbox_v4_runtime_cleanup  — delete a runtime: workspace + v3 session + its secrets (needs approval).
 *  - sandbox_v4_profile_list     — list agent profiles (builtins + customs) with skills + LLM (read-only).
 *  - sandbox_v4_profile_validate — validate a profile JSON document (read-only).
 *  - sandbox_v4_profile_create   — create a custom profile (needs approval).
 *  - sandbox_v4_profile_set      — assign a profile to a runtime.
 *  - sandbox_v4_budget_status    — budget status for a runtime / conversation (read-only).
 *  - sandbox_v4_budget_set_limits — replace a runtime's budget limits (needs approval: money).
 *  - sandbox_v4_budget_record    — record one usage step on a runtime's meter.
 *  - sandbox_v4_secret_request   — open a secret request (the approval happens at fulfil time).
 *  - sandbox_v4_secret_approve   — fulfil a pending request with a value (needs approval).
 *  - sandbox_v4_secret_deny      — deny a pending request.
 *  - sandbox_v4_secret_list      — list a conversation's secret requests, metadata only (read-only).
 *  - sandbox_v4_depmap_build     — build the dependency map of a source tree (read-only).
 *  - sandbox_v4_depmap_order     — topological change waves for a set of files (read-only).
 *  - sandbox_v4_depmap_conflicts — detect conflicts between agents' change sets (read-only).
 *
 * SAFETY: `runtime_create` / `runtime_cleanup` / `profile_create`
 * / `budget_set_limits` / `secret_approve` are needsApproval.
 * The secret value passed to `secret_approve` is NEVER echoed
 * back in any result, never written to any log by this module,
 * and is single-use inside the manager. HOST WARNING: the host
 * that executes these tools must not persist tool-call arguments
 * for `sandbox_v4_secret_approve` — the value travels in the
 * call, and only the user-typed modal input should ever fill it.
 * The budget meter soft-blocks new steps when a hard limit is
 * crossed; the tools report the block, they do not override it.
 */

import type { Tool } from '@open-bot/core';
import {
  SandboxV4Service,
  defaultSandboxV4BudgetLimits,
  renderSandboxV4BudgetMarkdown,
  renderSandboxV4DepMapMarkdown,
  renderSandboxV4RuntimeReportMarkdown,
  validateSandboxV4AgentProfile,
  validateSandboxV4BudgetLimits,
  type SandboxV4BudgetLimits,
} from '@open-bot/core';

export const SANDBOX_V4_TOOL_NAMES = [
  'sandbox_v4_runtime_create',
  'sandbox_v4_runtime_list',
  'sandbox_v4_runtime_report',
  'sandbox_v4_runtime_stop',
  'sandbox_v4_runtime_cleanup',
  'sandbox_v4_profile_list',
  'sandbox_v4_profile_validate',
  'sandbox_v4_profile_create',
  'sandbox_v4_profile_set',
  'sandbox_v4_budget_status',
  'sandbox_v4_budget_set_limits',
  'sandbox_v4_budget_record',
  'sandbox_v4_secret_request',
  'sandbox_v4_secret_approve',
  'sandbox_v4_secret_deny',
  'sandbox_v4_secret_list',
  'sandbox_v4_depmap_build',
  'sandbox_v4_depmap_order',
  'sandbox_v4_depmap_conflicts',
] as const;

export function isSandboxV4ToolName(name: string): boolean {
  return (SANDBOX_V4_TOOL_NAMES as readonly string[]).includes(name);
}

export interface SandboxV4ToolOptions {
  /** Base dir for runtimes (default: os.tmpdir()/open-bot-sandbox-v4). */
  baseDir?: string;
  /** Idle timeout for runtimes in ms. */
  idleTimeoutMs?: number;
  /** Default lifetime cap for runtimes in ms. */
  defaultLifetimeMs?: number;
  /** Secret request TTL in ms. */
  secretTtlMs?: number;
}

function errorResult(message: string): string {
  return `Error: ${message}`;
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

function getStringArg(args: Record<string, unknown>, name: string, required = false): string {
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

function getNumberArg(args: Record<string, unknown>, name: string, defaultValue?: number): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`Argument "${name}" must be a number, got ${typeof value}`);
  }
  return value;
}

function getRequiredNumberArg(args: Record<string, unknown>, name: string): number {
  const value = getNumberArg(args, name);
  if (value === undefined) throw new Error(`Missing required argument: "${name}"`);
  return value;
}

function getStringArrayArg(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`Argument "${name}" must be an array of strings`);
  for (const item of value) {
    if (typeof item !== 'string') throw new Error(`Argument "${name}" must be an array of strings`);
  }
  return [...(value as string[])];
}

function getTrustArg(args: Record<string, unknown>): 'trusted' | 'standard' | 'untrusted' | 'hostile' {
  const trust = getStringArg(args, 'trust');
  if (trust === '') return 'standard';
  const allowed = ['trusted', 'standard', 'untrusted', 'hostile'];
  if (!allowed.includes(trust)) {
    throw new Error(`trust must be one of ${allowed.join(', ')}, got "${trust}"`);
  }
  return trust as 'trusted' | 'standard' | 'untrusted' | 'hostile';
}

function getTierArg(args: Record<string, unknown>): 'bwrap' | 'syscall-policy' | 'microvm' | undefined {
  const tier = getStringArg(args, 'tier');
  if (tier === '') return undefined;
  const allowed = ['bwrap', 'syscall-policy', 'microvm'];
  if (!allowed.includes(tier)) {
    throw new Error(`tier must be one of ${allowed.join(', ')}, got "${tier}"`);
  }
  return tier as 'bwrap' | 'syscall-policy' | 'microvm';
}

/** Resolve a runtime id from either `runtimeId` or `conversationId`. */
function resolveRuntimeId(service: SandboxV4Service, args: Record<string, unknown>): string {
  const runtimeId = getStringArg(args, 'runtimeId');
  if (runtimeId !== '') {
    if (!service.getRuntime(runtimeId)) throw new Error(`Unknown sandbox v4 runtime "${runtimeId}".`);
    return runtimeId;
  }
  const conversationId = getStringArg(args, 'conversationId', true);
  const runtime = service.getRuntimeByConversation(conversationId);
  if (!runtime) throw new Error(`No sandbox v4 runtime for conversation "${conversationId}".`);
  return runtime.id;
}

function parseBudgetLimitsArg(args: Record<string, unknown>): SandboxV4BudgetLimits | undefined {
  const maxInput = getNumberArg(args, 'budgetMaxInputTokens');
  const maxOutput = getNumberArg(args, 'budgetMaxOutputTokens');
  const maxCost = getNumberArg(args, 'budgetMaxCostUsd');
  const maxWall = getNumberArg(args, 'budgetMaxWallMs');
  const warnAt = getNumberArg(args, 'budgetWarnAtRatio');
  if (maxInput === undefined && maxOutput === undefined && maxCost === undefined && maxWall === undefined && warnAt === undefined) {
    return undefined;
  }
  const defaults = defaultSandboxV4BudgetLimits();
  return {
    maxInputTokens: maxInput ?? defaults.maxInputTokens,
    maxOutputTokens: maxOutput ?? defaults.maxOutputTokens,
    maxCostUsd: maxCost ?? defaults.maxCostUsd,
    maxWallMs: maxWall ?? defaults.maxWallMs,
    warnAtRatio: warnAt ?? defaults.warnAtRatio,
  };
}

/**
 * Create the sandbox v4 tools. One service is created per call
 * and shared by the tools, so a runtime created by
 * `sandbox_v4_runtime_create` is visible to
 * `sandbox_v4_budget_status` and `sandbox_v4_runtime_report`
 * in the same host process.
 */
export function createSandboxV4Tools(
  getBaseDir?: () => string | null | undefined,
  toolOptions: SandboxV4ToolOptions = {},
): Tool[] {
  const resolveBase = (): string | undefined => {
    try {
      const dir = getBaseDir?.();
      if (typeof dir === 'string' && dir.trim().length > 0) return dir;
    } catch {
      // Fall through to toolOptions.baseDir / service default.
    }
    return toolOptions.baseDir;
  };

  const service = new SandboxV4Service({
    ...(resolveBase() !== undefined ? { baseDir: resolveBase() as string } : {}),
    ...(toolOptions.idleTimeoutMs !== undefined ? { idleTimeoutMs: toolOptions.idleTimeoutMs } : {}),
    ...(toolOptions.defaultLifetimeMs !== undefined ? { defaultLifetimeMs: toolOptions.defaultLifetimeMs } : {}),
    ...(toolOptions.secretTtlMs !== undefined ? { secretTtlMs: toolOptions.secretTtlMs } : {}),
  });

  const runtimeCreateTool: Tool = {
    definition: toolDef(
      'sandbox_v4_runtime_create',
      'Create and start a per-conversation sandbox v4 runtime: its own sandbox v3 session, its own workspace directory, its own process registry and budget meter. One live runtime per conversation. Needs approval: a runtime reserves a workspace and a lifetime budget.',
      {
        conversationId: { type: 'string', description: 'Conversation id (1-128 chars: letters, digits, "_", "-").' },
        trust: { type: 'string', description: 'Trust level: trusted | standard | untrusted | hostile (default standard).' },
        policyId: { type: 'string', description: 'Builtin sandbox v3 policy id (optional, default: builtin for the trust level).' },
        tier: { type: 'string', description: 'Requested tier: bwrap | syscall-policy | microvm (optional).' },
        lifetimeMs: { type: 'number', description: 'Requested lifetime in ms (default 4h, max 24h).' },
        profileId: { type: 'string', description: 'Agent profile id to run under (optional).' },
        budgetMaxInputTokens: { type: 'number', description: 'Budget: max input tokens (optional, default 200000, 0 = unlimited).' },
        budgetMaxOutputTokens: { type: 'number', description: 'Budget: max output tokens (optional, default 50000, 0 = unlimited).' },
        budgetMaxCostUsd: { type: 'number', description: 'Budget: max spend in USD (optional, default 5, 0 = unlimited).' },
        budgetMaxWallMs: { type: 'number', description: 'Budget: max wall-clock time in ms (optional, default 3600000, 0 = unlimited).' },
      },
      ['conversationId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const conversationId = getStringArg(args, 'conversationId', true);
        const trust = getTrustArg(args);
        const policyId = getStringArg(args, 'policyId');
        const tier = getTierArg(args);
        const lifetimeMs = getNumberArg(args, 'lifetimeMs');
        const profileId = getStringArg(args, 'profileId');
        const budgetLimits = parseBudgetLimitsArg(args);
        const runtime = service.createRuntime(conversationId, {
          trust,
          ...(policyId !== '' ? { policyId } : {}),
          ...(tier !== undefined ? { tier } : {}),
          ...(lifetimeMs !== undefined ? { lifetimeMs } : {}),
          ...(profileId !== '' ? { profileId } : {}),
          ...(budgetLimits !== undefined ? { budgetLimits } : {}),
        });
        return JSON.stringify({ runtime }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const runtimeListTool: Tool = {
    definition: toolDef(
      'sandbox_v4_runtime_list',
      'List sandbox v4 runtimes with state, conversation, profile, tier, deadline and live process counts. Read-only.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      try {
        const runtimes = service.listRuntimes();
        return JSON.stringify({ runtimes }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const runtimeReportTool: Tool = {
    definition: toolDef(
      'sandbox_v4_runtime_report',
      'Full report for one sandbox v4 runtime: session, budget meter, processes, whether a new step may run. Read-only. Give runtimeId or conversationId.',
      {
        runtimeId: { type: 'string', description: 'Runtime id (alternative to conversationId).' },
        conversationId: { type: 'string', description: 'Conversation id (alternative to runtimeId).' },
        format: { type: 'string', description: '"json" (default) or "markdown".' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const runtimeId = resolveRuntimeId(service, args);
        const report = service.reportRuntime(runtimeId);
        const format = getStringArg(args, 'format');
        if (format === 'markdown') return renderSandboxV4RuntimeReportMarkdown(report);
        return JSON.stringify(report, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const runtimeStopTool: Tool = {
    definition: toolDef(
      'sandbox_v4_runtime_stop',
      'Stop a sandbox v4 runtime for good: kills its registered processes and stops its sandbox v3 session. The workspace is kept until cleanup. Give runtimeId or conversationId.',
      {
        runtimeId: { type: 'string', description: 'Runtime id (alternative to conversationId).' },
        conversationId: { type: 'string', description: 'Conversation id (alternative to runtimeId).' },
        reason: { type: 'string', description: 'Why the runtime is stopped (optional).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const runtimeId = resolveRuntimeId(service, args);
        const reason = getStringArg(args, 'reason');
        const stopped = service.stopRuntime(runtimeId, reason);
        return JSON.stringify({ runtimeId, stopped }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const runtimeCleanupTool: Tool = {
    definition: toolDef(
      'sandbox_v4_runtime_cleanup',
      'Clean up a sandbox v4 runtime: stop it, delete its sandbox v3 session, remove its workspace directory from disk, and drop its secret requests. Needs approval: the workspace is deleted.',
      {
        runtimeId: { type: 'string', description: 'Runtime id (alternative to conversationId).' },
        conversationId: { type: 'string', description: 'Conversation id (alternative to runtimeId).' },
      },
      [],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const runtimeId = resolveRuntimeId(service, args);
        const cleaned = service.cleanupRuntime(runtimeId);
        return JSON.stringify({ runtimeId, cleaned }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const profileListTool: Tool = {
    definition: toolDef(
      'sandbox_v4_profile_list',
      'List agent profiles (builtins + customs) with skills, LLM model and network flags. Read-only.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      try {
        const profiles = service.profileStore().summarize();
        return JSON.stringify({ profiles }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const profileValidateTool: Tool = {
    definition: toolDef(
      'sandbox_v4_profile_validate',
      'Validate an agent profile JSON document (persona, instructions, skill ids from the catalog, LLM profile). Returns valid true/false plus every problem. An invalid profile must never be applied. Read-only.',
      {
        profileJson: { type: 'string', description: 'Profile document as a JSON string.' },
      },
      ['profileJson'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const profileJson = getStringArg(args, 'profileJson', true);
        let parsed: unknown;
        try {
          parsed = JSON.parse(profileJson) as unknown;
        } catch (err) {
          return errorResult(`Profile JSON is not valid JSON: ${(err as Error).message}`);
        }
        const problems = validateSandboxV4AgentProfile(parsed);
        return JSON.stringify({ valid: problems.length === 0, problems }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const profileCreateTool: Tool = {
    definition: toolDef(
      'sandbox_v4_profile_create',
      'Create a custom agent profile from a profile JSON document (id, name, persona, instructions, skillIds, llm). Builtin ids cannot be reused. Needs approval: the profile becomes available to every conversation.',
      {
        profileJson: { type: 'string', description: 'Profile document as a JSON string.' },
      },
      ['profileJson'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const profileJson = getStringArg(args, 'profileJson', true);
        let parsed: unknown;
        try {
          parsed = JSON.parse(profileJson) as unknown;
        } catch (err) {
          return errorResult(`Profile JSON is not valid JSON: ${(err as Error).message}`);
        }
        const problems = validateSandboxV4AgentProfile(parsed);
        if (problems.length > 0) {
          return errorResult(`Invalid profile: ${problems.join(' ')}`);
        }
        const result = service.createProfile(parsed as Parameters<SandboxV4Service['createProfile']>[0]);
        if (!result.ok) return errorResult(result.error ?? 'Could not create profile.');
        return JSON.stringify({ profile: result.profile }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const profileSetTool: Tool = {
    definition: toolDef(
      'sandbox_v4_profile_set',
      'Assign an agent profile to a runtime (the profile must exist). The runtime keeps running under the new profile from the next turn. Give runtimeId or conversationId.',
      {
        runtimeId: { type: 'string', description: 'Runtime id (alternative to conversationId).' },
        conversationId: { type: 'string', description: 'Conversation id (alternative to runtimeId).' },
        profileId: { type: 'string', description: 'Agent profile id (e.g. coder, researcher, generalist).' },
      },
      ['profileId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const runtimeId = resolveRuntimeId(service, args);
        const profileId = getStringArg(args, 'profileId', true);
        const runtime = service.setRuntimeProfile(runtimeId, profileId);
        const systemPrompt = service.systemPromptForRuntime(runtimeId);
        return JSON.stringify({ runtime, systemPrompt }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const budgetStatusTool: Tool = {
    definition: toolDef(
      'sandbox_v4_budget_status',
      'Budget status for a runtime / conversation: token / dollar / time usage vs limits, warning and blocked dimensions, remaining headroom. Read-only. Give runtimeId or conversationId.',
      {
        runtimeId: { type: 'string', description: 'Runtime id (alternative to conversationId).' },
        conversationId: { type: 'string', description: 'Conversation id (alternative to runtimeId).' },
        format: { type: 'string', description: '"json" (default) or "markdown".' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const runtimeId = resolveRuntimeId(service, args);
        const state = service.budgetForRuntime(runtimeId);
        const format = getStringArg(args, 'format');
        if (format === 'markdown') return renderSandboxV4BudgetMarkdown(state);
        return JSON.stringify(state, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const budgetSetLimitsTool: Tool = {
    definition: toolDef(
      'sandbox_v4_budget_set_limits',
      'Replace a runtime budget limits (any subset; omitted fields keep their defaults from the standard budget). Needs approval: raising a limit spends real money. Give runtimeId or conversationId.',
      {
        runtimeId: { type: 'string', description: 'Runtime id (alternative to conversationId).' },
        conversationId: { type: 'string', description: 'Conversation id (alternative to runtimeId).' },
        maxInputTokens: { type: 'number', description: 'Max input tokens (0 = unlimited).' },
        maxOutputTokens: { type: 'number', description: 'Max output tokens (0 = unlimited).' },
        maxCostUsd: { type: 'number', description: 'Max spend in USD (0 = unlimited).' },
        maxWallMs: { type: 'number', description: 'Max wall-clock time in ms (0 = unlimited).' },
        warnAtRatio: { type: 'number', description: 'Warn when any used ratio reaches this, 0..1 (default 0.8).' },
      },
      [],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const runtimeId = resolveRuntimeId(service, args);
        const current = service.budgetForRuntime(runtimeId);
        const next: SandboxV4BudgetLimits = {
          maxInputTokens: getNumberArg(args, 'maxInputTokens') ?? current.limits.maxInputTokens,
          maxOutputTokens: getNumberArg(args, 'maxOutputTokens') ?? current.limits.maxOutputTokens,
          maxCostUsd: getNumberArg(args, 'maxCostUsd') ?? current.limits.maxCostUsd,
          maxWallMs: getNumberArg(args, 'maxWallMs') ?? current.limits.maxWallMs,
          warnAtRatio: getNumberArg(args, 'warnAtRatio') ?? current.limits.warnAtRatio,
        };
        const problems = validateSandboxV4BudgetLimits(next);
        if (problems.length > 0) return errorResult(`Invalid budget limits: ${problems.join(' ')}`);
        const applyProblems = service.setBudgetLimits(runtimeId, next);
        if (applyProblems.length > 0) return errorResult(`Invalid budget limits: ${applyProblems.join(' ')}`);
        return JSON.stringify({ runtimeId, limits: next, state: service.budgetForRuntime(runtimeId) }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const budgetRecordTool: Tool = {
    definition: toolDef(
      'sandbox_v4_budget_record',
      'Record one usage step on a runtime budget meter (model, input/output tokens, wall time). Returns the meter status after recording, including soft-blocked when a hard limit was crossed. Give runtimeId or conversationId.',
      {
        runtimeId: { type: 'string', description: 'Runtime id (alternative to conversationId).' },
        conversationId: { type: 'string', description: 'Conversation id (alternative to runtimeId).' },
        model: { type: 'string', description: 'Model id for cost estimation (e.g. gpt-4o, ollama/llama3).' },
        inputTokens: { type: 'number', description: 'Input tokens in this step.' },
        outputTokens: { type: 'number', description: 'Output tokens in this step.' },
        wallMs: { type: 'number', description: 'Wall time in ms for this step (optional).' },
        costUsd: { type: 'number', description: 'Provider-reported cost in USD (optional; overrides the estimate).' },
      },
      ['inputTokens', 'outputTokens'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const runtimeId = resolveRuntimeId(service, args);
        const model = getStringArg(args, 'model');
        const inputTokens = getRequiredNumberArg(args, 'inputTokens');
        const outputTokens = getRequiredNumberArg(args, 'outputTokens');
        const wallMs = getNumberArg(args, 'wallMs');
        const costUsd = getNumberArg(args, 'costUsd');
        const result = service.recordUsage(runtimeId, {
          ...(model !== '' ? { model } : {}),
          inputTokens,
          outputTokens,
          ...(wallMs !== undefined ? { wallMs } : {}),
          ...(costUsd !== undefined ? { costUsd } : {}),
        });
        return JSON.stringify(result, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const secretRequestTool: Tool = {
    definition: toolDef(
      'sandbox_v4_secret_request',
      'Open a secret request: the agent asks for a credential (API key, token) mid-conversation. The user fulfils it out of band; the value is single-use and never appears in any log, context or history. Returns the request id (metadata only).',
      {
        conversationId: { type: 'string', description: 'Conversation the request belongs to.' },
        name: { type: 'string', description: 'Secret name, e.g. GITHUB_TOKEN (never the value).' },
        purpose: { type: 'string', description: 'Why the agent needs it (shown to the user).' },
        requestedBy: { type: 'string', description: 'Which agent / tool asked (optional).' },
      },
      ['conversationId', 'name', 'purpose'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const conversationId = getStringArg(args, 'conversationId', true);
        const name = getStringArg(args, 'name', true);
        const purpose = getStringArg(args, 'purpose', true);
        const requestedBy = getStringArg(args, 'requestedBy');
        const request = service.secretManager().request({
          conversationId,
          name,
          purpose,
          ...(requestedBy !== '' ? { requestedBy } : {}),
        });
        return JSON.stringify({ request }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const secretApproveTool: Tool = {
    definition: toolDef(
      'sandbox_v4_secret_approve',
      'Fulfil a pending secret request with its value. The value is stored in memory only, single-use, and is NEVER echoed back in the result or written to any log. Needs approval: this is the step where the user hands over a credential. Hosts must not persist this tool call arguments.',
      {
        requestId: { type: 'string', description: 'Secret request id.' },
        value: { type: 'string', description: 'The secret value (typed by the user in the approval modal, never from chat).' },
        resolvedBy: { type: 'string', description: 'Who fulfilled it (optional, default user).' },
      },
      ['requestId', 'value'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const requestId = getStringArg(args, 'requestId', true);
        const value = getStringArg(args, 'value', true);
        const resolvedBy = getStringArg(args, 'resolvedBy');
        // The value is passed straight to the manager and never
        // touches this tool result, a log, or any other output.
        const request = service.secretManager().fulfill(requestId, value, resolvedBy === '' ? 'user' : resolvedBy);
        return JSON.stringify({ request, liveValueWaiting: true }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const secretDenyTool: Tool = {
    definition: toolDef(
      'sandbox_v4_secret_deny',
      'Deny a pending secret request (operator note, never a value).',
      {
        requestId: { type: 'string', description: 'Secret request id.' },
        note: { type: 'string', description: 'Why it was denied (optional).' },
        resolvedBy: { type: 'string', description: 'Who denied it (optional, default user).' },
      },
      ['requestId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const requestId = getStringArg(args, 'requestId', true);
        const note = getStringArg(args, 'note');
        const resolvedBy = getStringArg(args, 'resolvedBy');
        const request = service.secretManager().deny(requestId, note, resolvedBy === '' ? 'user' : resolvedBy);
        return JSON.stringify({ request }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const secretListTool: Tool = {
    definition: toolDef(
      'sandbox_v4_secret_list',
      'List a conversation secret requests (metadata only: id, name, purpose, status — never a value). Read-only.',
      {
        conversationId: { type: 'string', description: 'Conversation id.' },
        pendingOnly: { type: 'boolean', description: 'Only pending requests (default false).' },
      },
      ['conversationId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const conversationId = getStringArg(args, 'conversationId', true);
        const pendingOnly = args.pendingOnly === true;
        const requests = pendingOnly
          ? service.secretManager().listPending(conversationId)
          : service.secretManager().listForConversation(conversationId);
        return JSON.stringify({ requests, liveValues: service.secretManager().liveValueCount() }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const depmapBuildTool: Tool = {
    definition: toolDef(
      'sandbox_v4_depmap_build',
      'Build the dependency map of a source tree: the import graph, file/edge counts, import cycles, and the most-imported files. Read-only (reads files, writes nothing).',
      {
        rootDir: { type: 'string', description: 'Root directory to scan (absolute path).' },
        format: { type: 'string', description: '"json" (default) or "markdown".' },
      },
      ['rootDir'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const rootDir = getStringArg(args, 'rootDir', true);
        const result = service.buildDepMap(rootDir);
        const format = getStringArg(args, 'format');
        if (format === 'markdown') {
          return renderSandboxV4DepMapMarkdown(result.map);
        }
        return JSON.stringify(
          {
            map: result.map,
            skippedOversize: result.skippedOversize,
            unresolvable: result.unresolvable,
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const depmapOrderTool: Tool = {
    definition: toolDef(
      'sandbox_v4_depmap_order',
      'Topological change waves for a set of files: files in one wave have no dependency between each other, waves run in dependency order. Files stuck in import cycles are reported unordered. Read-only.',
      {
        rootDir: { type: 'string', description: 'Root directory to scan (absolute path).' },
        files: { type: 'array', description: 'Files to order (paths relative to rootDir).' },
      },
      ['rootDir', 'files'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const rootDir = getStringArg(args, 'rootDir', true);
        const files = getStringArrayArg(args, 'files');
        const { map } = service.buildDepMap(rootDir);
        const plan = service.planChanges(map, files);
        return JSON.stringify({ plan, cycles: map.cycles }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const depmapConflictsTool: Tool = {
    definition: toolDef(
      'sandbox_v4_depmap_conflicts',
      'Detect conflicts between agents change sets: same file edited by two agents, or one agent change landing inside another agent impact set. Read-only. changeSets is a JSON array [{ agentId, files, description }].',
      {
        rootDir: { type: 'string', description: 'Root directory to scan (absolute path).' },
        changeSetsJson: { type: 'string', description: 'Change sets as a JSON string.' },
      },
      ['rootDir', 'changeSetsJson'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const rootDir = getStringArg(args, 'rootDir', true);
        const changeSetsJson = getStringArg(args, 'changeSetsJson', true);
        let parsed: unknown;
        try {
          parsed = JSON.parse(changeSetsJson) as unknown;
        } catch (err) {
          return errorResult(`changeSetsJson is not valid JSON: ${(err as Error).message}`);
        }
        if (!Array.isArray(parsed)) return errorResult('changeSetsJson must be a JSON array of { agentId, files, description }.');
        const { map } = service.buildDepMap(rootDir);
        const conflicts = service.depConflicts(
          map,
          parsed as Parameters<SandboxV4Service['depConflicts']>[1],
        );
        return JSON.stringify({ conflicts, conflictCount: conflicts.length }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    runtimeCreateTool,
    runtimeListTool,
    runtimeReportTool,
    runtimeStopTool,
    runtimeCleanupTool,
    profileListTool,
    profileValidateTool,
    profileCreateTool,
    profileSetTool,
    budgetStatusTool,
    budgetSetLimitsTool,
    budgetRecordTool,
    secretRequestTool,
    secretApproveTool,
    secretDenyTool,
    secretListTool,
    depmapBuildTool,
    depmapOrderTool,
    depmapConflictsTool,
  ];
}

/** Default (unbound) tools, for the global tool list. */
export const SANDBOX_V4_TOOLS: Tool[] = createSandboxV4Tools();

// Re-exported for tests / host wiring convenience.
export { SandboxV4Service };
export type { SandboxV4BudgetLimits };
