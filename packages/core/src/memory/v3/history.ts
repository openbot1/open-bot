/**
 * Lịch sử + point-in-time query cho memory v6 (v1.05, Đội T1).
 *
 * Vì kho v6 là add-only (bản ghi không bao giờ bị sửa/xoá, trạng thái
 * chỉ đổi qua event có timestamp), toàn bộ quá khứ đều truy vấn được:
 *  - "Lúc T, bản ghi này đang active hay đã superseded?" — replay
 *    event có `at <= T`.
 *  - "Lúc T, key này resolve ra giá trị gì?" — như trên, trên toàn bộ
 *    ứng viên của key.
 *  - Timeline của một bản ghi: chuỗi version + event theo thời gian.
 *
 * Khác với truy vấn bi-temporal của graph v5 (validFrom/validUntil
 * của thế giới thật): ở đây chỉ có MỘT trục thời gian — thời điểm
 * ghi/đổi trạng thái trong kho (record time). Đây là "as known at T":
 * lúc T, hệ thống ĐÃ BIẾT gì (không phải "lúc T, thế giới ra sao").
 */

import type { V6Record, V6RecordView, V6ScopeQuery, V6StoreStats, V6VersionEvent } from './types';
import { bucketLabel } from './temporal';
import { scopeLevelOf, scopeVisible } from './scopes';
import { deriveEffectiveStatus } from './versioning';
import { recordHistory } from './versioning';
import type { V6RecordStore } from './store';

/** Trạng thái hiệu lực của một bản ghi TẠI thời điểm T. */
export function statusAtTime(
  record: V6Record,
  events: V6VersionEvent[],
  at: Date,
): { status: V6RecordView['status']; supersededBy?: string; reason?: string } {
  const atMs = at.getTime();
  const visible = events.filter((e) => e.targetId === record.id && Date.parse(e.at) <= atMs);
  return deriveEffectiveStatus(record, visible);
}

/** Một bản ghi kèm trạng thái hiệu lực TẠI thời điểm T. */
export function viewAtTime(
  record: V6Record,
  events: V6VersionEvent[],
  at: Date,
): V6RecordView {
  const eff = statusAtTime(record, events, at);
  const view: V6RecordView = { ...record, status: eff.status };
  if (eff.supersededBy) view.supersededBy = eff.supersededBy;
  if (eff.reason) view.statusReason = eff.reason;
  return view;
}

/**
 * Tất cả bản ghi đang ACTIVE tại thời điểm `at` (theo record time).
 * Bản ghi tạo SAU `at` không tính (lúc đó chưa tồn tại).
 */
export function listActiveAt(store: V6RecordStore, at: Date): V6RecordView[] {
  const atMs = at.getTime();
  const snapshot = store.snapshot();
  const out: V6RecordView[] = [];
  for (const record of snapshot.records) {
    if (Date.parse(record.createdAt) > atMs) continue;
    const view = viewAtTime(record, snapshot.events, at);
    if (view.status === 'active') out.push(view);
  }
  return out;
}

/**
 * Resolve một key TẠI thời điểm `at`: trong các ứng viên nhìn thấy
 * được từ `query` mà đã tồn tại lúc `at` và còn active lúc `at`,
 * mức hẹp nhất thắng (trong cùng mức, mới nhất lúc `at` thắng).
 */
export function resolveKeyAt(
  store: V6RecordStore,
  query: V6ScopeQuery,
  key: string,
  at: Date,
  priority: ('run' | 'agent' | 'user' | 'app')[] = ['run', 'agent', 'user', 'app'],
): V6RecordView | undefined {
  const trimmed = key.trim();
  if (trimmed === '') return undefined;
  const atMs = at.getTime();
  const snapshot = store.snapshot();
  const rank = (level: string): number => {
    const index = priority.indexOf(level as 'run' | 'agent' | 'user' | 'app');
    return index === -1 ? priority.length : index;
  };
  const candidates: V6RecordView[] = [];
  for (const record of snapshot.records) {
    if (record.key !== trimmed) continue;
    if (Date.parse(record.createdAt) > atMs) continue;
    const view = viewAtTime(record, snapshot.events, at);
    if (view.status !== 'active') continue;
    // Visibility tại thời điểm truy vấn (scope không đổi theo thời gian).
    if (!scopeVisible(record.scope, query)) continue;
    candidates.push(view);
  }
  candidates.sort((a, b) => {
    const rankDiff = rank(scopeLevelOf(a.scope)) - rank(scopeLevelOf(b.scope));
    if (rankDiff !== 0) return rankDiff;
    return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });
  return candidates[0];
}

