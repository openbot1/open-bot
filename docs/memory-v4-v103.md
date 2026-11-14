# Memory v4 — v1.03, Đội T2

Ý tưởng học từ Mem0 (extract + judge add/update/delete/noise, scope
user/agent/run), Letta (shared memory blocks, sleep-time agents) và
Zep/Graphiti (temporal validity windows) — chỉ học ý tưởng, tự thiết
kế lại hoàn toàn cho open-bot, 100% local, không gọi model, không copy
code/text/tài sản của bất kỳ repo nào. Kế thừa: memory blocks v0.96,
temporal KG + quarantine v0.98, dream v1.00/v1.02, scopes + fused
retrieval v1.02.

## 1. Shared-block groups (`packages/core/src/memory/sharedBlocks.ts`)

`MemoryBlockStore.share()` (v0.96) là thao tác một lần, không có nhóm:
không biết block đang share cho bot nào theo nhóm nào, bot mới vào
nhóm không tự thấy block, không có role. `SharedBlockGroupStore` thêm
lớp nhóm lên trên store có sẵn:

- Nhóm = `{ id, name, members[{botId, role: read|write}], blockIds }`,
  lưu `.open-bot/memory-shared-groups.json` (atomic, mode 0600).
- Nội dung block vẫn sống duy nhất trong `MemoryBlockStore` — module
  này chỉ lưu quan hệ nhóm ↔ bot ↔ block.
- `attachBlockToGroup` attach block vào MỌI thành viên (sửa một nơi,
  mọi bot thấy); `addMember` catch-up ngay cho bot mới; `removeMember`
  / `deleteGroup` detach (trừ block còn thuộc nhóm khác của bot đó).
- `resolveBlocksForBot` trả block bot thấy được kèm nguồn (nhóm nào,
  role gì) — provenance nhóm thắng attach trực tiếp.
- `groupSyncReport` phát hiện drift (thành viên thiếu block, block
  mồ côi, block read-only). Chỉ đọc, không tự sửa.

## 2. Judge pipeline (`packages/core/src/memory/judge.ts`)

Một message đi qua 3 bước trong `judgeAndConsolidateMessage`:

1. **Extract** — `FactExtractor` (mặc định `RuleBasedFactExtractor`).
2. **Judge** — `judgeCandidate` phân loại trước khi chạm store:
   `NOISE` (chào hỏi, cảm ơn, câu hỏi, mệnh lệnh, câu quá ngắn),
   `ADD`, `UPDATE`, `DELETE` (phủ định), `QUARANTINE` (mâu thuẫn
   fact tin cậy cao / mẫu nghi ngờ), `SKIP` (trùng / phủ định không
   có đích). Ngưỡng khớp `consolidateCandidates` (stale 90 ngày,
   update ≥ 0.5, delete ≥ 0.9) để quyết định dự đoán = quyết định thực
   thi — có test hồi quy.
3. **Apply** — ứng viên không phải NOISE qua `consolidateCandidates`
   (cùng luật, cùng quarantine, cùng supersession).

`ConsolidationDecision` thêm `'NOISE'` (additive). Gap đã sửa để
DELETE chạy được end-to-end: extractor cũ không rút được fact phủ
định — thêm 4 pattern phủ định VI+EN (likes/lives_in) vào
`graph/extract.ts`; `classifyNoise` cũng được tool dùng để
short-circuit message toàn noise trước khi chạm store.

## 3. Scored dream pass (`packages/core/src/memory/sleepScoring.ts`)

Dream cũ promote mọi fact đủ confidence như nhau. Lớp chấm điểm:

```
score = 0.35·confidence + 0.25·frequency (bão hoà 5 lần nhắc)
      + 0.20·corroboration (bão hoà 3 episode) + 0.20·recency
      (decay tuyến tính 30 ngày) − 0.30·contradiction
```

`runScoredDreamPass` chạy trên episode chưa xử lý của temporal
graph: extract → gom nhóm theo fact chuẩn hoá → chấm điểm → chỉ
promote top-N đủ điểm vào block `human` → đánh dấu episode đã xử
lý. Fact điểm thấp không bị xoá — nhắc lại sẽ tăng frequency. Fact
mâu thuẫn fact active KHÔNG được promote (ghi vào report, không tự
ghi quarantine để tránh trùng với `consolidateGraph`).

