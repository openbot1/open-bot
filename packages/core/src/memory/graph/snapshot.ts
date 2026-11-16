/**
 * Temporal KG v2 — snapshot / time-travel (v1.12, Đội T3).
 *
 * Ý tưởng học từ Graphiti/Zep (bi-temporal edge: validity interval
 * tách biệt transaction time) nhưng tự thiết kế lại hoàn toàn cho
 * open-bot, 100% local, không copy code/text/tài sản của bất kỳ repo
 * nào.
 *
 * Cái v1.04 đã có (biTemporal.ts / temporalQuery.ts):
 *  - `queryFactsAt` / `queryFactsAtBiTemporal`: fact đúng tại T.
 *  - `invalidateFact`: đóng cửa sổ + audit JSONL.
 *  - `edgeValidityIntervals` / `factVersionTimeline`: timeline 1 edge.
 *
 * Cái v2 thêm lên trên — chưa có ở main:
 *  1. `snapshotGraphAt`: tái dựng TOÀN BỘ đồ thị như hệ thống đã
 *     biết tại thời điểm ghi nhận R — entity + fact + trạng thái
 *     của từng fact tại R (active / superseded / deleted /
 *     invalidated). Dùng để audit quyết định agent đưa ra trong quá
 *     khứ ("hôm qua bot trả lời dựa trên tri thức nào?").
 *  2. `diffSnapshots`: diff hai snapshot (fact thêm / mất / đổi
 *     trạng thái / đổi object giữa hai thời điểm ghi nhận).
 *  3. `changesSince`: changelog theo TRANSACTION time — mọi thay
 *     đổi (created / superseded / deleted / invalidated) kể từ R,
 *     gồm cả invalidate đọc từ audit log JSONL.
 *  4. `factValueAt`: giá trị đơn của một quan hệ (subject,
 *     predicate) tại thời điểm T, theo tri thức đã biết tại R —
 *     đáp án "Huy sống ở đâu vào tháng 6, theo những gì bot biết
 *     tới hôm qua".
 *  5. `validityGaps`: khoảng trống giữa các khoảng hiệu lực của một
 *     edge — thời gian mà hệ thống KHÔNG biết gì về quan hệ đó.
 *  6. `temporalCoverage`: thống kê bao phủ thời gian của cả đồ thị.
 *
 * Mọi hàm ở đây đều là pure read (không ghi), trừ việc đọc audit
 * log invalidate từ đĩa khi caller truyền workspaceDir.
 */

import type { GraphEntity, GraphFact, MemoryScope } from './types';
import { factDisplayText } from './types';
import type { TemporalGraphStore } from './store';
import { edgeValidityIntervals, readInvalidationLog } from './biTemporal';
import type { EdgeValidityInterval } from './biTemporal';

function parseMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(limit)));
}

function scopeOf(opts: { scope?: MemoryScope }): MemoryScope {
  return opts.scope ?? { userId: '', botId: '', runId: '' };
}

/** Trạng thái của một fact TẠI thời điểm ghi nhận R. */
export type FactStateAtRecordTime = 'active' | 'superseded' | 'deleted' | 'invalidated' | 'not-yet-known';

/** Một fact trong snapshot: fact gốc + trạng thái của nó tại R. */
export interface SnapshotFact {
  fact: GraphFact;
  subjectName: string;
  objectName?: string;
  /** Trạng thái của fact tại thời điểm ghi nhận R. */
  stateAtRecordTime: FactStateAtRecordTime;
  /** true = fact này là phiên bản "hiện tại" của edge tại R. */
  currentAtRecordTime: boolean;
}

