# Nghiên cứu repo — Sóng v1.09 (2026-11-15)

> CHỈ HỌC Ý TƯỞNG, không copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor.
> Các phát hiện dưới đây là tóm tắt ý tưởng kiến trúc, viết lại bằng lời của mình,
> để định hướng cho 6 đội sóng v1.09.

## 1. Claude Code Agent Teams (thử nghiệm, bật bằng `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`)

- **Lead + teammate**: một session lead điều phối nhiều session teammate chạy song
  song; lead chia việc, teammate báo kết quả về, không ai làm việc của ai.
- **Shared task list có claiming**: danh sách task dùng chung, teammate "nhận" task
  (claim) có khóa file để không hai bot cùng làm một task; task có dependency —
  task sau chỉ chạy khi task trước xong.
- **Mailbox teammate-to-teammate**: các teammate nhắn trực tiếp cho nhau và cho
  lead, không cần qua lead làm trung gian cho mọi trao đổi.
- **Không dùng worktree nên phải phân vùng file**: các teammate cùng làm trong một
  cây file, vì vậy phải chia vùng làm việc rõ ràng để tránh giẫm chân nhau.
- **Giới hạn thực tế**: tối đa 20 subagent song song; workflow tối đa 256 concurrent
  / 1000 agents mỗi run; chi phí token tăng tuyến tính theo số teammate.
- **Quy tắc leo cấp**: chỉ dùng phối hợp nhiều bot khi cấp thấp (một bot) chứng minh
  là không đủ — đừng trả giá phối hợp cho task đơn giản.

**Áp vào open-bot (T1 Agent Teams v1)**: lead bot + teammate bot theo phiên; task
list chia sẻ có claiming + dependency + phát hiện chu trình; mailbox có loại
request/result/question/broadcast; phân vùng directory/worktree + phát hiện xung
đột file; chính sách leo cấp theo điểm phức tạp; UI theo dõi team.

## 2. Letta / MemGPT (memory kiểu agent tự quản)

- **Memory block tự sửa qua tool**: agent tự gọi tool để sửa memory của chính nó
  (`core_memory_append`, `core_memory_replace`, `archival_memory_insert/search`)
  — memory là trạng thái sống, không phải prompt tĩnh.
- **Ba tầng**: core (RAM, luôn nằm trong context), recall (lịch sử phiên gần đây),
  archival (lưu trữ dài hạn, truy hồi theo nhu cầu).
- **Sleep-time compute**: agent nền dọn dẹp, cô đọng và tổ chức lại memory giữa các
  phiên, khi người dùng không tương tác.
- **Giới hạn kích thước block**: block đầy thì agent phải tự cô đọng thay vì append
  vô hạn — ép agent giữ memory gọn và có ích.
- **Agent là thực thể bền vững phía server**: mỗi agent có identity + memory riêng
  tồn tại qua nhiều phiên, không phải phiên chat dùng một lần.

**Áp vào open-bot (T2 Memory v9 kiểu Letta)**: core blocks persona/human/project có
giới hạn cứng và tự cô đọng khi đầy; tầng recall + archival có tìm kiếm từ khoá và
embedding tuỳ chọn; sleep pass chạy nền (prune recall, trích fact, đề xuất cập nhật
core block, ghi log quyết định); entity snapshot/restore/export/import có checksum.

## 3. Mem0 vs Zep/Graphiti (hai trường phái memory có cấu trúc)

- **Mem0**: chưng cất hội thoại thành fact đã rút gọn, entity linking nhẹ, graph
  nhẹ — memory là tập fact sạch, truy hồi nhanh, ít nhiễu.
- **Zep/Graphiti**: temporal knowledge graph — entity và edge có khoảng hiệu lực
  thời gian (valid-from / valid-to), fact cũ không bị xoá mà hết hiệu lực.
- **Điểm chung**: cả hai đều coi memory không phải là đống text thô mà là dữ liệu
  có cấu trúc, có thể truy vấn, hết hạn và suy diễn.

**Áp vào open-bot (T2, sóng sau)**: archival tier lưu fact có khoảng hiệu lực thời
gian; dedupe fact trùng bằng tương tự Jaccard; promote fact archival lên core block
khi đủ quan trọng.

## 4. MCP spec 2026-07-28 + hệ sinh thái protocol agent 2026

- **MCP core stateless** (Agentic AI Foundation, Linux Foundation): không còn
  handshake `initialize` bắt buộc; tính năng tuỳ chọn tách thành extension.
- **MCP Apps** (`io.modelcontextprotocol/ui`, extension chính thức đầu tiên,
  01/2026): tool trả UI tương tác, render trong sandboxed iframe qua resource
  `ui://` — server MCP giờ trả cả giao diện, không chỉ text.
- **Tasks**: extension cho long-running call — tạo task, theo dõi tiến độ, huỷ,
  lấy kết quả; client không phải giữ kết nối chờ tool chạy xong.
- **Skills over MCP**: skill (quy trình làm việc đóng gói) phân phối qua MCP.
- **A2A v1.0** (03/2026, vào AAIF 08/2026): Agent Card có chữ ký, version
  negotiation, multi-tenancy — agent ngoài có thể tin nhau qua card đã ký.
- **AG-UI 1.0** (09/2026, CopilotKit): stream run state về frontend — message,
  tool-call, state event theo thời gian thực.
- **A2UI 0.9.1**: UI khai báo dạng JSON (`createSurface`, `updateComponents`) —
  agent mô tả giao diện bằng dữ liệu, frontend render.

**Áp vào open-bot (T3 MCP Apps + Tasks, T4 A2A v1.1 + AG-UI)**: host render UI
`ui://` trong iframe sandbox có allowlist message + rate limit + audit log; Task
runner có poll backoff, timeout, cancel, resume sau restart; đàm phán capability
per-server có fallback; Agent Card v1.1 có chữ ký + version negotiation + tenant
card cô lập; AG-UI stream session có checkpoint, replay buffer, phát hiện gap và
resume.

## 5. Ghi chú sóng v1.09

- Voice v5 (T5): barge-in, VAD cải tiến, resume phiên sau ngắt kết nối — học từ
  pattern realtime voice chung, không gắn với provider cụ thể nào; mock khi không
  có key thật.
- Platform/fleet v6 (T6): lập lịch nhiều bot, quota theo bot/nhóm, hàng đợi ưu tiên
  có preemption giới hạn, health + restart backoff — học từ scheduler hệ điều hành
  và orchestrator, áp cho bot local.
- Bài học gộp sóng: pin đếm toàn cục (ALL_TOOLS, defaultToolFactory, i18n) phải
  recompute một lần ở merge sau khi đủ 6 đội; đội riêng lẻ không sửa pin của đội
  khác. Xung đột gộp tập trung ở `packages/tools/src/tools.ts` (ALL_TOOLS +
  wiring), `preload.ts` (import type) và file pin i18n — giải quyết bằng cách giữ
  cả hai bên.
