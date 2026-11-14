/**
 * Workspace tools v3 — agent-callable tools for the workspace
 * abstraction (v1.03, Đội T4).
 *
 * Every tool is a thin wrapper over @open-bot/core: workspaces live
 * under `<workspaceDir>/.open-bot/workspaces`, so the tools work
 * without extra host wiring (same pattern as rescueV102Tools — paths
 * from the workspace). Tools that change outside state (create, exec,
 * snapshot create/restore) set needsApproval; read-only tools
 * (list, quota_status, snapshot_list) do not.
 *
 * Backend note: a workspace created with backend 'container' on a
 * machine without docker/podman falls back to local execution and is
 * marked `degraded` — the tool result says so plainly, never claims
 * container isolation it does not have (see workspace/container.ts).
 */

import * as path from 'node:path';
import type { Tool, ToolContext } from '@open-bot/core';
import { WorkspaceManager } from '@open-bot/core';
import { MAX_TOOL_RESULT_CHARS, truncateText } from './truncate';

export const WORKSPACE_TOOL_NAMES = [
  'workspace_create',
  'workspace_exec',
  'workspace_list',
  'workspace_quota_status',
  'workspace_snapshot_create',
  'workspace_snapshot_list',
  'workspace_snapshot_restore',
] as const;

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
  if (typeof value !== 'string') throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  return value;
}

function getOptionalNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a number, got ${typeof value}`);
  }
  return value;
}

function getStringArrayArg(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings`);
  }
  return [...(value as string[])];
}

function managerFor(ctx: ToolContext): WorkspaceManager {
  return new WorkspaceManager({
    rootDir: path.join(ctx.workspaceDir, '.open-bot', 'workspaces'),
  });
}

function summarizeStatus(status: ReturnType<WorkspaceManager['status']>): string {
  return JSON.stringify(
    {
      id: status.id,
      name: status.name,
      botId: status.botId,
      backend: status.backend,
      status: status.status,
      ...(status.degradedReason ? { degradedReason: status.degradedReason } : {}),
      isolation: status.isolation
        ? { kind: status.isolation.kind, isolated: status.isolation.isolated, detail: status.isolation.detail }
        : null,
      quota: {
        cpuCores: status.quota.cpuCores,
        ramMb: Math.round(status.quota.ramBytes / 1024 / 1024),
        diskMb: Math.round(status.quota.diskBytes / 1024 / 1024),
        maxProcesses: status.quota.maxProcesses,
        maxWriteMb: Math.round(status.quota.maxWriteBytes / 1024 / 1024),
        maxWallMs: status.quota.maxWallMs,
        timeoutMs: status.quota.timeoutMs,
      },
      usage: {
        diskMb: Math.round(status.usage.diskBytes / 1024 / 1024),
        fileCount: status.usage.fileCount,
        runs: status.usage.runs,
        bytesWritten: status.usage.bytesWritten,
        wallMs: status.usage.wallMs,
        windowStart: status.usage.windowStart,
      },
      snapshotCount: status.snapshotCount,
      createdAt: status.createdAt,
    },
    null,
    2,
  );
}