/** Toàn bộ đồ thị như đã biết tại thời điểm ghi nhận R. */
export interface GraphSnapshot {
  /** Thời điểm ghi nhận (ISO). */
  recordedAt: string;
  /** Scope snapshot được chụp. */
  scope: MemoryScope;
  /** Entity có ít nhất một fact đã biết tại R (kèm factCount tại R). */
  entities: GraphEntity[];
  /** Mọi fact đã biết tại R (createdAt ≤ R), kèm trạng thái tại R. */
  facts: SnapshotFact[];
  /** Số fact đang đúng (cửa sổ hiệu lực mở) tại R — theo trục sự kiện tại R. */
  validAtRecordTime: number;
  /** Số fact đã bị invalidate (có invalidAt ≤ R). */
  invalidatedCount: number;
  /** Số fact bị supersede trước R. */
  supersededCount: number;
  /** Số fact bị xoá mềm trước R. */
  deletedCount: number;
}

/**
 * Trạng thái của một fact tại thời điểm ghi nhận R, suy từ các mốc
 * transaction time của nó:
 *  - createdAt > R → chưa biết (không vào snapshot).
 *  - invalidAt ≤ R → invalidated (mốc invalidate là mốc ghi nhận
 *    lần invalidate — xem InvalidationRecord.at — nhưng invalidAt
 *    cũng là thời điểm fact bắt đầu sai; dùng invalidAt vì đó là
 *    mốc có trên fact, không cần đọc log).
 *  - status deleted + validUntil ≤ R → deleted.
 *  - status superseded + validUntil ≤ R → superseded.
 *  - còn lại → active.
 *
 * Lưu ý: một fact superseded vẫn có thể "đúng" theo trục sự kiện
 * trước khi bị thay thế — `stateAtRecordTime` nói về trạng thái ghi
 * nhận, không nói về tính đúng sự kiện; muốn biết "đúng tại T"
 * thì dùng `queryFactsAtBiTemporal`.
 */
export function factStateAtRecordTime(fact: GraphFact, recordedMs: number): FactStateAtRecordTime {
  if (parseMs(fact.createdAt) > recordedMs) return 'not-yet-known';
  if (fact.invalidAt !== undefined && parseMs(fact.invalidAt) <= recordedMs) return 'invalidated';
  if (fact.status === 'deleted' && fact.validUntil !== null && parseMs(fact.validUntil) <= recordedMs) {
    return 'deleted';
  }
  if (fact.status === 'superseded' && fact.validUntil !== null && parseMs(fact.validUntil) <= recordedMs) {
    return 'superseded';
  }
  return 'active';
}

/**
 * Tái dựng toàn bộ đồ thị như hệ thống đã biết tại R.
 *
 * Fact lọt vào snapshot khi createdAt ≤ R. Entity lọt vào khi có
 * ít nhất một fact trong snapshot trỏ tới nó. `factCount` của entity
 * trong snapshot được tính lại theo fact tại R (chỉ fact active tại
 * R mới đếm — giống `recountFacts` của store).
 */
