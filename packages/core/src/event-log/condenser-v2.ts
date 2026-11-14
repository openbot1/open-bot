/**
 * Condenser v2 — nhiều chiến lược nén event stream (v1.04, Đội T4).
 *
 * Condenser v1 (`condenser.ts`) chỉ có MỘT chiến lược: tóm tắt trích
 * xuất toàn bộ prefix. V2 giữ chiến lược đó làm `summarize` và thêm:
 *
 * - `truncate`: giữ nguyên văn N event đầu + M event cuối, bỏ đoạn
 *   giữa (ghi rõ khoảng seq đã bỏ). Hữu ích khi log rất dài: đầu log
 *   có prompt + setup, cuối log có kết quả gần nhất.
 * - `extract-keep`: giữ nguyên văn event QUAN TRỌNG (prompt, lỗi,
 *   file change, approval, kết thúc run, model response cuối) và chỉ
 *   tóm tắt phần còn lại. Hữu ích khi log có nhiều lỗi cần giữ chính
 *   xác từng chữ (lỗi biên dịch, output lỗi của tool).
 *
 * Mọi chiến lược đều ĐO THẬT token tiết kiệm được trên cùng một log:
 * `tokensBefore` (tổng `estimateEventTokens` của prefix gốc),
 * `tokensAfter` (token của bản nén: tóm tắt + phần giữ nguyên văn),
 * `tokensSaved` = before − after, `savedRatioPct` = saved/before.
 * Không ước lượng bằng hệ số, không nhân số cho đẹp — đo trên dữ liệu
 * thật rồi báo cáo đúng số đó (kể cả khi tiết kiệm âm, vd truncate
 * trên log ngắn giữ lại gần như toàn bộ).
 *
 * Nén không xoá lịch sử: `compactRunV2` chỉ append marker
 * `run.compacted` mang bản tóm tắt (giống v1); event gốc còn nguyên
 * trên đĩa, replay/snapshot vẫn thấy đủ.
 */

import { estimateTokens } from '../agent/tokens';
import type { RunLogStore } from './store';
import type { AnyRunEvent } from './types';
import { condenseEvents, estimateEventTokens, type CondenseOptions } from './condenser';

/** Chiến lược nén của condenser v2. */
export type CondenseStrategyV2 = 'summarize' | 'truncate' | 'extract-keep';

/** Các loại event luôn giữ nguyên văn ở chiến lược `extract-keep`. */
export const EXTRACT_KEEP_TYPES: ReadonlySet<AnyRunEvent['type']> = new Set([
  'run.started',
  'run.prompt',
  'file.change',
  'compile.error',
  'approval.request',
  'approval.decision',
  'run.failed',
  'run.aborted',
  'run.compacted',
  'stuck.detected',
]);

/** Tùy chọn condenser v2 (kế thừa ngưỡng của v1). */
export interface CondenseV2Options extends CondenseOptions {
  /** Chiến lược. Mặc định 'summarize' (giống v1). */
  strategy?: CondenseStrategyV2;
  /** `truncate`: giữ bao nhiêu event đầu. Mặc định 5. */
  keepHeadEvents?: number;
  /** `truncate`: giữ bao nhiêu event cuối. Mặc định 10. */
  keepTailEvents?: number;
  /** Seq cuối bao phủ (mặc định = seq cuối của log). */
  upToSeq?: number;
}

/** Báo cáo nén — số đo thật trên cùng một log. */
export interface CondenserV2Report {
  strategy: CondenseStrategyV2;
  /** Seq cuối mà bản nén bao phủ (bao gồm). */
  upToSeq: number;
  /** Số event trong prefix đã nén. */
  eventsCovered: number;
  /** Số event giữ nguyên văn trong bản nén. */
  eventsKept: number;
  /** Số event đã bỏ (truncate) hoặc tóm tắt gọn (summarize/extract-keep). */
  eventsDropped: number;
  /** Bản nén (tóm tắt + phần giữ nguyên văn, nếu có). */
  summary: string;
  /**
   * Phần giữ nguyên văn (chỉ `truncate`/`extract-keep` có): các event
   * được giữ, mỗi dòng một event, để caller nạp thẳng vào context.
   */
  keptTranscript?: string;
  /** Ước lượng token của prefix gốc (đo thật). */
  tokensBefore: number;
  /** Ước lượng token của bản nén (đo thật). */
  tokensAfter: number;
  /** Token tiết kiệm được = before − after (có thể âm). */
  tokensSaved: number;
  /** Tỉ lệ tiết kiệm, % làm tròn 1 chữ số thập phân (có thể âm). */
  savedRatioPct: number;
}

