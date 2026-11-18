/**
 * Memory v16 — Temporal validity v2 (v1.35, Doi T1).
 *
 * Y tuong hoc tu Zep (temporal KG: moi fact mang cua so hieu luc —
 * fact dung tu khi nao toi khi nao; het han / bi thay the thi cua so
 * dong lai, lich su van truy van duoc) — tu thiet ke lai hoan toan cho
 * open-bot, chay 100% local, KHONG copy code/text/tai san cua bat ky
 * repo nao.
 *
 * Moi so voi temporal KG v15 (lop validity RIENG cua v16):
 *  1. Validity ledger rieng: lop M16ValidityLedger ghi de cua so
 *     hieu luc cua fact (set/expire/extend) ma KHONG sua truc tiep
 *     field cua store — cua so hieu luc hieu dung = ledger (neu co)
 *     giao voi cua so goc cua fact. Ledger serialize duoc sang JSON.
 *  2. Trang thai validity day du: active / not_yet / expired /
 *     invalidated / superseded / deleted — phan biet ro "het han tu
 *     nhien" (expired) voi "bi tuyen bo sai" (invalidated) va "bi
 *     thay the" (superseded).
 *  3. Expiry sweep: quet fact sap het han / da het han trong khoang
 *     thoi gian, tra bao cao de sleep-time consolidation dua vao
 *     archival hoac xoa mem.
 *  4. Replace co ghi lich su cua so: supersede qua store + ledger
 *     ghi lai cua so cu -> moi (chuoi supersession truy vet duoc).
 *  5. Timeline validity: tung buoc thay doi cua so + moc invalidate
 *     + moc supersede, format duoc thanh text doc duoc.
 *
 * Khong bao gio xoa fact khi het han / thay the — chi dong cua so +
 * ghi audit (ly do, actor, thoi diem).
 */

import type { GraphFact, MemoryScope } from '../memory/graph/types';
import type { TemporalGraphStore } from '../memory/graph/store';
import type { ScopeFilter } from '../memory/graph/store';

/** Loi temporal validity v16 — message tieng Viet. */
export class M16TemporalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'M16TemporalError';
  }
}

/** Cua so hieu luc cua mot fact (valid time). */
export interface M16ValidityWindow {
  /** Fact dung tu luc nao (ISO). */
  validFrom: string;
  /** Fact het dung luc nao (null = van dung; ISO). */
  validUntil: string | null;
}

/** Mot ban ghi trong validity ledger (ghi de cua so cua fact). */
export interface M16ValidityRecord extends M16ValidityWindow {
  factId: string;
  /** Ly do dat/doi cua so (vd "het han tu nhien", "user doi viec"). */
  reason: string;
  updatedBy: string;
  updatedAt: string;
  /** Lich su cac cua so truoc (cu nhat dau danh sach). */
  history: { validFrom: string; validUntil: string | null; reason: string; updatedAt: string }[];
}

/** Trang thai validity cua fact tai mot thoi diem. */
export type M16ValidityStatus =
  | 'active'
  | 'not_yet'
  | 'expired'
  | 'invalidated'
  | 'superseded'
  | 'deleted';

export function parseIsoM16(value: string, field: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new M16TemporalError(`Thoi gian khong hop le cho ${field}: "${value}" (can dinh dang ISO).`);
  }
  return ms;
}

