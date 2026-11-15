/**
 * Sleep-time compute v9 — daemon nền tự động (v1.08, Đội T1).
 *
 * Đây là mảnh còn thiếu mà task sóng v1.08 gọi tên: v0.97 có
 * SleepTimeAgent (chạy theo bước/khi compact/thủ công) và v8 có
 * SleepV8Scheduler (policy bền + nén block + ledger), nhưng chưa có
 * một AGENT NỀN nối chúng lại — tự chạy giữa các session mà không
 * cần ai gọi tay. `SleepV9Agent` là daemon đó:
 *
 *  - TRIGGER: session kết thúc (đủ dài/đủ turn) | rảnh đủ lâu
 *    (idle) | giờ hẹn mỗi ngày (scheduled) | chạy tay (manual).
 *  - JOB LIFECYCLE: job xếp hàng -> chạy -> done/failed/skipped,
 *    không bao giờ chạy 2 job chồng nhau; job quá maxJobMs thì dừng
 *    sớm, báo partial thay vì treo.
 *  - MỖI JOB CHẠY 3 BƯỚC (theo policy.steps, bước nào cũng có thể
 *    tắt): (1) consolidation v8 — dedupe/summary/quarantine bản
 *    ghi + nén block cũ (TÁI DÙNG SleepV8Scheduler, không viết lại);
 *    (2) trích fact từ transcript session (TÁI DÙNG SleepTimeAgent
 *    v0.97, trigger 'manual' để không đụng config bền của nó);
 *    (3) snapshot các block đã đổi trong lần chạy để rollback được.
 *  - RUN LOG: mọi job (kể cả dry-run, kể cả skip do policy) đều
 *    ghi vào `.open-bot/memory-v9-sleep-runs.jsonl` + file latest
 *    để UI đọc nhanh; đếm số lần chạy trong ngày chỉ tính chạy thật.
 *  - AN TOÀN: mặc định TẮT; không chạy trong giờ yên lặng; nghỉ
 *    cooldown giữa hai lần chạy tự động; giới hạn số lần/ngày;
 *    lỗi từng bước không fail cả job (ghi vào errors, job vẫn done
 *    với partial counts); lỗi ghi log không fail job.
 *
 * Daemon sống trong tiến trình host: host tạo MỘT SleepV9Agent cho
 * mỗi workspace (tool layer giữ singleton theo workspaceDir), gọi
 * start() một lần, rồi gọi noteActivity()/noteSessionStart()/
 * noteTurn()/noteSessionEnd() theo vòng đời chat. Tool
 * memory_v9_sleep_run chạy tay một job ngay.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { V6RecordStore } from '../v3/store';
import { V6RecordStore as V6RecordStoreClass } from '../v3/store';
import type { GitMemoryProjection } from '../gitProjection';
import { GitMemoryProjection as GitMemoryProjectionClass } from '../gitProjection';
import { SleepV8Scheduler } from '../v8/sleep';
import { SleepTimeAgent } from '../sleepAgent';
import type { SleepEpisode } from '../sleepAgent';
import { MemoryV9VersionStore } from './versioning';
import {
  defaultV9SleepPolicy,
  emptyV9SleepJobCounts,
  isInV9QuietHours,
  normalizeV9SleepPolicy,
  V9_SLEEP_ACTOR,
  V9_SLEEP_LATEST_REL_PATH,
  V9_SLEEP_POLICY_REL_PATH,
  V9_SLEEP_RUN_LOG_KEEP,
  V9_SLEEP_RUN_LOG_REL_PATH,
  V9Error,
} from './types';
import type {
  V9SleepAgentStatus,
  V9SleepJob,
  V9SleepJobCounts,
  V9SleepPolicy,
  V9SleepPolicyFile,
  V9SleepRunLogEntry,
  V9SleepStepResult,
  V9SleepTrigger,
  V9TrackedSession,
} from './types';

/** Số episode tối đa giữ cho một session đang theo dõi. */
export const V9_MAX_EPISODES_PER_SESSION = 200;
/** Số ký tự tối đa giữ cho một episode (cắt ngắn transcript dài). */
export const V9_MAX_EPISODE_CHARS = 2000;
/** Số dòng tối đa giữ trong run log file (cũ hơn bị cắt khi append). */
export const V9_RUN_LOG_PRUNE_AT = 250;