## 4. Validity windows (`packages/core/src/memory/graph/validity.ts`)

Đồ thị v0.98 đã có cửa sổ bi-temporal nhưng chưa có lớp quản lý:

- `parseValidityHint(text)` — rút gợi ý từ "từ 2020-01-01 đến
  2024-12-31" / "đến 2026-12-31" / "từ 03/2025" (chỉ ngày ISO hoặc
  tháng/năm chắc chắn, không đoán).
- `setValidityWindow` / `extendValidity` (chỉ nới ra, thu hẹp phải
  tường minh) / `closeValidity` — qua `TemporalGraphStore.setFactValidity`
  (mới, additive) + `validUntil` trong `AddFactInput` (mới, additive).
  `validUntil < validFrom` bị chặn ở store.
- `validityReport` — expired / expiring-soon (mặc định 30 ngày) /
  open-ended / invalid-window.
- `sweepExpiredFacts` — fact active nhưng `validUntil` đã qua được
  đóng mềm bằng `deleteFact` (status `deleted`, vẫn xem lại qua
  `factHistory`, KHÔNG xoá khỏi file) + ghi dòng vào
  `.open-bot/memory-validity-sweeps.jsonl` để audit.

## 5. Per-scope retrieval (`packages/core/src/memory/scopedRetrieval.ts`)

`retrieveScoped` hợp nhất cả ba kho: graph facts + long-term entries
+ memory blocks (trực tiếp + shared-group). Mọi nguồn đều qua
`scopeIncludes` (fact user/bot/run khác không lọt vào). Điểm =
keyword hits × confidence × scope-level weight (run 1.0 > agent 0.8 >
user 0.6 > app 0.4) × source weight (graph 1.0, long-term 0.9, block
0.85). Dedupe theo text chuẩn hoá, giữ hit điểm cao nhất, ghi
`mergedSources`. Query rỗng = recent theo scope. Không
embedding/model — keyword + confidence + scope weight là đủ cho
local-first.

## 6. Tools (`packages/tools/src/memoryV4Tools.ts`, 6 tool)

| Tool | Approval | Ghi chú |
|---|---|---|
| `memory_v4_shared_group` | true | create/list/add-member/remove-member/attach-block/detach-block/delete |
| `memory_v4_shared_resolve` | false | resolve blocks + sync report (read) |
| `memory_v4_judge_message` | true | extract → judge → apply một message |
| `memory_v4_scored_dream` | true | dream có scoring |
| `memory_v4_validity` | true | report/parse-hint/set-window/extend/close/sweep |
| `memory_v4_scoped_recall` | false | fused recall 3 kho (read) |

Đăng ký qua `createMemoryV4Tools` (factory pattern như v3, nối vào
coordinator guarded) + export ở `packages/tools/src/index.ts`. KHÔNG
gộp vào `ALL_TOOLS` — `ALL_TOOLS` chỉ chứa built-in tools của
`packages/tools/src/tools.ts`; memory tools đăng ký qua factory của
coordinator như v2/v3 (cùng store đồ thị/block/long-term).

## 7. i18n

10 key `memory.v4.*` (sharedGroups, scoredDream, judge, validity,
scopedRecall + intro) thêm vào đủ 6 locale (en/vi/zh/ja/es/fr);
`tests/i18n.test.mjs` xanh (2809 key/locale).

## 8. Test

- `tests/memory-v4-v103.test.mjs` — 22 test core.
- `tests/memory-v4-tools-v103.test.mjs` — 7 test tools.
- Hồi quy: 108 test memory graph/v3/blocks cũ xanh.

## Giới hạn còn lại

- Judge + extractor đều rule-based: câu diễn đạt lạ (vd phủ định
  kiểu "giờ chán phở rồi") extractor chưa rút được → fact không vào
  judge. LLM extractor (interface `FactExtractor` đã có) sẽ mở rộng
  được mà không đổi judge.
- Scored dream chỉ xét episode của temporal graph, chưa xét daily
  notes của `DeepDreamEngine` — hai dream pass chạy song song, chưa
  gộp.
- Validity sweep chỉ chạy tay qua tool; chưa nối vào sleep agent tự
  động (cần host quyết định lịch sweep).
- Shared-group role `read` hiện chỉ ghi nhận, chưa chặn sửa block
  ở tầng store (thành viên read vẫn sửa được nếu gọi trực tiếp
  `MemoryBlockStore`).