/** Kết quả của `compactRunV2`: báo cáo + seq marker đã ghi. */
export interface CompactRunV2Result extends CondenserV2Report {
  /** Seq của event `run.compacted` vừa append. */
  markerSeq: number;
}

/** Lý do chọn chiến lược (để UI giải thích, không phải số bịa). */
export interface StrategyRecommendation {
  strategy: CondenseStrategyV2;
  reason: string;
}

const V2_DEFAULTS: Required<Omit<CondenseV2Options, 'upToSeq' | 'strategy'>> = {
  minEvents: 40,
  minTokens: 4000,
  maxSummaryChars: 1500,
  maxFilesListed: 10,
  keepHeadEvents: 5,
  keepTailEvents: 10,
};

/**
 * Một dòng mô tả ngắn cho một event (dùng cho phần giữ nguyên văn).
 * Chỉ lấy field text đã sanitize sẵn trong payload (text,
 * outputPreview, firstError, message, finalText, summary).
 */
export function describeEventLine(event: AnyRunEvent): string {
  const p = event.payload as unknown as Record<string, unknown>;
  const text =
    typeof p['text'] === 'string'
      ? p['text']
      : typeof p['finalText'] === 'string'
        ? p['finalText']
        : typeof p['outputPreview'] === 'string'
          ? p['outputPreview']
          : typeof p['firstError'] === 'string'
            ? p['firstError']
            : typeof p['message'] === 'string'
              ? p['message']
              : typeof p['summary'] === 'string'
                ? p['summary']
                : '';
  const tool = typeof p['tool'] === 'string' ? ` ${p['tool']}` : '';
  const clipped = text.length > 200 ? `${text.slice(0, 199)}…` : text;
  return `[#${event.seq} ${event.type}${tool}]${clipped === '' ? '' : ` ${clipped}`}`;
}

/** Tổng token ước lượng của một dãy event (đo thật từng event). */
export function estimateEventsTokens(events: readonly AnyRunEvent[]): number {
  let total = 0;
  for (const e of events) total += estimateEventTokens(e);
  return total;
}

/** Số event lỗi (tool error + compile error) trong một dãy event. */
export function countErrorEvents(events: readonly AnyRunEvent[]): number {
  let n = 0;
  for (const e of events) {
    if (e.type === 'compile.error') n += 1;
    if (e.type === 'tool.result') {
      const p = e.payload as { status?: unknown };
      if (p.status === 'error') n += 1;
    }
  }
  return n;
}

/**
 * Gợi ý chiến lược theo hình dạng log (policy xác định, không gọi LLM):
 * - Log có >= 20% event lỗi → `extract-keep` (giữ nguyên văn từng lỗi).
 * - Log rất dài (>= 200 event) và ít lỗi → `truncate` (đầu + cuối).
 * - Còn lại → `summarize` (tóm tắt trích xuất v1).
 */
