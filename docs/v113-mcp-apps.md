# MCP Apps host v13

Host MCP Apps đầy đủ theo SEP-1865 (chỉ học ý tưởng, không copy
code/text/tài sản của bất kỳ repo nào). Xây trên nền Apps v0.97–v1.12
(validate HTML, CSP, sandbox, bridge `app-*`, AppManager, live data,
catalog) và thêm phần còn thiếu: khai báo UI của tool, registry
`ui://`, dialect JSON-RPC `ui/`, 3 display mode, component kit.

## 1. Tool khai báo UI — `_meta.ui`

```json
{ "name": "show-dashboard",
  "_meta": { "ui": {
    "resourceUri": "ui://my-server/dashboard",
    "displayMode": "inline",
    "preferredWidth": 720, "preferredHeight": 480,
    "capabilities": ["tools-call", "open-link"],
    "title": "Dashboard" } } }
```

- `parseToolUiMeta(tool)` (`packages/core/src/mcp/appsUiMeta.ts`):
  trả `ToolUiDeclaration` hoặc `null` (tool không có app); ném
  `UiMetaError` khi khai báo sai (URI sai, mode lạ, capability lạ,
  kích thước sai) — lỗi khai báo phải lộ ra để server sửa.
- MIME của app: `text/html;profile=mcp-app` (SEP-1865). Host nhận cả
  dạng profile và `text/html` thuần (`isMcpAppMimeType`,
  `parseUiMimeType`). Resource URI luôn `ui://<server>/<path...>`
  (không query/fragment/`..`/khoảng trắng).

## 2. Registry `ui://` — `appsUiRegistry.ts`

`McpAppUiRegistry`: bảng tra cứu resource theo URI trong bộ nhớ
(không persist — HTML là nội dung không tin cậy từ server).

- `register()` validate URI + MIME + HTML (`validateAppHtml`) trước;
  lỗi không ghi đè entry cũ. Đăng ký lại cùng URI = cập nhật
  (`version` tăng).
- `resolve(uri)` (tăng `hits`, kiểm tra TTL), `resolveForTool(server,
  tool, declaration)` (ưu tiên entry đúng tool), `list()` (snapshot
  không kèm HTML), `unregisterServer()`, `pruneExpired()`.
- Giới hạn mặc định: 200 entry / 32 MB — vượt thì đuổi entry ít dùng
  nhất (LRU theo `lastUsedAtMs` + `hits`).

## 3. Dialect JSON-RPC `ui/` — `appsUiDialect.ts`

App ↔ host qua postMessage, JSON-RPC 2.0. App → host:

| Method | Ý nghĩa |
|---|---|
| `ui/initialize` | Bắt tay: app gửi `clientInfo`, host trả `hostContext` (theme, locale, timezone, platform, display mode, kích thước container) + `protocolVersion: ui/1.0` + capabilities. Method khác trước initialize bị từ chối (-32002). |
| `ui/update-model-context` | App báo model context mới (`taskStatus`/`progress`/`data`); host lưu + callback. `progress` phải 0..100. |
| `ui/message` | App gửi message (`info`/`warn`/`error`) về host. |
| `ui/open-link` | App xin mở link http(s); host quyết định (mặc định chặn, -32003). |
| `tools/call` | Đường duy nhất app gọi tool: host kiểm tra allowlist của session, thực thi qua callback, trả kết quả dạng MCP content. Timeout mặc định 30s. |
| `ui/close` | App xin đóng (host extension). |
| `ui/set-display-mode` | App xin đổi display mode (host extension). |

Host → app (notification, không `id`): `ui/model-context-updated`,
`ui/message`, `ui/display-mode-changed`.

Lỗi JSON-RPC chuẩn: -32700 parse, -32600 invalid request, -32601
method not found, -32602 invalid params, -32002 chưa khởi tạo,
-32003 bị cấm, -32603 lỗi nội bộ. Hỗ trợ cả batch (array).
`UiDialectHost` thuần — renderer chỉ postMessage object host build
ra. Bridge legacy `app-*` (v1.09) vẫn chạy song song cho app cũ;
renderer phân biệt bằng `jsonrpc === '2.0'`.

## 4. Display mode — `appsDisplayModes.ts`

- `inline`: trong luồng chat (mặc định). `fullscreen`: chiếm toàn bộ
  vùng làm việc — chỉ **một** app fullscreen tại một thời điểm (app cũ
  tự về mode trước đó). `pip`: cửa sổ nổi (monitoring/timer/media),
  kéo/thu phóng được, clamp vào viewport (240×160 … 960×720), nhiều
  app pip tự dời góc để không chồng nhau (cascade 32px).
- `AppDisplayModeManager`: `register/setMode/exitOverlay/cycleMode/
  movePip/resizePip/anchorPip/setPinned/setInlineHeight`,
  `serialize/restore` (khôi phục sau restart renderer).

## 5. Component kit — `appsComponents.ts`

Server trả component khai báo thay vì HTML tay; host render HTML an
toàn (mọi text escape, không JS tuỳ ý từ server):

