# Khảo sát repo — sóng v1.26 (17/11/2026, chu kỳ 07:01)

Nghiên cứu phục vụ sóng v1.26. CHỈ HỌC Ý TƯỞNG — không copy code/text/tài sản
của bất kỳ repo nào, của xAI/Cursor.

## 1. OpenHands V1 SDK — bài báo chính thức (arXiv 2511.03690, MLSys 2026)

- Nguồn: arxiv.org/html/2511.03690v2 — "The OpenHands Software Agent SDK",
  Wang và cộng sự, chấp nhận MLSys 2026. Repo `OpenHands/software-agent-sdk`
  (MIT), 64k+ stars cho OpenHands. V1 là viết lại toàn bộ kiến trúc V0.
- Ý tưởng đáng học:
  - **Chín component tách rời**: Event-Sourced State, LLM, Tool System, Agent,
    Context Window Management, Local Conversation, Secret Registry, Security
    and Confirmation, Deployment (local/remote workspace).
  - **Event-sourced state**: mọi interaction là event append-only; replay log
    tái tạo toàn bộ conversation; overhead event-sourcing không đáng kể.
  - **Bằng chứng sản xuất**: so sánh 15 ngày, V1 giảm 61% lỗi do hệ thống so
    với V0; ~77% SWE-Bench Verified với Claude Sonnet 4.5.
  - **Security analyzers 4 lớp**: LLMSecurityAnalyzer (agent tự chấm
    security_risk cho từng action), GraySwanAnalyzer (API đối kháng ngoài),
    PatternSecurityAnalyzer và PolicyRailSecurityAnalyzer (rail có tên như
    fetch-to-exec, raw-disk-op, catastrophic-delete, phân tích trên shell-AST).
  - **Post-train model trong harness** (OpenHands + Snowflake, 03/11/2026):
    rollout RL chạy ngay trong harness thật (Snowflake Cortex Sandbox), config
    agent truyền thẳng làm config train — không viết lại harness thứ hai.
    Skill `cortex-training-rl` cho phép mô tả bằng ngôn ngữ tự nhiên.
- Áp vào v1.26: T3 coding agent v17 — tách 9 component kiểu V1 SDK, security
  analyzer 4 lớp (pattern + policy rail trên shell-AST), event log append-only
  cho run; T2 protocols v9 — đối chiếu secret registry + confirmation.

## 2. Memory 2026 — cuộc đua số liệu đã ngã ngũ, chọn theo chi phí/vận hành

- Nguồn: particula.tech (Mem0 vs Zep vs Letta vs Cognee 2026),
  developersdigest.tech (10/2026), andrew.ooo (30/10/2026).
- Số liệu đã công bố (mỗi team tự đo, model đọc khác nhau — đọc như định hướng,
  không phải chân lý tuyệt đối):
  - **Mem0** (~66–68k stars, Apache-2.0): 94,4% LongMemEval, 92,5% LoCoMo
    (thuật toán tháng 04/2026), ~6,8–7k token/query, p50 ~1s. Bản open-source
    KHÔNG còn cắm graph store ngoài — graph memory chỉ có trên platform.
  - **Zep / Graphiti** (~28–32k stars, Apache-2.0): 90,2% LongMemEval, 94,7%
    LoCoMo, retrieval p50 104ms, 4,4–5,8k token/query. Bi-temporal: mỗi fact
    mang valid time + transaction time, fact cũ bị invalidate chứ không xóa.
    **Zep Community Edition đã ngừng hỗ trợ; backend Kuzu của Graphiti đã
    deprecated.** Zep giờ chỉ còn cloud / BYOC.
  - **Letta** (~25,3k stars): shared memory blocks — một block gắn cho nhiều
    agent, sửa một lần tất cả thấy; memory là git-backed context repo.
  - **Cognee**: chạy fully local, không có chứng nhận SOC 2/HIPAA.
  - **Cloudflare Agent Memory**: private beta.
- Bài học cho open-bot (local-first): vì Zep CE đã chết và Mem0 OSS mất graph
  ngoài, open-bot KHÔNG được dựa vào hosted memory — graph temporal kiểu
  Graphiti phải tự xây local (đã có nền từ v1.19–v1.25). Chọn kiến trúc theo
  chi phí token/latency, không theo điểm benchmark.
