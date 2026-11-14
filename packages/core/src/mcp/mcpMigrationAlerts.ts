/**
 * MCP 2.0 migration alerts — cảnh báo migration từ discovery
 * (v1.05, sóng T2).
 *
 * `deprecation.ts` có shim + notice cho từng method deprecated,
 * `deprecationMigration.ts` có guide từng method — nhưng chưa có
 * lớp nào nhìn vào một `server/discover` document và nói ngay:
 * "server này còn dùng những gì cũ, cần migrate cái gì, theo thứ
 * tự nào". Module này làm việc đó:
 *
 *   - `migrationAlertsForDiscovery(discover)`: từ capabilities
 *     server khai trong discovery → danh sách alert (deprecated
 *     capability nào còn bật, extension nào đã thay nó, guide
 *     migrate nào áp dụng, mức độ ưu tiên).
 *   - `migrationAlertsForNegotiation(negotiation)`: alert riêng
 *     cho trường hợp fallback handshake (server pre-2.0 — toàn bộ
 *     surface cũ vẫn chạy nhưng không có stateless/MRTR/Tasks
 *     2026).
 *   - `formatMigrationAlerts(alerts)`: text hiển thị trong
 *     Settings / log (tiếng Việt).
 *   - `summarizeMigrationAlerts(alerts)`: một dòng tóm tắt cho
 *     activity feed.
 *
 * Không chạm mạng, không copy code từ SDK MCP nào.
 */

import {
  checkDeprecatedCapabilities,
  formatDeprecationWarning,
  type DeprecatedMcpMethod,
} from './deprecation';
import {
  migrationGuideFor,
  type MigrationEffort,
} from './deprecationMigration';
import type { ServerDiscoverResult } from './stateless';
import type { StatelessNegotiation } from './statelessClient';

/** Mức độ ưu tiên của một migration alert. */
export type MigrationAlertSeverity = 'info' | 'warning' | 'urgent';

/** Một cảnh báo migration cho server. */
export interface MigrationAlert {
  /** Capability/method cũ gây ra alert. */
  subject: string;
  /** Mức độ ưu tiên. */
  severity: MigrationAlertSeverity;
  /** Thông điệp ngắn (hiển thị). */
  message: string;
  /** Cái thay thế (method / extension / flow mới). */
  replacement: string;
  /** Nỗ lực migrate ước tính (khi có guide). */
  effort?: MigrationEffort;
  /** Các bước migrate (khi có guide). */
  steps?: string[];
  /** Ngày sớm nhất method cũ có thể bị gỡ (khi có). */
  removeAfter?: string;
  /** Deprecated metadata gốc (khi alert từ deprecation.ts). */
  deprecated?: DeprecatedMcpMethod;
}

/**
 * Build alert từ discovery document của server. Mỗi deprecated
 * capability server khai (sampling / roots / logging /
 * elicitation) → một alert kèm guide migrate. Thêm alert `info`
 * khi server không khai Tasks/Apps extension 2026 (không phải
 * lỗi — chỉ là thiếu tính năng mới).
 */
export function migrationAlertsForDiscovery(
  discover: ServerDiscoverResult,
): MigrationAlert[] {
  const alerts: MigrationAlert[] = [];
  const deprecated = checkDeprecatedCapabilities(
    discover.capabilities as unknown as Record<string, unknown>,
  );
  for (const meta of deprecated) {
    const guide = migrationGuideFor(meta.method);
    alerts.push({
      subject: meta.method,
      severity: 'warning',
      message: formatDeprecationWarning(meta),
      replacement: meta.replacement,
      ...(guide ? { effort: guide.effort, steps: guide.steps.map((s) => `${s.title}: ${s.detail}`) } : {}),
      removeAfter: meta.removeAfter,
      deprecated: meta,
    });
  }
  const caps = discover.capabilities;
  if (caps.tasks === undefined) {
    alerts.push({
      subject: 'tasks',
      severity: 'info',
      message:
        `Server "${discover.serverInfo.name}" không khai Tasks extension ` +
        `(io.modelcontextprotocol/tasks) — task dài vẫn chạy được qua client, ` +
        `nhưng server không hỗ trợ tasks/get/update/cancel theo chuẩn 2026-07-28.`,
      replacement: 'Khai tasks capability + implement tasks/get, tasks/update, tasks/cancel (xem tasks.ts).',
    });
  }
  if (caps.apps === undefined) {
    alerts.push({
      subject: 'apps',
      severity: 'info',
      message:
        `Server "${discover.serverInfo.name}" không khai MCP Apps extension ` +
        `(io.modelcontextprotocol/apps) — app UI sẽ không render qua chuẩn Apps v2.`,
      replacement: 'Khai apps capability + declare template trước khi render (xem appsV2.ts).',
    });
  }
  const protocolVersion = discover.protocolVersion;
  if (protocolVersion !== '2026-07-28') {
    alerts.push({
      subject: 'protocolVersion',
      severity: 'warning',
      message:
        `Server đang nói protocol ${protocolVersion}, cũ hơn 2026-07-28 — ` +
        `stateless vẫn chạy qua _meta nhưng MRTR / Tasks 2026 / Apps v2 có thể thiếu.`,
      replacement: 'Nâng server lên MCP 2026-07-28 (stateless core, MRTR, Tasks, Apps).',
    });
  }
  return alerts;
}

