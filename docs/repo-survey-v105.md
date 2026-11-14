# Repo survey — v1.05 (14/11/2026)

Nghiên cứu cho chu kỳ v1.05. CHỈ HỌC Ý TƯỞNG, không copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor.

## 1. OpenMausBot v0.1.146 (milind-soni/OpenMausBot, TypeScript, Apache 2.0)

Tham chiếu kiến trúc chính cho open-bot (đã chọn từ 09/11): bot chạy trên các CLI đã đăng nhập sẵn trên máy user (`claude`/`codex`/`grok`), harness server local trên 127.0.0.1, dữ liệu ở `~/.openmausbot`, mỗi bot có model + computer (cloud Linux desktop / Local VM / máy của user) + 500+ app qua Composio, Electron + React 19.

- **Team YAML (ý tưởng áp dụng — đội T3):** định nghĩa team bằng file YAML khai báo (members, shared bots, quota computer theo bot), có lệnh validate/dry-run/apply/export/diff. File khai báo là source of truth, apply chỉ ghi JSON dẫn xuất — tách "khai báo con người đọc được" khỏi "state máy đọc".
- **Model refresh (ý tưởng áp dụng — đội T3):** làm mới danh sách model từ provider qua endpoint list chuẩn của từng provider (Ollama `/api/tags`, OpenAI-compatible `/v1/models`, Gemini `/v1beta/models?key=`, Anthropic qua API list), cache lại, không gọi model. Mỗi provider một fetcher riêng, timeout ngắn, lỗi rõ ràng thay vì crash.
- **Doctor / headless (ý tưởng áp dụng — đội T3):** lệnh `doctor` kiểm tra sức khoẻ hệ thống (Node, provider đã cấu hình, Ollama local, MCP servers, RAM, ổ đĩa, port headless) với exit code phân biệt lỗi/cảnh báo; chế độ headless chạy core không UI, log ra file, có lệnh `logs` xem đuôi log.
- **Computer v2 / quota (ý tưởng áp dụng — đội T3):** mỗi bot gắn một "computer" (mức box, số core/RAM/disk), quota kiểm tra trước khi chạy để không làm nặng máy user; team YAML là nơi khai quota.

## 2. MCP 2026-07-28 — stateless core, MRTR server side, Tasks extension

Tiếp nối survey v1.04 (spec 2026-07-28, SEP-2575/2322/2663). Đào sâu phần phía server cho v1.05:

- **MRTR phía server (ý tưởng áp dụng — đội T2):** một tool handler dài cần hỏi user giữa chừng thì không block: trả `needs_elicitation` cho client, giữ round state trong session có TTL, resume khi client gửi follow-up kèm `inputResponses`. Session store có cap số lượng + evict session cũ nhất; quá TTL thì lỗi rõ ràng thay vì resume round đã chết. Validate answer theo schema trước khi resume.
- **Tasks extension poll-based (đã có từ v1.04, đội T2 mở rộng):** task dài chạy nền, client poll `tasks/get`, gửi input giữa chừng bằng `tasks/update`; không giữ stream mở, không blocking result.
- **OAuth iss validation (đã có từ v1.04, đội T2 củng cố):** kiểm tra issuer của token khớp metadata server, theo hướng siết auth của spec mới.

## 3. Memory 2026 — Mem0 v3, Letta, Zep (đào sâu cho memory v6)

Tiếp nối survey v1.03/v1.04:

- **ADD-only record store + versioning (ý tưởng áp dụng — đội T1):** memory chỉ append, không sửa/xoá trực tiếp; mỗi bản ghi có version, bản cũ bị supersede chứ không mất; import phải idempotent (không hồi sinh bản đã supersede). Lịch sử đầy đủ phục vụ export/audit.
- **Multi-scope + shared blocks (ý tưởng áp dụng — đội T1):** record thuộc scope (bot/team/user/global), block chia sẻ giữa các bot trong team; fused retrieval kết hợp nhiều nguồn (vector/keyword/graph/recency) rồi xếp hạng lại.
- **Sleep-time compute (ý tưởng áp dụng — đội T1):** gom việc nặng (consolidate, migrate, tóm tắt) vào lúc rảnh thay vì chặn đường chat; migration v5→v6 chạy nền có checkpoint.
- **Eval offline cho memory (ý tưởng áp dụng — đội T6):** dataset cố định (facts + câu hỏi recall/temporal/multi-hop) chạy offline với mock retriever/judge, so sánh report giữa các lần chạy, phát hiện regression trước khi đổi retriever.

## 4. Context engineering — window 1M token, tiered compaction

- **Tiered compaction (ý tưởng áp dụng — đội T4):** chia window thành tầng (recent/anchor/summary/spill) theo kind, nén theo tầng khi vượt ngưỡng thay vì cắt đuôi mù; giữ anchor (quyết định, cam kết) lâu hơn chat thường.
- **Verified summaries (ý tưởng áp dụng — đội T4):** summary sau nén phải verify được (trích dẫn lại được nguồn gốc từng khẳng định); summary không verify được thì đánh dấu, không dùng làm ground truth.
- **Per-bot policy + snapshot (ý tưởng áp dụng — đội T4):** mỗi bot một policy nén riêng (preset chat/coding/long-run/minimal), snapshot window export/import được, scheduler nén chạy nền theo lịch; CLI `context` cho cùng state mà desktop dùng (một nguồn thật).
- **Inspector (ý tưởng áp dụng — đội T4):** xem cây window theo kind + stats token, để user thấy context đang chứa gì trước khi quyết định nén tay.

## 5. Voice realtime v4 — multi-session, latency, barge-in

- **Session manager đa phiên (ý tưởng áp dụng — đội T5):** nhiều phiên voice song song, mỗi phiên có log riêng; start/stop/pause/resume rõ trạng thái, không lẫn log giữa các phiên.
- **Latency pipeline + barge-in test (ý tưởng áp dụng — đội T5):** đo độ trễ theo chặng (capture → STT → model → TTS → phát), test barge-in (ngắt lời) có số đo; eval nội bộ chạy offline với mock transport, không cần key thật.
- **Mock transport mặc định (ý tưởng áp dụng — đội T5):** không key, không mạng vẫn chạy được toàn bộ flow voice để test/UI; key thật chỉ gắn khi user cấu hình.

## 6. Platform/fleet v4 — task templates, eval v3

- **Fleet task templates (ý tưởng áp dụng — đội T6):** task định kỳ khai báo một lần (vd "weekly progress report" mỗi 7 ngày), scheduler hỏi template nào tới hạn rồi mới sinh task v4; template quản lý định nghĩa + lịch, không tự chạy task.
- **Eval v3 (ý tưởng áp dụng — đội T6):** chạy suite eval offline, report + so sánh + trend theo thời gian; benchmark retriever bằng dataset cố định; lịch eval (schedule) + regression thresholds.
