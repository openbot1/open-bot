/**
 * Memory v15 — Mem0-v3 style consolidation (v1.16, Doi T1).
 *
 * Y tuong hoc tu Mem0 v3 (04/2026: chi 1 LLM call o write-time, chi
 * ADD — khong UPDATE/DELETE khi ghi; fact moi nam canh fact cu, luc
 * RETRIEVAL moi quyet dinh cai nao con dung) — tu thiet ke lai hoan
 * toan cho open-bot, chay 100% local, KHONG copy code/text/tai san
 * cua bat ky repo nao.
 *
 * Diem KHAC BIET co y thuc so voi v14 (applyExtractionV14 supersede
 * NGAY khi ghi):
 *  1. Write-time chi ADD: `consolidateTurnsV15` trich 1 pass duy nhat
 *     moi turn (1 lan goi LLM hook, dem bang `llmCalls`), append
 *     add-only vao TemporalGraphStore, KHONG bao gio update/delete/
 *     supersede fact cu o luc ghi. Mau thuan duoc GHI LAI (coexisting)
 *     chu khong giai quyet.
 *  2. Retrieval-time supersede: `resolveCurrentV15` moi quyet dinh
 *     fact nao con dung cho mot (subject, predicate) don tri tai
 *     thoi diem hoi — thang theo (validFrom moi nhat, confidence
 *     cao nhat, createdAt moi nhat). Fact thua chi bi danh dau
 *     `superseded` TRONG VIEW tra ve; store khong doi gi.
 *  3. Lich su day du: vi khong co ghi de, moi phien ban cua mot
 *     fact deu con nguyen trong store va tra loi duoc "dung tai T"
 *     (xem temporalKg.ts).
 *
 * Ke thua, khong viet lai:
 *  - `extractCandidatesFromText` v13 + mau luat v14: v15 GIU NGUYEN
 *    qua `extractFactsV14Sync` (goi lai, khong copy mau) va chi THEM
 *    mau moi cua rieng v15 (routine / goal / constraint / reads /
 *    watches / lives_with / commutes_by). `dislikes` / `prefers` da
 *    co o v13 nen v15 KHONG lap lai (chi them `prefers` vao tap don
 *    tri de retrieval-time supersede ap dung cho no).
 *  - `parseTemporalHint` v14: goi y validFrom/validUntil tu ngu phap
 *    thoi gian, dung lai nguyen ven.
 *  - `effectiveConfidenceV14` / source-trust: confidence hieu dung
 *    = goc * (0.5 + 0.5 * trust), dung lai nguyen ven.
 *  - Judge poisoning v14: gate tuy chon cua consolidate, dung lai
 *    qua `v14JudgeGate` (xem hybridSearch.ts — `gateExtractedV15`).
 */

import type { GraphFact, MemoryScope } from '../memory/graph/types';
import { normalizeGraphText } from '../memory/graph/types';
import type { TemporalGraphStore } from '../memory/graph/store';
import { extractFactsV14Sync, parseTemporalHint, effectiveConfidenceV14 } from '../memory/v14/extraction';
import type { V14ExtractedFact } from '../memory/v14/extraction';
import { isSingleValuedPredicateV14 } from '../memory/v14/extraction';

/** Loi consolidation v15 — message tieng Viet. */
export class V15ConsolidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V15ConsolidationError';
  }
}

/** Y dinh cua mot ung vien fact v15 (giong v14, giu de tuong thich). */
export type V15FactIntent = 'assert' | 'retract';

/** Nguon sinh ra ung vien. */
export type V15CandidateOrigin = 'rule' | 'llm';

/** Mot fact ung vien trich duoc (chua ghi). */
export interface V15ExtractedFact {
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
  origin: V15CandidateOrigin;
  intent: V15FactIntent;
  /** Goi y cua so hieu luc rut tu ngu phap thoi gian (ISO, co the rong). */
  validFrom?: string;
  validUntil?: string | null;
}

