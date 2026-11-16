/**
 * Temporal KG v2 — phát hiện & giải quyết mâu thuẫn (v1.12, Đội T3).
 *
 * Ý tưởng học từ Graphiti/Zep (edge mâu thuẫn thì invalidate chứ
 * không xóa) nhưng tự thiết kế lại hoàn toàn cho open-bot, 100%
 * local, không copy code/text/tài sản của bất kỳ repo nào.
 *
 * Cái v1.02 đã có (temporalQuery.ts):
 *  - `findContradictionsBetween`: mâu thuẫn giữa HAI CỬA SỔ thời
 *    gian (so sánh "tuần trước nói X" vs "hôm nay nói Y").
 *
 * Cái v2 thêm lên trên — chưa có ở main:
 *  1. `detectLiveContradictions`: mâu thuẫn ĐANG TỒN TẠI ngay bây
 *     giờ — hai fact ACTIVE cùng (subject, predicate), object khác
 *     nhau, cửa sổ hiệu lực overlap nhau. Đây là dữ liệu xấu cần
 *     xử lý, không phải so sánh lịch sử.
 *  2. `resolveContradiction`: giải quyết một mâu thuẫn theo policy
 *     tường minh — invalidate fact cũ / fact mới (ghi invalidAt +
 *     audit, lịch sử còn nguyên), đưa fact cũ vào quarantine để
 *     user duyệt, hoặc giữ cả hai (ghi nhận đã xem xét).
 *  3. `autoInvalidateConflicts`: quét toàn bộ đồ thị, invalidate
 *     fact cũ hơn trong từng nhóm mâu thuẫn theo policy mặc định
 *     (fact mới hơn thắng — vì fact mới thường là thông tin cập
 *     nhật), trả báo cáo đầy đủ để audit.
 *  4. `contradictionSummary`: tóm tắt nhóm mâu thuẫn thành một dòng
 *     đọc được, kèm bằng chứng (sourceText + episode + thời gian).
 *
 * QUY TẮC AN TOÀN: auto-invalidate chỉ chạm fact có confidence
 * thấp hơn hoặc bằng fact thắng, và chỉ khi hai fact cùng scope;
 * fact confidence cao (≥ 0.9) mâu thuẫn với fact khác thì KHÔNG tự
 * invalidate mà đưa vào quarantine để user duyệt — tránh memory
 * poisoning tự động xoá tri thức đúng (OWASP ASI06, như
 * consolidateGraph.ts).
 */

import type { GraphFact, MemoryScope } from './types';
import { factDisplayText, normalizeGraphText } from './types';
import type { TemporalGraphStore } from './store';
import {
  edgeValidityIntervals,
  findEdgeIntervalOverlaps,
  invalidateFact,
} from './biTemporal';
import type { InvalidationRecord } from './biTemporal';

/** Ngưỡng confidence: fact ≥ ngưỡng này không bao giờ bị auto-invalidate. */
export const AUTO_INVALIDATE_HIGH_CONFIDENCE = 0.9;

function parseMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(limit)));
}

/** Một nhóm mâu thuẫn đang tồn tại: cùng edge, object khác nhau, overlap. */
export interface LiveContradiction {
  subjectName: string;
  predicate: string;
  /** Các fact active mâu thuẫn nhau (xếp theo validFrom). */
  facts: Array<{
    fact: GraphFact;
    objectText: string;
    validFrom: string;
    validUntil: string | null;
    sourceText: string;
    episodeId: string;
    recordedAt: string;
  }>;
  /** Giao nhau của các cửa sổ hiệu lực (từ ... đến ...). */
  overlapFrom: string;
  overlapTo: string | null;
  /** Fact mới nhất trong nhóm (ứng viên "thắng" khi resolve). */
  newestFactId: string;
  /** Fact cũ nhất trong nhóm (ứng viên bị invalidate khi resolve). */
  oldestFactId: string;
}

/**
 * Mâu thuẫn đang tồn tại: quét mọi edge, tìm cặp khoảng hiệu lực
 * overlap với object khác nhau mà CẢ HAI fact đều đang active.
 * Fact superseded/deleted/quarantined không tính — chúng đã là
 * lịch sử, không phải mâu thuẫn hiện tại.
 */
