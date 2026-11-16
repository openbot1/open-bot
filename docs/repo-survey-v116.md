# Khảo sát repo/hệ thống cho sóng v1.16 — 16/11/2026

CHỈ HỌC Ý TƯỞNG, không copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor.

## 1. OpenMausBot — bài học kiến trúc mới (11/2026)

- Harness server loopback `127.0.0.1:8799` sở hữu mọi agent process; transcripts/keys/events
  ở `~/.openmausbot`, không cloud telemetry, không proxy giữa chừng.
- Protocol normalization layer: `claude` trả `<tool_use>`, `codex` trả `function_call`,
  `grok` stream `tool_invocations` → hợp nhất thành một NDJSON event stream.
- Permission broker: mọi shell/file-write/computer-control/OAuth API đều chờ thẻ duyệt
  (Allow/Deny), giống nhau trên host / local VM / cloud desktop.
- Engines pluggable: trỏ engine tới CLI binary tùy chỉnh (Settings → Engines); model
  picker hiển thị Claude/Codex/Grok side-by-side, provider không khả dụng mờ đi kèm lý do.
- BotMRR: team packages di động (bot + personality + model + computer + apps) — agent
  composition dạng gói có thể chia sẻ.
- Điểm yếu đã biết: không pin/version CLI phụ thuộc → đổi format output là normalization
  gãy (từng gãy 2 tuần); API key plaintext trong config.json (0600); single-user.
- Ý tưởng cho open-bot v1.16 (T3/T6): CLI-format version probe + adapter versioning
  (mỗi CLI một adapter có version range, fallback khi format lạ), BotMRR-style team
  package export/import, permission broker thống nhất cho mọi execution target.

## 2. Memory: Mem0 v3 / Letta / Zep — cập nhật 11/2026

- **Mem0 v3** (04/2026): thuật toán mới chỉ 1 LLM call, chỉ ADD (không UPDATE/DELETE
  ở write-time); fact mới nằm cạnh fact cũ, retrieval mới quyết định cái nào còn đúng.
  LoCoMo 71.4 → 91.6, LongMemEval 67.8 → 93.4, p95 selective retrieval ~1.44s vs 17.12s
  full-context. Search fuse 3 tín hiệu: semantic + BM25 + entity match.
- **Letta**: sleep-time compute — background agent tự reorganize memory blocks lúc idle,
  không tốn turn của user. Core memory blocks (persona/human) agent tự edit qua tool;
  archival (vector) + recall (history) là 2 tầng ngoài.
- **Zep/Graphiti**: temporal KG, edge mang validity interval bi-temporal; contradiction
  làm invalid chứ không xóa — "cái gì đúng, và khi nào".
- Chuẩn đo: LoCoMo / LongMemEval; extracted-fact + graph hơn naive RAG 20–40 điểm.
  Rủi ro: OWASP ASI06 Memory & Context Poisoning, GDPR erasure, cross-tenant leakage.
- Ý tưởng cho open-bot v1.16 (T1): memory v15 — consolidation kiểu Mem0 v3 (add-only +
  retrieval-time supersede), temporal KG v3 (validity intervals + contradiction
  invalidation), Letta blocks v2 (versioned blocks + sleep-time reorganizer), hybrid
  search v2 (vector + graph + BM25 + recency, có eval set đo recall/precision).

## 3. MCP 2026-07-28 stateless core + Skills over MCP (SEP-2640)

- Core stateless: bỏ `initialize`/`Mcp-Session-Id`; mỗi request tự chứa version +
  capabilities trong `_meta`; `server/discover` bắt buộc phía server; multi round-trip
  thay server-initiated request (server trả `input_required`, client retry kèm đáp án);
  `subscriptions/listen` thay GET stream + `resources/subscribe`.
- Extensions đàm phán qua capabilities: Tasks (`io.modelcontextprotocol/tasks` —
  durable handle, poll progress, resume sau reconnect), Skills SEP-2640 final 09/2026
  (`io.modelcontextprotocol/skills`: `skills/list`/`skills/get`, resource `skill://…`,
  SKILL.md theo agentskills.io — Claude Code/Codex/Gemini CLI/Copilot/Cursor đều hỗ trợ
  format này), MCP Apps (`ui://`, iframe sandbox).
- Deprecated (xóa sớm nhất 28/07/2027): Roots, Sampling, Logging, HTTP+SSE.
- Claude Code giờ defer MCP tool definitions (chỉ load tên + server instructions,
  tool search khi cần) → giảm context cost.
