/**
 * Condenser v2 cho coding agent v6 (v1.14, Đội T3).
 *
 * Ý tưởng học từ OpenHands Condenser (survey v1.14 §2): nén context
 * window khi hội thoại dài. Nối với condenser v1 (`event-log/
 * condenser.ts`: tóm tắt trích xuất prefix event, đo token thật) và
 * condenser v2 (`event-log/condenser-v2.ts`: 3 chiến lược summarize /
 * truncate / extract-keep): v6 giữ nguyên tắc "nén không xoá lịch
 * sử" (event gốc còn nguyên, chỉ append marker `v6.condensed`) nhưng
 * bản nén có CẤU TRÚC riêng cho coding agent:
 *
 *   - `decisions`: quyết định agent đã ghi (think "Quyết định: …" /
 *     finish summary) — thứ mất đi là mất mạch làm việc.
 *   - `filesChanged`: file nào đã đổi (path + số lần) — để turn sau
 *     biết code đang ở trạng thái nào.
 *   - `errorsEncountered`: lỗi đã gặp (text cắt ngắn + nguồn) — để
 *     không lặp lại lỗi cũ.
 *   - `openQuestions`: câu hỏi chưa trả lời (dòng kết thúc `?` trong
 *     think/user message chưa có câu trả lời sau đó).
 *   - `summary`: bản tóm tắt một đoạn (prompt + tool đã chạy + kết
 *     quả cuối) + số token đo thật (trước/sau/tiết kiệm).
 *
 * Hai đầu vào: log v6 (`condenseV6Log`) và danh sách message thuần
 * (`condenseV6Messages`, dùng khi agent loop chỉ giữ message, không
 * giữ event). `applyV6Condensation` thay prefix message bằng MỘT
 * message tóm tắt có cấu trúc để nạp lại vào context model.
 *
 * Module thuần, xác định (không gọi LLM): cùng một log luôn cho cùng
 * một bản nén — test được, replay được.
 */

import { estimateTokens } from '../agent/tokens';
import type { V6Event } from './types';
import { clipV6Text } from './conversationLog';

/** Tùy chọn condenser v6 (ngưỡng + giới hạn liệt kê). */
export interface V6CondenseOptions {
  /** Nén khi event >= ngưỡng này. Mặc định 40. */
  minEvents?: number;
  /** Nén khi ước lượng token >= ngưỡng này. Mặc định 4000. */
  minTokens?: number;
  /** Tóm tắt tối đa bao nhiêu ký tự. Mặc định 1500. */
  maxSummaryChars?: number;
  /** Tối đa bao nhiêu file liệt kê. Mặc định 10. */
  maxFilesListed?: number;
  /** Tối đa bao nhiêu lỗi liệt kê. Mặc định 10. */
  maxErrorsListed?: number;
  /** Tối đa bao nhiêu quyết định liệt kê. Mặc định 10. */
  maxDecisionsListed?: number;
}

/** Kết quả kiểm tra "có nên nén không". */
export interface V6CondenseCheck {
  needed: boolean;
  reason: string;
  eventCount: number;
  estimatedTokens: number;
}

/** Bản nén có cấu trúc của một prefix log/message. */
export interface V6Condensation {
  /** Seq cuối cùng bản nén bao phủ (bao gồm; 0 khi nén message). */
  upToSeq: number;
  /** Số event/message đã bao phủ. */
  covered: number;
  /** Bản tóm tắt một đoạn (<= maxSummaryChars). */
  summary: string;
  /** Quyết định giữ lại (theo thứ tự xuất hiện). */
  decisions: string[];
  /** File đã đổi (path + số lần). */
  filesChanged: Array<{ path: string; changes: number }>;
  /** Lỗi đã gặp (text cắt ngắn). */
  errorsEncountered: string[];
  /** Câu hỏi chưa có câu trả lời. */
  openQuestions: string[];
  /** Số tool/action đã chạy theo kind. */
  actionCounts: Record<string, number>;
  /** Token ước lượng của prefix gốc. */
  tokensBefore: number;
  /** Token ước lượng của bản nén. */
  tokensAfter: number;
  /** Token tiết kiệm được (có thể âm khi log ngắn). */
  tokensSaved: number;
}

