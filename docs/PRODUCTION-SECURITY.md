# Production security model and operator checklist

Cập nhật: 20/11/2026.

Tài liệu này tóm tắt ranh giới tin cậy, tài sản cần bảo vệ và các giới hạn
an ninh cần tính đến khi triển khai/vận hành open-bot. Đây là **threat model
và hướng dẫn vận hành**, không phải chứng nhận, pentest hay cam kết rằng mọi
đường thực thi đều đã được cô lập ở cấp hệ điều hành.

Các nhận định về trạng thái triển khai chỉ có giá trị với **commit SHA được
review/phát hành**. Không coi thay đổi mới chỉ có ở checkout local hoặc Draft
PR là kiểm soát đã được ship. Một kiểm soát chỉ được tính là hiện diện khi code
của nó nằm trong SHA mục tiêu và có bằng chứng kiểm thử cho đúng SHA đó.

## 1. Phạm vi và giả định

open-bot là desktop app local-first: dữ liệu ứng dụng chủ yếu lưu trên máy
người dùng, nhưng **local-first không có nghĩa là không có dữ liệu rời khỏi
máy**. Nội dung chat/context và tệp đính kèm được gửi tới provider mà người
dùng chọn khi chạy model; web tools, MCP server, plugin, webhook và các tích
hợp khác có thể tạo thêm luồng dữ liệu mạng.

Threat model giả định người dùng kiểm soát OS account và máy của mình. Nó
không bảo vệ được khỏi malware đã chạy với cùng quyền người dùng, tài khoản OS
bị chiếm, kernel/OS bị compromise, hay provider bên ngoài bị compromise.

### Tài sản cần bảo vệ

| Tài sản | Ví dụ | Hậu quả khi bị lộ hoặc sửa |
| --- | --- | --- |
| Credentials | Provider API keys, OAuth refresh tokens, MCP/plugin secrets, webhook keys | Chiếm tài khoản dịch vụ, phát sinh chi phí, giả mạo request |
| Dữ liệu hội thoại | Chat, memory, task/run logs, tệp đính kèm | Lộ dữ liệu cá nhân, mã nguồn hoặc dữ liệu công việc |
| Workspace | Source code, tài liệu, file cấu hình | Đọc/sửa/xóa dữ liệu hoặc cài mã độc |
| Quyền thực thi | Tool calls, shell, plugin và MCP processes | Thực thi lệnh, truy cập file hoặc mạng |
| Cấu hình tin cậy | Approval policy, tool/plugin allowlist, egress policy | Mở rộng quyền mà người dùng không nhận biết |

## 2. Ranh giới tin cậy

Luồng khái quát:

```text
Renderer (UI; có thể bị ảnh hưởng bởi XSS/nội dung không tin cậy)
       │  API hẹp qua preload / IPC
       ▼
Electron main (quyền truy cập app data, Vault, OS APIs)
       │
       ├── core / agent loop / approval policy
       ├── tools / shell / filesystem
       ├── plugin và MCP code
       └── network ──► provider, website, MCP, webhook, dịch vụ người dùng cấu hình
```

- **Renderer → main:** preload chỉ expose API ứng dụng có chủ đích qua
  `window.openBot`, không expose trực tiếp `ipcRenderer` hay Node API. Đây
  là giảm bề mặt IPC, không phải xác thực người gọi thay cho main process.
  Mọi payload từ renderer vẫn phải được validate ở handler; các handler có
  quyền cần kiểm tra đúng sender/frame và không được tin dữ liệu do renderer
  gửi chỉ vì nó đi qua preload.
- **Model, prompt và nội dung web:** tool call do model đề xuất là input không
  tin cậy, không phải lệnh có quyền tự động. Trang web, tài liệu, skill và
  nội dung do người khác cung cấp có thể chứa prompt injection.
- **Tools và OS:** `resolveWithin()` giúp giữ các đường dẫn của tool dùng
  helper trong workspace (kể cả symlink escape); denylist shell, timeout,
  giới hạn output và approval là các lớp giảm rủi ro. Chúng **không tương
  đương một OS sandbox** và không giới hạn mọi chương trình con đã chạy.
- **Plugin:** manifest/permission validation và static source scan chỉ là
  kiểm tra lúc load. Code plugin chạy với quyền của tiến trình/người dùng và
  có thể lách static scan; không cài plugin không đáng tin.
- **MCP server:** server bên thứ ba là code thực thi, không chỉ là một API
  declaration. Cấu hình command/package và biến môi trường được cấp cho nó
  phải được xem là cấp quyền chạy code bên ngoài.
