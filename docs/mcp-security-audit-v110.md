# Audit bảo mật MCP server nội bộ — Sóng v1.10 (15/11/2026)

Người audit: Đội T2 (MCP 2026-07-28+). Phạm vi: các MCP server nội bộ
của open-bot và các tool tương đương 3 reference server trong advisory
MCP 11/11/2026 (`mcp-server-git`, filesystem server, fetch server).
Phương pháp: đọc code + tấn công thật bằng test
(`tests/mcp-security-audit-v110.test.mjs`, 14 test — mọi attack string
đều chạy qua defense thật, test fail nếu attack lọt).

Kết quả tổng: **không tìm thấy lỗ hổng critical/high còn mở** trong
3 họ tấn công của advisory. Tìm thấy **2 lỗ hổng thật (mức low/medium)
và đã vá trong sóng này**, cộng 2 bug nhỏ do test bắt được ở code mới.

## 1. Command injection (họ `mcp-server-git` — High trong advisory)

### Đã kiểm tra

| Bề mặt | Cơ chế phòng thủ | Kết quả |
|---|---|---|
| `git checkout` / `git branch` / `git show` / `git log` / `git blame` / `git diff` / `git commit` (`packages/tools/src/gitTools.ts`, `gitLog.ts`, `gitWorkflowTools.ts`, `tools.ts`, `codeTools.ts`) | Mọi giá trị user đưa vào đều qua `shellQuote` (POSIX: single-quote + `'\''`; Windows PowerShell: escape backtick/`"`/`$`) trước khi nối vào lệnh `runShell` (`/bin/sh -c`); branch/ref còn validate bằng regex + chặn `..`, `@{`, `.lock`, leading `-` | ✅ Chặn. Test chạy thật `echo ${shellQuote("a'; touch …; echo 'b")}`: giá trị in ra nguyên vẹn, file marker không được tạo; `$(...)`, backtick cũng vậy. |
| `validateBranchName` / `validateGitRef` | Regex `^[A-Za-z0-9][A-Za-z0-9._/-]*$` (+ `..`/`@{`/`.lock` check) | ✅ Chặn `;`, `&&`, `|`, `$(...)`, backtick, `\n`, `-f`, `--upload-pack=…`, `..`, `@{1}`. Test 17 chuỗi độc đều bị reject; tên hợp lệ (`feature/x_1.2`, `HEAD~2`, SHA) vẫn qua. |
| `runShell` denylist (`sandbox.ts` → `BLOCKED_COMMAND_PATTERNS` trong `agent/rules.ts`) | Chặn `rm -rf /`, `sudo`, `curl/wget … \| sh/bash`, `chmod 777 /etc/passwd`, `mkfs`, … trước khi spawn; env secret bị strip; cwd giới hạn trong workspace | ✅ Chặn. Test 7 lệnh độc đều throw `blocked by sandbox denylist`. |
| Spawn MCP server stdio (`client.ts`) | `spawn(command, args[])` — KHÔNG dùng shell; args là mảng, không qua shell parse | ✅ Không có injection qua args. `command` chỉ tới từ `mcp.json` do user tự viết (config tin cậy). |
| `harnessV103Tools` / `shellTools` / `tools.ts` shell_exec | Lệnh user gõ trực tiếp (tool shell có chủ đích) — vẫn qua denylist + approval | ⚠️ Theo thiết kế: đây là tool shell, user phải approve. Không phải lỗ hổng, nhưng ghi nhận: model không được tự ý dùng tool này để chạy lệnh ghép từ input ngoài. |

### Kết luận họ này
Không có command injection còn mở. Defense-in-depth đã đủ 3 lớp
(validate → quote → denylist). Không cần vá thêm.

## 2. Path traversal (họ filesystem server — 2 path escape trong advisory)

### Đã kiểm tra

