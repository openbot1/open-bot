# Repo survey v132 — Agent Skills, agent sandboxes, multi-agent orchestration, Ralph loop

Ngày: 2026-11-17. Chu kỳ 19:01. Chỉ học ý tưởng — KHÔNG copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor.

## 1. Agent Skills — định dạng mở SKILL.md (Anthropic, chuẩn hoá 2025–2026)

- Anthropic công bố Agent Skills làm chuẩn mở ngày 18/12/2025 (agentskills.io); tới 22/10/2026 đã trao lại cho Agentic AI Foundation (Linux Foundation, đồng sáng lập cùng Block và OpenAI).
- Đơn vị cơ bản: một thư mục chứa `SKILL.md` (frontmatter YAML: `name` ≤ 64 ký tự, `description` ≤ 1.024 ký tự) + script/tham chiếu tuỳ chọn. Agent chỉ load name + description lúc bắt đầu (progressive disclosure), đọc toàn bộ SKILL.md chỉ khi task khớp mô tả.
- Hơn 70 nền tảng hỗ trợ cùng format: Claude Code, Codex CLI, ChatGPT, Cursor, VS Code/Copilot, Gemini CLI, Kiro, JetBrains Junie, Block Goose, OpenCode, Windsurf. ~1 triệu skill đã xuất bản, ~280 triệu lượt cài (10/2026).
- Thị trường (marketplace): Skills.sh (Vercel, ra mắt 20/01/2026, 83k+ skill, 8M+ lượt cài, quét bảo mật qua Snyk, CLI-native), SkillsMP (400k+, crawl GitHub + tìm kiếm ngữ nghĩa), ClawHub (OpenClaw, ~10k+, từng dính chiến dịch malware ClawHavoc — bài học: skill phải được quét/xác minh trước khi chạy).
- `allowed-tools` trong Claude Code chỉ pre-approve tool cho lượt gọi skill, không chặn tool khác. Skill sống ở `~/.claude/skills/` (cá nhân) hoặc `.claude/skills/` (project).
- OpenAI có Skills Catalog chính thức (github.com/openai/skills, 13k+ sao, 35 skill curated); Google có repo skills chính thức cài qua `npx skills install`.
- Ý tưởng cho open-bot (T1): skill registry nội bộ theo đúng format SKILL.md mở (tương thích Claude Code/Codex/Gemini CLI để người dùng mang skill đi khắp nơi), loader progressive disclosure, installer từ GitHub/local, quét bảo mật cơ bản trước khi kích hoạt, skill marketplace UI chỉ đọc (local-first, không gọi API marketplace lạ khi chưa có key), bộ skill mẫu do chính open-bot viết (không copy skill của người khác).

## 2. Agent sandboxes — E2B / Daytona / Modal / Vercel / Cloudflare (2026)

- Bài toán: agent viết code thì code phải chạy ở nơi không làm hại host. Ba dạng sản phẩm: code runner vô trạng thái, persistent computer, control plane quản lý fleet.
- E2B: Firecracker microVM, kernel riêng, filesystem + network + process tree riêng, cold start ~150ms, tính phí theo giây cả lúc idle; `sandbox.fork({count})` nhân bản tối đa 20 bản từ snapshot đang chạy (cả filesystem + memory).
- Vercel Sandbox: GA 30/01/2026, Firecracker microVM, snapshot filesystem khi dừng, `Sandbox.fork()` từ snapshot mới nhất, Drives (beta) là storage gắn ngoài bền, chỉ tính phí lúc CPU active (I/O wait miễn phí), concurrency Pro 10.000 sandbox.
- Daytona: pivot sang "composable computers for agents", Series A $24M (02/2026); container mặc định + VM Linux/Windows + GPU sandbox; pause/auto-pause/fork + snapshot ổn định từ 07/2026 (chỉ VM sandbox); filesystem giữ nguyên qua stop/start.
- Modal: VM Sandboxes GA 01/10/2026 (`runtime="vm"`, Cloud Hypervisor, mở Docker/FUSE/nested cgroups); gVisor vẫn mặc định; GPU sandbox chỉ chạy gVisor runtime; lifetime tối đa 24h, memory snapshot thử nghiệm, hết hạn sau 7 ngày.
- Cloudflare Sandbox SDK 1.0 (30/09/2026): Durable Object điều khiển start/stop/snapshot từng sandbox container; cold start 2–3s (chậm nhất nhóm).
- Pattern chung đáng học: snapshot-and-fork (chạy thử suy đoán/speculative execution), pause-with-memory (~1s resume), egress control + timer/lifetime rõ ràng, phân biệt code runner vs persistent computer.
- Ý tưởng cho open-bot (T2, local-first): sandbox engine v2 trên bwrap/overlayfs đã có — thêm snapshot/fork (copy-on-write), pause/resume, per-sandbox egress policy, lifetime cap, UI quản lý sandbox; KHÔNG dùng cloud sandbox (trái hướng local-first, cần key/tiền).

## 3. Multi-agent orchestration — LangGraph / Microsoft Agent Framework / CrewAI (2026)

