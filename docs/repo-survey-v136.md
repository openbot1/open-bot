# Repo survey v136 — nghiên cứu 18/11/2026 (chu kỳ 05:01)

Chỉ học Ý TƯỞNG, không copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor.

## 1. Agent Skills — chuẩn mở (agentskills.io, Agentic AI Foundation)

- Anthropic công bố Agent Skills thành chuẩn mở tháng 12/2025; ngày 22/10/2026 tặng chuẩn này
  cho Agentic AI Foundation (Linux Foundation, cùng nhà với MCP, AGENTS.md, goose).
  Hơn 70 nền tảng đã tích hợp (ChatGPT, Cursor, GitHub Copilot, VS Code...); báo cáo
  ~1 triệu skill đã xuất bản, ~280 triệu lượt cài.
- Định dạng: một thư mục chứa `SKILL.md` (frontmatter YAML: `name` + `description` bắt buộc;
  `license`, `compatibility`, `metadata`, `allowed-tools` (thử nghiệm) tùy chọn), kèm
  `scripts/`, `references/`, `assets/` tùy chọn. Tên skill = tên thư mục, chỉ chữ thường/số/gạch nối.
- Progressive disclosure 3 tầng: discovery chỉ nạp name+description; activation nạp toàn bộ
  SKILL.md; execution mới mở scripts/references.
- Mỗi host vẫn quét thư mục riêng: Claude Code `.claude/skills`, Codex `.agents/skills`,
  Copilot `.github/skills`, OpenCode `.opencode/skills` (cũng đọc `.claude/skills`,
  `.agents/skills`). Vị trí chuẩn chung: `.agents/skills`.
- Có SDK tham chiếu `skills-ref` để validate một skill theo spec.
- Nguồn: https://www.ahood.dev/blog/agent-skills-open-standard,
  https://app.thecompanion.sh/blog/agent-skills-open-standard-vs-vendor-folders,
  https://dev.to/tjsingh007/one-skillmd-every-agent-how-to-build-a-single-agent-skill-that-works-in-claude-code-codex-990
- Ý tưởng cho open-bot (T2 skills v15): import/export skill đa nền tảng (bản chuẩn
  `.agents/skills` + liên kết/copy sang `.claude/skills`, `.github/skills`, Codex);
  validator theo spec (frontmatter, tên thư mục, `allowed-tools`); progressive disclosure
  trong loader hiện có; registry skill có trường `compatibility`.

## 2. OpenHands 1.25 → 1.38 (10/2026 – 11/2026)

- Per-conversation Docker runtime (1.34.0): mỗi conversation một runtime riêng, trang Runtime mới.
- Built-in ACP agents mới: OpenCode và Pi làm agent ACP cho backend local (1.27.0);
  Agent Canvas chạy Claude Code / Codex / Copilot qua ACP trong cùng một giao diện.
- Agent profiles: persona + hướng dẫn riêng từng profile, chọn skill từ catalog của server
  cho từng profile.
- Secret requests: agent xin secret qua modal trong conversation (1.28.0), nhập an toàn giữa phiên.
- Conversation budget meters (1.38.0): hiển thị ngân sách conversation; plugin config thực thi
  được sửa được; automation-aware install; prompt + plugin presets theo profile.
- Large Codebase SDK: map dependency toàn hệ thống, điều phối thay đổi đúng thứ tự, nhiều
  agent làm song song không xung đột.
- Automations: setup split-panel, form hỗ trợ agent-assisted action, lưu draft; scheduled PR review.
- ~72% SWE-Bench Verified với model mới nhất; 80.000+ GitHub stars.
- Nguồn: https://ai-news.cortexit.de/openhands/2026-10,
  https://daily.rclabs.in/i/openhands-v1-38-0-fa5c77,
  https://www.openhands.dev/blog/openhands-product-update---may-2026
- Ý tưởng cho open-bot (T4 sandbox v4 + agent profiles): runtime riêng theo conversation
  (sandbox v4); agent profile (persona + skill chọn lọc + LLM profile riêng); budget meter
  theo conversation (token/$/thời gian); secret-request flow (agent xin secret giữa phiên,
  không bao giờ ghi secret vào log/context); Large-Codebase-style dependency map cho coding agent.

## 3. mem0 v3 (04/2026) và memory layer 2026

- mem0 (Apache 2.0, ~67.700 stars): thuật toán 04/2026 — extraction single-pass, ADD-only
  (một LLM call, không tự UPDATE/DELETE); retrieval hợp nhất semantic + BM25 keyword +
  entity matching, ranking theo thời gian; entity linking ghi vào collection phụ `<tên>_entities`.
- Graph memory bị GỠ khỏi SDK mã nguồn mở từ v3, chỉ còn trên Mem0 Platform (gói Custom);
  benchmark LoCoMo 92.5 / LongMemEval 94.4 là số của platform, không phải SDK.
- Hướng thay thế mã nguồn mở cho graph memory: Graphiti (Zep) — bi-temporal knowledge graph
  (hai timeline: fact đúng khi nào + học được khi nào; fact cũ bị đánh dấu invalid, không xóa);
  Cognee (graph + vector local); Letta (memory gắn trong agent); Hindsight (graph + time-range recall).
- Sáu tầng đọc memory 2026: token (transcript) → vector → graph (triple có typed edge)
  → spatial/temporal → feature-level → trainable memory.
