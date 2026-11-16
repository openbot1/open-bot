/**
 * Memory v14 — Mem0-style fact extraction v2 (v1.15, Doi T1).
 *
 * Y tuong hoc tu Mem0 v3 (extract facts bang LLM roi consolidate vao
 * vector/graph store, scoping user/agent/run) — tu thiet ke lai hoan
 * toan cho open-bot, chay 100% local, KHONG copy code/text/tai san
 * cua bat ky repo nao.
 *
 * Ke thua, khong viet lai:
 *  - `extractCandidatesFromText` cua v13 (mau luat co ban likes /
 *    lives_in / works_at / speaks / wants / prefers / uses): v14
 *    GIU NGUYEN cac mau do qua ham `extractCandidatesFromText` va
 *    chi THEM mau moi (thu cung, so huu, di ung, choi mon gi, ky
 *    nang, quan he, da di dau, an kieng, hoc o dau, sinh o dau).
 *  - `applyExtractionV13` (add-only + invalidate): v14 dung lai
 *    qua `supersedeFactV14` cua temporalKg (dong cua so hieu luc
 *    thay vi chi invalidate) khi fact moi thang fact cu.
 *
 * Moi so voi v13:
 *  1. Ngu phap thoi gian: "tu 2020", "tu thang 3/2026", "den nam
 *     2026", "since 2020", "until 2026" -> goi y validFrom /
 *     validUntil cho fact (temporal KG v3 an truc tiep).
 *  2. Y dinh rut lai (retract): "khong con thich X nua", "het thich
 *     X roi", "no longer like X" -> ung vien co intent 'retract'
 *     thay vi mot fact 'dislikes' moi; apply se dong cua so cua
 *     fact cu thay vi tao fact mau thuan.
 *  3. LLM-optional hook: interface `V14LlmExtractor` — bat ky
 *     extractor nao goi model that cung cam duoc (tra candidate
 *     co `origin: 'llm'`); `V14MockLlmExtractor` la mock xac dinh
 *     (khong goi API that) bat cac cach dien dat ma luat regex bo
 *     sot ("go-to drink", "toi me ...", "dam me ..."). Rule luon
 *     thang khi trung lap; LLM chi bo sung.
 *  4. Source trust: confidence hieu dung = confidence goc nhan he
 *     so tin cay nguon (0..1); nguon khong tin cay khong bao gio
 *     duoc phep thang fact tin cay cao (xem poisoning.ts).
 */

import type { GraphFact, MemoryScope } from '../graph/types';
import { normalizeGraphText } from '../graph/types';
import type { TemporalGraphStore } from '../graph/store';
import { extractCandidatesFromText } from '../v13/extraction';
import type { V13ExtractedCandidate } from '../v13/extraction';
import { supersedeFactV14 } from './temporalKg';

/** Loi extraction v14 — message tieng Viet. */
export class V14ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V14ExtractionError';
  }
}

/** Y dinh cua mot ung vien fact. */
export type V14FactIntent = 'assert' | 'retract';

/** Nguon sinh ra ung vien. */
export type V14CandidateOrigin = 'rule' | 'llm';

/** Mot fact ung vien trich duoc (chua ghi). */
export interface V14ExtractedFact {
  subject: string;
  predicate: string;
  objectText: string;
  /** Confidence goc cua mau / LLM (0..1, chua nhan trust). */
  confidence: number;
  /** Confidence hieu dung sau khi nhan he so tin cay nguon. */
  effectiveConfidence: number;
  /** Do tin cay cua nguon turn nay (0..1, mac dinh 1). */
  sourceTrust: number;
  sourceText: string;
  /** Mau luat / ten extractor LLM nao sinh ra ung vien. */
  pattern: string;
  origin: V14CandidateOrigin;
  intent: V14FactIntent;
  /** Goi y cua so hieu luc rut tu ngu phap thoi gian (ISO, co the rong). */
  validFrom?: string;
  validUntil?: string | null;
}

export interface V14TurnInput {
  text: string;
  episodeId?: string;
  turnId?: string;
  runId?: string;
  botId?: string;
  userId?: string;
  at?: string;
  scope?: MemoryScope;
  /** Do tin cay nguon turn nay (0..1). Mac dinh 1 = nguon tin cay. */
  sourceTrust?: number;
  /** Ten nguon (vd 'user-chat', 'imported-notes', 'web-scrape'). */
  sourceName?: string;
}

/** Ham gate tuy chon: poisoning judge ben ngoai quyet dinh ung vien co duoc ghi khong. */
export type V14ExtractionGate = (
  candidate: V14ExtractedFact,
  ctx: { store: TemporalGraphStore; scope: MemoryScope },
) => { decision: 'accept' | 'quarantine' | 'reject'; reason: string };

