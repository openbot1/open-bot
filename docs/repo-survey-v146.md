# Repo survey v146 — nghiên cứu 19/11/2026 (chu kỳ 11:01)

Chỉ học Ý TƯỞNG, không copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor.

## 1. OpenHands v1.41.0 (16/11/2026) — Automations + Agent Profiles + budget meter

- OpenHands (All Hands AI, MIT, ~90.7k stars) là nền tảng agent phát triển phần mềm mã
  nguồn mở: conversation có sandbox chạy code/shell/browser; gồm Agent Canvas (client),
  Agent Server, Software Agent SDK, Sandbox Server, Cloud/Enterprise.
- **Automations**: chạy agent theo lịch/sự kiện/webhook, có dashboard, template, setup
  assistant giải thích bằng sơ đồ Mermaid; automation lưu repo đã chọn (clone URL cho
  Bitbucket Data Center), event type theo từng nguồn (Jira/Bitbucket Data Center riêng);
  `keep_alive` giữ sandbox sống sau run; install qua link `/launch?mode=automation`.
- **Agent Profiles**: preset prompt + plugin chạy từ một profile thay vì chọn model rời;
  ACP profile hiển thị `ACP` thay tên model; plugin config chỉnh được dạng JSON từ Edit.
- **Conversation budget meter**: đồng hồ Usage so chi tiêu với budget cap đã cấu hình
  (chỉ báo, không enforce — chi tiêu có thể vượt cap); không có cap thì ẩn.
- **Stop không giết sandbox**: nút Stop ngắt agent nhưng để sandbox chạy tiếp.
- **Resolved/Reopen**: conversation đã resolve hiện banner, bấm Reopen hoặc gửi tin mới
  để tiếp tục; server-side conversation tags lưu metadata workspace/repo, pin/archive
  nên đồng bộ sang máy khác; Paper theme + contrast pass Light+/Solarized.
- Nguồn: https://docs.openhands.dev/openhands/usage/agent-canvas/release-notes/v1.38.0,
  https://agentbreakingchanges.com/tools/openhands/v1.41.0/
- Ý tưởng cho open-bot (T1 automations v2): automation engine — trigger lịch/sự kiện/
  webhook, template + setup assistant, repo/event-type theo nguồn; Agent Profiles
  (preset prompt+plugin+model trong 1 profile); budget meter theo cap (báo, chưa enforce);
  Stop ngắt agent nhưng giữ sandbox; resolved banner + reopen; conversation tags
  server-side cho pin/archive/repo/branch.

## 2. MCP 2026-07-28 — stateless + Multi Round-Trip Requests (MCP 2.0)

- Spec hiện hành 2026-07-28 (trước đó 2025-11-25): **stateless hoàn toàn** — bỏ
  handshake `initialize` và header `Mcp-Session-Id`; mỗi request tự mang protocol
  version + client capabilities trong `_meta`; `server/discover` để biết server hỗ trợ gì
  trước khi gọi; load balancing round-robin thuần túy được.
- **Multi Round-Trip Requests (SEP-2322)** thay mọi callback giữa request: server không
  còn tự mở request riêng (sampling/create, elicitation/create, roots/list). Server trả
  `resultType: input_required` + `inputRequests`; client retry call gốc kèm
  `inputResponses`; kết quả thường `resultType: complete`; server cũ thiếu resultType
  được coi là complete; `requestState` để server tự tương quan retry.
- **Deprecated (2026-07-28)**: Sampling, Roots, Logging, OAuth Dynamic Client
  Registration — vẫn chạy trong thời gian deprecation, không được gỡ trước 28/07/2027
  (thông báo tối thiểu 12 tháng, 90 ngày chỉ cho lỗi bảo mật). Sampling được giữ lại
  dạng thu hẹp: `maxTokens` bắt buộc, `includeContext` hạn chế, client kiểm soát budget;
  hướng migrate là gọi trực tiếp API của provider thay vì mượn model của client.
- SDK Tier 1: TypeScript, Python, C#, Go, Rust, Ruby; Python/C# SDK ra 2.0 cùng ngày
  spec; Python: `McpError` → `MCPError`, pin `mcp>=1.28,<2` nếu chưa migrate.
