/**
 * Temporal KG v2 — export / import bi-temporal snapshot (v1.12, Đội T3).
 *
 * Ý tưởng: snapshot bi-temporal là đơn vị backup / đồng bộ của đồ
 * thị — mang đủ cả hai trục thời gian (validFrom/validUntil +
 * createdAt/updatedAt + invalidAt) và provenance (episodeId) để
 * bên nhận tái dựng đúng lịch sử, không chỉ "trạng thái hiện tại".
 * Tự thiết kế lại hoàn toàn cho open-bot, 100% local, không copy
 * code/text/tài sản của bất kỳ repo nào.
 *
 * QUY TẮC AN TOÀN khi import (add-only, giống triết lý của graph):
 *  - Chỉ THÊM entity/fact/episode chưa có (so theo id) — KHÔNG BAO
 *    GIỜ ghi đè fact đã có (lịch sử của kho đích không được sửa).
 *  - Fact import phải có provenance đầy đủ (episodeId + sourceText)
 *    và cửa sổ hiệu lực hợp lệ (validUntil ≥ validFrom nếu có) —
 *    fact thiếu provenance hoặc cửa sổ sai bị bỏ qua + liệt kê lỗi.
 *  - Episode import phải có text; episode trùng turnId+botId với
 *    episode đã có thì bỏ qua (chống ingest trùng).
 *  - Invalidation import: chỉ thêm bản ghi chưa có (so theo id);
 *    fact đích đã có invalidAt thì KHÔNG đổi (lần invalidate đầu
 *    tiên mới là mốc).
 *  - Import KHÔNG đụng quarantine/shares của kho đích.
 *
 * File snapshot là JSON thuần (version 2) — đọc được bằng tay, ghi
 * bằng `JSON.stringify(snapshot, null, 2)`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GraphEntity, GraphEpisode, GraphFact, MemoryScope } from './types';
import type { TemporalGraphStore } from './store';
import { readInvalidationLog } from './biTemporal';
import type { InvalidationRecord } from './biTemporal';

/** Version của định dạng snapshot bi-temporal. */
export const TEMPORAL_SNAPSHOT_VERSION = 2;