export function detectLiveContradictions(
  store: TemporalGraphStore,
  scope: MemoryScope,
  opts: { limit?: number } = {},
): LiveContradiction[] {
  const limit = clampLimit(opts.limit, 100, 1000);
  // Chỉ fact active CHƯA bị invalidate mới là "niềm tin hiện tại":
  // fact đã invalidate (có invalidAt) giữ status active theo thiết
  // kế bi-temporal v1.04, nhưng mâu thuẫn của nó đã được giải quyết
  // rồi — không tính nữa, nếu không mâu thuẫn đã xử lý vẫn hiện mãi.
  const activeFacts = store
    .listFacts({ ...scope, status: 'active', limit: 20000 })
    .filter((f) => f.invalidAt === undefined);
  const byEdge = new Map<string, GraphFact[]>();
  for (const fact of activeFacts) {
    const key = `${fact.subjectId}|${fact.predicate}`;
    const list = byEdge.get(key) ?? [];
    list.push(fact);
    byEdge.set(key, list);
  }
  const out: LiveContradiction[] = [];
  for (const [key, edgeFacts] of byEdge) {
    if (edgeFacts.length < 2) continue;
    const [subjectId, predicate] = key.split('|');
    const subject = store.getEntity(subjectId ?? '');
    if (!subject || !predicate) continue;
    const intervals = edgeValidityIntervals(store, subject.name, predicate, scope).filter((iv) =>
      edgeFacts.some((f) => f.id === iv.factId),
    );
    const overlaps = findEdgeIntervalOverlaps(intervals);
    if (overlaps.length === 0) continue;
    // Chỉ fact nào tham gia ít nhất một cặp overlap mới vào nhóm —
    // fact cùng edge nhưng cửa sổ không chạm nhau không mâu thuẫn.
    const overlappingIds = new Set<string>();
    for (const overlap of overlaps) {
      overlappingIds.add(overlap.first.factId);
      overlappingIds.add(overlap.second.factId);
    }
    const conflictingFacts = edgeFacts.filter((f) => overlappingIds.has(f.id));
    if (conflictingFacts.length < 2) continue;
    // Gộp mọi fact mâu thuẫn của edge này thành MỘT nhóm (một edge
    // chỉ có một "sự thật hiện tại" nên mọi phiên bản cùng đúng một
    // lúc đều mâu thuẫn nhau).
    const facts = conflictingFacts
      .map((fact) => ({
        fact,
        objectText: fact.objectText ?? '',
        validFrom: fact.validFrom,
        validUntil: fact.validUntil,
        sourceText: fact.provenance.sourceText,
        episodeId: fact.provenance.episodeId,
        recordedAt: fact.createdAt,
      }))
      .sort((a, b) => a.validFrom.localeCompare(b.validFrom));
    const firstOverlap = overlaps[0];
    if (!firstOverlap) continue;
    const sorted = [...facts].sort((a, b) => a.validFrom.localeCompare(b.validFrom));
    const oldest = sorted[0];
    const newest = sorted[sorted.length - 1];
    if (!oldest || !newest) continue;
    out.push({
      subjectName: subject.name,
      predicate,
      facts,
      overlapFrom: firstOverlap.overlapFrom,
      overlapTo: firstOverlap.overlapTo,
      newestFactId: newest.fact.id,
      oldestFactId: oldest.fact.id,
    });
  }
  out.sort((a, b) => a.overlapFrom.localeCompare(b.overlapFrom));
  return out.slice(0, limit);
}

/** Policy giải quyết một mâu thuẫn. */
export type ContradictionPolicy =
  | 'invalidate-older'
  | 'invalidate-newer'
  | 'quarantine-older'
  | 'keep-both';

/** Kết quả giải quyết một mâu thuẫn. */
export interface ResolveContradictionResult {
  policy: ContradictionPolicy;
  /** Fact bị invalidate (nếu policy invalidate-*). */
  invalidatedFactId?: string;
  /** Bản ghi invalidate (nếu policy invalidate-*). */
  invalidation?: InvalidationRecord;
  /** Mục quarantine đã tạo (nếu policy quarantine-older). */
  quarantineId?: string;
  /** Fact được giữ làm "sự thật hiện tại". */
  keptFactId: string;
  /** true = không có gì thay đổi (keep-both hoặc đã xử lý rồi). */
  noChange: boolean;
  reason: string;
}

