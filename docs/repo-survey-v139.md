# Repo survey v139 — nghiên cứu 18/11/2026 (chu kỳ 13:01)

CHỈ HỌC Ý TƯỞNG, không copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor.
Nguồn: tìm kiếm web ngày 18/11/2026 (xem link cuối file).
Dành cho sóng v1.39 (sau khi v1.38 hoàn tất gộp + kiểm chứng).

## 1. MCP spec 2026-07-28: từ giao thức gọi tool thành nền tảng app nhỏ (T2 — protocols v8)

- **Core stateless**: bỏ handshake `initialize` và header `Mcp-Session-Id`; mọi
  request tự mang protocol version + capabilities trong `_meta`; thêm
  `server/discover` để hỏi capabilities trước. Route được tới bất kỳ instance nào.
- **MCP Apps** (`io.modelcontextprotocol/ui`, extension chính thức đầu tiên,
  26/01/2026, GA trong spec 2026-07-28): tool khai báo UI qua
  `_meta.ui.resourceUri` trỏ resource `ui://`, host fetch HTML
  (`text/html;profile=mcp-app`) rồi render trong iframe sandbox, UI gọi ngược
  lại tool của server. Host xây CSP từ domain resource khai báo, domain ngoài
  bị chặn. Gộp MCP-UI cộng đồng + OpenAI Apps SDK; Anthropic + OpenAI + MCP-UI
  cùng viết. Host hỗ trợ: Claude, ChatGPT, VS Code, Cursor, Goose...
- **Tasks** (`io.modelcontextprotocol/tasks`, từ experimental 2025-11-25 thành
  extension chính thức): server trả task handle thay vì giữ connection;
  client poll `tasks/get`, kết quả cuối nhúng thẳng trong Task object
  (SEP-2663 bỏ `tasks/result` blocking và `tasks/list`); `tasks/update` đưa
  input vào giữa chừng. Multi Round-Trip Requests (MRTR, SEP-2322) thay cơ chế cũ.
- **Deprecated** (SEP-2577): Sampling, Roots, Logging — vẫn chạy, không nên
  adopt mới, sớm nhất bị gỡ ở revision sau 2027-07-28.
- **Extensions khác trong framework** (SEP-2133, SEP-3392 lifecycle): OAuth
  Client Credentials, Enterprise Managed Authorization, **Skills over MCP**,
  Server Cards. Extensions thương lượng qua trường `extensions` trong
  capabilities, mặc định tắt.
- Ý tưởng cho T2: MCP Apps host mini trong open-bot (render `ui://` resource
  của tool trong panel sandbox + CSP), Tasks extension client/server đúng chuẩn
  polling, Skills over MCP (skill pack phát qua MCP), bỏ dần Sampling/Roots
  khỏi code mới; Server Cards cho discovery.

## 2. Claude Code Agent Skills: chuẩn mở cho "kỹ năng" tái dùng (T6 — platform/fleet v26)

- **Skill = thư mục + SKILL.md** (+ script/assets tùy chọn), chuẩn mở Agent
  Skills, dùng được qua nhiều tool. Claude Code mở rộng thêm invocation
  control, subagent execution, dynamic context injection.
- **Progressive disclosure 3 tầng**: tầng 1 metadata (name + description,
  ~100 token/skill, load lúc startup); tầng 2 SKILL.md body (<5k token, load
  khi trigger); tầng 3 script/assets khi cần. Đây là cách giữ context gọn khi
  có hàng trăm skill.
- **Slash commands đã gộp vào Skills** (`.claude/commands/` vẫn chạy nhưng
  skill được ưu tiên khi trùng path). Skill khai báo được `allowed-tools`,
  argument, và chạy subagent riêng.
- **Hooks** (PreToolUse / PostToolUse / Stop): side-effect xác định, chạy shell
  hook ở lifecycle event — dùng để enforce policy thay vì trông chờ model.
- **Subagent discovery** (v2.1.133+): subagent tự tìm skill của project/user/
  plugin qua Skill tool như session chính. Bundled skills mới: `/doctor`,
  `/code-review`, `/verify`, `/run`.
- **Plugins**: gói share được, bundle skills + hooks + slash commands + MCP
  server trong một package.
