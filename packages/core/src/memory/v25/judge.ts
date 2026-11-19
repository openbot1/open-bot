/**
 * Memory v25 — LLM judge + extractor (v1.40, Doi T1).
 *
 * Y tuong hoc tu Mem0 (survey v140 muc 4, chi y tuong): pipeline
 * add memory -> extract fact -> LLM judge quyet dinh ADD / UPDATE /
 * DELETE / NOISE cho tung fact so voi memory hien co. Giu nguyen
 * tac "khong xoa vat ly, chi dong hieu luc" cua Graphiti cho fact cu.
 *
 * Ngu nghia quyet dinh (v25):
 *  - ADD: chua co fact active nao cung subject+predicate — fact moi.
 *  - UPDATE: co fact active cung subject+predicate, object khac,
 *    ung vien dua ra gia tri moi — supersede fact cu, them fact moi.
 *  - DELETE: ung vien phu dinh / ket thuc fact hien co (vd "khong con",
 *    "da nghi", "no longer", "stopped") — DONG hieu luc fact cu,
 *    KHONG them fact moi, KHONG xoa vat ly.
 *  - NOISE: ung vien rong / khong co cau truc fact / trung lap y
 *    het fact hien co — bo qua, khong ghi.
 *
 * Mac dinh dung rule judge xac dinh (deterministic, chay local,
 * khong goi model). Host co the cam LLM that qua V25JudgeFn — sleep
 * agent va pipeline nhan judgeFn tu ben ngoai, ghi ro model vao
 * sleep pass + judge log de audit.
 */
import type { V25FactEdgeStore } from './factEdges';
import {
  errV25,
  isoAtV25,
  jaccardV25,
  makeV25Id,
  normalizeTextV25,
  okV25,
  tokenizeV25,
  type V25FactEdge,
  type V25FactEdgeInput,
  type V25JudgeDecision,
  type V25JudgeFn,
  type V25JudgeInput,
  type V25JudgeVerdict,
  type V25Result,
} from './types';

/** Nguong tuong dong object de coi la trung lap (NOISE). */
const DUPLICATE_SIMILARITY = 0.85;

/** Dau hieu phu dinh / ket thuc (tieng Viet + tieng Anh). */
const NEGATION_MARKERS = [
  'không còn',
  'khong con',
  'không còn là',
  'không phải',
  'khong phai',
  'đã nghỉ',
  'da nghi',
  'đã thôi',
  'da thoi',
  'đã dừng',
  'da dung',
  'đã hủy',
  'da huy',
  'đã bỏ',
  'da bo',
  'hết hạn',
  'het han',
  'no longer',
  'not anymore',
  'not any more',
  'stopped',
  'quit',
  'cancelled',
  'canceled',
  'no more',
  'never',
];

/** Cau qua ngan / khong co noi dung de trich fact. */
export function isNoiseTextV25(text: string): boolean {
  const t = text.trim();
  if (t.length < 3) return true;
  const tokens = tokenizeV25(t);
  if (tokens.length < 2) return true;
  // Chi toan cam than / chao hoi.
  if (/^(hi|hello|hey|chao|chào|ok|okay|ừ|ừm|ừ nhỉ|thanks|cảm ơn|cam on)[.!?]*$/i.test(t)) return true;
  return false;
}

/** Ung vien co chua dau hieu phu dinh / ket thuc khong? */
export function hasNegationV25(text: string): boolean {
  const low = ` ${normalizeTextV25(text)} `;
  return NEGATION_MARKERS.some((m) => low.includes(` ${m} `) || low.includes(` ${m}`));
}

/**
 * Rule judge xac dinh — khong goi model, khong goi mang.
 * Thu tu quyet dinh: NOISE (trung lap / rong) -> DELETE (phu dinh
 * fact hien co) -> UPDATE (cung subject+predicate, object khac) ->
 * ADD (chua co gi).
 */
