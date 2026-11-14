/**
 * Driver probe — test kết nối một driver CLI tuỳ chỉnh (v1.06, Đội T3).
 *
 * Chạy binary với `versionArgs` (mặc định `--version`), đọc version
 * từ stdout/stderr; nếu driver khai `probeArgs` thì chạy thêm lệnh
 * đó để kiểm tra đăng nhập. Chỉ ĐỌC: không gửi prompt, không ghi
 * file, không truyền secret. Timeout mặc định 10 s; quá hạn thì fail
 * rõ thay vì treo.
 *
 * `spawnFn` inject được để test chạy xác định (không spawn thật).
 */

import { execFile } from 'node:child_process';

import type { CliDriverConfig, DriverProbeResult } from './types';

export const DRIVER_PROBE_TIMEOUT_MS = 10_000;
/** Stdout giữ lại tối đa bao nhiêu ký tự trong preview (đủ debug, không tràn log). */
export const DRIVER_PROBE_PREVIEW_CHARS = 500;

export interface DriverProbeDeps {
  /** Spawn một lệnh chỉ-đọc; null khi binary không chạy được. */
  spawn?: (
    binaryPath: string,
    args: string[],
    timeoutMs: number,
  ) => Promise<{ code: number | null; stdout: string; stderr: string } | null>;
  /** Đồng hồ (test). */
  now?: () => number;
  /** Timeout mỗi lệnh (ms). */
  timeoutMs?: number;
}

function defaultSpawn(
  binaryPath: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string } | null> {
  return new Promise((resolve) => {
    execFile(binaryPath, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return resolve(null);
      const code = err ? ((err as NodeJS.ErrnoException).code as unknown as number | null) ?? 1 : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/** Đọc version từ output: số phiên bản đầu tiên dạng x.y[.z] (vd "1.2.3", "v0.9"). */
export function parseVersionFromOutput(output: string): string | null {
  const m = /v?(\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9.]+)?)/.exec(output);
  return m ? m[1] ?? null : null;
}

function preview(text: string): string {
  const trimmed = text.trim().slice(0, DRIVER_PROBE_PREVIEW_CHARS);
  return trimmed;
}

export async function probeDriver(driver: CliDriverConfig, deps: DriverProbeDeps = {}): Promise<DriverProbeResult> {
  const spawn = deps.spawn ?? defaultSpawn;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? DRIVER_PROBE_TIMEOUT_MS;
  const started = now();
  const latency = (): number => Math.max(0, now() - started);

  let versionOut: { code: number | null; stdout: string; stderr: string } | null = null;
  try {
    versionOut = await spawn(driver.binaryPath, [...driver.argv, ...driver.versionArgs], timeoutMs);
  } catch (err) {
    return {
      driverId: driver.id,
      ok: false,
      version: null,
      binaryFound: false,
      signedIn: null,
      latencyMs: latency(),
      error: `không chạy được binary "${driver.binaryPath}": ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
    };
  }
  if (versionOut === null) {
    return {
      driverId: driver.id,
      ok: false,
      version: null,
      binaryFound: false,
      signedIn: null,
      latencyMs: latency(),
      error: `không tìm thấy binary "${driver.binaryPath}" — kiểm tra lại đường dẫn hoặc PATH.`,
    };
  }
  const combined = `${versionOut.stdout}\n${versionOut.stderr}`;
  const version = parseVersionFromOutput(combined);
  if (versionOut.code !== 0) {
    return {
      driverId: driver.id,
      ok: false,
      version,
      binaryFound: true,
      signedIn: null,
      latencyMs: latency(),
      error: `lệnh version trả exit code ${versionOut.code}: ${preview(combined) || '(không có output)'}`.slice(0, 300),
      stdoutPreview: preview(combined) || undefined,
    };
  }
  if (version === null) {
    return {
      driverId: driver.id,
      ok: false,
      version: null,
      binaryFound: true,
      signedIn: null,
      latencyMs: latency(),
      error: 'binary chạy được nhưng không đọc được version từ output — kiểm tra lại versionArgs.',
      stdoutPreview: preview(combined) || undefined,
    };
  }
  let signedIn: boolean | null = null;
  if (driver.probeArgs && driver.probeArgs.length > 0) {
    let probeOut: { code: number | null; stdout: string; stderr: string } | null = null;
    try {
      probeOut = await spawn(driver.binaryPath, [...driver.argv, ...driver.probeArgs], timeoutMs);
    } catch {
      probeOut = null;
    }
    // probeArgs fail = chưa đăng nhập / chưa kiểm chứng được — driver
    // vẫn "ok" (binary tốt), chỉ báo signedIn = false.
    signedIn = probeOut !== null && probeOut.code === 0;
  }
  return {
    driverId: driver.id,
    ok: true,
    version,
    binaryFound: true,
    signedIn,
    latencyMs: latency(),
    stdoutPreview: preview(combined) || undefined,
  };
}
