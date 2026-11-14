/**
 * Migration memory v5 -> v6 (v1.05, Đội T1).
 *
 * Chuyển dữ liệu từ kho cũ sang kho v6 add-only mà KHÔNG sửa kho cũ:
 *  - Nguồn 1: `LongTermMemory` (long-term key/value, v0.7+) — mỗi
 *    entry thành một bản ghi v6 kind 'fact', text "key: value".
 *  - Nguồn 2: fact graph v5 (`TemporalGraphStore.listFacts()`, đồ
 *    thị tri thức add-only v1.04) — mỗi fact thành một bản ghi v6
 *    kind 'fact', text "subject predicate object", giữ nguyên chuỗi
 *    supersession (fact đã superseded -> bản ghi v6 cũng superseded
 *    qua event, trỏ `supersededBy` sang id fact thay thế).
 *
 * IDEMPOTENT: chạy migration 2 lần không nhân đôi dữ liệu — bản ghi
 * đã có (cùng text chuẩn hoá + scope + kind, đang active) thì bỏ qua
 * và đếm vào `skippedDuplicate` (dedupe của store).
 *
 * KHÔNG copy dữ liệu nhạy cảm: embedding vector của fact graph không
 * được mang sang (v6 tính TF-IDF/embedding lúc truy vấn); chỉ text +
 * entity + tag + confidence + scope + provenance được chuyển.
 */

import type { GraphFact } from '../graph/types';
import type { LongTermMemory, LongTermMemoryEntry } from '../longterm';
import type { V6MigrationReport, V6Scope } from './types';
import { normalizeV6Text, toV6Scope } from './types';
import { supersedeRecord } from './versioning';
import type { V6RecordStore } from './store';

/** Tuỳ chọn migration. */
export interface V6MigrationOptions {
  /** userId mặc định khi entry/fact không gắn user ('' = giữ nguyên legacy). */
  defaultUserId?: string;
  /** appId gắn cho bản ghi đã migrate ('' = không gắn app). */
  appId?: string;
  /** Chỉ migrate tối đa từng này mục (mặc định không giới hạn). */
  limit?: number;
  /** Bỏ qua fact đã superseded (mặc định false = vẫn migrate + giữ chuỗi). */
  skipSupersededFacts?: boolean;
}

/** Entry long-term -> text v6 ("key: value"). */
export function longTermEntryToText(entry: LongTermMemoryEntry): string {
  const key = (entry.key ?? '').trim();
  const value = (entry.value ?? '').trim();
  return key === '' ? value : `${key}: ${value}`;
}

/** Fact graph -> text v6 ("subject predicate object"). */
export function graphFactToText(fact: GraphFact, subjectName: string, objectName: string): string {
  const predicate = (fact.predicate ?? '').trim();
  const parts = [subjectName.trim(), predicate, objectName.trim()].filter((p) => p !== '');
  return parts.join(' ');
}

/**
 * Migrate toàn bộ entry của một `LongTermMemory` sang store v6.
 * Entry thiếu cả key lẫn value thì bỏ qua (skippedInvalid).
 */
export function migrateLongTermMemory(
  longTerm: LongTermMemory,
  store: V6RecordStore,
  opts: V6MigrationOptions = {},
): V6MigrationReport {
  const report: V6MigrationReport = {
    source: 'longterm',
    read: 0,
    migrated: 0,
    skippedDuplicate: 0,
    skippedInvalid: 0,
    errors: [],
  };
  let entries: LongTermMemoryEntry[];
  try {
    entries = longTerm.list();
  } catch (err) {
    report.errors.push(`Không đọc được LongTermMemory: ${(err as Error).message}`);
    return report;
  }
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  for (const entry of entries) {
    if (report.read + report.migrated + report.skippedDuplicate + report.skippedInvalid >= limit) break;
    report.read += 1;
    const text = longTermEntryToText(entry);
    if (normalizeV6Text(text) === '') {
      report.skippedInvalid += 1;
      continue;
    }
    const scope: V6Scope = toV6Scope({
      userId: entry.userId ?? opts.defaultUserId ?? '',
      agentId: entry.botId ?? '',
      appId: opts.appId ?? '',
    });
    try {
      const before = store.count();
      const view = store.append({
        kind: 'fact',
        key: (entry.key ?? '').trim() !== '' ? entry.key.trim() : undefined,
        text,
        tags: [...(entry.tags ?? [])],
        confidence: entry.confidence ?? 0.8,
        scope,
        source: {
          type: 'migration',
          ref: `longterm:${entry.id}`,
          botId: entry.botId ?? undefined,
          sourceText: `Migrated từ LongTermMemory entry ${entry.id}.`,
        },
      });
      if (store.count() === before) {
        // Store dedupe -> đã có bản giống hệt.
        report.skippedDuplicate += 1;
      } else {
        void view;
        report.migrated += 1;
      }
    } catch (err) {
      report.errors.push(`Entry ${entry.id}: ${(err as Error).message}`);
    }
  }
  return report;
}

