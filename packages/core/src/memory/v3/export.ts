/**
 * Export / import cho memory v6 (v1.05, Đội T1).
 *
 * Backup và di chuyển kho v6 giữa các máy/bot mà không mất lịch sử:
 *  - Export JSON: toàn bộ records + events (định dạng file kho v6,
 *    kèm `exportedAt` + `recordCount` để kiểm tra toàn vẹn).
 *  - Export Markdown: bản đọc được cho người (theo scope/kind).
 *  - Import JSON: append từng bản ghi vào store đích (qua
 *    `append()` nên dedupe tự nhiên — import 2 lần không nhân đôi);
 *    event được import sau, chỉ khi target của nó đã tồn tại trong
 *    store đích (event "mồ côi" thì bỏ qua và đếm vào skipped).
 *
 * KHÔNG copy dữ liệu nhạy cảm: export không bao giờ chứa embedding
 * (v6 không lưu vector); import validate shape từng mục và bỏ qua
 * mục sai thay vì fail cả file.
 */

import type { V6Record, V6VersionEvent } from './types';
import { normalizeV6Text } from './types';
import type { V6RecordStore, V6StoreFile } from './store';
import { MEMORY_V6_FILE_VERSION } from './store';

/** File export JSON của kho v6. */
export interface V6ExportFile extends V6StoreFile {
  exportedAt: string;
  recordCount: number;
  eventCount: number;
}

/** Kết quả import. */
export interface V6ImportReport {
  /** Số bản ghi đã đọc từ file. */
  readRecords: number;
  /** Số bản ghi đã append vào store đích. */
  importedRecords: number;
  /** Số bản ghi bỏ qua vì đã có bản giống hệt. */
  skippedDuplicateRecords: number;
  /** Số bản ghi bỏ qua vì sai shape/thiếu text. */
  skippedInvalidRecords: number;
  /** Số event đã đọc từ file. */
  readEvents: number;
  /** Số event đã append vào store đích. */
  importedEvents: number;
  /** Số event bỏ qua (target chưa có trong store đích). */
  skippedOrphanEvents: number;
  /** Lỗi từng mục (không fail cả lần import). */
  errors: string[];
}

/** Lỗi export/import — mọi message đều tiếng Việt. */
export class V6ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V6ExportError';
  }
}

function isRecordShape(value: unknown): value is V6Record {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Partial<V6Record>;
  return (
    typeof r.id === 'string' &&
    r.id !== '' &&
    typeof r.text === 'string' &&
    typeof r.version === 'number' &&
    typeof r.createdAt === 'string' &&
    typeof r.scope === 'object' &&
    r.scope !== null
  );
}

function isEventShape(value: unknown): value is V6VersionEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const e = value as Partial<V6VersionEvent>;
  return (
    typeof e.seq === 'number' &&
    typeof e.type === 'string' &&
    ['supersede', 'retire', 'quarantine', 'restore'].includes(e.type) &&
    typeof e.targetId === 'string' &&
    typeof e.reason === 'string' &&
    typeof e.actor === 'string' &&
    typeof e.at === 'string'
  );
}

/** Export toàn bộ store thành file JSON (records + events). */
export function exportV6Store(store: V6RecordStore): V6ExportFile {
  const snapshot = store.snapshot();
  return {
    version: MEMORY_V6_FILE_VERSION,
    records: snapshot.records,
    events: snapshot.events,
    exportedAt: new Date().toISOString(),
    recordCount: snapshot.records.length,
    eventCount: snapshot.events.length,
  };
}

