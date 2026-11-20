# Build, testing and production verification

Cập nhật: 20/11/2026. Yêu cầu runtime/build: Node.js 24+ và npm.

## Quy tắc báo cáo trạng thái

- Một kết quả test chỉ có giá trị khi ghi kèm **commit SHA, lệnh chính xác, môi trường/OS, thời điểm và summary do runner trả về**.
- Không lấy test count trong log cũ hoặc từ một checkout khác làm bằng chứng cho commit hiện tại.
- Không ghi “CI xanh” nếu chưa kiểm tra GitHub Actions của đúng SHA. Workflow CI hiện định nghĩa build, typecheck và test trên Ubuntu, Windows, macOS; trạng thái phải đọc ở trang Actions của commit/PR cụ thể.
- PR release-gate này được tạo bằng GitHub web UI; tác giả không có checkout thực thi, nên **không chạy build, typecheck, unit test, full suite, signing hay notarization**.
- Tại lúc cập nhật tài liệu, maintainer báo local main `dfd90beb` khác public GitHub main `9ecb82ed24aface43b4287ae8ffd81c484ea85ea`. PR #7/#8/#9 còn local-only và chưa được đưa vào base của release-gate. Coordinator đang xử lý nhóm 13 regression test fail riêng; release-gate không sửa các test đó và không tuyên bố full suite đã xanh. Chỉ land release-gate sau khi coordinator xác nhận full suite xanh trên source snapshot dự định phát hành và Muse hoàn thành kiểm chứng độc lập.

## Cài đặt, build và typecheck

Tại repository root:

```bash
npm run version:sync
npm ci
npm run build
npm run typecheck
```

`package.json` ở root là nguồn version chuẩn. `version:sync` đồng bộ version sang các workspace manifests và `package-lock.json`; `version:check` xác minh metadata không bị lệch:

```bash
npm run version:check
```

Root build/typecheck/dev/dist và desktop workspace build/dist đều gọi script đồng bộ trước khi chạy. CLI đọc version từ root manifest trong monorepo; Electron lấy `app.getVersion()` từ desktop package đã được đồng bộ trước build/package.

## Chạy test

Trên Linux, nhóm test dùng display cần chạy dưới Xvfb:

```bash
xvfb-run -a npm test
```

Trên Windows/macOS:

```bash
npm test
```

Với thay đổi updater ở release-gate (sau khi build các workspace):

```bash
node --test tests/auth-update-v07.test.mjs tests/update-tracks-v054.test.mjs tests/update-feed-tracks-v059.test.mjs
```

Nếu một test cần API key, service ngoài, display hoặc binary hệ thống, hãy ghi rõ điều kiện đó và trạng thái skip. Skip không được tính là xác minh tích hợp thật. Khi báo cáo kết quả, đính kèm summary nguyên bản của `node --test` và không suy diễn test count.

## CI

Workflow `.github/workflows/ci.yml` khai báo:

- Build + typecheck + full test trên `ubuntu-latest`, `windows-latest`, `macos-latest`.
- Linux full test chạy bằng `xvfb-run -a npm test`.
- Một job platform chạy `tests/platform.test.mjs` sau build trên cả ba OS.

Cấu hình workflow không chứng minh một run cụ thể đã pass. Kiểm tra đúng commit SHA trên GitHub Actions trước khi gọi release gate là xanh. Không có CI status hoặc full-suite count mới nào được ghi trong tài liệu này.

## Release readiness

Release packaging, version tagging, signing, notarization và draft GitHub Releases được mô tả tại [docs/RELEASING.md](RELEASING.md). Lưu ý:

- Updater hiện check GitHub Releases theo track và mở trang release để tải thủ công; nó **không tự tải/cài**.
- Không có release artifact nào được publish tại lần kiểm tra khi soạn release-gate.
- macOS release đòi Developer ID signing + notarization; Windows release đòi Authenticode signing. Linux AppImage hiện không được GPG-sign bởi cấu hình release.
- Không chạy hoặc mô tả một release là signed/notarized cho tới khi artifact thật đã được tạo trên host phù hợp và xác minh trên OS đích.

## Known gaps / môi trường chưa xác minh

