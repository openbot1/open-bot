/**
 * Public surface của `packages/core/src/fleetV19/` (v1.29, Đội T6):
 * platform/fleet v19 — fleet health monitoring (lịch sử health,
 * trend, điểm fleet tổng hợp, alert rule + vòng đời), job queue
 * (ưu tiên + aging, retry backoff, dead-letter, idempotency, phân
 * bổ lên node), node status (bảng chuyển trạng thái, heartbeat stale
 * 4 mức, pressure tài nguyên, ranking placement, snapshot), plugin
 * SDK v4 (capability manifest versioned, lifecycle install/enable/
 * disable/uninstall, dependency resolve, sandbox quyền), panels v19
 * (fleet health, job queue, node status, plugin store), tools v19.
 *
 * Các module khác import từ đây (hoặc trực tiếp từng file) — không
 * import từ `fleet/` v12 hay `fleetV13/`..`fleetV17/` để tránh nhầm
 * phiên bản (trừ khi module v19 ủy thác tường minh cho v14/v17, đã
 * ghi rõ trong doc từng file).
 */
export * from './fleetHealthV19';
export * from './jobQueueV19';
export * from './nodeStatusV19';
export * from './pluginSdkV19';
export * from './panelsV19';
export * from './toolsV19';
