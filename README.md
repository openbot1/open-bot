# open-bot

## Trạng thái production / Production status

Cập nhật tài liệu: 24/11/2026 (08:01 +07).

- Repo hiện dùng GitHub Releases làm kênh phân phối dự kiến. Tại lần kiểm tra trong release-gate, repo chưa có release/artifact đã publish.
- Updater hiện kiểm tra release theo track và mở trang release chính thức để tải thủ công. **Ứng dụng chưa tự tải, xác minh rồi cài bản cập nhật trong app**; nút kiểm tra bản mới không đồng nghĩa với auto-install.
- electron-builder có cấu hình đích AppImage (Linux), DMG (macOS) và NSIS (Windows). macOS/Windows release được cấu hình fail-closed khi thiếu chứng chỉ; macOS còn yêu cầu notarization. Linux AppImage chưa có chữ ký GPG trong cấu hình hiện tại.
- Việc một nền tảng có target đóng gói không chứng minh ứng dụng đã được chạy/kiểm thử trên nền tảng đó. Xem [docs/TESTING.md](docs/TESTING.md) để biết cách phân biệt bằng chứng trên GitHub CI với kết quả từ máy phát triển.

### Version source and hardening snapshot

- **Nguồn version duy nhất:** trường `version` trong root `package.json`. Các version trong workspace manifests và `package-lock.json` là metadata mirror được đồng bộ bằng `npm run version:sync` và kiểm tra bằng `npm run version:check`. Không tự sửa version trong package con. PR #30 đã chuẩn hóa runtime consumers qua generated `APP_VERSION` modules và đã land trên local main tại `1fe41d25`; thay đổi này hiện chưa nằm trên public GitHub `main` do snapshot local chưa được đẩy. PR #29 v3 đã land trên local main trong snapshot `e38671d9`; Muse xác minh 0 blocker, focused checks 7/7, probe 27/27 và vùng chạm 145/145 trước khi land.
- Hardening đã bao phủ các ranh giới: IPC sender validation; egress/SSRF (bao gồm nhận diện bare `curl`/`wget` targets); Vault fallback; MCP config-file permissions; router local-model child-environment filtering; webhook approval-payload minimisation; chặn skill prompt-injection trước khi đưa nội dung vào prompt; và disclosure rằng plugin chạy ở process riêng vẫn giữ quyền của cùng OS user.
- **Snapshot local/remote (maintainer-reported, 24/11/2026 08:01 +07):** local main hiện ở `e38671d9`; PR #28 (`8522ce7b`), #30 (`1fe41d25`), #32 (`5c8eac59`), #33 (`bcfa06c1`) và PR #29 v3 (`0df9e0cd`, land trong snapshot `e38671d9`) đã land local. Gate trên `e38671d9`: build + typecheck exit 0; full suite báo **12,824 pass / 3 fail / 19 skipped** (12,846 test). Cả 3 fail đều là timeout CDP 120 giây ở `automations-seed-samples-v074-renderer`; chạy riêng file đó retest **3/3 pass**, và 7 test mới của #29 đều pass trong suite. Vì full-suite lần đầu vẫn có 3 fail, không gọi gate hiện tại là xanh; retest riêng chỉ chứng minh flake không tái hiện trong lần chạy lẻ. Gate #30 riêng trên SHA `1fe41d25` đã xanh lúc 07:17 +07: **12,820 pass / 0 fail / 19 skipped**; đây không phải kết quả của `e38671d9`. Remote GitHub `main` vẫn `f17b8675`. Approval `709d77cc` còn chờ nhưng gắn manifest cũ; manifest mới từ `e38671d9` có 41 file in-scope, đã loại 26 file drift, chưa được đẩy. PR #34/#35 LAND-READY chờ land; #36 chờ kiểm chứng và phụ thuộc #34.
- Chỉ coi một thay đổi là đã land khi nó có mặt trên đúng source snapshot/commit. Không suy ra trạng thái remote từ local main hoặc từ việc một PR đã được mở.

## Tiếng Việt

