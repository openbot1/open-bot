# Repo survey — v1.07 (14/11/2026)

Nghiên cứu cho chu kỳ v1.07. CHỈ HỌC Ý TƯỞNG, không copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor. Các nguồn dưới đây đều là tóm tắt viết lại từ tài liệu công khai, kiểm chứng qua web search ngày 14/11/2026.

## 1. OpenHands v1.38.0 (10/11/2026) — V1 SDK: Agent / Conversation / Workspace / EventLog

Nguồn: daily.rclabs.in (release notes v1.38.0), viblo.asia (deep dive theo V1 SDK paper arXiv 2511.03690 + OpenDevin paper arXiv 2407.16741), openhands.dev (product update 05/2026), docs.openhands.dev (Enterprise 0.74.0).

- **Kiến trúc V1 (từ 11/2025):** lõi rất nhỏ — một **Agent** stateless phát ra Action, một **Conversation** chạy vòng lặp và lưu **append-only EventLog**, một **Workspace** (local process hoặc Docker container) thực thi Action và trả Observation, một **LLM** bọc qua LiteLLM để đổi provider tự do. V0 cũ có AgentController + Runtime riêng; V1 gộp lại vì controller "không xứng đáng với sự phức tạp". Bài học: đừng giữ lớp trung gian chỉ vì nó từng có — nếu vòng lặp + event log đã đủ, bỏ controller.
- **V1.38.0 mới:** conversation budget meters (hiển thị ngân sách hội thoại bằng meter ngữ nghĩa), chỉnh được cấu hình plugin thực thi trong automation, Paper theme, banner "resolved" cho conversation, automation-aware install (`mode=automation` + POST /plugin-spec), profile-based prompt và plugin presets, message-only launch links.
- **LLM Profiles + lệnh `/model`:** user lưu nhiều cấu hình LLM thành profile tái dùng; gõ `/model` trong chat để liệt kê và đổi profile ngay, không cấu hình lại. Đây là pattern open-bot nên có: profile model đổi nhanh trong chat.
- **Sub-agent delegation + Critic:** OpenHands ủy quyền task chuyên biệt cho sub-agent qua TaskToolSet; kết quả critic/verification render inline trong conversation. Sandbox grouping strategy phơi ra trong Settings cho mọi user.
- **Secrets inline:** agent xin secret qua modal ngay trong conversation (v1.28.0) — không bắt user rời chat sang Settings. Pattern này áp dụng được cho open-bot: khi tool cần key chưa có, hỏi inline trong chat thay vì chặn ở màn hình key.
- **Prompt caching:** LiteLLM + prompt caching giảm 30–80% chi phí — bài học cho router local của open-bot: cache system prompt + memory blocks đã biên dịch theo hash, chỉ gửi lại phần đổi.
- **Microagent registry:** chia sẻ skill giữa các team khi có >5 project — tương đương plugin/skill marketplace nội bộ của open-bot.
- **Production checklist (đáng học):** headless mode trước, GUI sau; resolver kiểu Issue → PR tự động chỉ khi tin agent; evaluation harness (SWE-Bench, GAIA) trước khi tuyên bố con số.
- Ý tưởng áp dụng cho open-bot v1.07 (đội T2/T5): vòng lặp Agent/Conversation/EventLog gọn lại; LLM profiles + `/model` trong chat; xin secret inline trong chat; budget meter cho conversation; critic result render inline; sub-agent delegation qua TaskToolSet.

## 2. Claude Code 2026 — Agent Teams, 7 extension layer, subagent là context firewall

Nguồn: resources.anthropic.com (Claude Code Advanced Patterns, 24/03/2026), genai-playbook.com (dựa Anthropic blog 14/05/2026 "the harness matters as much as the model"), dev.to (9 production agent, 14 tuần), makerkit.dev (best practices 2026, cập nhật 06/2026), wal.sh (Q2 2026 notes, kiểm chứng changelog tới 08/10/2026).

