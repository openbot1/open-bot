/**
 * Memory v17 — Entity linking + collection phu `<name>_entities` (v1.36, Doi T1).
 *
 * Y tuong hoc tu mem0 v3: entity linking ghi vao collection phu
 * `<ten>_entities` rieng biet khoi collection fact; moi entity co alias,
 * kind, va typed edge noi voi entity khac / fact. Tu thiet ke lai hoan
 * toan cho open-bot, chay 100% local, KHONG copy code/text/tai san cua
 * bat ky repo nao.
 *
 *  1. Canonicalization: ten chuan hoa (trim, gom space) + alias index
 *     (khong dau, chu thuong) de \"Ha Noi\", \"Hà Nội\", \"HN\" cung chi ve
 *     1 entity neu host dang ky alias; khong tu dong gop 2 ten khac
 *     nhau khi chua co bang chung (tranh gop nham).
 *  2. Typed edge: edge giua 2 entity (vd user —lives_in→ Ha Noi) duoc
 *     ghi rieng (M17EntityEdge), co factId chung minh; edge khong co
 *     fact chung minh bi danh dau confidence thap.
 *  3. Merge co kiem soat: mergeEntities chi gop khi ten chuan hoa
 *     trung nhau hoac alias khop CHINH XAC; entity cu chuyen status
 *     merged, giu lai mergedIntoId (khong xoa).
 *  4. Scope: moi entity/edge mang scope; tim kiem chi trong scope
 *     yeu cau (loc chat, xem scope.ts).
 */

import {
  M17Error,
  M17Entity,
  M17EntityEdge,
  M17EntityKind,
  M17EntityStatus,
  M17ExtractedFact,
  M17Fact,
  M17Scope,
  M17EdgeType,
  M17_MAX_ALIASES_PER_ENTITY,
  M17_MAX_ENTITIES_PER_SCOPE,
  M17_ENTITY_COLLECTION_SUFFIX,
  entityCollectionNameM17,
  isValidEdgeTypeM17,
  isValidEntityKindM17,
  makeM17Id,
  normalizeCompareTextM17,
  normalizeEntityNameM17,
  scopesEqualM17,
  truncateTextM17,
  validateScopeM17,
} from './types';

export { M17_ENTITY_COLLECTION_SUFFIX, entityCollectionNameM17 };

/** Nguong tu dong link entity theo alias (khop chinh xac chuan hoa). */
export const M17_ENTITY_LINK_EXACT_SCORE = 1.0;
/** Nguong goi y link mo (prefix / substring) — chi goi y, khong tu link. */
export const M17_ENTITY_SUGGEST_MIN_SCORE = 0.6;

/** Loi entity linking v17. */
export class M17EntityError extends M17Error {
  constructor(message: string) {
    super(message);
    this.name = 'M17EntityError';
  }
}

/** Ket qua link 1 fact vao entity. */
export interface M17EntityLinkResult {
  /** Entity dai dien cho subject (tao moi neu chua co). */
  subjectEntity: M17Entity;
  /** Entity dai dien cho object (tao moi neu chua co). */
  objectEntity: M17Entity;
  /** Edge da tao / da ton tai. */
  edge: M17EntityEdge;
  /** Co tao entity moi khong. */
  createdSubject: boolean;
  createdObject: boolean;
  /** Co tao edge moi khong. */
  createdEdge: boolean;
}

/** Go i y link entity (chua chac chan). */
export interface M17EntitySuggestion {
  entity: M17Entity;
  score: number;
  reason: string;
}

/** Ket qua merge 2 entity. */
export interface M17EntityMergeResult {
  /** Entity giu lai. */
  survivor: M17Entity;
  /** Entity bi gop (status merged). */
  merged: M17Entity;
  /** So alias duoc chuyen sang. */
  aliasesMoved: number;
  /** So edge duoc chuyen sang. */
  edgesMoved: number;
}

/** Tuy chon cua store entity. */
export interface M17EntityStoreOptions {
  /** Ten collection fact goc (de suy ra ten collection entity). */
  factCollection?: string;
  /** Gioi han entity / scope. */
  maxEntitiesPerScope?: number;
}

/**
 * Store entity trong bo nho (in-memory) — host luu JSON bang serialize().
 * Collection phu co ten `<factCollection>_entities`; mac dinh
 * `memory_v17_entities` khi khong truyen factCollection.
 */
