/**
 * Memory v16 — Entity linking (v1.17, Doi T1).
 *
 * Y tuong hoc tu Mem0 v3 (2026: entity linking + graph nhe — fact gan
 * entity, entity trung lap duoc gop) — tu thiet ke lai hoan toan cho
 * open-bot, chay 100% local, KHONG copy code/text/tai san cua bat ky
 * repo nao.
 *
 * Van de giai quyet: extractor viet ten entity tu do ("Ha Noi",
 * "Ha Noi", "HN", "thanh pho Ha Noi") nen cung mot thuc the sinh ra
 * nhieu entity rieng biet trong TemporalGraphStore; fact ve cung mot
 * nguoi/noi vi the khong noi voi nhau, retrieval theo entity bi sot.
 * Module nay la lop phan giai tren store hien co (khong doi schema):
 *
 *  - `normalizeEntityNameV16` — chuan hoa ten de so sanh (chu thuong,
 *    bo dau tieng Viet, bo dau cau, bo tien to/hau to dia danh thong
 *    dung nhu "thanh pho"/"tp."/"tinh" khi so sanh).
 *  - `entityMatchScoreV16` — cham diem khop 0..1 giua hai ten: khop
 *    chinh xac sau chuan hoa (1.0), khop alias (0.95), mot ten la
 *    viet tat cua ten kia (0.85), Jaccard token (0..0.8), mot ten la
 *    hau to/tien to cua ten kia (0.7). Nguong mac dinh 0.8.
 *  - `V16EntityLinker` — giu bang lien ket (link table) trong bo nho:
 *    `resolve(name, kind)` tra ve entity chuan trong store (tim theo
 *    ten/alias, neu khong co thi tao moi qua `ensureEntity`); moi
 *    ten bien the duoc ghi alias vao entity chuan qua
 *    `store.addAlias` de lan sau tim thang.
 *  - `mergeEntitiesV16` — gop that: doi subjectId/objectId cua moi
 *    fact dang tro toi entity thua sang entity giu (sua truc tiep
 *    tren object fact ma store tra ve — cung object trong file cua
 *    store — roi goi `setFactConfidence` cung gia tri de store flush
 *    xuong dia), them ten thua lam alias, xoa entity thua khoi store.
 *    Fact trung lap sinh ra sau khi gop (cung subject+predicate+
 *    object) duoc tra ve de caller gop tiep bang `mergeFacts`.
 *  - `scanDuplicateEntitiesV16` — quet toan bo entity trong scope,
 *    gom cum theo diem khop, tra ve danh sach cum trung lap de user
 *    hoac sleep agent duyet truoc khi gop (khong tu gop lang le).
 *  - `V16EntityLinkTable` — bang lien ket serialize duoc sang JSON
 *    (de host luu file tuy y): ghi lai moi lan resolve/merge (ten
 *    bien the -> canonical id, ly do, thoi gian) de audit va de
 *    khoi phuc sau restart ma khong phai quet lai.
 */

import type { GraphEntity, GraphFact, MemoryScope } from '../graph/types';
import { normalizeGraphText } from '../graph/types';
import type { TemporalGraphStore } from '../graph/store';

/** Loi entity linking v16 — message tieng Viet. */
export class V16EntityLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V16EntityLinkError';
  }
}

/** Diem khop toi thieu de coi hai ten la cung entity (mac dinh). */
export const V16_DEFAULT_LINK_THRESHOLD = 0.8;
/** Diem khop toi thieu cho viet tat (can xac nhan them, mac dinh). */
export const V16_ABBREVIATION_SCORE = 0.85;
/** So ky tu toi thieu cua ten de xet viet tat (tranh "Ha" khop lung tung). */
export const V16_MIN_ABBREV_CHARS = 2;

/** Tien to/hau to dia danh bo qua khi so sanh ten (khong doi ten goc). */
export const V16_LOCATION_PREFIXES: readonly string[] = [
  'thanh pho',
  'tp',
  'tinh',
  'quan',
  'huyen',
  'xa',
  'phuong',
  'thi tran',
  'city',
  'province',
];

