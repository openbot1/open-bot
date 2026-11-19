/**
 * Sandbox v5 tools (v1.37, Team T3).
 *
 * 22 tools, bound through `createSandboxV5Tools(getBaseDir, opts)`:
 *
 *  - sandbox_v5_tier_list      — list runtime tiers + availability (read-only).
 *  - sandbox_v5_choice_set     — set a bot's runtime tier + profile (needs approval).
 *  - sandbox_v5_choice_get     — a bot's stored runtime choice (read-only).
 *  - sandbox_v5_choice_list    — all stored runtime choices (read-only).
 *  - sandbox_v5_runtime_register — register a runtime for a bot (applies its choice).
 *  - sandbox_v5_runtime_list   — list bot runtimes with state + idle time (read-only).
 *  - sandbox_v5_runtime_stop   — stop a bot runtime.
 *  - sandbox_v5_switch_plan    — dry-run plan for a tier switch (read-only).
 *  - sandbox_v5_switch         — run a safe tier switch (needs approval).
 *  - sandbox_v5_archive_scan   — idle runtimes that could be archived (read-only).
 *  - sandbox_v5_archive_create — archive a stopped runtime (needs approval).
 *  - sandbox_v5_archive_list   — list archives (read-only).
 *  - sandbox_v5_archive_restore — restore an archive into a fresh runtime (needs approval).
 *  - sandbox_v5_archive_delete — delete an archive permanently (needs approval).
 *  - sandbox_v5_disk_status    — disk usage vs budget (read-only).
 *  - sandbox_v5_disk_reclaim   — dry-run or execute a cache/gitignored reclaim (needs approval to execute).
 *  - sandbox_v5_secret_grant   — grant a secret to one (bot, run, profile) (needs approval).
 *  - sandbox_v5_secret_consume — consume a grant (scope-checked; value returned ONLY here).
 *  - sandbox_v5_secret_list    — list grants, metadata only (read-only).
 *  - sandbox_v5_secret_revoke  — revoke one grant.
 *  - sandbox_v5_secret_end_run — revoke every grant of a run (run end).
 *  - sandbox_v5_secret_audit   — secret audit log + chain verification (read-only).
 *
 * SAFETY: `choice_set` / `switch` / `archive_create` /
 * `archive_restore` / `archive_delete` / `disk_reclaim`
 * (execute) / `secret_grant` are needsApproval. Secret values
 * passed to `secret_grant` / returned by `secret_consume`
 * are NEVER echoed back in any other result, never written to
 * any log by this module — the value travels in the call, and
 * only the user-typed modal input should ever fill it. HOST
 * WARNING: the host that executes these tools must not persist
 * tool-call arguments for `sandbox_v5_secret_grant` and must
 * not persist results of `sandbox_v5_secret_consume`.
 */

import type { Tool } from '@open-bot/core';
import {
  SandboxV5Service,
  renderSandboxV5ArchivesMarkdown,
  renderSandboxV5ChoiceMarkdown,
  renderSandboxV5DiskStatusMarkdown,
  renderSandboxV5IdleCandidatesMarkdown,
  renderSandboxV5ReclaimPlanMarkdown,
  renderSandboxV5ReclaimResultMarkdown,
  renderSandboxV5RuntimesMarkdown,
  renderSandboxV5SecretAuditMarkdown,
  renderSandboxV5SecretGrantsMarkdown,
  renderSandboxV5SwitchPlanMarkdown,
  renderSandboxV5SwitchResultMarkdown,
  renderSandboxV5TierTable,
  type SandboxV5Tier,
  type SandboxV5TrustLevel,
} from '@open-bot/core';

