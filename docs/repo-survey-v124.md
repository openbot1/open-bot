# Nghiên cứu chu kỳ v1.24 — open-bot (03:50 17/11/2026)

## Trạng thái đầu chu kỳ (đã kiểm chứng bằng git + đếm trực tiếp, không đoán)

- **main VẪN = v1.17 `063970db`, 609.892 dòng TS, suite GREEN 8540/8559** (0 fail, 19 skipped).
  Remote GitHub VẪN ở `c8cfcdf` = v1.17 (2/11) — thẻ duyệt gói 3/11 đang chờ,
  KHÔNG đẩy GitHub trong sóng này (cycle worker lo phần đẩy).
- **Chuỗi merge tồn đọng CHƯA lên main** (chưa nhánh nào được xác minh xanh hoàn toàn):
  - merge/v118 `669ec8fb` — 632.936 dòng.
  - merge/v119 `ab551922` (chứa v118 + fix-round).
  - merge/v120 `f6e88679` — 684.914 dòng; worktree có 1 file sửa chưa commit
    (`packages/core/src/composio/toolkitsV120.ts`) — KHÔNG động vào.
  - merge/v121 `9f3878e8` — 677.388 dòng, build cuối xanh nhưng chưa có kết quả full suite.
  - merge/v122 `6ff3e255` — 677.405 dòng, đủ 6 đội, coordinator v1.22 vẫn đang xác minh.
  - merge/v123 `4437393e` — **684.986 dòng, stack xa nhất đã hợp nhất**
    (v118+v119+v120 + survey v123) → **BASE của sóng v1.24**.
- Coordinator đang chạy: v1.19, v1.20 (lần 3), v1.22, v1.23. Không có coordinator
  v1.24 → chu kỳ này cử mới theo lệnh Huy 13/11 (mỗi chu kỳ đều cử sóng, chạy song
  song trên nhánh/worktree riêng, không chờ sóng trước).
- **CẢNH BÁO PHÂN KỲ (ghi rõ, không giấu):** các stack song song chứa bản triển khai
  khác nhau của cùng số phiên bản (v120 và v121 đều có memory v19 / protocols v4 /
  coding v12 / Composio v5 / fleet v17 nhưng nội dung khác; v122/v123 đang xây
  memory v20–v21, protocols v5–v6, coding v13–v14, voice v19–v20, fleet v18–v19
  trong nhánh đội chưa gộp). Sóng v1.24 CHỈ xây tiếp trên merge/v123 với số phiên
  bản MỚI (memory v22, protocols v7, coding v15, Composio v7, voice v21, fleet v20),
  KHÔNG gộp hay hòa giải các stack cũ — việc hòa giải là của sóng hợp nhất riêng sau.

## Nghiên cứu chu kỳ (~15 phút, chỉ học ý tưởng, KHÔNG copy code/text/tài sản)

### 1. MCP spec 2026-07-28 — stateless core + extensions (đã kiểm chứng qua tìm kiếm 17/11)

- Core stateless: bỏ handshake `initialize` và header `Mcp-Session-Id`; mỗi request
  mang protocol version + capabilities trong `_meta`; thêm `server/discover` bắt buộc
  phía server; `subscriptions/listen` thay HTTP GET endpoint và `resources/subscribe`.
- Server-initiated requests bị xóa: elicitation / sampling / roots chuyển sang
  **Multi Round-Trip Requests (MRTR)** — server trả `InputRequiredResult`, client
  retry request gốc kèm đáp án. **Roots, Sampling, Logging bị deprecated** — vẫn chạy
  tối thiểu 12 tháng theo deprecation policy bằng văn bản (SEP-2596), nhưng code mới
  KHÔNG nên dùng.
- Extensions thành cơ chế chính thức, mỗi extension có identifier riêng, hai bên phải
  quảng bá hỗ trợ trong capabilities: **Tasks** (`io.modelcontextprotocol/tasks`,
  long-running: tool trả handle, client poll `tasks/get`, `tasks/update` giữa chừng,
  `tasks/cancel` hợp tác), **MCP Apps** (`io.modelcontextprotocol/ui`, extension chính
  thức đầu tiên, SEP-1865, Stable 2026-01-26, UI `ui://` render trong sandboxed iframe),
  **Skills** (`io.modelcontextprotocol/skills`, SEP-2640, Final 2026-09-13).
