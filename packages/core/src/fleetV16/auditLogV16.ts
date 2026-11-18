/**
 * Audit log UI v2 — tìm kiếm nâng cao, phân loại mức độ, bộ lọc đã
 * lưu, phân trang bằng cursor, export NDJSON + chọn cột (v1.19, Đội T6).
 *
 * Tầng trên của audit log v15 (`fleetV15/auditLogV15.ts` — view
 * thống nhất 3 nguồn, filter cơ bản, phân trang theo số trang,
 * export JSON/CSV, tóm tắt). V15 trả lời "gộp log lại, lọc, xem
 * từng trang, tải về"; v16 trả lời 4 câu tra cứu tiếp theo:
 *
 * - TÌM KIẾM NÂNG CAO: truy vấn nhiều từ (AND — mọi từ phải xuất
 *   hiện), tìm theo trường (`actor:alice`, `action:user.`,
 *   `target:bot-1`, `source:fleet-audit`) và chuỗi tự do; tìm
 *   không phân biệt hoa thường, hỗ trợ chuỗi có dấu.
 * - MỨC ĐỘ (SEVERITY): mỗi action được xếp mức `info | warning |
 *   critical` theo tiền tố (vd `user.deactivate`, `role.remove`,
 *   `rollout.rollback` là critical; `*.suspend`, `*.pause` là
 *   warning; còn lại info) — panel tô màu và lọc theo mức độ
 *   mà không cần backend ghi thêm trường.
 * - BỘ LỌC ĐÃ LƯU (PRESET): admin lưu một bộ lọc hay dùng dưới
 *   một cái tên (vd "Lỗi rollout tuần này") để mở lại trong một
 *   cú bấm; tối đa 20 preset, trùng tên → lỗi.
 * - PHÂN TRANG CURSOR: thay vì số trang (dễ lệch khi log mới đổ
 *   về), v16 dùng cursor `at:seq:source` — trang sau bắt đầu
 *   đúng sau dòng cuối trang trước, ổn định khi có dòng mới.
 * - EXPORT NDJSON + CHỌN CỘT: ngoài JSON/CSV của v15, v16 xuất
 *   NDJSON (một JSON mỗi dòng — tiện cho log pipeline) và cho
 *   chọn tập cột khi xuất CSV.
 *
 * Module này chỉ ĐỌC + TRÌNH BÀY (như v15): không ghi log mới,
 * không sửa chuỗi hash; việc verify chuỗi vẫn do v15/v14 làm.
 */

import type { AuditV15Filter, AuditV15Row } from '../fleetV15/auditLogV15';
import { exportAuditV15Csv, exportAuditV15Json } from '../fleetV15/auditLogV15';

/** Mức độ của một dòng audit (suy ra từ action). */
export type AuditV16Severity = 'info' | 'warning' | 'critical';

export const AUDIT_V16_SEVERITIES: readonly AuditV16Severity[] = ['info', 'warning', 'critical'];

/**
 * Tiền tố action → mức độ. Critical = thay đổi quyền / xóa /
 * rollback / vô hiệu; warning = tạm dừng / tạm ngưng / từ chối;
 * còn lại info. Tiền tố khớp dài nhất thắng.
 */
export const AUDIT_V16_SEVERITY_PREFIXES: Readonly<Record<string, AuditV16Severity>> = {
  'user.deactivate': 'critical',
  'user.suspend': 'warning',
  'user.change-role': 'critical',
  'user.remove': 'critical',
  'role.remove': 'critical',
  'role.create': 'warning',
  'rollout.rollback': 'critical',
  'auto-rollback': 'critical',
  'fleet.node-remove': 'critical',
  'fleet.node-drain': 'warning',
  'rollout.pause': 'warning',
  'auto-pause': 'warning',
  'quota.exceeded': 'warning',
  'rate-limit': 'warning',
  'auth.failed': 'warning',
  'auth.locked': 'critical',
  'tenant.quota-exceeded': 'critical',
};

/** Xếp mức độ cho một action (tiền tố dài nhất thắng, mặc định info). */
export function auditV16SeverityOf(action: string): AuditV16Severity {
  let best: AuditV16Severity = 'info';
  let bestLen = -1;
  for (const [prefix, severity] of Object.entries(AUDIT_V16_SEVERITY_PREFIXES)) {
    if (action.startsWith(prefix) && prefix.length > bestLen) {
      best = severity;
      bestLen = prefix.length;
    }
  }
  return best;
}

/** Một dòng audit kèm mức độ (view-model v2). */
export interface AuditV16Row extends AuditV15Row {
  severity: AuditV16Severity;
}