/* ------------------------------------------------------------------ */
/* Policy store (lưu bền)                                             */
/* ------------------------------------------------------------------ */

/**
 * Store policy sleep v9 (file JSON, atomic temp + rename, mode 0600).
 * In-memory khi không có dir (dùng cho test).
 */
export class V9SleepPolicyStore {
  private readonly filePath: string | null;
  private policy: V9SleepPolicy | null = null;

  constructor(opts: { dir?: string; filePath?: string; inMemory?: boolean } = {}) {
    if (opts.inMemory) {
      this.filePath = null;
    } else if (opts.filePath) {
      this.filePath = opts.filePath;
    } else if (opts.dir) {
      this.filePath = path.join(opts.dir, V9_SLEEP_POLICY_REL_PATH);
    } else {
      this.filePath = null;
    }
  }

  static fromWorkspace(workspaceDir: string): V9SleepPolicyStore {
    return new V9SleepPolicyStore({ dir: workspaceDir });
  }

  static inMemory(): V9SleepPolicyStore {
    return new V9SleepPolicyStore({ inMemory: true });
  }

  get path(): string | null {
    return this.filePath;
  }

  /** Policy hiện tại (đọc đĩa lần đầu, thiếu file -> mặc định). */
  get(): V9SleepPolicy {
    if (this.policy) return normalizeV9SleepPolicy(this.policy);
    let raw: Partial<V9SleepPolicy> = {};
    if (this.filePath) {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const file = parsed as Partial<V9SleepPolicyFile> & Partial<V9SleepPolicy>;
          raw = (file.policy ?? file) as Partial<V9SleepPolicy>;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new V9Error(`File policy sleep v9 hỏng: ${this.filePath}`);
        }
      }
    }
    this.policy = normalizeV9SleepPolicy(raw);
    return normalizeV9SleepPolicy(this.policy);
  }

  /** Lưu policy mới (ghi bền ngay). Trả về policy đã chuẩn hoá. */
  set(patch: Partial<V9SleepPolicy>): V9SleepPolicy {
    const next = normalizeV9SleepPolicy({ ...this.get(), ...patch });
    this.policy = next;
    if (this.filePath) {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
      const payload: V9SleepPolicyFile = { version: 1, policy: next };
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    }
    return normalizeV9SleepPolicy(next);
  }
}

/* ------------------------------------------------------------------ */
/* Run log (JSONL append-only)                                        */
/* ------------------------------------------------------------------ */

/** Đọc run log sleep v9 (cũ nhất trước, tối đa `limit` dòng cuối). */
export function readV9SleepRunLog(workspaceDir: string, limit = V9_SLEEP_RUN_LOG_KEEP): V9SleepRunLogEntry[] {
  const filePath = path.join(workspaceDir, V9_SLEEP_RUN_LOG_REL_PATH);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const out: V9SleepRunLogEntry[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as V9SleepRunLogEntry;
      if (parsed && typeof parsed.id === 'string' && typeof parsed.status === 'string') out.push(parsed);
    } catch {
      // Dòng hỏng — bỏ qua.
    }
  }
  return out.slice(-Math.max(1, Math.min(1000, limit)));
}

