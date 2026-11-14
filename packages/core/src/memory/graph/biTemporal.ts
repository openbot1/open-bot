/**
 * Temporal KG v2 — bi-temporal edges (v1.04, Đội T1).
 *
 * Ý tưởng học từ Graphiti (Zep): edge mang validity intervals
 * (thời gian sự kiện đúng) tách biệt với thời gian ghi nhận
 * (transaction time), mâu thuẫn thì invalidate chứ không xóa —
 * tự thiết kế lại hoàn toàn cho open-bot, 100% local, không copy
 * code/text/tài sản của bất kỳ repo nào.
 *
 * Kế thừa, không làm lại:
 *  - `GraphFact` (v0.98) ĐÃ là bi-temporal: `validFrom` /
 *    `validUntil` (thời gian sự kiện) + `createdAt` / `updatedAt`
 *    (thời gian ghi nhận), superseded facts được giữ lại.
 *  - `queryFactsAt` / `findChangesInWindow` /
 *    `findContradictionsBetween` (v1.02, temporalQuery.ts) đã trả
 *    lời "fact đúng tại thời điểm T" theo cửa sổ sự kiện.
 *  - `setFactValidity` / `validityReport` / `sweepExpiredFacts`
 *    (v1.03) đã quản lý cửa sổ hiệu lực.
 *
 * Cái v2 thêm lên trên — chưa có ở main:
 *  1. `invalidateFact`: đóng cửa sổ hiệu lực của một fact vì MÂU
 *     THUẪN (không phải vì hết hạn, không phải vì bị thay thế bởi
 *     fact mới) — fact giữ status `active` nhưng `validUntil` =
 *     thời điểm invalidate, kèm bản ghi audit vào JSONL
 *     `.open-bot/memory-invalidations.jsonl`. Lịch sử vẫn truy vấn
 *     được: fact từng đúng trước thời điểm đó.
 *  2. `queryFactsAtBiTemporal`: "fact đúng tại thời điểm T" theo
 *     CẢ hai trục — trục sự kiện (validFrom ≤ T < validUntil) VÀ
 *     trục ghi nhận (fact đã được ghi vào đồ thị trước thời điểm
 *     R, và chưa bị supersede/delete trước R). Đây là truy vấn
 *     "chúng ta ĐÃ BIẾT gì tại thời điểm R về thời điểm T" — vd
 *     audit lại quyết định agent đưa ra hôm qua với tri thức lúc đó.
 *  3. `edgeValidityIntervals`: toàn bộ khoảng hiệu lực của một edge
 *     (subject —predicate→ *) — mọi phiên bản fact của edge đó,
 *     xếp theo thời gian, kèm trạng thái và thời điểm ghi nhận.
 *     Dùng để vẽ timeline của một quan hệ.
 *  4. `findInvalidatedFacts` / `readInvalidationLog`: fact nào đã
 *     bị invalidate, vì sao, bởi ai — audit trail.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { GraphFact, MemoryScope } from './types';
import { factDisplayText } from './types';
import type { TemporalGraphStore } from './store';

/** File audit JSONL cho các lần invalidate (một dòng / một lần). */
export const MEMORY_INVALIDATIONS_REL_PATH = path.join(
  '.open-bot',
  'memory-invalidations.jsonl',
);
/** Số dòng log tối đa khi đọc (chặn file phình vô hạn). */
export const MAX_INVALIDATION_LOG_LINES = 1000;

function parseMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Một lần invalidate: fact nào, từ lúc nào thì không còn đúng, vì sao. */
export interface InvalidationRecord {
  id: string;
  factId: string;
  subjectName: string;
  predicate: string;
  objectText: string;
  /** Từ thời điểm này fact không còn đúng (ISO). */
  invalidAt: string;
  /** Cửa sổ hiệu lực trước khi invalidate (để audit). */
  previousValidUntil: string | null;
  /** Lý do: mâu thuẫn với fact nào / bằng chứng nào. */
  reason: string;
  /** Fact mâu thuẫn (nếu có). */
  conflictingFactId?: string;
  actor: string;
  /** Thời điểm ghi nhận lần invalidate (ISO). */
  at: string;
}