/** Parse một file export JSON (validate shape cơ bản). */
export function parseV6ExportFile(raw: string): V6ExportFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new V6ExportError('File export memory v6 hỏng (không parse được JSON).');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new V6ExportError('File export memory v6 sai định dạng (phải là object).');
  }
  const file = parsed as Partial<V6ExportFile>;
  if (!Array.isArray(file.records) || !Array.isArray(file.events)) {
    throw new V6ExportError('File export memory v6 thiếu records/events.');
  }
  return {
    version: file.version ?? MEMORY_V6_FILE_VERSION,
    records: file.records as V6Record[],
    events: file.events as V6VersionEvent[],
    exportedAt: typeof file.exportedAt === 'string' ? file.exportedAt : new Date().toISOString(),
    recordCount: file.records.length,
    eventCount: file.events.length,
  };
}

/**
 * Import một file export vào store đích.
 *
 * Thứ tự: records trước (theo createdAt tăng dần để chuỗi version đi
 * đúng chiều), events sau. Bản ghi import giữ nguyên id/version/
 * createdAt gốc (để history khớp giữa hai máy); append qua store
 * nên dedupe theo text+scope+kind vẫn áp dụng. Event import chỉ ghi
 * khi target đã có trong store đích (kể cả vừa import xong).
 */
export function importV6Store(store: V6RecordStore, data: V6ExportFile): V6ImportReport {
  const report: V6ImportReport = {
    readRecords: 0,
    importedRecords: 0,
    skippedDuplicateRecords: 0,
    skippedInvalidRecords: 0,
    readEvents: 0,
    importedEvents: 0,
    skippedOrphanEvents: 0,
    errors: [],
  };
  const ordered = [...data.records].sort(
    (a, b) => Date.parse(a.createdAt ?? '') - Date.parse(b.createdAt ?? ''),
  );
  // Map id gốc -> id mới trong store đích (để nối chuỗi supersedes).
  const idMap = new Map<string, string>();
  // Khóa idempotency của import: bản ghi đã import từ trước có
  // source.ref = `v6-export:<id gốc>`. append() chỉ dedupe bản ACTIVE
  // nên không đủ — import lần 2 phải bỏ qua cả bản đã superseded/
  // retired (nếu không sẽ "hồi sinh" lịch sử thành bản active mới).
  for (const view of store.listAll()) {
    const match = /^v6-export:(.+)$/.exec(view.source.ref);
    if (match) idMap.set(match[1] as string, view.id);
  }
  for (const raw of ordered) {
    report.readRecords += 1;
    if (!isRecordShape(raw) || normalizeV6Text(raw.text) === '') {
      report.skippedInvalidRecords += 1;
      continue;
    }
    if (idMap.has(raw.id)) {
      // Đã import từ trước (kể cả bản đã superseded/retired).
      report.skippedDuplicateRecords += 1;
      continue;
    }
    try {
      const before = store.count();
      const mappedSupersedes = raw.supersedes ? idMap.get(raw.supersedes) : undefined;
      const view = store.append({
        kind: raw.kind ?? 'fact',
        ...(raw.key ? { key: raw.key } : {}),
        text: raw.text,
        entities: raw.entities ?? [],
        tags: raw.tags ?? [],
        confidence: raw.confidence ?? 0.8,
        scope: {
          userId: raw.scope.userId ?? '',
          agentId: raw.scope.agentId ?? '',
          runId: raw.scope.runId ?? '',
          appId: raw.scope.appId ?? '',
        },
        source: {
          type: 'import',
          ref: `v6-export:${raw.id}`,
          ...(raw.source?.botId ? { botId: raw.source.botId } : {}),
          sourceText: `Import từ export v6 (gốc ${raw.id}).`,
        },
        ...(mappedSupersedes ? { supersedes: mappedSupersedes } : {}),
      });
      idMap.set(raw.id, view.id);
      if (store.count() === before) {
        report.skippedDuplicateRecords += 1;
      } else {
        report.importedRecords += 1;
      }
    } catch (err) {
      report.errors.push(`Record ${raw.id}: ${(err as Error).message}`);
    }
  }
  // Event: chỉ import khi target đã có trong store đích. Vì id bản
  // ghi import là id MỚI (append sinh uuid mới), event gốc trỏ id cũ
  // không khớp — nối lại qua `source.ref` (v6-export:<id gốc>).
  const byOriginalId = new Map<string, string>();
  for (const view of store.listAll()) {
    const match = /^v6-export:(.+)$/.exec(view.source.ref);
    if (match) byOriginalId.set(match[1] as string, view.id);
  }
  // Cả bản ghi đã có sẵn từ trước (không phải import lần này) cũng
  // có thể là target: map thêm id hiện tại -> chính nó.
  for (const view of store.listAll()) {
    if (!byOriginalId.has(view.id)) byOriginalId.set(view.id, view.id);
  }
  const orderedEvents = [...data.events].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  for (const raw of orderedEvents) {
    report.readEvents += 1;
    if (!isEventShape(raw)) {
      report.skippedOrphanEvents += 1;
      continue;
    }
    const targetId = byOriginalId.get(raw.targetId);
    if (!targetId) {
      report.skippedOrphanEvents += 1;
      continue;
    }
    try {
      const current = store.getById(targetId);
      // Không ghi event trùng y hệt (cùng type + target + reason) —
      // import 2 lần không nhân đôi event.
      const duplicate = store
        .listEvents()
        .some(
          (e) =>
            e.type === raw.type && e.targetId === targetId && e.reason === raw.reason,
        );
      if (duplicate) {
        report.skippedOrphanEvents += 1;
        continue;
      }
      // Supersede đã được nối sẵn qua `supersedes` lúc import record
      // thì không ghi event lần nữa.
      if (
        raw.type === 'supersede' &&
        current?.status === 'superseded' &&
        raw.byId !== undefined &&
        byOriginalId.get(raw.byId) === current.supersededBy
      ) {
        report.skippedOrphanEvents += 1;
        continue;
      }
      void current;
      const byId = raw.byId ? byOriginalId.get(raw.byId) : undefined;
      store.appendEvent({
        type: raw.type,
        targetId,
        ...(byId ? { byId } : {}),
        reason: raw.reason,
        actor: `import:${raw.actor}`,
        at: raw.at,
      });
      report.importedEvents += 1;
    } catch (err) {
      report.errors.push(`Event ${raw.seq}: ${(err as Error).message}`);
    }
  }
  return report;
}