export class M17EntityStore {
  readonly factCollection: string;
  readonly entityCollection: string;
  private readonly maxEntitiesPerScope: number;
  private entities: M17Entity[] = [];
  private edges: M17EntityEdge[] = [];
  /** Alias index: compareKey -> entityId (chi trong cung scope). */
  private aliasIndex = new Map<string, string>();

  constructor(options: M17EntityStoreOptions = {}) {
    this.factCollection = options.factCollection ?? 'memory_v17';
    this.entityCollection = entityCollectionNameM17(this.factCollection);
    this.maxEntitiesPerScope = options.maxEntitiesPerScope ?? M17_MAX_ENTITIES_PER_SCOPE;
  }

  /** So entity hien co. */
  get entityCount(): number {
    return this.entities.length;
  }

  /** So edge hien co. */
  get edgeCount(): number {
    return this.edges.length;
  }

  /** Key alias index: scopeKey + compareKey. */
  private aliasKey(scope: M17Scope, compareKey: string): string {
    return `${scope.tenantId}\u0000${scope.userId}\u0000${scope.botId}\u0000${scope.conversationId}\u0000${compareKey}`;
  }

  /** Dang ky ten + alias vao index. */
  private indexEntity(entity: M17Entity): void {
    const keys = [entity.name, ...entity.aliases];
    for (const key of keys) {
      const compare = normalizeCompareTextM17(key);
      if (compare) this.aliasIndex.set(this.aliasKey(entity.scope, compare), entity.id);
    }
  }

  /** Bo index cua entity (khi merge / invalidate). */
  private deindexEntity(entity: M17Entity): void {
    const keys = [entity.name, ...entity.aliases];
    for (const key of keys) {
      const compare = normalizeCompareTextM17(key);
      if (!compare) continue;
      const k = this.aliasKey(entity.scope, compare);
      if (this.aliasIndex.get(k) === entity.id) this.aliasIndex.delete(k);
    }
  }

  /** Tim entity theo ten/alias chinh xac trong scope. */
  findByName(name: string, scope: M17Scope): M17Entity | null {
    const scopeError = validateScopeM17(scope);
    if (scopeError) throw new M17EntityError(scopeError);
    const compare = normalizeCompareTextM17(name);
    if (!compare) return null;
    const id = this.aliasIndex.get(this.aliasKey(scope, compare));
    if (!id) return null;
    const entity = this.entities.find((e) => e.id === id) ?? null;
    if (!entity || entity.status !== 'active') return null;
    if (!scopesEqualM17(entity.scope, scope)) return null;
    return entity;
  }

  /** Tao entity moi (hoac tra entity da co neu ten trung). */
  getOrCreate(
    name: string,
    kind: M17EntityKind,
    scope: M17Scope,
    nowIso: string,
  ): { entity: M17Entity; created: boolean } {
    const scopeError = validateScopeM17(scope);
    if (scopeError) throw new M17EntityError(scopeError);
    if (!isValidEntityKindM17(kind)) throw new M17EntityError(`Entity kind khong hop le: "${kind}".`);
    const cleanName = normalizeEntityNameM17(name);
    if (!cleanName) throw new M17EntityError('Ten entity rong.');
    const existing = this.findByName(cleanName, scope);
    if (existing) {
      existing.lastSeenAt = nowIso;
      return { entity: existing, created: false };
    }
    const inScope = this.entities.filter(
      (e) => scopesEqualM17(e.scope, scope) && e.status === 'active',
    ).length;
    if (inScope >= this.maxEntitiesPerScope) {
      throw new M17EntityError(
        `Vuot gioi han ${this.maxEntitiesPerScope} entity trong scope (tenant="${scope.tenantId}", user="${scope.userId}").`,
      );
    }
    const entity: M17Entity = {
      id: makeM17Id('ent'),
      name: cleanName,
      kind,
      aliases: [],
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
      factCount: 0,
      status: 'active',
      mergedIntoId: null,
      scope: { ...scope },
    };
    this.entities.push(entity);
    this.indexEntity(entity);
    return { entity, created: true };
  }

