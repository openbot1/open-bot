/**
 * Memory v27 — bi-temporal fact graph, add-only (v1.42, Doi T3).
 *
 * Y tuong hoc tu Graphiti 0.30-0.31 (survey v142 muc 3): edge
 * bi-temporal (valid_at/invalid_at/created_at/expired_at), fact
 * doi thi edge cu dong chu khong xoa, episode lam provenance,
 * search ket hop embedding + BM25 + graph traversal. Tu thiet
 * ke lai hoan toan cho open-bot, ke thua V25FactEdgeStore cua
 * v25 (khong viet lai edge store), chi them lop add-only +
 * time-travel chat + traversal tren no.
 *
 * Quy tac add-only (bat buoc):
 *   - KHONG co ham update/delete/xoa edge. Chi co addFact (them
 *     moi) va closeEdge (dong hieu luc, ke thua v25).
 *   - addFact trung y het edge active -> tra edge cu, added=false.
 *   - addFact mau thuan edge active (cung subject+predicate,
 *     object khac) -> ADD edge moi + DONG edge cu qua
 *     addSuperseding cua v25 (invalid_at = expired_at = now).
 *   - queryAt(X) chat: loc CA valid time (fact dung tai X) VA
 *     transaction time (he thong da biet fact truoc X) — dung
 *     factValidAtV27, chat hon queryAt cua v25 (chi valid time).
 *   - Traversal: ke 1 hop = fact co chung subject/object/entity
 *     voi fact goc; duong 2 hop = ke cua ke.
 */
import { V25FactEdgeStore } from '../v25/factEdges';
import {
  edgeKnownAtV25,
  edgeValidAtV25,
  normalizeTextV27,
  okV27,
  errV27,
  factValidAtV27,
  toV27Fact,
  truncateV27,
  type V27AddFactResult,
  type V27CandidateFact,
  type V27Fact,
  type V27Result,
} from './types';
import {
  makeV25Scope,
  parseIsoV25,
  type V25FactEdge,
  type V25FactEdgeInput,
  type V25Scope,
} from '../v25/types';

/** Bo loc khi liet ke / query fact trong graph v27. */
export interface V27GraphFilter {
  scope?: V25Scope;
  subject?: string;
  predicate?: string;
  object?: string;
  status?: V25FactEdge['status'];
  /** Chi fact con hieu luc hien tai. */
  currentOnly?: boolean;
  /** Chi fact link toi entity nay. */
  entityId?: string;
  /** Chi fact tu episode nay. */
  episodeId?: string;
  limit?: number;
}

/**
 * Graph fact bi-temporal v27.
 * Ben trong giu V25FactEdgeStore (edge that) + bang phu
 * factId -> entityIds (link luc ghi) de traversal/boosting
 * khong phai quet sourceText.
 */
export class V27Graph {
  /** Edge store ke thua tu v25 (public de store save/load). */
  readonly edges: V25FactEdgeStore;
  /** factId -> entityIds da link luc ghi. */
  private readonly factEntities = new Map<string, string[]>();
  /** factId -> episode text snapshot (de hien thi provenance). */
  private readonly factEpisodeText = new Map<string, string>();

  constructor(edges?: V25FactEdgeStore) {
    this.edges = edges ?? new V25FactEdgeStore();
  }

  get size(): number {
    return this.edges.size;
  }

  /** Lay 1 fact theo id (ke ca da dong — lich su khong mat). */
  get(id: string): V27Fact | undefined {
    const edge = this.edges.get(id);
    if (!edge) return undefined;
    return toV27Fact(edge, {
      entityIds: this.factEntities.get(id) ?? [],
      episodeText: this.factEpisodeText.get(id) ?? edge.sourceText,
    });
  }

