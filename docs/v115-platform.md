# Platform / Fleet v12 + UI (v1.15, Đội T6)

Nối tiếp platform/fleet v11 (v1.14): health theo node/bot + alert ngưỡng cố
định (`fleetV11Health.ts`), rollout theo nhóm đặt tên (`fleetV11Rollout.ts`),
panel memory/voice/MCP Apps (`fleetV11Panels.ts`).

Khảo sát: `docs/repo-survey-v115.md` mục 4 (local model router — llama.cpp
router mode, pin GGUF từ publisher, cảnh báo đừng build trên model do OS
cung cấp) + mục 6 (hướng sóng v1.15). Chỉ học ý tưởng, không copy code/text/
tài sản của bất kỳ repo nào.

## 1. Fleet local-model pinning (`packages/core/src/fleet/fleetV12Pinning.ts`)

- Mỗi fleet node pin model GGUF cụ thể của mình (từ publisher, có hash
  SHA-256 verify), không dùng model do OS cung cấp.
- Blocklist OS-provided: `apple-foundation`, `phi-silica`, `foundry-local`,
  `os-provided`, `system-model`, `windows-ai`, ... — `pinFleetV12Model`
  từ chối kèm lý do (Apple đổi model theo OS release; Microsoft gỡ Phi
  Silica khỏi retail Windows 01/2027).
- Catalog mặc định 5 model license rõ: Qwen3 4B/8B (Apache-2.0), Llama
  3.2 3B / 3.1 8B (Llama Community), Gemma 3 4B (Gemma).
- Verify khi load: `verifyFleetV12ModelFile` hash SHA-256 bằng stream
  (không load cả file GGUF vào RAM) → `verified | tampered | missing |
  size-mismatch`. Kích thước lệch được phát hiện trước hash.
- Drift: `detectFleetV12PinDrift` (so hash hiện tại với hash đã pin) +
  `applyFleetV12VerifyResult` (node lệch hash → status `drift`, không
  được dùng cho tới khi re-pin/re-verify).
- Manifest: `<fleetRoot>/fleet-model-pins-v115.json` (atomic tmp + rename,
  mode 0600). Re-pin model reset verify của các node đang pin model đó.
- Không tải model từ mạng, không chạy inference, không spawn process.

## 2. Rollout theo nhóm phần trăm (`packages/core/src/fleet/fleetV12Rollout.ts`)

- Mức cố định: canary (1 node) → 25% → 50% → 100%. Cohort tính
  DETERMINISTIC bằng hash SHA-256 (`rolloutId + nodeId`): cùng rollout +
  cùng danh sách node thì cohort không đổi; cohort mức cao bao hàm mức
  thấp (mở rộng, không đổi nhóm).
- Máy trạng thái (hàm thuần): `draft -> canary -> expanding -> complete`,
  `paused`, `rolled-back`; chuyển đổi sai bị từ chối kèm lý do.
- Gate trước mỗi lần mở rộng: cohort trước done, tỉ lệ lỗi dưới ngưỡng,
  node down trong cohort dưới ngưỡng, không có alert critical trên cohort
  tiếp theo, ít nhất một nửa node cohort tiếp theo healthy.
- Pause/rollback tự động: `decideFleetV12AutoAction` — rollback khi lỗi
  vượt ngưỡng rollback / quá nhiều node down / alert critical trên cohort
  đang chạy; pause khi lỗi vừa (vượt ngưỡng pause nhưng dưới ngưỡng
  rollback). Module chỉ đề xuất; caller áp dụng.
- Lịch sử rollout + audit: mỗi lần chuyển trạng thái ghi entry (actor +
  lý do + thời điểm) vào `history`.
- Manifest: `<fleetRoot>/fleet-rollouts-v115.json` (atomic, mode 0600).

## 3. Fleet health v12 (`packages/core/src/fleet/fleetV12Health.ts`)

- Sample mở rộng từ v11: thêm model đang load (`loadedModelId`,
  `modelStatus` verified/drift/unverified/none), tốc độ sinh token
  (tok/s), số request đang chờ.
- Alert rule cấu hình được (8 rule mặc định): metric (cpu/ram/disk/
  heartbeat-stale/model-drift/tokens-per-sec), toán tử, ngưỡng, thời
  lượng vi phạm liên tục tối thiểu, mức, cooldown. Rule không hợp lệ bị
  `validateFleetV12AlertRule` từ chối.
- History ngắn hạn: ring buffer tối đa 60 sample/node (~15 phút nếu
  probe mỗi 15s) — avg/max/trend (rising/falling/stable) + % sample
  drift, đủ vẽ sparkline mà không phình file.
- `recordFleetV12Sample`: append history, bắn alert khi đủ duration,
  cooldown chặn bắn trùng, alert hết vi phạm thì resolved, ack không
  xóa alert, dedupe trùng rule+node.
- Dashboard: `buildFleetV12HealthDashboard` — rollup theo trạng thái +
  theo model, node drift/down, tài nguyên trung bình, alert theo mức,
  node tệ nhất, history từng node.
