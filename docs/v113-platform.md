# Fleet platform v10 (v1.13, Đội T6)

Mở rộng hệ thống platform/fleet + ACP Control Center đã có — **local-first,
không cloud VM, không tài khoản/thanh toán**. Fleet ở đây là fleet
local/multi-user trên máy người dùng: nhiều user nội bộ dùng chung một máy,
mỗi user có workspace/quota/audit riêng.

## Module mới (packages/core/src/fleet/)

| File | Nội dung |
| --- | --- |
| `fleetV10Triggers.ts` | Event-triggered agents: 6 loại sự kiện, điều kiện lọc, debounce/throttle/cooldown/giới hạn theo giờ, lịch sử chạy |
| `fleetV10Scheduled.ts` | Scheduled agents: cron 5 trường theo múi giờ IANA riêng, interval, once; retry backoff; skip-if-running; missed-run |
| `fleetV10Users.ts` | Multi-user fleet: user nội bộ, ma trận quyền, quota theo user, cách ly thư mục, audit hash-chain theo user |
| `fleetV10Dashboard.ts` | Mở rộng ACP Control Center: máy trạng thái điều khiển agent, snapshot dashboard, đọc đuôi log, persistence runtime |

Tất cả đều là hàm thuần + lưu file tách riêng (atomic tmp + rename, mode
0600), theo đúng mẫu của các module fleet trước. Không file nào chứa secret:
webhook chỉ lưu `keyId`, secret nằm trong Vault.

## 1. Event-triggered agents (`fleetV10Triggers.ts`)

Sự kiện: `file-changed`, `webhook-local`, `calendar-due`,
`message-inbound`, `agent-done`, `queue-depth`. Điều kiện lọc: glob đường
dẫn (`*`, `**`, `?`), nguồn, khớp trường payload (chuỗi hỗ trợ glob),
user, độ sâu hàng đợi tối thiểu.

Thứ tự quyết định trong `decideFleetV10Trigger`: trùng sự kiện (idempotency)
→ tắt → lọc → cooldown → throttle → debounce → giới hạn/giờ → fire.
`evaluateFleetV10Triggers` đánh giá một lô sự kiện cho mọi trigger; sự kiện
trùng id trong cùng lô chỉ xử lý 1 lần. File bền:
`fleet-triggers-v113.json`, `fleet-trigger-runs-v113.json`.

## 2. Scheduled agents (`fleetV10Scheduled.ts`)

Cron 5 trường (`m h dom mon dow`) với **múi giờ IANA riêng từng lịch**
(`Asia/Ho_Chi_Minh`, `America/New_York`, ...), tính bằng
`Intl.DateTimeFormat` (không thêm dependency). DST xử lý đúng: giờ
wall-clock không tồn tại (spring forward) thì bỏ qua; giờ lặp lại (fall
back) thì chạy ở lần xuất hiện đầu tiên.

`tickFleetV10Scheduler(now, state, runningAgentIds)` là hàm thuần:
lịch tới giờ → start; agent đang chạy + `skipIfRunning` → ghi
`skipped-running`; lỡ quá grace (mặc định 5 phút) → ghi **tối đa 1 lần**
`missed`, không bù chạy; retry tới giờ → mở lại với attempt tăng.
Lỗi thì retry theo cấp số nhân có chặn trên (`backoff * multiplier^attempt`,
tối đa 15 phút); hết lượt thì `exhausted`. `once` chạy xong thì
`nextRunAt = null`. File bền: `fleet-schedules-v113.json`,
`fleet-scheduled-runs-v113.json`.

## 3. Multi-user fleet (`fleetV10Users.ts`)

User là người dùng **nội bộ của máy** (vd các thành viên trong nhà/nhóm
dùng chung một máy), đăng ký bằng tên local, admin của máy thêm/xóa —
không đăng nhập cloud, không mật khẩu tập trung, không đồng bộ server.

- Vai trò tái dùng `FleetRole` (`admin` / `member` / `chat-only`).
  Ma trận quyền fail-closed: vai trò/hành động không biết = từ chối.
  `chat-only` chỉ xem dashboard; `member` điều khiển agent + trigger +
  schedule của mình; `admin` làm mọi thứ.
