# Repo survey v1.34 — 2026-11-17

Nghiên cứu phục vụ sóng v1.34. CHỈ HỌC Ý TƯỞNG — không copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor.

## 1. Agent Skills — chuẩn mở thuộc Agentic AI Foundation (AAIF, 22/10/2026)

- Anthropic tặng Agent Skills (định dạng đứng sau Claude Code skills) cho Agentic AI
  Foundation thuộc Linux Foundation ngày 22/10/2026; tên, GitHub org và tên miền
  agentskills.io chuyển sang foundation trung lập, **định dạng file không đổi** —
  skill cũ vẫn chạy. Cùng foundation đang giữ MCP.
- Skill = thư mục chứa `SKILL.md` bắt buộc + thư mục tùy chọn `scripts/`, `references/`,
  `assets/`. Front matter chỉ có 6 field: bắt buộc `name` (tối đa 64 ký tự, chữ thường/
  số/gạch ngang, phải trùng tên thư mục) và `description` (tối đa 1.024 ký tự, nói rõ
  skill làm gì VÀ khi nào dùng — vì description là thứ duy nhất agent thấy trước khi
  quyết định load); tùy chọn `license`, `compatibility`, `metadata`, `allowed-tools`
  (thử nghiệm — chỉ một số agent parse).
- Progressive disclosure là cốt lõi: chỉ metadata + description vào context lúc đầu,
  toàn bộ thân SKILL.md chỉ load khi skill được kích hoạt, scripts/references chỉ load
  khi cần. Đây là mẫu tiết kiệm context chuẩn cho mọi agent.
- Vị trí thư mục do từng sản phẩm tự định: Claude Code đọc `.claude/skills/` (+ global
  `~/.claude/skills/`); Codex, Cursor, Copilot, VS Code, Gemini CLI đọc
  `.agents/skills/`; hơn 70 nền tảng đã áp dụng tính tới 10/2026. Skill viết đúng spec
  (6 field, `.agents/skills/` + symlink `.claude/skills/`) chạy được khắp nơi.
- **Đem vào open-bot**: T1 skills v-next — validator strict theo spec (6 field, giới
  hạn ký tự, name trùng thư mục, quét bảo mật script), discovery 2 đường
  `.agents/skills/` + `.claude/skills/` (+ global), loader progressive disclosure,
  local skill index kiểu marketplace (chỉ đọc, tier enable/disable), import/export
  skill portable, nối loader vào runtime + tool `list-skills`.

## 2. MCP Apps — SEP-1865, extension chính thức đầu tiên của MCP (stable 26/01/2026)

- MCP Apps cho phép tool trả về giao diện tương tác (form, bảng, chart, dashboard) mà
  client render trong sandboxed iframe ngay trong cuộc trò chuyện, thay vì chỉ text.
  Spec 2026-01-26 stable; SDK chính thức `@modelcontextprotocol/ext-apps` v1.0.0 cùng
  ngày (nay v2.x); mọc ra từ đề xuất 11/2025 dựa trên MCP-UI cộng đồng + OpenAI Apps SDK.
- Cơ chế dùng lại 2 primitive sẵn có của MCP: tool khai báo UI trong metadata
  `_meta.ui.resourceUri` trỏ tới resource scheme `ui://`, MIME
  `text/html;profile=mcp-app`; view và host nói chuyện JSON-RPC 2.0 qua `postMessage`
  (dialect riêng của MCP, method prefix `ui/` — `ui/initialize`,
  `ui/update-model-context`, gọi lại `tools/call`/`resources/read`).
- Chỉ cho HTML document ở v1 (nhúng website ngoài bị hoãn vì lo host không review được).
  Capability negotiation trong handshake MCP → progressive enhancement, không breaking.
  Server phải trả kèm text fallback cho client không render được (terminal).
- Mô hình bảo mật nêu rõ threat: server độc hại đưa HTML hại, view thoát sandbox,
  tool call không phép, exfiltration, phishing. Mọi action từ UI đi qua cùng đường
  audit + consent như tool call trực tiếp — UI là input surface cho model, không phải
  đường vòng qua model. Claude (web/desktop, 9 connector lúc launch: Asana, Figma,
  Slack...), VS Code, ChatGPT, Microsoft 365 Copilot đã hỗ trợ.
- **Đem vào open-bot**: T3 MCP Apps v-next — registry `ui://` resource, khai báo
  `_meta.ui.resourceUri` trên tool, host iframe sandbox (CSP, allow-list), bridge
  postMessage JSON-RPC `ui/*`, capability negotiation, text fallback bắt buộc, consent
  cho action phát sinh từ UI, panel xem trước app + audit log.

## 3. Sandboxing 2026 — container không đủ cho code do agent sinh ra

- Đồng thuận 2026: code do agent tự viết/chạy (shell, cài dependency, biên dịch, chạy
  test) KHÔNG được chạy trực tiếp trên host — prompt injection hoặc `rm -rf` ảo giác
  đều có thể thành RCE host (vd CVE-2026-25592/26030: prompt injection trong Semantic
  Kernel leo thang thành RCE, 05/2026; container escape CVE-2024-21626 đã demo được).