export interface TemporalSnapshot {
  version: 2;
  /** Thời điểm xuất (ISO). */
  exportedAt: string;
  /** Thời điểm ghi nhận mà snapshot chụp (ISO, '' = toàn bộ lịch sử). */
  recordedAt: string;
  scope: MemoryScope;
  entities: GraphEntity[];
  facts: GraphFact[];
  episodes: GraphEpisode[];
  /** Bản ghi invalidate (audit log JSONL, nếu có workspaceDir). */
  invalidations: InvalidationRecord[];
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Xuất snapshot bi-temporal của một scope: toàn bộ entity/fact/
 * episode của scope + bản ghi invalidate (khi có workspaceDir).
 * `recordedAt` rỗng = xuất toàn bộ lịch sử (mọi fact, mọi status);
 * có `recordedAt` thì chỉ xuất fact đã biết tại R (createdAt ≤ R)
 * — snapshot "như đã biết lúc R" để audit / khôi phục đúng tri
 * thức thời điểm đó.
 */
export function exportTemporalSnapshot(
  store: TemporalGraphStore,
  scope: MemoryScope,
  opts: { workspaceDir?: string; recordedAt?: string | Date } = {},
): TemporalSnapshot {
  const recordedMs =
    opts.recordedAt === undefined
      ? Number.POSITIVE_INFINITY
      : opts.recordedAt instanceof Date
        ? opts.recordedAt.getTime()
        : Date.parse(opts.recordedAt);
  const recordedAt =
    opts.recordedAt === undefined
      ? ''
      : Number.isNaN(recordedMs)
        ? ''
        : new Date(recordedMs).toISOString();
  const facts = store
    .listFacts({ ...scope, limit: 20000 })
    .filter((f) => Date.parse(f.createdAt) <= recordedMs);
  const entityIds = new Set<string>();
  for (const fact of facts) {
    entityIds.add(fact.subjectId);
    if (fact.objectId) entityIds.add(fact.objectId);
  }
  const entities = store
    .listEntities()
    .filter((e) => entityIds.has(e.id))
    .map((e) => ({ ...e }));
  const episodeIds = new Set(facts.map((f) => f.provenance.episodeId));
  const episodes = store
    .exportFile()
    .episodes.filter((e) => episodeIds.has(e.id))
    .map((e) => ({ ...e }));
  const invalidations = opts.workspaceDir
    ? readInvalidationLog(opts.workspaceDir, 1000).filter((r) =>
        facts.some((f) => f.id === r.factId),
      )
    : [];
  return {
    version: 2,
    exportedAt: nowIso(),
    recordedAt,
    scope: { ...scope },
    entities,
    facts: facts.map((f) => ({ ...f })),
    episodes,
    invalidations: invalidations.map((r) => ({ ...r })),
  };
}

/** Kết quả import một snapshot. */
export interface ImportTemporalSnapshotResult {
  addedEntities: number;
  addedFacts: number;
  addedEpisodes: number;
  addedInvalidations: number;
  skippedEntities: number;
  skippedFacts: number;
  skippedEpisodes: number;
  /** Lý do từng mục bị bỏ (fact thiếu provenance, cửa sổ sai, ...). */
  errors: string[];
}

/** Kiểm tra một snapshot có đúng định dạng không (trả danh sách lỗi). */
export function validateTemporalSnapshot(value: unknown): string[] {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null) return ['Snapshot không phải object.'];
  const snap = value as Record<string, unknown>;
  if (snap.version !== 2) errors.push(`Snapshot version phải là 2 (nhận ${String(snap.version)}).`);
  if (typeof snap.exportedAt !== 'string' || Number.isNaN(Date.parse(snap.exportedAt))) {
    errors.push('Snapshot thiếu exportedAt hợp lệ.');
  }
  if (!Array.isArray(snap.entities)) errors.push('Snapshot thiếu entities (mảng).');
  if (!Array.isArray(snap.facts)) errors.push('Snapshot thiếu facts (mảng).');
  if (!Array.isArray(snap.episodes)) errors.push('Snapshot thiếu episodes (mảng).');
  if (!Array.isArray(snap.invalidations)) errors.push('Snapshot thiếu invalidations (mảng).');
  if (errors.length > 0) return errors;
  for (const fact of snap.facts as Array<Record<string, unknown>>) {
    const id = typeof fact.id === 'string' ? fact.id : '(không id)';
    if (typeof fact.subjectId !== 'string' || fact.subjectId === '') {
      errors.push(`Fact ${id}: thiếu subjectId.`);
    }
    if (typeof fact.predicate !== 'string' || fact.predicate === '') {
      errors.push(`Fact ${id}: thiếu predicate.`);
    }
    if (typeof fact.validFrom !== 'string' || Number.isNaN(Date.parse(fact.validFrom))) {
      errors.push(`Fact ${id}: validFrom không hợp lệ.`);
    }
    if (
      fact.validUntil !== null &&
      fact.validUntil !== undefined &&
      (typeof fact.validUntil !== 'string' || Number.isNaN(Date.parse(fact.validUntil)))
    ) {
      errors.push(`Fact ${id}: validUntil không hợp lệ.`);
    }
    if (
      typeof fact.validUntil === 'string' &&
      typeof fact.validFrom === 'string' &&
      Date.parse(fact.validUntil) < Date.parse(fact.validFrom)
    ) {
      errors.push(`Fact ${id}: validUntil < validFrom.`);
    }
    const provenance = fact.provenance as Record<string, unknown> | undefined;
    if (!provenance || typeof provenance.episodeId !== 'string' || provenance.episodeId === '') {
      errors.push(`Fact ${id}: thiếu provenance.episodeId (fact mồ côi không được import).`);
    }
    if (fact.invalidAt !== undefined && typeof fact.invalidAt !== 'string') {
      errors.push(`Fact ${id}: invalidAt không phải chuỗi ISO.`);
    }
  }
  return errors;
}

/**
 * Import một snapshot vào store (add-only — xem quy tắc ở đầu file).
 * Fact/episode/entity đã có (trùng id) thì bỏ qua, không ghi đè.
 * Trả về số lượng đã thêm + danh sách lỗi của từng mục bị bỏ.
 *
 * Lưu ý: import ghi qua backend của store (persist sau mỗi lần
 * thêm theo từng đợt — dùng `importTemporalSnapshot` với snapshot
 * lớn (hàng nghìn fact) sẽ ghi file nhiều lần; đó là hành vi có
 * chủ ý để mỗi đợt đều bền ngay cả khi tiến trình chết giữa chừng.
 */
