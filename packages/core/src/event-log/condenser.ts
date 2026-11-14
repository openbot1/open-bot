/**
 * Condenser — nén event stream thành bản tóm tắt (v1.03, Đội T1).
 *
 * Ý tưởng học từ survey v1.03 (OpenHands V1: condenser treo trên
 * event stream; Mem0/Letta: nén history để tiết kiệm context): khi
 * một run đã dài, thay vì nạp toàn bộ event vào context, condenser
 * tóm tắt prefix thành vài trăm token rồi ghi marker `run.compacted`.
 * Event gốc vẫn còn nguyên trên đĩa — compaction không xoá lịch sử,
 * chỉ cho phép UI/loop dùng bản tóm tắt thay cho prefix khi cần.
 *
 * Tóm tắt ở đây là trích xuất xác định (extractive, không gọi LLM):
 * prompt gốc, tool nào đã chạy bao nhiêu lần / lỗi mấy lần, file nào
 * đã đổi, lỗi biên dịch nào lặp lại, text cuối. Nhờ xác định nên
 * cùng một log luôn cho cùng một bản tóm tắt — test được, replay
 * được, và không tốn thêm token model.
 */

import { estimateTokens } from '../agent/tokens';
import type { RunLogStore } from './store';
import type { AnyRunEvent } from './types';

/** Ước lượng token của một event (text + output preview + lỗi). */
export function estimateEventTokens(event: AnyRunEvent): number {
  const p = event.payload as unknown as Record<string, unknown>;
  let chars = 0;
  for (const key of ['text', 'outputPreview', 'firstError', 'message', 'finalText', 'summary']) {
    const v = p[key];
    if (typeof v === 'string') chars += v.length;
  }
  const toolCalls = p['toolCalls'];
  if (Array.isArray(toolCalls)) {
    for (const c of toolCalls) {
      const cc = c as { tool?: unknown };
      if (typeof cc.tool === 'string') chars += cc.tool.length;
    }
  }
  return Math.max(1, Math.ceil(chars / 4)) + 8; // +8 token overhead/ event
}

/** Ngưỡng quyết định có nên nén hay không. */
export interface CondenseOptions {
  /** Nén khi event >= ngưỡng này. Mặc định 40. */
  minEvents?: number;
  /** Nén khi ước lượng token >= ngưỡng này. Mặc định 4000. */
  minTokens?: number;
  /** Tóm tắt tối đa bao nhiêu ký tự (sanitize cắt ở 2000 — giữ dưới). Mặc định 1500. */
  maxSummaryChars?: number;
  /** Tóm tắt tối đa bao nhiêu file change liệt kê. Mặc định 10. */
  maxFilesListed?: number;
}

/** Kết quả kiểm tra "có nên nén run này không". */
export interface CondenseCheck {
  needed: boolean;
  reason: string;
  eventCount: number;
  estimatedTokens: number;
}

/** Bản tóm tắt trích xuất của một prefix event. */
export interface Condensation {
  /** Seq cuối cùng mà bản tóm tắt bao phủ (bao gồm). */
  upToSeq: number;
  /** Số event đã bao phủ. */
  eventsCovered: number;
  /** Bản tóm tắt (<= maxSummaryChars). */
  summary: string;
  /** Ước lượng token của prefix gốc. */
  tokensBefore: number;
  /** Ước lượng token của bản tóm tắt. */
  tokensAfter: number;
}

const CONDENSE_DEFAULTS: Required<CondenseOptions> = {
  minEvents: 40,
  minTokens: 4000,
  maxSummaryChars: 1500,
  maxFilesListed: 10,
};

