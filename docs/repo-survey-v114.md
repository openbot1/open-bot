# Repo survey v1.14 — Letta Code, OpenHands V1 SDK, MCP Tasks/Apps v2, Mem0/Zep 2026, voice realtime

Ngày: 2026-11-16 (chu kỳ 01:01). Điểm xuất phát: main `3e97c52`, 513.288 dòng TS (v1.13 xong,
suite GREEN 7585/7604, i18n 4983 key × 6 locale, registry 820 tool).
CHỈ HỌC Ý TƯỞNG — không copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor.

## 1. Letta — stateful agent runtime, memory là trạng thái của agent (MemGPT, Berkeley 2023)
- Ba tầng memory kiểu OS: **core memory** (block luôn nằm trong prompt, agent tự sửa bằng tool
  `core_memory_append`/`core_memory_replace`), **archival memory** (vector store tìm kiếm theo nhu cầu),
  **recall memory** (lịch sử hội thoại tìm theo ngày/nội dung).
- Block là primitive chịu tải: chuỗi có nhãn (`human` = biết gì về user, `persona` = agent là ai),
  giới hạn vài trăm–vài nghìn token ép agent phải biên tập thay vì tích trữ; custom block cho
  task/project state. Thay đổi block = biên dịch lại system prompt, lần gọi sau thấy ngay.
- Letta v0.16.7 (31/03/2026): context 128K, bỏ giới hạn kích thước block, Conversations API
  (01/2026) cho nhiều agent chia sẻ memory block. Letta Code: coding agent #1 model-agnostic
  trên Terminal-Bench, kèm Skill Library + Context Repositories — memory commit/branch/rollback
  qua Git như code.
- Điểm yếu: agent được tin tưởng sửa core memory của chính nó — cần tool rules, exact-string
  edit, read-only flag, runtime enforcement; chi phí token/turn cao hơn 1,5–3×.
- Ý tưởng cho open-bot v1.14 (T1): memory blocks v13 — block versioning git-backed (snapshot/
  branch/rollback từng block), block templates theo task, block-level ACL (read-only/sensitive),
  memory compaction theo CoALA (episodic/semantic/procedural/working), self-audit tool-budget.
  Nối với memory blocks v12 (v1.12) + temporal KG v2 (v1.12) đã có.

## 2. OpenHands V1 SDK — CodeAct, event-sourced, tiny core (All-Hands-AI, MIT, 74k+ stars)
- V1 SDK (11/2025, paper arXiv 2511.03690): tách 4 package độc lập — SDK (agent definitions),
  Tools (action handlers), Workspace (execution env), Server (hosting). Agent là config object
  stateless; mọi state thay đổi nằm trong một `ConversationState` event-sourced duy nhất.
- Conversation = stream typed event **Action** ↔ **Observation** (Pydantic, immutable, replayable);
  event log append-only là single source of truth — replay log là tái tạo toàn bộ hội thoại.
- **CodeActAgent**: thay vì 20 tool hẹp, cho LLM bash + Python (Jupyter) + browser DSL và để nó
  viết code làm mọi việc. System prompt áp đặt methodology 4 pha: Exploration → Analysis →
  Implementation → Verification (chỉ `finish` khi verify pass). `ThinkTool` cho model chỗ suy luận
  không commit action. ~72–77% SWE-Bench Verified với model frontier.
- **LLMSecurityAnalyzer**: chấm mọi tool call LOW/MEDIUM/HIGH/UNKNOWN, pause xin xác nhận khi
  nguy hiểm. **Condenser**: nén context window (summarize/compress/prioritize). **RouterLLM**:
  đổi model giữa hội thoại (leo thang lên multimodal chỉ khi có ảnh). Multi-agent delegation
  qua tool call + stuck detection (5 pattern).
- Ý tưởng cho open-bot v1.14 (T3): coding agent v6 — event-sourced conversation log (replay/
  time-travel debug), CodeAct-lite v2 (bash+Python sandbox làm action language thống nhất),
  security analyzer chấm rủi ro từng tool call, condenser v2, stuck detection, delegation
  sub-agent qua tool. Nối với coding agent v5 git-native + eval (v1.13) và event-sourced (v1.12).

