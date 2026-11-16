# Memory v12 — Memory Blocks kiểu Letta (v1.12, Đội T1)

Ý tưởng học từ Letta/MemGPT (core memory là các block có tên, có giới
hạn token riêng, agent tự sửa bằng tool call, biên dịch thẳng vào
system prompt, sleep-time compute dọn dẹp lúc rảnh). Viết lại hoàn
toàn cho open-bot trên nền đã có (MemoryBlockStore v0.96 + block kind
v11) — **không copy code/text/tài sản của bất kỳ repo nào**, không gọi
model, không gọi API thật.

## Cái gì đã có trước v12 (không viết lại)

- `packages/core/src/memory/blocks.ts` (v0.96): MemoryBlockStore —
  block có label slug, charLimit, readOnly, attach/share nhiều bot,
  audit append-only, version snapshot (blockHistory).
- `packages/core/src/memory/v11/blockKinds.ts`: 5 kind hệ thống
  (`human`, `persona`, `task`, `project`, `safety`) + custom, giới
  hạn ký tự theo kind, render `<memory_blocks>`, parse ngược.
- `packages/core/src/memory/v11/patch.ts`: unified-diff patch +
  insert theo dòng. `v11/sleepConsolidationAgent.ts`: raw-fact inbox
  + sleep pass ghi `learned-context` + archival.
- `packages/core/src/memory/consolidate.ts` (v0.96): dedupe/conflict/
  promote trên long-term memory entry + scheduler idle.

## Cái v12 thêm mới

| Module | Việc làm |
| --- | --- |
| `memory/v12/tokens.ts` | Giới hạn token theo kind (= giới hạn ký tự v11 / 4, suy ra chứ không định nghĩa lại). Đếm token **dùng lại** `estimateTokens` của `agent/tokens.ts` (đã hiệu chuẩn bằng tiktoken, sai số ~2.6%) — không định nghĩa lại cách đếm. `v12BlockTokenUsage` (ok/warm/full), `summarizeBlocksTokens`. |
| `memory/v12/exactEdit.ts` | Exact-string edit (`oldText` → `newText`): 0 lần thì lỗi, >1 lần mà không chỉ `occurrence` thì lỗi kèm vị trí, chỉ thay đúng 1 lần. `applyExactEditToBlock` kiểm tra token limit rồi ghi qua `store.replace` (version +1, audit, snapshot tự động). |
| `memory/v12/compile.ts` | Biên dịch block đã attach thành `<memory_blocks>` trong ngân sách token chung (mặc định 4000): block ưu tiên cao giữ nguyên trước, block thấp bị cắt (binary-search bằng chính `estimateTokens`, cắt theo ranh giới dòng, đánh dấu `… [truncated: …]`) rồi bỏ hẳn; chi phí tag XML + dự phòng được trừ trước nên tổng thực tế ≤ budget. `BlockPromptCompiler` cache theo (id, version, hash) — chỉ recompile block vừa đổi. |
| `memory/v12/systemBlocks.ts` | Block hệ thống (`systemOwned`): chỉ actor `user` mới tạo/sửa/gỡ bảo vệ. Store chặn agent ở mọi đường ghi (`update`/`replace`/`append`/`delete`/`restoreVersion`/`setReadOnly(false)`/`setSystemOwned`). Preset duy nhất: `safety`. |
| `memory/v12/sleepJanitor.ts` | Sleep-time janitor cấp **block** (khác consolidate v0.96 làm trên entry, khác sleep agent v11 làm trên raw fact): dedupe dòng trong block, merge bullet trùng giữa các block (giữ ở block ưu tiên cao nhất), trim block vượt charLimit (bỏ dòng cũ nhất trước), promote bullet `learned-context` → `human`. Bỏ qua block read-only/system-owned. Dry-run không ghi gì. `runJanitorIfIdle` đọc cấu hình consolidation sẵn có (`enabled` + `idleMinutes`, mặc định TẮT) + chống chạy chồm. Log JSONL. |
| `memory/v12/blocksIO.ts` | Export/import block (backup JSON theo label): import an toàn — label trùng thì bỏ qua trừ khi user yêu cầu overwrite; block hỏng báo `invalid` chứ không làm hỏng cả file; `systemOwned` chỉ user mới khôi phục được. |
| `tools/memoryV12Tools.ts` | 9 tool: `memory_block_edit`, `memory_block_search`, `memory_block_tokens`, `memory_blocks_compile`, `memory_system_block`, `memory_block_audit`, `memory_sleep_janitor`, `memory_blocks_export`, `memory_blocks_import`. Tool chạy với actor `agent:<botId>` nên mọi thao tác ghi block hệ thống đều bị core chặn (test chứng minh). |

## Thay đổi phẫu thuật ở code cũ (không phá API)

- `memory/blocks.ts`: thêm field tùy chọn `MemoryBlock.systemOwned`
  + `CreateBlockInput.systemOwned`; `assertWritable(block, actor)`
  chặn agent sửa block hệ thống; thêm `setSystemOwned` (chỉ user).
  Mọi lời gọi cũ dùng actor mặc định `'user'` nên không đổi hành vi.
- `tools/tools.ts`: `ALL_TOOLS` 359 → **368** (+9 tool v12); binding
  `createDefaultTools({ getMemoryV12WorkspaceDir, getMemoryV12BotId })`.
- i18n: 25 key `memoryBlockV12.*` × 6 locale → **4590 key/locale**
  (4565 + 25). Pin snapshot đã cập nhật theo.

## Quy tắc an toàn (đã có test cho từng cái)

- Agent không bao giờ sửa được block hệ thống, kể cả đường vòng
  "tắt read-only trước rồi sửa sau" (store chặn cả hai bước).
- Exact-string edit mơ hồ (>1 lần xuất hiện) thì từ chối, không đoán.
- Janitor không sửa block read-only/system-owned; dry-run không ghi.
- Compile không bao giờ để block chưa attach lọt vào prompt.
- Không gọi model/API thật ở bất kỳ đâu (đếm token = heuristic đã
  hiệu chuẩn, janitor = luật xác định trên text).

## Giới hạn còn tồn tại

- Số token là **ước lượng** (heuristic hiệu chuẩn, sai số ~2.6% trên
  corpus tiktoken), không phải số token thật của model đang chạy.
- Janitor trim bỏ dòng cũ nhất khi block vượt giới hạn — có thể bỏ
  fact cũ quan trọng nếu block đã đầy (chỉ chạy khi `enabled`, và
  dry-run xem trước được).
- `learned-context` trong store lưu dưới dạng slug `learned-context`
  (store đổi `_` → `-`); janitor dùng đúng slug này.
- Sleep janitor chạy theo cấu hình consolidation chung (mặc định tắt)
  — host phải bật `enabled` + gọi `runJanitorIfIdle` lúc setup turn.
- UI desktop chưa có màn hình v12 (chỉ có key i18n sẵn cho UI sau).

## Test

```
npm run build --workspace=@open-bot/core
npm run build --workspace=@open-bot/tools
node --test tests/memory-v12-tokens.test.mjs tests/memory-v12-exact-edit.test.mjs \
  tests/memory-v12-compile.test.mjs tests/memory-v12-system-blocks.test.mjs \
  tests/memory-v12-janitor.test.mjs tests/memory-v12-tools.test.mjs \
  tests/memory-v12-i18n.test.mjs tests/memory-v12-blocks-io.test.mjs
```

70 test v12 (48 core + 14 tools/i18n + 8 blocks-io), toàn bộ xanh,
không mạng, không model.
