# Coding agent v7 — sóng v1.15 (Đội T4)

Học ý tưởng OpenHands V1 SDK (survey v1.15 §3: agent = hàm thuần từ
event history → next event; ConversationState event-sourced duy nhất;
CodeAct thay tool bespoke; Skills thay microagents). Chỉ học ý tưởng —
không copy code/text/tài sản của bất kỳ repo nào.

## Thiết kế

### 1. Stateless agent + event log append-only (`packages/core/src/codingV7/`)

- `conversationLog.ts` — `CodingV7Log`: append-only, hash chain
  SHA-256, `stateAt(seq)` / `replayFrom(seq)` (time-travel),
  `forkAt(seq)` (con giữ prefix, ghi rõ `forkedFrom`; cha ghi
  `v7.forked`), `pause()` / `resume()` hạng nhất (đếm số lần trong
  state), `toJsonl` / `fromJsonl`, snapshot kèm state đã fold
  (`toSnapshot` / `fromSnapshot`, verify chain trước khi tin).
- `agent.ts` — `decideV7NextAction(events, modelText)` là **hàm
  thuần**: cùng history + cùng model text → cùng action (test
  determinism). `CodingAgentV7.runTurn()` lặp step generate → parse
  → security → execute → observation, mỗi step ghi event vào log.
  Action `ask` pause chờ user (interrupt-and-resume); resume tiếp
  tục đúng step tiếp theo, không chạy lại step cũ.
- State suy ra duy nhất bằng fold (`foldV7Event`): file đã đổi,
  quyết định, lỗi đã gặp, skill đã kích hoạt, số lần pause/resume/
  condense, số action bị chặn.

### 2. CodeAct-lite v3 (`codeactV3.ts`)

- Parser: MỘT format — fenced block ```` ```bash ```` /
  ```` ```python ```` / ```` ```edit ```` / ```` ```read ```` /
  ```` ```think ```` / ```` ```finish ```` / ```` ```ask ```` +
  JSON block + dòng `ACTION: kind: ...`. Trả cả action lẫn lỗi parse.
- Executor tự chủ (`V7CodeActExecutor`): chạy thật bằng child_process
  trong working dir bị nhốt — bash qua `bash -c`, Python qua
  `python3 -`, file op qua fs có kiểm tra path. Timeout kill (timer
  riêng, báo `timedOut` rõ ràng), giới hạn output 20k ký tự, env đã
  lược (không forward secret host). Không cần BotBox/host.
- Giới hạn (ghi rõ): chạy trên máy host với user hiện tại, không phải
  VM/container cách ly; chặn lệnh nguy hiểm bằng pattern, không phải
  syscall sandbox; không giới hạn CPU/RAM ngoài timeout + output cap.

### 3. Condenser v3 (`condenserV3.ts`)

- Summary 6 mục cố định (goal / facts / decisions / filesChanged /
  errorsEncountered / openItems), trích từ state đã fold + log,
  không cần gọi LLM (đo được, replay được).
- Trigger theo token budget (`shouldCondenseV7Log`, heuristic
  chars/4), trả số token tiết kiệm được. Agent tự condense khi vượt
  budget, append event `v7.condensed`.
- `restoreV7Context(summary, log)`: summary + các event sau seq đã
  nén (còn nguyên, không mất thông tin gần đây).

### 4. Security analyzer (`security.ts`)

- Quét trước khi chạy, 3 mức **allow/warn/block** (warn vẫn chạy kèm
  cảnh báo; block không chạy, trả observation blocked). Rule engine
  dạng bảng (22 rule): block `rm -rf /|~|$HOME` (cả flag gộp `-rf`,
  `-fr`, `-r -f`, `--recursive --force`), `curl|sh`, đọc secret
  (`~/.ssh`, `.pem`, `.env`), exfil secret, sudo/su, fork bomb,
  mkfs/dd, ghi ngoài workspace; warn `rm -rf` trong workspace,
  download, pip/npm install, git push, `eval`/`os.system` trong
  Python...; audit log append-only riêng, secret redact trước khi ghi.

### 5. Skills kiểu microagents (`skills.ts`)

- Skill = file markdown có frontmatter (`name`, `description`,
  `triggers`) + hướng dẫn + ví dụ. Parser frontmatter tự viết
  (không phụ thuộc YAML lib). `discoverV7Skills(dir)` quét `*.md`,
  file lỗi chỉ warning. `matchV7Skills` chấm điểm theo số trigger
  trùng, xếp hạng. 3 skill mẫu thật: `fix-test-failure`,
  `refactor-extract`, `add-i18n-key` (ghi ra đĩa qua
  `writeV7BuiltinSkills`).

### 6. Eval (`eval.ts`)

- 3 task mẫu chạy thật trên repo mẫu trong /tmp (seed + check thật):
  sửa off-by-one, thêm `is_prime` + test, sửa greet capitalize.
  Check dùng **chỉ stdlib Python** (không phụ thuộc pytest — pytest
  có thể không có trên máy CI/VM khác). `runV7EvalTask` /
  `runV7Eval` trả pass rate; `scriptedV7Generator` cho model xác
  định; model không làm gì → fail (không cho pass khống).

## Tools (9) — `packages/tools/src/codingV7Tools.ts`

`coding_v7_start/step/pause/resume/replay/security/condense/skills/eval`,
đăng ký vào registry (`ALL_TOOLS` 491 → **500**), bind qua
`getCodingV7BaseDir` (replace-in-place, không trùng tên). Log ở
`<baseDir>/coding-v7/<sessionId>.jsonl`.

## CLI — `apps/cli/src/codingV7Command.ts`

`open-bot coding-v7 security|skills|eval|replay` (xem `--help`).
Security block → exit 2; eval fail → exit 2.

## i18n

`codingV7.*` 20 key, đủ 6 locale (vi/en/es/fr/ja/zh), cùng key set.

## Kiểm chứng

- `npm run build` + `typecheck` cho core/tools/cli: xanh.
- `node --test tests/coding-v7-v115.test.mjs`: **34 pass, 0 fail**
  (log/fork/pause/snapshot, parser, executor thật, security,
  condenser, skills, agent e2e, eval 3/3 pass, tools e2e, CLI thật,
  i18n).
- Eval scripted: pass rate **3/3 = 100%**; model no-op: fail (đo được).

## Giới hạn còn tồn tại

- Executor không phải sandbox cách ly thật (xem §2).
- Eval chỉ có 3 task mẫu + scripted model — chưa đo model thật.
- Các test pin `ALL_TOOLS.length === 491` ở các file khác sẽ đỏ
  (491 → 500 do +9 tool v7); coordinator gộp re-pin như mọi sóng
  (v1.14 đã re-pin 491). Số cuối sau gộp 6 đội sẽ khác 500.
- i18n 5 locale (trừ vi/en) chưa được người bản ngữ rà soát.
- pytest đã cài trên VM này (`pip --break-system-packages`) để tiện
  tay, nhưng eval không phụ thuộc nó.
