/**
 * Memory v22 — Dream scheduler: khi nao thi dream chay
 * (v1.37, Doi T1).
 *
 * Y tuong (Letta dreaming: kich hoat sau N buoc agent hoac khi
 * compaction + Mem0 Dream job nen theo lich): dream chay ngoai
 * critical path, theo 3 kich hoat doc lap — lich (interval),
 * buoc (steps), compaction — cong voi chay tay va ap luc bo nho.
 * Scheduler CHI quyet dinh "da toi luc chay chua" (tra ve
 * trigger hoac null); viec chay dream do `V22Dreamer` lam.
 *
 * Quy tac:
 *  1. `enabled: false` thi khong bao gio tu chay (chi chay tay
 *     qua `forceDue` / goi truc tiep dreamer).
 *  2. Lich: `now - lastRunAt >= intervalMs` (lan dau: chay ngay
 *     khi `lastRunAt` chua co — host co the dat `lastRunAt =
 *     now` luc khoi tao de doi du interval).
 *  3. Buoc: moi buoc hoi thoai goi `noteStep()`; khi
 *     `stepsSinceRun >= stepsThreshold` thi toi luc dream.
 *  4. Compaction: `noteCompaction()` danh dau co compaction vua
 *     chay; lan `checkDue` ke tiep tra ve trigger `compaction`
 *     (chi khi `runOnCompaction` bat) va xoa co.
 *  5. Thu tu uu tien khi nhieu trigger cung toi luc: compaction
 *     > steps > scheduled (ly do: compaction la luc context vua
 *     duoc don, dream luc nay re nhat).
 *  6. Timer tuy chon: `start(onDue)` dung setInterval (unref —
 *     khong giu process song) goi lai `checkDue` dinh ky; `stop()`
 *     dung timer. Test dung `checkDue` truc tiep, khong can timer.
 */
import type { V22DreamConfig, V22DreamJobState, V22DreamReport, V22DreamTrigger } from './types';
import { V22_DREAM_DEFAULT_CONFIG, V22DreamError } from './types';

/** Kiem tra tinh hop le cua config (throw V22DreamError neu sai). */
export function validateDreamConfigV22(config: V22DreamConfig): void {
  if (typeof config.enabled !== 'boolean') {
    throw new V22DreamError('config.enabled phai la boolean.');
  }
  if (!Number.isFinite(config.intervalMs) || config.intervalMs <= 0) {
    throw new V22DreamError('config.intervalMs phai la so duong (ms).');
  }
  if (!Number.isFinite(config.stepsThreshold) || config.stepsThreshold <= 0) {
    throw new V22DreamError('config.stepsThreshold phai la so duong.');
  }
  if (typeof config.runOnCompaction !== 'boolean') {
    throw new V22DreamError('config.runOnCompaction phai la boolean.');
  }
  if (!Number.isFinite(config.maxCharsAlwaysLoaded) || config.maxCharsAlwaysLoaded <= 0) {
    throw new V22DreamError('config.maxCharsAlwaysLoaded phai la so duong.');
  }
  if (!Number.isFinite(config.dedupeThreshold) || config.dedupeThreshold <= 0 || config.dedupeThreshold > 1) {
    throw new V22DreamError('config.dedupeThreshold phai trong (0, 1].');
  }
  if (!Number.isFinite(config.minConfidenceGap) || config.minConfidenceGap < 0 || config.minConfidenceGap > 1) {
    throw new V22DreamError('config.minConfidenceGap phai trong [0, 1].');
  }
  if (!Number.isFinite(config.patternMinSessions) || config.patternMinSessions < 1) {
    throw new V22DreamError('config.patternMinSessions phai >= 1.');
  }
  if (!Number.isFinite(config.patternMinObservations) || config.patternMinObservations < 1) {
    throw new V22DreamError('config.patternMinObservations phai >= 1.');
  }
  if (!Number.isFinite(config.promoteThreshold) || config.promoteThreshold < 0 || config.promoteThreshold > 1) {
    throw new V22DreamError('config.promoteThreshold phai trong [0, 1].');
  }
  if (!Number.isFinite(config.maxFactsPerDream) || config.maxFactsPerDream < 1) {
    throw new V22DreamError('config.maxFactsPerDream phai >= 1.');
  }
  if (!Number.isFinite(config.priorityHalfLifeDays) || config.priorityHalfLifeDays <= 0) {
    throw new V22DreamError('config.priorityHalfLifeDays phai la so duong.');
  }
  if (!Number.isFinite(config.memoryPressureThreshold) || config.memoryPressureThreshold < 0 || config.memoryPressureThreshold > 1) {
    throw new V22DreamError('config.memoryPressureThreshold phai trong [0, 1].');
  }
  if (typeof config.actor !== 'string' || config.actor.trim() === '') {
    throw new V22DreamError('config.actor khong duoc rong.');
  }
}