  /**
   * Them 1 fact vao graph — ADD-ONLY.
   *  - Trung y het edge active -> tra edge cu, added=false.
   *  - Mau thuan edge active -> supersede: ADD moi + DONG cu.
   *  - Con lai -> ADD moi binh thuong.
   * Khong bao gio sua/xoa edge da co.
   */
  addFact(
    candidate: V27CandidateFact,
    opts: {
      episodeId?: string;
      episodeText?: string;
      scope?: Partial<V25Scope>;
      validAt?: string | null;
      nowMs?: number;
      by?: string;
    } = {},
  ): V27Result<V27AddFactResult> {
    const subject = candidate.subject.trim();
    const predicate = candidate.predicate.trim();
    const object = candidate.object.trim();
    if (!subject || !predicate || !object) {
      return errV27('Fact phai co du subject/predicate/object (khong rong).');
    }
    const nowMs = opts.nowMs ?? Date.now();
    const scope = makeV25Scope(opts.scope ?? {});
    const input: V25FactEdgeInput = {
      subject,
      predicate,
      object,
      validAt: opts.validAt ?? null,
      episodeId: opts.episodeId ?? '',
      sourceText: candidate.sourceSentence,
      scope,
      confidence: candidate.confidence,
      judgeDecision: null,
    };
    // 1. Trung y het edge active? Tra edge cu, khong them.
    const actives = this.edges.activeFor(subject, predicate, scope);
    const duplicate = actives.find(
      (e) => normalizeTextV27(e.object) === normalizeTextV27(object),
    );
    if (duplicate) {
      return okV27({
        added: false,
        edge: duplicate,
        closed: [],
        duplicateOf: duplicate.id,
      });
    }
    // 2. Mau thuan edge active? Supersede: ADD moi + DONG cu.
    const conflicting = actives.filter(
      (e) => normalizeTextV27(e.object) !== normalizeTextV27(object),
    );
    if (conflicting.length > 0) {
      const created = this.edges.addSuperseding(input, {
        nowMs,
        by: opts.by ?? 'system',
        reason: candidate.supersedeReason || `superseded by new fact (add-only)`,
      });
      if (!created.ok) return created as unknown as V27Result<V27AddFactResult>;
      this.rememberFactMeta(created.value.edge, candidate, opts.episodeText);
      return okV27({
        added: true,
        edge: created.value.edge,
        closed: created.value.closed,
        duplicateOf: '',
      });
    }
    // 3. ADD moi binh thuong.
    const created = this.edges.add(input, { nowMs, by: opts.by ?? 'system' });
    if (!created.ok) return created as unknown as V27Result<V27AddFactResult>;
    this.rememberFactMeta(created.value, candidate, opts.episodeText);
    return okV27({ added: true, edge: created.value, closed: [], duplicateOf: '' });
  }

  /** Ghi nho entityIds + episode text cua fact vua them. */
  private rememberFactMeta(
    edge: V25FactEdge,
    candidate: V27CandidateFact,
    episodeText?: string,
  ): void {
    if (candidate.entityIds.length > 0) {
      this.factEntities.set(edge.id, [...candidate.entityIds]);
    }
    if (episodeText) {
      this.factEpisodeText.set(edge.id, truncateV27(episodeText, 500));
    }
  }

  /** Gan entityIds cho 1 fact da co (khi link bo sung sau ingest). */
  setFactEntities(factId: string, entityIds: string[]): void {
    if (entityIds.length === 0) return;
    const prev = this.factEntities.get(factId) ?? [];
    const merged = [...new Set([...prev, ...entityIds])];
    this.factEntities.set(factId, merged);
  }

  /** EntityIds da link cua 1 fact. */
  factEntityIds(factId: string): string[] {
    return [...(this.factEntities.get(factId) ?? [])];
  }

  /** Dong hieu luc 1 edge (ke thua v25) — KHONG xoa vat ly. */
  closeFact(
    id: string,
    opts: { nowMs?: number; by?: string; reason?: string } = {},
  ): V27Result<V25FactEdge> {
    return this.edges.closeEdge(id, opts);
  }

  /** Danh dau 1 edge het han tu nhien (ke thua v25). */
  expireFact(
    id: string,
    opts: { nowMs?: number; by?: string; reason?: string } = {},
  ): V27Result<V25FactEdge> {
    return this.edges.expireEdge(id, opts);
  }

  /** Liet ke fact theo bo loc (moi nhat truoc). */
  list(filter: V27GraphFilter = {}): V27Fact[] {
    let out = this.edges.list({
      scope: filter.scope,
      subject: filter.subject,
      predicate: filter.predicate,
      status: filter.status,
      currentOnly: filter.currentOnly,
      limit: undefined,
    });
    if (filter.object !== undefined) {
      const want = normalizeTextV27(filter.object);
      out = out.filter((e) => normalizeTextV27(e.object) === want);
    }
    if (filter.entityId !== undefined) {
      out = out.filter((e) => (this.factEntities.get(e.id) ?? []).includes(filter.entityId as string));
    }
    if (filter.episodeId !== undefined) {
      out = out.filter((e) => e.episodeId === filter.episodeId);
    }
    const facts = out.map((e) =>
      toV27Fact(e, {
        entityIds: this.factEntities.get(e.id) ?? [],
        episodeText: this.factEpisodeText.get(e.id) ?? e.sourceText,
      }),
    );
    if (filter.limit !== undefined) return facts.slice(0, Math.max(0, filter.limit));
    return facts;
  }

