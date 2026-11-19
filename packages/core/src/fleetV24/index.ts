/**
 * Public surface của `packages/core/src/fleetV24/` (v1.37, Đội T6):
 * fleet v24 — automation dashboard + stop hook feedback + CIDR sandbox
 * rules trong router UI.
 *
 * Nối tiếp v23, không làm lại, không phá API v23:
 * - `automationDashboard.ts`: registry automation (owner, tag, status)
 *   + gom theo tag, lọc theo owner, thống kê tag/owner/toàn fleet,
 *   bật/tắt/pause theo nhóm tag, audit lifecycle.
 * - `automationRuns.ts`: run ledger — lịch sử chạy của automation
 *   (start/finish, outcome, duration), query theo automation/tag/
 *   owner/outcome/time window, failure rate, timing, stuck runs.
 * - `stopHookFeedback.ts`: feedback khi stop hook kích hoạt — lý do
 *   dừng, ai/quy trình nào kích hoạt, hành động tiếp theo đề xuất,
 *   truy vấn theo run/automation, xác nhận đã xem.
 * - `cidrSandbox.ts`: parse/validate CIDR v4+v6, rule allow/deny theo
 *   dải CIDR, bind theo route, đánh giá (route, IP) bằng longest
 *   prefix match, phát hiện chồng lấn, audit mọi thay đổi rule.
 * - `panelsV24.ts`: view-model automation dashboard / runs / stop hook
 *   / CIDR router + dashboard tổng hợp.
 * - `toolsV24.ts`: định nghĩa tool thuần (26 tool, 3 nhóm).
 *
 * Các module khác import từ đây (hoặc trực tiếp từng file) — không
 * import từ `fleetV23/` để tránh nhầm phiên bản (v24 làm việc trên
 * store riêng, host tự chuyển đổi).
 */
export const FLEET_V24_VERSION = 'v24';
export * from './automationDashboard';
export * from './automationRuns';
export * from './stopHookFeedback';
export * from './cidrSandbox';
export * from './panelsV24';
export * from './toolsV24';