- Lưu ý: SDK mem0 gửi telemetry PostHog mặc định (tắt bằng MEM0_TELEMETRY=false); rò rỉ
  cross-tenant trong session scoping được công bố 20/10/2026 — bài học về isolation theo scope.
- Nguồn: https://aiagentmemory.org/articles/what-is-mem0-ai/,
  https://www.reviewramble.com/github-repos/mem0,
  https://taku.ai/blog/mem0-alternatives,
  https://kennethlaw325.github.io/awesome-llm-knowledge-systems/chapters/06-agent-memory/
- Ý tưởng cho open-bot (T1 memory v17): extraction add-only single-pass; entity linking
  (collection phụ + typed edge `lives_in`/`prefers`/`owns`...); conflict detector +
  update resolver (overwrite/merge/giữ cả hai kèm provenance); bi-temporal graph
  (validFrom + learnedAt, invalid thay vì xóa — khớp hướng memory v15/v16 hiện có);
  retrieval fusion semantic+keyword+entity + time-aware ranking; scope isolation chặt
  (bài học từ vụ rò rỉ mem0).

## 4. MCP 2026-07-28 — "MCP 2.0", bản sửa lớn nhất từ khi ra mắt

- Stateless core: bỏ handshake `initialize` và header `Mcp-Session-Id`; mọi request mang
  protocol version + capabilities trong `_meta`; thêm `server/discover`; load-balancing
  round-robin thường hoạt động được (SEP-2567, SEP-2575).
- Multi Round-Trip Requests — MRTR (SEP-2322): server KHÔNG còn gửi request ngược cho client
  giữa tool call. Server trả result với `resultType: "input_required"` + `inputRequests`;
  client thu thập đáp án rồi gọi lại method cũ kèm `inputResponses` + `requestState` (opaque).
  Handler phải idempotent trước điểm cần input và không giữ secret trong `requestState`.
  Server-initiated request chỉ còn được phép trong lúc đang xử lý một client request (SEP-2260).
- Elicitation: form mode KHÔNG dùng cho password/API key/token/thanh toán (spec cấm);
  URL mode là kênh duy nhất cho các trường hợp đó (OAuth sign-in, payment page).
- Extensions thành cơ chế chính thức, thương lượng qua field `extensions` trong capabilities,
  mặc định TẮT: MCP Apps (SEP-1865, ổn định 01/2026, `io.modelcontextprotocol/ui`) —
  server render HTML tương tác trong sandboxed iframe, tool khai báo UI template trước để
  host prefetch/cache/security-review; Tasks (`io.modelcontextprotocol/tasks`) — handle
  cho công việc dài, dự kiến vào core.
- Deprecated (SEP-2577, earliest removal ≥ 2027-07-28, tối thiểu 12 tháng báo trước):
  Roots, Sampling, Logging. MCP Registry ~2.000 server (09/2025).
- Auth: OAuth issuer (`iss`) validation bắt buộc (RFC 9207); chuyển từ Dynamic Client
  Registration sang Client ID Metadata Documents để chống reuse credential.
- Nguồn: https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/,
  https://www.ajayk.sh/blog/mcp-resources-prompts-sampling-elicitation-explained/,
  https://dev.to/ali_82f3409ed625e8ba8515b/mcp-20-what-changed-and-how-to-migrate-5586,
  https://www.scalekit.com/blog/mcp-elicitation-explained
- Ý tưởng cho open-bot (T3 MCP Apps v16 + MCP 2026-07-28): client stateless (mỗi request
  tự mang version + capabilities; `server/discover`); MRTR elicitation (input_required →
  gọi lại với inputResponses + requestState, handler idempotent); URL-mode elicitation cho
  secret/credential (không bao giờ đi qua form/context); extension negotiation
  (Apps/Tasks mặc định tắt, khai báo capabilities); lộ trình deprecate Roots/Sampling/Logging
  theo policy 12 tháng; `iss` validation cho OAuth.

## 5. Hướng đội sóng v1.36 (base merge/v135 @ 4e5d1f2b, 781.802 dòng TS)

| Đội | Hệ thống | Số mới (kiểm chứng bằng ls trên base, không đoán) | Ý tưởng chính |
|-----|----------|---------------------------------------------------|---------------|
| T1 | memory | v16 → **v17** | mem0-v3 add-only extraction, entity linking, conflict resolver, bi-temporal graph, retrieval fusion |
| T2 | skills | v14 → **v15** | Agent Skills chuẩn mở: import/export đa nền tảng, validator spec, allowed-tools, progressive disclosure |
| T3 | MCP Apps | v15 → **v16** + MCP 2026-07-28 | stateless client, MRTR elicitation, server/discover, extension negotiation, URL-mode cho secret |
| T4 | sandbox + profiles | sandbox v3 → **v4** | per-conversation runtime, agent profile (persona+skill+LLM), budget meter, secret-request flow |
| T5 | voice | v22 → **v23** | tiếp nối voice v22 (đánh giá + realtime) |
| T6 | fleet | v22 → **v23** | tiếp nối fleet v22 (multi-bot, scheduling, placement) |

Mục tiêu: merge/v136 ≥ 811.802 dòng TS (+30.000). Mỗi đội: worktree + branch riêng
(`v136-tN`), commit sớm và thường xuyên, test cho mọi tính năng, i18n 6 locale,
đăng ký tool mới vào registry (tên tool chỉ `[A-Za-z0-9_-]`, KHÔNG dấu chấm —
bài học fleet v21/v22), KHÔNG độn dòng, KHÔNG copy code.