- **Network:** egress policy là kiểm soát ở các đường tích hợp cụ thể, không
  phải firewall/proxy ở tầng OS. Tool hoặc process tự mở socket ngoài các
  đường đã nối policy có thể không bị kiểm tra.

## 3. Những kiểm soát hiện có và giới hạn quan trọng

### Vault và secret

Vault lưu ciphertext trong `vault.json`. Khi Electron `safeStorage` khả
dụng, main process dùng backend OS (DPAPI trên Windows, Keychain trên macOS,
libsecret trên Linux). Khi không khả dụng, code nền có `LocalEncryptor`
fallback: AES-256-GCM, khóa dẫn xuất bằng scrypt từ machine-key file; envelope
gồm version byte, salt 16 byte, IV 12 byte, ciphertext và GCM tag 16 byte.

Fallback có ích để tránh plaintext-at-rest và chống việc chỉ đọc riêng file
ciphertext, nhưng **yếu hơn OS keychain**: machine key mặc định nằm trong
`vault.json.key` cạnh store, với quyền file hạn chế. Ai lấy được cả hai file
(ví dụ malware cùng user hoặc bản sao thư mục app data) có thể có đủ dữ liệu
để giải mã. Mã hóa không bảo vệ secret khỏi code độc hại đang chạy cùng quyền
người dùng hoặc khỏi tiến trình app đã bị compromise.

- Không mô tả LocalEncryptor là OS keychain, hardware-backed storage hay
  encryption độc lập với tài khoản OS.
- Khi UI/trạng thái ứng dụng báo storage degraded/fallback, coi đây là mức
  bảo vệ thấp hơn; tuân theo chính sách tổ chức và không lưu credential nhạy
  cảm trên máy dùng chung hoặc thư mục đồng bộ không tin cậy.
- Khi backup/khôi phục fallback, giữ đúng cặp ciphertext + machine key và
  bản backup tương ứng. **Không xóa hoặc tự tạo lại file `.key`** để chữa
  lỗi decrypt: key mới không thể giải mã ciphertext cũ.
- Khi gặp lỗi decrypt hoặc nghi ngờ key mismatch, dừng thao tác ghi/rotate,
  sao lưu nguyên trạng store, key file và các bản durable backup trước khi
  thử khôi phục. Không chạy migration/rotation mù trên bản dữ liệu duy nhất.

### Approval, sandbox và extension

Approval là điểm xác nhận của người dùng, không phải bằng chứng hành động
an toàn. Kiểm tra tham số và hiển thị rõ tool, target, tác động trước khi
duyệt; không bật auto-approve rộng hơn nhu cầu công việc.

`resolveWithin()` chỉ bảo vệ những đường code thực sự gọi helper đó.
Denylist shell là safety net, không phải shell parser hay container. Plugin
static scan không ngăn được code cố tình obfuscate hoặc gọi API Node trực tiếp.
Vì vậy:

- Chỉ cài plugin/skill/MCP từ nguồn đã được tổ chức tin cậy và review.
- Kiểm tra quyền plugin, lệnh MCP sẽ chạy, nguồn package và phiên bản trước
  khi cài/cập nhật.
- Không cấp credential có quyền rộng cho môi trường chứa extension không
  đáng tin; giả định extension cùng OS user có thể truy cập các tài nguyên
  user có quyền đọc.
- Nếu cần cô lập extension khỏi Vault/workspace/OS, phải dùng OS account,
  container hoặc sandbox hệ điều hành độc lập; không dựa vào manifest hay
  tên gọi “sandbox”.

### Egress và dữ liệu ra ngoài

Egress policy có allowlist/denylist và mặc định fail-closed khi đã được nối
vào đường gọi. Giữ `allowPrivateDestinations` tắt trừ khi có use case nội bộ
được review và giới hạn cụ thể. Không nới `failClosed` để che lỗi DNS.

Các giới hạn cần hiểu trước khi coi policy là hàng rào mạng:

- Shell target extraction chỉ nhận diện URL có scheme rõ ràng và dạng Git
  SCP-like; host viết tắt như `curl example.com` có thể không được trích ra.
- Đường kiểm tra đồng bộ không resolve DNS; không coi đó là bảo vệ DNS
  rebinding đầy đủ.
- Plugin/MCP hoặc chương trình đã spawn có thể mở socket trực tiếp, ngoài
  các điểm vào egress đã nối policy.
- Mỗi network-capable tool mới phải được rà soát riêng: policy resolver,
  DNS/redirect handling, private/loopback/link-local/metadata targets và
  mọi fallback path. Egress policy trong app không thay thế firewall của OS
  hay network perimeter.