/**
 * Build alert từ kết quả negotiation (statelessClient.ts): khi
 * fallback về handshake với server pre-2.0, toàn bộ surface cũ
 * vẫn chạy nhưng client không có stateless/MRTR/Tasks 2026 —
 * alert `urgent` để operator biết server cần nâng cấp.
 */
export function migrationAlertsForNegotiation(
  negotiation: StatelessNegotiation,
  serverName: string,
): MigrationAlert[] {
  if (!negotiation.fellBack) return [];
  return [
    {
      subject: 'handshake-fallback',
      severity: 'urgent',
      message:
        `Server "${serverName}" không biết server/discover (pre-2.0) — client đã fallback ` +
        `về handshake initialize (protocol ${negotiation.protocolVersion}). ` +
        `Stateless, MRTR và Tasks 2026 không dùng được với server này.`,
      replacement: 'Nâng server lên MCP 2026-07-28 để dùng stateless + MRTR + Tasks extension.',
    },
  ];
}

/** Gộp alert từ discovery + negotiation (trùng subject thì giữ severity cao hơn). */
export function mergeMigrationAlerts(...groups: MigrationAlert[][]): MigrationAlert[] {
  const severityRank: Record<MigrationAlertSeverity, number> = {
    info: 0,
    warning: 1,
    urgent: 2,
  };
  const bySubject = new Map<string, MigrationAlert>();
  for (const group of groups) {
    for (const alert of group) {
      const existing = bySubject.get(alert.subject);
      if (!existing || severityRank[alert.severity] > severityRank[existing.severity]) {
        bySubject.set(alert.subject, alert);
      }
    }
  }
  return [...bySubject.values()].sort(
    (a, b) => severityRank[b.severity] - severityRank[a.severity],
  );
}

/** Đếm alert theo severity. */
export function countMigrationAlertsBySeverity(
  alerts: readonly MigrationAlert[],
): Record<MigrationAlertSeverity, number> {
  const counts: Record<MigrationAlertSeverity, number> = { info: 0, warning: 0, urgent: 0 };
  for (const alert of alerts) counts[alert.severity] += 1;
  return counts;
}

/** True khi có ít nhất một alert urgent (cần hành động ngay). */
export function hasUrgentMigrationAlert(alerts: readonly MigrationAlert[]): boolean {
  return alerts.some((a) => a.severity === 'urgent');
}

/** Format nhiều alert thành text hiển thị (Settings / log). */
export function formatMigrationAlerts(alerts: readonly MigrationAlert[]): string {
  if (alerts.length === 0) return 'Không có cảnh báo migration — server đã dùng MCP 2026-07-28 đầy đủ.';
  const lines: string[] = [`Migration MCP 2.0 — ${alerts.length} cảnh báo:`];
  for (const alert of alerts) {
    const tag =
      alert.severity === 'urgent' ? '[KHẨN]' : alert.severity === 'warning' ? '[CẢNH BÁO]' : '[INFO]';
    lines.push(`- ${tag} ${alert.subject}: ${alert.message}`);
    lines.push(`  Thay bằng: ${alert.replacement}`);
    if (alert.effort) lines.push(`  Nỗ lực: ${alert.effort}.`);
    if (alert.removeAfter) lines.push(`  Có thể bị gỡ sau: ${alert.removeAfter}.`);
    if (alert.steps && alert.steps.length > 0) {
      for (const step of alert.steps) lines.push(`  • ${step}`);
    }
  }
  return lines.join('\n');
}

/** Một dòng tóm tắt cho activity feed. */
export function summarizeMigrationAlerts(alerts: readonly MigrationAlert[]): string {
  if (alerts.length === 0) return 'MCP 2.0: server đã up-to-date, không có cảnh báo migration.';
  const counts = countMigrationAlertsBySeverity(alerts);
  const parts: string[] = [];
  if (counts.urgent > 0) parts.push(`${counts.urgent} khẩn`);
  if (counts.warning > 0) parts.push(`${counts.warning} cảnh báo`);
  if (counts.info > 0) parts.push(`${counts.info} lưu ý`);
  return `MCP 2.0 migration: ${alerts.length} cảnh báo (${parts.join(', ')}) — xem chi tiết trong Settings → MCP.`;
}
