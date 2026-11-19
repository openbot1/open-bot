/**
 * Memory v27 — entity registry: linking luc ghi + boosting luc
 * search (v1.42, Doi T3).
 *
 * Y tuong hoc tu Mem0 v3 (survey v142 muc 3): entity linking
 * luc ghi + entity boosting luc search. Tu thiet ke lai hoan
 * toan cho open-bot, rule-based chay local, khong goi model.
 *
 * Luong:
 *   - LUC GHI (ingest): moi mention trong cau duoc link ve 1
 *     entity chuan ngay — khop exact ten chuan -> alias -> fuzzy
 *     overlap token; khong khop thi TAO entity moi (kind suy
 *     ra tu ngu canh, mac dinh 'unknown'). Fact luu entityIds.
 *   - LUC SEARCH: query duoc tach mention, link ve entity, entity
 *     nao xuat hien trong fact thi CONG DIEM boost — trong so
 *     tinh tu mentionCount + do moi (cap o 1), khong phai so
 *     mu vo han.
 *   - Merge alias: 2 entity cung chi 1 thuc the thi gop alias
 *     vao entity giu lai; entity bi gop KHONG bi xoa vat ly ma
 *     danh dau mergedIntoId (add-only: lich su con nguyen).
 *
 * Kind suy ra tu ngu canh: mention sau "lives in / song o" la
 * place; sau "works at" la org; ten nguoi viet hoa 1-2 tu + lam
 * subject cua "likes/is" thuong la person; mac dinh unknown.
 */
import {
  errV27,
  isoAtV27,
  makeV27Id,
  normalizeTextV27,
  okV27,
  tokenizeV27,
  truncateV27,
  V27_LIMITS,
  isV27EntityKind,
  type V27Entity,
  type V27EntityBoost,
  type V27EntityInput,
  type V27EntityKind,
  type V27EntityLink,
  type V27Result,
} from './types';
import { makeV25Scope, type V25Scope } from '../v25/types';

/** Nguong overlap token toi thieu cho fuzzy link (mac dinh 0.6). */
const DEFAULT_FUZZY_THRESHOLD = 0.6;

/** Tu dung chung khong bao gio la entity (stopword viet hoa). */
const ENTITY_STOPWORDS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those',
  'i', 'you', 'he', 'she', 'we', 'they', 'it',
  'toi', 'tôi', 'minh', 'mình', 'anh', 'chi', 'chị', 'em', 'ban', 'bạn',
  'my', 'your', 'his', 'her', 'our', 'their',
  'and', 'or', 'but', 'if', 'when', 'where', 'what', 'how', 'why',
  'va', 'và', 'hoac', 'hoặc', 'nhung', 'nhưng', 'neu', 'nếu', 'khi',
  'is', 'are', 'was', 'were', 'la', 'là', 'co', 'có',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december',
]);

/** Suy kind tu ngu canh cau: tu khoa quanh mention. */
export function inferEntityKindV27(mention: string, sentence: string): V27EntityKind {
  const lower = normalizeTextV27(sentence);
  const mentionLower = normalizeTextV27(mention);
  const after = lower.split(mentionLower)[1] ?? '';
  const before = lower.split(mentionLower)[0] ?? '';
  void after;
  if (/(lives?\s+in|song\s+(o|ở)|sống\s+(ở|o)|ở\s+tại|in\s+ho\s+chi|saigon|sài gòn|hanoi|hà nội|danang|đà nẵng)\b/u.test(lower)) {
    if (before.match(/(lives?\s+in|song\s+(o|ở)|sống\s+(ở|o))\s*$/u)) return 'place';
  }
  if (/(works?\s+(at|in|for)|làm việc\s+(tại|tai|ở|o)|lam\s+viec\s+(tai|o))\s*$/u.test(before)) return 'org';
  if (/(uses?|dùng|dung|sử dụng)\s*$/u.test(before)) return 'tool';
  if (/(project|dự án|du\s+an)\s*$/u.test(before)) return 'project';
  // Ten nguoi: 1-2 tu, moi tu viet hoa chu cai dau, lam subject.
  const words = mention.trim().split(/\s+/u);
  if (words.length <= 2 && words.every((w) => /^[A-ZÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚÝĂÂĐÊÔƠƯ]/.test(w))) {
    return 'person';
  }
  return 'unknown';
}

