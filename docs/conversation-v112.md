# Event-sourced Conversation + CodeAct-lite (v1.12, Đội T2)

## Vấn đề

Run log ở `packages/core/src/event-log/` ghi **một run** (một lượt
chạy của AgentRunner). Nhưng một **conversation** kéo dài nhiều turn,
nhiều run, có thể rẽ nhánh — không có source of truth nào cho toàn
bộ hội thoại. CodeAct v2 (`codeact/`) yêu cầu agent gọi tool tường
minh; agent viết code trong text tự do thì code đó không chạy. Skill
chuẩn sống ở `<userData>/skills/` — skill đi kèm repo/workspace thì
không có chỗ.

## Giải pháp (module mới `packages/core/src/conversationV112/`)

Ý tưởng học từ OpenHands V1 SDK: stream event typed Action /
Observation bất biến + replay để tái tạo state. Chỉ học ý tưởng,
không copy code/text/tài sản.

### 1. Conversation event log (append-only, hash chain)

- `store.ts` — `ConversationLogStore`: một conversation = một file
  JSONL `<conversationId>.jsonl` dưới `<dataDir>/conversations-v112/`.
  Append tự điền `seq`/`prevHash`/`hash`, fsync trước khi trả về.
  Đọc: `readAll` / `readRange` / `tail`; dòng cuối bị cắt do crash
  được báo `corruptTail: true` thay vì throw cả file. File đầy
  (`maxFileBytes`, mặc định 16 MB) → từ chối append, host phải
  snapshot + compact.
- `types.ts` — 13 loại event: `conversation.started`, `user.message`,
  `agent.message`, `action.tool`, `observation.tool`,
  `action.codeact`, `observation.codeact`, `skill.loaded`,
  `skill.suggested`, `conversation.branched`,
  `conversation.snapshot`, `conversation.compacted`,
  `conversation.ended`.
- `canonical.ts` — hash chain SHA-256 trên bản chuẩn hoá (key sắp
  xếp). Sửa 1 byte → verify báo đúng seq hỏng.
- `redact.ts` — secret rõ ràng (sk-/xai-/AKIA/ghp_/Bearer/password…)
  bị thay bằng `[REDACTED]` **trước khi lưu**; text dài bị cắt ngắn
  kèm `originalChars`. Redaction là best-effort theo mẫu — không đảm
  bảo bắt mọi secret.
- `replay.ts` — `foldConversationEvents` thuần (cùng dãy event luôn
  cho cùng state): messages, pending tool/CodeAct, skill đã nạp,
  counts, branches, snapshot. `replayDeterministicallyV112` fold hai
  lần để chứng minh determinism.

### 2. Branch / snapshot / compact

- `branches.ts` — fork tại `fromSeq`: conversation con sao chép
  event tới đó (chain tính lại từ đầu, seq đếm lại từ 1), cha ghi
  `conversation.branched`. Mỗi conversation một file riêng nên sửa
  con không ảnh hưởng cha.
- `snapshots.ts` — snapshot là file JSON riêng theo throughSeq
  (`<id>.snapshot-<seq>.json`, kèm SHA-256 verify); `replayFromSnapshot`
  bắt đầu từ snapshot mới nhất rồi fold event sau anchor. Compact:
  snapshot tại N rồi viết lại log chỉ giữ anchor + event sau N;
  replay từ snapshot vẫn cho đủ state (log-only fold thì thiếu — hành
  vi có chủ ý, đã ghi rõ trong code + test). `foldStateAtSeq` fold
  tới một seq bất kỳ (hiểu cả log đã compact); snapshot sau compact
  không ghi đè file snapshot cũ cùng số seq (thêm hậu tố `-2`/`-3`…).
- `timetravel.ts` — `stateAtSeq` (state tại một seq),
  `diffConversationStates`, `timeTravelConversation` (state tại seq +
  diff tới hiện tại + số event tương lai). Read-only, không ghi log.

### 3. CodeAct-lite

- `codeactLite.ts` — trích fenced block ```` ```bash ```` /
  ```` ```python ```` từ text agent rồi chạy qua `CodeActExecutor`
  (BotBox sandbox). Không có block → validation error.
- `policy.ts` — chặn thêm so với CodeAct v2: sudo/su/passwd/ssh/
  scp/netcat, `curl|sh`, `env`/`printenv` trần, ghi device/thư mục
  hệ thống, `os.system`/`subprocess`/`os.environ`/`eval`/`exec`
  trong Python. Bị chặn → observation `blocked`, không throw.
  Ngân sách: tối đa 8 action/turn, code tối đa 32.000 ký tự/action.

