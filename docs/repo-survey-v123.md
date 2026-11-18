# Nghiên cứu chu kỳ v1.23 — open-bot (01:01 17/11/2026)

## Trạng thái đầu chu kỳ (đã kiểm chứng bằng git, không đoán)

- **main = v1.17 `063970db`, 609.892 dòng TS, suite GREEN 8540/8559** (0 fail, 19 skipped).
  LƯU Ý: log chu kỳ 23:01 ngày 16/11 ghi "main ĐÃ lên v1.18" là SAI — worker đó
  đọc HEAD của nhánh đang checkout (`merge/v118`) mà tưởng là main. `git show-ref`
  + reflog xác nhận main chưa hề rời `063970db` (lần di chuyển cuối là fast-forward v1.17).
- **merge/v118 = `669ec8fb`, 632.936 dòng (+23.044 vs v1.17), 26 commit trước main.**
  Suite merge3: **30 fail / 1125** (chủ yếu CLI/E2E chậm: cli doctor/team/headless,
  smoke history tab, renderer Composio automation, delegate A2A — mỗi test 60–216s,
  rất giống timeout do 1,5 CPU phải gánh 4 sóng song song, chưa chắc lỗi thật).
  Coordinator v1.18 (8e5da735) vẫn liệt kê "running" nhưng **idle ~48 phút**,
  không còn làm việc; nhánh này thực chất đã bị thay thế (xem dưới).
- **merge/v119 = `29f579c9`** (116 commit trước main): chứa commit `6cb0c39f` của v118
  (đủ 6 đội v118) nhưng KHÔNG chứa 2 commit fix-round của v118 (`0d9d135a` khôi phục
  fleetV12 binding block, `669ec8fb` đổi docusign→pandadoc + re-pin preset 12→90).
  → Khi v119 land, 2 fix này có thể THIẾU — coordinator sóng sau phải kiểm tra và
  áp lại nếu suite bắt lỗi, không áp mù.
- **merge/v120 = `6b7c8769`** (211 commit): chứa toàn bộ merge/v119 (stacked).
  **merge/v121 = `29b46f8e`** (192 commit) và **merge/v122 = `f52fbd7e`** (109 commit):
  cả hai đều rẽ từ `07e48941` (HEAD của v119 lúc 21:01), KHÔNG chứa v120 và không
  chứa các fix-round sau của v119 → sẽ xung đột/trùng lặp khi land, coordinator
  phải xử lý bằng fix-round như các sóng trước.
- Coordinator đang chạy: v1.19 (~6,9h), v1.20 (~5,7h, lần 3), v1.21 (~3,9h),
  v1.22 (~1,7h), coordinator sửa lỗi kiểm toán v1.16 (fix/audit-v116).
  Không có coordinator v1.23 → chu kỳ này cử mới theo lệnh Huy 13/11.
- **Đẩy GitHub: remote mới có v1.17 gói 1/11 (`c0090b49`).** Không còn thẻ duyệt chờ
  (permissions.list_pending trống lúc 01:01; thẻ gói 2/11 `a68a8355` đã hết hạn).
  Main v1.17 đã xanh mà chưa đẩy → cử agent đẩy tiếp tục từ gói 2/11 trước/song song
  sóng mới, theo đúng quy tắc body chu kỳ. Nếu v1.19 land giữa chừng và thay thế
  thì agent đẩy DỪNG và báo cáo, không đẩy cố.
- Sóng v1.22 đã được dặn xác minh base trước (fail CLI/E2E của v118 có thể do môi trường).

## Nghiên cứu chu kỳ (~15 phút, chỉ học ý tưởng, không copy code/text/tài sản)

### 1. MCP spec 2026-07-28 — stateless core + MRTR (blog.modelcontextprotocol.io, 28/07/2026)
- Core giờ stateless: bỏ handshake `initialize` và header `Mcp-Session-Id`; mỗi request
  mang protocol version + capabilities trong `_meta`; thêm `server/discover`.
- Server-initiated requests bị xóa: elicitation / sampling / roots chuyển sang
  **Multi Round-Trip Requests (MRTR, SEP-2322)** — server trả `InputRequiredResult`,
  client retry request gốc kèm đáp án. Không còn stream hai chiều giữ mở.
- **Roots, Sampling, Logging bị deprecated (SEP-2577)** — vẫn chạy tối thiểu 12 tháng,
  nhưng implementation mới KHÔNG nên dùng: truyền thư mục qua tool param thay cho Roots,
  gọi trực tiếp LLM API thay cho Sampling, log ra stderr/OpenTelemetry thay cho Logging.
- Extensions thành cơ chế chính thức: **Tasks** (long-running: server trả handle, client
  poll) và **MCP Apps** (ra mắt 26/01/2026, extension chính thức đầu tiên) nằm ngoài core.
- Auth siết theo OAuth 2.1 + OpenID Connect; deprecation policy 12 tháng bằng văn bản.
- Áp cho open-bot: v119 T2 (protocols v3) và v121 T2 (protocols v4) có thể đã làm một phần
  2026-07-28 — **coordinator PHẢI đọc nhánh v119-t2/v121-t2 trước**, chỉ làm phần còn thiếu:
  MRTR client đầy đủ, Tasks extension client, MCP Apps embedding, `server/discover`,
  migration path bỏ session-based cũ. Elicitation form mode KHÔNG dùng cho secret
  (spec cấm: password/key/token phải đi URL mode).