| Bề mặt | Cơ chế phòng thủ | Kết quả |
|---|---|---|
| `resolveWorkspacePath` (`core/src/mcp/server.ts`, dùng cho `resources/read workspace://`) | Lexical containment + realpath phần tồn tại dài nhất rồi nối đuôi, chặn cả symlink escape | ✅ Chặn `../`, `../../etc/passwd`, `a/../../etc/passwd`, đường dẫn tuyệt đối, symlink trong workspace trỏ ra `/etc`. |
| `resolveWithin` (`tools/src/sandbox.ts`) | Cùng pattern realpath | ✅ Chặn cùng các lớp trên. |
| `resources/read` (`server.ts`) | Chỉ đọc resource đã đăng ký theo URI chính xác, hoặc `workspace://` qua `resolveWorkspacePath` sau `decodeURIComponent` | ✅ Chặn `workspace://../`, `workspace://%2e%2e%2f`, `workspace://escape/passwd` (symlink), `file:///etc/passwd`. |
| `blobStore` (`tools/src/blobStore.ts`) | `blobId` phải khớp `BLOB_ID_RE` (`blob-<id>`), không chứa `/` hay `..` | ✅ Chặn `../../etc/passwd`, `blob-…/../../etc/passwd`. |
| `McpFilesStore` mới (`core/src/mcp/files.ts`) | `fileId` chỉ là `file-<16 hex sha256>`; tên file cấm `/\` và `..`; mọi path qua `resolveFilesPath` có realpath | ✅ Chặn (test riêng `tests/mcp-files-v110.test.mjs`). |
| `agentDataTools` / `fileSearchTools` / `ciTools` / `codeTools` / `computerUse` | Đều đi qua `resolveWithin` trước khi `fs.*` | ✅ Không còn đường `fs` trực tiếp với path user. |

### Lưu ý platform (không phải lỗ hổng)
- Trên Linux, `..\secret.txt` là tên file thường (backslash không phải
  separator) nên `resolveWorkspacePath` trả về path trong workspace —
  đúng hành vi POSIX, không thoát được. Trên Windows cùng hàm sẽ
  normalize `\` trước khi check containment.
- `%2e%2e%2f` chưa decode cũng là tên file thường ở tầng
  `resolveWorkspacePath`; decode chỉ xảy ra ở `readResource` (đã test
  chặn ở tầng đó).

### Kết luận họ này
Không có path traversal còn mở.

## 3. Fetch / SSRF (họ fetch server — 2 bypass low trong advisory)

### Đã kiểm tra

| Bề mặt | Cơ chế phòng thủ | Kết quả |
|---|---|---|
| `http_request` / `http_get` (`tools/src/httpTools.ts`, `tools.ts`) | `assertPublicUrl` (SSRF guard, không cần policy): chặn loopback, private LAN, link-local, `::1`; chỉ `http(s)`; redirect được re-check từng hop, tối đa 5 hop | ✅ Chặn `127.0.0.1`, `localhost`, `10/8`, `192.168/16`, `172.16/12`, `169.254.169.254` (cloud metadata), `[::1]` — `fetch` không được gọi lần nào. Redirect `example.com → 169.254.169.254` bị chặn ở hop 2 (fetch chỉ gọi 1 lần). `file://`, `gopher://`, `ftp://` bị reject. |
| `runShell` egress (`sandbox.ts` + `core/src/egress/policy.ts`) | Lệnh chứa đích mạng phải qua `checkEgress` trước khi spawn; chưa cấu hình policy thì fail-closed `egress_unconfigured`; `isPrivateIp` chặn cả IPv4-mapped IPv6 | ✅ Đã có. Không test lại ở đây (đã có test egress riêng). |

### Kết luận họ này
Không có SSRF bypass còn mở.

## 4. Lỗ hổng thật tìm thấy + đã vá trong sóng này

