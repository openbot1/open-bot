/**
 * Memory v25 — fact edges bi-temporal (v1.40, Doi T1).
 *
 * Y tuong hoc tu Graphiti/Zep (survey v140 muc 3, chi y tuong):
 * moi fact edge co 4 moc thoi gian — valid_at / invalid_at
 * (valid time: fact dung trong the gioi that khi nao) +
 * created_at / expired_at (transaction time: he thong biet fact
 * tu khi nao). Fact moi mau thuan fact cu thi DONG khoang hieu
 * luc cua fact cu (set invalid_at/expired_at), KHONG xoa vat ly.
 *
 * Query:
 *  - queryAt(X): fact dung tai X — cua so valid chua X, va he thong
 *    da biet fact truoc X (created_at <= X < expired_at).
 *  - queryCurrent(): cua so con mo (status active, invalid_at va
 *    expired_at deu null).
 *
 * Chay 100% local, khong goi model/mang. Luu JSON duoc qua
 * toJSON/fromJSON (store goi).
 */
import {
  edgeIsCurrentV25,
  edgeKnownAtV25,
  edgeValidAtV25,
  errV25,
  isoAtV25,
  makeV25Id,
  makeV25Scope,
  normalizeTextV25,
  okV25,
  parseIsoV25,
  scopeMatchesV25,
  type V25EdgeStatus,
  type V25FactEdge,
  type V25FactEdgeInput,
  type V25Result,
  type V25Scope,
} from './types';

/** Bo loc khi liet ke / query fact. */
export interface V25FactFilter {
  scope?: V25Scope;
  subject?: string;
  predicate?: string;
  status?: V25FactEdge['status'];
  /** Chi lay edge con hieu luc. */
  currentOnly?: boolean;
  limit?: number;
}

/**
 * Store fact edge bi-temporal trong bo nho.
 * Khong co ham xoa vat ly — chi co closeEdge (dong hieu luc).
 */
export class V25FactEdgeStore {
  private readonly edges = new Map<string, V25FactEdge>();

  /** So edge dang giu. */
  get size(): number {
    return this.edges.size;
  }

  /** Them 1 edge moi (khong supersede edge nao). */
  add(input: V25FactEdgeInput, opts: { nowMs?: number; by?: string } = {}): V25Result<V25FactEdge> {
    const subject = input.subject.trim();
    const predicate = input.predicate.trim();
    const object = input.object.trim();
    if (!subject) return errV25('subject khong duoc rong.');
    if (!predicate) return errV25('predicate khong duoc rong.');
    if (!object) return errV25('object khong duoc rong.');
    if (subject.length > 500 || predicate.length > 200 || object.length > 2000) {
      return errV25('subject/predicate/object qua dai (500/200/2000 ky tu).');
    }
    const nowMs = opts.nowMs ?? Date.now();
    const nowIso = isoAtV25(nowMs);
    let validAt: string | null = null;
    if (input.validAt !== undefined && input.validAt !== null) {
      const parsed = parseIsoV25(input.validAt);
      if (!parsed) return errV25(`validAt "${input.validAt}" khong phai ISO date hop le.`);
      validAt = parsed.toISOString();
      if (parsed.getTime() > nowMs) {
        return errV25('validAt khong duoc o tuong lai so voi thoi diem ghi.');
      }
    }
    const edge: V25FactEdge = {
      id: makeV25Id('edge'),
      subject,
      predicate,
      object,
      validAt,
      invalidAt: null,
      createdAt: nowIso,
      expiredAt: null,
      status: 'active',
      episodeId: input.episodeId ?? '',
      sourceText: input.sourceText ?? '',
      scope: {
        userId: input.scope?.userId ?? '',
        agentId: input.scope?.agentId ?? '',
        runId: input.scope?.runId ?? '',
        appId: input.scope?.appId ?? '',
      },
      confidence: clampConfidence(input.confidence),
      supersedesId: null,
      supersededById: null,
      judgeDecision: input.judgeDecision ?? null,
      history: [
        {
          at: nowIso,
          kind: 'created',
          detail: `created: ${subject} ${predicate} ${object}`,
          by: opts.by ?? 'system',
        },
      ],
    };
    this.edges.set(edge.id, edge);
    return okV25(edge);
  }