/** Append một job đã kết thúc vào run log (giữ tối đa 200 dòng gần nhất). */
export function appendV9SleepRunLog(workspaceDir: string, job: V9SleepJob): void {
  const filePath = path.join(workspaceDir, V9_SLEEP_RUN_LOG_REL_PATH);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(job)}\n`, { mode: 0o600 });
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    if (lines.length > V9_RUN_LOG_PRUNE_AT) {
      const kept = lines.slice(-V9_SLEEP_RUN_LOG_KEEP);
      const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, `${kept.join('\n')}\n`, { mode: 0o600 });
      fs.renameSync(tmp, filePath);
    }
  } catch {
    // Prune lỗi thì thôi — log vẫn còn nguyên.
  }
  try {
    const latestPath = path.join(workspaceDir, V9_SLEEP_LATEST_REL_PATH);
    const tmp = `${latestPath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(job, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, latestPath);
  } catch {
    // Latest lỗi thì thôi.
  }
}

/** Đếm số lần chạy THẬT trong ngày (giờ địa phương, dry-run không tính). */
export function countV9SleepRunsToday(workspaceDir: string, now = new Date()): number {
  const runs = readV9SleepRunLog(workspaceDir, V9_SLEEP_RUN_LOG_KEEP);
  const day = now.toDateString();
  return runs.filter(
    (r) => !r.dryRun && r.finishedAt && new Date(r.finishedAt).toDateString() === day,
  ).length;
}

/** Lần chạy gần nhất trong log (null khi chưa có). */
export function lastV9SleepRun(workspaceDir: string): V9SleepRunLogEntry | null {
  const runs = readV9SleepRunLog(workspaceDir, 1);
  return runs.length > 0 ? (runs[runs.length - 1] as V9SleepRunLogEntry) : null;
}

/* ------------------------------------------------------------------ */
/* Daemon                                                             */
/* ------------------------------------------------------------------ */

/** Tuỳ chọn daemon sleep v9. */
export interface SleepV9AgentOptions {
  /** Thư mục workspace (policy + run log + projection block live ở đây). */
  workspaceDir: string;
  /** Bot mà daemon phục vụ (mặc định 'default'). */
  botId?: string;
  /** Store v6 (mặc định tạo mới từ workspace). */
  store?: V6RecordStore;
  /** Projection block v7 (mặc định tạo mới từ workspace). */
  projection?: GitMemoryProjection;
  /** Policy store riêng (mặc định file trong workspace; test dùng inMemory). */
  policyStore?: V9SleepPolicyStore;
  /** Version store riêng (mặc định tạo mới từ workspace). */
  versionStore?: MemoryV9VersionStore;
  /** Callback sau mỗi job kết thúc (để host log/UI). */
  onJob?: (job: V9SleepJob) => void;
}

/**
 * Daemon sleep-time compute v9: chạy nền giữa các session.
 *
 *  - `start()` bật interval kiểm tra trigger; `stop()` dừng hẳn.
 *  - `noteActivity()` host gọi mỗi khi có hoạt động (reset đồng hồ rảnh).
 *  - `noteSessionStart/noteTurn/noteSessionEnd` theo dõi session;
 *    khi session kết thúc và đủ điều kiện thì xếp một job session-end.
 *  - `tick()` một nhịp kiểm tra: idle / scheduled / xả hàng đợi
 *    session-end (tôn trọng enabled, giờ yên lặng, cooldown, giới
 *    hạn ngày). `runJobNow()` chạy một job ngay (bỏ qua trigger,
 *    vẫn tôn trọng maxJobMs; chạy tay thì chạy cả trong giờ yên lặng).
 *  - Không bao giờ chạy 2 job chồng nhau (`running` guard).
 */
export class SleepV9Agent {
  private readonly workspaceDir: string;
  private readonly botId: string;
  private readonly store: V6RecordStore;
  private readonly projection: GitMemoryProjection;
  private readonly policyStore: V9SleepPolicyStore;
  private readonly versionStore: MemoryV9VersionStore;
  private readonly onJob: ((job: V9SleepJob) => void) | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  private runningJob: V9SleepJob | null = null;
  private queue: V9SleepJob[] = [];
  private sessions = new Map<string, V9TrackedSession>();
  private lastActivityAt = Date.now();
  private totalRuns = 0;
  private lastRunValue: V9SleepRunLogEntry | null = null;

