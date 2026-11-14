/**
 * Coding agent v2 (v1.08, Đội T2) — Aider-style, tự thiết kế lại.
 *
 *  - Repo map v2: đồ thị symbol + import, PageRank, cập nhật tăng dần,
 *    cache trên đĩa, API truy vấn "file nào liên quan nhất tới X".
 *  - Architect mode: planner và editor tách riêng, planner duyệt diff
 *    sau mỗi bước, lệch kế hoạch thì dừng.
 *  - Git-first: mỗi edit thành 1 commit riêng có thể revert, kèm diff
 *    view, revert 1 commit, squash chuỗi commit.
 *
 * Local-first: không X, không Grok Imagine, không cloud VM/tài khoản/
 * thanh toán. Mọi thứ chạy trên máy user.
 */

export * from './repoMapGraph';
export * from './architect';
export * from './gitFirst';