- Ý tưởng cho T6: skill pack dùng chung cho cả fleet (một skill viết một lần,
  mọi bot dùng), progressive disclosure cho registry skill của open-bot (hiện
  load hết mô tả tool vào context — học cách chỉ load metadata rồi mở body khi
  cần), hooks xác định cho policy (cấm tool nguy hiểm không cần hỏi model),
  plugin bundle đóng gói skill+hook+MCP server để chia sẻ/chợ skill có ký số
  + versioning.

## 3. Memory 2026: ba kiến trúc, lấy cái hay của cả ba — phần 2 (T1 — memory v24)

- **Letta shared memory blocks**: một block (vd `organization`,
  `current_plan`) gắn vào nhiều agent qua `block_ids`; một agent cập nhật là
  các agent khác thấy ngay, không cần nhắn tin agent-to-agent. Đây là đáp án
  trực tiếp cho "các bot chia sẻ memory thế nào" trong fleet.
- **Letta sleep-time compute**: agent nền dọn dẹp/tổ chức lại memory blocks
  lúc rảnh, không tốn lượt trả lời người dùng.
- **Mem0 v3** (migration docs): bỏ pass LLM thứ hai; chỉ add, không quyết định
  overwrite lúc ghi — fact mới nằm cạnh fact cũ, retrieval tự phân xử cái nào
  còn đúng. Số họ công bố: LoCoMo 71.4 → 91.6, LongMemEval 67.8 → 93.4,
  p95 retrieval ~1.44s so với 17.12s khi nhét full history.
- **Mem0 fusion**: semantic + BM25 + entity match hợp nhất rồi rank; đa scope
  `user_id` / `agent_id` / `run_id` / `app_id`.
- **Zep (Graphiti)**: temporal knowledge graph — fact có thời gian, biết fact
  nào đã thay đổi, phù hợp câu hỏi "trước đây X, giờ Y thì sao".
- Số benchmark của vendor (Mem0 92.5 LoCoMo / 94.4 LongMemEval, ~6.900
  token/query so với ~26.000 full-context) là claim của vendor, đọc như claim
  cần tự kiểm chứng trên task của mình.
- Ý tưởng cho T1: shared memory blocks liên-bot (một block, nhiều bot đọc/ghi,
  có khóa + lịch sử phiên bản), sleep-time consolidation job chạy lúc idle,
  Mem0-style v3 add-only + fused retrieval (semantic + BM25 + entity) cho
  recall, temporal layer kiểu Graphiti ghi lại khi nào fact đổi.

## 4. OpenHands 1.x: coding agent trưởng thành + verification stack (T4 — coding v17, T3 — sandbox v7)

- **1.0** (16/12/2025, theo đính chính của team): rebuild quanh **Software
  Agent SDK** — 4 package Python tách bạch (`openhands.sdk` core abstractions:
  Agent/Conversation/LLM/Tool/event system; `openhands.agent_server` REST +
  WebSocket). Không còn monolith.
- **Mọi thứ là event**: prompt, bash, file change, lỗi compiler đều là event
  bất biến trong append-only log → deterministic replay + session recovery.
  Components immutable (Pydantic frozen sau khởi tạo).
- **Security là vòng lặp, không phải checkbox**: SecurityAnalyzer chấm mọi
  tool call low/medium/high risk; ConfirmationPolicy quyết định có dừng chờ
  người duyệt không (ConfirmRisky → agent WAITING_FOR_CONFIRMATION). Docker
  sandbox giới hạn CPU/RAM từng container, chạy non-root mặc định.
- **CodeAct**: agent viết + chạy code trực tiếp (Python/Bash/Browser DSL)
  thay vì hàng chục tool hẹp.