- Ý tưởng cho open-bot v1.16 (T2): Tasks long-running v2 (poll/resume/reconnect),
  Skills-over-MCP đầy đủ (list/get/skill:// + skill-loading path có verify + approval),
  server/discover matrix + version negotiation, multi-round-trip input_required v2.

## 4. Local model router: llama.cpp router mode + llama-swap (2026)

- **Router mode** (llama.cpp, từ 12/2025): `llama-server` không `-m` → router; route
  theo `model` (OpenAI-compatible), load on-demand, LRU unload ở `--models-max`, mỗi
  model một child process riêng (crash một model không kéo sập router), switch 3–10s.
  `--models-dir` (quét GGUF), `--models-preset` (INI per-model flags), `--models-max`
  đếm model chứ không đếm VRAM — phải set theo VRAM thật. TTL idle unload.
- **llama-swap** (Go proxy): ngồi trước mọi OpenAI-compatible server, groups quy định
  model nào được chia GPU, "embedder luôn resident" — dùng khi nhiều backend
  (llama.cpp + vLLM + speech server).
- Thực hành: Qwen3-4B GGUF Q4_K_M ~2.5 GB default fleet; 7B Q4 30–80 tok/s Apple
  Silicon; KV cache 8k ctx ≈ 1.15 GB; bind 127.0.0.1 + API key.
- Ý tưởng cho open-bot v1.16 (T3): router v2 — discovery models-dir/preset, per-model
  flags, LRU + TTL unload, crash isolation, swap-groups, model picker v2 (chấm điểm
  task → model theo cost/latency/quality), auto-detect CLI agents sâu hơn.

## 5. OpenHands V1 SDK — coding agent (nối v1.15)

- Agent = pure function history → next Action; Conversation sở hữu ConversationState
  duy nhất (mutable); EventLog append-only là single source of truth (replay/fork/
  pause/audit miễn phí). 4 package: SDK / Tools / Workspace / Server.
- CodeActAgent: không 20 tool bespoke — bash + Python + browser DSL, agent tự biểu
  diễn action bằng code. Microagents V0 → Skills V1. SWE-Bench Verified ~77%
  (Claude Sonnet 4.5), 71.8% submission chính thức; Devstral 24B open-weight ~46.8%.
- 1.0 (16/12/2025): Docker sandboxing, security policies, resource limits, plugin
  system; Agent Canvas là control center tự host (CLI repo cũ không còn duy trì).
- Ý tưởng cho open-bot v1.16 (T4): coding agent v8 — repo map PageRank v3 (tree-sitter
  incremental), multi-file refactor an toàn (plan → preview diff → apply → verify),
  test-generation tự động cho code đổi, security analyzer v2 (taint lite + secret scan).

## 6. Voice realtime 2026 — ngân sách 300ms

- Ngưỡng hội thoại tự nhiên: inter-turn gap 200–300ms (Stivers et al. PNAS 2009);
  >500ms user cảm nhận lag, >1000ms coi như đứt.
- Pipeline cổ điển STT→LLM→TTS: 1.5–3s; speech-to-speech (OpenAI Realtime
  `gpt-realtime` GA 28/08/2025, Gemini Live): 300–600ms end-to-end.
- Ngân sách từng tầng (production 2026): VAD 50–150ms (Silero VAD v5 ~30ms/frame,
  threshold 0.65), STT 100–300ms partial (Deepgram Nova-3 ~110–160ms, Flux semantic
  ~25ms), LLM TTFT 300–800ms, TTS TTFA 75–200ms (Cartesia Sonic ~40ms, ElevenLabs
  Flash v2.5 ~75ms, Deepgram Aura-2 <200ms), orchestrator 20–50ms (LiveKit Agents
  1.5.x adaptive turn detection + MCP tools, Pipecat Smart Turn v3.1, 23 ngôn ngữ).
- Barge-in: `response.cancel` khi `speech_started`; flush TTS buffer + discard stale
  LLM work (CancelScope) trước khi thành audio thừa; min-speech 250ms, min-silence
  450ms. Semantic turn detection (không chỉ VAD) giảm false end-of-turn cả chục lần.
- Ý tưởng cho open-bot v1.16 (T5): voice v15 — speech-to-speech path (adapter
  Realtime/Live, mock-first), pipeline v3 với budget từng tầng + alert, barge-in v3,
  semantic turn-taking v3, TTS streaming v3, wake word v3, provider registry v2.

## 7. A2A / AG-UI / A2UI — nối v1.15

- A2A v1.0 (03/2026): Agent Card có ký, version negotiation, multi-tenancy, 3 binding
  tương đương (JSON-RPC/gRPC/REST); task lifecycle hàng giờ, pause chờ human.
- AG-UI 1.0 (CopilotKit, 09/2026): một request, một stream sự kiện có thứ tự
  (31 event type, 8 nhóm); interrupt-and-resume hạng nhất; subagent events.
- A2UI 1.0 (Google, 10/2026): generative UI từ catalog của app, chạy trên AG-UI.
- Ý tưởng cho open-bot v1.16 (T2): A2A signed card + multi-tenancy v2, AG-UI event
  stream v2 (subagent events, interrupt/resume), A2UI generative UI v2.

## 8. Hướng sóng v1.16 (6 đội, mục tiêu +30.000 dòng TS thật)

- T1 memory v15: Mem0-v3 consolidation + temporal KG v3 + Letta blocks v2 + hybrid search v2 có eval đo được.
- T2 protocols v2: MCP Tasks v2 + Skills-over-MCP (SEP-2640) + discover/negotiation v2 + A2A signed card v2 + AG-UI/A2UI v2.
- T3 local-model router v2: llama.cpp router-mode v2 + swap-groups + model picker v2 + auto-detect CLI agents sâu + fallback chain.
- T4 coding agent v8: repo map PageRank v3 + multi-file refactor an toàn + test-generation tự động + security analyzer v2.
- T5 voice v15: speech-to-speech path + pipeline v3 (budget từng tầng) + barge-in v3 + semantic turn-taking v3 + wake word v3.
- T6 platform/fleet v13 + UI: multi-user/team v2 + rollout theo nhóm v2 + Composio polling v3 + app mới + fleet v13 + UI panel mới.

## Nguồn

- hysenlabs.com / starlog.is / hotrepo.ai / frontiernow.dev / anchorterminal.com (OpenMausBot 11/2026)
- codeyashu.github.io / kenhuangus.substack.com / dataaspirant.com / aiworkflowlab.dev / reactify-solutions.com (Mem0 v3 / Letta / Zep 2026)
- irurueta.com / cohorte.co / joost.blog / blog.linux-ng.de (MCP 2026-07-28, SEP-2640)
- bigiron.cc / freshlab.es / glukhov.org / aquanode.io / skjoldrun.github.io (llama.cpp router mode)
- docs.masst.dev / autointerviewai.com / reactify-solutions.com / teachaitools.blog (voice realtime 2026)
- dev.to / viblo.asia (OpenHands V1 SDK, arXiv 2511.03690)