/** Overlap token Jaccard giua 2 chuoi (0..1) — cho fuzzy link. */
export function tokenOverlapV27(a: string, b: string): number {
  const setA = new Set(tokenizeV27(a));
  const setB = new Set(tokenizeV27(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Registry entity: map id + chi muc theo ten chuan hoa + alias. */
export class V27EntityRegistry {
  private readonly entities = new Map<string, V27Entity>();
  /** Ten chuan hoa -> id entity (ke ca alias). */
  private readonly nameIndex = new Map<string, string>();
  private readonly fuzzyThreshold: number;

  constructor(opts: { fuzzyThreshold?: number } = {}) {
    this.fuzzyThreshold = opts.fuzzyThreshold ?? DEFAULT_FUZZY_THRESHOLD;
  }

  get size(): number {
    return this.entities.size;
  }

  /** Lay entity theo id (ke ca da merge). */
  get(id: string): V27Entity | undefined {
    return this.entities.get(id);
  }

  /** Lay entity theo ten chuan hoa hoac alias (khop chinh xac). */
  getByName(name: string): V27Entity | undefined {
    const id = this.nameIndex.get(normalizeTextV27(name));
    return id ? this.entities.get(id) : undefined;
  }

  /** Tat ca entity (moi nhat truoc theo lastMentionedAt). */
  list(filter: { kind?: V27EntityKind; scope?: V25Scope; limit?: number } = {}): V27Entity[] {
    const out: V27Entity[] = [];
    for (const entity of this.entities.values()) {
      if (filter.kind && entity.kind !== filter.kind) continue;
      if (filter.scope) {
        const q = filter.scope;
        if (q.userId && entity.scope.userId !== q.userId) continue;
        if (q.agentId && entity.scope.agentId !== q.agentId) continue;
        if (q.appId && entity.scope.appId !== q.appId) continue;
      }
      out.push(entity);
    }
    out.sort((a, b) => (a.lastMentionedAt < b.lastMentionedAt ? 1 : -1));
    if (filter.limit !== undefined) return out.slice(0, Math.max(0, filter.limit));
    return out;
  }

  /** Dem entity theo kind. */
  countByKind(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const entity of this.entities.values()) {
      out[entity.kind] = (out[entity.kind] ?? 0) + 1;
    }
    return out;
  }

  /**
   * Dang ky entity moi hoac tra entity da co cung ten.
   * Ten rong / stopword / qua dai thi tu choi.
   */
  register(
    input: V27EntityInput,
    opts: { nowMs?: number } = {},
  ): V27Result<V27Entity> {
    const name = input.name.trim();
    if (!name) return errV27('Ten entity khong duoc rong.');
    if (name.length > V27_LIMITS.maxEntityNameChars) {
      return errV27(`Ten entity qua dai (toi da ${V27_LIMITS.maxEntityNameChars} ky tu).`);
    }
    if (ENTITY_STOPWORDS.has(normalizeTextV27(name))) {
      return errV27(`"${name}" la tu dung chung, khong dang ky lam entity.`);
    }
    const existing = this.getByName(name);
    if (existing) return okV27(existing);
    if (this.entities.size >= V27_LIMITS.maxEntities) {
      return errV27(`Registry da day (${V27_LIMITS.maxEntities} entity) — gop alias thay vi tao moi.`);
    }
    const nowMs = opts.nowMs ?? Date.now();
    const nowIso = isoAtV27(nowMs);
    const kind: V27EntityKind =
      input.kind && isV27EntityKind(input.kind) ? input.kind : 'unknown';
    const aliases = [...new Set((input.aliases ?? []).map((a) => a.trim()).filter(Boolean))]
      .slice(0, V27_LIMITS.maxAliasesPerEntity);
    const entity: V27Entity = {
      id: makeV27Id('ent'),
      name,
      normalizedName: normalizeTextV27(name),
      aliases,
      kind,
      mentionCount: 0,
      activeFactCount: 0,
      lastMentionedAt: nowIso,
      createdAt: nowIso,
      scope: makeV25Scope(input.scope ?? {}),
    };
    this.entities.set(entity.id, entity);
    this.nameIndex.set(entity.normalizedName, entity.id);
    for (const alias of aliases) {
      const key = normalizeTextV27(alias);
      if (!this.nameIndex.has(key)) this.nameIndex.set(key, entity.id);
    }
    return okV27(entity);
  }

  /**
   * Link 1 mention ve entity — LUC GHI.
   * Thu tu: exact ten chuan -> exact alias -> fuzzy overlap ->
   * tao moi. Mention nao cung co ket qua (khong bao gio 'none'
   * khi tao moi duoc — chi 'none' khi mention la stopword).
   */
  linkMention(
    mention: string,
    opts: {
      sentence?: string;
      scope?: Partial<V25Scope>;
      nowMs?: number;
      /** true = duoc phep tao entity moi khi khong khop. */
      createIfMissing?: boolean;
    } = {},
  ): V27EntityLink {
    const clean = mention.trim();
    const nowMs = opts.nowMs ?? Date.now();
    const nowIso = isoAtV27(nowMs);
    const noMatch: V27EntityLink = {
      mention: clean,
      entityId: '',
      entityName: clean,
      kind: 'unknown',
      created: false,
      match: 'none',
      confidence: 0,
    };
    if (!clean || clean.length < 2) return noMatch;
    if (ENTITY_STOPWORDS.has(normalizeTextV27(clean))) return noMatch;
    const key = normalizeTextV27(clean);
    // 1. Exact: ten chuan hoac alias (phan biet: khop ten chuan
    // thi 'exact', khop alias thi 'alias').
    const exactId = this.nameIndex.get(key);
    if (exactId) {
      const entity = this.entities.get(exactId);
      if (entity) {
        entity.mentionCount++;
        entity.lastMentionedAt = nowIso;
        const isCanonical = entity.normalizedName === key;
        return {
          mention: clean, entityId: entity.id, entityName: entity.name,
          kind: entity.kind, created: false,
          match: isCanonical ? 'exact' : 'alias',
          confidence: isCanonical ? 1 : 0.95,
        };
      }
    }
    // 2. Fuzzy: overlap token cao nhat, vuot nguong.
    let best: V27Entity | null = null;
    let bestScore = 0;
    for (const entity of this.entities.values()) {
      const score = Math.max(
        tokenOverlapV27(clean, entity.name),
        ...entity.aliases.map((a) => tokenOverlapV27(clean, a)),
      );
      if (score > bestScore) {
        bestScore = score;
        best = entity;
      }
    }
    if (best && bestScore >= this.fuzzyThreshold) {
      best.mentionCount++;
      best.lastMentionedAt = nowIso;
      // Ghi nho dang viet khac nay lam alias (de lan sau exact).
      if (
        best.aliases.length < V27_LIMITS.maxAliasesPerEntity &&
        !best.aliases.some((a) => normalizeTextV27(a) === key)
      ) {
        best.aliases.push(clean);
        this.nameIndex.set(key, best.id);
      }
      return {
        mention: clean, entityId: best.id, entityName: best.name,
        kind: best.kind, created: false, match: 'fuzzy', confidence: bestScore,
      };
    }
    // 3. Tao moi (neu duoc phep).
    if (opts.createIfMissing === false) return noMatch;
    const kind = inferEntityKindV27(clean, opts.sentence ?? '');
    const created = this.register(
      { name: clean, kind, scope: opts.scope },
      { nowMs },
    );
    if (!created.ok) return noMatch;
    created.value.mentionCount = 1;
    created.value.lastMentionedAt = nowIso;
    return {
      mention: clean, entityId: created.value.id, entityName: created.value.name,
      kind, created: true, match: 'exact', confidence: 0.7,
    };
  }

  /** Link nhieu mention 1 luc (dedup theo ten chuan hoa). */
  linkMentions(
    mentions: string[],
    opts: {
      sentence?: string;
      scope?: Partial<V25Scope>;
      nowMs?: number;
      createIfMissing?: boolean;
    } = {},
  ): V27EntityLink[] {
    const out: V27EntityLink[] = [];
    const seen = new Set<string>();
    for (const mention of mentions) {
      const key = normalizeTextV27(mention);
      if (seen.has(key)) continue;
      seen.add(key);
      const link = this.linkMention(mention, opts);
      if (link.match !== 'none') out.push(link);
    }
    return out;
  }

  /**
   * Gop 2 entity: alias + mentionCount cua `from` chuyen sang
   * `into`; entity `from` duoc danh dau mergedIntoId (KHONG xoa
   * vat ly — lich su con nguyen, get() van tra ve voi flag).
   */
  merge(
    fromId: string,
    intoId: string,
    opts: { nowMs?: number; by?: string } = {},
  ): V27Result<V27Entity> {
    if (fromId === intoId) return errV27('Khong the gop 1 entity vao chinh no.');
    const from = this.entities.get(fromId);
    const into = this.entities.get(intoId);
    if (!from) return errV27(`Khong co entity "${fromId}".`);
    if (!into) return errV27(`Khong co entity "${intoId}".`);
    if (from.mergedIntoId) return errV27(`Entity "${from.name}" da gop vao "${from.mergedIntoId}".`);
    const nowIso = isoAtV27(opts.nowMs ?? Date.now());
    void nowIso;
    void opts.by;
    // Chuyen alias (khong trung) + so lieu.
    for (const alias of [from.name, ...from.aliases]) {
      const key = normalizeTextV27(alias);
      if (!into.aliases.some((a) => normalizeTextV27(a) === key) && normalizeTextV27(into.name) !== key) {
        if (into.aliases.length < V27_LIMITS.maxAliasesPerEntity) into.aliases.push(alias);
      }
      this.nameIndex.set(key, into.id);
    }
    into.mentionCount += from.mentionCount;
    into.activeFactCount += from.activeFactCount;
    if (from.lastMentionedAt > into.lastMentionedAt) into.lastMentionedAt = from.lastMentionedAt;
    from.mergedIntoId = into.id;
    return okV27(into);
  }

  /**
   * Cap nhat activeFactCount cho 1 entity (goi khi fact them/dong).
   * delta = +1 (fact moi) hoac -1 (fact bi supersede/expire).
   */
  bumpFactCount(entityId: string, delta: number): void {
    const entity = this.entities.get(entityId);
    if (!entity) return;
    entity.activeFactCount = Math.max(0, entity.activeFactCount + delta);
  }

  /**
   * Trong so boosting cua 1 entity luc search.
   * Cong thuc: 0.3 co so + 0.4 theo log(mentionCount) + 0.3 theo
   * do moi (mention trong 30 ngay) — cap o 1. Entity moi, it
   * mention thi boost thap; entity quen thuoc, moi dung thi cao.
   */
  boostFor(entity: V27Entity, nowMs: number = Date.now()): V27EntityBoost {
    const mentionPart = Math.min(0.4, 0.12 * Math.log10(1 + entity.mentionCount));
    const lastMs = Date.parse(entity.lastMentionedAt);
    const ageDays = Number.isNaN(lastMs) ? 365 : Math.max(0, (nowMs - lastMs) / 86400000);
    const recencyPart = ageDays <= 30 ? 0.3 * (1 - ageDays / 30) : 0;
    const weight = Math.min(1, Math.max(0, 0.3 + mentionPart + recencyPart));
    return {
      entityId: entity.id,
      entityName: entity.name,
      weight: Math.round(weight * 1000) / 1000,
      mentionCount: entity.mentionCount,
      lastMentionedAt: entity.lastMentionedAt,
    };
  }

  /** Trong so boosting cho nhieu entity (tra theo id). */
  boostsFor(ids: string[], nowMs: number = Date.now()): Map<string, V27EntityBoost> {
    const out = new Map<string, V27EntityBoost>();
    for (const id of ids) {
      const entity = this.entities.get(id);
      if (entity) out.set(id, this.boostFor(entity, nowMs));
    }
    return out;
  }

  toJSON(): V27Entity[] {
    return [...this.entities.values()];
  }

  static fromJSON(data: unknown, opts: { fuzzyThreshold?: number } = {}): V27EntityRegistry {
    const registry = new V27EntityRegistry(opts);
    if (!Array.isArray(data)) return registry;
    for (const raw of data as V27Entity[]) {
      if (!raw || typeof raw.id !== 'string') continue;
      registry.entities.set(raw.id, {
        ...raw,
        aliases: Array.isArray(raw.aliases) ? raw.aliases : [],
      });
      registry.nameIndex.set(normalizeTextV27(raw.name), raw.id);
      for (const alias of raw.aliases ?? []) {
        const key = normalizeTextV27(alias);
        if (!registry.nameIndex.has(key)) registry.nameIndex.set(key, raw.id);
      }
    }
    return registry;
  }
}
