/**
 * Memory v16 — Memory poisoning guard v2 (v1.17, Doi T1).
 *
 * Y tuong hoc tu OWASP ASI06 (Memory & Context Poisoning: ke tan
 * cong chen fact doc hai vao bo nho qua hoi thoai/tai lieu de agent
 * hanh dong sai o phien sau) — tu thiet ke lai hoan toan cho
 * open-bot, chay 100% local, KHONG copy code/text/tai san cua bat ky
 * repo nao.
 *
 * Ke thua, khong viet lai:
 *  - `judgeCandidateV14` / `v14JudgeGate` / `quarantineCandidateV14`
 *    / `reviewQuarantineV14` / `quarantineStatsV14` cua memory/v14:
 *    judge rule-based 5 tin hieu + quarantine duy nhat cua store;
 *    v16 GOI LAI nguyen ven, chi them lop allowlist + provenance
 *    verification + core-block gate ben tren.
 *  - `V14_DEFAULT_SOURCE_TRUSTS`: do tin cay mac dinh theo loai
 *    nguon; v16 dung lam co so khi allowlist chua ghi de.
 *
 * Moi trong v16:
 *  - `V16SourceAllowlist` — registry nguon: moi nguon co trang thai
 *    allow / deny / review (mac dinh review = phai qua judge), trust
 *    ghi de, ly do, nguoi cap nhat. Nguon bi deny thi ung vien bi
 *    reject thang, khong can judge; nguon allow + trust cao thi duoc
 *    bo qua buoc quarantine nhanh (van bi judge bat neu khop mau
 *    nghi ngo). Ho tro mau wildcard (`import-*`, `web-*`).
 *  - `verifyProvenanceV16` — xac minh provenance cua mot fact truoc
 *    khi tin no: episode goc phai ton tai trong store, scope cua
 *    fact phai khop scope episode, sourceText khong rong, thoi gian
 *    ghi khong o tuong lai qua xa, chuoi provenance phai day du
 *    (episodeId/turnId/runId/botId/userId). Tra ve danh sach loi cu
 *    the thay vi boolean don.
 *  - `V16CorePromotionGate` — gate truoc khi dua fact vao core
 *    block: fact phai (a) vuot judge v14, (b) provenance hop le,
 *    (c) nguon nam trong allowlist (khong deny), (d) confidence
 *    hieu dung >= nguong, (e) khong phai fact tam thoi (validUntil
 *    gan). Gate tra ve quyet dinh + ly do de UI hien thi.
 *  - Quarantine review v2: `reviewQuarantineBatchV16` (duyet hang
 *    loat, moi muc ghi audit rieng), `expireStaleQuarantineV16`
 *    (muc pending qua han -> tu dong reject co ghi ly do, tranh
 *    dong ton), `quarantineAgingReportV16` (bao cao muc sap het han),
 *    `reopenQuarantineV16` (mo lai muc da reject de xem xet lai —
 *    chi doi status ve pending, khong tu tao fact).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { GraphFact, MemoryScope, QuarantineItem } from '../graph/types';
import type { TemporalGraphStore } from '../graph/store';
import {
  judgeCandidateV14,
  quarantineCandidateV14,
  reviewQuarantineV14,
  V14_DEFAULT_SOURCE_TRUSTS,
} from '../v14/poisoning';
import type { V14JudgeThresholds, V14JudgeVerdict } from '../v14/poisoning';
import type { V14ExtractedFact } from '../v14/extraction';
import { clamp01V16 } from './consolidationOps';
import type { V16CandidateFact } from './consolidationOps';

/** Loi poisoning guard v16 — message tieng Viet. */
export class V16PoisoningGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V16PoisoningGuardError';
  }
}

/** Trang thai cua mot nguon trong allowlist. */
export type V16SourceStatus = 'allow' | 'deny' | 'review';

/** Mot muc trong registry nguon. */
export interface V16SourceEntry {
  /** Ten nguon hoac mau wildcard (vd 'user-chat', 'web-*'). */
  pattern: string;
  status: V16SourceStatus;
  /** Trust ghi de (0..1); null = dung mac dinh cua v14. */
  trustOverride: number | null;
  /** Ly do cap nhat (de audit). */
  reason: string;
  updatedBy: string;
  updatedAt: string;
}

/** JSON serialize cua allowlist (de luu file). */
export interface V16SourceAllowlistJson {
  version: 1;
  entries: V16SourceEntry[];
  updatedAt: string;
}

