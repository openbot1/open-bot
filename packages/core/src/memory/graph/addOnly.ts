/**
 * ADD-only fact store — Memory v5 (v1.04, Đội T1).
 *
 * Ý tưởng học từ Mem0 v3 (pipeline extraction → consolidation, bản
 * v3 chuyển sang append-only: fact mới luôn được ADD cạnh fact cũ
 * thay vì UPDATE/DELETE tại chỗ, retrieval ranking quyết định fact
 * nào thắng) — tự thiết kế lại hoàn toàn cho open-bot, 100% local,
 * không copy code/text/tài sản của bất kỳ repo nào.
 *
 * Kế thừa, không làm lại:
 *  - `TemporalGraphStore` (v0.98) đã lưu mọi fact + chuỗi supersession
 *    + `factHistory`; module này KHÔNG sửa store, chỉ thêm lớp ngữ
 *    nghĩa ADD-only lên trên nó.
 *  - `consolidateCandidates` (v0.98) UPDATE/DELETE tại chỗ vẫn tồn
 *    tại cho đường judge v4; đường ADD-only là đường riêng: append
 *    thuần, không bao giờ gọi `supersedeFact` / `deleteFact` trong
 *    lúc append.
 *  - `scoreFactCandidate` (v1.03, scored dream) là nguồn của công
 *    thức ranking dưới đây (confidence + frequency + corroboration +
 *    recency − contradiction), hiệu chỉnh lại cho nhóm ADD-only.
 *
 * Luật ADD-only:
 *  1. Fact mới LUÔN append cạnh fact cũ (kể cả khi cùng
 *     (subject, predicate) nhưng khác object). Không update/delete
 *     tại chỗ trong lúc append.
 *  2. Ngoại lệ duy nhất: trùng lặp CHÍNH XÁC (cùng subject +
 *     predicate + object đã chuẩn hoá, đang active) thì dedupe —
 *     trả về fact cũ, không tạo bản sao. Đây là dedupe, không phải
 *     update: không fact nào bị sửa.
 *  3. Fact nào "thắng" do RETRIEVAL RANKING quyết định lúc đọc
 *     (`rankAddOnlyFacts` / `retrieveAddOnly`), không phải do ghi.
 *     Fact thua vẫn active trong store, vẫn truy vấn được lịch sử.
 *  4. "Đánh dấu superseded" chỉ xảy ra ở bước áp dụng tường minh
 *     (`applyRankingSupersession`, cần actor + xác nhận của host):
 *     loser được đóng cửa sổ bằng cơ chế `mergeFacts` có sẵn
 *     (status `superseded`, `supersededBy` trỏ về winner — lịch sử
 *     giữ nguyên qua `factHistory`). Không bao giờ tự động
 *     trong lúc append hay lúc retrieval.
 *
 * Nhóm ranking: mọi fact active cùng (subjectId, predicate) tạo
 * thành một nhóm cạnh tranh; mỗi nhóm có tối đa một winner. Nhóm
 * chỉ có một object duy nhất thì không có mâu thuẫn.
 */

import type { EntityKind, GraphFact, MemoryScope } from './types';
import { normalizeGraphText } from './types';
import type { TemporalGraphStore } from './store';

/** Trọng số ranking ADD-only (tổng phần dương = 1, penalty trừ riêng). */
export const ADDONLY_WEIGHT_CONFIDENCE = 0.3;
export const ADDONLY_WEIGHT_RECENCY = 0.3;
export const ADDONLY_WEIGHT_SUPPORT = 0.2;
export const ADDONLY_WEIGHT_FRESHNESS = 0.2;
/** Mỗi fact khác-object trong cùng nhóm trừ từng này (tối đa 2 lần). */
export const ADDONLY_CONTRADICTION_PENALTY = 0.15;
export const ADDONLY_MAX_CONTRADICTION_PENALTY = 0.3;
/** Recency decay tuyến tính trong từng này ngày. */
export const ADDONLY_RECENCY_DAYS = 90;
/** Support bão hoà ở từng này fact cùng object. */
export const ADDONLY_SUPPORT_CAP = 3;
/** Winner phải hơn loser ít nhất từng này điểm mới được supersede. */
export const ADDONLY_SUPERSEDE_MIN_GAP = 0.25;
/** Winner phải có confidence ít nhất từng này mới được supersede loser. */
export const ADDONLY_SUPERSEDE_MIN_CONFIDENCE = 0.6;

function parseMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Key nhóm cạnh tranh: cùng subject + predicate. */
export function addOnlyGroupKey(fact: GraphFact): string {
  return `${fact.subjectId}|${fact.predicate}`;
}

/** Key dedupe chính xác: nhóm + object đã chuẩn hoá. */
export function addOnlyFactKey(fact: GraphFact): string {
  return `${addOnlyGroupKey(fact)}|${normalizeGraphText(fact.objectText ?? '')}`;
}

export interface AddOnlyRankBreakdown {
  confidence: number;
  recency: number;
  support: number;
  freshness: number;
  contradictionPenalty: number;
  /** Tổng sau khi trừ penalty, kẹp 0..1. */
  total: number;
}

export interface RankedAddOnlyFact {
  fact: GraphFact;
  subjectName: string;
  /** Số fact active khác-object trong cùng nhóm (mâu thuẫn trực tiếp). */
  contradictingCount: number;
  /** Số fact active cùng object (ủng hộ lẫn nhau). */
  supportingCount: number;
  score: AddOnlyRankBreakdown;
}

/**
 * Chấm điểm một fact trong nhóm ADD-only của nó. Thuần hàm, không
 * chạm store — tách riêng để test được.
 *
 *  - confidence: độ tin cậy của fact × 0.30.
 *  - recency: fact càng mới càng cao, decay tuyến tính 90 ngày × 0.30.
 *  - support: số fact cùng object trong nhóm (bão hoà 3) × 0.20 —
 *    nhiều nguồn nói giống nhau thì fact đáng tin hơn.
 *  - freshness: 1 khi fact chưa từng bị "thua" (validUntil null),
 *    0 khi cửa sổ đã đóng × 0.20 — fact còn hiệu lực được ưu tiên.
 *  - contradictionPenalty: 0.15 cho mỗi fact khác-object trong
 *    nhóm, tối đa 0.30 — fact mâu thuẫn với nhiều fact khác bị hạ hạng.
 */
export function scoreAddOnlyFact(
  fact: GraphFact,
  group: GraphFact[],
  now: Date = new Date(),
): AddOnlyRankBreakdown {
  const objectNorm = normalizeGraphText(fact.objectText ?? '');
  let supporting = 0;
  let contradicting = 0;
  for (const other of group) {
    if (other.id === fact.id) continue;
    if (normalizeGraphText(other.objectText ?? '') === objectNorm) supporting += 1;
    else contradicting += 1;
  }
  const confidence = clamp01(fact.confidence) * ADDONLY_WEIGHT_CONFIDENCE;
  const ageDays = Math.max(0, (now.getTime() - parseMs(fact.createdAt)) / 86_400_000);
  const recency = Math.max(0, 1 - ageDays / ADDONLY_RECENCY_DAYS) * ADDONLY_WEIGHT_RECENCY;
  const support =
    (Math.min(supporting, ADDONLY_SUPPORT_CAP) / ADDONLY_SUPPORT_CAP) * ADDONLY_WEIGHT_SUPPORT;
  const freshness = (fact.validUntil === null ? 1 : 0) * ADDONLY_WEIGHT_FRESHNESS;
  const contradictionPenalty = Math.min(
    contradicting * ADDONLY_CONTRADICTION_PENALTY,
    ADDONLY_MAX_CONTRADICTION_PENALTY,
  );
  const total = clamp01(confidence + recency + support + freshness - contradictionPenalty);
  return { confidence, recency, support, freshness, contradictionPenalty, total };
}

/**
 * Xếp hạng mọi fact active trong một nhóm (cùng subject + predicate).
 * Trả về điểm cao → thấp; hoà thì fact mới hơn thắng (createdAt sau,
 * rồi id để thứ tự xác định).
 */
export function rankAddOnlyFacts(
  store: TemporalGraphStore,
  facts: GraphFact[],
  now: Date = new Date(),
): RankedAddOnlyFact[] {
  const ranked: RankedAddOnlyFact[] = facts.map((fact) => {
    const objectNorm = normalizeGraphText(fact.objectText ?? '');
    let supporting = 0;
    let contradicting = 0;
    for (const other of facts) {
      if (other.id === fact.id) continue;
      if (normalizeGraphText(other.objectText ?? '') === objectNorm) supporting += 1;
      else contradicting += 1;
    }
    return {
      fact,
      subjectName: store.getEntity(fact.subjectId)?.name ?? 'user',
      contradictingCount: contradicting,
      supportingCount: supporting,
      score: scoreAddOnlyFact(fact, facts, now),
    };
  });
  ranked.sort((a, b) => {
    if (b.score.total !== a.score.total) return b.score.total - a.score.total;
    const byCreated = b.fact.createdAt.localeCompare(a.fact.createdAt);
    if (byCreated !== 0) return byCreated;
    return a.fact.id.localeCompare(b.fact.id);
  });
  return ranked;
}