export interface InvalidateFactResult {
  fact: GraphFact;
  record: InvalidationRecord;
  /** true = đã ghi dòng audit vào JSONL. */
  logWritten: boolean;
}

/**
 * Invalidate một fact vì mâu thuẫn: đóng `validUntil` = invalidAt
 * (qua `setFactValidity` có sẵn — không động status hay chuỗi
 * supersession), ghi bản ghi audit. Fact KHÔNG bị xoá: trước
 * invalidAt nó vẫn đúng, sau invalidAt nó không còn đúng.
 *
 * `invalidAt` phải nằm trong cửa sổ hiệu lực hiện tại của fact
 * (validFrom ≤ invalidAt; nếu fact đã có validUntil thì invalidAt
 * phải < validUntil) — invalidate một fact đã hết hiệu lực là vô
 * nghĩa và bị chặn.
 */
export function invalidateFact(
  store: TemporalGraphStore,
  factId: string,
  invalidAt: string | Date,
  reason: string,
  actor: string,
  opts: { workspaceDir?: string; conflictingFactId?: string; now?: Date } = {},
): InvalidateFactResult {
  const fact = store.getFact(factId);
  if (!fact) throw new Error('Không tìm thấy fact.');
  const invalidMs = invalidAt instanceof Date ? invalidAt.getTime() : Date.parse(invalidAt);
  if (Number.isNaN(invalidMs)) throw new Error('invalidAt không phải thời gian hợp lệ.');
  const fromMs = parseMs(fact.validFrom);
  if (invalidMs < fromMs) {
    throw new Error('invalidAt phải >= validFrom của fact (không thể invalidate trước khi fact bắt đầu đúng).');
  }
  if (fact.validUntil !== null && invalidMs >= parseMs(fact.validUntil)) {
    throw new Error('Fact đã hết hiệu lực trước invalidAt — không cần invalidate nữa.');
  }
  const cleanReason = (reason ?? '').trim().slice(0, 1000);
  if (cleanReason === '') throw new Error('Lý do invalidate không được rỗng (cần audit được).');
  // Chụp cửa sổ cũ TRƯỚC khi setFactValidity mutate cùng object.
  const previousValidUntil = fact.validUntil;
  const updated = store.setFactValidity(factId, { validUntil: new Date(invalidMs).toISOString() });
  const record: InvalidationRecord = {
    id: randomUUID(),
    factId: fact.id,
    subjectName: store.getEntity(fact.subjectId)?.name ?? 'user',
    predicate: fact.predicate,
    objectText: fact.objectText ?? '',
    invalidAt: new Date(invalidMs).toISOString(),
    previousValidUntil,
    reason: cleanReason,
    ...(opts.conflictingFactId ? { conflictingFactId: opts.conflictingFactId } : {}),
    actor: (actor ?? '').trim() || 'system',
    at: (opts.now ?? new Date()).toISOString(),
  };
  let logWritten = false;
  if (opts.workspaceDir) {
    try {
      const dir = path.join(opts.workspaceDir, '.open-bot');
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(
        path.join(opts.workspaceDir, MEMORY_INVALIDATIONS_REL_PATH),
        JSON.stringify(record) + '\n',
        { mode: 0o600 },
      );
      logWritten = true;
    } catch {
      logWritten = false;
    }
  }
  return { fact: updated, record, logWritten };
}

/** Đọc N bản ghi invalidate mới nhất (bỏ dòng hỏng, không throw). */
export function readInvalidationLog(workspaceDir: string, limit = 50): InvalidationRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(workspaceDir, MEMORY_INVALIDATIONS_REL_PATH), 'utf8');
  } catch {
    return [];
  }
  const out: InvalidationRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as InvalidationRecord;
      if (typeof parsed.factId === 'string' && typeof parsed.invalidAt === 'string') out.push(parsed);
    } catch {
      // Dòng hỏng — bỏ qua.
    }
  }
  const n = Math.min(Math.max(Math.floor(limit), 1), MAX_INVALIDATION_LOG_LINES);
  return out.slice(-n).reverse();
}

