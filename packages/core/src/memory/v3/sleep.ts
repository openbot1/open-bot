/**
 * Sleep-time compute cho memory v6 (v1.05, Đội T1).
 *
 * Ý tưởng học từ Letta (sleep-time agent chạy lúc rảnh: sắp xếp lại
 * memory, tóm tắt, dọn mâu thuẫn) — tự thiết kế lại hoàn toàn cho
 * open-bot, 100% local, không copy code/text/tài sản của bất kỳ repo
 * nào.
 *
 * SCHEDULER (`SleepV6Scheduler`):
 *  - Chạy nền bằng setInterval: mỗi `checkIntervalMs` kiểm tra đã
 *    rảnh đủ `idleMs` kể từ hoạt động cuối (host gọi `markActivity()`
 *    mỗi khi user/bot nhắn) thì chạy một lần consolidation.
 *  - Tắt/mở được (`setEnabled`, `start`, `stop`); mặc định TẮT —
 *    host bật tường minh. Không bao giờ chạy 2 lần chồng nhau.
 *  - Không dùng timer thì gọi `runOnce()` trực tiếp (tool
 *    memory_v6_sleep_consolidate dùng đường này).
 *
 * MỘT LẦN CHẠY (`runConsolidation`, 4 bước, theo đúng thứ tự này):
 *  1. Exact dedupe: cùng text chuẩn hoá + scope + kind, đang active
 *     -> giữ bản đầu tiên, retire các bản sau (event retire).
 *  2. Near-dup: Jaccard token >= ngưỡng trong cùng scope + kind ->
 *     giữ bản confidence cao nhất (hoà thì mới nhất), retire còn lại.
 *  3. Summarize cụm cũ: bản ghi active cũ hơn `summarizeOlderThanDays`,
 *     gom theo (mức scope + kind + entity/tag chung đầu tiên), cụm
 *     >= `minClusterSize` -> append MỘT bản ghi kind 'summary' tóm
 *     tắt cụm (liệt kê ý chính, tối đa `maxSummaryChars`), rồi
 *     supersede từng bản gốc bằng bản tóm tắt (event supersede).
 *  4. Quarantine mâu thuẫn: cùng `key` + scope nhưng text chuẩn hoá
 *     khác nhau, cả hai active -> quarantine bản confidence thấp hơn
 *     (hoà thì cũ hơn), để user duyệt sau.
 *
 * GIỚI HẠN TÀI NGUYÊN (không bao giờ chạy vô hạn):
 *  - `maxRecordsPerRun`: chỉ xem xét từng này bản ghi active đầu tiên
 *    (cũ nhất trước — vì sleep dọn đồ cũ).
 *  - `maxMsPerRun`: kiểm tra đồng hồ giữa các bước/cụm; hết giờ thì
 *    dừng, báo `stoppedByBudget: true`, lần sau chạy tiếp.
 *  - Lỗi từng mục không fail cả lần chạy (ghi vào `errors`).
 *  - Mọi lần chạy đều ghi log (append vào `sleep-v6-log.json`,
 *    giữ tối đa 50 lần gần nhất) + giữ `lastReport` trong bộ nhớ.
 *
 * AN TOÀN: mọi thay đổi đều qua store append/event (add-only) —
 * sleep KHÔNG BAO GIỜ xoá dữ liệu; bản ghi bị retire/supersede vẫn
 * truy vấn được lịch sử.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { V6RecordView, V6SleepConfig, V6SleepRunReport } from './types';
import { DEFAULT_V6_SLEEP_CONFIG, normalizeV6Text, normalizeV6Token } from './types';
import { ageInDays } from './temporal';
import { scopeLevelOf } from './scopes';
import { jaccardSimilarity, tokenizeV6 } from './tfidf';
import { quarantineRecord, retireRecord, supersedeRecord } from './versioning';
import type { V6RecordStore } from './store';

/** Đường dẫn tương đối của file log sleep v6 trong workspace. */
export const SLEEP_V6_LOG_REL_PATH = path.join('.open-bot', 'sleep-v6-log.json');
/** Số lần chạy log tối đa giữ lại trong file. */
export const SLEEP_V6_LOG_KEEP = 50;

