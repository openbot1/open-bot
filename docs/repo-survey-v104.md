# Repo survey — v1.04 (14/11/2026)

Nghiên cứu cho chu kỳ v1.04. CHỈ HỌC Ý TƯỞNG, không copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor.

## 1. MCP 2.0 — spec 2026-07-28 (stateless rewrite)

Nguồn: sota.io (30/07/2026), agentic-academy.ai, codex.danielvaughan.com (31/07/2026), appstackbuilder.com, atozofsoftwareengineering.blog (12/11/2026). Bản sửa lớn nhất kể từ khi MCP ra mắt (11/2024, Anthropic; 12/2025 donate cho Agentic AI Foundation / Linux Foundation).

- **Stateless core (SEP-2575):** bỏ `initialize`/`notifications/initialized` handshake, bỏ header `Mcp-Session-Id`, bỏ SSE resumability và `ping`, `logging/setLevel`. Mọi request tự mang protocol version + client capabilities trong `_meta` (`io.modelcontextprotocol/protocolVersion`, `io.modelcontextprotocol/clientCapabilities`). Version mismatch trả `UnsupportedProtocolVersionError` chuyên biệt. Lợi ích: request nào cũng vào được instance nào sau load balancer round-robin thường.
- **`server/discover` bắt buộc:** server phải implement để quảng bá version hỗ trợ, capabilities, identity. Client gọi trước hoặc dùng làm backward-compat probe qua stdio.
- **MRTR — Multi Round-Trip Requests (SEP-2322):** thay toàn bộ server-initiated request (`roots/list`, `sampling/createMessage`, `elicitation/create`). Server trả result có `resultType: "input_required"` kèm câu hỏi; client gọi lại request gốc với `inputResponses` đính kèm. Không giữ stream mở.
- **Tasks thành extension chính thức** (`io.modelcontextprotocol/tasks`, SEP-2663): bỏ blocking `tasks/result`, thay bằng poll `tasks/get` (trạng thái `working`/`input_required`/`completed`/`failed`/`cancelled`) + `tasks/update` gửi input giữa chừng; bỏ `tasks/list`; server được trả task handle mà không cần client opt-in trước.
- **Extensions thành cơ chế chính thức:** `extensions` field trên cả `ClientCapabilities` và `ServerCapabilities`. MCP Apps (`io.modelcontextprotocol/ui`, SEP-1865, stable từ 26/01/2026) — HTML tương tác trong sandboxed iframe; Enterprise-Managed Authorization.
- **List endpoints cacheable:** `tools/list`, `prompts/list`, `resources/list`, `resources/read` trả thêm `ttlMs` + `cacheScope`.
- **Deprecation policy chính thức (SEP-2577):** Roots/Sampling/Logging + legacy HTTP+SSE transport deprecated, cửa sổ tối thiểu 12 tháng, earliest removal 2027-07-28. Mọi result bắt buộc có field `resultType`.
- **OAuth:** iss validation bắt buộc (theo brief chu kỳ; khớp hướng siết auth của spec mới).
- Ý tưởng áp dụng cho open-bot v1.04 (đội T2): stateless core + `server/discover` + fallback handshake server cũ (2025-11-25 trở xuống), MRTR thay elicitation/sampling callback, Tasks extension poll-based, MCP Apps v2 (khai báo UI template trước để prefetch/cache/review + audit path), cảnh báo deprecation có migration path.

## 2. Harness Engineering — Anatomy of Eleven Systems (arXiv 2609.00006, 07/2026)

Nguồn: paper + survey v1.03 (đã đọc kỹ ở v1.03). Đào sâu thêm cho v1.04:

- Định nghĩa: **agent = model + harness** — runtime nối LLM với thế giới qua loop, tools, context management, safety, orchestration, extension surfaces. Harness engineering thành discipline riêng đầu 2026.
- 7 subsystem chuẩn của mọi harness; 13 cross-cutting observations; catalog **29 recurring design pattern**; 18 design recommendations; scaffold harness tối thiểu 90 dòng.
- Hội tụ thành bắt chước: Codex dùng nguyên hook vocabulary của Claude Code + importer session/settings; OpenHands đọc plugin format Claude Code; ACP có mặt ở 6/11 hệ và thêm vai trò thứ 3 là *harness hosting* (OpenHands chạy Claude Code/Codex/Gemini CLI làm backend thay thế được).
- Policy hành vi chuyển từ prompt prose sang config (versioned, validate được, audit được).
- Không harness nào import framework agent đa năng (LangChain/LangGraph/AutoGen...); không harness nào retrieve code bằng vector embeddings — hai điểm này là lời nhắc: open-bot nên giữ harness tự chủ, retrieval code nên dùng repo map cấu trúc thay vì vector mù.
- Ý tưởng áp dụng cho open-bot v1.04 (đội T3): hook system đầy đủ (PreToolUse/PostToolUse/SessionStart/SessionEnd/Stop/SubagentStop), policy-as-config versioned, session importer Codex + Claude Code, plugin format compat, scaffold harness tối thiểu chạy được làm tài liệu tham chiếu.

## 3. Memory 2026 — Mem0 v3, Graphiti/Zep, Cognee, Hindsight, Letta

Nguồn: membase.com, atlan.com, unabyss.com, ithub.directory (kiểm tra 10–11/2026).

- **Mem0 v3 (mem0ai/mem0, ~65.6k stars, Apache 2.0):** extraction single-pass **ADD-only** — một LLM call per `add()`, chỉ append, không còn UPDATE/DELETE. Fact mới lưu cạnh fact cũ; retrieval ranking (time-aware) quyết định fact nào thắng. **Graph memory BỎ khỏi OSS SDK** (các driver Neo4j/Memgraph/Kuzu/Apache AGE/Neptune đều gỡ) — chỉ còn trên Mem0 Platform Pro $249/tháng. Self-hosted mất cả memory decay và temporal reasoning. Đây là khoảng trống lớn cho bản tự host: open-bot tự host graph memory là lợi thế cạnh tranh thật.
- **Thay thế tự host:** Graphiti (Zep engine, ~31.9k stars, Apache 2.0, bi-temporal, MCP server riêng, backend Neo4j/FalkorDB/Neptune), Cognee (~31.2k stars, Apache 2.0, graph + vector từ document/code, MCP server + plugin Claude Code/Codex, free self-host), Hindsight (MIT, 4-strategy TEMPR rerank, tự báo 91.4% LongMemEval, free self-host).
- **Graphiti/Zep (arXiv 2501.13956):** mọi node/edge mang `valid_at`/`invalid_at`; mâu thuẫn thì invalidate chứ không xóa; bi-temporal (thời gian sự kiện + thời gian ghi nhận).
- **Letta (~25k stars, MemGPT lineage):** agent tự sửa memory blocks (persona/human) bằng tool; archival memory vector store; shared memory blocks cross-agent; sleep-time agents consolidate giữa session.
- Ý tưởng áp dụng cho open-bot v1.04 (đội T1): ADD-only fact store + contradiction ranking (thay thế phần graph Mem0 đã bỏ, tự host 100%); temporal KG v2 bi-temporal (validity intervals, invalidate-not-delete, truy vấn "đúng tại thời điểm T"); ingestion kiểu Cognee từ file/repo thành graph có provenance; consolidation v2 + memory health dashboard.

