# Repo survey v1.35 — 2026-11-18

Nghiên cứu phục vụ sóng v1.35. CHỈ HỌC Ý TƯỞNG — không copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor.

## 1. Memory kiểu Letta / mem0 / Zep — bộ nhớ là một phần của runtime, không phải kho lưu trữ thụ động

- Letta (hậu duệ của MemGPT, bài báo arXiv 2310.08560) coi memory là thành phần của
  agent runtime: các *core memory block* (persona, human, task) luôn nằm trong
  context; agent tự chỉnh sửa chúng bằng tool call (`core_memory_replace`); archival
  memory là vector store để tra cứu khi cần; recall memory giữ toàn bộ lịch sử.
  Ý tưởng cốt lõi: agent tự quản memory của mình thay vì để code bên ngoài ghi đè.
- Sleep-time compute (2025): agent nền tự tổ chức lại memory trong lúc idle — dồn
  các block trùng lặp, trích fact mới từ hội thoại, dọn rác. Memory tốt lên theo
  thời gian mà không tốn lượt tương tác của người dùng.
- mem0 là một layer CRUD gọn: `add/search/update/delete`; LLM trích xuất fact từ
  hội thoại, rồi hợp nhất (thêm mới / cập nhật / xóa / bỏ qua nhiễu); đa scope
  user/agent/session. Số đo công bố (04/2026): LoCoMo ~92,5, LongMemEval ~94,4;
  ~6.900 token/truy vấn so với ~26.000 của cách naive. Bài học: trích fact + hợp
  nhất có chủ đích rẻ hơn nhiều so với nhồi toàn bộ lịch sử vào context.
- Zep/Graphiti dùng temporal knowledge graph: mỗi fact được ghi nhận kèm khoảng
  thời gian nó đúng — fact có thể hết hạn, bị thay thế, và câu trả lời phải tôn
  trọng "đúng vào thời điểm nào".
- **Đem vào open-bot**: T1 memory v16 — core blocks agent tự sửa qua tool
  (persona/human/task) kèm versioning + pinning; sleep-time consolidation chạy
  nền lúc idle; archival recall; extract/fuse kiểu mem0 đa scope
  (user/agent/session); temporal validity kiểu Zep (fact đúng từ khi nào tới khi
  nào). Mục tiêu đo được: recall chính xác hơn, token/query thấp hơn.

## 2. MCP Apps — SEP-1865, extension chính thức đầu tiên của MCP (stable 26/01/2026)

- MCP Apps cho phép server trả về giao diện tương tác (form, bảng, chart,
  dashboard) mà host render trong sandboxed iframe ngay trong cuộc trò chuyện,
  thay vì chỉ trả text. Spec stable 26/01/2026; SDK chính thức
  `@modelcontextprotocol/ext-apps` v2.x (server/react/app-bridge).
- Cơ chế dùng lại 2 primitive sẵn có của MCP: tool khai báo UI trong metadata
  `_meta.ui.resourceUri` trỏ tới resource scheme `ui://`, MIME
  `text/html;profile=mcp-app`; view và host nói chuyện JSON-RPC 2.0 qua
  `postMessage` (gọi lại tool, đọc resource, mở link, post message vào chat).
  Host chịu trách nhiệm xin consent trước khi thực hiện action do UI khởi xướng
  — UI không được tự ý gọi tool có tác dụng phụ.
- Client đã hỗ trợ: Claude (web/desktop/mobile + Cowork), ChatGPT, VS Code
  Copilot, Goose, M365 Copilot. Goose có autovisualiser built-in (tự sinh
  chart/sankey/mermaid/map từ dữ liệu). Có Agent Skills hỗ trợ tạo app mới
  (`create-mcp-app`, `add-app-to-server`, `migrate-oai-app`).
- **Đem vào open-bot**: T3 MCP Apps host v15 — đăng ký resource `ui://`, render
  sandboxed iframe + cầu `postMessage` JSON-RPC, consent cho action do UI khởi
  xướng, auto-visualiser built-in (chart/sankey/mermaid/map, học ý tưởng Goose),
  Agent Skills tạo app mới. Host phải coi UI là code không tin cậy: sandbox +
  consent là bắt buộc, không phải tùy chọn.

## 3. Agent SDKs — hai mẫu orchestration đối lập, chọn đúng chỗ (10/2026)

- Claude Agent SDK (@anthropic-ai/claude-agent-sdk TS 0.3.316, Python 0.2.176):
  agent-as-runtime. *Subagents* (AgentDefinition: description + prompt + danh
  sách tool) chạy trong context riêng, parent giữ toàn quyền kiểm soát và nhận
  kết quả tóm tắt. *Hooks* (PreToolUse/PostToolUse/Stop/SessionStart/SessionEnd)
  chặn và kiểm soát từng bước. Permission modes phân tầng. Session resume/fork.
  Mẫu này hợp với "doer" chạm filesystem: tách biệt context, giới hạn tool,
  parent kiểm soát.
- OpenAI Agents SDK (@openai/agents TS 0.21.0): *handoffs* — chuyển toàn bộ hội
  thoại sang agent chuyên môn dưới dạng tool `transfer_to_*`; *guardrails*
  (input/output/tool, tripwire dừng run, chạy song song hoặc tuần tự); *tracing*
  ghi lại quyết định. Bản cập nhật 04/2026 thêm sandbox execution. Mẫu này hợp
  với "router/talker": chuyển giao mượt, giữ nguyên lịch sử hội thoại.
- Quy tắc chọn rút ra: router/talker → handoffs; doer chạm filesystem →
  subagents. Hai mẫu không loại nhau — một hệ thống tốt dùng cả hai, mỗi mẫu
  đúng chỗ của nó.
- **Đem vào open-bot**: T2 sandbox v3 — học ý tưởng permission modes/hooks của
  Claude Agent SDK + sandbox execution của OpenAI Agents SDK (syscall allowlist
  theo tier, egress policy gate, lifetime cap + auto-stop, snapshot COW,
  pause/resume). T6 fleet v22 — orchestration làm cả hai dạng: subagent
  delegation giữ quyền kiểm soát kiểu Claude + handoff chuyển giao kiểu OpenAI.
  T4 eval harness v3 — guardrails kiểu OpenAI SDK (input/output/tool +
  tripwire) + tracing quyết định, eval kiểu SWE-bench (issue → patch, oracle
  solution, test xác định, regression gates).

## 4. Ghi chú sóng v1.35

- Base: merge/v134 @ 180a54c6, 750.138 dòng TS (đo chuẩn). Mục tiêu merge/v135
  ≥ 780.138 dòng (+30.000).
- 6 đội: T1 memory v16, T2 sandbox v3, T3 MCP Apps host v15, T4 eval harness
  v3, T5 voice v22, T6 fleet v22. Mỗi đội ~+5.200 dòng thật.
- CẢNH BÁO: `packages/core/src/inferenceBrokerV2/voiceV22.ts` là file của
  inference broker, KHÔNG phải voice subsystem — T5 không chạm, không dùng số
  đó làm căn cứ. Voice subsystem thật là `packages/core/src/voiceV21/` (max).
- merge/v134 tip hiện tại có thêm 1 commit 409a63de (fix skills v14) sau base
  180a54c6 — không nằm trong base v135; cycle worker hoà giải lúc land main.