### [M-1] `ensureMcpServer` ghi config chưa validate → poison `mcp.json` (Medium)
- **Vị trí:** `packages/core/src/mcp/config.ts:ensureMcpServer`.
- **Vấn đề:** config tới từ runtime (plugin bundle manifest, part
  definition) được ghi thẳng vào `.open-bot/mcp.json` mà không qua
  `validateServer` — hàm `validateMcpServerConfig` đã tồn tại với đúng
  mục đích này ("reused by plugin-bundle manifests so a bundle cannot
  smuggle in a server that mcp.json itself would reject") nhưng đường
  merge thực tế không gọi nó. Một bundle lỗi/độc khai `args` không phải
  mảng, `url: "ftp://…"`, hoặc thiếu cả `command` lẫn `url` sẽ làm mọi
  lần `loadMcpConfig` sau đó throw → toàn bộ MCP config tê liệt (DoS
  toàn cục, không chỉ server đó).
- **Vá:** `ensureMcpServer` validate + chuẩn hoá config bằng
  `validateServer` trước khi ghi; `mergePluginMcpServers` validate sớm
  bằng `validateMcpServerConfig` (fail fast, ghi sidecar bằng config
  đã chuẩn hoá). Caller `coordinator.ts` đã bọc try/catch nên config
  lỗi chỉ log warning, không crash tạo bot.
- **Test:** `mcp-security-audit-v110`: 8 shape hỏng đều bị reject, file
  không bị poison (server hợp lệ vẫn ghi + load được sau đó); merge
  plugin hỏng fail fast, không ghi `mcp.json`.

### [M-2] `taskStore.update` nhận input không validate theo schema (Low)
- **Vị trí:** `packages/core/src/mcp/taskStore.ts:update`.
- **Vấn đề:** task park ở `input_required` có khai `inputRequest.schema`
  lúc `requestInput`, nhưng `tasks/update` nhận mọi input — client gửi
  sai kiểu / thiếu trường bắt buộc vẫn resume runner, lỗi chỉ vỡ ở bước
  sau (khó trace về input sai).
- **Vá:** `update()` validate input bằng `validateInputAgainstSchema`
  (dùng chung validator của `inputRequired.ts`); sai thì throw
  `TaskStoreError` kèm từng issue, task giữ nguyên `input_required`
  để client sửa lại rồi gửi tiếp.
- **Test:** `mcp-security-audit-v110` + `mcp-tasks-input-v110`
  (schema `{city: string, required}`: `{city: 42}` và `{}` bị reject,
  task vẫn park; `{city: 'Hanoi'}` resume và hoàn thành).

## 5. Bug nhỏ do test bắt được ở code mới (đã sửa)

- **`downloadBytes` chỉ trả 1 chunk** (`files.ts`): `downloadChunk`
  clamp mỗi lần đọc về `maxChunkBytes` nên `downloadBytes` với store
  cấu hình chunk nhỏ chỉ trả chunk đầu. Sửa: page theo chunk rồi ghép.
- **`uploadBytes` nhận base64 hỏng** (`files.ts`): `Buffer.from`
  lenient (bỏ ký tự rác lặng lẽ) + `uploadBytes` re-encode trước khi
  gọi `writeChunk` nên check round-trip trong `writeChunk` không thấy
  input gốc. Sửa: thêm `isValidBase64` strict, check ở `uploadBytes`
  trước khi decode và dùng chung ở `writeChunk`.

## 6. Phạm vi chưa audit / giới hạn còn lại

- **OAuth / token trong `mcp.json`:** loader không log secret, nhưng
  file `.open-bot/mcp.json` chứa static `Authorization` header do user
  tự gõ — trách nhiệm bảo mật file thuộc về user (đã ghi trong header
  `config.ts`). Không đổi trong sóng này.
- **Plugin bundle manifest là dữ liệu tin cậy một nửa:** bundle chỉ
  được cài khi user chủ động cài; sau vá M-1, bundle không còn ghi
  được config hỏng, nhưng bundle vẫn khai được `command` tuỳ ý (vd
  `rm`) — đó là quyền của code user tự cài, tương đương `command`
  trong `mcp.json` user viết tay. Chặn sâu hơn (allowlist command)
  sẽ phá config hiện có nên không làm trong sóng này; ghi nhận cho
  coordinator cân nhắc.
- **Windows PowerShell quoting:** `shellQuote` Windows chỉ được review
  bằng đọc code (escape backtick/`"`/`$`), chưa chạy thật trên
  Windows (VM này là Linux). CI Windows sẽ chạy test audit — test
  `shellQuote` chạy thật chỉ cover POSIX.
- **DNS rebinding / TOCTOU trong SSRF guard:** `assertPublicUrl` resolve
  DNS lúc check; một host đổi IP giữa lúc check và lúc fetch (rebinding)
  vẫn là rủi ro lý thuyết còn lại của mọi guard dạng này — ngoài phạm vi
  sóng này.
- **Server nội bộ không expose tool file/git mặc định:** tool của
  `McpServer` do host đăng ký; audit này cover dispatcher + resource
  + các tool file/git/fetch của `@open-bot/tools`. Tool do plugin bên
  thứ ba đăng ký vào server không thuộc phạm vi audit này.

## 7. Test tấn công (regression — chạy lại mỗi lần sửa defense)

`node --test tests/mcp-security-audit-v110.test.mjs` — 14 test, pass 14/14:
traversal (`../`, absolute, symlink, `workspace://`, blob_id), command
injection (17 chuỗi branch/ref, `shellQuote` chạy thật, denylist),
SSRF (7 URL private/metadata, redirect, scheme), config poisoning
(8 shape hỏng + merge plugin hỏng), `tasks/update` schema.