- Bốn framework Python thống trị 2026 (Microsoft Learn): Microsoft Agent Framework, LangGraph, AutoGen, CrewAI. Không loại trừ lẫn nhau — có thể lồng nhau (Agent Framework điều phối, LangGraph làm subworkflow).
- LangGraph: workflow = state graph có hướng (node = bước/agent, edge = chuyển đổi), typed state dict chảy qua mọi node, checkpointer (thread-scoped: continuity, human-in-the-loop, time travel, fault tolerance) + store (fact/preference cross-thread). LangSmith là observability đi kèm. Nghiên cứu độc lập 2026: 76% success trên workflow vừa (3–5 tool call) vs CrewAI 71%, AutoGen 68%.
- Microsoft Agent Framework 1.0 GA 04/2026: kế nhiệm trực tiếp Semantic Kernel + AutoGen (cùng team Microsoft), workflow data-flow, managed identity, M365 plugins, pattern sequential/concurrent/handoff/group-chat/Magentic-One, CodeAct mode, declarative YAML.
- AutoGen: chuyển sang maintenance mode 2026 (chỉ bugfix/bảo mật), README chỉ người mới sang Agent Framework.
- CrewAI: crew = agent có role/goal/backstory + task pipeline sequential/hierarchical; Flows (2025, `@start`/`@listen`/`@router`) là lớp điều phối event-driven, đáp trả trực tiếp LangGraph.
- Số liệu thực tế đáng nhớ: nghiên cứu 6.259 agent đã deploy đo được 56,6% task success — thiết kế recovery quan trọng hơn chọn framework.
- Ý tưởng cho open-bot (T3): engine orchestration native TypeScript — state graph có typed state + checkpointer (resume/time-travel), interrupt/HITL, subgraph, supervisor + handoff + sequential/concurrent/group-chat theo mẫu Agent Framework; KHÔNG port code Python, tự viết theo ý tưởng.

## 4. Ralph Wiggum loop — vòng lặp coding tự trị (Geoffrey Huntley, 07/2025)

- Vấn đề: agent dài hơi bị context saturation, tự tuyên bố "xong" dựa trên summary sai (Anthropic xác nhận 11/2025).
- Cách làm: vòng lặp bash chạy agent với context TRỐNG mỗi lượt (`while :; do cat PROMPT.md | claude-code; done`), tối đa N lượt, dừng khi agent output `<promise>DONE</promise>` / `COMPLETE`. Memory chuyển từ chat history sang filesystem: spec/PRD JSON + `progress.txt` append-only + git history.
- PRD-based: danh sách user story; mỗi lượt pick 1 story chưa xong → implement → chạy test/typecheck → commit → cập nhật progress. Mỗi commit PHẢI xanh test + type — feedback loop là yếu tố quyết định.
- Anthropic có plugin chính thức `/ralph-loop` (Claude Code plugin, `--max-iterations`, `--completion-promise`); Vercel AI SDK và Block Goose cũng adopt; snarktank/ralph 12,5k+ sao; chi phí thực tế: vòng 50 lượt trên codebase vừa ~$50–100+ API.
- Khác biệt quan trọng: plugin loop trong cùng session (context vẫn tăng) vs bash loop spawn process mới mỗi lượt (chống context bleed tốt hơn cho job cực dài).
- An toàn: BẮT BUỘC sandbox — Ralph dùng `--dangerously-skip-permissions`; skill ralph-wiggum yêu cầu phát hiện môi trường container trước khi chạy; cấm sửa/xoá test để gian lận metric.
- Ý tưởng cho open-bot (T4): Ralph loop engine nội bộ — PRD JSON, progress file append-only, fresh-context mỗi lượt, completion-promise, cap lượt/chi phí, bắt buộc chạy trong sandbox (từ chối nếu không có sandbox), eval hook ghi lại pass/fail từng lượt.

## 5. Evals + observability (hướng T5)

- LangSmith: trace đầy đủ theo node (đi kèm LangGraph); Braintrust: scoring + dataset eval; Arize Phoenix: tracing open-source. Pattern chung: span/trace theo chuẩn OTel GenAI (survey v130 đã nghiên cứu), dataset + scorer + regression report, tách eval khỏi telemetry sản phẩm.
- Ý tưởng cho open-bot (T5): eval harness nội bộ — trace store local (span OTel GenAI-compatible), dataset eval cho tool/agent, scorer (pass/fail + latency + token), báo cáo regression theo sóng; KHÔNG gửi trace ra ngoài mặc định.

## 6. Ghi chú chống trùng sóng trước

- v130 survey: Temporal durable execution, OTel GenAI observability, local inference broker.
- v131 survey: Google ADK 2.0, Vercel AI SDK 6/7, LiveKit/Pipecat voice, agent sandboxes (tổng quan).
- v132 KHÔNG lặp lại: đi sâu implementation — Skills format (mới), sandbox snapshot/fork local (v131 mới dừng ở tổng quan), orchestration graph engine (mới), Ralph loop (mới), eval harness (mới).

## Nguồn (chỉ để đối chiếu ý tưởng)

- https://baeseokjae.github.io/posts/agent-skills-marketplace-guide-2026-claude-codex-cursor-and-gemini-cli/
- https://www.termdock.com/en/blog/agent-skills-guide
- https://www.paperclipped.de/en/blog/agent-skills-open-standard-interoperability/
- https://nextgentrainingacademy.com/blog/ai-news-2026-10-24-agent-skills-open-standard
- https://cloudrps.com/blog/ai-code-execution-sandbox-e2b-vercel-daytona/
- https://www.developersdigest.tech/blog/ai-agent-code-sandbox-comparison-2026
- https://fly.io/learn/agent-sandbox-providers/
- https://learn.microsoft.com/en-us/training/modules/aaai-implement-multi-agent-orchestration-azure-ai-foundry/6-compare-orchestration-frameworks
- https://aiintegrator.in/blog/best-multi-agent-ai-framework-for-enterprise/
- https://www.spheron.network/blog/langgraph-vs-crewai-vs-autogen-2026/
- https://threadreaderapp.com/thread/2007924876548637089.html
- https://www.clawdbytes.com/article/2026-10-30-the-ralph-wiggum-loop-explained-why-ai-agents-quit-long-tasks-halfway-and-the-si
- https://www.atcyrus.com/stories/ralph-wiggum-technique-claude-code-autonomous-loops