/** Một bước trong timeline của một bản ghi. */
export interface V6TimelineStep {
  /** Thời điểm bước này (ISO). */
  at: string;
  /** Loại bước: tạo / supersede / retire / quarantine / restore / version mới. */
  kind: 'created' | 'superseded' | 'retired' | 'quarantined' | 'restored' | 'replaced_by';
  /** Mô tả ngắn. */
  label: string;
  /** Id bản ghi liên quan (bản thay thế, khi có). */
  relatedId?: string;
}

/**
 * Timeline đầy đủ của một bản ghi: lúc tạo, các event đổi trạng thái,
 * và bản ghi đã thay thế nó (nếu có). Sắp theo thời gian tăng dần.
 */
export function recordTimeline(store: V6RecordStore, id: string): V6TimelineStep[] {
  const target = store.getById(id);
  if (!target) return [];
  const chain = recordHistory(store, id);
  const steps: V6TimelineStep[] = [];
  for (const link of chain) {
    const record = link.record;
    steps.push({
      at: record.createdAt,
      kind: 'created',
      label: `Tạo version ${record.version}: "${record.text.slice(0, 80)}${record.text.length > 80 ? '…' : ''}"`,
    });
    for (const event of link.events) {
      switch (event.type) {
        case 'supersede':
          steps.push({
            at: event.at,
            kind: 'superseded',
            label: `Bị thay thế (${event.reason})`,
            relatedId: event.byId,
          });
          break;
        case 'retire':
          steps.push({ at: event.at, kind: 'retired', label: `Retired: ${event.reason}` });
          break;
        case 'quarantine':
          steps.push({ at: event.at, kind: 'quarantined', label: `Quarantined: ${event.reason}` });
          break;
        case 'restore':
          steps.push({ at: event.at, kind: 'restored', label: `Khôi phục về active (${event.reason})` });
          break;
      }
    }
  }
  // Bản ghi đã thay thế target (nằm ngoài chuỗi khi target không nối supersedes).
  const replacer = store.listAll().find((r) => r.supersedes === id);
  if (replacer && !steps.some((s) => s.relatedId === replacer.id)) {
    steps.push({
      at: replacer.createdAt,
      kind: 'replaced_by',
      label: `Được thay bằng version ${replacer.version}`,
      relatedId: replacer.id,
    });
  }
  steps.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return steps;
}

/** Đếm event theo loại trong một khoảng thời gian (để báo cáo). */
export function countEventsByType(
  events: V6VersionEvent[],
  from?: Date,
  to?: Date,
): Record<V6VersionEvent['type'], number> {
  const out: Record<V6VersionEvent['type'], number> = {
    supersede: 0,
    retire: 0,
    quarantine: 0,
    restore: 0,
  };
  for (const event of events) {
    const at = Date.parse(event.at);
    if (from && at < from.getTime()) continue;
    if (to && at > to.getTime()) continue;
    out[event.type] += 1;
  }
  return out;
}

/**
 * Báo cáo Markdown cho kho v6: thống kê + bucket + event gần đây.
 * Dùng cho tool stats mở rộng, CLI `memory-v6 stats`, hoặc dashboard.
 */
export function statsMarkdown(store: V6RecordStore, stats: V6StoreStats, now: Date = new Date()): string {
  const lines: string[] = ['# Memory v6 — thống kê', ''];
  lines.push(`- Tổng bản ghi: **${stats.totalRecords}** (active ${stats.activeRecords}, superseded ${stats.supersededRecords}, retired ${stats.retiredRecords}, quarantined ${stats.quarantinedRecords}).`);
  lines.push(`- Theo loại: ${Object.entries(stats.byKind).map(([k, v]) => `${k} ${v}`).join(', ')}.`);
  lines.push(
    `- Theo thời gian: ${(['today', 'this_week', 'this_month', 'older'] as const)
      .map((b) => `${bucketLabel(b)} ${stats.byBucket[b]}`)
      .join(', ')}.`,
  );
  lines.push(
    `- Theo scope: ${(['run', 'agent', 'user', 'app'] as const)
      .map((l) => `${l} ${stats.byScopeLevel[l]}`)
      .join(', ')}.`,
  );
  lines.push(`- Tổng event version: ${stats.totalEvents}.`);
  if (stats.newestAt) lines.push(`- Mới nhất: ${stats.newestAt}; cũ nhất: ${stats.oldestAt ?? '—'}.`);
  const events = store.listEvents();
  const recent = events.slice(-5).reverse();
  if (recent.length > 0) {
    lines.push('', '## Event gần nhất', '');
    for (const event of recent) {
      lines.push(`- [${event.at.slice(0, 19)}] ${event.type} ${event.targetId.slice(0, 8)} — ${event.reason} (bởi ${event.actor})`);
    }
  }
  void now;
  return lines.join('\n');
}
