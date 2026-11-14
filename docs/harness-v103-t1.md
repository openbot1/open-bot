# Harness engine v2 — v1.03, Đội T1

Ý tưởng học từ `docs/repo-survey-v103.md` §1–2 (OpenHands V1 SDK:
event-sourced conversation, CodeAct; harness engineering: stuck
detection là pattern còn thiếu). Chỉ học ý tưởng — không copy
code/text/tài sản của bất kỳ repo nào.

## 1. Event-sourced conversation, sâu hơn

Run log v1.01 đã có: append-only JSONL + hash chain, fold → trạng
thái, deterministic replay, pause/resume/fork. v1.03 thêm 3 loại
event mới (`packages/core/src/event-log/types.ts`):

| Event | Ý nghĩa |
|---|---|
| `event.redacted` | Marker che nội dung của một event cũ (theo seq). |
| `run.compacted` | Marker: prefix tới `upToSeq` đã có bản tóm tắt. |
| `stuck.detected` | Marker audit: một lần phân tích phát hiện agent kẹt. |

`foldEvents` (`replay.ts`) đã biết 3 loại mới: redaction được áp
dụng ngược lại transcript/tool result đã fold; compaction và stuck
detection được gom vào `state.compactions` / `state.stuckDetections`;
`state.redactedSeqs` liệt kê các seq đã che.

### Time-travel (`timeTravel.ts`)

- `replayUpTo(store, runId, atSeq)` — fold prefix 1..atSeq → trạng
  thái tại điểm đó. `atSeq = 0` → trạng thái rỗng. Chỉ đọc.
- `forkRunAt(store, parentRunId, fromSeq, opts)` — bọc `forkRun`
  (control.ts) với `fromSeq` bắt buộc + trả luôn trạng thái con tại
  điểm fork. Run cha không đổi.
- `compareRunStates(a, b)` — diff số học (steps/tokens/tool/file/
  errors/transcript, status).
- `listChildRuns(store, runId)` — các run con fork từ run này.

Lưu ý: digest của con khác digest của cha tại cùng điểm fork vì
`startedAt` khác nhau (con có event `run.started` riêng). Nội dung
(prompt/steps/tokens/transcript) thì bằng nhau — test
`harness-v103-timetravel` kiểm chứng theo field, không theo digest.

### Redaction (`redaction.ts`)

Append-only: event gốc KHÔNG BAO GIỜ bị sửa/xoá (hash chain giữ
nguyên để audit còn kiểm chứng được). `redactEvent` chỉ append
marker `event.redacted`; `foldEvents` che ngược lại bản hiển thị
(prompt / model text / tool output / compile error + chuỗi lỗi suy
ra từ đó).

**Giới hạn phải nói rõ với user:** redaction chỉ che *bản hiển
thị* — ai cầm file `.jsonl` vẫn đọc được event gốc. Muốn xoá thật
khỏi đĩa thì phải xoay/xoá file log (ngoài scope module này).
`redactEvent` từ chối event không có nội dung text để che
(`run.started`, `file.change`, …) và seq không tồn tại.
`findEventsContaining` định vị seq chứa một chuỗi (vd secret lọt
vào log) để redact.

## 2. CodeAct-style tool (`packages/tools/src/harnessV103Tools.ts`)

Một contract duy nhất Action → Execution → Observation thay cho
nhiều tool bespoke:

- `codeact_execute` — `kind: bash | python | read | write | edit`.
  Bash/python chạy qua `runShell` (denylist + cwd confinement +
  timeout + safe env của sandbox); python được ghi ra file tạm dưới
  `.open-bot/codeact/` rồi chạy `python3`. Editor chỉ chạm file
  trong workspace (`resolveWithin`). Trả observation JSON chuẩn:
  `{kind, status, exitCode, stdout, stderr, durationMs,
  changedFiles}`. `needsApproval: true` (chạy code thật).