## 4. OpenHands V1 SDK — đào sâu cho agent server v2

Nguồn: survey v1.03 (dev.to, viblo, arXiv 2511.03690) + brief chu kỳ.

- V0 → V1 (11/2025): monolith 140+ config field/15 class → 4 package độc lập: **SDK** (agent definitions), **Tools** (action handlers), **Workspace** (execution environments), **Server** (hosting). ~72% SWE-Bench Verified (brief chu kỳ; survey v1.03 ghi ~77% với Claude Sonnet 4.5 — con số khác nhau theo benchmark run, không dùng làm claim tuyệt đối), 91k+ stars.
- Quyết định kiến trúc quan trọng nhất: **event-sourced, stateless agent**. Mọi mutable context nằm trong một `ConversationState`; conversation là stream typed event bất biến (Action/Observation), replayable. Pause, resume, fork, deterministic replay, audit trail đều miễn phí nhờ đó.
- **CodeActAgent:** thay vì 20 tool bespoke, cho LLM bash + Python (Jupyter) + browser DSL; mọi hành động biểu diễn bằng code; contract Action → Execution → Observation.
- Agent là pure function từ event history → next event; `Conversation` factory tự chọn Local/Remote theo config.
- Ý tưởng áp dụng cho open-bot v1.04 (đội T4): event log append-only có replay/snapshot/fork/time-travel; agent server REST v2 (conversations, pause/resume/cancel, SSE/WebSocket); CodeAct v2 (bash+python+editor, sandbox local); multi-agent delegation qua tool call; condenser v2 nhiều chiến lược + đo token saved.

## 5. Hướng đội v1.04 (từ survey này)

- **T1 memory v5:** ADD-only fact store + contradiction ranking; temporal KG v2 bi-temporal; ingestion Cognee-style; consolidation v2 + health dashboard.
- **T2 MCP 2.0:** stateless core + server/discover + fallback; MRTR; Tasks extension; MCP Apps v2; deprecation Roots/Sampling/Logging.
- **T3 harness engineering:** hook system; policy-as-config; session importer Codex/Claude Code; plugin format compat; scaffold tối thiểu.
- **T4 event-sourced SDK + agent server v2:** replay/snapshot; REST agent server; CodeAct v2; multi-agent delegation; condenser v2.
- **T5 voice realtime v3 + sửa gốc lỗi CI:** full-duplex v2 (VAD, turn-taking, barge-in); voice profiles; live transcription streaming; voice-driven tool calls; sửa scripts/tts-live-v082 + v083 assert cứng espeak-ng (engine theo platform / skip khi thiếu).
- **T6 platform/fleet v3 + eval harness v2:** fleet scheduler v2 (multi-machine dispatch, heartbeat, work stealing); SWE-bench-style local evals + contamination-free runner + benchmark harness; telemetry v2 (cost/latency, OTLP export, tắt mặc định).

## 6. Ghi chú đội T1 — Memory v5 (chi tiết)

