/**
 * Memory v17 — Bi-temporal graph store (v1.36, Doi T1).
 *
 * Y tuong hoc tu Graphiti/Zep: bi-temporal knowledge graph — moi fact
 * mang HAI timeline: valid time (fact dung khi nao trong the gioi that:
 * validFrom/validTo) va transaction time (he thong biet khi nao:
 * learnedAt/invalidatedAt). Fact cu KHONG bao gio bi xoa: khi sai hoac
 * het han thi danh dau invalid (invalidatedAt + ly do), khi bi thay the
 * thi dong validTo + status superseded + tro supersededById sang fact
 * moi. Lich su vi vay van truy van duoc (\"truoc day song o dau?\",
 * \"luc do he thong biet gi?\").
 *
 *  1. Add-only: addFact chi them dong moi; khong co ham update-in-place
 *     nao. Moi thay doi la 1 dong moi + dong cu doi status.
 *  2. queryAt(T): fact dung tai thoi diem T (valid time) — chi active.
 *  3. queryAsKnownAt(T): he thong biet gi tai thoi diem T (transaction
 *     time) — fact co learnedAt <= T va (chua invalid hoac invalidatedAt
 *     > T); dung de time-travel / kiem tra lich su nhan thuc.
 *  4. Timeline: moi thay doi cua 1 fact (hoc / invalid / supersede /
 *     merge) deu la buoc co moc thoi gian.
 *  5. Scope: moi fact mang scope; moi truy van loc dung scope (loc
 *     chat, xem scope.ts). Khong co share ngam — share chi qua grant
 *     tuong minh.
 */

import {
  M17Error,
  M17ExtractedFact,
  M17Fact,
  M17FactStatus,
  M17Provenance,
  M17Scope,
  M17_MAX_FACTS_PER_SCOPE,
  clamp01M17,
  makeM17Id,
  parseIsoM17,
  scopesEqualM17,
  truncateTextM17,
  validateScopeM17,
} from './types';

/** Loi bi-temporal store v17. */
export class M17BiTemporalError extends M17Error {
  constructor(message: string) {
    super(message);
    this.name = 'M17BiTemporalError';
  }
}

/** Tuy chon cua store. */
export interface M17BiTemporalStoreOptions {
  /** Gioi han fact / scope. */
  maxFactsPerScope?: number;
}

/** Tuy chon them fact. */
export interface M17AddFactOptions {
  /** Confidence ghi de (mac dinh lay tu candidate). */
  confidence?: number;
  /** Nguon goc (bat buoc: episode/turn/run). */
  provenance: Omit<M17Provenance, 'at' | 'method' | 'extractor'> & {
    method?: M17Provenance['method'];
    extractor?: string;
  };
  /** Thoi diem hoc duoc (mac dinh now). */
  learnedAt?: string;
}

/** Mot buoc trong timeline cua fact. */
export interface M17FactTimelineStep {
  /** Loai buoc: learned | invalidated | superseded | merged | restored. */
  kind: 'learned' | 'invalidated' | 'superseded' | 'merged' | 'restored';
  /** Moc thoi gian (ISO). */
  at: string;
  /** Chi tiet (ly do / fact lien quan). */
  detail: string;
}

/** Ket qua query state-at. */
export interface M17StateAtResult {
  /** Fact dung tai T. */
  facts: M17Fact[];
  /** Thoi diem truy van. */
  at: string;
  /** Tong fact active trong scope (de UI biet ty le). */
  totalActiveInScope: number;
}

/** Ket qua invalidate / supersede. */
export interface M17MarkResult {
  fact: M17Fact;
  /** Trang thai truoc khi doi. */
  previousStatus: M17FactStatus;
}

/** Ban ghi lich su cua 1 fact (de audit). */
export interface M17FactHistoryEntry {
  factId: string;
  kind: M17FactTimelineStep['kind'];
  at: string;
  detail: string;
}

/**
 * Store bi-temporal trong bo nho — host luu JSON bang serialize().
 * Khong phu thuoc backend ngoai; host co the thay bang SQLite sau nay
 * ma khong doi API (chi can implement cung interface nay).
 */
export class M17BiTemporalStore {
  private readonly maxFactsPerScope: number;
  private facts: M17Fact[] = [];
  private history: M17FactHistoryEntry[] = [];