  /**
   * Them edge moi + dong cac edge active cung subject+predicate co
   * object khac (supersede). Tra edge moi + danh sach edge bi dong.
   * Dung khi judge quyet dinh UPDATE.
   */
  addSuperseding(
    input: V25FactEdgeInput,
    opts: { nowMs?: number; by?: string; reason?: string } = {},
  ): V25Result<{ edge: V25FactEdge; closed: V25FactEdge[] }> {
    const nowMs = opts.nowMs ?? Date.now();
    // Chi supersede edge cung scope (scope rong = khop moi scope).
    const scope = makeV25Scope(input.scope ?? {});
    const conflicting = this.list({
      subject: input.subject,
      predicate: input.predicate,
      status: 'active',
    }).filter(
      (e) =>
        scopeMatchesV25(e.scope, scope) &&
        normalizeTextV25(e.object) !== normalizeTextV25(input.object),
    );
    const created = this.add(
      { ...input, judgeDecision: input.judgeDecision ?? 'UPDATE' },
      { nowMs, by: opts.by },
    );
    if (!created.ok) return created as unknown as V25Result<{ edge: V25FactEdge; closed: V25FactEdge[] }>;
    const edge = created.value;
    const closed: V25FactEdge[] = [];
    for (const old of conflicting) {
      const res = this.closeEdge(old.id, {
        nowMs,
        by: opts.by ?? 'system',
        reason: opts.reason ?? `superseded by ${edge.id} (UPDATE)`,
        supersededById: edge.id,
      });
      if (res.ok) {
        edge.supersedesId = old.id;
        edge.history.push({
          at: isoAtV25(nowMs),
          kind: 'created',
          detail: `supersedes ${old.id}`,
          by: opts.by ?? 'system',
        });
        closed.push(res.value);
      }
    }
    // Chi giu supersedesId la edge bi dong gan nhat (neu co nhieu).
    if (closed.length > 1) {
      edge.supersedesId = closed[closed.length - 1]?.id ?? null;
    }
    return okV25({ edge, closed });
  }

  /**
   * Dong khoang hieu luc cua 1 edge: set invalidAt + expiredAt = now,
   * status = 'superseded'. KHONG xoa vat ly — edge + history con
   * nguyen de audit. Dong 2 lan tra loi.
   */
  closeEdge(
    id: string,
    opts: { nowMs?: number; by?: string; reason?: string; supersededById?: string } = {},
  ): V25Result<V25FactEdge> {
    const edge = this.edges.get(id);
    if (!edge) return errV25(`Khong co fact edge "${id}".`);
    if (edge.status !== 'active' || edge.invalidAt !== null) {
      return errV25(`Edge "${id}" da dong (status ${edge.status}).`);
    }
    const nowMs = opts.nowMs ?? Date.now();
    const nowIso = isoAtV25(nowMs);
    edge.invalidAt = nowIso;
    edge.expiredAt = nowIso;
    edge.status = 'superseded';
    if (opts.supersededById) edge.supersededById = opts.supersededById;
    edge.history.push({
      at: nowIso,
      kind: 'superseded',
      detail: opts.reason ?? `closed at ${nowIso}`,
      by: opts.by ?? 'system',
    });
    return okV25(edge);
  }

  /**
   * Danh dau 1 edge het han tu nhien (khong phai bi supersede):
   * status = 'expired', chi set expiredAt (giu nguyen invalidAt neu
   * da co). Dung cho fact co thoi han (vd lich hen da qua).
   */
  expireEdge(
    id: string,
    opts: { nowMs?: number; by?: string; reason?: string } = {},
  ): V25Result<V25FactEdge> {
    const edge = this.edges.get(id);
    if (!edge) return errV25(`Khong co fact edge "${id}".`);
    if (edge.status === 'expired') return errV25(`Edge "${id}" da expired.`);
    const nowMs = opts.nowMs ?? Date.now();
    const nowIso = isoAtV25(nowMs);
    edge.expiredAt = nowIso;
    edge.status = 'expired';
    edge.history.push({
      at: nowIso,
      kind: 'expired',
      detail: opts.reason ?? `expired at ${nowIso}`,
      by: opts.by ?? 'system',
    });
    return okV25(edge);
  }

  /** Lay 1 edge theo id (ke ca da dong — lich su khong mat). */
  get(id: string): V25FactEdge | undefined {
    return this.edges.get(id);
  }

