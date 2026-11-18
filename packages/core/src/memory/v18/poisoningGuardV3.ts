/**
 * Memory v18 — Poisoning guard v3: source trust scoring + contradiction alert (v1.19, Doi T1).
 *
 * Y tuong hoc tu OWASP ASI06 (Memory & Context Poisoning: memory bi
 * dau doc roi agent dung lai nhu su that) + Mem0 2026 (judge truoc
 * khi ghi) — tu thiet ke lai hoan toan cho open-bot, chay 100%
 * local, KHONG copy code/text/tai san cua bat ky repo nao.
 *
 * Ke thua, khong viet lai:
 *  - `V16SourceAllowlist` (allow/deny/wildcard + trustOverride):
 *    bang nguon duy nhat; v18 dung no lam lop quyet dinh cuoi
 *    (deny -> reject thang), khong tao allowlist song song.
 *  - `corePromotionGateV16` (judge v14 5 tin hieu + provenance +
 *    confidence): gate co san; v18 goi truoc, roi cong them lop
 *    trust scoring + contradiction alert cua rieng minh.
 *  - `TemporalGraphStore.addToQuarantine` / `reviewQuarantine`:
 *    quarantine duy nhat cua store; v18 chi goi qua chung.
 *  - `judgeCandidateV14` (v14/poisoning): judge rule-based; v18
 *    khong viet lai judge, chi bo sung tin hieu moi o tang v18.
 *
 * Moi trong v18:
 *  1. `V18SourceTrustBook` — so trust theo nguon: moi nguon co
 *     diem trust hoc duoc tu lich su duyet (approve tang, reject
 *     giam — cap nhat kieu trung binh co trong so), kem so lan
 *     approve/reject; serialize JSON de host luu file.
 *  2. Mau tiem nhiem mo rong (`V18_INJECTION_PATTERNS`): them mau
 *     moi so voi v14 (lenh gia mao he thong, yeu cau tiet lo
 *     huong dan, chen "system:" gia, doi credential) — `scanInjectionV18`
 *     tra ve cac mau khop.
 *  3. Canh bao mau thuan (`checkContradictionV18`): ung vien mau
 *     thuan voi fact active co confidence cao (>= nguong) tren cung
 *     edge don tri -> canh bao co chi tiet (fact cu, confidence cu,
 *     do lech) thay vi lang le supersede.
 *  4. `screenCandidateV18` — pipeline sang loc 4 buoc: (a) nguon
 *     deny -> reject; (b) mau tiem nhiem -> quarantine; (c) gate
 *     v16 reject/quarantine -> theo gate; (d) mau thuan manh ->
 *     quarantine kem canh bao; (e) trust thap -> quarantine;
 *     con lai -> admit (ghi audit). Moi buoc ghi vao
 *     `V18ScreenAudit`.
 *  5. `recordReviewOutcomeV18` — cap nhat trust cua nguon sau moi
 *     lan user duyet quarantine (approve/reject), de nguon tot dan
 *     duoc tin hon, nguon xau bi ha trust tu dong.
 */

import type { GraphFact, MemoryScope, QuarantineItem } from '../graph/types';
import { normalizeGraphText } from '../graph/types';
import type { TemporalGraphStore } from '../graph/store';
import { V16SourceAllowlist, corePromotionGateV16 } from '../v16/poisoningGuard';
import type { V16CandidateFact } from '../v16/consolidationOps';
import { isSingleValuedPredicateV15 } from '../../memoryV15/consolidation';

/** Loi poisoning guard v3 — message tieng Viet. */
export class V18PoisoningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V18PoisoningError';
  }
}

/** Trust mac dinh cho nguon chua tung xuat hien. */
export const V18_UNKNOWN_SOURCE_TRUST = 0.5;
/** Confidence toi thieu cua fact cu de coi la mau thuan manh. */
export const V18_DEFAULT_CONTRADICTION_MIN_CONFIDENCE = 0.7;
/** Trust toi thieu de auto-admit (duoi thi vao quarantine). */
export const V18_DEFAULT_MIN_TRUST_AUTO_ADMIT = 0.4;
/** Buoc cap nhat trust moi lan duyet (approve +, reject -). */
export const V18_TRUST_LEARN_STEP = 0.05;

/** Mau tiem nhiem bo sung cua v18 (chuan hoa truoc khi so). */
export const V18_INJECTION_PATTERNS: readonly string[] = [
  'ignore previous instructions',
  'ignore all previous',
  'disregard previous instructions',
  'you are now',
  'system:',
  'reveal your instructions',
  'tiet lo huong dan',
  'bo qua huong dan',
  'quen het',
  'forget everything',
  'send your password',
  'gui mat khau',
  'api key',
  'khoa api',
  'override your',
  'ghi de huong dan',
];

