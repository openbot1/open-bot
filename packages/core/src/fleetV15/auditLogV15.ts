/**
 * Audit log v15 — view-model thống nhất cho trang/panel xem audit
 * log (v1.18, Đội T6).
 *
 * Nối với audit log backend HIỆN CÓ (không tạo log mới):
 * - Audit theo user v3 (`fleetV14/multiUserV14.ts` — chuỗi hash
 *   SHA-256 nối tiếp, mỗi event có userId/actorUserId/action/
 *   target/detail): nguồn `user-audit`.
 * - Fleet audit (`fleet/audit.ts` — `fleet.jsonl`, hash nối tiếp
 *   qua `team/audit.ts`): nguồn `fleet-audit`.
 * - Team audit (`team/audit.ts` — `audit.jsonl`): nguồn
 *   `team-audit`.
 *
 * Module này chỉ ĐỌC + TRÌNH BÀY: gộp các nguồn thành một dòng
 * thời gian duy nhất (mới nhất trước), lọc theo user / action /
 * khoảng thời gian / nguồn, phân trang, export JSON/CSV (chuỗi
 * thuần — việc tải file xuống do renderer làm), tóm tắt đếm theo
 * action/nguồn/user. Verify chuỗi hash ủy thác cho
 * `verifyTeamV14UserAuditLog` (user-audit) — fleet/team audit dùng
 * cùng hàm băm `team/audit.ts` nên caller verify bằng
 * `validateAuditEvent` của nó; module này chỉ báo "đã verify ở
 * nguồn nào" qua trường `verified`.
 *
 * Giới hạn thật (kế thừa backend): log LOCAL cho máy tin cậy —
 * chuỗi hash phát hiện sửa lén không tính lại hash, KHÔNG chống
 * được người có quyền sửa file tính lại chuỗi.
 */

import type { AuditEvent } from '../team/audit';
import type { TeamV14UserAuditEvent } from '../fleetV14/multiUserV14';
import { verifyTeamV14UserAuditLog } from '../fleetV14/multiUserV14';

/** Nguồn của một dòng audit trong view thống nhất. */
export type AuditV15Source = 'user-audit' | 'fleet-audit' | 'team-audit';

export const AUDIT_V15_SOURCES: readonly AuditV15Source[] = [
  'user-audit',
  'fleet-audit',
  'team-audit',
];

/** Một dòng audit thống nhất (đã chuẩn hóa từ 3 nguồn). */
export interface AuditV15Row {
  /** Seq trong nguồn gốc (để đối chiếu file). */
  seq: number;
  at: number;
  source: AuditV15Source;
  /** User là chủ thể (user-audit) hoặc '' khi nguồn không có user. */
  userId: string;
  actorUserId: string;
  actorRole: string;
  action: string;
  target: string;
  detail: string;
  hash: string;
  /** True khi dòng này thuộc chuỗi đã verify OK (caller truyền vào). */
  verified: boolean;
}

/** Số dòng tối đa gộp trong một view (tránh UI nặng). */
export const AUDIT_V15_MAX_ROWS = 10000;
/** Số dòng mỗi trang mặc định. */
export const AUDIT_V15_DEFAULT_PAGE_SIZE = 50;
/** Số dòng mỗi trang tối đa. */
export const AUDIT_V15_MAX_PAGE_SIZE = 500;

/** Chuẩn hóa một event user-audit v3 thành dòng thống nhất. */
export function auditV15RowFromUserEvent(
  event: TeamV14UserAuditEvent,
  verified: boolean,
): AuditV15Row {
  return {
    seq: event.seq,
    at: event.at,
    source: 'user-audit',
    userId: event.userId,
    actorUserId: event.actorUserId,
    actorRole: event.actorRole,
    action: event.action,
    target: event.target,
    detail: event.detail,
    hash: event.hash,
    verified,
  };
}