  /** Them alias cho entity (khong trung ten chinh / alias khac trong scope). */
  addAlias(entityId: string, alias: string, scope: M17Scope): M17Entity {
    const entity = this.entities.find((e) => e.id === entityId) ?? null;
    if (!entity) throw new M17EntityError(`Khong tim thay entity: ${entityId}.`);
    if (!scopesEqualM17(entity.scope, scope)) {
      throw new M17EntityError('Entity khong thuoc scope yeu cau — tu choi them alias.');
    }
    if (entity.status !== 'active') throw new M17EntityError('Entity khong con active.');
    const clean = normalizeEntityNameM17(alias);
    if (!clean) throw new M17EntityError('Alias rong.');
    if (entity.aliases.length >= M17_MAX_ALIASES_PER_ENTITY) {
      throw new M17EntityError(`Entity da co toi da ${M17_MAX_ALIASES_PER_ENTITY} alias.`);
    }
    const compare = normalizeCompareTextM17(clean);
    const clashId = this.aliasIndex.get(this.aliasKey(scope, compare));
    if (clashId && clashId !== entity.id) {
      throw new M17EntityError(`Alias "${clean}" da thuoc entity khac trong cung scope.`);
    }
    if (normalizeCompareTextM17(entity.name) === compare) return entity;
    if (!entity.aliases.some((a) => normalizeCompareTextM17(a) === compare)) {
      entity.aliases.push(clean);
      this.indexEntity(entity);
    }
    return entity;
  }

  /** Tao hoac lay edge giua 2 entity (dedupe theo from/to/edge/scope). */
  getOrCreateEdge(
    fromEntityId: string,
    toEntityId: string,
    edge: M17EdgeType,
    scope: M17Scope,
    factId: string | null,
    confidence: number,
    nowIso: string,
  ): { edge: M17EntityEdge; created: boolean } {
    if (!isValidEdgeTypeM17(edge)) throw new M17EntityError(`Edge khong hop le: "${edge}".`);
    const scopeError = validateScopeM17(scope);
    if (scopeError) throw new M17EntityError(scopeError);
    const from = this.entities.find((e) => e.id === fromEntityId) ?? null;
    const to = this.entities.find((e) => e.id === toEntityId) ?? null;
    if (!from || !to) throw new M17EntityError('Edge tro toi entity khong ton tai.');
    if (!scopesEqualM17(from.scope, scope) || !scopesEqualM17(to.scope, scope)) {
      throw new M17EntityError('Edge chi noi 2 entity trong cung scope.');
    }
    const existing = this.edges.find(
      (e) =>
        e.fromEntityId === fromEntityId &&
        e.toEntityId === toEntityId &&
        e.edge === edge &&
        scopesEqualM17(e.scope, scope),
    );
    if (existing) {
      if (factId && !existing.factId) existing.factId = factId;
      if (confidence > existing.confidence) existing.confidence = confidence;
      return { edge: existing, created: false };
    }
    const created: M17EntityEdge = {
      id: makeM17Id('edge'),
      fromEntityId,
      toEntityId,
      edge,
      factId,
      confidence,
      createdAt: nowIso,
      scope: { ...scope },
    };
    this.edges.push(created);
    return { edge: created, created: true };
  }

  /**
   * Link 1 fact vao entity: tao/lay entity subject + object, tao typed
   * edge, tang factCount. Subject \"user\" duoc map thanh entity person
   * ten theo scope.userId (de graph co nut user on dinh).
   */
  linkFact(
    fact: M17Fact | M17ExtractedFact,
    scope: M17Scope,
    nowIso: string,
    factId: string | null = null,
  ): M17EntityLinkResult {
    const subjectName = fact.subject === 'user' ? `user:${scope.userId}` : fact.subject;
    const subjectKind: M17EntityKind = fact.subject === 'user' ? 'person' : 'other';
    const subject = this.getOrCreate(subjectName, subjectKind, scope, nowIso);
    const mentioned = 'mentionedEntities' in fact ? fact.mentionedEntities : [];
    const objectKind: M17EntityKind =
      mentioned.length > 0 ? mentioned[0].kind : 'other';
    const object = this.getOrCreate(fact.object, objectKind, scope, nowIso);
    subject.entity.factCount += 1;
    object.entity.factCount += 1;
    const edge = this.getOrCreateEdge(
      subject.entity.id,
      object.entity.id,
      fact.edge,
      scope,
      factId,
      fact.confidence,
      nowIso,
    );
    return {
      subjectEntity: subject.entity,
      objectEntity: object.entity,
      edge: edge.edge,
      createdSubject: subject.created,
      createdObject: object.created,
      createdEdge: edge.created,
    };
  }

