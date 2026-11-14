/**
 * Driver registry (v1.06, Đội T3) — public surface of packages/core/src/drivers/.
 *
 * Đăng ký CLI binary tuỳ chỉnh (đường dẫn + cách gọi + định dạng
 * stream JSON/JSON-RPC/ACP/NDJSON), test kết nối, bật/tắt từng driver.
 * Xem types.ts / registry.ts / probe.ts.
 */
export { DriverRegistry, getDriverStateFilePath, validateDriverInput } from './registry';
export type { DriverRegistryOptions } from './registry';
export { probeDriver, parseVersionFromOutput, DRIVER_PROBE_TIMEOUT_MS, DRIVER_PROBE_PREVIEW_CHARS } from './probe';
export type { DriverProbeDeps } from './probe';
export { DRIVER_STREAM_FORMATS, CLI_DRIVERS_FILE } from './types';
export type {
  CliDriverConfig,
  CliDriversStateFile,
  DriverProbeResult,
  DriverStreamFormat,
  RegisterDriverInput,
} from './types';
