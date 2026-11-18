# Protocols v1.20 — Team T2 (protocols v4)

> Nguồn: mô tả công khai của các spec (không copy code/text/tài sản của bất
> kỳ repo nào — chỉ học ý tưởng). Các ngày + số liệu dưới đây là thời điểm
> sóng v1.20 (16/11/2026); spec có thể đổi sau đó.

## 1. Version matrix (protocols v4)

| Family | Current | Legacy | Ghi chú |
|---|---|---|---|
| Poppy (Personal Agent Protocol) | 1.0 | 0.2, 0.1 (draft) | `/.well-known/poppy.json`, `poppy:read` / `poppy:write`, opaque user id, signed-assertion session. 1.0 được báo cáo 13/11/2026. |
| MCP | 2026-07-28 | 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05 | Sampling / roots / logging deprecated (SEP-2577); gỡ sớm nhất ở revision đầu tiên từ 2027-07-28. |
| A2A | 1.1-rc | 1.0 (stable 1.0.1) | 1.1 vẫn là RC (tag 29/10/2026). `SendLiveMessage` là opt-in, không mặc định. 0.3/0.2 đã gỡ. |
| AG-UI | 1.0 | 0.0.1 | 31 event type, `THINKING_*` đã gỡ, thay bằng `REASONING_*`. |
| A2UI | 1.0 | 0.1 | |

Module: `packages/core/src/protocolsV4/versions.ts` (đàm phán + lịch deprecation),
`poppyV4.ts` (profile exchange giữa các personal agent).

## 2. A2A v1.1 RC — SendLiveMessage live session

Module: `packages/core/src/protocolsV4/a2aLiveV4.ts`, xây trên
`protocolsV3/a2aTwoWayV3.ts` (không viết lại frame/window/ack).

- Đàm phán: live session chỉ mở khi peer nói `1.1-rc`/`1.1` **và** advertise
  `liveStreaming`. Peer 1.0/1.0.1 vẫn làm task thường qua `SendStreamingMessage`.
- `message/sendLive` (JSON-RPC): envelope + validator (`buildSendLiveRequest`,
  `parseSendLiveRequest`).
- Client-written artifacts (v1.1): client được ghi artifact giữa task
  (frame `artifact` chiều lên, agent nhận qua `onClientArtifact`).
- Backpressure: cửa sổ gửi v3 + ngưỡng session (high/low water). Quá ngưỡng
  thì frame xếp hàng, không drop; `onBackpressure` báo 1 lần khi bắt đầu và
  1 lần khi xả xong.
- `generation` + coherent history: mỗi status/message/artifact mang
  generation; reconnect tăng generation (đặt hàng / optimistic concurrency);
  `history()` trả một timeline duy nhất theo (generation, sequence).
- Resume token `live:<taskId>:<generation>:<sequence>` cho kiểu resume
  `SubscribeToTask` (GET binding ở 1.1); `resume()` gửi lại frame chưa ack,
  peer drop trùng theo sequence.

## 3. MCP sampling — dọn dẹp (không gỡ handler cũ)

Module: `packages/core/src/protocolsV4/mcpSamplingV4.ts`, xây trên
`mcp/deprecation.ts` + `mcp/clientDeprecation.ts` + `protocolsV3/mrtrV3.ts`.

**Đính chính quan trọng so với brief sóng:** brief nói "thay sampling bằng
elicitation/roots" — nhưng theo SEP-2577 thì **roots cũng deprecated**, và
callback cũ `elicitation/create` **cũng deprecated**. Chỉ còn đúng:
elicitation dạng MRTR round (`needs_elicitation` / `input_required`, SEP-2322).
Bảng thay thế đúng:

| Cũ (deprecated 2026-07-28) | Thay bằng |
|---|---|
| `sampling/createMessage` | Server tự gọi LLM API trực tiếp; hoặc vòng MRTR `input_required` hỏi người dùng khi thật sự cần câu trả lời của người |
| `roots/list` | Đọc roots từ config local, hoặc nhận per-request trong `_meta` |
| `roots/subscribe` | Host file watcher |
| `notifications/message`, `logging/setLevel` | stderr / OpenTelemetry; tiến độ cho user dùng `notifications/progress` |
| `elicitation/create` | MRTR `needs_elicitation` / `input_required` (elicitation không bị deprecated — chỉ shape callback cũ bị) |

Công cụ trong module:

- `auditMcpSurfaceV4({ methods, capabilities })` — quét surface còn sót,
  trả finding kèm replacement + ngày gỡ (`2027-07-28`).
- `stripDeprecatedCapabilitiesV4(caps)` — build capability object cho client
  mới, không còn sampling/roots/logging (opt-in, không ép peer cũ).
- `McpSamplingV4MigrationGuard` — bọc handler sampling cũ: warn mode
  (mặc định) cảnh báo đúng 1 lần + đếm; strict mode từ chối kèm replacement
  để tìm hết caller trước hạn gỡ.
- `buildElicitationReplacementV4(shape)` — sampling-shape có câu hỏi cho
  người → vòng `input_required`; sampling chỉ muốn model output → từ chối
  và bảo gọi provider trực tiếp (không bịa câu hỏi cho user).

Handler legacy vẫn chạy tới hạn 2027-07-28 như spec hứa — module này không
xóa chúng.

## 4. AG-UI 1.0 conformance — phát hiện thật

