/**
 * Memory v17 — Add-only single-pass extraction (v1.36, Doi T1).
 *
 * Y tuong hoc tu mem0 v3 (04/2026): extraction single-pass — MOT LLM call
 * duy nhat (hoac 0 call khi dung rule), chi sinh ADD; he thong KHONG bao
 * gio tu UPDATE/DELETE fact cu trong luc trich xuat. Moi thay doi deu di
 * qua conflict resolver (conflicts.ts) voi provenance day du.
 *
 * Rule extractor xac dinh (khong goi model): pattern tieng Viet + tieng
 * Anh cho cac edge pho bien (prefers / lives_in / works_at / owns /
 * speaks / member_of / allergic_to / has_goal / uses / ...), phat hien
 * phu dinh (\"khong con ... nua\", \"no longer ...\"), parse cua so hieu
 * luc (\"tu thang 3/2026\", \"until 2024\", \"den 2024\"), loai noise (chao
 * hoi / cam on / cau hoi don thuan), dedupe trong cung pass, loc
 * confidence duoi nguong.
 *
 * LLM extractor la interface tuy chon: host truyen 1 ham duy nhat duoc
 * goi toi da 1 lan / pass; ket qua LLM cung chi sinh candidate ADD,
 * van qua cung bo loc rule (noise/dedupe/threshold) truoc khi ghi.
 */

import {
  M17Error,
  M17ExtractedFact,
  M17ExtractionResult,
  M17EdgeType,
  M17EntityKind,
  M17_DEFAULT_MIN_CONFIDENCE,
  isValidEdgeTypeM17,
  normalizeCompareTextM17,
  normalizeEntityNameM17,
  truncateTextM17,
} from './types';

/** Nguong mac dinh. */
export const M17_EXTRACT_MIN_CONFIDENCE = M17_DEFAULT_MIN_CONFIDENCE;
/** Confidence mac dinh cho fact rule khop chac chan. */
export const M17_RULE_STRONG_CONFIDENCE = 0.85;
/** Confidence mac dinh cho fact rule khop vua. */
export const M17_RULE_MEDIUM_CONFIDENCE = 0.65;
/** Confidence mac dinh cho fact LLM tra ve (neu LLM khong kem score). */
export const M17_LLM_DEFAULT_CONFIDENCE = 0.7;
/** So LLM call toi da trong 1 pass (mem0 v3: 1). */
export const M17_MAX_LLM_CALLS_PER_PASS = 1;

/** Ham LLM tuy chon cua host: nhan toan bo turn, tra candidate JSON. */
export type M17LlmExtractFn = (
  turns: { role: string; text: string }[],
) => Promise<M17ExtractedFact[]>;

/** Input 1 turn de trich xuat. */
export interface M17TurnInput {
  role: 'user' | 'assistant' | 'system';
  text: string;
  episodeId: string;
  turnId: string;
}

/** Tuy chon extractor. */
export interface M17ExtractOptions {
  /** Nguong confidence toi thieu de giu candidate. */
  minConfidence?: number;
  /** Ham LLM tuy chon (neu co, goi toi da 1 lan / pass). */
  llmExtract?: M17LlmExtractFn;
  /** Chi lay turn cua user (mac dinh true — assistant noi khong phai fact ve user). */
  userTurnsOnly?: boolean;
  /** Gioi han so candidate / pass (chong spam). */
  maxCandidates?: number;
}

/** Loai noise cua turn. */
export type M17TurnNoise = 'greeting' | 'filler' | 'question-only' | null;

/** Pattern rule: regex + edge + cach lay object + kind entity + confidence. */
interface M17RulePattern {
  edge: M17EdgeType;
  /** Regex co 1 capture group la object (group 1). */
  re: RegExp;
  kind: M17EntityKind;
  confidence: number;
  /** Pattern phu dinh rieng cho edge nay (neu co). */
  negationRe?: RegExp;
}