- Stewardship: Agentic AI Foundation (AAIF) dưới Linux Foundation từ 12/2025.
  **Ruby SDK lên Tier 1 (30/10/2026)** — Tier 1 giờ: TypeScript, Python, C#, Go, Rust, Ruby.
  Lịch release mới theo SEP-3398 (chấp nhận 2026-10-14): chu kỳ tháng 3 + tháng 9,
  bản tiếp theo dời sang **2027-03-30**. MCP Registry (preview) đã liệt kê >47.000
  server đang hoạt động (10/2026).
- **Draft extension `io.modelcontextprotocol/files` (10/11/2026, experimental, CHƯA có
  reference implementation):** đọc/ghi file qua extension — open-bot chỉ làm mock +
  contract test theo draft, ghi rõ là draft, không giả vờ có ref impl.
- Áp cho open-bot (T2 protocols v7): MCP Tasks client đầy đủ (handle + poll + streaming
  progress + cancel), Files extension mock + contract test, ghi chú tương thích MCP 2.x
  SDK (stateless, `server/discover`, MRTR), A2A v1.1 two-way streaming thật qua SSE.

### 2. OpenHands v1.40.0 + Agent Canvas + SDK (đã kiểm chứng qua tìm kiếm 17/11)

- **OpenHands 1.40.0 phát hành 12/11/2026** (feat: cải thiện hướng dẫn xác thực Codex
  subscription; fix chat giữ message ở ranh giới trang history, chống delayed echo
  xóa draft mới). Agent Canvas là GUI tự host (npm `@openhands/agent-canvas`, chạy
  OpenHands/Claude Code/Codex/Gemini/Pi/OpenCode hoặc bất kỳ agent ACP nào, local/remote/
  cloud backend, Docker sandbox tùy chọn hoặc git worktree riêng mỗi conversation).
  **~93.341 GitHub stars (12/11/2026).** Nhịp release rất nhanh: 29 bản Canvas + 33 bản
  SDK trong 90 ngày (08–10/2026); SDK giữ deadline gỡ API đã công bố (5 minor release).
- **BÀI HỌC BẢO MẬT — CVE-2026-112346 (CVSS 9.8):** sandbox server không xác thực trong
  SDK workspace < 1.52.0, công bố bởi VulnCheck, không tìm thấy advisory chính thức
  của OpenHands. Từ 1.52.0, DockerWorkspace ports bind loopback. Áp cho open-bot
  (T6 fleet v20): **mọi sandbox server phải xác thực** — token/bearer + bind loopback
  mặc định, không bao giờ expose sandbox server không auth, kể cả trên localhost;
  viết regression test cho đúng lỗi này.
- Snowflake Cortex RL training ngay trong harness (03/11/2026, theo brief chu kỳ —
  chưa kiểm chứng độc lập trong lượt này): ý tưởng học theo là vòng train–đánh giá
  khép kín trong harness (reward từ test suite thật), không phải copy pipeline.

### 3. Anthropic — inline-tools beta, message threads beta, gỡ sampling knobs (theo brief chu kỳ)

- **Inline-tools beta + message threads beta (02/11/2026):** threads cho hội thoại
  dài có trạng thái phía server; inline-tools cho tool definition gọn trong message.
  Áp cho open-bot: thread store local tương đương (không dùng server Anthropic),
  inline tool schema nén — T3 coding v15 dùng ý này cho tool-call compression v2.
- **Sampling knobs bị gỡ (API 2026-10-21); forced `tool_choice` bị gỡ trên
  Fable/Mythos 5.1, Opus/Sonnet 5.5:** provider mới KHÔNG được phụ thuộc vào các knob
  này; router/model layer phải coi chúng là không tồn tại. Ghi chú tương thích vào
  protocols v7 (T2) và coding v15 (T3).

### 4. XERJ + MCPtoCodeMode — code-graph search + tiết kiệm token (theo brief chu kỳ)