- **Agent Teams (research preview):** nhiều agent giao tiếp, phối hợp, chia việc song song — tỏa sáng khi task tách được thành workstream độc lập, mỗi agent sở hữu một lát cắt không chặn nhau. Khác subagent một lần: team là quan hệ peer lâu hơn một task, có điều phối.
- **7 extension layer của harness:** CLAUDE.md (hiến pháp project, luôn load), hooks (shell script tại PreToolUse/PostToolUse/Stop/SessionStart/UserPromptSubmit), skills (file Markdown tái dùng trong `.claude/skills/`, gọi bằng slash command, progressive disclosure theo thư mục), plugins (bundle skill + hook + MCP config thành gói cài được), MCP servers (giới hạn thực tế 3–5 server mỗi agent), LSP integration, subagents (session riêng, context window riêng, chỉ trả kết quả cuối về parent).
- **Subagent = context firewall:** giá trị lớn nhất của subagent không phải song song mà là cô lập context — Explore/Plan tách khỏi Edit; reviewer chuyên biệt (code-reviewer, security-expert, debugger) chạy trong context riêng rồi trả một message nén thay vì hàng trăm tool call làm bẩn context parent. Cô lập bằng git worktree: child làm trên worktree riêng, trả về tên branch.
- **Skills:** không phải mọi chuyên môn đều cần có mặt mỗi session — skill chỉ kích hoạt khi làm việc trong thư mục liên quan, tránh context bloat. Plugin = skill + hook + MCP đóng gói lại.
- **Context 1M token mặc định:** mọi model Claude hiện tại trừ Haiku đều có context 1M (Opus 5.5 ra 22/09/2026, $4/$20 per Mtok, thay Opus 5 làm default). Bài học cho open-bot: router nên biết context window từng model để chọn chiến lược nén/summarize.
- **Harness quan trọng ngang model:** Anthropic quan sát thấy rollout mượt nhất là nơi đầu tư hạ tầng harness trước khi mở rộng truy cập — cấu trúc (AGENTS.md, skill, MCP, subagent) quyết định code agent sinh ra có maintainable hay thành technical debt.
- Ý tưởng áp dụng cho open-bot v1.07 (đội T4/T6): hệ skills Markdown + progressive disclosure; plugin bundle (skill+hook+MCP); hooks lifecycle; Agent Teams peer điều phối; subagent worktree isolation; router biết context window từng model.

## 3. Giao thức agent 2026 — A2A v1.0 thắng, ACP sáp nhập, MCP 97 triệu lượt tải/tháng

Nguồn: tyk.io (AI Agent Protocols Explained), boldare.com (ACP Explained, mid-2026), dev.to (A2A vs MCP vs ACP), codex.danielvaughan.com (A2A meets MCP, 09/04/2026).

- **Cuộc chiến giao thức đã kết thúc:** MCP lo agent ↔ tool (tích hợp dọc), A2A lo agent ↔ agent (điều phối ngang). Cả hai đều dưới Linux Foundation. ACP của IBM (ra 03/2025 cho BeeAI) đã sáp nhập vào A2A tháng 08/2025; ACP dừng phát triển độc lập, repo gốc archived, doc IBM redirect sang A2A. **Đừng thiết kế kiến trúc mới quanh ACP** — chỉ còn giá trị tham khảo lịch sử + migration guide (adapter A2AServer/A2AAgent cho BeeAI).
- **A2A v1.0 (01–03/2026):** 150+ tổ chức ủng hộ, production ở tài chính/bảo hiểm/supply chain. Agent Card có **chữ ký JWS** (RFC 7515 + canonicalisation RFC 8785) để xác minh danh tính agent xuyên tổ chức. Task là state machine bất đồng bộ, streaming artifact qua Server-Sent Events. Discovery qua `/.well-known/agent.json`. Multi-protocol, multi-tenancy.
- **MCP:** tới 03/2026 đạt **97 triệu lượt tải/tháng** (tăng 970x trong 18 tháng). Roadmap 2026: transport scalability (stateful session chống load balancer), enterprise readiness (audit trail, SSO auth, gateway), governance, tool annotation mô tả hành vi tool cho agent. Anthropic donate MCP cho Agentic AI Foundation (AAIF) ngày 09/12/2025, đồng sáng lập cùng Block và OpenAI.
- **Hạ tầng phụ trợ:** AGNTCY (Cisco Outshift, 03/2025, donate LF 07/2025) cho discovery/identity/messaging/observability của multi-agent system. **Agent Client Protocol** (Zed Industries, 08/2025) chuẩn hoá cách editor nói chuyện với coding agent (Claude Code, Gemini CLI).
- Ý tưởng áp dụng cho open-bot v1.07 (đội T3): A2A v1.0 server + client thật — Agent Card có chữ ký (JWS local, khóa trong Vault), task state machine + SSE, discovery `/.well-known/agent.json`; registry discovery kiểu AGNTCY chạy local; ghi rõ ACP chỉ còn là migration note, không xây mới.