- Nguồn: https://www.aiagentsinfo.com/reports/mcp-next-6-months,
  https://dev.to/ali_82f3409ed625e8ba8515b/mcp-20-what-changed-and-how-to-migrate-5586,
  https://spyn3.com/resources/mcp-sampling-security/
- Ý tưởng cho open-bot (T2 MCP v2): client stateless 2026-07-28 (không handshake,
  `_meta` mỗi request, `server/discover`); Multi Round-Trip Requests — server trả
  `InputRequiredResult`, client retry với `inputResponses`; elicitation theo mẫu mới;
  sampling thu hẹp có budget + review prompt/response, mặc định tắt; migration path
  cho server cũ (coi thiếu resultType là complete); deprecation registry + cảnh báo.

## 3. Memory layer 2026 — Mem0 v3 vs Letta vs Zep/Graphiti (so sánh 05/11/2026)

- **Mem0** (68.435 stars 05/11/2026, $24M Series A, exclusive memory provider cho AWS
  Agent SDK): layer gắn vào agent có sẵn — LLM trích fact từ hội thoại → vector store
  (+ graph tuỳ chọn); `add()`/`search()` scope theo user/agent/app/run; pipeline 2 bước:
  extraction rồi consolidation (so với memory cũ, quyết định add/update/delete/noise);
  mọi memory có created_at/updated_at; LOCOMO: +26% accuracy vs OpenAI memory, p95
  latency −91% vs nhét full history, −90% token. MCP server hosted có tool
  `add_memory`/`search_memories`/`update_memory`/`delete_memory`.
- **Letta** (25.352 stars, MemGPT lineage): agent tự quản memory — core memory blocks
  có label/description/value/giới hạn ký tự, agent tự sửa bằng tool; archival (vector)
  + recall (history); **sleep-time agents** củng cố memory nền sau N bước hoặc khi
  compact; Conversations API (04/2026): nhiều session song song của 1 agent đọc/ghi
  block chung không giẫm nhau; block chia sẻ được giữa agent, có read-only.
- **Zep/Graphiti** (32.536 stars): temporal knowledge graph — theo dõi fact thay đổi
  theo thời gian; benchmark 09/2026: recall 37.0%, 3.65s build graph/turn, 8/22 câu
  temporal đúng (yếu nhất trong 6 cấu hình đo).
- Điểm chung cần có: eval recall/precision trên tập memory, đường xoá thoả GDPR,
  phòng **memory poisoning (OWASP ASI06)**; benchmark LoCoMo 419-turn: GoodMem 57.6%,
  Letta archival 52.2% (không gọi model khi ghi).
- Nguồn: https://www.getlockstep.dev/blog/mem0-vs-zep-vs-letta-vs-supermemory,
  https://www.hamzashabbir.dev/article/ai-agent-memory-layer-mem0-vs-letta-vs-zep,
  https://past.dev/blog/mem0-vs-letta.md
- Ý tưởng cho open-bot (T3 memory v17): extraction+consolidation kiểu Mem0 (add/update/
  delete/noise, timestamp mọi fact, scope user/agent/run); sleep-time consolidation nền
  (sau N bước/compact); shared blocks kiểu Letta Conversations API (read-only flag,
  lock chống giẫm); temporal KG cho fact thay đổi; eval recall/precision + GDPR erasure
  + phòng poisoning ASI06 (quarantine fact lạ, provenance/source excerpt).

## 4. Claude Code 2.1.322 + Codex CLI 0.167 (11/2026) — subagent effort, skills, guardrails

- **Claude Code 2.1.316→2.1.322** (11/2026): `CLAUDE_CODE_SUBAGENT_EFFORT` — effort
  riêng cho subagent, không thừa hưởng session; `CLAUDE_CODE_DISABLE_ULTRATHINK`;
  `permissions.blockWritesOutsideWorkingDirectories` — Write/Edit/NotebookEdit từ chối
  đường dẫn ngoài working dir ở mọi permission mode; hook prompt/agent tối đa 24 chạy
  song song/session (+12 chờ quá timeout); `autoCompactWindow` của subagent chỉ được
  hạ, không được nâng; Opus 4.8 fast mode deprecated 30/10, gỡ hẳn 30/11 (không fallback);
  model mặc định Opus 5.5 ($4/$20, window 1M); Agent Teams vẫn experimental, tắt mặc định;
  Skills (workflow chia sẻ như /review-pr), hooks 30+ event, MCP.