/**
 * Chuan hoa ten entity de so sanh: chu thuong, bo dau, bo dau cau,
 * bo tien to dia danh o dau ten. Ten goc khong bi thay doi — ham nay
 * chi dung cho so sanh, khong dung de hien thi.
 */
export function normalizeEntityNameV16(name: string): string {
  let norm = normalizeGraphText(name ?? '');
  if (norm === '') return '';
  for (const prefix of V16_LOCATION_PREFIXES) {
    if (norm.startsWith(`${prefix} `)) {
      norm = norm.slice(prefix.length + 1).trim();
      break;
    }
    if (norm.endsWith(` ${prefix}`)) {
      norm = norm.slice(0, norm.length - prefix.length - 1).trim();
      break;
    }
  }
  return norm;
}

/** Tach ten da chuan hoa thanh token (bo token 1 ky tu). */
export function entityTokensV16(normalizedName: string): string[] {
  return (normalizedName ?? '')
    .split(' ')
    .map((t) => t.trim())
    .filter((t) => t.length > 1);
}

/** Jaccard giua hai tap token (0..1). */
export function tokenJaccardV16(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter += 1;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : inter / union;
}

/**
 * Viet tat cua mot ten co phai la chu cai dau cua cac token khong
 * (vd "hn" la viet tat cua "ha noi", "hcm" cua "ho chi minh").
 */
export function isAbbreviationOfV16(abbrev: string, fullName: string): boolean {
  const a = (abbrev ?? '').trim();
  const tokens = entityTokensV16(fullName);
  if (a.length < V16_MIN_ABBREV_CHARS || tokens.length < 2) return false;
  if (!/^[a-z0-9]+$/.test(a)) return false;
  if (a.length !== tokens.length) return false;
  return tokens.every((token, i) => token.startsWith(a[i]));
}

/** Chi tiet cham diem khop giua hai ten entity. */
export interface V16EntityMatchDetail {
  /** Diem khop 0..1. */
  score: number;
  /** Ly do dat diem nay. */
  reason: 'exact' | 'alias' | 'abbreviation' | 'token' | 'affix' | 'none';
  /** Ten da chuan hoa cua hai ben (de debug). */
  normalizedA: string;
  normalizedB: string;
}

/**
 * Cham diem khop giua hai ten entity (0..1). `aliases` la alias cua
 * entity B (neu co) — khop alias duoc 0.95. Khong goi model, chi luat.
 */
export function entityMatchScoreV16(
  nameA: string,
  nameB: string,
  aliasesB: string[] = [],
): V16EntityMatchDetail {
  const normA = normalizeEntityNameV16(nameA);
  const normB = normalizeEntityNameV16(nameB);
  if (normA === '' || normB === '') {
    return { score: 0, reason: 'none', normalizedA: normA, normalizedB: normB };
  }
  if (normA === normB) {
    return { score: 1, reason: 'exact', normalizedA: normA, normalizedB: normB };
  }
  for (const alias of aliasesB) {
    if (normalizeEntityNameV16(alias) === normA) {
      return { score: 0.95, reason: 'alias', normalizedA: normA, normalizedB: normB };
    }
  }
  const compactA = normA.replace(/ /g, '');
  const compactB = normB.replace(/ /g, '');
  if (
    (compactA.length >= V16_MIN_ABBREV_CHARS &&
      isAbbreviationOfV16(compactA, normB)) ||
    (compactB.length >= V16_MIN_ABBREV_CHARS && isAbbreviationOfV16(compactB, normA))
  ) {
    return { score: V16_ABBREVIATION_SCORE, reason: 'abbreviation', normalizedA: normA, normalizedB: normB };
  }
  const tokensA = entityTokensV16(normA);
  const tokensB = entityTokensV16(normB);
  const sharedTokens = tokensA.filter((t) => tokensB.includes(t));
  if (
    sharedTokens.length >= 2 &&
    (sharedTokens.length === tokensA.length || sharedTokens.length === tokensB.length)
  ) {
    // Mot ten la tap con cua ten kia (>= 2 token chung): vd "pho bo"
    // trong "pho bo tai" — rat co the cung entity (ten day du hon).
    return { score: 0.85, reason: 'token', normalizedA: normA, normalizedB: normB };
  }
  const jaccard = tokenJaccardV16(tokensA, tokensB);
  if (jaccard >= 0.8) {
    return { score: 0.8 + jaccard * 0.1, reason: 'token', normalizedA: normA, normalizedB: normB };
  }
  if (jaccard >= 0.5) {
    return { score: 0.5 + jaccard * 0.2, reason: 'token', normalizedA: normA, normalizedB: normB };
  }
  if (normA.length >= 3 && (normB.startsWith(normA) || normA.startsWith(normB))) {
    return { score: 0.7, reason: 'affix', normalizedA: normA, normalizedB: normB };
  }
  return { score: jaccard * 0.5, reason: 'none', normalizedA: normA, normalizedB: normB };
}

