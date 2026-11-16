# Coding agent v5 — git-native (v1.13, Đội T4)

Coding agent v5 học ý tưởng từ Aider — **chỉ học ý tưởng, không đọc,
không copy code/text/tài sản của Aider hay bất kỳ repo nào**. Mọi module
đều tự thiết kế và viết lại từ đầu trên nền coding agent v2–v4 của repo.

## Tính năng

### 1. Patch preview trước khi apply (`codingV5/patchPreview.ts`)

- `parseCodingV5Diff(diffText)` — parse unified diff thành
  file/hunk/dòng (hỗ trợ new/deleted/rename/binary, `\ No newline`).
- `renderCodingV5Preview(patch, opts)` — preview gọn: file nào, hunk
  nào (`file:hunk`), +/-, số dòng; cắt ngắn theo `maxChars` /
  `maxHunkLines`; `showContext: false` chỉ hiện dòng +/-.
- `CodingV5PatchSession` — duyệt từng hunk (`approveHunk` /
  `rejectHunk` / `approveAll`, kiểu `git add -p`), xuất patch chỉ gồm
  hunk đã duyệt (`approvedDiffText()`), `applyApproved()` qua
  `git apply` (luôn `--check` trước).
- `filterCodingV5Patch` + `serializeCodingV5Patch` — lọc hunk và dựng
  lại unified diff (tính lại header `@@ -a,b +c,d @@`).
- `saveCodingV5PatchReview` / `loadCodingV5PatchReview` — lưu phiên
  duyệt (diff gốc + quyết định từng hunk) xuống JSON để khôi phục sau
  restart; hunk id nào không còn trong patch thì bỏ qua và báo rõ.

### 2. Auto-commit message (`codingV5/commitMessage.ts`)

- `analyzeCodingV5Diff(patch)` — phân loại `feat` / `fix` /
  `refactor` / `test` / `docs` / `chore` từ đường dẫn + symbol thêm/xóa
  + từ khóa; scope từ module chung nhất của file đổi.
- `generateCodingV5CommitMessage(patch, opts)` — subject
  `type(scope): summary` (≤ 72 ký tự), body liệt kê file + symbol,
  footer issue ref; `validateCodingV5CommitMessage(msg)` kiểm tra theo
  quy ước repo.
- Message chỉ để xuất cho user/agent xác nhận trước khi commit — tool
  `coding_v5_patch_apply` chỉ commit khi message hợp lệ.

### 3. `/add` chọn lọc theo repo map (`codingV5/fileSelection.ts`)

- `CodingV5FileSet` — tập file đang làm: `add` / `drop` / `clear` /
  `list`, validate (trong repo, tồn tại, không phải `.git` /
  `node_modules` / `dist`), ước lượng token (ký tự / 4), cảnh báo vượt
  ngân sách, serialize JSON.
- `parseCodingV5FileCommand(input)` — `/add`, `/drop`, `/ls-files`,
  `/clear`, `/add --suggest <truy vấn> [--limit n]`.
- `suggestCodingV5Files(graph, files, query)` — gợi ý qua xếp hạng
  PageRank v2 của v4 (seed khớp truy vấn + tham chiếu + độ mới), kèm lý
  do từng file; `suggestCodingV5FilesByName` là fallback khi chưa có
  repo map (báo rõ là fallback).

### 4. Eval harness kiểu SWE-bench (`codingV5/sweBenchEval.ts`)

- Một task: `issue` + fixture repo + `patch` ứng viên + lệnh test
  (argv, không shell) + 2 nhóm `failToPass` / `passToPass`.
- `CodingV5SweHarness.runTask` — tạo repo git tạm, chạy test trên base,
  apply patch (`git apply --check` trước), chạy lại test, chấm đúng quy
  tắc SWE-bench: failToPass phải fail trước + pass sau; passToPass phải
  pass cả hai lần. Patch rỗng / không apply được → `error`.
- `runSuite` + `renderCodingV5SweReport` + `saveCodingV5SweReport` /
  `loadCodingV5SweReport` — báo cáo pass rate, lưu JSON để so sánh
  giữa các lần chạy. 3 task mẫu đi kèm (sửa đúng → PASS, patch sai →
  FAIL, patch phá test cũ → FAIL).