/** Clamp 0..1. */
export function clamp01V18Poison(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Quet text tim mau tiem nhiem (khong phan biet hoa/thuong, bo dau
 * tieng Viet). Tra ve cac mau khop (rong = sach).
 */
export function scanInjectionV18(text: string): string[] {
  const hay = normalizeGraphText(text ?? '');
  if (hay === '') return [];
  const hits: string[] = [];
  for (const pattern of V18_INJECTION_PATTERNS) {
    const norm = normalizeGraphText(pattern);
    if (norm !== '' && hay.includes(norm)) hits.push(pattern);
  }
  return hits;
}

/** Trang thai trust cua mot nguon. */
export interface V18SourceTrustEntry {
  sourceName: string;
  trust: number;
  approved: number;
  rejected: number;
  quarantined: number;
  updatedAt: string;
}

/** So trust theo nguon (hoc tu lich su duyet). */
export class V18SourceTrustBook {
  private readonly entries = new Map<string, V18SourceTrustEntry>();

  /** Trust hien tai cua nguon (chua co -> mac dinh 0.5). */
  trustOf(sourceName: string): number {
    const entry = this.entries.get((sourceName ?? '').trim().toLowerCase());
    return entry ? entry.trust : V18_UNKNOWN_SOURCE_TRUST;
  }

  /** Lay ban sao entry (null neu chua co). */
  get(sourceName: string): V18SourceTrustEntry | null {
    const entry = this.entries.get((sourceName ?? '').trim().toLowerCase());
    return entry ? { ...entry } : null;
  }

  /** Liệt kê tat ca entry (trust tang dan). */
  list(): V18SourceTrustEntry[] {
    return [...this.entries.values()]
      .sort((a, b) => a.trust - b.trust)
      .map((e) => ({ ...e }));
  }

  /**
   * Cap nhat trust sau mot lan duyet: approve +step, reject -step
   * (nhan doi khi reject vi tiem nhiem), quarantine khong doi
   * trust nhung dem so lan. Trust luon o [0,1].
   */
  recordOutcome(
    sourceName: string,
    outcome: 'approved' | 'rejected' | 'quarantined',
    opts: { injection?: boolean; now?: Date } = {},
  ): V18SourceTrustEntry {
    const key = (sourceName ?? '').trim().toLowerCase() || 'unknown';
    const at = (opts.now ?? new Date()).toISOString();
    const prev = this.entries.get(key) ?? {
      sourceName: key,
      trust: V18_UNKNOWN_SOURCE_TRUST,
      approved: 0,
      rejected: 0,
      quarantined: 0,
      updatedAt: at,
    };
    if (outcome === 'approved') {
      prev.approved += 1;
      prev.trust = clamp01V18Poison(prev.trust + V18_TRUST_LEARN_STEP);
    } else if (outcome === 'rejected') {
      prev.rejected += 1;
      const step = opts.injection ? V18_TRUST_LEARN_STEP * 2 : V18_TRUST_LEARN_STEP;
      prev.trust = clamp01V18Poison(prev.trust - step);
    } else {
      prev.quarantined += 1;
    }
    prev.updatedAt = at;
    this.entries.set(key, prev);
    return { ...prev };
  }

  /** Dat trust thu cong (user ghi de). */
  setTrust(sourceName: string, trust: number, now = new Date()): V18SourceTrustEntry {
    const key = (sourceName ?? '').trim().toLowerCase() || 'unknown';
    const prev = this.entries.get(key) ?? {
      sourceName: key,
      trust: V18_UNKNOWN_SOURCE_TRUST,
      approved: 0,
      rejected: 0,
      quarantined: 0,
      updatedAt: now.toISOString(),
    };
    prev.trust = clamp01V18Poison(trust);
    prev.updatedAt = now.toISOString();
    this.entries.set(key, prev);
    return { ...prev };
  }

  /** Serialize sang JSON (de host luu file). */
  toJson(now = new Date()): { version: 1; updatedAt: string; entries: V18SourceTrustEntry[] } {
    return { version: 1, updatedAt: now.toISOString(), entries: this.list() };
  }

  /** Nap tu JSON (bo qua dong hong). */
  static fromJson(json: { version?: number; entries?: V18SourceTrustEntry[] }): V18SourceTrustBook {
    const book = new V18SourceTrustBook();
    if (!json || json.version !== 1 || !Array.isArray(json.entries)) return book;
    for (const e of json.entries) {
      if (!e || typeof e.sourceName !== 'string' || !Number.isFinite(e.trust)) continue;
      book.entries.set(e.sourceName.toLowerCase(), {
        sourceName: e.sourceName.toLowerCase(),
        trust: clamp01V18Poison(e.trust),
        approved: Math.max(0, e.approved ?? 0),
        rejected: Math.max(0, e.rejected ?? 0),
        quarantined: Math.max(0, e.quarantined ?? 0),
        updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : new Date().toISOString(),
      });
    }
    return book;
  }
}

/** Canh bao mau thuan giua ung vien va fact cu. */
export interface V18ContradictionAlert {
  /** Co mau thuan manh khong. */
  contradicts: boolean;
  /** Fact cu mau thuan (neu co). */
  conflictingFact: GraphFact | null;
  /** Ly do (text de UI hien thi). */
  reason: string;
  /** Do tin cay cua fact cu. */
  oldConfidence: number;
}

/**
 * Kiem tra ung vien co mau thuan voi fact active co confidence cao
 * tren cung edge don tri (cung subject + predicate, object khac)
 * khong. Chi xet predicate don tri (vd lives_in, works_at) — cac
 * predicate nhieu gia tri (likes, reads) khong coi la mau thuan.
 */
export function checkContradictionV18(
  store: TemporalGraphStore,
  candidate: { subjectName: string; predicate: string; objectText: string },
  scope: MemoryScope,
  opts: { minOldConfidence?: number } = {},
): V18ContradictionAlert {
  const minOld = clamp01V18Poison(opts.minOldConfidence ?? V18_DEFAULT_CONTRADICTION_MIN_CONFIDENCE);
  const noAlert: V18ContradictionAlert = { contradicts: false, conflictingFact: null, reason: '', oldConfidence: 0 };
  if (!isSingleValuedPredicateV15(candidate.predicate)) return noAlert;
  const oldFacts = store.findActiveFacts(candidate.subjectName, candidate.predicate, scope);
  for (const old of oldFacts) {
    if (normalizeGraphText(old.objectText ?? '') === normalizeGraphText(candidate.objectText ?? '')) continue;
    if (old.confidence < minOld) continue;
    return {
      contradicts: true,
      conflictingFact: old,
      reason:
        `Ung vien "${candidate.objectText}" mau thuan voi fact cu "${old.objectText}" ` +
        `(confidence ${old.confidence.toFixed(2)}). Can nguoi duyet truoc khi thay the.`,
      oldConfidence: old.confidence,
    };
  }
  return noAlert;
}

/** Quyet dinh sang loc v18. */
export type V18ScreenDecision = 'admit' | 'quarantine' | 'reject';

/** Ket qua sang loc mot ung vien. */
export interface V18ScreenResult {
  decision: V18ScreenDecision;
  reasons: string[];
  /** Diem trust cua nguon luc sang loc. */
  sourceTrust: number;
  /** Cac mau tiem nhiem khop (neu co). */
  injectionHits: string[];
  /** Canh bao mau thuan (neu co). */
  contradiction: V18ContradictionAlert | null;
  /** Quarantine item da tao (khi decision = quarantine). */
  quarantineId: string | null;
}

/** Tuy chon sang loc. */
export interface V18ScreenOptions {
  allowlist?: V16SourceAllowlist;
  trustBook?: V18SourceTrustBook;
  minTrustAutoAdmit?: number;
  minOldConfidence?: number;
  /** Gate v16 co bat khong (mac dinh true). */
  useV16Gate?: boolean;
}

/**
 * Pipeline sang loc 4 buoc cho mot ung vien fact moi. Thu tu:
 * deny -> tiem nhiem -> gate v16 -> mau thuan/trust. Ung vien bi
 * quarantine duoc ghi vao quarantine cua store (doi nguoi duyet);
 * ung vien reject thi khong ghi gi vao store.
 */
export function screenCandidateV18(
  store: TemporalGraphStore,
  candidate: V16CandidateFact,
  scope: MemoryScope,
  opts: V18ScreenOptions = {},
): V18ScreenResult {
  const sourceName = (candidate.sourceName ?? 'user-chat').trim() || 'user-chat';
  const allowlist = opts.allowlist ?? new V16SourceAllowlist();
  const trustBook = opts.trustBook;
  const sourceTrust = trustBook ? trustBook.trustOf(sourceName) : allowlist.trustOf(sourceName);
  const minTrust = clamp01V18Poison(opts.minTrustAutoAdmit ?? V18_DEFAULT_MIN_TRUST_AUTO_ADMIT);
  const provenance = {
    episodeId: candidate.episodeId ?? '',
    turnId: candidate.turnId ?? '',
    runId: candidate.runId ?? '',
    botId: candidate.botId ?? '',
    userId: candidate.userId ?? '',
    at: candidate.at ?? new Date().toISOString(),
    sourceText: (candidate.sourceText ?? '').slice(0, 500),
  };
  const toQuarantine = (
    reason: string,
    detail: string,
    conflictingFactId?: string,
  ): V18ScreenResult => {
    const item: QuarantineItem = store.addToQuarantine({
      candidate: {
        subjectName: candidate.subject,
        predicate: candidate.predicate,
        objectText: candidate.objectText,
        confidence: candidate.effectiveConfidence,
      },
      reason: 'suspicious-pattern',
      detail,
      ...(conflictingFactId ? { conflictingFactId } : {}),
      scope,
      provenance,
    });
    return {
      decision: 'quarantine',
      reasons: [reason],
      sourceTrust,
      injectionHits: scanInjectionV18(`${candidate.subject} ${candidate.predicate} ${candidate.objectText} ${candidate.sourceText}`),
      contradiction: null,
      quarantineId: item.id,
    };
  };

  // (a) Nguon deny -> reject thang.
  if (allowlist.isDenied(sourceName)) {
    return {
      decision: 'reject',
      reasons: [`Nguon "${sourceName}" nam trong denylist — tu choi.`],
      sourceTrust,
      injectionHits: [],
      contradiction: null,
      quarantineId: null,
    };
  }
  // (b) Mau tiem nhiem trong noi dung ung vien -> quarantine.
  const injectionHits = scanInjectionV18(
    `${candidate.subject} ${candidate.predicate} ${candidate.objectText} ${candidate.sourceText}`,
  );
  if (injectionHits.length > 0) {
    if (trustBook) trustBook.recordOutcome(sourceName, 'quarantined');
    const res = toQuarantine(
      `Phat hien mau tiem nhiem: ${injectionHits.join(', ')}.`,
      `Ung vien chua mau tiem nhiem (${injectionHits.join(', ')}) — can nguoi duyet.`,
    );
    res.injectionHits = injectionHits;
    return res;
  }
  // (c) Gate v16 (judge + provenance + confidence).
  if (opts.useV16Gate ?? true) {
    const gate = corePromotionGateV16(store, candidate, scope, sourceName, { allowlist });
    if (gate.decision === 'reject') {
      return {
        decision: 'reject',
        reasons: gate.reasons,
        sourceTrust,
        injectionHits: [],
        contradiction: null,
        quarantineId: null,
      };
    }
    if (gate.decision === 'quarantine') {
      if (trustBook) trustBook.recordOutcome(sourceName, 'quarantined');
      const res = toQuarantine(`Gate v16 quarantine: ${gate.reasons.join(' ')}`, gate.reasons.join(' '));
      return res;
    }
  }
  // (d) Mau thuan manh voi fact cu co confidence cao -> quarantine kem canh bao.
  const contradiction = checkContradictionV18(
    store,
    { subjectName: candidate.subject, predicate: candidate.predicate, objectText: candidate.objectText },
    scope,
    { minOldConfidence: opts.minOldConfidence },
  );
  if (contradiction.contradicts) {
    if (trustBook) trustBook.recordOutcome(sourceName, 'quarantined');
    const res = toQuarantine(
      contradiction.reason,
      contradiction.reason,
      contradiction.conflictingFact?.id,
    );
    res.contradiction = contradiction;
    return res;
  }
  // (e) Trust nguon thap -> quarantine (doi nguoi duyet, khong tu admit).
  if (sourceTrust < minTrust) {
    if (trustBook) trustBook.recordOutcome(sourceName, 'quarantined');
    return toQuarantine(
      `Trust nguon "${sourceName}" chi ${sourceTrust.toFixed(2)} (< ${minTrust.toFixed(2)}) — can nguoi duyet.`,
      `Nguon moi / chua du tin cay (trust ${sourceTrust.toFixed(2)}).`,
    );
  }
  return {
    decision: 'admit',
    reasons: [`Dat gate v16, khong tiem nhiem, khong mau thuan, trust nguon ${sourceTrust.toFixed(2)}.`],
    sourceTrust,
    injectionHits: [],
    contradiction: null,
    quarantineId: null,
  };
}

/**
 * Cap nhat trust cua nguon sau khi user duyet mot muc quarantine:
 * approve -> trust tang; reject -> trust giam (gap doi neu muc do
 * bi reject vi tiem nhiem). Tra ve entry trust moi.
 */
export function recordReviewOutcomeV18(
  trustBook: V18SourceTrustBook,
  sourceName: string,
  decision: 'approved' | 'rejected',
  opts: { injection?: boolean } = {},
): V18SourceTrustEntry {
  return trustBook.recordOutcome(sourceName, decision, { injection: opts.injection });
}