/** Hai ten co phai cung entity khong (theo nguong). */
export function isSameEntityV16(
  nameA: string,
  nameB: string,
  aliasesB: string[] = [],
  threshold: number = V16_DEFAULT_LINK_THRESHOLD,
): boolean {
  return entityMatchScoreV16(nameA, nameB, aliasesB).score >= threshold;
}

/** Mot dong trong bang lien ket: ten bien the -> entity chuan. */
export interface V16EntityLink {
  /** Ten bien the (goc, chua chuan hoa). */
  variant: string;
  /** Ten chuan hoa cua bien the. */
  normalizedVariant: string;
  /** Id entity chuan. */
  canonicalId: string;
  /** Ten hien thi cua entity chuan luc ghi. */
  canonicalName: string;
  /** Loai entity. */
  kind: GraphEntity['kind'];
  /** Vi sao lien ket (exact/alias/abbreviation/token/affix/manual). */
  reason: V16EntityMatchDetail['reason'] | 'manual';
  /** Diem khop luc lien ket. */
  score: number;
  /** So lan bien the nay duoc resolve (de thay alias nao hay dung). */
  hits: number;
  createdAt: string;
  updatedAt: string;
}

/** JSON serialize cua bang lien ket (de luu file). */
export interface V16EntityLinkTableJson {
  version: 1;
  links: V16EntityLink[];
  updatedAt: string;
}

/** Ket qua resolve mot ten thanh entity. */
export interface V16ResolveResult {
  entity: GraphEntity;
  /** true = entity moi vua tao; false = tim thay entity cu. */
  created: boolean;
  /** Diem khop (1 khi tao moi hoac khop chinh xac). */
  score: number;
  /** Ly do lien ket. */
  reason: V16EntityMatchDetail['reason'] | 'manual';
  /** Ten bien the da duoc ghi alias (neu co). */
  aliasAdded: string | null;
}

/** Tuy chon cua linker. */
export interface V16EntityLinkerOptions {
  /** Nguong khop (mac dinh 0.8). */
  threshold?: number;
  /** Chi resolve trong scope nay (mac dinh: moi scope). */
  scope?: MemoryScope;
}

/**
 * Bang lien ket entity trong bo nho, tren TemporalGraphStore.
 *
 * Luong resolve: (1) tim trong bang lien ket (bien the da biet);
 * (2) `store.findEntityByName` (khop ten/alias chinh xac cua store);
 * (3) quet entity trong scope, cham diem khop, lay diem cao nhat
 * >= nguong; (4) khong co thi `ensureEntity` tao moi. Moi lan resolve
 * thanh cong deu ghi/ghi lai dong link + them alias neu ten goi khac
 * ten chuan — de lan sau tim o buoc (1)/(2) thay vi quet.
 */
export class V16EntityLinker {
  private readonly links = new Map<string, V16EntityLink>();
  private readonly threshold: number;
  private readonly scope: MemoryScope | undefined;

  constructor(
    private readonly store: TemporalGraphStore,
    opts: V16EntityLinkerOptions = {},
  ) {
    this.threshold = opts.threshold ?? V16_DEFAULT_LINK_THRESHOLD;
    this.scope = opts.scope;
  }

  /** So dong link da ghi. */
  get size(): number {
    return this.links.size;
  }

  /** Tim dong link theo ten bien the (da chuan hoa). */
  findLink(variant: string): V16EntityLink | undefined {
    return this.links.get(normalizeEntityNameV16(variant));
  }

