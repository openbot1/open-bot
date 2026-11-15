# Nghiên cứu repo — Sóng v1.11 (15/11/2026, chu kỳ 15:01)

Nguồn: tìm trên mạng ngày 15/11/2026. CHỈ HỌC Ý TƯỞNG — không copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor.

## 1. OpenHands 1.40.0 (12/11/2026) + Agent SDK / Snowflake RL

- Release 1.40.0 (12/11): Codex subscription auth guidance, chat history page boundaries, Agent Profiles (home model pick khi self-hosted tắt profiles), dùng default branch thật của repo thay vì giả định, i18n Indonesian cho Codex keys.
- 1.39.0 trước đó: multi-org user management, **ACP model switching** (đổi model giữa run), MCP server config support, OHE multi-model LLM discovery với BYOK gating, Jira DC OAuth persistence, **sub-agent task visualizer trong chat UI**, Slack attachment support.
- Agent Canvas 1.34.0 / SDK 1.59.0 (cuối 10/2026); 29 Canvas + 33 SDK release trong 90 ngày — nhịp release rất nhanh.
- **Post-train model ngay trong harness** (OpenHands + Snowflake, 03/11/2026): thay vì rebuild harness trong RL framework, truyền agent config (system prompt, tools, skills, turn budget, context length) thẳng vào training; proxy ghi lại token model sinh ra mỗi turn; task theo format **Harbor** (instruction.md + environment/ sandbox + tests/test.sh, điểm test = reward); mỗi rollout chạy trong Snowflake Cortex Sandbox riêng; skill `cortex-training-rl` cho phép mô tả bằng ngôn ngữ tự nhiên. Đã train Qwen3.5-4B 25 step × 64 rollout/step.
- **Ý tưởng mang về (local-first):** Harbor-format eval task + eval runner nội bộ (chạy task trong sandbox, chấm bằng test script, điểm = reward); export rollout thành training data (JSONL) để user tự fine-tune model local; Agent Profiles (preset model+tools+system prompt theo loại task); ACP-style model switching giữa run; sub-agent task visualizer trong chat UI.
- Bài học bảo mật từ OpenHands: CVE-2026-112346 (9.8) — sandbox server không auth trước SDK 1.52.0; DockerWorkspace bind loopback từ 1.52.0; confirmation mode (Always/Never/ConfirmRisky) — open-bot giữ nguyên loopback-only + confirm risky.

## 2. Letta (MemGPT) — memory blocks, shared memory, sleep-time compute

- v0.16.7 (31/03/2026): context 128K (từ 32K), bỏ giới hạn kích thước block, thêm GPT-5.4/GLM-5/MiniMax M2.7. Source V1 đã archive (08/2026, ~367k dòng bị gỡ khỏi main), source hiện tại là `letta-ai/letta-code`.
- Kiến trúc 3 tầng: **Core memory** (block có tên: `human`, `persona`, `task`, `project`, `safety` — biên dịch thẳng vào system prompt dưới dạng `<memory_blocks>`, agent tự sửa bằng tool `core_memory_replace`/`memory_insert`/`memory_apply_patch`); **Archival memory** (vector store không giới hạn, search khi cần); **Recall memory** (lịch sử hội thoại, query theo ngày/nội dung).
- **Conversations API (01/2026):** nhiều agent chia sẻ memory block — một block attach vào nhiều agent, một agent update thì tất cả thấy ngay, không cần nhắn tin agent-to-agent. Rủi ro: write xấu lan ra mọi agent → chỉ supervisor được write block chia sẻ, block chia sẻ giữ nhỏ.
- **Git-backed memory (cuối 2025):** memory lưu dạng file có version control — versioning, diff, rollback; `block_history` table theo dõi mọi thay đổi bất kể backend.
- **Sleep-time compute (2025):** agent thứ hai chạy nền, ngoài critical path — xử lý transcript, viết `learned_context` vào block chia sẻ, consolidate/invalidate archival record; turn chính chỉ ghi raw fact nhanh, sleep pass dọn dẹp sau.
- V1 deprecate `send_message`/heartbeat + inline `Thought:` token, chuyển sang native reasoning channel (Responses API / Messages API extended thinking).
- **Ý tưởng mang về:** shared memory blocks giữa các bot trong open-bot (block `current_plan`, `organization` attach nhiều bot, chỉ supervisor write); git-backed memory (snapshot block vào file, diff/rollback, block_history); sleep-time consolidation agent chạy nền giữa các turn; block tùy ý do user định nghĩa (`task`, `project`, `safety`).

