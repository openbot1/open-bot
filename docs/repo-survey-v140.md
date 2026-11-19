# Repo survey v140 — nghiên cứu 18/11/2026 (chu kỳ 19:01)

CHỈ HỌC Ý TƯỞNG, không copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor.
Nguồn: tìm kiếm web ngày 18/11/2026 (xem link cuối file).
Dành cho sóng v1.40 (base merge/v139 @ 70f36562, 902.896 dòng TS).

## 1. OpenHands V1 SDK — 4 package tách rời, agent vòng lặp tối giản (T3, T4)

- **Kiến trúc V1 (paper arXiv 2511.03690, MLSys 2026)**: 4 package tách rời —
  `openhands.sdk` (core abstractions), `openhands.tools` (tool implementations),
  `openhands.workspace` (local/remote sandbox), `openhands.agent_server`
  (REST/WebSocket). V0 có AgentController + Runtime riêng; V1 gộp thành
  Conversation + Workspace vì controller "không đáng công giữ".
- **Vòng lặp tối giản**: Agent stateless, chỉ emit Action; Conversation chạy loop
  và giữ append-only EventLog (event-sourcing, replay xác định); Workspace thực
  thi Action và trả Observation; LLM qua LiteLLM (100+ provider).
- **CodeActAgent**: agent mặc định — thay vì hàng chục tool JSON hẹp, agent viết
  code bash/Python + browser DSL rồi chạy. Một công cụ "chạy code" thay cả họ
  tool rời rạc; đổi lại cần sandbox + risk scoring mạnh.
- **RouterLLM**: lớp trừu tượng chọn model theo message — vd route message có
  ảnh sang model đa phương thức, text thuần sang model rẻ; router lồng được
  (router trỏ tới router) thành cây tối ưu chi phí.
- **LLMSecurityAnalyzer**: mỗi Action được chấm `SecurityRisk ∈ {LOW, MEDIUM,
  HIGH, UNKNOWN}`; mặc định LLM tự chấm inline qua field `security_risk` trong
  JSON schema của tool (không tốn thêm call), MCP tool annotations
  (`readOnlyHint`, `destructiveHint`) làm đầu vào. **Confirmation policy**:
  `AlwaysConfirm` / `NeverConfirm` / `ConfirmRisky(threshold=HIGH)` — action
  nguy hiểm pause conversation ở trạng thái `WAITING_FOR_CONFIRMATION` chờ user.
- **Verification mới là nút thắt (2026)**: V1 giảm lỗi do hệ thống so với V0
  với overhead event-sourcing không đáng kể; SWE-Bench Verified ~72,8% với
  Claude Sonnet 4.5. Bài học: đầu tư vào chấm điểm trajectory + review trước
  khi push, không chỉ thêm tool.
- Ý tưởng cho T3: RouterLLM giữa cuộc trò chuyện (leo/hạ model theo nội dung),
  risk scoring LOW/MEDIUM/HIGH/UNKNOWN cho mỗi tool call + pause xác nhận khi
  HIGH, log đầy đủ quyết định. Ý tưởng cho T4: verification stack — critic
  chấm trajectory trước push, code-review skill trên mỗi PR/diff.
- Ý tưởng LOẠI: Agent Server REST/WebSocket công khai ra ngoài — open-bot là
  local-first, loopback-only; không mở server ra internet (theo hướng đứng).

## 2. Letta — sleep-time agents + memory blocks chia sẻ (T1)

- **Memory blocks**: core memory render thẳng vào prompt dưới dạng
  `<memory_blocks>`; block có label + mô tả + giá trị, vd `human` (về user),
  `persona` (vai trò agent). v0.16.7 (03/2026) bỏ giới hạn kích thước block,
  context 128K. Block có thể attach/detach, **chia sẻ giữa các agent hoặc
  đánh dấu read-only** (Conversations API 01/2026: nhiều agent song song chia
  sẻ block, giữ hiểu biết chung nhất quán).
- **Sleep-time agent** (`sleeptime_agent`): chạy nền khi agent rảnh — tổ chức
  lại memory, học từ tương tác gần đây, cải thiện phản hồi sau. Primary agent
  xử lý user + tool + retrieval, KHÔNG tự sửa core memory; sleep-time agent
  sửa block ngoài vòng lặp chính, có thể dùng model khác, tần suất cấu hình
  được (sau N bước hoặc khi context bị compact). Paper "Sleep-time Compute"
  (04/2025) báo cáo cải thiện Pareto chất lượng/chi phí trên AIME, GSM.