- Áp vào v1.26: T1 memory v24 — extraction đa tín hiệu kiểu Mem0 (additive,
  dedupe), retrieval đo token/latency minh bạch, shared blocks kiểu Letta,
  graph temporal local kiểu Graphiti (bi-temporal + invalidation).

## 3. Claude Agent SDK cuối 2026 — extension model sâu nhất thị trường

- Nguồn: developersdigest.tech (cập nhật 10/11/2026), software-lifecycle.com,
  skilldirectory.dev, myandroidsolutions.com (12/11/2026).
- Hiện trạng: `@anthropic-ai/claude-agent-sdk` TS **0.3.322** (10/11/2026,
  ngang Claude Code v2.1.322), Python 0.2.180. Model: Claude Opus/Sonnet/
  Haiku 5.5, Fable 5.1. Claude Code là agent được dùng nhiều nhất theo khảo
  sát Stack Overflow 2026.
- Ý tưởng đáng học (5 extension point, phân vai rõ — "ai quyết định?"):
  - **Subagent**: chạy background mặc định; spawn được subagent con; giới hạn
    depth 3, concurrency 20, spend cap; fork subagent; Workflow tool.
  - **Hooks**: 33 event, 5 handler type; `PreToolUse` chặn trước khi chạy,
    `PostToolUse` chạy sau; `updatedToolOutput`/`updatedInput`; quyết định
    `defer`; model không chọn hook — harness chạy hook, không tốn context
    trừ khi hook in ra output.
  - **Skills**: file `SKILL.md`, gọi bằng `/tên`; chuẩn này Codex và Cursor
    cũng đọc được.
  - **Plugins**: gói skills + agents + hooks + MCP server trong một folder
    (`plugin.json`); SDK chỉ nhận type `local`; marketplace phải tải về rồi
    trỏ folder; `reloadPlugins({ addPlugins })` nạp thêm khi đang chạy.
  - **Permissions**: `permission_policy` cho từng tool trên MCP server;
    `AGENTS.md` được đọc tự động từ v2.1.277 khi không có `CLAUDE.md`.
  - **Codex đọc được marketplace/plugin kiểu Claude** — chuẩn plugin đang
    hội tụ giữa các CLI.
- Áp vào v1.26: T6 platform/fleet v22 — plugin format kiểu Claude (local
  folder, manifest, reload khi đang chạy), subagent depth/concurrency/spend
  cap, hook lifecycle Pre/PostToolUse; T4 Composio v9 — per-tool permission
  policy cho MCP server.

## 4. CLI agent 2026 — bản đồ auto-detect phải cập nhật (quan trọng)

- Nguồn: theaicareerlab.com, safeguard.sh, termdock.com (kiểm chứng 27/10/2026).
- **Gemini CLI → Antigravity CLI**: từ **18/06/2026**, user miễn phí và Google
  One chuyển sang Antigravity CLI; Gemini CLI chỉ còn cho Code Assist
  Standard/Enterprise hoặc API trả phí. Free tier cũ 1.000 req/ngày không còn.
  → open-bot auto-detect PHẢI nhận diện Antigravity CLI, không chỉ Gemini CLI.
- **Codex CLI** (Apache-2.0): đăng nhập ChatGPT hoặc API key; sandbox mặc
  định (workspace writes, network off, `.git` read-only); có cả IDE extension,
  desktop app, Codex Cloud.
- **OpenCode** (MIT, 75+ provider, local qua Ollama/LM Studio/llama.cpp):
  agent build full-access + agent plan read-only chuyển bằng Tab; **sự cố
  17/10/2026: key provider bên thứ ba của một nhóm user Console có thể đã bị
  lộ** — bài học bảo mật trực tiếp: không bao giờ copy/lưu key của user ra
  khỏi máy, probe session chỉ đọc.
- **Qwen Code, Goose, Cline, Crush** là các CLI open-source còn được duy trì.
- Áp vào v1.26: T4 (đội CLI detect — gộp vào Composio v9 hoặc đội riêng theo
  coordinator) — thêm Antigravity CLI vào danh sách detect, probe session
  read-only, cảnh báo khi phát hiện CLI lưu key ở vị trí không an toàn.

