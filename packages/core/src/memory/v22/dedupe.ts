/**
 * Memory v22 — Dedupe: gop fact trung lap (v1.37, Doi T1).
 *
 * Y tuong (Mem0 Dream "merge" + Letta sleep-time dedupe): hai
 * fact noi gan nhu cung mot dieu thi gop lam mot — giu ban
 * manh nhat (confidence cao nhat, hoa thi moi nhat), ban thua
 * chuyen status `merged` va tro `mergedInto` ve ban giu, ban
 * giu thua huong toan bo nguon/tag/session cua ban thua.
 *
 * Giong nhau do bang Jaccard tren tap token sau khi chuan hoa
 * (ha chu, bo dau cau, bo dau tieng Viet). Nhom co so khac
 * nhau (ngay / gio / so luong) thi KHONG tu dong gop — danh
 * dau `needsReview` de host/user quyet dinh, vi "hen 9h" va
 * "hen 10h" giong nhau ve chu nhung khac nhau ve y nghia.
 *
 * Module nay khong goi model, khong goi mang, khong throw khi
 * gap fact xau — fact xau chi bi bo qua co ghi ly do.
 */
import type { V22DreamChange, V22DreamFact } from './types';
import { V22_DREAM_DEFAULT_CONFIG } from './types';
import { cloneDreamFactV22, stripDiacriticsV22, type V22DreamStore } from './store';

