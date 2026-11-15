/**
 * Memory v9 tools for @open-bot/tools (v1.08, Team T1).
 *
 * The agent works with the v9 memory system by tool call:
 *  - memory_v9_sleep_status    — daemon sleep v9: policy + job đang chạy/xếp hàng + lần chạy gần nhất + giờ hẹn kế tiếp (read)
 *  - memory_v9_sleep_config    — đổi policy sleep v9 (bật/tắt, trigger, idle, giờ hẹn, cooldown, bước chạy) — bật/tắt daemon theo enabled (needsApproval: true)
 *  - memory_v9_sleep_run       — chạy một sleep job ngay (manual / session-end / idle / scheduled, dry-run được) (needsApproval: true)
 *  - memory_v9_sleep_log       — run log sleep v9 (lọc theo trigger/status, xem chi tiết một job) (read)
 *  - memory_v9_version_snapshot — snapshot phiên bản hiện tại của block kèm ghi chú (needsApproval: true)
 *  - memory_v9_version_history — lịch sử phiên bản gộp của block (snapshot v9 + commit git v7) (read)
 *  - memory_v9_version_diff    — diff từng dòng giữa hai phiên bản của block (read)
 *  - memory_v9_version_rollback — rollback block về phiên bản cũ (ghi thành version mới, không viết lại lịch sử) (needsApproval: true)
 *  - memory_v9_shared_register — đăng ký block dùng chung (owner + quyền ban đầu) (needsApproval: true)
 *  - memory_v9_shared_list     — liệt kê block dùng chung (kèm role của bot) (read)
 *  - memory_v9_shared_acl      — cấp/thu/xem quyền của bot trên block dùng chung (needsApproval: true, trừ action list)
 *  - memory_v9_shared_sync     — đồng bộ cho một bot: change chưa thấy + xung đột đang chờ (read)
 *  - memory_v9_shared_write    — ghi block dùng chung kèm baseVersion (xung đột -> ghi lại, không ghi đè) (needsApproval: true)
 *  - memory_v9_shared_resolve  — resolve xung đột ghi (keep-mine / keep-theirs / merged) (needsApproval: true)
 *
 * SAFETY: sleep mặc định TẮT, không chạy trong giờ yên lặng, không
 * chạy 2 job chồng nhau; rollback không viết lại lịch sử (ghi thành
 * version mới); ghi shared-block sai baseVersion không bao giờ ghi
 * đè — xung đột được ghi lại để user/bot resolve tường minh.
 * Không tuyên bố điểm benchmark nào.
 *
 * Factory:
 *   createMemoryV9Tools(opts) -> Tool[]   (bound, usable)
 *   MEMORY_V9_TOOLS                       (unbound placeholder)
 *   getMemoryV9Agent(workspaceDir)       (daemon singleton theo workspace,
 *                                          host dùng để noteSessionStart/End)
 */
import type {
  GitMemoryProjection,
  SleepV9Agent,
  V9SleepAgentStatus,
  Tool,
  V9SharedRole,
  V9SleepTrigger,
} from '@open-bot/core';
import {
  countV9SleepRunsToday,
  MemoryV9VersionStore,
  readV9SleepRunLog,
  SharedBlockRegistry,
  SleepV9Agent as SleepV9AgentClass,
  V9Error,
} from '@open-bot/core';
import type { SleepEpisode } from '@open-bot/core';

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

function getBooleanArg(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean, got ${typeof value}`);
  }
  return value;
}

function getNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a number, got ${typeof value}`);
  }
  return value;
}