- Bốn tool run-log (không cần approval, chỉ đọc/ghi trong thư mục
  run-log, mặc định `<workspaceDir>/.open-bot/run-logs`):
  `harness_run_fork`, `harness_run_replay` (time-travel, chỉ đọc),
  `harness_stuck_check` (phân tích kẹt; `record=true` thì ghi thêm
  marker audit), `harness_run_compact` (condenser + marker).
- Cả 5 tool đăng ký vào `ALL_TOOLS` (registry 259 → **264**);
  3 test đếm registry đã cập nhật (`conversation-history-v085`,
  `rescue-v102-tools`, `coordinator`).

## 3. Stuck detection (`stuck.ts`)

Hàm thuần trên event đã ghi (không gọi model). Sáu tín hiệu:

1. `repeat_tool_call` — cùng tool call (tool + argKeys) lặp liên
   tiếp ≥ 3. Dedup theo callId: một lần gọi xuất hiện ở cả
   `model.response` và `tool.call` chỉ đếm 1 lần.
2. `repeat_tool_error` — cùng tool lỗi ≥ 3 lần liên tiếp.
3. `repeat_compile_error` — cùng `firstError` ≥ 3 lần.
4. `empty_response_loop` — response rỗng kèm tool call ≥ 3 lần.
5. `no_progress` — ≥ 8 step không file change / tool ok.
6. `step_budget` — đã dùng ≥ 80% maxSteps.

`detectStuck` trả `StuckReport { stuck, step, signals,
suggestionKey }`; `suggestionKey` trỏ tới key i18n
`harness.v103.stuck.*` (UI dịch key này). `recordStuckDetection`
ghi marker `stuck.detected` để audit.

Khác với `planning/stuck.ts` (detector live-stream theo tool-call
stream, có stall/tool-cycle): detector này chạy post-hoc trên event
log, thêm compile-error loop, empty-response loop, step budget và
tiến triển theo file change. Hai detector bổ sung cho nhau, không
thay thế nhau.

## 4. Condenser (`condenser.ts`)

Tóm tắt trích xuất xác định (không gọi LLM — cùng log luôn cho cùng
bản tóm tắt): prompt, tool nào chạy bao nhiêu lần / lỗi mấy lần,
file đã đổi, compile error, outcome. `shouldCondense` theo ngưỡng
event/token; `compactRun` tóm tắt prefix rồi append marker
`run.compacted` (event gốc vẫn còn nguyên — compaction không xoá
lịch sử). Ước lượng token dùng chung `estimateTokens`
(`agent/tokens.ts`); riêng `estimateEventTokens` cộng thêm overhead
mỗi event.

## 5. i18n

12 key mới `harness.v103.*` (stuck suggestions ×6 + titles +
time-travel + condenser + codeact) trong đủ 6 locale
(en/vi/es/fr/ja/zh): 2799 → **2811 keys/locale**.

## 6. Test

- `tests/harness-v103-timetravel.test.mjs` (8 test)
- `tests/harness-v103-stuck-condenser.test.mjs` (8 test)
- `tests/harness-v103-tools.test.mjs` (5 test)
- Hồi quy: `i18n`, `runlog-v101-*` (6 file), `conversation-history-v085`,
  `rescue-v102-tools`, `coordinator` — đều xanh.

## 7. Giới hạn còn lại

- Time-travel fork: digest cha/con khác nhau ở `startedAt` (nói trên).
- Redaction không xoá dữ liệu khỏi file log trên đĩa (nói trên).
- Condenser là trích xuất, chưa dùng LLM để tóm tắt ngữ nghĩa —
  bản tóm tắt dài ~tối đa 1500 ký tự, đủ cho context loading nhưng
  không thay được đọc kỹ log.
- Stuck detection là heuristic trên mẫu lặp — có thể báo kẹt giả
  khi agent cố tình thử lại cùng thao tác (vd polling); ngưỡng có
  thể chỉnh qua `StuckOptions`.
- `codeact_execute` chạy code trên máy user (đã có approval +
  sandbox) nhưng không có network egress policy riêng — thừa hưởng
  denylist của `runShell`; container/sandbox v3 là việc của Đội T4.