/**
 * Giải quyết MỘT mâu thuẫn: caller chỉ ra fact nào trong nhóm là
 * "fact sai" (factId) và fact nào là "fact đúng" (keptFactId), policy
 * quyết định hành động:
 *  - invalidate-older / invalidate-newer: invalidate fact sai (ghi
 *    invalidAt + audit log; lịch sử còn nguyên).
 *  - quarantine-older: fact sai vào quarantine để user duyệt (fact
 *    vẫn active cho tới khi user duyệt — không tự xoá tri thức).
 *  - keep-both: không làm gì, chỉ ghi nhận đã xem xét (dùng khi cả
 *    hai fact đều đúng trong ngữ cảnh khác nhau — vd biệt danh).
 *
 * `invalidAt` mặc định = bây giờ; có thể truyền thời điểm fact bắt
 * đầu sai (vd ngày user đính chính).
 */
export function resolveContradiction(
  store: TemporalGraphStore,
  opts: {
    wrongFactId: string;
    keptFactId: string;
    policy: ContradictionPolicy;
    actor: string;
    reason: string;
    invalidAt?: string | Date;
    workspaceDir?: string;
    now?: Date;
  },
): ResolveContradictionResult {
  const wrong = store.getFact(opts.wrongFactId);
  const kept = store.getFact(opts.keptFactId);
  if (!wrong) throw new Error('Không tìm thấy fact cần xử lý.');
  if (!kept) throw new Error('Không tìm thấy fact được giữ.');
  if (wrong.id === kept.id) throw new Error('Fact sai và fact giữ không được trùng nhau.');
  if (wrong.subjectId !== kept.subjectId || wrong.predicate !== kept.predicate) {
    throw new Error('Hai fact không cùng edge (subject, predicate) — không phải một mâu thuẫn.');
  }
  const cleanReason = (opts.reason ?? '').trim();
  if (cleanReason === '') throw new Error('Lý do giải quyết mâu thuẫn không được rỗng (cần audit được).');
  const actor = (opts.actor ?? '').trim() || 'system';

  if (opts.policy === 'keep-both') {
    return {
      policy: opts.policy,
      keptFactId: kept.id,
      noChange: true,
      reason: `Giữ cả hai fact: ${cleanReason}`,
    };
  }
  if (opts.policy === 'quarantine-older') {
    if (wrong.status !== 'active') {
      return {
        policy: opts.policy,
        keptFactId: kept.id,
        noChange: true,
        reason: 'Fact cần quarantine không còn active — không cần xử lý nữa.',
      };
    }
    const item = store.addToQuarantine({
      candidate: {
        subjectName: store.getEntity(wrong.subjectId)?.name ?? 'user',
        predicate: wrong.predicate,
        objectText: wrong.objectText ?? '',
        confidence: wrong.confidence,
      },
      reason: 'contradiction',
      detail: `Mâu thuẫn với fact ${kept.id} ("${kept.objectText ?? ''}"): ${cleanReason}`,
      conflictingFactId: kept.id,
      scope: wrong.scope,
      provenance: wrong.provenance,
    });
    return {
      policy: opts.policy,
      quarantineId: item.id,
      keptFactId: kept.id,
      noChange: false,
      reason: `Fact cũ vào quarantine chờ duyệt: ${cleanReason}`,
    };
  }
  // invalidate-older / invalidate-newer: cùng một hành động, chỉ
  // khác tên policy (caller đã chọn fact nào là "sai").
  if (wrong.invalidAt !== undefined) {
    return {
      policy: opts.policy,
      invalidatedFactId: wrong.id,
      keptFactId: kept.id,
      noChange: true,
      reason: `Fact đã bị invalidate trước đó (invalidAt=${wrong.invalidAt}).`,
    };
  }
  const invalidAt = opts.invalidAt ?? opts.now ?? new Date();
  const result = invalidateFact(store, wrong.id, invalidAt, cleanReason, actor, {
    ...(opts.workspaceDir ? { workspaceDir: opts.workspaceDir } : {}),
    conflictingFactId: kept.id,
    ...(opts.now ? { now: opts.now } : {}),
  });
  return {
    policy: opts.policy,
    invalidatedFactId: wrong.id,
    invalidation: result.record,
    keptFactId: kept.id,
    noChange: false,
    reason: `Đã invalidate fact cũ ("${wrong.objectText ?? ''}"): ${cleanReason}`,
  };
}

