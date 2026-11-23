# Build, testing and production verification

Cập nhật: 23/11/2026, 20:00 +07. Yêu cầu runtime/build: Node.js 24+ và npm.

## Snapshot production được maintainer xác nhận

- Local `main` được maintainer xác nhận tại `1fb2cded` (23/11/2026 ~20:00 +07).
- Full suite trên đúng local SHA đó: **12,804 passed / 0 failed / 19 skipped** (12,823 test cases được runner báo cáo). Điều kiện bắt buộc để land: **0 test fail** trên đúng head SHA được kiểm chứng. Báo cáo skip riêng, xem xét lý do và không tính skip là pass.
- Public GitHub `main` tại thời điểm này vẫn là `f17b8675ed5a5415894ca47ad42096e240489fa5`; snapshot local mới hơn đang chờ phê duyệt push. Kết quả trên là báo cáo từ maintainer local, **không phải** test do tác giả tài liệu chạy hoặc CI xác nhận trên remote `main`.
- Khi kiểm chứng/land, luôn lấy SHA thực tế từ PR head và xác nhận đúng base. Không tái sử dụng test count từ một SHA khác hoặc suy ra remote đã có các commit local chưa push.

## Single source of truth — app version

- Trường `version` trong root `package.json` là **nguồn version sản phẩm duy nhất** và là nơi duy nhất được sửa khi đổi release version.
- Version trong `apps/*/package.json`, `packages/*/package.json` và các workspace entries của `package-lock.json` là generated/synchronized npm metadata mirrors, không phải nguồn version độc lập.
- Chạy `npm run version:sync` để đồng bộ metadata; `npm run version:check` phải pass trước khi release/tag.
- PR #30 chuẩn hóa runtime consumers qua các generated `APP_VERSION` modules lấy từ root version. PR #30 đang chờ Muse xác minh độc lập; sau khi land, không tạo thêm literal product-version ở runtime và không sửa generated module thủ công.

```bash
npm run version:sync
npm run version:check
```

## Hardening scope được theo dõi

Các lát cắt production-hardening đã/đang được xử lý gồm:

1. IPC sender validation — xác thực sender tại ranh giới IPC.
2. Egress/SSRF — giới hạn network egress và nhận diện đích bare `curl`/`wget`.
3. Vault fallback — hiển thị/trạng thái lưu trữ fallback dành riêng cho webhook key; PR #29 đang chờ Muse xác minh.
4. MCP config-file permissions — siết quyền file cấu hình; PR #27 đã được Muse xác minh land-ready và maintainer đang land.
5. Router local-model child environment — lọc child env; PR #28 đã được Muse xác minh land-ready và maintainer đang land.
6. Webhook approval-payload minimisation — chỉ phát các trường allowlist cần thiết ra webhook.
7. Skills prompt-injection blocking — quét nội dung/metadata trước khi skill đi vào prompt.
8. Plugin security disclosure — nêu rõ process riêng không phải OS sandbox và plugin vẫn có quyền của OS user hiện tại.

PR #26 (bare curl/wget egress targets) đã được maintainer báo landed trên local main. PR #27/#28 đang được land; PR #29 và PR #30 chưa được xem là landed/verified cho tới khi Muse xác minh đúng head SHA. Tình trạng remote cần kiểm tra lại trên GitHub, vì local main và public GitHub main có thể lệch nhau.

## Cài đặt dependencies, build và typecheck

Yêu cầu: Node.js 24+ (khớp CI và `packages/core/package.json` engines) cùng npm. Tại repository root:

```bash
npm ci
npm run version:sync
npm run version:check
npm run build
npm run typecheck
```

Root scripts trong `package.json` thực hiện build/typecheck theo thứ tự core → tools → desktop → CLI. Lệnh tương đương từng workspace:

```bash
npm run build --workspace=@open-bot/core
npm run build --workspace=@open-bot/tools
npm run build --workspace=@open-bot/desktop
npm run build --workspace=@open-bot/cli

npm run typecheck --workspace=@open-bot/core
npm run typecheck --workspace=@open-bot/tools
npm run typecheck --workspace=@open-bot/desktop
npm run typecheck --workspace=@open-bot/cli
```

Root `prebuild` và `pretypecheck` tự gọi `version:sync`; chạy lệnh sync/check tường minh giúp chứng minh manifest/lockfile đồng bộ và tránh dựa vào lifecycle hook một cách ngầm định. Desktop workspace cũng có prebuild/predist sync.

## Full-suite test gate