- Self-install/update verification end-to-end chưa được implement; xem `docs/unbuildable-gaps-v086.md` và `docs/update-tracks.md`.
- Computer-use ngoài Linux + X11 chưa được xác minh trong môi trường tương ứng; xem `docs/unbuildable-gaps-v086.md`.
- Build target macOS/Windows không thay thế test runtime thật trên Mac/Windows.
- Provider live tests yêu cầu key/service thật; không có key thì test có thể skip. Không ghi live-provider pass dựa trên mock.
- Signing/notarization requires external certificate and secrets; PR source changes do not constitute a signed release.

---

## Lịch sử kiểm thử cũ (chỉ tham khảo, không phải bằng chứng release hiện tại)

Các ghi chép bên dưới được giữ lại để bảo toàn bối cảnh lịch sử của repository. Mọi kết quả, test count và kết luận bên dưới thuộc checkout/ngày chạy được ghi trong từng mục; **không được dùng để khẳng định trạng thái của HEAD hiện tại hoặc CI hiện tại**.

## Smoke test agent core (mock provider + tool thật)

Script kiểm tra (tạm, lưu ở `/tmp/open-bot-smoke/mock-test.cjs`, không commit):
mock server HTTP local giả lập OpenAI `/chat/completions`.

- Vòng 1: mock trả tool call `write_file` (`hello.txt`, nội dung
  `xin chao open-bot`).
- Vòng 2: mock kiểm tra request chứa assistant message có `tool_calls` +
  message `role: tool` với `tool_call_id` khớp, rồi trả tool call `read_file`.
- Vòng 3: mock kiểm tra lại pairing, trả text cuối.
- Kết quả: **PASS** — 3 vòng, file `hello.txt` được ghi thật bằng
  `createDefaultTools()` (autoApprove true trong test) và đọc lại đúng nội
  dung, câu trả lời cuối chứa `xin chao open-bot`.

## Kiểm tra provider Anthropic + Gemini (mock server)

Script `/tmp/open-bot-smoke/provider-test.cjs`:

- Anthropic: vòng 2 gửi đúng `tool_use` (id `toolu_1`) trước `tool_result`
  với `tool_use_id` khớp và nội dung kết quả — **PASS**.
- Gemini: vòng 2 gửi đúng `functionCall` + `functionResponse` với `name`
  `read_file` và `response.result` là nội dung file — **PASS**.

## Kiểm tra BotMemory (API thật mà desktop dùng)

Script `/tmp/open-bot-smoke/websearch-test.cjs`: `saveBot`/`getBot`,
`saveMessage`/`getHistory`, `setMemory`/`getMemory`,
`createTask`/`updateTask`/`listTasks` trên DB SQLite tạm — **PASS**.

## Kiểm tra web_search (DuckDuckGo + fallback Bing)

Cùng script trên, query `open source desktop AI agent`:

- DuckDuckGo không trả kết quả dùng được trong lần chạy này → fallback Bing
  chạy và trả **8 kết quả** — **PASS** (fallback đã được chứng minh chạy).

## Smoke test desktop (Electron thật)

- `npm run build` trong `apps/desktop`: **PASS** (`dist/main/main.js`,
  `dist/main/preload.js`, `dist/renderer/index.html` đều có).
- Khởi động thật: `timeout 20 xvfb-run -a npx electron . --no-sandbox`
  (cần `--no-sandbox` vì đang chạy dưới user root; `xvfb-run` đã có sẵn
  trên máy, không cần cài thêm). App **chạy suốt 20s** tới khi bị timeout
  kill (exit 124 = bị kill, không phải crash), không có lỗi JS
  (không `Uncaught`, `TypeError`, `Cannot find module` trong log).
  Bằng chứng main process chạy thật: file `settings.json` được tạo ở
  `~/.config/@open-bot/desktop/` với bot mặc định `Trợ lý` (xai, grok-4.7)
  và Local Storage/Cache của renderer được tạo.
- Log chỉ có nhiễu môi trường VM: lỗi kết nối D-Bus (không có system bus),
  lỗi khởi tạo GPU, và `FATAL: Failed to shutdown` lúc bị SIGTERM kill —
  không phải lỗi của app.

## Kiểm tra v0.2 (2026-11-08)

