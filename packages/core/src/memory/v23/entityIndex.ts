/**
 * Memory v23 — entity index (v1.38, Doi T1).
 *
 * Tin hieu thu ba cua retrieval fusion: entity. Index anh xa
 * entity (da chuan hoa) -> tap record id, kem alias + dong xuat
 * hien (co-occurrence) de mo rong query ("ca phe" cung thay voi
 * "buoi sang" thi tim ca hai).
 *
 * Trich entity kieu luat (khong can model):
 *  - Cum tu viet hoa (ten rieng, vd "Ha Noi", "Nguyen Van A").
 *  - Cum trong dau ngoac kep / dau backtick.
 *  - Chuoi `word: value` / hashtag `#tag` / @mention.
 *  - Tu khoa nhan manh co san trong tu dien mo rong cua caller.
 *
 * Index chi luu trong RAM; store v23 tai tao lai index khi load
 * tu file (xem store.ts). Moi thao tac deu thuan tuy / dong bo.
 */

import { normalizeV23Text, tokenizeV23 } from './types';

/** Entity da chuan hoa (viet thuong, bo dau cau thua). */
export function normalizeEntityV23(raw: string): string {
  return normalizeV23Text(raw)
    .toLowerCase()
    .replace(/^[#@'\"`]+/, '')
    .replace(/['\"`]+$/, '')
    .replace(/[^\p{L}\p{N} ._-]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Alias mac dinh: cach viet khac nhau cua cung mot entity. */
export const V23_ENTITY_ALIASES: Readonly<Record<string, string>> = {
  'hn': 'ha noi',
  'hcm': 'ho chi minh',
  'tp hcm': 'ho chi minh',
  'sai gon': 'ho chi minh',
  'sg': 'ho chi minh',
  'usa': 'my',
  'us': 'my',
  'uk': 'anh',
  'ai': 'tri tue nhan tao',
};

/** Giai alias ve dang chuan (neu co). */
export function resolveEntityAliasV23(entity: string): string {
  const norm = normalizeEntityV23(entity);
  return V23_ENTITY_ALIASES[norm] ?? norm;
}

/** Mau cum viet hoa: 2+ tu, moi tu viet hoa chu cai dau (ke ca tieng Viet co dau). */
const CAPITALIZED_PHRASE = /(\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+)+)/gu;
/** Cum trong ngoac kep hoac backtick. */
const QUOTED_PHRASE = /["“”`'‘’]([^"“”`'‘’]{2,60})["“”`'‘’]/gu;
/** Hashtag / mention. */
const HASH_MENTION = /[#@]([\p{L}\p{N}_-]{2,40})/gu;
/** Cap `key: value` ngan. */
const KEY_VALUE = /\b([\p{L}][\p{L}\p{N} _-]{1,30})\s*:\s*([\p{L}\p{N}][^\n,;]{1,40})/gu;

/** Tu thuong gap o dau cau nhung khong phai entity (bo qua). */
const NON_ENTITY_STARTERS = new Set([
  'toi', 'ban', 'anh', 'chi', 'em', 'chung', 'hom', 'ngay', 'thang', 'nam',
  'sang', 'trua', 'chieu', 'toi', 'thu', 'khi', 'neu', 'vi', 'nhung', 'tuy',
  'i', 'you', 'he', 'she', 'we', 'they', 'the', 'this', 'that', 'today',
  'yesterday', 'tomorrow', 'monday', 'tuesday', 'wednesday', 'thursday',
  'friday', 'saturday', 'sunday',
]);

/**
 * Trich entity tu text bang luat. Tra ve danh sach duy nhat, da
 * chuan hoa + giai alias, giu thu tu xuat hien. `extraKeywords`
 * la tu dien mo rong cua caller (vd ten du an, ten tool).
 */
export function extractEntitiesV23(text: string, extraKeywords: string[] = []): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    const norm = resolveEntityAliasV23(raw);
    if (!norm || norm.length < 2 || norm.length > 60) return;
    if (seen.has(norm)) return;
    const first = norm.split(' ')[0];
    if (NON_ENTITY_STARTERS.has(first) && !norm.includes(' ')) return;
    seen.add(norm);
    found.push(norm);
  };

  for (const m of text.matchAll(QUOTED_PHRASE)) push(m[1]);
  for (const m of text.matchAll(HASH_MENTION)) push(m[1]);
  for (const m of text.matchAll(KEY_VALUE)) {
    push(m[2].trim());
  }
  for (const m of text.matchAll(CAPITALIZED_PHRASE)) {
    const phrase = m[1];
    const first = phrase.split(' ')[0].toLowerCase();
    if (NON_ENTITY_STARTERS.has(first)) continue;
    push(phrase);
  }
  const lowered = ` ${text.toLowerCase()} `;
  for (const kw of extraKeywords) {
    const norm = normalizeEntityV23(kw);
    if (norm && lowered.includes(` ${norm} `)) push(norm);
  }
  return found;
}

/** Thong ke mot entity trong index. */
export interface V23EntityInfo {
  entity: string;
  /** So record chua entity nay. */
  recordCount: number;
  /** Entity hay xuat hien chung nhat (toi da 10, kem so lan). */
  coOccurring: { entity: string; count: number }[];
}

/**
 * Index entity -> record id, kem dem co-occurrence.
 * Moi record chi tinh 1 lan cho moi entity (du text nhac nhieu lan).
 */
export class V23EntityIndex {
  private readonly byEntity = new Map<string, Set<string>>();
  private readonly coOccur = new Map<string, Map<string, number>>();
  /** So record da index. */
  recordCount = 0;

  /** So entity rieng biet trong index. */
  size(): number {
    return this.byEntity.size;
  }

  /** Them mot record (id + entity list da chuan hoa). */
  addRecord(recordId: string, entities: string[]): void {
    const unique = [...new Set(entities.map((e) => resolveEntityAliasV23(e)).filter(Boolean))];
    if (unique.length === 0) return;
    this.recordCount += 1;
    for (const entity of unique) {
      let set = this.byEntity.get(entity);
      if (!set) {
        set = new Set<string>();
        this.byEntity.set(entity, set);
      }
      set.add(recordId);
    }
    for (let i = 0; i < unique.length; i += 1) {
      for (let j = 0; j < unique.length; j += 1) {
        if (i === j) continue;
        let row = this.coOccur.get(unique[i]);
        if (!row) {
          row = new Map<string, number>();
          this.coOccur.set(unique[i], row);
        }
        row.set(unique[j], (row.get(unique[j]) ?? 0) + 1);
      }
    }
  }

  /** Go mot record khoi index (khi xoa / doi entity). */
  removeRecord(recordId: string, entities: string[]): void {
    const unique = [...new Set(entities.map((e) => resolveEntityAliasV23(e)).filter(Boolean))];
    if (unique.length === 0) return;
    this.recordCount = Math.max(0, this.recordCount - 1);
    for (const entity of unique) {
      const set = this.byEntity.get(entity);
      if (!set) continue;
      set.delete(recordId);
      if (set.size === 0) this.byEntity.delete(entity);
    }
    for (let i = 0; i < unique.length; i += 1) {
      for (let j = 0; j < unique.length; j += 1) {
        if (i === j) continue;
        const row = this.coOccur.get(unique[i]);
        if (!row) continue;
        const next = (row.get(unique[j]) ?? 0) - 1;
        if (next <= 0) row.delete(unique[j]);
        else row.set(unique[j], next);
        if (row.size === 0) this.coOccur.delete(unique[i]);
      }
    }
  }

  /** Xoa sach index. */
  clear(): void {
    this.byEntity.clear();
    this.coOccur.clear();
    this.recordCount = 0;
  }

  /** Cac record id chua entity (da giai alias). */
  recordsFor(entity: string): string[] {
    const set = this.byEntity.get(resolveEntityAliasV23(entity));
    return set ? [...set].sort() : [];
  }

  /** Entity co trong index khong. */
  has(entity: string): boolean {
    return this.byEntity.has(resolveEntityAliasV23(entity));
  }

  /** Tat ca entity, sap theo so record giam dan (gioi han `limit`). */
  topEntities(limit = 20): { entity: string; count: number }[] {
    return [...this.byEntity.entries()]
      .map(([entity, set]) => ({ entity, count: set.size }))
      .sort((a, b) => b.count - a.count || a.entity.localeCompare(b.entity))
      .slice(0, Math.max(0, limit));
  }

  /** Thong ke chi tiet mot entity (kem co-occurrence). */
  info(entity: string): V23EntityInfo | null {
    const norm = resolveEntityAliasV23(entity);
    const set = this.byEntity.get(norm);
    if (!set) return null;
    const row = this.coOccur.get(norm);
    const coOccurring = row
      ? [...row.entries()]
          .map(([e, count]) => ({ entity: e, count }))
          .sort((a, b) => b.count - a.count || a.entity.localeCompare(b.entity))
          .slice(0, 10)
      : [];
    return { entity: norm, recordCount: set.size, coOccurring };
  }

  /**
   * Mo rong tap entity truy van bang co-occurrence: them toi da
   * `perEntity` entity hay di kem moi entity goc (trong so giam dan
   * theo thu hang). Dung de query ngan van tim duoc record lien quan.
   */
  expandQueryEntities(queryEntities: string[], perEntity = 2): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of queryEntities) {
      const norm = resolveEntityAliasV23(raw);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      out.push(norm);
      const row = this.coOccur.get(norm);
      if (!row) continue;
      const top = [...row.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, Math.max(0, perEntity));
      for (const [entity] of top) {
        if (!seen.has(entity)) {
          seen.add(entity);
          out.push(entity);
        }
      }
    }
    return out;
  }

  /**
   * Diem tin hieu entity 0..1 giua query va mot record:
   * ti le entity cua query co mat trong record (khop chinh xac sau
   * chuan hoa), cong them 0.25 neu co entity mo rong trung khop
   * (toi da 1). Query khong co entity nao -> 0.
   */
  static entitySignal(
    queryEntities: string[],
    recordEntities: string[],
    expandedQueryEntities: string[] = [],
  ): number {
    if (queryEntities.length === 0) return 0;
    const recordSet = new Set(recordEntities.map((e) => resolveEntityAliasV23(e)));
    let hits = 0;
    for (const q of queryEntities) {
      if (recordSet.has(resolveEntityAliasV23(q))) hits += 1;
    }
    const direct = hits / queryEntities.length;
    if (direct >= 1) return 1;
    let bonus = 0;
    if (expandedQueryEntities.length > queryEntities.length) {
      for (const extra of expandedQueryEntities.slice(queryEntities.length)) {
        if (recordSet.has(extra)) {
          bonus = 0.25;
          break;
        }
      }
    }
    return Math.min(1, direct + bonus);
  }
}

/** Trich entity tu query (dung chung cho fusion + scoped retrieval). */
export function queryEntitiesV23(query: string, extraKeywords: string[] = []): string[] {
  const fromRules = extractEntitiesV23(query, extraKeywords);
  // Bo sung: token dai, khong phai stopword, xuat hien trong query
  // cung la ung vien entity (vd ten du an viet thuong).
  const tokens = tokenizeV23(query).filter((t) => t.length >= 4);
  const extra = tokens.filter((t) => !fromRules.includes(t)).slice(0, 4);
  return [...fromRules, ...extra];
}
