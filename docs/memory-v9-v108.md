# Memory v9 — sleep daemon, git versioning, shared-block registry (v1.08, Đội T1)

> CHỈ HỌC Ý TƯỞNG, không copy code/text/tài sản của bất kỳ repo nào
> (Letta: sleep-time compute, git-backed memory, shared memory
> blocks). Chạy 100% local, không mạng, không model call thêm.

## Vấn đề v9 giải quyết

| Mảnh | Trước v9 | v9 thêm |
|---|---|---|
| Sleep-time compute | v0.97 `SleepTimeAgent` chạy theo bước/compact/thủ công; v8 `SleepV8Scheduler` có policy bền + nén block + ledger — nhưng chưa có daemon nối chúng lại, không tự chạy giữa các session | `SleepV9Agent`: daemon nền, trigger session-end / idle / scheduled / manual, job lifecycle, run log |
| Git-backed versioning | v7 projection lưu block thành file .md + commit; v1.02 snapshot JSONL — nhưng chưa có API thống nhất snapshot có tên / history gộp / diff từng dòng / rollback qua tool | `MemoryV9VersionStore`: snapshot, history, diff (LCS tự viết), rollback (ghi thành version mới) |
| Shared block | v1.03 nhóm share theo nhóm + role; v8 gói sync fleet — nhưng chưa có registry cấp block với ACL từng bot, change feed, phát hiện xung đột ghi | `SharedBlockRegistry`: register, ACL read/write/admin, change feed + seenSeq, base-version conflict check, resolve keep-mine/keep-theirs/merged |

## Sleep daemon (`packages/core/src/memory/v9/sleepAgent.ts`)

- `SleepV9Agent` sống trong tiến trình host: **một instance cho mỗi
  workspace** (tool layer giữ singleton theo workspaceDir qua
  `getMemoryV9Agent()`).
- Policy lưu bền (`.open-bot/memory-v9-sleep-policy.json`), mặc định
  **TẮT**. Trigger: `sessionEnd` (session đủ turn + đủ dài),
  `idle` (rảnh đủ `idleMs`), `scheduled` (một lần/ngày vào giờ hẹn),
  `manual` (chạy tay). Tôn trọng giờ yên lặng, cooldown giữa hai lần
  chạy tự động, giới hạn số lần/ngày.
- Host nối vòng đời chat: `noteActivity()` mỗi turn,
  `noteSessionStart()` / `noteTurn()` / `noteSessionEnd()` theo
  session. `createDefaultTools({ getMemoryV9WorkspaceDir })` tự start
  daemon khi policy đã enabled; `memory_v9_sleep_config`
  `{enabled:true}` cũng start, `{enabled:false}` stop.
- Một job chạy 3 bước (tắt được từng bước): (1) consolidation v8
  **tái dùng** `SleepV8Scheduler` (dedupe/summary/quarantine bản ghi
  + nén block); (2) trích fact từ transcript **tái dùng**
  `SleepTimeAgent` v0.97 (trigger `'manual'` để không đụng config bền
  của nó); (3) snapshot các block đã đổi trong lần chạy.
- Không bao giờ chạy 2 job chồng nhau; job quá `maxJobMs` thì dừng
  sớm, báo partial. Mọi job (kể cả dry-run, kể cả cancel) ghi vào run
  log `.open-bot/memory-v9-sleep-runs.jsonl` + file latest; đếm số lần
  chạy trong ngày chỉ tính chạy thật.

## Git-backed versioning (`packages/core/src/memory/v9/versioning.ts`)

- `snapshot(label, note, actor)`: lưu đủ nội dung + hash + commit vào
  `.open-bot/memory-v9-snapshots.jsonl` (giữ 30 snapshot/block) — rollback
  được cả khi máy không có git.
- `history(label)`: gộp snapshot v9 + `blockHistory()` của projection
  v7 (tự rơi về `history.jsonl` khi không có git), dedupe theo
  (version + hash), mới nhất trước.
- `diff(label, fromVersion, toVersion?)`: line diff bằng thuật toán
  LCS tự viết, trả hunks có 3 dòng context + số dòng hai phía; kèm
  text git diff thô khi cả hai phiên bản đều có commit.
- `rollback(label, version, actor)`: ghi nội dung cũ lại thành phiên
  bản **mới** (version+1) + snapshot "rollback từ vN" — không bao giờ
  viết lại lịch sử. Rollback về nội dung đang có thì `changed: false`.