const V6_CONDENSE_DEFAULTS: Required<V6CondenseOptions> = {
  minEvents: 40,
  minTokens: 4000,
  maxSummaryChars: 1500,
  maxFilesListed: 10,
  maxErrorsListed: 10,
  maxDecisionsListed: 10,
};

/** Ước lượng token của một event v6 (text + output + lỗi trong payload). */
export function estimateV6EventTokens(event: V6Event): number {
  const p = event.payload as Record<string, unknown>;
  let text = '';
  for (const key of ['text', 'summary', 'stdout', 'stderr', 'message', 'command', 'code']) {
    const v = p[key];
    if (typeof v === 'string') text += `${v}\n`;
  }
  return estimateTokens(text);
}

/** Đếm event + token để quyết định có nên nén log này không. */
export function shouldCondenseV6Log(events: readonly V6Event[], options: V6CondenseOptions = {}): V6CondenseCheck {
  const o = { ...V6_CONDENSE_DEFAULTS, ...options };
  const estimatedTokens = events.reduce((sum, e) => sum + estimateV6EventTokens(e), 0);
  if (events.length >= o.minEvents) {
    return { needed: true, reason: `đủ ${events.length} event (>= ${o.minEvents})`, eventCount: events.length, estimatedTokens };
  }
  if (estimatedTokens >= o.minTokens) {
    return { needed: true, reason: `~${estimatedTokens} token (>= ${o.minTokens})`, eventCount: events.length, estimatedTokens };
  }
  return {
    needed: false,
    reason: `chưa tới ngưỡng (${events.length} event, ~${estimatedTokens} token)`,
    eventCount: events.length,
    estimatedTokens,
  };
}

interface Collected {
  decisions: string[];
  files: Map<string, number>;
  errors: string[];
  questions: string[];
  actionCounts: Record<string, number>;
  prompt: string;
  lastText: string;
  steps: number;
}

function newCollected(): Collected {
  return { decisions: [], files: new Map(), errors: [], questions: [], actionCounts: {}, prompt: '', lastText: '', steps: 0 };
}

function addDecision(collected: Collected, text: string, max: number): void {
  const clean = text.trim();
  if (clean === '' || collected.decisions.includes(clean)) return;
  if (collected.decisions.length < max) collected.decisions.push(clean);
}

function addError(collected: Collected, text: string, max: number): void {
  const clean = clipV6Text(text.trim(), 300);
  if (clean === '' || collected.errors.includes(clean)) return;
  if (collected.errors.length < max) collected.errors.push(clean);
}

/** Trích câu hỏi (dòng kết thúc `?`) từ một đoạn text. */
export function extractOpenQuestions(text: string): string[] {
  const questions: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.endsWith('?') && trimmed.length > 3 && trimmed.length <= 200) {
      if (!questions.includes(trimmed)) questions.push(trimmed);
    }
  }
  return questions;
}