  constructor(opts: SleepV9AgentOptions) {
    this.workspaceDir = opts.workspaceDir;
    this.botId = opts.botId ?? 'default';
    this.store = opts.store ?? V6RecordStoreClass.fromWorkspace(opts.workspaceDir);
    this.projection = opts.projection ?? new GitMemoryProjectionClass(opts.workspaceDir);
    this.policyStore = opts.policyStore ?? V9SleepPolicyStore.fromWorkspace(opts.workspaceDir);
    this.versionStore = opts.versionStore ?? new MemoryV9VersionStore(opts.workspaceDir);
    this.onJob = opts.onJob;
    try {
      this.lastRunValue = lastV9SleepRun(opts.workspaceDir);
    } catch {
      this.lastRunValue = null;
    }
  }

  /* ---------------- policy ---------------- */

  /** Policy hiện tại (bản sao). */
  getPolicy(): V9SleepPolicy {
    return this.policyStore.get();
  }

  /** Đổi policy (ghi bền). */
  setPolicy(patch: Partial<V9SleepPolicy>): V9SleepPolicy {
    return this.policyStore.set(patch);
  }

  /** Bật/tắt sleep compute (ghi bền vào policy). */
  setEnabled(enabled: boolean): void {
    this.setPolicy({ enabled });
  }

  /** Sleep compute có đang bật không. */
  get enabled(): boolean {
    return this.policyStore.get().enabled;
  }

  /** Daemon có đang chạy interval không. */
  get started(): boolean {
    return this.timer !== null;
  }

  /** Có đang chạy một job không. */
  get isRunning(): boolean {
    return this.runningJob !== null;
  }

  /** Job đang chạy (null khi không có). */
  get runningJobInfo(): V9SleepJob | null {
    return this.runningJob;
  }

  /** Số job đang xếp hàng. */
  get queuedCount(): number {
    return this.queue.length;
  }

  /** Tổng số job đã chạy (trong tiến trình này). */
  get totalJobsRun(): number {
    return this.totalRuns;
  }

  /** Job gần nhất (trong tiến trình này hoặc từ log trên đĩa). */
  get lastRun(): V9SleepRunLogEntry | null {
    return this.lastRunValue;
  }