  /** Liệt kê toàn bộ link (ban sao, moi nhat cuoi). */
  listLinks(): V16EntityLink[] {
    return [...this.links.values()]
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .map((l) => ({ ...l }));
  }

  private recordLink(
    variant: string,
    entity: GraphEntity,
    reason: V16EntityMatchDetail['reason'] | 'manual',
    score: number,
    now: string,
  ): V16EntityLink {
    const key = normalizeEntityNameV16(variant);
    const prev = this.links.get(key);
    const link: V16EntityLink = {
      variant,
      normalizedVariant: key,
      canonicalId: entity.id,
      canonicalName: entity.name,
      kind: entity.kind,
      reason,
      score,
      hits: (prev?.hits ?? 0) + 1,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };
    this.links.set(key, link);
    return link;
  }

  /** Ghi thu cong mot lien ket (user xac nhan hai ten la mot). */
  addManualLink(variant: string, canonicalId: string, now = new Date()): V16EntityLink {
    const entity = this.store.getEntity(canonicalId);
    if (!entity) {
      throw new V16EntityLinkError(`Khong tim thay entity chuan: "${canonicalId}".`);
    }
    const at = now.toISOString();
    return this.recordLink(variant, entity, 'manual', 1, at);
  }

  /**
   * Resolve mot ten thanh entity chuan trong store. Khong bao gio
   * tra ve null — khong tim thay thi tao moi.
   */
  resolve(name: string, kind: GraphEntity['kind'] = 'other', now = new Date()): V16ResolveResult {
    const clean = (name ?? '').trim();
    if (clean === '') {
      throw new V16EntityLinkError('Ten entity khong duoc rong.');
    }
    const at = now.toISOString();
    const norm = normalizeEntityNameV16(clean);

    const known = this.links.get(norm);
    if (known) {
      const entity = this.store.getEntity(known.canonicalId);
      if (entity) {
        this.recordLink(clean, entity, known.reason, known.score, at);
        return { entity, created: false, score: known.score, reason: known.reason, aliasAdded: null };
      }
      this.links.delete(norm);
    }

    const exact = this.store.findEntityByName(clean);
    if (exact) {
      this.recordLink(clean, exact, 'exact', 1, at);
      return { entity: exact, created: false, score: 1, reason: 'exact', aliasAdded: null };
    }

    let best: GraphEntity | null = null;
    let bestScore = 0;
    let bestReason: V16EntityMatchDetail['reason'] = 'none';
    for (const candidate of this.store.listEntities()) {
      if (candidate.kind !== kind && kind !== 'other' && candidate.kind !== 'other') continue;
      const detail = entityMatchScoreV16(clean, candidate.name, candidate.aliases);
      if (detail.score > bestScore) {
        bestScore = detail.score;
        best = candidate;
        bestReason = detail.reason;
      }
    }
    if (best && bestScore >= this.threshold) {
      let aliasAdded: string | null = null;
      if (normalizeEntityNameV16(best.name) !== norm) {
        const updated = this.store.addAlias(best.id, clean);
        void updated;
        aliasAdded = clean;
      }
      this.recordLink(clean, best, bestReason, bestScore, at);
      return { entity: best, created: false, score: bestScore, reason: bestReason, aliasAdded };
    }

    const created = this.store.ensureEntity(clean, kind);
    this.recordLink(clean, created, 'exact', 1, at);
    return { entity: created, created: true, score: 1, reason: 'exact', aliasAdded: null };
  }

  /** Resolve hang loat ten (tra ve theo dung thu tu dau vao). */
  resolveMany(names: string[], kind: GraphEntity['kind'] = 'other'): V16ResolveResult[] {
    return names.map((n) => this.resolve(n, kind));
  }

  /** Serialize bang lien ket sang JSON (de host luu file). */
  toJson(now = new Date()): V16EntityLinkTableJson {
    return { version: 1, links: this.listLinks(), updatedAt: now.toISOString() };
  }