## 3. MCP spec 2026-07-28 — Tasks beta, Apps stable, core stateless
- Revision 2026-07-28: core stateless — bỏ handshake `initialize` và header `Mcp-Session-Id`;
  mỗi request mang protocol version + capabilities trong `_meta`; `server/discover` hỏi
  capability trước. Roots/Sampling/Logging deprecated (SEP-2577, xóa sớm nhất sau 2027-07-28).
- **Tasks** (`io.modelcontextprotocol/tasks`, beta, dự kiến vào core): server trả task handle,
  client poll `tasks/get`, `tasks/update` đưa input giữa chừng; 2026-07-28 thay `tasks/result`
  chặn bằng polling, bỏ `tasks/list`.
- **MCP Apps** (`io.modelcontextprotocol/ui`, stable, ext-apps v2.0.4 27/10/2026): tool khai
  `_meta.ui.resourceUri` → resource `ui://...`, MIME `text/html;profile=mcp-app`, iframe
  sandboxed, CSP deny-by-default (bundle single-file), `_meta.ui.permissions` xin mic/camera.
  Extension thương lượng 2 chiều — cả client và server đều phải khai `extensions`.
  Host đã hỗ trợ: Claude, ChatGPT, VS Code, Goose, Postman, MCPJam, Cursor, Microsoft 365
  Copilot, Archestra, PostHog Code. Ba host từng "đang xem xét" (01/2026) tới 08/2026 vẫn chưa có.
- Ý tưởng cho open-bot v1.14 (T2): MCP Apps v2 — capability negotiation đúng spec 2026-07-28
  (server/discover, `_meta` extensions), Tasks polling đúng chuẩn mới, App gallery + template
  (dashboard/form/chart/wizard), CSP builder + single-file bundler, permissions mic/camera.
  Nối với MCP Apps ui:// v1.13 và MCP Tasks v1.09/v1.10.

## 4. Mem0 vs Zep 2026 — memory layer: accuracy war đã kết thúc, chọn theo latency/token
- Mem0 (Apache-2.0, ~66k stars): thuật toán 04/2026 — extraction **add-only** một pass (không
  UPDATE/DELETE âm thầm), entity linking xuyên memory, retrieval đa tín hiệu song song
  (semantic + BM25 keyword + entity boost). LongMemEval 94,4%, LoCoMo 92,5% (GPT-5 làm reader
  + judge, depth 200), ~6,8–7,0K token/query, p50 ~0,9–1,1s. Graph memory (Mem0g) chỉ ở
  managed Pro $249/mo, đã gỡ khỏi SDK open-source.
- Zep/Graphiti (Apache-2.0 engine): temporal knowledge graph **bi-temporal** — mỗi fact mang 2
  timeline (thời gian thật trong thế giới + thời gian hệ thống biết). Fact mâu thuẫn không xóa
  mà ghi `invalid_at` (edge invalidation) — trả lời được "user sống ở đâu tháng 3?".
  LongMemEval 90,2%, LoCoMo 94,7%, p50 retrieval 87–104ms, 4,4–5,8K token/query (GPT-5.4).
  Zep Community Edition đã dừng 04/2025; Graphiti tự host trên Neo4j/FalkorDB/Neptune.
- Cognee (Apache-2.0): local-first KG memory, text → entity/relationship/chunk, graph + vector,
  chạy hoàn toàn local, không chứng chỉ SOC 2.
- Ý tưởng cho open-bot v1.14 (T1/T4): retrieval đa tín hiệu (semantic + BM25 + entity boost)
  cho memory v13, temporal query API ("đúng vào thời điểm X thì sao?") trên temporal KG v2,
  extraction add-only + invalidation thay vì overwrite, benchmark harness nội bộ kiểu
  LongMemEval/LoCoMo thu nhỏ để đo recall theo từng phiên bản.

## 5. Voice realtime 2026 — barge-in là constraint thiết kế, không phải corner case
- Hai kiến trúc: cascaded (STT → LLM → TTS, kiểm soát + audit trail, $0,04–0,13/phút) vs native
  speech-to-speech (latency thấp, prosody/interruption tích hợp, vendor lock-in, audio token đắt).
  Vendor realtime: OpenAI `gpt-realtime-2.1` (07/2026, ~25% giảm p95 latency), GPT-Live-1
  (09/2026, full-duplex), Google Gemini 3.8 Live. Transport: WebRTC (browser/mobile), WebSocket
  (server-to-server), SIP (điện thoại).