/** Fact đã bị invalidate (có bản ghi trong log) — kèm bản ghi mới nhất. */
export function findInvalidatedFacts(
  store: TemporalGraphStore,
  workspaceDir: string,
  scope: MemoryScope,
): Array<{ fact: GraphFact; record: InvalidationRecord }> {
  const records = readInvalidationLog(workspaceDir, MAX_INVALIDATION_LOG_LINES);
  const latestByFact = new Map<string, InvalidationRecord>();
  for (const record of records) {
    if (!latestByFact.has(record.factId)) latestByFact.set(record.factId, record);
  }
  const out: Array<{ fact: GraphFact; record: InvalidationRecord }> = [];
  for (const [factId, record] of latestByFact) {
    const fact = store.getFact(factId);
    if (!fact) continue;
    if (scope.userId !== '' && fact.scope.userId !== '' && fact.scope.userId !== scope.userId) continue;
    if (scope.botId !== '' && fact.scope.botId !== '' && fact.scope.botId !== scope.botId) continue;
    out.push({ fact, record });
  }
  out.sort((a, b) => b.record.at.localeCompare(a.record.at));
  return out;
}

export interface BiTemporalQueryOptions {
  scope?: MemoryScope;
  /**
   * Thời điểm ghi nhận R (mặc định: bây giờ): chỉ tính fact mà hệ
   * thống ĐÃ BIẾT tại R — fact tạo sau R không lọt vào, fact bị
   * supersede/delete trước R được tính là còn hiệu lực tại R nếu
   * cửa sổ sự kiện của nó phủ T.
   */
  recordedAt?: string | Date;
  limit?: number;
}

export interface FactAtBiTemporalTime {
  fact: GraphFact;
  subjectName: string;
  objectName?: string;
  /** Thời điểm sự kiện được hỏi (ISO). */
  at: string;
  /** Thời điểm ghi nhận được hỏi (ISO). */
  recordedAt: string;
  /** true = fact này đang là phiên bản "hiện tại" của edge tại R. */
  currentAtRecordTime: boolean;
}

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(limit)));
}

/**
 * Fact đúng tại thời điểm T, theo tri thức đã biết tại thời điểm R.
 *
 * Trục sự kiện: validFrom ≤ T < validUntil (validUntil null = tới nay).
 * Trục ghi nhận: createdAt ≤ R (fact phải tồn tại lúc R) và — nếu
 * fact đã bị supersede/delete — thời điểm đóng cửa sổ (validUntil
 * của bản bị thay thế = lúc thay thế) phải > R thì fact mới được
 * tính là "đang đúng" tại R; ngược lại, tại R hệ thống đã biết fact
 * mới hơn rồi nên bản cũ không còn là đáp án.
 *
 * Status bị bỏ qua có chủ đích ở trục sự kiện (như `queryFactsAt`):
 * fact superseded vẫn từng đúng trước khi bị thay thế.
 */
