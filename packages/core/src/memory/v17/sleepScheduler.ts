/**
 * Memory v17 — Sleep-time compute scheduler v2 (v1.18, Doi T1).
 *
 * Y tuong hoc tu Letta/MemGPT (sleep-time agents: agent nen chay
 * NGOAI vong lap chinh, luc idle — trigger sau N buoc hoac khi
 * context bi compact; co the dung model manh hon vi khong nam tren
 * duong dan tra loi user) — tu thiet ke lai hoan toan cho open-bot,
 * chay 100% local, KHONG copy code/text/tai san cua bat ky repo nao.
 *
 * Ke thua, khong viet lai:
 *  - `V16SleepConsolidationAgent` / `V16SleepConfig` /
 *    `V16_DEFAULT_SLEEP_CONFIG` cua memory/v16/sleepConsolidation:
 *    agent nen v2 (trich fact -> gate -> 4-op -> promote, trigger
 *    turns/compact/manual, budget, fail-open); v17 la lop LICH
 *    ben tren, KHONG chay lai pipeline.
 *  - `runSleepReorganizeV15` cua memoryV15: reorganize block luc
 *    idle; v17 goi sau moi lan sleep chay xong (neu host cap
 *    blockStore) de block khong phi.
 *
 * Moi trong v17:
 *  1. Lich chay theo gio: `intervalMs` (mac dinh 2 gio), gio yen
 *     lang `quietHours` (khong chay trong khoang nay — vd dem),
 *     `maxRunsPerDay` (chan chay qua nhieu), `cooldownMs` toi
 *     thieu giua 2 lan chay.
 *  2. `nextRunAtV17` — ham thuan tuy tinh lan chay ke tiep tu
 *     config + state + thoi diem hien tai (de test xac dinh, de
 *     UI hien thi "lan chay ke tiep luc ...").
 *  3. `V17SleepScheduler`: boc agent v16; `tick(now)` — host goi
 *     dinh ky (vd moi phut): chay neu den lich, bo qua neu dang
 *     trong quiet hours / vuot maxRunsPerDay / chua het cooldown;
 *     `runOnCompactV17` — chay ngay khi context bi compact (uu
 *     tien hon lich, nhung van ton trong quiet hours neu bat
 *     `respectQuietHoursOnCompact`); backoff khi run loi (gap doi
 *     khoang cho lan sau, toi da `maxBackoffMs`).
 *  4. State luu file JSON (lan chay cuoi, so lan chay hom nay,
 *     so loi lien tiep, lan chay ke tiep) de resume sau restart
 *     ma khong chay bu lai hang loat.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { MemoryScope } from '../graph/types';
import type { TemporalGraphStore } from '../graph/store';
import { runSleepReorganizeV15 } from '../../memoryV15/blocks';
import type { V15BlockStore } from '../../memoryV15/blocks';
import {
  V16SleepConsolidationAgent,
  V16_DEFAULT_SLEEP_CONFIG,
} from '../v16/sleepConsolidation';
import type { V16SleepConfig, V16SleepRunReport } from '../v16/sleepConsolidation';
import type { V16BlockAdapter } from '../v16/corePromotion';

/** Loi sleep scheduler v17 — message tieng Viet. */
export class V17SleepSchedulerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V17SleepSchedulerError';
  }
}

/** Khoang gio yen lang (gio local 0..23, end co the <= start = qua dem). */
export interface V17QuietHours {
  /** Gio bat dau (0..23). */
  startHour: number;
  /** Gio ket thuc (0..23). */
  endHour: number;
}