export function createRuleJudgeV25(): V25JudgeFn {
  return (input: V25JudgeInput): V25JudgeVerdict => {
    const c = input.candidate;
    const subject = c.subject.trim();
    const predicate = c.predicate.trim();
    const object = c.object.trim();
    if (!subject || !predicate || !object) {
      return {
        decision: 'NOISE',
        confidence: 0.95,
        reason: 'Ung vien thieu subject/predicate/object — khong phai fact.',
        matchedFactId: null,
        suggestedObject: null,
      };
    }
    const sourceText = c.sourceText && c.sourceText.trim()
      ? c.sourceText
      : `${subject} ${predicate} ${object}`;
    if (isNoiseTextV25(sourceText) && isNoiseTextV25(object)) {
      return {
        decision: 'NOISE',
        confidence: 0.9,
        reason: 'Text nguon qua ngan / khong co noi dung — noise.',
        matchedFactId: null,
        suggestedObject: null,
      };
    }
    const existing = input.existing.filter((e) => e.status === 'active');
    if (existing.length === 0) {
      return {
        decision: 'ADD',
        confidence: 0.8,
        reason: 'Chua co fact active nao cung subject+predicate.',
        matchedFactId: null,
        suggestedObject: null,
      };
    }
    // DELETE: ung vien phu dinh / ket thuc 1 fact hien co.
    if (hasNegationV25(sourceText) || hasNegationV25(object)) {
      const target = pickClosestExistingV25(existing, c);
      return {
        decision: 'DELETE',
        confidence: 0.75,
        reason: `Ung vien phu dinh/ket thuc fact hien co (${target.id}): dong hieu luc, khong them fact moi.`,
        matchedFactId: target.id,
        suggestedObject: null,
      };
    }
    // NOISE: trung lap y het 1 fact hien co.
    for (const e of existing) {
      const sim = jaccardV25(tokenizeV25(e.object), tokenizeV25(object));
      if (normalizeTextV25(e.object) === normalizeTextV25(object) || sim >= DUPLICATE_SIMILARITY) {
        return {
          decision: 'NOISE',
          confidence: 0.9,
          reason: `Trung lap fact hien co ${e.id} (similarity ${sim.toFixed(2)}) — da biet.`,
          matchedFactId: e.id,
          suggestedObject: null,
        };
      }
    }
    // UPDATE: cung subject+predicate, object khac — gia tri moi.
    const target = pickClosestExistingV25(existing, c);
    return {
      decision: 'UPDATE',
      confidence: 0.8,
      reason: `Cung subject+predicate voi ${target.id} nhung object khac ("${target.object}" -> "${object}") — supersede fact cu.`,
      matchedFactId: target.id,
      suggestedObject: object,
    };
  };
}

/** Chon fact hien co gan ung vien nhat (theo object similarity). */
function pickClosestExistingV25(existing: V25FactEdge[], c: V25FactEdgeInput): V25FactEdge {
  let best = existing[0] as V25FactEdge;
  let bestSim = -1;
  for (const e of existing) {
    const sim = jaccardV25(tokenizeV25(e.object), tokenizeV25(c.object));
    if (sim > bestSim) {
      bestSim = sim;
      best = e;
    }
  }
  return best;
}

/** Ket qua ap dung 1 quyet dinh judge vao store. */
export interface V25ApplyDecisionResult {
  decision: V25JudgeDecision;
  /** Edge moi (ADD/UPDATE) hoac null (DELETE/NOISE). */
  newEdge: V25FactEdge | null;
  /** Edge bi dong hieu luc (UPDATE/DELETE) hoac null. */
  closedEdge: V25FactEdge | null;
  /** Mo ta ket qua de ghi log. */
  detail: string;
}

/**
 * Ap dung quyet dinh judge vao store.
 *  - ADD: them edge moi.
 *  - UPDATE: supersede edge cu (dong cua so), them edge moi.
 *  - DELETE: dong cua so edge cu, KHONG them edge moi, KHONG xoa.
 *  - NOISE: khong ghi gi.
 */
export function applyJudgeDecisionV25(
  store: V25FactEdgeStore,
  candidate: V25FactEdgeInput,
  verdict: V25JudgeVerdict,
  opts: { nowMs?: number; by?: string } = {},
): V25Result<V25ApplyDecisionResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const by = opts.by ?? 'judge';
  const matched = verdict.matchedFactId ? store.get(verdict.matchedFactId) : undefined;
  switch (verdict.decision) {
    case 'NOISE': {
      return okV25({
        decision: 'NOISE',
        newEdge: null,
        closedEdge: null,
        detail: `NOISE — bo qua: ${verdict.reason}`,
      });
    }
    case 'ADD': {
      const created = store.add(
        { ...candidate, judgeDecision: 'ADD' },
        { nowMs, by },
      );
      if (!created.ok) return created as unknown as V25Result<V25ApplyDecisionResult>;
      return okV25({
        decision: 'ADD',
        newEdge: created.value,
        closedEdge: null,
        detail: `ADD — them edge ${created.value.id}: ${candidate.subject} ${candidate.predicate} ${candidate.object}`,
      });
    }
    case 'UPDATE': {
      const created = store.addSuperseding(
        { ...candidate, judgeDecision: 'UPDATE' },
        {
          nowMs,
          by,
          reason: `superseded by judge UPDATE (${verdict.reason})`,
        },
      );
      if (!created.ok) return created as unknown as V25Result<V25ApplyDecisionResult>;
      const closed = created.value.closed[0] ?? null;
      return okV25({
        decision: 'UPDATE',
        newEdge: created.value.edge,
        closedEdge: closed,
        detail: `UPDATE — them edge ${created.value.edge.id}${closed ? `, dong edge ${closed.id}` : ''}: ${candidate.subject} ${candidate.predicate} ${candidate.object}`,
      });
    }
    case 'DELETE': {
      if (!matched) {
        return errV25('DELETE can matchedFactId tro toi fact hien co, nhung khong tim thay.');
      }
      if (matched.status !== 'active') {
        return errV25(`Fact ${matched.id} da dong (status ${matched.status}) — khong DELETE lai.`);
      }
      const closed = store.closeEdge(matched.id, {
        nowMs,
        by,
        reason: `judge DELETE: ${verdict.reason}`,
      });
      if (!closed.ok) return closed as unknown as V25Result<V25ApplyDecisionResult>;
      return okV25({
        decision: 'DELETE',
        newEdge: null,
        closedEdge: closed.value,
        detail: `DELETE — dong hieu luc edge ${closed.value.id} (khong xoa): ${verdict.reason}`,
      });
    }
    default:
      return errV25(`Quyet dinh judge khong hop le: ${String(verdict.decision)}.`);
  }
}