/** Số hoặc null tường minh (vd scheduledHour=null để tắt giờ hẹn). */
function getNullableNumberArg(args: Record<string, unknown>, name: string): number | null | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a number or null, got ${typeof value}`);
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

function getEpisodesArg(args: Record<string, unknown>, name: string): SleepEpisode[] | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`Argument "${name}" must be an array of {role, text}.`);
  }
  const out: SleepEpisode[] = [];
  for (const item of value.slice(0, 50)) {
    if (!item || typeof item !== 'object') throw new Error(`Argument "${name}" must be an array of {role, text}.`);
    const role = (item as Record<string, unknown>).role;
    const text = (item as Record<string, unknown>).text;
    if (role !== 'user' && role !== 'bot') throw new Error(`Episode role phải là "user" hoặc "bot".`);
    if (typeof text !== 'string') throw new Error(`Episode text phải là string.`);
    out.push({ id: `tool-ep-${out.length}`, role, text, at: new Date().toISOString() });
  }
  return out;
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

/** Daemon singleton theo workspaceDir (để start/stop/status dùng chung một instance trong tiến trình). */
const agentByWorkspace = new Map<string, SleepV9Agent>();

/**
 * Daemon sleep v9 của một workspace (tạo mới khi chưa có). Host dùng
 * để nối vòng đời chat: noteSessionStart / noteTurn / noteSessionEnd
 * / noteActivity, và start() khi app khởi động (khi policy enabled).
 */
export function getMemoryV9Agent(workspaceDir: string): SleepV9Agent {
  const existing = agentByWorkspace.get(workspaceDir);
  if (existing) return existing;
  const agent = new SleepV9AgentClass({ workspaceDir });
  agentByWorkspace.set(workspaceDir, agent);
  return agent;
}

/** Xoá singleton daemon (chỉ dùng cho test — để test không rò timer/state). */
export function resetMemoryV9AgentsForTests(): void {
  for (const agent of agentByWorkspace.values()) {
    try {
      agent.stop();
    } catch {
      // Bỏ qua.
    }
  }
  agentByWorkspace.clear();
}

export interface MemoryV9ToolOptions {
  /** Workspace dir (required: policy/run log/snapshot/registry/projection live here). */
  workspaceDir?: string;
  /** Pre-built sleep daemon (defaults to the per-workspace singleton). */
  agent?: SleepV9Agent;
  /** Pre-built version store (defaults to a new one on workspaceDir). */
  versionStore?: MemoryV9VersionStore;
  /** Pre-built shared-block registry (defaults to a new one on workspaceDir). */
  registry?: SharedBlockRegistry;
  /** Pre-built git-backed projection (defaults to a new one on workspaceDir). */
  projection?: GitMemoryProjection;
}

export function createMemoryV9Tools(opts: MemoryV9ToolOptions = {}): Tool[] {
  const needWorkspaceDir = (): string => {
    if (!opts.workspaceDir) {
      throw new Error('workspaceDir is required (host must pass it to createMemoryV9Tools).');
    }
    return opts.workspaceDir;
  };
  const agentOf = (): SleepV9Agent => {
    if (opts.agent) return opts.agent;
    return getMemoryV9Agent(needWorkspaceDir());
  };
  const versionStoreOf = (): MemoryV9VersionStore => {
    if (opts.versionStore) return opts.versionStore;
    return new MemoryV9VersionStore(needWorkspaceDir());
  };
  const registryOf = (): SharedBlockRegistry => {
    if (opts.registry) return opts.registry;
    return new SharedBlockRegistry(needWorkspaceDir());
  };

  const sleepStatus: Tool = {
    definition: toolDef(
      'memory_v9_sleep_status',
      'Sleep-time compute daemon status (v9, read): current sleep policy (enabled, triggers, idle threshold, scheduled hour, quiet hours, daily run limit, steps), daemon state (started, running job, queued jobs, tracked sessions), runs today, last run summary, and next scheduled run. The daemon only runs automatically when enabled; manual runs are always available via memory_v9_sleep_run.',
      {},
      [],
    ),
    needsApproval: false,
    async execute() {
      try {
        const dir = needWorkspaceDir();
        const agent = agentOf();
        const status: V9SleepAgentStatus = agent.getStatus();
        return JSON.stringify(
          {
            status,
            runsToday: countV9SleepRunsToday(dir),
            hint: status.enabled
              ? 'Daemon chạy nền khi app mở (tự start khi policy enabled).'
              : 'Sleep v9 đang tắt — bật bằng memory_v9_sleep_config {enabled: true}.',
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sleepConfig: Tool = {
    definition: toolDef(
      'memory_v9_sleep_config',
      'Change the sleep-time compute policy (v9, needs user approval): enable/disable the background daemon (enabling also starts it, disabling stops it), triggers (sessionEnd / idle / scheduled), idle threshold in ms, check interval in ms, session minimum turns/minutes for a session-end run, cooldown between automatic runs, scheduled hour (0-23, null = no scheduled run) + minute, quiet hours (local time, no automatic run even when idle), max runs per day (0 = unlimited), max job duration in ms, and which steps run (consolidateV8 / extractFacts / snapshotBlocks). Policy is saved to disk immediately. Needs user approval first.',
      {
        enabled: { type: 'boolean', description: 'Enable/disable sleep-time compute (enabling starts the daemon, disabling stops it).' },
        triggerSessionEnd: { type: 'boolean', description: 'Run when a session ends (default true).' },
        triggerIdle: { type: 'boolean', description: 'Run after being idle long enough (default true).' },
        triggerScheduled: { type: 'boolean', description: 'Run once a day at the scheduled hour (default false).' },
        idleMs: { type: 'number', description: 'Idle threshold in ms (default 600000 = 10 minutes).' },
        checkIntervalMs: { type: 'number', description: 'Daemon check interval in ms (default 60000).' },
        sessionMinTurns: { type: 'number', description: 'Min turns for a session-end run (default 5).' },
        sessionMinMinutes: { type: 'number', description: 'Min session length in minutes for a session-end run (default 5).' },
        cooldownMs: { type: 'number', description: 'Min pause between automatic runs in ms (default 1800000 = 30 minutes).' },
        scheduledHour: { type: 'number', description: 'Scheduled run hour 0-23, or null to disable the scheduled run.' },
        scheduledMinute: { type: 'number', description: 'Scheduled run minute 0-59 (default 0).' },
        quietStartHour: { type: 'number', description: 'Quiet hours start (0-23 local time).' },
        quietEndHour: { type: 'number', description: 'Quiet hours end (0-23 local time). start == end = no quiet hours.' },
        maxRunsPerDay: { type: 'number', description: 'Max automatic runs per day (0 = unlimited, default 12).' },
        maxJobMs: { type: 'number', description: 'Max duration of one job in ms (default 120000).' },
        stepConsolidateV8: { type: 'boolean', description: 'Run the v8 consolidation step (default true).' },
        stepExtractFacts: { type: 'boolean', description: 'Run the fact-extraction step (default true).' },
        stepSnapshotBlocks: { type: 'boolean', description: 'Snapshot blocks changed by the run (default true).' },
      },
      [],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const agent = agentOf();
        const patch: Record<string, unknown> = {};
        const enabled = getBooleanArg(args, 'enabled');
        if (enabled !== undefined) patch.enabled = enabled;
        const triggers: Record<string, unknown> = {};
        const tSessionEnd = getBooleanArg(args, 'triggerSessionEnd');
        if (tSessionEnd !== undefined) triggers.sessionEnd = tSessionEnd;
        const tIdle = getBooleanArg(args, 'triggerIdle');
        if (tIdle !== undefined) triggers.idle = tIdle;
        const tScheduled = getBooleanArg(args, 'triggerScheduled');
        if (tScheduled !== undefined) triggers.scheduled = tScheduled;
        if (Object.keys(triggers).length > 0) {
          patch.triggers = { ...agent.getPolicy().triggers, ...triggers };
        }
        const steps: Record<string, unknown> = {};
        const sCons = getBooleanArg(args, 'stepConsolidateV8');
        if (sCons !== undefined) steps.consolidateV8 = sCons;
        const sExt = getBooleanArg(args, 'stepExtractFacts');
        if (sExt !== undefined) steps.extractFacts = sExt;
        const sSnap = getBooleanArg(args, 'stepSnapshotBlocks');
        if (sSnap !== undefined) steps.snapshotBlocks = sSnap;
        if (Object.keys(steps).length > 0) {
          patch.steps = { ...agent.getPolicy().steps, ...steps };
        }
        for (const name of ['idleMs', 'checkIntervalMs', 'sessionMinTurns', 'sessionMinMinutes', 'cooldownMs', 'scheduledMinute', 'maxRunsPerDay', 'maxJobMs'] as const) {
          const v = getNumberArg(args, name);
          if (v !== undefined) patch[name] = v;
        }
        const scheduledHour = getNullableNumberArg(args, 'scheduledHour');
        if (scheduledHour !== undefined) {
          if (scheduledHour !== null && (!Number.isInteger(scheduledHour) || scheduledHour < 0 || scheduledHour > 23)) {
            throw new Error('scheduledHour phải là số nguyên 0..23 hoặc null.');
          }
          patch.scheduledHour = scheduledHour;
        }
        const quietStart = getNumberArg(args, 'quietStartHour');
        const quietEnd = getNumberArg(args, 'quietEndHour');
        if (quietStart !== undefined && (!Number.isInteger(quietStart) || quietStart < 0 || quietStart > 23)) {
          throw new Error('quietStartHour phải là số nguyên 0..23.');
        }
        if (quietEnd !== undefined && (!Number.isInteger(quietEnd) || quietEnd < 0 || quietEnd > 23)) {
          throw new Error('quietEndHour phải là số nguyên 0..23.');
        }
        if (quietStart !== undefined || quietEnd !== undefined) {
          const current = agent.getPolicy().quietHours;
          patch.quietHours = {
            startHour: quietStart ?? current.startHour,
            endHour: quietEnd ?? current.endHour,
          };
        }
        const policy = agent.setPolicy(patch as Parameters<SleepV9Agent['setPolicy']>[0]);
        if (policy.enabled) agent.start();
        else agent.stop();
        return JSON.stringify({ policy, daemonStarted: agent.started }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sleepRun: Tool = {
    definition: toolDef(
      'memory_v9_sleep_run',
      'Run a sleep job now (v9, needs user approval): consolidation v8 (dedupe/summary/quarantine records + compress old blocks) + fact extraction from the given session transcript + snapshot of blocks changed by the run. trigger: "manual" (default) | "session-end" | "idle" | "scheduled". dryRun=true only previews (v8 dry-run + no snapshots), writes nothing except the run-log entry marked dryRun. Returns null job when another sleep job is already running. Needs user approval first.',
      {
        trigger: { type: 'string', description: '"manual" (default) | "session-end" | "idle" | "scheduled".' },
        sessionId: { type: 'string', description: 'Session id this run is for (session-end runs).' },
        episodes: { type: 'array', description: 'Session transcript turns for fact extraction: [{role: "user"|"bot", text}].', items: { type: 'object' } },
        dryRun: { type: 'boolean', description: 'Only preview, do not write (default false).' },
      },
      [],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const agent = agentOf();
        const triggerRaw = getOptionalStringArg(args, 'trigger') ?? 'manual';
        if (triggerRaw !== 'manual' && triggerRaw !== 'session-end' && triggerRaw !== 'idle' && triggerRaw !== 'scheduled') {
          throw new Error(`trigger phải là "manual", "session-end", "idle" hoặc "scheduled", nhận được "${triggerRaw}".`);
        }
        const trigger = triggerRaw as V9SleepTrigger;
        const job = await agent.runJobNow({
          trigger,
          ...(getOptionalStringArg(args, 'sessionId') ? { sessionId: getOptionalStringArg(args, 'sessionId') as string } : {}),
          ...(getEpisodesArg(args, 'episodes') ? { episodes: getEpisodesArg(args, 'episodes') as SleepEpisode[] } : {}),
          ...(getBooleanArg(args, 'dryRun') === true ? { dryRun: true } : {}),
        });
        if (!job) {
          return JSON.stringify({ job: null, note: 'Một sleep job khác đang chạy — thử lại sau.' }, null, 2);
        }
        return JSON.stringify({ job }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sleepLog: Tool = {
    definition: toolDef(
      'memory_v9_sleep_log',
      'Sleep run log (v9, read): recent sleep jobs (newest last), optionally filtered by trigger and/or status. Each entry shows the trigger, steps run with per-step results, counts (records examined/deduped, blocks compressed, facts extracted/stored, snapshots created), duration, and errors. Use jobId to read one job in full.',
      {
        limit: { type: 'number', description: 'Max entries (default 20, max 100).' },
        trigger: { type: 'string', description: 'Filter: "session-end" | "idle" | "scheduled" | "manual".' },
        status: { type: 'string', description: 'Filter: "queued" | "running" | "done" | "failed" | "cancelled" | "skipped".' },
        jobId: { type: 'string', description: 'Read one job by id.' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const dir = needWorkspaceDir();
        const jobId = getOptionalStringArg(args, 'jobId');
        const limit = Math.max(1, Math.min(100, Math.floor(getNumberArg(args, 'limit') ?? 20)));
        const entries = readV9SleepRunLog(dir, 200);
        if (jobId) {
          const found = entries.find((e) => e.id === jobId);
          if (!found) throw new Error(`Không tìm thấy sleep job "${jobId}" trong run log.`);
          return JSON.stringify({ job: found }, null, 2);
        }
        const trigger = getOptionalStringArg(args, 'trigger');
        const status = getOptionalStringArg(args, 'status');
        const filtered = entries.filter(
          (e) => (!trigger || e.trigger === trigger) && (!status || e.status === status),
        );
        return JSON.stringify({ total: entries.length, returned: filtered.slice(-limit).length, entries: filtered.slice(-limit) }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const versionSnapshot: Tool = {
    definition: toolDef(
      'memory_v9_version_snapshot',
      'Snapshot the current version of a memory block (v9, needs user approval): saves the full content + version + content hash + git commit (when available) with a note, so the block can be rolled back later even without git. Returns the snapshot id, version and hash. Needs user approval first.',
      {
        label: { type: 'string', description: 'Block label (e.g. "human").' },
        note: { type: 'string', description: 'Note for this snapshot (e.g. "before manual edit").' },
      },
      ['label'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const label = getStringArg(args, 'label');
        const note = getOptionalStringArg(args, 'note') ?? '';
        const snap = versionStoreOf().snapshot(label, note, `user:${ctx.botId}`);
        return JSON.stringify({ snapshot: snap }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const versionHistory: Tool = {
    definition: toolDef(
      'memory_v9_version_history',
      'Version history of a memory block (v9, read): merged list of versions from v9 snapshots + v7 git commits (falls back to the history log when git is unavailable), newest first. Each entry shows version, time, actor, action, commit, content hash and character count. Use it to pick a version for memory_v9_version_diff or memory_v9_version_rollback.',
      {
        label: { type: 'string', description: 'Block label (e.g. "human").' },
        limit: { type: 'number', description: 'Max versions (default 20, max 100).' },
      },
      ['label'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const label = getStringArg(args, 'label');
        const limit = Math.max(1, Math.min(100, Math.floor(getNumberArg(args, 'limit') ?? 20)));
        const history = versionStoreOf().history(label, limit);
        return JSON.stringify({ label, versions: history }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const versionDiff: Tool = {
    definition: toolDef(
      'memory_v9_version_diff',
      'Diff between two versions of a memory block (v9, read): line-level diff (added/removed lines, hunks with 3 lines of context, line numbers on both sides), computed locally without git; the raw git diff text is attached when both versions have git commits. toVersion defaults to the current version.',
      {
        label: { type: 'string', description: 'Block label (e.g. "human").' },
        fromVersion: { type: 'number', description: 'Older version number.' },
        toVersion: { type: 'number', description: 'Newer version number (default: current).' },
      },
      ['label', 'fromVersion'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const label = getStringArg(args, 'label');
        const fromVersion = getNumberArg(args, 'fromVersion') as number;
        const toVersion = getNumberArg(args, 'toVersion');
        const diff = versionStoreOf().diff(
          label,
          Math.floor(fromVersion),
          ...(toVersion !== undefined ? [Math.floor(toVersion)] : []),
        );
        return JSON.stringify({ diff }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const versionRollback: Tool = {
    definition: toolDef(
      'memory_v9_version_rollback',
      'Roll back a memory block to an old version (v9, needs user approval): writes the old content back as a NEW version (version + 1) and snapshots it with a "rollback from vN" note — history is never rewritten, so the rollback itself can be rolled back. System blocks (human/persona) can only be rolled back by the user, never by an agent actor. Needs user approval first.',
      {
        label: { type: 'string', description: 'Block label (e.g. "human").' },
        version: { type: 'number', description: 'Version to roll back to.' },
      },
      ['label', 'version'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const label = getStringArg(args, 'label');
        const version = getNumberArg(args, 'version') as number;
        const report = versionStoreOf().rollback(label, Math.floor(version), `user:${ctx.botId}`);
        return JSON.stringify({ report }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sharedRegister: Tool = {
    definition: toolDef(
      'memory_v9_shared_register',
      'Register a memory block as shared across bots (v9, needs user approval): the block must exist in the local projection. The registering bot becomes the owner (admin forever); other bots get their initial roles from grants (read = can sync, write = can write, admin = can grant/revoke). The block content stays in the projection — the registry only stores the sharing relation, ACL and version vector. Needs user approval first.',
      {
        label: { type: 'string', description: 'Block label to share (e.g. "team-notes").' },
        ownerBotId: { type: 'string', description: 'Bot id registering the block (becomes owner/admin).' },
        description: { type: 'string', description: 'What this shared block is for.' },
        grants: { type: 'array', description: 'Initial grants: [{botId, role: "read"|"write"|"admin"}].', items: { type: 'object' } },
      },
      ['label', 'ownerBotId'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const label = getStringArg(args, 'label');
        const ownerBotId = getStringArg(args, 'ownerBotId');
        const grantsRaw = args.grants;
        let grants: Array<{ botId: string; role: V9SharedRole }> | undefined;
        if (grantsRaw !== undefined && grantsRaw !== null) {
          if (!Array.isArray(grantsRaw)) throw new Error('Argument "grants" must be an array of {botId, role}.');
          grants = [];
          for (const g of grantsRaw) {
            if (!g || typeof g !== 'object') throw new Error('Each grant must be {botId, role}.');
            const botId = (g as Record<string, unknown>).botId;
            const role = (g as Record<string, unknown>).role;
            if (typeof botId !== 'string' || (role !== 'read' && role !== 'write' && role !== 'admin')) {
              throw new Error('Each grant must be {botId: string, role: "read"|"write"|"admin"}.');
            }
            grants.push({ botId, role });
          }
        }
        const entry = registryOf().register(label, ownerBotId, {
          ...(getOptionalStringArg(args, 'description') ? { description: getOptionalStringArg(args, 'description') as string } : {}),
          ...(grants ? { grants } : {}),
        });
        return JSON.stringify({ entry }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sharedList: Tool = {
    definition: toolDef(
      'memory_v9_shared_list',
      'List shared memory blocks (v9, read): all registered blocks with owner, version, version vector and pending conflict count; optionally only the blocks one bot can see, with that bot\'s role on each.',
      {
        botId: { type: 'string', description: 'Only blocks this bot can see (with its role). Omit to list all.' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const registry = registryOf();
        const botId = getOptionalStringArg(args, 'botId');
        if (botId) {
          const visible = registry.listForBot(botId).map(({ entry, role }) => ({ entry, role }));
          return JSON.stringify({ botId, blocks: visible }, null, 2);
        }
        const blocks = registry.list().map((entry) => ({
          entry,
          pendingConflicts: registry.listConflicts(entry.label, 'pending').length,
        }));
        return JSON.stringify({ blocks }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sharedAcl: Tool = {
    definition: toolDef(
      'memory_v9_shared_acl',
      'Manage access to a shared block (v9, needs user approval): "grant" gives a bot a role (read/write/admin, only owner/admin can grant), "revoke" removes a bot\'s access (only owner/admin; the owner can never be revoked), "list" shows the ACL. The owner always keeps admin. Needs user approval first (grant/revoke change access).',
      {
        label: { type: 'string', description: 'Shared block label.' },
        action: { type: 'string', description: '"grant" | "revoke" | "list".' },
        botId: { type: 'string', description: 'Bot id to grant/revoke (required for grant/revoke).' },
        role: { type: 'string', description: 'Role for grant: "read" | "write" | "admin".' },
        grantedBy: { type: 'string', description: 'Bot id performing the grant/revoke (must be owner/admin; default: the calling bot).' },
      },
      ['label', 'action'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const label = getStringArg(args, 'label');
        const action = getStringArg(args, 'action');
        const registry = registryOf();
        if (action === 'list') {
          const entry = registry.get(label);
          if (!entry) throw new V9Error(`Block "${label}" chưa đăng ký dùng chung.`);
          return JSON.stringify({ entry }, null, 2);
        }
        if (action !== 'grant' && action !== 'revoke') {
          throw new Error(`action phải là "grant", "revoke" hoặc "list", nhận được "${action}".`);
        }
        const botId = getStringArg(args, 'botId');
        const by = getOptionalStringArg(args, 'grantedBy') ?? ctx.botId;
        if (action === 'grant') {
          const role = getStringArg(args, 'role');
          if (role !== 'read' && role !== 'write' && role !== 'admin') {
            throw new Error(`role phải là "read", "write" hoặc "admin", nhận được "${role}".`);
          }
          const entry = registry.grant(label, botId, role as V9SharedRole, by);
          return JSON.stringify({ entry }, null, 2);
        }
        const revoked = registry.revoke(label, botId, by);
        return JSON.stringify({ label, botId, revoked }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sharedSync: Tool = {
    definition: toolDef(
      'memory_v9_shared_sync',
      'Sync a shared block for one bot (v9, read): returns the block\'s sync status (version, version vector, per-bot seen sequences, pending conflicts) plus every change the bot has not seen yet (sinceSeq, default 0 = all changes) and the pending conflicts. Syncing marks the bot as seen up to the newest change returned. The bot must have read access. No network is used — this is the local change feed.',
      {
        label: { type: 'string', description: 'Shared block label.' },
        botId: { type: 'string', description: 'Bot id syncing (must have read access).' },
        sinceSeq: { type: 'number', description: 'Only changes with seq greater than this (default 0).' },
      },
      ['label', 'botId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const label = getStringArg(args, 'label');
        const botId = getStringArg(args, 'botId');
        const sinceSeq = Math.max(0, Math.floor(getNumberArg(args, 'sinceSeq') ?? 0));
        const result = registryOf().sync(label, botId, sinceSeq);
        return JSON.stringify({ sync: result }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sharedWrite: Tool = {
    definition: toolDef(
      'memory_v9_shared_write',
      'Write to a shared memory block (v9, needs user approval): the bot must have write access, and the write carries the baseVersion the bot read. If the block has moved on since then (another bot wrote first), the write is REFUSED and recorded as a pending conflict — nothing is overwritten silently; resolve it with memory_v9_shared_resolve. baseVersion=null writes blind (still permission-checked). A successful write bumps the version, updates the version vector and appends to the change feed. Needs user approval first.',
      {
        label: { type: 'string', description: 'Shared block label.' },
        botId: { type: 'string', description: 'Bot id writing (must have write access).' },
        content: { type: 'string', description: 'New full content of the block.' },
        baseVersion: { type: 'number', description: 'Version the bot based its edit on (from memory_v9_shared_sync).' },
        summary: { type: 'string', description: 'Short summary of the change (for the change feed).' },
      },
      ['label', 'botId', 'content'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const label = getStringArg(args, 'label');
        const botId = getStringArg(args, 'botId');
        const content = getStringArg(args, 'content');
        const baseVersionRaw = args.baseVersion;
        let baseVersion: number | null = null;
        if (baseVersionRaw !== undefined && baseVersionRaw !== null) {
          if (typeof baseVersionRaw !== 'number' || !Number.isFinite(baseVersionRaw)) {
            throw new Error('Argument "baseVersion" must be a number or null.');
          }
          baseVersion = Math.floor(baseVersionRaw);
        }
        const result = registryOf().write(label, botId, content, baseVersion, getOptionalStringArg(args, 'summary') ?? '');
        return JSON.stringify({ result }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sharedResolve: Tool = {
    definition: toolDef(
      'memory_v9_shared_resolve',
      'Resolve a pending shared-block write conflict (v9, needs user approval): only the block owner/admin or the writer who created the conflict may resolve it. "keep-mine" keeps the current content and discards the writer\'s; "keep-theirs" writes the writer\'s content as a new version; "merged" writes mergedContent (required) as a new version. A successful keep-theirs/merged write is recorded in the change feed. Needs user approval first.',
      {
        conflictId: { type: 'string', description: 'Id of the pending conflict.' },
        resolution: { type: 'string', description: '"keep-mine" | "keep-theirs" | "merged".' },
        byBotId: { type: 'string', description: 'Bot id resolving (owner/admin or the writer).' },
        mergedContent: { type: 'string', description: 'Merged content (required for "merged").' },
      },
      ['conflictId', 'resolution', 'byBotId'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const conflictId = getStringArg(args, 'conflictId');
        const resolution = getStringArg(args, 'resolution');
        if (resolution !== 'keep-mine' && resolution !== 'keep-theirs' && resolution !== 'merged') {
          throw new Error(`resolution phải là "keep-mine", "keep-theirs" hoặc "merged", nhận được "${resolution}".`);
        }
        const byBotId = getStringArg(args, 'byBotId');
        const conflict = registryOf().resolveConflict(
          conflictId,
          resolution,
          byBotId,
          getOptionalStringArg(args, 'mergedContent'),
        );
        return JSON.stringify({ conflict }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    sleepStatus,
    sleepConfig,
    sleepRun,
    sleepLog,
    versionSnapshot,
    versionHistory,
    versionDiff,
    versionRollback,
    sharedRegister,
    sharedList,
    sharedAcl,
    sharedSync,
    sharedWrite,
    sharedResolve,
  ];
}

/** Unbound placeholder (same shape as MEMORY_V8_TOOLS). */
export const MEMORY_V9_TOOLS: Tool[] = createMemoryV9Tools();

/** Names of the memory v9 tools (for the coordinator/registry checks). */
export const MEMORY_V9_TOOL_NAMES = [
  'memory_v9_sleep_status',
  'memory_v9_sleep_config',
  'memory_v9_sleep_run',
  'memory_v9_sleep_log',
  'memory_v9_version_snapshot',
  'memory_v9_version_history',
  'memory_v9_version_diff',
  'memory_v9_version_rollback',
  'memory_v9_shared_register',
  'memory_v9_shared_list',
  'memory_v9_shared_acl',
  'memory_v9_shared_sync',
  'memory_v9_shared_write',
  'memory_v9_shared_resolve',
] as const;
