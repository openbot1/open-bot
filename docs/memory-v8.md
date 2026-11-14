# Memory v8 — Sleep-time compute có policy bền, fleet sync, retrieval local, provenance + chống poisoning, xóa GDPR

v1.07, Đội T1. Ý tưởng học từ tài liệu công khai (docs/repo-survey-v107.md
§4 — Mem0 v3, Letta, Zep/Graphiti, OWASP ASI06), tự thiết kế lại hoàn
toàn cho open-bot, 100% local, không copy code/text/tài sản của bất kỳ
repo nào, kể cả của xAI/Cursor.

v8 nối tiếp v6/v7, không viết lại: kho bản ghi vẫn là `V6RecordStore`
(add-only) + block v7 git-backed. Code: `packages/core/src/memory/v8/`
(`types`, `provenance`, `poisoning`, `retrieval`, `sleep`, `fleet`,
`erasure`). Tool: `packages/tools/src/memoryV8Tools.ts` (12 tool
`memory_v8_*`, placeholder trong `ALL_TOOLS`, bind qua
`createDefaultTools({ getMemoryV8WorkspaceDir })`).

## 1. Sleep-time compute (policy bền + nén block)

- `V8SleepPolicy` lưu bền trong `.open-bot/memory-v8-sleep-policy.json`:
  bật/tắt, `idleMs`, `checkIntervalMs`, giờ yên lặng (không chạy dù
  đang rảnh), `maxRunsPerDay`, `compressBlocksOlderThanDays`,
  `minBlocksToCompress`, `maxBlocksPerRun`.
- `SleepV8Scheduler` bọc `SleepV6Scheduler`: một lần chạy = consolidation
  v6 (dedupe/summary/quarantine bản ghi) + nén block v7.
- Nén block: block user-scope, không read-only, tier working/session, cũ
  hơn ngưỡng -> gom theo (tier + scope) thành MỘT block tóm tắt ở tier
  semantic, rồi xóa block gốc. Bản gốc vẫn khôi phục được từ git history
  của projection (mỗi lần xóa là một git commit). Block system-scope
  không bao giờ bị nén.
- `preview()` là dry-run thật: chỉ đọc, không ghi gì (v6 chỉ ước lượng
  số bản ghi sẽ xem xét vì `runConsolidation` v6 không có chế độ
  dry-run; số dedupe/quarantine chính xác chỉ biết khi chạy thật).
- Mọi lần chạy ghi vào ledger `.open-bot/memory-v8-sleep-ledger.json`
  (tối đa 50 lần gần nhất).

## 2. Shared memory block xuyên fleet/bot (gói sync)

- `exportFleetSyncPacket(store, fromBotId)`: gói JSON
  (`open-bot-fleet-sync-v8`) chứa mọi shared block local + version
  vector của từng block. Gói là dữ liệu thuần — mang đi bằng file/USB/
  tunnel tùy host, tool không dùng mạng.
- `importFleetSyncPacket(store, packet)`: merge theo version vector
  (không tin đồng hồ hai máy):
  - chưa có -> import mới (giữ owner/ACL);
  - incoming mới hơn -> cập nhật;
  - local mới hơn/bằng -> bỏ qua;
  - cả hai cùng sửa từ một gốc chung -> XUNG ĐỘT: giữ local, ghi vào
    conflict log `.open-bot/memory-v8-fleet-conflicts.json`, user quyết
    sau. Không bao giờ tự ghi đè, không bao giờ xóa block local.
- Giới hạn trung thực: `SharedBlockStore` v6 không lưu vector ngoài nên
  version local sau import bắt đầu từ 1; lần đồng bộ sau vẫn đúng vì
  vector incoming chứa version local thì update thắng.

## 3. Fused retrieval 3 tín hiệu LOCAL

`localFusedRetrieve(store, query, opts)` — chỉ 3 tín hiệu, đều tính
local từ text thô:

| Tín hiệu | Cách tính |
|---|---|
| Keyword | BM25 (k1=1.2, b=0.75, dùng lại `V6Bm25Index`), chuẩn hoá theo max |
| Entity | tỉ lệ entity của bản ghi xuất hiện trong query |
| Recency | decay mũ `0.5^(tuổi / halfLifeNgày)`, mặc định half-life 30 ngày |

Điểm cuối = `wK*keyword + wE*entity + wR*recency` (trọng số mặc định
0.5/0.3/0.2, chuẩn hoá về tổng 1). Mỗi hit kèm breakdown đầy đủ +
`explainV8LocalHit()`.

KHÔNG embedding: API này không có tham số embedder, không import
`Embedder`, không đọc file vector nào. Cần semantic thì dùng
`fusedRetrieve` v6 (embedder tường minh).

## 4. Provenance + chống poisoning (OWASP ASI06)

- `buildV8Provenance(record, { registry })`: nguồn gốc (loại + ref +
  bot + user), trust lúc ghi (trust v2 × trust riêng của nguồn trong
  registry), chuỗi bằng chứng (evidence chain: chat/tool/file/sync),
  flag nghi ngờ quét lại từ text, trạng thái quarantine.
- `SourceTrustRegistry` (`.open-bot/memory-v8-source-trust.json`): user
  đặt trust cho từng NGUỒN cụ thể (`tool:shady`...), đếm fact/flag theo
  nguồn để rà soát.