  /** Goi y entity co the khop (prefix/substring) — chi goi y, khong tu link. */
  suggestEntities(
    name: string,
    scope: M17Scope,
    limit = 5,
  ): M17EntitySuggestion[] {
    const scopeError = validateScopeM17(scope);
    if (scopeError) throw new M17EntityError(scopeError);
    const query = normalizeCompareTextM17(name);
    if (!query) return [];
    const suggestions: M17EntitySuggestion[] = [];
    for (const entity of this.entities) {
      if (entity.status !== 'active') continue;
      if (!scopesEqualM17(entity.scope, scope)) continue;
      const names = [entity.name, ...entity.aliases];
      let best = 0;
      let reason = '';
      for (const candidate of names) {
        const compare = normalizeCompareTextM17(candidate);
        if (!compare) continue;
        if (compare === query) {
          best = M17_ENTITY_LINK_EXACT_SCORE;
          reason = 'khop chinh xac';
          break;
        }
        if (compare.startsWith(query) || query.startsWith(compare)) {
          const score = 0.8;
          if (score > best) {
            best = score;
            reason = 'tien to khop';
          }
        } else if (compare.includes(query) || query.includes(compare)) {
          const score = 0.65;
          if (score > best) {
            best = score;
            reason = 'chuoi con khop';
          }
        }
      }
      if (best >= M17_ENTITY_SUGGEST_MIN_SCORE) {
        suggestions.push({ entity, score: best, reason });
      }
    }
    return suggestions
      .sort((a, b) => b.score - a.score || b.entity.factCount - a.entity.factCount)
      .slice(0, limit);
  }

