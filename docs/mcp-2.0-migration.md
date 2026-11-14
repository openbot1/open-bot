# MCP 2.0 — Migration guide (deprecation SEP-2577)

MCP 2.0 (spec 2026-07-28) deprecates sampling, roots, logging và server-initiated elicitation. Các method cũ **vẫn chạy** — không gì bị gỡ trước **2027-07-28** — nhưng code mới không nên dùng chúng nữa.

> Tài liệu này được sinh từ `packages/core/src/mcp/deprecationMigration.ts`
> (`buildDeprecationMigrationMarkdown()`). Sửa guide ở đó rồi sinh lại file này,
> đừng sửa tay — nếu không guide trong code và doc sẽ lệch nhau.

## Tổng quan

| Method | Thay bằng | Ảnh hưởng | Effort |
|---|---|---|---|
| `sampling/createMessage` | Call the LLM API directly, or use MRTR needs_sampling (see mrtr.ts). | server | trung bình |
| `roots/list` | Read the workspace roots from local configuration, or use MRTR needs_roots. | server | nhỏ |
| `roots/subscribe` | Watch the workspace with the host file watcher instead of a roots subscription. | server | nhỏ |
| `notifications/message` | Log to stderr or OpenTelemetry; surface user-visible progress with notifications/progress. | server | nhỏ |
| `logging/setLevel` | Configure the log level in the server configuration / environment. | client | nhỏ |
| `elicitation/create` | Use MRTR needs_elicitation (see mrtr.ts). | server | trung bình |

## `sampling/createMessage`

- **Capability:** `sampling`
- **Deprecated từ:** 2026-07-28 — **gỡ sớm nhất:** 2027-07-28
- **Lý do:** Server-initiated callbacks were removed in MCP 2.0; sampling is now a client-driven MRTR round.
- **Thay bằng:** Call the LLM API directly, or use MRTR needs_sampling (see mrtr.ts).
- **Module thay thế trong open-bot:** mrtr.ts (needs_sampling) + provider trực tiếp
- **Effort:** trung bình

1. **Gọi LLM API trực tiếp từ server** — Server cần completion thì gọi provider đã cấu hình (OpenAI-compatible / Gemini / Ollama local) thay vì nhờ client sampling hộ. Credentials nằm ở server, không đi qua MCP channel.
2. **Hoặc trả MRTR needs_sampling** — Khi server không có key riêng: tool handler trả `{ resultType: "needs_sampling", need: { prompt } }` (xem `mrtr.ts: buildMrtrResult` + `mrtrClient.ts: extractMrtrToolResult`); client nối `onNeedsSampling` vào model của user và gọi lại. Không còn callback giữa chừng.
3. **Bỏ capability sampling khỏi initialize** — Không quảng cáo `sampling` trong capabilities nữa — server nào còn quảng cáo sẽ bị `DeprecationShim` ghi notice mỗi lần kết nối.

## `roots/list`

- **Capability:** `roots`
- **Deprecated từ:** 2026-07-28 — **gỡ sớm nhất:** 2027-07-28
- **Lý do:** Server-initiated callbacks were removed in MCP 2.0; roots are now supplied per request in _meta.
- **Thay bằng:** Read the workspace roots from local configuration, or use MRTR needs_roots.
- **Module thay thế trong open-bot:** mrtr.ts (needs_roots) + config workspace local
- **Effort:** nhỏ

1. **Đọc workspace từ cấu hình local của server** — Server tự biết thư mục làm việc của nó (workspaceDir khi khởi động McpServer) — không cần hỏi client qua roots/list.
2. **Hoặc nhận roots qua MRTR needs_roots** — Khi roots do user chọn lúc chạy: tool handler trả `{ resultType: "needs_roots" }`; client trả danh sách roots ở round tiếp theo (xem `mrtrClient.ts: buildDefaultMrtrHandlers`).
3. **Ghi roots vào _meta của request** — Client stateless có thể kèm roots trong `_meta` của từng request (xem `stateless.ts: StatelessRequestMeta`) thay vì chờ server hỏi.

## `roots/subscribe`

