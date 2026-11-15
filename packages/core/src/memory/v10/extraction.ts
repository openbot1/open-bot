/**
 * Extraction v10 — bước 1 của pipeline kiểu Mem0 (v1.10, Đội T1).
 *
 * Pipeline 2 bước tách rời (bước 2 ở consolidation.ts):
 *  1. Extraction (file này): rút fact ứng viên từ từng turn + chấm
 *     salience + lọc noise. Chỉ fact đủ nổi bật mới đi tiếp.
 *  2. Consolidation: so fact ứng viên với fact cũ → ADD / UPDATE /
 *     DELETE / QUARANTINE.
 *
 * Extractor nền tái dùng `RuleBasedFactExtractor` của graph v0.98
 * (luật xác định, offline, không bịa fact) — v10 thêm 3 lớp trên nó:
 *  a. Salience: trọng số predicate (sở thích/dị ứng/tên cao hơn
 *     khẳng định chung) × độ đặc thù của object (object càng cụ thể
 *     càng đáng nhớ) × độ tin cậy gốc.
 *  b. Noise filter: chào hỏi, câu filler, câu chỉ hỏi, câu quá ngắn,
 *     câu không khớp pattern fact nào — bị drop với lý do rõ ràng
 *     (NOISE), không bao giờ lọt vào store.
 *  c. Negation + validity window: "không còn thích X nữa" → ứng viên
 *     DELETE (isNegation); "từ tháng 3...", "since March 2026",
 *     "đến 2024" → cửa sổ hiệu lực suy ra từ text để bi-temporal
 *     graph ghi đúng trục validity.
 * Ngoài fact, extractor còn rút thủ tục (procedural): câu hướng dẫn
 * nhiều bước ("để ... thì ...", "bước 1... bước 2...", "first... then...")
 * thành ứng viên V10ProceduralCandidate cho procedural store.
 */

import { RuleBasedFactExtractor } from '../graph/extract';
import type { CandidateFact } from '../graph/types';
import type { MemoryScope } from '../graph/types';
import {
  normalizeV10Text,
  type V10ExtractedCandidate,
  type V10ExtractionResult,
  type V10NoiseReason,
  type V10ProceduralCandidate,
} from './types';

/** Trọng số salience theo predicate — fact về con người càng "cứng"
 *  (tên, dị ứng, nơi sống) càng đáng nhớ; khẳng định chung thấp nhất. */
export const V10_PREDICATE_SALIENCE: Record<string, number> = {
  name_is: 1.0,
  allergic_to: 1.0,
  lives_in: 0.95,
  birthday: 0.95,
  works_at: 0.85,
  works_as: 0.85,
  favorite_food: 0.85,
  favorite_drink: 0.85,
  favorite_movie: 0.8,
  favorite_music: 0.8,
  likes: 0.8,
  dislikes: 0.85,
  speaks: 0.8,
  prefers: 0.75,
  hobby: 0.8,
  goal: 0.85,
  owns: 0.7,
  wants: 0.7,
  location: 0.75,
  states: 0.5,
};

/** Ngưỡng salience: dưới ngưỡng này ứng viên bị drop là noise. */
export const V10_SALIENCE_THRESHOLD = 0.3;

/** Câu chào / tạm biệt / filler — noise, không chứa fact. */
const NOISE_PATTERNS: { re: RegExp; reason: V10NoiseReason }[] = [
  { re: /^(xin\s+chào|chào\s+(bạn|mọi người|anh|chị|em)?|hello|hi|hey|good\s+morning|good\s+afternoon)\b/iu, reason: 'greeting' },
  { re: /^(tạm\s+biệt|bye|goodbye|see\s+you|hẹn\s+gặp\s+lại)\b/iu, reason: 'greeting' },
  { re: /^(ok|okay|ừ|ừm|à|ờ|vâng|dạ|haha+|lol|👍)\s*[.!?]*$/iu, reason: 'filler' },
  { re: /^(cảm\s+ơn|thanks?|thank\s+you)(\s+\S+){0,2}\s*[.!?]*$/iu, reason: 'filler' },
  { re: /^(được\s+rồi|ok\s+rồi|thế\s+nhé|nhé|nha|thôi)\s*[.!?]*$/iu, reason: 'filler' },
];