- Ba tầng cách ly, đánh đổi rõ ràng:
  - **Firecracker microVM**: kernel riêng qua KVM, boot ~125ms, overhead <5MB, tới
    ~150 VM/giây/host, snapshot resume; kẻ tấn công phải thoát cả guest kernel lẫn
    hypervisor. Chuẩn vàng cho code không tin cậy / đa tenant (E2B xây trên đó, boot
    <100ms, API riêng cho agent: tạo sandbox, upload file, chạy lệnh, teardown).
  - **gVisor (runsc)**: userspace kernel chặn + ảo hoá syscall trước khi chạm host
    kernel; mạnh hơn container nhiều, overhead 5–15% trên workload syscall-nặng,
    gần 0 trên task code thường; không cần VM đầy đủ.
  - **Kata Containers**: microVM qua API container chuẩn, boot ~200ms, cho môi trường
    regulated / Kubernetes đa tenant.
- Defense-in-depth bắt buộc kèm theo: giới hạn tài nguyên, kiểm soát mạng (mặc định
  tắt, chỉ mở allow-list), credential theo phạm vi + ngắn hạn (token broker: không
  tool call nào chạm hệ thống downstream nếu chưa qua policy check và nhận credential
  mới), kill switch, mỗi agent một git worktree riêng để agent song song không sửa
  cùng file.
- **Đem vào open-bot**: T2 sandbox v-next — mô hình tier (bwrap → policy syscall kiểu
  gVisor → descriptor microVM kiểu Firecracker, dry-run + báo cáo trên OS không có
  KVM), policy-as-code (allow-list syscall/file/network), token broker cấp credential
  ngắn hạn theo từng task, kill switch + lifetime cap, báo cáo cách ly từng run.

## 4. Eval cho coding agent — harness quan trọng hơn model (Terminal-Bench 2.0, SWE-bench Pro)

- SWE-bench Verified (500 task, issue GitHub thật → patch phải qua unit test) vẫn là
  chuẩn de facto; **SWE-bench Pro** (1.865 task, Scale AI, 2026) là bản kế tiếp khó
  hơn — public + held-out + commercial, 41 repo, model top chỉ ~23% (so với 70%+ trên
  Verified) — sinh ra để trị contamination + bão hoà của Verified.
- **Terminal-Bench 2.0** (Stanford × Laude, 89 task, 4 dễ / 55 vừa / 30 khó): không chấm
  patch mà chấm **trạng thái cuối của container** — agent vào Docker + terminal, làm
  gì tùy ý, test kiểm tra trạng thái máy sau khi xong (build, sysadmin, data, ML,
  security, debug). Mỗi task có oracle solution chứng minh giải được + test quyết
  định pass/fail. Frontier model + agent vẫn <65% lúc nộp bài (01/2026).
- **Harbor** (kèm TB 2.0): harness tổng quát chạy mọi agent trên mọi bộ task container
  hoá, local hoặc cloud sandbox, hàng trăm trial song song; adapter sẵn cho Claude
  Code, Codex CLI, Gemini CLI, OpenHands, Terminus; một CLI chạy được nhiều suite.
- Bài học kiến trúc: một submission luôn là **harness, không phải model thô** — tool
  điều hướng file, tích hợp test runner, retry, review loop mới là thứ quyết định
  điểm; benchmark tốt tách 3 lớp: rollout worker (stateless, sandbox/container),
  judge (test xác định, không cần LLM judge), aggregation (điểm + khoảng tin cậy).
- **Đem vào open-bot**: T4 eval harness v-next — định dạng task container hoá (2 loại:
  issue→patch kiểu SWE-bench và state-check kiểu terminal-bench), oracle solution +
  test xác định, runner song song + trial lặp, scorer 4 chiều có sẵn nối trace OTel,
  regression gate cho CI, CLI `eval-harness` chạy bộ task mẫu local-first.

## 5. Ghi chú sóng v1.34

- Base: nhánh `merge/v134` @ `32852c86` (= tip merge/v133 sau khi gộp T5),
  **728.678 dòng TS** (đo chuẩn, worktree `~/workspace/open-bot-merge-v134`).
- Main vẫn ở v1.20 (ec4bf689, suite ĐỎ lúc land) — các sóng v1.21–v1.33 xếp chồng trên
  nhánh merge/v12X/v13X, chưa land main, remote GitHub vẫn v1.17 (2/11). Sóng v1.34
  KHÔNG tự fast-forward main, KHÔNG đẩy GitHub — chỉ gộp + kiểm chứng xanh trên
  merge/v134 rồi báo cáo.
- CẢNH BÁO PHÂN KỲ: merge/v131 (721.445 dòng) / v132 (708.871) / v133 (724.791) rẽ
  nhánh từ các stack tip khác nhau; merge/v129 tip (T4 Composio v6) không nằm trong
  v130/v131/v132 (theo ghi chú v132). Lúc landing phải hoà giải, KHÔNG rebase mất code.
- Neo số phiên bản từ HEAD các đội v133 (kiểm chứng bằng commit message): memory v22
  (T1), voice v22 (T5), coding agent v17 (T3), inference broker v2 (T5). Coordinator
  v1.34 PHẢI liệt kê thư mục `packages/core/src/<subsystem>/` để lấy số hiện tại của
  từng subsystem rồi mới đặt số mới — grep `-rho` bị nhiễu (vd `fleetV103`,
  `sandboxV129` là số dòng/version tag lẫn vào), không dùng số grep thô để đặt tên.
- Daemon restart quét agent mỗi ~10–15 phút: đội PHẢI commit stub trong vài phút đầu,
  1 file = 1 commit, commit sau mỗi file; worktree đội không có node_modules nên chỉ
  viết code + test, build/typecheck/test để coordinator làm lúc gộp.