export const SANDBOX_V5_TOOL_NAMES = [
  'sandbox_v5_tier_list',
  'sandbox_v5_choice_set',
  'sandbox_v5_choice_get',
  'sandbox_v5_choice_list',
  'sandbox_v5_runtime_register',
  'sandbox_v5_runtime_list',
  'sandbox_v5_runtime_stop',
  'sandbox_v5_switch_plan',
  'sandbox_v5_switch',
  'sandbox_v5_archive_scan',
  'sandbox_v5_archive_create',
  'sandbox_v5_archive_list',
  'sandbox_v5_archive_restore',
  'sandbox_v5_archive_delete',
  'sandbox_v5_disk_status',
  'sandbox_v5_disk_reclaim',
  'sandbox_v5_secret_grant',
  'sandbox_v5_secret_consume',
  'sandbox_v5_secret_list',
  'sandbox_v5_secret_revoke',
  'sandbox_v5_secret_end_run',
  'sandbox_v5_secret_audit',
] as const;

export function isSandboxV5ToolName(name: string): boolean {
  return (SANDBOX_V5_TOOL_NAMES as readonly string[]).includes(name);
}

export interface SandboxV5ToolOptions {
  /** Base dir for v5 state (default: OS temp dir / open-bot-sandbox-v5). */
  baseDir?: string;
  /** Disk budget override (bytes). */
  diskBudgetBytes?: number;
  /** Disk headroom override (bytes). */
  diskHeadroomBytes?: number;
  /** Cache roots the reclaimer may clean. */
  cacheRoots?: Array<{ path: string; kind: string; policy?: 'oldest-first' | 'least-used-first' | 'largest-first' }>;
  /** Workspace roots scanned for gitignored dirs. */
  workspaceRoots?: string[];
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
  if (typeof value !== 'boolean') throw new Error(`Argument "${name}" must be a boolean`);
  return value;
}

function getTierArg(args: Record<string, unknown>, required = false): SandboxV5Tier | '' {
  const tier = getStringArg(args, 'tier', required);
  if (tier === '') return '';
  const allowed = ['local', 'bwrap', 'syscall-policy', 'microvm', 'vm'];
  if (!allowed.includes(tier)) {
    throw new Error(`tier must be one of ${allowed.join(', ')}, got "${tier}"`);
  }
  return tier as SandboxV5Tier;
}

function getTrustArg(args: Record<string, unknown>): SandboxV5TrustLevel | '' {
  const trust = getStringArg(args, 'trust');
  if (trust === '') return '';
  const allowed = ['trusted', 'standard', 'untrusted', 'hostile'];
  if (!allowed.includes(trust)) {
    throw new Error(`trust must be one of ${allowed.join(', ')}, got "${trust}"`);
  }
  return trust as SandboxV5TrustLevel;
}

/**
 * Create the sandbox v5 tools. One service is created per call
 * and shared by the tools, so a choice set by
 * `sandbox_v5_choice_set` is visible to
 * `sandbox_v5_runtime_register` in the same host process.
 */
