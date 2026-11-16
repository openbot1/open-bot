# Protocol triad v1.15 — AG-UI 1.0 + A2UI + A2A v1.0 + MCP stateless 2026-07-28

Team T2, sóng v1.15. Chỉ học ý tưởng từ khảo sát
(`docs/repo-survey-v115.md` mục 1); không copy code/text/tài
sản của bất kỳ repo nào. Lớp mới nằm trong
`packages/core/src/protocols/` (xây trên `agui/`, `a2a/`,
`mcp/stateless*` đã có), tools trong
`packages/tools/src/protocolV115Tools.ts`, panel renderer trong
`apps/desktop/src/renderer/protocols/protocolPanelV115.ts`.

## 1. AG-UI 1.0 event stream (`protocols/aguiEvents.ts`)

31 event type, 8 nhóm:

| Nhóm | Số lượng | Event |
|---|---|---|
| lifecycle | 5 | RUN_STARTED, RUN_FINISHED, RUN_ERROR, RUN_CANCELLED, RUN_PAUSED |
| text | 4 | TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT, TEXT_MESSAGE_END, THINKING_CONTENT |
| toolCall | 5 | TOOL_CALL_START, TOOL_CALL_ARGS, TOOL_CALL_END, TOOL_CALL_RESULT, TOOL_CALL_ERROR |
| state | 3 | STATE_SNAPSHOT, STATE_DELTA, MESSAGES_SNAPSHOT |
| interrupt | 4 | INTERRUPT_STARTED, INTERRUPT_RESOLVED, INTERRUPT_CANCELLED, INTERRUPT_TIMEOUT |
| subagent | 3 | SUBAGENT_STARTED, SUBAGENT_FINISHED, SUBAGENT_ERROR |
| generativeUi | 4 | GENERATIVE_UI_START, GENERATIVE_UI_DELTA, GENERATIVE_UI_END, GENERATIVE_UI_RESPONSE |
| custom | 3 | CUSTOM, RAW, ACTIVITY |

`ProtocolAgUiEmitter` (một emitter cho một run):

- `emit(type, data, stepId?)` gán `sequence` đơn điệu theo run,
  timestamp ISO-8601, sanitize payload (cắt chuỗi dài, bỏ key
  dạng secret khỏi state snapshot).
- `stream()` là `AsyncIterable`: consumer `for await` thấy mọi
  event theo thứ tự, kể cả event đã emit trước khi bắt đầu đọc
  (replay từ log), và dừng sau event terminal.
- `finish()` / `fail()` / `cancel()` emit event terminal kèm
  `TokenUsage` `{provider, model, promptTokens,
  completionTokens, totalTokens}` khi provider báo usage.
- Sau event terminal, event mới bị drop và đếm
  (`droppedCount`), không bao giờ chèn sau điểm kết thúc.
- `protocolAgUiToLegacyType()` map 31 type xuống vốn từ 16
  type cũ của `agui/` cho consumer hiện hữu.

## 2. Interrupt-and-resume (`protocols/interrupt.ts`)

`ProtocolInterruptManager.raise(runId, payload, stepId?)` trả về
promise resolve bằng answer của user, reject bằng
`ProtocolInterruptCancelledError` (user hủy) hoặc
`ProtocolInterruptTimeoutError` (hết `timeoutMs`, mặc định
10 phút, tối đa 1 giờ). `resume(id, answer)` /
`cancel(id, reason)` / `resolve(id, outcome, ...)` — lần resolve
đầu thắng, lần sau báo `already-resolved`. `cancelForRun(runId)`
hủy mọi interrupt đang chờ của một run (khi run bị abort).

Payload 3 kind: `approval` (`{approved, note?}`),
`form` (fields `text|number|boolean|choice|secret`, required,
tối đa 32 field), `choice` (tối đa 16 lựa chọn). Payload và
answer đều được validate fail-closed: tên field phải là
identifier an toàn, field dạng secret không được mang default,
answer không được chứa field lạ, field required phải có.
Manager có thể gắn emitter để publish `INTERRUPT_STARTED` /
`RUN_PAUSED` / `INTERRUPT_RESOLVED|CANCELLED|TIMEOUT` lên stream.