Root `npm test` gọi `node --test` cho toàn bộ test suite. Dùng đúng lệnh theo OS:

```bash
# Linux — cần virtual display cho nhóm computer-use/X11 tests
xvfb-run -a npm test

# Windows / macOS
npm test
```

**Không land nếu full suite có bất kỳ test fail nào (yêu cầu 0 fail).** Ghi nguyên văn summary runner, số pass/fail/skipped, OS, Node/npm version, thời điểm và exact commit SHA. Các test skipped phải được liệt kê/giải thích; không diễn giải skip thành pass và không chấp nhận skip mới không có lý do.

Trước full suite, chạy focused regression tests cho đúng lát cắt PR bằng chính lệnh `node --test <test-file...>` ghi trong PR. Với các thay đổi ảnh hưởng platform boundary, CI còn có platform job:

```bash
npm ci
npm run build
node --test tests/platform.test.mjs
```

## GitHub Actions CI

Workflow thực tế: `.github/workflows/ci.yml`.

- Job `build-test`: matrix `ubuntu-latest`, `windows-latest`, `macos-latest`; mỗi OS chạy `npm ci`, `npm run build`, `npm run typecheck` và full suite. Linux dùng `xvfb-run -a npm test`; Windows/macOS dùng `npm test`.
- Job `platform`: cùng matrix ba OS; chạy `npm ci`, `npm run build`, rồi `node --test tests/platform.test.mjs`.
- Workflow declaration chỉ mô tả các bước sẽ chạy. Chỉ kết luận CI xanh sau khi mở Actions/checks của **đúng PR head SHA** và xác nhận mọi job bắt buộc pass; không suy diễn từ cấu hình YAML hoặc run của commit khác.

## Quy trình kiểm chứng PR do ChatGPT tạo

ChatGPT hỗ trợ đọc/sửa source và mở PR qua GitHub, nhưng môi trường tác giả **không clone checkout, không chạy build, typecheck, unit test hoặc full suite**. Mọi PR do ChatGPT tạo đều phải được Muse độc lập kiểm chứng trên đúng head SHA trước khi land.

Muse cần:
1. Xác nhận PR head SHA/base branch và đọc toàn bộ diff; không tin test claims chưa có runner output.
2. Chạy `npm ci`, `npm run version:check`, `npm run build`, `npm run typecheck`.
3. Chạy focused regression tests liên quan đúng scope.
4. Chạy full-suite gate theo OS ở trên và ghi nguyên bản output summary (yêu cầu 0 fail).
5. Với PR ảnh hưởng platform, xác minh platform test và runtime trên OS đích khi phù hợp; kiểm tra GitHub Actions của đúng SHA.
6. Báo cáo SHA, OS, Node/npm versions, commands, thời điểm, pass/fail/skip và mọi giới hạn trước khi maintainer quyết định land.

Không mark PR là ready, không merge và không mô tả PR là verified chỉ vì code đã được soạn hoặc Draft PR đã mở.

## Release readiness và ranh giới ngoài scope

Quy trình packaging/tag/signing/notarization/GitHub Releases nằm trong [docs/RELEASING.md](RELEASING.md). Source build/test gate không thay thế signing, notarization hoặc kiểm thử artifact trên OS đích. Các lát cắt updater, signing/notarizing và tài liệu release khác cần PR/gate riêng; không coi chúng đã được xác minh chỉ từ PR docs này.

- Updater hiện chỉ check release và mở trang tải thủ công; không tự download/verify/install trong app.
- macOS yêu cầu Developer ID signing + notarization; Windows yêu cầu Authenticode signing. Linux AppImage không được GPG-sign theo cấu hình hiện tại.
- Không có thao tác signing/notarizing trong quy trình PR docs này. Chỉ xác nhận artifact signed/notarized sau khi tạo và verify thật trên nền tảng tương ứng.

## Known gaps / môi trường chưa xác minh

- Self-install/update end-to-end chưa được implement; xem `docs/unbuildable-gaps-v086.md` và `docs/update-tracks.md`.
- Computer-use ngoài Linux + X11 chưa được xác minh trong môi trường tương ứng; xem `docs/unbuildable-gaps-v086.md`.
- Build target macOS/Windows không thay thế test runtime thật trên Mac/Windows.
- Provider live tests yêu cầu key/service thật; nếu thiếu key, test có thể skip. Không ghi live-provider pass dựa trên mock.
- Signing/notarization đòi certificate và secrets bên ngoài; source PR không phải signed release.
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