| Lệnh | Kết quả |
| --- | --- |
| `npm run build` (root: core → tools → desktop) | PASS — exit 0 |
| `npm run typecheck` (root) | PASS — 0 lỗi |
| `npm test` (root, `node --test`) | PASS — **111/111 test, 0 fail** (i18n 12, MCP 12, planning 5, subagent 8, tools-code 14, integration 6, agent-marketplace 9, plugins 10, mcp-marketplace-team 14, coordinator 11, daemon 10) — cập nhật 2026-11-08, v0.3 wave 2 hoàn tất |
| Electron-coordinator e2e (`/tmp/open-bot-smoke/electron-coordinator-test.cjs`, chạy bằng binary Electron dưới xvfb) | PASS — coordinator spawn từ trong Electron (env `ELECTRON_RUN_AS_NODE=1`), ping/pong, 48 tool, approval round-trip, file ghi đúng, history lưu đúng |
| Ollama e2e qua coordinator (`/tmp/open-bot-smoke/ollama-coordinator-e2e.mjs`, model local thật qwen2.5:0.5b) | PASS — chat tiếng Việt đúng, tool task ghi đúng `hello-ollama.txt` với nội dung `xin chao ollama`, history lưu đúng |
| Electron-daemon e2e (`/tmp/open-bot-smoke/electron-daemon-test.cjs`, chạy bằng binary Electron dưới xvfb) | PASS — daemon cháu của Electron (lazy, `running:false` trước khi dùng shell), shell_exec qua daemon ra đúng `hello-electron-daemon` + `exit code: 0`, `daemonStatus` báo `running:true` + pid |
| Ollama shell e2e qua coordinator + daemon (`/tmp/open-bot-smoke/ollama-shell-e2e.mjs`, model local thật qwen2.5:0.5b) | PASS — model gọi đúng `shell_exec` (`echo xin chao`), kết quả về đúng qua daemon, model trả lời tiếng Việt đúng, `daemonStatus` running |
| Mock smoke test v0.1 (`/tmp/open-bot-smoke/mock-test.cjs`, `provider-test.cjs`) | PASS — không regression sau thay đổi loop v0.2 |
| Desktop xvfb 25s (`electron --no-sandbox`) | PASS — chạy suốt 25s tới khi bị timeout kill (exit 124), không lỗi JS |

### End-to-end với model local thật (Ollama, lần đầu có provider thật)

- Cài Ollama 0.40.15 (`/usr/local/bin/ollama`, cần `zstd` để giải nén
  installer); `ollama pull` bị lỗi TLS qua egress proxy của VM nên đã
  tải GGUF trực tiếp từ Hugging Face (`Qwen2.5-0.5B-Instruct-GGUF`,
  q4_k_m, 468 MB) rồi `ollama create qwen2.5:0.5b` từ Modelfile.
- **Phát hiện thật:** lần chạy đầu lỗi HTTP 400 — 48 tool definitions
  chiếm 5.562 token, vượt context mặc định 4.096 token của Ollama.
  Đã sửa bằng `PARAMETER num_ctx 16384` trong Modelfile rồi tạo lại
  model; sau đó chạy lại thì PASS hết (xem dưới). Bài học đã ghi vào
  ARCHITECTURE.md: model context nhỏ + nhiều tool = lỗi 400.