- **Letta Code 2026**: chuyển sang git-backed memory ("MemFS") — skill là file
  Markdown version được bằng git, chia sẻ được; sleep-time chuyển từ server
  sang client-side subagent dùng chung computer/context.
- Ý tưởng cho T1: sleep-time consolidation agent (chạy nền sau N bước, tổng
  hợp trò chuyện thành memory, cập nhật block ngoài vòng lặp chính) + memory
  blocks chia sẻ giữa các bot (shared/read-only) + contradiction invalidation
  qua LLM judge (sleep pass làm sạch record bị mâu thuẫn).
- Ý tưởng LOẠI: Letta server/hosted (stateful agents as a service, trả phí
  theo agent) — trái local-first, miễn phí.

## 3. Zep / Graphiti — bi-temporal knowledge graph (T1)

- **Bi-temporal = 2 trục thời gian cho mỗi fact**: valid time (fact đúng trong
  thế giới thực từ khi nào tới khi nào) và transaction/ingestion time (hệ
  thống biết fact khi nào, từ episode nguồn nào). Graphiti (~30k stars,
  Apache-2.0) lưu 4 timestamp mỗi edge: `valid_at`, `invalid_at`,
  `created_at`, `expired_at`.
- **Supersede thay vì xóa**: fact mới mâu thuẫn fact cũ → đóng khoảng hiệu lực
  của fact cũ (set `invalid_at`/`expired_at`), KHÔNG xóa — lịch sử còn nguyên
  để audit. Truy vấn "đúng tại thời điểm X" lọc edge có cửa sổ valid chứa X;
  truy vấn "hiện tại" lọc cửa sổ còn mở.
- **Quy trình**: episode (text/message/JSON + reference time) → LLM trích
  entity + fact → resolve với graph đã có → đóng fact bị mâu thuẫn. Retrieval
  hybrid: semantic + BM25 + graph traversal, không cần LLM call lúc query.
  Thoughtworks Radar 04/2026 đưa Graphiti lên Trial; benchmark báo cáo +18,5%
  accuracy, −90% latency (con số của vendor, tham khảo).
- Ý tưởng cho T1: fact edges bi-temporal (valid time + transaction time,
  supersede đóng khoảng hiệu lực thay vì xóa, query "đúng tại thời điểm X").
- Ý tưởng LOẠI: Neo4j làm backend bắt buộc — open-bot giữ store local nhẹ
  (JSON/SQLite local), không bắt user chạy database server.

## 4. Mem0 — consolidation extract → judge (T1)

- **Pipeline**: add memory → extract fact → LLM judge quyết định
  ADD / UPDATE / DELETE / NOISE cho từng fact so với memory hiện có. Dream
  memory consolidation (Pro/Enterprise) chạy nền tương tự sleep-time.
- **Temporal**: mỗi memory có `created_at`/`updated_at`, custom timestamp khi
  add; event time lấy từ timestamp nguồn.
- Ý tưởng cho T1: judge ADD/UPDATE/DELETE/NOISE trong sleep-time pass; giữ
  nguyên tắc "không xóa vật lý, chỉ đóng hiệu lực" của Graphiti cho fact cũ.

## 5. Giao thức agent 2026: MCP, A2A, ACP — 3 tầng bổ sung nhau (T2)

- **MCP** (Anthropic 11/2024 → Linux Foundation/AAIF 12/2025): agent ↔ tool/
  data. JSON-RPC 2.0, stdio local hoặc Streamable HTTP remote. MCP Apps (xem
  survey v139) cho tool trả UI.
- **A2A** (Google 04/2025 → Linux Foundation, v1.0 năm 2026): agent ↔ agent.
  Mỗi agent công bố **Agent Card** (JSON tại well-known URL); client đọc card
  rồi quyết định delegate task; task lifecycle + message + artifact exchange,
  streaming. A2A hấp thụ ACP (IBM/BeeAI) tháng 08/2025.
- **ACP có 2 nghĩa khác nhau — cẩn thận khi đọc tài liệu**:
  - Agent Communication Protocol (IBM/BeeAI, 03/2025): agent ↔ agent qua REST;
    **đã merge vào A2A, spec lưu trữ, không dùng mới**.
  - Agent Client Protocol (Zed, 08/2025, đồng duy trì với JetBrains):
    client/editor ↔ coding agent; OpenHands Agent Canvas dùng ACP để chạy
    Claude Code / Codex / Gemini CLI qua login sẵn trên máy — đúng mô hình
    auto-detect CLI của open-bot.
  - Agentic Commerce Protocol (Stripe + OpenAI, 2025): agent ↔ thanh toán;
    **LOẠI — Huy bỏ thanh toán/cloud accounts**.