export function createSandboxV5Tools(
  getBaseDir?: () => string | null | undefined,
  toolOptions: SandboxV5ToolOptions = {},
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

  const service = new SandboxV5Service({
    ...(resolveBase() !== undefined ? { baseDir: resolveBase() as string } : {}),
    ...(toolOptions.diskBudgetBytes !== undefined || toolOptions.diskHeadroomBytes !== undefined
      ? {
          diskBudget: {
            ...(toolOptions.diskBudgetBytes !== undefined ? { totalBudgetBytes: toolOptions.diskBudgetBytes } : {}),
            ...(toolOptions.diskHeadroomBytes !== undefined ? { headroomBytes: toolOptions.diskHeadroomBytes } : {}),
            cacheRoots: (toolOptions.cacheRoots ?? []).map((root) => ({
              path: root.path,
              kind: root.kind,
              policy: root.policy ?? 'oldest-first',
            })),
            workspaceRoots: toolOptions.workspaceRoots ?? [],
          },
        }
      : {}),
  });

  const tierListTool: Tool = {
    definition: toolDef(
      'sandbox_v5_tier_list',
      'List sandbox v5 runtime tiers (local / bwrap / syscall-policy / microvm / vm) with what each isolates, what it costs, and which are available on this host. Read-only.',
      {
        format: { type: 'string', description: '"json" (default) or "markdown".' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const tiers = service.listTiers();
        const available = service.availableTiers();
        const format = getStringArg(args, 'format');
        if (format === 'markdown') return renderSandboxV5TierTable(tiers);
        return JSON.stringify({ tiers, available }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const choiceSetTool: Tool = {
    definition: toolDef(
      'sandbox_v5_choice_set',
      'Set a bot runtime choice: which isolation tier it runs on and which agent profile. The choice is stored per bot and survives restarts; a running runtime keeps its tier until a safe switch moves it. Refuses tiers too weak for the bot trust or unavailable on this host. Needs approval: the bot isolation changes.',
      {
        botId: { type: 'string', description: 'Bot id.' },
        tier: { type: 'string', description: 'Tier: local | bwrap | syscall-policy | microvm | vm.' },
        profileId: { type: 'string', description: 'Agent profile id (optional, "" = none).' },
        trust: { type: 'string', description: 'Trust level: trusted | standard | untrusted | hostile (optional).' },
        maxWriteBytes: { type: 'number', description: 'Max write bytes per run (optional, 0 = box default).' },
        timeoutMs: { type: 'number', description: 'Timeout per run in ms (optional, 0 = box default).' },
        reason: { type: 'string', description: 'Why the choice is set (optional).' },
      },
      ['botId', 'tier'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const botId = getStringArg(args, 'botId', true);
        const tier = getTierArg(args, true) as SandboxV5Tier;
        const profileId = getStringArg(args, 'profileId');
        const trust = getTrustArg(args);
        const maxWriteBytes = getNumberArg(args, 'maxWriteBytes');
        const timeoutMs = getNumberArg(args, 'timeoutMs');
        const reason = getStringArg(args, 'reason');
        const limits: Record<string, number> = {};
        if (maxWriteBytes !== undefined) limits.maxWriteBytes = maxWriteBytes;
        if (timeoutMs !== undefined) limits.timeoutMs = timeoutMs;
        const choice = service.setChoice(botId, {
          tier,
          ...(profileId !== '' ? { profileId } : {}),
          ...(trust !== '' ? { trust } : {}),
          ...(Object.keys(limits).length > 0 ? { limits } : {}),
          ...(reason !== '' ? { reason } : {}),
        });
        return JSON.stringify({ choice }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const choiceGetTool: Tool = {
    definition: toolDef(
      'sandbox_v5_choice_get',
      'A bot stored runtime choice (tier, profile, trust, limits). Read-only.',
      {
        botId: { type: 'string', description: 'Bot id.' },
        format: { type: 'string', description: '"json" (default) or "markdown".' },
      },
      ['botId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const botId = getStringArg(args, 'botId', true);
        const choice = service.getChoice(botId);
        if (!choice) return errorResult(`Bot "${botId}" has no stored runtime choice yet.`);
        const format = getStringArg(args, 'format');
        if (format === 'markdown') return renderSandboxV5ChoiceMarkdown(choice);
        return JSON.stringify({ choice }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const choiceListTool: Tool = {
    definition: toolDef(
      'sandbox_v5_choice_list',
      'All stored per-bot runtime choices, sorted by bot id. Read-only.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      try {
        return JSON.stringify({ choices: service.listChoices() }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const runtimeRegisterTool: Tool = {
    definition: toolDef(
      'sandbox_v5_runtime_register',
      'Register a runtime for a bot: applies the bot stored choice (tier + profile) when tier/profile are not given. One live runtime per bot. The runtime starts in state "created" — start it with the host runner.',
      {
        botId: { type: 'string', description: 'Bot id.' },
        workdir: { type: 'string', description: 'Workspace directory for the runtime (absolute path).' },
        tier: { type: 'string', description: 'Tier override (optional; default: the bot stored choice).' },
        profileId: { type: 'string', description: 'Profile override (optional; default: the bot stored choice).' },
      },
      ['botId', 'workdir'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const botId = getStringArg(args, 'botId', true);
        const workdir = getStringArg(args, 'workdir', true);
        const tier = getTierArg(args);
        const profileId = getStringArg(args, 'profileId');
        const runtime = service.registerRuntime({
          botId,
          workdir,
          ...(tier !== '' ? { tier } : {}),
          ...(profileId !== '' ? { profileId } : {}),
        });
        return JSON.stringify({ runtime }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const runtimeListTool: Tool = {
    definition: toolDef(
      'sandbox_v5_runtime_list',
      'List bot runtimes with tier, profile, state, idle time, run and switch counts. Read-only.',
      {
        format: { type: 'string', description: '"json" (default) or "markdown".' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const runtimes = service.listRuntimes();
        const format = getStringArg(args, 'format');
        if (format === 'markdown') return renderSandboxV5RuntimesMarkdown(runtimes);
        return JSON.stringify({ runtimes }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const runtimeStopTool: Tool = {
    definition: toolDef(
      'sandbox_v5_runtime_stop',
      'Stop a bot runtime (running / paused / created → stopped). The workspace is kept until it is archived or destroyed.',
      {
        botId: { type: 'string', description: 'Bot id.' },
        reason: { type: 'string', description: 'Why the runtime is stopped (optional).' },
      },
      ['botId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const botId = getStringArg(args, 'botId', true);
        const reason = getStringArg(args, 'reason');
        const runtime = service.stopRuntime(botId, reason);
        return JSON.stringify({ runtime }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const switchPlanTool: Tool = {
    definition: toolDef(
      'sandbox_v5_switch_plan',
      'Dry-run plan for a tier switch: allowed / blocked / needs-drain, the steps it would run, and downgrade warnings. Nothing is changed. Read-only.',
      {
        botId: { type: 'string', description: 'Bot id.' },
        tier: { type: 'string', description: 'Target tier: local | bwrap | syscall-policy | microvm | vm.' },
        format: { type: 'string', description: '"json" (default) or "markdown".' },
      },
      ['botId', 'tier'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const botId = getStringArg(args, 'botId', true);
        const tier = getTierArg(args, true) as SandboxV5Tier;
        const plan = service.planSwitch(botId, tier);
        const format = getStringArg(args, 'format');
        if (format === 'markdown') return renderSandboxV5SwitchPlanMarkdown(plan);
        return JSON.stringify({ plan }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const switchTool: Tool = {
    definition: toolDef(
      'sandbox_v5_switch',
      'Run a safe tier switch for a bot: quiesce (drain in-flight runs) → snapshot state → stop old runtime → start new tier → restore state → verify. A failure after the old runtime stops rolls back to the old tier. A downgrade needs a reason. Needs approval: the bot isolation changes while it runs.',
      {
        botId: { type: 'string', description: 'Bot id.' },
        tier: { type: 'string', description: 'Target tier: local | bwrap | syscall-policy | microvm | vm.' },
        reason: { type: 'string', description: 'Why the switch happens (required for downgrades).' },
        drainTimeoutMs: { type: 'number', description: 'How long to wait for in-flight runs to drain, ms (default 30000).' },
        format: { type: 'string', description: '"json" (default) or "markdown".' },
      },
      ['botId', 'tier'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const botId = getStringArg(args, 'botId', true);
        const tier = getTierArg(args, true) as SandboxV5Tier;
        const reason = getStringArg(args, 'reason');
        const drainTimeoutMs = getNumberArg(args, 'drainTimeoutMs');
        const format = getStringArg(args, 'format');
        const result = await service.switchTier(botId, tier, {
          ...(reason !== '' ? { reason } : {}),
          ...(drainTimeoutMs !== undefined ? { drainTimeoutMs } : {}),
        });
        if (format === 'markdown') return renderSandboxV5SwitchResultMarkdown(result);
        return JSON.stringify({ result }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const archiveScanTool: Tool = {
    definition: toolDef(
      'sandbox_v5_archive_scan',
      'Scan bot runtimes for idle-archive candidates: stopped runtimes idle past the threshold can be archived. Read-only.',
      {
        idleThresholdMs: { type: 'number', description: 'Idle threshold in ms (optional; default: the disk budget idle threshold).' },
        format: { type: 'string', description: '"json" (default) or "markdown".' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const idleThresholdMs = getNumberArg(args, 'idleThresholdMs');
        const candidates = service.scanIdleRuntimes(idleThresholdMs);
        const format = getStringArg(args, 'format');
        if (format === 'markdown') return renderSandboxV5IdleCandidatesMarkdown(candidates);
        return JSON.stringify({ candidates }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const archiveCreateTool: Tool = {
    definition: toolDef(
      'sandbox_v5_archive_create',
      'Archive a stopped bot runtime: pack its workspace (tar.gz when tar exists, plain copy otherwise; secret-like files are excluded, never packed) and remove the live workspace. The archive can be restored later. Needs approval: the live workspace is removed.',
      {
        botId: { type: 'string', description: 'Bot id.' },
        idleThresholdMs: { type: 'number', description: 'Idle threshold that triggered the archive, ms.' },
        reason: { type: 'string', description: 'Why it is archived (optional).' },
      },
      ['botId', 'idleThresholdMs'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const botId = getStringArg(args, 'botId', true);
        const idleThresholdMs = getNumberArg(args, 'idleThresholdMs');
        if (idleThresholdMs === undefined) throw new Error('Missing required argument: "idleThresholdMs"');
        const reason = getStringArg(args, 'reason');
        const result = service.archiveRuntime(botId, {
          idleThresholdMs,
          ...(reason !== '' ? { reason } : {}),
        });
        return JSON.stringify({ archive: result.archive, liveRemoved: result.liveRemoved }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const archiveListTool: Tool = {
    definition: toolDef(
      'sandbox_v5_archive_list',
      'List runtime archives, newest first, with format, file count, size and state. Read-only.',
      {
        format: { type: 'string', description: '"json" (default) or "markdown".' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const archives = service.listArchives();
        const format = getStringArg(args, 'format');
        if (format === 'markdown') return renderSandboxV5ArchivesMarkdown(archives);
        return JSON.stringify({ archives }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const archiveRestoreTool: Tool = {
    definition: toolDef(
      'sandbox_v5_archive_restore',
      'Restore an archive into a fresh runtime: the payload hash is verified before unpacking (a tampered archive is refused), then a runtime is registered on the archive tier. Needs approval: a new runtime is created from stored files.',
      {
        archiveId: { type: 'string', description: 'Archive id.' },
        destWorkdir: { type: 'string', description: 'Destination workspace directory (absolute path, must not exist yet).' },
      },
      ['archiveId', 'destWorkdir'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const archiveId = getStringArg(args, 'archiveId', true);
        const destWorkdir = getStringArg(args, 'destWorkdir', true);
        const result = service.restoreArchive(archiveId, destWorkdir);
        return JSON.stringify({ result }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const archiveDeleteTool: Tool = {
    definition: toolDef(
      'sandbox_v5_archive_delete',
      'Delete a runtime archive permanently (metadata + payload). Needs approval: the archived workspace is gone for good.',
      {
        archiveId: { type: 'string', description: 'Archive id.' },
      },
      ['archiveId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const archiveId = getStringArg(args, 'archiveId', true);
        const deleted = service.deleteArchive(archiveId);
        return JSON.stringify({ archiveId, deleted }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const diskStatusTool: Tool = {
    definition: toolDef(
      'sandbox_v5_disk_status',
      'Disk usage of the sandbox tree vs its budget: total / cache / workspace / archive bytes, headroom, and whether it is over the usable budget. Read-only.',
      {
        format: { type: 'string', description: '"json" (default) or "markdown".' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const status = service.diskStatus();
        const format = getStringArg(args, 'format');
        if (format === 'markdown') return renderSandboxV5DiskStatusMarkdown(status);
        return JSON.stringify({ status }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const diskReclaimTool: Tool = {
    definition: toolDef(
      'sandbox_v5_disk_reclaim',
      'Reclaim disk space when the sandbox tree is over its usable budget: caches first (oldest / least-used first), then gitignored directories (node_modules, dist, …). With dryRun=true (default) it only returns the plan — nothing is deleted. With dryRun=false it executes the plan and logs every removal. Needs approval to execute.',
      {
        dryRun: { type: 'boolean', description: 'When true (default), only plan — delete nothing.' },
        includeWellKnownGitignored: { type: 'boolean', description: 'Also shed well-known gitignored dirs (node_modules, dist, …) even without a .gitignore match (default false).' },
        format: { type: 'string', description: '"json" (default) or "markdown".' },
      },
      [],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const dryRun = getBooleanArg(args, 'dryRun', true);
        const includeWellKnown = getBooleanArg(args, 'includeWellKnownGitignored', false);
        const format = getStringArg(args, 'format');
        const plan = service.planReclaim({ includeWellKnownGitignored: includeWellKnown });
        if (dryRun) {
          if (format === 'markdown') return renderSandboxV5ReclaimPlanMarkdown(plan);
          return JSON.stringify({ plan, dryRun: true }, null, 2);
        }
        const result = service.executeReclaim(plan);
        if (format === 'markdown') return renderSandboxV5ReclaimResultMarkdown(result);
        return JSON.stringify({ result, dryRun: false }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const secretGrantTool: Tool = {
    definition: toolDef(
      'sandbox_v5_secret_grant',
      'Grant a secret to exactly one (bot, run, profile) triple, with a TTL and a use budget (1 = single-use). The value lives in memory only and is NEVER returned in any result or written to any log. Needs approval: a credential is handed to a bot run. Hosts must not persist this tool call arguments.',
      {
        name: { type: 'string', description: 'Secret name, e.g. GITHUB_TOKEN (UPPER_CASE, never the value).' },
        value: { type: 'string', description: 'The secret value (typed by the user in the approval modal, never from chat).' },
        botId: { type: 'string', description: 'Bot the grant is scoped to.' },
        runId: { type: 'string', description: 'Run the grant is scoped to.' },
        profileId: { type: 'string', description: 'Profile the grant is scoped to.' },
        maxUses: { type: 'number', description: 'Max consumes (default 1 = single-use).' },
        ttlMs: { type: 'number', description: 'TTL in ms (default 0 = no expiry; still revoked at run end).' },
        purpose: { type: 'string', description: 'Why the run needs it (shown to the auditor).' },
      },
      ['name', 'value', 'botId', 'runId', 'profileId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const name = getStringArg(args, 'name', true);
        // The value is passed straight to the manager and never
        // touches this tool result, a log, or any other output.
        const value = getStringArg(args, 'value', true);
        const botId = getStringArg(args, 'botId', true);
        const runId = getStringArg(args, 'runId', true);
        const profileId = getStringArg(args, 'profileId', true);
        const maxUses = getNumberArg(args, 'maxUses');
        const ttlMs = getNumberArg(args, 'ttlMs');
        const purpose = getStringArg(args, 'purpose');
        const grant = service.grantSecret({
          name,
          value,
          botId,
          runId,
          profileId,
          ...(maxUses !== undefined ? { maxUses } : {}),
          ...(ttlMs !== undefined ? { ttlMs } : {}),
          ...(purpose !== '' ? { purpose } : {}),
        });
        return JSON.stringify({ grant }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const secretConsumeTool: Tool = {
    definition: toolDef(
      'sandbox_v5_secret_consume',
      'Consume a secret grant: the value is returned ONLY in this call result, and only when the caller scope matches the grant (bot, run, profile). A consume from any other scope is denied. When the use budget runs out the grant is consumed and the value is dropped. The caller must not log or persist the returned value.',
      {
        grantId: { type: 'string', description: 'Grant id.' },
        botId: { type: 'string', description: 'Bot consuming (must match the grant scope).' },
        runId: { type: 'string', description: 'Run consuming (must match the grant scope).' },
        profileId: { type: 'string', description: 'Profile consuming (must match the grant scope).' },
      },
      ['grantId', 'botId', 'runId', 'profileId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const grantId = getStringArg(args, 'grantId', true);
        const botId = getStringArg(args, 'botId', true);
        const runId = getStringArg(args, 'runId', true);
        const profileId = getStringArg(args, 'profileId', true);
        const result = service.consumeSecret(grantId, { botId, runId, profileId });
        return JSON.stringify({ result }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const secretListTool: Tool = {
    definition: toolDef(
      'sandbox_v5_secret_list',
      'List secret grants (metadata only: id, name, bot/run/profile scope, status, uses — never a value). Read-only.',
      {
        botId: { type: 'string', description: 'Filter by bot (optional).' },
        runId: { type: 'string', description: 'Filter by run (optional).' },
        profileId: { type: 'string', description: 'Filter by profile (optional).' },
        format: { type: 'string', description: '"json" (default) or "markdown".' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const botId = getStringArg(args, 'botId');
        const runId = getStringArg(args, 'runId');
        const profileId = getStringArg(args, 'profileId');
        const grants = service.listSecrets({
          ...(botId !== '' ? { botId } : {}),
          ...(runId !== '' ? { runId } : {}),
          ...(profileId !== '' ? { profileId } : {}),
        });
        const format = getStringArg(args, 'format');
        if (format === 'markdown') return renderSandboxV5SecretGrantsMarkdown(grants);
        return JSON.stringify({ grants }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const secretRevokeTool: Tool = {
    definition: toolDef(
      'sandbox_v5_secret_revoke',
      'Revoke one secret grant early (the value is dropped from memory immediately).',
      {
        grantId: { type: 'string', description: 'Grant id.' },
        reason: { type: 'string', description: 'Why it is revoked (optional).' },
      },
      ['grantId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const grantId = getStringArg(args, 'grantId', true);
        const reason = getStringArg(args, 'reason');
        const revoked = service.revokeSecret(grantId, 'user', reason);
        return JSON.stringify({ grantId, revoked }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const secretEndRunTool: Tool = {
    definition: toolDef(
      'sandbox_v5_secret_end_run',
      'End a run: revoke EVERY secret grant of that run. A finished run leaves no credential behind.',
      {
        botId: { type: 'string', description: 'Bot id.' },
        runId: { type: 'string', description: 'Run id.' },
      },
      ['botId', 'runId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const botId = getStringArg(args, 'botId', true);
        const runId = getStringArg(args, 'runId', true);
        const result = service.endRun(botId, runId, 'user');
        return JSON.stringify({ result }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const secretAuditTool: Tool = {
    definition: toolDef(
      'sandbox_v5_secret_audit',
      'Secret audit log (metadata only, hash-chained): every grant / consume / revoke / expiry, plus whether the chain verifies. Read-only.',
      {
        format: { type: 'string', description: '"json" (default) or "markdown".' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const entries = service.secretAuditLog();
        const problems = service.verifySecretAuditChain();
        const format = getStringArg(args, 'format');
        if (format === 'markdown') return renderSandboxV5SecretAuditMarkdown(entries);
        return JSON.stringify({ entries, chainOk: problems.length === 0, problems }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    tierListTool,
    choiceSetTool,
    choiceGetTool,
    choiceListTool,
    runtimeRegisterTool,
    runtimeListTool,
    runtimeStopTool,
    switchPlanTool,
    switchTool,
    archiveScanTool,
    archiveCreateTool,
    archiveListTool,
    archiveRestoreTool,
    archiveDeleteTool,
    diskStatusTool,
    diskReclaimTool,
    secretGrantTool,
    secretConsumeTool,
    secretListTool,
    secretRevokeTool,
    secretEndRunTool,
    secretAuditTool,
  ];
}

/** Default (unbound) tools, for the global tool list. */
export const SANDBOX_V5_TOOLS: Tool[] = createSandboxV5Tools();

// Re-exported for tests / host wiring convenience.
export { SandboxV5Service };
export type { SandboxV5Tier };