export function snapshotGraphAt(
  store: TemporalGraphStore,
  recordedAt: string | Date,
  opts: { scope?: MemoryScope; limit?: number } = {},
): GraphSnapshot {
  const recordedDate = recordedAt instanceof Date ? recordedAt : new Date(recordedAt);
  const recordedMs = recordedDate.getTime();
  const scope = scopeOf(opts);
  const limit = clampLimit(opts.limit, 5000, 20000);
  const empty: GraphSnapshot = {
    recordedAt: Number.isNaN(recordedMs) ? new Date().toISOString() : recordedDate.toISOString(),
    scope,
    entities: [],
    facts: [],
    validAtRecordTime: 0,
    invalidatedCount: 0,
    supersededCount: 0,
    deletedCount: 0,
  };
  if (Number.isNaN(recordedMs)) return empty;
  const facts = store.listFacts({ ...scope, limit: 20000 });
  const snapshotFacts: SnapshotFact[] = [];
  const entityIds = new Set<string>();
  let validAtRecordTime = 0;
  let invalidatedCount = 0;
  let supersededCount = 0;
  let deletedCount = 0;
  for (const fact of facts) {
    const state = factStateAtRecordTime(fact, recordedMs);
    if (state === 'not-yet-known') continue;
    // Fact đúng theo trục sự kiện tại R: cửa sổ hiệu lực phủ R.
    const validAtR =
      parseMs(fact.validFrom) <= recordedMs &&
      (fact.validUntil === null || parseMs(fact.validUntil) > recordedMs);
    if (validAtR) validAtRecordTime += 1;
    if (state === 'invalidated') invalidatedCount += 1;
    if (state === 'superseded') supersededCount += 1;
    if (state === 'deleted') deletedCount += 1;
    entityIds.add(fact.subjectId);
    if (fact.objectId) entityIds.add(fact.objectId);
    snapshotFacts.push({
      fact,
      subjectName: store.getEntity(fact.subjectId)?.name ?? 'user',
      ...(fact.objectId ? { objectName: store.getEntity(fact.objectId)?.name } : {}),
      stateAtRecordTime: state,
      currentAtRecordTime: state === 'active',
    });
  }
  snapshotFacts.sort((a, b) => a.fact.createdAt.localeCompare(b.fact.createdAt));
  const sliced = snapshotFacts.slice(0, limit);
  const activeCounts = new Map<string, number>();
  for (const entry of sliced) {
    if (entry.stateAtRecordTime !== 'active') continue;
    activeCounts.set(entry.fact.subjectId, (activeCounts.get(entry.fact.subjectId) ?? 0) + 1);
    if (entry.fact.objectId) {
      activeCounts.set(entry.fact.objectId, (activeCounts.get(entry.fact.objectId) ?? 0) + 1);
    }
  }
  const entities: GraphEntity[] = [];
  for (const id of entityIds) {
    const entity = store.getEntity(id);
    if (!entity) continue;
    entities.push({ ...entity, factCount: activeCounts.get(id) ?? 0 });
  }
  entities.sort((a, b) => a.name.localeCompare(b.name));
  return {
    recordedAt: recordedDate.toISOString(),
    scope,
    entities,
    facts: sliced,
    validAtRecordTime,
    invalidatedCount,
    supersededCount,
    deletedCount,
  };
}

/** Một thay đổi giữa hai snapshot. */
export type SnapshotDiffKind = 'added' | 'removed' | 'state-changed' | 'object-changed';

export interface SnapshotDiffEntry {
  kind: SnapshotDiffKind;
  factId: string;
  subjectName: string;
  predicate: string;
  /** Trạng thái / object trong snapshot cũ (null = chưa có). */
  before: { state: FactStateAtRecordTime; objectText: string } | null;
  /** Trạng thái / object trong snapshot mới (null = không còn). */
  after: { state: FactStateAtRecordTime; objectText: string } | null;
  text: string;
}

export interface SnapshotDiff {
  fromRecordedAt: string;
  toRecordedAt: string;
  added: SnapshotDiffEntry[];
  removed: SnapshotDiffEntry[];
  stateChanged: SnapshotDiffEntry[];
  objectChanged: SnapshotDiffEntry[];
  /** Tổng số mục thay đổi (4 nhóm cộng lại). */
  total: number;
}

/**
 * Diff hai snapshot: fact nào thêm (chỉ có ở snapshot mới), mất
 * (chỉ có ở snapshot cũ — thực tế hiếm vì fact không bị xoá vật lý,
 * nhưng snapshot cũ có thể hẹp hơn do limit), đổi trạng thái
 * (active → superseded / invalidated / deleted), đổi object (fact
 * cùng id nhưng objectText khác — chỉ xảy ra khi fact bị sửa trực
 * tiếp, vì supersede tạo fact mới).
 */
