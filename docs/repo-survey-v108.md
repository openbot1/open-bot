# Nghiên cứu repo — Sóng v1.08 (2026-11-15)

> CHỈ HỌC Ý TƯỞNG, không copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor.
> Các phát hiện dưới đây là tóm tắt ý tưởng kiến trúc, viết lại bằng lời của mình,
> để định hướng cho 6 đội sóng v1.08.

## 1. Letta (ex-MemGPT, Apache 2.0, ~25k stars, v0.16.7)

- **Memory blocks có thể sửa**: các khối memory (human/persona) là dữ liệu có thể
  chỉnh sửa, được biên dịch thẳng vào system prompt của agent mỗi lượt — memory
  không phải prompt tĩnh mà là trạng thái sống.
- **Ba tầng memory**: core (luôn trong context), archival (lưu trữ dài hạn, recall
  theo nhu cầu), recall (lịch sử hội thoại) — phân tầng rõ ràng thay vì một
  kho chung.
- **Sleep-time compute**: agent nền tự tổ chức lại memory giữa các session, khi
  người dùng không tương tác — dọn dẹp, nén, trích xuất sự kiện.
- **Git-backed memory**: memory được version như code — xem diff, rollback về
  phiên bản cũ, lịch sử thay đổi rõ ràng.
- **Conversations API**: nhiều agent chia sẻ cùng memory blocks — memory là tài
  nguyên dùng chung có quyền, không phải dữ liệu riêng từng bot.
- Nguồn hiện tại là letta-code (npm).

**Áp vào open-bot (T1 memory v9)**: sleep-time compute chạy nền tự động nối với
consolidation v8; git-backed versioning/diff/rollback cho memory blocks; shared-block
registry có quyền đọc/ghi giữa nhiều bot.

## 2. OpenHands (MIT, ~72% SWE-bench Verified)

- **Kiến trúc "tiny core" + V1 modular SDK 4 package** (sdk / tools / workspace /
  agent_server): lõi nhỏ, mọi thứ còn lại là module thay được.
- **CodeAct**: agent viết code thật và thực thi trực tiếp, quan sát output rồi lặp
  — hành động của agent là code, không phải chuỗi tool call rời rạc.
- **EventLog append-only bất biến**: mọi sự kiện của agent ghi vào log chỉ thêm,
  không sửa — replay được toàn bộ phiên, debug bằng time-travel.
- **Large Codebase SDK**: lập map dependency cho repo lớn, nhiều agent song song
  làm việc không xung đột nhờ biết rõ thứ tự thay đổi.

**Áp vào open-bot (T3 harness v4)**: EventLog append-only cho mọi turn (persist +
replay + time-travel debug); CodeAct executor (viết + chạy Python/Bash trong
sandbox, quan sát output, lặp); dependency sweep cho repo lớn để nhiều agent
song song không xung đột. T6 fleet campaign dùng dependency sweep của T3 làm
conflict guard.

## 3. Aider (Apache 2.0, 6,8M PyPI installs)

- **Repo map cho context trên repo lớn**: tóm tắt cấu trúc repo (symbol, import)
  để model luôn biết "đất" đang đứng, cập nhật tăng dần thay vì quét lại.
- **Git-first**: mỗi sửa của agent là một commit — lịch sử sạch, revert được từng
  bước, diff xem được ngay.
- **Architect mode**: planner và editor tách riêng — người lập kế hoạch không viết
  code, người viết code không tự ý đổi kế hoạch.

**Áp vào open-bot (T2 coding agent v2)**: repo map PageRank v2 (đồ thị symbol +
import, cập nhật tăng dần); architect mode planner/editor tách riêng; git-first —
mỗi edit của agent thành 1 commit có thể revert, kèm diff view.

## Hướng dùng chung cho sóng v1.08

- T4 apps/providers v2: mở rộng Composio (toolkit polling + trigger mapping mới),
  thêm 2 provider OpenAI-compatible mới + provider health dashboard, registry
  428 → ~445.
- T5 voice v7 + UI: voice realtime v7 (barge-in tốt hơn, VAD cải tiến, transcript
  streaming UI), panel quản lý voice sessions; UI: memory-blocks editor panel +
  event-log viewer (time-travel) trong renderer.
- T6 fleet v5: fleet campaign — điều phối nhiều agent trên nhiều repo cùng lúc
  (queue, dedup, conflict guard theo dependency sweep của T3); per-bot resource
  budget v2 + fleet health dashboard.

## Lưu ý đặt tên (tránh va chạm với v1.07 đã có trên main)

- v1.07 đã có `memory_v8_*` (12 tool), `harness_v3_*` (3 tool), `voice_v6_*`
  (7 tool), `fleet_v4_teams_*` (5 tool) — sóng v1.08 dùng tên mới:
  `memory_v9_*`, `harness_v4_*`, `voice_v7_*`, `fleet_v5_*`, `coding_v2_*`.