/** Câu chỉ hỏi (kết thúc bằng ? và không chứa mệnh đề khẳng định
 *  về bản thân) — câu hỏi không phải fact. */
const QUESTION_RE = /\?\s*$/u;

/** Mẫu phủ định — "không còn ..." / "no longer ..." → DELETE. */
const NEGATION_RES = [
  /không\s+còn\s+/iu,
  /không\s+(?:thích|sống|ở|làm|nữa)/iu,
  /\bno\s+longer\b/iu,
  /\b(don'?t|do\s+not|doesn'?t)\s+(?:really\s+)?(like|live|work)\b/iu,
  /\bnot\s+(?:a|an|the)\s+\w+\s+anymore\b/iu,
];

/** Từ dừng tiếng Việt/Anh để đo độ đặc thù của object: object chỉ
 *  toàn từ dừng thì không cụ thể, salience thấp. */
const STOPWORDS = new Set([
  'nó', 'này', 'kia', 'vậy', 'thế', 'đó', 'nữa', 'it', 'that', 'this', 'thing', 'stuff',
]);

export function isV10NegationText(text: string): boolean {
  return NEGATION_RES.some((re) => re.test(text));
}

/**
 * Suy cửa sổ hiệu lực từ text. Hiểu các dạng:
 *  - "từ tháng 3/2026", "từ 2020", "since March 2026", "from 2020"
 *    → validFrom.
 *  - "đến 2024", "tới tháng 6/2025", "until 2024", "to June 2025"
 *    → validUntil.
 * Không suy ra được → undefined (caller dùng learnedAt làm validFrom).
 * Tháng/năm suy ra ngày đầu tháng; "đến tháng X" suy ra ngày đầu
 * tháng SAU X (cửa sổ [from, until) nửa-mở).
 */
export function parseValidityWindow(
  text: string,
  referenceDate: Date = new Date(),
): { validFrom?: string; validUntil?: string | null } | undefined {
  const lower = text.toLowerCase();
  const monthNames: Record<string, number> = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
    jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
  };
  const refYear = referenceDate.getFullYear();
  let validFrom: string | undefined;
  let validUntil: string | null | undefined;

  // "từ tháng 3/2026" / "từ tháng 3" / "từ 2020" / "since March 2026" / "from 2020"
  const fromMonthYear = lower.match(/(?:từ\s+tháng\s+(\d{1,2})\s*(?:\/\s*(\d{4}))?|since\s+([a-z]+)\s+(\d{4})|from\s+([a-z]+)\s+(\d{4})|từ\s+(\d{4}))/u);
  if (fromMonthYear) {
    if (fromMonthYear[1]) {
      const m = Math.min(12, Math.max(1, Number(fromMonthYear[1])));
      const y = fromMonthYear[2] ? Number(fromMonthYear[2]) : refYear;
      validFrom = new Date(Date.UTC(y, m - 1, 1)).toISOString();
    } else if (fromMonthYear[3] && monthNames[fromMonthYear[3]] !== undefined) {
      validFrom = new Date(Date.UTC(Number(fromMonthYear[4]), monthNames[fromMonthYear[3]], 1)).toISOString();
    } else if (fromMonthYear[5] && monthNames[fromMonthYear[5]] !== undefined) {
      validFrom = new Date(Date.UTC(Number(fromMonthYear[6]), monthNames[fromMonthYear[5]], 1)).toISOString();
    } else if (fromMonthYear[7]) {
      validFrom = new Date(Date.UTC(Number(fromMonthYear[7]), 0, 1)).toISOString();
    }
  }
  // "đến 2024" / "tới tháng 6/2025" / "until 2024" / "to June 2025"
  const untilMatch = lower.match(/(?:đến|tới)\s+(?:tháng\s+(\d{1,2})\s*(?:\/\s*(\d{4}))?|(\d{4}))|until\s+([a-z]+)\s+(\d{4})|until\s+(\d{4})|to\s+([a-z]+)\s+(\d{4})/u);
  if (untilMatch) {
    if (untilMatch[1]) {
      const m = Math.min(12, Math.max(1, Number(untilMatch[1])));
      const y = untilMatch[2] ? Number(untilMatch[2]) : refYear;
      validUntil = new Date(Date.UTC(y, m, 1)).toISOString();
    } else if (untilMatch[3]) {
      validUntil = new Date(Date.UTC(Number(untilMatch[3]) + 1, 0, 1)).toISOString();
    } else if (untilMatch[4] && monthNames[untilMatch[4]] !== undefined) {
      const m = monthNames[untilMatch[4]];
      validUntil = new Date(Date.UTC(Number(untilMatch[5]), m + 1, 1)).toISOString();
    } else if (untilMatch[6]) {
      validUntil = new Date(Date.UTC(Number(untilMatch[6]) + 1, 0, 1)).toISOString();
    } else if (untilMatch[7] && monthNames[untilMatch[7]] !== undefined) {
      const m = monthNames[untilMatch[7]];
      validUntil = new Date(Date.UTC(Number(untilMatch[8]), m + 1, 1)).toISOString();
    }
  }
  if (validFrom === undefined && validUntil === undefined) return undefined;
  return { validFrom, validUntil: validUntil ?? null };
}

