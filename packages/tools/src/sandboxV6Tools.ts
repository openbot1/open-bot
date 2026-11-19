/**
 * Sandbox v6 tools (v1.38, Team T3).
 *
 * 22 tools, bound through `createSandboxV6Tools(getBaseDir, opts)`:
 *
 *  - sandbox_v6_runtime_create   — create + start a per-bot runtime (needs approval).
 *  - sandbox_v6_runtime_list     — list bot runtimes with state, quota, enforcement (read-only).
 *  - sandbox_v6_runtime_report   — full report: quota, live usage, disk, audit, secrets (read-only).
 *  - sandbox_v6_runtime_pause    — pause a runtime (refuses new execs).
 *  - sandbox_v6_runtime_resume   — resume a paused runtime.
 *  - sandbox_v6_runtime_stop     — stop a runtime (keeps box, cgroup, secrets).
 *  - sandbox_v6_runtime_destroy  — destroy a runtime: box + cgroup + secrets gone, audit kept (needs approval).
 *  - sandbox_v6_quota_get        — quota + live usage for a bot (read-only).
 *  - sandbox_v6_quota_set        — change a live bot's quota, admission-checked (needs approval).
 *  - sandbox_v6_quota_presets    — list quota presets + fair-share suggestion for N bots (read-only).
 *  - sandbox_v6_exec             — run a command in a bot's runtime, audited start-to-finish (needs approval).
 *  - sandbox_v6_usage            — live CPU/RAM/disk usage for a bot (read-only).
 *  - sandbox_v6_audit_query      — query a bot's exec audit log (read-only).
 *  - sandbox_v6_audit_summary    — audit counts + hash-chain verification for a bot (read-only).
 *  - sandbox_v6_audit_export     — export a bot's whole audit history, verified (read-only).
 *  - sandbox_v6_disk_reclaim     — plan/apply disk reclaim in a bot's workspace (needs approval to apply).
 *  - sandbox_v6_enforcement_verify — re-read a bot's live cgroup files vs its quota, report drift (read-only).
 *  - sandbox_v6_secret_put       — store a secret for a bot (needs approval).
 *  - sandbox_v6_secret_get       — read a bot's own secret (owner-only; needs approval; value never logged).
 *  - sandbox_v6_secret_list      — list a bot's secrets, metadata only (read-only).
 *  - sandbox_v6_secret_revoke    — revoke a bot's secret (needs approval).
 *  - sandbox_v6_secret_grant     — grant an extra purpose to a bot's secret (needs approval).
 *
 * SAFETY: `runtime_create` / `runtime_destroy` / `quota_set` /
 * `exec` / `secret_put` / `secret_get` / `secret_revoke` /
 * `secret_grant` are needsApproval. The secret value passed to
 * `secret_put` and returned by `secret_get` is NEVER written to
 * any log by this module, and `secret_list` / `secret_grant`
 * carry metadata only. HOST WARNING: the host that executes
 * these tools must not persist tool-call arguments for
 * `sandbox_v6_secret_put` — the value travels in the call.
 * Execs are refused (audited, not run) when the runtime is
 * not running or the disk quota is blown.
 */

import type { Tool } from '@open-bot/core';
import {
  SANDBOX_V6_QUOTA_PRESETS,
  SandboxV6Service,
  formatSandboxV6Bytes,
  probeSandboxV6HostCapacity,
  renderSandboxV6Admission,
  renderSandboxV6AuditMarkdown,
  renderSandboxV6EnforcementStatus,
  renderSandboxV6RuntimeReportMarkdown,
  suggestSandboxV6FairShare,
  type SandboxV6AuditQuery,
  type SandboxV6Quota,
  type SandboxV6QuotaPresetName,
} from '@open-bot/core';