export interface V14ApplyExtractionOptions {
  minConfidence?: number;
  /** Confidence hieu dung toi thieu de fact moi thay the fact cu (mac dinh 0.6). */
  minConfidenceToSupersede?: number;
  actor?: string;
  now?: Date;
  /** Extractor LLM tuy chon (mac dinh: khong dung LLM, chi rule). */
  llmExtractor?: V14LlmExtractor | null;
  /** Gate phong chong poisoning (mac dinh: khong gate, ghi thang). */
  gate?: V14ExtractionGate | null;
  /** Callback khi mot ung vien bi gate chan (de ghi quarantine ben ngoai). */
  onGated?: (candidate: V14ExtractedFact, decision: 'quarantine' | 'reject', reason: string) => void;
}

export interface V14ExtractionReport {
  turns: number;
  ruleCandidates: number;
  llmCandidates: number;
  appended: V14ExtractedFact[];
  duplicates: { candidate: V14ExtractedFact; existingFactId: string }[];
  superseded: { oldFact: GraphFact; newFact: GraphFact }[];
  retracted: { candidate: V14ExtractedFact; closedFact: GraphFact }[];
  dropped: V14ExtractedFact[];
  gated: { candidate: V14ExtractedFact; decision: 'quarantine' | 'reject'; reason: string }[];
  deferred: { candidate: V14ExtractedFact; conflictingFact: GraphFact; reason: string }[];
}

export const V14_DEFAULT_MIN_CONFIDENCE = 0.5;
export const V14_DEFAULT_MIN_CONFIDENCE_TO_SUPERSEDE = 0.6;

/**
 * Predicate DON TRI (tai mot thoi diem chi co mot gia tri dung):
 * doi gia tri moi la MAU THUAN (supersede/quarantine). Cac
 * predicate khac (likes, speaks, plays, has_pet...) la DA TRI:
 * them gia tri moi khong mau thuan gia tri cu.
 */
export const V14_SINGLE_VALUED_PREDICATES: ReadonlySet<string> = new Set([
  'lives_in',
  'works_at',
  'born_in',
  'studies_at',
  'favorite',
]);

export function isSingleValuedPredicateV14(predicate: string): boolean {
  return V14_SINGLE_VALUED_PREDICATES.has(
    normalizeGraphText(predicate ?? '').replace(/\s+/g, '_'),
  );
}