  constructor(options: M17BiTemporalStoreOptions = {}) {
    this.maxFactsPerScope = options.maxFactsPerScope ?? M17_MAX_FACTS_PER_SCOPE;
  }

  /** Tong so fact (moi status). */
  get totalFacts(): number {
    return this.facts.length;
  }

  /** So fact active. */
  get activeFacts(): number {
    return this.facts.filter((f) => f.status === 'active').length;
  }

  /** Them 1 fact moi (ADD-only — khong bao gio sua fact cu o day). */
  addFact(candidate: M17ExtractedFact, scope: M17Scope, options: M17AddFactOptions): M17Fact {
    const scopeError = validateScopeM17(scope);
    if (scopeError) throw new M17BiTemporalError(scopeError);
    if (!candidate || typeof candidate.object !== 'string' || !candidate.object.trim()) {
      throw new M17BiTemporalError('Fact can object khong rong.');
    }
    const inScope = this.facts.filter((f) => scopesEqualM17(f.scope, scope)).length;
    if (inScope >= this.maxFactsPerScope) {
      throw new M17BiTemporalError(
        `Vuot gioi han ${this.maxFactsPerScope} fact trong scope (tenant="${scope.tenantId}", user="${scope.userId}").`,
      );
    }
    const nowIso = options.learnedAt ?? new Date().toISOString();
    const provenance: M17Provenance = {
      episodeId: options.provenance.episodeId,
      turnId: options.provenance.turnId,
      runId: options.provenance.runId,
      botId: options.provenance.botId,
      userId: options.provenance.userId,
      at: nowIso,
      sourceText: truncateTextM17(options.provenance.sourceText ?? candidate.sourceText, 500),
      method: options.provenance.method ?? 'rule',
      extractor: options.provenance.extractor ?? 'm17-rule-v1',
    };
    const fact: M17Fact = {
      id: makeM17Id('fact'),
      subject: candidate.subject,
      edge: candidate.edge,
      object: candidate.object,
      validFrom: candidate.validFrom ?? null,
      validTo: candidate.validTo ?? null,
      learnedAt: nowIso,
      invalidatedAt: null,
      invalidReason: null,
      supersedesId: null,
      supersededById: null,
      mergedFromIds: [],
      confidence: clamp01M17(options.confidence ?? candidate.confidence),
      status: 'active',
      scope: { ...scope },
      provenance,
      note: '',
    };
    this.facts.push(fact);
    this.history.push({
      factId: fact.id,
      kind: 'learned',
      at: nowIso,
      detail: `Hoc duoc tu episode ${provenance.episodeId} turn ${provenance.turnId} (${provenance.method}).`,
    });
    return fact;
  }

  /** Lay fact theo id (bat ky status, bat ky scope — caller tu kiem scope). */
  getFact(id: string): M17Fact | null {
    return this.facts.find((f) => f.id === id) ?? null;
  }

  /** Lay fact theo id + scope (tu choi neu sai scope). */
  getFactInScope(id: string, scope: M17Scope): M17Fact {
    const fact = this.getFact(id);
    if (!fact) throw new M17BiTemporalError(`Khong tim thay fact: ${id}.`);
    if (!scopesEqualM17(fact.scope, scope)) {
      throw new M17BiTemporalError('Fact khong thuoc scope yeu cau — tu choi truy cap.');
    }
    return fact;
  }

