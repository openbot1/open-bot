# Repo survey v1.13 — Agent Skills, MCP Apps, repo map, coding agent git-native

Ngày: 2026-11-15 (chu kỳ 21:01). Điểm xuất phát: main `a9bb7f9`, 487.839 dòng TS (v1.12 xong, suite GREEN 7278/7297).
CHỈ HỌC Ý TƯỞNG — không copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor.

## 1. Agent Skills — chuẩn mở SKILL.md (Anthropic, 16/10/2025; spec mở 18/12/2025)
- Skill = thư mục chứa `SKILL.md` (bắt buộc) + `scripts/` + `references/` + `assets/` (tùy chọn).
- Frontmatter: `name`, `description` (bắt buộc); `license`, `compatibility` (≤500 ký tự),
  `metadata`, `allowed-tools` (thử nghiệm — chỉ 2/8 agent parse).
- Progressive disclosure 3 tầng: đọc header mọi skill lúc mở session → load body khi liên quan →
  chỉ chạm scripts/references khi cần. Đây là lần đầu hệ sinh thái agent có đơn vị tùy biến portable.
- Adopter (tới 03/2026): 32 công cụ — Claude Code (canonical, `.claude/skills/`, global `~/.claude/skills/`),
  Cursor (từ 2.4), OpenAI Codex CLI (`~/.agents/skills/`), Gemini CLI, Cline, Goose, Junie, Kiro, Amp,
  TRAE, Mistral, VS Code/Copilot, Snowflake, Databricks. Installer `npx skills add` symlink cho long tail
  (OpenCode, Continue, Roo Code, Windsurf, Devin...). Vercel `skills.sh`: 89.753 skill đã publish (04/2026).
- Anthropic open-source 17 skill production-grade (PDF/Excel/Word/PowerPoint, brand assets, code review, doc QA)
  tại github.com/anthropics/skills. DOE (Genesis Mission, 10/2026): 35 skill khoa học, 23 có script chạy được.
  MiniMax mcode-stack (28/10/2026): 17 skill — subagent-split-check, tool-budget-audit, context-tax-audit,
  long-session-check, handoff-doc, independent-review, trajectory-review.
- Cạm bẫy: case-sensitive `SKILL.md` (Gemini CLI nghiêm), 3 quy ước vị trí thư mục khác nhau,
  `allowed-tools` không đồng nhất. Spec portable, runtime quanh nó thì không.
- Ý tưởng cho open-bot v1.13 (T1): loader SKILL.md theo spec agentskills.io (đọc header → index →
  load-on-demand), registry skill nội bộ + import/export tương thích Claude Code/Codex/Gemini CLI,
  skill marketplace cục bộ, audit tool-budget/context-tax kiểu mcode-stack, skill cho chính open-bot
  (coding, review, memory, voice...). Không copy nội dung skill của Anthropic/DOE/MiniMax.

## 2. MCP Apps — SEP-1865, extension chính thức đầu tiên của MCP (live 26/01/2026, spec 2026-07-28)
- Tool khai báo UI qua `_meta.ui.resourceUri` → resource `ui://...`, MIME `text/html;profile=mcp-app`.
  Host render trong sandboxed iframe; iframe ↔ host bằng JSON-RPC qua `postMessage` (dialect `ui/`:
  `ui/initialize`, `ui/update-model-context`, `ui/message`, `ui/open-link`, `tools/call`).
- `ui/initialize` đưa host context: theme, locale, timezone, platform, display mode, kích thước container.
- 3 display mode: `inline` (chat flow), `fullscreen` (editor/game/dashboard phức tạp),
  `pip` (picture-in-picture: monitoring, timer, media player).
- Host hỗ trợ: Claude (web/desktop), ChatGPT, VS Code/Copilot, Cursor, Goose, Postman, MCPJam, Archestra, PostHog.
  SDK: `@modelcontextprotocol/ext-apps` (`/server`, `/react`, `/app-bridge`), repo `modelcontextprotocol/ext-apps`.