const workspaceCreateTool: Tool = {
  definition: toolDef(
    'workspace_create',
    'Create an isolated workspace for agent work (local sandbox, or container when docker/podman is available). Returns the workspace id, backend actually used, quota and status. A container request on a machine without a container runtime falls back to local execution and is marked degraded.',
    {
      id: { type: 'string', description: 'Workspace id (letters, digits, ".", "-" and "_" only; empty = auto-generated).' },
      name: { type: 'string', description: 'Display name (defaults to the id).' },
      backend: { type: 'string', enum: ['local', 'container'], description: 'Execution backend (default "local").' },
      cpuCores: { type: 'number', description: 'Max CPU cores (default 1).' },
      ramMb: { type: 'number', description: 'Max RAM in MiB (default 1024).' },
      diskMb: { type: 'number', description: 'Max disk in MiB (default 2048).' },
      profile: { type: 'string', enum: ['strict', 'standard', 'permissive'], description: 'Sandbox profile (default "standard").' },
    },
    [],
  ),
  needsApproval: true,
  async execute(args, ctx) {
    try {
      const manager = managerFor(ctx);
      const backend = getOptionalStringArg(args, 'backend');
      if (backend !== undefined && backend !== 'local' && backend !== 'container') {
        return errorResult(`backend must be "local" or "container", got "${backend}"`);
      }
      const profile = getOptionalStringArg(args, 'profile');
      if (profile !== undefined && !['strict', 'standard', 'permissive'].includes(profile)) {
        return errorResult(`profile must be "strict", "standard" or "permissive", got "${profile}"`);
      }
      const cpuCores = getOptionalNumberArg(args, 'cpuCores');
      const ramMb = getOptionalNumberArg(args, 'ramMb');
      const diskMb = getOptionalNumberArg(args, 'diskMb');
      const ws = manager.create({
        ...(getOptionalStringArg(args, 'id') ? { id: getOptionalStringArg(args, 'id') } : {}),
        ...(getOptionalStringArg(args, 'name') ? { name: getOptionalStringArg(args, 'name') } : {}),
        ...(backend ? { backend: backend as 'local' | 'container' } : {}),
        ...(profile ? { profile } : {}),
        ...(ctx.botId ? { botId: ctx.botId } : {}),
        quota: {
          ...(cpuCores !== undefined ? { cpuCores } : {}),
          ...(ramMb !== undefined ? { ramBytes: Math.round(ramMb * 1024 * 1024) } : {}),
          ...(diskMb !== undefined ? { diskBytes: Math.round(diskMb * 1024 * 1024) } : {}),
        },
      });
      return truncateText(summarizeStatus(ws.status()), MAX_TOOL_RESULT_CHARS);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

const workspaceExecTool: Tool = {
  definition: toolDef(
    'workspace_exec',
    'Run a command inside a workspace (sandboxed by the workspace backend + quota + dangerous-command guard). Returns exit code, real isolation level, stdout/stderr (truncated) and measured disk usage. Refused before spawning when the workspace quota is exceeded.',
    {
      workspaceId: { type: 'string', description: 'Workspace id.' },
      command: { type: 'string', description: 'Program to run (e.g. "/bin/echo", "node"). No shell unless you pass /bin/sh -c.' },
      args: { type: 'array', items: { type: 'string' }, description: 'Arguments for the program.' },
      stdin: { type: 'string', description: 'Stdin text for the process.' },
    },
    ['workspaceId', 'command'],
  ),
  needsApproval: true,
  async execute(args, ctx) {
    try {
      const manager = managerFor(ctx);
      const ws = manager.get(getStringArg(args, 'workspaceId'));
      const command = getStringArg(args, 'command');
      const cmdArgs = getStringArrayArg(args, 'args');
      const result = await ws.exec(command, cmdArgs, {
        ...(getOptionalStringArg(args, 'stdin') !== undefined
          ? { stdin: getOptionalStringArg(args, 'stdin') as string }
          : {}),
      });
      const out = [
        `exitCode: ${result.exitCode}`,
        `isolation: ${result.isolation.kind} (isolated=${result.isolation.isolated}) — ${result.isolation.detail}`,
        ...(result.timedOut ? ['timedOut: true'] : []),
        ...(result.writeCapExceeded ? ['writeCapExceeded: true'] : []),
        ...(result.quotaDenied ? ['quotaDenied: true'] : []),
        `workspaceBytes: ${result.workspaceBytes}`,
        `durationMs: ${result.durationMs}`,
        '--- stdout ---',
        result.stdout,
        '--- stderr ---',
        result.stderr,
      ].join('\n');
      return truncateText(out, MAX_TOOL_RESULT_CHARS);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

const workspaceListTool: Tool = {
  definition: toolDef(
    'workspace_list',
    'List workspaces (id, backend actually used, status, quota and measured usage).',
    {},
    [],
  ),
  needsApproval: false,
  async execute(_args, ctx) {
    try {
      const manager = managerFor(ctx);
      const metas = manager.list();
      if (metas.length === 0) return 'No workspaces yet.';
      const lines = metas.map((meta) => {
        const status = manager.status(meta.id);
        return summarizeStatus(status);
      });
      return truncateText(lines.join('\n'), MAX_TOOL_RESULT_CHARS);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

const workspaceQuotaStatusTool: Tool = {
  definition: toolDef(
    'workspace_quota_status',
    'Show a workspace quota + measured usage + snapshot count (CPU/RAM/disk allocated vs used, runs/wall-time in the current quota window).',
    {
      workspaceId: { type: 'string', description: 'Workspace id.' },
    },
    ['workspaceId'],
  ),
  needsApproval: false,
  async execute(args, ctx) {
    try {
      const manager = managerFor(ctx);
      const status = manager.status(getStringArg(args, 'workspaceId'));
      return truncateText(summarizeStatus(status), MAX_TOOL_RESULT_CHARS);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

const workspaceSnapshotCreateTool: Tool = {
  definition: toolDef(
    'workspace_snapshot_create',
    'Snapshot a workspace (copies all files + a sha256 manifest). Returns the snapshot id, file count and total bytes.',
    {
      workspaceId: { type: 'string', description: 'Workspace id.' },
      name: { type: 'string', description: 'Snapshot name (defaults to the snapshot id).' },
    },
    ['workspaceId'],
  ),
  needsApproval: true,
  async execute(args, ctx) {
    try {
      const manager = managerFor(ctx);
      const ws = manager.get(getStringArg(args, 'workspaceId'));
      const snap = ws.createSnapshot(getOptionalStringArg(args, 'name'));
      return truncateText(
        JSON.stringify(
          {
            id: snap.id,
            workspaceId: snap.workspaceId,
            name: snap.name,
            backend: snap.backend,
            fileCount: snap.fileCount,
            totalBytes: snap.totalBytes,
            createdAt: snap.createdAt,
          },
          null,
          2,
        ),
        MAX_TOOL_RESULT_CHARS,
      );
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

const workspaceSnapshotListTool: Tool = {
  definition: toolDef(
    'workspace_snapshot_list',
    'List snapshots of a workspace (newest first: id, name, file count, bytes, created time).',
    {
      workspaceId: { type: 'string', description: 'Workspace id.' },
    },
    ['workspaceId'],
  ),
  needsApproval: false,
  async execute(args, ctx) {
    try {
      const manager = managerFor(ctx);
      const ws = manager.get(getStringArg(args, 'workspaceId'));
      const snaps = ws.listSnapshots();
      if (snaps.length === 0) return `No snapshots for workspace "${ws.id}".`;
      return truncateText(
        JSON.stringify(
          snaps.map((s) => ({
            id: s.id,
            name: s.name,
            fileCount: s.fileCount,
            totalBytes: s.totalBytes,
            createdAt: s.createdAt,
          })),
          null,
          2,
        ),
        MAX_TOOL_RESULT_CHARS,
      );
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

const workspaceSnapshotRestoreTool: Tool = {
  definition: toolDef(
    'workspace_snapshot_restore',
    'Restore a workspace to a snapshot (verifies sha256 before and after copying; rolls back to the pre-restore content on failure).',
    {
      workspaceId: { type: 'string', description: 'Workspace id.' },
      snapshotId: { type: 'string', description: 'Snapshot id.' },
    },
    ['workspaceId', 'snapshotId'],
  ),
  needsApproval: true,
  async execute(args, ctx) {
    try {
      const manager = managerFor(ctx);
      const ws = manager.get(getStringArg(args, 'workspaceId'));
      const restored = ws.restoreSnapshot(getStringArg(args, 'snapshotId'));
      return `Restored workspace "${ws.id}" to snapshot "${restored.id}" (${restored.name}, ${restored.fileCount} files, ${restored.totalBytes} bytes).`;
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

/** All 7 workspace tools (v1.03, Đội T4). */
export const WORKSPACE_TOOLS: Tool[] = [
  workspaceCreateTool,
  workspaceExecTool,
  workspaceListTool,
  workspaceQuotaStatusTool,
  workspaceSnapshotCreateTool,
  workspaceSnapshotListTool,
  workspaceSnapshotRestoreTool,
];
