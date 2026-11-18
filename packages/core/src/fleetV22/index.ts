/**
 * Public surface của `packages/core/src/fleetV22/` (v1.35, Đội T6):
 * fleet đa người dùng + orchestration 2 mẫu.
 *
 * - `users.ts`: user đa người dùng — vai trò (viewer/member/operator/
 *   admin), quota theo tài nguyên đã cấp, kiểm tra quyền, registry.
 * - `computers.ts`: per-bot computer — 3 loại (cloud-linux-desktop /
 *   local-vm / own-computer), vòng đời, registry (1 computer đang hoạt
 *   động / bot).
 * - `probes.ts`: probe tài nguyên host thật (CPU/RAM/disk) + phân vùng
 *   sau khi trừ headroom cho host (không làm hại máy user).
 * - `delegation.ts`: subagent delegation kiểu Claude Agent SDK — parent
 *   giữ quyền kiểm soát, subagent chạy context riêng, budget, xác minh.
 * - `handoff.ts`: handoff chuyển giao kiểu OpenAI Agents SDK — chuyển
 *   toàn bộ hội thoại sang agent chuyên môn (`transfer_to_*`), chain,
 *   chống vòng lặp, duyệt khi cần.
 * - `orchestration.ts`: orchestrator — rule router (delegation mặc
 *   định), escalation, audit trail append-only, snapshot.
 * - `panelsV22.ts`: view-model user/computer/orchestration/probe +
 *   dashboard tổng hợp.
 * - `toolsV22.ts`: định nghĩa tool thuần (24 tool, 4 nhóm).
 *
 * Các module khác import từ đây (hoặc trực tiếp từng file) — không
 * import từ `fleetV21/` để tránh nhầm phiên bản.
 */
export const FLEET_V22_VERSION = 'v22';
export * from './users';
export * from './computers';
export * from './probes';
export * from './delegation';
export * from './handoff';
export * from './orchestration';
export * from './panelsV22';
export * from './toolsV22';