  /** Fact hien tai: cua so con mo. */
  queryCurrent(filter: Omit<V27GraphFilter, 'status' | 'currentOnly'> = {}): V27Fact[] {
    return this.list({ ...filter, currentOnly: true });
  }

  /**
   * Time-travel: fact dung tai thoi diem X (ISO).
   * Chat: ca valid time (validAt <= X < invalidAt) VA
   * transaction time (createdAt <= X < expiredAt). Tra loi neu
   * X khong hop le.
   */
  queryAt(at: string, filter: Omit<V27GraphFilter, 'status' | 'currentOnly'> = {}): V27Result<V27Fact[]> {
    const parsed = parseIsoV25(at);
    if (!parsed) return errV27(`Thoi diem "${at}" khong phai ISO date hop le.`);
    const atMs = parsed.getTime();
    const out = this.list(filter).filter((f) => factValidAtV27(f, atMs));
    return okV27(out);
  }

  /**
   * Time-travel chi theo valid time (giong queryAt cua v25) —
   * de so sanh: fact co the "dung trong the gioi that tai X"
   * nhung he thong chi biet sau X (vd nhap lieu tre).
   */
  queryValidAt(at: string, filter: Omit<V27GraphFilter, 'status' | 'currentOnly'> = {}): V27Result<V27Fact[]> {
    const parsed = parseIsoV25(at);
    if (!parsed) return errV27(`Thoi diem "${at}" khong phai ISO date hop le.`);
    const atMs = parsed.getTime();
    const out = this.list(filter).filter((f) => edgeValidAtV25(f, atMs));
    return okV27(out);
  }

  /** Fact he thong da biet tai X (chi transaction time). */
  queryKnownAt(at: string, filter: Omit<V27GraphFilter, 'status' | 'currentOnly'> = {}): V27Result<V27Fact[]> {
    const parsed = parseIsoV25(at);
    if (!parsed) return errV27(`Thoi diem "${at}" khong phai ISO date hop le.`);
    const atMs = parsed.getTime();
    const out = this.list(filter).filter((f) => edgeKnownAtV25(f, atMs));
    return okV27(out);
  }

  /** Lich su day du cua 1 fact (ke ca da dong). */
  history(id: string): V27Result<V25FactEdge['history']> {
    return this.edges.history(id);
  }

  /**
   * Lich su cua 1 cap (subject, predicate): tat ca edge (active
   * + da dong) theo thu tu thoi gian — thay doi cua fact theo
   * thoi gian, cu nhat truoc.
   */
  historyFor(subject: string, predicate: string, scope?: V25Scope): V27Fact[] {
    const out = this.list({ subject, predicate, ...(scope ? { scope } : {}) });
    out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return out;
  }