/** Chuẩn hóa một AuditEvent (fleet/team) thành dòng thống nhất. */
export function auditV15RowFromAuditEvent(
  event: AuditEvent,
  source: 'fleet-audit' | 'team-audit',
  verified: boolean,
): AuditV15Row {
  return {
    seq: event.seq,
    at: event.at,
    source,
    userId: '',
    actorUserId: event.actor,
    actorRole: '',
    action: event.action,
    target: event.target,
    detail: event.detail ? JSON.stringify(event.detail) : '',
    hash: event.hash,
    verified,
  };
}

/**
 * Gộp các nguồn thành một dòng thời gian (mới nhất trước, rồi seq
 * giảm dần). `userVerified` = kết quả verify chuỗi user-audit;
 * `fleetVerified` / `teamVerified` tương tự cho 2 nguồn còn lại.
 * Cắt ở AUDIT_V15_MAX_ROWS dòng mới nhất.
 */
export function buildAuditV15Rows(input: {
  userEvents?: readonly TeamV14UserAuditEvent[];
  fleetEvents?: readonly AuditEvent[];
  teamEvents?: readonly AuditEvent[];
  userVerified?: boolean;
  fleetVerified?: boolean;
  teamVerified?: boolean;
}): AuditV15Row[] {
  const rows: AuditV15Row[] = [];
  for (const e of input.userEvents ?? []) {
    rows.push(auditV15RowFromUserEvent(e, input.userVerified ?? false));
  }
  for (const e of input.fleetEvents ?? []) {
    rows.push(auditV15RowFromAuditEvent(e, 'fleet-audit', input.fleetVerified ?? false));
  }
  for (const e of input.teamEvents ?? []) {
    rows.push(auditV15RowFromAuditEvent(e, 'team-audit', input.teamVerified ?? false));
  }
  rows.sort((a, b) => {
    if (b.at !== a.at) return b.at - a.at;
    if (a.source !== b.source) return a.source.localeCompare(b.source);
    return b.seq - a.seq;
  });
  return rows.slice(0, AUDIT_V15_MAX_ROWS);
}

/** Bộ lọc cho trang audit log. */
export interface AuditV15Filter {
  userId?: string;
  actorUserId?: string;
  /** Khớp chính xác action (vd 'user.switch'). */
  action?: string;
  /** Khớp tiền tố action (vd 'user.' khớp mọi action user.*). */
  actionPrefix?: string;
  source?: AuditV15Source;
  fromMs?: number;
  toMs?: number;
  /** Chỉ lấy dòng đã verify OK (chuỗi hash nguyên vẹn). */
  verifiedOnly?: boolean;
  /** Tìm chuỗi con trong action/target/detail (không phân biệt hoa thường). */
  query?: string;
}