/** Độ đặc thù của object 0..1: càng dài, càng ít từ dừng càng cao. */
export function objectSpecificity(objectText: string): number {
  const tokens = normalizeV10Text(objectText).split(' ').filter(Boolean);
  if (tokens.length === 0) return 0;
  const meaningful = tokens.filter((t) => !STOPWORDS.has(t)).length;
  const lengthScore = Math.min(1, tokens.join(' ').length / 24);
  return 0.5 * (meaningful / tokens.length) + 0.5 * lengthScore;
}

/** Chấm salience cho một fact ứng viên. */
export function scoreSalience(candidate: CandidateFact): number {
  const predicateWeight = V10_PREDICATE_SALIENCE[candidate.predicate] ?? 0.5;
  const specificity = objectSpecificity(candidate.objectText);
  const raw = candidate.confidence * (0.55 + 0.45 * predicateWeight) * (0.6 + 0.4 * specificity);
  return Math.round(Math.min(1, Math.max(0, raw)) * 1000) / 1000;
}

/** Kiểm tra một turn có phải noise toàn phần không (trả lý do). */
export function classifyTurnNoise(text: string): V10NoiseReason | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 'too-short';
  if (trimmed.length < 3) return 'too-short';
  for (const { re, reason } of NOISE_PATTERNS) {
    if (re.test(trimmed)) return reason;
  }
  // Câu chỉ hỏi, không có mệnh đề khẳng định về bản thân.
  if (QUESTION_RE.test(trimmed) && !/(tôi|mình|em|tớ|i\s+(?:like|live|work|am|have))\b/iu.test(trimmed)) {
    return 'question-only';
  }
  return null;
}

/** Tách các bước thủ tục từ text: "bước 1... bước 2...", "1. ... 2. ...",
 *  "đầu tiên ... sau đó ... cuối cùng ...", "first ... then ... finally ...".
 *  Bước đánh số có thể nằm inline, cách nhau bằng dấu phẩy ("bước 1 mở
 *  app, bước 2 chọn ảnh") nên trích bằng match thay vì split theo dòng. */