Trước khi gửi dữ liệu nhạy cảm tới provider hoặc dịch vụ tích hợp, xác nhận
provider/endpoint, payload, retention terms và quyền truy cập của tổ chức.
Đừng suy ra “không gửi dữ liệu” chỉ từ kiến trúc local-first.

## 4. Checklist trước khi dùng trong production

- Chạy app dưới OS account riêng, không dùng quyền Administrator/root thường
  trực; bật mã hóa ổ đĩa, khóa màn hình và cập nhật OS.
- Xác nhận Vault dùng storage backend mà chính sách tổ chức yêu cầu. Nếu ở
  degraded/fallback, đánh giá rủi ro và không gọi nó là keychain.
- Cấp API key tối thiểu quyền, giới hạn chi phí ở provider nếu có; không đưa
  secret vào prompt, ticket, terminal transcript hay log đính kèm công khai.
- Chỉ cài plugin/MCP/skill đã review; kiểm tra command, package, version,
  permission và nguồn tải. Không dựa vào static scan làm bằng chứng an toàn.
- Bật egress policy phù hợp với môi trường; dùng allowlist host/IP tối thiểu,
  giữ fail-closed và chỉ cho phép mạng nội bộ theo ngoại lệ có chủ đích.
- Kiểm tra đúng source SHA, OS, lệnh và summary trong `docs/TESTING.md`.
  CI xanh hoặc test mock không thay thế xác minh live/provider và artifact
  thật trên OS đích.
- Xác minh signing/notarization/checksum theo quy trình phát hành hiện hành;
  không cài artifact chỉ vì nó được tải từ một URL có vẻ chính thức.

## 5. Phản ứng nhanh khi có sự cố

### Credential nghi bị lộ

1. Dừng run/automation liên quan và cô lập máy khỏi mạng nếu còn nguy cơ
   exfiltration đang diễn ra.
2. Thu hồi hoặc rotate credential tại provider/dịch vụ phát hành credential
   trước; không chờ điều tra xong mới revoke.
3. Kiểm tra phạm vi quyền, usage/billing và access log phía provider; cấp key
   mới với quyền tối thiểu rồi cập nhật trong app.
4. Lưu bằng chứng cần thiết ở nơi hạn chế truy cập. Redact token, prompt,
   workspace path và dữ liệu khách hàng trước khi gửi issue/log ra ngoài.

### Vault không decrypt được hoặc key có vẻ không khớp

1. Không xóa Vault, key file, backup; không chạy rotate/migrate thêm.
2. Đóng app và tạo bản sao nguyên trạng của `vault.json`, `vault.json.key`
   (nếu có) cùng các bản backup liên quan; giữ permissions và timestamps.
3. Khôi phục một cặp store/key đã biết khớp. Nếu dùng OS `safeStorage`,
   thực hiện restore trong đúng OS account/profile phù hợp; ciphertext có thể
   không giải mã được trên một máy hoặc profile khác.
4. Chỉ tiếp tục thao tác sau khi đã đọc được secret cần thiết và xác minh
   dữ liệu; không overwrite bản duy nhất trong quá trình thử.

### Plugin/MCP hoặc tool đáng ngờ

1. Dừng run, disable/uninstall extension từ UI và thoát app; kiểm tra/stop
   child process còn sống.
2. Giữ bản sao package, manifest, cấu hình MCP, thời điểm cài/cập nhật và
   log liên quan để điều tra offline.
3. Vì code extension có thể chạy với quyền cùng OS user, xử lý sự cố như
   khả năng credential và workspace đã bị truy cập; revoke/rotate credential
   có thể đã đọc được.
4. Chỉ bật lại sau khi xác minh nguồn, nội dung, command và quyền.

## 6. Tài liệu liên quan

- [Kiến trúc tổng quan](ARCHITECTURE.md)
- [Egress policy và các giới hạn triển khai](egress-policy.md)
- [Security audit v0.15 — findings theo thời điểm audit](security-audit-v015.md)
- [MCP security audit v1.10](mcp-security-audit-v110.md)
- [Build, testing và production verification](TESTING.md)
- [Các gap chưa build/test được](unbuildable-gaps-v086.md)

Audit cũ là bằng chứng theo commit/thời điểm đã ghi trong từng báo cáo, không
phải khẳng định các finding đã được sửa hoặc vẫn còn nguyên trên HEAD hiện
tại. Trước mỗi release, đối chiếu từng claim với source và test của SHA sẽ
phát hành.