`card`, `table` (≤50 hàng/20 cột), `metric`, `form` (text/number/
select/checkbox/textarea/date — submit gọi tool qua `tools/call`,
không có form action), `list` (≤200 item), `chart-placeholder`
(SVG tĩnh bar/line, không cần thư viện), `stack`/`grid` (lồng ≤3
tầng), `html` (escape hatch — vẫn qua `validateAppHtml`).

- `renderAppComponents(list, {title, theme})` → tài liệu HTML đầy
  đủ (CSS kit + client shim), đã kiểm tra qua `validateAppHtml`.
- `buildAppClientShim()`: `window.__openbot` — `initialize`,
  `callTool`, `openLink`, `sendMessage`, `updateModelContext`,
  `close`, `setDisplayMode`, `onModelContext`, `onMessage`. Shim tự
  nó qua `validateAppHtml` (chỉ `parent.postMessage(msg,
  window.location.origin)`, không `window.parent`, không `'*'`,
  không fetch/storage/eval). Form và nút action trong kit tự bind
  vào shim (submit → `tools/call`, hiện kết quả ngay dưới form).

## 6. Host orchestrator — `appsHostV13.ts`

`McpAppHostV13` nối registry + dialect + display + AppManager +
bridge legacy + Tasks:

- `openAppFromTool(tool, result)`: tìm HTML theo thứ tự — resource
  khớp `_meta.ui.resourceUri` trong kết quả → registry `ui://` →
  `parseAppResult` chung (3 wire shape v0.98). Validate → đăng ký
  registry → mở AppManager → đăng ký display mode → tạo session
  dialect (+ bridge legacy nếu `useLegacyBridge`) → trả frame config
  (sandbox `allow-scripts` + CSP deny + srcdoc).
- `openAppFromRegistry(uri)`, `openAppFromComponents(components)`,
  `openSampleApp(kind)` — 4 sample: `dashboard` (metrics + chart +
  list), `form` (feedback → tool), `monitor` (mặc định pip),
  `table` (server mẫu).
- `updateModelContext(appId, ctx)` → notification
  `ui/model-context-updated` cho renderer postMessage.
- `linkTask(appId, taskId)` + `pushTaskProgress(...)`: tiến độ MCP
  Task chảy vào model context của app (app pip/monitor hiện tiến độ
  task dài không cần poll).

## 7. Renderer — `McpAppHostV13.tsx`

Sandboxed iframe (`sandbox="allow-scripts"`, CSP deny nhúng vào
srcdoc) + xử lý cả dialect `ui/` lẫn bridge legacy `app-*`. Nút đổi
mode inline/fullscreen/pip, thoát overlay, kéo cửa sổ pip bằng
header, log bridge + đếm message bị chặn, hiện model context keys.
i18n: `mcpAppsV13.*` (16 key × 6 locale: vi, en, zh, ja, fr, es —
repo không có locale `ko`, 6 locale thực tế là vi/en/zh/ja/fr/es).

## 8. Tools cho agent — `packages/tools/src/mcpAppsV113Tools.ts`

7 tool, export `MCP_APPS_V113_TOOLS` / `createMcpAppsV113Tools(host)`
(coordinator nối vào ALL_TOOLS sau; module này không sửa registry
trung tâm):

`mcp_apps_ui_register`, `mcp_apps_ui_list`, `mcp_apps_ui_open`,
`mcp_apps_ui_set_display_mode`, `mcp_apps_ui_model_context`,
`mcp_apps_components_render`, `mcp_apps_ui_sample`.
Mở app / đổi mode / mở sample cần approval (thay đổi UI nhìn thấy);
đọc registry và render component thì không. Tất cả chạy local.

## 9. Test

- `tests/mcp-apps-v113-ui-meta-registry.test.mjs` — `_meta.ui` + registry.
- `tests/mcp-apps-v113-dialect-display.test.mjs` — dialect `ui/` + display modes.
- `tests/mcp-apps-v113-components-host.test.mjs` — component kit + host + tools.

Chạy sau khi build core + tools:

```sh
npm run build --workspace=@open-bot/core
npm run build --workspace=@open-bot/tools
node --test tests/mcp-apps-v113-ui-meta-registry.test.mjs tests/mcp-apps-v113-dialect-display.test.mjs tests/mcp-apps-v113-components-host.test.mjs
```

## 10. Chưa xong / giới hạn

- `McpAppHostV13.tsx` chưa nối vào `App.tsx`/view (coordinator nối
  sau; component tự đứng được, nhận HTML + callback).
- Tool `mcp_apps_ui_*` chưa nối vào ALL_TOOLS (theo quy tắc sóng:
  coordinator nối sau).
- Dialect `ui/` chạy qua postMessage của iframe srcdoc; app từ server
  thật (resources/read qua MCP client) cần coordinator nối transport
  — host đã có `registerFromDeclaration`/`openAppFromTool` để nhận.
- i18n: repo có 6 locale vi/en/zh/ja/**fr**/es (không có `ko` như
  brief ghi) — đã thêm đủ 16 key vào cả 6 locale hiện có.
