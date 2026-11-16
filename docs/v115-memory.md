# Memory v14 — sóng v1.15, Đội T1

CHỈ HỌC Ý TƯỞNG từ Mem0 v3 / Letta / Zep-Graphiti (mục 2,
`docs/repo-survey-v115.md`), không copy code/text/tài sản của bất kỳ
repo nào. Mọi module đều tự thiết kế lại cho open-bot, chạy 100%
local, không gọi API thật.

## 1. Tổng quan

| Module | File | Chức năng |
|---|---|---|
| Extraction v2 | `packages/core/src/memory/v14/extraction.ts` | Rule v13 kế thừa + 12 predicate mới, ngữ pháp thời gian, retract, LLM-optional hook + mock LLM |
| Temporal KG v3 | `packages/core/src/memory/v14/temporalKg.ts` | Supersede có mốc, `factsValidAt`, timeline, phát hiện cửa sổ chồng nhau |
| Fusion v2 | `packages/core/src/memory/v14/fusion.ts` | Semantic + BM25 + graph (trực tiếp 1.0 / 1-hop 0.5), weighted + RRF |
| Poisoning defence | `packages/core/src/memory/v14/poisoning.ts` | Source trust, judge rule-based, quarantine, audit JSONL (OWASP ASI06) |
| GDPR erasure | `packages/core/src/memory/v14/erasure.ts` | Hard delete theo user/subject + receipt + verify + audit |
| Eval | `packages/core/src/memory/v14/eval.ts` | 24 case (16 retrieval + 8 poisoning), đo recall/precision/F1/block rate |
| Tools | `packages/tools/src/memoryV14Tools.ts` | 8 tool `memory_v14_*`, đăng ký trong `ALL_TOOLS` + `createDefaultTools` |
| i18n | `apps/desktop/src/renderer/i18n/locales/*.json` | 15 khóa `memoryV14.*` × 6 locale |

Store thêm 3 phương thức hard-delete (`packages/core/src/memory/graph/store.ts`):
`removeFactHard` / `removeEpisodeHard` / `removeQuarantineHard` — chỉ dùng
cho GDPR erasure; xóa mềm thông thường vẫn dùng `deleteFact`.

## 2. Extraction v2 — Mem0-style

- **Kế thừa v13**: `extractCandidatesFromText` (likes / lives_in /
  works_at / speaks / wants / prefers / uses) được gọi lại, không viết lại.
- **Predicate mới** (12): `has_pet`, `owns`, `allergic_to`, `plays`,
  `knows_skill`, `is_friend_of`, `works_with`, `visited`, `eats`,
  `studies_at`, `born_in`, `favorite` (VI + EN).
- **Ngữ pháp thời gian**: `parseTemporalHint` rút `validFrom` /
  `validUntil` từ "từ 2020", "từ tháng 3/2026", "đến 2026",
  "since/until + year" → fact mang luôn cửa sổ hiệu lực cho KG v3.
- **Retract**: "không còn thích X nữa" / "no longer like X" tạo ứng viên
  `intent: 'retract'` — apply sẽ **đóng cửa sổ** của fact cũ thay vì
  tạo fact `dislikes` mâu thuẫn.