/** Đếm event + token của một run để quyết định có nên nén không. */
export function shouldCondense(
  events: readonly AnyRunEvent[],
  options: CondenseOptions = {},
): CondenseCheck {
  const o = { ...CONDENSE_DEFAULTS, ...options };
  const estimatedTokens = events.reduce((sum, e) => sum + estimateEventTokens(e), 0);
  if (events.length >= o.minEvents) {
    return {
      needed: true,
      reason: `event count ${events.length} >= ${o.minEvents}`,
      eventCount: events.length,
      estimatedTokens,
    };
  }
  if (estimatedTokens >= o.minTokens) {
    return {
      needed: true,
      reason: `estimated tokens ${estimatedTokens} >= ${o.minTokens}`,
      eventCount: events.length,
      estimatedTokens,
    };
  }
  return {
    needed: false,
    reason: `below thresholds (${events.length} events, ~${estimatedTokens} tokens)`,
    eventCount: events.length,
    estimatedTokens,
  };
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/**
 * Tóm tắt trích xuất dãy event thành một bản ngắn.
 * `upToSeq` mặc định = seq cuối (tóm tắt toàn bộ); nhỏ hơn thì chỉ
 * tóm tắt prefix tới đó. Log rỗng → summary rỗng, tokens 0.
 */
export function condenseEvents(
  events: readonly AnyRunEvent[],
  options: CondenseOptions & { upToSeq?: number } = {},
): Condensation {
  const o = { ...CONDENSE_DEFAULTS, ...options };
  const covered = options.upToSeq === undefined
    ? [...events]
    : events.filter((e) => e.seq <= options.upToSeq!);
  if (covered.length === 0) {
    return { upToSeq: 0, eventsCovered: 0, summary: '', tokensBefore: 0, tokensAfter: 0 };
  }
  const upToSeq = covered[covered.length - 1]!.seq;
  const tokensBefore = covered.reduce((sum, e) => sum + estimateEventTokens(e), 0);

  let prompt = '';
  let finalText = '';
  let status = 'running';
  let steps = 0;
  const toolCounts = new Map<string, { calls: number; errors: number }>();
  const files: string[] = [];
  const compileErrors: string[] = [];
  for (const event of covered) {
    const p = event.payload as unknown as Record<string, unknown>;
    switch (event.type) {
      case 'run.prompt':
        if (typeof p['text'] === 'string') prompt = p['text'] as string;
        break;
      case 'model.response': {
        if (typeof p['step'] === 'number') steps = Math.max(steps, (p['step'] as number) + 1);
        const calls = p['toolCalls'];
        if (Array.isArray(calls)) {
          for (const c of calls) {
            const cc = c as { tool?: unknown };
            if (typeof cc.tool !== 'string') continue;
            const entry = toolCounts.get(cc.tool) ?? { calls: 0, errors: 0 };
            entry.calls += 1;
            toolCounts.set(cc.tool, entry);
          }
        }
        break;
      }
      case 'tool.result': {
        if (p['status'] === 'error' && typeof p['tool'] === 'string') {
          const entry = toolCounts.get(p['tool'] as string) ?? { calls: 0, errors: 0 };
          entry.errors += 1;
          toolCounts.set(p['tool'] as string, entry);
        }
        break;
      }
      case 'file.change':
        if (typeof p['path'] === 'string') files.push(p['path'] as string);
        break;
      case 'compile.error':
        if (typeof p['firstError'] === 'string') compileErrors.push(p['firstError'] as string);
        break;
      case 'run.completed':
        status = 'completed';
        if (typeof p['finalText'] === 'string') finalText = p['finalText'] as string;
        break;
      case 'run.failed':
        status = 'failed';
        if (typeof p['message'] === 'string') finalText = p['message'] as string;
        break;
      case 'run.aborted':
        status = 'aborted';
        break;
      default:
        break;
    }
  }

  const lines: string[] = [];
  lines.push(`Run summary (events 1..${upToSeq}, ${covered.length} events, ~${tokensBefore} tokens, status: ${status}, steps: ${steps}):`);
  if (prompt !== '') lines.push(`Prompt: ${clip(prompt, 300)}`);
  if (toolCounts.size > 0) {
    const parts = [...toolCounts.entries()]
      .sort((a, b) => b[1].calls - a[1].calls)
      .map(([tool, c]) => (c.errors > 0 ? `${tool} x${c.calls} (${c.errors} errors)` : `${tool} x${c.calls}`));
    lines.push(`Tools: ${parts.join(', ')}`);
  }
  if (files.length > 0) {
    const shown = files.slice(0, o.maxFilesListed);
    lines.push(
      `Files changed (${files.length}): ${shown.join(', ')}${files.length > shown.length ? `, +${files.length - shown.length} more` : ''}`,
    );
  }
  if (compileErrors.length > 0) {
    const unique = [...new Set(compileErrors)];
    lines.push(`Compile errors (${compileErrors.length}, ${unique.length} unique): ${clip(unique[0]!, 200)}`);
  }
  if (finalText !== '') lines.push(`Outcome: ${clip(finalText, 300)}`);

  let summary = lines.join('\n');
  if (summary.length > o.maxSummaryChars) summary = `${summary.slice(0, o.maxSummaryChars - 1)}…`;
  return {
    upToSeq,
    eventsCovered: covered.length,
    summary,
    tokensBefore,
    tokensAfter: estimateTokens(summary),
  };
}

/** Kết quả của `compactRun`: bản tóm tắt + seq của event marker đã ghi. */
export interface CompactRunResult extends Condensation {
  /** Seq của event `run.compacted` vừa append. */
  markerSeq: number;
}

/**
 * Nén một run: tóm tắt prefix tới `upToSeq` (mặc định = toàn bộ log
 * hiện tại) rồi append event `run.compacted` mang bản tóm tắt.
 * Ném lỗi khi run không có event nào.
 */
export function compactRun(
  store: RunLogStore,
  runId: string,
  options: CondenseOptions & { upToSeq?: number } = {},
): CompactRunResult {
  const { events } = store.readRun(runId);
  if (events.length === 0) throw new Error(`Không nén được: run ${runId} chưa có event nào.`);
  const condensation = condenseEvents(events, options);
  const marker = store.append(runId, {
    type: 'run.compacted',
    payload: {
      upToSeq: condensation.upToSeq,
      summary: condensation.summary,
      eventsReplaced: condensation.eventsCovered,
      tokensBefore: condensation.tokensBefore,
      tokensAfter: condensation.tokensAfter,
    },
  });
  return { ...condensation, markerSeq: marker.seq };
}