- Ý tưởng cho T2: MCP Apps v2 + ACP (Agent Client Protocol) agent sessions
  (map session, resume/cancel — chạy CLI agent có sẵn qua login của user) +
  A2A protocol (agent-to-agent task delegation, message + artifact exchange).
- Ý tưởng LOẠI: Agentic Commerce Protocol / thanh toán; A2A cross-org qua
  internet công khai (chỉ làm A2A local/loopback + card discovery nội bộ).

## 6. Large Codebase SDK + verification stack (T4)

- **Large codebase**: map dependency toàn hệ thống, sắp xếp thứ tự sửa để
  nhiều agent làm song song không xung đột — chia repo thành vùng sở hữu
  (ownership zones) theo đồ thị phụ thuộc; agent chỉ sửa trong vùng của mình
  hoặc theo thứ tự topo đã định.
- **Verification stack 2026**: critic model chấm trajectory (điểm + chặn khi
  thấp) trước khi push; code-review skill tự động chạy trên mỗi PR/diff
  (kiểm tra style, lỗi thường gặp, test thiếu); eval harness chạy verifier
  mới trên cùng task để so sánh.
- Ý tưởng cho T4: dependency map (đồ thị phụ thuộc, thứ tự sửa, vùng sở hữu)
  + critic chấm trajectory + review skill + eval harness mở rộng 3 verifier.

## 7. Voice realtime v2 + fleet campaigns (T5, T6)

- **Barge-in / turn-taking**: voice agent phải phát hiện user ngắt lời
  (barge-in) và dừng nói ngay; VAD tuning quyết định độ nhạy im lặng/kết
  thúc lượt; multi-voice personas — chọn và ghi nhớ giọng theo bot.
- **Fleet campaigns**: chạy hàng loạt bot nền theo campaign, theo dõi tiến độ
  từng bot, tổng hợp kết quả; automation templates theo lịch — mẫu gợi ý theo
  repo/bot (vd template "review PR mỗi sáng", "tổng hợp memory mỗi đêm").
- Ý tưởng cho T5: barge-in, turn-taking + VAD tuning, multi-voice personas,
  xác nhận trạng thái phiên bền vững. Ý tưởng cho T6: async run campaigns +
  scheduled automation templates + fleet quota v2 + UI panels.
- Ý tưởng LOẠI: voice realtime qua cloud vendor độc quyền / giọng clone từ
  mẫu giọng thật của user khi chưa có consent rõ ràng — chỉ dùng voice
  provider user tự cấu hình key.

## 8. Ý tưởng LOẠI toàn sóng (theo hướng đứng của Huy 12/11)

- Cloud VM / tài khoản / thanh toán (kể cả ACP commerce, Letta hosted, Zep
  Cloud): LOẠI — local-first, miễn phí, công khai.
- Dữ liệu X / Grok Imagine: LOẠI — internet-wide data, user tự cắm key
  image/video.
- Server công khai ra internet (OpenHands agent_server, A2A cross-org):
  LOẠI — chỉ loopback/local.
- Copy code/text/tài sản từ bất kỳ repo nào: CẤM — chỉ học ý tưởng, viết lại
  từ đầu theo kiến trúc open-bot.

## Nguồn

- OpenHands V1 SDK paper: https://arxiv.org/html/2511.03690v2
- OpenHands deep dive: https://viblo.asia/p/openhands-deep-dive-build-your-own-guide-OXLA0jKMJGr
- Letta framework: https://chatforest.com/reviews/letta-memgpt-stateful-agent-framework/
- Letta sleep-time: https://latent.space/wiki/letta-ai-558a42a5/
- Mem0 vs Letta vs Zep: https://www.pixeltable.com/learn/mem0-vs-letta-vs-zep
- Temporal knowledge graph (Zep/Graphiti): https://www.getzep.com/ai-agents/temporal-knowledge-graph/
- Graphiti bi-temporal model: https://deepwiki.com/getzep/graphiti/3.2-temporal-awareness
- Agent protocols MCP/A2A/ACP: https://tyk.io/learning-center/agent-protocols-a-complete-guide-to-mcp-a2a-and-acp/
- MCP vs A2A vs ACP: https://blog.picassoia.com/mcp-vs-a2a-vs-acp-ai-agent-protocols-compared
