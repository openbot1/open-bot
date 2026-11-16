# Khảo sát repo — Sóng v1.12 (15/11/2026, chu kỳ 19:01)

Trạng thái xuất phát: main `0e1b144`, **464.931 dòng TS** (+23.090 vs v1.10),
suite GREEN 7005/7024, i18n 4565 key × 6 locale, registry ~359 tool.
Đẩy GitHub v1.11: 3/8 gói, gói 4 đang chờ thẻ duyệt từ 17:54 — KHÔNG đẩy lại gói 4.

CHỈ HỌC Ý TƯỞNG, không copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor.

## 1. Letta (ex-MemGPT) — memory blocks tự quản (2026)

- Nguồn: sureprompts.com/blog/letta-memgpt-walkthrough,
  neoneye.github.io/agent-memory-atlas/systems/letta/,
  danilchenko.dev/posts/mem0-vs-cognee-vs-letta/,
  reactify-solutions.com/articles/ai-agent-memory-systems-2026
- Ý tưởng cốt lõi: coi context window như RAM, bộ nhớ ngoài như disk; agent TỰ quản
  memory bằng tool call trong vòng lặp bình thường (không phải pipeline RAG bên ngoài).
- Primitive: **memory block** — chuỗi có nhãn, giới hạn kích thước (vài trăm–vài nghìn
  token), agent sửa bằng `core_memory_append` / `core_memory_replace`; block biên dịch
  thẳng vào system prompt nên lần gọi sau thấy ngay không cần search.
- Block chuẩn: `human` (agent biết gì về user), `persona` (agent biết gì về chính nó);
  block tùy chỉnh cho task/project. 3 tầng: main context (RAM), recall (lịch sử hội thoại
  tìm kiếm theo yêu cầu), archival (tri thức dài hạn tìm kiếm ngữ nghĩa).
- Mới 2025–2026: **sleep-time compute** — agent nền dọn dẹp block lúc rảnh; memory
  git-backed (letta-code) — agent sửa memory bằng file tool thông thường.
- Rủi ro: agent được tin tưởng sửa core memory của chính nó → cần tool rules,
  exact-string edit, read-only flag, runtime enforcement.
- Áp dụng cho v1.12 (T1): memory blocks v12 — block `human`/`persona`/`project` tự sửa
  qua tool, versioning + audit trail, sleep-time consolidation, giới hạn token/block,
  read-only flag cho block hệ thống.

## 2. OpenHands V1 SDK — event-sourced, CodeAct, control center (2026)

- Nguồn: dev.to/lynkr/run-openhands-on-any-model-you-want-1mnd,
  tech.vibequant.cc/tech/awesome-agent-openhands-review-en/,
  dev.to/truongpx396/openhands-deep-dive-build-your-own-guide-1al0
- ~82k stars, 7k+ commits; V1 SDK (11/2025, arXiv 2511.03690) tách thành 4 package độc
  lập: SDK (agent definitions), Tools, Workspace (execution env), Server. Agent là
  config object vô trạng; mọi state thay đổi nằm trong **ConversationState event-sourced** —
  stream typed **Action/Observation** bất biến, append-only, replay được.
- **CodeAct**: thay vì 20 tool hẹp, cho agent bash + Python + browser DSL, mọi hành động
  biểu diễn bằng code. ~77% SWE-Bench Verified (Claude Sonnet 4.5, V0) / 72.8% (V1 SDK).
- Microagents → Skills: thư mục `.openhands/microagents/*.md` (repo.md, frontend.md…)
  nạp theo yêu cầu — cho agent mental model của codebase.
- 2026: đổi hướng thành **Agent Control Center** — quản lý cả agent ACP khác
  (Claude Code, Codex, Gemini) qua Agent-Client Protocol; Agent Server chạy nhiều agent
  trên một host/port; Agent Canvas kết nối nhiều server; Automation Server (scheduled
  runs, webhook triggers); enterprise: profiles, budgets, usage monitoring, RBAC.
- Bài học: V0 có 140+ config field / 15 class / 2.8k LOC chỉ cho config → V1 viết lại.
  Nguyên tắc: optional isolation (local mặc định, Docker khi cần), two-layer composability.
- Áp dụng cho v1.12 (T2 + T4): T2 — event log append-only + replay cho conversation
  open-bot, CodeAct-lite (bash/python tool an toàn trong sandbox), skills markdown
  nạp theo yêu cầu; T4 — ACP control center: quản lý agent CLI ngoài (Claude Code /
  Codex / Gemini CLI) như agent được quản lý, kèm budgets + usage monitoring.

## 3. Mem0 vs Zep/Graphiti — memory layer 2026 (benchmark war)

- Nguồn: atlan.com/know/zep-vs-mem0/, particula.tech/blog/agent-memory-frameworks-tested-mem0-zep-letta-cognee-2026,
  aiworkflowlab.dev/article/agent-memory-mem0-vs-letta-vs-zep-2026,
  dataaspirant.com/blog/mem0-vs-letta-vs-zep/
- Mem0 (~66k stars, Apache 2.0): extraction-first — LLM trích fact nổi bật từ mỗi turn,
  lưu vector + BM25 + entity graph (Mem0g); thuật toán 04/2026 tự báo 94.4% LongMemEval,
  92.5% LoCoMo, ~6.8–7k token/query, p50 ~1s. Additive: fact mới không ghi đè fact cũ
  âm thầm; update/delete phải tường minh. Điểm mạnh: bolt-on nhẹ, `add()`/`search()`.
- Zep/Graphiti (~31k stars): **temporal knowledge graph hai thời gian** (bi-temporal):
  mỗi fact là edge có khoảng hiệu lực (valid time + transaction time); fact mâu thuẫn
  thì **invalidate** (ghi `invalid_at`) chứ không xóa → trả lời được "user thích gì
  tháng trước?", "tháng 3 user ở đâu?". Tự báo 90.2% LongMemEval, 94.7% LoCoMo,
  p50 retrieval ~104ms, 4.4–5.8k token/query. Graphiti OSS tự host được (Neo4j/FalkorDB).
- Cognee: graph trên document + conversation log, chạy fully local.
- Cảnh báo: số benchmark là tự báo, phương pháp tranh cãi (LOCOMO: Zep 84% → Mem0
  sửa thành 58.44% → Zep phản bác 75.14%). Dùng làm hướng thiết kế, không trích số
  tuyệt đối.
- Áp dụng cho v1.12 (T3): temporal KG v2 — edge có khoảng hiệu lực, invalidation thay
  vì xóa, truy vấn "đã đúng khi nào", episode giữ nguyên làm provenance, scope
  user/session/agent.

## 4. Hướng sóng v1.12 — 6 đội

| Đội | Hệ thống | Mục tiêu |
|-----|----------|----------|
| T1 | Memory blocks kiểu Letta v12 | block tự sửa qua tool, sleep-time consolidation, versioning |
| T2 | Event-sourced conversation + CodeAct-lite | event log append-only + replay, skills markdown |
| T3 | Temporal KG v2 kiểu Graphiti | bi-temporal edge, invalidation, truy vấn theo thời gian |
| T4 | ACP control center | quản lý agent CLI ngoài, budgets, usage monitoring |
| T5 | Voice realtime v11 | barge-in, turn-taking, VAD, TTS streaming |
| T6 | Platform/fleet v9 + Composio | fleet scheduling, automations v2, toolkit mở rộng |

Mục tiêu chu kỳ: +30.000 dòng TS thật (code + test + i18n cho tính năng thật).
Nút thắt đã biết: máy chỉ 1,5 CPU — các sóng gần đây đạt 16–25k/chu kỳ.