/** Cau hinh lich sleep v17. */
export interface V17SleepScheduleConfig {
  /** Bat/tat lich chay (mac dinh TAT — user bat trong Settings). */
  enabled: boolean;
  /** Khoang cach giua 2 lan chay dinh ky (ms, mac dinh 2 gio). */
  intervalMs: number;
  /** Thoi gian cho toi thieu giua 2 lan chay bat ky (ms, mac dinh 5 phut). */
  cooldownMs: number;
  /** So lan chay dinh ky toi da moi ngay (mac dinh 12). */
  maxRunsPerDay: number;
  /** Gio yen lang — khong chay dinh ky trong khoang nay (null = khong co). */
  quietHours: V17QuietHours | null;
  /** true = ca chay khi compact cung ton trong quiet hours (mac dinh true). */
  respectQuietHoursOnCompact: boolean;
  /** Backoff toi da sau loi lien tiep (ms, mac dinh 1 gio). */
  maxBackoffMs: number;
  /** Config agent nen v16 ben trong (afterTurns/cooldown/...). */
  agentConfig?: Partial<V16SleepConfig>;
}

export const V17_DEFAULT_SLEEP_SCHEDULE_CONFIG: V17SleepScheduleConfig = {
  enabled: false,
  intervalMs: 2 * 60 * 60 * 1000,
  cooldownMs: 5 * 60 * 1000,
  maxRunsPerDay: 12,
  quietHours: null,
  respectQuietHoursOnCompact: true,
  maxBackoffMs: 60 * 60 * 1000,
};

/** State lich sleep v17 (luu file). */
export interface V17SleepScheduleState {
  version: 1;
  /** ISO lan chay dinh ky thanh cong cuoi (ke ca compact/manual). */
  lastRunAt: string | null;
  /** ISO lan chay ke tiep du kien (null = chua tinh). */
  nextRunAt: string | null;
  /** Ngay (YYYY-MM-DD, gio local) cua dem runsToday. */
  dayKey: string;
  /** So lan chay trong ngay hien tai. */
  runsToday: number;
  /** So lan chay loi lien tiep (de backoff). */
  consecutiveFailures: number;
  /** Tong so lan chay thanh cong. */
  totalRuns: number;
  updatedAt: string;
}

/** Ly do scheduler quyet dinh chay hay khong (de UI/log). */
export type V17ScheduleDecision =
  | { run: true; reason: string }
  | { run: false; reason: string };

function nowIsoV17(date = new Date()): string {
  return date.toISOString();
}

