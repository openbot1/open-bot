# Nghiên cứu repo/hệ thống — Sóng v1.10 (15/11/2026)

Mục đích: học Ý TƯỞNG kiến trúc từ các hệ thống lớn, KHÔNG copy code/text/tài sản
của bất kỳ repo nào, của xAI/Cursor. Nguồn: tìm kiếm web ngày 15/11/2026.

## 1. MCP sau bản 2026-07-28 — những gì đổi từ tháng 11/2026

- Spec mới nhất sau 2025-11-25 là 2026-07-28 (stateless: không còn handshake
  `initialize`, không `Mcp-Session-Id`, mỗi request tự đủ thông tin; chạy sau
  load balancer thường). Chu kỳ phát hành mới: 6 tháng (SEP-3398), bản tiếp
  theo dự kiến `2027-03-30`.
- **Multi Round-Trip Requests (MRTR)**: mọi server-initiated request bị gỡ
  (elicitation, sampling, `roots/list`). Server trả `InputRequiredResult`
  (`resultType: "input_required"`), client trả lời rồi retry request gốc kèm
  đáp án. Tất cả result giờ mang trường `resultType` bắt buộc.
- **Tasks ra khỏi core** thành extension chính thức `io.modelcontextprotocol/tasks`
  (SEP-2663): bỏ `tasks/result` blocking, polling bằng `tasks/get` + `tasks/update`
  cho client-to-server input, bỏ `tasks/list`; server được trả task handle
  không cần opt-in từng request. Python SDK v2 chưa implement extension này.
- **Files extension** (bản nháp đăng 2026-11-10): `io.modelcontextprotocol/files`
  đưa byte file ra ngoài model — mục tiêu ổn định cuối 2026.
- Deprecated với offramp tối thiểu 12 tháng: transport HTTP+SSE, dynamic client
  registration (thay bằng Client ID Metadata Documents), roots/sampling/logging
  (có thể biến mất từ ~07/2027).
- Trạng thái extension (11/2026): MCP Apps (HTML tương tác trả về từ tool,
  ra mắt 26/01/2026), Enterprise-Managed Authorization, OAuth Client Credentials
  đã stable; Tasks, Skills over MCP, Server Cards đang beta.
- **Bảo mật 11/11/2026**: 6 advisory cho reference server — command-execution
  High ở `mcp-server-git`, 2 path escape ở filesystem server, 2 bypass low ở
  fetch server. Nâng cấp lên 2026.11.11+. Bài học cho open-bot: audit path
  traversal + command injection ở mọi MCP server nội bộ.
- Claude Code 2.1.319 + TS Agent SDK 0.3.319 (06/11/2026): tool call chạy dạng
  task được đưa nền ngay (`CLAUDE_AUTO_BACKGROUND_TASKS=1` + streaming input).
  VS Code 1.145 (04/11/2026): MCP Apps có thể đăng ký tool cho model gọi.
- Microsoft Agent Framework (.NET, 1.28.0, kiểm chứng 13/11/2026): dùng SDK C#
  chính thức, thêm `Microsoft.Agents.AI.Mcp` (alpha) cho long-running MCP tasks
  và MCP-delivered skills; `ListAgentToolsWithTasksAsync` poll task tới xong rồi
  trả kết quả như gọi đồng bộ.
- Ý tưởng áp dụng cho v1.10: MRTR client (InputRequiredResult + retry kèm
  state), Tasks extension client/server (poll `tasks/get`), files extension
  draft (upload/download ngoài model), audit bảo mật MCP server nội bộ theo
  advisory 11/11, auto-background tasks cho tool call dài.

## 2. Claude Code Agent Teams + Codex (tháng 11/2026)