## 3. Claude Code — Agent Teams (experimental, 2026)

- 5 cấp độ orchestration theo chi phí phối hợp: (1) single agent; (2) subagents (cô lập context, trả về summary); (3) headless pipelines (batch, deterministic); (4) parallel sessions trong git worktrees; (5) agent teams (khám phá song song + giao tiếp chéo). Quy tắc: chỉ leo cấp khi cấp hiện tại chứng minh là thất bại.
- Agent Teams: experimental, bật bằng `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`; lead session spawn teammate là các session độc lập đầy đủ, phối hợp qua **shared task list** (file-locked claiming, dependency-aware) + **mailbox** nhắn tin trực tiếp teammate-to-teammate.
- **7 primitives:** TeamCreate, Task (spawn teammate), SendMessage, + task lifecycle 3 trạng thái, file locking chống double-claim, waves theo dependency chain.
- Khác subagent: subagent chỉ báo cáo về main; teammate nhắn nhau trực tiếp, tự claim việc, thách thức kết luận của nhau.
- Giới hạn đã biết: token cost tuyến tính theo số teammate (~7× session thường với team lớn); teams không dùng worktrees → phải chia file cho từng teammate (2 teammate sửa cùng file sẽ ghi đè); `/resume` không khôi phục teammate đang chạy; 1 session chỉ có 1 team; teammate không tạo team con; teammateMode=tmux cho mỗi teammate một pane; nên bắt đầu 3–5 teammate; subagent tối đa 20 concurrent, nest 3 cấp.
- Agent View (`claude agents`, v2.1.139+ research preview): quản lý nhiều background session, mỗi session tự có git worktree.
- **Ý tưởng mang về:** teams v3 trong open-bot theo đúng 7 primitives (TeamCreate/Task/SendMessage/claim/dependency waves/file lock), lead control layer (delegate mode vs implement mode), teammate pane view (tmux-style trong UI), giới hạn 1 team/session + cảnh báo token cost tuyến tính trong UI, agent-view dashboard cho background sessions.

## 4. Hướng sóng v1.11 (6 đội, mục tiêu +30.000 dòng TS thật)

- **T1 — Memory v11 (Letta-style):** shared memory blocks giữa các bot (chỉ supervisor write), git-backed memory (snapshot/diff/rollback + block_history), sleep-time consolidation agent, block tùy ý (`task`/`project`/`safety`).
- **T2 — Eval + training-data harness (OpenHands/Harbor-style):** Harbor-format eval task (instruction + environment + test.sh), eval runner trong sandbox, điểm test = reward, export rollout JSONL làm training data local, Agent Profiles.
- **T3 — Agent Teams v3 (Claude Code-style):** 7 primitives, shared task list + file-locked claiming + dependency waves, teammate messaging, lead control layer, teammate pane view, cảnh báo token cost.
- **T4 — Coding agent v4:** repo map PageRank v2, sub-agent task visualizer trong chat UI, ACP-style model switching giữa run, Agent Profiles theo loại task.
- **T5 — Voice v10 + realtime:** tiếp nối voice v9/AG-UI, realtime voice v2, AG-UI v3.
- **T6 — Platform/fleet v8 + Composio:** fleet v8, mở rộng Composio + app integrations, provider mới.

## 5. Ghi chú đứng (không đổi)

- Não = model nào cũng được; KHÔNG dữ liệu X; KHÔNG Grok Imagine; voice realtime; BỎ cloud VM/tài khoản/thanh toán — miễn phí, local-first, công khai.
- Live ảnh Gemini KHÔNG thử lại (key miễn phí quota ảnh = 0).
- Local API loopback-only; Composio cloud cần tunnel; trigger tạo bởi user trong Composio.
- Dọn thư mục tạm `.tmp-cli-v105-1UWGZS/` (untracked) trên main trong sóng này.