// ---------------------------------------------------------------------------
// Rule extractor — trich fact ung vien tu text (khong goi model)
// ---------------------------------------------------------------------------

/** 1 fact ung vien trich tu text. */
export interface V25ExtractedCandidate extends V25FactEdgeInput {
  /** Cau goc trich ra ung vien. */
  sentence: string;
}

/**
 * Trich fact ung vien tu text bang pattern (tieng Viet + tieng Anh):
 *  - "X là Y" / "X is Y" / "X la Y"
 *  - "X thích Y" / "X likes Y" / "X love Y"
 *  - "X làm Y" / "X works as Y" / "X is a Y"
 *  - "X sống ở Y" / "X lives in Y"
 *  - "X có Y" / "X has Y"
 * Pattern chi lay cau co subject la danh tu rieng / dai tu ngan —
 * muc dich la ung vien cho judge, judge moi quyet dinh ghi hay khong.
 */
export function extractCandidateFactsV25(
  text: string,
  opts: { episodeId?: string; scope?: Partial<V25FactEdgeInput['scope']>; maxCandidates?: number } = {},
): V25ExtractedCandidate[] {
  const max = opts.maxCandidates ?? 20;
  const out: V25ExtractedCandidate[] = [];
  const sentences = text
    .split(/(?<=[.!?。])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
  const patterns: { re: RegExp; predicate: string }[] = [
    { re: /^(.{1,60}?)\s+(?:là|la|is)\s+(?:một\s+|a\s+|an\s+|the\s+)?(.{1,120})$/i, predicate: 'is' },
    { re: /^(.{1,60}?)\s+(?:thích|thich|likes?|loves?|love)\s+(.{1,120})$/i, predicate: 'likes' },
    { re: /^(.{1,60}?)\s+(?:làm việc(?:\s+(?:ở|o|tại|tai|as))?|làm|lam|works?\s+(?:as\s+)?)\s+(.{1,120})$/i, predicate: 'works_as' },
    { re: /^(.{1,60}?)\s+(?:sống ở|sống tại|song o|song tai|lives?\s+in)\s+(.{1,120})$/i, predicate: 'lives_in' },
    { re: /^(.{1,60}?)\s+(?:có|co|has|have)\s+(.{1,120})$/i, predicate: 'has' },
    { re: /^(.{1,60}?)\s+(?:học|hoc|studies|studying)\s+(.{1,120})$/i, predicate: 'studies' },
    { re: /^(.{1,60}?)\s+(?:ghét|ghet|hates?|dislikes?)\s+(.{1,120})$/i, predicate: 'dislikes' },
  ];
  for (const sentence of sentences) {
    if (out.length >= max) break;
    const clean = sentence.replace(/[.!?。]+$/, '').trim();
    for (const { re, predicate } of patterns) {
      const m = re.exec(clean);
      if (!m) continue;
      const subject = (m[1] ?? '').trim();
      const object = (m[2] ?? '').trim();
      if (!subject || !object) continue;
      if (subject.split(/\s+/).length > 8 || object.split(/\s+/).length > 20) continue;
      out.push({
        subject,
        predicate,
        object,
        sourceText: sentence,
        sentence,
        episodeId: opts.episodeId ?? '',
        scope: opts.scope,
      });
      break;
    }
  }
  return out;
}

/** Tao 1 muc judge log tu verdict + ket qua ap dung. */
export function makeJudgeLogEntryV25(
  candidate: V25FactEdgeInput,
  verdict: V25JudgeVerdict,
  applied: boolean,
  appliedDetail: string,
  source: string,
  nowMs: number = Date.now(),
): { id: string; at: string; candidateSubject: string; candidatePredicate: string; candidateObject: string; decision: V25JudgeDecision; confidence: number; reason: string; matchedFactId: string | null; applied: boolean; appliedDetail: string; source: string } {
  return {
    id: makeV25Id('judge'),
    at: isoAtV25(nowMs),
    candidateSubject: candidate.subject,
    candidatePredicate: candidate.predicate,
    candidateObject: candidate.object,
    decision: verdict.decision,
    confidence: verdict.confidence,
    reason: verdict.reason,
    matchedFactId: verdict.matchedFactId,
    applied,
    appliedDetail,
    source,
  };
}
