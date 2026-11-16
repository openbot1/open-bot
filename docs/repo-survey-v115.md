# Khảo sát repo/hệ thống cho sóng v1.15 — 16/11/2026

CHỈ HỌC Ý TƯỞNG, không copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor.

## 1. Bộ ba giao thức agent 2026 (MCP + A2A + AG-UI/A2UI)

- **MCP 2026-07-28** (hiện hành): core stateless — bỏ `initialize` handshake và
  `Mcp-Session-Id`; mỗi request tự chứa version + capabilities trong `_meta`;
  `server/discover` bắt buộc; multi round-trip thay server-initiated request
  (server trả `input_required`, client retry kèm đáp án). Extensions: MCP Apps
  (`ui://` resource, HTML tương tác trong iframe sandbox, JSON-RPC về host),
  Tasks (long-running: task id + `tasks/get`/`tasks/update`), Skills over MCP,
  auth OAuth 2.1/OIDC. Deprecated (xóa sớm nhất 28/07/2027, chính sách 12 tháng):
  Roots, Sampling, Logging, HTTP+SSE. Tier 1 SDK: TS, Python, Go, C#, Rust, Ruby.
  MCP + A2A cùng thuộc Agentic AI Foundation (Linux Foundation).
- **A2A v1.0** (03/2026, v1.0.1 tháng 05): Agent Card có ký, version negotiation,
  multi-tenancy, 3 binding (JSON-RPC, gRPC, HTTP+JSON/REST) tương đương chức năng.
  Task lifecycle chạy hàng giờ, pause chờ human. Gia nhập AAIF 17–27/08/2026.
- **AG-UI 1.0** (CopilotKit, 17–30/09/2026): agent → user interface. Một request,
  một stream sự kiện có thứ tự (31 event type, 8 nhóm: lifecycle, text, tool call,
  state, interrupt...). Schema-first: JSON Schema sinh SDK TS/Python/.NET.
  Interrupt-and-resume hạng nhất: agent pause giữa run, đẩy form/approval lên
  frontend, block chờ user. Token usage theo provider/model trên terminal events.
  Subagent events (`SUBAGENT_STARTED/FINISHED/ERROR`, `subagentRunId`).
  Tích hợp: LangGraph, CrewAI, Mastra, AG2, LlamaIndex, Agno, Pydantic AI,
  Microsoft Agent Framework, Google ADK, AWS Strands, Claude Agent SDK.
- **A2UI 1.0** (Google, 10/2026): generative UI — agent trả UI từ catalog của app
  (18 basics + component riêng), chạy trên AG-UI. CopilotKit Generative UI: 70
  component sẵn. Phân biệt AG-UI (event stream) vs A2UI (declarative UI state).
- **NANDA** (MIT): meta-layer trên MCP + A2A + NLWeb — discovery, identity,
  routing phi tập trung cho Internet of Agents.
- Ý tưởng cho open-bot v1.15 (T2): AG-UI 1.0 event stream nội bộ (run/step/tool/
  state/interrupt), A2UI-style generative surfaces trong renderer, A2A v1.0
  signed Agent Card + version negotiation, migrate MCP client sang stateless
  2026-07-28 (bỏ session handshake, `server/discover`, Tasks extension).

## 2. Memory: Mem0 v3 / Letta / Zep-Graphiti (tình hình 10/2026)

- **Mem0 v3** (04/2026, ~60k stars, Apache-2.0): extract facts bằng LLM → vector
  store (+ graph tùy chọn); API `add/search/update/delete/get_all`, scoping
  user/agent/run; retrieve = semantic + keyword + entity fusion. LoCoMo 92.5,
  LongMemEval 94.4 (theo trang research 2026). Hosted $19–$249/mo; OSS không còn
  external graph store.
- **Letta** (ex-MemGPT, ~24k stars): stateful agent OS — core memory blocks
  (persona/human, agent tự edit qua tool), archival memory (vector), recall
  memory (history). Source chuyển sang letta-ai/letta-code; V1 API server retired.
  Chi phí token/turn 1.5–3× do core memory luôn trong context.
- **Zep / Graphiti** (~28k stars): temporal knowledge graph, bi-temporal validity,
  hybrid search (semantic + BM25 + graph). Zep Community Edition không còn được
  hỗ trợ; Graphiti Kuzu backend deprecated.
- Chuẩn đo: LOCOMO / LongMemEval; extracted-fact và graph memory hơn naive RAG
  20–40 điểm recall precision. Rủi ro: **OWASP ASI06 Memory & Context Poisoning**,
  GDPR erasure, cross-tenant leakage — cần deletion path + defence chống memory
  poisoning (capstone yêu cầu: measured recall/precision + erasure + poisoning
  defence).
- Ý tưởng cho open-bot v1.15 (T1): memory v14 — Mem0-style fact extraction +
  temporal KG v3 (validity intervals, supersede), retrieval fusion 3 tín hiệu,
  memory poisoning defence (quarantine + provenance + judge), GDPR erasure path,
  eval set recall/precision đo được.

## 3. OpenHands V1 SDK (MLSys 2026, MIT, ~74k stars, v1.7.0 05/2026)