## 3. A2UI generative surfaces (`protocols/a2ui.ts`)

Catalog 10 kind: `card`, `form`, `table`, `chart`
(chart-lite: bar/line), `approval`, `options`, `message`,
`progress`, `list`, `detail`.

- `validateA2uiSpec()` là validator JSON-Schema-style viết tay
  (không vendor schema library): giới hạn rows/options/fields/
  points/items, text tối đa 4000 ký tự, action `href` chỉ nhận
  `https://`, ô bảng cấm URL `javascript:`/`data:` — spec là
  DATA ONLY, không HTML/script/handler.
- `negotiateA2uiSpec(spec, capabilities)`: client không render
  được thì fallback — `chart -> table`, `card/table/progress/
  list/detail -> message`; client non-interactive chỉ nhận
  `message`; `form`/`approval`/`options` không có fallback
  (phải trả về cho client khác hoặc không gửi).
- `A2uiSurfaceRegistry`: `register()` (validate + chống trùng
  `componentId` + hẹn giờ hết hạn), `answer()` (validate answer
  theo kind: form theo field, approval theo `actionId`, options
  theo `selectedId(s)`; chặn answer lần 2), `dismiss()`,
  `expire()` / `expireDue()`. Surface emit
  `GENERATIVE_UI_START` / `GENERATIVE_UI_RESPONSE` lên stream
  khi có emitter gắn kèm.

## 4. A2A v1.0 signed Agent Card (`protocols/a2aCard.ts`)

- `buildSignedAgentCard()` xây card bằng `a2a/card.ts`
  (`buildAgentCard`) rồi ký bằng envelope HMAC-SHA256 trên
  canonical JSON của card. **Đây là chữ ký nội bộ, không phải
  PKI**: key là secret chia sẻ trong vault/máy, envelope ghi rõ
  `trust: 'internal-hmac'` — chỉ chứng minh card do bên giữ
  cùng secret phát hành, không chứng minh danh tính với bên
  thứ ba. Muốn tin cậy liên tổ chức, dùng ký Ed25519 có sẵn
  trong `a2a/signing.ts`. `verifySignedAgentCard()` so sánh
  bằng `timingSafeEqual`, hỗ trợ `maxAgeMs` để loại chữ ký cũ.
- `negotiateA2aVersion(clientVersions, serverVersions)`:
  version chung cao nhất thắng, không có version chung thì
  `agreed: null` (không bao giờ đoán mò version).
- 3 binding: `describeA2aBinding()` / `describeAllA2aBindings()`
  mô tả JSON-RPC, gRPC, HTTP+JSON (cùng wire shape tương
  đương). Chỉ JSON-RPC chạy thật ở đây: `A2aJsonRpcServer`
  (loopback 127.0.0.1, `POST /a2a/message` với
  `message/send`/`message/stream`, `GET
  /.well-known/agent-card.json`, `POST /a2a/negotiate`) và
  `sendA2aJsonRpcMessage()` / `fetchSignedAgentCard()` phía
  client. gRPC và HTTP+JSON chỉ ở mức interface (core không
  vendor dependency gRPC; REST shim có thể tái dùng cùng
  handler/payload).

## 5. MCP stateless 2026-07-28 (`protocols/mcpStateless.ts`)

`McpStatelessClientV115` chạy trên một transport
(`McpStatelessTransport`, mặc định `McpHttpTransport` qua
`fetch`):

- `discover()` là bước đầu tiên bắt buộc (`server/discover`);
  mọi method khác đều ném lỗi khi chưa discover.
- Mọi request mang `_meta` = protocol version `2026-07-28` +
  capabilities (`multiRoundTrip`, `tasks`, `apps`). Không bao
  giờ gọi `initialize`, không bao giờ gửi `Mcp-Session-Id`.
- `callToolWithInput()` chạy vòng multi round-trip: server trả
  `input_required` thì hỏi callback `answerInput` rồi retry kèm
  đáp án (`_meta.inputAnswer`), tối đa 5 vòng rồi fail loudly.
