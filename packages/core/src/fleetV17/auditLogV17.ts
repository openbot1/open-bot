/**
 * Audit log UI v3 — xem audit log: lọc theo user/action/resource/
 * thời gian, chi tiết từng entry kèm ngữ cảnh, export theo bộ lọc
 * (v1.20, Đội T6).
 *
 * Tầng trên của audit log v16 (`fleetV16/auditLogV16.ts` — tìm kiếm
 * nâng cao, severity theo action, preset, phân trang cursor, export
 * NDJSON + chọn cột) và v15 (`fleetV15/auditLogV15.ts` — view thống
 * nhất 3 nguồn, filter cơ bản, phân trang theo số trang, export
 * JSON/CSV, tóm tắt). V16 trả lời "tìm, lọc, phân trang, xuất";
 * v17 trả lời 4 câu tra cứu mà admin cần khi điều tra một sự cố:
 *
 * - LỌC ĐA CHIỀU KẾT HỢP: user (actor hoặc chủ thể) + action
 *   (chính xác / tiền tố / nhiều action) + resource (target chính
 *   xác / tiền tố / nhiều target) + khoảng thời gian + severity
 *   (kế thừa v16) + nguồn + trạng thái verify — mọi điều kiện kết
 *   hợp AND; filter sai (from > to, pageSize ngoài khoảng) bị từ
 *   chối kèm lý do thay vì trả kết quả rỗng khó hiểu.
 * - CHI TIẾT TỪNG ENTRY: `buildAuditV17Detail` trả về entry kèm
 *   ngữ cảnh — các entry LIỀN TRƯỚC / LIỀN SAU cùng resource
 *   (để thấy "trước đó ai đã chạm vào resource này"), các entry
 *   cùng actor trong 1 giờ gần đó (để thấy chuỗi hành động của
 *   người đó), và severity + gợi ý đọc (vd entry critical chưa
 *   verify → cảnh báo chuỗi có thể đã bị sửa).
 * - EXPORT THEO BỘ LỌC: export JSON/CSV/NDJSON áp dụng đúng filter
 *   đang xem (không xuất toàn bộ log), kèm header metadata (thời
 *   gian xuất, filter đã dùng, tổng số dòng) để file xuất ra tự
 *   giải thích được; CSV có escaping đúng chuẩn.
 * - TÓM TẮT THEO THỜI GIAN: `auditV17Timeline` gom số entry theo
 *   từng giờ/ngày trong khoảng lọc (để UI vẽ biểu đồ) + top actor /
 *   top action / top resource trong khoảng đó.
 *
 * Module này chỉ ĐỌC + TRÌNH BÀY (như v15/v16): không ghi log mới,
 * không sửa chuỗi hash; việc verify chuỗi vẫn do v15/v14 làm.
 */

import type { AuditV15Row } from '../fleetV15/auditLogV15';
import { exportAuditV15Csv, exportAuditV15Json } from '../fleetV15/auditLogV15';
import { auditV16SeverityOf, exportAuditV16Ndjson, toAuditV16Rows } from '../fleetV16/auditLogV16';
import type { AuditV16Row, AuditV16Severity } from '../fleetV16/auditLogV16';

/** Bộ lọc đa chiều của audit log UI v3. */
export interface AuditV17Filter {
  /** Actor (người thực hiện) — khớp chính xác. */
  actorUserId?: string;
  /** Chủ thể bị tác động — khớp chính xác. */
  userId?: string;
  /** Action khớp chính xác (vd `user.deactivate`). */
  action?: string;
  /** Tiền tố action (vd `user.` khớp mọi action user.*). */
  actionPrefix?: string;
  /** Nhiều action (khớp BẤT KỲ action nào trong danh sách). */
  actions?: string[];
  /** Resource (target) khớp chính xác. */
  resource?: string;
  /** Tiền tố resource (vd `bot-` khớp mọi target bắt đầu `bot-`). */
  resourcePrefix?: string;
  /** Nhiều resource (khớp BẤT KỲ). */
  resources?: string[];
  /** Khoảng thời gian (epoch ms, bao gồm cả hai đầu). */
  fromMs?: number;
  toMs?: number;
  /** Lọc theo severity (kế thừa v16). */
  severity?: AuditV16Severity;
  /** Lọc theo nguồn. */
  source?: AuditV15Row['source'];
  /** Chỉ lấy dòng đã verify OK. */
  verifiedOnly?: boolean;
  /** Tìm chuỗi con trong action/target/detail (không phân biệt hoa thường). */
  query?: string;
}