/** Clamp 0..1. */
export function clamp01V14(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Confidence hieu dung: confidence goc * (0.5 + 0.5 * trust).
 * Nguon trust = 1 giu nguyen; trust = 0 chi con mot nua (khong bao
 * gio ve 0 hoan toan — fact yeu van co the vao quarantine de duyet
 * tay, nhung khong duoc thang fact manh).
 */
export function effectiveConfidenceV14(confidence: number, sourceTrust: number): number {
  return clamp01V14(clamp01V14(confidence) * (0.5 + 0.5 * clamp01V14(sourceTrust)));
}

// ---------------------------------------------------------------------------
// Ngu phap thoi gian: "tu 2020" / "tu thang 3/2026" / "den 2026" / since/until
// ---------------------------------------------------------------------------

export interface V14TemporalHint {
  validFrom?: string;
  validUntil?: string | null;
}

const MONTH_YEAR_RE =
  /(?:từ|tu|from|since)\s+(?:tháng\s+)?(\d{1,2})[\/\-](\d{4})/i;
const YEAR_RE = /(?:từ|tu|from|since)\s+(?:năm\s+|nam\s+)?(\d{4})/i;
const UNTIL_MONTH_YEAR_RE =
  /(?:đến|den|tới|toi|until|till)\s+(?:tháng\s+)?(\d{1,2})[\/\-](\d{4})/i;
const UNTIL_YEAR_RE = /(?:đến|den|tới|toi|until|till)\s+(?:năm\s+|nam\s+)?(\d{4})/i;

/** Rut goi y validFrom/validUntil tu mot cau (chi nam/thang, khong doan ngay). */
export function parseTemporalHint(text: string): V14TemporalHint {
  const clean = text ?? '';
  const out: V14TemporalHint = {};
  const monthYear = MONTH_YEAR_RE.exec(clean);
  if (monthYear) {
    const month = Number(monthYear[1]);
    const year = Number(monthYear[2]);
    if (month >= 1 && month <= 12 && year >= 1900 && year <= 2100) {
      out.validFrom = new Date(Date.UTC(year, month - 1, 1)).toISOString();
    }
  } else {
    const year = YEAR_RE.exec(clean);
    if (year) {
      const y = Number(year[1]);
      if (y >= 1900 && y <= 2100) out.validFrom = new Date(Date.UTC(y, 0, 1)).toISOString();
    }
  }
  const untilMonthYear = UNTIL_MONTH_YEAR_RE.exec(clean);
  if (untilMonthYear) {
    const month = Number(untilMonthYear[1]);
    const year = Number(untilMonthYear[2]);
    if (month >= 1 && month <= 12 && year >= 1900 && year <= 2100) {
      out.validUntil = new Date(Date.UTC(year, month - 1, 1)).toISOString();
    }
  } else {
    const untilYear = UNTIL_YEAR_RE.exec(clean);
    if (untilYear) {
      const y = Number(untilYear[1]);
      if (y >= 1900 && y <= 2100) out.validUntil = new Date(Date.UTC(y, 0, 1)).toISOString();
    }
  }
  if (out.validFrom && out.validUntil && Date.parse(out.validUntil) < Date.parse(out.validFrom)) {
    delete out.validUntil;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mau luat moi cua v14 (them vao mau v13, khong viet lai mau v13)
// ---------------------------------------------------------------------------

interface V14Pattern {
  name: string;
  predicate: string;
  confidence: number;
  regexes: RegExp[];
}

const V14_PATTERNS: V14Pattern[] = [
  {
    name: 'has_pet',
    predicate: 'has_pet',
    confidence: 0.85,
    regexes: [
      /(?:tôi|tớ|mình|em|anh|chị)\s+(?:đang\s+)?nuôi\s+(?:một\s+|1\s+)?([^,.;!?\n]{2,60})/i,
      /(?:tôi|tớ|mình|em|anh|chị)\s+có\s+(?:một\s+)?(?:con\s+)?(chó|mèo|chim|cá|thỏ|hamster|rùa)([^,.;!?\n]{0,40})/i,
      /(?:i|we)\s+have\s+a\s+(dog|cat|bird|fish|rabbit|hamster|turtle)([^,.;!?\n]{0,40})/i,
    ],
  },
  {
    name: 'owns',
    predicate: 'owns',
    confidence: 0.8,
    regexes: [
      /(?:tôi|tớ|mình|em|anh|chị)\s+có\s+(?:một\s+|cái\s+|chiếc\s+)?(xe\s+[^,.;!?\n]{2,60}|nhà\s+[^,.;!?\n]{2,60}|điện\s+thoại\s+[^,.;!?\n]{2,60}|laptop\s+[^,.;!?\n]{2,60})/i,
      /(?:i|we)\s+own\s+(?:a\s+|an\s+)?([^,.;!?\n]{2,60})/i,
    ],
  },
  {
    name: 'allergic_to',
    predicate: 'allergic_to',
    confidence: 0.9,
    regexes: [
      /(?:tôi|tớ|mình|em|anh|chị)\s+(?:bị\s+)?dị\s+ứng\s+(?:với\s+)?([^,.;!?\n]{2,60})/i,
      /(?:tôi|tớ|mình|em|anh|chị)\s+không\s+(?:ăn|uống)\s+được\s+([^,.;!?\n]{2,60})\s+vì\s+dị\s+ứng/i,
      /(?:i|we)\s+(?:am|are)\s+allergic\s+to\s+([^,.;!?\n]{2,60})/i,
    ],
  },
  {
    name: 'plays',
    predicate: 'plays',
    confidence: 0.8,
    regexes: [
      /(?:tôi|tớ|mình|em|anh|chị)\s+(?:hay\s+|thường\s+)?chơi\s+([^,.;!?\n]{2,60})/i,
      /(?:tôi|tớ|mình|em|anh|chị)\s+(?:đang\s+)?tập\s+([^,.;!?\n]{2,60})/i,
      /(?:i|we)\s+play\s+([^,.;!?\n]{2,60})/i,
    ],
  },
  {
    name: 'knows_skill',
    predicate: 'knows_skill',
    confidence: 0.75,
    regexes: [
      /(?:tôi|tớ|mình|em|anh|chị)\s+(?:giỏi|biết\s+làm|thành\s+thạo)\s+([^,.;!?\n]{2,60})/i,
      /(?:i|we)\s+(?:am\s+good\s+at|know\s+how\s+to)\s+([^,.;!?\n]{2,60})/i,
    ],
  },
  {
    name: 'is_friend_of',
    predicate: 'is_friend_of',
    confidence: 0.8,
    regexes: [
      /(?:tôi|tớ|mình|em|anh|chị)\s+(?:là\s+)?bạn\s+(?:thân\s+)?(?:của|với)\s+([A-ZÀ-Ỹ][\wÀ-ỹ]{1,30})/i,
      /(?:i|we)\s+(?:am|are)\s+(?:good\s+)?friends\s+with\s+([A-Z][\w]{1,30})/i,
    ],
  },
  {
    name: 'works_with',
    predicate: 'works_with',
    confidence: 0.8,
    regexes: [
      /(?:tôi|tớ|mình|em|anh|chị)\s+làm\s+cùng\s+([A-ZÀ-Ỹ][\wÀ-ỹ]{1,30})/i,
      /(?:i|we)\s+work\s+with\s+([A-Z][\w]{1,30})/i,
    ],
  },
  {
    name: 'visited',
    predicate: 'visited',
    confidence: 0.8,
    regexes: [
      /(?:tôi|tớ|mình|em|anh|chị)\s+(?:đã\s+)?(?:đi\s+du\s+lịch|từng\s+đến|đã\s+đến)\s+([^,.;!?\n]{2,60})/i,
      /(?:i|we)\s+(?:have\s+)?(?:visited|been\s+to)\s+([^,.;!?\n]{2,60})/i,
    ],
  },
  {
    name: 'eats_diet',
    predicate: 'eats',
    confidence: 0.85,
    regexes: [
      /(?:tôi|tớ|mình|em|anh|chị)\s+ăn\s+(chay|kiêng\s+[^,.;!?\n]{2,40}|không\s+[^,.;!?\n]{2,40})/i,
      /(?:i|we)\s+(?:eat\s+)?(vegetarian|vegan|gluten-free|halal|kosher)\b/i,
    ],
  },
  {
    name: 'studies_at',
    predicate: 'studies_at',
    confidence: 0.85,
    regexes: [
      /(?:tôi|tớ|mình|em|anh|chị)\s+(?:đang\s+)?học\s+(?:ở|tại)\s+([^,.;!?\n]{2,60})/i,
      /(?:i|we)\s+study\s+at\s+([^,.;!?\n]{2,60})/i,
    ],
  },
  {
    name: 'born_in',
    predicate: 'born_in',
    confidence: 0.9,
    regexes: [
      /(?:tôi|tớ|mình|em|anh|chị)\s+sinh\s+(?:ra\s+)?(?:ở|tại)\s+([^,.;!?\n]{2,60})/i,
      /(?:i|we)\s+(?:was|were)\s+born\s+in\s+([^,.;!?\n]{2,60})/i,
    ],
  },
  {
    name: 'favorite',
    predicate: 'favorite',
    confidence: 0.8,
    regexes: [
      /(?:món|thứ|bài|phim|cuốn)\s+(?:yêu\s+thích|khoái\s+khẩu)\s+(?:nhất\s+)?(?:của\s+(?:tôi|tớ|mình)\s+)?(?:là\s+)?([^,.;!?\n]{2,60})/i,
      /(?:my\s+)?favorite\s+(?:food|movie|book|song|drink)\s+is\s+([^,.;!?\n]{2,60})/i,
    ],
  },
];

/** Mau rut lai: "khong con ... nua" / "het ... roi" / "no longer ...". */
const V14_RETRACT_PATTERNS: { predicate: string; regexes: RegExp[] }[] = [
  {
    predicate: 'likes',
    regexes: [
      /(?:tôi|tớ|mình|em|anh|chị)\s+không\s+còn\s+thích\s+([^,.;!?\n]{2,80})\s+nữa/i,
      /(?:tôi|tớ|mình|em|anh|chị)\s+hết\s+thích\s+([^,.;!?\n]{2,80})/i,
      /(?:i|we)\s+(?:don't|do not)\s+like\s+([^,.;!?\n]{2,80})\s+(?:anymore|any more)/i,
      /(?:i|we)\s+no\s+longer\s+like\s+([^,.;!?\n]{2,80})/i,
    ],
  },
  {
    predicate: 'lives_in',
    regexes: [
      /(?:tôi|tớ|mình|em|anh|chị)\s+không\s+còn\s+(?:sống|ở)\s+([^,.;!?\n]{2,80})\s+nữa/i,
      /(?:i|we)\s+no\s+longer\s+live\s+in\s+([^,.;!?\n]{2,80})/i,
    ],
  },
  {
    predicate: 'works_at',
    regexes: [
      /(?:tôi|tớ|mình|em|anh|chị)\s+không\s+còn\s+làm\s+(?:ở|tại|cho)\s+([^,.;!?\n]{2,80})\s+nữa/i,
      /(?:tôi|tớ|mình|em|anh|chị)\s+đã\s+nghỉ\s+(?:việc\s+)?(?:ở|tại)\s+([^,.;!?\n]{2,80})/i,
      /(?:i|we)\s+no\s+longer\s+work\s+(?:at|for)\s+([^,.;!?\n]{2,80})/i,
    ],
  },
];

function cleanObject(raw: string): string {
  return (raw ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.,;!?\s]+$/, '')
    .slice(0, 200);
}

function toV14(
  c: V13ExtractedCandidate,
  opts: { sourceTrust: number; text: string },
): V14ExtractedFact {
  const hint = parseTemporalHint(opts.text);
  return {
    subject: c.subject,
    predicate: c.predicate,
    objectText: c.objectText,
    confidence: c.confidence,
    effectiveConfidence: effectiveConfidenceV14(c.confidence, opts.sourceTrust),
    sourceTrust: clamp01V14(opts.sourceTrust),
    sourceText: c.sourceText,
    pattern: c.pattern,
    origin: 'rule',
    intent: 'assert',
    ...(hint.validFrom ? { validFrom: hint.validFrom } : {}),
    ...(hint.validUntil ? { validUntil: hint.validUntil } : {}),
  };
}

/** Trich ung vien bang mau luat v14 (moi) — thuan, khong ghi gi. */
export function extractV14RuleCandidates(text: string, sourceTrust = 1): V14ExtractedFact[] {
  const clean = (text ?? '').trim();
  if (clean === '') return [];
  const out: V14ExtractedFact[] = [];
  const seen = new Set<string>();
  // Retract truoc: cau "khong con thich X nua" KHONG duoc tao fact 'likes'/'dislikes'.
  for (const group of V14_RETRACT_PATTERNS) {
    for (const re of group.regexes) {
      re.lastIndex = 0;
      const m = re.exec(clean);
      if (!m) continue;
      const objectText = cleanObject(m[1] ?? '');
      if (objectText.length < 2) continue;
      const key = `retract|user|${group.predicate}|${normalizeGraphText(objectText)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        subject: 'user',
        predicate: group.predicate,
        objectText,
        confidence: 0.85,
        effectiveConfidence: effectiveConfidenceV14(0.85, sourceTrust),
        sourceTrust: clamp01V14(sourceTrust),
        sourceText: clean.slice(0, 500),
        pattern: `retract_${group.predicate}`,
        origin: 'rule',
        intent: 'retract',
      });
    }
  }
  for (const pattern of V14_PATTERNS) {
    for (const re of pattern.regexes) {
      re.lastIndex = 0;
      const m = re.exec(clean);
      if (!m) continue;
      let objectRaw: string;
      if (pattern.name === 'has_pet' && m[2] !== undefined && /chó|mèo|chim|cá|thỏ|hamster|rùa|dog|cat|bird|fish|rabbit|hamster|turtle/i.test(m[1] ?? '')) {
        objectRaw = `${m[1] ?? ''}${m[2] ?? ''}`.trim();
      } else {
        objectRaw = m[1] ?? '';
      }
      const objectText = cleanObject(objectRaw);
      if (objectText.length < 2) continue;
      const key = `assert|user|${pattern.predicate}|${normalizeGraphText(objectText)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const hint = parseTemporalHint(clean);
      out.push({
        subject: 'user',
        predicate: pattern.predicate,
        objectText,
        confidence: pattern.confidence,
        effectiveConfidence: effectiveConfidenceV14(pattern.confidence, sourceTrust),
        sourceTrust: clamp01V14(sourceTrust),
        sourceText: clean.slice(0, 500),
        pattern: pattern.name,
        origin: 'rule',
        intent: 'assert',
        ...(hint.validFrom ? { validFrom: hint.validFrom } : {}),
        ...(hint.validUntil ? { validUntil: hint.validUntil } : {}),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// LLM-optional hook
// ---------------------------------------------------------------------------

/** Ung vien do LLM tra ve (chua co effectiveConfidence — tinh o merge). */
export interface V14LlmCandidate {
  subject: string;
  predicate: string;
  objectText: string;
  confidence: number;
  sourceText?: string;
}

/** Bat ky extractor goi model that nao cung cam duoc qua interface nay. */
export interface V14LlmExtractor {
  readonly name: string;
  extract(text: string, opts?: { at?: string }): Promise<V14LlmCandidate[]>;
}

/**
 * Mock LLM extractor xac dinh (khong goi API that): bat cac cach
 * dien dat ma regex v13/v14 bo sot. Dung cho test + chay offline.
 * Chu Y: day la MOCK co chu dich — ket qua luon giong nhau voi cung
 * input, khong phai model that.
 */
export class V14MockLlmExtractor implements V14LlmExtractor {
  readonly name = 'mock-llm-v14';
  private static readonly PATTERNS: { predicate: string; confidence: number; regexes: RegExp[] }[] = [
    {
      predicate: 'likes',
      confidence: 0.7,
      regexes: [
        /(?:tôi|tớ|mình|em|anh|chị)\s+mê\s+([^,.;!?\n]{2,60})/i,
        /(?:tôi|tớ|mình|em|anh|chị)\s+đam\s+mê\s+([^,.;!?\n]{2,60})/i,
        /(?:my\s+)?go-to\s+(?:drink|food|dish)\s+is\s+([^,.;!?\n]{2,60})/i,
        /(?:i|we)\s+(?:am|are)\s+really\s+into\s+([^,.;!?\n]{2,60})/i,
        /(?:i|we)\s+adore\s+([^,.;!?\n]{2,60})/i,
      ],
    },
    {
      predicate: 'dislikes',
      confidence: 0.7,
      regexes: [
        /(?:tôi|tớ|mình|em|anh|chị)\s+không\s+chịu\s+được\s+([^,.;!?\n]{2,60})/i,
        /(?:i|we)\s+can(?:'t|not)\s+stand\s+([^,.;!?\n]{2,60})/i,
      ],
    },
    {
      predicate: 'wants',
      confidence: 0.65,
      regexes: [
        /(?:tôi|tớ|mình|em|anh|chị)\s+đang\s+mong\s+([^,.;!?\n]{2,60})/i,
        /(?:i|we)\s+(?:am|are)\s+looking\s+forward\s+to\s+([^,.;!?\n]{2,60})/i,
      ],
    },
    {
      predicate: 'lives_in',
      confidence: 0.7,
      regexes: [
        /(?:i|we)\s+(?:am|are)\s+based\s+in\s+([^,.;!?\n]{2,60})/i,
        /(?:tôi|tớ|mình|em|anh|chị)\s+định\s+cư\s+(?:ở|tại)\s+([^,.;!?\n]{2,60})/i,
      ],
    },
  ];

  async extract(text: string): Promise<V14LlmCandidate[]> {
    const clean = (text ?? '').trim();
    if (clean === '') return [];
    const out: V14LlmCandidate[] = [];
    const seen = new Set<string>();
    for (const p of V14MockLlmExtractor.PATTERNS) {
      for (const re of p.regexes) {
        re.lastIndex = 0;
        const m = re.exec(clean);
        if (!m) continue;
        const objectText = cleanObject(m[1] ?? '');
        if (objectText.length < 2) continue;
        const key = `${p.predicate}|${normalizeGraphText(objectText)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          subject: 'user',
          predicate: p.predicate,
          objectText,
          confidence: p.confidence,
          sourceText: clean.slice(0, 500),
        });
      }
    }
    return out;
  }
}

/** Gop ung vien rule + LLM: rule thang khi trung (subject, predicate, object). */
export function mergeRuleAndLlmCandidates(
  rule: V14ExtractedFact[],
  llm: V14LlmCandidate[],
  opts: { sourceTrust?: number; sourceText: string },
): V14ExtractedFact[] {
  const trust = clamp01V14(opts.sourceTrust ?? 1);
  const out = [...rule];
  const seen = new Set(
    rule.map(
      (c) => `${c.intent}|${normalizeGraphText(c.subject)}|${c.predicate}|${normalizeGraphText(c.objectText)}`,
    ),
  );
  for (const c of llm) {
    const objectText = cleanObject(c.objectText);
    if (objectText.length < 2) continue;
    const key = `assert|${normalizeGraphText(c.subject)}|${c.predicate}|${normalizeGraphText(objectText)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const hint = parseTemporalHint(opts.sourceText);
    out.push({
      subject: (c.subject ?? 'user').trim() || 'user',
      predicate: c.predicate,
      objectText,
      confidence: clamp01V14(c.confidence),
      effectiveConfidence: effectiveConfidenceV14(c.confidence, trust),
      sourceTrust: trust,
      sourceText: (c.sourceText ?? opts.sourceText).slice(0, 500),
      pattern: 'llm',
      origin: 'llm',
      intent: 'assert',
      ...(hint.validFrom ? { validFrom: hint.validFrom } : {}),
      ...(hint.validUntil ? { validUntil: hint.validUntil } : {}),
    });
  }
  return out;
}

/**
 * Trich day du mot turn: rule v13 (ke thua) + rule v14 + LLM tuy chon.
 * Thu tu uu tien trung lap: v13 rule > v14 rule > LLM.
 */
export async function extractFactsV14(
  text: string,
  opts: { sourceTrust?: number; llmExtractor?: V14LlmExtractor | null; at?: string } = {},
): Promise<V14ExtractedFact[]> {
  const trust = clamp01V14(opts.sourceTrust ?? 1);
  const clean = (text ?? '').trim();
  if (clean === '') return [];
  const v13 = extractCandidatesFromText(clean).map((c) => toV14(c, { sourceTrust: trust, text: clean }));
  const v14rules = extractV14RuleCandidates(clean, trust);
  const seen = new Set(
    v13.map(
      (c) => `${c.intent}|${normalizeGraphText(c.subject)}|${c.predicate}|${normalizeGraphText(c.objectText)}`,
    ),
  );
  const merged = [...v13];
  for (const c of v14rules) {
    const key = `${c.intent}|${normalizeGraphText(c.subject)}|${c.predicate}|${normalizeGraphText(c.objectText)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(c);
  }
  if (opts.llmExtractor) {
    let llm: V14LlmCandidate[] = [];
    try {
      llm = await opts.llmExtractor.extract(clean, { ...(opts.at ? { at: opts.at } : {}) });
    } catch {
      llm = [];
    }
    return mergeRuleAndLlmCandidates(merged, llm, { sourceTrust: trust, sourceText: clean });
  }
  return merged;
}

/** Trich dong bo (khong LLM) — tien cho tool/test khong async. */
export function extractFactsV14Sync(text: string, sourceTrust = 1): V14ExtractedFact[] {
  const trust = clamp01V14(sourceTrust);
  const clean = (text ?? '').trim();
  if (clean === '') return [];
  const v13 = extractCandidatesFromText(clean).map((c) => toV14(c, { sourceTrust: trust, text: clean }));
  const v14rules = extractV14RuleCandidates(clean, trust);
  const seen = new Set(
    v13.map(
      (c) => `${c.intent}|${normalizeGraphText(c.subject)}|${c.predicate}|${normalizeGraphText(c.objectText)}`,
    ),
  );
  const merged = [...v13];
  for (const c of v14rules) {
    const key = `${c.intent}|${normalizeGraphText(c.subject)}|${c.predicate}|${normalizeGraphText(c.objectText)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(c);
  }
  return merged;
}

function scopeOfTurn(turn: V14TurnInput): MemoryScope {
  if (turn.scope) return { ...turn.scope };
  return {
    userId: turn.userId ?? '',
    botId: turn.botId ?? '',
    runId: turn.runId ?? '',
  };
}

/**
 * Ap dung trich xuat v14 cho mot loat turn:
 * trich -> loc confidence hieu dung -> gate (neu co) -> append
 * add-only (dedupe) -> fact moi thang fact cu thi SUPERSEDE (dong
 * cua so hieu luc cu, giu lich su) -> retract thi dong cua so fact
 * cu. Khong bao gio overwrite/xoa fact cu.
 */
export async function applyExtractionV14(
  store: TemporalGraphStore,
  turns: V14TurnInput[],
  opts: V14ApplyExtractionOptions = {},
): Promise<V14ExtractionReport> {
  const minConfidence = opts.minConfidence ?? V14_DEFAULT_MIN_CONFIDENCE;
  const minToSupersede =
    typeof opts.minConfidenceToSupersede === 'number'
      ? opts.minConfidenceToSupersede
      : V14_DEFAULT_MIN_CONFIDENCE_TO_SUPERSEDE;
  const now = opts.now ?? new Date();
  const report: V14ExtractionReport = {
    turns: turns.length,
    ruleCandidates: 0,
    llmCandidates: 0,
    appended: [],
    duplicates: [],
    superseded: [],
    retracted: [],
    dropped: [],
    gated: [],
    deferred: [],
  };
  for (const turn of turns) {
    const scope = scopeOfTurn(turn);
    const at = turn.at ?? now.toISOString();
    const trust = clamp01V14(turn.sourceTrust ?? 1);
    const candidates = await extractFactsV14(turn.text, {
      sourceTrust: trust,
      ...(opts.llmExtractor ? { llmExtractor: opts.llmExtractor } : {}),
      at,
    });
    report.ruleCandidates += candidates.filter((c) => c.origin === 'rule').length;
    report.llmCandidates += candidates.filter((c) => c.origin === 'llm').length;
    for (const candidate of candidates) {
      if (candidate.effectiveConfidence < minConfidence) {
        report.dropped.push(candidate);
        continue;
      }
      if (opts.gate) {
        const verdict = opts.gate(candidate, { store, scope });
        if (verdict.decision !== 'accept') {
          report.gated.push({ candidate, decision: verdict.decision, reason: verdict.reason });
          opts.onGated?.(candidate, verdict.decision, verdict.reason);
          continue;
        }
      }
      const provenance: GraphFact['provenance'] = {
        episodeId: turn.episodeId ?? '',
        turnId: turn.turnId ?? '',
        runId: turn.runId ?? scope.runId,
        botId: turn.botId ?? scope.botId,
        userId: turn.userId ?? scope.userId,
        at,
        sourceText: candidate.sourceText,
      };
      // --- Retract: dong cua so fact cu cung (subject, predicate, object). ---
      if (candidate.intent === 'retract') {
        const targets = store
          .findActiveFacts(candidate.subject, candidate.predicate, scope)
          .filter(
            (f) =>
              normalizeGraphText(f.objectText ?? '') === normalizeGraphText(candidate.objectText),
          );
        if (targets.length === 0) {
          report.dropped.push(candidate);
          continue;
        }
        for (const old of targets) {
          // Chi dong cua so hieu luc tai `at` (khong xoa mem):
          // query "dung tai T" truoc `at` van thay fact cu; query
          // hien tai (sau `at`) khong thay nua vi isFactValidAt
          // kiem tra validUntil. Lich su duoc giu nguyen.
          const closed = store.setFactValidity(old.id, { validUntil: at });
          report.retracted.push({ candidate, closedFact: closed });
        }
        continue;
      }
      // --- Assert: append add-only (dedupe chinh xac). ---
      const existing = store
        .listFacts({ ...scope, status: 'active', predicate: candidate.predicate, limit: 5000 })
        .find(
          (f) =>
            normalizeGraphText(store.getEntity(f.subjectId)?.name ?? '') ===
              normalizeGraphText(candidate.subject) &&
            normalizeGraphText(f.objectText ?? '') === normalizeGraphText(candidate.objectText),
        );
      if (existing) {
        report.duplicates.push({ candidate, existingFactId: existing.id });
        continue;
      }
      // --- Mau thuan (chi predicate DON TRI): fact active cung
      // (subject, predicate) khac object. Predicate da tri (likes,
      // speaks...) thi gia tri moi song song gia tri cu, khong
      // supersede. Kiem tra TRUOC KHI ghi de tranh tao 2 fact moi
      // trung nhau (add roi supersede lai tao them mot fact nua).
      const conflicts = isSingleValuedPredicateV14(candidate.predicate)
        ? store
            .findActiveFacts(candidate.subject, candidate.predicate, scope)
            .filter(
              (f) =>
                normalizeGraphText(f.objectText ?? '') !== normalizeGraphText(candidate.objectText),
            )
            .sort((a, b) => b.confidence - a.confidence)
        : [];
      if (conflicts.length > 0 && candidate.effectiveConfidence >= minToSupersede) {
        // Thang fact cu tin nhat bang supersede (tao dung 1 fact
        // moi); cac fact cu khac cung predicate thi dong cua so.
        const [first, ...rest] = conflicts;
        const created = supersedeFactV14(
          store,
          first.id,
          {
            subjectName: candidate.subject,
            predicate: candidate.predicate,
            objectText: candidate.objectText,
            confidence: candidate.effectiveConfidence,
            scope,
            provenance,
            validFrom: candidate.validFrom ?? at,
          },
          { supersededAt: candidate.validFrom ?? at },
        );
        report.appended.push(candidate);
        report.superseded.push({ oldFact: first, newFact: created });
        for (const other of rest) {
          store.setFactValidity(other.id, { validUntil: candidate.validFrom ?? at });
          report.superseded.push({ oldFact: other, newFact: created });
        }
        continue;
      }
      const fact = store.addFact({
        subjectName: candidate.subject,
        predicate: candidate.predicate,
        objectText: candidate.objectText,
        confidence: candidate.effectiveConfidence,
        scope,
        provenance,
        validFrom: candidate.validFrom ?? at,
        ...(candidate.validUntil ? { validUntil: candidate.validUntil } : {}),
      });
      report.appended.push(candidate);
      for (const old of conflicts) {
        report.deferred.push({
          candidate,
          conflictingFact: old,
          reason: `Confidence hieu dung ${candidate.effectiveConfidence.toFixed(2)} < nguong supersede ${minToSupersede} — fact cu van giu.`,
        });
      }
      void fact;
    }
  }
  return report;
}
