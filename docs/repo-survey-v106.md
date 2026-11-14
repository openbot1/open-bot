# Repo survey — v1.06 (14/11/2026)

Nghiên cứu cho chu kỳ v1.06. CHỈ HỌC Ý TƯỞNG, không copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor. Các nguồn dưới đây đều là tóm tắt viết lại từ tài liệu công khai, kiểm chứng qua web search ngày 14/11/2026.

## 1. OpenMausBot v0.1.146 — ~16.139 stars (milind-soni/OpenMausBot, Apache 2.0)

Nguồn: aifrontierpost.com (hướng dẫn thực hành, kiểm chứng 07/11/2026), hysenlabs.com, exe.dev, web.lumintu.workers.dev. Trước đây tên OpenGrokBot; tự nhận là open-source alternative của Grok Bot, không liên quan xAI/Meta/OpenAI/Manus.

- **Mô hình chạy:** chat app mà mỗi contact là một agent thật chạy trên máy user — bot chạy trên các CLI đã cài và đăng nhập sẵn (`claude`, `codex`, `grok`), không tài khoản mới, không proxy ở giữa. Model usage tính theo subscription của provider mà user đã trả.
- **Headless server + CLI:** `openmausbot serve --no-pair` chạy headless, harness server lắng nghe `127.0.0.1:8799`, sở hữu mọi agent process và chuẩn hoá protocol riêng của từng provider thành một event stream chuẩn (log NDJSON theo thread). App chat UI nói chuyện với harness qua HTTP. `openmausbot doctor` là health check (version, server, browser, engine login). Team cài từ một file YAML (`team apply` / `team export`), CLI trả một JSON document với `--json`, exit code dùng được cho script/CI.
- **Driver riêng mỗi provider:** mỗi engine có driver riêng (Claude Code / Codex / Grok Build, cộng custom engine trỏ tới binary CLI riêng trong Settings → Engines). Dockerfile cài engine mặc định là `@anthropic-ai/claude-code` và `@openai/codex`.
- **Computer cho bot:** cloud Linux desktop, Local VM tách biệt, hoặc máy của chính user (opt-in tường minh). Host control chỉ có trên macOS và Ubuntu Xorg; Ubuntu Wayland đang bị khoá (issue #345). Data ở `~/.openmausbot`.
- **Yêu cầu:** macOS / Windows / Ubuntu 24.04, Node.js 24+, một agent CLI đã đăng nhập thì bot mới làm việc thật được. Không GPU, không tải model, không API key cho chính OpenMausBot. Tốc độ tăng trưởng nhanh: +5.580 stars trong tuần tới 06/11/2026.
- **MCP:** có stdio MCP server để client ngoài (Claude Desktop, Cursor) orchestrate bot; không expose approval grants, deletion, settings tuỳ ý, credentials, hay computer lifecycle.
- Ý tưởng áp dụng cho open-bot v1.06: pattern `doctor` (health check một lệnh, output rõ ràng, exit code cho script); team YAML apply/export; harness chuẩn hoá event stream của nhiều provider thành một luồng chuẩn; driver riêng mỗi provider thay vì một adapter chung; loopback-trust làm auth model cho local harness.

## 2. Letta — V1 server archive 15/08/2026, letta-code hiện tại, memory blocks + git-backed projection

Nguồn: neoneye.github.io/agent-memory-atlas (Letta — Agent Memory Atlas), publish.obsidian.md (letta-code local backend, 08/05/2026), careerstack.dev, verdenmax.github.io, deepwiki.com (letta-code SDK).

- **Archive:** commit `87fd37aa` (#3430, 15/08/2026) gỡ V1 API server — khoảng 367.000 dòng — khỏi nhánh main của `letta-ai/letta`, chỉ còn README, policies và citation file. README trỏ sang `letta-ai/letta-code` làm source hiện tại (agent harness, terminal UI, App Server, channels); server cũ nằm trên nhánh `archive`.
- **Memory model (V1, vẫn là bài học cốt lõi):** core memory là các block có label (`human`, `persona`, `system/persona`, custom) biên dịch vào system prompt bằng `Memory.compile()`; archival memory là semantic memory ngoài context; recall trên conversation history; file/source memory; và git-backed memory projection (mới hơn).
- **Điểm mạnh nhất:** memory editing tường minh trong tool loop, với **block-level prompt recompilation** sau mỗi lần đổi. Core memory không phải thứ "tìm rồi chèn" — nó được biên dịch thành system prompt, nên một lần ghi là viết lại chính message #0 của agent; turn sau thấy text mới ngay từ token đầu, không cần bước search. Agent tự sửa block bằng `core_memory_append` / `core_memory_replace`; `rebuild_system_prompt` viết lại message #0.
- **Letta-code local backend (experimental):** `letta --backend local` chạy embedded backend trong process, agent state trên disk, memory là **local git-backed MemFS repo** (`~/.letta/lc-local-backend/memfs/<agent-id>/memory/system/` — block `persona` thành file `system/persona.md`), prompt biên dịch lại từ file memory local; không cloud sync, có thể mirror thêm remote qua `/memory-repository`. Hạn chế: không parity với Letta Cloud, schema lưu trữ có thể đổi.
- **Git render:** với agent bật git, `_render_memory_blocks_git()` render `system/persona` thành `<self>`, các block `system/*` khác vào `<memory>`.
- **Letta-code SDK:** 4 preset block, custom block cùng semantics, system prompt 3 dạng (preset / custom string / preset + append); đổi memory structure trên agent đang chạy bị cấm vì làm mất hiệu lực cache — muốn đổi thì tạo agent mới.
- Ý tưởng áp dụng cho open-bot v1.06 (đội T1): **memory v7 = git-backed memory projection + block-level prompt recompilation** — mỗi block là một file Markdown có frontmatter (label/tier/scope/version), mỗi lần sửa là một commit; `git log/blame/diff` cho lịch sử từng block; recompile chỉ block nào đổi hash (cache theo label+hash), còn lại tái dùng section đã biên dịch; guardrail scope system (agent không tự sửa block hệ thống). Đây là phần T1 đã xây trong chu kỳ này.

## 3. Mem0 v3 (04/2026) — ADD-only, scope user/agent/run, OpenMemory MCP

Nguồn: ithub.directory, docs.bswen.com (25/08/2026), contextbolt.com (Mem0 MCP 2026), docs.mem0.ai (OpenCode integration, entity-scoped memory).

- **V3 (tháng 04/2026):** extraction single-pass **ADD-only** — một LLM call cho `add()`, chỉ append fact mới cạnh fact cũ, không còn UPDATE/DELETE trong lúc add; retrieval ranking (hybrid, time-aware) quyết định fact nào thắng. `search()` và `get_all()` nhận entity id trong `filters` (top-level `user_id` kwarg giờ raise `ValueError`). Graph memory đã gỡ khỏi OSS SDK — chỉ còn trên Platform.
- **Scope:** mọi memory thuộc về `user_id`, `agent_id`, `app_id` hoặc `run_id`. Viết (`add`) chấp nhận mọi tổ hợp id; đọc (`search`, `get_all`) dùng cùng id trong `filters`; xoá scope qua query params. User = persona/account bền; agent = persona/tool riêng; run = flow ngắn hạn, reset/expire độc lập. Id rỗng/chỉ whitespace bị reject.
- **MCP — cần phân biệt 4 thứ cùng tên:** hosted Platform MCP (`https://mcp.mem0.ai/mcp/`, OAuth/API key, hiện tại); repo `mem0ai/mem0-mcp` đã **archived tháng 03/2026** (659 stars, npm 0.2.0 tháng 04/2026); **OpenMemory MCP đã deprecated**, gộp vào self-hosted server (FastAPI + Postgres/pgvector + dashboard, Docker); repo `mem0ai/openmemory` nay là CLI/TUI port session giữa Claude Code/Codex/OpenCode, không còn là memory server. Plugin OpenCode dùng trực tiếp SDK (`mem0ai` TS), không qua MCP.
- **Cảnh báo thực tế:** Claude Code từ 2.1.59 (02/2026) đã có Auto Memory mặc định (ghi `MEMORY.md`), nên memory layer ngoài chỉ đáng giá khi cần scope đa user/agent/run và retrieval có ranking.
- Ý tưởng áp dụng cho open-bot v1.06 (đội T1): memory 4 tầng của v7 mượn scope Mem0 v3 (user/bot/run gắn trên từng item, filter khi list/search); consolidation thăng tầng theo điểm + lượt truy cập thay vì LLM rewrite; episodic search keyword + score thay vì vector (tránh rò embedding).

## 4. Zep / Graphiti — temporal knowledge graph, hybrid search

Nguồn: survey v1.03/v1.04 (đã đọc kỹ ở các chu kỳ trước), arXiv 2501.13956.

- **Graphiti (Zep engine):** mọi node/edge mang `valid_at`/`invalid_at` (bi-temporal: thời gian sự kiện + thời gian ghi nhận); mâu thuẫn thì **invalidate chứ không xoá**; truy vấn "đúng tại thời điểm T, theo những gì đã biết tại thời điểm R".
- **Hybrid search:** kết hợp keyword (BM25) + vector + graph traversal, RRF fusion; entity extraction/linking trước khi truy vấn.
- **Tình trạng:** Graphiti vẫn là lựa chọn tự host mạnh nhất cho temporal KG (backend Neo4j/FalkorDB/Neptune, MCP server riêng); Mem0 Platform đã hút graph memory về phía trả phí, để lại khoảng trống cho bản tự host.
- Ý tưởng áp dụng cho open-bot v1.06: memory v7 giữ nguyên temporal graph v5 (bi-temporal + invalidate) làm tầng episodic/semantic có cấu trúc; tầng episodic của v7 là bản nhẹ (keyword + score, không cần graph DB) cho trường hợp user không chạy Neo4j; khi cần suy luận quan hệ thì dùng graph v5, khi cần xem nhanh "chuyện gì đã xảy ra" thì dùng episodic search v7.

## 5. MCP spec 2026-07-28 — stateless core, server/discover, MRTR, Tasks, MCP Apps, deprecations

Nguồn: victordibia.com (MCP 2026-07-28, cập nhật 22/08/2026), dev.to (MCP 2.0 migration), for.you.com (16/10/2026), keronlewis.dev, lokeshkapoor.com, codex.danielvaughan.com (30/05/2026). Khớp với survey v1.04; bổ sung xác nhận chéo tháng 10–11/2026.

- **Stateless core (SEP-2575):** "all the information needed to process a request is contained in the request itself". Bỏ `initialize` handshake, bỏ header `Mcp-Session-Id`, bỏ HTTP GET stream và SSE resumability, bỏ server-initiated request, bỏ `ping`, `logging/setLevel`, bỏ in-core tasks methods. Mọi request tự mang protocol version + capabilities trong `_meta`. Lợi ích: round-robin load balancing thường hoạt động.
- **`server/discover`:** server phải implement để quảng bá version hỗ trợ, capabilities, identity; client gọi trước hoặc dùng làm backward-compat probe qua stdio.
- **MRTR — Multi Round-Trip Requests (SEP-2322):** thay mọi server-initiated call (sampling, elicitation, roots). Server trả result có `resultType: "input_required"` kèm câu hỏi; client gọi lại request gốc với `inputResponses`.
- **Tasks thành extension chính thức** (SEP-2663, Final): task durable trước khi client thấy id; client drive polling (`tasks/get`: `working`/`input_required`/`completed`/`failed`/`cancelled`); cancel là cooperative; `tasks/get` phải tới đúng instance đang giữ task.
- **MCP Apps** (SEP-1865, stable 26/01/2026): server trả HTML tương tác, host render trong sandboxed iframe với `ui/initialize` handshake riêng; host push input/result, relay tool call theo policy; không khai CSP thì app không chạm được network.
- **Deprecated (SEP-2577, tối thiểu 12 tháng, earliest removal 28/07/2027):** Roots, Sampling, Logging, Dynamic Client Registration (thay bằng Client ID Metadata Documents). HTTP+SSE transport cũng deprecated, đủ điều kiện gỡ 3 tháng sau khi SEP-2596 Final.
- **OAuth:** iss validation bắt buộc; auth chạy trên mọi request, không còn một lần mỗi session.
- Ý tưởng áp dụng cho open-bot v1.06: các đội protocol tiếp tục theo hướng v1.04 (stateless core + `server/discover` + MRTR + Tasks extension + MCP Apps); đội T1 không chạm protocol trong chu kỳ này, chỉ ghi nhận để tránh xây tính năng mới trên API đã deprecated (Roots/Sampling/Logging).

## 6. Hướng đội v1.06 (từ survey này)

- **T1 memory v7 (đã xây xong chu kỳ này):** git-backed memory projection (block = file Markdown + commit), memory 4 tầng working/session/episodic/semantic với promote/demote một bậc + TTL + consolidation, block-level prompt recompilation (hash cache), 10 tool `memory_v7_*`, guardrail scope system, i18n 6 locale, docs survey này.
- **Gợi ý các đội khác (chưa xây, để coordinator phân):** pattern `doctor` + team YAML kiểu OpenMausBot cho harness/CLI; loopback-trust auth model cho local harness; driver riêng mỗi provider thay vì adapter chung; tránh xây mới trên Roots/Sampling/Logging (deprecated); episodic search v7 làm "bản nhẹ" trước khi gọi temporal graph v5 khi cần suy luận quan hệ.

## 7. Ghi chú đội T1 — Memory v7 (chi tiết)

- **File mới:**
  - `packages/core/src/memory/tiers.ts` — `TieredMemoryStore` (JSON atomic `.open-bot/memory-v7-tiers.json`): 4 tầng, TTL mặc định (working 1h / session 24h / episodic 90d / semantic không TTL), capacity (20/200/1000/5000), promote/demote đúng một bậc, `effectiveScore = score + min(0.2, accessCount*0.02)`, `sweepExpired`, `consolidate` (working→session hết turn; session→episodic khi score ≥ 0.7; episodic→semantic khi score ≥ 0.7 và accessCount ≥ 3; dry-run không ghi file), `search` keyword trên episodic (expired không bao giờ trúng).
  - `packages/core/src/memory/gitProjection.ts` — `GitMemoryProjection` (repo git riêng `.open-bot/memory-v7/`, block = `blocks/<label>.md` + frontmatter): create/update/append/setTier/setReadOnly/delete (mỗi lần đổi = một commit `memory-v7: <action> <label> v<n>`), guardrail `assertEditable` (system scope: chỉ `user`/`system:*`, agent bị chặn; read-only chặn mọi actor), `blockHistory` (`git log --follow` + `git show` từng version), `blockBlame`, `blockDiff`, fallback JSONL `history.jsonl` khi không có git, `importFromBlocks` (nhập block JSON v0.96, bỏ qua block đã có).
  - `packages/core/src/memory/promptRecompile.ts` — `PromptRecompiler` (cache theo label+hash): `recompile()` chỉ biên dịch lại block đổi hash, còn lại tái dùng; `compileSystemPrompt()` hàm thuần; thứ tự render system → semantic → episodic → session → working → label; section dạng `<memory label tier scope>`.
  - `packages/tools/src/memoryV7Tools.ts` — 10 tool `memory_v7_*` (create/update/list/promote/demote/prompt_recompile/block_history/episodic_search/tiers_status/consolidate) + `importV96BlocksIntoV7`; factory giữ một `PromptRecompiler` chung cho cả session nên cache sống qua nhiều lần gọi tool.
- **Đăng ký:** export core (`packages/core/src/index.ts`), export tools (`packages/tools/src/index.ts`), coordinator đăng ký guarded sau memory v5 (`packages/core/src/coordinator/coordinator.ts`, `createMemoryV7Tools` optional).
- **i18n:** 19 key `memoryV7.*` × 6 locale (en/vi/es/fr/ja/zh), 3129 → 3148 key/locale.
- **Test:** `tests/memory-v7-v106.test.mjs` (13 test core) + `tests/memory-v7-tools-v106.test.mjs` (11 test tools) + `tests/i18n-v106.test.mjs` (1 test) = **25 test, pass 25/25** (chạy sau khi build core + tools). Test coordinator đếm cứng cũng cập nhật: 293 → 303 tool (293 + 10 memory_v7_*), bản plugin 295 → 305 — coordinator gộp sóng cần đối chiếu lại vì các đội v1.05/v1.06 khác cũng thêm tool.
- **Giới hạn còn tồn tại:** git history/blame/diff cần git CLI trên máy (không có thì fallback JSONL, blame/diff rỗng); prompt cache sống theo factory instance — host nào tạo factory mới mỗi lần gọi thì mất cache (coordinator tạo một lần nên không ảnh hưởng); episodic search là keyword, chưa có embedding; import v0.96 chỉ nhập label/description/content/readOnly, không nhập attachments (block v0.96 attach vào bot nào thì sau import phải attach lại qua projection nếu cần).