  /** Liet ke edge theo bo loc (mac dinh tat ca, moi nhat truoc). */
  list(filter: V25FactFilter = {}): V25FactEdge[] {
    const out: V25FactEdge[] = [];
    for (const edge of this.edges.values()) {
      if (filter.scope && !scopeMatchesV25(edge.scope, filter.scope)) continue;
      if (filter.subject !== undefined && normalizeTextV25(edge.subject) !== normalizeTextV25(filter.subject)) continue;
      if (filter.predicate !== undefined && normalizeTextV25(edge.predicate) !== normalizeTextV25(filter.predicate)) continue;
      if (filter.status !== undefined && edge.status !== filter.status) continue;
      if (filter.currentOnly && !edgeIsCurrentV25(edge)) continue;
      out.push(edge);
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    if (filter.limit !== undefined) return out.slice(0, Math.max(0, filter.limit));
    return out;
  }

  /** Edge active hien tai cho 1 cap (subject, predicate) — co the nhieu. */
  activeFor(subject: string, predicate: string, scope?: V25Scope): V25FactEdge[] {
    return this.list({
      subject,
      predicate,
      status: 'active',
      ...(scope ? { scope } : {}),
    });
  }

  /**
   * Fact dung tai thoi diem X (ISO): cua so valid chua X
   * (validAt <= X < invalidAt). Transaction time (createdAt /
   * expiredAt) van luu tren edge de audit rieng qua
   * edgeKnownAtV25 — queryAt chi loc theo valid time, dung nhu
   * mo ta "fact dung tai thoi diem X". Tra loi neu X khong hop le.
   */
  queryAt(at: string, filter: Omit<V25FactFilter, 'status' | 'currentOnly'> = {}): V25Result<V25FactEdge[]> {
    const parsed = parseIsoV25(at);
    if (!parsed) return errV25(`Thoi diem "${at}" khong phai ISO date hop le.`);
    const atMs = parsed.getTime();
    const out = this.list(filter).filter((e) => edgeValidAtV25(e, atMs));
    return okV25(out);
  }

  /** Fact hien tai: cua so con mo (active + chua dong + chua het han). */
  queryCurrent(filter: Omit<V25FactFilter, 'status' | 'currentOnly'> = {}): V25FactEdge[] {
    return this.list({ ...filter, currentOnly: true });
  }

  /** Lich su day du cua 1 edge (ke ca da dong). */
  history(id: string): V25Result<V25FactEdge['history']> {
    const edge = this.edges.get(id);
    if (!edge) return errV25(`Khong co fact edge "${id}".`);
    return okV25([...edge.history]);
  }

  /** Dem edge theo status. */
  countByStatus(): Record<V25EdgeStatus, number> {
    const out: Record<V25EdgeStatus, number> = { active: 0, superseded: 0, expired: 0 };
    for (const edge of this.edges.values()) out[edge.status]++;
    return out;
  }

  /** Kiem tra tinh nhat quan: cua so valid phai mo truoc khi dong. */
  validate(): string[] {
    const problems: string[] = [];
    for (const edge of this.edges.values()) {
      if (edge.validAt && edge.invalidAt) {
        if (Date.parse(edge.validAt) >= Date.parse(edge.invalidAt)) {
          problems.push(`edge ${edge.id}: validAt >= invalidAt.`);
        }
      }
      if (edge.expiredAt && Date.parse(edge.createdAt) > Date.parse(edge.expiredAt)) {
        problems.push(`edge ${edge.id}: createdAt > expiredAt.`);
      }
      if (edge.status === 'active' && (edge.invalidAt !== null || edge.expiredAt !== null)) {
        problems.push(`edge ${edge.id}: active nhung da co invalidAt/expiredAt.`);
      }
    }
    return problems;
  }

  toJSON(): V25FactEdge[] {
    return [...this.edges.values()];
  }

  static fromJSON(data: unknown): V25FactEdgeStore {
    const store = new V25FactEdgeStore();
    if (!Array.isArray(data)) return store;
    for (const raw of data as V25FactEdge[]) {
      if (!raw || typeof raw.id !== 'string') continue;
      store.edges.set(raw.id, {
        ...raw,
        history: Array.isArray(raw.history) ? raw.history : [],
      });
    }
    return store;
  }
}

function clampConfidence(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0.7;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
