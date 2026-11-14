# Skills & plugins — v1.07 (Team T4)

Ý tưởng học từ tài liệu công khai (không copy code/text/tài sản):
- Claude Code 2026 — 7 extension layer: skills là file Markdown trong
  `.claude/skills/`, progressive disclosure theo thư mục; plugin là
  bundle skill + hook + MCP config; hooks chạy tại PreToolUse /
  PostToolUse / Stop / SessionStart / UserPromptSubmit.
- OpenHands v1.28 — agent xin secret qua modal ngay trong
  conversation, không bắt user rời chat sang Settings.

## 1. Skill theo phạm vi thư mục (`packages/core/src/skills/scope.ts`)

Skill khai thêm `scope` trong frontmatter — danh sách pattern thư
mục, tương đối so với workspace root hoặc tuyệt đối:

```yaml
---
name: deploy-server
description: Deploy the server to production.
scope: [src/server, docs/**]
---
```

- Không có `scope` = skill toàn cục (mọi skill cũ giữ nguyên hành vi).
- Pattern: `src/server` = thư mục đó + toàn bộ cây con; `*` = một
  segment; `**` = mọi độ sâu. Pattern tương đối chứa `..` bị từ chối
  lúc load (không thoát khỏi workspace).
- `SkillRegistry` có bản directory-aware của index/match/apply:
  `listForDirectory`, `skillIndexForDirectory`,
  `directorySkillIndex` (kèm đếm số skill bị ẩn bởi scope),
  `formatSkillIndexForDirectory`, `matchSkillsForDirectory`,
  `applySkillsForDirectory`. Skill ngoài phạm vi không bao giờ xuất
  hiện trong prompt, không chỉ bị xếp hạng thấp.
- LƯU Ý (bug đã sửa trong sóng này): `workingDir` tương đối phải
  được resolve về workspace TRƯỚC khi so scope — resolve về process
  CWD sẽ lặng lẽ ẩn mọi skill có scope. Các method registry đã làm
  việc này qua `resolveWorkingDir`; `buildDirectorySkillIndex` yêu
  cầu `workingDir` tuyệt đối (xem doc trong `scope.ts`).

## 2. Plugin bundle (`packages/core/src/plugins/bundle.ts`, `bundleInstall.ts`)

Một bundle = một thư mục có `manifest.json` ở gốc, đóng gói skill +
hook + MCP server thành một gói cài được:

```json
{
  "id": "my-bundle", "name": "My Bundle", "version": "1.0.0",
  "description": "...", "permissions": ["fs"],
  "skills": [{ "dir": "skills/my-skill" }],
  "hooks": [
    { "name": "guard-rm", "script": "hooks/guard.mjs",
      "events": ["PreToolUse"], "matcher": ["shell_exec"] }
  ],
  "mcpServers": { "my-server": { "command": "npx", "args": ["-y", "x"] } }
}
```

- `validatePluginBundleManifest` kiểm tra trước khi cài/kích hoạt:
  permission lạ bị TỪ CHỐI (không chỉ cảnh báo như catalog);
  skill dir và hook script phải nằm trong bundle và tồn tại; hook
  khai đúng một trong `script`/`command`; MCP server qua đúng
  validator của `mcp.json`.
- `installPluginBundle` (copy vào `<pluginsDir>/<id>`, từ chối ghi
  đè trừ khi `overwrite`), `uninstallPluginBundle` (chỉ xóa thư mục
  có manifest đúng id), `setPluginBundleEnabled` /
  `isPluginBundleEnabled` (một writer duy nhất cho `enabled.json`),
  `listPluginBundles` (bundle lỗi manifest vẫn liệt kê, không giấu).
- `activatePluginBundle` đăng ký skill vào SkillRegistry (nguồn
  `plugin`), hook vào HookRegistry (script qua
  `registerScriptHook`, command qua `registerCommandHook`), gộp MCP
  server vào workspace `mcp.json` (server trùng tên của user không
  bao giờ bị ghi đè — xem `mcp/pluginServers.ts`); lỗi từng thành
  phần được thu thập, không throw giữa chừng. `deactivatePluginBundle`
  gỡ đúng ba thứ đó (skill gỡ qua `SkillRegistry.removeSkillsByPlugin`
  mới thêm).
- MCP server của bundle được ghi nhận trong sidecar
  `<pluginsDir>/plugin-mcp-servers.json` (tên → config đã cài);
  lúc gỡ chỉ xóa server nào config còn y hệt lúc cài — server user
  đã sửa sau khi cài được giữ lại.

## 3. Hook khai báo (`packages/core/src/hooks/declarative.ts`)

File `.open-bot/hooks.json` (hoặc `hooks.json` ở gốc workspace),
version 1:

```json
{ "version": 1, "hooks": [
  { "name": "guard-rm", "script": "hooks/guard.mjs",
    "events": ["PreToolUse"], "matcher": ["shell_exec"] },
  { "name": "fmt", "command": "npm run format", "events": ["PostToolUse"] }
]}
```