/** Do tin cay mac dinh cua v16 khi nguon khong co trong bang v14. */
export const V16_UNKNOWN_SOURCE_TRUST = 0.5;
/** So ngay toi da mot muc quarantine duoc pending truoc khi het han. */
export const V16_DEFAULT_QUARANTINE_TTL_DAYS = 30;

/**
 * Registry nguon (allowlist/denylist). Quy tac khop: khop chinh xac
 * truoc, roi wildcard `prefix-*`, roi mac dinh: nguon la trong
 * `V14_DEFAULT_SOURCE_TRUSTS` thi `review`, nguon la thi `review`
 * voi trust 0.5. Nguon `deny` luon thang `allow` khi ca hai mau deu
 * khop (an toan mac dinh).
 */
export class V16SourceAllowlist {
  private readonly entries: V16SourceEntry[] = [];

  constructor(entries: V16SourceEntry[] = []) {
    for (const e of entries) this.upsert(e.pattern, e.status, e.trustOverride, e.reason, e.updatedBy);
  }

  /** So muc trong registry. */
  get size(): number {
    return this.entries.length;
  }

  /** Them/cap nhat mot muc (pattern chuan hoa chu thuong). */
  upsert(
    pattern: string,
    status: V16SourceStatus,
    trustOverride: number | null = null,
    reason = '',
    updatedBy = 'system',
    now = new Date(),
  ): V16SourceEntry {
    const clean = (pattern ?? '').trim().toLowerCase();
    if (clean === '') {
      throw new V16PoisoningGuardError('Pattern nguon khong duoc rong.');
    }
    if (trustOverride !== null) {
      if (!Number.isFinite(trustOverride) || trustOverride < 0 || trustOverride > 1) {
        throw new V16PoisoningGuardError('Trust ghi de phai trong [0, 1].');
      }
    }
    const at = now.toISOString();
    const existing = this.entries.find((e) => e.pattern === clean);
    if (existing) {
      existing.status = status;
      existing.trustOverride = trustOverride;
      existing.reason = reason;
      existing.updatedBy = updatedBy;
      existing.updatedAt = at;
      return { ...existing };
    }
    const entry: V16SourceEntry = {
      pattern: clean,
      status,
      trustOverride,
      reason,
      updatedBy,
      updatedAt: at,
    };
    this.entries.push(entry);
    return { ...entry };
  }

  /** Xoa mot muc (tra ve true neu co xoa). */
  remove(pattern: string): boolean {
    const clean = (pattern ?? '').trim().toLowerCase();
    const idx = this.entries.findIndex((e) => e.pattern === clean);
    if (idx < 0) return false;
    this.entries.splice(idx, 1);
    return true;
  }

  /** Liệt kê toàn bộ mục (bản sao). */
  list(): V16SourceEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  private matches(pattern: string, sourceName: string): boolean {
    if (pattern.endsWith('*')) {
      return sourceName.startsWith(pattern.slice(0, -1));
    }
    return pattern === sourceName;
  }

  /** Tim muc khop nhat cho mot ten nguon (deny uu tien hon allow). */
  findEntry(sourceName: string): V16SourceEntry | undefined {
    const name = (sourceName ?? '').trim().toLowerCase() || 'unknown';
    const matched = this.entries.filter((e) => this.matches(e.pattern, name));
    if (matched.length === 0) return undefined;
    const denied = matched.find((e) => e.status === 'deny');
    if (denied) return { ...denied };
    const exact = matched.find((e) => e.pattern === name);
    if (exact) return { ...exact };
    matched.sort((a, b) => b.pattern.length - a.pattern.length);
    return { ...matched[0] };
  }

  /** Trang thai cua mot nguon (mac dinh 'review'). */
  statusOf(sourceName: string): V16SourceStatus {
    return this.findEntry(sourceName)?.status ?? 'review';
  }

  /** true = nguon bi cam hoan toan. */
  isDenied(sourceName: string): boolean {
    return this.statusOf(sourceName) === 'deny';
  }

  /** true = nguon duoc tin (allow). */
  isAllowed(sourceName: string): boolean {
    return this.statusOf(sourceName) === 'allow';
  }

  /** Trust hieu dung cua mot nguon (ghi de > bang v14 > 0.5). */
  trustOf(sourceName: string): number {
    const name = (sourceName ?? '').trim().toLowerCase() || 'unknown';
    const entry = this.findEntry(name);
    if (entry?.trustOverride !== null && entry?.trustOverride !== undefined) {
      return clamp01V16(entry.trustOverride);
    }
    if (name in V14_DEFAULT_SOURCE_TRUSTS) return V14_DEFAULT_SOURCE_TRUSTS[name];
    return V16_UNKNOWN_SOURCE_TRUST;
  }