export function diffSnapshots(before: GraphSnapshot, after: GraphSnapshot): SnapshotDiff {
  const beforeById = new Map(before.facts.map((f) => [f.fact.id, f]));
  const afterById = new Map(after.facts.map((f) => [f.fact.id, f]));
  const added: SnapshotDiffEntry[] = [];
  const removed: SnapshotDiffEntry[] = [];
  const stateChanged: SnapshotDiffEntry[] = [];
  const objectChanged: SnapshotDiffEntry[] = [];
  const entry = (
    kind: SnapshotDiffKind,
    snap: SnapshotFact,
    beforeState: { state: FactStateAtRecordTime; objectText: string } | null,
    afterState: { state: FactStateAtRecordTime; objectText: string } | null,
  ): SnapshotDiffEntry => ({
    kind,
    factId: snap.fact.id,
    subjectName: snap.subjectName,
    predicate: snap.fact.predicate,
    before: beforeState,
    after: afterState,
    text: factDisplayText(snap.fact, snap.subjectName),
  });
  for (const snap of after.facts) {
    const prev = beforeById.get(snap.fact.id);
    if (!prev) {
      added.push(entry('added', snap, null, { state: snap.stateAtRecordTime, objectText: snap.fact.objectText ?? '' }));
      continue;
    }
    const beforeState = { state: prev.stateAtRecordTime, objectText: prev.fact.objectText ?? '' };
    const afterState = { state: snap.stateAtRecordTime, objectText: snap.fact.objectText ?? '' };
    if (beforeState.state !== afterState.state) {
      stateChanged.push(entry('state-changed', snap, beforeState, afterState));
    }
    if (beforeState.objectText !== afterState.objectText) {
      objectChanged.push(entry('object-changed', snap, beforeState, afterState));
    }
  }
  for (const snap of before.facts) {
    if (afterById.has(snap.fact.id)) continue;
    removed.push(
      entry('removed', snap, { state: snap.stateAtRecordTime, objectText: snap.fact.objectText ?? '' }, null),
    );
  }
  return {
    fromRecordedAt: before.recordedAt,
    toRecordedAt: after.recordedAt,
    added,
    removed,
    stateChanged,
    objectChanged,
    total: added.length + removed.length + stateChanged.length + objectChanged.length,
  };
}

/** Một thay đổi theo transaction time (kể từ R). */
export type TransactionChangeKind = 'created' | 'superseded' | 'deleted' | 'invalidated' | 'updated';

export interface TransactionChange {
  kind: TransactionChangeKind;
  fact: GraphFact;
  subjectName: string;
  /** Thời điểm thay đổi được ghi nhận (ISO). */
  at: string;
  /** Fact thay thế / bị thay thế (khi superseded). */
  relatedFactId?: string;
  /** Lý do invalidate (khi invalidated). */
  reason?: string;
  text: string;
}

/**
 * Changelog theo transaction time: mọi thay đổi được GHI NHẬN kể
 * từ thời điểm R (không phải thay đổi "đúng" kể từ R — một fact có
 * validFrom cũ vẫn có thể mới được ghi hôm nay).
 *
 * Nguồn mốc ghi nhận cho từng loại:
 *  - created: `createdAt` trong (R, ...].
 *  - superseded/deleted: `validUntil` (= lúc đóng) trong (R, ...]
 *    kèm status tương ứng.
 *  - invalidated: bản ghi trong audit log JSONL (thời điểm ghi
 *    `at` của lần invalidate) — cần workspaceDir; không có thì
 *    dùng `invalidAt` trên fact làm mốc dự phòng.
 *  - updated: `updatedAt` trong (R, ...] mà không thuộc 3 loại
 *    trên (vd đổi confidence / session) — để changelog không bỏ
 *    sót lần ghi nào.
 */