  /** Nap bang lien ket tu JSON (bo qua dong hong / trung lap). */
  static fromJson(store: TemporalGraphStore, json: V16EntityLinkTableJson, opts: V16EntityLinkerOptions = {}): V16EntityLinker {
    const linker = new V16EntityLinker(store, opts);
    if (!json || json.version !== 1 || !Array.isArray(json.links)) return linker;
    for (const link of json.links) {
      if (!link || typeof link.normalizedVariant !== 'string' || typeof link.canonicalId !== 'string') continue;
      if (!store.getEntity(link.canonicalId)) continue;
      linker.links.set(link.normalizedVariant, { ...link, hits: Math.max(0, link.hits ?? 0) });
    }
    return linker;
  }
}

/** Mot cum entity trung lap tim thay khi quet. */
export interface V16DuplicateCluster {
  /** Entity giu lai (nhieu fact nhat, roi toi ten dai nhat). */
  keep: GraphEntity;
  /** Cac entity thua (se bi gop vao keep). */
  duplicates: GraphEntity[];
  /** Diem khop thap nhat trong cum. */
  minScore: number;
  /** Ly do khop pho bien nhat trong cum. */
  reason: V16EntityMatchDetail['reason'];
}

/**
 * Quet entity trong scope, gom cum trung lap theo diem khop. Chi
 * TRA VE cum — khong tu gop (caller/user duyet roi moi goi
 * `mergeEntitiesV16`). Cum duoc xep theo tong fact giam dan.
 */
export function scanDuplicateEntitiesV16(
  store: TemporalGraphStore,
  opts: { threshold?: number; scope?: MemoryScope; limit?: number } = {},
): V16DuplicateCluster[] {
  const threshold = opts.threshold ?? V16_DEFAULT_LINK_THRESHOLD;
  const entities = store.listEntities();
  const visited = new Set<string>();
  const clusters: V16DuplicateCluster[] = [];

  const factCountOf = (e: GraphEntity): number => e.factCount ?? 0;

  for (const entity of entities) {
    if (visited.has(entity.id)) continue;
    visited.add(entity.id);
    const members: Array<{ entity: GraphEntity; score: number; reason: V16EntityMatchDetail['reason'] }> = [];
    for (const other of entities) {
      if (other.id === entity.id || visited.has(other.id)) continue;
      const detail = entityMatchScoreV16(other.name, entity.name, entity.aliases);
      const reverse = entityMatchScoreV16(entity.name, other.name, other.aliases);
      const score = Math.max(detail.score, reverse.score);
      if (score >= threshold) {
        members.push({ entity: other, score, reason: score === detail.score ? detail.reason : reverse.reason });
        visited.add(other.id);
      }
    }
    if (members.length === 0) continue;
    const all = [entity, ...members.map((m) => m.entity)];
    all.sort((a, b) => factCountOf(b) - factCountOf(a) || b.name.length - a.name.length);
    const keep = all[0];
    const duplicates = all.slice(1);
    const minScore = Math.min(...members.map((m) => m.score));
    const reasonCounts = new Map<string, number>();
    for (const m of members) reasonCounts.set(m.reason, (reasonCounts.get(m.reason) ?? 0) + 1);
    const reason = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])[0][0] as V16EntityMatchDetail['reason'];
    clusters.push({ keep, duplicates, minScore, reason });
  }
  clusters.sort(
    (a, b) =>
      a.duplicates.reduce((s, e) => s + factCountOf(e), 0) -
      b.duplicates.reduce((s, e) => s + factCountOf(e), 0),
  );
  clusters.reverse();
  return opts.limit !== undefined ? clusters.slice(0, opts.limit) : clusters;
}

/** Ket qua gop mot cum entity. */
export interface V16EntityMergeResult {
  keepId: string;
  keepName: string;
  /** Id entity thua da xoa khoi store. */
  removedIds: string[];
  /** So fact da doi subject/object sang entity giu. */
  repointedFacts: number;
  /** Alias moi them vao entity giu. */
  aliasesAdded: string[];
  /** Fact trung lap sinh ra sau khi gop (cung subject+predicate+object). */
  duplicateFacts: Array<{ keepFactId: string; duplicateFactId: string }>;
  /** Id fact da gop (neu caller yeu cau gop luon fact trung). */
  mergedFactIds: string[];
}