## 4. Memory 2026 — Mem0 v3 ADD-only, Letta sleep-time compute, cảnh báo benchmark

Nguồn: reactify-solutions.com (AI Agent Memory in 2026), codeyashu.github.io (study planner, cập nhật 09/2026), agentmarketcap.ai (Architecture Wars 2026), mnemoverse.com (so sánh 6 hệ thống, tái kiểm chứng 28/09/2026).

- **Mem0 v3 (04/2026):** extraction single-pass ADD-only, retrieval fusion 3 tín hiệu (semantic + BM25 + entity). Điểm LoCoMo 92.5, LongMemEval 94.4, khoảng 6.900 token/query so với ~26.000 token của full-context replay (giảm ~73% token, vẫn thua full-context một chút về accuracy). Temporal reasoning +29.6 điểm, multi-hop +23.1 so với bản trước. Scope đa tầng: user/agent/run/app, query gộp theo thứ tự ưu tiên session > user > org.
- **Letta:** memory block tự sửa qua tool + **sleep-time compute** — agent nền sắp xếp lại memory block lúc idle, không chiếm turn của user. V1 mở rộng shared memory block xuyên fleet: nhiều agent chuyên biệt chia sẻ một memory state chung, Conversations API giữ memory đồng bộ giữa các trải nghiệm song song.
- **Zep/Graphiti:** temporal knowledge graph, entity + quan hệ có thời gian hiệu lực (bi-temporal), hybrid search (semantic + BM25 + graph).
- **Cảnh báo quan trọng:** số benchmark của vendor **không sống sót qua tái kiểm chứng độc lập** — LongMemEval của Mem0 rơi từ 93.4% xuống 73.8% dưới harness của Maximem (bản thân Maximem cũng là vendor memory). Luôn hỏi harness là gì và ai chạy. Open-bot không tuyên bố điểm benchmark của mình nếu không tự chạy harness công khai.
- **Bảo mật memory:** OWASP ASI06 Memory & Context Poisoning — memory là bề mặt tấn công (fact độc chèn vào rồi agent tin). Cần đường xóa đáp ứng yêu cầu GDPR erasure + defense chống poisoning: ghi nguồn gốc mỗi fact, nghi ngờ fact mâu thuẫn, cho user duyệt/xóa.
- Ý tưởng áp dụng cho open-bot v1.07 (đội T1): memory v8 — sleep-time compute (consolidation lúc idle), shared memory block xuyên fleet/bot, fused retrieval 3 tín hiệu (keyword + entity + recency, local, không rò embedding), provenance + chống poisoning + xóa theo yêu cầu.

## 5. Hướng đội v1.07 (từ survey này)

- **T1 — Memory v8:** sleep-time compute + shared fleet memory blocks + fused retrieval + provenance/chống poisoning (OWASP ASI06) + xóa GDPR.
- **T2 — Harness v3:** gọn vòng lặp theo kiểu Agent/Conversation/EventLog; sub-agent delegation (TaskToolSet); critic inline; conversation budget meter; LLM profiles + `/model` trong chat.
- **T3 — Protocols A2A v1.0:** Agent Card ký JWS + discovery `/.well-known/agent.json` + task state machine + SSE; registry discovery local kiểu AGNTCY; ACP chỉ là migration note.
- **T4 — Skills & plugins:** skills Markdown + progressive disclosure; plugin bundle (skill+hook+MCP); hooks lifecycle Pre/PostToolUse/Stop/SessionStart; xin secret inline trong chat.
- **T5 — Voice v4 + UI:** realtime voice tiếp nối + budget meter UI + theme; i18n đầy đủ cho mọi chuỗi mới.
- **T6 — Platform/fleet v4:** Agent Teams peer điều phối + subagent worktree isolation + router biết context window từng model + prompt-cache theo hash cho memory blocks.