export interface V15TurnInput {
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
export type V15ConsolidationGate = (
  candidate: V15ExtractedFact,
  ctx: { store: TemporalGraphStore; scope: MemoryScope },
) => { decision: 'accept' | 'quarantine' | 'reject'; reason: string };

export interface V15ConsolidateOptions {
  minConfidence?: number;
  actor?: string;
  now?: Date;
  /** Extractor LLM tuy chon (mac dinh: khong dung LLM, chi rule). */
  llmExtractor?: V15LlmExtractor | null;
  /** Gate phong chong poisoning (mac dinh: khong gate, ghi thang). */
  gate?: V15ConsolidationGate | null;
  /** Callback khi mot ung vien bi gate chan (de ghi quarantine ben ngoai). */
  onGated?: (candidate: V15ExtractedFact, decision: 'quarantine' | 'reject', reason: string) => void;
}

/** Mot cap fact mau thuan dang CUNG TON TAI (chua giai quyet o write-time). */
export interface V15Coexistence {
  candidate: V15ExtractedFact;
  /** Fact cu cung (subject, predicate) don tri, khac object, dang active. */
  existingFact: GraphFact;
  reason: string;
}

export interface V15ConsolidationReport {
  turns: number;
  /** So lan goi LLM hook — Mem0 v3: toi da 1/turn (single-pass). */
  llmCalls: number;
  ruleCandidates: number;
  llmCandidates: number;
  appended: V15ExtractedFact[];
  duplicates: { candidate: V15ExtractedFact; existingFactId: string }[];
  /** Mau thuan ghi lai, KHONG giai quyet o write-time (de retrieval quyet). */
  coexisting: V15Coexistence[];
  retracted: { candidate: V15ExtractedFact; closedFact: GraphFact }[];
  dropped: V15ExtractedFact[];
  gated: { candidate: V15ExtractedFact; decision: 'quarantine' | 'reject'; reason: string }[];
}

export const V15_DEFAULT_MIN_CONFIDENCE = 0.5;

/** Predicate DON TRI — tai mot thoi diem chi co mot gia tri dung (ke thua v14). */
export const V15_SINGLE_VALUED_PREDICATES: ReadonlySet<string> = new Set([
  'lives_in',
  'works_at',
  'born_in',
  'studies_at',
  'favorite',
  'lives_with',
  'commutes_by',
  'prefers',
]);

export function isSingleValuedPredicateV15(predicate: string): boolean {
  if (isSingleValuedPredicateV14(predicate)) return true;
  return V15_SINGLE_VALUED_PREDICATES.has(
    normalizeGraphText(predicate ?? '').replace(/\s+/g, '_'),
  );
}

/** Clamp 0..1. */
export function clamp01V15(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

// ---------------------------------------------------------------------------
// Mau luat moi cua v15 (them vao mau v13/v14, khong viet lai mau cu)
// ---------------------------------------------------------------------------

interface V15Pattern {
  name: string;
  predicate: string;
  confidence: number;
  regexes: RegExp[];
}

const V15_PATTERNS: V15Pattern[] = [
  {
    name: 'daily_routine',
    predicate: 'daily_routine',
    confidence: 0.75,
    regexes: [
      /(?:mỗi\s+sáng|moi\s+sang|hàng\s+ngày|hang\s+ngay|mỗi\s+tối|moi\s+toi)\s+(?:tôi|tớ|mình|em|anh|chị)\s+([^,.;!?\n]{2,80})/i,
      /(?:every\s+morning|every\s+day|every\s+evening)\s+(?:i|we)\s+([^,.;!?\n]{2,80})/i,
    ],
  },
  {
    name: 'goal',
    predicate: 'goal',
    confidence: 0.8,
    regexes: [
      /(?:mục\s+tiêu|muc\s+tieu)\s+(?:của\s+(?:tôi|tớ|mình)\s+)?(?:là\s+)?((?:[^,;!?\n]|\.(?=\d)){2,80})/i,
      /(?:tôi|tớ|mình|em|anh|chị)\s+muốn\s+trở\s+thành\s+((?:[^,;!?\n]|\.(?=\d)){2,80})/i,
      /(?:ước\s+mơ|uoc\s+mo)\s+(?:của\s+(?:tôi|tớ|mình)\s+)?(?:là\s+)?((?:[^,;!?\n]|\.(?=\d)){2,80})/i,
      /(?:my\s+)?goal\s+is\s+to\s+((?:[^,;!?\n]|\.(?=\d)){2,80})/i,
      /(?:i|we)\s+want\s+to\s+become\s+(?:a\s+|an\s+)?((?:[^,;!?\n]|\.(?=\d)){2,80})/i,
    ],
  },
  {
    name: 'constraint',
    predicate: 'constraint',
    confidence: 0.85,
    regexes: [
      /(?:tôi|tớ|mình|em|anh|chị)\s+không\s+được\s+([^,.;!?\n]{2,80})/i,
      /(?:bác\s+sĩ|bac\s+si)\s+dặn\s+(?:tôi|tớ|mình)\s+không\s+([^,.;!?\n]{2,80})/i,
      /(?:i|we)\s+(?:must\s+not|mustn't|can\s+not|cannot)\s+([^,.;!?\n]{2,80})/i,
    ],
  },
  {
    name: 'reads',
    predicate: 'reads',
    confidence: 0.75,
    regexes: [
      /(?:tôi|tớ|mình|em|anh|chị)\s+(?:đang\s+)?đọc\s+([^,.;!?\n]{2,60})/i,
      /(?:i|we)\s+(?:am\s+|are\s+)?reading\s+([^,.;!?\n]{2,60})/i,
    ],
  },
  {
    name: 'watches',
    predicate: 'watches',
    confidence: 0.75,
    regexes: [
      /(?:tôi|tớ|mình|em|anh|chị)\s+(?:hay\s+|thường\s+)?xem\s+([^,.;!?\n]{2,60})/i,
      /(?:i|we)\s+(?:usually\s+)?watch\s+([^,.;!?\n]{2,60})/i,
    ],
  },
  {
    name: 'lives_with',
    predicate: 'lives_with',
    confidence: 0.85,
    regexes: [
      /(?:tôi|tớ|mình|em|anh|chị)\s+sống\s+cùng\s+([^,.;!?\n]{2,60})/i,
      /(?:i|we)\s+live\s+with\s+([^,.;!?\n]{2,60})/i,
    ],
  },
  {
    name: 'commutes_by',
    predicate: 'commutes_by',
    confidence: 0.8,
    regexes: [
      /(?:tôi|tớ|mình|em|anh|chị)\s+đi\s+làm\s+bằng\s+([^,.;!?\n]{2,60})/i,
      /(?:i|we)\s+commute\s+(?:to\s+work\s+)?by\s+([^,.;!?\n]{2,60})/i,
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

function toV15(v14: V14ExtractedFact): V15ExtractedFact {
  return {
    subject: v14.subject,
    predicate: v14.predicate,
    objectText: v14.objectText,
    confidence: v14.confidence,
    effectiveConfidence: v14.effectiveConfidence,
    sourceTrust: v14.sourceTrust,
    sourceText: v14.sourceText,
    pattern: v14.pattern,
    origin: 'rule',
    intent: v14.intent,
    ...(v14.validFrom ? { validFrom: v14.validFrom } : {}),
    ...(v14.validUntil ? { validUntil: v14.validUntil } : {}),
  };
}

/** Trich ung vien bang mau luat v15 (moi) — thuan, khong ghi gi. */
export function extractV15RuleCandidates(text: string, sourceTrust = 1): V15ExtractedFact[] {
  const clean = (text ?? '').trim();
  if (clean === '') return [];
  const trust = clamp01V15(sourceTrust);
  const out: V15ExtractedFact[] = [];
  const seen = new Set<string>();
  for (const pattern of V15_PATTERNS) {
    for (const re of pattern.regexes) {
      re.lastIndex = 0;
      const m = re.exec(clean);
      if (!m) continue;
      // 'prefers' co 2 nhom: lay nhom 1 (thu duoc uu tien), ghi them
      // nhom 2 vao objectText dang "X (hon Y)" de khong mat thong tin.
      let objectRaw = m[1] ?? '';
      if (pattern.name === 'prefers' && m[2]) {
        objectRaw = `${cleanObject(m[1] ?? '')} (hơn ${cleanObject(m[2])})`;
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
        effectiveConfidence: effectiveConfidenceV14(pattern.confidence, trust),
        sourceTrust: trust,
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
// LLM-optional hook — single-pass: 1 call / turn, chi ADD
// ---------------------------------------------------------------------------

/** Ung vien do LLM tra ve (chua co effectiveConfidence — tinh o merge). */
export interface V15LlmCandidate {
  subject: string;
  predicate: string;
  objectText: string;
  confidence: number;
  sourceText?: string;
}

/** Bat ky extractor goi model that nao cung cam duoc qua interface nay. */
export interface V15LlmExtractor {
  readonly name: string;
  extract(text: string, opts?: { at?: string }): Promise<V15LlmCandidate[]>;
}

/**
 * Mock LLM extractor xac dinh (khong goi API that): bat cac cach
 * dien dat ma regex v13/v14/v15 bo sot. Dung cho test + chay offline.
 * Chu Y: day la MOCK co chu dich — ket qua luon giong nhau voi cung
 * input, khong phai model that. Mau khac hoan toan mock v14.
 */
export class V15MockLlmExtractor implements V15LlmExtractor {
  readonly name = 'mock-llm-v15';
  private static readonly PATTERNS: { predicate: string; confidence: number; regexes: RegExp[] }[] = [
    {
      predicate: 'likes',
      confidence: 0.7,
      regexes: [
        /(?:tôi|tớ|mình|em|anh|chị)\s+mê\s+mẩn\s+([^,.;!?\n]{2,60})/i,
        /(?:tôi|tớ|mình|em|anh|chị)\s+nghiện\s+([^,.;!?\n]{2,60})/i,
        /(?:my\s+)?guilty\s+pleasure\s+is\s+([^,.;!?\n]{2,60})/i,
        /(?:i|we)\s+(?:am|are)\s+obsessed\s+with\s+([^,.;!?\n]{2,60})/i,
      ],
    },
    {
      predicate: 'dislikes',
      confidence: 0.7,
      regexes: [
        /(?:tôi|tớ|mình|em|anh|chị)\s+không\s+thể\s+chịu\s+nổi\s+([^,.;!?\n]{2,60})/i,
        /(?:i|we)\s+can(?:'t|not)\s+bear\s+([^,.;!?\n]{2,60})/i,
      ],
    },
    {
      predicate: 'daily_routine',
      confidence: 0.65,
      regexes: [
        /(?:tôi|tớ|mình|em|anh|chị)\s+thường\s+dậy\s+lúc\s+([^,.;!?\n]{2,60})/i,
        /(?:tôi|tớ|mình|em|anh|chị)\s+luôn\s+([^,.;!?\n]{2,60})\s+vào\s+buổi\s+sáng/i,
        /(?:i|we)\s+usually\s+wake\s+up\s+at\s+([^,.;!?\n]{2,60})/i,
      ],
    },
    {
      predicate: 'goal',
      confidence: 0.65,
      regexes: [
        /(?:tôi|tớ|mình|em|anh|chị)\s+đang\s+phấn\s+đấu\s+(?:để\s+)?([^,.;!?\n]{2,60})/i,
        /(?:i|we)\s+(?:am|are)\s+working\s+towards\s+([^,.;!?\n]{2,60})/i,
      ],
    },
    {
      predicate: 'lives_in',
      confidence: 0.7,
      regexes: [
        /(?:tôi|tớ|mình|em|anh|chị)\s+đang\s+thuê\s+nhà\s+(?:ở|tại)\s+([^,.;!?\n]{2,60})/i,
        /(?:i|we)\s+(?:am|are)\s+renting\s+(?:a\s+place\s+)?in\s+([^,.;!?\n]{2,60})/i,
      ],
    },
  ];

  async extract(text: string): Promise<V15LlmCandidate[]> {
    const clean = (text ?? '').trim();
    if (clean === '') return [];
    const out: V15LlmCandidate[] = [];
    const seen = new Set<string>();
    for (const p of V15MockLlmExtractor.PATTERNS) {
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
export function mergeRuleAndLlmCandidatesV15(
  rule: V15ExtractedFact[],
  llm: V15LlmCandidate[],
  opts: { sourceTrust?: number; sourceText: string },
): V15ExtractedFact[] {
  const trust = clamp01V15(opts.sourceTrust ?? 1);
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
      confidence: clamp01V15(c.confidence),
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
 * Trich day du mot turn: rule v13/v14 (ke thua) + rule v15 + LLM tuy
 * chon — TAT CA trong 1 pass duy nhat (Mem0 v3: single-pass
 * extraction). Thu tu uu tien trung lap: v13/v14 rule > v15 rule > LLM.
 */
export async function extractFactsV15(
  text: string,
  opts: { sourceTrust?: number; llmExtractor?: V15LlmExtractor | null; at?: string } = {},
): Promise<V15ExtractedFact[]> {
  const trust = clamp01V15(opts.sourceTrust ?? 1);
  const clean = (text ?? '').trim();
  if (clean === '') return [];
  const inherited = extractFactsV14Sync(clean, trust).map(toV15);
  const v15rules = extractV15RuleCandidates(clean, trust);
  const seen = new Set(
    inherited.map(
      (c) => `${c.intent}|${normalizeGraphText(c.subject)}|${c.predicate}|${normalizeGraphText(c.objectText)}`,
    ),
  );
  const merged = [...inherited];
  for (const c of v15rules) {
    const key = `${c.intent}|${normalizeGraphText(c.subject)}|${c.predicate}|${normalizeGraphText(c.objectText)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(c);
  }
  if (opts.llmExtractor) {
    let llm: V15LlmCandidate[] = [];
    try {
      llm = await opts.llmExtractor.extract(clean, { ...(opts.at ? { at: opts.at } : {}) });
    } catch {
      llm = [];
    }
    return mergeRuleAndLlmCandidatesV15(merged, llm, { sourceTrust: trust, sourceText: clean });
  }
  return merged;
}

/** Trich dong bo (khong LLM) — tien cho tool/test khong async. */
export function extractFactsV15Sync(text: string, sourceTrust = 1): V15ExtractedFact[] {
  const trust = clamp01V15(sourceTrust);
  const clean = (text ?? '').trim();
  if (clean === '') return [];
  const inherited = extractFactsV14Sync(clean, trust).map(toV15);
  const v15rules = extractV15RuleCandidates(clean, trust);
  const seen = new Set(
    inherited.map(
      (c) => `${c.intent}|${normalizeGraphText(c.subject)}|${c.predicate}|${normalizeGraphText(c.objectText)}`,
    ),
  );
  const merged = [...inherited];
  for (const c of v15rules) {
    const key = `${c.intent}|${normalizeGraphText(c.subject)}|${c.predicate}|${normalizeGraphText(c.objectText)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(c);
  }
  return merged;
}

function scopeOfTurn(turn: V15TurnInput): MemoryScope {
  if (turn.scope) return { ...turn.scope };
  return {
    userId: turn.userId ?? '',
    botId: turn.botId ?? '',
    runId: turn.runId ?? '',
  };
}

/**
 * Consolidate Mem0-v3 style: trich 1 pass / turn -> loc confidence
 * hieu dung -> gate (neu co) -> APPEND add-only (dedupe chinh xac)
 * -> mau thuan don tri chi GHI LAI (coexisting), KHONG supersede,
 * KHONG dong cua so, KHONG xoa. Retract van dong cua so fact cu
 * (dong cua so la cach duy nhat viet lai lich su o write-time, va
 * no khong xoa fact — lich su truoc moc rut lai van truy van duoc).
 */
export async function consolidateTurnsV15(
  store: TemporalGraphStore,
  turns: V15TurnInput[],
  opts: V15ConsolidateOptions = {},
): Promise<V15ConsolidationReport> {
  const minConfidence = opts.minConfidence ?? V15_DEFAULT_MIN_CONFIDENCE;
  const now = opts.now ?? new Date();
  const report: V15ConsolidationReport = {
    turns: turns.length,
    llmCalls: 0,
    ruleCandidates: 0,
    llmCandidates: 0,
    appended: [],
    duplicates: [],
    coexisting: [],
    retracted: [],
    dropped: [],
    gated: [],
  };
  for (const turn of turns) {
    const scope = scopeOfTurn(turn);
    const at = turn.at ?? now.toISOString();
    const trust = clamp01V15(turn.sourceTrust ?? 1);
    // Single-pass: dung 1 lan goi LLM duy nhat cho ca turn (ke ca
    // khi khong co LLM — llmCalls chi dem khi that su goi).
    if (opts.llmExtractor) report.llmCalls += 1;
    const candidates = await extractFactsV15(turn.text, {
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
      // --- Mau thuan don tri: GHI LAI, khong giai quyet (Mem0 v3). ---
      const conflicts = isSingleValuedPredicateV15(candidate.predicate)
        ? store
            .findActiveFacts(candidate.subject, candidate.predicate, scope)
            .filter(
              (f) =>
                normalizeGraphText(f.objectText ?? '') !== normalizeGraphText(candidate.objectText),
            )
        : [];
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
      void fact;
      report.appended.push(candidate);
      for (const old of conflicts) {
        report.coexisting.push({
          candidate,
          existingFact: old,
          reason:
            `Fact moi "${candidate.objectText}" mau thuan fact cu "${old.objectText ?? ''}" ` +
            `cung (${candidate.subject}, ${candidate.predicate}) — giu ca hai, retrieval se quyet.`,
        });
      }
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// Retrieval-time supersede — quyet dinh fact nao con dung LUC HOI
// ---------------------------------------------------------------------------

/** Ket qua giai quyet mot nhom (subject, predicate) don tri tai thoi diem hoi. */
export interface V15Resolution {
  subject: string;
  predicate: string;
  /** Fact thang (null = khong co fact nao dung tai thoi diem hoi). */
  winner: GraphFact | null;
  /** Cac fact thua — van con trong store, chi bi danh dau o view nay. */
  supersededInView: { fact: GraphFact; reason: string }[];
  /** Tat ca fact xet (de UI/debug hien lich su). */
  considered: GraphFact[];
}

/** Thu tu thang: validFrom moi nhat > confidence cao nhat > createdAt moi nhat. */
export function compareFactsForResolutionV15(a: GraphFact, b: GraphFact): number {
  const aFrom = Date.parse(a.validFrom);
  const bFrom = Date.parse(b.validFrom);
  if (aFrom !== bFrom) return bFrom - aFrom;
  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  return Date.parse(b.createdAt) - Date.parse(a.createdAt);
}

/**
 * Giai quyet mot (subject, predicate) tai thoi diem `asOf` (mac dinh
 * bay gio): chi xet fact co cua so hieu luc chua `asOf` (window-based,
 * khong xet status — fact superseded o write-time van co the thang
 * neu cua so cua no chua `asOf`), loai fact deleted/quarantined.
 * Store KHONG doi gi — ket qua chi la view.
 */
export function resolveCurrentV15(
  store: TemporalGraphStore,
  subject: string,
  predicate: string,
  scope: MemoryScope,
  asOf?: string | Date,
): V15Resolution {
  const atMs = asOf === undefined ? Date.now() : new Date(asOf).getTime();
  const subjectNorm = normalizeGraphText(subject);
  const considered = store
    .listFacts({ ...scope, predicate, limit: 5000 })
    .filter((f) => f.status !== 'deleted' && f.status !== 'quarantined')
    .filter(
      (f) =>
        normalizeGraphText(store.getEntity(f.subjectId)?.name ?? '') === subjectNorm,
    )
    .filter((f) => {
      if (Number.isNaN(atMs)) return true;
      if (Date.parse(f.validFrom) > atMs) return false;
      if (f.validUntil !== null && Date.parse(f.validUntil) <= atMs) return false;
      return true;
    })
    .sort(compareFactsForResolutionV15);
  const winner = considered[0] ?? null;
  const supersededInView = considered.slice(1).map((fact) => ({
    fact,
    reason: winner
      ? `Thua fact "${winner.objectText ?? ''}" (validFrom ${winner.validFrom}, confidence ${winner.confidence}) tai thoi diem hoi.`
      : 'Khong co fact thang.',
  }));
  return { subject, predicate, winner, supersededInView, considered };
}

/**
 * Giai quyet TAT CA nhom (subject, predicate) don tri trong scope
 * tai thoi diem hoi — dung de lay "trang thai hien tai" cua memory
 * ma khong phai supersede tung fact o write-time.
 */
export function resolveAllCurrentV15(
  store: TemporalGraphStore,
  scope: MemoryScope,
  asOf?: string | Date,
): V15Resolution[] {
  const groups = new Map<string, { subject: string; predicate: string }>();
  for (const fact of store.listFacts({ ...scope, limit: 5000 })) {
    if (fact.status === 'deleted' || fact.status === 'quarantined') continue;
    if (!isSingleValuedPredicateV15(fact.predicate)) continue;
    const subject = store.getEntity(fact.subjectId)?.name ?? '';
    const key = `${normalizeGraphText(subject)}|${fact.predicate}`;
    if (!groups.has(key)) groups.set(key, { subject, predicate: fact.predicate });
  }
  const out: V15Resolution[] = [];
  for (const g of groups.values()) {
    out.push(resolveCurrentV15(store, g.subject, g.predicate, scope, asOf));
  }
  out.sort((a, b) =>
    `${a.subject}|${a.predicate}` < `${b.subject}|${b.predicate}` ? -1 : 1,
  );
  return out;
}