export interface AddOnlyGroup {
  /** Key nhóm: `subjectId|predicate`. */
  key: string;
  subjectName: string;
  predicate: string;
  /** Mọi fact active trong nhóm, đã xếp hạng (cao → thấp). */
  ranked: RankedAddOnlyFact[];
  /** Fact thắng trong nhóm (null khi nhóm rỗng — không xảy ra). */
  winner: RankedAddOnlyFact | null;
  /** Các fact thua (mọi fact còn lại trong nhóm). */
  losers: RankedAddOnlyFact[];
  /** true = nhóm có ≥ 2 object khác nhau (mâu thuẫn thật). */
  hasContradiction: boolean;
  /** Số object khác nhau trong nhóm. */
  distinctObjects: number;
}

/** Gom mọi fact active (theo scope) thành nhóm ADD-only + xếp hạng. */
export function resolveAddOnlyGroups(
  store: TemporalGraphStore,
  scope: MemoryScope,
  now: Date = new Date(),
): AddOnlyGroup[] {
  const facts = store.listFacts({ ...scope, status: 'active', limit: 5000 });
  const byKey = new Map<string, GraphFact[]>();
  for (const fact of facts) {
    const key = addOnlyGroupKey(fact);
    const list = byKey.get(key) ?? [];
    list.push(fact);
    byKey.set(key, list);
  }
  const groups: AddOnlyGroup[] = [];
  for (const [key, members] of byKey) {
    const ranked = rankAddOnlyFacts(store, members, now);
    const distinctObjects = new Set(members.map((f) => normalizeGraphText(f.objectText ?? ''))).size;
    groups.push({
      key,
      subjectName: ranked[0]?.subjectName ?? 'user',
      predicate: members[0]?.predicate ?? '',
      ranked,
      winner: ranked[0] ?? null,
      losers: ranked.slice(1),
      hasContradiction: distinctObjects > 1,
      distinctObjects,
    });
  }
  groups.sort((a, b) => {
    if (a.hasContradiction !== b.hasContradiction) return a.hasContradiction ? -1 : 1;
    return b.ranked.length - a.ranked.length;
  });
  return groups;
}

/** Tỉ lệ mâu thuẫn ADD-only: nhóm có ≥ 2 object / tổng số nhóm. */
export function addOnlyContradictionRate(
  store: TemporalGraphStore,
  scope: MemoryScope,
  now: Date = new Date(),
): { groups: number; contradictoryGroups: number; rate: number } {
  const groups = resolveAddOnlyGroups(store, scope, now);
  const contradictory = groups.filter((g) => g.hasContradiction).length;
  return {
    groups: groups.length,
    contradictoryGroups: contradictory,
    rate: groups.length === 0 ? 0 : contradictory / groups.length,
  };
}

export interface AddOnlyAppendInput {
  subjectName: string;
  kind?: EntityKind;
  predicate: string;
  objectText: string;
  objectIsEntity?: boolean;
  confidence?: number;
  scope: MemoryScope;
  provenance: GraphFact['provenance'];
  validFrom?: string;
  validUntil?: string | null;
}

export interface AddOnlyAppendResult {
  fact: GraphFact;
  /** true = object đã có sẵn (dedupe chính xác), không tạo fact mới. */
  duplicate: boolean;
  /** Fact cũ cùng object (khi duplicate). */
  existingFactId?: string;
  /** Nhóm sau khi append (đã xếp hạng) — để caller thấy ai đang thắng. */
  groupAfter: AddOnlyGroup | null;
}

/**
 * Append ADD-only: fact mới luôn lưu CẠNH fact cũ. Không gọi
 * `supersedeFact` / `deleteFact` — fact cũ giữ nguyên status
 * `active` và cửa sổ hiệu lực. Trùng lặp chính xác thì dedupe.
 */