/**
 * Migrate fact graph v5 sang store v6.
 *
 * `resolveName` dịch entity id -> tên hiển thị (vd store.getEntity(id)?.name);
 * không có resolver thì dùng chính id làm tên (vẫn migrate được, chỉ
 * kém đẹp). Fact có `supersededBy` -> sau khi append, ghi event
 * supersede để bản ghi v6 giữ đúng trạng thái (lịch sử giữ nguyên).
 */
export function migrateGraphFacts(
  facts: GraphFact[],
  store: V6RecordStore,
  opts: V6MigrationOptions & { resolveName?: (entityId: string) => string | undefined } = {},
): V6MigrationReport {
  const report: V6MigrationReport = {
    source: 'graph',
    read: 0,
    migrated: 0,
    skippedDuplicate: 0,
    skippedInvalid: 0,
    errors: [],
  };
  const resolveName = opts.resolveName ?? ((id: string): string => id);
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  // Map fact id -> v6 record id (để nối chuỗi supersession sau).
  const migratedIds = new Map<string, string>();
  // Migrate bản "cũ" trước để chuỗi supersedes đi đúng chiều thời gian.
  const ordered = [...facts].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
  for (const fact of ordered) {
    if (report.read >= limit) break;
    report.read += 1;
    if (opts.skipSupersededFacts && fact.status === 'superseded') {
      report.skippedInvalid += 1;
      continue;
    }
    const subjectName = resolveName(fact.subjectId) ?? fact.subjectId;
    const objectName = fact.objectId
      ? (resolveName(fact.objectId) ?? fact.objectId)
      : (fact.objectText ?? '');
    const text = graphFactToText(fact, subjectName, objectName);
    if (normalizeV6Text(text) === '') {
      report.skippedInvalid += 1;
      continue;
    }
    const scope: V6Scope = toV6Scope({
      userId: fact.scope.userId ?? opts.defaultUserId ?? '',
      agentId: fact.scope.botId ?? '',
      runId: fact.scope.runId ?? '',
      appId: fact.scope.appId ?? opts.appId ?? '',
    });
    try {
      const before = store.count();
      const view = store.append({
        kind: 'fact',
        text,
        entities: [subjectName, objectName].filter((e) => e !== '').map((e) => e.toLowerCase()),
        tags: [fact.predicate],
        confidence: fact.confidence ?? 0.8,
        scope,
        source: {
          type: 'migration',
          ref: `graph:${fact.id}`,
          botId: fact.scope.botId ?? undefined,
          sourceText: fact.provenance?.sourceText ?? `Migrated từ graph fact ${fact.id}.`,
        },
      });
      if (store.count() === before) {
        report.skippedDuplicate += 1;
        // Vẫn ghi map để chuỗi supersession nối được khi cần.
        const existing = store.listAll().find(
          (r) => r.source.ref === `graph:${fact.id}` || normalizeV6Text(r.text) === normalizeV6Text(text),
        );
        if (existing) migratedIds.set(fact.id, existing.id);
      } else {
        migratedIds.set(fact.id, view.id);
        report.migrated += 1;
      }
    } catch (err) {
      report.errors.push(`Fact ${fact.id}: ${(err as Error).message}`);
    }
  }
  // Nối chuỗi supersession: fact nào có supersededBy thì bản ghi v6
  // tương ứng cũng superseded (append event, không sửa bản ghi).
  for (const fact of ordered) {
    if (!fact.supersededBy) continue;
    const oldV6Id = migratedIds.get(fact.id);
    const newV6Id = migratedIds.get(fact.supersededBy);
    if (!oldV6Id || !newV6Id) continue;
    try {
      const current = store.getById(oldV6Id);
      if (current && current.status === 'active') {
        supersedeRecord(store, oldV6Id, newV6Id, 'migration:v6', `Fact graph ${fact.id} đã superseded.`);
      }
    } catch (err) {
      report.errors.push(`Supersede ${fact.id}: ${(err as Error).message}`);
    }
  }
  return report;
}

/**
 * Migrate cả hai nguồn v5 trong một workspace (long-term + graph) về
 * một store v6. Trả về báo cáo gộp (một report mỗi nguồn).
 */
export function migrateV5Workspace(
  longTerm: LongTermMemory,
  graphFacts: GraphFact[],
  store: V6RecordStore,
  opts: V6MigrationOptions & { resolveName?: (entityId: string) => string | undefined } = {},
): V6MigrationReport[] {
  return [
    migrateLongTermMemory(longTerm, store, opts),
    migrateGraphFacts(graphFacts, store, opts),
  ];
}

/** Tóm tắt báo cáo migration thành text (để log/tool trả về). */
export function migrationReportMarkdown(reports: V6MigrationReport[]): string {
  const lines: string[] = ['# Migration memory v5 -> v6', ''];
  for (const report of reports) {
    lines.push(
      `- **${report.source}**: đọc ${report.read}, migrate ${report.migrated}, ` +
        `trùng ${report.skippedDuplicate}, không hợp lệ ${report.skippedInvalid}, ` +
        `lỗi ${report.errors.length}.`,
    );
    for (const error of report.errors.slice(0, 5)) {
      lines.push(`  - Lỗi: ${error}`);
    }
    if (report.errors.length > 5) {
      lines.push(`  - ... và ${report.errors.length - 5} lỗi nữa.`);
    }
  }
  return lines.join('\n');
}