**open-bot** là một agent AI local-first, chạy trên máy cá nhân của bạn. Ứng dụng dùng API key/provider do bạn cấu hình; khi gọi provider cloud, nội dung request vẫn được gửi tới provider đó. Dự án không vận hành backend cloud riêng để lưu lịch sử trò chuyện của bạn.

### Thành phần chính

- Agent chạy nền và điều phối tác vụ qua provider AI do người dùng chọn.
- Bộ nhớ và lịch sử lưu trữ local (SQLite và các file dữ liệu ứng dụng).
- Hỗ trợ provider cloud và model local như Ollama.
- Tool hệ thống, file/code, web, lập kế hoạch, MCP và các tích hợp khác; quyền thực thi phụ thuộc policy/approval của ứng dụng.
- Desktop app Electron với giao diện tiếng Việt và tiếng Anh.
- CLI headless cho quy trình chạy bot/team từ terminal.

### Cài đặt và chạy từ source

Yêu cầu: Node.js 24+ và npm.

```bash
npm run version:sync
npm ci
npm run version:check
npm run dev
```

Build và typecheck:

```bash
npm run build
npm run typecheck
```

Full-suite gate (run on the exact commit being considered for landing):

```bash
# Linux
xvfb-run -a npm test

# Windows / macOS
npm test
```

**Không land nếu full suite có bất kỳ test fail nào.** Skip phải được báo cáo riêng, có lý do; không coi skip là pass hoặc bằng chứng tích hợp thật. Các lệnh root build/typecheck chạy lần lượt các workspace core, tools, desktop và CLI. Xem [docs/TESTING.md](docs/TESTING.md) để biết lệnh từng workspace, CI matrix và quy trình Muse xác minh độc lập.

### Cấu hình API key

Lấy API key từ provider bạn chọn, sau đó nhập trong Settings hoặc cấu hình theo [docs/SETUP.md](docs/SETUP.md). Chỉ gửi key tới provider bạn đã cấu hình; không commit file `.env`, file cấu hình hay backup chứa secret vào Git.

### Bảo mật và giới hạn

- Dữ liệu ứng dụng được lưu local; các request tới provider bên ngoài vẫn rời khỏi máy.
- Mức bảo vệ secret phụ thuộc secure storage khả dụng trên hệ điều hành và cấu hình hiện hành. Không suy ra rằng mọi môi trường đều có cùng mức bảo vệ như OS keychain.
- Self-update hiện là **check + thông báo + mở trang download**, chưa tự tải/cài.
- Computer-use hiện có giới hạn nền tảng; không coi target đóng gói là bằng chứng computer-use đã hỗ trợ trên Wayland/macOS/Windows. Xem [docs/unbuildable-gaps-v086.md](docs/unbuildable-gaps-v086.md).

### Build phát hành

Xem [docs/RELEASING.md](docs/RELEASING.md) để biết tag, signing/notarization, GitHub Releases và các biến môi trường. Không có release đã ký nào được hứa hẹn chỉ bởi việc source build thành công.

### Kiến trúc và giấy phép

- Kiến trúc: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Setup: [docs/SETUP.md](docs/SETUP.md)
- License: MIT — xem [LICENSE](LICENSE).

---

## English

**open-bot** is a local-first AI agent that runs on your computer. It uses the AI providers and API keys you configure. When a cloud provider is selected, request content is sent to that provider; the project does not operate a separate cloud backend for storing your chat history.

### Main components

- Background agent runtime and task orchestration through the provider selected by the user.
- Local conversation and memory storage (SQLite and application data files).
- Cloud providers and local models such as Ollama.
- System, file/code, web, planning, MCP and other tools; execution permissions depend on the app's policy and approval flow.
- Electron desktop application with Vietnamese and English UI.
- Headless CLI for running bots and applying team configuration from a terminal.

### Install and run from source

Requirements: Node.js 24+ and npm.

```bash
npm run version:sync
npm ci
npm run version:check
npm run dev
```

Build and typecheck:

```bash
npm run build
npm run typecheck
```

Full-suite gate (run on the exact commit being considered for landing):

