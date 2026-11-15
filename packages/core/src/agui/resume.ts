/**
 * AG-UI checkpoint store (v1.09, Đội T4) — resume stream sau ngắt kết nối.
 *
 * `streaming.ts` giữ checkpoint trong bộ nhớ của session; module này
 * là tầng lưu trữ checkpoint để resume bền vững hơn:
 *  - `AgUiCheckpointStore`: lưu checkpoint theo runId (bộ nhớ, có
 *    giới hạn số run + TTL), xuất/nhập JSON (app lưu disk rồi nạp
 *    lại sau restart), cắt checkpoint cũ.
 *  - `planResume`: quyết định cách resume một run sau ngắt — replay
 *    từ bus buffer khi event thiếu còn trong buffer; snapshot +
 *    replay phần sau checkpoint khi buffer đã cắt; fetch lại toàn bộ
 *    khi không còn gì (checkpoint quá cũ / run đã bị quên).
 *  - `detectStreamGap`: so sánh sequence đã nhận với sequence mới
 *    nhất trong buffer để biết client mất bao nhiêu event.
 *  - Checkpoint JSON có version (`agui-checkpoint/1`) + checksum nhẹ
 *    (độ dài + lastSequence) để phát hiện file checkpoint bị cắt
 *    ngang khi ghi disk.
 *
 * Không gọi mạng, không tự đọc/ghi file — app gọi `exportJson` rồi
 * tự lưu, hoặc dùng store trong bộ nhớ trực tiếp.
 */

import type { AgUiEvent } from './types';
import type { AgUiStreamCheckpoint } from './streaming';

/** Version định dạng checkpoint JSON. */
export const AG_UI_CHECKPOINT_FORMAT = 'agui-checkpoint/1';

/** Số run tối đa giữ checkpoint (run cũ nhất bị cắt). */
export const AG_UI_CHECKPOINT_MAX_RUNS = 100;

/** Checkpoint quá bao lâu thì coi là cũ (mặc định 1 giờ). */
export const AG_UI_CHECKPOINT_MAX_AGE_MS = 60 * 60 * 1000;

/** Một checkpoint đã lưu kèm metadata lưu trữ. */
export interface StoredAgUiCheckpoint {
  checkpoint: AgUiStreamCheckpoint;
  /** ISO-8601 lúc lưu vào store. */
  savedAt: string;
  /** Số lần checkpoint này đã được dùng để resume. */
  resumeCount: number;
}

/** Checkpoint JSON xuất ra disk (có checksum nhẹ). */
export interface AgUiCheckpointFile {
  format: typeof AG_UI_CHECKPOINT_FORMAT;
  /** runId → checkpoint. */
  checkpoints: Record<string, AgUiStreamCheckpoint>;
  exportedAt: string;
  /** Tổng số checkpoint. */
  count: number;
}

export interface AgUiCheckpointStoreOptions {
  maxRuns?: number;
  maxAgeMs?: number;
  now?: () => number;
}