/** Hop nhat config rieng phan vao config mac dinh (co validate). */
export function resolveDreamConfigV22(partial: Partial<V22DreamConfig> = {}): V22DreamConfig {
  const resolved: V22DreamConfig = { ...V22_DREAM_DEFAULT_CONFIG, ...partial };
  validateDreamConfigV22(resolved);
  return resolved;
}

/** Scheduler quyet dinh khi nao dream chay. */
export class V22DreamScheduler {
  private config: V22DreamConfig;
  private stepsSinceRun = 0;
  private compactionPending = false;
  private lastMemoryPressure: number | undefined;
  private lastRunAt: number | undefined;
  private lastTrigger: V22DreamTrigger | undefined;
  private lastReport: V22DreamReport | undefined;
  private lastError: string | undefined;
  private running = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(config: Partial<V22DreamConfig> = {}) {
    this.config = resolveDreamConfigV22(config);
  }

  /** Config hien tai (ban sao). */
  getConfig(): V22DreamConfig {
    return { ...this.config };
  }

  /** Doi config (validate truoc khi ap dung). */
  updateConfig(partial: Partial<V22DreamConfig>): V22DreamConfig {
    const next = resolveDreamConfigV22({ ...this.config, ...partial });
    this.config = next;
    return this.getConfig();
  }

  /** So buoc ke tu lan dream cuoi. */
  getStepsSinceRun(): number {
    return this.stepsSinceRun;
  }

  /** Ghi nhan buoc hoi thoai moi (goi moi turn / moi tool call lon). */
  noteStep(count = 1): number {
    if (!Number.isFinite(count) || count < 0) {
      throw new V22DreamError('noteStep: count phai >= 0.');
    }
    this.stepsSinceRun += Math.floor(count);
    return this.stepsSinceRun;
  }

  /** Ghi nhan mot lan compaction vua chay. */
  noteCompaction(): void {
    this.compactionPending = true;
  }

  /** true = co compaction dang cho duoc xu ly. */
  hasPendingCompaction(): boolean {
    return this.compactionPending;
  }

