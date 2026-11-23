# open-bot

## Trạng thái production / Production status

Cập nhật tài liệu: 23/11/2026 (20:00 +07).

- Repo hiện dùng GitHub Releases làm kênh phân phối dự kiến. Tại lần kiểm tra trong release-gate, repo chưa có release/artifact đã publish.
- Updater hiện kiểm tra release theo track và mở trang release chính thức để tải thủ công. **Ứng dụng chưa tự tải, xác minh rồi cài bản cập nhật trong app**; nút kiểm tra bản mới không đồng nghĩa với auto-install.
- electron-builder có cấu hình đích AppImage (Linux), DMG (macOS) và NSIS (Windows). macOS/Windows release được cấu hình fail-closed khi thiếu chứng chỉ; macOS còn yêu cầu notarization. Linux AppImage chưa có chữ ký GPG trong cấu hình hiện tại.
- Việc một nền tảng có target đóng gói không chứng minh ứng dụng đã được chạy/kiểm thử trên nền tảng đó. Xem [docs/TESTING.md](docs/TESTING.md) để biết cách phân biệt bằng chứng trên GitHub CI với kết quả từ máy phát triển.

### Version source and hardening snapshot

- **Nguồn version duy nhất:** trường `version` trong root `package.json`. Các version trong workspace manifests và `package-lock.json` là metadata mirror được đồng bộ bằng `npm run version:sync` và kiểm tra bằng `npm run version:check`. Không tự sửa version trong package con. PR #30 chuẩn hóa runtime consumers qua generated `APP_VERSION` modules; PR này phải được Muse kiểm chứng độc lập trước khi land.
- Hardening đã bao phủ các ranh giới: IPC sender validation; egress/SSRF (bao gồm nhận diện bare `curl`/`wget` targets); Vault fallback; MCP config-file permissions; router local-model child-environment filtering; webhook approval-payload minimisation; chặn skill prompt-injection trước khi đưa nội dung vào prompt; và disclosure rằng plugin chạy ở process riêng vẫn giữ quyền của cùng OS user.
- **Snapshot có phân biệt local/remote:** full suite trên local snapshot `1fb2cded` ngày 23/11/2026 chạy từ 19:03 đến 19:33 +07 (land commit lúc 19:34 +07; 20:00 +07 là thời điểm viết báo cáo), với 12,804 pass / 0 fail / 19 skipped. Đây là kết quả maintainer báo cáo trên local checkout, không phải kết quả do tài liệu này chạy hay CI trên remote SHA xác nhận. PR #27 đã landed trên local main `cdd9a5f5`; PR #28 đã landed trên local main `8522ce7b`; cả hai đang chờ push snapshot lên remote (public GitHub `main` vẫn là `f17b8675`). PRs #29/#30 vẫn chờ Muse kiểm chứng độc lập.
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

- **Single version source:** the `version` field in the root `package.json`. Workspace manifest versions and `package-lock.json` entries are synchronized metadata mirrors maintained by `npm run version:sync` and checked by `npm run version:check`. Do not edit workspace versions independently. PR #30 standardizes runtime consumers through generated `APP_VERSION` modules and is awaiting Muse's independent verification before landing.
- Hardening work covers IPC sender validation; egress/SSRF controls (including bare `curl`/`wget` target detection); Vault fallback; MCP config-file permissions; router local-model child-environment filtering; webhook approval-payload minimisation; prompt-injection blocking before skill content enters prompts; and disclosure that a separate plugin process still runs with the same OS user's privileges.
- **Local/remote snapshot distinction:** the full suite on local snapshot `1fb2cded` ran on 23 Nov 2026 from 19:03 to 19:33 +07 (the landing commit was created at 19:34 +07; 20:00 +07 was the report-writing time), with 12,804 passed / 0 failed / 19 skipped. This is a maintainer-reported local result, not a run performed by this documentation author or evidence of CI passing on the remote SHA. PR #27 landed on local main at `cdd9a5f5`; PR #28 landed on local main at `8522ce7b`; both are awaiting the approved snapshot push (public GitHub `main` remains `f17b8675`). PRs #29/#30 remain pending independent Muse verification.
- Treat a change as landed only when it is present on the exact source snapshot/commit being released. Do not infer remote state from local main or from an opened PR.

### Release builds

See [docs/RELEASING.md](docs/RELEASING.md) for tags, signing/notarization, GitHub Releases and required environment variables. A successful source build does not by itself mean a signed release exists.

### Architecture and license

- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Setup: [docs/SETUP.md](docs/SETUP.md)
- License: MIT — see [LICENSE](LICENSE).

## Disclaimer

This project is written from scratch. References to third-party products or provider names identify integrations or compatibility targets; they do not imply endorsement or affiliation.