- **Capability:** `roots`
- **Deprecated từ:** 2026-07-28 — **gỡ sớm nhất:** 2027-07-28
- **Lý do:** Server-initiated callbacks were removed in MCP 2.0.
- **Thay bằng:** Watch the workspace with the host file watcher instead of a roots subscription.
- **Module thay thế trong open-bot:** file watcher của host
- **Effort:** nhỏ

1. **Dùng file watcher của host** — Thay subscription qua MCP bằng watcher file hệ thống (chokidar / fs.watch) ở phía host — thay đổi workspace được phát hiện trực tiếp, không qua round-trip MCP.
2. **Bỏ handler roots/subscribe** — Xoá đăng ký handler `roots/subscribe` ở client; server nào còn gửi sẽ nhận -32601 thay vì treo.

## `notifications/message`

- **Capability:** `logging`
- **Deprecated từ:** 2026-07-28 — **gỡ sớm nhất:** 2027-07-28
- **Lý do:** Logging over the MCP channel was deprecated; servers should log out of band.
- **Thay bằng:** Log to stderr or OpenTelemetry; surface user-visible progress with notifications/progress.
- **Module thay thế trong open-bot:** stderr / OpenTelemetry + notifications/progress
- **Effort:** nhỏ

1. **Log ra stderr hoặc OpenTelemetry** — Log vận hành (debug/info) đi ra stderr (stdio server) hoặc OpenTelemetry — không đi qua MCP channel nữa. `McpServer` đã có `onLog` cho việc này.
2. **Tiến độ cho user thì dùng notifications/progress** — Thứ user cần thấy (tiến độ tool dài) gửi qua `notifications/progress` với `progressToken` trong `_meta`, không phải `notifications/message`.

## `logging/setLevel`

- **Capability:** `logging`
- **Deprecated từ:** 2026-07-28 — **gỡ sớm nhất:** 2027-07-28
- **Lý do:** Logging over the MCP channel was deprecated; servers should log out of band.
- **Thay bằng:** Configure the log level in the server configuration / environment.
- **Module thay thế trong open-bot:** cấu hình server / biến môi trường
- **Effort:** nhỏ

1. **Đặt log level ở cấu hình server** — Log level là cấu hình triển khai: đặt trong file cấu hình server hoặc biến môi trường khi khởi động, không điều khiển qua MCP lúc chạy.
2. **Bỏ gọi logging/setLevel sau initialize** — Client không gửi `logging/setLevel` nữa; server giữ level mặc định `info` (xem `McpServer` — `logLevel`) trừ khi cấu hình nói khác.

## `elicitation/create`

- **Capability:** `elicitation`
- **Deprecated từ:** 2026-07-28 — **gỡ sớm nhất:** 2027-07-28
- **Lý do:** Server-initiated elicitation was removed in MCP 2.0; elicitation is now a client-driven MRTR round.
- **Thay bằng:** Use MRTR needs_elicitation (see mrtr.ts).
- **Module thay thế trong open-bot:** mrtr.ts (needs_elicitation) + mrtrClient.ts
- **Effort:** trung bình

1. **Trả MRTR needs_elicitation thay vì callback** — Tool handler cần giá trị từ user thì trả `{ resultType: "needs_elicitation", need: { prompt, schema } }` (xem `mrtr.ts: buildMrtrResult`); client hỏi user ở round tiếp theo qua `onNeedsElicitation` rồi gọi lại. Không còn `elicitation/create` giữa chừng.
2. **Nối elicitation prompt cũ vào MRTR handler** — Hàm hỏi user đã có (`elicitation.ts: ElicitationPrompt`) được nối vào `buildDefaultMrtrHandlers({ onNeedsElicitation })` trong `mrtrClient.ts` — UI hỏi user không đổi, chỉ đường gọi đổi.
3. **Bỏ capability elicitation khỏi initialize** — Không quảng cáo `elicitation` nữa; client chỉ nhận follow-up MRTR khi đã đăng ký handler tương ứng.

## Kiểm tra còn dùng method cũ ở đâu

Server ghi notice qua `DeprecationShim` mỗi khi client quảng cáo capability cũ hoặc gọi method cũ (`server.ts`). Dùng `buildDeprecationReport(shim.getNotices())` để lấy backlog migration: method nào còn dùng, bao nhiêu lần, thay bằng gì.