## Shared-block registry (`packages/core/src/memory/v9/sharedRegistry.ts`)

- `register(label, ownerBotId, {description, grants})`: block phải có
  trong projection; owner luôn admin; nội dung block vẫn sống duy nhất
  trong projection (registry chỉ lưu quan hệ + metadata).
- ACL: `grant` / `revoke` chỉ owner/admin; không hạ/thu quyền owner.
  Thứ tự quyền: read < write < admin.
- `write(label, botId, content, baseVersion, summary)`: kiểm tra quyền
  write, rồi so `baseVersion` với version hiện tại. Khác nhau → **không
  ghi đè**: ghi lại xung đột pending (kèm nội dung writer muốn ghi) và
  trả `outcome: 'conflict'`. Ghi thành công thì bump version + version
  vector + append change vào feed (`.open-bot/memory-v9-shared-changes.jsonl`).
- `sync(label, botId, sinceSeq)`: trả change bot chưa thấy + xung đột
  đang chờ, đồng thời đánh dấu `seenSeq` của bot.
- `resolveConflict(id, resolution, byBotId, mergedContent?)`: chỉ
  owner/admin hoặc chính writer. `keep-mine` (giữ hiện tại),
  `keep-theirs` (ghi nội dung writer), `merged` (ghi nội dung gộp tay,
  bắt buộc có `mergedContent`). Ghi thành công được append vào feed.

## Tool mới (14) — `packages/tools/src/memoryV9Tools.ts`

| Tool | Quyền |
|---|---|
| `memory_v9_sleep_status` | read |
| `memory_v9_sleep_config` | approval (bật/tắt daemon theo `enabled`) |
| `memory_v9_sleep_run` | approval (`trigger` + `episodes` + `dryRun`) |
| `memory_v9_sleep_log` | read (`limit` / `trigger` / `status` / `jobId`) |
| `memory_v9_version_snapshot` | approval |
| `memory_v9_version_history` | read |
| `memory_v9_version_diff` | read |
| `memory_v9_version_rollback` | approval |
| `memory_v9_shared_register` | approval |
| `memory_v9_shared_list` | read |
| `memory_v9_shared_acl` | approval (`grant` / `revoke` / `list`) |
| `memory_v9_shared_sync` | read |
| `memory_v9_shared_write` | approval |
| `memory_v9_shared_resolve` | approval |

Đăng ký: placeholder trong `ALL_TOOLS`, bind qua
`createDefaultTools({ getMemoryV9WorkspaceDir })` (replace-in-place,
không trùng tên); coordinator bind sẵn. Registry: 428 → **442** tool.

## i18n

24 key `memory.v9.*` mới, đủ 6 locale (en/vi/es/fr/ja/zh), tổng key
3643 → **3667**. Test: `tests/i18n-v108.test.mjs`.

## Test

- `tests/memory-v9-core-v108.test.mjs` — 25 test: policy, line diff,
  versioning, sleep daemon, shared registry.
- `tests/memory-v9-tools-v108.test.mjs` — 7 test: registry, approval
  flags, placeholder, sleep/version/shared end-to-end, binding.
- `tests/i18n-v108.test.mjs` — 2 test: key v9 + đồng bộ key set 6 locale.

## Giới hạn còn lại

- Host phải gọi `noteSessionStart` / `noteTurn` / `noteSessionEnd`
  (qua `getMemoryV9Agent(workspaceDir)`) ở vòng đời chat thì trigger
  session-end mới có transcript để trích fact; hiện tại trigger
  idle/scheduled/manual đã chạy độc lập, còn session-end chỉ xếp job
  khi host gọi — chưa nối vào turn loop của coordinator (một call site,
  để coordinator/merge nối, không đụng turn path trong sóng này).
- Sleep daemon chỉ chạy khi app/host process còn sống (interval trong
  tiến trình, `unref`); không phải service hệ thống.
- Diff LCS chạy trên toàn bộ dòng của block — block bị giới hạn ký tự
  bởi projection nên vẫn nhanh, nhưng không dùng cho file ngoài block.
- Snapshot giữ 30 phiên bản/block, change feed giữ 200 change/block,
  run log giữ 200 lần chạy gần nhất (cũ hơn bị cắt khi ghi).
- Bản dịch 4 locale (es/fr/ja/zh) chưa được người bản xứ review.
