/**
 * Public surface của `packages/core/src/fleetV20/` (v1.33, Đội T6):
 * platform/fleet v20 — subagent chuyên biệt Explore/Plan/Verify
 * (`specializedSubagentsV20.ts`, tiếp tục từ code dở đội trước để lại),
 * context cô lập cho subagent (`subagentContextV20.ts` — budget, pool,
 * handoff đã validate), plugin manager v20 (lifecycle install/enable/
 * disable/uninstall, compat host, dependency, duyệt quyền nguy hiểm),
 * hook manager v20 (match event, log chặn, tự tắt khi lỗi liên tiếp),
 * eval harness v20 (% resolved trên task đã chạy xong, cost/task,
 * breakdown theo category/độ khó, so baseline phát hiện hồi quy),
 * panels v20 (view-model Plugin/Hook/Eval/Subagent cho desktop),
 * tools v20 (định nghĩa thuần, không tự đăng ký vào registry trung tâm).
 *
 * Các module khác import từ đây (hoặc trực tiếp từng file) — không
 * import từ `fleet/` v12 hay `fleetV13/`..`fleetV19/` để tránh nhầm
 * phiên bản (trừ khi module v20 ủy thác tường minh, đã ghi rõ trong
 * doc từng file).
 */
export * from './specializedSubagentsV20';
export * from './subagentContextV20';
export * from './subagentDelegationV20';
export * from './pluginManagerV20';
export * from './hookManagerV20';
export * from './evalHarnessV20';
export * from './panelsV20';
export * from './toolsV20';
