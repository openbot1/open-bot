/**
 * Repo map v5 (v1.13, Doi T3) — symbol topology + hierarchical
 * summaries + incremental index + code graph search + jump-to-
 * definition cho agent loop.
 *
 * Y tuong hoc tu OpenHands Repository Map — chi hoc y tuong, tu thiet
 * ke va viet lai hoan toan tu dau, KHONG doc, KHONG copy code/text/
 * tai san cua bat ky repo nao, cua xAI/Cursor.
 *
 * Lop nay mo rong repo map v2/v3/v4 (xem tung module): v2 do thi
 * symbol-level + PageRank, v3 call edges + module graph + budget
 * map, v4 PageRank v2 + weighted map + cache invalidation theo
 * fingerprint. v5 them export/import/call-site topology that, tom
 * tat phan cap theo thu muc, index tang dan theo content hash +
 * invalid theo phu thuoc, tim kiem tren do thi code, va API
 * jump-to-definition cho agent loop.
 *
 * Local-first: khong X, khong Grok Imagine, khong cloud VM/tai
 * khoan/thanh toan. Module core thuan tuy (khong fs); lop fs song o
 * `packages/tools/src/codingV5RepoMap.ts`.
 */

export * from './topology';
export * from './summaries';
export * from './incrementalIndex';
export * from './search';
export * from './jumpToDefinition';

/**
 * Coding agent v5 (v1.13, Doi T4) — git-native, hoc y tuong tu Aider.
 *
 * Y tuong hoc tu Aider (chi hoc y tuong, tu thiet ke va viet lai hoan
 * toan tu dau, KHONG doc, KHONG copy code/text/tai san cua bat ky repo
 * nao, cua xAI/Cursor):
 *
 *   - Patch preview truoc khi apply: unified diff -> preview file/hunk
 *     -> duyet tung hunk (kieu `git add -p`) -> chi apply hunk duyet.
 *   - Auto-commit message co nghia tu diff (type/scope/summary theo
 *     quy uoc repo).
 *   - `/add` chon loc theo repo map v4 (PageRank v2 + tham chieu +
 *     do moi): `/add`, `/drop`, `/ls-files`, goi y theo truy van.
 *   - Eval harness kieu SWE-bench chay local: issue -> patch -> chay
 *     test FAIL_TO_PASS / PASS_TO_PASS truoc/sau patch, cham pass/fail,
 *     luu ket qua tung bai, bao cao ti le.
 *   - Rollback theo commit: revert (an toan) hoac reset-hard (pha huy,
 *     can xac nhan), log lich su patch tren dia.
 *
 * Local-first: khong X, khong Grok Imagine, khong cloud VM/tai khoan/
 * thanh toan. Khong push/fetch, khong cham remote.
 */

export * from './gitV5';
export * from './patchPreview';
export * from './commitMessage';
export * from './fileSelection';
export * from './sweBenchEval';
export * from './patchHistory';
