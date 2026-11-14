# Workspace abstraction v3 (v1.03, Đội T4)

Agent code không bao giờ chạm host trực tiếp: mọi thao tác file/shell
đi qua một interface `Workspace` duy nhất, factory chọn backend local
hay container theo config. Ý tưởng học từ OpenHands V1 SDK (Workspace
package) — chỉ học ý tưởng, không copy code.

## Dùng nhanh

```ts
import { WorkspaceManager } from '@open-bot/core';

const manager = new WorkspaceManager({ rootDir: '/path/to/workspaces' });
const ws = manager.create({ id: 'demo', backend: 'local' });
const run = await ws.exec('/bin/echo', ['hello']);
ws.writeFile('notes.txt', 'hello');
const snap = ws.createSnapshot('before-refactor');
ws.restoreSnapshot(snap.id);
```

## Backend

- `local` (mặc định): `BotBoxManager` — thư mục riêng + env
  allow-list + bwrap/unshare khi có, chạy thường + cảnh báo rõ khi không có.
- `container`: mỗi workspace là một container docker/podman chạy nền
  (`sleep infinity`), file bind-mount vào `/workspace`, exec qua
  `docker exec` / `podman exec`, quota CPU/RAM bằng `--cpus` / `--memory`.

Không có docker/podman thì create với `backend: 'container'` fallback
về local và đánh dấu workspace `degraded` + lý do — không bao giờ báo
"đang chạy trong container" khi thực tế chạy local. Máy này không có
Docker nên container backend hiện ở trạng thái đó (xem container.ts).

## Quota

- Ngân sách host tính bằng cùng công thức headroom của
  `compute/planner` (chừa CPU/RAM/đĩa cho host). Hết ngân sách thì
  create bị từ chối kèm lý do.
- Mỗi workspace có quota riêng (CPU/RAM/đĩa/process/write/wall/timeout)
  + cửa sổ sử dụng (mặc định 1 ngày). Exec bị từ chối trước khi spawn
  khi vượt quota cửa sổ.
- Số liệu "đang dùng" đo thật từ đĩa (`dirSizeBytes`); số đã cấp ghi
  riêng.

## Snapshot / restore

Copy toàn bộ cây file + manifest sha256 từng file. Restore kiểm tra
hash trước và sau khi copy; lỗi giữa chừng thì rollback về nội dung
cũ — workspace không rơi vào trạng thái nửa-vời. Giữ tối đa 10
snapshot/workspace (prune tự động).

## Hardening (kế thừa sandbox, không phá API cũ)

`Workspace.exec` qua 3 lớp: quota cửa sổ → `WorkspaceExecGuard`
(mẫu lệnh nguy hiểm + tối đa 4 exec đồng thời + `SandboxEnforcer`
theo profile) → backend exec (timeout/cap ghi/cap output + cách ly
thật). File read/write qua `resolveWithinRoot` (chặn `..` escape và
symlink trỏ ra ngoài) + enforcer (cấm path credential dưới mọi profile).

## Layout trên đĩa

```
<root>/
  audit.log                  — audit exec của mọi workspace
  <id>/
    workspace.json           — meta (quota, usage, status; không secret)
    snapshots/<snapId>/      — snapshot.json + manifest.json + files/
  boxes/ws-<id>/workspace/   — file của workspace local (box)
  <id>/files/                — file của workspace container (bind-mount)
```

## Giới hạn còn lại

- Container backend cần image `alpine:latest` pull được; chưa kiểm
  chứng trên macOS/Windows; container không có network namespace
  riêng — egress vẫn qua gate của host.
- Giới hạn prlimit (CPU/RAM/process) của box local chỉ áp lúc tạo box;
  quota đổi sau đó vẫn được enforce ở tầng Workspace (cửa sổ + đĩa).
- Snapshot copy bằng fs (không tar) — workspace rất lớn sẽ chậm.
