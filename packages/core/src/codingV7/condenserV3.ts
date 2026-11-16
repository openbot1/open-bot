/**
 * Condenser v3 (v1.15, Đội T4) — nén history dài thành summary có cấu trúc.
 *
 * Học ý tưởng Condenser của OpenHands V1 SDK (survey v1.15 §3) và nối
 * condenser v2 (v1.14), nhưng v7 viết lại với 3 điểm khác:
 * - Summary 6 mục cố định (goal / facts / decisions / filesChanged /
 *   errorsEncountered / openItems) — trích từ state đã fold + log,
 *   không cần gọi LLM (đo được, replay được, không tốn token).
 * - Trigger theo token budget: `shouldCondenseV7` đo ước lượng token
 *   của log (chars/4) so với budget; trả cả số token tiết kiệm được
 *   nếu condense tới seq N.
 * - Khôi phục context: `restoreV7Context(summary, log, afterSeq)`
 *   dựng lại prompt cho model từ summary + các event sau seq đã nén
 *   (event mới nhất còn nguyên, không mất thông tin gần đây).
 *
 * Module thuần (không fs, không gọi model).
 */

import type { V7CondensedSummary, V7Event, V7State } from './types';
import { clipV7Text, foldV7Events, emptyV7State } from './conversationLog';

/** Ước lượng token theo heuristic chars/4 (đủ cho trigger, không thay tiktoken). */
export function estimateV7Tokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Ước lượng token của toàn bộ log (text payload + overhead mỗi event). */
export function estimateV7LogTokens(events: readonly V7Event[]): number {
  let total = 0;
  for (const event of events) {
    total += 12; // overhead seq/type/hash
    total += estimateV7Tokens(JSON.stringify(event.payload));
  }
  return total;
}

/** Tùy chọn condenser. */
export interface V7CondenseOptions {
  /** Token budget của history: vượt thì nên condense. Mặc định 8000. */
  tokenBudget?: number;
  /** Số fact/quyết định/lỗi tối đa giữ trong summary. Mặc định 20. */
  maxItemsPerSection?: number;
}

/** Kết quả kiểm tra có nên condense không. */
export interface V7CondenseCheck {
  shouldCondense: boolean;
  /** Token ước lượng hiện tại của log. */
  tokens: number;
  /** Budget đã đặt. */
  budget: number;
  /** Token tiết kiệm được nếu condense toàn bộ tới seq cuối. */
  tokensSavedIfCondensed: number;
  /** Lý do (để ghi log). */
  reason: string;
}

/** Kiểm tra log có vượt token budget không. */
export function shouldCondenseV7Log(
  events: readonly V7Event[],
  options: V7CondenseOptions = {},
): V7CondenseCheck {
  const budget = options.tokenBudget ?? 8000;
  const tokens = estimateV7LogTokens(events);
  const summary = condenseV7Log(events, options);
  const tokensSavedIfCondensed = Math.max(0, tokens - summary.tokensAfter);
  return {
    shouldCondense: tokens > budget,
    tokens,
    budget,
    tokensSavedIfCondensed,
    reason:
      tokens > budget
        ? `log tokens ${tokens} exceed budget ${budget}; condensing saves ~${tokensSavedIfCondensed} tokens`
        : `log tokens ${tokens} within budget ${budget}`,
  };
}