/** Gắn mức độ cho các dòng v15 (không đổi thứ tự). */
export function toAuditV16Rows(rows: readonly AuditV15Row[]): AuditV16Row[] {
  return rows.map((r) => ({ ...r, severity: auditV16SeverityOf(r.action) }));
}

// ---------------------------------------------------------------------------
// Tìm kiếm nâng cao
// ---------------------------------------------------------------------------

/** Một mệnh đề tìm kiếm đã parse. */
export interface AuditV16SearchClause {
  /** Trường giới hạn (`actor` | `action` | `target` | `source` | '' = mọi trường). */
  field: '' | 'actor' | 'action' | 'target' | 'source';
  term: string;
}

/**
 * Parse truy vấn tìm kiếm: các từ cách nhau bằng khoảng trắng là
 * AND; `field:giá-trị` giới hạn trường (`actor:alice`,
 * `action:user.`, `target:bot-1`, `source:fleet-audit`). Từ trong
 * dấu ngoặc kép được giữ nguyên (vd `"bot alpha"`).
 */
export function parseAuditV16Query(query: string): AuditV16SearchClause[] {
  const clauses: AuditV16SearchClause[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) !== null) {
    const raw = (m[1] ?? m[2] ?? '').trim();
    if (raw === '') continue;
    const colon = raw.indexOf(':');
    if (colon > 0) {
      const field = raw.slice(0, colon).toLowerCase();
      const term = raw.slice(colon + 1).toLowerCase();
      if (term === '') continue;
      if (field === 'actor' || field === 'action' || field === 'target' || field === 'source') {
        clauses.push({ field, term });
        continue;
      }
    }
    clauses.push({ field: '', term: raw.toLowerCase() });
  }
  return clauses;
}

function auditV16FieldText(row: AuditV16Row, field: AuditV16SearchClause['field']): string {
  switch (field) {
    case 'actor':
      return `${row.actorUserId} ${row.userId} ${row.actorRole}`.toLowerCase();
    case 'action':
      return row.action.toLowerCase();
    case 'target':
      return row.target.toLowerCase();
    case 'source':
      return row.source.toLowerCase();
    default:
      return `${row.action} ${row.target} ${row.detail} ${row.actorUserId} ${row.userId} ${row.actorRole} ${row.source}`.toLowerCase();
  }
}

/** True khi dòng khớp TẤT CẢ mệnh đề (AND). */
export function auditV16RowMatchesQuery(row: AuditV16Row, query: string): boolean {
  const clauses = parseAuditV16Query(query);
  if (clauses.length === 0) return true;
  return clauses.every((c) => auditV16FieldText(row, c.field).includes(c.term));
}

// ---------------------------------------------------------------------------
// Bộ lọc v2 + preset đã lưu
// ---------------------------------------------------------------------------

/** Bộ lọc v2: filter v15 + mức độ + truy vấn nâng cao. */
export interface AuditV16Filter extends AuditV15Filter {
  severities?: AuditV16Severity[];
}

export function filterAuditV16Rows(
  rows: readonly AuditV16Row[],
  filter: AuditV16Filter = {},
): AuditV16Row[] {
  const query = filter.query ? filter.query.trim() : '';
  return rows.filter((r) => {
    if (filter.userId !== undefined && filter.userId !== '' && r.userId !== filter.userId) return false;
    if (filter.actorUserId !== undefined && filter.actorUserId !== '' && r.actorUserId !== filter.actorUserId) return false;
    if (filter.action !== undefined && filter.action !== '' && r.action !== filter.action) return false;
    if (filter.actionPrefix !== undefined && filter.actionPrefix !== '' && !r.action.startsWith(filter.actionPrefix)) return false;
    if (filter.source !== undefined && r.source !== filter.source) return false;
    if (filter.fromMs !== undefined && r.at < filter.fromMs) return false;
    if (filter.toMs !== undefined && r.at > filter.toMs) return false;
    if (filter.verifiedOnly === true && !r.verified) return false;
    if (filter.severities !== undefined && filter.severities.length > 0 && !filter.severities.includes(r.severity)) {
      return false;
    }
    if (query !== '' && !auditV16RowMatchesQuery(r, query)) return false;
    return true;
  });
}

/** Một bộ lọc đã lưu (preset). */
export interface AuditV16Preset {
  name: string;
  filter: AuditV16Filter;
  createdAt: number;
}

/** Số preset tối đa. */
export const AUDIT_V16_MAX_PRESETS = 20;

/** Lỗi validate preset, '' = hợp lệ. */
export function validateAuditV16Preset(preset: Omit<AuditV16Preset, 'createdAt'>): string {
  if (typeof preset.name !== 'string' || preset.name.trim().length === 0 || preset.name.length > 60) {
    return 'tên preset không được rỗng và tối đa 60 ký tự';
  }
  if (preset.filter.severities) {
    for (const s of preset.filter.severities) {
      if (!AUDIT_V16_SEVERITIES.includes(s)) return `mức độ không hợp lệ: ${s}`;
    }
  }
  if (preset.filter.fromMs !== undefined && preset.filter.toMs !== undefined && preset.filter.fromMs > preset.filter.toMs) {
    return 'fromMs phải <= toMs';
  }
  return '';
}

