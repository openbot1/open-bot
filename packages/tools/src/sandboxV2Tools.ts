/**
 * Sandbox v2 tools (v1.34, Đội T2).
 *
 * 9 tools, bound through `createSandboxV2Tools(getBaseDir, opts)`:
 *
 *  - sandbox_v2_list_policies   — list built-in policies (id, trust, tier, caps).
 *  - sandbox_v2_policy_validate — validate a policy JSON document (read-only).
 *  - sandbox_v2_select_tier     — pick the tier for (trust, policy, requested) on this host.
 *  - sandbox_v2_run             — run a command in sandbox v2 (needs approval).
 *  - sandbox_v2_report          — full isolation report for a finished run.
 *  - sandbox_v2_token_issue     — issue a scoped short-lived token for a task.
 *  - sandbox_v2_token_revoke    — revoke a token by id.
 *  - sandbox_v2_microvm_dryrun  — dry-run a microVM spec (feasibility, no boot).
 *  - sandbox_v2_kill            — trip the kill switch of a live run.
 *
 * SAFETY: `sandbox_v2_run` is needsApproval; the runner enforces the
 * policy before executing anything, issues tokens only after the
 * policy check passed, and always returns a run report. Token
 * secrets are returned once at issue time and are never written to
 * a report or a log by this module.
 */

import type { Tool } from '@open-bot/core';
import {
  BUILTIN_SANDBOX_V2_POLICIES,
  SANDBOX_V2_TIER_LEVELS,
  SandboxV2RunReportBuilder,
  SandboxV2Runner,
  TokenBroker,
  builtinPolicyForTrust,
  defaultMicroVmSpec,
  describeHostCapabilities,
  dryRunMicroVm,
  getBuiltinSandboxV2Policy,
  parseSandboxV2Policy,
  probeHostCapabilities,
  renderSandboxV2ReportMarkdown,
  selectSandboxV2Tier,
  summarizeSandboxV2Report,
  validateSandboxV2Policy,
  validateMicroVmSpec,
  type SandboxV2Policy,
  type SandboxV2Tier,
  type SandboxV2TrustLevel,
} from '@open-bot/core';

export const SANDBOX_V2_TOOL_NAMES = [
  'sandbox_v2_list_policies',
  'sandbox_v2_policy_validate',
  'sandbox_v2_select_tier',
  'sandbox_v2_run',
  'sandbox_v2_report',
  'sandbox_v2_token_issue',
  'sandbox_v2_token_revoke',
  'sandbox_v2_microvm_dryrun',
  'sandbox_v2_kill',
] as const;

export function isSandboxV2ToolName(name: string): boolean {
  return (SANDBOX_V2_TOOL_NAMES as readonly string[]).includes(name);
}

