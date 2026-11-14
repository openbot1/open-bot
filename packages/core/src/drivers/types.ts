/**
 * Driver registry — đăng ký CLI binary tuỳ chỉnh (v1.06, Đội T3).
 *
 * Học ý tưởng "custom CLI" của OpenMausBot (bot chạy trên CLI đã có
 * trên máy user): ngoài các CLI có sẵn (Claude Code, Codex…), user
 * được đăng ký thêm binary CLI bất kỳ của riêng mình — ghi rõ nó nói
 * giao thức nào (JSON dòng / JSON-RPC / ACP) để open-bot gọi đúng
 * cách. Driver chỉ là KHAI BÁO (đường dẫn + cách gọi), không chứa
 * secret: argv chứa cờ key/token bị từ chối lúc đăng ký (theo mẫu
 * `detected/custom.ts`), key đăng nhập thuộc về chính CLI đó.
 *
 * Lưu bền: `<dataDir>/cli-drivers.json` (ghi atomic qua
 * writeDurableFileSync). Driver tắt (`enabled: false`) thì picker
 * không hiện và bot không dùng được — fail-closed.
 */

/** Định dạng stream mà CLI tuỳ chỉnh nói. */
export type DriverStreamFormat = 'json' | 'json-rpc' | 'acp' | 'ndjson';
export const DRIVER_STREAM_FORMATS: readonly DriverStreamFormat[] = ['json', 'json-rpc', 'acp', 'ndjson'];

/** Cấu hình một driver CLI tuỳ chỉnh. */
export interface CliDriverConfig {
  /** Id ổn định, vd "my-cli" (duy nhất trong registry). */
  id: string;
  /** Tên hiển thị, vd "My CLI". */
  name: string;
  /** Provider id mà driver này phục vụ (vd "my-provider"). */
  providerId: string;
  /** Đường dẫn tuyệt đối tới binary (hoặc tên binary trên PATH). */
  binaryPath: string;
  /** Argv cố định đưa CLI vào chế độ agent/stream (vd ["acp"]). */
  argv: string[];
  /** Định dạng stream CLI nói. */
  streamFormat: DriverStreamFormat;
  /** Lệnh lấy version, vd ["--version"] (mặc định ["--version"]). */
  versionArgs: string[];
  /** Lệnh kiểm tra đăng nhập (tùy chọn, vd ["auth", "status"]). */
  probeArgs?: string[];
  /** Bật hay tắt (mặc định true khi đăng ký). */
  enabled: boolean;
  /** Epoch ms lúc đăng ký. */
  createdAt: number;
  /** Epoch ms lần cập nhật cuối. */
  updatedAt: number;
}

/** Input khi đăng ký/cập nhật driver (chưa có id/time/enabled). */
export interface RegisterDriverInput {
  id: string;
  name: string;
  providerId: string;
  binaryPath: string;
  argv?: string[];
  streamFormat: DriverStreamFormat;
  versionArgs?: string[];
  probeArgs?: string[];
  enabled?: boolean;
}

export const CLI_DRIVERS_FILE = 'cli-drivers.json';

/** File state bền vững của registry. */
export interface CliDriversStateFile {
  version: 1;
  drivers: CliDriverConfig[];
}

/** Kết quả test kết nối một driver (xem drivers/probe.ts). */
export interface DriverProbeResult {
  driverId: string;
  /** `true` khi binary chạy được và trả về version đọc được. */
  ok: boolean;
  /** Version parse được (vd "1.2.3"), null khi không đọc được. */
  version: string | null;
  /** Binary có tồn tại/khả thi không. */
  binaryFound: boolean;
  /** Lệnh status có chạy được không (null khi driver không khai probeArgs). */
  signedIn: boolean | null;
  /** Thời gian probe (ms). */
  latencyMs: number;
  /** Lỗi ngắn gọn khi !ok (đã cắt ngắn, không secret). */
  error?: string;
  /** Stdout thô đã cắt ngắn (tối đa 500 ký tự) — để debug. */
  stdoutPreview?: string;
}
