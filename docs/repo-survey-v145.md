# Repo survey v145 — nghiên cứu 19/11/2026 (chu kỳ 07:01)

Chỉ học Ý TƯỞNG, không copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor.

## 1. Google ADK 2.x — Workflow Runtime dạng graph (GA Python 19/05/2026, TypeScript 21/08/2026)

- ADK (Agent Development Kit, Apache-2.0) là framework agent của Google, chạy đa ngôn ngữ
  (Python, TypeScript, Go, Java, Kotlin), lấy Gemini làm mặc định nhưng có adapter cho
  Claude, OpenAI, Ollama, vLLM, LiteLLM, model local.
- ADK 2.0 đổi mô hình: từ agent phân cấp (Sequential/Parallel/Loop template ở 1.x) sang
  **Workflow Runtime dạng graph** — agent, tool, hàm code đều là node trong graph, edge
  quyết định đường chạy; hỗ trợ fan-out/fan-in, loop, retry, state, dynamic node,
  human-in-the-loop có thể resume. Google báo cáo ví dụ refund flow định tuyến bằng code
  giảm ~50% token và ~20% latency so với để model tự quyết.
- Phiên bản kiểm chứng 01/11/2026: Python google-adk 2.13.0, TypeScript @google/adk 2.4.0,
  Go v2.6.0. ADK 2.5 thêm: graph-native Workflows, resumable HITL, state-based recovery,
  Skill registries, A2A 1.x, expose agent thành MCP server, Web UI xem graph/trace.
- Session/memory: `InMemorySessionService` mất state khi restart; production dùng
  `DatabaseSessionService` + dịch vụ memory riêng (Vertex AI Memory Bank) cho recall
  xuyên session. Đánh giá: module evaluation có user + environment simulation.
- Lưu ý nâng cấp: 2.0 breaking — `BaseAgent` thành subclass `BaseNode`, event có thêm
  field `node_info`/`output`, schema DB cũ bị reject; `LoopAgent` không tự dừng — bắt
  buộc `max_iterations` + điều kiện thoát đánh giá, nếu không tốn tiền model vô hạn.
- Nguồn: https://adk.dev/, https://www.motiontic.com/glossary/google-adk,
  https://sidbharath.com/blog/the-complete-guide-to-googles-agent-development-kit-adk/
- Ý tưởng cho open-bot (T1 workflow v31): graph workflow engine riêng — node = agent/tool/
  hàm, edge khai báo trước, compile-time kiểm tra edge trỏ node không tồn tại (fail sớm);
  superstep kiểu Pregel (node sẵn sàng chạy song song, merge update vào state chung);
  checkpoint từng superstep theo `thread_id` để resume sau crash; YAML declarative
  authoring biên dịch ra cùng graph runtime; `max_iterations` + exit condition bắt buộc
  cho mọi loop node; eval harness dùng user/environment simulation như ADK.

## 2. Microsoft Agent Framework 1.0 GA (03/04/2026) — AutoGen + Semantic Kernel hợp nhất

- MAF là SDK + runtime mã nguồn mở (.NET và Python, cùng khái niệm/API), kế thừa chính
  thức của Semantic Kernel và AutoGen. AutoGen vào chế độ maintenance-only từ 02/10/2025
  (chỉ fix critical/security, không tính năng mới); Semantic Kernel v1.x được hỗ trợ ít
  nhất 1 năm sau GA. AG2 (fork cộng đồng) ra v1.0 nhưng không drop-in upgrade.
- 5 pattern orchestration built-in: Sequential, Concurrent, Handoff, Group Chat, Magentic
  (Magentic-One cho research). **Handoff**: khai báo agent + directed edge, framework tự
  inject handoff tool để agent chuyển quyền điều khiển; topology/guardrail thuộc dev,
  quyết định routing thuộc agent — giải đúng bài toán router chuyển cho specialist rồi
  specialist cần hỏi lại/hỏi peer.
- **Harness Agent**: agent mẫu opinionated cho việc dài nhiều bước — planning, todo
  tracking, context compaction, file-based memory, approval-gated tools, telemetry có sẵn
  trong một call.
- **CodeAct**: model sinh code rồi chạy code đó; gói `agent-framework-hyperlight`
  (alpha) chạy mỗi lần gọi code trong Hyperlight micro-VM mới, cô lập mạnh với chi phí
  gần như bằng 0 ở粒度 từng tool call.
- **Declarative Workflows 1.0** (23/07/2026): orchestration viết bằng YAML, load vào cùng
  kiểu `Workflow` như graph code-first, chạy/stream/checkpoint/compose như nhau — tách
  "orchestration là tài liệu" khỏi call graph để review hành vi không cần đọc code.
  Python `agent-framework-declarative` 1.0.0, .NET
  `Microsoft.Agents.AI.Workflows.Declarative` stable; Go còn public preview (thiếu
  declarative agents, RAG, CodeAct).
- Tracing OpenTelemetry native + checkpointing pause/resume; MCP là first-class tool
  provider (không adapter); hơn 14.000 GitHub stars sau ~18 tháng.
