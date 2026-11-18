/**
 * Memory v16 — Extract/fuse da scope + sleep-time consolidation (v1.35, Doi T1).
 *
 * Y tuong hoc tu Mem0 (extract fact tu conversation, roi fuse vao bo
 * nho bang 4 thao tac ADD / UPDATE / DELETE / IGNORE — fact moi thi
 * them, fact thay doi gia tri thi cap nhat, fact bi phu dinh thi xoa,
 * fact trung/nhieu thi bo) + sleep-time compute kieu Letta (agent nen
 * don dep luc idle) — tu thiet ke lai hoan toan cho open-bot, chay
 * 100% local, KHONG copy code/text/tai san cua bat ky repo nao.
 *
 * Moi so voi consolidation v15 (lop fuse RIENG cua v16):
 *  1. Da scope that su: user / agent / session / shared — cung mot
 *     (subject, predicate) nhung khac scope thi khong fuse lan nhau;
 *     session fact lap lai du lan duoc PROMOTE len user scope.
 *  2. Fuse 4 thao tac day du: ADD (moi), UPDATE (don tri doi gia
 *     tri — supersede qua store), DELETE (mau phu dinh "khong con
 *     ... nua" — invalidate, giu lich su), IGNORE (trung / nhieu /
 *     tin cay thap).
 *  3. Sleep-time consolidation agent: queue turn cho luc idle, chay
 *     1 luot gom extract + fuse + promote fact ben vung vao core
 *     block (persona/human) — block PINNED khong bao gio bi ghi de
 *     luc promote.
 *  4. Rule extractor song ngu Viet/Anh, xac dinh, khong goi model:
 *     name, lives_in, works_at, likes, dislikes, prefers, speaks,
 *     has_pet, owns, goal + mau phu dinh (retract).
 */

import type { GraphFact, MemoryScope } from '../memory/graph/types';
import { normalizeGraphText } from '../memory/graph/types';
import type { TemporalGraphStore } from '../memory/graph/store';
import { M16BlockStore, M16_SLEEP_IDLE_THRESHOLD_MS } from './blocks';
import type { M16ValidityLedger } from './temporalKg';

/** Loi consolidation v16 — message tieng Viet. */
export class M16ConsolidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'M16ConsolidationError';
  }
}

/** Scope fuse: fact thuoc ve ai / phien nao. */
export type M16Scope = 'user' | 'agent' | 'session' | 'shared';

/** Y dinh cua fact trich duoc: khang dinh hay phu dinh (rut lai). */
export type M16FactIntent = 'assert' | 'retract';

/** Mot fact trich duoc tu text (chua ghi vao store). */
export interface M16ExtractedFact {
  subject: string;
  predicate: string;
  objectText: string;
  confidence: number;
  sourceText: string;
  scope: M16Scope;
  intent: M16FactIntent;
  /** Cua so hieu luc neu text neu ro (vd "tu thang 6"). */
  validFrom?: string;
  validUntil?: string | null;
}

/** Predicate don tri: 1 subject chi co 1 gia tri dung tai 1 thoi diem. */
export const M16_SINGLE_VALUED_PREDICATES: ReadonlySet<string> = new Set([
  'name',
  'lives_in',
  'works_at',
  'job_title',
  'age',
  'birthday',
  'phone',
  'email',
  'favorite_color',
  'favorite_food',
  'current_goal',
  'current_project',
]);

export function isSingleValuedPredicateM16(predicate: string): boolean {
  return M16_SINGLE_VALUED_PREDICATES.has(normalizeGraphText(predicate).replace(/\s+/g, '_'));
}

/** Do tin cay toi thieu mac dinh de fuse (duoi muc nay -> IGNORE). */
export const M16_DEFAULT_MIN_CONFIDENCE = 0.5;
/** So lan session fact lap lai thi promote len user scope. */
export const M16_SESSION_PROMOTE_REPEATS = 2;