  /** Serialize sang JSON (de host luu file). */
  toJson(now = new Date()): V16SourceAllowlistJson {
    return { version: 1, entries: this.list(), updatedAt: now.toISOString() };
  }

  /** Nap tu JSON (bo qua muc hong). */
  static fromJson(json: V16SourceAllowlistJson): V16SourceAllowlist {
    const list = new V16SourceAllowlist();
    if (!json || json.version !== 1 || !Array.isArray(json.entries)) return list;
    for (const e of json.entries) {
      if (!e || typeof e.pattern !== 'string') continue;
      try {
        list.upsert(e.pattern, e.status, e.trustOverride ?? null, e.reason ?? '', e.updatedBy ?? 'system');
      } catch {
        // Bo muc hong.
      }
    }
    return list;
  }
}

/** Ket qua xac minh provenance cua mot fact. */
export interface V16ProvenanceCheck {
  /** true = provenance hop le. */
  ok: boolean;
  /** Cac loi tim thay (rong khi ok). */
  errors: string[];
  /** Episode goc (neu tim thay). */
  episodeId: string | null;
  /** true = episode goc ton tai trong store. */
  episodeExists: boolean;
}

/**
 * Xac minh provenance cua mot fact truoc khi tin no:
 * episode goc phai ton tai; scope fact phai khop scope episode
 * (user/bot/run — tru khi mot ben rong, tuc legacy); sourceText
 * khong rong; thoi gian ghi khong o tuong lai qua 1 ngay (dong ho
 * lech); cac truong bat buoc phai co. Fact "mo coi" (khong tro ve
 * episode nao) KHONG bao gio duoc dua vao core block.
 */
export function verifyProvenanceV16(
  store: TemporalGraphStore,
  fact: GraphFact,
  opts: { now?: Date; maxFutureSkewMs?: number } = {},
): V16ProvenanceCheck {
  const errors: string[] = [];
  const now = opts.now ?? new Date();
  const maxSkew = opts.maxFutureSkewMs ?? 24 * 60 * 60 * 1000;
  const provenance = fact.provenance;
  const episodeId = provenance?.episodeId ?? '';
  let episodeExists = false;
  if (!provenance) {
    errors.push('Fact khong co provenance.');
    return { ok: false, errors, episodeId: null, episodeExists: false };
  }
  if (episodeId === '') {
    errors.push('Provenance thieu episodeId.');
  } else {
    const episode = store.getEpisode(episodeId);
    episodeExists = episode !== undefined && episode !== null;
    if (!episode) {
      errors.push(`Episode goc "${episodeId}" khong ton tai trong store.`);
    } else {
      const mismatch: string[] = [];
      if (episode.userId !== '' && fact.scope.userId !== '' && episode.userId !== fact.scope.userId) {
        mismatch.push('userId');
      }
      if (episode.botId !== '' && fact.scope.botId !== '' && episode.botId !== fact.scope.botId) {
        mismatch.push('botId');
      }
      if (episode.runId !== '' && fact.scope.runId !== '' && episode.runId !== fact.scope.runId) {
        mismatch.push('runId');
      }
      if (mismatch.length > 0) {
        errors.push(`Scope fact khong khop episode goc (${mismatch.join(', ')}).`);
      }
    }
  }
  if ((provenance.sourceText ?? '').trim() === '') {
    errors.push('Provenance thieu sourceText (cau goc).');
  }
  for (const field of ['turnId', 'runId', 'botId', 'userId'] as const) {
    if ((provenance[field] ?? '').trim() === '') {
      errors.push(`Provenance thieu ${field}.`);
    }
  }
  const atMs = Date.parse(provenance.at ?? '');
  if (Number.isNaN(atMs)) {
    errors.push('Provenance co thoi gian ghi khong hop le.');
  } else if (atMs - now.getTime() > maxSkew) {
    errors.push('Thoi gian ghi provenance o tuong lai qua xa (dong ho lech hoac gia mao).');
  }
  return { ok: errors.length === 0, errors, episodeId: episodeId || null, episodeExists };
}

/** Quyet dinh cua core-block gate. */
export type V16GateDecision = 'allow' | 'quarantine' | 'reject';