export function queryFactsAtBiTemporal(
  store: TemporalGraphStore,
  at: string | Date,
  opts: BiTemporalQueryOptions = {},
): FactAtBiTemporalTime[] {
  const atDate = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(atDate.getTime())) return [];
  const recordedDate =
    opts.recordedAt === undefined
      ? new Date()
      : opts.recordedAt instanceof Date
        ? opts.recordedAt
        : new Date(opts.recordedAt);
  if (Number.isNaN(recordedDate.getTime())) return [];
  const atMs = atDate.getTime();
  const recordedMs = recordedDate.getTime();
  const scope = opts.scope ?? { userId: '', botId: '', runId: '' };
  const limit = clampLimit(opts.limit, 100, 1000);
  const facts = store.listFacts({ ...scope, limit: 5000 });
  const out: FactAtBiTemporalTime[] = [];
  for (const fact of facts) {
    // Trục ghi nhận: fact chưa tồn tại tại R → hệ thống chưa biết.
    if (parseMs(fact.createdAt) > recordedMs) continue;
    // Trục sự kiện: cửa sổ hiệu lực phải phủ T.
    if (parseMs(fact.validFrom) > atMs) continue;
    if (fact.validUntil !== null && parseMs(fact.validUntil) <= atMs) continue;
    // Trục ghi nhận (phiên bản hiện tại): nếu fact đã bị đóng cửa
    // sổ TRƯỚC R thì tại R nó không còn là đáp án hiện tại nữa —
    // nhưng nó vẫn từng đúng tại T, nên vẫn trả về với cờ false.
    // Fact active (validUntil null) hoặc đóng sau R → current = true.
    const currentAtRecordTime =
      fact.status === 'active' ||
      (fact.validUntil !== null && parseMs(fact.validUntil) > recordedMs);
    out.push({
      fact,
      subjectName: store.getEntity(fact.subjectId)?.name ?? 'user',
      ...(fact.objectId ? { objectName: store.getEntity(fact.objectId)?.name } : {}),
      at: atDate.toISOString(),
      recordedAt: recordedDate.toISOString(),
      currentAtRecordTime,
    });
  }
  out.sort((a, b) => a.fact.validFrom.localeCompare(b.fact.validFrom));
  return out.slice(0, limit);
}

/** Một khoảng hiệu lực của một edge (subject —predicate→ object). */
export interface EdgeValidityInterval {
  factId: string;
  subjectName: string;
  predicate: string;
  objectText: string;
  validFrom: string;
  validUntil: string | null;
  status: GraphFact['status'];
  /** Thời điểm ghi nhận fact (createdAt). */
  recordedAt: string;
  /** Thời điểm ghi nhận lần sửa cuối (updatedAt). */
  lastRecordedAt: string;
  confidence: number;
  /** Text hiển thị của fact trong khoảng này. */
  text: string;
}

/**
 * Toàn bộ khoảng hiệu lực của một edge: mọi fact (mọi phiên bản,
 * mọi status) của (subject, predicate), xếp theo validFrom. Hai
 * khoảng kề nhau không overlap là bình thường (fact cũ đóng đúng
 * lúc fact mới mở); overlap = dữ liệu đáng ngờ (hai fact cùng đúng
 * một lúc với object khác nhau) — caller có thể cờ lên từ đây.
 */
export function edgeValidityIntervals(
  store: TemporalGraphStore,
  subjectName: string,
  predicate: string,
  scope: MemoryScope,
): EdgeValidityInterval[] {
  const entity = store.findEntityByName(subjectName);
  if (!entity) return [];
  const pred = predicate.trim().toLowerCase().replace(/\s+/g, '_');
  const facts = store
    .listFacts({ ...scope, predicate: pred, limit: 5000 })
    .filter((f) => f.subjectId === entity.id);
  const intervals = facts.map((fact) => ({
    factId: fact.id,
    subjectName: entity.name,
    predicate: fact.predicate,
    objectText: fact.objectText ?? '',
    validFrom: fact.validFrom,
    validUntil: fact.validUntil,
    status: fact.status,
    recordedAt: fact.createdAt,
    lastRecordedAt: fact.updatedAt,
    confidence: fact.confidence,
    text: factDisplayText(fact, entity.name),
  }));
  intervals.sort((a, b) => {
    const byFrom = a.validFrom.localeCompare(b.validFrom);
    if (byFrom !== 0) return byFrom;
    return a.recordedAt.localeCompare(b.recordedAt);
  });
  return intervals;
}

/** Overlap giữa các khoảng hiệu lực của một edge (dấu hiệu mâu thuẫn chưa xử lý). */
export interface EdgeIntervalOverlap {
  first: EdgeValidityInterval;
  second: EdgeValidityInterval;
  /** Giao nhau từ ... đến ... (ISO). */
  overlapFrom: string;
  overlapTo: string | null;
}

