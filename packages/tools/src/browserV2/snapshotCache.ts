/**
 * Snapshot cache theo step — chỉ gửi DIFF về model để giảm token/step
 * (v1.33, Đội T4).
 *
 * Vấn đề (survey v133): re-send toàn bộ page state mỗi bước nên
 * context/step — không phải browser — mới là nút thắt. Cache này giữ
 * snapshot của step trước; ở step mới chỉ render diff (added/removed/
 * changed) + tóm tắt, và chỉ gửi full snapshot khi:
 *  - chưa có snapshot trước (step 0),
 *  - diff quá lớn (>= `fullSnapshotThreshold`, mặc định 60% node đổi —
 *    lúc đó diff không còn rẻ hơn full),
 *  - caller ép buộc (`forceFull: true`, vd sau navigation đổi trang).
 *
 * Cache cũng đếm token đã tiết kiệm (ước lượng 1 token ≈ 4 ký tự) để
 * eval cost/task có số thật thay vì đoán.
 */
import {
  diffSnapshots,
  estimateTokens,
  parseAriaSnapshot,
  renderSnapshotDiff,
  serializeAriaSnapshot,
  type A11yNode,
  type SnapshotDiff,
} from './a11ySnapshot';

/** Một lần snapshot đã lưu trong cache. */
export interface CachedSnapshot {
  /** Số thứ tự step (0-based). */
  step: number;
  /** URL của trang lúc chụp. */
  url: string;
  /** Cây đã parse. */
  nodes: A11yNode[];
  /** Văn bản snapshot đầy đủ (đã serialize lại — chuẩn hoá). */
  text: string;
  /** Diff so với snapshot trước (null ở step 0). */
  diff: SnapshotDiff | null;
  /** Số token ước lượng nếu gửi full snapshot. */
  fullTokens: number;
  /** Số token ước lượng của payload thực tế đã gửi (full hoặc diff). */
  sentTokens: number;
  /** true khi payload là full snapshot (không phải diff). */
  sentFull: boolean;
  /** Thời điểm chụp (epoch ms). */
  capturedAt: number;
}

/** Thống kê tích luỹ của cache (dùng cho eval + báo cáo). */
export interface SnapshotCacheStats {
  steps: number;
  fullSnapshotsSent: number;
  diffsSent: number;
  totalFullTokens: number;
  totalSentTokens: number;
  /** Token đã tiết kiệm so với việc gửi full mọi step. */
  tokensSaved: number;
  /** Tỉ lệ tiết kiệm (0..1). */
  savedRatio: number;
  /** Số node trung bình mỗi snapshot. */
  avgNodes: number;
}

export interface SnapshotCacheOptions {
  /** Tỉ lệ node đổi tối đa để còn dùng diff (mặc định 0.6). */
  fullSnapshotThreshold?: number;
  /** Số snapshot tối đa giữ trong lịch sử (mặc định 50, 0 = chỉ giữ cái mới nhất). */
  maxHistory?: number;
  /** Ép full snapshot mỗi N step (mặc định 0 = không ép). */
  forceFullEveryNSteps?: number;
}

/** Quyết định payload gửi về model ở một step. */
export type SnapshotPayload =
  | { kind: 'full'; text: string; tokens: number }
  | { kind: 'diff'; text: string; tokens: number; diff: SnapshotDiff };

export class SnapshotCache {
  private readonly threshold: number;
  private readonly maxHistory: number;
  private readonly forceFullEveryN: number;
  private history: CachedSnapshot[] = [];
  private stepCounter = 0;
  private totalFullTokens = 0;
  private totalSentTokens = 0;
  private fullSent = 0;
  private diffSent = 0;
  private nodeTotal = 0;

  constructor(opts: SnapshotCacheOptions = {}) {
    this.threshold = opts.fullSnapshotThreshold ?? 0.6;
    this.maxHistory = opts.maxHistory ?? 50;
    this.forceFullEveryN = opts.forceFullEveryNSteps ?? 0;
  }

  /** Snapshot mới nhất (null khi chưa chụp lần nào). */
  latest(): CachedSnapshot | null {
    return this.history.length > 0 ? this.history[this.history.length - 1] : null;
  }

