# Memory v5 — v1.04, Đội T1

Ý tưởng học từ Mem0 v3 (ADD-only fact store), Graphiti/Zep
(bi-temporal edges, invalidate thay vì xóa) và Cognee (ingest
file/repo → graph, chunk + dedup + provenance) — chỉ học ý tưởng,
tự thiết kế lại hoàn toàn cho open-bot, 100% local, không gọi
model, không copy code/text/tài sản của bất kỳ repo nào. Kế thừa:
temporal graph + quarantine v0.98, validity windows + judge +
scored dream + scoped retrieval v1.03.

## 1. ADD-only fact store (`packages/core/src/memory/graph/addOnly.ts`)

Fact mới LUÔN append cạnh fact cũ — không update/delete tại chỗ
trong lúc append. Ngoại lệ duy nhất: trùng lặp CHÍNH XÁC (cùng
subject + predicate + object đã chuẩn hoá, đang active) thì
dedupe, trả về fact cũ.

- `appendFactAddOnly` — append + trả nhóm sau khi append (đã xếp hạng).
- `scoreAddOnlyFact` — điểm = 0.30·confidence + 0.30·recency
  (decay tuyến tính 90 ngày) + 0.20·support (fact cùng object,
  bão hoà 3) + 0.20·freshness (validUntil null) − 0.15·mỗi fact
  khác-object trong nhóm (tối đa 0.30).
- `resolveAddOnlyGroups` — gom fact active theo (subject,
  predicate), xếp hạng từng nhóm, winner = điểm cao nhất (hoà thì
  fact mới hơn thắng).
- `addOnlyContradictionRate` — nhóm có ≥ 2 object / tổng nhóm.
- `retrieveAddOnly` — điểm = keyword hits × điểm ranking;
  `winnersOnly` (mặc định true) mỗi nhóm chỉ trả winner — loser
  vẫn trong store, vẫn xem được qua rank, chỉ không lọt vào câu
  trả lời của agent.
- `applyRankingSupersession` — BƯỚC TƯỜNG MINH (không tự động):
  loser chỉ bị supersede (qua `mergeFacts` có sẵn — lịch sử giữ
  nguyên) khi winner có confidence ≥ 0.6 VÀ hơn loser ≥ 0.25
  điểm; chưa đủ điều kiện thì ở lại active.
- `explainRanking` — giải thích bằng câu đọc được vì sao fact
  thắng/thua (từng thành phần điểm + gap so với winner).

## 2. Temporal KG v2 — bi-temporal (`packages/core/src/memory/graph/biTemporal.ts`)

`GraphFact` đã là bi-temporal từ v0.98 (validFrom/validUntil =
thời gian sự kiện, createdAt/updatedAt = thời gian ghi nhận).
V2 thêm lớp quản lý còn thiếu:

- `invalidateFact` — đóng `validUntil` = invalidAt vì MÂU THUẪN
  (không phải hết hạn, không phải bị thay thế): fact giữ status
  `active`, trước invalidAt vẫn đúng, sau thì không; lý do bắt
  buộc (audit); ghi JSONL
  `.open-bot/memory-invalidations.jsonl`.
- `queryFactsAtBiTemporal` — "fact đúng tại thời điểm T, theo tri
  thức đã biết tại thời điểm R": trục sự kiện (validFrom ≤ T <
  validUntil) VÀ trục ghi nhận (createdAt ≤ R; fact bị đóng cửa
  sổ trước R thì `currentAtRecordTime = false`).
- `edgeValidityIntervals` + `findEdgeIntervalOverlaps` — toàn bộ
  khoảng hiệu lực của một edge + cặp khoảng overlap (dấu hiệu mâu
  thuẫn chưa xử lý).
- `factVersionTimeline` — timeline phiên bản đầy đủ của một edge:
  created / superseded / deleted / invalidated (kèm lý do từ log).
- `readInvalidationLog` / `findInvalidatedFacts` — audit trail.

## 3. Ingestion kiểu Cognee (`packages/core/src/memory/graph/ingest.ts`)

- `chunkText` — chia theo heading markdown (biên cứng), code
  fence (không chẻ đôi), đoạn văn, rồi theo dòng/ký tự; chunk kề
  nhau overlap 200 ký tự; `maxChars` kẹp 200..20000.
- `ingestDocument` — chunk → dedupe chunk (hash SHA-256) → extract
  từng chunk bằng `RuleBasedFactExtractor` → dedupe fact
  (subject|predicate|object chuẩn hoá) → `consolidateCandidates`
  (nghi ngờ → quarantine). Mỗi chunk là một episode riêng (turnId
  `ingest:<source>:<index>`) nên ingest lại không tạo episode trùng.
- `ingestFile` / `ingestDirectory` — đọc file text (bỏ file nhị
  phân / > 1MB), đi thư mục (bỏ node_modules/.git/dist/...,
  tối đa 200 file).
