# Repo survey v1.28 — 2026-11-17

Nghiên cứu phục vụ sóng v1.28. CHỈ HỌC Ý TƯỞNG — không copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor.

## 1. OpenHands Software Agent SDK v1.60.1 (05/11/2026) — event-sourced conversation engine

- Agent = vòng lặp `Agent.step()` trên một conversation có event-sourced state: mọi
  message, action, observation đều là event append-only trong EventLog; state hiện tại
  suy ra bằng replay, không lưu snapshot mutable làm nguồn chân lý.
- EventLog bền trên FileStore + file locking (flock), SecretRegistry redaction secret
  trước khi ghi log; per-conversation Docker runtime từ v1.49.0 — mỗi conversation có
  sandbox riêng, ranh giới cô lập rõ ràng.
- Hỗ trợ ACP (Agent Client Protocol); fix CVE-2026-109518 trong bản 1.60.1.
- Paper MLSys 2026 (arXiv 2511.03690): V1 giảm 61% lỗi do hệ thống so với V0 trong
  15 ngày production — event sourcing + runtime theo conversation là nguyên nhân chính.
- **Đem vào open-bot**: T4 event-sourced runtime v1 — append-only event log làm single
  source of truth cho conversation, deterministic replay, redaction secret, sandbox
  theo từng conversation.

## 2. Letta v0.16.7 (31/03/2026) — memory agent tự vận hành

- Core memory blocks do agent tự sửa bằng tool (đã bỏ giới hạn kích thước block,
  context 128K); archival vector memory + recall memory; git-backed memory (cuối 2025);
  skill learning (12/2025); Conversations API (01/2026) cho nhiều agent chia sẻ memory block.
- Sleep-time compute: background agent củng cố memory giữa các session, ngoài critical
  path của chat — memory tốt dần mà không làm chậm phản hồi.
- **Đem vào open-bot**: T1 memory v20 — core memory blocks agent tự sửa bằng tool +
  sleep-time consolidation chạy nền giữa các session.

## 3. Aider repomap — symbol-level retrieval (Aider 0.86.2, 02/2026)

- Repomap = tree-sitter symbol graph + personalized PageRank: hệ số 10x cho identifier
  user nhắc tới, 50x cho file đã trong chat; trả về symbol/function liên quan thay vì
  cả file — signal ratio hiện chỉ 10–20% ở mức file, cao hơn nhiều ở mức symbol.
- Search-replace blocks thắng unified diff: ép unified diff làm tỉ lệ completion đúng
  rơi 59% → 26%; ngưỡng repomap ~400 dòng.
- Phát triển Aider đã chậm lại từ đầu 2026 — pattern đã ổn định, học được trọn vẹn.
- **Đem vào open-bot**: T3 coding agent v13 — symbol graph + personalized PageRank
  repomap (bias theo file trong chat + identifier user nhắc), tool trả về function/symbol
  thay vì cả file, search-replace edit engine (không ép unified diff).

## 4. MCP — Files extension draft + Tasks + bảo mật (spec 2026-07-28)

- Spec MCP 2026-07-28 stateless; draft Files extension `io.modelcontextprotocol/files`
  (blog 10/11/2026, thử nghiệm): truyền file out-of-band qua `x-mcp-file`,
  `upload_required` + HTTPS target, SHA-256 digest TÙY CHỌN trong draft — kiểm tra size
  không bằng kiểm tra nội dung (2 file giá chỉ khác 1 chữ số đảo vẫn cùng size).
- Tasks extension opt-in (Claude Code 2.1.319 / TS Agent SDK 0.3.319,
  `CLAUDE_AUTO_BACKGROUND_TASKS=1`): task chạy nền, báo kết quả khi xong.
- Chu kỳ phát hành 6 tháng, bản tiếp 2027-03-30; 6 security advisory 11/11/2026
  (mcp-server-git command-exec High, filesystem path escape); IETF draft MCP over MOQT (11/2026).
- **Đem vào open-bot**: T2 protocols v5 — MCP Files extension với SHA-256 BẮT BUỘC cả
  2 chiều (khác draft: draft để tùy chọn), requestState chống replay; + MCP Tasks
  chạy nền. SHA-256 bắt buộc là quyết định an toàn của ta, không phải của draft.

## 5. Bối cảnh sóng

- Các sóng trước đã làm memory tới v19, protocols v4, coding agent v12, voice v18,
  platform/fleet v17 — sóng này nối tiếp số phiên bản, không quay lại số cũ.
- Sóng v1.27 đang chạy song song (merge/v127); v1.28 base trên merge/v127 @ 2635f06d,
  hạ cánh bằng rebase lên main hiện tại + kiểm chứng lại toàn bộ, không fast-forward mù.