- Tasks extension (`StatelessMcpTasks`): `tasks/create`
  (server không hỗ trợ thì báo `supported: false` thay vì nổ),
  `tasks/get`, `tasks/update`, `waitFor()` poll tới trạng
  thái terminal, kèm mirror cục bộ để UI hiển thị tiến độ.
- `LegacyMcpClientAdapter` (**@deprecated**): bọc client cũ
  (`initialize` + session id) sau cùng một bề mặt để server
  tiền-2026 còn chạy được; mỗi lần dùng gọi
  `onDeprecatedUse` đúng một lần để app cảnh báo user nâng
  cấp server. Đường legacy dự kiến xóa theo cửa sổ deprecation
  12 tháng (sớm nhất 28/07/2027 theo khảo sát).

## 6. Tools (`packages/tools/src/protocolV115Tools.ts`)

9 tools, đăng ký qua `ToolRegistry.registerProtocolV115Tools()`
(chưa nối vào `defaultToolFactory` — coordinator nối và đếm
lại pin như lệ với tool v1.10):

| Tool | Ghi chú |
|---|---|
| `protocol_agui_emit` | emit 1 event vào stream của run |
| `protocol_agui_catalog` | 31 type / 8 nhóm (read) |
| `protocol_interrupt_raise` | raise interrupt, block chờ user (needs approval) |
| `protocol_interrupt_resolve` | resume/cancel interrupt |
| `protocol_a2ui_render` | validate + register surface (có negotiate) |
| `protocol_a2ui_answer` | answer surface |
| `protocol_a2a_card` | build + ký HMAC card (cần HMAC key từ host, nếu không sẽ refuse) |
| `protocol_a2a_negotiate` | negotiate version (read) |
| `protocol_mcp_discover` | `server/discover` + list tools (cần transport từ host) |

Host truyền state qua `ProtocolV115ToolOptions`
(`getEmitter`, `getInterruptManager`, `getSurfaceRegistry`,
`getHmacKey`, `getMcpTransport`); thiếu thì tool dùng
instance cục bộ mới (hoặc refuse với card/MCP).

## 7. Renderer panel (`apps/desktop/src/renderer/protocols/protocolPanelV115.ts`)

View model thuần (theo mẫu BudgetMeter: renderer không
value-import `@open-bot/core`): `buildProtocolPanelView()`
parse defensive payload IPC thành run/interrupt/surface/card/
MCP rows + summary; `formatProtocolUsage()` ra dạng
`provider/model: 1,234 tokens`; interrupt sắp timeout (< 60s)
đánh `urgent`. i18n: 15 key `protocols.v115.*` đủ 6 locale
(vi, en, es, fr, ja, zh).

## 8. Test

`tests/protocols-v115.test.mjs` — 32 test, node --test, sau khi
build core + tools. Bao phủ: đếm type/nhóm, emitter + stream,
sanitize, interrupt (round-trip, validate, cancel, timeout,
cancelForRun), A2UI (validate, negotiate, registry), A2A (ký/
verify/giả mạo/stale/negotiate/3 binding/JSON-RPC loopback
thật), MCP (discover/_meta/input loop/giới hạn vòng/Tasks/
legacy adapter), tools (9 tool + registry + refuse khi thiếu
key/transport), panel (parse defensive + summary), i18n 6 locale.

## Giới hạn còn tồn tại

- gRPC và HTTP+JSON binding chỉ ở mức mô tả interface, chưa
  chạy thật (cần dependency/gateway ngoài core).
- Chữ ký HMAC là tin cậy nội bộ, không thay PKI/Ed25519 cho
  liên tổ chức (đã ghi rõ trong envelope + doc).
- `message/stream` của server JSON-RPC hiện trả một result
  duy nhất, ghi chú rõ là non-streaming (chưa có SSE).
- Interrupt timeout tối đa 1 giờ; run chờ user quá lâu vẫn cần
  cơ chế nhắc user ở tầng UI (chưa có).
- Server MCP thật chưa được thử live (test dùng fake transport
  + HTTP transport chỉ kiểm tra constructor); cần thử với
  server MCP 2026-07-28 thật trước khi bật mặc định.
- Tools chưa nối vào `defaultToolFactory` (chờ coordinator).