/** Ket qua gate truoc khi dua fact vao core block. */
export interface V16CoreGateResult {
  decision: V16GateDecision;
  /** Ly do bang tieng Viet (de UI hien thi). */
  reasons: string[];
  /** Verdict cua judge v14 (neu da chay). */
  judgeVerdict: V14JudgeVerdict | null;
  /** Ket qua xac minh provenance. */
  provenanceCheck: V16ProvenanceCheck | null;
  /** Trust hieu dung cua nguon. */
  sourceTrust: number;
}

/** Tuy chon core-block gate. */
export interface V16CoreGateOptions {
  /** Allowlist nguon (mac dinh: registry rong — chi dung bang v14). */
  allowlist?: V16SourceAllowlist;
  /** Nguong judge v14 (mac dinh cua v14). */
  judgeThresholds?: V14JudgeThresholds;
  /** Confidence hieu dung toi thieu de vao core (mac dinh 0.6). */
  minCoreConfidence?: number;
  /** Fact co validUntil trong N ngay toi thi coi la tam thoi (mac dinh 7). */
  temporaryWithinDays?: number;
  /** Thoi diem danh gia (mac dinh: bay gio). */
  now?: Date;
}

/** Chuyen ung vien v15 sang dang v14 de chay judge. */
export function toV14CandidateV16(candidate: V16CandidateFact): V14ExtractedFact {
  return {
    subject: candidate.subject,
    predicate: candidate.predicate,
    objectText: candidate.objectText,
    confidence: candidate.confidence,
    effectiveConfidence: candidate.effectiveConfidence,
    sourceTrust: candidate.sourceTrust,
    sourceText: candidate.sourceText,
    pattern: candidate.pattern,
    origin: candidate.origin,
    intent: candidate.intent,
    ...(candidate.validFrom ? { validFrom: candidate.validFrom } : {}),
    ...(candidate.validUntil !== undefined ? { validUntil: candidate.validUntil } : {}),
  };
}

/**
 * Gate truoc khi dua mot ung vien fact vao core block (persona /
 * human — luon nam trong context). Thu tu kiem tra: nguon bi deny
 * -> reject ngay; judge v14 reject -> reject; judge quarantine ->
 * quarantine; provenance khong hop le -> quarantine (can nguoi xem
 * lai, vi co the la fact cu thieu episode); confidence thap / fact
 * tam thoi -> quarantine (khong du manh de vao core, van giu o
 * archival). Chi `allow` moi duoc promote.
 */
export function corePromotionGateV16(
  store: TemporalGraphStore,
  candidate: V16CandidateFact,
  scope: MemoryScope,
  sourceName: string,
  opts: V16CoreGateOptions = {},
): V16CoreGateResult {
  const reasons: string[] = [];
  const allowlist = opts.allowlist ?? new V16SourceAllowlist();
  const sourceTrust = allowlist.trustOf(sourceName);
  const minCoreConfidence = opts.minCoreConfidence ?? 0.6;
  const temporaryWithinDays = opts.temporaryWithinDays ?? 7;
  const now = opts.now ?? new Date();

  if (allowlist.isDenied(sourceName)) {
    return {
      decision: 'reject',
      reasons: [`Nguon "${sourceName}" nam trong denylist — tu choi.`,],
      judgeVerdict: null,
      provenanceCheck: null,
      sourceTrust,
    };
  }

  const v14Candidate = toV14CandidateV16({ ...candidate, sourceTrust });
  const verdict = judgeCandidateV14(store, v14Candidate, scope, {
    ...(opts.judgeThresholds ? { thresholds: opts.judgeThresholds } : {}),
  });
  if (verdict.decision === 'reject') {
    return {
      decision: 'reject',
      reasons: [`Judge v14 reject (risk ${verdict.risk.toFixed(2)}): ${verdict.reasons.join(' ')}`],
      judgeVerdict: verdict,
      provenanceCheck: null,
      sourceTrust,
    };
  }
  if (verdict.decision === 'quarantine') {
    return {
      decision: 'quarantine',
      reasons: [`Judge v14 quarantine (risk ${verdict.risk.toFixed(2)}): ${verdict.reasons.join(' ')}`],
      judgeVerdict: verdict,
      provenanceCheck: null,
      sourceTrust,
    };
  }

  const effective = clamp01V16(candidate.effectiveConfidence);
  if (effective < minCoreConfidence) {
    return {
      decision: 'quarantine',
      reasons: [
        `Confidence hieu dung ${effective.toFixed(2)} duoi nguong core ${minCoreConfidence.toFixed(2)} — chi giu o archival.`,
      ],
      judgeVerdict: verdict,
      provenanceCheck: null,
      sourceTrust,
    };
  }

  if (candidate.validUntil) {
    const untilMs = Date.parse(candidate.validUntil);
    if (!Number.isNaN(untilMs) && untilMs - now.getTime() < temporaryWithinDays * 24 * 60 * 60 * 1000) {
      return {
        decision: 'quarantine',
        reasons: ['Fact tam thoi (sap het han) — khong dua vao core block.'],
        judgeVerdict: verdict,
        provenanceCheck: null,
        sourceTrust,
      };
    }
  }

  reasons.push('Vuot judge v14, du confidence, khong tam thoi — du dieu kien vao core block.');
  return { decision: 'allow', reasons, judgeVerdict: verdict, provenanceCheck: null, sourceTrust };
}

