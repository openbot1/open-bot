# Khảo sát repo — sóng v1.25 (17/11/2026, chu kỳ 05:01)

Nghiên cứu phục vụ sóng v1.25. CHỈ HỌC Ý TƯỞNG — không copy code/text/tài sản
của bất kỳ repo nào, của xAI/Cursor.

## 1. Letta / letta-code — memory là primitive của agent

- Nguồn: letta-ai/letta (V1 server đã về hưu, nhánh `archive`), runtime hiện tại
  là `letta-ai/letta-code` 0.34.42 (npm `@letta-ai/letta-code`, release 06/11/2026),
  ~25,3k stars, Apache-2.0. Gốc là MemGPT (UC Berkeley, arXiv:2310.08560).
- Ý tưởng đáng học:
  - **Memory blocks**: core memory biên dịch thẳng vào system prompt dưới dạng
    `<memory_blocks>`; agent tự sửa block bằng tool, sửa xong prompt được
    biên dịch lại theo từng block. Memory là state của agent, không phải RAG.
  - **Git-backed memory (MemFS, cuối 2025)**: memory lưu dạng file có version,
    diff, rollback được; đồng bộ với repo của user.
  - **Conversations API (01/2026)**: nhiều agent chia sẻ memory blocks, chạy
    song song mà vẫn giữ hiểu biết chung nhất quán.
  - **Rủi ro đã thấy**: agent được tin để tự sửa core memory của mình — đúng
    sai phụ thuộc tool rules, exact-string edits, read-only flags và runtime
    enforcement. Đây là bài học an toàn trực tiếp cho open-bot.
  - 15+ provider qua `ModelSettings` tập trung; state bền qua 51-model ORM.
- Áp vào v1.25: T1 memory v21 — memory block có version/diff/rollback kiểu git,
  block chia sẻ giữa các bot, cờ read-only + runtime enforcement cho block do
  agent tự sửa.

## 2. Harness Engineering — giải phẫu 11 coding harness (arXiv 2609.00006, 07/2026)

- Nguồn: arxiv.org/html/2609.00006v1 — nghiên cứu source-code của Claude Code,
  Codex CLI, Gemini CLI, Mistral Vibe, OpenHands, Aider, Mini-SWE-Agent, Hermes,
  Pi, OpenCode, OpenClaw, cộng Omnigent (meta-harness) làm điểm đối chiếu.
- Ý tưởng đáng học:
  - **Bảy subsystem chuẩn của một harness** (định nghĩa + min/max implementation
    cho từng cái), 29 design pattern lặp lại, 18 khuyến nghị thiết kế, scaffold
    harness tối thiểu 90 dòng.
  - **OpenHands V1 SDK**: core tí hon — Agent stateless phát Actions,
    Conversation chạy vòng lặp + lưu append-only EventLog, Workspace (local/Docker)
    thi hành Actions trả Observations, LLM qua LiteLLM. Bài học V0 → V1: V0 có
    140+ config field / 15 config class / 2,8k LOC chỉ cho config — V1 gộp lại
    vì controller không xứng đáng với độ phức tạp của nó.
  - **Aider**: 13 polymorphic edit format, repo-map, git-first (mọi sửa thành
    commit, revert bằng một lệnh), architect mode tách planner + editor.
  - **OpenCode**: kiến trúc client/server triệt để nhất trong corpus.
  - **Hermes**: skill loop tự cải thiện, harness tăng trưởng nhanh nhất GitHub.
  - **OpenHands**: ~77% SWE-Bench Verified với Claude Sonnet 4.5; CodeAct;
    PromptRegistry với cache tiers (static/dynamic two-block assembly).
- Áp vào v1.25:
  - T2 protocols/harness v5 — đối chiếu open-bot với bản đồ 7 subsystem, rút
    gọn config phình to theo bài học V0→V1, event log append-only cho run.
  - T3 coding agent v13 — nhiều edit format đa hình (ý tưởng Aider), repo-map v2,
    chế độ architect tách planner/editor, git-first cho patch.
  - T6 platform/fleet v19 — meta-harness/orchestrator (ý tưởng Omnigent) điều
    phối nhiều harness con.

## 3. Trạng thái pipeline khi khảo sát (đã kiểm chứng 05:01–05:20 17/11)

- Nhánh `main` cục bộ đang ở `063970db` (v1.17, **609.892 dòng TS**, suite GREEN
  8540/8559). Nhánh `merge/v118` ở `669ec8fb` (fix round 2, 632.936 dòng) —
  chưa lên main. Các nhánh merge/v119–v124 đều đã có nhưng KHÔNG chứa commit
  v118 (kiểm chứng bằng merge-base); main vẫn ở v1.17.
- Nhánh gộp sóng này `merge/v125` được rebase lên `merge/v124` @ `f1296061`
  (**684.986 dòng TS**, stack xa nhất hiện có: v123 @ 4437393e + survey v124).
  Lưu ý: merge/v123 đã tiến thêm tới `90939686` (T6 fleet v19 + plugin SDK v1)
  sau khi v124 tách nhánh — coordinator v1.25 tự quyết có rebase tiếp hay không.
- Coordinator đang chạy: v1.19 (stale ~1,6h không hoạt động), v1.20, v1.22, v1.24
  (mới, hoạt động). v1.21 và v1.23 đã báo xong (merge xong, build cuối chạy detached).
- Agent hạ cánh v1.18 đã cử riêng: kiểm chứng merge/v118 rồi fast-forward main
  lên `669ec8fb` nếu xanh; agent đẩy GitHub v1.18 cử lại sau khi có kết luận đó
  (agent đẩy trước chết do daemon restart ngay sau khi cử).
- Sóng tiếp theo: **v1.25**, base merge/v124 @ f1296061 (684.986 dòng).

## 4. Hướng đội cho v1.25 (mục tiêu +30.000 dòng TS thật)

Số phiên bản đặt CAO HƠN sóng v1.24 đang chạy (memory v22, protocols v7,
coding v15, Composio v7, voice v21, fleet v20 + plugin SDK v2) để tránh đụng độ:
- T1 memory v23: git-backed memory blocks + block chia sẻ + read-only enforcement.
- T2 protocols/harness v8: bản đồ 7 subsystem, event log append-only, gọn config.
- T3 coding agent v16: edit format đa hình, repo-map v2, architect mode.
- T4 Composio v8: polling/trigger tiếp + skill loop tự cải thiện (ý tưởng Hermes).
- T5 voice v22: realtime tiếp (mock-only khi chưa có key thật; KHÔNG thử live ảnh Gemini).
- T6 platform/fleet v21: meta-harness/orchestrator + plugin SDK v3 + UI panel tương ứng.
- Mọi đội: test cho mọi tính năng, i18n 6 locale, wire registry, build +
  typecheck xanh 4 workspace, full suite dưới `xvfb-run -a npm test` xanh,
  build lại sau mỗi lần gộp rồi mới chạy suite.