/** Thêm preset (trùng tên → lỗi, danh sách không đổi). */
export function addAuditV16Preset(
  presets: readonly AuditV16Preset[],
  preset: Omit<AuditV16Preset, 'createdAt'>,
  now = Date.now(),
): { ok: boolean; presets: AuditV16Preset[]; error: string } {
  const invalid = validateAuditV16Preset(preset);
  if (invalid) return { ok: false, presets: [...presets], error: invalid };
  if (presets.some((p) => p.name === preset.name.trim())) {
    return { ok: false, presets: [...presets], error: `preset đã tồn tại: ${preset.name.trim()}` };
  }
  if (presets.length >= AUDIT_V16_MAX_PRESETS) {
    return { ok: false, presets: [...presets], error: `đã đạt tối đa ${AUDIT_V16_MAX_PRESETS} preset` };
  }
  return {
    ok: true,
    presets: [...presets, { name: preset.name.trim(), filter: { ...preset.filter }, createdAt: now }],
    error: '',
  };
}

/** Xóa preset theo tên (không có → lỗi). */
export function removeAuditV16Preset(
  presets: readonly AuditV16Preset[],
  name: string,
): { ok: boolean; presets: AuditV16Preset[]; error: string } {
  if (!presets.some((p) => p.name === name)) {
    return { ok: false, presets: [...presets], error: `không tìm thấy preset: ${name}` };
  }
  return { ok: true, presets: presets.filter((p) => p.name !== name), error: '' };
}

// ---------------------------------------------------------------------------
// Phân trang bằng cursor
// ---------------------------------------------------------------------------

/** Mã hóa vị trí một dòng thành cursor (ổn định khi log mới đổ về). */
export function auditV16CursorFor(row: AuditV16Row): string {
  return `${row.at}:${row.seq}:${row.source}`;
}

/** Giải mã cursor (null khi sai định dạng). */
export function auditV16ParseCursor(cursor: string): { at: number; seq: number; source: string } | null {
  const parts = cursor.split(':');
  if (parts.length !== 3) return null;
  const at = Number(parts[0]);
  const seq = Number(parts[1]);
  if (!Number.isFinite(at) || !Number.isInteger(seq)) return null;
  return { at, seq, source: parts[2] };
}

/** So sánh thứ tự hiển thị của 2 dòng (mới nhất trước — như v15). */
function auditV16Compare(a: AuditV16Row, b: AuditV16Row): number {
  if (b.at !== a.at) return b.at - a.at;
  if (a.source !== b.source) return a.source.localeCompare(b.source);
  return b.seq - a.seq;
}

/** Một trang cursor: rows + cursor trang sau (null = hết). */
export interface AuditV16CursorPage {
  rows: AuditV16Row[];
  nextCursor: string | null;
  totalRows: number;
}

/**
 * Phân trang cursor: `cursor` là dòng cuối của trang trước (lấy
 * các dòng SAU nó); cursor null/rỗng = trang đầu. Rows phải đã
 * sắp xếp mới nhất trước (như `buildAuditV15Rows` trả về).
 */
export function paginateAuditV16Rows(
  rows: readonly AuditV16Row[],
  cursor: string | null,
  pageSize = 50,
): AuditV16CursorPage {
  const size = Math.min(500, Math.max(1, Math.floor(pageSize) || 50));
  let start = 0;
  if (cursor) {
    const parsed = auditV16ParseCursor(cursor);
    if (parsed) {
      const idx = rows.findIndex(
        (r) => r.at === parsed.at && r.seq === parsed.seq && r.source === parsed.source,
      );
      if (idx >= 0) {
        start = idx + 1;
      } else {
        // Cursor trỏ tới dòng đã bị cắt khỏi view: tìm dòng đầu tiên
        // đứng SAU vị trí cursor trong thứ tự mới-nhất-trước.
        const probe: AuditV16Row = {
          seq: parsed.seq,
          at: parsed.at,
          source: parsed.source as AuditV16Row['source'],
          userId: '',
          actorUserId: '',
          actorRole: '',
          action: '',
          target: '',
          detail: '',
          hash: '',
          verified: false,
          severity: 'info',
        };
        const after = rows.findIndex((r) => auditV16Compare(r, probe) > 0);
        start = after >= 0 ? after : rows.length;
      }
    }
  }
  const page = rows.slice(start, start + size);
  const nextCursor = start + size < rows.length && page.length > 0
    ? auditV16CursorFor(page[page.length - 1])
    : null;
  return { rows: page, nextCursor, totalRows: rows.length };
}