/** Validate mot cua so: parse duoc + validFrom <= validUntil (neu co). */
export function validateWindowM16(window: M16ValidityWindow): { ok: true } | { ok: false; reason: string } {
  let fromMs: number;
  let untilMs: number | null = null;
  try {
    fromMs = parseIsoM16(window.validFrom, 'validFrom');
    if (window.validUntil !== null) untilMs = parseIsoM16(window.validUntil, 'validUntil');
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (untilMs !== null && untilMs < fromMs) {
    return {
      ok: false,
      reason: `validUntil (${window.validUntil}) som hon validFrom (${window.validFrom}) — cua so hieu luc rong.`,
    };
  }
  return { ok: true };
}

/**
 * Validity ledger: ban do factId -> cua so hieu luc do v16 quan ly.
 * Ledger GHI DE cua so goc cua fact khi query (giao nhau: lay cua so
 * hep hon). Serialize duoc sang JSON de host luu lau dai.
 */
export class M16ValidityLedger {
  private readonly records = new Map<string, M16ValidityRecord>();

  get size(): number {
    return this.records.size;
  }

  get(factId: string): M16ValidityRecord | undefined {
    const r = this.records.get(factId);
    return r ? { ...r, history: [...r.history] } : undefined;
  }

  has(factId: string): boolean {
    return this.records.has(factId);
  }

  /** Dat cua so hieu luc cho mot fact (ghi lich su cua so cu). */
  set(
    factId: string,
    window: M16ValidityWindow,
    actor = 'system',
    reason = '',
    now?: Date,
  ): M16ValidityRecord {
    const checked = validateWindowM16(window);
    if (!checked.ok) throw new M16TemporalError(checked.reason);
    const at = (now ?? new Date()).toISOString();
    const existing = this.records.get(factId);
    if (existing) {
      existing.history.push({
        validFrom: existing.validFrom,
        validUntil: existing.validUntil,
        reason: existing.reason,
        updatedAt: existing.updatedAt,
      });
      existing.validFrom = window.validFrom;
      existing.validUntil = window.validUntil;
      existing.reason = (reason ?? '').slice(0, 500);
      existing.updatedBy = actor;
      existing.updatedAt = at;
      return { ...existing, history: [...existing.history] };
    }
    const record: M16ValidityRecord = {
      factId,
      validFrom: window.validFrom,
      validUntil: window.validUntil,
      reason: (reason ?? '').slice(0, 500),
      updatedBy: actor,
      updatedAt: at,
      history: [],
    };
    this.records.set(factId, record);
    return { ...record, history: [] };
  }

  /** Dong cua so tai thoi diem `at` (het han): validUntil = at. */
  expire(
    factId: string,
    at: string | Date,
    actor = 'system',
    reason = '',
    now?: Date,
  ): M16ValidityRecord {
    const atIso = at instanceof Date ? at.toISOString() : at;
    parseIsoM16(atIso, 'expireAt');
    const existing = this.records.get(factId);
    const base: M16ValidityWindow = existing
      ? { validFrom: existing.validFrom, validUntil: existing.validUntil }
      : { validFrom: new Date(0).toISOString(), validUntil: null };
    if (base.validUntil !== null) {
      // Expire la dong cua so — terminal: da het han thi khong the
      // expire lai (muon doi cua so thi dung set/extend).
      throw new M16TemporalError(
        `Fact ${factId} da het hieu luc tu ${base.validUntil} — khong the expire lai tai ${atIso}.`,
      );
    }
    return this.set(
      factId,
      { validFrom: base.validFrom, validUntil: atIso },
      actor,
      reason || 'het han (expiry)',
      now,
    );
  }

  /** Gia han cua so: doi validUntil thanh `until` (null = vo han). */
  extend(
    factId: string,
    until: string | null,
    actor = 'system',
    reason = '',
    now?: Date,
  ): M16ValidityRecord {
    const existing = this.records.get(factId);
    if (!existing) {
      throw new M16TemporalError(`Fact ${factId} chua co ban ghi validity — dung set() truoc khi extend.`);
    }
    if (until !== null) parseIsoM16(until, 'validUntil');
    return this.set(
      factId,
      { validFrom: existing.validFrom, validUntil: until },
      actor,
      reason || 'gia han hieu luc',
      now,
    );
  }

  /** Xoa ban ghi ledger cua mot fact (ve lai cua so goc cua store). */
  remove(factId: string): boolean {
    return this.records.delete(factId);
  }

  list(): M16ValidityRecord[] {
    return [...this.records.values()].map((r) => ({ ...r, history: [...r.history] }));
  }

  toJSON(): { version: 1; records: M16ValidityRecord[] } {
    return { version: 1, records: this.list() };
  }

  static fromJSON(data: unknown): { ledger: M16ValidityLedger; skipped: number } {
    const ledger = new M16ValidityLedger();
    let skipped = 0;
    const raw = (data ?? {}) as { records?: unknown };
    if (!Array.isArray(raw.records)) return { ledger, skipped: 0 };
    for (const item of raw.records) {
      const r = item as Partial<M16ValidityRecord>;
      if (typeof r?.factId !== 'string' || typeof r?.validFrom !== 'string') {
        skipped += 1;
        continue;
      }
      if (r.validUntil !== null && typeof r.validUntil !== 'string') {
        skipped += 1;
        continue;
      }
      if (validateWindowM16({ validFrom: r.validFrom, validUntil: r.validUntil ?? null }).ok === false) {
        skipped += 1;
        continue;
      }
      ledger.records.set(r.factId, {
        factId: r.factId,
        validFrom: r.validFrom,
        validUntil: r.validUntil ?? null,
        reason: typeof r.reason === 'string' ? r.reason : '',
        updatedBy: typeof r.updatedBy === 'string' ? r.updatedBy : 'system',
        updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : new Date().toISOString(),
        history: Array.isArray(r.history) ? r.history : [],
      });
    }
    return { ledger, skipped };
  }
}

/**
 * Cua so hieu luc HIỆU DỤNG cua fact: giao cua so ledger (neu co)
 * voi cua so goc cua fact — lay khoang hep hon (from muon nhat,
 * until som nhat).
 */
export function effectiveWindowM16(fact: GraphFact, ledger?: M16ValidityLedger): M16ValidityWindow {
  const base: M16ValidityWindow = { validFrom: fact.validFrom, validUntil: fact.validUntil };
  const override = ledger?.get(fact.id);
  if (!override) return base;
  const fromMs = Math.max(Date.parse(base.validFrom), Date.parse(override.validFrom));
  let untilMs: number | null = null;
  if (base.validUntil !== null && override.validUntil !== null) {
    untilMs = Math.min(Date.parse(base.validUntil), Date.parse(override.validUntil));
  } else {
    untilMs = base.validUntil !== null ? Date.parse(base.validUntil) : override.validUntil !== null ? Date.parse(override.validUntil) : null;
  }
  return {
    validFrom: new Date(fromMs).toISOString(),
    validUntil: untilMs === null ? null : new Date(untilMs).toISOString(),
  };
}

/** Trang thai validity cua fact tai thoi diem `at`. */
export function validityStatusM16(
  fact: GraphFact,
  at: string | Date = new Date(),
  ledger?: M16ValidityLedger,
): M16ValidityStatus {
  if (fact.status === 'deleted') return 'deleted';
  if (fact.invalidAt !== undefined) return 'invalidated';
  if (fact.status === 'superseded') return 'superseded';
  const atMs = at instanceof Date ? at.getTime() : Date.parse(at);
  if (Number.isNaN(atMs)) throw new M16TemporalError(`Thoi gian khong hop le: "${String(at)}".`);
  const window = effectiveWindowM16(fact, ledger);
  if (atMs < Date.parse(window.validFrom)) return 'not_yet';
  if (window.validUntil !== null && atMs >= Date.parse(window.validUntil)) return 'expired';
  return 'active';
}

/** Fact co dung tai thoi diem `at` khong (chi trang thai active moi dung). */
export function isFactValidAtM16(
  fact: GraphFact,
  at: string | Date = new Date(),
  ledger?: M16ValidityLedger,
): boolean {
  return validityStatusM16(fact, at, ledger) === 'active';
}

/** Hai cua so co chong nhau khong. */
export function windowsOverlapM16(a: M16ValidityWindow, b: M16ValidityWindow): boolean {
  const aFrom = Date.parse(a.validFrom);
  const aUntil = a.validUntil === null ? Number.POSITIVE_INFINITY : Date.parse(a.validUntil);
  const bFrom = Date.parse(b.validFrom);
  const bUntil = b.validUntil === null ? Number.POSITIVE_INFINITY : Date.parse(b.validUntil);
  return aFrom < bUntil && bFrom < aUntil;
}

export interface M16FactsValidAtOptions {
  scope?: ScopeFilter;
  /** Chi lay fact co trang thai validity nay (mac dinh: chi 'active'). */
  status?: M16ValidityStatus | 'any';
  limit?: number;
  ledger?: M16ValidityLedger;
}

export interface M16FactsValidAtResult {
  at: string;
  facts: { fact: GraphFact; window: M16ValidityWindow; status: M16ValidityStatus }[];
}

/** Tat ca fact dung tai thoi diem `at` (ke ca ledger override). */
export function factsValidAtM16(
  store: TemporalGraphStore,
  at: string | Date = new Date(),
  opts: M16FactsValidAtOptions = {},
): M16FactsValidAtResult {
  const atIso = at instanceof Date ? at.toISOString() : at;
  parseIsoM16(atIso, 'at');
  const want = opts.status ?? 'active';
  const all = store.listFacts({ ...(opts.scope ?? {}), limit: opts.limit ?? 500 });
  const facts: M16FactsValidAtResult['facts'] = [];
  for (const fact of all) {
    const status = validityStatusM16(fact, atIso, opts.ledger);
    if (want !== 'any' && status !== want) continue;
    facts.push({ fact, window: effectiveWindowM16(fact, opts.ledger), status });
  }
  return { at: atIso, facts };
}

export interface M16ExpiringFact {
  fact: GraphFact;
  window: M16ValidityWindow;
  /** So ms con lai toi khi het han (>= 0). */
  msLeft: number;
}

/** Fact sap het han trong `withinMs` ke tu `now` (chi fact active). */
export function factsExpiringSoonM16(
  store: TemporalGraphStore,
  withinMs: number,
  now: Date = new Date(),
  opts: { scope?: ScopeFilter; ledger?: M16ValidityLedger; limit?: number } = {},
): M16ExpiringFact[] {
  if (!Number.isFinite(withinMs) || withinMs < 0) {
    throw new M16TemporalError(`withinMs phai la so >= 0, nhan duoc ${withinMs}.`);
  }
  const nowMs = now.getTime();
  const out: M16ExpiringFact[] = [];
  for (const fact of store.listFacts({ ...(opts.scope ?? {}), limit: opts.limit ?? 500 })) {
    if (validityStatusM16(fact, now, opts.ledger) !== 'active') continue;
    const window = effectiveWindowM16(fact, opts.ledger);
    if (window.validUntil === null) continue;
    const msLeft = Date.parse(window.validUntil) - nowMs;
    if (msLeft >= 0 && msLeft <= withinMs) out.push({ fact, window, msLeft });
  }
  out.sort((a, b) => a.msLeft - b.msLeft);
  return out;
}

/** Fact da het han tai thoi diem `now` (trang thai expired). */
export function expiredFactsM16(
  store: TemporalGraphStore,
  now: Date = new Date(),
  opts: { scope?: ScopeFilter; ledger?: M16ValidityLedger; limit?: number } = {},
): { fact: GraphFact; window: M16ValidityWindow; expiredAt: string }[] {
  const out: { fact: GraphFact; window: M16ValidityWindow; expiredAt: string }[] = [];
  for (const fact of store.listFacts({ ...(opts.scope ?? {}), limit: opts.limit ?? 500 })) {
    if (validityStatusM16(fact, now, opts.ledger) !== 'expired') continue;
    const window = effectiveWindowM16(fact, opts.ledger);
    out.push({ fact, window, expiredAt: window.validUntil ?? '' });
  }
  out.sort((a, b) => (a.expiredAt < b.expiredAt ? -1 : 1));
  return out;
}

export interface M16ExpirySweepReport {
  at: string;
  scanned: number;
  expiringSoon: number;
  expired: number;
  /** Id fact da het han (de sleep consolidation dua vao archival). */
  expiredIds: string[];
  /** Id fact sap het han (de canh bao / gia han). */
  expiringSoonIds: string[];
}

/**
 * Expiry sweep: quet toan bo store, dem fact sap het han + da het
 * han. KHONG tu dong xoa hay archive — chi bao cao, caller quyet
 * dinh (sleep consolidation / archival recall se xu ly tiep).
 */
export function sweepExpiredM16(
  store: TemporalGraphStore,
  opts: { withinMs?: number; now?: Date; scope?: ScopeFilter; ledger?: M16ValidityLedger } = {},
): M16ExpirySweepReport {
  const now = opts.now ?? new Date();
  const withinMs = opts.withinMs ?? 7 * 24 * 60 * 60 * 1000;
  const scanned = store.listFacts({ ...(opts.scope ?? {}), limit: 500 }).length;
  const soon = factsExpiringSoonM16(store, withinMs, now, { scope: opts.scope, ledger: opts.ledger });
  const expired = expiredFactsM16(store, now, { scope: opts.scope, ledger: opts.ledger });
  return {
    at: now.toISOString(),
    scanned,
    expiringSoon: soon.length,
    expired: expired.length,
    expiredIds: expired.map((e) => e.fact.id),
    expiringSoonIds: soon.map((e) => e.fact.id),
  };
}

export interface M16ReplaceFactOptions {
  /** Cua so hieu luc cua fact moi (mac dinh: tu `at` tro di). */
  window?: M16ValidityWindow;
  actor?: string;
  reason?: string;
  ledger?: M16ValidityLedger;
  now?: Date;
}

export interface M16ReplaceFactResult {
  oldFact: GraphFact;
  newFact: GraphFact;
  oldWindow: M16ValidityWindow;
  newWindow: M16ValidityWindow;
}

/**
 * Thay the fact cu bang fact moi: supersede qua store (dong cua so
 * cu tai `at`, noi supersession hai chieu) + ledger ghi cua so moi.
 * Tra ve ca hai fact + hai cua so de audit.
 */
export function replaceFactM16(
  store: TemporalGraphStore,
  oldFactId: string,
  input: {
    subjectName: string;
    predicate: string;
    objectText: string;
    confidence?: number;
    scope: MemoryScope;
    sourceText: string;
    episodeId?: string;
    turnId?: string;
    runId?: string;
    botId?: string;
    userId?: string;
  },
  opts: M16ReplaceFactOptions = {},
): M16ReplaceFactResult {
  const oldFact = store.getFact(oldFactId);
  if (!oldFact) throw new M16TemporalError(`Khong tim thay fact ${oldFactId} de thay the.`);
  const now = opts.now ?? new Date();
  const at = now.toISOString();
  const oldWindow = effectiveWindowM16(oldFact, opts.ledger);
  const newWindow: M16ValidityWindow = opts.window ?? { validFrom: at, validUntil: null };
  const checked = validateWindowM16(newWindow);
  if (!checked.ok) throw new M16TemporalError(checked.reason);
  const newFact = store.supersedeFact(oldFactId, {
    subjectName: input.subjectName,
    predicate: input.predicate,
    objectText: input.objectText,
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    scope: input.scope,
    provenance: {
      episodeId: input.episodeId ?? '',
      turnId: input.turnId ?? '',
      runId: input.runId ?? oldFact.scope.runId ?? '',
      botId: input.botId ?? oldFact.scope.botId ?? '',
      userId: input.userId ?? oldFact.scope.userId ?? '',
      at,
      sourceText: input.sourceText,
    },
    validFrom: newWindow.validFrom,
    validUntil: newWindow.validUntil,
  });
  if (opts.ledger) {
    opts.ledger.set(newFact.id, newWindow, opts.actor ?? 'system', opts.reason ?? 'replace fact');
  }
  return { oldFact: store.getFact(oldFactId) ?? oldFact, newFact, oldWindow, newWindow };
}

/** Mot buoc trong timeline validity cua fact. */
export interface M16ValidityTimelineStep {
  at: string;
  kind: 'created' | 'window_change' | 'expired' | 'invalidated' | 'superseded' | 'deleted';
  detail: string;
}

/** Timeline validity: moc tao + doi cua so (ledger) + het han + invalidate + supersede. */
export function factValidityTimelineM16(
  fact: GraphFact,
  ledger?: M16ValidityLedger,
  now: Date = new Date(),
): M16ValidityTimelineStep[] {
  const steps: M16ValidityTimelineStep[] = [
    {
      at: fact.createdAt,
      kind: 'created',
      detail: `Fact tao luc ${fact.createdAt}, cua so goc ${fact.validFrom} → ${fact.validUntil ?? '∞'}.`,
    },
  ];
  const record = ledger?.get(fact.id);
  if (record) {
    for (const h of record.history) {
      steps.push({
        at: h.updatedAt,
        kind: 'window_change',
        detail: `Cua so cu ${h.validFrom} → ${h.validUntil ?? '∞'} (${h.reason || 'khong ro ly do'}).`,
      });
    }
    steps.push({
      at: record.updatedAt,
      kind: 'window_change',
      detail: `Cua so hien tai ${record.validFrom} → ${record.validUntil ?? '∞'} (${record.reason || 'khong ro ly do'}, boi ${record.updatedBy}).`,
    });
  }
  const status = validityStatusM16(fact, now, ledger);
  const window = effectiveWindowM16(fact, ledger);
  if (status === 'expired' && window.validUntil) {
    steps.push({ at: window.validUntil, kind: 'expired', detail: `Het hieu luc luc ${window.validUntil}.` });
  }
  if (fact.invalidAt) {
    steps.push({
      at: fact.invalidAt,
      kind: 'invalidated',
      detail: `Bi invalidate boi ${fact.invalidatedBy ?? '?'}: ${fact.invalidationReason ?? ''}`,
    });
  }
  if (fact.status === 'superseded') {
    steps.push({
      at: fact.updatedAt,
      kind: 'superseded',
      detail: `Bi thay the boi fact ${fact.supersededBy ?? '?'} (cua so dong tai ${fact.validUntil ?? fact.updatedAt}).`,
    });
  }
  if (fact.status === 'deleted') {
    steps.push({ at: fact.updatedAt, kind: 'deleted', detail: 'Bi xoa mem (soft-delete).' });
  }
  steps.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return steps;
}

/** Format timeline validity thanh text doc duoc. */
export function formatValidityTimelineM16(fact: GraphFact, ledger?: M16ValidityLedger, now?: Date): string {
  const steps = factValidityTimelineM16(fact, ledger, now ?? new Date());
  const lines = [
    `Timeline validity — fact ${fact.id} (${fact.subjectId} ${fact.predicate} ${fact.objectText ?? ''}):`,
  ];
  for (const s of steps) lines.push(`  [${s.at}] ${s.kind}: ${s.detail}`);
  return lines.join('\n');
}

/**
 * Chuoi supersession: di nguoc tu fact hien tai ve fact goc (qua
 * `supersedes`) + di xuoi toi fact moi nhat (qua `supersededBy`).
 * Tra ve danh sach id theo thu tu thoi gian (cu nhat dau).
 */
export function supersessionChainM16(store: TemporalGraphStore, factId: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current = store.getFact(factId);
  // Di nguoc ve goc.
  const backward: string[] = [];
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    backward.push(current.id);
    current = current.supersedes ? store.getFact(current.supersedes) : undefined;
  }
  backward.reverse();
  chain.push(...backward);
  // Di xuoi toi moi nhat.
  let fwd = store.getFact(factId);
  while (fwd?.supersededBy && !seen.has(fwd.supersededBy)) {
    const next = store.getFact(fwd.supersededBy);
    if (!next) break;
    seen.add(next.id);
    chain.push(next.id);
    fwd = next;
  }
  return chain;
}

