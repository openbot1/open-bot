/**
 * Mem0-style extraction + consolidation judge (v1.03, Đội T2 — Memory v4).
 *
 * Ý tưởng học từ Mem0 (LLM extract facts từ message, rồi judge
 * add/update/delete/noise qua LLM, lưu vector store theo scope
 * user/agent/run) nhưng tự thiết kế lại hoàn toàn cho open-bot, chạy
 * 100% local, KHÔNG gọi model: mọi quyết định đều là luật xác định
 * trên text, tái lập được và không bao giờ "sáng tác" fact mới.
 *
 * Pipeline một message đi qua 3 bước, trong một lần gọi duy nhất
 * (`judgeAndConsolidateMessage`):
 *
 *   1. EXTRACT — `FactExtractor` rút fact ứng viên từ message
 *      (mặc định `RuleBasedFactExtractor`, có thể thay bằng LLM
 *      extractor khi host cắm vào — cùng interface).
 *   2. JUDGE — mỗi ứng viên được phân loại TRƯỚC khi chạm store:
 *        NOISE       — không phải fact (chào hỏi, cảm ơn, câu hỏi
 *                      không chứa fact, mệnh lệnh cho bot, câu quá
 *                      ngắn / chỉ có từ dừng). Noise KHÔNG vào đồ
 *                      thị, chỉ ghi vào report để UI giải thích.
 *        ADD         — fact mới, chưa có trong đồ thị.
 *        UPDATE      — cùng (subject, predicate), object khác, ứng
 *                      viên đủ tin (hoặc fact cũ đã già) → thay thế.
 *        DELETE      — phủ định ("không còn thích ... nữa") nhắm
 *                      fact cũ đang có.
 *        QUARANTINE — mâu thuẫn fact cũ tin cậy cao, hoặc khớp mẫu
 *                      nghi ngờ (memory poisoning) → chờ user duyệt.
 *        SKIP        — trùng fact đã có, hoặc phủ định không có đích.
 *      Ngưỡng judge KHỚP với `consolidateCandidates` (stale 90 ngày,
 *      update >= 0.5, delete >= 0.9) để quyết định dự đoán = quyết
 *      định thực thi; test hồi quy kiểm tra điều này.
 *   3. APPLY — ứng viên không phải NOISE được đưa qua
 *      `consolidateCandidates` (cùng luật, cùng quarantine, cùng
 *      supersession) để ghi thật vào store; NOISE chỉ ghi report.
 *
 * Judge KHÔNG tự ý xoá fact tin cậy cao, KHÔNG tự áp dụng nội dung
 * nghi ngờ — hai tuyến phòng thủ đó giữ nguyên từ v0.98.
 */

import {
  consolidateCandidates,
  findSuspiciousPattern,
  isNegationText,
} from './graph/consolidateGraph';
import type {
  ConsolidateGraphOptions,
  ConsolidateGraphResult,
} from './graph/consolidateGraph';
import type { CandidateFact, ConsolidationDecision, MemoryScope } from './graph/types';
import { normalizeGraphText } from './graph/types';
import type { FactExtractor } from './graph/extract';
import type { TemporalGraphStore } from './graph/store';

/** Ngưỡng judge — khớp consolidateCandidates (v0.98). */
export const JUDGE_STALE_DAYS = 90;
export const JUDGE_MIN_CONFIDENCE_TO_UPDATE = 0.5;
export const JUDGE_MIN_CONFIDENCE_TO_DELETE = 0.9;
/** Câu ngắn hơn ngưỡng này không thể chứa fact (sau trim). */
export const JUDGE_MIN_FACT_CHARS = 8;

/** Quyết định của judge cho một ứng viên (mở rộng từ ConsolidationDecision). */
export type JudgeDecision = ConsolidationDecision | 'NOISE';

/** Một quyết định judge kèm lý do đọc được. */
export interface JudgeVerdict {
  decision: JudgeDecision;
  candidate: CandidateFact;
  /** Lý do bằng tiếng Việt/Anh để UI hiển thị. */
  reason: string;
  /** Fact cũ liên quan (mâu thuẫn / bị thay thế / bị xoá). */
  conflictingFactId?: string;
}