/** Lỗi sleep v6 — mọi message đều tiếng Việt. */
export class V6SleepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V6SleepError';
  }
}

/** Đọc log các lần chạy sleep v6 từ file (mới nhất cuối mảng). */
export function readSleepV6Log(workspaceDir: string): V6SleepRunReport[] {
  const filePath = path.join(workspaceDir, SLEEP_V6_LOG_REL_PATH);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as V6SleepRunReport[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [];
  }
}

/** Append một báo cáo lần chạy vào file log sleep v6 (giữ tối đa 50 lần gần nhất). */
export function appendSleepV6Log(workspaceDir: string, report: V6SleepRunReport): void {
  const filePath = path.join(workspaceDir, SLEEP_V6_LOG_REL_PATH);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const existing = readSleepV6Log(workspaceDir);
  existing.push(report);
  const kept = existing.slice(-SLEEP_V6_LOG_KEEP);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(kept, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

/** Key gom cụm: mức scope + kind + entity/tag chung đầu tiên. */
export function clusterKey(record: V6RecordView): string | null {
  const level = scopeLevelOf(record.scope);
  const anchor = record.entities[0] ?? record.tags[0] ?? record.key ?? null;
  if (!anchor) return null;
  const scopeId =
    level === 'run'
      ? record.scope.runId
      : level === 'agent'
        ? record.scope.agentId
        : level === 'user'
          ? record.scope.userId
          : record.scope.appId;
  return `${level}:${scopeId}:${record.kind}:${normalizeV6Token(anchor)}`;
}

/** Tóm tắt một cụm bản ghi thành text (liệt kê ý, cắt ở giới hạn). */
export function summarizeCluster(records: V6RecordView[], maxChars: number): string {
  const lines: string[] = [];
  lines.push(`Tóm tắt ${records.length} bản ghi cũ (memory v6, sleep-time):`);
  for (const record of records) {
    const text = record.text.replace(/\s+/g, ' ').trim();
    lines.push(`- ${text}`);
  }
  let summary = lines.join('\n');
  if (summary.length > maxChars) {
    summary = `${summary.slice(0, Math.max(0, maxChars - 1))}…`;
  }
  return summary;
}

/** Tuỳ chọn chạy consolidation (ghi đè một phần config). */
export interface RunConsolidationOptions {
  /** Ghi đè config mặc định của lần chạy này. */
  config?: Partial<V6SleepConfig>;
  /** "Bây giờ" (để test; mặc định new Date()). */
  now?: Date;
  /** Actor ghi vào event (mặc định 'sleep:v6'). */
  actor?: string;
}

/**
 * Chạy MỘT lần consolidation sleep-time trên store (đồng bộ, không
 * timer). Dùng trực tiếp cho tool trigger hoặc test.
 */
export function runConsolidation(
  store: V6RecordStore,
  opts: RunConsolidationOptions = {},
): V6SleepRunReport {
  const config: V6SleepConfig = { ...DEFAULT_V6_SLEEP_CONFIG, ...(opts.config ?? {}) };
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? 'sleep:v6';
  const startedAt = new Date();
  const startedIso = startedAt.toISOString();
  const deadline = startedAt.getTime() + Math.max(0, config.maxMsPerRun);
  const report: V6SleepRunReport = {
    runId: randomUUID(),
    startedAt: startedIso,
    finishedAt: startedIso,
    durationMs: 0,
    examined: 0,
    dedupedExact: 0,
    dedupedNear: 0,
    summarizedClusters: 0,
    summaryRecords: 0,
    quarantined: 0,
    superseded: 0,
    stoppedByBudget: false,
    errors: [],
  };
  const outOfTime = (): boolean => Date.now() > deadline;

  // Chỉ xem xét bản active, cũ nhất trước (sleep dọn đồ cũ).
  const actives = store
    .listActive()
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(0, Math.max(0, config.maxRecordsPerRun));
  report.examined = actives.length;
  const retiredIds = new Set<string>();
  const isAlive = (r: V6RecordView): boolean => !retiredIds.has(r.id);

  // --- Bước 1: exact dedupe. ---
  try {
    const seen = new Map<string, V6RecordView>();
    for (const record of actives) {
      if (outOfTime()) {
        report.stoppedByBudget = true;
        break;
      }
      if (!isAlive(record)) continue;
      const key = [
        record.kind,
        normalizeV6Text(record.text),
        record.scope.userId,
        record.scope.agentId,
        record.scope.runId,
        record.scope.appId,
      ].join('|');
      const first = seen.get(key);
      if (!first) {
        seen.set(key, record);
        continue;
      }
      try {
        retireRecord(store, record.id, actor, `Trùng chính xác với ${first.id} (sleep dedupe).`);
        retiredIds.add(record.id);
        report.dedupedExact += 1;
      } catch (err) {
        report.errors.push(`Exact dedupe ${record.id}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    report.errors.push(`Bước exact dedupe lỗi: ${(err as Error).message}`);
  }

  // --- Bước 2: near-dup (Jaccard token). ---
  try {
    const alive = actives.filter(isAlive);
    const tokenSets = new Map<string, Set<string>>();
    for (const record of alive) tokenSets.set(record.id, new Set(tokenizeV6(record.text)));
    for (let i = 0; i < alive.length && !report.stoppedByBudget; i += 1) {
      const a = alive[i] as V6RecordView;
      if (!isAlive(a)) continue;
      for (let j = i + 1; j < alive.length; j += 1) {
        if (outOfTime()) {
          report.stoppedByBudget = true;
          break;
        }
        const b = alive[j] as V6RecordView;
        if (!isAlive(b)) continue;
        if (a.kind !== b.kind) continue;
        if (
          a.scope.userId !== b.scope.userId ||
          a.scope.agentId !== b.scope.agentId ||
          a.scope.runId !== b.scope.runId ||
          a.scope.appId !== b.scope.appId
        ) {
          continue;
        }
        const sim = jaccardSimilarity(
          tokenSets.get(a.id) as Set<string>,
          tokenSets.get(b.id) as Set<string>,
        );
        if (sim < config.nearDupJaccard) continue;
        // Giữ bản confidence cao hơn (hoà thì mới hơn); retire bản còn lại.
        const keep = a.confidence > b.confidence ? a : b.confidence > a.confidence ? b : a;
        const drop = keep === a ? b : a;
        try {
          retireRecord(
            store,
            drop.id,
            actor,
            `Gần trùng với ${keep.id} (Jaccard ${sim.toFixed(2)}, sleep dedupe).`,
          );
          retiredIds.add(drop.id);
          report.dedupedNear += 1;
        } catch (err) {
          report.errors.push(`Near-dup ${drop.id}: ${(err as Error).message}`);
        }
      }
    }
  } catch (err) {
    report.errors.push(`Bước near-dup lỗi: ${(err as Error).message}`);
  }

  // --- Bước 3: tóm tắt cụm cũ. ---
  try {
    const alive = actives.filter(isAlive);
    const clusters = new Map<string, V6RecordView[]>();
    for (const record of alive) {
      if (ageInDays(record.createdAt, now) < config.summarizeOlderThanDays) continue;
      if (record.kind === 'summary') continue;
      const key = clusterKey(record);
      if (!key) continue;
      const group = clusters.get(key) ?? [];
      group.push(record);
      clusters.set(key, group);
    }
    for (const [, group] of clusters) {
      if (report.stoppedByBudget) break;
      if (group.length < config.minClusterSize) continue;
      if (outOfTime()) {
        report.stoppedByBudget = true;
        break;
      }
      const sorted = [...group].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      const first = sorted[0] as V6RecordView;
      try {
        const summary = store.append({
          kind: 'summary',
          text: summarizeCluster(sorted, config.maxSummaryChars),
          entities: first.entities,
          tags: [...new Set([...first.tags, 'sleep-summary'])],
          confidence: 0.7,
          scope: { ...first.scope },
          source: {
            type: 'sleep',
            ref: `sleep-v6:${report.runId}`,
            botId: first.source.botId,
            sourceText: `Tóm tắt ${sorted.length} bản ghi cũ.`,
          },
        });
        for (const original of sorted) {
          try {
            supersedeRecord(store, original.id, summary.id, actor, `Tóm tắt vào ${summary.id} (sleep).`);
            retiredIds.add(original.id);
            report.superseded += 1;
          } catch (err) {
            report.errors.push(`Supersede ${original.id}: ${(err as Error).message}`);
          }
        }
        report.summarizedClusters += 1;
        report.summaryRecords += 1;
      } catch (err) {
        report.errors.push(`Tóm tắt cụm ${clusterKey(first) ?? '?'}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    report.errors.push(`Bước tóm tắt lỗi: ${(err as Error).message}`);
  }

  // --- Bước 4: quarantine mâu thuẫn (cùng key, text khác nhau). ---
  try {
    const alive = actives.filter(isAlive);
    const byKey = new Map<string, V6RecordView[]>();
    for (const record of alive) {
      if (!record.key) continue;
      const scopeKey = [
        record.scope.userId,
        record.scope.agentId,
        record.scope.runId,
        record.scope.appId,
      ].join('|');
      const mapKey = `${scopeKey}|${record.key}`;
      const group = byKey.get(mapKey) ?? [];
      group.push(record);
      byKey.set(mapKey, group);
    }
    for (const [, group] of byKey) {
      if (report.stoppedByBudget) break;
      if (group.length < 2) continue;
      if (outOfTime()) {
        report.stoppedByBudget = true;
        break;
      }
      // Nhóm theo text chuẩn hoá: > 1 text khác nhau = mâu thuẫn.
      const byText = new Map<string, V6RecordView[]>();
      for (const record of group) {
        const textKey = normalizeV6Text(record.text);
        const list = byText.get(textKey) ?? [];
        list.push(record);
        byText.set(textKey, list);
      }
      if (byText.size < 2) continue;
      // Quarantine bản yếu nhất trong các bản "thua": sắp theo
      // confidence tăng dần, rồi tuổi giảm dần; quarantine tất cả trừ
      // bản mạnh nhất.
      const sorted = [...group].sort((a, b) => {
        if (a.confidence !== b.confidence) return a.confidence - b.confidence;
        return Date.parse(a.createdAt) - Date.parse(b.createdAt);
      });
      const winner = sorted[sorted.length - 1] as V6RecordView;
      for (const loser of sorted.slice(0, -1)) {
        if (outOfTime()) {
          report.stoppedByBudget = true;
          break;
        }
        try {
          quarantineRecord(
            store,
            loser.id,
            actor,
            `Mâu thuẫn key "${loser.key}" với ${winner.id} (sleep quarantine, chờ duyệt).`,
          );
          retiredIds.add(loser.id);
          report.quarantined += 1;
        } catch (err) {
          report.errors.push(`Quarantine ${loser.id}: ${(err as Error).message}`);
        }
      }
    }
  } catch (err) {
    report.errors.push(`Bước quarantine lỗi: ${(err as Error).message}`);
  }

  const finishedAt = new Date();
  report.finishedAt = finishedAt.toISOString();
  report.durationMs = finishedAt.getTime() - startedAt.getTime();
  return report;
}

/** Tuỳ chọn scheduler. */
export interface SleepV6SchedulerOptions {
  /** Store v6 mà scheduler dọn. */
  store: V6RecordStore;
  /** Thư mục workspace (để ghi log; không có thì chỉ giữ lastReport). */
  workspaceDir?: string;
  /** Config ban đầu (mặc định DEFAULT_V6_SLEEP_CONFIG, enabled=false). */
  config?: Partial<V6SleepConfig>;
  /** Callback sau mỗi lần chạy (để host log/UI). */
  onRun?: (report: V6SleepRunReport) => void;
}

/**
 * Scheduler sleep-time compute v6: chạy nền khi rảnh.
 *
 *  - `start()` bật interval kiểm tra; `stop()` dừng hẳn.
 *  - `setEnabled(true/false)` tắt/mở mà không huỷ interval (host
 *    có thể bật/tắt từ Settings).
 *  - `markActivity()` host gọi mỗi khi có hoạt động (user/bot nhắn)
 *    để scheduler biết "chưa rảnh".
 *  - `runNow()` chạy một lần ngay (bỏ qua điều kiện rảnh) — tool
 *    memory_v6_sleep_consolidate dùng đường này.
 *  - Không bao giờ chạy 2 lần chồng nhau (`running` guard).
 */
export class SleepV6Scheduler {
  private readonly store: V6RecordStore;
  private readonly workspaceDir: string | undefined;
  private config: V6SleepConfig;
  private readonly onRun: ((report: V6SleepRunReport) => void) | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastActivityAt = Date.now();
  private lastReportValue: V6SleepRunReport | null = null;
  private runCount = 0;

  constructor(opts: SleepV6SchedulerOptions) {
    this.store = opts.store;
    this.workspaceDir = opts.workspaceDir;
    this.config = { ...DEFAULT_V6_SLEEP_CONFIG, ...(opts.config ?? {}) };
    this.onRun = opts.onRun;
  }

  /** Config hiện tại (bản sao). */
  getConfig(): V6SleepConfig {
    return { ...this.config };
  }

  /** Bật/tắt sleep compute (không huỷ interval). */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }

  /** Sleep compute có đang bật không. */
  get enabled(): boolean {
    return this.config.enabled;
  }

  /** Scheduler có đang chạy interval không. */
  get started(): boolean {
    return this.timer !== null;
  }

  /** Có đang chạy một lần consolidation không. */
  get isRunning(): boolean {
    return this.running;
  }

  /** Báo cáo lần chạy gần nhất (null khi chưa chạy lần nào). */
  get lastReport(): V6SleepRunReport | null {
    return this.lastReportValue;
  }

  /** Tổng số lần đã chạy. */
  get totalRuns(): number {
    return this.runCount;
  }

  /** Ghi nhận hoạt động (user/bot vừa nhắn) — reset đồng hồ rảnh. */
  markActivity(): void {
    this.lastActivityAt = Date.now();
  }

  /** Bật interval kiểm tra rảnh (gọi 1 lần; gọi lại không tạo thêm timer). */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.checkIntervalMs);
    if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
  }

  /** Dừng interval (không huỷ lần chạy đang diễn ra). */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Một nhịp kiểm tra: đủ rảnh + đang bật + không chạy chồng -> chạy. */
  async tick(): Promise<V6SleepRunReport | null> {
    if (!this.config.enabled || this.running) return null;
    const idleFor = Date.now() - this.lastActivityAt;
    if (idleFor < this.config.idleMs) return null;
    return this.runNow();
  }

  /** Chạy một lần consolidation ngay (bỏ qua điều kiện rảnh). */
  async runNow(): Promise<V6SleepRunReport | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const report = runConsolidation(this.store, { config: this.config });
      this.lastReportValue = report;
      this.runCount += 1;
      if (this.workspaceDir) {
        try {
          appendSleepV6Log(this.workspaceDir, report);
        } catch {
          // Ghi log lỗi thì bỏ qua — không fail lần chạy.
        }
      }
      this.onRun?.(report);
      return report;
    } finally {
      this.running = false;
    }
  }
}
