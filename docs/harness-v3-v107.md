# Harness v3 — vòng lặp Agent/Conversation/EventLog gọn (v1.07, Đội T2)

Ý tưởng học từ survey v1.07 phần 1 (OpenHands v1.38 V1 SDK — chỉ học ý
tưởng, không copy code/text/tài sản của repo nào, của xAI/Cursor).

## Quyết định kiến trúc: KHÔNG có controller trung gian

OpenHands V1 bỏ AgentController vì "không xứng đáng với sự phức tạp":
vòng lặp + event log đã đủ. open-bot làm theo:

- `V3Conversation` (`packages/core/src/harness/v3/conversation.ts`)
  CHÍNH LÀ vòng lặp: nhận prompt → hỏi agent → thực thi action trong
  workspace → ghi event → lặp. Không có lớp `V3Controller` nào nữa.
- `LocalHarness` giữ vai trò cũ (registry instance + event bus +
  NDJSON log + permission broker) và KHÔNG trở thành controller của
  vòng lặp này. Host nối hai tầng bằng `onEvent` (forward event V3
  sang `publishLoopEvent`) nếu muốn NDJSON/bus thấy turn V3.
- `agent/loop.ts` (AgentRunner) và `event-log/RunLogStore` KHÔNG bị
  thay: V3 là vòng lặp gọn, nhẹ, dùng độc lập (headless, eval,
  sub-agent) và cho bot mới. AgentRunner vẫn là đường chạy chính của
  desktop cho tới khi coordinator quyết định chuyển.

## Thành phần

| File | Vai trò |
| --- | --- |
| `v3/types.ts` | `V3Action` / `V3Observation` / `V3Agent` (stateless) / `V3Workspace` / event log types. |
| `v3/conversation.ts` | `V3Conversation.runTurn()` — vòng lặp turn, append-only EventLog, snapshot/restore, budget check trước mỗi step, critic khi finish. |
| `v3/delegation.ts` | `TaskToolSet` — delegate task cho sub-agent, timeout, nén kết quả về parent (đầu + cuối + marker, mặc định 4.000 ký tự). |
| `v3/critic.ts` | `runCritic` + 4 check có sẵn + `renderCriticInline` (markdown chèn vào chat). |
| `v3/budget.ts` | `V3BudgetMeter` — token/cost (dùng lại `risk/ConversationBudgetMeter`) + thời gian; cảnh báo 70% / 90% / vượt; `formatBudgetMeterLine` cho chat. |
| `v3/llmProfiles.ts` | `LlmProfileStore` — CRUD profile LLM, persist JSON atomic (không chứa API key), `seedFromPresets()`. |
| `v3/modelCommand.ts` | `/model`, `/model list`, `/model <id>`, `/model help` + đăng ký vào `SlashCommandRegistry`. |

## Tool (packages/tools)

`harness_v3_delegate` (giao task cho sub-agent, cần host bind runner),
`harness_v3_budget` (xem meter của conversation hiện tại),
`harness_v3_model` (liệt kê / đổi profile LLM).
Xem `packages/tools/src/harnessV107Tools.ts`. Placeholder trong
`ALL_TOOLS` có `execute` thật (trả hướng dẫn khi chưa bind) — không
có tool placeholder rỗng (bài học v1.00).

## UI (apps/desktop)

- `CriticInlineCard.tsx` — render `CriticReport` thành thẻ inline
  trong chat (✅/⚠️/❌ + từng check).
- `BudgetMeter.tsx` mở rộng thêm prop tùy chọn `elapsedMs` /
  `timeLimitMs` (tương thích ngược) để hiện chiều thời gian của V3.
- i18n: key `harness.v107.*` đủ 6 locale (en/vi/zh/ja/es/fr).

## Cách dùng nhanh

```ts
import { V3Conversation, V3BudgetMeter, LlmProfileStore, handleModelCommand } from '@open-bot/core';

// /model trong chat — xử lý trước khi đưa input vào agent loop:
const res = handleModelCommand(userInput, profileStore);
if (res.handled) { showInChat(res.reply); return; }

// Một turn V3:
const meter = new V3BudgetMeter(convId, { tokenLimit: 100_000, timeLimitMs: 10 * 60_000 });
const conv = new V3Conversation(convId, {
  budget: meter,
  delegateRunner: async (task) => runSubagent(task), // host tự cung cấp
  onEvent: (e) => harness.publishLoopEvent(botId, convId, engine, mapKind(e), e.payload),
});
const out = await conv.runTurn(prompt, llmAgent, workspace);
if (out.criticInline) showInChat(out.criticInline); // critic render inline
if (out.budgetLine) showInChat(out.budgetLine);     // meter render inline
```

## Giới hạn còn lại

- V3 chưa nối vào coordinator/desktop chat thật — mới là lõi +
  tool + UI component rời; coordinator cần một bước nối (host cung
  cấp `V3Agent` từ LLM thật + `V3Workspace` từ tool registry +
  `delegateRunner` từ `AgentRunner.runSubagent`).
- Critic mặc định là check thuần (không gọi LLM); critic bằng LLM là
  một check đăng ký thêm, chưa có sẵn.
- Budget meter đếm token/cost theo usage provider báo + ước lượng
  giá từ bảng `usage/pricing.ts` (model chưa có giá → cost null,
  không báo $0 giả); thời gian là wall-clock của turn.
- Profile không chứa API key — đổi profile sang provider chưa có
  key trong Vault thì turn sẽ lỗi ở provider, không phải ở V3.