export function recommendStrategy(events: readonly AnyRunEvent[]): StrategyRecommendation {
  if (events.length === 0) {
    return { strategy: 'summarize', reason: 'Log rỗng — không có gì để nén, dùng summarize mặc định.' };
  }
  const errorEvents = countErrorEvents(events);
  const errorRatio = errorEvents / events.length;
  if (errorRatio >= 0.2) {
    return {
      strategy: 'extract-keep',
      reason: `${errorEvents}/${events.length} event là lỗi (${Math.round(errorRatio * 100)}%) — giữ nguyên văn lỗi, tóm tắt phần còn lại.`,
    };
  }
  if (events.length >= 200) {
    return {
      strategy: 'truncate',
      reason: `Log dài (${events.length} event), ít lỗi — giữ đầu + cuối, bỏ đoạn giữa.`,
    };
  }
  return {
    strategy: 'summarize',
    reason: `Log vừa (${events.length} event, ${errorEvents} lỗi) — tóm tắt trích xuất toàn bộ prefix.`,
  };
}

/** Tính `tokensSaved`/`savedRatioPct` từ before/after đã đo. */
function savings(tokensBefore: number, tokensAfter: number): { tokensSaved: number; savedRatioPct: number } {
  const tokensSaved = tokensBefore - tokensAfter;
  const savedRatioPct =
    tokensBefore > 0 ? Math.round((tokensSaved / tokensBefore) * 1000) / 10 : 0;
  return { tokensSaved, savedRatioPct };
}

/** Nén bằng chiến lược `summarize` (tóm tắt trích xuất v1). */
function condenseSummarize(
  covered: AnyRunEvent[],
  upToSeq: number,
  options: CondenseV2Options,
  tokensBefore: number,
): CondenserV2Report {
  const c = condenseEvents(covered, options);
  const tokensAfter = c.tokensAfter;
  return {
    strategy: 'summarize',
    upToSeq,
    eventsCovered: covered.length,
    eventsKept: 0,
    eventsDropped: covered.length,
    summary: c.summary,
    tokensBefore,
    tokensAfter,
    ...savings(tokensBefore, tokensAfter),
  };
}

/** Nén bằng chiến lược `truncate` (giữ đầu + cuối nguyên văn). */
function condenseTruncate(
  covered: AnyRunEvent[],
  upToSeq: number,
  options: CondenseV2Options,
  tokensBefore: number,
): CondenserV2Report {
  const headN = options.keepHeadEvents ?? V2_DEFAULTS.keepHeadEvents;
  const tailN = options.keepTailEvents ?? V2_DEFAULTS.keepTailEvents;
  const total = covered.length;
  let kept: AnyRunEvent[];
  let dropped = 0;
  let gapNote = '';
  if (total <= headN + tailN) {
    kept = [...covered];
  } else {
    const head = covered.slice(0, headN);
    const tail = covered.slice(total - tailN);
    kept = [...head, ...tail];
    dropped = total - kept.length;
    const gapFrom = head[head.length - 1]!.seq + 1;
    const gapTo = tail[0]!.seq - 1;
    gapNote = `… [${dropped} events đã bỏ, seq ${gapFrom}..${gapTo}] …`;
  }
  const lines = kept.map(describeEventLine);
  const keptTranscript = gapNote === '' ? lines.join('\n') : [...lines.slice(0, headN), gapNote, ...lines.slice(headN)].join('\n');
  const summary =
    `Truncated log (events 1..${upToSeq}, ${total} events, giữ ${kept.length}, bỏ ${dropped}):\n` +
    keptTranscript;
  const tokensAfter = estimateTokens(summary);
  return {
    strategy: 'truncate',
    upToSeq,
    eventsCovered: total,
    eventsKept: kept.length,
    eventsDropped: dropped,
    summary,
    keptTranscript,
    tokensBefore,
    tokensAfter,
    ...savings(tokensBefore, tokensAfter),
  };
}

