/**
 * Public surface của `packages/core/src/fleetV23/` (v1.36, Đội T6):
 * fleet v23 — topology + scheduler v2 + placement v2 + rebalance v2.
 *
 * Nối tiếp v22, không làm lại, không phá API v22:
 * - `topology.ts`: zone/failure domain + bot group (spread,
 *   affinity/anti-affinity ở mức group, quorum) + thiệt hại khi một
 *   zone chết.
 * - `schedulerV2.ts`: hàng đợi ưu tiên (priority + aging chống đói),
 *   cron 5 trường, SLA deadline + breach, preemption theo SLA (job
 *   critical cướp chỗ job thấp hơn, có luật bảo vệ).
 * - `placementV2.ts`: chấm điểm node 6 tiêu chí (CPU/RAM/disk trống,
 *   độ tin cậy, độ trễ, chi phí) với trọng số cấu hình được, Pareto
 *   frontier, capacity planning (dự báo ngày hết chỗ).
 * - `rebalanceV2.ts`: đo lệch tải (CV + spread), lập kế hoạch di
 *   chuyển bot (tham lam, tôn trọng pinned/topology), dry-run, thực
 *   thi từng bước có xác minh + rollback khi lỗi.
 * - `dispatchV2.ts`: vòng dispatch — gán job queued (theo thứ tự ưu
 *   tiên) lên node bằng placement scorer v2, job không đặt được thì
 *   hoãn lại kèm lý do; áp dụng kế hoạch (start job + đổi placement).
 * - `autoscaleV2.ts`: đề xuất scale-out/scale-in từ capacity
 *   forecast + hàng đợi + SLA, có cooldown chống scale liên tục.
 * - `healthV2.ts`: chấm sức khoẻ node (availability/reliability/
 *   load/freshness) + rollup fleet (zone degraded, group nguy cơ mất
 *   quorum) + alert + lịch sử/xu hướng.
 * - `panelsV23.ts`: view-model topology/scheduler/placement/
 *   rebalance + dashboard tổng hợp.
 * - `toolsV23.ts`: định nghĩa tool thuần (24 tool, 4 nhóm).
 *
 * Các module khác import từ đây (hoặc trực tiếp từng file) — không
 * import từ `fleetV21/` hay `fleetV22/` để tránh nhầm phiên bản
 * (v23 làm việc trên snapshot riêng, host tự chuyển đổi).
 */
export const FLEET_V23_VERSION = 'v23';
export * from './topology';
export * from './schedulerV2';
export * from './placementV2';
export * from './rebalanceV2';
export * from './dispatchV2';
export * from './autoscaleV2';
export * from './healthV2';
export * from './panelsV23';
export * from './toolsV23';