export const SANDBOX_V6_TOOL_NAMES = [
  'sandbox_v6_runtime_create',
  'sandbox_v6_runtime_list',
  'sandbox_v6_runtime_report',
  'sandbox_v6_runtime_pause',
  'sandbox_v6_runtime_resume',
  'sandbox_v6_runtime_stop',
  'sandbox_v6_runtime_destroy',
  'sandbox_v6_quota_get',
  'sandbox_v6_quota_set',
  'sandbox_v6_quota_presets',
  'sandbox_v6_exec',
  'sandbox_v6_usage',
  'sandbox_v6_audit_query',
  'sandbox_v6_audit_summary',
  'sandbox_v6_audit_export',
  'sandbox_v6_disk_reclaim',
  'sandbox_v6_enforcement_verify',
  'sandbox_v6_secret_put',
  'sandbox_v6_secret_get',
  'sandbox_v6_secret_list',
  'sandbox_v6_secret_revoke',
  'sandbox_v6_secret_grant',
] as const;

export function isSandboxV6ToolName(name: string): boolean {
  return (SANDBOX_V6_TOOL_NAMES as readonly string[]).includes(name);
}

export interface SandboxV6ToolOptions {
  /** Base dir for runtimes (default: os.tmpdir()/open-bot-sandbox-v6). */
  baseDir?: string;
  /** cgroup root (default /sys/fs/cgroup; tests pass a temp dir). */
  cgroupRoot?: string;
  /** Idle timeout for runtimes in ms. */
  idleTimeoutMs?: number;
  /** Default lifetime cap for runtimes in ms. */
  defaultLifetimeMs?: number;
  /** Allow total quotas above host capacity. */
  allowOvercommit?: boolean;
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
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings.`);
  }
  return [...(value as string[])];
}

function parseQuotaArg(args: Record<string, unknown>): SandboxV6Quota {
  const quota: SandboxV6Quota = {};
  const cpu = getNumberArg(args, 'cpuPercent');
  if (cpu !== undefined) quota.cpuPercent = cpu;
  const mem = getNumberArg(args, 'memoryBytes');
  if (mem !== undefined) quota.memoryBytes = mem;
  const disk = getNumberArg(args, 'diskBytes');
  if (disk !== undefined) quota.diskBytes = disk;
  const procs = getNumberArg(args, 'maxProcesses');
  if (procs !== undefined) quota.maxProcesses = procs;
  const execMs = getNumberArg(args, 'maxExecMs');
  if (execMs !== undefined) quota.maxExecMs = execMs;
  const write = getNumberArg(args, 'maxWriteBytes');
  if (write !== undefined) quota.maxWriteBytes = write;
  return quota;
}

function parsePresetArg(args: Record<string, unknown>): SandboxV6QuotaPresetName | undefined {
  const value = getStringArg(args, 'preset');
  if (value === '') return undefined;
  const allowed: readonly string[] = ['tiny', 'small', 'default', 'large', 'unlimited'];
  if (!allowed.includes(value)) {
    throw new Error(`Invalid preset "${value}": use one of ${allowed.join(', ')}.`);
  }
  return value as SandboxV6QuotaPresetName;
}

function quotaSummary(quota: {
  cpuPercent: number;
  memoryBytes: number;
  diskBytes: number;
  maxProcesses: number;
  maxExecMs: number;
  maxWriteBytes: number;
}): string {
  return (
    `CPU ${quota.cpuPercent > 0 ? `${quota.cpuPercent}%` : 'unlimited'}, ` +
    `RAM ${quota.memoryBytes > 0 ? formatSandboxV6Bytes(quota.memoryBytes) : 'unlimited'}, ` +
    `disk ${quota.diskBytes > 0 ? formatSandboxV6Bytes(quota.diskBytes) : 'unlimited'}, ` +
    `${quota.maxProcesses > 0 ? `${quota.maxProcesses} processes` : 'processes unlimited'}`
  );
}

/**
 * Create the sandbox v6 tools. One service is created per call
 * and shared by the tools, so a runtime created by
 * `sandbox_v6_runtime_create` is visible to `sandbox_v6_exec`
 * and `sandbox_v6_runtime_report` in the same host process.
 */
export function createSandboxV6Tools(
  getBaseDir?: () => string | null | undefined,
  toolOptions: SandboxV6ToolOptions = {},
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

  const service = new SandboxV6Service({
    ...(resolveBase() !== undefined ? { baseDir: resolveBase() as string } : {}),
    ...(toolOptions.cgroupRoot !== undefined ? { cgroupRoot: toolOptions.cgroupRoot } : {}),
    ...(toolOptions.idleTimeoutMs !== undefined ? { idleTimeoutMs: toolOptions.idleTimeoutMs } : {}),
    ...(toolOptions.defaultLifetimeMs !== undefined ? { defaultLifetimeMs: toolOptions.defaultLifetimeMs } : {}),
    ...(toolOptions.allowOvercommit !== undefined ? { allowOvercommit: toolOptions.allowOvercommit } : {}),
  });

  const runtimeCreateTool: Tool = {
    definition: toolDef(
      'sandbox_v6_runtime_create',
      'Create and start a per-bot sandbox v6 runtime: its own BotBox workspace, its own cgroup v2 enforcement (CPU/RAM/process caps), its own exec audit log and its own secret scope. One live runtime per bot. Quotas are admission-checked against host capacity. Needs approval: a runtime reserves host resources.',
      {
        botId: { type: 'string', description: 'Bot id (1-128 chars: letters, digits, ".", "-", "_").' },
        preset: { type: 'string', description: 'Quota preset: tiny | small | default | large | unlimited (default: default).' },
        cpuPercent: { type: 'number', description: 'Quota: CPU percent of one core, 0 = unlimited (overrides preset).' },
        memoryBytes: { type: 'number', description: 'Quota: physical RAM cap in bytes, 0 = unlimited (overrides preset).' },
        diskBytes: { type: 'number', description: 'Quota: workspace disk cap in bytes, 0 = unlimited (overrides preset).' },
        maxProcesses: { type: 'number', description: 'Quota: max processes (fork-bomb guard), 0 = unlimited (overrides preset).' },
        maxExecMs: { type: 'number', description: 'Quota: max wall-clock ms per exec, 0 = default (overrides preset).' },
        maxWriteBytes: { type: 'number', description: 'Quota: max bytes one exec may write, 0 = default (overrides preset).' },
        lifetimeMs: { type: 'number', description: 'Hard lifetime cap in ms (0 = none).' },
      },
      ['botId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const botId = getStringArg(args, 'botId', true);
        const preset = parsePresetArg(args);
        const quota = parseQuotaArg(args);
        const lifetimeMs = getNumberArg(args, 'lifetimeMs');
        const runtime = service.createRuntime(botId, {
          ...(Object.keys(quota).length > 0 ? { quota } : {}),
          ...(preset !== undefined && Object.keys(quota).length === 0 ? { preset } : {}),
          ...(lifetimeMs !== undefined ? { lifetimeMs } : {}),
        });
        return JSON.stringify(
          { runtime, quota: quotaSummary(runtime.quota) },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const runtimeListTool: Tool = {
    definition: toolDef(
      'sandbox_v6_runtime_list',
      'List sandbox v6 bot runtimes with state, quota, enforcement mode and exec counts. Read-only.',
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
      'sandbox_v6_runtime_report',
      'Full report for one bot runtime: quota, live CPU/RAM/disk usage, disk check, audit summary (incl. hash-chain verification) and secret metadata (never values). Read-only.',
      {
        botId: { type: 'string', description: 'Bot id.' },
        markdown: { type: 'boolean', description: 'Return markdown instead of JSON (default false).' },
      },
      ['botId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const botId = getStringArg(args, 'botId', true);
        const report = service.report(botId);
        if (args.markdown === true) return renderSandboxV6RuntimeReportMarkdown(report);
        return JSON.stringify({ report }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const runtimePauseTool: Tool = {
    definition: toolDef(
      'sandbox_v6_runtime_pause',
      'Pause a bot runtime: new execs are refused until it is resumed. The box, cgroup and secrets are kept.',
      { botId: { type: 'string', description: 'Bot id.' } },
      ['botId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const runtime = service.pauseRuntime(getStringArg(args, 'botId', true));
        return JSON.stringify({ runtime }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const runtimeResumeTool: Tool = {
    definition: toolDef(
      'sandbox_v6_runtime_resume',
      'Resume a paused bot runtime.',
      { botId: { type: 'string', description: 'Bot id.' } },
      ['botId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const runtime = service.resumeRuntime(getStringArg(args, 'botId', true));
        return JSON.stringify({ runtime }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const runtimeStopTool: Tool = {
    definition: toolDef(
      'sandbox_v6_runtime_stop',
      'Stop a bot runtime: new execs are refused. The box, cgroup and secrets are kept (use destroy to remove them).',
      { botId: { type: 'string', description: 'Bot id.' } },
      ['botId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const runtime = service.stopRuntime(getStringArg(args, 'botId', true));
        return JSON.stringify({ runtime }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const runtimeDestroyTool: Tool = {
    definition: toolDef(
      'sandbox_v6_runtime_destroy',
      'Destroy a bot runtime: box workspace, cgroup and the bot\'s secrets are removed. The exec audit log is KEPT (deleting the record of what a bot did would defeat the audit). Needs approval: destructive.',
      { botId: { type: 'string', description: 'Bot id.' } },
      ['botId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const runtime = service.destroyRuntime(getStringArg(args, 'botId', true));
        return JSON.stringify({ runtime }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const quotaGetTool: Tool = {
    definition: toolDef(
      'sandbox_v6_quota_get',
      'Quota + live usage for one bot: CPU/RAM/process/disk caps vs current use. Read-only.',
      { botId: { type: 'string', description: 'Bot id.' } },
      ['botId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const botId = getStringArg(args, 'botId', true);
        const runtime = service.getRuntime(botId);
        if (runtime === undefined) throw new Error(`Unknown bot runtime "${botId}".`);
        const usage = service.getUsage(botId);
        const disk = service.checkDisk(botId);
        return JSON.stringify({ quota: runtime.quota, quotaSummary: quotaSummary(runtime.quota), usage, disk }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const quotaSetTool: Tool = {
    definition: toolDef(
      'sandbox_v6_quota_set',
      'Change a live bot\'s quota: cgroup limits are rewritten live and the change is audited. Admission-checked against host capacity (refused when the host cannot hold the total). Needs approval: resource promise.',
      {
        botId: { type: 'string', description: 'Bot id.' },
        cpuPercent: { type: 'number', description: 'Quota: CPU percent of one core, 0 = unlimited.' },
        memoryBytes: { type: 'number', description: 'Quota: physical RAM cap in bytes, 0 = unlimited.' },
        diskBytes: { type: 'number', description: 'Quota: workspace disk cap in bytes, 0 = unlimited.' },
        maxProcesses: { type: 'number', description: 'Quota: max processes, 0 = unlimited.' },
        maxExecMs: { type: 'number', description: 'Quota: max wall-clock ms per exec, 0 = default.' },
        maxWriteBytes: { type: 'number', description: 'Quota: max bytes one exec may write, 0 = default.' },
      },
      ['botId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const botId = getStringArg(args, 'botId', true);
        const quota = parseQuotaArg(args);
        if (Object.keys(quota).length === 0) throw new Error('No quota field given: pass at least one of cpuPercent, memoryBytes, diskBytes, maxProcesses, maxExecMs, maxWriteBytes.');
        const current = service.getRuntime(botId);
        if (current === undefined) throw new Error(`Unknown bot runtime "${botId}".`);
        const merged: SandboxV6Quota = { ...current.quota, ...quota };
        const runtime = service.setQuota(botId, merged);
        return JSON.stringify({ runtime, quota: quotaSummary(runtime.quota) }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const quotaPresetsTool: Tool = {
    definition: toolDef(
      'sandbox_v6_quota_presets',
      'List quota presets (tiny/small/default/large/unlimited), host capacity, and a fair-share suggestion for N bots. Read-only.',
      {
        botCount: { type: 'number', description: 'Number of bots to split the host across (default 4).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const botCount = getNumberArg(args, 'botCount', 4) ?? 4;
        const capacity = probeSandboxV6HostCapacity();
        const fairShare = suggestSandboxV6FairShare(botCount, capacity);
        const presets: Record<string, string> = {};
        for (const [name, quota] of Object.entries(SANDBOX_V6_QUOTA_PRESETS)) {
          presets[name] = quotaSummary(quota);
        }
        const admission = renderSandboxV6Admission(
          service.admissionFor('__preset-preview__', { ...fairShare }),
        );
        return JSON.stringify({ presets, capacity, fairShare, fairShareSummary: quotaSummary(fairShare), admission }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const execTool: Tool = {
    definition: toolDef(
      'sandbox_v6_exec',
      'Run a command in a bot\'s runtime (inside its BotBox + cgroup). Every exec is audited start-to-finish (command, bot, time, exit code, duration). Refused — audited, not run — when the runtime is not running or the disk quota is blown. Named secrets (owned by this bot) can be injected as env vars OPENBOT_SECRET_<NAME>. Needs approval: runs a command.',
      {
        botId: { type: 'string', description: 'Bot id.' },
        command: { type: 'string', description: 'Program to run (no shell unless you pass /bin/sh -c ...).' },
        args: { type: 'array', description: 'Arguments (array of strings).' },
        secrets: { type: 'array', description: 'Secret names owned by this bot to inject as env vars (array of strings, optional).' },
        stdin: { type: 'string', description: 'Stdin for the process (optional).' },
        timeoutMs: { type: 'number', description: 'Timeout override in ms (optional).' },
      },
      ['botId', 'command'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const botId = getStringArg(args, 'botId', true);
        const command = getStringArg(args, 'command', true);
        const argList = getStringArrayArg(args, 'args');
        const secretNames = getStringArrayArg(args, 'secrets');
        const stdin = getStringArg(args, 'stdin');
        const timeoutMs = getNumberArg(args, 'timeoutMs');
        const result = await service.exec(botId, command, argList, {
          ...(secretNames.length > 0 ? { secrets: secretNames.map((name) => ({ name })) } : {}),
          ...(stdin !== '' ? { stdin } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        });
        return JSON.stringify({ result }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const usageTool: Tool = {
    definition: toolDef(
      'sandbox_v6_usage',
      'Live resource usage for one bot: CPU time, RAM current/peak, processes in cgroup, workspace disk use. Read-only.',
      { botId: { type: 'string', description: 'Bot id.' } },
      ['botId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const botId = getStringArg(args, 'botId', true);
        const usage = service.getUsage(botId);
        return JSON.stringify({ usage }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const auditQueryTool: Tool = {
    definition: toolDef(
      'sandbox_v6_audit_query',
      'Query one bot\'s exec audit log: every command, when, exit code, duration, enforcement mode. Newest first. Read-only.',
      {
        botId: { type: 'string', description: 'Bot id.' },
        kind: { type: 'string', description: 'Event kind filter: exec-start | exec-finish | exec-refused | exec-timeout | quota-changed | quota-exceeded | disk-quota-exceeded | secret-access-denied | secret-granted | secret-revoked | runtime-created | runtime-stopped | runtime-destroyed | cgroup-failed (optional).' },
        text: { type: 'string', description: 'Substring filter over command/detail (optional).' },
        exitCode: { type: 'number', description: 'Exit code filter (optional).' },
        limit: { type: 'number', description: 'Max entries (default 100).' },
      },
      ['botId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const botId = getStringArg(args, 'botId', true);
        const query: SandboxV6AuditQuery = { botId };
        const kind = getStringArg(args, 'kind');
        if (kind !== '') query.kind = kind as SandboxV6AuditQuery['kind'];
        const text = getStringArg(args, 'text');
        if (text !== '') query.text = text;
        const exitCode = getNumberArg(args, 'exitCode');
        if (exitCode !== undefined) query.exitCode = exitCode;
        const limit = getNumberArg(args, 'limit');
        if (limit !== undefined) query.limit = limit;
        const entries = service.queryAudit(botId, query);
        return JSON.stringify({ entries }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const auditSummaryTool: Tool = {
    definition: toolDef(
      'sandbox_v6_audit_summary',
      'Audit summary for one bot: counts by event kind, exit-code histogram, time range, and hash-chain verification (OK or broken at seq N). Read-only.',
      { botId: { type: 'string', description: 'Bot id.' } },
      ['botId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const summary = service.auditSummary(getStringArg(args, 'botId', true));
        return JSON.stringify({ summary }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const auditExportTool: Tool = {
    definition: toolDef(
      'sandbox_v6_audit_export',
      'Export one bot\'s whole audit history (live log + rotated logs), hash-chain verified, secret values re-scrubbed. Read-only.',
      {
        botId: { type: 'string', description: 'Bot id.' },
        markdown: { type: 'boolean', description: 'Return markdown instead of JSON (default false).' },
      },
      ['botId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const botId = getStringArg(args, 'botId', true);
        const bundle = service.exportAudit(botId);
        if (args.markdown === true) return renderSandboxV6AuditMarkdown(bundle);
        return JSON.stringify({ export: bundle }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const diskReclaimTool: Tool = {
    definition: toolDef(
      'sandbox_v6_disk_reclaim',
      'Reclaim disk in a bot\'s workspace: deletes tmp/log files (oldest first) until the workspace fits its quota. Dry-run by default (lists what would be deleted); pass apply=true to delete for real. Symlinks are never followed or deleted. Needs approval: can delete files.',
      {
        botId: { type: 'string', description: 'Bot id.' },
        apply: { type: 'boolean', description: 'Delete for real (default false = dry-run plan only).' },
        headroomBytes: { type: 'number', description: 'Bytes of headroom to keep under the quota (default 0).' },
      },
      ['botId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const botId = getStringArg(args, 'botId', true);
        const apply = args.apply === true;
        const headroomBytes = getNumberArg(args, 'headroomBytes', 0) ?? 0;
        const runtime = service.getRuntime(botId);
        if (runtime === undefined) throw new Error(`Unknown bot runtime "${botId}".`);
        const result = service.reclaimDisk(botId, { quotaBytes: runtime.quota.diskBytes, apply, headroomBytes });
        return JSON.stringify({ reclaim: result }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const secretPutTool: Tool = {
    definition: toolDef(
      'sandbox_v6_secret_put',
      'Store a secret for one bot (owner = botId). Optional purposes restrict which calls may use it; optional ttlMs expires it. The value is scrubbed from every audit log. Needs approval: stores a credential. HOST WARNING: do not persist this tool call\'s arguments.',
      {
        botId: { type: 'string', description: 'Bot id that will own the secret.' },
        name: { type: 'string', description: 'Secret name (lowercase letters, digits, "-", "_").' },
        value: { type: 'string', description: 'Secret value.' },
        purposes: { type: 'array', description: 'Purposes allowed to use it (array of strings, empty = any purpose for the owner).' },
        ttlMs: { type: 'number', description: 'TTL in ms (0 = never expires).' },
      },
      ['botId', 'name', 'value'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const botId = getStringArg(args, 'botId', true);
        const name = getStringArg(args, 'name', true);
        const value = getStringArg(args, 'value', true);
        const purposes = getStringArrayArg(args, 'purposes');
        const ttlMs = getNumberArg(args, 'ttlMs');
        const meta = service.putSecret(botId, name, value, {
          ...(purposes.length > 0 ? { purposes } : {}),
          ...(ttlMs !== undefined ? { ttlMs } : {}),
        });
        return JSON.stringify({ secret: meta }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const secretGetTool: Tool = {
    definition: toolDef(
      'sandbox_v6_secret_get',
      'Read a bot\'s own secret (callerBotId must equal ownerBotId; optional purpose must be granted). Cross-bot reads are denied AND audited. Needs approval: returns a credential value.',
      {
        callerBotId: { type: 'string', description: 'Bot asking for the secret.' },
        ownerBotId: { type: 'string', description: 'Bot that owns the secret.' },
        name: { type: 'string', description: 'Secret name.' },
        purpose: { type: 'string', description: 'Purpose to use it for (optional).' },
      },
      ['callerBotId', 'ownerBotId', 'name'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const callerBotId = getStringArg(args, 'callerBotId', true);
        const ownerBotId = getStringArg(args, 'ownerBotId', true);
        const name = getStringArg(args, 'name', true);
        const purpose = getStringArg(args, 'purpose');
        const got = service.getSecret(
          callerBotId,
          ownerBotId,
          name,
          purpose !== '' ? purpose : undefined,
        );
        if (!got.allowed || got.value === undefined) {
          return errorResult(got.reason ?? 'Access denied.');
        }
        return JSON.stringify({ name, ownerBotId, value: got.value }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const secretListTool: Tool = {
    definition: toolDef(
      'sandbox_v6_secret_list',
      'List a bot\'s secrets: names, purposes, expiry, read/denied counts. Metadata only — never values. Read-only.',
      { botId: { type: 'string', description: 'Bot id.' } },
      ['botId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const secrets = service.listSecrets(getStringArg(args, 'botId', true));
        return JSON.stringify({ secrets }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const secretRevokeTool: Tool = {
    definition: toolDef(
      'sandbox_v6_secret_revoke',
      'Revoke (delete) one of a bot\'s secrets. Needs approval: destructive.',
      {
        botId: { type: 'string', description: 'Bot id.' },
        name: { type: 'string', description: 'Secret name.' },
      },
      ['botId', 'name'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const revoked = service.revokeSecret(getStringArg(args, 'botId', true), getStringArg(args, 'name', true));
        return JSON.stringify({ revoked }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const secretGrantTool: Tool = {
    definition: toolDef(
      'sandbox_v6_secret_grant',
      'Grant an extra purpose to one of a bot\'s secrets. Needs approval: widens access.',
      {
        botId: { type: 'string', description: 'Bot id.' },
        name: { type: 'string', description: 'Secret name.' },
        purpose: { type: 'string', description: 'Purpose to grant.' },
      },
      ['botId', 'name', 'purpose'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const meta = service.grantSecretPurpose(
          getStringArg(args, 'botId', true),
          getStringArg(args, 'name', true),
          getStringArg(args, 'purpose', true),
        );
        return JSON.stringify({ secret: meta }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const enforcementVerifyTool: Tool = {
    definition: toolDef(
      'sandbox_v6_enforcement_verify',
      'Verify one bot\'s live cgroup files against its quota: re-reads cpu.max / memory.max / pids.max and reports drift (a limit changed outside sandbox v6) or a missing cgroup. Read-only.',
      {
        botId: { type: 'string', description: 'Bot id.' },
        text: { type: 'boolean', description: 'Return a one-line verdict instead of JSON (default false).' },
      },
      ['botId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const botId = getStringArg(args, 'botId', true);
        const status = service.verifyEnforcement(botId);
        if (args.text === true) return renderSandboxV6EnforcementStatus(status);
        return JSON.stringify({ enforcement: status }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    runtimeCreateTool,
    runtimeListTool,
    runtimeReportTool,
    runtimePauseTool,
    runtimeResumeTool,
    runtimeStopTool,
    runtimeDestroyTool,
    quotaGetTool,
    quotaSetTool,
    quotaPresetsTool,
    execTool,
    usageTool,
    auditQueryTool,
    auditSummaryTool,
    auditExportTool,
    diskReclaimTool,
    enforcementVerifyTool,
    secretPutTool,
    secretGetTool,
    secretListTool,
    secretRevokeTool,
    secretGrantTool,
  ];
}

/** Default (unbound) tools, for the global tool list. */
export const SANDBOX_V6_TOOLS: Tool[] = createSandboxV6Tools();

// Re-exported for tests / host wiring convenience.
export { SandboxV6Service };