- Script: `/tmp/open-bot-smoke/ollama-e2e.mjs` — **PASS**:
  `listModels()` trả `["qwen2.5:0.5b"]`; 48 tool được nối vào runner;
  chat thường trả lời đúng tiếng Việt ("Tôi là trợ lý AI được tạo ra
  để giúp bạn."); nhiệm vụ tool ("Tạo file hello-ollama.txt với nội
  dung 'xin chao ollama'") khiến model gọi đúng `write_file`, file được
  tạo thật với đúng nội dung, câu trả lời cuối đúng.

## Chưa kiểm chứng

- Provider cloud thật (OpenAI/Anthropic/Gemini/xAI): chưa có API key thật
  — cần Huy đưa key. Code provider đã được kiểm tra bằng mock server ở trên.
- Chat end-to-end trong UI thật (gõ tin nhắn, phê duyệt tool call, hộp
  hỏi người dùng): chưa làm — cần key thật + thao tác tay trong app.
- Chạy trên Windows/macOS: chưa test, chỉ test trên Linux VM này.

## Test flaky đã biết (v0.51)

- `tests/detected-cli-m3.test.mjs` — test `M3 opencode: abort giữa turn
  kill sạch process group (pid chết thật)`: fail 1 lần khi chạy full
  suite ở v0.50, chạy lẻ pass 3/3. Nguyên nhân: dưới tải full suite
  (nhiều file test chạy song song trên CPU chia sẻ) SIGTERM tới process
  group + thu hồi process con có thể chậm hơn 5s bình thường. Đã sửa
  v0.51: cửa sổ chờ `waitUntil(() => !isAlive(pid))` tăng 5s → 15s;
  vẫn còn sống thì ép `SIGKILL` vào cả group (chỉ POSIX) rồi đợi thêm
  5s trước khi kết luận fail. Lưu ý `isAlive()` dùng `kill(pid, 0)` nên
  process zombie chưa thu hồi vẫn tính là sống — chờ dài là để thu hồi
  kịp, không phải chỉ để kill kịp. Chứng minh: chạy file test 3 lần
  liên tiếp đều pass (xem `docs/BEYOND-ROADMAP.md` mục v0.51).

- `tests/detected-cli-m2.test.mjs` — cùng họ flake với M3: 2 test abort
  (`M2 codex` / `M2 grok: abort giữa turn kill sạch process group`) fail
  khi chạy full suite ở cuối sóng v0.51–v0.58, chạy lẻ 35/35 pass.
  Nguyên nhân giống hệt: `waitUntil` mặc định chỉ 3s, dưới tải full suite
  process cha thu hồi con chậm hơn 3s nên zombie vẫn tính là sống. Đã sửa
  (cuối sóng v0.51–v0.58): mặc định `waitUntil` trong file này tăng 3s →
  15s, và thêm helper `waitForDeath(pid)` theo đúng mẫu M3 (chờ 15s, còn
  sống thì ép `SIGKILL` vào cả process group rồi đợi thêm 5s) cho cả 6
  điểm kiểm tra "process phải chết" (abort / timeout / dispose, codex +
  grok). Lần chạy full suite đầu sau sửa này vẫn fail 1 test
  (`M2 codex` abort, hết cả 15s chờ) — chính vì vậy mới cần bước ép
  SIGKILL của `waitForDeath`, chứ chỉ tăng cửa sổ chờ là chưa đủ.

- Composio: 1 fail khi chạy chung 3 file test composio bằng một lệnh ở
  báo cáo v0.59 (mục 5), chạy riêng từng file đều xanh — KHÔNG TÁI HIỆN
  ĐƯỢC (điều tra sau v0.59, 2026-11-10). Cách tái hiện đã thử (sau khi
  `npm run build --workspace=@open-bot/core`):
  `node --test tests/composio-v057.test.mjs tests/composio-v058.test.mjs
  tests/composio-seed-v059.test.mjs` — 10 lần, lần nào cũng **31/31 pass**
  (kể cả 1 lần chạy cùng lúc với 1 CPU burner 60s: vẫn 31/31, chỉ chậm
  hơn 8,4s → 14,2s); cả 5 file composio cùng lệnh → **46/46 pass**;
  các trio khác cũng xanh (v057+v058+ipc-v057 → 30/30,
  v057+v058+live-harness-v059 → 29/29, v058+seed-v059+ipc-v057 → 29/29).
  Đã kiểm tra và LOẠI TRỪ các nguyên nhân liên file thường gặp: mock
  server nào cũng `listen(0, '127.0.0.1')` (port tạm, không cố định);
  thư mục tạm qua `mkdtempSync` (duy nhất mỗi test); `node --test` chạy
  mỗi file trong process riêng (singleton key/seed trong
  `packages/core/src/composio` không chia sẻ qua file); không có
  `setTimeout`/`waitUntil`/polling trong 3 file; timeout RPC NDJSON mặc
  định 10 phút (`DEFAULT_REQUEST_TIMEOUT_MS`, client.ts); không file nào
  chạm Ollama hay đường dẫn cố định. Giả thuyết còn lại (chưa chứng
  minh được vì báo cáo v0.59 không ghi tên test fail): nhiễu timing nhất
  thời dưới tải full suite — cùng họ với flake M2/M3 ở trên (spawn
  coordinator con + mock server chậm hơn bình thường khi CPU chia sẻ bị
  chiếm) — hoặc một worker khác rebuild `packages/core/dist` giữa lúc
  trio đang chạy (test import từ `dist`). Không có gì để sửa tận gốc
  khi chưa tái hiện được, nên KHÔNG đổi code test. Nếu fail tái xuất:
  ghi lại TÊN test + message lỗi, chạy lại trio 3 lần rồi chạy riêng
  file đó, và kiểm tra xem lúc đó có ai đang build/rebuild `dist` không.