/** Lỗi validate filter, '' = hợp lệ. */
export function validateAuditV17Filter(filter: AuditV17Filter): string {
  if (filter.fromMs !== undefined && filter.toMs !== undefined && filter.fromMs > filter.toMs) {
    return 'fromMs phải <= toMs';
  }
  if (filter.fromMs !== undefined && (!Number.isFinite(filter.fromMs) || filter.fromMs < 0)) {
    return 'fromMs phải là epoch ms >= 0';
  }
  if (filter.toMs !== undefined && (!Number.isFinite(filter.toMs) || filter.toMs < 0)) {
    return 'toMs phải là epoch ms >= 0';
  }
  if (filter.actions !== undefined && filter.actions.length === 0) return 'actions không được rỗng';
  if (filter.resources !== undefined && filter.resources.length === 0) return 'resources không được rỗng';
  if (filter.action !== undefined && filter.actionPrefix !== undefined) {
    return 'chỉ dùng một trong action / actionPrefix';
  }
  if (filter.resource !== undefined && filter.resourcePrefix !== undefined) {
    return 'chỉ dùng một trong resource / resourcePrefix';
  }
  return '';
}

/** Một dòng audit có khớp filter v17 không (mọi điều kiện AND). */
export function auditV17RowMatchesFilter(row: AuditV16Row, filter: AuditV17Filter): boolean {
  if (filter.actorUserId !== undefined && row.actorUserId !== filter.actorUserId) return false;
  if (filter.userId !== undefined && row.userId !== filter.userId) return false;
  if (filter.action !== undefined && row.action !== filter.action) return false;
  if (filter.actionPrefix !== undefined && !row.action.startsWith(filter.actionPrefix)) return false;
  if (filter.actions !== undefined && !filter.actions.includes(row.action)) return false;
  if (filter.resource !== undefined && row.target !== filter.resource) return false;
  if (filter.resourcePrefix !== undefined && !row.target.startsWith(filter.resourcePrefix)) return false;
  if (filter.resources !== undefined && !filter.resources.includes(row.target)) return false;
  if (filter.fromMs !== undefined && row.at < filter.fromMs) return false;
  if (filter.toMs !== undefined && row.at > filter.toMs) return false;
  if (filter.severity !== undefined && auditV16SeverityOf(row.action) !== filter.severity) return false;
  if (filter.source !== undefined && row.source !== filter.source) return false;
  if (filter.verifiedOnly === true && !row.verified) return false;
  if (filter.query !== undefined) {
    const q = filter.query.toLowerCase();
    const hay = `${row.action} ${row.target} ${row.detail}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

/** Lọc dòng audit theo filter v17 (giữ nguyên thứ tự đầu vào). */
export function filterAuditV17Rows(
  rows: readonly AuditV15Row[],
  filter: AuditV17Filter = {},
): AuditV16Row[] {
  const invalid = validateAuditV17Filter(filter);
  if (invalid) throw new Error(`AuditV17Filter không hợp lệ: ${invalid}`);
  return toAuditV16Rows(rows).filter((row) => auditV17RowMatchesFilter(row, filter));
}

// ---------------------------------------------------------------------------
// Chi tiết từng entry
// ---------------------------------------------------------------------------

/** Chi tiết một entry audit kèm ngữ cảnh để điều tra. */
export interface AuditV17Detail {
  entry: AuditV16Row;
  severity: AuditV16Severity;
  /** Entry liền trước cùng resource (null = không có trong dữ liệu). */
  previousForResource: AuditV16Row | null;
  /** Entry liền sau cùng resource (null = không có). */
  nextForResource: AuditV16Row | null;
  /** Entry cùng actor trong 1 giờ trước entry này (mới nhất trước). */
  actorRecent: AuditV16Row[];
  /** Số entry cùng resource trong toàn bộ dữ liệu. */
  resourceEntryCount: number;
  /** Số entry cùng actor trong toàn bộ dữ liệu. */
  actorEntryCount: number;
  /** Gợi ý đọc (vd chuỗi chưa verify, entry critical). */
  hints: string[];
}

/** Số entry cùng actor lấy tối đa trong chi tiết. */
export const AUDIT_V17_ACTOR_RECENT_LIMIT = 10;
/** Cửa sổ "gần đó" của actor: 1 giờ. */
export const AUDIT_V17_ACTOR_WINDOW_MS = 60 * 60 * 1000;

/**
 * Xây chi tiết cho một entry (tìm theo `source + seq`): entry liền
 * trước/sau cùng resource, các entry cùng actor trong 1 giờ trước
 * đó, số lượng theo resource/actor, gợi ý đọc.
 */
export function buildAuditV17Detail(
  rows: readonly AuditV15Row[],
  source: AuditV15Row['source'],
  seq: number,
): AuditV17Detail | null {
  const all = toAuditV16Rows(rows);
  const entry = all.find((r) => r.source === source && r.seq === seq);
  if (!entry) return null;
  const sameResource = all
    .filter((r) => r.target === entry.target)
    .sort((a, b) => a.at - b.at || a.seq - b.seq);
  const idx = sameResource.findIndex((r) => r.source === source && r.seq === seq);
  const actorRecent = all
    .filter(
      (r) =>
        r.actorUserId === entry.actorUserId &&
        r.at < entry.at &&
        r.at >= entry.at - AUDIT_V17_ACTOR_WINDOW_MS &&
        !(r.source === source && r.seq === seq),
    )
    .sort((a, b) => b.at - a.at)
    .slice(0, AUDIT_V17_ACTOR_RECENT_LIMIT);
  const severity = auditV16SeverityOf(entry.action);
  const hints: string[] = [];
  if (!entry.verified) hints.push('entry chưa verify — chuỗi hash có thể đã bị sửa, đừng tin tuyệt đối');
  if (severity === 'critical') hints.push('entry critical — thay đổi quyền / xóa / rollback, nên đối chiếu với entry liền trước cùng resource');
  if (actorRecent.length > 0) {
    hints.push(`actor ${entry.actorUserId} có ${actorRecent.length} hành động khác trong 1 giờ trước entry này`);
  }
  if (sameResource.length === 1) hints.push('đây là entry duy nhất của resource này trong dữ liệu hiện có');
  return {
    entry,
    severity,
    previousForResource: idx > 0 ? sameResource[idx - 1] : null,
    nextForResource: idx >= 0 && idx < sameResource.length - 1 ? sameResource[idx + 1] : null,
    actorRecent,
    resourceEntryCount: sameResource.length,
    actorEntryCount: all.filter((r) => r.actorUserId === entry.actorUserId).length,
    hints,
  };
}

// ---------------------------------------------------------------------------
// Export theo bộ lọc
// ---------------------------------------------------------------------------

/** Định dạng export v17. */
export type AuditV17ExportFormat = 'json' | 'csv' | 'ndjson';

export const AUDIT_V17_EXPORT_FORMATS: readonly AuditV17ExportFormat[] = ['json', 'csv', 'ndjson'];

/** Metadata đính kèm file export để file tự giải thích được. */
export interface AuditV17ExportMeta {
  exportedAt: number;
  format: AuditV17ExportFormat;
  rowCount: number;
  filter: AuditV17Filter;
}

/**
 * Export các dòng ĐÃ LỌC (không xuất toàn bộ log): JSON/CSV dùng
 * exporter v15, NDJSON dùng exporter v16; JSON bọc trong object
 * kèm metadata; CSV thêm 2 dòng comment đầu file ghi metadata.
 */
export function exportAuditV17Filtered(
  rows: readonly AuditV15Row[],
  filter: AuditV17Filter,
  format: AuditV17ExportFormat,
  now = Date.now(),
): { content: string; meta: AuditV17ExportMeta } {
  const filtered = filterAuditV17Rows(rows, filter);
  const meta: AuditV17ExportMeta = { exportedAt: now, format, rowCount: filtered.length, filter };
  if (format === 'json') {
    const body = exportAuditV15Json(filtered);
    const parsed = JSON.parse(body) as unknown;
    return { content: JSON.stringify({ meta, rows: parsed }, null, 2), meta };
  }
  if (format === 'csv') {
    const header = [
      `# open-bot audit export (v17) — ${filtered.length} rows — exportedAt ${new Date(now).toISOString()}`,
      `# filter ${JSON.stringify(filter)}`,
    ].join('\n');
    return { content: `${header}\n${exportAuditV15Csv(filtered)}`, meta };
  }
  const header = JSON.stringify({ meta });
  return { content: `${header}\n${exportAuditV16Ndjson(filtered)}`, meta };
}