  /** Merge entity nguon vao entity dich (chi khi ten/alias khop chinh xac hoac host xac nhan). */
  mergeEntities(
    sourceId: string,
    targetId: string,
    scope: M17Scope,
    reason: string,
  ): M17EntityMergeResult {
    if (sourceId === targetId) throw new M17EntityError('Khong the merge entity voi chinh no.');
    const source = this.entities.find((e) => e.id === sourceId) ?? null;
    const target = this.entities.find((e) => e.id === targetId) ?? null;
    if (!source || !target) throw new M17EntityError('Khong tim thay entity de merge.');
    if (!scopesEqualM17(source.scope, scope) || !scopesEqualM17(target.scope, scope)) {
      throw new M17EntityError('Chi merge 2 entity trong cung scope.');
    }
    if (source.status !== 'active' || target.status !== 'active') {
      throw new M17EntityError('Chi merge entity dang active.');
    }
    if (!reason || !reason.trim()) throw new M17EntityError('Merge can ly do (provenance).');
    this.deindexEntity(source);
    let aliasesMoved = 0;
    const aliasCandidates = [source.name, ...source.aliases];
    for (const alias of aliasCandidates) {
      const compare = normalizeCompareTextM17(alias);
      if (!compare) continue;
      if (normalizeCompareTextM17(target.name) === compare) continue;
      if (target.aliases.some((a) => normalizeCompareTextM17(a) === compare)) continue;
      if (target.aliases.length >= M17_MAX_ALIASES_PER_ENTITY) break;
      target.aliases.push(normalizeEntityNameM17(alias));
      aliasesMoved += 1;
    }
    let edgesMoved = 0;
    for (const edge of this.edges) {
      if (edge.fromEntityId === sourceId) {
        edge.fromEntityId = targetId;
        edgesMoved += 1;
      }
      if (edge.toEntityId === sourceId) {
        edge.toEntityId = targetId;
        edgesMoved += 1;
      }
    }
    // Loai edge trung lap sau merge (cung from/to/edge).
    const seen = new Set<string>();
    this.edges = this.edges.filter((edge) => {
      const key = `${edge.fromEntityId}|${edge.toEntityId}|${edge.edge}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    source.status = 'merged';
    source.mergedIntoId = targetId;
    target.factCount += source.factCount;
    target.lastSeenAt = new Date().toISOString();
    this.indexEntity(target);
    return { survivor: target, merged: source, aliasesMoved, edgesMoved };
  }

  /** Liet ke entity trong scope (loc theo kind / tu khoa, phan trang). */
  listEntities(
    scope: M17Scope,
    options: { kind?: M17EntityKind; query?: string; limit?: number; offset?: number } = {},
  ): { entities: M17Entity[]; total: number } {
    const scopeError = validateScopeM17(scope);
    if (scopeError) throw new M17EntityError(scopeError);
    const query = options.query ? normalizeCompareTextM17(options.query) : '';
    const filtered = this.entities.filter((e) => {
      if (e.status !== 'active') return false;
      if (!scopesEqualM17(e.scope, scope)) return false;
      if (options.kind && e.kind !== options.kind) return false;
      if (query) {
        const hay = normalizeCompareTextM17([e.name, ...e.aliases].join(' '));
        if (!hay.includes(query)) return false;
      }
      return true;
    });
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.max(1, Math.min(200, options.limit ?? 50));
    return {
      entities: filtered
        .sort((a, b) => b.factCount - a.factCount || b.lastSeenAt.localeCompare(a.lastSeenAt))
        .slice(offset, offset + limit),
      total: filtered.length,
    };
  }

  /** Liet ke edge cua 1 entity (ca 2 chieu). */
  edgesOf(entityId: string, scope: M17Scope): M17EntityEdge[] {
    return this.edges.filter(
      (e) =>
        (e.fromEntityId === entityId || e.toEntityId === entityId) &&
        scopesEqualM17(e.scope, scope),
    );
  }

  /** Entity mo coi: active nhung factCount = 0 (de host don dep). */
  orphanEntities(scope: M17Scope): M17Entity[] {
    return this.entities.filter(
      (e) => e.status === 'active' && e.factCount === 0 && scopesEqualM17(e.scope, scope),
    );
  }

  /** Xoa entity mo coi (chi xoa khi factCount = 0 va khong co edge). */
  pruneOrphans(scope: M17Scope): number {
    let removed = 0;
    for (const entity of [...this.entities]) {
      if (entity.status !== 'active' || entity.factCount !== 0) continue;
      if (!scopesEqualM17(entity.scope, scope)) continue;
      if (this.edgesOf(entity.id, scope).length > 0) continue;
      this.deindexEntity(entity);
      this.entities = this.entities.filter((e) => e.id !== entity.id);
      removed += 1;
    }
    return removed;
  }

  /** Serialize toan bo store (de host luu file). */
  serialize(): { entities: M17Entity[]; edges: M17EntityEdge[] } {
    return {
      entities: this.entities.map((e) => ({ ...e, aliases: [...e.aliases], scope: { ...e.scope } })),
      edges: this.edges.map((e) => ({ ...e, scope: { ...e.scope } })),
    };
  }

  /** Khoi phuc tu JSON (ghi de toan bo store hien tai). */
  deserialize(data: { entities?: M17Entity[]; edges?: M17EntityEdge[] }): void {
    this.entities = (data.entities ?? []).map((e) => ({
      ...e,
      aliases: [...(e.aliases ?? [])],
      scope: { ...e.scope },
    }));
    this.edges = (data.edges ?? []).map((e) => ({ ...e, scope: { ...e.scope } }));
    this.aliasIndex.clear();
    for (const entity of this.entities) {
      if (entity.status === 'active') this.indexEntity(entity);
    }
  }

  /** Dem nhanh theo kind trong scope. */
  statsByKind(scope: M17Scope): Record<string, number> {
    const stats: Record<string, number> = {};
    for (const entity of this.entities) {
      if (entity.status !== 'active') continue;
      if (!scopesEqualM17(entity.scope, scope)) continue;
      stats[entity.kind] = (stats[entity.kind] ?? 0) + 1;
    }
    return stats;
  }
}

/** Ten hien thi rut gon cua entity (de log / UI). */
export function describeEntityM17(entity: M17Entity): string {
  const aliasPart = entity.aliases.length > 0 ? ` (aka ${entity.aliases.slice(0, 3).join(', ')})` : '';
  return `${entity.name} [${entity.kind}]${aliasPart} — ${entity.factCount} fact`;
}

/** Cat ngan ten entity de hien thi. */
export function shortEntityNameM17(name: string, maxChars = 40): string {
  return truncateTextM17(normalizeEntityNameM17(name), maxChars);
}