function splitProcedureSteps(text: string): string[] {
  const numbered = [...text.matchAll(/(?:bước\s+)?\d+\s*[.)]?\s*([^,;.\n]+)/giu)]
    .map((m) => (m[1] ?? '').trim())
    .filter((s) => s.length >= 2);
  if (numbered.length >= 2) return numbered.slice(0, 12).map((s) => s.slice(0, 200));
  const seqParts = text
    .split(/\s*(?:đầu tiên|sau đó|tiếp theo|cuối cùng|first|then|next|finally)\s*[:,]?\s*/iu)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3);
  if (seqParts.length >= 3) return seqParts.slice(0, 12).map((s) => s.slice(0, 200));
  return [];
}

/** Rút ứng viên thủ tục từ một turn (chỉ khi có dấu hiệu hướng dẫn). */
export function extractProcedures(text: string): V10ProceduralCandidate[] {
  const out: V10ProceduralCandidate[] = [];
  const trimmed = text.trim();
  if (trimmed.length < 20) return out;
  const hasInstructionSignal =
    /(?:để\s+.+\s+thì|muốn\s+.+\s+hãy|cách\s+(?:để|làm)|các\s+bước|bước\s+1|first\s+.+\s+then|how\s+to\s+|hãy\s+(?:làm|thực hiện))/iu.test(trimmed);
  if (!hasInstructionSignal) return out;
  const steps = splitProcedureSteps(trimmed);
  if (steps.length < 2) return out;
  // Trigger = mệnh đề "để ... thì" hoặc câu đầu tiên, cắt ngắn.
  const triggerMatch = trimmed.match(/(?:để|cách để|how to)\s+(.{3,80}?)(?:\s+thì|\s*,|\s*:|\n|$)/iu);
  const trigger = (triggerMatch?.[1] ?? trimmed.split(/[.!?\n]/u)[0] ?? '').trim().slice(0, 120);
  if (trigger.length < 3) return out;
  out.push({
    trigger,
    steps,
    confidence: 0.75,
    sourceText: trimmed.slice(0, 500),
  });
  return out;
}

/** Extractor v10: rule-based nền + salience + noise + negation + validity. */
export class V10Extractor {
  readonly name = 'v10-rule-based';
  private readonly base: RuleBasedFactExtractor;

  constructor() {
    this.base = new RuleBasedFactExtractor();
  }

  async extractTurn(
    text: string,
    scope: MemoryScope,
    opts: { episodeId: string; turnId: string; referenceDate?: Date },
  ): Promise<V10ExtractionResult> {
    const now = new Date().toISOString();
    const turnNoise = classifyTurnNoise(text);
    const raw = turnNoise === null ? await this.base.extract(text, scope, text) : [];
    const candidates: V10ExtractedCandidate[] = [];
    let noiseDropped = 0;
    if (turnNoise !== null) {
      // Cả turn là noise (chào hỏi/filler/câu hỏi thuần) → không có
      // ứng viên nào; đếm 1 lần drop để pipeline thấy được.
      noiseDropped = 1;
    }
    const seen = new Set<string>();
    for (const fact of raw) {
      const key = `${fact.subjectName}|${fact.predicate}|${normalizeV10Text(fact.objectText)}`;
      if (seen.has(key)) {
        noiseDropped += 1;
        continue;
      }
      seen.add(key);
      const salience = scoreSalience(fact);
      const isNegation = isV10NegationText(fact.sourceText);
      const validity = parseValidityWindow(text, opts.referenceDate);
      const isNoise = salience < V10_SALIENCE_THRESHOLD;
      if (isNoise) noiseDropped += 1;
      candidates.push({
        subject: fact.subjectName,
        predicate: fact.predicate,
        object: fact.objectText,
        confidence: fact.confidence,
        sourceText: fact.sourceText,
        salience,
        isNoise,
        noiseReason: isNoise ? 'low-salience' : undefined,
        isNegation,
        validity,
      });
    }
    const procedures = extractProcedures(text);
    return {
      episodeId: opts.episodeId,
      turnId: opts.turnId,
      candidates,
      procedures,
      noiseDropped,
      extractor: this.name,
      extractedAt: now,
    };
  }
}
