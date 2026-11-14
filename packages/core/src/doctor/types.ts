/**
 * Doctor — kiểm tra toàn diện môi trường (v1.06, Đội T3).
 *
 * Học ý tưởng lệnh `doctor` của OpenMausBot: một lệnh duy nhất quét
 * hết những thứ khiến bot không chạy được (CLI chưa cài/chưa login,
 * Node quá cũ, hết đĩa, port bị chiếm, vault chưa có key…) rồi báo
 * cáo dạng checklist pass/warn/fail kèm gợi ý sửa cho từng lỗi.
 *
 * NGUYÊN TẮC:
 * - Chỉ ĐỌC, không bao giờ sửa môi trường, không đọc secret: kiểm
 *   tra đăng nhập bằng chính detector của `detected/` (hỏi CLI bằng
 *   lệnh status của nó) hoặc kiểm tra SỰ TỒN TẠI của file auth —
 *   không bao giờ đọc nội dung credential, không in token ra báo cáo.
 * - Mọi nguồn dữ liệu đều inject được qua `DoctorDeps` để test chạy
 *   xác định (không spawn process thật, không đọc máy thật).
 * - Một check lỗi không bao giờ làm cả lần doctor crash: check nào
 *   throw thì thành `fail` với lý do là message của lỗi đó.
 *
 * Dùng từ CLI (`open-bot doctor [--json]`) hoặc từ tool
 * `doctor_run` (agent tự chẩn đoán rồi đề xuất cách sửa).
 */

export type DoctorCheckStatus = 'pass' | 'warn' | 'fail';

/** Nhóm của một check (để UI gom nhóm checklist). */
export type DoctorCategory =
  | 'runtime' // node / npm / hệ điều hành
  | 'resources' // CPU / RAM / đĩa
  | 'cli' // CLI agent đã cài + đã login
  | 'harness' // harness server / port loopback
  | 'vault' // vault + key
  | 'data'; // thư mục dữ liệu (bots.json, team.json…)

/** Mã định danh ổn định của từng check (UI map mã → text i18n). */
export type DoctorCheckId =
  | 'node-version'
  | 'npm-version'
  | 'os'
  | 'cpu'
  | 'memory'
  | 'disk'
  | 'cli-engines'
  | 'harness-loopback'
  | 'harness-port'
  | 'vault'
  | 'data-dir';

/** Kết quả của một check. */
export interface DoctorCheck {
  /** Mã ổn định (xem DoctorCheckId). */
  id: DoctorCheckId;
  category: DoctorCategory;
  /** Nhãn hiển thị (tiếng Việt mặc định; UI dùng i18n theo id). */
  label: string;
  status: DoctorCheckStatus;
  /** Chi tiết ngắn đã đo được (vd "Node v24.3.0", "đĩa trống 12,4 GB"). */
  detail: string;
  /** Gợi ý sửa khi warn/fail; rỗng khi pass. */
  fix?: string;
  /** Thời gian check chạy (ms) — để phát hiện check nào chậm bất thường. */
  durationMs: number;
}

/** Toàn bộ báo cáo doctor. */
export interface DoctorReport {
  /** Phiên bản schema của báo cáo (đổi khi thêm/bớt check). */
  version: 1;
  /** Thời điểm chạy (ISO string). */
  ranAt: string;
  /** Tổng kết số lượng theo trạng thái. */
  summary: {
    pass: number;
    warn: number;
    fail: number;
    total: number;
  };
  /** `true` khi không có check nào fail (warn vẫn cho phép chạy). */
  ok: boolean;
  /** Từng check, theo thứ tự chạy (runtime → resources → cli → harness → vault → data). */
  checks: DoctorCheck[];
}

/** Một CLI engine mà doctor đã dò được (chỉ nhãn, không secret). */
export interface DoctorEngineInfo {
  kind: string;
  label: string;
  installed: boolean;
  version: string | null;
  signedIn: boolean | null;
  accountLabel?: string;
  enabled: boolean;
  reason?: string;
}

/** Ngưỡng cảnh báo/lỗi cho tài nguyên (mặc định xem DEFAULT_DOCTOR_THRESHOLDS). */
export interface DoctorThresholds {
  /** Node tối thiểu để chạy (fail khi thấp hơn). */
  nodeMinMajor: number;
  /** Node khuyến nghị (warn khi thấp hơn nhưng vẫn >= min). */
  nodeRecommendedMajor: number;
  /** Đĩa trống tối thiểu (bytes) — fail khi thấp hơn. */
  diskMinFreeBytes: number;
  /** Đĩa trống khuyến nghị (bytes) — warn khi thấp hơn nhưng vẫn >= min. */
  diskWarnFreeBytes: number;
  /** RAM trống tối thiểu (bytes) — fail khi thấp hơn. */
  memoryMinFreeBytes: number;
  /** RAM khuyến nghị (bytes) — warn khi thấp hơn nhưng vẫn >= min. */
  memoryWarnFreeBytes: number;
  /** Load trung bình 1 phút / CPU — warn khi vượt. */
  cpuLoadWarnPerCpu: number;
  /** Load trung bình 1 phút / CPU — fail khi vượt. */
  cpuLoadFailPerCpu: number;
}

export const DEFAULT_DOCTOR_THRESHOLDS: DoctorThresholds = {
  nodeMinMajor: 20,
  nodeRecommendedMajor: 24,
  diskMinFreeBytes: 1_073_741_824, // 1 GiB
  diskWarnFreeBytes: 5_368_709_120, // 5 GiB
  memoryMinFreeBytes: 268_435_456, // 256 MiB
  memoryWarnFreeBytes: 1_073_741_824, // 1 GiB
  cpuLoadWarnPerCpu: 0.9,
  cpuLoadFailPerCpu: 1.5,
};

/** Cổng harness mặc định mà doctor kiểm tra khi user không chỉ định cổng khác. */
export const DEFAULT_DOCTOR_HARNESS_PORT = 18789;

/** Các check doctor chạy, theo thứ tự cố định. */
export const DOCTOR_CHECK_IDS: readonly DoctorCheckId[] = [
  'node-version',
  'npm-version',
  'os',
  'cpu',
  'memory',
  'disk',
  'cli-engines',
  'harness-loopback',
  'harness-port',
  'vault',
  'data-dir',
];