Nguồn: tài liệu Mem0 (mem0.ai — "Mem0 v3: append-only memory"),
Zep/Graphiti (docs.getzep.com — bi-temporal knowledge graph,
"invalidate, don't delete"), Cognee (docs.cognee.ai — "ingest →
chunk → knowledge graph") — chỉ đọc mô tả kiến trúc công khai,
không lấy code.

- **Mem0 v3 (2026)**: chuyển từ update/delete tại chỗ sang
  append-only — fact mới luôn ADD cạnh fact cũ; retrieval ranking
  quyết định fact nào thắng; fact mâu thuẫn bị hạ hạng thay vì bị
  xóa. Áp dụng: `graph/addOnly.ts` — append thuần + ranking
  (confidence/recency/support/freshness − contradiction penalty)
  + supersession tường minh có ngưỡng (confidence + gap điểm).
  Khác biệt so với Mem0: ranking của open-bot là luật xác định,
  không cần LLM judge; supersession vẫn giữ chuỗi lịch sử của
  TemporalGraphStore thay vì chỉ dựa vào ranking lúc đọc.
- **Graphiti (Zep)**: edge mang validity intervals tách biệt
  transaction time (lúc ghi nhận) và valid time (lúc sự kiện
  đúng); mâu thuẫn thì invalidate edge (đóng cửa sổ hiệu lực) chứ
  không xóa node/edge. Áp dụng: `graph/biTemporal.ts` — fact của
  open-bot đã bi-temporal từ v0.98, v5 thêm `invalidateFact`
  (kèm audit JSONL + lý do bắt buộc), truy vấn hai trục
  `queryFactsAtBiTemporal(T, R)` ("đã biết gì tại R về thời
  điểm T"), `edgeValidityIntervals` + overlap, `factVersionTimeline`.
- **Cognee**: pipeline ingest file/repo → chunk (theo cấu trúc
  tài liệu) → trích entity/relation thành graph → dedup →
  provenance ghi rõ nguồn từng triple. Áp dụng:
  `graph/ingest.ts` — chunk theo heading/fence/đoạn văn có
  overlap, dedupe chunk bằng hash + dedupe fact bằng key chuẩn
  hoá, mỗi chunk/turn là một episode (provenance), ingest
  text/file/directory/transcript qua cùng `consolidateCandidates`
  (nghi ngờ → quarantine).
- **Consolidation v2 + health**: sleep-time consolidation có
  scoring (kế thừa scored dream v1.03) + health metrics
  (contradiction rate, staleness, coverage/orphan, quarantine
  backlog) + trend theo log — dashboard trong MemoryV5View.

### Phát hiện trùng / chưa có (so với main v1.03)

Đã có trên main, KHÔNG làm lại: temporal graph + supersession +
quarantine (v0.98), validity windows + judge + scored dream +
scoped retrieval (v1.03), shared-block groups (v1.03), one-pass
extraction + fused retrieval (v1.02).

Chưa có, v5 xây mới: ADD-only append + retrieval ranking +
ranking supersession có ngưỡng; invalidate vì mâu thuẫn + audit
log; truy vấn bi-temporal hai trục; edge validity intervals +
overlap; ingestion file/repo/transcript có chunk + dedup +
provenance; memory health score + trend; consolidation v2 gộp
(dedupe + ranking + sweep + prune orphan + dream); health
dashboard UI.

### Giới hạn ghi nhận

- Extractor rule-based nên tài liệu kỹ thuật cho ít fact
  (interface `FactExtractor` đã có sẵn cho LLM extractor sau này).
- Ranking xác định, chưa dùng embedding (cố tình local-first).
- Consolidation v2 chạy tay; chưa nối sleep agent tự động.

## 7. Ghi chú đội T2 — Trạng thái MCP trên main v1.03 (chi tiết)

Module `packages/core/src/mcp/` đã có 16.832 dòng. Các sóng v0.97 T1 và
v0.98 T6 đã xây **primitives MCP 2.0** (spec 2026-07-28, chỉ học ý tưởng
từ spec công khai), nhưng chúng mới là opt-in, chưa nối thành đường
mặc định:

- `stateless.ts` (382 dòng): `MCP_PROTOCOL_VERSION_2026 =
  '2026-07-28'`, `buildStatelessMeta` / `parseStatelessMeta`,
  `discoverServer` (`server/discover`), `requestStateless`,
  `buildServerDiscoverResult`. Client opt-in qua
  `McpServerConfig.stateless`; `connectMcp` khi đó gọi `discover`
  thay cho `initialize`.
- `mrtr.ts` (393 dòng): MRTR (SEP-2322) — `resultType`
  `complete | needs_input | needs_sampling | needs_elicitation |
  needs_roots | needs_confirmation`, `parseMrtrResult`,
  `buildMrtrResult`, `runMultiRoundTrip` (mặc định 8 round), state
  tiếp tục đi trong `_meta.roundTrip` + `previousAnswers`.
- `tasks.ts` (522 dòng): `TaskHandle` hai backend —
  `specVersion '2025-11-25'` (có `tasks/result` blocking +
  `tasks/list`) và `'2026-07-28'` (extension chính thức
  `io.modelcontextprotocol/tasks`: `tasks/get` trả luôn kết quả,
  thêm `tasks/update`, bỏ `tasks/result`/`tasks/list`).
- `taskStore.ts` / `taskManager.ts`: store phía server đã có
  `requestInput()` / `update()` / `cancel()`; `toHandleData()` đã
  kèm `result` khi `completed` và `error` khi `failed` — tức
  `tasks/get` trên extension 2026 đã trả kết quả cuối, không cần
  sửa store.
- `deprecation.ts` (263 dòng): SEP-2577 — sampling / roots /
  logging deprecated từ 2026-07-28, earliest removal 2027-07-28;
  `DeprecationShim` cảnh báo đúng 1 lần/method + đếm lần sau,
  `checkDeprecatedCapabilities` ghi nhận capability cũ trong
  `initialize` / `_meta`. Server đã nối shim (server.ts).
- `apps.ts` (770 dòng) + `appsManager.ts` (168 dòng): MCP Apps v1 —
  validate HTML (union chính sách chặt nhất hai sóng), CSP +
  sandbox `allow-scripts`, `AppManager` giữ tối đa 10 app mở.
  Chưa có: khai báo template trước, prefetch/cache, review,
  audit cho action khởi phát từ UI.
- `client.ts` (2.558 dòng): `discover()` trả null khi server
  pre-2.0; `connectMcp` stateless chỉ discover rồi tiếp tục
  stateless — **không fallback về handshake `initialize`** khi
  gặp server 2025-11-25 trở xuống; `request()`/`requestInner()`
  **không tự gắn `_meta` stateless** vào mỗi request (chỉ gắn
  `progressToken` khi có onProgress); `callTool` không nhận biết
  `resultType` — `runMultiRoundTrip` mới chỉ được dùng trong
  `packages/tools/src/mcpV097Tools.ts`, chưa nối vào client.
- `server.ts` (1.373 dòng): đã phục vụ `server/discover` trước
  cả gate initialize, đã chấp nhận request stateless qua `_meta`
  (parse + negotiate + ghi deprecation notice), đã có
  `tasks/update`. Nhưng vẫn phục vụ **`tasks/result` và
  `tasks/list` vô điều kiện** (khi `tasksEnabled`) — theo spec
  2026 hai method này phải biến mất khi server thương lượng
  2026-07-28. `tools/call` bọc mọi kết quả handler thành content
  block — handler không có đường nào trả `resultType` MRTR.
- `auditLog.ts` (643 dòng): `McpAuditLog.record()` đã redact args,
  hash-chain; có sẵn `direction: 'client' | 'server'`,
  `outcome: 'ok' | 'tool-error' | 'error' | 'cancelled'`,
  `caller`, `tool`, `resourceUri` — đủ để audit action từ App UI
  mà không cần sửa log.
- `elicitation.ts` (642 dòng) + `clientHandlers.ts`: callback
  elicitation/sampling/roots phía server-initiated vẫn còn — đúng
  vai trò shim tương thích, nhưng `callTool` chưa có đường MRTR
  để thay thế chúng giữa chừng.

### Khoảng trống v1.04 T2 phải lấp (không làm lại primitives)

1. **Stateless auto-negotiation**: `stateless: 'auto'` — thử
   `server/discover`, server 2026 thì stateless, server cũ
   (discover null / -32601) thì fallback `initialize` handshake
   và ghi lại mode đã thương lượng; mọi request ở mode stateless
   tự mang `_meta` (protocol version + capabilities), merge với
   `_meta` sẵn có (progressToken không mất).
2. **MRTR nối vào client**: `callToolMrtr` trên client — gọi
   `tools/call` qua `runMultiRoundTrip`, handlers mặc định nối
   từ elicitation/roots/confirmation của client; server cho tool
   handler trả thẳng `resultType` MRTR (passthrough, không bọc
   content block).
3. **Tasks spec gating**: server có `tasksSpecVersion`
   (pin cứng khi cần); không đặt thì phiên bản tasks suy ra từ
   protocol version đã thương lượng — client 2026 → Tasks 2026
   (`tasks/list` và `tasks/result` trả -32601 kèm thông điệp
   migration, dùng `tasks/get` / `tasks/update` thay thế),
   client 2025 trở xuống → Tasks 2025 (giữ hai method cũ, client
   cũ không vỡ). Phía client cũng nối theo: `TaskHandle` mặc
   định 2025, nhưng `clientAdapters.ts: createTaskForClient`
   suy `specVersion` từ `negotiatedProtocolVersion` của client
   (`tasks.ts: tasksSpecVersionForProtocol`) nên không bao giờ
   gọi method server đã bỏ.
6. **E2E thật qua transport**: fake server stdio + HTTP
   (`tests/mcp-v104-fake-stdio-server.mjs`, fake HTTP inline)
   chứng minh `connectMcp` auto-negotiation, `_meta` stateless
   trên từng request, và `callToolMrtr` qua client thật —
   không mock trên đường client.
4. **MCP Apps v2**: khai báo UI template TRƯỚC khi render
   (prefetch resources + cache TTL + review status), audit path
   cho mọi UI-initiated action (ghi ai bấm gì, tool nào chạy —
   qua `McpAuditLog.record`, args đã redact sẵn).
5. **Deprecation migration**: migration guide có cấu trúc cho
   từng method deprecated (replacement, bước đổi, effort,
   deadline 2027-07-28) + render thành `docs/mcp-2.0-migration.md`
   + báo cáo tổng hợp từ `DeprecationShim` notices.


## 8. Ghi chú đội T3 — Đối chiếu harness với main v1.03 (chi tiết)

Đội T3 v1.04 kiểm tra trực tiếp trên main trước khi code (không làm lại):

- **Hook system** (`packages/core/src/hooks/`, ~4.100 dòng): ĐÃ CÓ ĐẦY ĐỦ
  10 event kiểu Claude Code (PreToolUse / PostToolUse / SessionStart /
  SessionEnd / Stop / SubagentStart / SubagentStop / PreCompact /
  PostCompact / UserPromptSubmit), registry + runner (first-block-wins,
  modify chaining, per-hook timeout mặc định 5s, fail-closed, execution
  log), script hooks (node, out-of-process), shell-command hooks
  (exit 0 = allow, 2 = block), test-gate hook, settings validation.
  THIẾU so với Claude Code: **matcher** (chỉ chạy hook cho một số tool
  theo tên — trường `matcher` trong hooks.json của Claude Code),
  **priority** (thứ tự chạy tường minh thay vì chỉ registration order),
  **per-hook timeout** (runner hiện chỉ có một timeout chung cho mọi
  hook). → T3 v1.04 bổ sung 3 thứ này, không viết lại hệ thống.
- **Policy-as-config**: CHƯA CÓ. Behavioral policy hiện chỉ nằm trong
  prompt prose: workspace rules là `AGENTS.md` (`packages/core/src/rules/`,
  loader markdown, không schema, không version, không validate, không
  audit), guardrails (`packages/core/src/guardrails/`) là code builtin
  hard-code. Không có file policy versioned nào mà user sửa được và hệ
  thống enforce được. → T3 v1.04 xây mới `packages/core/src/policy/`:
  file policy JSON/YAML có schema + validate + version + audit log,
  compile ra system-prompt section, và `evaluateToolCall` + hook
  PreToolUse để enforce thật.
- **Session importer**: CHƯA CÓ. `packages/core/src/session/` chỉ có
  session box v0.7 (snapshot workspace) và substrate v1.02 (snapshot
  toàn bộ bot state) — đều là định dạng CỦA open-bot, không đọc session
  của harness khác. `packages/core/src/detected/` chỉ probe CLI agent
  đang cài (claude/codex/…) để dùng login của chúng, không đọc session
  file. Codex CLI lưu session JSONL ở `~/.codex/sessions/`, Claude Code
  lưu JSONL ở `~/.claude/projects/<encoded-path>/` — cả hai đều là
  file local của user, đọc được mà không cần credential. → T3 v1.04 xây
  mới `packages/core/src/session/importer.ts`: chỉ đọc file session
  theo đúng pattern tên file, KHÔNG BAO GIỜ mở auth.json / credentials
  / config chứa key; map sang định dạng session của open-bot.
- **Plugin format compat** (`packages/core/src/acp/pluginFormat.ts`,
  v1.03 T3): ĐÃ CÓ PHẦN ĐỌC (read-only): parse `.claude-plugin/plugin.json`,
  `marketplace.json`, scan `commands/` / `agents/` / `skills/`,
  liệt kê event trong `hooks/hooks.json`, map sang record open-bot.
  Cố tình KHÔNG chạy: warning ghi rõ "hooks … are imported as metadata
  only — open-bot does not execute Claude Code hooks". THIẾU: runtime
  thực sự chạy hook + command của plugin trong open-bot. → T3 v1.04 xây
  mới `packages/core/src/acp/pluginRuntime.ts`: parse `hooks/hooks.json`
  (chấp nhận cả 2 shape: object-map theo event như Claude Code thật,
  và array như v1.03 đã đọc), đăng ký từng hook của plugin thành
  shell-command hook trong HookRegistry (source `'plugin'`, kèm matcher
  + timeout của plugin), đọc `commands/*.md` thành prompt template
  chạy được; activation tường minh (opt-in), deactivate gỡ đăng ký.
  Plugin code JS không bao giờ được thực thi trực tiếp — hook chỉ chạy
  qua shell-command path đã có (timeout, env allowlist, stdout cap).
- **Scaffold harness ~90 dòng**: CHƯA CÓ. Không file nào tên scaffold
  trong repo; harness v2 (`packages/core/src/harness/v2/`) là hệ thống
  production (headless, webhook, routines, health probe), không phải
  tài liệu tham chiếu tối thiểu. → T3 v1.04 viết mới
  `packages/core/src/harness/scaffold.ts`: vòng lặp agent tối thiểu
  chạy được (~90 dòng code), model inject được (test dùng fake model),
  kèm doc `docs/harness-scaffold-v104.md` giải thích từng phần và map
  sang 7 subsystem của paper.
- **29-pattern audit** (`packages/core/src/acp/harnessAudit.ts`,
  v1.03 T3): đã có checklist tự đánh giá; v1.04 cập nhật trạng thái
  các pattern mà wave này bổ sung (hooks matcher/priority → P-hệ
  extensions/safety; policy-as-config → safety; plugin runtime →
  extensions; session importer → observability/persistence).

### Ý tưởng áp dụng (từ paper, diễn đạt lại — không copy)

- Hook là "deterministic automation ngoài vòng quyết định của model":
  model có thể quên instruction trong prompt, hook thì luôn chạy.
  Vì vậy policy dạng config + hook enforce đáng tin hơn prompt prose.
- Harness = model + loop + tools + context + safety + orchestration +
  extensions + observability. Một harness tối thiểu chỉ cần: vòng lặp
  gọi model → tool call → thực thi → observation → lặp lại, với điều
  kiện dừng rõ ràng. Mọi thứ khác là lớp bổ sung trên khung đó.
- Extension surface (plugin/skill/MCP) là nơi harness khác nhau nhất:
  đọc được format plugin của harness khác (như OpenHands đọc format
  Claude Code) là cách rẻ nhất để tái dùng hệ sinh thái có sẵn — nhưng
  phải chạy trong sandbox/timeout của mình, không tin code plugin.
- Session là dữ liệu của user trên máy user: import phải là read-only,
  chỉ đọc đúng file session, không chạm credential, và ghi rõ nguồn.

### Hướng đội T3

- T3a — Hook matcher / priority / per-hook timeout (mở rộng hệ có sẵn).
- T3b — Policy-as-config: schema v1 + validate + YAML/JSON + compile
  prompt + enforce qua hook + audit log khi policy đổi.
- T3c — Session importer: Codex CLI + Claude Code → session open-bot
  (read-only, không credential).
- T3d — Plugin runtime: chạy hook + command của Claude Code plugin
  trong open-bot (opt-in, qua shell-command hook path).
- T3e — Scaffold harness ~90 dòng + doc tham chiếu chạy được.
- i18n đủ 6 locale cho mọi chuỗi UI mới; test thật cho mọi tính năng.

### Đã xây xong (v1.04, nhánh v104-harness)

- **T3a — hooks** (`packages/core/src/hooks/matcher.ts` mới; `types.ts`,
  `registry.ts`, `runner.ts`, `shellCommandRunner.ts`,
  `settingsValidation.ts` mở rộng): matcher glob tên tool cho
  Pre/PostToolUse, priority (nhỏ chạy trước, mặc định 100, tie giữ
  registration order), per-hook timeoutMs (override timeout chung của
  runner), override cả ba từ settings + validation. Runner truyền
  toolName vào `listForEvent` cho Pre/PostToolUse.
- **T3b — policy** (`packages/core/src/policy/` mới: `types.ts`,
  `yaml.ts` (parser + emitter subset), `validate.ts`, `compile.ts`,
  `store.ts`, `audit.ts`, `presets.ts`): schema v1, validate strict
  (unknown key bị báo), YAML subset + JSON, `evaluateToolCall`
  (deny > requireApproval > allow-list + path/network rules +
  require-inside-workspace), `createPolicyHook` (PreToolUse,
  priority 10, needs-approval → fail-closed block), compile ra
  system-prompt section, load/save `.open-bot/policy.yaml/.json`,
  audit JSONL (sha256 trước/sau), 3 preset (strict/read-only/
  permissive). Đổi tên `loadPolicy`/`savePolicy` thành
  `loadBehaviorPolicy`/`saveBehaviorPolicy` vì `loadPolicy` đã tồn
  tại trong `auth/index.ts`.
- **T3c — importer** (`packages/core/src/session/importer.ts` mới):
  discovery chỉ 2 thư mục session (`~/.codex/sessions/<date>/`,
  `~/.claude/projects/<project>/`), chỉ file `.jsonl` thường (không
  symlink), parse JSONL Codex + Claude Code (tolerant: dòng hỏng
  skip + đếm, cap message/chars), strip field credential, map sang
  format open-bot versioned + ghi `.open-bot/imported-sessions/`
  (0600), `toAcpMessages` cho ACP replay, summary + list.
- **T3d — plugin runtime** (`packages/core/src/acp/pluginRuntime.ts`
  mới): parse `hooks/hooks.json` cả 2 shape (object-map + array),
  matcher `|`-alternatives, timeout giây → ms; đăng ký hook plugin
  thành shell-command hook (source `'plugin'`, timeout/env/safety
  của path đó); commands/agents thành prompt template
  (`$ARGUMENTS`); skills đọc theo yêu cầu; MCP servers của manifest
  được extract (không tự start); activation tường minh + rollback
  khi lỗi + deactivate gỡ đăng ký. `pluginFormat.ts` chỉ sửa warning
  cho đúng (hooks giờ chạy được qua runtime).
- **T3e — scaffold** (`packages/core/src/harness/scaffold.ts`, 64
  dòng code / ~100 dòng cả doc header): vòng lặp tối thiểu chạy
  được, model inject được; doc `docs/harness-scaffold-v104.md`
  giải thích từng phần + map sang 7 subsystem + những gì cố tình
  thiếu và nó sống ở đâu.
- **Audit 29 pattern**: P16 partial → present (policy-as-config),
  P24/P27 cập nhật evidence; số đếm 20/7/2 → 21/6/2 (test
  `acp-hosting-v103.test.mjs` cập nhật theo).
- **i18n**: 24 key mới × 6 locale (2991 key/locale); test i18n xanh.

## 9. Ghi chú đội T4 — Đã có gì trên main v1.03 (chi tiết)

### Event-sourced run log — `packages/core/src/event-log/` (~3.200 dòng)
- `types.ts`: 19 loại event bất biến (`run.started`, `run.prompt`,
  `model.response`, `tool.call`, `tool.result`, `file.change`,
  `compile.error`, `run.paused/resumed/forked/completed/failed/aborted`,
  `approval.request/decision`, `checkpoint.saved`, `event.redacted`,
  `run.compacted`, `stuck.detected`), hash chain SHA-256, `seq` liên tục.
- `store.ts`: `RunLogStore` append-only JSONL + xoay file (8 MiB),
  `append`/`appendMany`/`readRun`/`queryRun`/`verify`/`meta`/`listRuns`/
  `exportJsonl`/`deleteRun`. `append` fsync từng event.
- `replay.ts`: `foldEvents` (trạng thái = hàm thuần của dãy event),
  `replayDeterministically` + digest so sánh.
- `control.ts`: `RunPauseGate` (pause/resume/abort in-memory),
  `RunControlRegistry`, `pauseRun`/`resumeRun`/`forkRun`.
- `timeTravel.ts`: `replayUpTo`/`timeTravelTo`, `forkRunAt`,
  `compareRunStates`, `listChildRuns`.
- `condenser.ts` (v1): MỘT chiến lược duy nhất — tóm tắt trích xuất
  (extractive): prompt + đếm tool + file đổi + lỗi biên dịch + outcome;
  `condenseEvents`/`shouldCondense`/`compactRun` ghi marker
  `run.compacted`. Token ước lượng qua `estimateEventTokens`.
- `stuck.ts`: phát hiện kẹt (lặp tool, lặp lỗi, no-progress, step budget).
- `redaction.ts`, `sanitize.ts`, `canonical.ts`, `audit.ts`.
- **Thiếu**: snapshot trạng thái đã fold (phải fold lại toàn bộ log mỗi
  lần đọc), restore từ snapshot + tail, condenser nhiều chiến lược +
  báo cáo token saved đo thật.

### Harness — `packages/core/src/harness/` (+ `v2/`)
- `LocalHarness`, event bus, permission broker fail-closed, registry,
  NDJSON thread log, snapshot engine (ghi atomic).
- `v2/`: signed webhooks, routines v2, headless jobs, health probe,
  versioned NDJSON export. Không phải agent server REST.

### SDK — `packages/core/src/sdk/query.ts`
- Chỉ có `query()` (kiểu Claude Code Agent SDK): gọi `AgentRunner`
  trong process, async iterator event text/tool_call/tool_result/done.
  Chưa có package tách rời kiểu OpenHands V1 (SDK/Tools/Workspace/
  Server), chưa có conversation server.

### Agent server / API
- `packages/core/src/api/server.ts` (~2.900 dòng): Local API loopback
  + Bearer token + scope + rate limit (token bucket), webhook Composio,
  MCP mount. Là API tổng của app, KHÔNG phải agent server chuyên
  conversations/event-stream.
- `packages/core/src/acp/agentServer.ts`: ACP agent side (JSON-RPC
  stdio), session/new/load/resume/prompt/cancel — giao thức ACP, không
  phải REST + SSE.
- **Thiếu**: REST v2 chuyên conversations (tạo/liệt kê/pause/resume/
  cancel/fork/stream SSE), auth loopback-only riêng, gọn nhẹ, treo trên
  event log.

### CodeAct
- Chưa có module CodeAct nào (grep `codeact` chỉ trúng 1 key i18n
  `harness.v103.codeact.title` — key mồ côi, chưa có code). Có sẵn nền:
  `sandbox/box.ts` (`BotBoxManager.runInBox`: spawn qua prlimit,
  timeout/cap ghi/cap output thật, `BoxRunResult`), `sandbox/allowlist.ts`
  (`isCommandAllowed`/`checkAllowlist`), `sandbox/profiles.ts`
  (standard/strict/permissive), `workspace/` (local/container).
- **Thiếu**: contract thống nhất Action → Execution → Observation cho
  bash + python + editor; giới hạn tài nguyên riêng cho CodeAct; chặn
  lệnh phá hoại.

### Multi-agent delegation
- `agent/subagent.ts`: subagent chuyên biệt hoá (spec + validate + lọc
  tool + system prompt), chạy song song qua runner tiêm vào, gộp kết
  quả nối thứ tự + tóm tắt xung đột.
- `subagents/`: `nested.ts` (cây + depth/spawn/context budget),
  `fanout.ts` (fan-out có chấm điểm), `grader.ts`, `roles.ts`.
- `packages/tools/src/subagentTools.ts`: tool `delegate_task` (chạy con
  qua `ctx.runSubagent`, chờ xong, trả text), `list_subagent_roles`,
  `agent_status`; `nestedSubagentTools.ts` riêng.
- `a2a/delegation.ts`: ủy thác bot-to-bot qua A2A (loopback HTTP),
  depth cap 3, chống vòng lặp, miễn trừ mock/cli.
- **Thiếu**: delegation qua tool call CÓ theo dõi tiến độ (session +
  trạng thái + thời gian + số step/tool call của con), hợp nhất kết quả
  theo nhiều chiến lược (concat / summarize / verdict + phát hiện xung
  đột), fan-out song song qua tool call.

### Condenser / compaction khác
- `agent/compaction.ts` (380 dòng): compaction cho agent loop (khác
  event-log condenser: nén message history, không phải event stream).
- `memory/`: memory v4 (shared blocks, sleep-time consolidation).

### i18n
- 6 locale flat-key JSON (`vi/en/zh/ja/fr/es`, 2.967 key/locale, parity
  bắt buộc bởi `tests/i18n.test.mjs`: key giống hệt en, placeholder
  khớp, giá trị không rỗng). Key mới phải thêm đủ 6 file.

### OpenHands V1 SDK — ý tưởng áp dụng cho v1.04 T4

(Nguồn đã survey ở v1.03: 4 package độc lập SDK/Tools/Workspace/Server;
event-sourced stateless agent; CodeActAgent; xem
`docs/repo-survey-v103.md` §1.)

- **Event-sourced, stateless agent**: conversation = stream event bất
  biến; pause/resume/fork/replay/audit "miễn phí" nhờ đó. v1.04 T4 đi
  tiếp: snapshot trạng thái đã fold tại một seq + restore bằng cách
  fold phần đuôi (tail) lên snapshot, digest kiểm chứng bằng
  `digestReplayState` — snapshot KHÔNG thay log, chỉ là cache trạng
  thái có kiểm chứng.
- **Agent server**: `Conversation` factory chọn Local/Remote theo config,
  không đổi code. v1.04 T4: REST v2 loopback-only, conversation = một
  run trong event log; stream event qua SSE bằng cách tail store (poll
  250 ms, không cần websocket riêng ở v2 này); pause/resume/cancel nối
  thẳng `RunPauseGate` + event `run.paused/resumed/aborted`.
- **CodeAct**: thay 20 tool bespoke bằng bash + Python + editor qua
  contract Action → Execution → Observation. v1.04 T4: executor chạy
  trong `BotBoxManager` (sandbox local, prlimit CPU/RAM, timeout, cap
  output/ghi), editor ghi file confined trong `workspaceDir` của box,
  denylist lệnh phá hoại, mọi lần chạy trả Observation có
  exitCode/stdout/stderr/timedOut/limitsApplied.
- **Condenser trên event stream**: v1 chỉ có summarize trích xuất. v1.04
  T4 thêm `truncate` (giữ đầu + cuối, bỏ giữa, có marker khoảng trống)
  và `extract-keep` (giữ nguyên verbatim event quan trọng: lỗi, file
  change, approval, prompt + tóm tắt phần còn lại); báo cáo đo thật:
  `tokensBefore/tokensAfter/tokensSaved/savedRatioPct` bằng
  `estimateTokens`/`estimateEventTokens` trên cùng một log.
- **Sub-agent delegation**: OpenHands V1 chạy agent con như
  conversation con độc lập, theo dõi qua event stream của nó. v1.04 T4:
  `DelegationTracker` (session: started/running/done/error/timeout,
  elapsed, child steps/tool calls khi biết runId con qua
  `refreshFromLog`), `mergeDelegationResults` (concat/summarize/verdict),
  tool `delegate_to_agent` / `delegate_parallel` /
  `delegation_status` xây trên `ctx.runSubagent` /
  `ctx.runSpecializedSubagents` có sẵn — không tạo runner mới.

### Quyết định thiết kế v1.04 T4

| Hạng mục | Xây mới | Dùng lại (không sửa logic) |
|---|---|---|
| Snapshot event log | `event-log/snapshot.ts`: create/load/list/prune snapshot, `mergeReplayedStates` (fold tail lên snapshot), verify digest | `foldEvents`, `digestReplayState`, `RunLogStore`, `safeRunFileName` |
| Condenser v2 | `event-log/condenser-v2.ts`: 3 chiến lược + `CondenserV2Report` + `recommendStrategy` + `compactRunV2` | `condenseEvents` (strategy summarize), `estimateEventTokens`, `estimateTokens`, marker `run.compacted` |
| CodeAct v2 | `codeact/`: types + executor + contract | `BotBoxManager.runInBox`, `BoxResourceLimits`, `isPathAllowed`, `SANDBOX_PROFILE_*` |
| Agent server v2 | `agent-server/`: types/auth/conversations/stream/server (node:http, không thêm dep) | `RunLogStore`, `RunControlRegistry`, `pauseRun/resumeRun/forkRunAt`, `compactRunV2`, `createRunSnapshot` |
| Delegation | `delegation/` (tracker + merge) + `tools/delegationTools.ts` | `ctx.runSubagent`, `ctx.runSpecializedSubagents`, `runSpecializedSubagents` merge v1 làm baseline cho strategy concat |
| i18n | key `*.v104.*` đủ 6 locale | test parity `tests/i18n.test.mjs` tự bắt lệch |

Giới hạn nói rõ:
- Agent server v2 stream bằng SSE poll store (không WebSocket ở sóng
  này); server chỉ bind `127.0.0.1`, Bearer token sinh ngẫu nhiên mỗi
  lần khởi động (không lưu đĩa); không rate limit riêng (Local API đã có).
- CodeAct python chạy `python3` trong box (máy phải có python3);
  editor ghi file qua fs trong `workspaceDir` (không qua shell).
- Delegation tracker theo dõi tiến độ qua lifecycle tool + refresh từ
  run log khi biết `childRunId`; `ctx.runSubagent` chỉ trả text nên
  step/tool call của con chỉ có khi log-backed.
- Snapshot là cache trạng thái có kiểm chứng digest, không thay thế log;
  restore sai digest thì từ chối (không dùng snapshot hỏng).

## 10. Ghi chú đội T6 — SWE-bench, contamination-free eval, benchmark, OTLP, dispatch (chi tiết)

Nguồn: SWE-bench docs/wiki, bài giới thiệu và các phân tích độc lập (11/2026).

- Mỗi task = một issue thật + repo tại commit trước khi sửa + test patch ẩn.
  Agent chỉ nhận issue text và repo, phải tự sửa code rồi nộp patch.
- Chấm bằng **chạy test thật, không chấm bằng LLM-as-judge, không so
  sánh patch với đáp án của maintainer**.
- Hai nhóm test quyết định resolved hay không:
  - **FAIL_TO_PASS**: fail trước khi sửa, phải pass sau khi sửa — chứng
    minh bug đã được sửa.
  - **PASS_TO_PASS**: đã pass trước, phải tiếp tục pass — chống hồi quy.
  - Một task chỉ tính là resolved khi patch áp dụng được VÀ cả hai nhóm
    đều pass hết; không có điểm từng phần.
- Quy mô gốc: 2.294 task từ 12 repo Python; Verified: 500 task được rà
  soát thủ công (OpenAI, 2024); Multilingual: 300 task, 9 ngôn ngữ.
  Model mạnh nhất lúc ra mắt chỉ giải được 1,96%.
- Cảnh báo 2026: audit của OpenAI (2/2026) thấy 59,4% trong một mẫu
  138 task thất bại nặng có vấn đề về đặc tả/test, và có bằng chứng
  model đã thấy dữ liệu eval trong training — tức **contamination là
  mối đe dọa thật với mọi benchmark**, kể cả benchmark "chuẩn".
- Ý tưởng áp dụng cho open-bot v1.04: eval local kiểu SWE-bench thu
  nhỏ — task tự định nghĩa từ repo local (setup files + fail-to-pass
  + pass-to-pass bằng lệnh chạy thật trong workspace tạm), solver là
  callback agent (đo loop/harness, không đo "tâm trạng" model),
  baseline check bắt buộc (fail-to-pass phải fail trước khi solver
  chạy, nếu không task vô giá trị), báo cáo resolve rate + thời gian.

### Contamination-free eval — tách eval data khỏi training/context

Nguồn: tổng hợp từ các phân tích về SWE-bench contamination (2026)
và thực hành decontamination chuẩn trong cộng đồng eval.

- Vấn đề: nếu task/test lọt vào context của agent (qua file setup,
  prompt, memory, hay training data của model), điểm eval đo trí nhớ
  chứ không đo năng lực.
- Ba lớp phòng thủ thực dụng, không cần infrastructure nặng:
  1. **Tách vật lý**: eval data sống trong store riêng, chỉ hash
     (SHA-256) của eval item mới được đưa vào log/report; nội dung
     eval không bao giờ vào context hay memory của agent.
  2. **Phát hiện rò rỉ bằng n-gram overlap**: so n-gram (từ) giữa
     context/training excerpts và eval material; overlap cao trên
     ngưỡng → verdict suspect/contaminated, task bị loại khỏi aggregate.
  3. **Redaction trước khi chạy**: quét context, thay các đoạn trùng
     eval material bằng placeholder trước khi đưa cho agent.
- Giới hạn trung thực: n-gram overlap bắt được copy gần-nguyên văn,
  không bắt được paraphrase; hash chỉ phát hiện rò rỉ khi có bản
  eval gốc để so. Báo cáo phải ghi rõ phương pháp + ngưỡng, không
  tuyên bố "100% contamination-free".
- Ý tưởng áp dụng: module contamination riêng — scan overlap, hash
  registry cho eval item, strip eval material khỏi context, report
  verdict theo từng task.

### Benchmark harness — so sánh model/harness trên cùng task

Nguồn: thực hành chung của SWE-bench leaderboard và các harness so
sánh (tổng hợp 11/2026).

- Nguyên tắc vàng: **cùng task, cùng test, cùng budget** cho mọi
  config; khác nhau chỉ ở model/harness. So sánh mà task khác nhau
  thì vô nghĩa.
- Ba trục phải báo cáo cùng lúc, vì tối ưu một trục dễ làm hỏng hai
  trục còn lại: **accuracy** (% resolved), **latency** (mean/p95),
  **cost** (USD/task, USD/resolved-task). Model rẻ mà chậm, model
  nhanh mà đắt, model chính xác mà tốn — bảng so sánh phải hiện cả ba.
- Tránh cherry-pick: chạy toàn bộ task set cho mọi config, báo cáo
  cả task fail chung (khó cho mọi config) lẫn task chỉ một config
  pass (phân biệt thật).
- Ý tưởng áp dụng: benchmark runner nhận list config (model +
  harness label) + cùng task set, chạy qua callback runner do caller
  cung cấp, aggregate accuracy/latency/cost, bảng Markdown + winner
  theo từng metric (không tuyên bố một "winner chung" duy nhất).

### OpenTelemetry OTLP — export telemetry về collector local

Nguồn: opentelemetry.io docs, OTLP exporter guides (11/2026).

- OTLP có 2 transport: gRPC (`:4317`) và HTTP (`:4318`); OTLP/HTTP
  có 2 encoding `http/protobuf` và `http/json`. Endpoint mặc định
  của SDK là `http://localhost:4318`, path signal `/v1/traces`,
  `/v1/metrics`, `/v1/logs` được append tự động.
- Mô hình triển khai chuẩn: app gửi về **collector chạy local** trên
  cùng máy (loopback), collector mới forward đi nơi khác. App không
  bao giờ tự gửi thẳng ra backend xa.
- Env var chuẩn: `OTEL_EXPORTER_OTLP_ENDPOINT`,
  `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL`.
- Ý tưởng áp dụng cho open-bot v1.04 (local-first, giữ đúng hướng
  đứng của Huy): OTLP export **tắt mặc định**, chỉ bật khi user cấu
  hình endpoint; endpoint chỉ chấp nhận loopback hoặc IP LAN riêng
  (127.0.0.1 / ::1 / localhost / 10/8 / 172.16/12 / 192.168/16),
  từ chối host công khai fail-closed; dùng OTLP/HTTP JSON
  (`POST <endpoint>/v1/traces`, `Content-Type: application/json`),
  timeout ngắn, không follow redirect, không đọc env `OTEL_*` (chỉ
  config tường minh trong app mới bật). Payload tái dùng `traceToOtel`
  có sẵn, cộng thêm metrics payload từ run-metrics aggregates.

### Multi-machine dispatch + work stealing (lập lịch cổ điển)

Nguồn: thực hành lập lịch phân tán chuẩn (tổng hợp 11/2026).

- Fleet v1–v3 của open-bot chỉ đặt bot lên workspace **trên cùng một
  máy**. Bước tiếp theo là node: mỗi máy trong LAN là một node có
  CPU/RAM/disk + heartbeat; controller chỉ dispatch khi node còn sống.
- **Heartbeat + dead detection**: node gửi heartbeat định kỳ; node
  nào quá `heartbeatTimeoutMs` không thấy heartbeat thì coi là chết,
  job của nó được requeue — không bao giờ dispatch sang node chết.
- **Loopback-first**: node local (127.0.0.1) luôn được ưu tiên hơn
  node LAN xa, vì không tốn mạng và không phụ thuộc mạng.
- **Work stealing**: node rảnh chủ động lấy job đang chờ của node bận
  (queue dài vượt ngưỡng) hoặc node chết; job bị lấy ghi rõ `stolenFrom`
  để audit được. Không "đẩy" job sang node rảnh — node rảnh tự "kéo",
  tránh controller thành bottleneck và tránh race khi node bận vừa
  nhận job.
- Ý tưởng áp dụng: `fleet/nodes.ts` (registry + heartbeat + dead
  detection + scoring) và `fleet/dispatch.ts` (job lifecycle +
  dispatch theo node sống tốt nhất + work stealing + requeue job của
  node chết). Chỉ máy local/LAN của user, không cloud.

### Hướng đội T6

- Fleet scheduler v2: `fleet/nodes.ts` + `fleet/dispatch.ts` — node
  LAN, heartbeat, dead detection, loopback-first, work stealing.
- Eval harness v2: `observability/sweBenchEval.ts` (task local kiểu
  SWE-bench, fail-to-pass/pass-to-pass, baseline check),
  `observability/contamination.ts` (n-gram scan, hash registry,
  redaction), `observability/benchmark.ts` (cùng task, nhiều
  model/harness, bảng cost/latency/accuracy).
- Telemetry v2: `observability/runMetrics.ts` (cost/latency per
  run/model/tool) + `observability/otlp.ts` (OTLP/HTTP JSON, tắt
  mặc định, chỉ loopback/LAN).
- Không làm lại: scheduler v3 trong máy (`fleet/scheduling.ts`),
  eval chấm recording (`observability/evalHarness.ts`), cost
  (`observability/cost.ts`), OTel JSON local
  (`observability/otel.ts`) — tất cả được tái dùng, không viết lại.