export function changesSince(
  store: TemporalGraphStore,
  since: string | Date,
  opts: { scope?: MemoryScope; workspaceDir?: string; limit?: number } = {},
): TransactionChange[] {
  const sinceDate = since instanceof Date ? since : new Date(since);
  if (Number.isNaN(sinceDate.getTime())) return [];
  const sinceMs = sinceDate.getTime();
  const scope = scopeOf(opts);
  const limit = clampLimit(opts.limit, 100, 1000);
  const out: TransactionChange[] = [];
  const seen = new Set<string>();
  const push = (change: TransactionChange): void => {
    const key = `${change.kind}|${change.fact.id}|${change.at}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(change);
  };
  const invalidationAtByFact = new Map<string, string>();
  if (opts.workspaceDir) {
    for (const record of readInvalidationLog(opts.workspaceDir, 1000)) {
      if (!invalidationAtByFact.has(record.factId)) {
        invalidationAtByFact.set(record.factId, record.at);
      }
    }
  }
  for (const fact of store.listFacts({ ...scope, limit: 20000 })) {
    const subjectName = store.getEntity(fact.subjectId)?.name ?? 'user';
    const text = factDisplayText(fact, subjectName);
    if (parseMs(fact.createdAt) > sinceMs) {
      push({ kind: 'created', fact, subjectName, at: fact.createdAt, text });
    }
    if (fact.validUntil !== null && parseMs(fact.validUntil) > sinceMs) {
      if (fact.status === 'superseded') {
        push({
          kind: 'superseded',
          fact,
          subjectName,
          at: fact.validUntil,
          ...(fact.supersededBy ? { relatedFactId: fact.supersededBy } : {}),
          text,
        });
      } else if (fact.status === 'deleted') {
        push({ kind: 'deleted', fact, subjectName, at: fact.validUntil, text });
      }
    }
    if (fact.invalidAt !== undefined) {
      const at = invalidationAtByFact.get(fact.id) ?? fact.invalidAt;
      if (parseMs(at) > sinceMs) {
        push({
          kind: 'invalidated',
          fact,
          subjectName,
          at,
          ...(fact.invalidationReason ? { reason: fact.invalidationReason } : {}),
          text,
        });
      }
    }
    // Updated mà không thuộc loại trên: vẫn ghi nhận để không sót.
    if (
      parseMs(fact.updatedAt) > sinceMs &&
      parseMs(fact.createdAt) <= sinceMs &&
      !(fact.validUntil !== null && parseMs(fact.validUntil) > sinceMs) &&
      fact.invalidAt === undefined
    ) {
      push({ kind: 'updated', fact, subjectName, at: fact.updatedAt, text });
    }
  }
  out.sort((a, b) => a.at.localeCompare(b.at));
  return out.slice(0, limit);
}

/** Giá trị của một quan hệ tại thời điểm T (theo tri thức tại R). */
export interface FactValueAt {
  /** true = có fact đúng tại T. */
  found: boolean;
  fact?: GraphFact;
  subjectName: string;
  predicate: string;
  objectText?: string;
  objectName?: string;
  /** Cửa sổ hiệu lực của fact tìm được. */
  validFrom?: string;
  validUntil?: string | null;
  /** true = fact này là phiên bản hiện tại của edge tại R. */
  currentAtRecordTime?: boolean;
  /** Thời điểm sự kiện được hỏi (ISO). */
  at: string;
  /** Thời điểm ghi nhận được hỏi (ISO). */
  recordedAt: string;
}

/**
 * Giá trị đơn của (subject, predicate) tại thời điểm T.
 *
 * Trục sự kiện: validFrom ≤ T < validUntil. Trục ghi nhận: fact
 * phải tồn tại (createdAt ≤ R) và — nếu đã bị đóng cửa sổ — mốc
 * đóng phải > R thì mới tính là "hiện tại" tại R; nếu có nhiều fact
 * cùng đúng tại T (overlap chưa xử lý), chọn fact có validFrom
 * muộn nhất (phiên bản mới nhất), và báo `overlaps` để caller cờ
 * mâu thuẫn chưa xử lý.
 */
export function factValueAt(
  store: TemporalGraphStore,
  subjectName: string,
  predicate: string,
  at: string | Date,
  opts: { scope?: MemoryScope; recordedAt?: string | Date; limit?: number } = {},
): FactValueAt & { overlaps: number } {
  const atDate = at instanceof Date ? at : new Date(at);
  const recordedDate =
    opts.recordedAt === undefined
      ? new Date()
      : opts.recordedAt instanceof Date
        ? opts.recordedAt
        : new Date(opts.recordedAt);
  const base: FactValueAt & { overlaps: number } = {
    found: false,
    subjectName,
    predicate: predicate.trim().toLowerCase().replace(/\s+/g, '_'),
    at: Number.isNaN(atDate.getTime()) ? '' : atDate.toISOString(),
    recordedAt: Number.isNaN(recordedDate.getTime()) ? '' : recordedDate.toISOString(),
    overlaps: 0,
  };
  if (Number.isNaN(atDate.getTime()) || Number.isNaN(recordedDate.getTime())) return base;
  const entity = store.findEntityByName(subjectName);
  if (!entity) return base;
  const scope = scopeOf(opts);
  const atMs = atDate.getTime();
  const recordedMs = recordedDate.getTime();
  const pred = base.predicate;
  const candidates = store
    .listFacts({ ...scope, predicate: pred, limit: 20000 })
    .filter((f) => f.subjectId === entity.id)
    .filter((f) => parseMs(f.createdAt) <= recordedMs)
    .filter((f) => parseMs(f.validFrom) <= atMs)
    .filter((f) => f.validUntil === null || parseMs(f.validUntil) > atMs);
  if (candidates.length === 0) return base;
  // Mới nhất trước (validFrom muộn nhất, rồi createdAt muộn nhất).
  candidates.sort((a, b) => {
    const byFrom = parseMs(b.validFrom) - parseMs(a.validFrom);
    if (byFrom !== 0) return byFrom;
    return parseMs(b.createdAt) - parseMs(a.createdAt);
  });
  const best = candidates[0];
  if (!best) return base;
  const currentAtRecordTime =
    best.status === 'active' ||
    (best.validUntil !== null && parseMs(best.validUntil) > recordedMs);
  return {
    ...base,
    found: true,
    fact: best,
    objectText: best.objectText,
    ...(best.objectId ? { objectName: store.getEntity(best.objectId)?.name } : {}),
    validFrom: best.validFrom,
    validUntil: best.validUntil,
    currentAtRecordTime,
    overlaps: candidates.length - 1,
  };
}

/** Một khoảng trống hiệu lực của một edge. */
export interface ValidityGap {
  /** Khoảng trống bắt đầu khi khoảng trước đóng (ISO). */
  gapFrom: string;
  /** Khoảng trống kết thúc khi khoảng sau mở (ISO, null = tới nay). */
  gapTo: string | null;
  /** Fact đóng trước khoảng trống (null = edge chưa từng có fact). */
  beforeFactId: string | null;
  /** Fact mở sau khoảng trống (null = chưa có fact mới). */
  afterFactId: string | null;
}

/**
 * Khoảng trống giữa các khoảng hiệu lực của một edge (subject,
 * predicate): thời gian mà hệ thống KHÔNG biết gì về quan hệ đó.
 * Khoảng trống đầu (trước fact đầu tiên) không tính — chỉ tính
 * khoảng giữa hai fact liên tiếp, cộng khoảng từ fact cuối (đã
 * đóng) tới nay nếu edge hiện không có fact nào đúng.
 */
export function validityGaps(
  store: TemporalGraphStore,
  subjectName: string,
  predicate: string,
  scope: MemoryScope,
  opts: { now?: Date } = {},
): ValidityGap[] {
  const intervals: EdgeValidityInterval[] = edgeValidityIntervals(store, subjectName, predicate, scope);
  if (intervals.length === 0) return [];
  const now = opts.now ?? new Date();
  const gaps: ValidityGap[] = [];
  const sorted = [...intervals].sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    const current = sorted[i];
    const next = sorted[i + 1];
    if (!current || !next) continue;
    if (current.validUntil === null) continue; // khoảng hiện tại còn mở — không có trống sau nó.
    const endMs = parseMs(current.validUntil);
    const nextStartMs = parseMs(next.validFrom);
    if (nextStartMs <= endMs) continue; // overlap hoặc kề nhau — không trống.
    gaps.push({
      gapFrom: current.validUntil,
      gapTo: next.validFrom,
      beforeFactId: current.factId,
      afterFactId: next.factId,
    });
  }
  const last = sorted[sorted.length - 1];
  if (last && last.validUntil !== null && parseMs(last.validUntil) < now.getTime()) {
    gaps.push({
      gapFrom: last.validUntil,
      gapTo: null,
      beforeFactId: last.factId,
      afterFactId: null,
    });
  }
  return gaps;
}

/** Thống kê bao phủ thời gian của cả đồ thị (một scope). */
export interface TemporalCoverage {
  scope: MemoryScope;
  totalFacts: number;
  activeFacts: number;
  /** Fact có cửa sổ đóng sẵn (validUntil != null). */
  closedFacts: number;
  /** Fact đã bị invalidate (có invalidAt). */
  invalidatedFacts: number;
  /** Fact bị supersede. */
  supersededFacts: number;
  /** Fact bị xoá mềm. */
  deletedFacts: number;
  /** Số edge (subject, predicate) có ≥ 2 khoảng hiệu lực overlap nhau. */
  edgesWithOverlaps: number;
  /** Số edge có khoảng trống hiệu lực. */
  edgesWithGaps: number;
  /** Tuổi trung bình của fact active (ngày, từ validFrom tới nay). */
  avgActiveAgeDays: number;
  /** Fact cũ nhất / mới nhất (createdAt). */
  oldestFactAt: string | null;
  newestFactAt: string | null;
}

/**
 * Thống kê bao phủ thời gian: đếm theo status/invalidAt + quét
 * overlap/gap theo từng edge. Dùng cho dashboard memory health và
 * cho `temporal_kg_snapshot` khi caller cần con số tổng quan.
 */
export function temporalCoverage(
  store: TemporalGraphStore,
  scope: MemoryScope,
  opts: { now?: Date } = {},
): TemporalCoverage {
  const now = opts.now ?? new Date();
  const facts = store.listFacts({ ...scope, limit: 20000 });
  const byEdge = new Map<string, GraphFact[]>();
  for (const fact of facts) {
    const key = `${fact.subjectId}|${fact.predicate}`;
    const list = byEdge.get(key) ?? [];
    list.push(fact);
    byEdge.set(key, list);
  }
  let edgesWithOverlaps = 0;
  let edgesWithGaps = 0;
  for (const [key, edgeFacts] of byEdge) {
    const [subjectId, predicate] = key.split('|');
    const subject = store.getEntity(subjectId ?? '');
    if (!subject) continue;
    const intervals = edgeValidityIntervals(store, subject.name, predicate ?? '', scope).filter((iv) =>
      edgeFacts.some((f) => f.id === iv.factId),
    );
    // Overlap: hai khoảng cùng phủ một thời điểm với object khác nhau.
    let hasOverlap = false;
    const sorted = [...intervals].sort((a, b) => a.validFrom.localeCompare(b.validFrom));
    for (let i = 0; i < sorted.length && !hasOverlap; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const first = sorted[i];
        const second = sorted[j];
        if (!first || !second || first.objectText === second.objectText) continue;
        const firstEnd = first.validUntil === null ? Number.POSITIVE_INFINITY : parseMs(first.validUntil);
        if (parseMs(second.validFrom) < firstEnd) hasOverlap = true;
      }
    }
    if (hasOverlap) edgesWithOverlaps += 1;
    if (validityGaps(store, subject.name, predicate ?? '', scope, { now }).length > 0) {
      edgesWithGaps += 1;
    }
  }
  const active = facts.filter((f) => f.status === 'active');
  const ages = active.map((f) => Math.max(0, now.getTime() - parseMs(f.validFrom)) / 86400000);
  const createdAts = facts.map((f) => f.createdAt).sort();
  return {
    scope,
    totalFacts: facts.length,
    activeFacts: active.length,
    closedFacts: facts.filter((f) => f.validUntil !== null).length,
    invalidatedFacts: facts.filter((f) => f.invalidAt !== undefined).length,
    supersededFacts: facts.filter((f) => f.status === 'superseded').length,
    deletedFacts: facts.filter((f) => f.status === 'deleted').length,
    edgesWithOverlaps,
    edgesWithGaps,
    avgActiveAgeDays:
      ages.length === 0 ? 0 : Math.round((ages.reduce((a, b) => a + b, 0) / ages.length) * 10) / 10,
    oldestFactAt: createdAts[0] ?? null,
    newestFactAt: createdAts[createdAts.length - 1] ?? null,
  };
}
