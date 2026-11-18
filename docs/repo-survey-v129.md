# Repo survey v1.29 — 2026-11-17

Nghiên cứu phục vụ sóng v1.29. CHỈ HỌC Ý TƯỞNG — không copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor.

Baseline merge/v129 @ b74991e4: 684.986 dòng TS chuẩn, i18n vi 6.628 keys.

## 1. Open Memory Spec / OKF — memory portable (Google Cloud OKF v0.2, 09/11/2026)

- OKF (Open Knowledge Format): memory là thư mục file Markdown, mỗi file một YAML
  frontmatter với key bắt buộc duy nhất `type`; các field tùy chọn: nguồn (`sources`),
  người viết, người kiểm chứng (`verified`), hạn hết hiệu lực (`stale_after`),
  `code_refs` gắn khái niệm với đường dẫn source (v0.2.0, 12/09/2026).
- Triết lý: file format thay vì memory database — bundle nằm trong git, review cùng
  code, backup cùng code; tìm kiếm BM25 dưới 300 micro giây/truy vấn (okf-agent-memory,
  Go binary, MCP over stdio, không daemon).
- Song song: LoreKit đề xuất chuẩn kiểu OpenTelemetry cho agent memory (11/2026) —
  4 format không tương thích đang chạy cùng lúc; MacPaw Portable Memory (.mem bundle,
  serialization byte-reproducible, deletion tombstones, optional signing); Open Memory
  Protocol draft 04/2026 (ZIP + manifest); Cognee COGX bridge Mem0/Letta/Zep.
- W3C AI Agent Memory Interoperability CG (charter v1.0, 19/06/2026): phạm vi hẹp —
  hình dạng chung để agent lưu/truy hồi/chia sẻ/xóa memory xuyên vendor; tham chiếu
  normative draft-saihm-memory-protocol-01; IETF agentproto BoF tại IETF 126
  (Vienna, 07/2026) đang xem xét charter working group.
- **Đem vào open-bot**: T1 memory v21 — export/import memory cross-format
  (OKF-style Markdown+YAML, MemFS git-backed blocks, OpenHands 2-tier MEMORY.md +
  daily logs), converter giữa các format, memory sync + versioning, tombstone xóa,
  sleep-time consolidation mở rộng.

## 2. Claude Agent SDK TS 0.3.322 (10/11/2026) — background MCP tasks

- Background MCP tasks (0.3.319): với `CLAUDE_AUTO_BACKGROUND_TASKS=1` + streaming
  input (prompt là async iterable), MCP task chạy nền, trả về ngay task id thay vì
  giữ call mở; `tool_result` là placeholder, kết quả thật đến trong system message
  `task_notification` (task_type `"mcp_task"`). Không có trên Bedrock/Vertex/Foundry.
- Per-tool `permission_policy` trên SDK MCP servers (0.3.301); `reloadPlugins`
  (addPlugins); `credential_expires_at`; subagent chạy nền mặc định
  (`run_in_background`, Claude Code v2.1.198); Bash/PowerShell timeout mặc định 30
  phút, tối đa 2 giờ cho lệnh nền.
- **Đem vào open-bot**: T2 protocols v6 — background MCP tasks kiểu SDK (task id,
  placeholder tool_result, task_notification), per-tool permission_policy, MCP OAuth
  elicitation/reconnect, ACP v2 draft + A2A.

## 3. ACP merge vào A2A dưới Linux Foundation; MCP vượt 200 server

- ACP (Agent Client Protocol) đã merge vào A2A dưới Linux Foundation; MCP vượt 200
  server implementations; ACP v2 draft đang soạn; ACP registry ~45 agents; Android
  Studio BYOA — ACP đóng vai trò như LSP cho agent (chuẩn giao tiếp client-agent).
- **Đem vào open-bot**: T2 protocols v6 — ACP v2 draft + A2A alignment, registry
  agent discovery, BYOA-style client adapter.

## 4. OpenHands Software Agent SDK 1.60.1 (05/11/2026) — event-sourced + condenser

- Conversation event-sourced: mọi message/action/observation là event append-only;
  state suy ra bằng replay. Per-conversation Docker runtime. Fix CVE-2026-109518.
- Condenser (ý tưởng từ hệ sinh thái OpenHands): nén context từ event stream khi
  vượt ngưỡng — tóm tắt các event cũ thành summary event, giữ event log replayable.
- **Đem vào open-bot**: T3 coding agent v14 — condenser nén context từ event stream,
  stuck detection + recovery, reasoning-block persistence (thinking_blocks /
  reasoning_content replayable qua event log).

## 5. Composio — background long jobs + polling

- Long job không giữ call mở: submit → job id → poll trạng thái → kết quả; polling
  có backoff, timeout, cancel; per-conversation sandbox boundary cho tool call.
- **Đem vào open-bot**: T4 Composio v6 — background long jobs + polling, mở rộng
  toolkit/app integrations, per-conversation sandbox boundary mở rộng.

## 6. Voice realtime — session persistence + eval

- Session realtime cần persistence/resume: checkpoint phiên, resume sau ngắt,
  eval harness đo chất lượng (prosody, turn-taking, latency) thay vì chỉ test mock.
- **Đem vào open-bot**: T5 voice v20 — realtime voice session persistence/resume +
  eval harness mở rộng, open-turn improvements (nối tiếp prosody TTS v5 của v128).

## 7. Platform/fleet + plugin SDK

- Fleet: nhiều agent/node phối hợp, panel giám sát, plugin SDK versioned với
  capability manifest; desktop panels mới cho fleet health, job queue, plugin store.
- **Đem vào open-bot**: T6 platform/fleet v19 + UI — fleet panels mở rộng, plugin
  SDK v4, desktop panels mới.

## Ghi chú hạ cánh

- Các stack v121–v128 fork từ lịch sử merge/v120 tại 6b7c8769, main KHÔNG phải
  ancestor — hạ cánh sau này cần true merge, KHÔNG fast-forward được.