function collectFromEvent(collected: Collected, event: V6Event, o: Required<V6CondenseOptions>): void {
  const p = event.payload as Record<string, unknown>;
  switch (event.type) {
    case 'v6.user.message':
      if (typeof p['text'] === 'string') {
        if (collected.prompt === '') collected.prompt = clipV6Text(p['text'] as string, 300);
        for (const q of extractOpenQuestions(p['text'] as string)) {
          if (!collected.questions.includes(q)) collected.questions.push(q);
        }
      }
      break;
    case 'v6.model.message':
      if (typeof p['text'] === 'string') {
        collected.lastText = p['text'] as string;
        collected.steps += 1;
      }
      break;
    case 'v6.action.parsed': {
      const kind = typeof p['kind'] === 'string' ? (p['kind'] as string) : 'unknown';
      collected.actionCounts[kind] = (collected.actionCounts[kind] ?? 0) + 1;
      if (kind === 'think' && typeof p['text'] === 'string') {
        for (const line of (p['text'] as string).split('\n')) {
          const m = line.match(/^\s*(?:Quyết định|Decision)\s*:\s*(.+)\s*$/i);
          if (m?.[1]) addDecision(collected, m[1], o.maxDecisionsListed);
        }
        for (const q of extractOpenQuestions(p['text'] as string)) {
          if (!collected.questions.includes(q)) collected.questions.push(q);
        }
      }
      if (kind === 'finish' && typeof p['summary'] === 'string') {
        addDecision(collected, `Hoàn thành: ${p['summary'] as string}`, o.maxDecisionsListed);
      }
      break;
    }
    case 'v6.action.executed':
      if (typeof p['path'] === 'string') {
        const path = p['path'] as string;
        collected.files.set(path, (collected.files.get(path) ?? 0) + 1);
      }
      break;
    case 'v6.file.changed':
      if (typeof p['path'] === 'string') {
        const path = p['path'] as string;
        collected.files.set(path, (collected.files.get(path) ?? 0) + 1);
      }
      break;
    case 'v6.observation':
      if (p['ok'] === false) {
        const err = typeof p['stderr'] === 'string' && (p['stderr'] as string).trim() !== ''
          ? (p['stderr'] as string)
          : typeof p['stdout'] === 'string'
            ? (p['stdout'] as string)
            : '';
        addError(collected, err, o.maxErrorsListed);
      }
      break;
    case 'v6.error':
      if (typeof p['message'] === 'string') addError(collected, p['message'] as string, o.maxErrorsListed);
      break;
    default:
      break;
  }
}

