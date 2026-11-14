# Harness scaffold — tài liệu tham chiếu chạy được (v1.04)

File: `packages/core/src/harness/scaffold.ts` — ~90 dòng (64 dòng code +
doc header). Demo chạy được: `tests/harness-scaffold-v104.test.mjs`
(fake model, không provider, không mạng).

## Ý tưởng (từ paper Harness Engineering, arXiv 2609.00006)

Định nghĩa của paper: **agent = model + harness**. Harness là runtime nối
LLM với thế giới qua 7 subsystem: loop, tools, context, safety,
orchestration, extensions, observability. Nhưng khung tối thiểu chỉ cần 3
thứ: **một vòng lặp, một bảng tool, một điều kiện dừng**. Mọi thứ khác là
lớp bổ sung. Scaffold này là khung đó — viết để ĐỌC, không để ship.

## Từng phần của scaffold

| Phần | Dòng | Vai trò |
|---|---|---|
| `ScaffoldMessage` | `{role, content}` | Conversation là một list message. List đó LÀ memory của agent — không có state nào khác. Đây là hạt nhân của subsystem **context** và **observability** (event-sourced conversation của v1.03 chỉ là list này + versioning). |
| `ScaffoldModel` | `(messages) => reply` | Bộ não, inject từ ngoài. Harness không biết model nào đang chạy — đúng hướng đứng của Huy (não = model nào cũng được). Test truyền fake model; production truyền provider call. |
| `ScaffoldTool` | `{name, run}` | Tool là tên + hàm. Không registry, không schema, không permission — scaffold tin tool của nó, và nói rõ điều đó. Subsystem **tools** production (registry có type, approval, sandbox) thay chỗ này. |
| `runScaffoldHarness` | vòng lặp | Hỏi model → chạy tool nó gọi (hoặc dừng khi nó trả lời bằng text) → append kết quả thành message `tool` → lặp lại tới `maxSteps`. Đây là subsystem **loop**. |
| `finishReason` | `final` / `max-steps` / `unknown-tool` | Mọi lối thoát đều có tên. Không có lối thoát âm thầm: tool không tồn tại thì dừng và báo rõ, không tự bịa kết quả. Đây là hạt mầm của **safety** (fail-closed) và **observability** (mọi run đều giải thích được vì sao dừng). |

## Cái gì scaffold KHÔNG có (cố tình) — và nó sống ở đâu trong open-bot

- **Safety**: không approval, không policy, không redaction → `packages/core/src/policy/` (policy-as-config, v1.04) + `packages/core/src/guardrails/` + hook `PreToolUse`.
- **Stuck detection**: model lặp lại cùng tool call mãi thì scaffold chỉ dừng ở `maxSteps` → `packages/core/src/acp/patterns.ts` (P05) + harness v2.
- **Context compaction**: history dài vô hạn → condenser của harness v2 (`packages/core/src/harness/v2/`).
- **Sub-agent**: không spawn agent con → `packages/core/src/subagents/` + hook `SubagentStart/Stop`.
- **Extensions**: không plugin/MCP → `packages/core/src/acp/pluginRuntime.ts` (v1.04) + MCP.
- **Persistence**: không lưu session → `packages/core/src/session/` + `packages/core/src/acp/sessionStore.ts`.

## Dùng để học / thử

```ts
import { runScaffoldHarness } from '@open-bot/core/dist/harness/scaffold.js';

const result = await runScaffoldHarness(
  async (messages) => {
    const last = messages[messages.length - 1];
    if (last.role === 'tool') return { text: `Kết quả là: ${last.content}` };
    return { toolCall: { name: 'add', args: { a: 2, b: 3 } } };
  },
  'Tính 2 + 3',
  { tools: [{ name: 'add', run: (args) => String(Number(args.a) + Number(args.b)) }] },
);
// result.finishReason === 'final', result.finalText === 'Kết quả là: 5'
```

Muốn mở rộng scaffold thành harness thật, thêm theo đúng thứ tự này:
hook PreToolUse → policy → timeout cho tool → compaction → sub-agent.
Mỗi lớp thêm vào đều có test riêng trong `tests/`.