- Mọi action từ UI vẫn đi qua host và cùng một control path (không bypass). Không có component library chuẩn
  (mỗi app tự ship HTML/CSS) — hướng đúng: bộ component chuẩn cho case đơn giản + escape hatch HTML đầy đủ.
- Ý tưởng cho open-bot v1.13 (T2): MCP Apps host trong desktop app (sandboxed iframe, CSP mặc định deny),
  registry `ui://`, 3 display mode, bridge `ui/` JSON-RPC, component kit chuẩn (card/table/metric/form),
  tool nào cũng có thể kèm UI. Nối với MCP Apps/Tasks đã có từ v1.09/v1.10.

## 3. OpenHands — platform layer + Repository Map (MIT)
- OpenHands là platform layer quanh các agent (Agent Canvas local-first, nối Claude Code/Codex/Gemini CLI qua ACP),
  không thay thế agent. Chạy local/VM/cloud/self-hosted, model-agnostic BYOK.
- Repository Map: lúc khởi động build topology symbol-level (class/function/import) + layered summaries để
  context 128k "giữ" được skeleton của codebase triệu dòng; agent điều hướng kiểu senior: jump-to-definition →
  read → edit → test → fix.
- OpenHands + CodeAct v3 + Claude Opus 4.6 đạt 68,4% SWE-bench Verified (2026). Giới hạn: clone vào Docker,
  indexing chậm quá 25k file.
- Ý tưởng cho open-bot v1.13 (T3): repo map v2 — tree-sitter symbol topology, hierarchical summaries theo
  thư mục, incremental index (chỉ re-index file đổi), code graph search, jump-to-definition cho agent loop.

## 4. Aider — coding agent git-native (Apache 2.0, 6,8M PyPI installs)
- Terminal pair-programmer: repo map tree-sitter, edit in-place, mọi thay đổi = unified patch → git commit
  sạch, review được (`git add -p` từng hunk). Slash commands `/add @file`, `/test`, `/commit`.
- Vòng "chat → patch → confirm → commit". Hỗ trợ 100+ ngôn ngữ, mọi provider kể cả Ollama local.
- Benchmark polyglot 225 bài Exercism × 6 ngôn ngữ, top 88,0%. Cạm bẫy: `/add` repo khổng lồ làm nổ context —
  chỉ add module liên quan hoặc dùng repo-map flag nhẹ.
- Ý tưởng cho open-bot v1.13 (T4): coding agent v5 git-native — patch preview trước khi apply, auto-commit
  message có nghĩa, `/add` có chọn lọc theo repo map, eval harness kiểu SWE-bench (issue → patch → test)
  chạy local, rollback theo commit.

## 5. Hướng sóng v1.13 (6 đội, mỗi đội một hệ thống lớn)
- T1 skills-v13: Agent Skills loader + registry + marketplace cục bộ + audit (tool-budget/context-tax).
- T2 mcp-apps-v13: MCP Apps host (ui://, iframe sandbox, ui/ JSON-RPC, 3 display mode, component kit).
- T3 repomap-v13: repo map v2 (tree-sitter topology, hierarchical summaries, incremental index, code graph).
- T4 coding-v13: coding agent v5 git-native (patch preview, auto-commit, eval harness SWE-bench-style).
- T5 voice-v13: voice v12 (realtime: barge-in/interruption, TTS streaming, turn-taking).
- T6 platform-v13: platform/fleet v10 (event-triggered + scheduled agents, multi-user fleet, ACP control center mở rộng).

## 6. Ghi chú
- v1.12 push: gói 1/9 thẻ duyệt vẫn chờ (từ 21:18 15/11) — KHÔNG đẩy lại gói đó.
- Live ảnh Gemini KHÔNG thử lại (key miễn phí quota ảnh = 0).
