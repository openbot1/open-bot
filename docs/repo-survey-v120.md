# Repo survey v1.20 — Memory 2026 + Protocol 2026 (16/11/2026)

Nghiên cứu cho sóng v1.20. CHỈ HỌC Ý TƯỞNG — không copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor.

## 1. Memory 2026

- **Mem0 BYOK — 17 writer model so sánh trên LoCoMo** — model nào viết memory thì dùng key của user (BYOK). Số tham khảo từ brief nghiên cứu sóng v1.20 (chưa đo độc lập bởi open-bot): Opus 5.5 LoCoMo 93,5% (cao nhất, đắt nhất); Sonnet 5.5 LoCoMo 93,4% (kém 0,1 điểm, nửa giá Opus); nhóm model rẻ trong 1 điểm LoCoMo so với flagship, dưới $10/1000 adds. Hướng cho T1: writer model registry BYOK + ước tính chi phí, chọn model rẻ nhất đạt ngưỡng accuracy thay vì mặc định flagship.
- **Letta FrontierMemory (10/2026)** — benchmark memory kiểu khác, cho kết quả khác LoCoMo: Fable 5.2 = Opus 5.5 ở 73,3% FrontierMemory. Hướng cho T1: eval harness dual benchmark — chạy cả LoCoMo lẫn FrontierMemory local, không kết luận bằng một benchmark.
- **MÂU THUẪN BENCHMARK (ghi rõ, không tin số vendor mù)** — GPT-6 Luna gần top LoCoMo nhưng chót FrontierMemory 28,9%. Hai benchmark đo khía cạnh khác nhau của memory; một model "tốt nhất" trên benchmark này có thể tệ nhất trên benchmark kia. Hướng cho T1: registry lưu riêng hai số theo từng benchmark + bắt buộc chỉ rõ benchmark đang tối ưu khi chọn model; harness local đo lại và cảnh báo khi hai benchmark mâu thuẫn.
- **State of Agent Memory 2026** — 23 memory layer được khảo sát, không chuẩn nào được phê chuẩn (chưa có standard thống nhất). Hướng cho T1: không khóa vào một chuẩn memory duy nhất; thiết kế lớp memory mở, thay được writer/retrieval/store.
- **Tech Radar 11/2026 — four-tier memory + token-budget governor** — memory chia tầng, replay vào prompt phải có ngân sách token (khoảng 15–20% context cho tier nhớ dài hạn). Hướng cho T1: token-budget governor (cap 20%, sàn 15%, chọn theo điểm ưu tiên, theo dõi usage, cảnh báo).
- **Mnemoverse memory_write 0.18.0** — memory mới thay thế memory cũ cùng chủ đề, giữ lịch sử thay vì xóa. Hướng cho T1: supersedes semantics (thay thế có kiểm tra confidence, rollback tạo phiên bản mới, không viết lại lịch sử).
- **OWASP ASI (memory/context poisoning)** — instruction injection giấu trong memory ghi vào, agent dùng lại như sự thật. Hướng cho T1: poisoning guard v19 — lớp tiền quét trên v18 (payload mã hoá base64, ký tự nguỵ trang zero-width, giả mạo tool-call), nghi ngờ thì quarantine cho người duyệt.

## 2. Protocol 2026

- **MCP spec 2026-07-28** — core stateless (bỏ initialize handshake, per-request negotiation qua `_meta` + header `MCP-Protocol-Version`, server/discover mới, Multi Round-Trip Requests với `input_required`, Sampling/Roots/Logging deprecated, Tasks / MCP Apps / Skills-over-MCP thành extension, transport Streamable HTTP thay HTTP+SSE). Đã vào sóng v1.19 (T3); v1.20 tiếp tục củng cố.
- **A2A v1.0 (12/03/2026)** — JSON-RPC/gRPC/HTTP+JSON, Agent Card có chữ ký; **v1.1 RC (10/2026)** — two-way streaming. Đã vào Agentic AI Foundation (Linux Foundation) 08/2026 cùng MCP.
- **Sierra Poppy 1.0 (13/11/2026)** — tham khảo kiến trúc agent (học ý tưởng, không copy).
- **IETF ACP WG (10/2026)** — nhóm làm việc về Agent Communication Protocol trong IETF; theo dõi hướng chuẩn hoá giao tiếp agent.
- **OpenHands v1.38.0 (10/11/2026)** — tham khảo coding agent (học ý tưởng, không copy).
- **Aider (git-first)** — coding agent lấy git làm nền (diff/commit/branch là giao diện làm việc); hướng cho T4 coding agent: mọi thay đổi qua git, review được bằng diff.

## 3. Nguồn

- Brief nghiên cứu sóng v1.20 (Mem0 BYOK 17 writer model / LoCoMo; Letta FrontierMemory 10/2026; State of Agent Memory 2026 — 23 memory layer; Tech Radar 11/2026; MCP 2026-07-28; A2A v1.0/v1.1 RC; Sierra Poppy 1.0 13/11/2026; IETF ACP WG 10/2026; OpenHands v1.38.0 10/11/2026; Aider git-first).
- docs/repo-survey-v119.md (Mem0 v3, Letta, Zep/Graphiti, OWASP ASI06, GDPR, MCP 2026-07-28, A2A, AG-UI 1.0, A2UI).

## 4. Áp dụng vào sóng v1.20

- T1 memory v19: BYOK writer model registry (17 model tham khảo, chọn theo benchmark chỉ rõ) + eval harness dual benchmark LoCoMo + FrontierMemory (mock + provider writer, đo chi phí/latency thật, cảnh báo mâu thuẫn) + token-budget governor 15–20% + consolidation pipeline bất đồng bộ (dedup + conflict resolution + decay hàm mũ, pause/resume/cancel) + supersedes semantics kiểu Mnemoverse memory_write 0.18.0 + feedback POSITIVE/NEGATIVE (ảnh hưởng ranking/recall) + poisoning guard v19 (lớp mở rộng trên v18: encoded payload, obfuscation, tool-call forgery).
- Các đội khác (T2 protocols, T3 coding, T4 Composio, T5 voice, T6 platform/fleet) tiếp tục theo roadmap sóng trước.
- Lưu ý trung thực: mọi số accuracy/giá trong registry v19 là SỐ THAM KHẢO (ghi rõ nguồn từng mục), không phải số đo được bởi open-bot; số đo thật chỉ có khi chạy harness local. Hai benchmark mâu thuẫn nhau là dữ kiện đã biết, không phải lỗi đo.