function dayKeyV17(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Validate quiet hours (gio 0..23, so nguyen). */
export function validateQuietHoursV17(q: V17QuietHours): void {
  for (const h of [q.startHour, q.endHour]) {
    if (!Number.isInteger(h) || h < 0 || h > 23) {
      throw new V17SleepSchedulerError('Gio yen lang phai la so nguyen 0..23.');
    }
  }
}

/** true = thoi diem `at` dang trong khoang yen lang. */
export function isInQuietHoursV17(q: V17QuietHours | null, at: Date): boolean {
  if (!q) return false;
  const h = at.getHours();
  if (q.startHour === q.endHour) return false; // Khoang rong.
  if (q.startHour < q.endHour) return h >= q.startHour && h < q.endHour;
  // Qua dem: vd 23h -> 7h.
  return h >= q.startHour || h < q.endHour;
}

/** Gio ket thuc quiet hours gan nhat SAU `at` (de tinh lan chay ke). */
export function endOfQuietHoursV17(q: V17QuietHours, at: Date): Date {
  const end = new Date(at);
  end.setHours(q.endHour, 0, 0, 0);
  if (end.getTime() <= at.getTime()) end.setDate(end.getDate() + 1);
  return end;
}

/** State mac dinh (chua chay lan nao). */
export function defaultV17SleepScheduleState(now = new Date()): V17SleepScheduleState {
  return {
    version: 1,
    lastRunAt: null,
    nextRunAt: null,
    dayKey: dayKeyV17(now),
    runsToday: 0,
    consecutiveFailures: 0,
    totalRuns: 0,
    updatedAt: nowIsoV17(now),
  };
}

/**
 * Tinh lan chay ke tiep (ham thuan tuy, de test xac dinh):
 *  - Chua chay bao gio -> chay ngay (now) neu khong phai quiet
 *    hours, neu khong thi het quiet hours.
 *  - Da chay -> lastRunAt + interval (cong backoff neu loi lien
 *    tiep: gap doi moi loi, toi da maxBackoffMs); neu roi vao
 *    quiet hours thi doi den het quiet hours; neu qua ngay moi
 *    thi reset runsToday (khong anh huong nextRunAt).
 *  - Vuot maxRunsPerDay thi doi sang 00:00 ngay hom sau.
 */
export function nextRunAtV17(
  config: V17SleepScheduleConfig,
  state: V17SleepScheduleState,
  now = new Date(),
): Date {
  let candidate: Date;
  if (!state.lastRunAt) {
    candidate = new Date(now);
  } else {
    const lastMs = Date.parse(state.lastRunAt);
    const backoff = Math.min(
      config.maxBackoffMs,
      config.cooldownMs * Math.pow(2, Math.max(0, state.consecutiveFailures - 1)),
    );
    const gap = Math.max(config.intervalMs, config.cooldownMs, backoff);
    candidate = new Date((Number.isNaN(lastMs) ? now.getTime() : lastMs) + gap);
    if (candidate.getTime() < now.getTime()) candidate = new Date(now);
  }
  if (config.quietHours && isInQuietHoursV17(config.quietHours, candidate)) {
    candidate = endOfQuietHoursV17(config.quietHours, candidate);
  }
  const todayKey = dayKeyV17(now);
  const runsToday = state.dayKey === todayKey ? state.runsToday : 0;
  if (runsToday >= config.maxRunsPerDay) {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    if (tomorrow.getTime() > candidate.getTime()) candidate = tomorrow;
    if (config.quietHours && isInQuietHoursV17(config.quietHours, candidate)) {
      candidate = endOfQuietHoursV17(config.quietHours, candidate);
    }
  }
  return candidate;
}

/** Quyet dinh co chay dinh ky luc `now` khong (thuan tuy). */
export function shouldRunScheduledV17(
  config: V17SleepScheduleConfig,
  state: V17SleepScheduleState,
  now = new Date(),
): V17ScheduleDecision {
  if (!config.enabled) return { run: false, reason: 'Lich sleep dang tat (enabled=false).' };
  if (config.quietHours && isInQuietHoursV17(config.quietHours, now)) {
    return { run: false, reason: `Dang trong gio yen lang (${config.quietHours.startHour}h–${config.quietHours.endHour}h) — doi het gio yen lang.` };
  }
  const todayKey = dayKeyV17(now);
  const runsToday = state.dayKey === todayKey ? state.runsToday : 0;
  if (runsToday >= config.maxRunsPerDay) {
    return { run: false, reason: `Da chay ${runsToday}/${config.maxRunsPerDay} lan trong ngay — doi sang ngay mai.` };
  }
  const next = nextRunAtV17(config, state, now);
  if (now.getTime() < next.getTime()) {
    return { run: false, reason: `Chua den lich (lan chay ke tiep: ${next.toISOString()}).` };
  }
  return { run: true, reason: 'Den lich chay dinh ky.' };
}

/** Duong dan file state lich sleep v17 (tuong doi workspace). */
export const V17_SLEEP_SCHEDULE_STATE_REL_PATH = path.join('.open-bot', 'memory-v17-sleep-schedule.json');
/** Duong dan file run log lich sleep v17 (tuong doi workspace). */
export const V17_SLEEP_SCHEDULE_RUNS_REL_PATH = path.join('.open-bot', 'memory-v17-sleep-schedule-runs.jsonl');

/** Doc state lich sleep v17 tu workspace (khong co file -> mac dinh). */
export function loadV17SleepScheduleState(workspaceDir: string): V17SleepScheduleState {
  try {
    const filePath = path.join(workspaceDir, V17_SLEEP_SCHEDULE_STATE_REL_PATH);
    if (!fs.existsSync(filePath)) return defaultV17SleepScheduleState();
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<V17SleepScheduleState>;
    if (parsed.version !== 1) return defaultV17SleepScheduleState();
    return {
      version: 1,
      lastRunAt: parsed.lastRunAt ?? null,
      nextRunAt: parsed.nextRunAt ?? null,
      dayKey: parsed.dayKey ?? dayKeyV17(new Date()),
      runsToday: Math.max(0, parsed.runsToday ?? 0),
      consecutiveFailures: Math.max(0, parsed.consecutiveFailures ?? 0),
      totalRuns: Math.max(0, parsed.totalRuns ?? 0),
      updatedAt: parsed.updatedAt ?? nowIsoV17(),
    };
  } catch {
    return defaultV17SleepScheduleState();
  }
}

/** Ghi state lich sleep v17 xuong workspace (best-effort). */
export function saveV17SleepScheduleState(workspaceDir: string, state: V17SleepScheduleState): void {
  try {
    const filePath = path.join(workspaceDir, V17_SLEEP_SCHEDULE_STATE_REL_PATH);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify({ ...state, updatedAt: nowIsoV17() }, null, 2)}\n`, 'utf8');
  } catch {
    // State best-effort.
  }
}

/** Ghi mot run log lich sleep (append-only JSONL, best-effort). */
export function appendV17SleepScheduleRunLog(
  workspaceDir: string,
  entry: { at: string; trigger: string; ran: boolean; reason: string; episodesProcessed?: number },
): void {
  try {
    const filePath = path.join(workspaceDir, V17_SLEEP_SCHEDULE_RUNS_REL_PATH);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Run log best-effort.
  }
}

/** Tuy chon chay cua scheduler. */
export interface V17SleepSchedulerOptions {
  blocks?: V16BlockAdapter | null;
  /** Block store v15 de reorganize sau khi sleep chay xong. */
  blockStore?: V15BlockStore | null;
}

/**
 * Sleep scheduler v17 — boc V16SleepConsolidationAgent + lich chay.
 * Host giu mot instance moi bot, goi `tick()` dinh ky (vd moi
 * phut) va `runOnCompact()` khi context bi compact. Tat ca phuong
 * thuc run deu fail-open: loi tong duoc ghi vao report, khong
 * throw ra caller (tru khi config tat — giong v16).
 */
export class V17SleepScheduler {
  private readonly agent: V16SleepConsolidationAgent;
  private readonly workspaceDir: string;
  private readonly scope: MemoryScope;
  private config: V17SleepScheduleConfig;
  private state: V17SleepScheduleState;

  constructor(
    store: TemporalGraphStore,
    workspaceDir: string,
    scope: MemoryScope,
    config: Partial<V17SleepScheduleConfig> = {},
  ) {
    this.workspaceDir = workspaceDir;
    this.scope = { ...scope };
    this.config = { ...V17_DEFAULT_SLEEP_SCHEDULE_CONFIG, ...config };
    if (this.config.quietHours) validateQuietHoursV17(this.config.quietHours);
    if (this.config.intervalMs < 60 * 1000) {
      throw new V17SleepSchedulerError('intervalMs toi thieu 1 phut (tranh chay lien tuc).');
    }
    if (this.config.maxRunsPerDay < 1) {
      throw new V17SleepSchedulerError('maxRunsPerDay toi thieu 1.');
    }
    this.state = loadV17SleepScheduleState(workspaceDir);
    this.agent = new V16SleepConsolidationAgent(store, workspaceDir, scope, {
      ...V16_DEFAULT_SLEEP_CONFIG,
      ...(config.agentConfig ?? {}),
      enabled: true,
    });
  }

  /** Config hien tai (ban sao). */
  getConfig(): V17SleepScheduleConfig {
    return { ...this.config, quietHours: this.config.quietHours ? { ...this.config.quietHours } : null };
  }

  /** Cap nhat config lich (khong ghi file — config do host quan ly). */
  updateConfig(patch: Partial<V17SleepScheduleConfig>): V17SleepScheduleConfig {
    const next = { ...this.config, ...patch };
    if (next.quietHours) validateQuietHoursV17(next.quietHours);
    this.config = next;
    return this.getConfig();
  }

  /** State hien tai (ban sao). */
  getState(): V17SleepScheduleState {
    return { ...this.state };
  }

  /** Lan chay ke tiep du kien (tinh tu state hien tai). */
  nextRunAt(now = new Date()): Date {
    return nextRunAtV17(this.config, this.state, now);
  }

  /** Quyet dinh co chay dinh ky luc `now` khong. */
  shouldRun(now = new Date()): V17ScheduleDecision {
    return shouldRunScheduledV17(this.config, this.state, now);
  }

  /** Dem turn cua agent v16 ben trong (de trigger turns van hoat dong). */
  noteTurn(opts: { blocks?: V16BlockAdapter | null } = {}): V16SleepRunReport | null {
    return this.agent.noteTurn(opts);
  }

  /**
   * Host goi dinh ky: chay neu den lich. Tra ve report neu chay,
   * null neu bo qua (kem ly do ghi vao run log file).
   */
  tick(opts: V17SleepSchedulerOptions = {}, now = new Date()): V16SleepRunReport | null {
    const decision = this.shouldRun(now);
    if (!decision.run) {
      appendV17SleepScheduleRunLog(this.workspaceDir, {
        at: now.toISOString(),
        trigger: 'scheduled',
        ran: false,
        reason: decision.reason,
      });
      return null;
    }
    return this.runOnce('scheduled', opts, now);
  }

  /** Chay ngay khi context bi compact (uu tien hon lich). */
  runOnCompact(opts: V17SleepSchedulerOptions = {}, now = new Date()): V16SleepRunReport | null {
    if (!this.config.enabled) return null;
    if (
      this.config.respectQuietHoursOnCompact &&
      this.config.quietHours &&
      isInQuietHoursV17(this.config.quietHours, now)
    ) {
      appendV17SleepScheduleRunLog(this.workspaceDir, {
        at: now.toISOString(),
        trigger: 'compact',
        ran: false,
        reason: 'Dang trong gio yen lang — bo qua lan chay khi compact.',
      });
      return null;
    }
    return this.runOnce('compact', opts, now);
  }

  /** Chay tay (tu Settings / lenh user) — khong bi lich chan. */
  runManual(opts: V17SleepSchedulerOptions = {}, now = new Date()): V16SleepRunReport {
    return this.runOnce('manual', opts, now);
  }

  private runOnce(
    trigger: 'scheduled' | 'compact' | 'manual',
    opts: V17SleepSchedulerOptions,
    now: Date,
  ): V16SleepRunReport {
    const report = this.agent.run({ trigger, blocks: opts.blocks ?? null, now });
    const todayKey = dayKeyV17(now);
    if (this.state.dayKey !== todayKey) {
      this.state.dayKey = todayKey;
      this.state.runsToday = 0;
    }
    if (report.error) {
      this.state.consecutiveFailures += 1;
    } else {
      this.state.consecutiveFailures = 0;
      this.state.totalRuns += 1;
      this.state.runsToday += 1;
    }
    this.state.lastRunAt = now.toISOString();
    this.state.nextRunAt = nextRunAtV17(this.config, this.state, now).toISOString();
    saveV17SleepScheduleState(this.workspaceDir, this.state);
    appendV17SleepScheduleRunLog(this.workspaceDir, {
      at: now.toISOString(),
      trigger,
      ran: true,
      reason: report.error ? `Chay loi: ${report.error}` : `Chay xong: ${report.episodesProcessed} episode, ${report.promoted} promote.`,
      episodesProcessed: report.episodesProcessed,
    });
    // Reorganize block luc idle sau khi sleep chay xong (neu host cap store).
    if (!report.error && opts.blockStore) {
      try {
        runSleepReorganizeV15(opts.blockStore, { force: true, actor: 'system:v17-sleep-scheduler' });
      } catch {
        // Reorganize loi thi bo qua — sleep chinh da xong.
      }
    }
    return report;
  }
}

/** Tien ich: tao scheduler v17 (de host khoi tao nhanh). */
export function createV17SleepScheduler(
  store: TemporalGraphStore,
  workspaceDir: string,
  scope: MemoryScope,
  config: Partial<V17SleepScheduleConfig> = {},
): V17SleepScheduler {
  return new V17SleepScheduler(store, workspaceDir, scope, config);
}