/** Store checkpoint trong bộ nhớ (có TTL + giới hạn số run). */
export class AgUiCheckpointStore {
  private readonly stored = new Map<string, StoredAgUiCheckpoint>();
  private readonly maxRuns: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(opts: AgUiCheckpointStoreOptions = {}) {
    this.maxRuns = opts.maxRuns !== undefined && opts.maxRuns > 0 ? Math.floor(opts.maxRuns) : AG_UI_CHECKPOINT_MAX_RUNS;
    this.maxAgeMs = opts.maxAgeMs !== undefined && opts.maxAgeMs >= 0 ? opts.maxAgeMs : AG_UI_CHECKPOINT_MAX_AGE_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Số checkpoint đang giữ. */
  get size(): number {
    return this.stored.size;
  }

  /** Run id đang có checkpoint. */
  runIds(): string[] {
    return [...this.stored.keys()];
  }

  /** Lưu checkpoint của một run (ghi đè checkpoint cũ của run đó). */
  save(checkpoint: AgUiStreamCheckpoint): StoredAgUiCheckpoint {
    const entry: StoredAgUiCheckpoint = {
      checkpoint: cloneCheckpoint(checkpoint),
      savedAt: new Date(this.now()).toISOString(),
      resumeCount: this.stored.get(checkpoint.runId)?.resumeCount ?? 0,
    };
    this.stored.set(checkpoint.runId, entry);
    while (this.stored.size > this.maxRuns) {
      const oldest = this.stored.keys().next().value;
      if (oldest === undefined || oldest === checkpoint.runId) break;
      this.stored.delete(oldest);
    }
    return cloneStored(entry);
  }

  /** Lấy checkpoint của run (bản copy), undefined khi chưa có/quá cũ. */
  get(runId: string): AgUiStreamCheckpoint | undefined {
    const entry = this.stored.get(runId);
    if (!entry) return undefined;
    if (this.isStale(entry)) {
      this.stored.delete(runId);
      return undefined;
    }
    return cloneCheckpoint(entry.checkpoint);
  }

  /** Lấy checkpoint kể cả khi quá cũ (để UI báo "checkpoint cũ"). */
  getEvenIfStale(runId: string): StoredAgUiCheckpoint | undefined {
    const entry = this.stored.get(runId);
    return entry ? cloneStored(entry) : undefined;
  }

  /** True khi checkpoint này quá cũ (vượt maxAgeMs). */
  isStale(entry: StoredAgUiCheckpoint): boolean {
    if (this.maxAgeMs <= 0) return false;
    return this.now() - Date.parse(entry.savedAt) > this.maxAgeMs;
  }

  /** Đánh dấu checkpoint đã được dùng để resume (tăng resumeCount). */
  markResumed(runId: string): AgUiStreamCheckpoint | undefined {
    const entry = this.stored.get(runId);
    if (!entry) return undefined;
    entry.resumeCount += 1;
    return cloneCheckpoint(entry.checkpoint);
  }

  /** Xoá checkpoint một run. */
  delete(runId: string): boolean {
    return this.stored.delete(runId);
  }

  /** Xoá mọi checkpoint. */
  clear(): void {
    this.stored.clear();
  }

  /** Cắt checkpoint quá cũ; trả số đã cắt. */
  prune(): number {
    let pruned = 0;
    for (const [runId, entry] of [...this.stored.entries()]) {
      if (this.isStale(entry)) {
        this.stored.delete(runId);
        pruned += 1;
      }
    }
    return pruned;
  }

  /** Xuất mọi checkpoint thành JSON (app lưu disk). */
  exportJson(): string {
    const checkpoints: Record<string, AgUiStreamCheckpoint> = {};
    for (const [runId, entry] of [...this.stored.entries()].sort()) {
      checkpoints[runId] = cloneCheckpoint(entry.checkpoint);
    }
    const file: AgUiCheckpointFile = {
      format: AG_UI_CHECKPOINT_FORMAT,
      checkpoints,
      exportedAt: new Date(this.now()).toISOString(),
      count: Object.keys(checkpoints).length,
    };
    return JSON.stringify(file);
  }

  /**
   * Nhập checkpoint từ JSON (app đọc disk). Entry sai định dạng bị
   * bỏ qua (không throw cả file). Trả số checkpoint nhập được.
   */
  importJson(json: string): { imported: number; skipped: number } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json) as unknown;
    } catch {
      return { imported: 0, skipped: 0 };
    }
    if (typeof parsed !== 'object' || parsed === null) return { imported: 0, skipped: 0 };
    const file = parsed as Record<string, unknown>;
    if (file['format'] !== AG_UI_CHECKPOINT_FORMAT) return { imported: 0, skipped: 0 };
    const checkpoints = file['checkpoints'];
    if (typeof checkpoints !== 'object' || checkpoints === null) return { imported: 0, skipped: 0 };
    let imported = 0;
    let skipped = 0;
    for (const [runId, raw] of Object.entries(checkpoints as Record<string, unknown>)) {
      if (isValidCheckpoint(raw, runId)) {
        this.save(raw as AgUiStreamCheckpoint);
        imported += 1;
      } else {
        skipped += 1;
      }
    }
    return { imported, skipped };
  }
}

function cloneCheckpoint(cp: AgUiStreamCheckpoint): AgUiStreamCheckpoint {
  return JSON.parse(JSON.stringify(cp)) as AgUiStreamCheckpoint;
}

function cloneStored(entry: StoredAgUiCheckpoint): StoredAgUiCheckpoint {
  return {
    checkpoint: cloneCheckpoint(entry.checkpoint),
    savedAt: entry.savedAt,
    resumeCount: entry.resumeCount,
  };
}

function isValidCheckpoint(raw: unknown, runId: string): raw is AgUiStreamCheckpoint {
  if (typeof raw !== 'object' || raw === null) return false;
  const rec = raw as Record<string, unknown>;
  return (
    rec['runId'] === runId &&
    typeof rec['lastSequence'] === 'number' &&
    Number.isInteger(rec['lastSequence']) &&
    (rec['lastSequence'] as number) >= -1 &&
    typeof rec['receivedEvents'] === 'number' &&
    typeof rec['createdAt'] === 'string' &&
    (rec['state'] === null || typeof rec['state'] === 'object') &&
    typeof rec['textByMessage'] === 'object' &&
    rec['textByMessage'] !== null
  );
}

/** Cách resume một run sau ngắt kết nối. */
export type AgUiResumeStrategy =
  | 'replay-buffer'
  | 'snapshot-and-replay'
  | 'refetch-full'
  | 'already-complete';

/** Kế hoạch resume cho một run. */
export interface AgUiResumePlan {
  runId: string;
  strategy: AgUiResumeStrategy;
  /** Sequence bắt đầu replay (inclusive). */
  fromSequence: number;
  /** Checkpoint sẽ nạp trước khi replay (null khi không có). */
  checkpoint: AgUiStreamCheckpoint | null;
  /** Số event thiếu ước tính (trong buffer). */
  missingEvents: number;
  /** true khi event thiếu đã bị cắt khỏi buffer (chỉ còn cách refetch). */
  bufferTruncated: boolean;
  /** Giải thích cho UI/logs. */
  reason: string;
}