export function importTemporalSnapshot(
  store: TemporalGraphStore,
  snapshot: TemporalSnapshot,
  opts: { workspaceDir?: string } = {},
): ImportTemporalSnapshotResult {
  const errors = validateTemporalSnapshot(snapshot);
  const result: ImportTemporalSnapshotResult = {
    addedEntities: 0,
    addedFacts: 0,
    addedEpisodes: 0,
    addedInvalidations: 0,
    skippedEntities: 0,
    skippedFacts: 0,
    skippedEpisodes: 0,
    errors: [...errors],
  };
  // Snapshot sai định dạng nền (không phải mảng...) thì dừng ngay.
  if (
    !Array.isArray(snapshot.entities) ||
    !Array.isArray(snapshot.facts) ||
    !Array.isArray(snapshot.episodes) ||
    !Array.isArray(snapshot.invalidations)
  ) {
    return result;
  }
  const file = store.exportFile();
  const existingEntityIds = new Set(file.entities.map((e) => e.id));
  const existingFactIds = new Set(file.facts.map((f) => f.id));
  const existingEpisodeIds = new Set(file.episodes.map((e) => e.id));

  // Entity trước (fact trỏ entity theo id — phải có entity trước).
  for (const entity of snapshot.entities) {
    if (typeof entity.id !== 'string' || entity.id === '' || typeof entity.name !== 'string' || entity.name === '') {
      result.errors.push(`Entity ${String(entity.id ?? '(không id)')}: thiếu id/name — bỏ qua.`);
      result.skippedEntities += 1;
      continue;
    }
    if (existingEntityIds.has(entity.id)) {
      result.skippedEntities += 1;
      continue;
    }
    try {
      if (store.importEntityRaw(entity)) result.addedEntities += 1;
      else result.skippedEntities += 1;
    } catch (err) {
      result.errors.push(`Entity ${entity.id}: ${(err as Error).message}`);
      result.skippedEntities += 1;
    }
  }

  // Episode trước (fact giữ episodeId trong provenance).
  for (const episode of snapshot.episodes) {
    if (typeof episode.id !== 'string' || episode.id === '') {
      result.errors.push('Episode thiếu id — bỏ qua.');
      result.skippedEpisodes += 1;
      continue;
    }
    if (existingEpisodeIds.has(episode.id)) {
      result.skippedEpisodes += 1;
      continue;
    }
    try {
      if (store.importEpisodeRaw(episode)) result.addedEpisodes += 1;
      else result.skippedEpisodes += 1;
    } catch (err) {
      result.errors.push(`Episode ${episode.id}: ${(err as Error).message}`);
      result.skippedEpisodes += 1;
    }
  }

  // Fact: giữ nguyên id + toàn bộ trường bi-temporal (kể cả
  // invalidAt) qua importFactRaw — liên kết supersession theo id
  // gốc vì vậy còn nguyên sau import.
  for (const fact of snapshot.facts) {
    if (existingFactIds.has(fact.id)) {
      result.skippedFacts += 1;
      continue;
    }
    try {
      const imported = store.importFactRaw(fact);
      if (imported === false) result.skippedFacts += 1;
      else {
        existingFactIds.add(fact.id);
        result.addedFacts += 1;
      }
    } catch (err) {
      result.errors.push(`Fact ${fact.id}: ${(err as Error).message}`);
      result.skippedFacts += 1;
    }
  }

  // Invalidation: ghi vào audit log JSONL (không đổi fact đích đã
  // có invalidAt — lần invalidate đầu tiên mới là mốc).
  if (opts.workspaceDir) {
    const existingLog = readInvalidationLog(opts.workspaceDir, 1000);
    const existingIds = new Set(existingLog.map((r) => r.id));
    const lines: string[] = [];
    for (const record of snapshot.invalidations) {
      if (typeof record.id !== 'string' || existingIds.has(record.id)) continue;
      const target = store.getFact(record.factId);
      if (target && target.invalidAt !== undefined) continue;
      lines.push(JSON.stringify(record));
      result.addedInvalidations += 1;
    }
    if (lines.length > 0) {
      const dir = path.join(opts.workspaceDir, '.open-bot');
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'memory-invalidations.jsonl'), lines.join('\n') + '\n', {
        mode: 0o600,
      });
    }
  }
  return result;
}

/** Ghi snapshot ra file JSON (atomic tmp + rename, mode 0600). */
export function writeTemporalSnapshotFile(filePath: string, snapshot: TemporalSnapshot): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Trên Windows chmod có thể không áp dụng được — file đã ghi xong.
  }
}

/** Đọc snapshot từ file JSON (throw khi file hỏng / sai định dạng). */
export function readTemporalSnapshotFile(filePath: string): TemporalSnapshot {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Không đọc được file snapshot: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('File snapshot bị hỏng (không phải JSON hợp lệ).');
  }
  const errors = validateTemporalSnapshot(parsed);
  if (errors.length > 0) {
    throw new Error(`Snapshot không hợp lệ: ${errors.slice(0, 5).join(' | ')}`);
  }
  return parsed as TemporalSnapshot;
}