- **Codex CLI 0.167.0** (06/11/2026, Rust, Apache-2.0): model GPT-6.1 Sol mặc định
  ($2/$10, window 500K), GPT-6.1 Terra thêm vào bundled/Vertex/Bedrock catalog;
  `codex queue --resume` tải lại thread chưa load sau khi queue tin; provider Vertex AI
  built-in (`model_provider = ...`); nested AGENTS.md (global/repo/subfolder, gần nhất
  thắng); Plan mode, Goal mode (mục tiêu chạy giờ/ngày), subagents, skills, plugin
  (skills+MCP server), hooks GA từ 05/2026, scheduled task theo event, worktrees,
  browser built-in, Computer Use macOS/Windows; Codex đã merge vào app ChatGPT desktop
  (09/07/2026).
- So sánh thực tế: Codex ~4x ít token/task hơn Claude Code (benchmark đầu 2026, model
  cũ); Claude Code thắng accuracy code mù (SWE-bench Verified 80.9% đầu 2026) và
  multi-agent (Agent Teams).
- Nguồn: https://agent-config.com/this-week/2026-w45/,
  https://particula.tech/blog/codex-vs-claude-code-cli-agent-comparison,
  https://applygist.com/2026/11/codex-vs-claude-code-who-wins.html
- Ý tưởng cho open-bot (T4 CLI-detect v2): cập nhật catalog model GPT-6.x / Claude 5.5
  + giá; subagent effort riêng (không thừa hưởng session); guard
  blockWritesOutsideWorkingDirectories cho mọi tool ghi; skills discovery theo thư mục
  (per-directory + `paths:`, sau `cd` sâu trong repo); nested AGENTS.md/CLAUDE.md
  (gần nhất thắng, đọc hết file lớn thay vì ghi đè sau khi thấy đầu file); Goal mode
  cho task dài giờ/ngày; queue --resume cho thread chưa load.

## 5. OpenHands verify + ACP reasoning effort — eval vượt happy path

- OpenHands 1.41.0: `verify-openhands` mở rộng scenario vượt happy path (map controls,
  browser timezone); ACP chọn reasoning effort từ những gì agent báo cáo; hooks dialog
  nêu rõ file hook workspace vs user; analytics instrument dead-end của automation
  setup funnel; reuse profile secret consent cho managed App enablement tự động.
- Nguồn: https://agentbreakingchanges.com/tools/openhands/v1.41.0/
- Ý tưởng cho open-bot (T5 eval v2): verify harness scenario vượt happy path (map,
  timezone, lỗi mạng, tool timeout); ACP reasoning effort theo agent report; analytics
  dead-end funnel (điểm user bỏ dở setup); profile secret consent reuse.

## 6. Tổng hợp — ưu tiên đưa vào open-bot v146

| # | Ý tưởng | Đội v146 |
|---|---------|----------|
| 1 | Automations + Agent Profiles + budget meter + Stop giữ sandbox + tags/pin/archive | T1 |
| 2 | MCP 2026-07-28 stateless + Multi Round-Trip + elicitation mới + sampling thu hẹp | T2 |
| 3 | Memory v17: Mem0 extraction/consolidation + Letta sleep-time + shared blocks + temporal KG + chống poisoning | T3 |
| 4 | CLI-detect v2: model GPT-6/Claude 5.5, subagent effort, write guard, skills discovery, nested AGENTS.md, Goal mode | T4 |
| 5 | Eval v2: verify vượt happy path + ACP reasoning effort + analytics funnel + voice realtime v32 | T5 |
| 6 | UI v2 kiểu Agent Canvas: tags/pin/archive đồng bộ, resolved banner, Paper theme, download file, live stage activity | T6 |

Ghi chú: v145 đạt +29.979 dòng chuẩn (thiếu 21 so với sàn 30k) — v146 mỗi đội mục tiêu
~5.300 dòng thật để có biên an toàn. Việc tồn đọng: v145 suite r1 đang chạy (nhiều lỗi
i18n sort + memory test file trong log giữa chừng — coordinator v145 xử lý fix round,
v146 KHÔNG chờ, base merge/v145 @ c0d0e7fe và hoà giải fix sau lúc gộp); v144 suite r3
đỏ 30 fail, v143 suite r3 đỏ 33 fail — các coordinator đó đang sửa, v146 đi song song.