### 2. Sandbox cho agent 2026 — thang cô lập theo độ tin cậy (simular.ai, kosa8.com, openclawai.io)
- Thang: container thường (chia sẻ kernel host, ~200ms) → **gVisor `runsc`**
  (userspace kernel, ~300ms) → **Firecracker/Kata microVM** (kernel riêng, KVM, <2s,
  boot <125ms, overhead <5 MiB/VM) → full VM/desktop khi cần trình duyệt + đăng nhập.
- Local-first: **microsandbox** (Apache 2.0, Apple Silicon / Linux KVM / Windows WHP,
  network allowlist, secret không bao giờ vào VM), **kosa8** (mỗi agent một microVM,
  egress broker giữ API key ở host), Lima/UTM cho VM đa năng.
- Quy tắc chọn theo độ tin cậy của code: code mình viết → container; code LLM sinh từ
  prompt của mình → Docker+gVisor; code từ nguồn không tin (web, issue công khai,
  MCP tool bên thứ ba) → Firecracker microVM. Computer-use luôn chạy trong VM/container
  dùng một lần, không credential, có egress allowlist + xác nhận của người dùng.
- Áp cho open-bot — TRỰC TIẾP SỬA AUDIT OB-005 (CodeAct v8 chạy quyền host; BotBoxManager
  bwrap đã có nhưng không dùng): đội sandbox v2 làm execution tiers — bwrap mặc định cho
  CodeAct, tier gVisor `runsc` khi có Docker, tier microVM khi có KVM; egress allowlist +
  secrets broker (key không vào sandbox); cap CPU/RAM/disk theo task. Chỗ nào không chạy
  được runtime thật trên VM này thì mock driver + test rõ ràng, KHÔNG giả vờ chạy thật.

### 3. OpenHands V1 SDK + multi-agent orchestration (arXiv 2511.03690, MLSys 2026; MDPI survey 06/2026)
- OpenHands V1: refactor từ monolith thành **4 package Python tách rời** (agent, sandbox,
  workspace, services), ~72% SWE-Bench Verified, 80k+ stars, MIT.
- **Multi-agent delegation**: agent sinh sub-agent bằng một tool call; **stuck detection**
  nhận diện 5 pattern lặp/kẹt và tự phá vòng lặp.
- **Large Codebase SDK**: map dependency toàn hệ thống, sắp xếp thay đổi đúng thứ tự,
  nhiều agent làm song song không xung đột.
- Survey đa-agent (LangGraph, CrewAI, AutoGen/Microsoft Agent Framework, OpenAI Agents SDK,
  MetaGPT, DSPy): 3 topology — centralized / decentralized / hierarchical — cộng trục
  dynamic–adaptive; so sánh theo state granularity, token-cost, failure-recovery.
- Áp cho open-bot: coding agent v13 — delegation-as-tool-call, stuck detection 5 pattern,
  repo-map-guided task splitting + dependency-ordered parallel edits; dùng lại repo map
  PageRank đã có, không xây hệ thống map mới.

## Đề xuất 6 đội sóng v1.23 (coordinator KIỂM TRA nhánh v119-t1..t6, v120, v121, v122 TRƯỚC khi chốt — tránh trùng scope; báo cáo scope thực tế đã chọn)

- **T1 memory v21** — consolidation + forgetting: decay kiểu Ebbinghaus, sleep-time
  consolidation jobs, semantic dedup giữa các block, memory sharing giữa các bot (có consent).
  Nối tiếp v122 T1 (memory v20 graph builder kiểu Cognee), không làm lại graph builder.
- **T2 protocols v5** — MCP 2026-07-28 còn thiếu (mục 1): MRTR client, Tasks extension,
  MCP Apps embedding, `server/discover`, OAuth 2.1. Chỉ làm phần v119/v121 chưa có.
- **T3 sandbox v2** — execution tiers (mục 2): bwrap mặc định cho CodeAct (OB-005),
  gVisor tier, microVM tier, egress allowlist, secrets broker, resource caps.
- **T4 coding agent v13** — multi-agent delegation + stuck detection + dependency-ordered
  parallel edits (mục 3); eval harness kiểu Terminal-Bench cho delegation (nối tiếp v121 T3).
- **T5 voice v19** — realtime v4: speaker identification, noise suppression pipeline,
  voice profiles v3, hook voice-cloning có consent (mock-only), mở rộng local TTS engine registry.
- **T6 platform/fleet v18 + UI** — multi-user v5 (quota, metering, audit export),
  plugin/extension SDK v1 (signed manifest, sandbox permission, marketplace catalog mock),
  admin panels + i18n.

## Rủi ro / nút thắt ghi nhận cho sóng v1.23

- 1,5 CPU gánh 5 sóng song song (v119–v123) + audit-fix: suite đầy đủ chậm, CLI/E2E
  timeout giả là rủi ro lớn nhất — coordinator phải chạy suite lúc máy rảnh, retry có
  kiểm chứng trước khi kết luận fail thật; không "sửa" test bằng cách nới timeout mù.
- Pipeline rối: v121/v122 rẽ từ `07e48941`, v120 stacked trên v119-tip — land theo thứ tự
  v119 → v120 → (v121, v122 xử lý xung đột) → v123; **v123 KHÔNG tự fast-forward main**,
  chỉ giao merge/v123 đã xanh + báo cáo, cycle worker xếp lịch land.
- Base v123: merge/v120 tip `6b7c8769` (stack đầy đủ nhất); nếu base hỏng thì fallback
  merge/v119 tip `29f579c9` và báo rõ. Kiểm tra 2 fix-round v118 còn thiếu trước khi gộp.
- Live ảnh Gemini KHÔNG thử lại (key miễn phí quota ảnh = 0).
