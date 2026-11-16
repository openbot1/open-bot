# Agent Skills loader v13 (sóng v1.13, Đội T1)

Loader SKILL.md theo chuẩn mở Agent Skills (agentskills.io), xây trên
loader v0.11a sẵn có — **chỉ học ý tưởng từ chuẩn mở, không copy code
hay nội dung skill của bất kỳ dự án nào**. Mọi skill mẫu trong test đều
do đội T1 tự viết.

## Module mới — `packages/core/src/skills/v13/`

| File | Việc làm |
| --- | --- |
| `validation.ts` | Kiểm tra v13 nghiêm ngặt: `compatibility` ≤ 500 ký tự (lỗi), `license` rỗng/> 200 ký tự (lỗi), license không phải SPDX (cảnh báo), `metadata` > 4096 ký tự (lỗi), `allowed-tools` sai định dạng/trùng (lỗi), tool lạ so với host (cảnh báo), description phải nói **khi nào dùng** (lỗi `description-no-trigger`), `tools:` + `allowed-tools:` cùng lúc (lỗi), body > 20.000 ký tự (lỗi) / > 500 dòng (cảnh báo), code fence > 50 dòng (cảnh báo). Trả `{errors, warnings, qualityScore 0–100, contextTax}`. `validateSkillDirV13(dir)` kiểm tra cả thư mục, trả tổng hợp (số valid/invalid, điểm trung bình, tổng context tax). |
| `skillDiff.ts` | So sánh 2 phiên bản skill: thay đổi theo field, breaking change (bớt allowed-tool, thu hẹp scope, mất > nửa body, tắt kích hoạt), gợi ý semver bump (major/minor/patch/none), `versionRegressed` khi version mới không mới hơn. Dùng cho marketplace upgrade check. |
| `sessionIndex.ts` | `SkillSessionIndex`: mở session chỉ đọc **header** (tier 1) → index `name — description` + token header; `ensureBody(name)` nạp body theo yêu cầu (tier 2) với cache LRU (mặc định 8 body); `readResource`/`resourcePath` (tier 3) chỉ đọc `scripts/`/`references/`/`assets/`, chặn traversal. Root sau override root trước khi trùng tên. |
| `internalRegistry.ts` | Catalog skill của chính open-bot: 11 builtin (`code-review`, `commit-message`, `data-cleaning`, `git-workflow`, `meeting-notes`, `release-notes`, `research-brief`, `summarize-file`, `test-writing`, `translation`, `writing-vi`) + 4 capability (`memory-recall`, `voice-realtime`, `coding-agent`, `platform-fleet`). `searchInternalSkills(query)`, `skillsForContext(context)`, overlay runtime `register/unregisterInternalSkill`. |
| `interop.ts` | Nhập/xuất với 3 host: Claude Code (`.claude/skills/`), Codex CLI (`~/.agents/skills/`, project `.codex/skills/`), Gemini CLI (`~/.gemini/skills/`). `detectSkillFormat`, `exportSkillToHost`, `importSkillFromHost`, `importAllFromHost`, `listHostSkills`. Skill luôn qua loader + v13 validation + quét secret trước khi ghi; không ghi đè nếu chưa `overwrite`; từ chối symlink. |
| `localMarketplace.ts` | Marketplace **cục bộ** (khác marketplace URL v0.14): `browseLocalMarketplace` (kèm manifest `skill.json` — tên/version/mô tả phải khớp SKILL.md, version semver, tags lowercase, `minOpenBotVersion`), `searchLocalMarketplace`, `installLocalSkill` (copy qua thư mục tạm rồi rename — không nửa vời), `uninstallLocalSkill` (chỉ xóa thư mục có SKILL.md), `checkLocalUpgrades` + `compareSemver`. |
| `audit.ts` | Audit kiểu mcode-stack: `auditToolBudget` (đếm tool-call theo skill, vượt ngân sách, tool chiếm đa số, skill lỗi nhiều), `auditContextTax` (token header/body, skill chưa bao giờ kích hoạt = lãng phí header), `buildWasteReport` (xếp hạng lãng phí + khuyến nghị) và `formatWasteReport` (Markdown). |

Export chung qua `packages/core/src/skills/index.ts` (`export * from './v13/index'`).

## Tools — `packages/tools/src/skillsV13Tools.ts`

8 tool qua factory `createSkillsV13Tools({getSkillsDir})`, **không** nối
vào `ALL_TOOLS` (coordinator nối sau):

| Tool | Quyền |
| --- | --- |
| `skills_v13_list` | chỉ đọc |
| `skills_v13_search` | chỉ đọc |
| `skills_v13_validate` | chỉ đọc |
| `skills_v13_audit` | chỉ đọc |
| `skills_v13_import` | cần duyệt |
| `skills_v13_export` | cần duyệt |
| `skills_v13_install_local` | cần duyệt |
| `skills_v13_uninstall` | cần duyệt |

Tool ghi cần `getSkillsDir` từ host; chưa cấu hình thì báo lỗi rõ ràng
thay vì ghi lung tung. Không tool nào in nội dung secret.

## i18n

18 key `skillsV13.*` × 6 locale (vi, en, zh, ja, es, fr — repo hiện có
fr, **không có ko.json**): tiêu đề, validate, điểm chất lượng, context
tax, tìm kiếm, import/export, cài/gỡ, báo cáo lãng phí.

## Test

5 file, 85 test, đều dùng skill mẫu tự viết, không mạng/không key:

- `tests/skills-v113-validation.test.mjs` — validation + internal registry
- `tests/skills-v113-session-interop.test.mjs` — session index + interop
- `tests/skills-v113-marketplace-audit.test.mjs` — marketplace + audits
- `tests/skills-v113-tools.test.mjs` — 8 agent tool
- `tests/skills-v113-diff.test.mjs` — skill diff + validate cả thư mục

```sh
npm run build --workspace=@open-bot/core
npm run build --workspace=@open-bot/tools
node --test tests/skills-v113-validation.test.mjs tests/skills-v113-session-interop.test.mjs tests/skills-v113-marketplace-audit.test.mjs tests/skills-v113-tools.test.mjs tests/skills-v113-diff.test.mjs
```

## Giới hạn đã biết

- `validateSkillV13` không biết version thật của skill khi loader đã
  mặc định `1.0.0` — cảnh báo `version-default` chỉ là gợi ý.
- Interop chỉ đọc/ghi **thư mục**, không gọi CLI của Claude/Codex/
  Gemini (không chạy process ngoài).
- Audit chỉ tính trên log/activations mà host đưa vào — nó không tự
  thu thập log từ agent loop (host cần truyền `usageJson` /
  `activationsJson` cho tool `skills_v13_audit`).
- Mô tả "khi nào dùng" được kiểm tra bằng danh sách từ kích hoạt
  (Anh/Việt/Trung/Nhật/Tây Ban Nha/Pháp) — heuristic, không phải NLP.