// ---------------------------------------------------------------------------
// Tóm tắt theo thời gian
// ---------------------------------------------------------------------------

/** Một điểm trên timeline (số entry trong một bucket thời gian). */
export interface AuditV17TimelineBucket {
  bucketStart: number;
  count: number;
  critical: number;
  warning: number;
}

/** Tóm tắt trong một khoảng thời gian (để UI vẽ biểu đồ + top list). */
export interface AuditV17Timeline {
  fromMs: number;
  toMs: number;
  bucketMs: number;
  buckets: AuditV17TimelineBucket[];
  total: number;
  topActors: { actorUserId: string; count: number }[];
  topActions: { action: string; count: number }[];
  topResources: { resource: string; count: number }[];
}

function topCounts(entries: [string, number][], limit: number): { key: string; count: number }[] {
  return entries
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

/**
 * Gom các dòng đã lọc theo bucket thời gian (giờ/ngày — caller
 * chọn `bucketMs`), kèm top actor/action/resource trong khoảng.
 */
export function auditV17Timeline(
  rows: readonly AuditV15Row[],
  filter: AuditV17Filter,
  bucketMs: number,
  topLimit = 5,
): AuditV17Timeline {
  const filtered = filterAuditV17Rows(rows, filter);
  const fromMs = filter.fromMs ?? (filtered.length > 0 ? Math.min(...filtered.map((r) => r.at)) : 0);
  const toMs = filter.toMs ?? (filtered.length > 0 ? Math.max(...filtered.map((r) => r.at)) : 0);
  const buckets = new Map<number, AuditV17TimelineBucket>();
  const actorCounts = new Map<string, number>();
  const actionCounts = new Map<string, number>();
  const resourceCounts = new Map<string, number>();
  for (const row of filtered) {
    const bucketStart = Math.floor(row.at / bucketMs) * bucketMs;
    let bucket = buckets.get(bucketStart);
    if (!bucket) {
      bucket = { bucketStart, count: 0, critical: 0, warning: 0 };
      buckets.set(bucketStart, bucket);
    }
    bucket.count += 1;
    const severity = auditV16SeverityOf(row.action);
    if (severity === 'critical') bucket.critical += 1;
    if (severity === 'warning') bucket.warning += 1;
    actorCounts.set(row.actorUserId, (actorCounts.get(row.actorUserId) ?? 0) + 1);
    actionCounts.set(row.action, (actionCounts.get(row.action) ?? 0) + 1);
    resourceCounts.set(row.target, (resourceCounts.get(row.target) ?? 0) + 1);
  }
  return {
    fromMs,
    toMs,
    bucketMs,
    buckets: [...buckets.values()].sort((a, b) => a.bucketStart - b.bucketStart),
    total: filtered.length,
    topActors: topCounts([...actorCounts.entries()], topLimit).map(({ key, count }) => ({
      actorUserId: key,
      count,
    })),
    topActions: topCounts([...actionCounts.entries()], topLimit).map(({ key, count }) => ({
      action: key,
      count,
    })),
    topResources: topCounts([...resourceCounts.entries()], topLimit).map(({ key, count }) => ({
      resource: key,
      count,
    })),
  };
}