export function appendFactAddOnly(
  store: TemporalGraphStore,
  input: AddOnlyAppendInput,
  now: Date = new Date(),
): AddOnlyAppendResult {
  const predicate = normalizeGraphText(input.predicate).replace(/\s+/g, '_');
  const objectNorm = normalizeGraphText(input.objectText);
  const scope = input.scope;
  const existing = store
    .findActiveFacts(input.subjectName, predicate, scope)
    .find((f) => normalizeGraphText(f.objectText ?? '') === objectNorm);
  if (existing) {
    const groups = resolveAddOnlyGroups(store, scope, now);
    const group = groups.find((g) => g.key === addOnlyGroupKey(existing)) ?? null;
    return { fact: existing, duplicate: true, existingFactId: existing.id, groupAfter: group };
  }
  const fact = store.addFact({
    subjectName: input.subjectName,
    ...(input.kind ? { kind: input.kind } : {}),
    predicate,
    objectText: input.objectText,
    ...(input.objectIsEntity !== undefined ? { objectIsEntity: input.objectIsEntity } : {}),
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    scope,
    provenance: input.provenance,
    ...(input.validFrom ? { validFrom: input.validFrom } : {}),
    ...(input.validUntil !== undefined ? { validUntil: input.validUntil } : {}),
  });
  const groups = resolveAddOnlyGroups(store, scope, now);
  const group = groups.find((g) => g.key === addOnlyGroupKey(fact)) ?? null;
  return { fact, duplicate: false, groupAfter: group };
}

export interface AddOnlySupersedeResult {
  /** Loser đã được đóng bằng supersedeFact (lịch sử giữ nguyên). */
  superseded: Array<{ loserId: string; winnerId: string; gap: number }>;
  /** Loser chưa đủ điều kiện (gap/confidence thấp) — chỉ ghi nhận. */
  deferred: Array<{ loserId: string; winnerId: string; gap: number; reason: string }>;
  details: string[];
}

/**
 * Áp dụng ranking thành supersession — BƯỚC TƯỜNG MINH, không tự
 * động: chỉ chạy khi host/user gọi (tool `memory_v5_consolidate`
 * hoặc UI health panel). Loser chỉ bị supersede khi winner hơn
 * loser ít nhất ADDONLY_SUPERSEDE_MIN_GAP điểm VÀ winner có
 * confidence ≥ ADDONLY_SUPERSEDE_MIN_CONFIDENCE. Loser không đủ
 * điều kiện thì ở lại active — ranking lúc đọc vẫn hạ hạng nó.
 */
export function applyRankingSupersession(
  store: TemporalGraphStore,
  groups: AddOnlyGroup[],
  actor: string,
): AddOnlySupersedeResult {
  const superseded: AddOnlySupersedeResult['superseded'] = [];
  const deferred: AddOnlySupersedeResult['deferred'] = [];
  const details: string[] = [];
  for (const group of groups) {
    if (!group.hasContradiction || !group.winner) continue;
    for (const loser of group.losers) {
      const gap = group.winner.score.total - loser.score.total;
      if (group.winner.fact.confidence < ADDONLY_SUPERSEDE_MIN_CONFIDENCE) {
        deferred.push({
          loserId: loser.fact.id,
          winnerId: group.winner.fact.id,
          gap,
          reason: `Winner confidence ${group.winner.fact.confidence.toFixed(2)} < ${ADDONLY_SUPERSEDE_MIN_CONFIDENCE} — chưa đủ chắc để supersede.`,
        });
        continue;
      }
      if (gap < ADDONLY_SUPERSEDE_MIN_GAP) {
        deferred.push({
          loserId: loser.fact.id,
          winnerId: group.winner.fact.id,
          gap,
          reason: `Gap điểm ${gap.toFixed(2)} < ${ADDONLY_SUPERSEDE_MIN_GAP} — hai fact còn ngang nhau, giữ cả hai.`,
        });
        continue;
      }
      try {
        const winner = group.winner.fact;
        const merged = store.mergeFacts(winner.id, [loser.fact.id], actor);
        if (merged.length === 0) {
          deferred.push({
            loserId: loser.fact.id,
            winnerId: winner.id,
            gap,
            reason: 'Loser đã đổi trạng thái giữa chừng — bỏ qua, lần sau xét lại.',
          });
          continue;
        }
        superseded.push({ loserId: loser.fact.id, winnerId: winner.id, gap });
        details.push(
          `Supersede (ranking): ${group.subjectName} ${group.predicate} "${loser.fact.objectText}" → "${winner.objectText}" (gap ${gap.toFixed(2)}).`,
        );
      } catch {
        deferred.push({
          loserId: loser.fact.id,
          winnerId: group.winner.fact.id,
          gap,
          reason: 'Loser đã đổi trạng thái giữa chừng — bỏ qua, lần sau xét lại.',
        });
      }
    }
  }
  return { superseded, deferred, details };
}