/** Báo cáo quét + auto-invalidate toàn bộ đồ thị. */
export interface AutoInvalidateReport {
  scannedEdges: number;
  contradictionGroups: number;
  /** Số fact đã invalidate. */
  invalidated: string[];
  /** Số fact đưa vào quarantine (confidence cao, không tự invalidate). */
  quarantined: string[];
  /** Số nhóm bỏ qua (vd đã invalidate rồi / keep-both). */
  skipped: string[];
  /** Chi tiết từng hành động (để audit). */
  details: Array<{
    subjectName: string;
    predicate: string;
    action: 'invalidated' | 'quarantined' | 'skipped';
    wrongFactId: string;
    keptFactId: string;
    reason: string;
  }>;
}

/**
 * Quét toàn bộ đồ thị, tự invalidate fact cũ hơn trong từng nhóm
 * mâu thuẫn đang tồn tại. Quy tắc:
 *  - Fact thắng = fact mới nhất (validFrom muộn nhất) trong nhóm.
 *  - Fact thua có confidence ≥ 0.9 → KHÔNG tự invalidate, đưa vào
 *    quarantine để user duyệt (tránh xoá tri thức đúng vì model/
 *    extractor nhầm — OWASP ASI06).
 *  - Fact thua đã có invalidAt → bỏ qua (đã xử lý rồi).
 *  - Chỉ invalidate fact cùng scope với fact thắng (scope khác
 *    nhau có thể là hai ngữ cảnh khác nhau, không phải mâu thuẫn).
 *
 * Hàm này KHÔNG tự chạy nền — chỉ chạy khi user/agent gọi tường
 * minh (tool `temporal_kg_resolve` action=auto).
 */