function buildCondensation(
  collected: Collected,
  upToSeq: number,
  covered: number,
  tokensBefore: number,
  o: Required<V6CondenseOptions>,
): V6Condensation {
  const filesChanged = [...collected.files.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, o.maxFilesListed)
    .map(([path, changes]) => ({ path, changes }));
  const toolParts = Object.entries(collected.actionCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${kind} x${count}`);
  const parts: string[] = [];
  if (collected.prompt !== '') parts.push(`Task: ${collected.prompt}`);
  if (toolParts.length > 0) parts.push(`Đã chạy: ${toolParts.join(', ')}.`);
  if (filesChanged.length > 0) {
    parts.push(`File đã đổi: ${filesChanged.map((f) => `${f.path} (x${f.changes})`).join(', ')}.`);
  }
  if (collected.decisions.length > 0) {
    parts.push(`Quyết định: ${collected.decisions.join(' | ')}`);
  }
  if (collected.errors.length > 0) {
    parts.push(`Lỗi đã gặp: ${collected.errors.join(' | ')}`);
  }
  if (collected.questions.length > 0) {
    parts.push(`Câu hỏi mở: ${collected.questions.join(' | ')}`);
  }
  if (collected.lastText !== '') {
    parts.push(`Kết quả gần nhất: ${clipV6Text(collected.lastText, 300)}`);
  }
  let summary = parts.join(' ');
  if (summary.length > o.maxSummaryChars) summary = `${summary.slice(0, o.maxSummaryChars - 1)}…`;
  const tokensAfter = estimateTokens(summary);
  return {
    upToSeq,
    covered,
    summary,
    decisions: [...collected.decisions],
    filesChanged,
    errorsEncountered: [...collected.errors],
    openQuestions: [...collected.questions],
    actionCounts: { ...collected.actionCounts },
    tokensBefore,
    tokensAfter,
    tokensSaved: tokensBefore - tokensAfter,
  };
}

/**
 * Nén một prefix log v6 thành bản có cấu trúc. `upToSeq` mặc định =
 * seq cuối (nén toàn bộ); nhỏ hơn thì chỉ nén tới đó. Log rỗng →
 * bản nén rỗng, token 0.
 */
export function condenseV6Log(
  events: readonly V6Event[],
  options: V6CondenseOptions & { upToSeq?: number } = {},
): V6Condensation {
  const o = { ...V6_CONDENSE_DEFAULTS, ...options };
  const covered = options.upToSeq === undefined
    ? [...events]
    : events.filter((e) => e.seq <= (options.upToSeq as number));
  if (covered.length === 0) {
    return {
      upToSeq: 0,
      covered: 0,
      summary: '',
      decisions: [],
      filesChanged: [],
      errorsEncountered: [],
      openQuestions: [],
      actionCounts: {},
      tokensBefore: 0,
      tokensAfter: 0,
      tokensSaved: 0,
    };
  }
  const upToSeq = covered[covered.length - 1]!.seq;
  const tokensBefore = covered.reduce((sum, e) => sum + estimateV6EventTokens(e), 0);
  const collected = newCollected();
  for (const event of covered) collectFromEvent(collected, event, o);
  return buildCondensation(collected, upToSeq, covered.length, tokensBefore, o);
}

/** Một message trong lịch sử hội thoại (dạng agent loop giữ). */
export interface V6ChatMessage {
  role: 'user' | 'model' | 'system';
  text: string;
}

/**
 * Nén danh sách message thuần (không có event log). Dùng khi agent
 * loop chỉ giữ message: quyết định/file/lỗi được trích từ text
 * message (dòng `Quyết định:`, `File:`, `Lỗi:`).
 */
export function condenseV6Messages(messages: readonly V6ChatMessage[], options: V6CondenseOptions = {}): V6Condensation {
  const o = { ...V6_CONDENSE_DEFAULTS, ...options };
  const collected = newCollected();
  let tokensBefore = 0;
  for (const message of messages) {
    tokensBefore += estimateTokens(message.text);
    if (message.role === 'user' && collected.prompt === '') {
      collected.prompt = clipV6Text(message.text, 300);
    }
    for (const line of message.text.split('\n')) {
      const d = line.match(/^\s*(?:Quyết định|Decision)\s*:\s*(.+)\s*$/i);
      if (d?.[1]) addDecision(collected, d[1], o.maxDecisionsListed);
      const f = line.match(/^\s*(?:File|Tệp)\s*:\s*(\S+)\s*$/i);
      if (f?.[1]) {
        const path = f[1];
        collected.files.set(path, (collected.files.get(path) ?? 0) + 1);
      }
      const e = line.match(/^\s*(?:Lỗi|Error)\s*:\s*(.+)\s*$/i);
      if (e?.[1]) addError(collected, e[1], o.maxErrorsListed);
    }
    for (const q of extractOpenQuestions(message.text)) {
      if (message.role === 'user' && !collected.questions.includes(q)) collected.questions.push(q);
    }
    if (message.role === 'model') {
      collected.lastText = message.text;
      collected.steps += 1;
    }
  }
  return buildCondensation(collected, 0, messages.length, tokensBefore, o);
}

/**
 * Áp dụng bản nén vào danh sách message: giữ lại N message cuối
 * nguyên văn, thay toàn bộ message trước đó bằng MỘT message system
 * mang bản nén có cấu trúc. Trả danh sách mới (không sửa input).
 */
export function applyV6Condensation(
  messages: readonly V6ChatMessage[],
  condensation: V6Condensation,
  keepLast = 4,
): V6ChatMessage[] {
  if (messages.length === 0 || condensation.covered === 0) return [...messages];
  const kept = messages.slice(-keepLast);
  const lines: string[] = ['[Lịch sử đã nén — tóm tắt thay cho phần trước]'];
  if (condensation.summary !== '') lines.push(condensation.summary);
  if (condensation.decisions.length > 0) {
    lines.push(`Quyết định đã giữ: ${condensation.decisions.join(' | ')}`);
  }
  if (condensation.filesChanged.length > 0) {
    lines.push(`File đã đổi: ${condensation.filesChanged.map((f) => `${f.path} (x${f.changes})`).join(', ')}`);
  }
  if (condensation.errorsEncountered.length > 0) {
    lines.push(`Lỗi đã gặp (đừng lặp lại): ${condensation.errorsEncountered.join(' | ')}`);
  }
  const summaryMessage: V6ChatMessage = { role: 'system', text: lines.join('\n') };
  return [summaryMessage, ...kept];
}