/** Chuan hoa text de so sanh trung lap: ha chu, bo dau, bo dau cau. */
export function normalizeDreamTextV22(text: string): string {
  return stripDiacriticsV22(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tap token duy nhat cua text da chuan hoa. */
export function dreamTextTokensV22(text: string): string[] {
  const norm = normalizeDreamTextV22(text);
  if (!norm) return [];
  return [...new Set(norm.split(' '))];
}

/** Jaccard tren tap token (1 = giong het, 0 = khong chung token). */
export function jaccardSimilarityV22(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let inter = 0;
  for (const token of a) if (setB.has(token)) inter += 1;
  return inter / (a.length + b.length - inter);
}

/** Do tuong dong Jaccard giua hai fact (theo text). */
export function dreamFactSimilarityV22(a: V22DreamFact, b: V22DreamFact): number {
  return jaccardSimilarityV22(dreamTextTokensV22(a.text), dreamTextTokensV22(b.text));
}

/** Trich cac so trong text (ngay/gio/luong) de phat hien mau thuan so. */
export function extractNumbersV22(text: string): string[] {
  return [...text.matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => m[0].replace(',', '.'));
}

/**
 * Ly do can xem lai cua mot nhom (undefined = gop an toan):
 * cac fact trong nhom co tap so khac nhau.
 */
export function groupNeedsReviewReasonV22(members: V22DreamFact[]): string | undefined {
  if (members.length < 2) return undefined;
  const base = new Set(extractNumbersV22(members[0].text));
  for (let i = 1; i < members.length; i += 1) {
    const other = new Set(extractNumbersV22(members[i].text));
    const same = base.size === other.size && [...base].every((x) => other.has(x));
    if (!same) {
      return 'cac fact gop co so khac nhau (ngay/gio/luong) — can xem lai truoc khi gop';
    }
  }
  return undefined;
}

/** Tuy chon dedupe (lay mac dinh tu config dream khi khong truyen). */
export interface V22DedupeOptions {
  /** Nguong Jaccard de coi hai fact la trung lap. Mac dinh 0.6. */
  dedupeThreshold?: number;
  /** Chi xet fact active (mac dinh true). */
  onlyActive?: boolean;
  /** So fact toi da xet trong mot lan (chong qua tai). */
  maxFacts?: number;
}

/** Mot nhom trung lap: keeper + cac fact se gop vao keeper. */
export interface V22DedupeGroup {
  keeper: V22DreamFact;
  merged: V22DreamFact[];
  /** Do tuong dong thap nhat trong nhom (so voi keeper). */
  minSimilarity: number;
  /** true = nhom co so khac nhau, can nguoi xem lai. */
  needsReview: boolean;
  reviewReason?: string;
}

/**
 * Nhom cac fact trung lap trong danh sach (khong ghi gi vao
 * store). Sap xep truoc theo confidence giam dan de keeper luon
 * la ban manh nhat; nhom gom cac fact chua dung, co Jaccard so
 * voi keeper >= nguong.
 */
export function groupDuplicateFactsV22(
  facts: V22DreamFact[],
  options: V22DedupeOptions = {},
): V22DedupeGroup[] {
  const threshold = options.dedupeThreshold ?? V22_DREAM_DEFAULT_CONFIG.dedupeThreshold;
  const onlyActive = options.onlyActive ?? true;
  const maxFacts = options.maxFacts ?? V22_DREAM_DEFAULT_CONFIG.maxFactsPerDream;
  const pool = facts
    .filter((f) => !onlyActive || f.status === 'active')
    .slice(0, maxFacts)
    .sort((a, b) => b.confidence - a.confidence || b.observedAt - a.observedAt);
  const used = new Set<string>();
  const groups: V22DedupeGroup[] = [];
  for (const fact of pool) {
    if (used.has(fact.id)) continue;
    used.add(fact.id);
    const keeperTokens = dreamTextTokensV22(fact.text);
    const members: V22DreamFact[] = [];
    let minSimilarity = 1;
    for (const other of pool) {
      if (used.has(other.id)) continue;
      const sim = jaccardSimilarityV22(keeperTokens, dreamTextTokensV22(other.text));
      if (sim >= threshold) {
        members.push(other);
        used.add(other.id);
        minSimilarity = Math.min(minSimilarity, sim);
      }
    }
    const all = [fact, ...members];
    const reviewReason = groupNeedsReviewReasonV22(all);
    groups.push({
      keeper: cloneDreamFactV22(fact),
      merged: members.map((m) => cloneDreamFactV22(m)),
      minSimilarity: members.length === 0 ? 1 : minSimilarity,
      needsReview: reviewReason !== undefined,
      ...(reviewReason ? { reviewReason } : {}),
    });
  }
  return groups;
}

/** Ket qua ap dung dedupe len store. */
export interface V22DedupeResult {
  groups: V22DedupeGroup[];
  /** So fact da gop (merged). */
  mergedCount: number;
  /** Nhom can xem lai (khong gop). */
  needsReviewCount: number;
  /** Cac thay doi co bang chung (de dua vao dream report). */
  changes: V22DreamChange[];
  /** Muc bi bo qua co ly do. */
  skipped: string[];
}

/**
 * Ap dung dedupe len store: voi moi nhom KHONG can xem lai,
 * keeper thua huong nguon/tag/session cua ban thua, ban thua
 * chuyen `merged` + tro ve keeper. Nhom can xem lai thi bo qua
 * co ghi ly do vao `skipped` (khong tu dong gop).
 */
export function applyDedupeV22(
  store: V22DreamStore,
  options: V22DedupeOptions & { actor?: string; now?: number } = {},
): V22DedupeResult {
  const now = options.now ?? Date.now();
  const groups = groupDuplicateFactsV22(store.list({ status: 'active' }), options);
  const changes: V22DreamChange[] = [];
  const skipped: string[] = [];
  let mergedCount = 0;
  let needsReviewCount = 0;
  let changeSeq = 0;
  for (const group of groups) {
    if (group.merged.length === 0) continue;
    if (group.needsReview) {
      needsReviewCount += 1;
      skipped.push(
        `nhom gop giu "${group.keeper.id}" can xem lai: ${group.reviewReason ?? 'mau thuan so'} (gop ${group.merged.length} fact: ${group.merged.map((m) => m.id).join(', ')})`,
      );
      continue;
    }
    const beforeIds = [group.keeper.id, ...group.merged.map((m) => m.id)];
    for (const loser of group.merged) {
      store.absorbMerged(group.keeper.id, loser, now);
      store.setStatus(loser.id, 'merged', { mergedInto: group.keeper.id, now });
      mergedCount += 1;
    }
    changeSeq += 1;
    changes.push({
      id: `chg-dedupe-${changeSeq}`,
      kind: 'merge',
      factIdsBefore: beforeIds,
      factIdsAfter: [group.keeper.id],
      reason: `Gop ${group.merged.length} fact trung lap vao "${group.keeper.id}" (Jaccard toi thieu ${group.minSimilarity.toFixed(2)} >= nguong).`,
      detail: `fact bi gop: ${group.merged.map((m) => m.id).join(', ')}; nguon/tag/session da hop nhat vao keeper.`,
      at: now,
    });
  }
  return { groups, mergedCount, needsReviewCount, changes, skipped };
}

/** Dem so cap trung lap tiem nang (de UI bao truoc khi dream). */
export function countPotentialDuplicatesV22(
  facts: V22DreamFact[],
  options: V22DedupeOptions = {},
): number {
  const threshold = options.dedupeThreshold ?? V22_DREAM_DEFAULT_CONFIG.dedupeThreshold;
  const pool = facts.filter((f) => f.status === 'active');
  let count = 0;
  for (let i = 0; i < pool.length; i += 1) {
    for (let j = i + 1; j < pool.length; j += 1) {
      if (dreamFactSimilarityV22(pool[i], pool[j]) >= threshold) count += 1;
    }
  }
  return count;
}