export function clamp01M16(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function cleanObjectM16(raw: string): string {
  return (raw ?? '').trim().replace(/\s+/g, ' ').replace(/[.,;:!?]+$/, '').trim();
}

interface M16ExtractPattern {
  predicate: string;
  /** Nhom capture 1 = object. */
  regex: RegExp;
  confidence: number;
  intent: M16FactIntent;
}

/**
 * Bang mau trich fact song ngu (Viet/Anh). Thu tu quan trong: mau
 * dac thu truoc, mau chung sau (vd `owns` sau `has_pet`).
 */
const M16_EXTRACT_PATTERNS: M16ExtractPattern[] = [
  { predicate: 'name', regex: /(?:tên (?:tôi|của tôi|mình) là|tôi tên là|tên mình là|my name is|i am called|call me)\s+([A-ZÀ-ỹ][^,.;!?]{1,40})/i, confidence: 0.95, intent: 'assert' },
  { predicate: 'lives_in', regex: /(?:tôi sống (?:ở|tại)|mình sống (?:ở|tại)|sống (?:ở|tại)|i live in|i live at|i am based in)\s+([^,.;!?]{1,60})/i, confidence: 0.9, intent: 'assert' },
  { predicate: 'works_at', regex: /(?:tôi làm (?:việc )?(?:ở|tại)|mình làm (?:ở|tại)|làm việc (?:ở|tại)|i work at|i work for|i am employed (?:at|by))\s+([^,.;!?]{1,60})/i, confidence: 0.9, intent: 'assert' },
  { predicate: 'job_title', regex: /(?:tôi là (?:một )?(?:một )?|mình là |i am a|i am an|i work as a|nghề của tôi là)\s+([^,.;!?]{1,50})/i, confidence: 0.7, intent: 'assert' },
  { predicate: 'likes', regex: /(?:tôi (?:rất )?thích|mình (?:rất )?thích|tôi yêu thích|i (?:really )?(?:like|love)|i enjoy)\s+([^,.;!?]{1,60})/i, confidence: 0.85, intent: 'assert' },
  { predicate: 'dislikes', regex: /(?:tôi không thích|mình không thích|tôi ghét|mình ghét|i (?:do not|don't) like|i hate|i dislike)\s+([^,.;!?]{1,60})/i, confidence: 0.85, intent: 'assert' },
  { predicate: 'prefers', regex: /(?:tôi thích nhất|mình thích nhất|tôi ưa|i prefer)\s+([^,.;!?]{1,60})/i, confidence: 0.8, intent: 'assert' },
  { predicate: 'speaks', regex: /(?:tôi nói được|mình nói được|tôi biết|i speak|i can speak)\s+(tiếng [^,.;!?]{1,30}|english|vietnamese|french|japanese|chinese|spanish|german|[a-z]{2,20})/i, confidence: 0.85, intent: 'assert' },
  { predicate: 'has_pet', regex: /(?:tôi nuôi|mình nuôi|tôi có (?:một )?con|i have a pet|i own a)\s+(chó|mèo|chim|cá|thỏ|dog|cat|bird|fish|rabbit|[^,.;!?]{1,20})/i, confidence: 0.85, intent: 'assert' },
  { predicate: 'owns', regex: /(?:tôi có|mình có|tôi sở hữu|i have|i own)\s+(?:một |a |an )?([^,.;!?]{1,60})/i, confidence: 0.6, intent: 'assert' },
  { predicate: 'current_goal', regex: /(?:mục tiêu (?:của tôi|của mình) là|mục tiêu hiện tại (?:của tôi )?là|my goal is|my current goal is)\s+([^,.;!?]{1,80})/i, confidence: 0.85, intent: 'assert' },
  { predicate: 'favorite_food', regex: /(?:món (?:ăn )?(?:yêu thích|ưa thích) (?:của tôi )?là|tôi thích ăn nhất|my favorite food is|my favourite food is)\s+([^,.;!?]{1,40})/i, confidence: 0.85, intent: 'assert' },
  { predicate: 'favorite_color', regex: /(?:màu (?:yêu thích|ưa thích) (?:của tôi )?là|my favorite color is|my favourite colour is)\s+([^,.;!?]{1,30})/i, confidence: 0.85, intent: 'assert' },
];

/** Mau phu dinh: "khong con ... nua" / "no longer ..." -> intent retract. */
const M16_RETRACT_PATTERNS: { predicate: string; regex: RegExp }[] = [
  { predicate: 'works_at', regex: /(?:tôi không còn làm (?:việc )?(?:ở|tại)|không còn làm ở|i no longer work at|i no longer work for)\s+([^,.;!?]{1,60})/i },
  { predicate: 'lives_in', regex: /(?:tôi không còn sống (?:ở|tại)|không còn sống ở|i no longer live in|i no longer live at)\s+([^,.;!?]{1,60})/i },
  { predicate: 'likes', regex: /(?:tôi không còn thích|không còn thích|i no longer like|i don't like .* anymore)\s+([^,.;!?]{1,60})/i },
  { predicate: 'current_goal', regex: /(?:tôi (?:đã )?bỏ mục tiêu|tôi không còn theo đuổi|i (?:have )?abandoned (?:my )?goal|i no longer pursue)\s+([^,.;!?]{1,80})/i },
];

/**
 * Trich fact tu text bang rule (xac dinh, khong goi model). Tra ve
 * danh sach fact ung vien; text khong khop mau nao -> [].
 */
export function extractFactsM16Sync(
  text: string,
  opts: { scope?: M16Scope; sourceTrust?: number; subject?: string } = {},
): M16ExtractedFact[] {
  const input = (text ?? '').trim();
  if (input === '') return [];
  const scope = opts.scope ?? 'user';
  const trust = clamp01M16(opts.sourceTrust ?? 1);
  const subject = (opts.subject ?? 'user').trim() || 'user';
  const out: M16ExtractedFact[] = [];
  const seen = new Set<string>();

  for (const pat of M16_RETRACT_PATTERNS) {
    const m = pat.regex.exec(input);
    if (!m) continue;
    const objectText = cleanObjectM16(m[1] ?? '');
    if (objectText === '') continue;
    const key = `${pat.predicate}::${normalizeGraphText(objectText)}::retract`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      subject,
      predicate: pat.predicate,
      objectText,
      confidence: 0.85 * trust,
      sourceText: input.slice(0, 500),
      scope,
      intent: 'retract',
    });
  }

  for (const pat of M16_EXTRACT_PATTERNS) {
    const m = pat.regex.exec(input);
    if (!m) continue;
    const objectText = cleanObjectM16(m[1] ?? '');
    if (objectText === '') continue;
    // Bo qua match qua ngan / chi la dai tu.
    if (/^(nó|này|kia|đó|it|that|this)$/i.test(objectText)) continue;
    const key = `${pat.predicate}::${normalizeGraphText(objectText)}::${pat.intent}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      subject,
      predicate: pat.predicate,
      objectText,
      confidence: clamp01M16(pat.confidence * trust),
      sourceText: input.slice(0, 500),
      scope,
      intent: pat.intent,
    });
  }
  return out;
}

/**
 * Muc do trung nhau token giua 2 object (0..1) — he so overlap
 * (containment): 1 = object ngan hon nam tron trong object dai hon.
 * Dung de phat hien gan trung: mot fact la tap con token cua fact
 * kia thi khong them thong tin moi (vd 'ca phe trung' trong
 * 'ca phe trung Ha Noi' -> gan trung).
 */
export function objectOverlapM16(a: string, b: string): number {
  const ta = new Set(normalizeGraphText(a).split(/\s+/).filter((t) => t.length > 0));
  const tb = new Set(normalizeGraphText(b).split(/\s+/).filter((t) => t.length > 0));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / Math.min(ta.size, tb.size);
}

/** Quyet dinh fuse cho mot ung vien so voi fact hien co cung scope. */
export type M16FuseDecision = 'add' | 'update' | 'delete' | 'ignore';

export interface M16FusePlan {
  decision: M16FuseDecision;
  reason: string;
  /** Fact hien co bi anh huong (update/delete), neu co. */
  target?: GraphFact;
}

/**
 * Lap ke hoach fuse (khong ghi): so sanh ung vien voi fact active
 * cung (subject, predicate) trong cung scope.
 *  - retract + co fact khop -> DELETE; retract nhung khong co -> IGNORE.
 *  - khong co fact cung cap -> ADD.
 *  - object giong het -> IGNORE (trung).
 *  - don tri + doi object -> UPDATE (supersede).
 *  - da tri + doi object: gan trung (>= 0.8 overlap) -> IGNORE, con lai -> ADD.
 */
export function planFuseM16(
  existing: GraphFact[],
  candidate: M16ExtractedFact,
  opts: { minConfidence?: number } = {},
): M16FusePlan {
  const minConfidence = opts.minConfidence ?? M16_DEFAULT_MIN_CONFIDENCE;
  if (candidate.confidence < minConfidence) {
    return {
      decision: 'ignore',
      reason: `Do tin cay ${candidate.confidence.toFixed(2)} duoi nguong ${minConfidence}.`,
    };
  }
  const subjectKey = normalizeGraphText(candidate.subject);
  void subjectKey;
  const predicate = normalizeGraphText(candidate.predicate).replace(/\s+/g, '_');
  // Caller da loc `existing` theo dung subject (xem applyFuseM16:
  // loc theo subjectId qua findEntityByName). O day chi loc theo
  // predicate + trang thai active.
  const byPredicate = existing.filter((f) => f.status === 'active' && f.predicate === predicate);
  if (candidate.intent === 'retract') {
    const target = byPredicate.find(
      (f) =>
        normalizeGraphText(f.objectText ?? '') === normalizeGraphText(candidate.objectText) ||
        objectOverlapM16(f.objectText ?? '', candidate.objectText) >= 0.8,
    );
    if (!target) {
      return { decision: 'ignore', reason: `Retract "${candidate.objectText}" nhung khong co fact nao khop de xoa.` };
    }
    return { decision: 'delete', reason: `User rut lai fact "${target.objectText ?? ''}".`, target };
  }
  if (byPredicate.length === 0) {
    return { decision: 'add', reason: 'Chua co fact cung (subject, predicate) — them moi.' };
  }
  const exact = byPredicate.find(
    (f) => normalizeGraphText(f.objectText ?? '') === normalizeGraphText(candidate.objectText),
  );
  if (exact) {
    return { decision: 'ignore', reason: `Fact "${candidate.objectText}" da ton tai (trung).`, target: exact };
  }
  if (isSingleValuedPredicateM16(predicate)) {
    // Don tri: lay fact moi nhat lam muc tieu update.
    const target = [...byPredicate].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
    return {
      decision: 'update',
      reason: `Predicate don tri "${predicate}": "${target?.objectText ?? ''}" -> "${candidate.objectText}".`,
      target,
    };
  }
  const nearDup = byPredicate.find(
    (f) => objectOverlapM16(f.objectText ?? '', candidate.objectText) >= 0.8,
  );
  if (nearDup) {
    return { decision: 'ignore', reason: `Gan trung voi fact "${nearDup.objectText ?? ''}" (overlap >= 0.8).`, target: nearDup };
  }
  return { decision: 'add', reason: 'Predicate da tri, gia tri moi song song gia tri cu.' };
}

export interface M16FuseResult {
  decision: M16FuseDecision;
  candidate: M16ExtractedFact;
  reason: string;
  /** Fact moi tao / bi supersede / bi invalidate (neu co). */
  fact?: GraphFact;
  targetId?: string;
}

export interface M16FuseOptions {
  actor?: string;
  minConfidence?: number;
  ledger?: M16ValidityLedger;
  now?: Date;
  /** Scope MemoryScope ghi vao store (mac dinh suy tu candidate.scope). */
  scopeOverride?: MemoryScope;
}

function scopeForCandidateM16(candidate: M16ExtractedFact, base: MemoryScope): MemoryScope {
  const scope = { ...base };
  if (candidate.scope === 'session') {
    scope.sessionId = scope.sessionId ?? scope.runId ?? '';
  }
  if (candidate.scope === 'shared') {
    scope.userId = '';
    scope.botId = '';
  }
  return scope;
}

/**
 * So sanh scope CHAT: 2 scope chi giong nhau khi user/bot/run/
 * session/app deu khong ('' = khong co). KHAC voi matchesScope cua
 * old store ("empty matches everything" — fact khong co sessionId
 * van hien voi moi session): fuse phai co lap scope, neu khong fact
 * scope user se bi fuse voi candidate scope session.
 */
function sameScopeM16(a: MemoryScope, b: MemoryScope): boolean {
  const norm = (v: string | undefined): string => v ?? '';
  return (
    norm(a.userId) === norm(b.userId) &&
    norm(a.botId) === norm(b.botId) &&
    norm(a.runId) === norm(b.runId) &&
    norm(a.sessionId) === norm(b.sessionId) &&
    norm(a.appId) === norm(b.appId)
  );
}

/**
 * Fuse 1 ung vien vao store (ghi that): ADD -> addFact, UPDATE ->
 * supersedeFact, DELETE -> markFactInvalidated (giu lich su),
 * IGNORE -> khong ghi.
 */
export function applyFuseM16(
  store: TemporalGraphStore,
  candidate: M16ExtractedFact,
  baseScope: MemoryScope,
  opts: M16FuseOptions = {},
): M16FuseResult {
  const scope = opts.scopeOverride ?? scopeForCandidateM16(candidate, baseScope);
  const now = opts.now ?? new Date();
  const at = now.toISOString();
  const actor = opts.actor ?? 'sleep-agent-v16';
  // Chi fuse voi fact cung subject: loc theo entity name cua candidate.
  const subjectEntity = store.findEntityByName(candidate.subject);
  const allActive = store.listFacts({ ...scope, status: 'active', limit: 500 });
  const existing = (subjectEntity
    ? allActive.filter((f) => f.subjectId === subjectEntity.id)
    : []
  ).filter((f) => sameScopeM16(f.scope, scope));
  const plan = planFuseM16(existing, candidate, { minConfidence: opts.minConfidence });
  const provenance = {
    episodeId: '',
    turnId: '',
    runId: scope.runId ?? '',
    botId: scope.botId ?? '',
    userId: scope.userId ?? '',
    at,
    sourceText: candidate.sourceText,
  };
  switch (plan.decision) {
    case 'add': {
      const fact = store.addFact({
        subjectName: candidate.subject,
        predicate: candidate.predicate,
        objectText: candidate.objectText,
        confidence: candidate.confidence,
        scope,
        provenance,
        ...(candidate.validFrom ? { validFrom: candidate.validFrom } : {}),
        ...(candidate.validUntil !== undefined ? { validUntil: candidate.validUntil } : {}),
      });
      return { decision: 'add', candidate, reason: plan.reason, fact };
    }
    case 'update': {
      if (!plan.target) return { decision: 'ignore', candidate, reason: 'Khong co target de update.' };
      const fact = store.supersedeFact(plan.target.id, {
        subjectName: candidate.subject,
        predicate: candidate.predicate,
        objectText: candidate.objectText,
        confidence: candidate.confidence,
        scope,
        provenance,
        validFrom: at,
      });
      return { decision: 'update', candidate, reason: plan.reason, fact, targetId: plan.target.id };
    }
    case 'delete': {
      if (!plan.target) return { decision: 'ignore', candidate, reason: 'Khong co target de delete.' };
      let fact: GraphFact;
      try {
        fact = store.markFactInvalidated(plan.target.id, {
          invalidAt: at,
          actor,
          reason: `User rut lai: "${candidate.objectText}" (${plan.reason})`,
        });
      } catch {
        // Fact da het hieu luc truoc — xoa mem thay vi invalidate.
        fact = store.deleteFact(plan.target.id, actor);
      }
      return { decision: 'delete', candidate, reason: plan.reason, fact, targetId: plan.target.id };
    }
    case 'ignore':
    default:
      return { decision: 'ignore', candidate, reason: plan.reason, targetId: plan.target?.id };
  }
}

export interface M16TurnInput {
  text: string;
  scope?: M16Scope;
  subject?: string;
  userId?: string;
  botId?: string;
  runId?: string;
  sessionId?: string;
  sourceTrust?: number;
  sourceName?: string;
}

export interface M16ConsolidationReport {
  turns: number;
  extracted: number;
  added: number;
  updated: number;
  deleted: number;
  ignored: number;
  results: M16FuseResult[];
}

/**
 * Consolidate 1 luot turn: extract tung turn (rule) roi fuse tung
 * ung vien vao store. Tra bao cao dem theo thao tac.
 */
export function consolidateTurnsM16(
  store: TemporalGraphStore,
  turns: M16TurnInput[],
  opts: M16FuseOptions = {},
): M16ConsolidationReport {
  const report: M16ConsolidationReport = {
    turns: turns.length,
    extracted: 0,
    added: 0,
    updated: 0,
    deleted: 0,
    ignored: 0,
    results: [],
  };
  for (const turn of turns) {
    const baseScope: MemoryScope = {
      userId: turn.userId ?? '',
      botId: turn.botId ?? '',
      runId: turn.runId ?? '',
      ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
    };
    const candidates = extractFactsM16Sync(turn.text, {
      scope: turn.scope ?? 'user',
      sourceTrust: turn.sourceTrust ?? 1,
      subject: turn.subject ?? 'user',
    });
    report.extracted += candidates.length;
    for (const candidate of candidates) {
      const result = applyFuseM16(store, candidate, baseScope, opts);
      report.results.push(result);
      if (result.decision === 'add') report.added += 1;
      else if (result.decision === 'update') report.updated += 1;
      else if (result.decision === 'delete') report.deleted += 1;
      else report.ignored += 1;
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// Sleep-time consolidation agent — chay nen luc idle
// ---------------------------------------------------------------------------

export interface M16PendingTurn extends M16TurnInput {
  queuedAt: string;
}

export interface M16SleepConsolidationOptions {
  /** Thoi gian idle (ms). Mac dinh 0 = khong biet -> khong chay tru force. */
  idleMs?: number;
  /** Nguong idle toi thieu (mac dinh 5 phut). */
  idleThresholdMs?: number;
  /** true = chay ngay ca khi chua idle. */
  force?: boolean;
  /** Do tin cay toi thieu de promote fact vao core block. */
  promoteMinConfidence?: number;
  /** So lan fact phai xuat hien moi promote vao core block. */
  promoteMinRepeats?: number;
  /** So session khac nhau thay session fact thi promote len user scope. */
  sessionPromoteRepeats?: number;
  actor?: string;
  now?: Date;
  /** Ledger validity de ghi cua so khi promote (tuy chon). */
  ledger?: M16ValidityLedger;
}

export interface M16SleepConsolidationReport {
  ran: boolean;
  reason: string;
  at: string;
  turnsProcessed: number;
  extracted: number;
  added: number;
  updated: number;
  deleted: number;
  ignored: number;
  /** So fact session duoc promote len user scope. */
  sessionPromoted: number;
  /** So dong ghi vao core block luc promote. */
  corePromoted: number;
  actions: string[];
}

/**
 * Sleep-time consolidation agent: queue turn trong ngay, chay 1 luot
 * khi idle — extract + fuse + promote.
 *
 * Promote 2 tang:
 *  (a) Session -> user: fact scope session xuat hien o >= N session
 *      khac nhau thi tao them ban sao scope user (fact goc giu nguyen).
 *  (b) Fact ben vung -> core block: fact co confidence cao + lap lai
 *      du lan thi ghi 1 dong tom tat vao block `human` (fact ve user)
 *      hoac `persona` (fact ve agent). Block PINNED khong bao gio bi
 *      ghi — promote bo qua, ghi log.
 */
export class M16SleepConsolidator {
  private readonly queue: M16PendingTurn[] = [];
  /** Dem so lan thay 1 fact (key: subject|predicate|object). */
  private readonly seenCounts = new Map<string, number>();
  /** Tap sessionId da thay 1 fact (key -> tap session). */
  private readonly seenSessions = new Map<string, Set<string>>();

  /** So turn dang cho trong queue (de UI hien). */
  get pendingTurns(): number {
    return this.queue.length;
  }

  /** Ban sao queue hien tai (khong xoa) — dung cho preview truoc khi chay. */
  peekQueue(): M16PendingTurn[] {
    return this.queue.map((t) => ({ ...t }));
  }

  enqueue(turn: M16TurnInput): void {
    this.queue.push({ ...turn, queuedAt: new Date().toISOString() });
  }

  clearQueue(): M16PendingTurn[] {
    return this.queue.splice(0, this.queue.length);
  }

  /** Dem so lan da thay fact (de test / UI). */
  seenCountFor(subject: string, predicate: string, objectText: string): number {
    return this.seenCounts.get(factKeyM16(subject, predicate, objectText)) ?? 0;
  }

  run(
    store: TemporalGraphStore,
    opts: M16SleepConsolidationOptions = {},
    blockStore?: M16BlockStore,
  ): M16SleepConsolidationReport {
    const now = opts.now ?? new Date();
    const at = now.toISOString();
    const threshold = opts.idleThresholdMs ?? M16_SLEEP_IDLE_THRESHOLD_MS;
    const idleMs = opts.idleMs ?? 0;
    const actor = opts.actor ?? 'sleep-agent-v16';
    if (!opts.force && idleMs < threshold) {
      return {
        ran: false,
        reason: `Chua idle du ${Math.round(threshold / 1000)}s (idle ${Math.round(idleMs / 1000)}s) — bo qua luot sleep nay (${this.queue.length} turn dang cho).`,
        at,
        turnsProcessed: 0,
        extracted: 0,
        added: 0,
        updated: 0,
        deleted: 0,
        ignored: 0,
        sessionPromoted: 0,
        corePromoted: 0,
        actions: [],
      };
    }
    const turns = this.clearQueue();
    const actions: string[] = [];
    const promoteMinConfidence = opts.promoteMinConfidence ?? 0.85;
    const promoteMinRepeats = opts.promoteMinRepeats ?? 2;
    const sessionPromoteRepeats = opts.sessionPromoteRepeats ?? M16_SESSION_PROMOTE_REPEATS;

    const report = consolidateTurnsM16(store, turns, {
      actor,
      ...(opts.ledger ? { ledger: opts.ledger } : {}),
      now,
    });

    // Dem lan xuat hien + session cua tung fact vua fuse.
    // Ca fact trung lap (IGNORE co target) cung tinh la 1 lan "thay
    // lai" — neu khong, fact ben vung khong bao gio du so lan de
    // promote vi lan 2 tro di luon bi fuse chan la trung.
    let sessionPromoted = 0;
    for (const result of report.results) {
      const sighted =
        result.decision === 'add' ||
        result.decision === 'update' ||
        (result.decision === 'ignore' && result.targetId !== undefined);
      if (!sighted) continue;
      const c = result.candidate;
      const key = factKeyM16(c.subject, c.predicate, c.objectText);
      this.seenCounts.set(key, (this.seenCounts.get(key) ?? 0) + 1);
      if (c.scope !== 'session') continue;
      if (result.decision !== 'add' && result.decision !== 'update') continue;
      const sessions = this.seenSessions.get(key) ?? new Set<string>();
      // Session id lay tu turn goc — tim trong report khong co,
      // dung runId cua scope ghi trong fact vua tao.
      const sessionId = result.fact?.scope.sessionId ?? result.fact?.scope.runId ?? '';
      if (sessionId !== '') sessions.add(sessionId);
      this.seenSessions.set(key, sessions);
      if (sessions.size >= sessionPromoteRepeats && result.fact) {
        // Promote: tao ban sao scope user (chi khi chua co).
        const userScope: MemoryScope = {
          userId: result.fact.scope.userId,
          botId: result.fact.scope.botId,
          runId: '',
        };
        // Chi tinh fact user-scope THAT (khong co sessionId): fact
        // session goc van hien trong query khong loc session, nen
        // phai loai truoc khi ket luan "da co ban user".
        const alreadyUser = store
          .listFacts({ ...userScope, status: 'active', predicate: c.predicate, limit: 500 })
          .some(
            (f) =>
              (f.scope.sessionId ?? '') === '' &&
              normalizeGraphText(f.objectText ?? '') === normalizeGraphText(c.objectText),
          );
        if (!alreadyUser) {
          store.addFact({
            subjectName: c.subject,
            predicate: c.predicate,
            objectText: c.objectText,
            confidence: c.confidence,
            scope: userScope,
            provenance: {
              episodeId: '',
              turnId: '',
              runId: '',
              botId: userScope.botId,
              userId: userScope.userId,
              at,
              sourceText: `promoted from session scope (seen in ${sessions.size} sessions): ${c.sourceText}`,
            },
            validFrom: at,
          });
          sessionPromoted += 1;
          actions.push(
            `Promote session -> user: "${c.subject} ${c.predicate} ${c.objectText}" (xuat hien o ${sessions.size} session).`,
          );
        }
      }
    }

    // (b) Promote fact ben vung vao core block. Ung vien la tat ca
    // fact "da thay" trong luot nay (ADD/UPDATE + IGNORE trung lap —
    // lan thay lai moi la bang chung ben vung), dedupe theo key.
    let corePromoted = 0;
    if (blockStore) {
      const seenThisRun = new Map<string, (typeof report.results)[number]>();
      for (const r of report.results) {
        const sighted =
          r.decision === 'add' ||
          r.decision === 'update' ||
          (r.decision === 'ignore' && r.targetId !== undefined);
        if (!sighted) continue;
        const key = factKeyM16(r.candidate.subject, r.candidate.predicate, r.candidate.objectText);
        if (!seenThisRun.has(key)) seenThisRun.set(key, r);
      }
      const durable = [...seenThisRun.values()].filter(
        (r) =>
          r.candidate.confidence >= promoteMinConfidence &&
          (this.seenCounts.get(factKeyM16(r.candidate.subject, r.candidate.predicate, r.candidate.objectText)) ?? 0) >=
            promoteMinRepeats,
      );
      for (const r of durable) {
        const c = r.candidate;
        const targetLabel = c.subject === 'agent' ? 'persona' : 'human';
        const target = blockStore.get(targetLabel);
        if (!target) continue;
        if (target.pinned) {
          actions.push(`Bo qua promote vao block "${targetLabel}" (dang PIN).`);
          continue;
        }
        const line = `- ${c.subject} ${c.predicate}: ${c.objectText} (tin cay ${c.confidence.toFixed(2)})`;
        if (target.content.includes(line)) continue;
        try {
          blockStore.append(targetLabel, line, actor, 'sleep-time promote: fact ben vung');
          corePromoted += 1;
          actions.push(`Promote vao block "${targetLabel}": ${line}`);
        } catch (err) {
          actions.push(
            `Khong promote duoc vao block "${targetLabel}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    return {
      ran: true,
      reason:
        `Sleep consolidation v16 chay luc idle (${Math.round(idleMs / 1000)}s): ` +
        `${turns.length} turn, ${report.extracted} fact trich, ${report.added} add / ${report.updated} update / ` +
        `${report.deleted} delete / ${report.ignored} ignore, ${sessionPromoted} session-promote, ${corePromoted} core-promote.`,
      at,
      turnsProcessed: turns.length,
      extracted: report.extracted,
      added: report.added,
      updated: report.updated,
      deleted: report.deleted,
      ignored: report.ignored,
      sessionPromoted,
      corePromoted,
      actions,
    };
  }
}

export function factKeyM16(subject: string, predicate: string, objectText: string): string {
  return [
    normalizeGraphText(subject),
    normalizeGraphText(predicate).replace(/\s+/g, '_'),
    normalizeGraphText(objectText),
  ].join('|');
}

/**
 * Ham tien ich 1-lan: tao consolidator, enqueue turn, chay ngay
 * (force) — dung cho tool + test.
 */
export function runSleepConsolidationM16(
  store: TemporalGraphStore,
  turns: M16TurnInput[],
  opts: M16SleepConsolidationOptions = {},
  blockStore?: M16BlockStore,
): M16SleepConsolidationReport {
  const agent = new M16SleepConsolidator();
  for (const t of turns) agent.enqueue(t);
  return agent.run(store, { ...opts, force: true }, blockStore);
}

// ---------------------------------------------------------------------------
// Consolidation preview (dry-run) — xem truoc khi ghi
// ---------------------------------------------------------------------------

export interface M16FusePreviewItem {
  candidate: M16ExtractedFact;
  decision: M16FuseDecision;
  reason: string;
  targetId?: string;
}

export interface M16ConsolidationPreview {
  turns: number;
  extracted: number;
  plans: M16FusePreviewItem[];
  counts: { add: number; update: number; delete: number; ignore: number };
}

/**
 * Preview consolidation (dry-run): extract + lap ke hoach fuse cho
 * tung turn NHUNG KHONG GHI gi vao store. Agent/UI dung de xem truoc
 * (va de user duyet) truoc khi chay consolidate that.
 */
export function previewConsolidationM16(
  store: TemporalGraphStore,
  turns: M16TurnInput[],
  opts: { minConfidence?: number } = {},
): M16ConsolidationPreview {
  const plans: M16FusePreviewItem[] = [];
  const counts = { add: 0, update: 0, delete: 0, ignore: 0 };
  let extracted = 0;
  for (const turn of turns) {
    const baseScope: MemoryScope = {
      userId: turn.userId ?? '',
      botId: turn.botId ?? '',
      runId: turn.runId ?? '',
      ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
    };
    const candidates = extractFactsM16Sync(turn.text, {
      scope: turn.scope ?? 'user',
      sourceTrust: turn.sourceTrust ?? 1,
      subject: turn.subject ?? 'user',
    });
    extracted += candidates.length;
    for (const candidate of candidates) {
      const scope = scopeForCandidateM16(candidate, baseScope);
      const subjectEntity = store.findEntityByName(candidate.subject);
      const allActive = store.listFacts({ ...scope, status: 'active', limit: 500 });
      const existing = subjectEntity
        ? allActive.filter((f) => f.subjectId === subjectEntity.id)
        : [];
      const plan = planFuseM16(existing, candidate, { minConfidence: opts.minConfidence });
      counts[plan.decision] += 1;
      plans.push({
        candidate,
        decision: plan.decision,
        reason: plan.reason,
        ...(plan.target ? { targetId: plan.target.id } : {}),
      });
    }
  }
  return { turns: turns.length, extracted, plans, counts };
}