- Nguồn: https://devblogs.microsoft.com/agent-framework/microsoft-agent-framework-at-build-2026-announce/,
  https://www.smfclearinghouse.com/blog/2026-07-27-agent-framework-declarative-workflows-1-0/,
  https://atlan.com/know/ai-agent/microsoft/agent-framework/
- Ý tưởng cho open-bot (T2 orchestration v2): Handoff orchestration — khai báo agent +
  directed edge, inject handoff tool, guardrail ở dev; Magentic-One research pattern
  (planner → workers → verifier); Harness Agent mẫu cho task dài (todo + compaction +
  approval gate + telemetry trong một call); CodeAct chạy code sinh ra trong micro-VM/
  sandbox riêng mỗi lần gọi (học Hyperlight: fresh VM per call); declarative workflow
  YAML biên dịch ra cùng graph runtime của T1.

## 3. LangGraph 1.2.16 (10/2026) — durable runtime, supervisor bằng handoff tool

- LangGraph (langchain-ai/langgraph, ~43.788 stars) là runtime state machine cho app LLM
  nhiều bước: node + edge + shared typed state; chạy theo superstep kiểu Pregel; mọi bước
  đều lưu được nên pause/resume/replay/inspect được.
- **Durability là first-class**: checkpointer (`SqliteSaver` cho 1 host, Postgres cho
  nhiều worker) lưu toàn bộ state graph theo `thread_id`; gọi lại cùng `thread_id` thì
  resume từ checkpoint cuối, không lặp lại tool call đắt tiền; crash giữa chừng không
  mất token đã trả. Không có `thread_id` thì run đúng nhưng ephemeral — lỗi hay gặp nhất.
- **Interrupt**: node gọi `interrupt(value)` thì pause cả graph, lưu state, trả quyền về
  caller; resume sau bằng `Command(resume=...)` qua cùng `thread_id`, kể cả từ process
  khác. Đây là hình dạng đúng cho approval gate trước side effect: checkpoint phải đặt
  TRƯỚC action không đảo ngược được.
- **Supervisor pattern 2026**: package `langgraph-supervisor` 0.0.31 hiện chỉ còn là
  đường tương thích nâng cấp LangChain 1.0; README khuyên dùng **tools-based supervisor**
  (tự nối handoff tool, ~30 dòng) thay vì dùng package. Supervisor tự chọn cùng subagent
  4 lần liên tiếp là lỗi tốn tiền thật: mỗi handoff gửi lại toàn bộ message list — giới
  hạn counter handoffs (vd tối đa 3) là tối ưu rẻ nhất.
- Reducers: merge policy khai báo theo từng field của state (node chỉ trả partial update,
  framework merge theo luật). Compile step: lỗi cấu trúc (edge trỏ node không tồn tại)
  fail trước khi chạy. Recursion limit mặc định cũ 25 đã đổi thành env-configurable.
- Nguồn: https://www.ainomam.com/post/langgraph-supervisor-handoff-tutorial,
  https://www.paurushmuley.com/blog/production-multi-agent-systems-langgraph-python-checkpoints,
  http://dev.to/creeta/one-missing-checkpoint-can-break-every-approval-gate-127k
- Ý tưởng cho open-bot (T3 durable execution v2): checkpointer theo `thread_id` cho mọi
  run dài (SQLite local, JSON file fallback); interrupt/resume API cho approval gate
  (checkpoint trước side effect, resume bằng decision của user); supervisor tools-based
  (handoff tool tự nối, counter handoffs tối đa 3, chống lặp chọn cùng worker); reducers
  theo field cho shared state; compile step validate graph trước khi chạy.

## 4. Claude Code — Agent Teams + subagents + hooks (2026)

- **Agent Teams** (ra mắt cùng Claude Opus 4.6, 05/02/2026, research preview, bật bằng
  `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`): 2–16 agent làm việc peer-to-peer trên cùng
  codebase — mailbox giao tiếp trực tiếp, shared task list, tự claim việc, tự delegate,
  không đi qua parent. Hợp khi task tách được thành workstream độc lập.
- **Subagents** (mẫu cũ, vẫn giữ song song): worker báo cáo về parent; định nghĩa bằng
  file Markdown + YAML frontmatter (name, description, tools allowlist, model, system
  prompt); project `.claude/agents/`, cá nhân `~/.claude/agents/`; mỗi subagent có context
  window riêng biệt (chỉ task prompt + CLAUDE.md + git status snapshot; fork là ngoại lệ,
  kế thừa toàn bộ conversation + prompt cache); tối đa 20 chạy song song mặc định, lồng
  nhau tối đa 3 tầng, mỗi subagent pin model riêng; foreground block conversation,
  background chạy tiếp trong khi user làm việc khác.
- **Hooks**: 14+ lifecycle trigger point (trước/sau tool call, lỗi, notification...);
  dùng cho auto-format, logging, sửa hành vi. Claude Code v2.1.323 (12/11/2026) bỏ
  `subagentStatusLine` — chỉ đổi 1 hook hiển thị, subagent vẫn chạy.