- `parseHooksConfig` / `loadHooksConfigFile` / `findHooksConfigFiles`
  / `applyHooksConfig` / `loadAndApplyHooksConfig`: parse + validate
  (script phải tồn tại trong thư mục config, command qua đúng
  validator của settings — env chứa tên giống secret bị từ chối),
  đăng ký vào HookRegistry; một entry lỗi không chặn các entry khác;
  entry `enabled: false` được ghi nhận là skipped.
- Helper vòng đời: `createSessionStartContextHook(name, provider)`
  (chèn context khi session bắt đầu; provider throw = không chèn gì)
  và `createStopCleanupHook(name, cleanups, { logger })` (chạy dọn
  dẹp khi agent dừng; cleanup throw vẫn chạy tiếp cleanup sau, luôn
  trả `allow` — Stop hook không chặn được gì).
- Hook lifecycle 10 event + runner + chặn/sửa tool call ở PreToolUse
  đã có từ trước (v0.10/v1.01/v1.04); sóng này chỉ thêm lớp khai báo
  bằng file + 2 helper.

## 4. Xin secret inline trong chat (`packages/core/src/vault/secretRequest.ts`, `secretPrompt.ts`)

Khi tool cần secret chưa có trong Vault, agent hỏi ngay trong
conversation (pattern OpenHands v1.28):

1. `ensureSecret(vault, service, { namespace, key, label, reason, requestedBy })`
   — Vault đã có thì trả ngay, không tạo prompt.
2. Chưa có: tạo `SecretRequest` đang chờ + payload `SecretRequestPrompt`
   (chỉ metadata: label, namespace, key, lý do — KHÔNG BAO GIỜ có giá trị)
   để host render ô nhập mật khẩu inline trong chat.
3. User nhập → host gọi `resolveSecret(id, value)`: validate, ghi Vault
   (durable, hoặc session-only với `saveToVault: false`), waiter tiếp tục.
   User từ chối → `declineSecret`; hết hạn (mặc định 5 phút) → expired.
4. Hai yêu cầu cùng namespace:key được dedupe thành một prompt duy nhất.

An toàn: giá trị secret không bao giờ xuất hiện trong prompt, log,
error message hay tool result. `InlineSecretService` không giữ secret
— sau khi xong nó chỉ giữ metadata (trạng thái + timestamp) để tra cứu.

## 5. Tool agent (`packages/tools/src/skillsPluginsV107Tools.ts`)

8 tool, placeholder trong `ALL_TOOLS`, factory
`createSkillsPluginsV107Tools(opts)` để host bind (nối qua
`createDefaultTools({ getSkillsPluginsV107Opts })`, replace-in-place,
không trùng tên):

| Tool | Việc |
| --- | --- |
| `skill_list_directory` | Tier-1 skill theo thư mục làm việc |
| `skill_show` | Body (tier-2) của một skill theo tên |
| `plugin_bundle_install` | Cài bundle từ thư mục (cần duyệt) |
| `plugin_bundle_list` | Bundle đã cài + thành phần + trạng thái |
| `plugin_bundle_toggle` | Bật/tắt bundle (cần duyệt) |
| `hook_config_apply` | Áp dụng file hooks.json (cần duyệt) |
| `secret_request` | Tạo yêu cầu secret inline, trả payload prompt |
| `secret_request_status` | Trạng thái yêu cầu — chỉ trạng thái, không giá trị |

## 6. i18n

21 key mới × 6 locale (`en`, `vi`, `es`, `fr`, `ja`, `zh`):
`skillsV107.*` (5), `pluginBundle.*` (7), `hooksV107.*` (3),
`secretRequest.*` (6). Placeholder `{...}` giống nhau ở mọi locale
(kiểm tra bởi `tests/i18n.test.mjs`).

## Test

- `tests/skills-scope-v107.test.mjs` (15 test)
- `tests/plugin-bundle-v107.test.mjs` (17 test)
- `tests/hooks-declarative-v107.test.mjs` (10 test)
- `tests/secret-request-v107.test.mjs` (13 test)
- `tests/skills-plugins-v107-tools.test.mjs` (10 test)

Chạy sau khi build core + tools:
`node --test tests/skills-scope-v107.test.mjs tests/plugin-bundle-v107.test.mjs tests/hooks-declarative-v107.test.mjs tests/secret-request-v107.test.mjs tests/skills-plugins-v107-tools.test.mjs`

## Giới hạn còn lại

- Bundle chưa có chữ ký / xác minh nguồn (marketplace signing v0.93
  là cho plugin tool-entry; bundle skill/hook chưa qua signing).
- Hook script chạy out-of-process qua `node`, không phải sandbox OS
  thật (giới hạn đã ghi trong `packages/tools/src/plugins/types.ts`).
- `secret_request` tạo yêu cầu + trả prompt; host (renderer/
  coordinator) phải tự render prompt và gọi `resolveSecret` /
  `declineSecret` — chưa có UI component trong sóng này (việc của T5).
- `skill_show` cắt body ở 8000 ký tự khi trả qua tool.
- Chưa có test live với MCP server thật của bundle (chỉ validate
  config + gộp file mcp.json).