/** Lọc dòng audit (giữ nguyên thứ tự mới nhất trước). */
export function filterAuditV15Rows(
  rows: readonly AuditV15Row[],
  filter: AuditV15Filter = {},
): AuditV15Row[] {
  const query = filter.query ? filter.query.trim().toLowerCase() : '';
  return rows.filter((r) => {
    if (filter.userId !== undefined && filter.userId !== '' && r.userId !== filter.userId) return false;
    if (filter.actorUserId !== undefined && filter.actorUserId !== '' && r.actorUserId !== filter.actorUserId) return false;
    if (filter.action !== undefined && filter.action !== '' && r.action !== filter.action) return false;
    if (filter.actionPrefix !== undefined && filter.actionPrefix !== '' && !r.action.startsWith(filter.actionPrefix)) return false;
    if (filter.source !== undefined && r.source !== filter.source) return false;
    if (filter.fromMs !== undefined && r.at < filter.fromMs) return false;
    if (filter.toMs !== undefined && r.at > filter.toMs) return false;
    if (filter.verifiedOnly === true && !r.verified) return false;
    if (query !== '') {
      const hay = `${r.action} ${r.target} ${r.detail} ${r.actorUserId} ${r.userId}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });
}

/** Một trang kết quả (phân trang). */
export interface AuditV15Page {
  rows: AuditV15Row[];
  page: number;
  pageSize: number;
  totalRows: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

/** Phân trang: page bắt đầu từ 1; pageSize clamp 1..500. */
export function paginateAuditV15Rows(
  rows: readonly AuditV15Row[],
  page: number,
  pageSize: number = AUDIT_V15_DEFAULT_PAGE_SIZE,
): AuditV15Page {
  const size = Math.min(AUDIT_V15_MAX_PAGE_SIZE, Math.max(1, Math.floor(pageSize) || AUDIT_V15_DEFAULT_PAGE_SIZE));
  const totalRows = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / size));
  const safePage = Math.min(totalPages, Math.max(1, Math.floor(page) || 1));
  const start = (safePage - 1) * size;
  return {
    rows: rows.slice(start, start + size),
    page: safePage,
    pageSize: size,
    totalRows,
    totalPages,
    hasNext: safePage < totalPages,
    hasPrev: safePage > 1,
  };
}

// ---------------------------------------------------------------------------
// Export (mock-safe: chỉ build chuỗi, không ghi file)
// ---------------------------------------------------------------------------

/** Export các dòng thành JSON (pretty, 2 space). */
export function exportAuditV15Json(rows: readonly AuditV15Row[]): string {
  return JSON.stringify(rows, null, 2);
}

function csvCell(value: string | number): string {
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Export các dòng thành CSV (header + một dòng mỗi event). */
export function exportAuditV15Csv(rows: readonly AuditV15Row[]): string {
  const header = ['seq', 'at', 'isoTime', 'source', 'userId', 'actorUserId', 'actorRole', 'action', 'target', 'detail', 'hash', 'verified'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.seq,
        r.at,
        new Date(r.at).toISOString(),
        r.source,
        r.userId,
        r.actorUserId,
        r.actorRole,
        r.action,
        r.target,
        r.detail,
        r.hash,
        r.verified ? 'true' : 'false',
      ].map(csvCell).join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Tóm tắt
// ---------------------------------------------------------------------------

/** Tóm tắt một tập dòng audit cho panel. */
export interface AuditV15Summary {
  totalRows: number;
  bySource: Record<string, number>;
  byAction: Record<string, number>;
  byActor: Record<string, number>;
  /** Số dòng thuộc chuỗi đã verify OK. */
  verifiedRows: number;
  /** Số dòng chưa verify (nguồn chưa được verify hoặc verify fail). */
  unverifiedRows: number;
  earliestAt: number;
  latestAt: number;
  /** Verify chuỗi user-audit: ok / seq lỗi / lý do. */
  userChain: { ok: boolean; badSeq: number; reason: string };
}

export function summarizeAuditV15Rows(
  rows: readonly AuditV15Row[],
  userEvents: readonly TeamV14UserAuditEvent[] = [],
): AuditV15Summary {
  const bySource: Record<string, number> = {};
  const byAction: Record<string, number> = {};
  const byActor: Record<string, number> = {};
  let verifiedRows = 0;
  let earliestAt = 0;
  let latestAt = 0;
  for (const r of rows) {
    bySource[r.source] = (bySource[r.source] ?? 0) + 1;
    byAction[r.action] = (byAction[r.action] ?? 0) + 1;
    byActor[r.actorUserId] = (byActor[r.actorUserId] ?? 0) + 1;
    if (r.verified) verifiedRows += 1;
    if (earliestAt === 0 || r.at < earliestAt) earliestAt = r.at;
    if (r.at > latestAt) latestAt = r.at;
  }
  const userChain = verifyTeamV14UserAuditLog(userEvents);
  return {
    totalRows: rows.length,
    bySource,
    byAction,
    byActor,
    verifiedRows,
    unverifiedRows: rows.length - verifiedRows,
    earliestAt,
    latestAt,
    userChain,
  };
}

/** Top N action xuất hiện nhiều nhất (để panel vẽ "action nào nhiều nhất"). */
export function topAuditV15Actions(
  rows: readonly AuditV15Row[],
  limit = 10,
): { action: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.action, (counts.get(r.action) ?? 0) + 1);
  return [...counts.entries()]
    .map(([action, count]) => ({ action, count }))
    .sort((a, b) => b.count - a.count || a.action.localeCompare(b.action))
    .slice(0, Math.max(0, limit));
}

/** Re-export để caller audit UI không phải import 2 module. */
export { verifyTeamV14UserAuditLog };
