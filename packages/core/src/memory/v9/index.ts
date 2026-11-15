/**
 * Memory v9 — barrel export (v1.08, Đội T1).
 *
 * Sleep-time compute nền tự động (daemon nối consolidation v8 +
 * trích fact v0.97 + snapshot block), git-backed versioning cho
 * block (snapshot / history gộp / diff từng dòng / rollback), và
 * shared-block registry (ACL theo bot, change feed, phát hiện xung
 * đột ghi đồng thời). Nối tiếp v6/v7/v8, không thay API cũ.
 */
export * from './types';
export * from './sleepAgent';
export * from './versioning';
export * from './sharedRegistry';