```bash
# Linux
xvfb-run -a npm test

# Windows / macOS
npm test
```

Do not land with any full-suite test failures. Report skipped tests separately with reasons; a skip is neither a pass nor proof of real integration. The root build/typecheck scripts run core, tools, desktop and CLI workspaces in sequence. See [docs/TESTING.md](docs/TESTING.md) for per-workspace commands, the CI matrix and Muse's independent verification procedure.

### API keys

Create a key with the provider you choose, then enter it in Settings or follow [docs/SETUP.md](docs/SETUP.md). Keys are sent only to the provider you configure. Never commit `.env`, app configuration, or backups containing secrets.

### Security and limitations

- Application data is stored locally; requests to external AI providers still leave the machine.
- Secret protection depends on the operating system's secure-storage availability and the active configuration. Do not assume every environment provides the same protection as an OS keychain.
- Self-update currently provides **check + notification + opening the download page**; it does not download and install updates in-app.
- Computer-use has platform limitations. A packaging target is not evidence that computer-use is supported on Wayland/macOS/Windows. See [docs/unbuildable-gaps-v086.md](docs/unbuildable-gaps-v086.md).

### Version source and hardening snapshot

- **Single version source:** the `version` field in the root `package.json`. Workspace manifest versions and `package-lock.json` entries are synchronized metadata mirrors maintained by `npm run version:sync` and checked by `npm run version:check`. Do not edit workspace versions independently. PR #30 standardized runtime consumers through generated `APP_VERSION` modules and has landed on local main at `1fe41d25`; this change is not yet present on public GitHub `main` because the local snapshot has not been pushed. PR #29 v3 has landed on local main in snapshot `e38671d9`; Muse reported 0 blockers, focused checks 7/7, probe 27/27 and touched-area tests 145/145 before landing.
- Hardening work covers IPC sender validation; egress/SSRF controls (including bare `curl`/`wget` target detection); Vault fallback; MCP config-file permissions; router local-model child-environment filtering; webhook approval-payload minimisation; prompt-injection blocking before skill content enters prompts; and disclosure that a separate plugin process still runs with the same OS user's privileges.
- **Local/remote snapshot (maintainer-reported, 24 Nov 2026 08:01 +07):** local main is `e38671d9`; PRs #28 (`8522ce7b`), #30 (`1fe41d25`), #32 (`5c8eac59`), #33 (`bcfa06c1`) and PR #29 v3 (`0df9e0cd`, included in the `e38671d9` landing snapshot) have landed locally. The gate on `e38671d9` reports build + typecheck exit 0 and full suite **12,824 passed / 3 failed / 19 skipped** (12,846 tests). All three failures are 120-second CDP timeouts in `automations-seed-samples-v074-renderer`; rerunning that test file alone passed **3/3**, and all seven new #29 tests passed in the full run. Because the initial full run still reported three failures, this snapshot is **not described as full-suite green**; the isolated rerun only shows the flake did not reproduce in that retry. The separate #30 gate on SHA `1fe41d25` was green at 07:17 +07: **12,820 passed / 0 failed / 19 skipped**; that result is not for `e38671d9`. Public GitHub `main` remains `f17b8675`. Approval `709d77cc` is still pending but refers to the old manifest; the rebuilt manifest from `e38671d9` contains 41 in-scope files after excluding 26 drift files and has not been pushed. PRs #34/#35 are LAND-READY and waiting to land; #36 awaits verification and depends on #34.
- Treat a change as landed only when it is present on the exact source snapshot/commit being released. Do not infer remote state from local main or from an opened PR.

### Release builds

See [docs/RELEASING.md](docs/RELEASING.md) for tags, signing/notarization, GitHub Releases and required environment variables. A successful source build does not by itself mean a signed release exists.

### Architecture and license

- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Setup: [docs/SETUP.md](docs/SETUP.md)
- License: MIT — see [LICENSE](LICENSE).

## Disclaimer

This project is written from scratch. References to third-party products or provider names identify integrations or compatibility targets; they do not imply endorsement or affiliation.