/**
 * Export kho thành Markdown đọc được (gom theo scope level rồi kind):
 * mỗi bản ghi một dòng `- [kind] text (scope level, bucket, vN)`.
 * Chỉ export bản active (mặc định) hoặc tất cả khi `includeNonActive`.
 */
export function exportV6Markdown(
  store: V6RecordStore,
  opts: { includeNonActive?: boolean; now?: Date } = {},
): string {
  const views = opts.includeNonActive ? store.listAll() : store.listActive();
  const lines: string[] = ['# Memory v6 — export', '', `Tổng ${views.length} bản ghi (export lúc ${new Date().toISOString()}).`, ''];
  if (views.length === 0) {
    lines.push('(Kho trống.)');
    return lines.join('\n');
  }
  const byLevel = new Map<string, V6Record[]>();
  for (const view of views) {
    const level =
      view.scope.runId !== ''
        ? 'run'
        : view.scope.agentId !== ''
          ? 'agent'
          : view.scope.userId !== ''
            ? 'user'
            : 'app';
    const list = byLevel.get(level) ?? [];
    list.push(view);
    byLevel.set(level, list);
  }
  for (const level of ['run', 'agent', 'user', 'app']) {
    const list = byLevel.get(level);
    if (!list || list.length === 0) continue;
    lines.push(`## Scope ${level} (${list.length})`, '');
    for (const record of list) {
      const scopeId =
        record.scope.runId || record.scope.agentId || record.scope.userId || record.scope.appId || 'chung';
      lines.push(
        `- [${record.kind}] ${record.text} (v${record.version}, ${scopeId}, ${record.createdAt.slice(0, 10)})`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}