- Claude Code v2.1.316+ (kiểm chứng 11/2026): Agent Teams vẫn EXPERIMENTAL,
  tắt mặc định, bật bằng `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. Lead spawn
  teammate, mỗi teammate là một session Claude Code đầy đủ với context riêng.
- Cơ chế phối hợp: **shared task list** (file-locked claiming — 2 agent không
  giành cùng việc) + **mailbox** nhắn peer-to-peer theo tên. Một team mỗi
  session, không team lồng nhau. Cần interactive session — `claude -p` và
  Agent SDK không bao giờ spawn teammate.
- Bật teams cũng đổi hành vi delegate thường: subagent Claude đặt tên có thể
  khởi chạy dạng teammate. Teammate load MCP server, CLAUDE.md, skills của
  project khi spawn; hook `TaskCompleted` chạy khi teammate đánh dấu xong
  (exit code 2 = giữ task mở kèm feedback).
- **Fork subagents** mặc định từ v2.1.302 ở `claude -p`, Agent SDK, desktop app,
  VS Code. Subagent tối đa 20 song song mặc định
  (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`), spawn sâu tối đa 3 tầng.
- Chi phí: team ở plan mode tốn ~7x token so với session thường. Khuyến nghị
  3–5 teammate.
- Codex CLI v0.167.0 (06/11/2026, GPT-6.1 Sol): subagents GA dạng
  manager + explorer/worker/default, giới hạn thread cấu hình được
  (`agents.max_concurrent_threads_per_session`), chưa có tính năng team đặt tên.
- Benchmark (09/11/2026): Claude Code Opus 5.5 mặc định từ v2.1.280 — 64.85%
  Terminal-Bench 4.0 vs Codex GPT-6.1 Sol 58.18%; Opus 5.5 đạt 89.9% SWE-bench
  Pro (Opus 4.8: 69.2%), giá $4/$20 (cũ $5/$25). 16 agent Claude viết compiler
  C 100.000 dòng bằng Rust, build Linux 6.9, pass 99% GCC torture suite,
  ~2.000 session, ~$20.000 API.
- Thang leo thang song song (Claude Code): subagent → background agent
  (`--bg`/`/background`/`claude agents`) → `/batch` worktrees → Agent Teams
  (experimental). Antigravity `/teamwork` là team duy nhất ship không cần flag
  (plan trả phí); Copilot CLI `/fleet` chạy subagent song song nhưng không phải
  team peer.
- Ý tưởng áp dụng cho v1.10: agent teams v2 trong open-bot — shared task list
  với claiming có khóa file, mailbox peer-to-peer, vai lead/worker, fork
  subagent (context riêng + merge kết quả), agent view dashboard, hook
  TaskCompleted (giữ task mở khi reviewer trả feedback), giới hạn team
  3–5 teammate + cảnh báo chi phí token.

## 3. Memory 2026: Mem0 vs Letta vs Zep — hợp nhất 3 tín hiệu

- Đồng thuận 2026: memory layer ≠ RAG. RAG kéo tri thức công khai, stateless
  theo user. Memory layer lưu dữ liệu cá nhân hoá theo user, thay đổi theo
  thời gian; write liên tục khi agent chạy, read chọn lọc theo từng turn.
- Khung CoALA (Princeton/Google): 4 loại memory — working, episodic, semantic,
  procedural. Agent mạnh kết hợp cả 4, không cược một store.
- **Mem0** (~48k stars, Apache-2.0): pipeline 2 bước bằng LLM — extraction
  (rút fact nổi bật mỗi turn) rồi consolidation (so với memory hiện có: add /
  update / delete khi mâu thuẫn / drop noise). Retrieval hợp nhất 3 tín hiệu:
  semantic (vector) + keyword (BM25) + entity-match. Scope theo
  `user_id`/`agent_id`/`run_id`. Store: Qdrant/pgvector + Neo4j + key-value.
  LOCOMO: hơn OpenAI memory feature 26% accuracy tương đối, p95 latency giảm
  ~91% so với nhét full history, dùng ~90% ít token hơn. Write p50 ~80–200ms.