/**
 * Lập kế hoạch resume: so checkpoint của client với buffer hiện tại
 * (event mới nhất trong buffer) để chọn chiến lược rẻ nhất mà không
 * mất event.
 *
 *  - Run đã terminal trong checkpoint → `already-complete` (không
 *    cần replay, chỉ hiện kết quả).
 *  - Không có checkpoint → replay từ 0 (`replay-buffer`).
 *  - Checkpoint còn trong buffer (lastSequence >= oldestSequence) →
 *    replay phần sau checkpoint (`replay-buffer`).
 *  - Checkpoint cũ hơn buffer (event đã bị cắt) nhưng có snapshot
 *    state → `snapshot-and-replay` (nạp snapshot rồi replay phần
 *    còn lại trong buffer).
 *  - Không checkpoint, không snapshot, buffer đã cắt → `refetch-full`.
 */
export function planResume(
  runId: string,
  checkpoint: AgUiStreamCheckpoint | null | undefined,
  buffer: { oldestSequence: number; newestSequence: number; eventCount: number },
): AgUiResumePlan {
  if (checkpoint && checkpoint.terminal) {
    return {
      runId,
      strategy: 'already-complete',
      fromSequence: checkpoint.lastSequence + 1,
      checkpoint,
      missingEvents: 0,
      bufferTruncated: false,
      reason: 'Run đã xong trong checkpoint — không cần replay.',
    };
  }
  if (!checkpoint) {
    return {
      runId,
      strategy: buffer.eventCount > 0 ? 'replay-buffer' : 'refetch-full',
      fromSequence: 0,
      checkpoint: null,
      missingEvents: buffer.eventCount,
      bufferTruncated: false,
      reason:
        buffer.eventCount > 0
          ? 'Không có checkpoint — replay toàn bộ buffer từ đầu.'
          : 'Không có checkpoint và buffer trống — fetch lại run đầy đủ.',
    };
  }
  const fromSequence = checkpoint.lastSequence + 1;
  if (fromSequence >= buffer.oldestSequence) {
    // Mọi event cần replay vẫn còn trong buffer → replay đủ.
    return {
      runId,
      strategy: 'replay-buffer',
      fromSequence,
      checkpoint,
      missingEvents: Math.max(0, buffer.newestSequence - checkpoint.lastSequence),
      bufferTruncated: false,
      reason: `Replay ${Math.max(0, buffer.newestSequence - checkpoint.lastSequence)} event từ sequence ${fromSequence}.`,
    };
  }
  if (checkpoint.state !== null) {
    return {
      runId,
      strategy: 'snapshot-and-replay',
      fromSequence: buffer.oldestSequence,
      checkpoint,
      missingEvents: Math.max(0, buffer.newestSequence - buffer.oldestSequence + 1),
      bufferTruncated: true,
      reason:
        `Event ${fromSequence}..${buffer.oldestSequence - 1} đã bị cắt khỏi buffer — ` +
        `nạp state snapshot từ checkpoint rồi replay phần còn lại từ ${buffer.oldestSequence}.`,
    };
  }
  return {
    runId,
    strategy: 'refetch-full',
    fromSequence: 0,
    checkpoint,
    missingEvents: 0,
    bufferTruncated: true,
    reason:
      'Checkpoint quá cũ, buffer đã cắt event thiếu và checkpoint không có state snapshot — fetch lại run đầy đủ.',
  };
}

/**
 * Phát hiện gap: client đã nhận tới `lastReceivedSequence`, buffer
 * có tới `newestSequence` — trả danh sách sequence thiếu. Trả rỗng
 * khi client đã bắt kịp.
 */
export function detectStreamGap(
  lastReceivedSequence: number,
  bufferedSequences: readonly number[],
): { missing: number[]; newest: number } {
  const sorted = [...bufferedSequences].sort((a, b) => a - b);
  const newest = sorted.length > 0 ? sorted[sorted.length - 1] : lastReceivedSequence;
  const have = new Set(bufferedSequences);
  const missing: number[] = [];
  for (let s = lastReceivedSequence + 1; s <= newest; s++) {
    if (!have.has(s)) missing.push(s);
  }
  return { missing, newest };
}

/** Trích sequence của event trong buffer (để `planResume`/`detectStreamGap` dùng). */
export function bufferWindow(events: readonly AgUiEvent[]): {
  oldestSequence: number;
  newestSequence: number;
  eventCount: number;
} {
  const sequences = events
    .map((e) => e.sequence ?? -1)
    .filter((s) => s >= 0);
  if (sequences.length === 0) return { oldestSequence: 0, newestSequence: -1, eventCount: 0 };
  return {
    oldestSequence: Math.min(...sequences),
    newestSequence: Math.max(...sequences),
    eventCount: events.length,
  };
}