  /**
   * Ke 1 hop cua 1 fact: fact khac co chung subject, object
   * hoac entity da link. Dung cho graph traversal luc search.
   */
  neighbors(factId: string, opts: { limit?: number } = {}): V27Fact[] {
    const fact = this.get(factId);
    if (!fact) return [];
    const myEntities = new Set(this.factEntities.get(factId) ?? []);
    const subj = normalizeTextV27(fact.subject);
    const obj = normalizeTextV27(fact.object);
    const out: V27Fact[] = [];
    for (const other of this.list({ currentOnly: true })) {
      if (other.id === factId) continue;
      const sharesSubject =
        normalizeTextV27(other.subject) === subj || normalizeTextV27(other.object) === subj;
      const sharesObject =
        normalizeTextV27(other.subject) === obj || normalizeTextV27(other.object) === obj;
      const sharesEntity = (this.factEntities.get(other.id) ?? []).some((e) => myEntities.has(e));
      if (sharesSubject || sharesObject || sharesEntity) out.push(other);
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    if (opts.limit !== undefined) return out.slice(0, Math.max(0, opts.limit));
    return out;
  }

  /**
   * Duong 2 hop tu 1 fact: ke cua ke (khong lap lai fact goc
   * va ke 1 hop). Tra {hop1, hop2} de search cong diem rieng.
   */
  twoHop(factId: string, opts: { limit?: number } = {}): { hop1: V27Fact[]; hop2: V27Fact[] } {
    const hop1 = this.neighbors(factId, opts);
    const seen = new Set<string>([factId, ...hop1.map((f) => f.id)]);
    const hop2: V27Fact[] = [];
    for (const h of hop1) {
      for (const n of this.neighbors(h.id, opts)) {
        if (!seen.has(n.id)) {
          seen.add(n.id);
          hop2.push(n);
        }
      }
    }
    return { hop1, hop2 };
  }

  /**
   * Tim duong ngan (BFS toi da 3 hop) giua 2 entity/subject:
   * tra chuoi fact noi chung (rong neu khong noi duoc).
   */
  findPath(
    fromSubject: string,
    toSubject: string,
    opts: { maxHops?: number } = {},
  ): V27Fact[] {
    const maxHops = opts.maxHops ?? 3;
    const from = normalizeTextV27(fromSubject);
    const to = normalizeTextV27(toSubject);
    if (!from || !to || from === to) return [];
    const all = this.list({ currentOnly: true });
    // Ke: 2 fact ke nhau neu chung subject/object.
    const keyOf = (f: V27Fact): string[] => [
      normalizeTextV27(f.subject),
      normalizeTextV27(f.object),
    ];
    const start = all.filter((f) =>
      keyOf(f).includes(from),
    );
    if (start.length === 0) return [];
    const visited = new Set<string>();
    type Node = { fact: V27Fact; path: V27Fact[] };
    const queue: Node[] = start.map((f) => ({ fact: f, path: [f] }));
    for (const s of start) visited.add(s.id);
    while (queue.length > 0) {
      const node = queue.shift();
      if (!node) break;
      if (keyOf(node.fact).includes(to)) return node.path;
      if (node.path.length >= maxHops) continue;
      for (const next of this.neighbors(node.fact.id)) {
        if (visited.has(next.id)) continue;
        visited.add(next.id);
        queue.push({ fact: next, path: [...node.path, next] });
      }
    }
    return [];
  }

  /** Dem fact theo status. */
  countByStatus(): Record<V25FactEdge['status'], number> {
    return this.edges.countByStatus();
  }

  /** Kiem tra tinh nhat quan cua graph (ke thua v25). */
  validate(): string[] {
    const problems = this.edges.validate();
    // Them: fact co entityIds thi entity phai ton tai? Graph
    // khong giu registry nen chi kiem tra meta khong rong.
    for (const [factId, entityIds] of this.factEntities) {
      if (!this.edges.get(factId)) {
        problems.push(`factEntities thua: fact "${factId}" khong con trong graph.`);
      }
      if (entityIds.length === 0) {
        problems.push(`factEntities rong: fact "${factId}" khong co entity.`);
      }
    }
    return problems;
  }

  /** Snapshot JSON: edge + bang phu meta. */
  toJSON(): {
    facts: V25FactEdge[];
    factEntities: [string, string[]][];
    factEpisodeText: [string, string][];
  } {
    return {
      facts: this.edges.toJSON(),
      factEntities: [...this.factEntities.entries()],
      factEpisodeText: [...this.factEpisodeText.entries()],
    };
  }

  static fromJSON(data: unknown): V27Graph {
    if (!data || typeof data !== 'object') return new V27Graph();
    const raw = data as {
      facts?: unknown;
      factEntities?: unknown;
      factEpisodeText?: unknown;
    };
    const graph = new V27Graph(
      raw.facts !== undefined
        ? V25FactEdgeStore.fromJSON(raw.facts)
        : new V25FactEdgeStore(),
    );
    if (Array.isArray(raw.factEntities)) {
      for (const [factId, ids] of raw.factEntities as [string, string[]][]) {
        if (typeof factId === 'string' && Array.isArray(ids)) {
          graph.factEntities.set(factId, [...ids]);
        }
      }
    }
    if (Array.isArray(raw.factEpisodeText)) {
      for (const [factId, text] of raw.factEpisodeText as [string, string][]) {
        if (typeof factId === 'string' && typeof text === 'string') {
          graph.factEpisodeText.set(factId, text);
        }
      }
    }
    return graph;
  }
}
