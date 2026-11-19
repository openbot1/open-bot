# Repo survey — v1.42 (19/11/2026)

Nghiên cứu chu kỳ v1.42 cho open-bot. **Chỉ học ý tưởng — không copy code, text hay tài sản
của bất kỳ repo nào, của xAI/Cursor.**

Base: `merge/v141` @ `c27d1635` — 955.644 dòng TS, i18n 8.935 key × 6 locale
(en/es/fr/ja/vi/zh), merge/v141 đã gộp đủ 6 đội (memory v26, protocols v10, router
local v118, coding v19, voice v28, fleet v28). Sóng v1.42 làm thế hệ tiếp theo, không
làm lại những thứ đó.

## 1. A2A v1.0.0 (12/03/2026) và v1.0.1 (28/05/2026)

- Agent2Agent Protocol, từ 08/2026 thuộc Agentic AI Foundation (cùng nhà với MCP);
  150+ tổ chức tham gia.
- 3 binding (JSON-RPC, gRPC, HTTP+JSON) chung một model `a2a.proto`.
- Agent Card có chữ ký (signed), multi-tenancy, version negotiation.
- Operations 1.0: `SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`
  (cursor pagination, mới), `CancelTask`, `SubscribeToTask`, `GetExtendedAgentCard`;
  task states có prefix; state mới `input-required`.
- **Bảo mật (Palo Alto Unit 42, 31/10/2025):** agent độc hại qua A2A session có thể
  inject instruction đa lượt, rò rỉ system prompt/tools/history và kích hoạt mua
  hàng trái phép. Kết luận cho open-bot: mọi A2A peer phải qua allowlist + xác thực
  card + sandbox quyền hạn; không để peer đọc system prompt/tools/history của mình;
  hành động nhạy cảm cần xác nhận người dùng.
- Hướng dùng (T1/T6 v1.42): client + server A2A nội bộ theo spec 1.0, peer registry
  + allowlist, guard chống prompt-injection đa lượt, task board điều phối đa agent.

## 2. MCP 2.0 — spec 2026-07-28

- Core stateless hoàn toàn: bỏ initialize handshake và `Mcp-Session-Id`; mọi request
  tự mang protocol version + capabilities trong `_meta`; `server/discover` mới;
  routing headers; cacheable lists.
- Mid-request callbacks (sampling, elicitation, roots) CHẾT, thay bằng Multi
  Round-Trip Requests (SEP-2322): server trả `resultType: "input_required"`,
  client gọi lại với input.
- Tasks thành extension chính thức (`io.modelcontextprotocol/tasks`, poll
  tasks/get); MCP Apps thành extension UI (`io.modelcontextprotocol/ui`, HTML
  trong sandboxed iframe).
- OAuth `iss` validation bắt buộc.
- Roots/Sampling/Logging deprecated, offramp tối thiểu 12 tháng (không bỏ trước
  07/2027). Client 2026-07-28 fallback về handshake khi gặp server 2025-11-25
  trở xuống.
- Hướng dùng (T2 v1.42): core stateless mới, MRTR, Tasks extension, discover,
  fallback handshake server cũ, `iss` validation bắt buộc; không thêm dependency
  vào Roots/Sampling/Logging đã deprecated. (v1.41 đã có protocols v10 stateless
  bước đầu — v1.42 làm thế hệ 2.0 đầy đủ.)

## 3. Memory 2026 — Mem0 v3 + Graphiti 0.30–0.31 + Letta

- Mem0 đổi thuật toán tháng 04/2026: add-only, single-pass extraction (không
  UPDATE/DELETE), entity linking lúc ghi + entity boosting lúc search; SDK
  open-source bỏ graph store (graph chỉ còn trên Mem0 Platform trả phí); có
  upgrade guide v2→v3.
- Graphiti 0.30–0.31 (Zep, Apache-2.0): temporal knowledge graph bi-temporal —
  mỗi fact có `valid_at`, `invalid_at`, `created_at`, `expired_at`; fact đổi thì
  edge cũ đóng bằng `invalid_at` chứ không xóa; episode giữ nguyên làm provenance;
  search kết hợp embedding + BM25 + graph traversal; backend Neo4j/FalkorDB/Neptune
  (Kuzu deprecated).
- Letta: memory block chia sẻ giữa nhiều agent, cập nhật cho tất cả cùng lúc.
- Hướng dùng (T3 v1.42): extraction add-only single-pass, entity linking lúc ghi
  + boosting lúc search, edge bi-temporal, episode provenance, truy vấn time-travel
  ("đúng tại thời điểm X"), shared memory block kiểu Letta. (v1.41 đã có memory
  v26 shared blocks — v1.42 thêm lớp bi-temporal + add-only lên trên.)

## 4. Voice realtime 2026

- OpenAI gpt-realtime-2.1 (06/07/2026, 128k context, 32k output) + 2.1 mini;
  GPT-Live full-duplex GA 10/09/2026 ($0.05/phút, server-driven, tự quyết
  barge-in, context append-only, tool call ủy quyền cho Responses model riêng).
- Gemini 3.8 Live GA 15/09/2026 (131k input, async function calling mặc định,
  proactive audio luôn bật).
- LiveKit Agents 1.0 (04/2025): audio turn detector, adaptive interruption,
  native MCP tool support; cascaded STT-LLM-TTS ~500–800ms, speech-to-speech
  ~300ms.
- Ba kiến trúc: cascaded / turn-based realtime / full-duplex.
- Hướng dùng (T4 v1.42): turn-taking full-duplex — VAD + barge-in, server-driven
  response, context append-only, tool call ủy quyền model text riêng, async
  function calling, proactive audio, ngân sách latency đo được (target <800ms),
  per-minute cost accounting theo giá trên. **Mock-only, không gọi API live thật**
  (như voice v28). (T5 v1.42 cập nhật metadata/config các model realtime này
  cho router, cũng không gọi API live.)

## 5. Ghi chú phạm vi sóng v1.42

- T1 A2A v1.0 (client + server nội bộ, card ký + verify, lifecycle, allowlist,
  guard injection) — mới, khác a2a v097/v100/v107/v109 cũ ở chỗ theo đúng spec
  1.0 (signed card, ListTasks cursor, `input-required`, version negotiation).
- T2 MCP 2.0 stateless core — thế hệ sau protocols v10 của v1.41.
- T3 Memory v27 — bi-temporal + add-only, sau memory v26 của v1.41.
- T4 Voice v29 — full-duplex, sau voice v28 của v1.41.
- T5 Router + provider v29 — refresh model catalog (Gemini 3.x, gpt-realtime-2.1,
  GPT-Live, Gemini 3.8 Live — chỉ metadata/config), routing latency/cost/capability.
- T6 Fleet/UI v29 — A2A task board + peer registry UI + allowlist admin + audit log.