  /** Số step đã chụp. */
  get steps(): number {
    return this.stepCounter;
  }

  /**
   * Chụp snapshot mới từ text thô (Playwright aria snapshot) + URL.
   * Trả về payload nên gửi về model (full hoặc diff) + bản ghi cache.
   */
  capture(rawSnapshotText: string, url: string, opts: { forceFull?: boolean } = {}): {
    payload: SnapshotPayload;
    cached: CachedSnapshot;
  } {
    const nodes = parseAriaSnapshot(rawSnapshotText);
    const text = serializeAriaSnapshot(nodes);
    const prev = this.latest();
    const step = this.stepCounter;
    this.stepCounter += 1;

    const fullTokens = estimateTokens(text);
    let diff: SnapshotDiff | null = null;
    let sentFull = true;
    let payloadText = text;

    if (prev) {
      diff = diffSnapshots(prev.nodes, nodes);
      const changedCount = diff.added.length + diff.removed.length + diff.changed.length;
      const changeRatio = diff.totalCount === 0 ? 0 : changedCount / diff.totalCount;
      const forceBySchedule =
        this.forceFullEveryN > 0 && step > 0 && step % this.forceFullEveryN === 0;
      const urlChanged = prev.url !== url;
      if (!opts.forceFull && !forceBySchedule && !urlChanged && changeRatio < this.threshold) {
        payloadText = renderSnapshotDiff(diff);
        sentFull = false;
      }
    }

    const sentTokens = estimateTokens(payloadText);
    this.totalFullTokens += fullTokens;
    this.totalSentTokens += sentTokens;
    if (sentFull) this.fullSent += 1;
    else this.diffSent += 1;
    this.nodeTotal += nodes.length;

    const cached: CachedSnapshot = {
      step,
      url,
      nodes,
      text,
      diff,
      fullTokens,
      sentTokens,
      sentFull,
      capturedAt: Date.now(),
    };
    this.history.push(cached);
    if (this.maxHistory > 0 && this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory);
    }
    const payload: SnapshotPayload = sentFull
      ? { kind: 'full', text: payloadText, tokens: sentTokens }
      : { kind: 'diff', text: payloadText, tokens: sentTokens, diff: diff as SnapshotDiff };
    return { payload, cached };
  }

  /**
   * Payload cho step hiện tại mà KHÔNG chụp mới: trả diff/full của
   * snapshot mới nhất so với snapshot trước nó (dùng khi model hỏi lại
   * state mà trang không đổi).
   */
  currentPayload(): SnapshotPayload | null {
    const latest = this.latest();
    if (!latest) return null;
    if (latest.sentFull || !latest.diff) {
      return { kind: 'full', text: latest.text, tokens: latest.fullTokens };
    }
    const text = renderSnapshotDiff(latest.diff);
    return { kind: 'diff', text, tokens: estimateTokens(text), diff: latest.diff };
  }

  /** Thống kê tích luỹ. */
  stats(): SnapshotCacheStats {
    const steps = this.stepCounter;
    const saved = Math.max(0, this.totalFullTokens - this.totalSentTokens);
    return {
      steps,
      fullSnapshotsSent: this.fullSent,
      diffsSent: this.diffSent,
      totalFullTokens: this.totalFullTokens,
      totalSentTokens: this.totalSentTokens,
      tokensSaved: saved,
      savedRatio: this.totalFullTokens === 0 ? 0 : saved / this.totalFullTokens,
      avgNodes: steps === 0 ? 0 : this.nodeTotal / steps,
    };
  }

  /** Xoá toàn bộ lịch sử (vd khi đổi tab/trang hoàn toàn mới). */
  reset(): void {
    this.history = [];
    this.stepCounter = 0;
    this.totalFullTokens = 0;
    this.totalSentTokens = 0;
    this.fullSent = 0;
    this.diffSent = 0;
    this.nodeTotal = 0;
  }
}

/** Tạo cache với cấu hình mặc định của driver v2. */
export function createSnapshotCache(opts: SnapshotCacheOptions = {}): SnapshotCache {
  return new SnapshotCache(opts);
}
