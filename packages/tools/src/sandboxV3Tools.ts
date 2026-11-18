/**
 * Sandbox v3 tools (v1.35, Team T2).
 *
 * 15 tools, bound through `createSandboxV3Tools(getBaseDir, opts)`:
 *
 *  - sandbox_v3_list_policies    — list built-in policies (id, trust, tier, syscall mode, egress, lifetime).
 *  - sandbox_v3_policy_validate  — validate a policy JSON document (read-only).
 *  - sandbox_v3_create_session   — create + start a session under a policy (needs approval).
 *  - sandbox_v3_list_sessions    — list sessions with state, steps, blocked events.
 *  - sandbox_v3_run_command      — run a shell command inside a session (needs approval).
 *  - sandbox_v3_run_step         — run a gated tool step (hooks + syscall + egress checks; needs approval).
 *  - sandbox_v3_report           — full deep-sandbox report for a session.
 *  - sandbox_v3_pause            — freeze a live session (no step runs while paused).
 *  - sandbox_v3_resume           — resume a paused session.
 *  - sandbox_v3_stop             — stop a session for good.
 *  - sandbox_v3_snapshot         — take a copy-on-write snapshot of the session workspace.
 *  - sandbox_v3_snapshot_restore — restore a snapshot into the workspace.
 *  - sandbox_v3_egress_check     — check one URL against a session's egress gate (read-only).
 *  - sandbox_v3_syscall_check    — check syscalls against a session's allowlist (read-only).
 *  - sandbox_v3_hook_register    — register a Pre/PostToolUse hook on a live session (needs approval).
 *
 * SAFETY: `run_command` / `run_step` / `create_session` /
 * `hook_register` are needsApproval; the runner enforces the
 * policy before executing anything, and every denial is recorded
 * on the session report. `run_step` executes through the host
 * executor when one is wired; otherwise it is a gates-only check
 * that records the step without running untrusted code.
 */

import type { Tool } from '@open-bot/core';
import {
  BUILTIN_SANDBOX_V3_POLICIES,
  SANDBOX_V3_TIER_LEVELS,
  SandboxV3EgressGate,
  SandboxV3Runner,
  SyscallAllowlist,
  builtinPolicyV3ForTrust,
  getBuiltinSandboxV3Policy,
  parseEgressPolicy,
  parseSandboxV3Policy,
  renderSandboxV3ReportMarkdown,
  summarizeSandboxV3Report,
  validateSandboxV3Policy,
  type SandboxV3EgressRequest,
  type SandboxV3Policy,
  type SandboxV3SyscallMode,
  type SandboxV2Tier,
  type SandboxV2TrustLevel,
} from '@open-bot/core';

export const SANDBOX_V3_TOOL_NAMES = [
  'sandbox_v3_list_policies',
  'sandbox_v3_policy_validate',
  'sandbox_v3_create_session',
  'sandbox_v3_list_sessions',
  'sandbox_v3_run_command',
  'sandbox_v3_run_step',
  'sandbox_v3_report',
  'sandbox_v3_pause',
  'sandbox_v3_resume',
  'sandbox_v3_stop',
  'sandbox_v3_snapshot',
  'sandbox_v3_snapshot_restore',
  'sandbox_v3_egress_check',
  'sandbox_v3_syscall_check',
  'sandbox_v3_hook_register',
] as const;

export function isSandboxV3ToolName(name: string): boolean {
  return (SANDBOX_V3_TOOL_NAMES as readonly string[]).includes(name);
}

export interface SandboxV3ToolOptions {
  /** Base dir for session workspaces (default: os.tmpdir()/open-bot-sandbox-v3). */
  baseDir?: string;
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

function getStringArrayArg(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`Argument "${name}" must be an array of strings`);
  for (const item of value) {
    if (typeof item !== 'string') throw new Error(`Argument "${name}" must be an array of strings`);
  }
  return [...(value as string[])];
}

