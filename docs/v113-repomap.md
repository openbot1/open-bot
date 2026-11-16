# Repo map v5 — symbol topology + hierarchical summaries + incremental index + code graph search + jump-to-definition (v1.13, Đội T3)

Ý tưởng học từ OpenHands Repository Map — chỉ học ý tưởng, tự thiết kế
và viết lại hoàn toàn từ đầu, KHÔNG đọc, KHÔNG copy code/text/tài sản
của bất kỳ repo nào.

## Nó nối tiếp cái gì

| Lớp | Trước đây | v5 thêm |
| --- | --- | --- |
| v1 (`tools/repoMap.ts`) | Đồ thị file-level, PageRank cá nhân hoá theo chat | — |
| v2 (`codingV2`) | Đồ thị symbol-level, cache đĩa theo mtime/size | — |
| v3 (`codingV3`) | Call edges file→file, module graph, budget map | — |
| v4 (`codingV4`) | PageRank v2 (PageRank + references + freshness), weighted map, invalidation theo fingerprint | — |
| **v5 (`codingV5`)** | — | **Export/import/call-site topology, tóm tắt phân cấp theo thư mục, index tăng dần theo content hash + invalid theo phụ thuộc, tìm kiếm trên đồ thị code, jump-to-definition cho agent loop** |

## Module

Core (thuần túy, không fs) — `packages/core/src/codingV5/`:

- `topology.ts` — trích export (named/default/namespace/re-export,
  kể cả `__all__` của Python), import (static/dynamic/type/require,
  alias, bare vs resolved), call site (caller là symbol chứa dòng gọi,
  callee resolve theo tên ngắn, `ambiguous` khi tên định nghĩa ở nhiều
  file và có receiver), **giải chuỗi re-export về định nghĩa gốc**
  (kể cả `export *` và `export * as ns`, an toàn với vòng lặp).
  Tính fan-in/fan-out theo file và theo symbol,
  chu trình import tĩnh (DFS, chuẩn hoá xoay), file mồ côi, hub.
- `summaries.ts` — tóm tắt từng thư mục (file/symbol theo kind, top
  symbol theo PageRank v2, export, phụ thuộc ra/vào, chu trình nội bộ,
  orphan), rollup lên cấp cha, render skeleton vừa ngân sách token
  (luôn giữ gốc + đường tới thư mục seed).
- `incrementalIndex.ts` — content hash FNV-1a 64-bit (tự viết, không
  phải hash bảo mật): file đổi mtime nhưng cùng hash thì chỉ cập nhật
  fingerprint (`metadataOnly`, không parse lại). Invalid theo phụ
  thuộc: file đổi/xoá làm stale file import nó (trực tiếp + gián tiếp,
  độ sâu mặc định 3). Cache JSON version 5
  (`.open-bot/coding-v5/repo-map-v5.json`) + đồ thị importers đảo.
- `search.ts` — tìm symbol (exact/prefix/substring/regex/fuzzy
  subsequence, lọc kind/file/directory, xếp hạng theo điểm khớp tên +
  PageRank + fan-in), tìm caller/callee thật từ call site, tìm file
  import một module (theo đường dẫn, tên file, hoặc bare specifier),
  impact analysis (đổi symbol X thì ảnh hưởng tới đâu: lan ngược theo
  caller + importer, theo bậc, over-approximation có chủ đích).
- `jumpToDefinition.ts` — API cho agent loop: "symbol X định nghĩa ở
  đâu, dùng ở đâu" — định nghĩa tốt nhất (file đang đọc > public
  export > PageRank), signature + context lines, usages (call/import/
  reference), danh sách mơ hồ đầy đủ, gợi ý tên gần nhất khi không thấy.

Lớp fs + tools — `packages/tools/src/`:

- `codingV5RepoMap.ts` — `CodingV5RepoMapStore` bọc `CodingV2RepoMapStore`
  (parse/tree-sitter + cache v2), đọc source từ đĩa, dựng 5 lớp v5,
  ghi cache index v5.
- `repoMapV5Tools.ts` — 6 tool, **chỉ định nghĩa trong module riêng,
  không sửa registry trung tâm `ALL_TOOLS`** (coordinator nối sau):
  `repomap_v5_build`, `repomap_v5_search`, `repomap_v5_definition`,
  `repomap_v5_callers` (callers/callees/importers/impact),
  `repomap_v5_summary`, `repomap_v5_index`.
  Tất cả `needsApproval: false`; build chỉ ghi cache trong workspace.

## Dùng thử

```ts
import { createCodingV5Tools } from '@open-bot/tools';
const tools = createCodingV5Tools({ workspaceDir: '/path/to/repo' });
// repomap_v5_build -> repomap_v5_search { query: 'alpha' }
// repomap_v5_definition { symbol: 'Beta.save', fromFile: 'src/b.ts' }
// repomap_v5_callers { kind: 'callers', symbol: 'alpha' }
// repomap_v5_summary { section: 'skeleton', budgetTokens: 2000 }
// repomap_v5_index  (không build lại)
```

## Giới hạn trung thực

- Call site trích bằng regex trên dòng source (đã cắt string/comment
  đơn giản): gọi qua biến trung gian (`const f = g; f()`), gọi động
  (`obj[method]()`), gọi trong template literal phức tạp không thấy.
  Callee khớp theo tên ngắn; tên mơ hồ được đánh dấu `ambiguous`,
  không đoán bừa (trừ gọi trần trong chính file định nghĩa nó).
- "Call" suy từ nhắc tên + vị trí gọi, không phải call graph chính
  xác theo AST; import động không tính vào chu trình import.
- Export/import Python ở mức cơ bản (`import`/`from`/`__all__`);
  `importlib` động không phân tích.
- Token chỉ là ước lượng (chars/4). FNV-1a chỉ để phát hiện thay đổi,
  không chống va chạm có chủ đích.
- i18n: 24 key `repomapV5.*` × 6 locale (vi/en/zh/ja/es/fr).
  Repo không có `ko.json` (chỉ có fr thay cho ko) nên key được thêm
  vào 6 locale hiện có.

## Test

```sh
npm run build --workspace=@open-bot/core
npm run build --workspace=@open-bot/tools
node --test tests/coding-v5-topology.test.mjs \
  tests/coding-v5-summaries-search.test.mjs \
  tests/coding-v5-incremental.test.mjs \
  tests/coding-v5-tools.test.mjs tests/i18n-v113.test.mjs
# 68 test, 0 fail (tại thời điểm viết)
```

Lưu ý cho coordinator: 2 test pin i18n toàn cục (`i18n-v106`,
`i18n-v112`) sẽ báo 4842 thay vì 4818 — đúng +24 key của sóng này;
pin do coordinator tính lại lúc gộp (cộng thêm key các đội khác).