/**
 * Gop cac entity thua vao entity giu (that, ghi vao store).
 *
 * Cach gop: voi moi fact tro toi entity thua (subject hoac object),
 * doi subjectId/objectId sang id giu — sua truc tiep tren object fact
 * ma store tra ve (cung object trong file noi bo cua store) — roi
 * goi `setFactConfidence(factId, confidence hien tai)` de store flush
 * xuong dia (store khong co API doi subject rieng; day la cach duy
 * nhat khong doi schema store). Sau do them ten thua lam alias, xoa
 * entity thua. Neu hai fact tro nen trung nhau hoan toan (cung
 * subject+predicate+object, cung status active), chung duoc liet ke
 * trong `duplicateFacts` va — neu `mergeDuplicateFacts` bat — gop
 * ngay bang `store.mergeFacts` (ban thua thanh superseded, lich su
 * van con).
 */
export function mergeEntitiesV16(
  store: TemporalGraphStore,
  keepId: string,
  duplicateIds: string[],
  opts: { actor?: string; mergeDuplicateFacts?: boolean } = {},
): V16EntityMergeResult {
  const keep = store.getEntity(keepId);
  if (!keep) throw new V16EntityLinkError(`Khong tim thay entity giu: "${keepId}".`);
  const actor = opts.actor ?? 'system';
  const removedIds: string[] = [];
  const aliasesAdded: string[] = [];
  let repointedFacts = 0;
  const duplicateFacts: Array<{ keepFactId: string; duplicateFactId: string }> = [];
  const mergedFactIds: string[] = [];

  const dupSet = new Set([...new Set(duplicateIds)].filter((id) => id !== keepId));
  for (const dupId of dupSet) {
    const dup = store.getEntity(dupId);
    if (!dup) continue;
    const affected = store
      .listFacts({ includeOtherScopes: true, limit: 100000 })
      .filter((f) => f.subjectId === dupId || f.objectId === dupId);
    for (const fact of affected) {
      let changed = false;
      if (fact.subjectId === dupId) {
        fact.subjectId = keepId;
        changed = true;
      }
      if (fact.objectId === dupId) {
        fact.objectId = keepId;
        changed = true;
      }
      if (changed) {
        repointedFacts += 1;
        store.setFactConfidence(fact.id, fact.confidence);
      }
    }
    for (const alias of [dup.name, ...dup.aliases]) {
      const normAlias = normalizeEntityNameV16(alias);
      const already =
        normalizeEntityNameV16(keep.name) === normAlias ||
        keep.aliases.some((a) => normalizeEntityNameV16(a) === normAlias);
      if (!already && normAlias !== '') {
        store.addAlias(keepId, alias);
        aliasesAdded.push(alias);
      }
    }
    const removed = store.removeEntity(dupId);
    if (removed) removedIds.push(dupId);
  }

  // Fact trung lap sinh ra sau khi gop: cung subject+predicate+object.
  const active = store
    .listFacts({ includeOtherScopes: true })
    .filter((f) => f.status === 'active');
  const seen = new Map<string, GraphFact>();
  for (const fact of active) {
    const key = [
      fact.subjectId,
      fact.predicate,
      fact.objectId ?? '',
      normalizeGraphText(fact.objectText ?? ''),
    ].join('|');
    const prev = seen.get(key);
    if (prev) {
      duplicateFacts.push({ keepFactId: prev.id, duplicateFactId: fact.id });
    } else {
      seen.set(key, fact);
    }
  }
  if (opts.mergeDuplicateFacts === true) {
    const byKeep = new Map<string, string[]>();
    for (const d of duplicateFacts) {
      const list = byKeep.get(d.keepFactId) ?? [];
      list.push(d.duplicateFactId);
      byKeep.set(d.keepFactId, list);
    }
    for (const [keepFactId, dupFactIds] of byKeep) {
      mergedFactIds.push(...store.mergeFacts(keepFactId, dupFactIds, actor));
    }
  }

  return {
    keepId,
    keepName: keep.name,
    removedIds,
    repointedFacts,
    aliasesAdded,
    duplicateFacts,
    mergedFactIds,
  };
}