  /** Bật interval kiểm tra trigger (gọi 1 lần; gọi lại không tạo thêm timer). */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        // Tick lỗi không bao giờ làm chết daemon.
      });
    }, this.policyStore.get().checkIntervalMs);
    if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
  }

  /** Dừng interval (không huỷ job đang chạy). */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /* ---------------- activity + session tracking ---------------- */

  /** Ghi nhận hoạt động (user/bot vừa nhắn) — reset đồng hồ rảnh. */
  noteActivity(): void {
    this.lastActivityAt = Date.now();
  }

  /** Bắt đầu theo dõi một session (idempotent — session đã có thì giữ nguyên). */
  noteSessionStart(sessionId: string, botId?: string): V9TrackedSession {
    const id = (sessionId ?? '').trim() || 'default';
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const session: V9TrackedSession = {
      sessionId: id,
      botId: botId ?? this.botId,
      startedAt: new Date().toISOString(),
      turns: 0,
      episodes: [],
    };
    this.sessions.set(id, session);
    return session;
  }

  /** Ghi nhận một turn trong session (để trích fact khi session kết thúc). */
  noteTurn(sessionId: string, role: 'user' | 'bot', text: string): void {
    const session = this.sessions.get((sessionId ?? '').trim() || 'default') ?? this.noteSessionStart(sessionId);
    session.turns += 1;
    if (session.episodes.length < V9_MAX_EPISODES_PER_SESSION) {
      session.episodes.push({
        id: `ep-${session.turns}-${Date.now()}`,
        role,
        text: (text ?? '').slice(0, V9_MAX_EPISODE_CHARS),
        at: new Date().toISOString(),
      });
    }
    this.noteActivity();
  }

  /**
   * Kết thúc một session: nếu session đủ điều kiện (đủ turn + đủ
   * dài) và policy cho phép trigger session-end thì xếp một job.
   * Trả về { queued, reason } — không throw.
   */
  noteSessionEnd(
    sessionId: string,
    opts: { episodes?: SleepEpisode[] } = {},
  ): { queued: boolean; jobId: string | null; reason: string } {
    const id = (sessionId ?? '').trim() || 'default';
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    const policy = this.policyStore.get();
    if (!session) {
      return { queued: false, jobId: null, reason: `Không theo dõi session "${id}" (chưa noteSessionStart).` };
    }
    session.endedAt = new Date().toISOString();
    const durationMin = (Date.parse(session.endedAt) - Date.parse(session.startedAt)) / 60000;
    if (!policy.enabled) {
      return { queued: false, jobId: null, reason: 'Sleep v9 đang tắt.' };
    }
    if (!policy.triggers.sessionEnd) {
      return { queued: false, jobId: null, reason: 'Trigger session-end đang tắt trong policy.' };
    }
    if (session.turns < policy.sessionMinTurns) {
      return {
        queued: false,
        jobId: null,
        reason: `Session "${id}" chỉ có ${session.turns} turn (cần >= ${policy.sessionMinTurns}).`,
      };
    }
    if (durationMin < policy.sessionMinMinutes) {
      return {
        queued: false,
        jobId: null,
        reason: `Session "${id}" chỉ dài ${durationMin.toFixed(1)} phút (cần >= ${policy.sessionMinMinutes}).`,
      };
    }
    const episodes = opts.episodes ?? session.episodes;
    const job = this.newJob('session-end', { sessionId: id, episodes });
    this.queue.push(job);
    return { queued: true, jobId: job.id, reason: `Đã xếp job session-end cho session "${id}".` };
  }

  /* ---------------- status ---------------- */

  /** Trạng thái daemon (policy + job + lần chạy gần nhất + giờ hẹn kế tiếp). */
  getStatus(): V9SleepAgentStatus {
    const policy = this.policyStore.get();
    return {
      enabled: policy.enabled,
      started: this.timer !== null,
      runningJobId: this.runningJob ? this.runningJob.id : null,
      queuedJobs: this.queue.length,
      trackedSessions: this.sessions.size,
      totalRuns: this.totalRuns,
      runsToday: countV9SleepRunsToday(this.workspaceDir),
      lastRun: this.lastRunValue,
      nextScheduledRunAt: this.nextScheduledRunAt(policy),
      policy,
    };
  }

  /** Lần chạy theo giờ hẹn kế tiếp (null khi trigger scheduled tắt hoặc chưa hẹn giờ). */
  nextScheduledRunAt(policy: V9SleepPolicy = this.policyStore.get()): string | null {
    if (!policy.triggers.scheduled || policy.scheduledHour === null) return null;
    const now = new Date();
    const next = new Date(now);
    next.setHours(policy.scheduledHour, policy.scheduledMinute, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }

  /** Run log gần đây (mới nhất cuối mảng). */
  readLog(limit = 20): V9SleepRunLogEntry[] {
    return readV9SleepRunLog(this.workspaceDir, limit);
  }

  /* ---------------- tick: trigger tự động ---------------- */

  /**
   * Một nhịp kiểm tra trigger tự động. Trả về job đã chạy (hoặc
   * null khi không đủ điều kiện). Không throw.
   */
  async tick(now = new Date()): Promise<V9SleepJob | null> {
    try {
      const policy = this.policyStore.get();
      if (!policy.enabled || this.runningJob !== null) return null;
      if (isInV9QuietHours(policy, now)) return null;
      if (this.cooldownActive(policy, now)) return null;
      if (this.dailyBudgetReached(policy, now)) return null;

      // 1. Xả hàng đợi session-end trước (job do noteSessionEnd xếp).
      const queued = this.queue.shift();
      if (queued) return this.executeJob(queued);

      // 2. Trigger scheduled: tới giờ hẹn và hôm nay chưa chạy lần nào theo giờ hẹn.
      if (policy.triggers.scheduled && policy.scheduledHour !== null && this.isScheduledDue(policy, now)) {
        return this.executeJob(this.newJob('scheduled'));
      }

      // 3. Trigger idle: rảnh đủ lâu.
      if (policy.triggers.idle && Date.now() - this.lastActivityAt >= policy.idleMs) {
        return this.executeJob(this.newJob('idle'));
      }
      return null;
    } catch {
      return null;
    }
  }

  private cooldownActive(policy: V9SleepPolicy, now: Date): boolean {
    if (policy.cooldownMs <= 0) return false;
    const last = this.lastRunValue;
    if (!last || !last.finishedAt) return false;
    return now.getTime() - Date.parse(last.finishedAt) < policy.cooldownMs;
  }

  private dailyBudgetReached(policy: V9SleepPolicy, now: Date): boolean {
    if (policy.maxRunsPerDay <= 0) return false;
    return countV9SleepRunsToday(this.workspaceDir, now) >= policy.maxRunsPerDay;
  }

  private isScheduledDue(policy: V9SleepPolicy, now: Date): boolean {
    if (policy.scheduledHour === null) return false;
    const due = new Date(now);
    due.setHours(policy.scheduledHour, policy.scheduledMinute, 0, 0);
    if (now.getTime() < due.getTime()) return false;
    // Hôm nay đã chạy scheduled rồi thì thôi (tránh chạy lặp mỗi tick).
    const runs = readV9SleepRunLog(this.workspaceDir, V9_SLEEP_RUN_LOG_KEEP);
    const day = now.toDateString();
    return !runs.some(
      (r) => r.trigger === 'scheduled' && !r.dryRun && r.finishedAt && new Date(r.finishedAt).toDateString() === day,
    );
  }

  /* ---------------- chạy job ---------------- */

  /**
   * Chạy một job ngay (bỏ qua trigger, cooldown, giờ yên lặng,
   * giới hạn ngày — chạy tay là tường minh). Trả null khi đang có
   * job khác chạy. Không throw (lỗi ghi vào job).
   */
  async runJobNow(opts: {
    trigger?: V9SleepTrigger;
    sessionId?: string;
    episodes?: SleepEpisode[];
    dryRun?: boolean;
    providerId?: string;
    providerKind?: string;
  } = {}): Promise<V9SleepJob | null> {
    if (this.runningJob !== null) return null;
    const job = this.newJob(opts.trigger ?? 'manual', {
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.episodes ? { episodes: opts.episodes } : {}),
      ...(opts.dryRun === true ? { dryRun: true } : {}),
    });
    return this.executeJob(job, {
      ...(opts.providerId ? { providerId: opts.providerId } : {}),
      ...(opts.providerKind ? { providerKind: opts.providerKind } : {}),
    });
  }

  /** Huỷ job đang xếp hàng (không huỷ job đang chạy). Trả true khi huỷ được. */
  cancelQueuedJob(jobId: string): boolean {
    const idx = this.queue.findIndex((j) => j.id === jobId);
    if (idx === -1) return false;
    const [job] = this.queue.splice(idx, 1) as [V9SleepJob];
    job.status = 'cancelled';
    job.finishedAt = new Date().toISOString();
    job.reason = 'Huỷ bởi user/host trước khi chạy.';
    this.finishJob(job);
    return true;
  }

  private newJob(
    trigger: V9SleepTrigger,
    opts: { sessionId?: string; episodes?: SleepEpisode[]; dryRun?: boolean } = {},
  ): V9SleepJob {
    const job: V9SleepJob = {
      id: randomUUID(),
      trigger,
      botId: this.botId,
      status: 'queued',
      dryRun: opts.dryRun === true,
      createdAt: new Date().toISOString(),
      steps: [],
      counts: emptyV9SleepJobCounts(),
      errors: [],
    };
    if (opts.sessionId) job.sessionId = opts.sessionId;
    // Episodes gắn tạm vào job qua closure — lưu riêng, không đưa vào log.
    if (opts.episodes) (job as unknown as { __episodes: SleepEpisode[] }).__episodes = opts.episodes;
    return job;
  }

  private jobEpisodes(job: V9SleepJob): SleepEpisode[] {
    return (job as unknown as { __episodes?: SleepEpisode[] }).__episodes ?? [];
  }

  private finishJob(job: V9SleepJob): void {
    this.totalRuns += 1;
    this.lastRunValue = job;
    try {
      appendV9SleepRunLog(this.workspaceDir, job);
    } catch {
      // Ghi log lỗi không fail job.
    }
    this.onJob?.(job);
  }

  private jobTimedOut(job: V9SleepJob, startedAtMs: number, policy: V9SleepPolicy): boolean {
    return Date.now() - startedAtMs >= policy.maxJobMs;
  }

  private async executeJob(
    job: V9SleepJob,
    opts: { providerId?: string; providerKind?: string } = {},
  ): Promise<V9SleepJob> {
    const policy = this.policyStore.get();
    const startedAtMs = Date.now();
    job.status = 'running';
    job.startedAt = new Date(startedAtMs).toISOString();
    this.runningJob = job;
    try {
      // Chụp version block trước khi chạy (để bước snapshot biết block nào đã đổi).
      const versionsBefore = new Map<string, number>();
      try {
        for (const b of this.projection.list()) versionsBefore.set(b.label, b.version);
      } catch {
        // Projection lỗi thì bước snapshot sẽ báo, job vẫn chạy tiếp.
      }

      // Bước 1 — consolidation v8 (bản ghi + nén block). Tái dùng
      // SleepV8Scheduler, không viết lại logic dedupe/nén.
      if (policy.steps.consolidateV8) {
        const stepStarted = Date.now();
        try {
          const scheduler = new SleepV8Scheduler({
            store: this.store,
            workspaceDir: this.workspaceDir,
            projection: this.projection,
          });
          const report = await scheduler.runNow({ ...(job.dryRun ? { dryRun: true } : {}) });
          if (report) {
            job.counts.recordsExamined += report.v6.examined;
            job.counts.recordsDeduped += report.v6.dedupedExact + report.v6.dedupedNear;
            job.counts.recordsSummarized += report.v6.summarizedClusters;
            job.counts.recordsQuarantined += report.v6.quarantined;
            job.counts.blocksCompressed += report.blocksCompressed;
            job.counts.summaryBlocksCreated += report.summaryBlocksCreated;
            for (const e of report.errors) job.errors.push(`consolidate-v8: ${e}`);
            job.steps.push({
              step: 'consolidate-v8',
              ok: true,
              detail: `xem ${report.v6.examined} bản ghi, dedupe ${report.v6.dedupedExact + report.v6.dedupedNear}, tóm tắt ${report.v6.summarizedClusters} cụm, nén ${report.blocksCompressed} block.`,
              ms: Date.now() - stepStarted,
            });
          } else {
            job.steps.push({
              step: 'consolidate-v8',
              ok: false,
              detail: 'Scheduler v8 đang bận (một lần chạy khác đang diễn ra).',
              ms: Date.now() - stepStarted,
            });
          }
        } catch (err) {
          job.errors.push(`consolidate-v8: ${(err as Error).message}`);
          job.steps.push({
            step: 'consolidate-v8',
            ok: false,
            detail: `Lỗi: ${(err as Error).message}`,
            ms: Date.now() - stepStarted,
          });
        }
      }

      // Bước 2 — trích fact từ transcript (SleepTimeAgent v0.97).
      // Dùng trigger 'manual' để không đụng config bền của agent cũ;
      // trigger thật của job v9 ghi trong detail.
      if (policy.steps.extractFacts) {
        const stepStarted = Date.now();
        const episodes = this.jobEpisodes(job);
        if (episodes.length === 0) {
          job.steps.push({
            step: 'extract-facts',
            ok: true,
            detail: 'Không có episode để trích xuất (job không gắn transcript).',
            ms: Date.now() - stepStarted,
          });
        } else if (this.jobTimedOut(job, startedAtMs, policy)) {
          job.steps.push({
            step: 'extract-facts',
            ok: false,
            detail: 'Bỏ qua: job đã quá maxJobMs.',
            ms: Date.now() - stepStarted,
          });
        } else {
          try {
            const inner = new SleepTimeAgent(this.workspaceDir, this.botId);
            const report = await inner.run({
              episodes,
              trigger: 'manual',
              ...(opts.providerId ? { providerId: opts.providerId } : {}),
              ...(opts.providerKind ? { providerKind: opts.providerKind } : {}),
            });
            job.counts.factsExtracted += report.factsExtracted;
            job.counts.factsStored += report.factsStored;
            job.counts.factsFlagged += report.factsFlagged;
            for (const d of report.details) job.errors.push(`extract-facts: ${d}`);
            job.steps.push({
              step: 'extract-facts',
              ok: true,
              detail: `trigger v9=${job.trigger}: xem ${report.episodesExamined} episode, trích ${report.factsExtracted} fact, lưu ${report.factsStored}, flag ${report.factsFlagged}, mâu thuẫn ${report.contradictionsFound}.`,
              ms: Date.now() - stepStarted,
            });
          } catch (err) {
            job.errors.push(`extract-facts: ${(err as Error).message}`);
            job.steps.push({
              step: 'extract-facts',
              ok: false,
              detail: `Lỗi: ${(err as Error).message}`,
              ms: Date.now() - stepStarted,
            });
          }
        }
      }

      // Bước 3 — snapshot các block đã đổi trong lần chạy.
      if (policy.steps.snapshotBlocks && !job.dryRun) {
        const stepStarted = Date.now();
        if (this.jobTimedOut(job, startedAtMs, policy)) {
          job.steps.push({
            step: 'snapshot-blocks',
            ok: false,
            detail: 'Bỏ qua: job đã quá maxJobMs.',
            ms: Date.now() - stepStarted,
          });
        } else {
          try {
            let created = 0;
            for (const b of this.projection.list()) {
              const before = versionsBefore.get(b.label);
              if (before !== undefined && b.version !== before) {
                this.versionStore.snapshot(b.label, `sleep run ${job.id} (${job.trigger})`, V9_SLEEP_ACTOR);
                created += 1;
              }
            }
            job.counts.snapshotsCreated += created;
            job.steps.push({
              step: 'snapshot-blocks',
              ok: true,
              detail: `Snapshot ${created} block đã đổi trong lần chạy.`,
              ms: Date.now() - stepStarted,
            });
          } catch (err) {
            job.errors.push(`snapshot-blocks: ${(err as Error).message}`);
            job.steps.push({
              step: 'snapshot-blocks',
              ok: false,
              detail: `Lỗi: ${(err as Error).message}`,
              ms: Date.now() - stepStarted,
            });
          }
        }
      }

      job.status = 'done';
      if (this.jobTimedOut(job, startedAtMs, policy)) {
        job.errors.push(`Job chạy ${Date.now() - startedAtMs}ms, quá maxJobMs ${policy.maxJobMs}ms (partial — một số bước đã bị bỏ qua).`);
      }
    } catch (err) {
      job.status = 'failed';
      job.errors.push(`Job lỗi: ${(err as Error).message}`);
    } finally {
      const finishedAtMs = Date.now();
      job.finishedAt = new Date(finishedAtMs).toISOString();
      job.durationMs = finishedAtMs - startedAtMs;
      this.runningJob = null;
      this.finishJob(job);
    }
    return job;
  }
}