/** Tien to phu dinh tieng Viet / Anh. */
const M17_NEGATION_PREFIXES =
  /^(tôi|tớ|mình|em|anh|chị|cháu|tui|i|we|my|mine|người dùng)\s+(không|chẳng|chả|không còn|đã không|don\'t|do not|doesn\'t|does not|no longer|not)\b/i;

/** Pattern phu dinh manh (\"khong con ... nua\" / \"no longer ...\"). */
const M17_STRONG_NEGATION = /không còn|không thích nữa|đã bỏ|đã ngừng|no longer|not anymore|stopped|quit\b/i;

/** Pattern rule tieng Viet. */
const M17_RULES_VI: M17RulePattern[] = [
  // Phu dinh manh phai dung TRUOC rule prefers duong (\"khong con thich\" != \"thich\").
  {
    edge: 'dislikes',
    re: /(?:tôi|tớ|mình|em|anh|chị|tui)\s+không còn (?:thích|yêu thích|mê|khoái)\s+(?:ăn\s+|uống\s+|nghe\s+|xem\s+|chơi\s+|đọc\s+)?(.+?)(?:\s*nữa)?[.!?,;]?\s*$/i,
    kind: 'thing',
    confidence: M17_RULE_STRONG_CONFIDENCE,
  },
  {
    edge: 'prefers',
    re: /(?:tôi|tớ|mình|em|anh|chị|tui)\s+(?:rất\s+)?(?:thích|yêu thích|mê|khoái)\s+(?:ăn\s+|uống\s+|nghe\s+|xem\s+|chơi\s+|đọc\s+)?(.+?)(?:\s*(?:nhất|nhiều|lắm|vô cùng))?[.!?,;]?\s*$/i,
    kind: 'thing',
    confidence: M17_RULE_STRONG_CONFIDENCE,
  },
  {
    edge: 'prefers',
    re: /(?:tôi|tớ|mình|em|anh|chị|tui)\s+(?:thích|yêu thích)\s+(.+?)[.!?,;]?\s*$/i,
    kind: 'thing',
    confidence: M17_RULE_MEDIUM_CONFIDENCE,
  },
  {
    edge: 'dislikes',
    re: /(?:tôi|tớ|mình|em|anh|chị|tui)\s+(?:không thích|ghét|dị ứng với|sợ)\s+(.+?)[.!?,;]?\s*$/i,
    kind: 'thing',
    confidence: M17_RULE_STRONG_CONFIDENCE,
  },
  {
    edge: 'allergic_to',
    re: /(?:tôi|tớ|mình|em|anh|chị|tui)\s+(?:bị\s+)?dị ứng (?:với\s+)?(.+?)[.!?,;]?\s*$/i,
    kind: 'food',
    confidence: M17_RULE_STRONG_CONFIDENCE,
  },
  {
    edge: 'lives_in',
    re: /(?:tôi|tớ|mình|em|anh|chị|tui)\s+(?:đang\s+)?(?:sống|ở)\s+(?:ở|tại)\s+(.+?)[.!?,;]?\s*$/i,
    kind: 'place',
    confidence: M17_RULE_STRONG_CONFIDENCE,
  },
  {
    edge: 'lives_in',
    re: /(?:tôi|tớ|mình|em|anh|chị|tui)\s+ở\s+(.+?)[.!?,;]?\s*$/i,
    kind: 'place',
    confidence: M17_RULE_MEDIUM_CONFIDENCE,
  },
  {
    edge: 'works_at',
    re: /(?:tôi|tớ|mình|em|anh|chị|tui)\s+(?:đang\s+)?(?:làm việc|làm)\s+(?:ở|tại|cho)\s+(.+?)[.!?,;]?\s*$/i,
    kind: 'organization',
    confidence: M17_RULE_STRONG_CONFIDENCE,
  },
  {
    edge: 'works_as',
    re: /(?:tôi|tớ|mình|em|anh|chị|tui)\s+là\s+(?:một\s+)?(.+?)(?:\s+(?:ở|tại)\s+.+)?[.!?,;]?\s*$/i,
    kind: 'thing',
    confidence: M17_RULE_MEDIUM_CONFIDENCE,
  },
  {
    edge: 'owns',
    re: /(?:tôi|tớ|mình|em|anh|chị|tui)\s+(?:có|sở hữu|mua)\s+(?:một\s+|cái\s+|chiếc\s+)?(.+?)[.!?,;]?\s*$/i,
    kind: 'thing',
    confidence: M17_RULE_MEDIUM_CONFIDENCE,
  },
  {
    edge: 'speaks',
    re: /(?:tôi|tớ|mình|em|anh|chị|tui)\s+(?:nói|biết)\s+tiếng\s+(.+?)[.!?,;]?\s*$/i,
    kind: 'language',
    confidence: M17_RULE_STRONG_CONFIDENCE,
  },
  {
    edge: 'member_of',
    re: /(?:tôi|tớ|mình|em|anh|chị|tui)\s+(?:là thành viên|tham gia)\s+(?:của\s+)?(.+?)[.!?,;]?\s*$/i,
    kind: 'organization',
    confidence: M17_RULE_STRONG_CONFIDENCE,
  },
  {
    edge: 'has_goal',
    re: /(?:tôi|tớ|mình|em|anh|chị|tui)\s+(?:muốn|dự định|đang cố)\s+(.+?)[.!?,;]?\s*$/i,
    kind: 'activity',
    confidence: M17_RULE_MEDIUM_CONFIDENCE,
  },
  {
    edge: 'uses',
    re: /(?:tôi|tớ|mình|em|anh|chị|tui)\s+(?:đang\s+)?(?:dùng|sử dụng|xài)\s+(.+?)[.!?,;]?\s*$/i,
    kind: 'tool',
    confidence: M17_RULE_MEDIUM_CONFIDENCE,
  },
  {
    edge: 'studies_at',
    re: /(?:tôi|tớ|mình|em|anh|chị|tui)\s+(?:đang\s+)?(?:học|đang học)\s+(?:ở|tại)\s+(.+?)[.!?,;]?\s*$/i,
    kind: 'organization',
    confidence: M17_RULE_STRONG_CONFIDENCE,
  },
  {
    edge: 'interested_in',
    re: /(?:tôi|tớ|mình|em|anh|chị|tui)\s+(?:quan tâm|hứng thú với|đam mê)\s+(.+?)[.!?,;]?\s*$/i,
    kind: 'activity',
    confidence: M17_RULE_MEDIUM_CONFIDENCE,
  },
];

/** Pattern rule tieng Anh. */
const M17_RULES_EN: M17RulePattern[] = [
  // Phu dinh manh dung truoc rule duong (\"no longer like\" != \"like\").
  {
    edge: 'dislikes',
    re: /\b(?:i|we)\s+no longer (?:like|love|enjoy)\s+(?:eating\s+|drinking\s+|listening to\s+|watching\s+|playing\s+|reading\s+)?(.+?)[.!?,;]?\s*$/i,
    kind: 'thing',
    confidence: M17_RULE_STRONG_CONFIDENCE,
  },
  {
    edge: 'prefers',
    re: /\b(?:i|we)\s+(?:really\s+)?(?:like|love|enjoy)\s+(?:eating\s+|drinking\s+|listening to\s+|watching\s+|playing\s+|reading\s+)?(.+?)[.!?,;]?\s*$/i,
    kind: 'thing',
    confidence: M17_RULE_STRONG_CONFIDENCE,
  },
  {
    edge: 'dislikes',
    re: /\b(?:i|we)\s+(?:don\'t like|do not like|hate|dislike)\s+(.+?)[.!?,;]?\s*$/i,
    kind: 'thing',
    confidence: M17_RULE_STRONG_CONFIDENCE,
  },
  {
    edge: 'allergic_to',
    re: /\b(?:i am|i\'m|we are|we\'re)\s+allergic to\s+(.+?)[.!?,;]?\s*$/i,
    kind: 'food',
    confidence: M17_RULE_STRONG_CONFIDENCE,
  },
  {
    edge: 'lives_in',
    re: /\b(?:i|we)\s+(?:live|am living|are living)\s+in\s+(.+?)[.!?,;]?\s*$/i,
    kind: 'place',
    confidence: M17_RULE_STRONG_CONFIDENCE,
  },
  {
    edge: 'works_at',
    re: /\b(?:i|we)\s+work\s+(?:at|for)\s+(.+?)[.!?,;]?\s*$/i,
    kind: 'organization',
    confidence: M17_RULE_STRONG_CONFIDENCE,
  },
  {
    edge: 'works_as',
    re: /\b(?:i am|i\'m|we are|we\'re)\s+an?\s+(.+?)[.!?,;]?\s*$/i,
    kind: 'thing',
    confidence: M17_RULE_MEDIUM_CONFIDENCE,
  },
  {
    edge: 'owns',
    re: /\b(?:i|we)\s+(?:have|own|bought)\s+an?\s+(.+?)[.!?,;]?\s*$/i,
    kind: 'thing',
    confidence: M17_RULE_MEDIUM_CONFIDENCE,
  },
  {
    edge: 'speaks',
    re: /\b(?:i|we)\s+speak\s+(.+?)[.!?,;]?\s*$/i,
    kind: 'language',
    confidence: M17_RULE_STRONG_CONFIDENCE,
  },
  {
    edge: 'member_of',
    re: /\b(?:i am|i\'m|we are|we\'re)\s+(?:a member of|part of)\s+(.+?)[.!?,;]?\s*$/i,
    kind: 'organization',
    confidence: M17_RULE_STRONG_CONFIDENCE,
  },
  {
    edge: 'has_goal',
    re: /\b(?:i|we)\s+(?:want to|plan to|aim to)\s+(.+?)[.!?,;]?\s*$/i,
    kind: 'activity',
    confidence: M17_RULE_MEDIUM_CONFIDENCE,
  },
  {
    edge: 'uses',
    re: /\b(?:i|we)\s+use\s+(.+?)[.!?,;]?\s*$/i,
    kind: 'tool',
    confidence: M17_RULE_MEDIUM_CONFIDENCE,
  },
  {
    edge: 'studies_at',
    re: /\b(?:i|we)\s+(?:study|am studying)\s+at\s+(.+?)[.!?,;]?\s*$/i,
    kind: 'organization',
    confidence: M17_RULE_STRONG_CONFIDENCE,
  },
  {
    edge: 'interested_in',
    re: /\b(?:i|we)\s+(?:am interested in|are interested in)\s+(.+?)[.!?,;]?\s*$/i,
    kind: 'activity',
    confidence: M17_RULE_MEDIUM_CONFIDENCE,
  },
  {
    edge: 'knows',
    re: /\b(?:i|we)\s+know\s+(.+?)[.!?,;]?\s*$/i,
    kind: 'person',
    confidence: M17_RULE_MEDIUM_CONFIDENCE,
  },
];

/** Pattern chao hoi / filler tieng Viet + Anh. */
const M17_NOISE_PATTERNS: { kind: M17TurnNoise; re: RegExp }[] = [
  { kind: 'greeting', re: /^(xin chào|chào bạn|chào buổi|hello|hi|hey|good (morning|afternoon|evening)|chào)\b/i },
  { kind: 'filler', re: /^(cảm ơn|cám ơn|thanks?|thank you|ok|okay|ừ|uhm|ừm|được rồi|tạm biệt|bye|goodbye|vâng|dạ)\b/i },
  { kind: 'question-only', re: /^[^.!?]*\?\s*$/ },
];

/** Pattern cua so hieu luc: \"tu thang 3/2026\", \"den 2024\", \"until 2024\", \"since 2020\". */
const M17_VALID_FROM_PATTERNS: { re: RegExp; build: (m: RegExpMatchArray) => string | null }[] = [
  {
    re: /từ tháng\s+(\d{1,2})\/(\d{4})/i,
    build: (m) => `${m[2]}-${m[1].padStart(2, '0')}-01T00:00:00.000Z`,
  },
  {
    re: /từ năm\s+(\d{4})/i,
    build: (m) => `${m[1]}-01-01T00:00:00.000Z`,
  },
  {
    re: /từ\s+(\d{4})/i,
    build: (m) => `${m[1]}-01-01T00:00:00.000Z`,
  },
  {
    re: /since\s+(\d{4})/i,
    build: (m) => `${m[1]}-01-01T00:00:00.000Z`,
  },
  {
    re: /since\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})/i,
    build: (m) => {
      const months = [
        'january', 'february', 'march', 'april', 'may', 'june',
        'july', 'august', 'september', 'october', 'november', 'december',
      ];
      const idx = months.indexOf(m[1].toLowerCase());
      if (idx < 0) return null;
      return `${m[2]}-${String(idx + 1).padStart(2, '0')}-01T00:00:00.000Z`;
    },
  },
];

const M17_VALID_TO_PATTERNS: { re: RegExp; build: (m: RegExpMatchArray) => string | null }[] = [
  {
    re: /đến (?:tháng\s+)?(\d{1,2})\/(\d{4})/i,
    build: (m) => `${m[2]}-${m[1].padStart(2, '0')}-01T00:00:00.000Z`,
  },
  {
    re: /đến (?:năm\s+)?(\d{4})/i,
    build: (m) => `${Number(m[1]) + 1}-01-01T00:00:00.000Z`,
  },
  {
    re: /until\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})/i,
    build: (m) => `${Number(m[1]) + 1}-01-01T00:00:00.000Z`,
  },
  {
    re: /until\s+(\d{4})/i,
    build: (m) => `${Number(m[1]) + 1}-01-01T00:00:00.000Z`,
  },
];

/** Phan loai noise cua 1 turn. */
export function classifyTurnNoiseM17(text: string): M17TurnNoise {
  const trimmed = text.trim();
  if (!trimmed) return 'filler';
  for (const { kind, re } of M17_NOISE_PATTERNS) {
    if (re.test(trimmed)) return kind;
  }
  return null;
}

/** Phat hien phu dinh trong text. */
export function detectNegationM17(text: string): boolean {
  return M17_STRONG_NEGATION.test(text) || M17_NEGATION_PREFIXES.test(text.trim());
}

/** Parse cua so hieu luc tu text (tra {validFrom, validTo} hoac null neu khong co). */
export function parseValidityWindowM17(
  text: string,
): { validFrom: string | null; validTo: string | null } | null {
  let validFrom: string | null = null;
  let validTo: string | null = null;
  for (const { re, build } of M17_VALID_FROM_PATTERNS) {
    const m = text.match(re);
    if (m) {
      validFrom = build(m);
      break;
    }
  }
  for (const { re, build } of M17_VALID_TO_PATTERNS) {
    const m = text.match(re);
    if (m) {
      validTo = build(m);
      break;
    }
  }
  if (!validFrom && !validTo) return null;
  return { validFrom, validTo };
}

/** Key dedupe trong pass: subject|edge|object chuan hoa. */
export function extractionKeyM17(fact: {
  subject: string;
  edge: string;
  object: string;
}): string {
  return [
    normalizeCompareTextM17(fact.subject),
    fact.edge,
    normalizeCompareTextM17(fact.object),
  ].join('|');
}

/** Lam sach object trich duoc: bo tu thua, gioi han do dai. */
export function cleanExtractedObjectM17(raw: string): string {
  let object = raw.trim();
  // Bo phan sau dau phay keo dai khong lien quan (vd \"pho bo, rat ngon\").
  object = object.split(/[,;]/)[0].trim();
  // Bo tien to \"an/uong\" thua neu con sot.
  object = object.replace(/^(ăn|uống|nghe|xem|chơi|đọc)\s+/i, '');
  object = normalizeEntityNameM17(object);
  return truncateTextM17(object, 200);
}

/** Trich fact tu 1 cau bang rule (khong LLM). */
export function extractFromSentenceM17(
  sentence: string,
  sourceText: string,
): M17ExtractedFact[] {
  const trimmed = sentence.trim();
  if (!trimmed) return [];
  if (classifyTurnNoiseM17(trimmed)) return [];
  const isNegation = detectNegationM17(trimmed);
  const window = parseValidityWindowM17(trimmed);
  const out: M17ExtractedFact[] = [];
  const rules = [...M17_RULES_VI, ...M17_RULES_EN];
  for (const rule of rules) {
    const m = trimmed.match(rule.re);
    if (!m || !m[1]) continue;
    const object = cleanExtractedObjectM17(m[1]);
    if (!object || object.length < 2) continue;
    // Phu dinh doi edge prefers -> dislikes (vd \"khong con thich pho\" = khong thich pho nua).
    let edge: M17EdgeType = rule.edge;
    let negation = isNegation;
    if (isNegation && rule.edge === 'prefers') {
      edge = 'dislikes';
      negation = false;
    }
    out.push({
      subject: 'user',
      edge,
      object,
      confidence: rule.confidence,
      isNegation: negation,
      validFrom: window?.validFrom ?? null,
      validTo: window?.validTo ?? null,
      mentionedEntities: [{ name: object, kind: rule.kind }],
      sourceText: truncateTextM17(sourceText, 500),
    });
    // Moi cau chi lay rule khop dau tien manh nhat (tranh candidate trung lap).
    break;
  }
  return out;
}

/** Tach text thanh cau (don gian, du cho rule extractor). */
export function splitSentencesM17(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Loc + dedupe candidate trong 1 pass. */
export function filterCandidatesM17(
  candidates: M17ExtractedFact[],
  minConfidence: number,
): { kept: M17ExtractedFact[]; dedupedWithinPass: number; belowThreshold: number } {
  const seen = new Set<string>();
  const kept: M17ExtractedFact[] = [];
  let dedupedWithinPass = 0;
  let belowThreshold = 0;
  // Sap xep confidence giam dan de ban co confidence cao thang khi trung.
  const sorted = [...candidates].sort((a, b) => b.confidence - a.confidence);
  for (const candidate of sorted) {
    if (!isValidEdgeTypeM17(candidate.edge)) {
      belowThreshold += 1;
      continue;
    }
    if (candidate.confidence < minConfidence) {
      belowThreshold += 1;
      continue;
    }
    if (!candidate.object || candidate.object.length < 2) {
      belowThreshold += 1;
      continue;
    }
    const key = extractionKeyM17(candidate);
    if (seen.has(key)) {
      dedupedWithinPass += 1;
      continue;
    }
    seen.add(key);
    kept.push(candidate);
  }
  return { kept, dedupedWithinPass, belowThreshold };
}

/**
 * Single-pass extraction: trich tat ca turn trong 1 lan duyet.
 * Rule chay truoc (0 LLM call); neu host truyen llmExtract thi goi
 * dung 1 lan cho toan bo turn, ket qua LLM cung qua cung bo loc.
 * CHI tra candidate ADD — ham nay khong sua/xoa bat ky fact cu nao.
 */
export async function extractTurnsSinglePassM17(
  turns: M17TurnInput[],
  options: M17ExtractOptions = {},
): Promise<M17ExtractionResult> {
  const started = Date.now();
  const minConfidence = options.minConfidence ?? M17_EXTRACT_MIN_CONFIDENCE;
  const userTurnsOnly = options.userTurnsOnly ?? true;
  const maxCandidates = options.maxCandidates ?? 50;
  if (!Array.isArray(turns)) {
    throw new M17Error('Turns phai la array.');
  }
  let noiseTurns = 0;
  let candidates: M17ExtractedFact[] = [];
  const llmTurns: { role: string; text: string }[] = [];
  for (const turn of turns) {
    if (!turn || typeof turn.text !== 'string') continue;
    if (userTurnsOnly && turn.role !== 'user') continue;
    const text = turn.text.trim();
    if (!text) {
      noiseTurns += 1;
      continue;
    }
    if (classifyTurnNoiseM17(text)) {
      noiseTurns += 1;
      continue;
    }
    for (const sentence of splitSentencesM17(text)) {
      candidates.push(...extractFromSentenceM17(sentence, text));
    }
    llmTurns.push({ role: turn.role, text });
  }
  let llmCalls = 0;
  if (options.llmExtract && llmTurns.length > 0) {
    llmCalls = 1;
    try {
      const llmFacts = await options.llmExtract(llmTurns);
      if (Array.isArray(llmFacts)) {
        for (const fact of llmFacts) {
          if (!fact || typeof fact !== 'object') continue;
          candidates.push({
            subject: typeof fact.subject === 'string' && fact.subject ? fact.subject : 'user',
            edge: fact.edge,
            object: typeof fact.object === 'string' ? cleanExtractedObjectM17(fact.object) : '',
            confidence:
              typeof fact.confidence === 'number' && Number.isFinite(fact.confidence)
                ? fact.confidence
                : M17_LLM_DEFAULT_CONFIDENCE,
            isNegation: fact.isNegation === true,
            validFrom: fact.validFrom ?? null,
            validTo: fact.validTo ?? null,
            mentionedEntities: Array.isArray(fact.mentionedEntities)
              ? fact.mentionedEntities
              : [],
            sourceText: truncateTextM17(
              typeof fact.sourceText === 'string' ? fact.sourceText : '',
              500,
            ),
          });
        }
      }
    } catch (err) {
      // LLM loi -> pass van hoan tat bang rule; ghi ro trong ket qua qua elapsedMs?
      // Khong throw: extraction khong duoc lam hong ca pass vi 1 call phu.
      candidates.push({
        subject: 'user',
        edge: 'related_to',
        object: '',
        confidence: 0,
        isNegation: false,
        validFrom: null,
        validTo: null,
        mentionedEntities: [],
        sourceText: `LLM extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  const filtered = filterCandidatesM17(candidates, minConfidence);
  const kept = filtered.kept.slice(0, maxCandidates);
  return {
    candidates: kept,
    noiseTurns,
    dedupedWithinPass: filtered.dedupedWithinPass,
    belowThreshold:
      filtered.belowThreshold + Math.max(0, filtered.kept.length - kept.length),
    llmCalls,
    elapsedMs: Date.now() - started,
  };
}

/** Trich 1 turn duy nhat (tien ich cho tool / test). */
export async function extractSingleTurnM17(
  turn: M17TurnInput,
  options: M17ExtractOptions = {},
): Promise<M17ExtractionResult> {
  return extractTurnsSinglePassM17([turn], options);
}