function firstSentence(text: string, limit = 160): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit)}…`;
}

function uniqueLines(lines: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Nén log thành summary có cấu trúc 6 mục (không xóa log gốc).
 * `upToSeq` mặc định = seq cuối; có thể nén tới seq giữa để giữ
 * các event mới nhất nguyên vẹn.
 */
export function condenseV7Log(
  events: readonly V7Event[],
  options: V7CondenseOptions = {},
  upToSeq?: number,
): V7CondensedSummary {
  const maxItems = options.maxItemsPerSection ?? 20;
  const limit = upToSeq ?? (events[events.length - 1]?.seq ?? 0);
  const slice = events.filter((e) => e.seq <= limit);
  const state: V7State = foldV7Events(slice, emptyV7State(events[0]?.sessionId ?? 'unknown'));

  const facts: string[] = [];
  const decisions: string[] = [];
  const errorsEncountered: string[] = [];
  const openItems: string[] = [];

  for (const event of slice) {
    const p = event.payload;
    if (event.type === 'v7.user.message' && typeof p['text'] === 'string') {
      facts.push(`user asked: ${firstSentence(p['text'] as string)}`);
    }
    if (event.type === 'v7.action.parsed' && p['kind'] === 'think' && typeof p['text'] === 'string') {
      decisions.push(firstSentence(p['text'] as string));
    }
    if (event.type === 'v7.turn.finished' && typeof p['summary'] === 'string') {
      decisions.push(`turn finished: ${firstSentence(p['summary'] as string)}`);
    }
    if (event.type === 'v7.observation' && p['ok'] === false) {
      const errText = typeof p['stderr'] === 'string' && p['stderr']
        ? (p['stderr'] as string)
        : typeof p['stdout'] === 'string'
          ? (p['stdout'] as string)
          : 'action failed';
      errorsEncountered.push(firstSentence(errText));
    }
    if (event.type === 'v7.error' && typeof p['message'] === 'string') {
      errorsEncountered.push(firstSentence(p['message'] as string));
    }
    if (event.type === 'v7.action.blocked' && typeof p['reason'] === 'string') {
      errorsEncountered.push(`blocked: ${firstSentence(p['reason'] as string)}`);
    }
    if (event.type === 'v7.action.parsed' && p['kind'] === 'ask') {
      const q = typeof p['question'] === 'string' ? p['question'] : '';
      if (q) openItems.push(`waiting for user: ${firstSentence(q)}`);
    }
    if (event.type === 'v7.skill.activated' && typeof p['skill'] === 'string') {
      facts.push(`skill activated: ${p['skill']}`);
    }
  }

  // Việc còn dở: lỗi chưa có observation thành công sau đó.
  if (state.failedObservations > 0 && state.status !== 'finished') {
    openItems.push(`${state.failedObservations} failed observation(s) still unresolved`);
  }
  if (state.status === 'paused') openItems.push('session is paused — resume to continue');
  if (state.status === 'running' && decisions.length === 0 && slice.length > 0) {
    openItems.push('task in progress — no decision recorded yet');
  }

  const filesChanged = state.filesChanged.map(
    (f) => `${f.path} (${f.changes} change${f.changes > 1 ? 's' : ''}, seq ${f.firstSeq}–${f.lastSeq})`,
  );

  const summary: V7CondensedSummary = {
    upToSeq: limit,
    eventsCondensed: slice.length,
    goal: state.title || firstSentence(state.messages.find((m) => m.role === 'user')?.text ?? 'unknown task'),
    facts: uniqueLines(facts, maxItems),
    decisions: uniqueLines(decisions, maxItems),
    filesChanged: uniqueLines(filesChanged, maxItems),
    errorsEncountered: uniqueLines(errorsEncountered, maxItems),
    openItems: uniqueLines(openItems, maxItems),
    tokensBefore: estimateV7LogTokens(slice),
    tokensAfter: 0,
  };
  summary.tokensAfter = estimateV7Tokens(renderV7Summary(summary));
  return summary;
}

/** Render summary thành text đưa vào prompt cho model. */
export function renderV7Summary(summary: V7CondensedSummary): string {
  const section = (title: string, items: string[]): string =>
    items.length ? `${title}\n${items.map((i) => `- ${i}`).join('\n')}\n` : '';
  return [
    `[Condensed history up to seq ${summary.upToSeq} — ${summary.eventsCondensed} events, ~${summary.tokensBefore} → ~${summary.tokensAfter} tokens]`,
    `Goal: ${summary.goal}`,
    section('Facts:', summary.facts),
    section('Decisions:', summary.decisions),
    section('Files changed:', summary.filesChanged),
    section('Errors encountered:', summary.errorsEncountered),
    section('Open items:', summary.openItems),
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Khôi phục context cho model: summary + các event sau seq đã nén
 * (giữ nguyên text, không nén lại). Trả prompt text hoàn chỉnh.
 */
export function restoreV7Context(
  summary: V7CondensedSummary,
  events: readonly V7Event[],
): string {
  const after = events.filter((e) => e.seq > summary.upToSeq);
  const lines: string[] = [renderV7Summary(summary), '', `[Events after seq ${summary.upToSeq} — ${after.length} recent events, verbatim]`];
  for (const event of after) {
    lines.push(`#${event.seq} ${event.type}: ${clipV7Text(JSON.stringify(event.payload), 800)}`);
  }
  return lines.join('\n');
}

/** Áp dụng condensation vào state (chỉ cập nhật marker, không xóa log). */
export function applyV7Condensation(state: V7State, summary: V7CondensedSummary): V7State {
  return {
    ...state,
    condensations: state.condensations + 1,
    lastCondensedUpToSeq: summary.upToSeq,
  };
}