- **Claude Agent SDK** (đổi tên từ Claude Code SDK đầu 2026): Python 0.2.165, TS 0.3.296
  (10/2026); primitives: `query()` generator, lifecycle hooks, subagents, governance
  schema, streaming, agent isolation. Không có A2A native.
- Nguồn: https://resources.anthropic.com/hubfs/Claude%20Code%20Advanced%20Patterns_%20Subagents,%20MCP,%20and%20Scaling%20to%20Real%20Codebases.pdf,
  https://aq.dev/guides/subagents-in-coding-agents-explained/,
  https://codex.danielvaughan.com/2026/04/09/codex-vs-claude-code-multi-agent/
- Ý tưởng cho open-bot (T4 agent teams v2): Agent Teams peer-to-peer — mailbox + shared
  task list + claim việc (khác subagent tree parent→child hiện có); subagent định nghĩa
  bằng file Markdown+YAML (tương thích `.claude/agents/` để import trực tiếp); context
  window riêng mỗi subagent + fork mode kế thừa conversation; hooks lifecycle 14 điểm
  (before/after tool, error, notify) cho auto-format/logging/guard; background subagent
  với progress reporting tách cost path.

## 5. A2A 1.0 — Agent-to-Agent thành chuẩn Linux Foundation

- A2A (Google tạo 04/2025, nay do Agentic AI Foundation của Linux Foundation quản),
  chuẩn hoá agent discovery + giao tiếp xuyên vendor; ACP đã merge vào A2A; 100+ doanh
  nghiệp áp dụng; MCP đã vượt 200 server implementation.
- **a2abridge 4.0** (15–21/09/2026): bọc mỗi CLI coding agent (Claude Code, Codex CLI,
  Cursor, Cline, Continue, Gemini CLI...) thành A2A 1.0 peer — mỗi bridge vừa là MCP
  server cho IDE vừa là A2A peer với Agent Card riêng; dùng SDK chính thức a2a-go v2.5.0,
  serve JSON-RPC + HTTP+JSON với SSE streaming + push notification; label ổn định theo
  session `<basename-cwd>-<4hex>`; inbox hook inject tin nhắn peer chưa đọc vào đầu prompt
  tiếp theo (queue + hook, không phải chat client). TCK chính thức: 157 pass / 6 fail
  (đều do a2a-go SDK) / 95 skip (gRPC không serve); tương tác 2 chiều với a2a-sdk Python
  1.1.0 (7/7 scenario). Breaking: 3.x và 4.x không tương thích wire — nâng cấp toàn mesh
  cùng lúc.
- Codex CLI subagents GA tháng 03/2026: định nghĩa TOML, spawn tường minh, địa chỉ theo
  path (`/root/agent_a`), nhận steering instruction có cấu trúc giữa chừng; hỗ trợ MCP
  STDIO + streamable HTTP qua `config.toml` / `codex mcp add`.
- Khoảng trống protocol: Codex CLI và Claude Code đều chưa implement A2A native (tính
  đến 04/2026) — chỉ qua MCP bridge; ADK có A2A native với Agent Card tự sinh; CrewAI
  thêm A2A task delegation 2026.
- Nguồn: https://vbcherepanov.com/projects/a2abridge,
  https://www.morphllm.com/ai-agent-framework
- Ý tưởng cho open-bot (T5 A2A v2): A2A 1.0 native — Agent Card tự sinh cho mỗi bot,
  JSON-RPC + HTTP+JSON + SSE streaming, push notification; peer discovery trong fleet;
  bridge cho CLI agent ngoài (Codex/Claude Code/Cursor...) thành peer A2A như a2abridge;
  inbox hook inject tin peer chưa đọc vào prompt; task lifecycle `send_message` /
  `get_task`; TCK tự kiểm tra theo spec (không cần chứng nhận ngoài).

## 6. Tổng hợp — ưu tiên đưa vào open-bot v145

| # | Ý tưởng | Đội v145 |
|---|---------|----------|
| 1 | Graph workflow engine + YAML declarative + checkpoint theo thread | T1 |
| 2 | Handoff/Magentic orchestration + Harness Agent + CodeAct micro-VM | T2 |
| 3 | Durable execution: checkpointer, interrupt/resume, reducers, compile-validate | T3 |
| 4 | Agent Teams peer-to-peer + subagent Markdown/YAML + hooks lifecycle | T4 |
| 5 | A2A 1.0 native + Agent Card + CLI-agent bridge + inbox hook | T5 |
| 6 | Voice realtime v31 + eval/observability v2 (OTEL tracing, simulation eval) | T6 |

Ghi chú: v144 đạt +29.551 (thiếu 449 so với sàn 30k) — v145 mỗi đội mục tiêu ~5.200 dòng
thật để có biên an toàn. Việc tồn đọng từ v144: đăng ký agent tools của eval harness v4
vào packages/tools + panel desktop cho nó (T2 cố ý để lại); desktop typecheck đỏ sẵn
29 lỗi V26/V28 panel — chỉ tính lỗi mới.