- **Verification Stack** (điểm mới quan trọng nhất 2026 theo team: "tạo code
  đã rẻ, nút thắt giờ là kiểm chứng"): nhiều tầng verifier — Critic Model
  (model nhỏ chấm trajectory trước khi push, AUC 0.69 theo code survival;
  critic-guided selection nâng SWE-bench 57.9% → 73.8% với trung bình 1.35
  attempt), Code Review Skill chạy trên mọi PR, cộng các tầng khác.
- **Plan Mode** (1.5.0, bật cho self-hosted/local từ 1.17.0): planning agent
  lập kế hoạch, refine, rồi mới build.
- **Multi-agent control center**: một dashboard chạy OpenHands, Claude Code,
  Codex, Gemini agent (local/Docker/K8s), giữ context khi đổi backend.
  K8s self-hosting từ 1.6.0 (03/2026): RBAC multi-user, audit log,
  data-residency.
- **Số đo**: ~72% SWE-bench Verified với model frontier (71.8% submission
  chính thức); open-weight Devstral 24B ~46.8%; dẫn đầu Multi-SWE-Bench 8
  ngôn ngữ; 84.2k star GitHub, MIT.
- Ý tưởng cho T4: verification stack nhiều tầng cho coding agent (critic
  chấm patch trước khi trình, review skill tự động trên mọi thay đổi, Plan
  Mode bắt buộc với task đa file), event-sourced trajectory log để replay/
  recovery phiên coding. Ý tưởng cho T3: SecurityAnalyzer chấm risk mọi tool
  call + ConfirmationPolicy (dừng chờ duyệt với high-risk), sandbox giới hạn
  CPU/RAM từng bot.

## 5. Voice v26 (T5) — hướng tiếp nối

- Không có phát hiện voice mới trong đợt này. T5 tiếp tục roadmap của mình
  (turn-taking, barge-in, latency budget). Gợi ý thêm từ mục 1: dùng MCP Apps
  làm bề mặt UI cho voice (panel điều khiển voice render như `ui://`
  resource, gọi ngược tool voice của server) thay vì panel hard-code.

## 6. Bổ sung chu kỳ 17:01 — NANDA, MemFS, WikiTrace, SoMem, building blocks (T1/T2)

- **NANDA Protocol (MIT)**: xây trên MCP + A2A + NLWeb — discovery,
  identity, routing cho "Internet of Agents". Ý tưởng áp dụng (local-first):
  sketch registry discovery nội bộ + identity tự ký cho agent/bot trong
  open-bot, không phụ thuộc dịch vụ tập trung.
- **Letta letta-code / MemFS**: memory dạng file Markdown git-backed, agent
  tự đọc/sửa memory của chính mình; thư mục `file system/` luôn nằm trong
  system prompt. Ý tưởng áp dụng (T1 memoryV24): MemFS-style store — memory
  là cây Markdown có version (git), agent edit qua tool, snapshot luôn có
  trong system prompt.
- **WikiTrace**: giữ evidence đằng sau mỗi lesson — 52% lỗi do memory sai
  được follow khi lesson không kèm bằng chứng. Ý tưởng áp dụng (T1): mỗi
  lesson phải link tới evidence (nguồn, đoạn trích, thời điểm).
- **SoMem**: memory dạng Markdown doc liên kết với nhau. Ý tưởng áp dụng
  (T1): memory doc có link chéo, duyệt theo đồ thị thay vì list phẳng.
- **15 building blocks (R083)**: admission policy (cái gì được ghi vào
  memory), scope + expiry lúc ghi, decay/forgetting, memory poisoning
  (chống memory độc). Ý tưởng áp dụng (T1): ghi memory kèm admission
  decision + scope + expiry; policy decay/quên; screening chống poisoning
  (nối tiếp memory v18, mở rộng sang admission-time).
- **DSPy**: là prompt optimizer, KHÔNG phải hệ memory — không nhầm vai trò
  khi thiết kế memory pipeline.

## Nguồn (chỉ học ý tưởng)

- MCP Apps / spec 2026-07-28: https://www.ajayk.sh/blog/mcp-resources-prompts-sampling-elicitation-explained/
- MCP Apps spec đọc nhanh: https://dev.to/topuzas/i-read-the-new-mcp-apps-spec-so-you-dont-have-to-heres-what-changes-for-net-developers-5b73
- MCP extensions overview: https://landing.complexqa.com/en/wiki/mcp/mcp-extensions
- Claude Code skills: https://code.claude.com/docs/en/skills (qua https://www.totalum.app/blog/claude-code-skills-totalum và http://luongnv.com/claude-howto/03-skills/index.html)
- Memory 2026: https://www.reactify-solutions.com/articles/ai-agent-memory-systems-2026 ; https://kenhuangus.substack.com/p/how-ai-agents-actually-remember-inside ; https://andrew.ooo/answers/best-llm-memory-solutions-for-multi-agent-teams-2026/
- OpenHands 1.x: https://dev.to/jamilxt/openhands-at-1x-how-to-run-it-on-your-own-machine-without-handing-over-the-keys-77b ; https://www.beri.net/tools/openhands ; https://www.vibecodingresources.com/tools/openhands/