export interface SandboxV2ToolOptions {
  /** Base dir for per-run workspaces (default: os.tmpdir()/open-bot-sandbox-v2). */
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

function getBooleanArg(args: Record<string, unknown>, name: string, defaultValue = false): boolean {
  const value = args[name];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean, got ${typeof value}`);
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

function resolvePolicyArg(args: Record<string, unknown>, trust: SandboxV2TrustLevel): SandboxV2Policy {
  const policyJson = getStringArg(args, 'policyJson');
  if (policyJson !== '') return parseSandboxV2Policy(policyJson);
  const policyId = getStringArg(args, 'policyId');
  if (policyId !== '') {
    const builtin = getBuiltinSandboxV2Policy(policyId);
    if (!builtin) throw new Error(`Unknown sandbox v2 policy "${policyId}"`);
    return builtin;
  }
  return builtinPolicyForTrust(trust);
}

function policySummary(policy: SandboxV2Policy): Record<string, unknown> {
  return {
    id: policy.id,
    name: policy.name,
    description: policy.description,
    version: policy.version,
    trust: policy.trust,
    minTier: policy.minTier,
    minTierLevel: SANDBOX_V2_TIER_LEVELS[policy.minTier],
    networkEnabled: policy.network.enabled,
    networkHosts: policy.network.hosts,
    shellEnabled: policy.shellEnabled,
    commands: policy.commands,
    caps: policy.caps,
  };
}

/**
 * Create the sandbox v2 tools. The runner + broker are created once
 * per call and shared by the tools, so `sandbox_v2_kill` can trip a
 * run started by `sandbox_v2_run` in the same host process, and
 * `sandbox_v2_report` can read its report afterwards.
 */
export function createSandboxV2Tools(
  getBaseDir?: () => string | null | undefined,
  toolOptions: SandboxV2ToolOptions = {},
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

  const runner = new SandboxV2Runner({
    ...(resolveBase() !== undefined ? { baseDir: resolveBase() as string } : {}),
  });
  // Token broker for standalone issue/revoke tools (bound to the
  // standard policy; the runner uses its own per-run broker).
  const broker = new TokenBroker({ policy: builtinPolicyForTrust('standard') });

  const listPoliciesTool: Tool = {
    definition: toolDef(
      'sandbox_v2_list_policies',
      'List the built-in sandbox v2 policies (strict / standard / trusted / untrusted) with trust level, minimum tier, network and caps. Read-only.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const policies = Object.values(BUILTIN_SANDBOX_V2_POLICIES).map(policySummary);
      return JSON.stringify({ policies }, null, 2);
    },
  };

  const validatePolicyTool: Tool = {
    definition: toolDef(
      'sandbox_v2_policy_validate',
      'Validate a sandbox v2 policy JSON document (policy-as-code). Returns valid true/false plus every problem and warning. An invalid policy must never be applied. Read-only.',
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
        const result = validateSandboxV2Policy(parsed);
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

  const selectTierTool: Tool = {
    definition: toolDef(
      'sandbox_v2_select_tier',
      'Pick the isolation tier for a run (trust level + policy + optional requested tier) on this host. Reports downgrades loudly and refuses hostile code when no tier-3 host exists. Read-only, runs nothing.',
      {
        trust: { type: 'string', description: 'Trust level: trusted | standard | untrusted | hostile (default standard).' },
        policyId: { type: 'string', description: 'Built-in policy id (default: builtin for the trust level).' },
        policyJson: { type: 'string', description: 'Full policy JSON (alternative to policyId).' },
        tier: { type: 'string', description: 'Requested tier: bwrap | syscall-policy | microvm (optional).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const trust = getTrustArg(args);
        const policy = resolvePolicyArg(args, trust);
        const requestedTier = getTierArg(args);
        const host = probeHostCapabilities();
        try {
          const decision = selectSandboxV2Tier({ trust, policy, requestedTier, host });
          return JSON.stringify(
            {
              tier: decision.tier,
              level: decision.level,
              reason: decision.reason,
              downgraded: decision.downgraded,
              ...(decision.requestedTier !== undefined ? { requestedTier: decision.requestedTier } : {}),
              trust: decision.trust,
              host: describeHostCapabilities(host),
            },
            null,
            2,
          );
        } catch (err) {
          return JSON.stringify(
            { refused: true, reason: (err as Error).message, host: describeHostCapabilities(host) },
            null,
            2,
          );
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const runTool: Tool = {
    definition: toolDef(
      'sandbox_v2_run',
      'Run a command inside sandbox v2 (tier selected from trust + policy, policy enforced before execution, token issued only after the policy check, kill switch + lifetime cap armed). Always returns a run report summary with the run id. Needs approval.',
      {
        command: { type: 'string', description: 'Command to run (must be allow-listed by the policy).' },
        args: { type: 'array', description: 'Command arguments.', items: { type: 'string' } },
        trust: { type: 'string', description: 'Trust level: trusted | standard | untrusted | hostile (default standard).' },
        policyId: { type: 'string', description: 'Built-in policy id (default: builtin for the trust level).' },
        policyJson: { type: 'string', description: 'Full policy JSON (alternative to policyId).' },
        tier: { type: 'string', description: 'Requested tier: bwrap | syscall-policy | microvm (optional; microvm is dry-run only).' },
        scopes: { type: 'array', description: 'Downstream scopes the run needs (a short-lived token is issued per scope set).', items: { type: 'string' } },
        tokenTtlMs: { type: 'number', description: 'Token TTL in ms (default: policy cap, broker-capped).' },
        maxLifetimeMs: { type: 'number', description: 'Max run lifetime in ms (default: policy cap; never above it).' },
        label: { type: 'string', description: 'Display label for the run report.' },
        dryRun: { type: 'boolean', description: 'Validate + select tier + report, do not execute (default false).' },
      },
      ['command'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const command = getStringArg(args, 'command', true);
        const cmdArgs = getStringArrayArg(args, 'args');
        const trust = getTrustArg(args);
        const policy = resolvePolicyArg(args, trust);
        const requestedTier = getTierArg(args);
        const scopes = getStringArrayArg(args, 'scopes');
        const tokenTtlMs = getNumberArg(args, 'tokenTtlMs');
        const maxLifetimeMs = getNumberArg(args, 'maxLifetimeMs');
        const label = getStringArg(args, 'label');
        const dryRun = getBooleanArg(args, 'dryRun', false);
        const report = await runner.run({
          command,
          args: cmdArgs,
          trust,
          policy,
          ...(requestedTier !== undefined ? { requestedTier } : {}),
          ...(scopes.length > 0 ? { scopes } : {}),
          ...(tokenTtlMs !== undefined ? { tokenTtlMs } : {}),
          ...(maxLifetimeMs !== undefined ? { caps: { maxLifetimeMs } } : {}),
          ...(label !== '' ? { label } : {}),
          ...(dryRun ? { dryRun: true } : {}),
        });
        return JSON.stringify(
          {
            runId: report.runId,
            summary: summarizeSandboxV2Report(report),
            tier: report.tier,
            policy: `${report.policyId} v${report.policyVersion}`,
            endReason: report.endReason,
            ...(report.endDetail !== undefined ? { endDetail: report.endDetail } : {}),
            durationMs: report.durationMs,
            exitCode: report.exitCode,
            blocked: report.blockedCounts,
            tokensIssued: report.tokensIssued,
            tokensRevoked: report.tokensRevoked,
            isolated: report.isolated,
            stdout: report.stdout.slice(0, 5000),
            stderr: report.stderr.slice(0, 5000),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const reportTool: Tool = {
    definition: toolDef(
      'sandbox_v2_report',
      'Get the full isolation report for a finished sandbox v2 run (tier, policy, blocked syscalls/files/network, tokens issued/revoked, lifetime, kill switch, end reason) as Markdown. Read-only.',
      {
        runId: { type: 'string', description: 'Run id returned by sandbox_v2_run.' },
      },
      ['runId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const runId = getStringArg(args, 'runId', true);
        const report = runner.getReport(runId);
        if (!report) return errorResult(`No sandbox v2 report for run "${runId}".`);
        return renderSandboxV2ReportMarkdown(report);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const tokenIssueTool: Tool = {
    definition: toolDef(
      'sandbox_v2_token_issue',
      'Issue a scoped, short-lived token for one task (token broker). The secret is returned ONCE here and never logged — pass it to the downstream call, then forget it. The token is bound to the task id and expires automatically.',
      {
        taskId: { type: 'string', description: 'Task id the token is bound to.' },
        scopes: { type: 'array', description: 'Downstream scopes (e.g. github:read, npm:fetch).', items: { type: 'string' } },
        ttlMs: { type: 'number', description: 'TTL in ms (default 900000, capped by policy + broker ceiling).' },
      },
      ['taskId', 'scopes'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const taskId = getStringArg(args, 'taskId', true);
        const scopes = getStringArrayArg(args, 'scopes');
        const ttlMs = getNumberArg(args, 'ttlMs');
        const issued = broker.issue(taskId, scopes, ttlMs ?? 900_000);
        return JSON.stringify(
          {
            tokenId: issued.token.id,
            secret: issued.secret,
            taskId: issued.token.taskId,
            scopes: issued.token.scopes,
            issuedAt: issued.token.issuedAt,
            expiresAt: issued.token.expiresAt,
            warning: 'Secret shown once — it is never stored or logged. A downstream call without a live token is denied.',
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const tokenRevokeTool: Tool = {
    definition: toolDef(
      'sandbox_v2_token_revoke',
      'Revoke a sandbox v2 token by id (manual revoke). A revoked token never validates again. Read-only on anything except the token itself.',
      {
        tokenId: { type: 'string', description: 'Token id to revoke.' },
      },
      ['tokenId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const tokenId = getStringArg(args, 'tokenId', true);
        const revoked = broker.revoke(tokenId, 'manual');
        return JSON.stringify({ tokenId, revoked }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const microvmDryrunTool: Tool = {
    definition: toolDef(
      'sandbox_v2_microvm_dryrun',
      'Dry-run a Firecracker-style microVM spec: validate it and report whether it could boot on this host (KVM, kernel/rootfs present, sizing), with blockers, warnings and boot estimates. NEVER boots a VM. Read-only.',
      {
        kernelPath: { type: 'string', description: 'Guest kernel image path on the host.' },
        rootfsPath: { type: 'string', description: 'Guest rootfs image path on the host.' },
        vcpuCount: { type: 'number', description: 'vCPU count 1–32 (default 1).' },
        memoryMiB: { type: 'number', description: 'Guest RAM in MiB 128–32768 (default 512).' },
        snapshotId: { type: 'string', description: 'Snapshot id to resume from (optional).' },
        networkHosts: { type: 'array', description: 'Allow-listed network hosts for the guest (default: none).', items: { type: 'string' } },
      },
      ['kernelPath', 'rootfsPath'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const kernelPath = getStringArg(args, 'kernelPath', true);
        const rootfsPath = getStringArg(args, 'rootfsPath', true);
        const vcpuCount = getNumberArg(args, 'vcpuCount', 1) ?? 1;
        const memoryMiB = getNumberArg(args, 'memoryMiB', 512) ?? 512;
        const snapshotId = getStringArg(args, 'snapshotId');
        const networkHosts = getStringArrayArg(args, 'networkHosts');
        const spec = defaultMicroVmSpec({
          kernelPath,
          rootfsPath,
          vcpuCount,
          memoryMiB,
          ...(snapshotId !== '' ? { snapshotId } : {}),
          networkHosts,
        });
        const validation = validateMicroVmSpec(spec);
        if (!validation.valid) {
          return JSON.stringify({ valid: false, problems: validation.problems, warnings: validation.warnings }, null, 2);
        }
        const host = probeHostCapabilities();
        const feasibility = dryRunMicroVm(spec, host);
        return JSON.stringify(
          { valid: true, warnings: validation.warnings, feasible: feasibility.feasible, estimatedBootMs: feasibility.estimatedBootMs, ...(feasibility.estimatedResumeMs !== undefined ? { estimatedResumeMs: feasibility.estimatedResumeMs } : {}), blockers: feasibility.blockers, feasibilityWarnings: feasibility.warnings, host: feasibility.host },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const killTool: Tool = {
    definition: toolDef(
      'sandbox_v2_kill',
      'Trip the kill switch of a live sandbox v2 run (from the UI or an operator). The run is killed immediately, tokens are revoked and the workspace is cleaned up. Returns false when the run already finished.',
      {
        runId: { type: 'string', description: 'Run id returned by sandbox_v2_run.' },
        reason: { type: 'string', description: 'Why the run is being killed (recorded on the report).' },
      },
      ['runId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const runId = getStringArg(args, 'runId', true);
        const reason = getStringArg(args, 'reason');
        const killed = runner.killRun(runId, 'ui', reason !== '' ? reason : undefined);
        const report = runner.getReport(runId);
        return JSON.stringify(
          {
            runId,
            killed,
            liveRuns: runner.listLiveRuns(),
            ...(report ? { summary: summarizeSandboxV2Report(report) } : {}),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    listPoliciesTool,
    validatePolicyTool,
    selectTierTool,
    runTool,
    reportTool,
    tokenIssueTool,
    tokenRevokeTool,
    microvmDryrunTool,
    killTool,
  ];
}

/** Default (unbound) tools, for the global tool list. */
export const SANDBOX_V2_TOOLS: Tool[] = createSandboxV2Tools();

// Re-exported for tests / host wiring convenience.
export { SandboxV2RunReportBuilder };
export type { SandboxV2Policy };