- **LLM-optional hook**: interface `V14LlmExtractor` — extractor gọi
  model thật nào cũng cắm được; `V14MockLlmExtractor` là mock xác định
  (không gọi API) bắt cách diễn đạt rule bỏ sót ("tôi mê …", "go-to
  drink", "based in …"). Rule luôn thắng khi trùng lặp; LLM lỗi thì
  fail-open (chỉ dùng rule).
- **Source trust**: `effectiveConfidence = confidence × (0.5 + 0.5 × trust)`.
  Nguồn không tin cậy không bao giờ thắng được fact tin cậy cao.
- **Predicate đơn trị vs đa trị**: chỉ `lives_in`, `works_at`,
  `born_in`, `studies_at`, `favorite` là đơn trị — giá trị mới mâu
  thuẫn giá trị cũ (supersede/quarantine). `likes`, `speaks`… là đa
  trị: giá trị mới sống song song, không supersede, không tính là mâu
  thuẫn cho judge.
- `applyExtractionV14`: trích → lọc confidence hiệu dụng → gate
  (judge, tùy chọn) → append add-only (dedupe) → supersede khi đủ tin
  (chỉ tạo **đúng 1** fact mới — kiểm tra mâu thuẫn **trước** khi ghi)
  → retract đóng cửa sổ. Không bao giờ overwrite/xóa fact cũ.

## 3. Temporal KG v3

- `supersedeFactV14(store, oldId, input, { supersededAt })`: fact cũ
  thành `superseded`, `validUntil = supersededAt`, `supersededBy` →
  fact mới; fact mới `validFrom = supersededAt`, `supersedes` → fact cũ.
  Mốc do caller chọn (thời điểm turn nói ra sự thay đổi), không phải
  giờ wall-clock lúc ghi.
- `factsValidAt(store, T, opts)`: mọi fact **đúng tại T** — kể cả fact
  đã superseded, miễn cửa sổ của nó bao phủ T (khác `isFactValidAt`
  chỉ tính fact `active`).
- `factTimelineV14(subject, predicate)`: các phiên bản theo thứ tự
  `validFrom`, kèm cửa sổ + status + liên kết supersession;
  `formatTimelineV14` render text.
- `overlappingIntervalsV14`: phát hiện 2 fact cùng (subject,
  predicate) có cửa sổ chồng nhau (dữ liệu lỗi, thường do import tay).
- `closeIntervalV14`: đóng cửa sổ tại mốc cho trước (retract/hết hạn).

## 4. Retrieval fusion v2

- 3 tín hiệu: semantic (`LocalHashEmbedder` + cosine, v10), BM25
  (`Bm25`, graph v0.98), **graph**: entity trong query = 1.0, fact về
  entity **kề 1-hop** = 0.5 (vd hỏi "Công ty Đỏ" thì fact `likes` của
  người làm ở đó vẫn được điểm graph nhỏ).
- 2 chế độ hợp nhất: `weighted` (mặc định semantic 0.4 / BM25 0.35 /
  graph 0.25, chuẩn hóa min-max từng tín hiệu) và `rrf` (reciprocal
  rank fusion, k = 60, chuẩn hóa về [0,1]).
- Lọc theo cửa sổ hiệu lực **tại thời điểm hỏi** (`asOf`); tùy chọn
  `includeSupersededHistory` để lấy lại lịch sử đã superseded cho
  mốc quá khứ.
- Mỗi hit kèm điểm từng tín hiệu + hạng từng tín hiệu + giải thích;
  `ablation()` đo đóng góp từng tín hiệu (tắt một tín hiệu xem top-1
  có đổi không).

## 5. Poisoning defence — OWASP ASI06

- **Source trust registry** (`V14SourceTrustRegistry`): trust mặc định
  theo loại nguồn (`user-chat` 1.0, `user-notes` 0.9, `user-import` 0.7,
  `web-scrape` 0.4, `third-party-agent` 0.3, `unknown` 0.5); host đăng
  ký/ghi đè từng nguồn, export/import được.
- **Mẫu nghi ngờ**: kế thừa `SUSPICIOUS_PATTERNS` của consolidateGraph
  + 11 mẫu v14 ("từ giờ trở đi", lộ mật khẩu, "pretend to be",
  "overwrite all", `[INST]`, …). **Kiểm tra không dấu**: mọi mẫu đều
  có bản normalize (`V14_SUSPICIOUS_PATTERNS_NORM`, test trên text đã
  bỏ dấu) nên câu tấn công viết không dấu vẫn bị bắt.
- **Judge rule-based** (`judgeCandidateV14`): điểm rủi ro 0..1 từ 5 tín
  hiệu — mẫu nghi ngờ (+0.5, một mình đã đủ vào quarantine), mâu thuẫn
  fact tin cậy cao ≥ 0.85 (+0.5 khi ứng viên yếu hơn), nguồn kém tin
  cậy, confidence hiệu dụng thấp, flood (> 8 ứng viên/episode).
  Ngưỡng cấu hình được: risk ≥ 0.85 → reject; ≥ 0.5 → quarantine; còn
  lại → accept. Ngoại lệ cứng: mẫu nghi ngờ + trust < 0.3 → reject
  thẳng; confidence hiệu dụng < 0.3 → reject thẳng.
- **Quarantine**: dùng kho `addToQuarantine` / `reviewQuarantine` của
  store (không viết kho mới). Approve → fact active (supersede fact
  mâu thuẫn nếu có); reject → chỉ đánh dấu, không bao giờ vào đồ thị.
  `quarantineStatsV14` thống kê theo status/reason.
- **Audit**: mọi quyết định judge ghi JSONL
  (`.open-bot/memory-v14-judge-audit.jsonl`, tối đa 1000 dòng, dòng
  hỏng bị bỏ qua khi đọc).
- `v14JudgeGate()` cắm thẳng vào `applyExtractionV14` làm gate.

## 6. GDPR erasure

- `eraseUserV14(store, userId, opts)`: hard-delete toàn bộ facts (mọi
  status, **embedding trong fact bị xóa cùng**), episodes, quarantine
  items của user đó; entity chỉ bị xóa khi mồ côi sau khi xóa (entity
  dùng chung với user khác được giữ).
- `eraseSubjectV14(store, subjectName, opts)`: xóa facts/quarantine về
  một entity (vd một người); episode **không** bị xóa nhưng liên kết
  `factIds` được dọn sạch.
- Bắt buộc `confirm` trùng khop target (userId / tên subject), có
  `dryRun` (chỉ đếm), receipt gồm counts + `erasedFactIds` + `verified`
  (quét lại toàn bộ file, `remaining` phải = 0). Audit JSONL
  (`.open-bot/memory-v14-erasure-audit.jsonl`) **không chứa nội dung
  fact** — chỉ id + số lượng + target.

## 7. Eval — số liệu đo được (chạy 16/11/2026)

Dataset `buildV14EvalDataset()`: 24 case, nhân vật/tình huống hư cấu
mới hoàn toàn so với v13 (Lan, Minh, Hoa, Tuan), 14 seed facts.

```
[v14 eval] answerHit=93.8% recall=94.7% precision=22.5% F1=36.4%
           blockRate=100.0% falsePositive=0.0% decisionAcc=100.0%
```

- Retrieval (16 case, topK 5): answer hit 15/16 (93.8%), support
  recall 94.7%. Precision 22.5% là precision **ước lượng**
  (supportFound / tổng text lấy về, topK 5) — thấp vì top-5 luôn trả
  5 text trong khi mỗi câu chỉ có 1–2 fact hỗ trợ; không phải lỗi
  retrieval. Case MISS duy nhất: **r12** (multi-hop) — "Người sống ở
  Đà Nẵng thích món ăn gì?" chỉ lấy được fact `Lan lives_in Da Nang`,
  không lấy được `Lan likes phở bò` trong top-5: query không nêu tên
  Lan nên tín hiệu graph không nối được hop Đà Nẵng → Lan → phở bò.
  Đây là giới hạn thật của fusion 1-hop hiện tại (cần 2-hop traversal
  để nối entity trung gian ẩn danh).
- Poisoning (8 case: 6 độc hại + 2 lành): chặn 6/6 (100%), báo động
  sai 0/2 (0%), quyết định đúng như mong đợi 8/8 (100%).
- Chạy: `node --test tests/memory-v14-erasure-eval-tools-v115.test.mjs`
  (in số liệu ra console) hoặc tool `memory_v14_eval`.

## 8. Tools

`createMemoryV14Tools({ graphStore | workspaceDir, botId })` — 8 tool:

| Tool | Quyền | Mô tả |
|---|---|---|
| `memory_v14_extract` | approval | Trích fact (rule + mock LLM tùy chọn), qua judge, ghi KG |
| `memory_v14_fused_search` | read | Fusion 3 tín hiệu, weighted/RRF, lọc `asOf` |
| `memory_v14_state_at` | read | Tri thức đúng tại T + timeline (subject, predicate) |
| `memory_v14_quarantine_list` | read | Liệt kê quarantine + thống kê |
| `memory_v14_quarantine_review` | approval | Approve/reject quarantine (cần `reviewedBy`) |
| `memory_v14_erase` | approval | GDPR erasure, bắt buộc `confirm`, dry-run + verify |
| `memory_v14_eval` | read | Chạy eval 24 case, trả số liệu + báo cáo markdown |
| `memory_v14_extract_preview` | read | Xem trước ứng viên rule, không ghi |

Đăng ký trong `ALL_TOOLS` (`packages/tools/src/tools.ts`, mỗi tên đúng
1 lần) + bind qua `createDefaultTools({ getMemoryV14WorkspaceDir,
getMemoryV14BotId })`. Placeholder unbound báo lỗi rõ ràng thay vì crash.

## 9. Test

3 file, 40 test, đều xanh (16/11/2026):

- `tests/memory-v14-extraction-temporal-v115.test.mjs` (15)
- `tests/memory-v14-fusion-poisoning-v115.test.mjs` (14)
- `tests/memory-v14-erasure-eval-tools-v115.test.mjs` (11, gồm eval + tools + i18n)

```
npm run build --workspace=@open-bot/core
npm run build --workspace=@open-bot/tools
node --test tests/memory-v14-extraction-temporal-v115.test.mjs \
  tests/memory-v14-fusion-poisoning-v115.test.mjs \
  tests/memory-v14-erasure-eval-tools-v115.test.mjs
# tests 40, pass 40, fail 0
```

## 10. Giới hạn còn tồn tại

- Mock LLM chỉ là regex xác định — **không phải model thật**; hook
  `V14LlmExtractor` chờ host cắm extractor gọi model thật.
- Embedding semantic vẫn là `LocalHashEmbedder` (hash, v10) — đủ để
  fusion chạy offline và đo được, nhưng không phải embedding ngữ nghĩa
  thật; khi có Ollama thì thay embedder qua `opts.embedder`.
- Precision eval là ước lượng (supportFound / retrieved) — không phải
  precision trên relevance judgment của người.
- Erasure theo subject không xóa episode (chỉ dọn `factIds`): nội dung
  turn gốc vẫn còn trong episode nếu turn đó nhắc tới subject — host
  cần thêm bước xóa/redact episode khi yêu cầu xóa tuyệt đối.
- Judge là rule-based: kẻ tấn công diễn đạt mới (không khớp mẫu, không
  mâu thuẫn fact đơn trị) có thể lọt — tuyến cuối vẫn là user duyệt
  quarantine + audit log.
- Chưa có UI panel riêng cho memory v14 (chỉ i18n + tools); T6 có thể
  gắn panel quarantine/eval/state-at từ các API này.