/** Mẫu NOISE — câu không mang fact bền vững. */
const NOISE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /^(xin\s+)?chào(\s+|$)/iu, label: 'lời chào' },
  { re: /^(hi|hello|hey|good\s+(morning|afternoon|evening))\b/iu, label: 'greeting' },
  { re: /^(cảm\s+ơn|thank(s|\s+you)|thanks)\b/iu, label: 'lời cảm ơn' },
  { re: /^(ok|okay|oke|được|ừ|uh|vâng|dạ)(\s|[.!?]|$)/iu, label: 'xác nhận ngắn' },
  { re: /^(tạm\s+biệt|bye|goodbye|good\s+night)\b/iu, label: 'lời chào tạm biệt' },
  { re: /^(haha|hehe|lol|:\)|:\(|😂|👍)/iu, label: 'cảm thán / emoji' },
  { re: /^(giúp\s+(tôi|mình)|can\s+you|please|hãy)\s+/iu, label: 'yêu cầu giúp đỡ (không phải fact)' },
  { re: /^(làm\s+ơn|pls|plz)\b/iu, label: 'yêu cầu lịch sự' },
  { re: /^(bạn\s+)?(là\s+ai|who\s+are\s+you)/iu, label: 'hỏi danh tính bot' },
  { re: /^(thời\s+tiết|mấy\s+giờ|what\s+time|what'?s\s+the\s+weather)/iu, label: 'hỏi thông tin thời sự' },
];

/** Câu hỏi thuần tuý (kết thúc bằng `?`, không chứa mẫu khẳng định fact). */
const QUESTION_RE = /[?？]\s*$/u;
/** Mệnh lệnh cho bot — không phải fact về user. */
const COMMAND_RE = /^(hãy|đừng|vui\s+lòng|please|do\s+not|don't|stop)\b/iu;

/**
 * Text có phải NOISE không (không mang fact)? Trả label lý do hoặc null.
 * Dùng cho cả judge (loại ứng viên) và UI (giải thích vì sao message
 * không sinh ra fact nào).
 */
export function classifyNoise(text: string): string | null {
  const trimmed = (text ?? '').trim();
  if (trimmed === '') return 'chuỗi rỗng';
  if (trimmed.length < JUDGE_MIN_FACT_CHARS) return 'câu quá ngắn, không chứa fact';
  for (const entry of NOISE_PATTERNS) {
    if (entry.re.test(trimmed)) return entry.label;
  }
  if (COMMAND_RE.test(trimmed)) return 'mệnh lệnh cho bot';
  if (QUESTION_RE.test(trimmed)) return 'câu hỏi (không khẳng định fact)';
  return null;
}

/** Đối tượng chuẩn hoá của ứng viên (để so trùng với fact cũ). */
function candidateObjectNorm(candidate: CandidateFact): string {
  return normalizeGraphText(candidate.objectText);
}

/**
 * Judge MỘT ứng viên: dự đoán quyết định consolidation sẽ áp dụng,
 * kèm lý do. Thuần đọc (không ghi store) — dùng để preview trước
 * khi apply, hoặc để UI hỏi user "có nên nhớ fact này không?".
 */
export function judgeCandidate(
  store: TemporalGraphStore,
  candidate: CandidateFact,
  scope: MemoryScope,
  opts: ConsolidateGraphOptions = {},
  now: Date = new Date(),
): JudgeVerdict {
  const staleDays = opts.staleDays ?? JUDGE_STALE_DAYS;
  const minUpdate = opts.minConfidenceToUpdate ?? JUDGE_MIN_CONFIDENCE_TO_UPDATE;
  const minDelete = opts.minConfidenceToDelete ?? JUDGE_MIN_CONFIDENCE_TO_DELETE;

  // 0. Noise xét trước hết: câu nguồn không mang fact thì ứng viên
  // cũng không có giá trị — dù extractor có rút được gì đi nữa.
  const noise = classifyNoise(candidate.sourceText);
  if (noise !== null) {
    return { decision: 'NOISE', candidate, reason: `Noise (${noise}) — không lưu fact.` };
  }
  const predicate = normalizeGraphText(candidate.predicate).replace(/\s+/g, '_');
  const objectNorm = candidateObjectNorm(candidate);
  if (predicate === '' || objectNorm === '') {
    return { decision: 'SKIP', candidate, reason: 'Fact ứng viên rỗng (thiếu predicate/object).' };
  }

  // 1. Mẫu nghi ngờ -> quarantine ngay (phòng thủ poisoning).
  const suspicious =
    findSuspiciousPattern(candidate.sourceText) ?? findSuspiciousPattern(candidate.objectText);
  if (suspicious !== null) {
    return {
      decision: 'QUARANTINE',
      candidate,
      reason: `Khớp mẫu nghi ngờ: ${suspicious}.`,
    };
  }

  const existing = store.findActiveFacts(candidate.subjectName, predicate, scope);
  const sameObject = existing.find(
    (f) => normalizeGraphText(f.objectText ?? '') === objectNorm,
  );

  // 2. Phủ định xét TRƯỚC dedupe (như consolidateCandidates).
  if (isNegationText(candidate.sourceText) || isNegationText(candidate.objectText)) {
    const target = pickNewest(existing);
    if (!target) {
      return { decision: 'SKIP', candidate, reason: 'Phủ định nhưng không có fact cũ để xoá.' };
    }
    if (target.confidence >= minDelete && candidate.confidence < target.confidence) {
      return {
        decision: 'QUARANTINE',
        candidate,
        conflictingFactId: target.id,
        reason: 'Xoá fact tin cậy cao — cần user duyệt.',
      };
    }
    return {
      decision: 'DELETE',
      candidate,
      conflictingFactId: target.id,
      reason: `Phủ định fact cũ: ${target.objectText}.`,
    };
  }

  if (sameObject) {
    return {
      decision: 'SKIP',
      candidate,
      conflictingFactId: sameObject.id,
      reason: 'Fact đã có sẵn (trùng object).',
    };
  }
  if (existing.length === 0) {
    return { decision: 'ADD', candidate, reason: 'Fact mới.' };
  }

  // 3. Mâu thuẫn: cùng (subject, predicate), object khác.
  const oldFact = pickNewest(existing);
  const oldAgeDays = (now.getTime() - Date.parse(oldFact.updatedAt)) / 86_400_000;
  const canUpdate =
    candidate.confidence >= oldFact.confidence ||
    candidate.confidence >= minUpdate ||
    oldAgeDays >= staleDays;
  if (!canUpdate) {
    return {
      decision: 'QUARANTINE',
      candidate,
      conflictingFactId: oldFact.id,
      reason: 'Mâu thuẫn fact cũ, ứng viên không đủ tin.',
    };
  }
  return {
    decision: 'UPDATE',
    candidate,
    conflictingFactId: oldFact.id,
    reason: `Thay thế fact cũ: ${oldFact.objectText}.`,
  };
}

function pickNewest<T extends { updatedAt: string }>(facts: T[]): T {
  return [...facts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

/** Kết quả extract + judge (chưa apply). */
export interface ExtractJudgeResult {
  ranAt: string;
  /** Số ứng viên extractor rút được. */
  extracted: number;
  verdicts: JudgeVerdict[];
  counts: Record<JudgeDecision, number>;
}

function emptyCounts(): Record<JudgeDecision, number> {
  return { ADD: 0, UPDATE: 0, DELETE: 0, QUARANTINE: 0, SKIP: 0, NOISE: 0 };
}

/**
 * Bước 1+2 của pipeline: extract từ một message rồi judge từng ứng
 * viên. Không ghi store — dùng để preview hoặc để host tự apply.
 */
export async function extractAndJudge(
  store: TemporalGraphStore,
  extractor: FactExtractor,
  text: string,
  scope: MemoryScope,
  opts: ConsolidateGraphOptions = {},
  now: Date = new Date(),
): Promise<ExtractJudgeResult> {
  const candidates = await extractor.extract(text, scope, text.slice(0, 500));
  const verdicts = candidates.map((c) => judgeCandidate(store, c, scope, opts, now));
  const counts = emptyCounts();
  for (const v of verdicts) counts[v.decision] += 1;
  return { ranAt: now.toISOString(), extracted: candidates.length, verdicts, counts };
}

/** Báo cáo đầy đủ của một lần extract + judge + apply. */
export interface JudgeConsolidateReport extends ConsolidateGraphResult {
  /** Số ứng viên bị loại là noise (không qua consolidation). */
  noise: number;
  /** Quyết định judge cho mọi ứng viên (kể cả NOISE). */
  verdicts: JudgeVerdict[];
}

/**
 * Pipeline đầy đủ cho MỘT message (Mem0-style one-pass): extract ->
 * judge -> apply (chỉ ứng viên không phải NOISE). Trả report gộp cả
 * quyết định judge và kết quả consolidation thực thi.
 *
 * Lưu ý: message toàn noise (vd chỉ "chào bạn") vẫn trả report hợp
 * lệ với extracted = 0, noise = 0 (không có ứng viên để judge) —
 * caller muốn biết message có phải noise thì dùng `classifyNoise`.
 */
export async function judgeAndConsolidateMessage(
  store: TemporalGraphStore,
  extractor: FactExtractor,
  text: string,
  scope: MemoryScope,
  provenanceBase: { turnId: string; runId: string; episodeId: string; at: string },
  opts: ConsolidateGraphOptions = {},
): Promise<JudgeConsolidateReport> {
  const now = new Date(provenanceBase.at);
  const judged = await extractAndJudge(store, extractor, text, scope, opts, now);
  const keep = judged.verdicts.filter((v) => v.decision !== 'NOISE');
  const noiseCount = judged.verdicts.length - keep.length;
  const applied = consolidateCandidates(
    store,
    keep.map((v) => v.candidate),
    scope,
    provenanceBase,
    opts,
  );
  // Ghi quyết định NOISE vào actions để report đầy đủ (không có factId).
  const noiseActions = judged.verdicts
    .filter((v) => v.decision === 'NOISE')
    .map((v) => ({ decision: 'NOISE' as const, candidate: v.candidate, reason: v.reason }));
  return {
    ...applied,
    noise: noiseCount,
    verdicts: judged.verdicts,
    actions: [...applied.actions, ...noiseActions],
  };
}