/** Nén bằng chiến lược `extract-keep` (giữ event quan trọng + tóm tắt phần còn lại). */
function condenseExtractKeep(
  covered: AnyRunEvent[],
  upToSeq: number,
  options: CondenseV2Options,
  tokensBefore: number,
): CondenserV2Report {
  // Model response cuối (kết quả gần nhất) luôn giữ.
  let lastModelResponseSeq = -1;
  for (let i = covered.length - 1; i >= 0; i -= 1) {
    if (covered[i]!.type === 'model.response') {
      lastModelResponseSeq = covered[i]!.seq;
      break;
    }
  }
  const kept: AnyRunEvent[] = [];
  const rest: AnyRunEvent[] = [];
  for (const e of covered) {
    const isErrorResult =
      e.type === 'tool.result' && (e.payload as { status?: unknown }).status === 'error';
    if (EXTRACT_KEEP_TYPES.has(e.type) || isErrorResult || e.seq === lastModelResponseSeq) {
      kept.push(e);
    } else {
      rest.push(e);
    }
  }
  const keptTranscript = kept.map(describeEventLine).join('\n');
  const restSummary = rest.length > 0 ? condenseEvents(rest, options).summary : '';
  const summary =
    `Extract-keep (events 1..${upToSeq}, ${covered.length} events, giữ nguyên văn ${kept.length}, tóm tắt ${rest.length}):\n` +
    `--- kept verbatim ---\n${keptTranscript}` +
    (restSummary === '' ? '' : `\n--- rest summarized ---\n${restSummary}`);
  const tokensAfter = estimateTokens(summary);
  return {
    strategy: 'extract-keep',
    upToSeq,
    eventsCovered: covered.length,
    eventsKept: kept.length,
    eventsDropped: rest.length,
    summary,
    keptTranscript,
    tokensBefore,
    tokensAfter,
    ...savings(tokensBefore, tokensAfter),
  };
}

/**
 * Nén prefix của run bằng chiến lược đã chọn. `strategy` không set thì
 * dùng `recommendStrategy` trên prefix thật. Trả báo cáo đo thật
 * (tokensBefore/After/Saved + tỉ lệ). Không ghi gì vào log — chỉ tính.
 * Ném lỗi khi run không có event nào.
 */
export function condenseEventsV2(
  events: readonly AnyRunEvent[],
  options: CondenseV2Options = {},
): CondenserV2Report {
  const totalSeq = events.length === 0 ? 0 : events[events.length - 1]!.seq;
  const upToSeq = options.upToSeq ?? totalSeq;
  if (events.length === 0) {
    throw new Error('Không nén được: run chưa có event nào.');
  }
  if (!Number.isInteger(upToSeq) || upToSeq < 0 || upToSeq > totalSeq) {
    throw new Error(`upToSeq ${upToSeq} ngoài khoảng 0..${totalSeq}.`);
  }
  const covered = events.filter((e) => e.seq <= upToSeq);
  const strategy = options.strategy ?? recommendStrategy(covered).strategy;
  const tokensBefore = estimateEventsTokens(covered);
  switch (strategy) {
    case 'truncate':
      return condenseTruncate(covered, upToSeq, options, tokensBefore);
    case 'extract-keep':
      return condenseExtractKeep(covered, upToSeq, options, tokensBefore);
    case 'summarize':
    default:
      return condenseSummarize(covered, upToSeq, options, tokensBefore);
  }
}

/** Nén một run trong store (đọc log rồi gọi `condenseEventsV2`). */
export function condenseRunV2(
  store: RunLogStore,
  runId: string,
  options: CondenseV2Options = {},
): CondenserV2Report {
  const { events } = store.readRun(runId);
  if (events.length === 0) throw new Error(`Không nén được: run ${runId} chưa có event nào.`);
  return condenseEventsV2(events, options);
}

/**
 * Nén một run rồi append marker `run.compacted` mang bản tóm tắt
 * (giống v1, để UI/loop dùng tóm tắt thay prefix). Event gốc không mất.
 */
export function compactRunV2(
  store: RunLogStore,
  runId: string,
  options: CondenseV2Options = {},
): CompactRunV2Result {
  const report = condenseRunV2(store, runId, options);
  const marker = store.append(runId, {
    type: 'run.compacted',
    payload: {
      upToSeq: report.upToSeq,
      summary: report.summary,
      eventsReplaced: report.eventsCovered,
      tokensBefore: report.tokensBefore,
      tokensAfter: report.tokensAfter,
    },
  });
  return { ...report, markerSeq: marker.seq };
}