// ---------------------------------------------------------------------------
// Export v2: NDJSON + CSV chọn cột
// ---------------------------------------------------------------------------

/** Export các dòng thành NDJSON (một JSON object mỗi dòng). */
export function exportAuditV16Ndjson(rows: readonly AuditV16Row[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : '');
}

/** Cột CSV có thể chọn khi export. */
export type AuditV16CsvColumn =
  | 'seq'
  | 'at'
  | 'isoTime'
  | 'source'
  | 'severity'
  | 'userId'
  | 'actorUserId'
  | 'actorRole'
  | 'action'
  | 'target'
  | 'detail'
  | 'hash'
  | 'verified';

export const AUDIT_V16_CSV_COLUMNS: readonly AuditV16CsvColumn[] = [
  'seq', 'at', 'isoTime', 'source', 'severity', 'userId', 'actorUserId',
  'actorRole', 'action', 'target', 'detail', 'hash', 'verified',
];

function auditV16CsvCell(value: string | number | boolean): string {
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Export CSV chỉ với các cột được chọn (mặc định = mọi cột). */
export function exportAuditV16Csv(
  rows: readonly AuditV16Row[],
  columns: readonly AuditV16CsvColumn[] = AUDIT_V16_CSV_COLUMNS,
): string {
  const cols = columns.length > 0 ? columns : AUDIT_V16_CSV_COLUMNS;
  const valueFor = (r: AuditV16Row, col: AuditV16CsvColumn): string | number | boolean => {
    switch (col) {
      case 'seq': return r.seq;
      case 'at': return r.at;
      case 'isoTime': return new Date(r.at).toISOString();
      case 'source': return r.source;
      case 'severity': return r.severity;
      case 'userId': return r.userId;
      case 'actorUserId': return r.actorUserId;
      case 'actorRole': return r.actorRole;
      case 'action': return r.action;
      case 'target': return r.target;
      case 'detail': return r.detail;
      case 'hash': return r.hash;
      case 'verified': return r.verified ? 'true' : 'false';
    }
  };
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map((c) => auditV16CsvCell(valueFor(r, c))).join(','));
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Tóm tắt v2: mức độ + histogram theo giờ
// ---------------------------------------------------------------------------

/** Tóm tắt v2 cho panel audit. */
export interface AuditV16Summary {
  totalRows: number;
  bySeverity: Record<AuditV16Severity, number>;
  bySource: Record<string, number>;
  topActors: { actorUserId: string; count: number }[];
  topActions: { action: string; count: number }[];
  /** Số dòng mỗi giờ (key = ISO giờ, vd 2026-11-16T10:00). */
  hourly: { hour: string; count: number }[];
  criticalRows: number;
}

export function summarizeAuditV16Rows(rows: readonly AuditV16Row[], topLimit = 5): AuditV16Summary {
  const bySeverity: Record<AuditV16Severity, number> = { info: 0, warning: 0, critical: 0 };
  const bySource: Record<string, number> = {};
  const actorCounts = new Map<string, number>();
  const actionCounts = new Map<string, number>();
  const hourCounts = new Map<string, number>();
  for (const r of rows) {
    bySeverity[r.severity] += 1;
    bySource[r.source] = (bySource[r.source] ?? 0) + 1;
    actorCounts.set(r.actorUserId, (actorCounts.get(r.actorUserId) ?? 0) + 1);
    actionCounts.set(r.action, (actionCounts.get(r.action) ?? 0) + 1);
    const hour = new Date(r.at).toISOString().slice(0, 13);
    hourCounts.set(hour, (hourCounts.get(hour) ?? 0) + 1);
  }
  const topActors = [...actorCounts.entries()]
    .map(([actorUserId, count]) => ({ actorUserId, count }))
    .sort((a, b) => b.count - a.count || a.actorUserId.localeCompare(b.actorUserId))
    .slice(0, Math.max(0, topLimit));
  const topActions = [...actionCounts.entries()]
    .map(([action, count]) => ({ action, count }))
    .sort((a, b) => b.count - a.count || a.action.localeCompare(b.action))
    .slice(0, Math.max(0, topLimit));
  return {
    totalRows: rows.length,
    bySeverity,
    bySource,
    topActors,
    topActions,
    hourly: [...hourCounts.entries()]
      .map(([hour, count]) => ({ hour, count }))
      .sort((a, b) => a.hour.localeCompare(b.hour)),
    criticalRows: bySeverity.critical,
  };
}

/** Re-export tiện ích v15 để caller audit UI v2 chỉ import một module. */
export { exportAuditV15Csv, exportAuditV15Json };