/**
 * Gate cho fact DA CO trong store (khac ung vien): xac minh
 * provenance that cua fact roi moi cho phep promote. Fact mo coi
 * hoac provenance loi -> quarantine (can nguoi xem lai).
 */
export function corePromotionGateForFactV16(
  store: TemporalGraphStore,
  fact: GraphFact,
  scope: MemoryScope,
  sourceName: string,
  opts: V16CoreGateOptions = {},
): V16CoreGateResult {
  const allowlist = opts.allowlist ?? new V16SourceAllowlist();
  const sourceTrust = allowlist.trustOf(sourceName);
  if (allowlist.isDenied(sourceName)) {
    return {
      decision: 'reject',
      reasons: [`Nguon "${sourceName}" nam trong denylist — tu choi.`],
      judgeVerdict: null,
      provenanceCheck: null,
      sourceTrust,
    };
  }
  const provenanceCheck = verifyProvenanceV16(store, fact, { now: opts.now });
  if (!provenanceCheck.ok) {
    return {
      decision: 'quarantine',
      reasons: [`Provenance khong hop le: ${provenanceCheck.errors.join(' ')}`],
      judgeVerdict: null,
      provenanceCheck,
      sourceTrust,
    };
  }
  void scope;
  const minCoreConfidence = opts.minCoreConfidence ?? 0.6;
  if (fact.confidence < minCoreConfidence) {
    return {
      decision: 'quarantine',
      reasons: [
        `Confidence ${fact.confidence.toFixed(2)} duoi nguong core ${minCoreConfidence.toFixed(2)}.`,
      ],
      judgeVerdict: null,
      provenanceCheck,
      sourceTrust,
    };
  }
  return {
    decision: 'allow',
    reasons: ['Provenance hop le, du confidence — du dieu kien vao core block.'],
    judgeVerdict: null,
    provenanceCheck,
    sourceTrust,
  };
}

/** Dua ung vien bi gate chan vao quarantine (goi lai v14). */
export function quarantineCandidateV16(
  store: TemporalGraphStore,
  candidate: V16CandidateFact,
  scope: MemoryScope,
  verdict: V14JudgeVerdict,
): QuarantineItem {
  return quarantineCandidateV14(store, {
    candidate: toV14CandidateV16(candidate),
    scope,
    provenance: {
      episodeId: candidate.episodeId ?? '',
      turnId: candidate.turnId ?? '',
      runId: candidate.runId ?? scope.runId,
      botId: candidate.botId ?? scope.botId,
      userId: candidate.userId ?? scope.userId,
      at: candidate.at ?? new Date().toISOString(),
      sourceText: candidate.sourceText ?? '',
    },
    verdict,
  });
}

/** Ket qua duyet mot muc quarantine (goi lai v14). */
export type V16QuarantineReview = ReturnType<typeof reviewQuarantineV14>;