- `compareCodingV5SweReports(before, after)` /
  `renderCodingV5SweComparison` — task nào được sửa (fixed), task nào
  bị phá vỡ (regressed), pass rate đổi bao nhiêu; `listCodingV5SweReports`
  liệt kê báo cáo đã lưu; `validateCodingV5SweTask` kiểm tra task trước
  khi chạy.

### 5. Rollback theo commit + lịch sử patch (`codingV5/patchHistory.ts`)

- `CodingV5PatchHistory` — log JSON tại
  `.open-bot/coding-v5/patch-history.json`: commit SHA, message,
  type/scope, file, +/-, hunk duyệt/từ chối, trạng thái rollback.
- `rollbackCodingV5Patch(repoRoot, sha, { mode })` — `revert` (mặc định,
  an toàn, xung đột thì abort) hoặc `reset-hard` về SHA cha (phá hủy —
  cần `allowDestructive: true`, không rollback được root commit).

### 6. Git runner riêng (`codingV5/gitV5.ts`)

Allowlist đóng (`diff`, `apply`, `status`, `log`, `show`, `rev-parse`,
`add`, `commit`, `revert`, `reset`); argv từ tham số có cấu trúc (chống
option injection); patch apply qua stdin của `git apply`; kiểm tra
đường dẫn trong patch không thoát khỏi repo; không push/fetch, không
chạm remote, không tự set `user.name`/`user.email` (giống quy ước v2 —
commit/revert cần user đã cấu hình git, nếu chưa thì báo lỗi rõ ràng).

## Tools (11) — `packages/tools/src/codingV5Tools.ts`

`coding_v5_patch_preview`, `coding_v5_patch_apply`,
`coding_v5_commit_message`, `coding_v5_add`, `coding_v5_drop`,
`coding_v5_ls_files`, `coding_v5_suggest_files`, `coding_v5_eval_run`,
`coding_v5_eval_suite`, `coding_v5_rollback`, `coding_v5_patch_history`.

`CODING_V5_TOOLS` **không** gộp vào `ALL_TOOLS` — coordinator nối
registry trung tâm sau (quy tắc sóng v1.13). Import trực tiếp
`createCodingV5Tools` / `CODING_V5_TOOLS` từ `@open-bot/tools`.

## i18n

18 key `codingV5.*` trong đủ 6 locale (`vi`, `en`, `zh`, `ja`, `es`,
`fr` — repo dùng `fr`, không có `ko`): 4818 → 4836 key/locale.

## Test

- `tests/coding-v5-patch-preview.test.mjs` — parse/preview/filter/
  serialize/apply trên repo git thật.
- `tests/coding-v5-commit-message.test.mjs` — phân loại, scope,
  subject, validate.
- `tests/coding-v5-file-selection.test.mjs` — FileSet, parse lệnh,
  gợi ý qua graph v2/v4 thật.
- `tests/coding-v5-swe-eval.test.mjs` — 3 task mẫu (PASS/FAIL/FAIL),
  suite 1/3, save/load báo cáo.
- `tests/coding-v5-rollback-history.test.mjs` — revert/reset-hard trên
  repo git thật.
- `tests/coding-v5-tools.test.mjs` — 11 tool end-to-end.
- `tests/coding-v5-i18n.test.mjs` — key + placeholder 6 locale.

Chạy sau khi build core + tools:

```sh
npm run build --workspace=@open-bot/core
npm run build --workspace=@open-bot/tools
node --test tests/coding-v5-*.test.mjs
```

## Giới hạn trung thực

- Preview/apply dùng unified diff chuẩn của git; không hiểu
  `--word-diff` hay `--stat`.
- Hunk đã duyệt nhưng phụ thuộc hunk bị từ chối ở trước (cùng vùng)
  có thể apply thất bại — `git apply --check` báo trước, không đổi gì.
- Ước lượng token = ký tự / 4, không phải đếm token thật của model.
- Eval không phải Docker sandbox thật — chỉ chạy trong thư mục tạm;
  chỉ dùng task tự viết/tin cậy. Chấm theo exit code, không chấm nội
  dung output.
- Rollback `reset-hard` xóa commit và thay đổi chưa commit — chỉ dùng
  khi hiểu rõ; lịch sử patch chỉ ghi patch nào agent tự ghi qua tool.