### 4. Skills workspace nạp theo yêu cầu

- `skillsOnDemand.ts` — quét `.openbot/skills/` trong workspace
  (loose `<name>.md` hoặc `<name>/SKILL.md`), tái dùng parser YAML
  của `skills/loader.ts` (không viết parser mới). Tier 1 chỉ đọc
  frontmatter; tier 2 đọc body khi `loadWorkspaceSkill`; suggest
  khớp trigger (3đ) + description/when-to-use (1đ), ngưỡng ≥ 2.
  Skill `disable-model-invocation` không bao giờ được suggest.
  Tên skill phải khớp tên file — sai thì ghi errors, không chặn
  skill khác.

### 5. Session + loop adapter

- `session.ts` — `ConversationV112Session`: API cao cấp (record
  message/tool/skill, `runCodeActText`, `branch`, `snapshot`,
  `compact`, `exportToFile`, `end`). State cache fold sau mỗi lần
  append. Mở lại conversation cũ = replay từ snapshot + log.
- `loopAdapter.ts` — nối vào loop **không sửa `agent/loop.ts`**:
  `toToolCallRecorder` implement `ToolCallRecorder` (một `record()`
  ghi cặp action/observation, nuốt lỗi + đếm `dropped`);
  `attachConversationV112ToRunner` trả `{ toolCallRecorder }` để
  spread vào `AgentRunnerOptions`.

### 6. Tools (11) + UI + i18n

- `packages/tools/src/conversationV112Tools.ts`:
  `conversation_v112_start/append_message/replay/branch/snapshot/
  compact/export/timetravel`, `codeact_v112_run_text`, `skill_v112_list/load`.
  Placeholder trong `ALL_TOOLS` tới khi host bind
  `createConversationV112Tools(getBaseDir, { getCodeActExecutor })`.
  ALL_TOOLS: 359 → **370**.
- `apps/desktop/src/renderer/components/ConversationV112Panel.tsx` —
  panel presentational (nhận state + event tail qua props, không gọi
  IPC).
- i18n: 33 key `convV112.*` × 6 locale (vi/en/zh/ja/es/fr), tổng
  mỗi locale 4565 → **4598**.

## Giới hạn còn tồn tại

- Hash chain chống sửa lén từng event, không chống xoá toàn bộ file
  log, không phải chữ ký số.
- Redaction chỉ bắt secret theo mẫu rõ ràng.
- Sau compact, seq đánh lại từ 1 (anchor) — seq là số thứ tự trong
  file log hiện tại, không phải số toàn cục của conversation. Diff
  time-travel so theo seq trong file log hiện tại nên sau compact chỉ
  đúng về số lượng qua biên compact, không đảm bảo đúng danh tính
  từng message.
- CodeAct-lite không có action `edit` (chỉ bash/python); muốn sửa
  file thì dùng CodeAct v2 hoặc bash (`cat > file` trong box).
- Box có thể là isolation `none` trên máy này (không Docker/bwrap)
  — xem `sandbox/env.ts`: khi đó box chỉ là thư mục riêng + prlimit,
  không phải container.
- Pin toàn cục cần coordinator gộp tính lại: ALL_TOOLS 359 → 370
  (cộng thêm tool các đội khác cùng sóng nếu có); i18n 4565 → 4598
  (tương tự). Các test pin cũ (`tests/agent-teams-v3-v111.test.mjs`,
  `tests/coding-v2-tools.test.mjs`, `tests/i18n-v106/107/108/109*.test.mjs`)
  sẽ đỏ tới khi coordinator cập nhật số — đó là thay đổi có chủ ý,
  không phải hồi quy.

## Test

```sh
npm run build --workspace=@open-bot/core
npm run build --workspace=@open-bot/tools
node --test tests/conversation-v112-store.test.mjs \
  tests/conversation-v112-replay.test.mjs \
  tests/codeact-lite-v112.test.mjs \
  tests/skills-ondemand-v112.test.mjs \
  tests/conversation-v112-tools.test.mjs \
  tests/conversation-v112-loop.test.mjs \
  tests/i18n-v112.test.mjs
# 57 test, 0 fail (kiểm chứng 2026-11-15)
```
