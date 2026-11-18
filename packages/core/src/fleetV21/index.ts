/**
 * Public surface của `packages/core/src/fleetV21/` (v1.34, Đội T6):
 * platform/fleet v21 — sandbox-tier-aware scheduling, multi-node
 * placement, durable automation v2, fleet dashboard tổng hợp.
 *
 * - `tiers.ts`: tier cách ly riêng của fleetV21 (bwrap <
 *   syscall-policy < microvm) — không phụ thuộc code sandboxV2 của
 *   đội T2 sóng này.
 * - `nodes.ts`: node model + registry trong bộ nhớ + heartbeat ageing.
 * - `scheduler.ts`: chấm điểm node theo tier/tài nguyên/độ tin cậy/
 *   độ trễ; từ chối kèm lý do từng node khi không node nào đủ tier.
 * - `placement.ts`: đặt nhiều run song song (bin-packing + affinity/
 *   anti-affinity), rebalance (node mới vào / node chết), lịch sử
 *   placement để audit.
 * - `panelsV21.ts`: view-model node/run/automation + dashboard tổng hợp.
 * - `toolsV21.ts`: định nghĩa tool thuần (18 tool, 4 nhóm).
 *
 * Durable automation v2 nằm ở `packages/core/src/durable/automationV2.ts`
 * (file mới, không sửa file durable hiện có) — import từ đó, không qua đây.
 *
 * Các module khác import từ đây (hoặc trực tiếp từng file) — không
 * import từ `fleet/` v12 hay `fleetV13/`..`fleetV20/` để tránh nhầm
 * phiên bản.
 */
export const FLEET_V21_VERSION = 'v21';
export * from './tiers';
export * from './nodes';
export * from './scheduler';
export * from './placement';
export * from './panelsV21';
export * from './toolsV21';