- `parseChatTranscript` / `ingestTranscript` — parse transcript
  (`User:` / `Assistant:` / `System:` / `Huy:` / `Bot:`), mỗi turn
  là một episode (turnId `transcript:<source>:<index>`, dedupe
  theo turnId), lọc theo role.
- Provenance: fact trỏ về episode của chunk/turn đã sinh ra nó;
  report ghi rõ `sourceLabel` + `chunkId` cho từng fact.

## 4. Consolidation v2 + memory health

`packages/core/src/memory/memoryHealth.ts`:

- `computeMemoryHealth` — fact count, contradiction rate, stale
  rate (fact active > 90 ngày không cập nhật), orphan entities,
  quarantine backlog, low-confidence rate, confidence trung bình,
  tuổi trung bình, top predicate. Điểm 0..100 = 100 − 40·mâu
  thuẫn − 25·già − 15·quarantine − 10·mồ côi − 10·confidence thấp;
  grade excellent ≥ 85, good ≥ 70, fair ≥ 50, còn lại poor. Mọi
  khoản trừ đều có issue đọc được.
- `healthTrend` / `readHealthTrendLog` — xu hướng điểm theo log
  consolidation v2 (direction improving/declining/flat/unknown,
  best run, total delta).
- `healthAttentionFacts`, `contradictionGroupSummary`,
  `healthReportMarkdown`, `healthDelta`.

`packages/core/src/memory/consolidationV2.ts` — một lần chạy, theo
thứ tự: (1) đo health trước, (2) gộp fact trùng lặp chính xác,
(3) ranking ADD-only → supersede loser đủ điều kiện, (4) sweep
fact hết hạn, (4b) dọn entity mồ côi (chỉ entity không fact nào
trỏ tới — cần `TemporalGraphStore.removeEntity` mới), (5) scored
dream pass (nếu có blocksStore), (6) đo health sau + ghi log
JSONL `.open-bot/memory-consolidation-v2.jsonl`. Không bước nào
xoá dữ liệu thật.

## 5. Tools (`packages/tools/src/memoryV5Tools.ts`, 8 tool)

| Tool | Approval | Ghi chú |
|---|---|---|
| `memory_v5_addonly_append` | true | Append ADD-only + dedupe |
| `memory_v5_addonly_rank` | false | Nhóm + winner/losers + explanation |
| `memory_v5_addonly_recall` | false | Retrieval có ranking (winnersOnly) |
| `memory_v5_bitemporal_query` | false | Fact tại T / R + edge intervals |
| `memory_v5_invalidate` | true | Invalidate + audit log |
| `memory_v5_ingest` | true | text/file/directory/transcript + dry-run |
| `memory_v5_health` | false | Health + nhóm mâu thuẫn + runs gần đây |
| `memory_v5_consolidate` | true | Consolidation v2 đầy đủ |

Đăng ký qua `createMemoryV5Tools` + nối vào coordinator (guarded
như v4). Output không bao giờ chứa embedding.

## 6. UI (`apps/desktop/src/renderer/components/MemoryV5View.tsx`)

Tab "Memory v5" trong MemoryView: health score + metrics, issues,
nhóm mâu thuẫn (winner/losers + điểm), lịch sử consolidation runs,
nút chạy consolidation v2, truy vấn bi-temporal (chọn ngày → fact
đúng tại ngày đó). IPC `memory-v5:health` / `:consolidate` /
`:bitemporal` trong main.ts; preload + renderer/types.ts +
global.d.ts mirror đủ 3 API.

## 7. i18n

38 key `memory.v5.*` + `memory.tabV5` đủ 6 locale (en/vi/zh/ja/es/fr);
tổng 3005 key/locale. Test UI kiểm tra parity + key dùng đều tồn tại.

## 8. Test

- `tests/memory-v5-v104.test.mjs` — 40 test core.
- `tests/memory-v5-tools-v104.test.mjs` — 11 test tools.
- `tests/memory-v5-ui-v104.test.mjs` — 5 test UI (tĩnh).
- Hồi quy: `tests/i18n.test.mjs` 13/13 xanh.

## Giới hạn còn lại

- Extractor rule-based: tài liệu kỹ thuật (code, log) cho ít fact —
  chunk + heading entity vẫn ghi nhận trong report; LLM extractor
  (interface `FactExtractor` đã có) sẽ mở rộng được mà không đổi
  pipeline.
- Ranking dùng recency/confidence/support/freshness — chưa dùng
  embedding semantic (cố tình: local-first, không cần model).
- Consolidation v2 chạy tay qua tool/UI; chưa nối vào sleep agent
  tự động (cần host quyết định lịch chạy).
- `mergeFacts` chỉ nối `supersededBy` (không đặt `supersedes` lên
  winner) nên `factHistory(winner)` không liệt kê loser — lịch sử
  đầy đủ đọc từ phía loser (`factHistory(loser)` đi xuôi qua
  `supersededBy`); xem test hồi quy trong file test.