  /** Liet ke fact active trong scope (loc theo edge / subject / tu khoa). */
  listActive(
    scope: M17Scope,
    options: { edge?: string; subject?: string; query?: string; limit?: number; offset?: number } = {},
  ): { facts: M17Fact[]; total: number } {
    const scopeError = validateScopeM17(scope);
    if (scopeError) throw new M17BiTemporalError(scopeError);
    const query = (options.query ?? '').trim().toLowerCase();
    const filtered = this.facts.filter((f) => {
      if (f.status !== 'active') return false;
      if (!scopesEqualM17(f.scope, scope)) return false;
      if (options.edge && f.edge !== options.edge) return false;
      if (options.subject && f.subject !== options.subject) return false;
      if (query) {
        const hay = `${f.subject} ${f.edge} ${f.object}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.max(1, Math.min(500, options.limit ?? 100));
    return {
      facts: filtered
        .sort((a, b) => b.learnedAt.localeCompare(a.learnedAt))
        .slice(offset, offset + limit),
      total: filtered.length,
    };
  }

  /** Danh dau fact invalid (fact sai) — dong KHONG bi xoa. */
  invalidateFact(
    id: string,
    scope: M17Scope,
    reason: string,
    nowIso: string,
  ): M17MarkResult {
    if (!reason || !reason.trim()) {
      throw new M17BiTemporalError('Invalidate can ly do (provenance).');
    }
    const fact = this.getFactInScope(id, scope);
    if (fact.status === 'invalidated') return { fact, previousStatus: 'invalidated' };
    if (fact.status !== 'active') {
      throw new M17BiTemporalError(
        `Chi invalidate fact active — fact ${id} dang o trang thai "${fact.status}".`,
      );
    }
    const previousStatus = fact.status;
    fact.status = 'invalidated';
    fact.invalidatedAt = nowIso;
    fact.invalidReason = reason.trim();
    this.history.push({
      factId: id,
      kind: 'invalidated',
      at: nowIso,
      detail: reason.trim(),
    });
    return { fact, previousStatus };
  }

  /**
   * Supersede: fact cu het dung (dong validTo, status superseded, tro
   * sang fact moi), fact moi duoc tao rieng bang addFact (ADD-only).
   * Ham nay chi xu ly phia fact cu; caller tao fact moi truoc roi goi
   * ham nay voi newFactId.
   */
  supersedeFact(
    oldId: string,
    newFactId: string,
    scope: M17Scope,
    reason: string,
    nowIso: string,
  ): M17MarkResult {
    if (!reason || !reason.trim()) {
      throw new M17BiTemporalError('Supersede can ly do (provenance).');
    }
    const oldFact = this.getFactInScope(oldId, scope);
    const newFact = this.getFactInScope(newFactId, scope);
    if (oldFact.status !== 'active') {
      throw new M17BiTemporalError(
        `Chi supersede fact active — fact ${oldId} dang o trang thai "${oldFact.status}".`,
      );
    }
    if (newFact.status !== 'active') {
      throw new M17BiTemporalError(`Fact moi ${newFactId} phai dang active de supersede.`);
    }
    const previousStatus = oldFact.status;
    oldFact.status = 'superseded';
    oldFact.validTo = nowIso;
    oldFact.supersededById = newFactId;
    newFact.supersedesId = oldId;
    newFact.validFrom = newFact.validFrom ?? nowIso;
    this.history.push({
      factId: oldId,
      kind: 'superseded',
      at: nowIso,
      detail: `${reason.trim()} (bi thay boi ${newFactId}).`,
    });
    this.history.push({
      factId: newFactId,
      kind: 'learned',
      at: nowIso,
      detail: `Thay the fact ${oldId}: ${reason.trim()}.`,
    });
    return { fact: oldFact, previousStatus };
  }

  /** Danh dau fact da gop vao fact khac (merge). */
  markMerged(
    oldId: string,
    mergedFactId: string,
    scope: M17Scope,
    reason: string,
    nowIso: string,
  ): M17MarkResult {
    const oldFact = this.getFactInScope(oldId, scope);
    const mergedFact = this.getFactInScope(mergedFactId, scope);
    if (oldFact.status !== 'active') {
      throw new M17BiTemporalError(`Chi merge fact active — fact ${oldId} dang "${oldFact.status}".`);
    }
    const previousStatus = oldFact.status;
    oldFact.status = 'merged';
    oldFact.invalidatedAt = nowIso;
    oldFact.invalidReason = reason.trim();
    if (!mergedFact.mergedFromIds.includes(oldId)) mergedFact.mergedFromIds.push(oldId);
    this.history.push({
      factId: oldId,
      kind: 'merged',
      at: nowIso,
      detail: `${reason.trim()} (gop vao ${mergedFactId}).`,
    });
    return { fact: oldFact, previousStatus };
  }

  /** Khoi phuc fact invalid/superseded ve active (ghi them history, khong xoa lich su cu). */
  restoreFact(id: string, scope: M17Scope, reason: string, nowIso: string): M17MarkResult {
    const fact = this.getFactInScope(id, scope);
    if (fact.status === 'active') return { fact, previousStatus: 'active' };
    if (fact.status === 'merged') {
      throw new M17BiTemporalError('Khong khoi phuc fact da merge — hay tao fact moi.');
    }
    const previousStatus = fact.status;
    fact.status = 'active';
    fact.invalidatedAt = null;
    fact.invalidReason = null;
    fact.supersededById = null;
    fact.validTo = null;
    this.history.push({ factId: id, kind: 'restored', at: nowIso, detail: reason.trim() });
    return { fact, previousStatus };
  }

  /** Tang confidence fact (khi gap duplicate) — khong doi noi dung. */
  bumpConfidence(id: string, scope: M17Scope, delta: number): M17Fact {
    const fact = this.getFactInScope(id, scope);
    if (fact.status !== 'active') {
      throw new M17BiTemporalError('Chi tang confidence fact active.');
    }
    fact.confidence = clamp01M17(fact.confidence + delta);
    return fact;
  }

  /**
   * queryAt: fact dung tai thoi diem T (valid time).
   * Fact dung tai T khi: status active + validFrom <= T (neu co) +
   * validTo > T (neu co). Fact khong co validFrom duoc coi la dung tu
   * luc hoc (learnedAt).
   */
  factsValidAt(scope: M17Scope, atIso: string): M17StateAtResult {
    const scopeError = validateScopeM17(scope);
    if (scopeError) throw new M17BiTemporalError(scopeError);
    const at = parseIsoM17(atIso);
    if (!at) throw new M17BiTemporalError(`Thoi diem khong hop le: "${atIso}".`);
    const atMs = at.getTime();
    const active = this.facts.filter(
      (f) => f.status === 'active' && scopesEqualM17(f.scope, scope),
    );
    const facts = active.filter((f) => {
      const fromMs = parseIsoM17(f.validFrom)?.getTime() ?? parseIsoM17(f.learnedAt)?.getTime() ?? 0;
      const toMs = parseIsoM17(f.validTo)?.getTime() ?? Number.POSITIVE_INFINITY;
      return fromMs <= atMs && atMs < toMs;
    });
    return { facts, at: atIso, totalActiveInScope: active.length };
  }

  /**
   * queryAsKnownAt: he thong biet gi tai thoi diem T (transaction time).
   * Fact duoc biet tai T khi learnedAt <= T va (chua invalid hoac
   * invalidatedAt > T) va (chua superseded truoc T). Dung cho time-travel
   * / kiem tra \"luc do he thong biet gi\".
   */
  factsAsKnownAt(scope: M17Scope, atIso: string): M17StateAtResult {
    const scopeError = validateScopeM17(scope);
    if (scopeError) throw new M17BiTemporalError(scopeError);
    const at = parseIsoM17(atIso);
    if (!at) throw new M17BiTemporalError(`Thoi diem khong hop le: "${atIso}".`);
    const atMs = at.getTime();
    const facts = this.facts.filter((f) => {
      if (!scopesEqualM17(f.scope, scope)) return false;
      const learnedMs = parseIsoM17(f.learnedAt)?.getTime() ?? 0;
      if (learnedMs > atMs) return false;
      const invalidMs = parseIsoM17(f.invalidatedAt)?.getTime();
      if (invalidMs !== undefined && invalidMs !== null && invalidMs <= atMs) return false;
      // Superseded: neu validTo <= T thi luc T he thong da biet fact cu het dung.
      const validToMs = parseIsoM17(f.validTo)?.getTime();
      if (f.status === 'superseded' && validToMs !== undefined && validToMs !== null && validToMs <= atMs) {
        return false;
      }
      if (f.status === 'merged') return false;
      return true;
    });
    const totalActiveInScope = this.facts.filter(
      (f) => f.status === 'active' && scopesEqualM17(f.scope, scope),
    ).length;
    return { facts, at: atIso, totalActiveInScope };
  }

  /** Timeline cua 1 fact: cac buoc thay doi theo thu tu thoi gian. */
  factTimeline(id: string, scope: M17Scope): M17FactTimelineStep[] {
    const fact = this.getFactInScope(id, scope);
    const steps: M17FactTimelineStep[] = this.history
      .filter((h) => h.factId === id)
      .map((h) => ({ kind: h.kind, at: h.at, detail: h.detail }));
    // Dam bao buoc learned luon co (neu history bi mat).
    if (steps.length === 0) {
      steps.push({
        kind: 'learned',
        at: fact.learnedAt,
        detail: 'Hoc duoc (khong co history chi tiet).',
      });
    }
    return steps.sort((a, b) => a.at.localeCompare(b.at));
  }

  /** Chuoi supersession: fact nay thay the ai, bi ai thay the (truy vet). */
  supersessionChain(id: string, scope: M17Scope): M17Fact[] {
    const chain: M17Fact[] = [];
    const visited = new Set<string>();
    let current: M17Fact | null = this.getFactInScope(id, scope);
    // Di nguoc ve goc.
    while (current && current.supersedesId && !visited.has(current.id)) {
      visited.add(current.id);
      const prev = this.getFact(current.supersedesId);
      if (!prev || !scopesEqualM17(prev.scope, scope)) break;
      chain.unshift(prev);
      current = prev;
    }
    // Di xuoi ve hien tai.
    current = this.getFactInScope(id, scope);
    visited.clear();
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      chain.push(current);
      if (!current.supersededById) break;
      const next = this.getFact(current.supersededById);
      if (!next || !scopesEqualM17(next.scope, scope)) break;
      current = next;
    }
    return chain;
  }

  /** Fact sap het han (validTo trong khoang) — de sleep-time xu ly. */
  factsExpiringSoon(scope: M17Scope, withinMs: number, nowIso: string): M17Fact[] {
    const now = parseIsoM17(nowIso)?.getTime() ?? Date.now();
    return this.facts.filter((f) => {
      if (f.status !== 'active') return false;
      if (!scopesEqualM17(f.scope, scope)) return false;
      const toMs = parseIsoM17(f.validTo)?.getTime();
      if (toMs === undefined || toMs === null) return false;
      return toMs > now && toMs - now <= withinMs;
    });
  }

  /** Thong ke nhanh trong scope. */
  stats(scope: M17Scope): {
    total: number;
    active: number;
    invalidated: number;
    superseded: number;
    merged: number;
    quarantined: number;
  } {
    const stats = { total: 0, active: 0, invalidated: 0, superseded: 0, merged: 0, quarantined: 0 };
    for (const fact of this.facts) {
      if (!scopesEqualM17(fact.scope, scope)) continue;
      stats.total += 1;
      stats[fact.status] += 1;
    }
    return stats;
  }

  /** Serialize toan bo store + history. */
  serialize(): { facts: M17Fact[]; history: M17FactHistoryEntry[] } {
    return {
      facts: this.facts.map((f) => ({
        ...f,
        mergedFromIds: [...f.mergedFromIds],
        scope: { ...f.scope },
        provenance: { ...f.provenance },
      })),
      history: this.history.map((h) => ({ ...h })),
    };
  }

  /** Khoi phuc tu JSON. */
  deserialize(data: { facts?: M17Fact[]; history?: M17FactHistoryEntry[] }): void {
    this.facts = (data.facts ?? []).map((f) => ({
      ...f,
      mergedFromIds: [...(f.mergedFromIds ?? [])],
      scope: { ...f.scope },
      provenance: { ...f.provenance },
    }));
    this.history = (data.history ?? []).map((h) => ({ ...h }));
  }
}

/** Format timeline thanh text doc duoc (UI / log). */
export function formatFactTimelineM17(
  fact: M17Fact,
  steps: M17FactTimelineStep[],
): string {
  const lines = [
    `${fact.subject} —${fact.edge}→ ${fact.object} [${fact.status}]`,
    `  Hoc luc: ${fact.learnedAt}`,
  ];
  if (fact.validFrom) lines.push(`  Dung tu: ${fact.validFrom}`);
  if (fact.validTo) lines.push(`  Het dung: ${fact.validTo}`);
  if (fact.invalidatedAt) lines.push(`  Invalid luc: ${fact.invalidatedAt} (${fact.invalidReason ?? ''})`);
  for (const step of steps) {
    lines.push(`  - [${step.at}] ${step.kind}: ${step.detail}`);
  }
  return lines.join('\n');
}