- **XERJ (~19k stars):** local search engine + MCP server — lập chỉ mục code local,
  truy vấn qua MCP. **MCPtoCodeMode:** giảm token khi gọi tool. Ý tưởng học theo
  (không copy): repo map v6 kiểu XERJ cho T3 — BM25 + vector local + hybrid,
  code-graph query (`get_neighbors`, `shortest_path`), và nén tool-call để tiết kiệm
  token thật (đo bằng test, không khoe số không đo được).

### 5. Kiểm toán v1.16 — bài học áp vào code MỚI (không sửa trùng fix/audit-v116)

- 28/30 finding CONFIRMED, đang được sửa trên nhánh `fix/audit-v116` — sóng v1.24
  KHÔNG sửa trùng. Nhưng code mới PHẢI áp dụng bài học ngay từ đầu:
  - **OB-005:** CodeAct v8 chạy quyền host → mọi thực thi code mới phải qua bwrap
    sandbox (BotBoxManager có sẵn), không chạy trực tiếp quyền host.
  - **OB-006:** path lexical không chống symlink → mọi resolve path mới phải dùng
    `resolveWithin` + `realpath` (đã có sẵn trong repo).
  - OB-002 (PDF.js CVE, `isEvalSupported:false`), OB-003 (SheetJS), OB-007 (refactor
    không hash pin): không đưa thêm dependency có CVE đã biết vào code mới; pin +
    hash mọi refactor/migration.
- Triage đầy đủ: `~/workspace/goals/large-software-recreation-with-rea/hidden_files/audit-v116-triage.md`.

## Hướng xây sóng v1.24 (base merge/v123 `4437393e`, 684.986 dòng)

| Đội | Hệ thống | Số phiên bản mới |
|-----|----------|------------------|
| T1 | memory | v22: consolidation v2 (LLM hook thật khi có key + embedding thật qua Ollama local), temporal KG v2, memory sharing v2 có phân quyền, eval LoCoMo + FrontierMemory mở rộng |
| T2 | protocols | v7: MCP Tasks (handle bất đồng bộ + streaming progress), MCP Files extension draft (mock + contract test), MCP 2.x SDK compat notes, A2A v1.1 two-way streaming thật qua SSE |
| T3 | coding agent | v15: repo map v6 kiểu XERJ (BM25+vector+hybrid local, code-graph query/get_neighbors/shortest_path), tool-call compression v2, skill library v3, eval harness v3 (Harbor-format tasks) |
| T4 | Composio | v7: polling v8, trigger instances v4, toolkit mock mới (dựa trên catalog thật của Composio, không bịa toolkit), OAuth refresh v5, webhook v4 có chữ ký xác thực, usage metering v3 + quota enforcement |
| T5 | voice | v21: realtime v3 (VAD Silero-style mock có thể thay engine thật, barge-in v3, turn-taking v3), S2S WebSocket thật (kết nối được khi có key, mock khi không), voice cloning consent v2, tóm tắt hội thoại v2 |
| T6 | platform/fleet + plugin SDK | v20: multi-tenant v4, scheduler bin-packing v2, sandbox server xác thực (bài học CVE-2026-112346), plugin marketplace v5, admin panels v6, audit export v2 |

- Mục tiêu chu kỳ: **+30.000 dòng TS thật** (code + test + i18n cho tính năng thật;
  KHÔNG độn dòng, KHÔNG code copy, KHÔNG filler). Báo số thật nếu dưới mục tiêu +
  đúng nút thắt (máy chỉ 1,5 CPU; nhiều sóng chạy song song).
- Quy ước: chỉ tạo module/file versioned MỚI, không sửa module của đội sóng v123,
  không rename file cũ; test cho mọi tính năng (`tests/*.test.mjs`); i18n đủ 6 locale
  (`apps/desktop/src/renderer/i18n/locales/`); re-pin mọi số đếm theo số đo trực tiếp
  sau mỗi lần gộp; build lại sau MỖI lần gộp rồi mới chạy suite.
- Giới hạn đứng: live ảnh Gemini KHÔNG thử lại (key miễn phí quota ảnh = 0); KHÔNG
  dữ liệu X; KHÔNG Grok Imagine; KHÔNG cloud VM/tài khoản/thanh toán; local-first.