- State: `<fleetRoot>/fleet-health-v115.json` (atomic, mode 0600).
- Probe local đo thật bằng `node:os` + `fs.statfsSync`.

## 4. UI panel (`packages/core/src/fleet/fleetV12Panels.ts` + renderer)

View-model thuần (không đọc file, không chạm mạng); component React ở
`apps/desktop/src/renderer/components/`:

- **AG-UI/A2UI** — `FleetV12AguiPanel.tsx`: timeline theo run
  (run/text/tool/state/genui/activity) từ event stream AG-UI 16 type,
  text delta gom thành preview, interrupt đang chờ (GENERATIVE_UI
  `confirm` blocking + ACTIVITY `waiting-approval`), generative
  surfaces A2UI (đã trả lời/chưa), nút approve/reject. Validate quyết
  định: chỉ `user` được duyệt/từ chối, interrupt phải đang chờ.
- **Memory v12** — `FleetV12MemoryRouterPanel.tsx`: fact list (lọc theo
  query/confidence/source/quarantine), temporal KG view đơn giản
  (entity/relation kèm khoảng hiệu lực + superseded), quarantine review
  (restore/delete, chỉ user), GDPR erasure plan (đếm dữ liệu của user
  + 5 bước xác nhận; chỉ lập kế hoạch, không xóa thật).
- **Router** — cùng component: model đang load + RAM từng model/tổng,
  routing decision log (mới nhất trước), budget/spend + cảnh báo 80% /
  vượt budget.

## 5. Tools (`packages/tools/src/fleetV12Tools.ts`, 9 tool)

`fleet_model_pin_v12`, `fleet_model_verify_v12`, `fleet_model_pins_v12`,
`fleet_rollout_create_v12`, `fleet_rollout_action_v12` (advance kiểm tra
gate trước; khi tiến độ đã bao hết cohort thì cohort được đánh done
trước khi kiểm tra gate; kèm quyết định pause/rollback tự động),
`fleet_rollout_status_v12`, `fleet_health_dashboard_v12`,
`fleet_panel_agui_v12`, `fleet_panel_memory_router_v12`.
Đăng ký vào `ALL_TOOLS` (491 → 500); bind qua `getFleetV12BaseDir`
(cùng pattern replace-in-place như v11, không trùng tên). Tool ghi file
cần approval; tool chỉ đọc/pure thì không.

## 6. i18n

91 key `fleetV12.*` mới, đủ 6 locale (vi, en, es, fr, ja, zh) — tổng
mỗi locale 5278 → 5369. Test v11 (`tests/fleet-v114-tools.test.mjs`)
được cập nhật tổng key; các test pin `ALL_TOOLS.length = 491` được
re-pin lên 500 theo quy ước repo (merge re-pin).

## 7. Test

- `tests/fleet-v115-pinning.test.mjs` (7 test): blocklist OS, catalog,
  validate, pin/assign/unpin, verify file thật (verified/tampered/
  missing/size-mismatch), drift, persistence.
- `tests/fleet-v115-rollout.test.mjs` (8 test): cohort deterministic,
  validate, state machine, progress, gate, auto action, summary +
  persistence.
- `tests/fleet-v115-health.test.mjs` (9 test): rule mặc định/validate,
  metric/compare, evaluate, trend/history, recordSample (duration/
  cooldown/resolved/ack/dedupe/cắt 60), dashboard, probe local,
  persistence.
- `tests/fleet-v115-panels.test.mjs` (5 test): AG-UI panel + interrupt,
  memory panel + quarantine, GDPR erasure, router panel.
- `tests/fleet-v115-tools.test.mjs` (6 test): registry/binding, pure
  tools, e2e bound (pin → verify hash thật → drift; rollout create →
  start → advance), validation + OS-provided, NOT_WIRED, i18n 91 key.

## 8. Giới hạn còn tồn tại

- Pinning chỉ verify file GGUF trên máy local (đọc file qua đường dẫn
  trong manifest); node LAN xa cần tự báo hash qua heartbeat — module
  không đoán hash node xa.
- Verify hash đọc toàn bộ file GGUF (stream): file vài GB mất vài giây
  đến vài chục giây tùy đĩa; chưa có verify tăng dần/chunked cache.
- Cohort deterministic phụ thuộc danh sách node lúc tạo rollout: thêm/
  bớt node sau khi tạo không làm thay đổi cohort của rollout đó (cần
  tạo rollout mới).
- Alert rule `tokensPerSec` chỉ bắn khi sample có `tokensPerSec`
  khác null (node không chạy inference thì không đo được).
- Panel AG-UI dùng 16 event type AG-UI của open-bot (v0.97); interrupt
  được suy ra từ GENERATIVE_UI `confirm` blocking + ACTIVITY
  `waiting-approval` — chưa có event INTERRUPT riêng của AG-UI 1.0.
- GDPR erasure chỉ lập kế hoạch (đếm + bước); việc xóa thật do store
  memory (T1) thực hiện sau khi user xác nhận.
- Component renderer dùng demo store khi chưa có host IPC wiring (ghi
  rõ trong code); host cần nối IPC để hiển thị số liệu thật.
- Không thử live ảnh Gemini (theo lệnh sóng).