- **Letta** (MemGPT, ~21k stars, Apache-2.0): context window = RAM, LLM tự
  quản lý paging qua tool call — core memory blocks cố định trong prompt,
  recall + archival tiers. 2026: **Letta Code** (coding agent #1 model-agnostic
  open-source trên Terminal-Bench) + Skill Library; memory commit/branch/rollback
  qua Git — memory thành artifact version được. LongMemEval ~52%.
- **Zep / Graphiti** (open-source engine): temporal knowledge graph — episode
  thành entity + relationship, mỗi edge mang validity window; fact mâu thuẫn
  làm edge cũ invalid thay vì ghi đè lặng lẽ. Bi-temporal: ghi cả thời điểm
  fact đúng trong thế giới và thời điểm hệ thống học được nó — trả lời được
  "ở đâu vào tháng 3" lẫn "ở đâu bây giờ". Retrieval hợp nhất vector
  similarity + full-text + graph traversal. LongMemEval 63.8% (cao nhất 3 hệ).
  Write p50 ~300–800ms. Zep `memory.get()` trả context block đã consolidate.
- So sánh: Mem0 = layer bolt-on nhanh nhất; Letta = runtime stateful cho agent
  chạy dài ngày; Zep = mạnh nhất về freshness + truy vấn bi-temporal.
  Extracted-fact + graph memory hơn naive RAG 20–40 điểm % trên LOCOMO.
- Ý tưởng áp dụng cho v1.10: memory v10 — pipeline extraction/consolidation
  kiểu Mem0 (add/update/delete/drop-noise) + bi-temporal graph v2 (validity
  window + invalid thay vì overwrite) + 4 loại CoALA + Git-versioned memory
  blocks kiểu Letta Code (commit/branch/rollback) + retrieval hợp nhất 3 tín
  hiệu (vector + BM25 + entity) với bảng điểm giải thích được.

## 4. Ưu tiên sóng v1.10 (6 đội)

- T1 memory v10: Mem0 pipeline + bi-temporal graph v2 + CoALA 4 loại + Git-versioned blocks.
- T2 MCP 2026-07-28+: MRTR client, Tasks extension (poll), Files extension draft, audit bảo mật theo advisory 11/11.
- T3 agent teams v2: shared task list + file-locked claiming, mailbox peer-to-peer, fork subagent, agent view dashboard, TaskCompleted hook.
- T4 coding agent v3: repo map PageRank v2, manager/explorer/worker, eval harness kiểu Terminal-Bench, router model local.
- T5 voice v5 + UI: realtime voice (mock + live key thật nếu có), AG-UI generative UI v2, dashboard teams.
- T6 platform/fleet v7 + Composio: fleet campaign v2, Composio toolkit mới, provider mới, i18n đầy đủ.

## Nguồn

- https://modelcontextprotocol.io/specification/2026-07-28/changelog
- https://py.sdk.modelcontextprotocol.io/whats-new/
- https://www.querynow.com/ai-agents/mcp/what-is-mcp
- https://ai-digest.fjgarciahurtado.com/topics/tooling/mcp/
- https://www.getorchestra.io/knowledge-hub/data-tools/claude-agent-orchestration
- https://learn.intellimetrics.net/modules/19-agentic-engineering/05-subagents-and-orchestration/
- https://docs.agentmessagingservice.com/guides/claude-code-multiple-agents
- https://www.postbase.so/blog/claude-code-agent-teams
- https://www.morphllm.com/comparisons/codex-vs-claude-code
- https://aiengineerinsights.com/blog/ai-agent-memory/
- https://anhtu.dev/long-term-memory-for-ai-agents-mem0-letta-zep-memory-augmented-llm-2026-2247
- https://aiworkflowlab.dev/article/agent-memory-mem0-vs-letta-vs-zep-2026
- https://dataaspirant.com/blog/mem0-vs-letta-vs-zep/