  /**
   * Ghi nhan ap luc bo nho hien tai (ty le 0..1 — vd ty le
   * context da dung). Khi vuot `memoryPressureThreshold` thi
   * lan `checkDue` ke tiep tra ve trigger `memory_pressure`.
   */
  noteMemoryPressure(ratio: number): void {
    if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
      throw new V22DreamError('noteMemoryPressure: ratio phai trong [0, 1].');
    }
    this.lastMemoryPressure = ratio;
  }

  /** Ty le ap luc bo nho ghi nhan gan nhat (undefined = chua ghi). */
  getLastMemoryPressure(): number | undefined {
    return this.lastMemoryPressure;
  }

  /** Epoch ms du kien lan dream tiep theo theo lich. */
  nextDueAt(now = Date.now()): number | undefined {
    if (!this.config.enabled) return undefined;
    if (this.lastRunAt === undefined) return now;
    return this.lastRunAt + this.config.intervalMs;
  }

  /**
   * Kiem tra co toi luc dream chua. Tra trigger (uu tien
   * compaction > memory_pressure > steps > scheduled) hoac null.
   * Co compaction / ap luc chi duoc "an" khi no la trigger tra
   * ve (neu scheduler tat thi co van giu lai cho lan sau).
   */
  checkDue(now = Date.now()): V22DreamTrigger | null {
    if (!this.config.enabled) return null;
    if (this.running) return null;
    if (this.compactionPending && this.config.runOnCompaction) {
      this.compactionPending = false;
      return 'compaction';
    }
    if (
      this.lastMemoryPressure !== undefined
      && this.lastMemoryPressure >= this.config.memoryPressureThreshold
    ) {
      this.lastMemoryPressure = undefined;
      return 'memory_pressure';
    }
    if (this.stepsSinceRun >= this.config.stepsThreshold) {
      return 'steps';
    }
    if (this.lastRunAt === undefined) return 'scheduled';
    if (now - this.lastRunAt >= this.config.intervalMs) return 'scheduled';
    return null;
  }

  /** Danh dau dream bat dau chay (chan 2 dream chay chong nhau). */
  markRunStarted(): boolean {
    if (this.running) return false;
    this.running = true;
    return true;
  }

  /** Danh dau dream chay xong (cap nhat lastRunAt / report / steps). */
  markRunFinished(report: V22DreamReport): void {
    this.running = false;
    this.lastRunAt = report.finishedAt;
    this.lastTrigger = report.trigger;
    this.lastReport = report;
    this.lastError = report.errors.length > 0 ? report.errors.join('; ') : undefined;
    this.stepsSinceRun = 0;
  }

  /** Danh dau dream that bai (khong reset steps — de chay lai som). */
  markRunFailed(error: string, now = Date.now()): void {
    this.running = false;
    this.lastError = error;
    this.lastRunAt = now;
  }

  /** Trang thai job hien tai (de UI hien thi). */
  getState(now = Date.now()): V22DreamJobState {
    return {
      status: this.running ? 'running' : this.lastError !== undefined && this.lastReport === undefined ? 'failed' : this.lastReport ? 'done' : 'idle',
      stepsSinceRun: this.stepsSinceRun,
      ...(this.lastRunAt !== undefined ? { lastRunAt: this.lastRunAt } : {}),
      ...(this.lastTrigger !== undefined ? { lastTrigger: this.lastTrigger } : {}),
      ...(this.nextDueAt(now) !== undefined ? { nextDueAt: this.nextDueAt(now) as number } : {}),
      ...(this.lastReport ? { lastReport: this.lastReport } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  /** Bao cao cua lan dream cuoi (neu co). */
  getLastReport(): V22DreamReport | undefined {
    return this.lastReport;
  }

  /**
   * Bat timer tu dong: moi `pollMs` kiem tra `checkDue` mot
   * lan, toi luc thi goi `onDue(trigger)`. Timer unref nen
   * khong giu process song. Tra false neu timer dang chay.
   */
  start(onDue: (trigger: V22DreamTrigger) => void, pollMs = 60_000): boolean {
    if (this.timer !== undefined) return false;
    if (!Number.isFinite(pollMs) || pollMs <= 0) {
      throw new V22DreamError('start: pollMs phai la so duong.');
    }
    this.timer = setInterval(() => {
      const trigger = this.checkDue();
      if (trigger) onDue(trigger);
    }, pollMs);
    if (typeof (this.timer as unknown as { unref?: () => void }).unref === 'function') {
      (this.timer as unknown as { unref: () => void }).unref();
    }
    return true;
  }

  /** Dung timer tu dong. Tra false neu timer khong chay. */
  stop(): boolean {
    if (this.timer === undefined) return false;
    clearInterval(this.timer);
    this.timer = undefined;
    return true;
  }

  /** true = timer dang chay. */
  isTimerRunning(): boolean {
    return this.timer !== undefined;
  }
}