export function autoInvalidateConflicts(
  store: TemporalGraphStore,
  scope: MemoryScope,
  opts: {
    actor?: string;
    workspaceDir?: string;
    now?: Date;
    limit?: number;
    /** Ngưỡng confidence cao — mặc định 0.9. */
    highConfidenceThreshold?: number;
  } = {},
): AutoInvalidateReport {
  const threshold = opts.highConfidenceThreshold ?? AUTO_INVALIDATE_HIGH_CONFIDENCE;
  const groups = detectLiveContradictions(store, scope, { limit: opts.limit });
  const report: AutoInvalidateReport = {
    scannedEdges: 0,
    contradictionGroups: groups.length,
    invalidated: [],
    quarantined: [],
    skipped: [],
    details: [],
  };
  // Đếm edge đã quét: mọi edge có ≥ 2 fact active (kể cả không mâu thuẫn).
  const activeFacts = store.listFacts({ ...scope, status: 'active', limit: 20000 });
  report.scannedEdges = new Set(activeFacts.map((f) => `${f.subjectId}|${f.predicate}`)).size;
  const actor = (opts.actor ?? '').trim() || 'system';
  // Quarantine đang chờ — để không tạo trùng khi auto chạy lại.
  const pendingQuarantine = store.listQuarantine({ ...scope, status: 'pending' });
  const alreadyQuarantined = (wrongId: string, keptId: string): boolean =>
    pendingQuarantine.some(
      (q) =>
        q.conflictingFactId === keptId &&
        q.candidate.objectText === store.getFact(wrongId)?.objectText,
    );
  for (const group of groups) {
    const kept = group.facts[group.facts.length - 1];
    if (!kept) continue;
    const keptFact = kept.fact;
    for (const entry of group.facts.slice(0, -1)) {
      const wrong = entry.fact;
      const subjectName = group.subjectName;
      const sameScope =
        normalizeGraphText(wrong.scope.userId) === normalizeGraphText(keptFact.scope.userId) &&
        normalizeGraphText(wrong.scope.botId) === normalizeGraphText(keptFact.scope.botId);
      if (!sameScope) {
        report.skipped.push(wrong.id);
        report.details.push({
          subjectName,
          predicate: group.predicate,
          action: 'skipped',
          wrongFactId: wrong.id,
          keptFactId: keptFact.id,
          reason: 'Scope khác nhau — có thể là hai ngữ cảnh khác nhau, không tự xử lý.',
        });
        continue;
      }
      if (wrong.invalidAt !== undefined) {
        report.skipped.push(wrong.id);
        report.details.push({
          subjectName,
          predicate: group.predicate,
          action: 'skipped',
          wrongFactId: wrong.id,
          keptFactId: keptFact.id,
          reason: `Đã invalidate trước đó (invalidAt=${wrong.invalidAt}).`,
        });
        continue;
      }
      if (wrong.confidence >= threshold) {
        if (alreadyQuarantined(wrong.id, keptFact.id)) {
          report.skipped.push(wrong.id);
          report.details.push({
            subjectName,
            predicate: group.predicate,
            action: 'skipped',
            wrongFactId: wrong.id,
            keptFactId: keptFact.id,
            reason: 'Đã có mục quarantine chờ duyệt cho mâu thuẫn này — không tạo trùng.',
          });
          continue;
        }
        const resolved = resolveContradiction(store, {
          wrongFactId: wrong.id,
          keptFactId: keptFact.id,
          policy: 'quarantine-older',
          actor,
          reason: `Fact cũ confidence cao (${wrong.confidence}) mâu thuẫn với fact mới ("${keptFact.objectText ?? ''}") — chờ user duyệt, không tự invalidate.`,
        });
        if (resolved.quarantineId) report.quarantined.push(wrong.id);
        else report.skipped.push(wrong.id);
        report.details.push({
          subjectName,
          predicate: group.predicate,
          action: resolved.quarantineId ? 'quarantined' : 'skipped',
          wrongFactId: wrong.id,
          keptFactId: keptFact.id,
          reason: resolved.reason,
        });
        continue;
      }
      const resolved = resolveContradiction(store, {
        wrongFactId: wrong.id,
        keptFactId: keptFact.id,
        policy: 'invalidate-older',
        actor,
        reason:
          `Fact cũ ("${wrong.objectText ?? ''}", valid từ ${wrong.validFrom}) mâu thuẫn với fact mới ` +
          `("${keptFact.objectText ?? ''}", valid từ ${keptFact.validFrom}) — fact mới thắng.`,
        ...(opts.workspaceDir ? { workspaceDir: opts.workspaceDir } : {}),
        ...(opts.now ? { now: opts.now } : {}),
      });
      if (resolved.invalidatedFactId && !resolved.noChange) report.invalidated.push(wrong.id);
      else report.skipped.push(wrong.id);
      report.details.push({
        subjectName,
        predicate: group.predicate,
        action: resolved.invalidatedFactId && !resolved.noChange ? 'invalidated' : 'skipped',
        wrongFactId: wrong.id,
        keptFactId: keptFact.id,
        reason: resolved.reason,
      });
    }
  }
  return report;
}

/** Một dòng tóm tắt nhóm mâu thuẫn, kèm bằng chứng. */
export function contradictionSummary(group: LiveContradiction): string {
  const fmt = (iso: string): string => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
  };
  const parts = group.facts.map(
    (f) =>
      `"${f.objectText}" (${fmt(f.validFrom)} – ${f.validUntil ? fmt(f.validUntil) : 'nay'}; ` +
      `nguồn: "${f.sourceText}" [${fmt(f.recordedAt)}])`,
  );
  return (
    `${group.subjectName} ${group.predicate} mâu thuẫn từ ${fmt(group.overlapFrom)}: ` +
    parts.join(' vs ') +
    '.'
  );
}

/** Fact trong một nhóm mâu thuẫn có đang overlap về thời gian không (kiểm tra nhanh). */
export function factsOverlap(a: GraphFact, b: GraphFact): boolean {
  const aEnd = a.validUntil === null ? Number.POSITIVE_INFINITY : parseMs(a.validUntil);
  const bEnd = b.validUntil === null ? Number.POSITIVE_INFINITY : parseMs(b.validUntil);
  return parseMs(a.validFrom) < bEnd && parseMs(b.validFrom) < aEnd;
}