Module: `packages/core/src/protocolsV4/aguiConformanceV4.ts`. Spec 1.0
(`docs/spec/1.0/schema.json`, commit `89cedd3f…`, kiểm chứng 16/11/2026 qua
schema audit công khai): **31 event type**, 8 family — run 5
(`RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`, `STEP_STARTED`, `STEP_FINISHED`),
text 4 (…`TEXT_MESSAGE_CHUNK`), tool 5 (…`TOOL_CALL_CHUNK`), state 3,
reasoning 7 (`REASONING_START`, `REASONING_MESSAGE_START/CONTENT/END/CHUNK`,
`REASONING_END`, `REASONING_ENCRYPTED_VALUE`), activity 2
(`ACTIVITY_SNAPSHOT`, `ACTIVITY_DELTA`), raw/custom 2 (`CUSTOM`, `RAW`),
subagents 3.

**Vocabulary của open-bot (`protocols/aguiEvents.ts`) cũng 31 type nhưng là
31 type KHÁC: chỉ 18 trùng với spec.**

- Thiếu 13 type của spec: `STEP_STARTED`, `STEP_FINISHED`,
  `TEXT_MESSAGE_CHUNK`, `TOOL_CALL_CHUNK`, toàn bộ 7 `REASONING_*`,
  `ACTIVITY_SNAPSHOT`, `ACTIVITY_DELTA`.
- Thừa 13 type ngoài spec: `THINKING_CONTENT`, `RUN_CANCELLED`,
  `RUN_PAUSED`, `TOOL_CALL_ERROR`, 4 `INTERRUPT_*`, 4 `GENERATIVE_UI_*`,
  `ACTIVITY`.
- Không có `RUN_CANCELLED` trong spec: hủy = `RUN_FINISHED` outcome
  `cancelled`. Không có event interrupt: tạm dừng = `RUN_FINISHED`
  outcome `interrupt`. Không có `TOOL_CALL_ERROR`: lỗi = `TOOL_CALL_RESULT`
  status error. `THINKING_*` là SDK-only, không nằm trong schema 1.0.

Module v4 cung cấp: bảng gap tính runtime từ vocabulary thật
(`agUiV4ConformanceReport()`), builder + validator cho 13 type còn thiếu
(`makeAgUiV4SpecEvent`, `validateAgUiV4SpecEvent`), stream checker
(`checkAgUiV4Stream`: `RUN_STARTED` đầu, đúng 1 terminal và ở cuối, mọi
start phải đóng trước terminal, sequence tăng đều không gap, không
`THINKING_*`, `RUN_FINISHED` luôn có outcome), và translator
(`translateOpenBotEventToSpecV4`: `THINKING_CONTENT` chỉ dịch sang
`REASONING_MESSAGE_CONTENT` khi host opt-in — reasoning mặc định là riêng
tư; `GENERATIVE_UI_*` → `CUSTOM` extension).

Vocabulary cũ không bị sửa (consumer hiện tại còn dùng); conformance là
lớp phủ, không phải breaking change.

## 5. IETF Agent Communication Protocols WG — watch-track

Module: `packages/core/src/protocolsV4/ietfWatchV4.ts`. Không có wire
protocol nào để implement lúc này — chỉ theo dõi.

- WG `agentproto`, charter được IESG duyệt **08/10/2026**, chairs Orie
  Steele + Leslie Daigle. Scope: common baseline agentic dialog management
  protocol + reference architecture; **không** thay MCP/A2A, **không** định
  nghĩa transport mới. Dialog protocol định nghĩa: dialog identifiers,
  lifecycle semantics, propagation of dialog context, với binding mang
  context đó trên các protocol IETF sẵn có. Ba khối chức năng: dialog
  management, authorization + delegation, identity management. Dialog
  context = identifiers + lifecycle state — **không** phải LLM context
  (không memory, document, prompt). Model implementation / reasoning /
  planning / UI / audit nằm ngoài scope theo charter.
- Milestone: adopt use-cases draft 12/2026 → architecture draft 02/2027 →
  dialog-management draft (proposed standard) 03/2027 → trình IESG 03/2028.
- Draft cá nhân đang chạy (chưa phải WG adoption): use-cases rev -04
  (15/10/2026), `draft-manyfolks-agentproto-arch-00` (30/10/2026, hết hạn
  03/05/2027). WG anh em DAWN (discovery) charter 22/10/2026.
- Readiness của open-bot (tự đánh giá, xem `ietfV4ReadinessReport()`):
  ready 2 (dialog lifecycle semantics, identity management), partial 3
  (dialog identifiers, context propagation, authorization/delegation),
  watch 3 (bindings, discovery/DAWN, out-of-scope). Việc cần làm ở mỗi
  milestone ghi trong `IETF_V4_AGENTPROTO_MILESTONES[].openBotAction` —
  prototype envelope dialog-context chỉ sau khi draft 03/2027 ra, không làm
  trước.

## 6. Không làm

- UCP / AP2 / x402 thanh toán: Huy đã bỏ payments — không đụng.
- Không sửa file protocol cũ (`protocols/`, `protocolsV2/`, `protocolsV3/`,
  `mcp/`, `a2a/`, `agui/`): v4 chỉ thêm file mới + 1 dòng export ở
  `packages/core/src/index.ts`.

## 7. Test + i18n

- Test: `tests/protocols-v120-a2a-live.test.mjs`,
  `tests/protocols-v120-mcp-sampling.test.mjs`,
  `tests/protocols-v120-agui-conformance.test.mjs`,
  `tests/protocols-v120-ietf-watch.test.mjs`,
  `tests/protocols-v120-i18n.test.mjs` (chạy sau khi build core).
- i18n: 17 key `protocols.v120.*`, đủ 6 locale (en/vi/es/fr/ja/zh),
  placeholder khớp en.