/** Duyet hang loat muc quarantine (moi muc ghi audit rieng o store). */
export function reviewQuarantineBatchV16(
  store: TemporalGraphStore,
  ids: string[],
  decision: 'approved' | 'rejected',
  reviewedBy: string,
): Array<{ id: string; ok: true; result: V16QuarantineReview } | { id: string; ok: false; error: string }> {
  if ((reviewedBy ?? '').trim() === '') {
    throw new V16PoisoningGuardError('reviewedBy khong duoc rong (can audit ai duyet).');
  }
  const results: Array<
    | { id: string; ok: true; result: V16QuarantineReview }
    | { id: string; ok: false; error: string }
  > = [];
  for (const id of ids) {
    try {
      const result = reviewQuarantineV14(store, id, decision, reviewedBy);
      results.push({ id, ok: true, result });
    } catch (err) {
      results.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

/** Bao cao muc quarantine sap het han / da het han. */
export interface V16QuarantineAgingReport {
  checkedAt: string;
  /** So muc pending qua han TTL. */
  expiredCount: number;
  /** So muc pending se het han trong 7 ngay toi. */
  expiringSoonCount: number;
  expiredIds: string[];
  expiringSoonIds: string[];
}

/** Quet muc quarantine pending theo tuoi (TTL mac dinh 30 ngay). */
export function quarantineAgingReportV16(
  store: TemporalGraphStore,
  filter: MemoryScope = { userId: '', botId: '', runId: '' },
  opts: { now?: Date; ttlDays?: number; expiringSoonDays?: number } = {},
): V16QuarantineAgingReport {
  const now = opts.now ?? new Date();
  const ttlMs = (opts.ttlDays ?? V16_DEFAULT_QUARANTINE_TTL_DAYS) * 24 * 60 * 60 * 1000;
  const soonMs = (opts.expiringSoonDays ?? 7) * 24 * 60 * 60 * 1000;
  const expiredIds: string[] = [];
  const expiringSoonIds: string[] = [];
  for (const item of store.listQuarantine({ ...filter, status: 'pending' })) {
    const createdMs = Date.parse(item.createdAt);
    if (Number.isNaN(createdMs)) continue;
    const age = now.getTime() - createdMs;
    if (age >= ttlMs) expiredIds.push(item.id);
    else if (ttlMs - age <= soonMs) expiringSoonIds.push(item.id);
  }
  return {
    checkedAt: now.toISOString(),
    expiredCount: expiredIds.length,
    expiringSoonCount: expiringSoonIds.length,
    expiredIds,
    expiringSoonIds,
  };
}

/**
 * Tu dong reject cac muc quarantine pending qua han TTL (chong dong
 * ton): moi muc bi reject voi `reviewedBy` la 'system:quarantine-ttl'
 * va ly do ghi trong audit cua store (reviewQuarantine ghi
 * reviewedAt). Chi ap dung cho muc pending; muc da duyet khong doi.
 */
export function expireStaleQuarantineV16(
  store: TemporalGraphStore,
  filter: MemoryScope = { userId: '', botId: '', runId: '' },
  opts: { now?: Date; ttlDays?: number } = {},
): { expired: number; ids: string[] } {
  const report = quarantineAgingReportV16(store, filter, opts);
  const ids: string[] = [];
  for (const id of report.expiredIds) {
    try {
      reviewQuarantineV14(store, id, 'rejected', 'system:quarantine-ttl');
      ids.push(id);
    } catch {
      // Muc co the da duoc duyet giua chung — bo qua.
    }
  }
  return { expired: ids.length, ids };
}

/**
 * Mo lai muc quarantine da reject de xem xet lai: chi doi status ve
 * `pending` (va xoa reviewedBy/reviewedAt), KHONG tu tao fact.
 * Dung khi user doi y hoac khi rule moi cho thay muc do la fact tot.
 * Luu y: thay doi duoc ap tren object truc tiep trong store (backend
 * in-memory thay ngay); backend file se flush o lan persist ke tiep
 * cua store (vd lan ghi fact/quarantine sau do).
 */
export function reopenQuarantineV16(store: TemporalGraphStore, id: string): QuarantineItem {
  const item = store.listQuarantine({ includeOtherScopes: true }).find((q) => q.id === id);
  if (!item) {
    throw new V16PoisoningGuardError(`Khong tim thay muc quarantine: "${id}".`);
  }
  if (item.status === 'pending') return item;
  if (item.status === 'approved') {
    throw new V16PoisoningGuardError('Muc da approve (fact da vao do thi) — khong mo lai duoc.');
  }
  item.status = 'pending';
  delete item.reviewedBy;
  delete item.reviewedAt;
  return item;
}

/** Duong dan file audit gate v16 (tuong doi workspace). */
export const V16_GATE_AUDIT_REL_PATH = path.join('.open-bot', 'memory-v16-gate-audit.jsonl');

/** Ghi audit mot quyet dinh gate (best-effort, khong throw). */
export function appendV16GateAudit(
  workspaceDir: string,
  entry: {
    at: string;
    decision: V16GateDecision;
    subject: string;
    predicate: string;
    objectText: string;
    sourceName: string;
    reasons: string;
  },
): void {
  try {
    const filePath = path.join(workspaceDir, V16_GATE_AUDIT_REL_PATH);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Audit best-effort.
  }
}
