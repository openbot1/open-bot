# Repo survey — v1.03 (14/11/2026)

Nghiên cứu cho chu kỳ v1.03. CHỈ HỌC Ý TƯỞNG, không copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor.

## 1. OpenHands V1 SDK (All-Hands-AI, ~74.400 stars, MIT, v1.7.0 tháng 5/2026)

Nguồn: dev.to "Run OpenHands Self-Hosted", viblo deep-dive (4/2026), arXiv 2511.03690 (V1 SDK paper, MLSys 2026).

- V0 → V1 (11/2025): từ monolith 140+ config field/15 class thành 4 package độc lập: **SDK** (agent definitions), **Tools** (action handlers), **Workspace** (execution environments), **Server** (hosting).
- Quyết định kiến trúc quan trọng nhất: **event-sourced, stateless agent**. Mọi mutable context nằm trong một `ConversationState`; conversation là stream typed event bất biến (**Action** / **Observation**), replayable. Pause, resume, fork, deterministic replay, audit trail đều miễn phí nhờ đó.
- Agent là **pure function từ event history → next event**, chạy trong vòng lặp. `Conversation` factory tự chọn `LocalConversation` (in-process) hoặc `RemoteConversation` (HTTP/WebSocket tới container) theo config, không đổi code.
- **CodeActAgent**: thay vì 20 tool bespoke, cho LLM bash + Python (Jupyter) + browser DSL, mọi hành động biểu diễn bằng code. Tool use thống nhất qua contract **Action → Execution → Observation**.
- Runtime: sandbox Docker microservice, action execution server qua REST API; agent không bao giờ chạm host trực tiếp.
- 4 nguyên tắc V1: optional isolation (local mặc định, sandbox khi cần), stateless by default + một source of truth, immutable config, typed tool system + MCP.
- ~77% SWE-Bench Verified với Claude Sonnet 4.5.
- Ý tưởng áp dụng cho open-bot v1.03: event-sourced conversation engine sâu hơn (fork/replay/time-travel cho run), CodeAct-style tool (bash+python+editor thống nhất), Workspace abstraction local ↔ container, condenser/memory compression treo trên event stream, microagent knowledge, stuck detection.

## 2. Harness Engineering — Anatomy of Eleven Systems (arXiv 2609.00006, 7/2026)

Nghiên cứu source-code của 11 harness production: Claude Code, Codex CLI, Gemini CLI, Mistral Vibe, OpenHands, Aider, Mini-SWE-Agent, Hermes, Pi, OpenCode, OpenClaw (+ Omnigent meta-harness).

- Định nghĩa: **agent = model + harness** — runtime nối LLM với thế giới qua loop, tools, context management, safety, orchestration, extension surfaces. "Harness engineering" được đặt tên thành discipline đầu 2026.
- 7 subsystem chuẩn của mọi harness; 13 cross-cutting observations; catalog **29 recurring design patterns**; 18 design recommendations + scaffold harness tối thiểu 90 dòng.
- 2 phát hiện đáng chú ý:
  - Không harness nào import framework agent đa năng (LangChain/LangGraph/AutoGen...); Gemini CLI cũng không dùng framework của chính Google.
  - Không harness nào retrieve code bằng vector embeddings.
  - **ACP (Agent Client Protocol) có mặt ở 6 hệ** và thêm vai trò thứ 3 là *harness hosting*: OpenHands chạy Claude Code / Codex / Gemini CLI như backend thay thế được. OpenHands đọc được format plugin của Claude Code.
- Ý tưởng áp dụng: đối chiếu 7 subsystem của open-bot với checklist 29 pattern, bổ sung pattern còn thiếu (stuck detection, security review, sub-agent delegation, context compaction), mở rộng ACP hosting (chạy harness ngoài như backend), plugin-format compat.

## 3. Mem0 vs Letta vs Zep — agent memory 2026

Nguồn: aiworkflowlab.dev (26/5/2026), past.dev (3/9/2026), andrew.ooo (30/10/2026), dataaspirant.com, dev.to.

- **Mem0** (~68k stars, Apache 2.0): memory layer — LLM extract facts từ message, dedup/consolidate (add/update/delete/noise) qua LLM judge, lưu vector store, scope `user_id`/`agent_id`/`run_id`. LOCOMO: +26% accuracy vs OpenAI memory, p95 latency −91%, token −90%. Best cho personalization + chat compression.
- **Letta** (~25k stars, MemGPT lineage, arXiv 2310.08560): stateful agent OS. Core memory blocks (persona/human) luôn trong context, agent tự edit bằng tool (`core_memory_replace`); archival memory vector store; recall memory là history. **Shared memory blocks**: một block gắn nhiều agent, update một nơi thấy ở mọi nơi — best cho multi-agent live shared state. **Sleep-time agents**: background agent consolidate memory giữa session, sau N step hoặc khi compact context.
- **Zep/Graphiti** (~28k stars): temporal knowledge graph — facts có validity window + supersession link, best cho temporal facts/CRM/support.
- Ý tưởng áp dụng: memory v4 — shared blocks cross-agent (kế thừa blocks v2), sleep-time consolidation sâu hơn (dream pass có scoring), mem0-style extraction+consolidation judge (add/update/delete), temporal validity windows cho fact (kế thừa temporal KG v0.98), per-scope retrieval (user/agent/run).

## 4. Hướng đội v1.03 (từ survey này)

- T1 — Harness engine v2: event-sourced conversation (fork/replay/time-travel), CodeAct tool, stuck detection, condenser.
- T2 — Memory v4: shared blocks cross-agent + sleep-time consolidation + mem0-style judge + temporal validity.
- T3 — ACP hosting: chạy harness ngoài (Claude Code/Codex/Gemini CLI/OpenCode) như backend thay thế được + plugin-format compat + 29-pattern audit.
- T4 — Workspace/sandbox v3: Workspace abstraction local ↔ container, resource quotas, snapshot/restore.
- T5 — Voice realtime v3 + multimodal: long session bền, media context sâu, local voice stack mở rộng.
- T6 — Platform/fleet v3 + UI: fleet console sâu, bot marketplace v3, plugin marketplace, observability (event-stream viewer, eval harness UI).