export interface AddOnlyHit {
  fact: GraphFact;
  subjectName: string;
  objectName?: string;
  /** Điểm ranking trong nhóm (0..1). */
  rankScore: number;
  /** true = fact này đang thắng nhóm của nó. */
  isWinner: boolean;
  /** Số fact cùng nhóm đang mâu thuẫn với fact này. */
  contradictingCount: number;
  /** Điểm retrieval cuối = keyword hits × rankScore. */
  score: number;
}

/**
 * Giải thích bằng câu đọc được vì sao một fact thắng/thua trong
 * nhóm của nó — dùng cho UI health panel và tool output. Liệt kê
 * từng thành phần điểm (confidence / recency / support / freshness /
 * penalty) và so sánh trực tiếp với winner của nhóm.
 */
export function explainRanking(group: AddOnlyGroup, factId: string): string | null {
  const ranked = group.ranked.find((r) => r.fact.id === factId);
  if (!ranked) return null;
  const winner = group.winner;
  const s = ranked.score;
  const fmt = (n: number): string => n.toFixed(2);
  const breakdown =
    `confidence ${fmt(s.confidence)} + recency ${fmt(s.recency)} + ` +
    `support ${fmt(s.support)} + freshness ${fmt(s.freshness)} − ` +
    `contradiction penalty ${fmt(s.contradictionPenalty)}`;
  const base =
    `"${ranked.fact.objectText ?? ''}" (${group.subjectName} ${group.predicate}): ` +
    `tổng ${fmt(s.total)} = ${breakdown}.`;
  if (!winner || winner.fact.id === factId) {
    return `${base} Đang thắng nhóm (${group.ranked.length} fact, ${group.distinctObjects} object khác nhau).`;
  }
  const gap = winner.score.total - s.total;
  return (
    `${base} Thua "${winner.fact.objectText ?? ''}" (tổng ${fmt(winner.score.total)}, hơn ${fmt(gap)} điểm). ` +
    `Fact thua vẫn active trong store — chỉ bị hạ hạng lúc retrieval, chưa bị supersede.`
  );
}

/**
 * Retrieval có ranking ADD-only: chỉ fact active được xét; điểm =
 * số từ khóa khớp × điểm ranking trong nhóm. Với `winnersOnly`
 * (mặc định true), mỗi nhóm chỉ trả winner — loser vẫn còn trong
 * store và vẫn xem được qua `resolveAddOnlyGroups`, chỉ không lọt
 * vào câu trả lời của agent. Query rỗng = fact mới nhất theo nhóm.
 */
export function retrieveAddOnly(
  store: TemporalGraphStore,
  query: string,
  scope: MemoryScope,
  opts: { winnersOnly?: boolean; limit?: number; now?: Date } = {},
): AddOnlyHit[] {
  const now = opts.now ?? new Date();
  const winnersOnly = opts.winnersOnly !== false;
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 20), 1), 200);
  const terms = query
    .split(/\s+/u)
    .map((t) => normalizeGraphText(t))
    .filter((t) => t.length > 0);
  const groups = resolveAddOnlyGroups(store, scope, now);
  const hits: AddOnlyHit[] = [];
  for (const group of groups) {
    const candidates = winnersOnly ? (group.winner ? [group.winner] : []) : group.ranked;
    for (const ranked of candidates) {
      const fact = ranked.fact;
      const subjectName = ranked.subjectName;
      const objectName = fact.objectId ? store.getEntity(fact.objectId)?.name : undefined;
      const haystack = normalizeGraphText(
        `${subjectName} ${fact.predicate.replace(/_/g, ' ')} ${fact.objectText ?? ''} ${objectName ?? ''}`,
      );
      let keywordHits = 0;
      for (const term of terms) {
        if (term !== '' && haystack.includes(term)) keywordHits += 1;
      }
      if (terms.length > 0 && keywordHits === 0) continue;
      const score = (terms.length === 0 ? 1 : keywordHits) * ranked.score.total;
      hits.push({
        fact,
        subjectName,
        ...(objectName ? { objectName } : {}),
        rankScore: ranked.score.total,
        isWinner: group.winner?.fact.id === fact.id,
        contradictingCount: ranked.contradictingCount,
        score,
      });
    }
  }
  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.fact.createdAt.localeCompare(a.fact.createdAt);
  });
  return hits.slice(0, limit);
}