/** Scope mac dinh (trong, dung cho test / eval). */
export function defaultM16Scope(): MemoryScope {
  return { userId: '', botId: '', runId: '' };
}

// ---------------------------------------------------------------------------
// Validity report — tong quan hieu luc toan bo store
// ---------------------------------------------------------------------------

export interface M16ValidityReport {
  at: string;
  scanned: number;
  byStatus: Record<M16ValidityStatus, number>;
  /** So fact co cua so mo (validUntil null) — van dung vo han. */
  openEnded: number;
  /** So fact co ledger override (cua so do v16 quan ly). */
  ledgerOverridden: number;
  expiringSoon: M16ExpiringFact[];
  expired: { fact: GraphFact; window: M16ValidityWindow; expiredAt: string }[];
}

/**
 * Bao cao tong quan hieu luc: dem fact theo tung trang thai validity
 * + danh sach sap het han / da het han. Dung cho dashboard + tool
 * validity_query (sweep mo rong).
 */
export function validityReportM16(
  store: TemporalGraphStore,
  opts: { withinMs?: number; now?: Date; scope?: ScopeFilter; ledger?: M16ValidityLedger; limit?: number } = {},
): M16ValidityReport {
  const now = opts.now ?? new Date();
  const withinMs = opts.withinMs ?? 7 * 24 * 60 * 60 * 1000;
  const facts = store.listFacts({ ...(opts.scope ?? {}), limit: opts.limit ?? 500 });
  const byStatus: Record<M16ValidityStatus, number> = {
    active: 0,
    not_yet: 0,
    expired: 0,
    invalidated: 0,
    superseded: 0,
    deleted: 0,
  };
  let openEnded = 0;
  let ledgerOverridden = 0;
  for (const fact of facts) {
    const status = validityStatusM16(fact, now, opts.ledger);
    byStatus[status] += 1;
    const window = effectiveWindowM16(fact, opts.ledger);
    if (window.validUntil === null) openEnded += 1;
    if (opts.ledger?.has(fact.id)) ledgerOverridden += 1;
  }
  return {
    at: now.toISOString(),
    scanned: facts.length,
    byStatus,
    openEnded,
    ledgerOverridden,
    expiringSoon: factsExpiringSoonM16(store, withinMs, now, { scope: opts.scope, ledger: opts.ledger }),
    expired: expiredFactsM16(store, now, { scope: opts.scope, ledger: opts.ledger }),
  };
}

/** Format validity report thanh text doc duoc. */
export function formatValidityReportM16(report: M16ValidityReport): string {
  const lines = [
    `Validity report v16 tai ${report.at}: quet ${report.scanned} fact.`,
    `  Trang thai: ${Object.entries(report.byStatus)
      .map(([s, n]) => `${s} ${n}`)
      .join(', ')}.`,
    `  Cua so mo (vo han): ${report.openEnded}; ledger override: ${report.ledgerOverridden}.`,
    `  Sap het han: ${report.expiringSoon.length}; da het han: ${report.expired.length}.`,
  ];
  for (const e of report.expiringSoon.slice(0, 10)) {
    lines.push(`  - SAP HET HAN: ${e.fact.predicate} = ${e.fact.objectText ?? ''} (con ${Math.round(e.msLeft / 3600000)} gio).`);
  }
  for (const e of report.expired.slice(0, 10)) {
    lines.push(`  - HET HAN: ${e.fact.predicate} = ${e.fact.objectText ?? ''} (luc ${e.expiredAt}).`);
  }
  return lines.join('\n');
}
