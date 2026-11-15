/**
 * Coding agent v3 (v1.10, Đội T4) — repo map PageRank v2 nâng cấp,
 * manager/explorer/worker, eval harness kiểu Terminal-Bench, router
 * model local.
 *
 * Ý tưởng học từ Codex (manager/explorer/worker, giới hạn thread),
 * Claude Code Agent Teams (shared task list + claiming) và
 * Terminal-Bench (task + setup/test + chấm điểm tự động) — chỉ học ý
 * tưởng, tự thiết kế và viết lại hoàn toàn từ đầu, KHÔNG đọc, KHÔNG
 * copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor.
 *
 * Local-first: không X, không Grok Imagine, không cloud VM/tài khoản/
 * thanh toán. Router chỉ chấm điểm trên bảng tĩnh, không gọi API.
 */

export * from './repoMapV3';
export * from './team';
export * from './evalHarness';
export * from './modelRouter';