- Audit: admin đọc audit mọi user, member/chat-only chỉ đọc audit của mình.
- Quota **theo user** (khác quota theo bot của `quotas.ts`): số agent,
  số chạy đồng thời, số trigger/schedule, CPU/RAM/đĩa, số lần chạy/ngày.
  `checkFleetV10UserQuotaAfterAdd` kiểm tra *trước khi tạo* để từ chối sớm.
- Cách ly: thư mục riêng `<fleetRoot>/users/<userId>/`;
  `resolveFleetV10UserPath` từ chối đường dẫn tuyệt đối và `..` thoát khỏi
  thư mục user. Vault namespace riêng: `fleet-user/<userId>`.
- Audit theo user: `users/<id>/audit.jsonl`, chuỗi hash SHA-256 nối tiếp
  (phát hiện sửa lén không tính lại hash; không chống được người có quyền
  sửa file tính lại chuỗi — cùng giới hạn đã ghi ở `fleet/audit.ts`).
- File bền: `fleet-users-v113.json`, `fleet-user-quotas-v113.json`.

## 4. ACP Control Center — fleet dashboard (`fleetV10Dashboard.ts`)

- Máy trạng thái runtime: `stopped → running → paused → running |
  stopped`, `error` chỉ thoát bằng `start`/`stop`. Chuyển đổi không hợp
  lệ bị từ chối kèm lý do (`applyFleetV10ControlAction`, hàm thuần).
  Mỗi lệnh hợp lệ sinh một `FleetV10ControlEvent` (agent, action,
  from/to, actor, lý do) để host ghi audit.
- `buildFleetV10Dashboard` (hàm thuần): đếm agent theo trạng thái, hàng
  đợi, % CPU/RAM/đĩa, hàng theo user, cảnh báo (heartbeat stale, agent
  lỗi, chờ hàng đợi lâu, tài nguyên vượt ngưỡng).
- `readFleetV10LogTail`: đọc N dòng cuối của file log, tối đa 1 MB cuối
  file, trả kèm `startByte` để UI poll phần mới; file không có → rỗng.
- Trạng thái runtime lưu ở `fleet-agent-runtime-v113.json`.

## Tools (packages/tools/src/fleetV10Tools.ts) — 11 tool, CHƯA đăng ký ALL_TOOLS

`fleet_trigger_create_v10`, `fleet_trigger_list_v10`,
`fleet_trigger_evaluate_v10` (thuần, chạy được khi chưa bind nếu truyền
`triggers`), `fleet_schedule_create_v10`, `fleet_schedule_list_v10`,
`fleet_schedule_tick_v10`, `fleet_user_create_v10`,
`fleet_user_quota_check_v10` (thuần khi truyền `quota` + `usage`),
`fleet_dashboard_snapshot_v10` (thuần), `fleet_agent_control_v10`,
`fleet_log_tail_v10` (đường dẫn log phải nằm trong `<userData>/fleet`).
Tool ghi file cần approval; tool chỉ đọc thì không. Coordinator nối vào
`ALL_TOOLS` sau (giống mẫu `createFleetV9Tools(getBaseDir)`).

## i18n

49 key `fleetV10.*` mới, đủ 6 locale (vi, en, zh, ja, es, fr — lưu ý repo
dùng **fr** chứ không có **ko**). Tổng mỗi locale: 4818 → 4867 key.

## Test

- `tests/fleet-v113-triggers.test.mjs`
- `tests/fleet-v113-scheduled.test.mjs`
- `tests/fleet-v113-users.test.mjs`
- `tests/fleet-v113-dashboard-tools.test.mjs`
- `tests/i18n-v113.test.mjs`

## Chưa xong / giới hạn

- Không có renderer panel riêng cho dashboard v10 (dashboard + điều khiển
  + log tail hiện qua core + tools; panel renderer để đội UI nối sau dùng
  key `fleetV10.*` đã có sẵn).
- Trigger `webhook-local` chỉ lưu `keyId` và đánh giá sự kiện đã xác thực;
  việc xác thực HMAC nằm ở host/webhook layer (như automations v2).
- `calendar-due` / `message-inbound` cần host đẩy sự kiện vào
  `evaluateFleetV10Triggers` (chưa có watcher lịch/kênh riêng trong sóng này).
- Cron quét theo phút wall-clock, tối đa 366 ngày — lịch thưa hơn sẽ ném lỗi
  thay vì treo (giống v6).