- `PoisoningReviewQueue` (`.open-bot/memory-v8-review-queue.json`):
  fact nghi ngờ vào hàng đợi `pending`; user quyết `approved` (tin lại,
  restore khỏi quarantine) hoặc `rejected` (retire, không tin nữa).
  Quyết 2 lần bị chặn; mục pending quá cũ -> `expired` (không phải là
  quyết định).
- `scanStoreForPoisoning(store)`: quét đọc (không sửa gì) — nội dung
  nghi ngờ (flag high), cụm mâu thuẫn xuyên scope (cùng key, giá trị
  khác nhau, gom thành cụm để quyết một lần), burst (một nguồn ghi ồ
  ạt, mặc định 10 fact/5 phút). `flagScanResults()` đưa kết quả vào
  hàng đợi.

## 5. Xóa theo yêu cầu (GDPR Article 17)

`ErasureService` (`.open-bot/memory-v8-erasure-audit.jsonl`):

1. Export trước khi xóa (portability): gói JSON đầy đủ dữ liệu user.
2. Bản ghi v6 có `scope.userId` = user -> retire + `scrubRecord`
   (thay nội dung bằng tombstone `[đã xóa theo yêu cầu]` — ngoại lệ
   duy nhất của add-only, vì luật yêu cầu nội dung biến mất thật).
3. Block v7: KHÔNG gắn userId nên không tự đoán — caller truyền
   `blockLabels` tường minh (chọn từ bản export); không có labels thì
   không xóa block nào và báo rõ lý do.
4. Shared block: gắn `ownerBotId` nên caller truyền `botIds` của user;
   không có thì không xóa block nào.
5. Scrub provenance log: viết lại JSONL, thay userId bằng `[erased]`
   (giữ quyết định audit, xóa định danh). Audit log xóa KHÔNG bị scrub.
6. Verify sau xóa: quét lại, còn sót thì `verified=false` + liệt kê.
7. Giới hạn: xóa local không xóa được bản sao đã đồng bộ sang máy khác
   qua gói fleet — máy nhận phải tự xóa (báo cáo ghi rõ).

## 6. Không tuyên bố điểm benchmark

Open-bot không tự chạy harness công khai nào cho memory v8 nên KHÔNG
công bố điểm LoCoMo/LongMemEval hay bất kỳ điểm benchmark nào. Mọi con
số trong module/test là số đo nội bộ trên fixture (đếm được, tái lập
được). Hằng `V8_NO_BENCHMARK_CLAIM` ghi rõ điều này; tool
`memory_v8_local_search` trả kèm tuyên bố trong kết quả.

## 7. Tool (12)

| Tool | Quyền |
|---|---|
| `memory_v8_sleep_status` | read |
| `memory_v8_sleep_config` | approval |
| `memory_v8_sleep_run` | approval |
| `memory_v8_local_search` | read |
| `memory_v8_provenance` | read |
| `memory_v8_review_list` | read |
| `memory_v8_review_decide` | approval |
| `memory_v8_poisoning_scan` | read |
| `memory_v8_fleet_export` | read |
| `memory_v8_fleet_import` | approval |
| `memory_v8_fleet_status` | read |
| `memory_v8_erase_user` | approval |

Placeholder (không có workspaceDir) từ chối bằng lỗi rõ ràng thay vì
crash. Đăng ký: placeholder trong `ALL_TOOLS`
(`packages/tools/src/tools.ts`); host bind qua
`createDefaultTools({ getMemoryV8WorkspaceDir })`; coordinator nối opt
này trong `defaultToolFactory`. Không `registerMany` riêng — trùng tên
sẽ throw trong `ToolRegistry` (bài học v1.00).

## 8. Test

- `tests/memory-v8-core-v107.test.mjs` (27 test): provenance, review
  queue, burst, cụm mâu thuẫn, scan, retrieval local, sleep policy/
  nén block/scheduler/ledger, fleet vector/export/import/xung đột,
  erasure/scrub/verify/audit.
- `tests/memory-v8-tools-v107.test.mjs` (11 test): registry (12 tool
  trong ALL_TOOLS đúng 1 lần, không trùng tên, approval flags),
  binding qua `createDefaultTools`, thực thi bound từng nhóm tool,
  placeholder từ chối khi thiếu workspaceDir.

## 9. i18n

12 key `memory.v8.*` × 6 locale (en/vi/es/fr/ja/zh), 3565 key/locale.
Bản dịch es/fr/ja/zh chưa được người bản xứ rà soát (như các key cũ).

## 10. Giới hạn còn lại

- Preview sleep v6 chỉ ước lượng (v6 không có dry-run thật).
- Erasure v7/shared-block cần labels/botIds tường minh (không tự đoán).
- Fleet sync là file-based (mang gói đi bằng tay); chưa có transport
  tự động giữa các máy.
- Version local sau import fleet bắt đầu từ 1 (xem §2).
- Trust registry và review queue là local từng workspace, chưa đồng bộ
  qua fleet.
- `scrubRecord` sửa bản ghi tại chỗ (ngoại lệ add-only duy nhất, vì
  GDPR) — event retire + audit log vẫn ghi lại việc xóa.