/** Tìm các cặp khoảng hiệu lực overlap nhau trong một edge. */
export function findEdgeIntervalOverlaps(
  intervals: EdgeValidityInterval[],
): EdgeIntervalOverlap[] {
  const out: EdgeIntervalOverlap[] = [];
  const sorted = [...intervals].sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const first = sorted[i];
      const second = sorted[j];
      if (!first || !second) continue;
      if (first.objectText === second.objectText) continue;
      const firstEnd = first.validUntil === null ? Number.POSITIVE_INFINITY : parseMs(first.validUntil);
      const secondStart = parseMs(second.validFrom);
      if (secondStart >= firstEnd) continue;
      const overlapFrom = second.validFrom;
      const overlapTo =
        first.validUntil === null
          ? second.validUntil
          : second.validUntil === null
            ? first.validUntil
            : parseMs(first.validUntil) <= parseMs(second.validUntil)
              ? first.validUntil
              : second.validUntil;
      out.push({ first, second, overlapFrom, overlapTo });
    }
  }
  return out;
}

/** Một bước trong timeline phiên bản của một edge. */
export interface FactVersionStep {
  /** Thời điểm bước này diễn ra (ISO). */
  at: string;
  kind: 'created' | 'superseded' | 'deleted' | 'invalidated' | 'active';
  factId: string;
  objectText: string;
  validFrom: string;
  validUntil: string | null;
  status: GraphFact['status'];
  /** Lý do invalidate (chỉ cho bước invalidated). */
  reason?: string;
  text: string;
}

/**
 * Timeline phiên bản đầy đủ của một edge (subject —predicate→ *):
 * mọi fact của edge + mọi lần invalidate, xếp theo thời gian.
 * Khác `edgeValidityIntervals` ở chỗ gộp cả audit log invalidate
 * (để thấy "fact này bị invalidate lúc nào, vì sao") và gắn nhãn
 * từng bước (created / superseded / deleted / invalidated).
 */
export function factVersionTimeline(
  store: TemporalGraphStore,
  subjectName: string,
  predicate: string,
  scope: MemoryScope,
  opts: { workspaceDir?: string } = {},
): FactVersionStep[] {
  const intervals = edgeValidityIntervals(store, subjectName, predicate, scope);
  const invalidations = opts.workspaceDir
    ? readInvalidationLog(opts.workspaceDir, MAX_INVALIDATION_LOG_LINES)
    : [];
  const invalidationByFact = new Map<string, InvalidationRecord>();
  for (const record of invalidations) {
    if (!invalidationByFact.has(record.factId)) invalidationByFact.set(record.factId, record);
  }
  const steps: FactVersionStep[] = [];
  for (const interval of intervals) {
    const fact = store.getFact(interval.factId);
    const kind: FactVersionStep['kind'] =
      interval.status === 'superseded'
        ? 'superseded'
        : interval.status === 'deleted'
          ? 'deleted'
          : 'active';
    steps.push({
      at: interval.recordedAt,
      kind: 'created',
      factId: interval.factId,
      objectText: interval.objectText,
      validFrom: interval.validFrom,
      validUntil: interval.validUntil,
      status: interval.status,
      text: interval.text,
    });
    // Bước đóng cửa sổ (khi fact bị supersede/delete/invalidate).
    if (fact && fact.validUntil !== null && fact.status !== 'active') {
      steps.push({
        at: fact.validUntil,
        kind,
        factId: interval.factId,
        objectText: interval.objectText,
        validFrom: interval.validFrom,
        validUntil: interval.validUntil,
        status: interval.status,
        text: interval.text,
      });
    }
    const invalidation = invalidationByFact.get(interval.factId);
    if (invalidation) {
      steps.push({
        at: invalidation.at,
        kind: 'invalidated',
        factId: interval.factId,
        objectText: interval.objectText,
        validFrom: interval.validFrom,
        validUntil: interval.validUntil,
        status: interval.status,
        reason: invalidation.reason,
        text: interval.text,
      });
    }
  }
  steps.sort((a, b) => {
    const byAt = a.at.localeCompare(b.at);
    if (byAt !== 0) return byAt;
    return a.factId.localeCompare(b.factId);
  });
  return steps;
}