- Hermes Agent v0.20.0 (03/08/2026, Nous Research, MIT): streaming TTS theo clause (từng mệnh đề,
  time-to-first-audio <1s), barge-in ngắt giữa câu, wake word on-device, STT/TTS pluggable
  (Edge TTS / Whisper local / OpenAI), A2A v1.0 agent-to-agent.
- LiveKit Agents 1.8 (10/2026, Apache-2.0): WebRTC, turn detector đã train, Krisp noise cancel,
  graceful interruption 120–200ms, per-turn latency metrics, PSTN qua Telnyx/Twilio; stack mặc
  định 10/2026: Deepgram Nova-3/Flux STT + Claude Haiku 5.5 + Cartesia Sonic-3.6/Deepgram Aura-2,
  550–700ms end-to-end.
- Pipecat 1.7.0 (08/2026): Smart Turn v3.1 — semantic end-of-turn trên raw audio, 23 ngôn ngữ,
  12ms CPU, mặc định không cần config. Kyutai Unmute: STT-1B + LLM + TTS 1.6B, ~450ms production,
  1 GPU 16GB; Pocket TTS (01/2026): 100M param, CPU-only, ~200ms to first audio, 6 ngôn ngữ,
  clone voice từ WAV local.
- Pattern chung đáng học: **hủy việc đã lỗi thời** — khi user nói chen, flush TTS buffer + discard
  stale LLM work (CancelScope) trước khi nó thành audio thừa; VAD/STT/LLM/TTS tách queue/thread.
- Ý tưởng cho open-bot v1.14 (T5): voice v13 — barge-in engine (VAD + cancel scope + flush queue),
  streaming TTS clause-by-clause, Smart-Turn-style end-of-turn (ngữ nghĩa, không chỉ silence),
  latency budget dashboard (VAD/STT/LLM/TTS từng chặng), wake word local, provider pluggable
  (Edge TTS/Whisper local/Realtime API theo key của user). Nối với voice v12 barge-in/TTS
  streaming (v1.13). Live ảnh Gemini KHÔNG thử lại (key miễn phí quota ảnh = 0).

## 6. Hướng sóng v1.14 (6 đội, mục tiêu +30.000 dòng TS thật)
- T1 memory v13: git-backed blocks + multi-signal retrieval + temporal query (học Letta/Mem0/Zep).
- T2 MCP Apps v2 + Tasks chuẩn 2026-07-28: discover/negotiation, gallery/template, CSP bundler.
- T3 coding agent v6: event-sourced log + CodeAct-lite v2 + security analyzer + condenser v2
  (học OpenHands V1 SDK).
- T4 Composio + app integrations v2: polling v2, trigger catalog mở rộng, health dashboard,
  provider mới (học Composio MCP Apps + Tasks).
- T5 voice v13: barge-in engine + streaming TTS clause + latency budget (học Hermes/LiveKit/Pipecat).
- T6 platform/fleet v11 + UI: fleet health, rollout theo nhóm, UI panel cho memory/voice/MCP Apps.

## Nguồn
- sureprompts.com/blog/letta-memgpt-walkthrough · aiworkflowlab.dev (Mem0 vs Letta vs Zep 2026)
- chatforest.com/reviews/letta-memgpt-stateful-agent-framework · anhtu.dev (long-term memory 2026)
- dev.to/lynkr (OpenHands Ollama/Bedrock) · viblo.asia (OpenHands deep dive, V1 SDK paper)
- medium.com/data-science-collective (MCP Apps) · ajayk.sh (MCP 2026-07-28) · composio.dev (MCP Apps)
- atlan.com (Zep vs Mem0) · taku.ai (Mem0 alternatives) · particula.tech (Mem0/Zep/Letta/Cognee)
- lukeocodes.dev (Hermes v0.20.0) · forasoft.com (LiveKit 2026) · studio.smartrules.ai (open voice SOTA)