## 5. Bản đồ giao thức tháng 11/2026 — MCP/A2A/Poppy + 1 CVE cần học

- Nguồn: dev.to (02 ngày trước), neuralpartners.ai (10/11/2026), aidaddy.tech.
- **MCP**: spec hiện tại **2026-07-28** (stateless, bỏ handshake `initialize`,
  thương lượng per-request qua `_meta` + header `MCP-Protocol-Version`).
  Registry vẫn preview, API đóng băng ở v0.1 — KHÔNG xây dependency cứng vào nó.
- **MCP Server Cards** (SEP-2127, Final 06/10/2026): card ở
  `<streamable-http-url>/server-card`; phát hiện qua AI Catalog
  `/.well-known/ai-catalog.json` — một index chung cho cả MCP server, A2A
  agent card và Claude Code plugin.
- **Skills over MCP** (SEP-2640, Final 13/09/2026; TS SDK 2.4.0, 23/10/2026):
  skill phân phối qua MCP như một extension.
- **A2A**: v1.0.0 (12/03/2026), v1.0.1 (28/05/2026); v1.1 RC cuối tháng 10
  thêm two-way streaming; từ 17/08/2026 A2A và MCP cùng nằm dưới Agentic AI
  Foundation (Linux Foundation). Nhóm "A2Family": A2A + AP2 (thanh toán,
  đã tặng cho FIDO Alliance) + A2UI (giao diện) + UCP (thương mại).
- **Poppy — Personal Agent Protocol 1.0** (Sierra, **13/11/2026**): agent cá
  nhân của user kết nối với doanh nghiệp qua website/API/agent của doanh nghiệp.
- **CVE-2026-115419** (CVSS 8.1, 22/10/2026, Strands Agents A2A server):
  server chia sẻ conversation history giữa các caller có `context_id` khác
  nhau — một caller đã xác thực có thể đọc history của caller khác hoặc lái
  model cho người khác. Fix: factory riêng cho mỗi `context_id`; workaround:
  một A2A server cho mỗi tenant. **Bài học trực tiếp cho open-bot fleet
  đa người dùng: cô lập state theo context/tenant là bắt buộc, không phải
  tính năng thêm.**
- **IETF** lập working group Agent Communication Protocols (10/2026).
- Áp vào v1.26: T2 protocols v9 — Server Cards + AI Catalog discovery, Skills
  over MCP, A2A v1.1 streaming, Poppy 1.0 (ý tưởng), kiểm toán cô lập
  context_id/tenant toàn fleet (bài học CVE-2026-115419); T5 voice v23 —
  AG-UI/A2UI live events cho voice session.

## 6. Trạng thái pipeline khi khảo sát (đã kiểm chứng 07:01–07:25 17/11)

- Nhánh `main` cục bộ đang ở `063970db` (v1.17, **609.892 dòng TS**, suite GREEN
  8540/8559). Nhánh `merge/v118` ở `669ec8fb` — agent hạ cánh v1.18 đang chạy
  (kiểm chứng rồi fast-forward main). Agent đẩy GitHub v1.18 đã CHẾT do daemon
  restart — cử lại sau khi v1.18 lên main.
- Các nhánh merge/v119–v125 đều đã có; merge/v125 chỉ chứa survey commit
  (`8b70af9e`) trên merge/v124 — đội v1.25 vẫn đang làm trên nhánh riêng.
- Số phiên bản đội v1.26 (đã kiểm chứng từ commit trên nhánh đội v1.25, KHÔNG
  lấy từ survey v125 vì survey đó ghi sai số): T1 memory v23 → **v24**,
  T2 harness v8 → **v9**, T3 coding v16 → **v17**, T4 Composio v8 → **v9**,
  T5 voice v22 → **v23**, T6 meta-harness v21 → **v22**. Coordinator KIỂM
  TRA LẠI số này từ code trước khi cử đội.
- Base sóng v1.26: nhánh `merge/v126` từ `merge/v125 @ 8b70af9e`.