- V1 (paper arXiv 2511.03690) tách V0 monolith thành 4 package độc lập: SDK (agent
  definitions), Tools, Workspace (execution env), Server. Agent = pure function
  từ event history → next event; mọi state mutable nằm trong một `ConversationState`
  event-sourced duy nhất. Conversation = stream typed Action/Observation events
  (Pydantic, immutable, replayable) — pause/resume/fork/replay/audit miễn phí.
  LocalConversation vs RemoteConversation (HTTP/WebSocket) không đổi code.
- CodeActAgent: không 20 tool bespoke — cho bash + Python (Jupyter) + browser DSL,
  agent tự biểu diễn action bằng code. Microagents V0 → **Skills** V1.
  Benchmark: 77.6% SWE-Bench Verified (Claude 3.5 Sonnet Thinking, V0),
  72.8% + 67.9% GAIA (Claude Sonnet 4.5, V1). V1 giảm 61% system-attributable
  failures sau 15 ngày production; event-sourcing overhead không đáng kể.
- Ý tưởng cho open-bot v1.15 (T4): coding agent v7 — agent stateless + event log
  append-only (replay/fork/pause), CodeAct-lite v3, condenser v3, security
  analyzer trước khi chạy code, Skills kiểu microagents.

## 4. Local model router (llama.cpp router mode, 2026)

- **llama-server router mode** (2026): một process quản nhiều model, route theo
  `model` (OpenAI-compatible API), load on-demand, LRU unload ở `--models-max`,
  mỗi model một process riêng, switch 3–10s. llama.cpp >100k stars.
- Thực hành: Qwen3-4B (Apache 2.0, GGUF Q4_K_M 2.5 GB, 32k ctx) là default cho
  fleet; Llama 3.2 3B; 7B Q4 ~30–80 tok/s trên Apple Silicon; 70B Q4 8–20 tok/s.
  Gateway pattern: LiteLLM proxy (virtual keys, budgets, rate limits, spend
  tracking) trước llama.cpp chỉ listen 127.0.0.1. KV cache 8k ctx ≈ 1.15 GB.
- Cảnh báo: đừng build fleet feature trên model do OS cung cấp — Apple đổi model
  theo OS release; Microsoft gỡ Phi Silica khỏi retail Windows 01/2027. Pin model
  của mình (GGUF từ publisher), Foundry Local chỉ cho Windows NPU pilot.
- Ý tưởng cho open-bot v1.15 (T3): local model router — registry model local
  (Ollama + llama.cpp router-mode-style), LRU load/unload theo RAM, routing theo
  cost/latency/quality (task nhỏ → 3–4B local, code nặng → cloud), budget +
  spend tracking nội bộ, model catalog Qwen3/Llama/Gemma có license rõ.

## 5. Voice realtime (nối v1.13–v1.14)

- Stack mặc định 10/2026: Deepgram Nova-3/Flux STT + Claude Haiku 5.5 + Cartesia
  Sonic-3.6/Deepgram Aura-2, 550–700ms end-to-end (LiveKit Agents 1.8).
  Pipecat Smart Turn v3.1: semantic end-of-turn, 23 ngôn ngữ, 12ms CPU.
  Kyutai Unmute ~450ms; Pocket TTS 100M param CPU-only ~200ms first audio.
  Pattern: khi user chen ngang — flush TTS buffer + discard stale LLM work
  (CancelScope) trước khi thành audio thừa; VAD/STT/LLM/TTS tách queue/thread.
- Ý tưởng cho open-bot v1.15 (T5): voice v14 — speech-to-speech latency budget v2
  (per-stage metrics + alert), provider pluggable mở rộng (Deepgram/Cartesia/
  local Whisper + Pocket-TTS-style), turn-taking semantic v2, wake word v2.

## 6. Hướng sóng v1.15 (6 đội, mục tiêu +30.000 dòng TS thật)

- T1 memory v14: fact extraction + temporal KG v3 + poisoning defence + GDPR erasure + eval đo được (học Mem0 v3 / Zep / Letta, OWASP ASI06).
- T2 protocol triad: AG-UI 1.0 event stream + A2UI generative surfaces + A2A v1.0 signed cards + MCP stateless 2026-07-28.
- T3 local model router: multi-model LRU (llama.cpp router-style) + gateway budget + model catalog có license.
- T4 coding agent v7: stateless agent + event log replay/fork + CodeAct-lite v3 + condenser v3 + security analyzer (học OpenHands V1 SDK).
- T5 voice v14: latency budget v2 + provider pluggable mở rộng + semantic turn-taking v2.
- T6 platform/fleet v12 + UI: fleet local-model pinning, rollout theo nhóm, UI panel cho AG-UI/A2UI + memory + router.

## Nguồn

- aiworkflowlab.dev (Mem0 vs Letta vs Zep 2026) · codeyashu.github.io (memory systems) · dev.to/plur9 · developersdigest.tech (10/2026)
- dev.to/lynkr (OpenHands) · proceedings.mlsys.org (V1 SDK paper) · viblo.asia (OpenHands deep dive)
- hubagenticai.com (protocol stack) · metavert.io (MCP) · qubittool.com · querynow.com · maximem.ai (MCP vs A2A)
- reactify-solutions.com (AG-UI) · motiontic.com · smfclearinghouse.com (AG-UI 1.0) · agentriot.com · copilotkit.pro (A2UI 1.0)
- freshlab.es (llama.cpp router) · beri.net (on-device LLM fleet) · medium.com/@nelsonandre (local gateway) · library.lucassantana.tech