function getObjectArg(args: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = args[name];
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Argument "${name}" must be an object`);
  }
  return value as Record<string, unknown>;
}

function getTrustArg(args: Record<string, unknown>): SandboxV2TrustLevel {
  const trust = getStringArg(args, 'trust');
  if (trust === '') return 'standard';
  const allowed: SandboxV2TrustLevel[] = ['trusted', 'standard', 'untrusted', 'hostile'];
  if (!allowed.includes(trust as SandboxV2TrustLevel)) {
    throw new Error(`trust must be one of ${allowed.join(', ')}, got "${trust}"`);
  }
  return trust as SandboxV2TrustLevel;
}

function getTierArg(args: Record<string, unknown>): SandboxV2Tier | undefined {
  const tier = getStringArg(args, 'tier');
  if (tier === '') return undefined;
  const allowed: SandboxV2Tier[] = ['bwrap', 'syscall-policy', 'microvm'];
  if (!allowed.includes(tier as SandboxV2Tier)) {
    throw new Error(`tier must be one of ${allowed.join(', ')}, got "${tier}"`);
  }
  return tier as SandboxV2Tier;
}

function getSyscallModeArg(args: Record<string, unknown>): SandboxV3SyscallMode | undefined {
  const mode = getStringArg(args, 'syscallMode');
  if (mode === '') return undefined;
  const allowed: SandboxV3SyscallMode[] = ['strict', 'standard', 'permissive'];
  if (!allowed.includes(mode as SandboxV3SyscallMode)) {
    throw new Error(`syscallMode must be one of ${allowed.join(', ')}, got "${mode}"`);
  }
  return mode as SandboxV3SyscallMode;
}

function resolvePolicyArg(args: Record<string, unknown>, trust: SandboxV2TrustLevel): SandboxV3Policy {
  const policyJson = getStringArg(args, 'policyJson');
  if (policyJson !== '') return parseSandboxV3Policy(policyJson);
  const policyId = getStringArg(args, 'policyId');
  if (policyId !== '') {
    const builtin = getBuiltinSandboxV3Policy(policyId);
    if (!builtin) throw new Error(`Unknown sandbox v3 policy "${policyId}"`);
    return builtin;
  }
  return builtinPolicyV3ForTrust(trust);
}

function policySummary(policy: SandboxV3Policy): Record<string, unknown> {
  return {
    id: policy.id,
    name: policy.name,
    description: policy.description,
    version: policy.version,
    trust: policy.trust,
    minTier: policy.minTier,
    minTierLevel: SANDBOX_V3_TIER_LEVELS[policy.minTier],
    syscallMode: policy.syscallMode,
    syscallAllow: policy.syscalls.allow,
    syscallDeny: policy.syscalls.deny,
    egressEnabled: policy.egress.enabled,
    egressHosts: policy.egress.allowedHosts,
    egressSchemes: policy.egress.schemes,
    maxLifetimeMs: policy.lifetime.maxLifetimeMs,
    graceMs: policy.lifetime.graceMs,
    idleTimeoutMs: policy.lifetime.idleTimeoutMs,
    maxPauseMs: policy.lifetime.maxPauseMs,
    maxSteps: policy.caps.maxSteps,
    maxSnapshots: policy.caps.maxSnapshots,
    hooks: policy.hooks.map((hook) => `${hook.timing}:${hook.name} (${hook.decision})`),
    commands: policy.commands,
    shellEnabled: policy.shellEnabled,
  };
}

/**
 * Create the sandbox v3 tools. One runner is created per call and
 * shared by the tools, so `sandbox_v3_pause` can freeze a session
 * started by `sandbox_v3_create_session` in the same host process,
 * and `sandbox_v3_report` can read it afterwards.
 */
export function createSandboxV3Tools(
  getBaseDir?: () => string | null | undefined,
  toolOptions: SandboxV3ToolOptions = {},
): Tool[] {
  const resolveBase = (): string | undefined => {
    try {
      const dir = getBaseDir?.();
      if (typeof dir === 'string' && dir.trim().length > 0) return dir;
    } catch {
      // Fall through to toolOptions.baseDir / runner default.
    }
    return toolOptions.baseDir;
  };

  const runner = new SandboxV3Runner({
    ...(resolveBase() !== undefined ? { baseDir: resolveBase() as string } : {}),
  });

  const listPoliciesTool: Tool = {
    definition: toolDef(
      'sandbox_v3_list_policies',
      'List the built-in sandbox v3 policies (strict / standard / trusted / untrusted / hostile) with trust level, minimum tier, syscall mode, egress and lifetime rules. Read-only.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const policies = Object.values(BUILTIN_SANDBOX_V3_POLICIES).map(policySummary);
      return JSON.stringify({ policies }, null, 2);
    },
  };

  const validatePolicyTool: Tool = {
    definition: toolDef(
      'sandbox_v3_policy_validate',
      'Validate a sandbox v3 policy JSON document (policy-as-code). Returns valid true/false plus every problem and warning. An invalid policy must never be applied. Read-only.',
      {
        policyJson: { type: 'string', description: 'Policy document as a JSON string.' },
      },
      ['policyJson'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const policyJson = getStringArg(args, 'policyJson', true);
        let parsed: unknown;
        try {
          parsed = JSON.parse(policyJson) as unknown;
        } catch (err) {
          return errorResult(`Policy JSON is not valid JSON: ${(err as Error).message}`);
        }
        const result = validateSandboxV3Policy(parsed);
        return JSON.stringify(
          {
            valid: result.valid,
            problems: result.problems,
            warnings: result.warnings,
            ...(result.policy ? { policy: policySummary(result.policy) } : {}),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const createSessionTool: Tool = {
    definition: toolDef(
      'sandbox_v3_create_session',
      'Create and start a sandbox v3 session under a policy (builtin id, full policy JSON, or trust level). Returns the session id, tier, deadline and workspace. Needs approval: a session reserves a workspace and a lifetime budget.',
      {
        trust: { type: 'string', description: 'Trust level: trusted | standard | untrusted | hostile (default standard).' },
        policyId: { type: 'string', description: 'Built-in policy id (default: builtin for the trust level).' },
        policyJson: { type: 'string', description: 'Full policy JSON (alternative to policyId).' },
        tier: { type: 'string', description: 'Requested tier: bwrap | syscall-policy | microvm (optional, never below the policy minimum).' },
        lifetimeMs: { type: 'number', description: 'Requested lifetime in ms (clamped by the policy max).' },
      },
      [],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const trust = getTrustArg(args);
        const policy = resolvePolicyArg(args, trust);
        const tier = getTierArg(args);
        const lifetimeMs = getNumberArg(args, 'lifetimeMs');
        const session = runner.createSession({
          policy,
          ...(tier !== undefined ? { tier } : {}),
          ...(lifetimeMs !== undefined ? { lifetimeMs } : {}),
        });
        return JSON.stringify({ session }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const listSessionsTool: Tool = {
    definition: toolDef(
      'sandbox_v3_list_sessions',
      'List sandbox v3 sessions (live and finished) with state, tier, steps, blocked events and egress usage. Read-only.',
      {
        state: { type: 'string', description: 'Filter by state: created | running | paused | stopped | expired (optional).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const state = getStringArg(args, 'state');
        if (state !== '' && !['created', 'running', 'paused', 'stopped', 'expired'].includes(state)) {
          throw new Error(`state must be created | running | paused | stopped | expired, got "${state}"`);
        }
        const sessions = state === ''
          ? runner.listSessions()
          : runner.listSessionsByState(state as 'created' | 'running' | 'paused' | 'stopped' | 'expired');
        return JSON.stringify({ sessions }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const runCommandTool: Tool = {
    definition: toolDef(
      'sandbox_v3_run_command',
      'Run a shell command inside a sandbox v3 session. The command must be on the policy command list, the shell must be enabled, and the session must be running (not paused, not expired). Returns the step record. Needs approval.',
      {
        sessionId: { type: 'string', description: 'Session id returned by sandbox_v3_create_session.' },
        command: { type: 'string', description: 'Shell command to run (e.g. "ls -la").' },
        cwd: { type: 'string', description: 'Working directory inside the session workspace, relative (optional).' },
        timeoutMs: { type: 'number', description: 'Timeout in ms (default 30000).' },
        syscalls: { type: 'array', items: { type: 'string' }, description: 'Syscalls the command declares (checked against the allowlist first).' },
        egressUrls: { type: 'array', items: { type: 'string' }, description: 'URLs the command declares it will reach (checked against the egress gate first).' },
      },
      ['sessionId', 'command'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const sessionId = getStringArg(args, 'sessionId', true);
        const command = getStringArg(args, 'command', true);
        const cwd = getStringArg(args, 'cwd');
        const timeoutMs = getNumberArg(args, 'timeoutMs');
        const syscalls = getStringArrayArg(args, 'syscalls');
        const egress: SandboxV3EgressRequest[] = getStringArrayArg(args, 'egressUrls').map((url) => ({ url }));
        const step = await runner.runCommand(sessionId, command, {
          ...(cwd !== '' ? { cwd } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          syscalls,
          egress,
        });
        return JSON.stringify({ step }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const runStepTool: Tool = {
    definition: toolDef(
      'sandbox_v3_run_step',
      'Run one gated tool step inside a sandbox v3 session: PreToolUse hooks, syscall allowlist and egress gate all run first; a denied step never executes. The step executor echoes the gated call (gates-only record) unless the host wired a real executor. Needs approval.',
      {
        sessionId: { type: 'string', description: 'Session id returned by sandbox_v3_create_session.' },
        tool: { type: 'string', description: 'Tool name to run (e.g. "read_file").' },
        toolCallId: { type: 'string', description: 'Agent-side tool call id (optional).' },
        args: { type: 'object', description: 'Arguments for the tool call (optional).' },
        syscalls: { type: 'array', items: { type: 'string' }, description: 'Syscalls the step declares (checked against the allowlist first).' },
        egressUrls: { type: 'array', items: { type: 'string' }, description: 'URLs the step declares it will reach (checked against the egress gate first).' },
      },
      ['sessionId', 'tool'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const sessionId = getStringArg(args, 'sessionId', true);
        const tool = getStringArg(args, 'tool', true);
        const toolCallId = getStringArg(args, 'toolCallId');
        const callArgs = getObjectArg(args, 'args');
        const syscalls = getStringArrayArg(args, 'syscalls');
        const egress: SandboxV3EgressRequest[] = getStringArrayArg(args, 'egressUrls').map((url) => ({ url }));
        const step = await runner.runStep(
          sessionId,
          { tool, args: callArgs, ...(toolCallId !== '' ? { toolCallId } : {}) },
          {
            syscalls,
            egress,
            executor: async (call) => ({
              output: JSON.stringify({ gated: true, tool: call.tool, args: call.args }),
              exitCode: 0,
            }),
          },
        );
        return JSON.stringify({ step }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const reportTool: Tool = {
    definition: toolDef(
      'sandbox_v3_report',
      'Full deep-sandbox report for a session: state, lifetime, egress, syscalls, hooks, snapshots, steps and blocked events, as JSON plus Markdown. Read-only.',
      {
        sessionId: { type: 'string', description: 'Session id returned by sandbox_v3_create_session.' },
        format: { type: 'string', description: 'Output format: json (default) or markdown.' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const sessionId = getStringArg(args, 'sessionId', true);
        const format = getStringArg(args, 'format');
        const report = runner.getReport(sessionId);
        if (!report) return errorResult(`Unknown sandbox v3 session "${sessionId}"`);
        if (format === 'markdown') return renderSandboxV3ReportMarkdown(report);
        return JSON.stringify(
          { summary: summarizeSandboxV3Report(report), report },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const pauseTool: Tool = {
    definition: toolDef(
      'sandbox_v3_pause',
      'Freeze a running sandbox v3 session. No step runs while paused; the idle clock freezes but the lifetime deadline keeps ticking. Returns false when the session cannot pause.',
      {
        sessionId: { type: 'string', description: 'Session id returned by sandbox_v3_create_session.' },
        reason: { type: 'string', description: 'Why the session is being paused (recorded on the report).' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const sessionId = getStringArg(args, 'sessionId', true);
        const reason = getStringArg(args, 'reason');
        const paused = runner.pauseSession(sessionId, reason);
        const session = runner.getSession(sessionId);
        return JSON.stringify({ sessionId, paused, session }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const resumeTool: Tool = {
    definition: toolDef(
      'sandbox_v3_resume',
      'Resume a paused sandbox v3 session. Returns false when the session is not paused.',
      {
        sessionId: { type: 'string', description: 'Session id returned by sandbox_v3_create_session.' },
        reason: { type: 'string', description: 'Why the session is being resumed (recorded on the report).' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const sessionId = getStringArg(args, 'sessionId', true);
        const reason = getStringArg(args, 'reason');
        const resumed = runner.resumeSession(sessionId, reason);
        const session = runner.getSession(sessionId);
        return JSON.stringify({ sessionId, resumed, session }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const stopTool: Tool = {
    definition: toolDef(
      'sandbox_v3_stop',
      'Stop a sandbox v3 session for good (terminal — it can never run again). The workspace is kept on disk until the host deletes the session. Needs approval.',
      {
        sessionId: { type: 'string', description: 'Session id returned by sandbox_v3_create_session.' },
        reason: { type: 'string', description: 'Why the session is being stopped (recorded on the report).' },
      },
      ['sessionId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const sessionId = getStringArg(args, 'sessionId', true);
        const reason = getStringArg(args, 'reason');
        const stopped = runner.stopSession(sessionId, reason);
        const session = runner.getSession(sessionId);
        return JSON.stringify({ sessionId, stopped, session }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const snapshotTool: Tool = {
    definition: toolDef(
      'sandbox_v3_snapshot',
      'Take a copy-on-write snapshot of a session workspace (files hashed + copied, deletions tombstoned). The base workspace is never mutated by a capture. Returns the snapshot id, label, file count and bytes.',
      {
        sessionId: { type: 'string', description: 'Session id returned by sandbox_v3_create_session.' },
        label: { type: 'string', description: 'Human label, e.g. "before-install".' },
      },
      ['sessionId', 'label'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const sessionId = getStringArg(args, 'sessionId', true);
        const label = getStringArg(args, 'label', true);
        const snapshot = runner.takeSnapshot(sessionId, label);
        return JSON.stringify({ snapshot }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const snapshotRestoreTool: Tool = {
    definition: toolDef(
      'sandbox_v3_snapshot_restore',
      'Restore a copy-on-write snapshot into the session workspace (manifest verified first; files the snapshot never saw are deleted). Returns restored/deleted file counts. Needs approval: restore overwrites workspace files.',
      {
        sessionId: { type: 'string', description: 'Session id returned by sandbox_v3_create_session.' },
        snapshotId: { type: 'string', description: 'Snapshot id returned by sandbox_v3_snapshot.' },
      },
      ['sessionId', 'snapshotId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const sessionId = getStringArg(args, 'sessionId', true);
        const snapshotId = getStringArg(args, 'snapshotId', true);
        const result = runner.restoreSnapshot(sessionId, snapshotId);
        return JSON.stringify({ result }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const egressCheckTool: Tool = {
    definition: toolDef(
      'sandbox_v3_egress_check',
      'Check one URL against a session\'s egress gate (or a standalone egress policy JSON) without sending any request. Returns allow/deny plus the reason. Read-only.',
      {
        sessionId: { type: 'string', description: 'Session id (uses the session gate).' },
        egressPolicyJson: { type: 'string', description: 'Standalone egress policy JSON (alternative to sessionId).' },
        url: { type: 'string', description: 'URL to check.' },
        method: { type: 'string', description: 'HTTP method (default GET).' },
        expectedBytes: { type: 'number', description: 'Expected response size in bytes (0 when unknown).' },
      },
      ['url'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const url = getStringArg(args, 'url', true);
        const method = getStringArg(args, 'method');
        const expectedBytes = getNumberArg(args, 'expectedBytes', 0) ?? 0;
        const sessionId = getStringArg(args, 'sessionId');
        const egressPolicyJson = getStringArg(args, 'egressPolicyJson');
        if (sessionId !== '') {
          const check = runner.checkEgress(sessionId, {
            url,
            ...(method !== '' ? { method } : {}),
            expectedBytes,
          });
          return JSON.stringify({ check }, null, 2);
        }
        if (egressPolicyJson !== '') {
          const policy = parseEgressPolicy(egressPolicyJson);
          const gate = new SandboxV3EgressGate({ policy });
          const check = gate.check({ url, ...(method !== '' ? { method } : {}), expectedBytes });
          return JSON.stringify({ check }, null, 2);
        }
        return errorResult('Provide sessionId or egressPolicyJson');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const syscallCheckTool: Tool = {
    definition: toolDef(
      'sandbox_v3_syscall_check',
      'Check syscalls against a session\'s allowlist (or a standalone mode) without running anything. Returns one verdict per syscall. Read-only.',
      {
        sessionId: { type: 'string', description: 'Session id (uses the session allowlist).' },
        syscallMode: { type: 'string', description: 'Standalone mode: strict | standard | permissive (alternative to sessionId).' },
        syscalls: { type: 'array', items: { type: 'string' }, description: 'Syscall names to check.' },
      },
      ['syscalls'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const syscalls = getStringArrayArg(args, 'syscalls');
        if (syscalls.length === 0) throw new Error('syscalls must not be empty');
        const sessionId = getStringArg(args, 'sessionId');
        if (sessionId !== '') {
          const checks = syscalls.map((name) => runner.checkSyscall(sessionId, name));
          return JSON.stringify({ checks }, null, 2);
        }
        const mode = getSyscallModeArg(args) ?? 'standard';
        const engine = new SyscallAllowlist({ mode });
        const checks = engine.checkBatch(syscalls);
        return JSON.stringify({ mode, checks }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const hookRegisterTool: Tool = {
    definition: toolDef(
      'sandbox_v3_hook_register',
      'Register a PreToolUse / PostToolUse hook on a live sandbox v3 session. A hook may allow, deny or modify matching tool calls (pre) or results (post). Policy hooks can never be removed by this tool. Needs approval.',
      {
        sessionId: { type: 'string', description: 'Session id returned by sandbox_v3_create_session.' },
        name: { type: 'string', description: 'Hook name, e.g. "block-shell-in-sandbox".' },
        timing: { type: 'string', description: 'When the hook runs: pre | post.' },
        toolPattern: { type: 'string', description: 'Tool name glob, e.g. "shell_*" or "*" (optional).' },
        argKey: { type: 'string', description: 'Only match calls that carry this argument key (optional).' },
        decision: { type: 'string', description: 'What the hook decides: allow | deny | modify.' },
        modifyArgs: { type: 'object', description: 'Replacement arguments for a modify hook (required when decision is modify).' },
        message: { type: 'string', description: 'Message shown when the hook denies or modifies (optional).' },
        priority: { type: 'number', description: 'Priority — lower runs first (default 100).' },
      },
      ['sessionId', 'name', 'timing', 'decision'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const sessionId = getStringArg(args, 'sessionId', true);
        const name = getStringArg(args, 'name', true);
        const timing = getStringArg(args, 'timing', true);
        const decision = getStringArg(args, 'decision', true);
        if (timing !== 'pre' && timing !== 'post') {
          throw new Error(`timing must be pre | post, got "${timing}"`);
        }
        if (decision !== 'allow' && decision !== 'deny' && decision !== 'modify') {
          throw new Error(`decision must be allow | deny | modify, got "${decision}"`);
        }
        const toolPattern = getStringArg(args, 'toolPattern');
        const argKey = getStringArg(args, 'argKey');
        const message = getStringArg(args, 'message');
        const priority = getNumberArg(args, 'priority');
        const modifyArgs = getObjectArg(args, 'modifyArgs');
        const hookId = runner.registerHook(sessionId, {
          name,
          timing: timing as 'pre' | 'post',
          ...((toolPattern !== '' || argKey !== '') ? {
            matcher: {
              ...(toolPattern !== '' ? { toolPattern } : {}),
              ...(argKey !== '' ? { argKey } : {}),
            },
          } : {}),
          decision: decision as 'allow' | 'deny' | 'modify',
          ...(decision === 'modify' ? { modifyArgs } : {}),
          ...(message !== '' ? { message } : {}),
          ...(priority !== undefined ? { priority } : {}),
        });
        return JSON.stringify({ sessionId, hookId, name, timing, decision }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    listPoliciesTool,
    validatePolicyTool,
    createSessionTool,
    listSessionsTool,
    runCommandTool,
    runStepTool,
    reportTool,
    pauseTool,
    resumeTool,
    stopTool,
    snapshotTool,
    snapshotRestoreTool,
    egressCheckTool,
    syscallCheckTool,
    hookRegisterTool,
  ];
}

/** Default (unbound) tools, for the global tool list. */
export const SANDBOX_V3_TOOLS: Tool[] = createSandboxV3Tools();

// Re-exported for tests / host wiring convenience.
export { SandboxV3Runner };
export type { SandboxV3Policy };
