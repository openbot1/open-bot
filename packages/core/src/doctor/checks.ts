/**
 * Doctor — các check riêng lẻ (v1.06, Đội T3).
 *
 * Mỗi check là một hàm thuần nhận `DoctorEnv` (mọi thứ đọc từ máy
 * đều qua đây) và trả `DoctorCheck` — không throw (lỗi hệ thống bên
 * trong cũng thành `fail` với lý do rõ). `runDoctor` trong doctor.ts
 * chỉ việc gọi lần lượt các check này.
 *
 * `DoctorEnv` mặc định đọc máy thật (process/os/fs/spawn); test
 * truyền env giả để chạy xác định. Riêng check CLI engines: mặc
 * định dùng `DetectedEngineRegistry` (đã có sẵn, hỏi chính CLI bằng
 * lệnh status của nó — không đọc credential); test truyền
 * `engines` giả.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import * as net from 'node:net';

import { DetectedEngineRegistry } from '../detected/registry';
import type { DetectedEnginesSnapshot } from '../detected/types';
import {
  DEFAULT_DOCTOR_HARNESS_PORT,
  DEFAULT_DOCTOR_THRESHOLDS,
  type DoctorCheck,
  type DoctorCheckId,
  type DoctorCheckStatus,
  type DoctorEngineInfo,
  type DoctorThresholds,
} from './types';

/** Mọi thứ một check cần đọc từ máy — inject được toàn bộ. */
export interface DoctorEnv {
  /** Phiên bản Node đang chạy, vd "v24.3.0" (mặc định: process.version). */
  nodeVersion?: string;
  /** Nền tảng, vd "linux" (mặc định: os.platform()). */
  platform?: string;
  /** Kiến trúc CPU, vd "x64" (mặc định: os.arch()). */
  arch?: string;
  /** Phiên bản hệ điều hành (mặc định: os.release()). */
  osRelease?: string;
  /** Số CPU logic (mặc định: os.cpus().length). */
  cpuCount?: number;
  /** Load trung bình 1 phút (mặc định: os.loadavg()[0]). */
  loadAvg1m?: number;
  /** Tổng RAM bytes (mặc định: os.totalmem()). */
  totalmem?: number;
  /** RAM trống bytes (mặc định: os.freemem()). */
  freemem?: number;
  /** Đĩa trống bytes tại dataDir (mặc định: đo bằng `df`, null khi không đo được). */
  diskFreeBytes?: number | null;
  /** Thư mục dữ liệu open-bot (mặc định: ~/.open-bot). */
  dataDir?: string;
  /** Cổng harness cần kiểm tra có trống không (mặc định: 18789). */
  harnessPort?: number;
  /** Chạy một lệnh chỉ-đọc; null khi không chạy được. */
  run?: (command: string, args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string } | null>;
  /** File có tồn tại không (mặc định: fs.existsSync). */
  fileExists?: (filePath: string) => boolean;
  /** Đọc thư mục (mặc định: fs.readdirSync, lỗi → []). */
  readDir?: (dirPath: string) => string[];
  /** Thử bind một cổng loopback (mặc định: net server thật). */
  tryBindLoopback?: (port: number) => Promise<boolean>;
  /** Thử kết nối tới một cổng (true = đang có ai nghe). */
  tryConnect?: (port: number) => Promise<boolean>;
  /** Snapshot engine đã detect sẵn (khi có thì không chạy registry thật). */
  engines?: DetectedEnginesSnapshot | null;
  /** Namespace nào trong vault đang có key (chỉ TÊN namespace, không giá trị). */
  vaultNamespaces?: string[] | null;
  /** Vault file có tồn tại không (mặc định: kiểm tra <dataDir>/vault.json). */
  vaultFileExists?: boolean;
  /** Đồng hồ (test). */
  now?: () => number;
}

function defaultRun(
  command: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string } | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 10_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return resolve(null);
      resolve({ code: err ? (err as NodeJS.ErrnoException).code as unknown as number | null : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

function defaultTryBindLoopback(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

function defaultTryConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    const done = (ok: boolean): void => {
      try {
        socket.destroy();
      } catch {
        /* bỏ qua */
      }
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(2000, () => done(false));
  });
}

/** Điền mặc định cho mọi field còn thiếu của env. */
export function resolveDoctorEnv(env: DoctorEnv = {}): Required<Omit<DoctorEnv, 'engines' | 'vaultNamespaces'>> & Pick<DoctorEnv, 'engines' | 'vaultNamespaces'> {
  const dataDir = env.dataDir ?? path.join(os.homedir(), '.open-bot');
  return {
    nodeVersion: env.nodeVersion ?? process.version,
    platform: env.platform ?? os.platform(),
    arch: env.arch ?? os.arch(),
    osRelease: env.osRelease ?? os.release(),
    cpuCount: env.cpuCount ?? Math.max(os.cpus().length, 1),
    loadAvg1m: env.loadAvg1m ?? os.loadavg()[0] ?? 0,
    totalmem: env.totalmem ?? os.totalmem(),
    freemem: env.freemem ?? os.freemem(),
    diskFreeBytes: env.diskFreeBytes === undefined ? null : env.diskFreeBytes,
    dataDir,
    harnessPort: env.harnessPort ?? DEFAULT_DOCTOR_HARNESS_PORT,
    run: env.run ?? defaultRun,
    fileExists: env.fileExists ?? ((p: string) => fs.existsSync(p)),
    readDir:
      env.readDir ??
      ((p: string) => {
        try {
          return fs.readdirSync(p);
        } catch {
          return [];
        }
      }),
    tryBindLoopback: env.tryBindLoopback ?? defaultTryBindLoopback,
    tryConnect: env.tryConnect ?? defaultTryConnect,
    engines: env.engines ?? null,
    vaultNamespaces: env.vaultNamespaces ?? null,
    vaultFileExists: env.vaultFileExists ?? fs.existsSync(path.join(dataDir, 'vault.json')),
    now: env.now ?? (() => Date.now()),
  };
}

export function parseMajorVersion(version: string): number | null {
  const m = /^v?(\d+)\./.exec(version.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'không rõ';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function makeCheck(
  id: DoctorCheckId,
  label: string,
  status: DoctorCheckStatus,
  detail: string,
  fix: string | undefined,
  startedAt: number,
  now: () => number,
  category: DoctorCheck['category'],
): DoctorCheck {
  return { id, category, label, status, detail, fix, durationMs: Math.max(0, now() - startedAt) };
}

export function checkNodeVersion(
  env: ReturnType<typeof resolveDoctorEnv>,
  thresholds: DoctorThresholds = DEFAULT_DOCTOR_THRESHOLDS,
): DoctorCheck {
  const started = env.now();
  const major = parseMajorVersion(env.nodeVersion);
  if (major === null) {
    return makeCheck('node-version', 'Phiên bản Node.js', 'fail', `không đọc được phiên bản ("${env.nodeVersion}")`, 'Cài Node.js 24 trở lên từ nodejs.org, rồi chạy lại `open-bot doctor`.', started, env.now, 'runtime');
  }
  if (major < thresholds.nodeMinMajor) {
    return makeCheck('node-version', 'Phiên bản Node.js', 'fail', `Node v${major} (cần tối thiểu v${thresholds.nodeMinMajor})`, `Nâng cấp Node lên v${thresholds.nodeRecommendedMajor} trở lên (nvm install ${thresholds.nodeRecommendedMajor} hoặc nodejs.org).`, started, env.now, 'runtime');
  }
  if (major < thresholds.nodeRecommendedMajor) {
    return makeCheck('node-version', 'Phiên bản Node.js', 'warn', `Node v${major} (khuyến nghị v${thresholds.nodeRecommendedMajor}+)`, `Nâng cấp Node lên v${thresholds.nodeRecommendedMajor} để nhận đủ tính năng và bản vá bảo mật.`, started, env.now, 'runtime');
  }
  return makeCheck('node-version', 'Phiên bản Node.js', 'pass', `Node ${env.nodeVersion}`, undefined, started, env.now, 'runtime');
}

export async function checkNpmVersion(env: ReturnType<typeof resolveDoctorEnv>): Promise<DoctorCheck> {
  const started = env.now();
  let result: { code: number | null; stdout: string; stderr: string } | null = null;
  try {
    result = await env.run('npm', ['--version']);
  } catch (err) {
    return makeCheck('npm-version', 'npm', 'fail', `không chạy được \`npm --version\`: ${err instanceof Error ? err.message : String(err)}`, 'Cài lại Node.js (kèm npm) từ nodejs.org.', started, env.now, 'runtime');
  }
  if (result === null || result.code !== 0) {
    return makeCheck('npm-version', 'npm', 'fail', 'không tìm thấy npm trên PATH', 'Cài Node.js (kèm npm) từ nodejs.org và kiểm tra PATH.', started, env.now, 'runtime');
  }
  const version = result.stdout.trim().split(/\s+/)[0] ?? '';
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    return makeCheck('npm-version', 'npm', 'warn', `npm trả về phiên bản lạ: "${version.slice(0, 40)}"`, 'Kiểm tra lại npm: chạy `npm --version` bằng tay.', started, env.now, 'runtime');
  }
  return makeCheck('npm-version', 'npm', 'pass', `npm ${version}`, undefined, started, env.now, 'runtime');
}

export function checkOs(env: ReturnType<typeof resolveDoctorEnv>): DoctorCheck {
  const started = env.now();
  const known = ['linux', 'darwin', 'win32'];
  if (!known.includes(env.platform)) {
    return makeCheck('os', 'Hệ điều hành', 'warn', `nền tảng "${env.platform}" chưa được kiểm chứng với open-bot`, 'Dùng Linux, macOS hoặc Windows để được hỗ trợ đầy đủ; một số tính năng (computer-use, TTS) có thể không chạy.', started, env.now, 'runtime');
  }
  return makeCheck('os', 'Hệ điều hành', 'pass', `${env.platform} ${env.arch} (${env.osRelease})`, undefined, started, env.now, 'runtime');
}

export function checkCpu(env: ReturnType<typeof resolveDoctorEnv>, thresholds: DoctorThresholds = DEFAULT_DOCTOR_THRESHOLDS): DoctorCheck {
  const started = env.now();
  const perCpu = env.cpuCount > 0 ? env.loadAvg1m / env.cpuCount : env.loadAvg1m;
  const detail = `${env.cpuCount} CPU, load 1 phút ${env.loadAvg1m.toFixed(2)} (${perCpu.toFixed(2)}/CPU)`;
  if (perCpu >= thresholds.cpuLoadFailPerCpu) {
    return makeCheck('cpu', 'CPU', 'fail', detail, 'Máy đang quá tải — tắt bớt tiến trình nặng rồi chạy lại; bot có thể chạy rất chậm hoặc timeout.', started, env.now, 'resources');
  }
  if (perCpu >= thresholds.cpuLoadWarnPerCpu) {
    return makeCheck('cpu', 'CPU', 'warn', detail, 'Máy đang tải cao — nên đợi tải giảm trước khi chạy bot nặng hoặc model local.', started, env.now, 'resources');
  }
  return makeCheck('cpu', 'CPU', 'pass', detail, undefined, started, env.now, 'resources');
}

export function checkMemory(env: ReturnType<typeof resolveDoctorEnv>, thresholds: DoctorThresholds = DEFAULT_DOCTOR_THRESHOLDS): DoctorCheck {
  const started = env.now();
  const detail = `RAM trống ${formatBytes(env.freemem)} / tổng ${formatBytes(env.totalmem)}`;
  if (env.freemem < thresholds.memoryMinFreeBytes) {
    return makeCheck('memory', 'Bộ nhớ RAM', 'fail', detail, 'Giải phóng RAM (tắt app nặng) — dưới 256 MB trống, model local và bot dễ crash vì hết RAM.', started, env.now, 'resources');
  }
  if (env.freemem < thresholds.memoryWarnFreeBytes) {
    return makeCheck('memory', 'Bộ nhớ RAM', 'warn', detail, 'RAM trống thấp — tránh chạy nhiều bot/model local cùng lúc.', started, env.now, 'resources');
  }
  return makeCheck('memory', 'Bộ nhớ RAM', 'pass', detail, undefined, started, env.now, 'resources');
}

export async function checkDisk(env: ReturnType<typeof resolveDoctorEnv>, thresholds: DoctorThresholds = DEFAULT_DOCTOR_THRESHOLDS): Promise<DoctorCheck> {
  const started = env.now();
  let free = env.diskFreeBytes;
  if (free === null || free === undefined) {
    // Đo bằng `df` (POSIX); Windows / môi trường lạ thì bỏ qua, không bịa số.
    try {
      const result = await env.run('df', ['-k', env.dataDir]);
      if (result && result.code === 0) {
        const lines = result.stdout.trim().split('\n');
        const last = lines[lines.length - 1] ?? '';
        const fields = last.trim().split(/\s+/);
        const availableKb = Number(fields[3]);
        if (Number.isFinite(availableKb)) free = availableKb * 1024;
      }
    } catch {
      free = null;
    }
  }
  if (free === null || free === undefined || !Number.isFinite(free)) {
    return makeCheck('disk', 'Dung lượng đĩa', 'warn', `không đo được đĩa trống tại ${env.dataDir}`, 'Kiểm tra bằng tay: `df -h` (Linux/macOS) và dọn bớt nếu dưới 5 GB trống.', started, env.now, 'resources');
  }
  const detail = `đĩa trống ${formatBytes(free)} tại ${env.dataDir}`;
  if (free < thresholds.diskMinFreeBytes) {
    return makeCheck('disk', 'Dung lượng đĩa', 'fail', detail, 'Dọn đĩa ngay (dưới 1 GB trống) — bot không ghi được log/memory và dễ crash.', started, env.now, 'resources');
  }
  if (free < thresholds.diskWarnFreeBytes) {
    return makeCheck('disk', 'Dung lượng đĩa', 'warn', detail, 'Đĩa sắp đầy — dọn bớt file/log cũ, giữ ít nhất 5 GB trống.', started, env.now, 'resources');
  }
  return makeCheck('disk', 'Dung lượng đĩa', 'pass', detail, undefined, started, env.now, 'resources');
}

/** Tóm tắt engine từ snapshot của DetectedEngineRegistry. */
export function enginesFromSnapshot(snapshot: DetectedEnginesSnapshot | null): DoctorEngineInfo[] {
  if (!snapshot) return [];
  return Object.values(snapshot.engines).map((e) => ({
    kind: e.kind,
    label: e.label,
    installed: e.binaryPath !== null,
    version: e.version,
    signedIn: e.status === 'available' ? true : e.status === 'unavailable' ? false : null,
    accountLabel: e.account?.label,
    enabled: e.enabled,
    reason: e.reason,
  }));
}

export async function checkCliEngines(env: ReturnType<typeof resolveDoctorEnv>): Promise<DoctorCheck> {
  const started = env.now();
  let snapshot: DetectedEnginesSnapshot | null = env.engines ?? null;
  if (snapshot === null) {
    try {
      const registry = new DetectedEngineRegistry({ stateFilePath: path.join(env.dataDir, 'detected-engines.json') });
      snapshot = await registry.detect();
    } catch (err) {
      return makeCheck('cli-engines', 'CLI agent đã đăng nhập', 'warn', `không quét được CLI: ${err instanceof Error ? err.message : String(err)}`, 'Chạy lại `open-bot doctor`; nếu vẫn lỗi, kiểm tra quyền chạy các CLI trên PATH.', started, env.now, 'cli');
    }
  }
  const engines = enginesFromSnapshot(snapshot);
  const installed = engines.filter((e) => e.installed);
  const signedIn = engines.filter((e) => e.installed && e.signedIn === true);
  const enabledSignedIn = signedIn.filter((e) => e.enabled);
  if (installed.length === 0) {
    return makeCheck(
      'cli-engines',
      'CLI agent đã đăng nhập',
      'warn',
      'không tìm thấy CLI agent nào (Claude Code, Codex, OpenCode, Gemini CLI, Cursor…)',
      'Cài ít nhất một CLI agent và đăng nhập bằng chính CLI đó (vd `claude` rồi đăng nhập), hoặc dùng provider API key trong Settings — open-bot vẫn chạy được bằng API key/Ollama.',
      started,
      env.now,
      'cli',
    );
  }
  if (signedIn.length === 0) {
    const names = installed.map((e) => `${e.label}${e.version ? ` ${e.version}` : ''}`).join(', ');
    return makeCheck(
      'cli-engines',
      'CLI agent đã đăng nhập',
      'warn',
      `đã cài ${names} nhưng chưa CLI nào đăng nhập`,
      'Đăng nhập bằng chính CLI đó (vd `claude` → đăng nhập, `codex login`), rồi chạy lại doctor.',
      started,
      env.now,
      'cli',
    );
  }
  const detail = signedIn
    .map((e) => `${e.label}${e.version ? ` ${e.version}` : ''}${e.accountLabel ? ` (${e.accountLabel})` : ''}${e.enabled ? '' : ' [chưa bật]'}`)
    .join(', ');
  if (enabledSignedIn.length === 0) {
    return makeCheck(
      'cli-engines',
      'CLI agent đã đăng nhập',
      'warn',
      `đã đăng nhập: ${detail} — nhưng chưa bật nguồn nào trong Settings → Engines`,
      'Bật ít nhất một nguồn trong Settings → Engines để bot được mượn model/tài khoản đã đăng nhập (mặc định tắt để an toàn).',
      started,
      env.now,
      'cli',
    );
  }
  return makeCheck('cli-engines', 'CLI agent đã đăng nhập', 'pass', `đã đăng nhập và đã bật: ${enabledSignedIn.map((e) => e.label).join(', ')}`, undefined, started, env.now, 'cli');
}

export async function checkHarnessLoopback(env: ReturnType<typeof resolveDoctorEnv>): Promise<DoctorCheck> {
  const started = env.now();
  let ok = false;
  try {
    ok = await env.tryBindLoopback(0);
  } catch {
    ok = false;
  }
  if (!ok) {
    return makeCheck('harness-loopback', 'Harness server (loopback)', 'fail', 'không bind được cổng loopback 127.0.0.1', 'Kiểm tra firewall/tường lửa có chặn loopback không; harness server chỉ bind 127.0.0.1 nên không thể chạy nếu loopback bị chặn.', started, env.now, 'harness');
  }
  return makeCheck('harness-loopback', 'Harness server (loopback)', 'pass', 'bind được 127.0.0.1 (harness server có thể khởi động)', undefined, started, env.now, 'harness');
}

export async function checkHarnessPort(env: ReturnType<typeof resolveDoctorEnv>): Promise<DoctorCheck> {
  const started = env.now();
  const port = env.harnessPort;
  let occupied = false;
  try {
    occupied = await env.tryConnect(port);
  } catch {
    occupied = false;
  }
  if (occupied) {
    return makeCheck('harness-port', `Cổng harness ${port}`, 'warn', `cổng ${port} đang có tiến trình khác nghe`, `Đổi cổng harness (Settings → Harness) hoặc dừng tiến trình đang chiếm cổng ${port} rồi chạy lại.`, started, env.now, 'harness');
  }
  return makeCheck('harness-port', `Cổng harness ${port}`, 'pass', `cổng ${port} đang trống`, undefined, started, env.now, 'harness');
}

export function checkVault(env: ReturnType<typeof resolveDoctorEnv>): DoctorCheck {
  const started = env.now();
  if (!env.vaultFileExists) {
    return makeCheck('vault', 'Vault (khoá API)', 'warn', 'chưa có file vault — chưa lưu key nào', 'Nhập API key trong Settings (Grok/OpenAI/Anthropic/Gemini…) hoặc đăng nhập một CLI agent để dùng model của nó; vault được tạo khi lưu key đầu tiên.', started, env.now, 'vault');
  }
  if (env.vaultNamespaces && env.vaultNamespaces.length > 0) {
    return makeCheck('vault', 'Vault (khoá API)', 'pass', `vault có key ở ${env.vaultNamespaces.length} nhóm: ${env.vaultNamespaces.join(', ')}`, undefined, started, env.now, 'vault');
  }
  return makeCheck('vault', 'Vault (khoá API)', 'pass', 'file vault đã có (chưa liệt kê được nhóm key — cần mở khoá để đếm)', undefined, started, env.now, 'vault');
}

export function checkDataDir(env: ReturnType<typeof resolveDoctorEnv>): DoctorCheck {
  const started = env.now();
  if (!env.fileExists(env.dataDir)) {
    return makeCheck('data-dir', 'Thư mục dữ liệu', 'warn', `thư mục ${env.dataDir} chưa tồn tại (sẽ được tạo khi lưu bot đầu tiên)`, 'Tạo một bot trong app (hoặc chạy `open-bot run --provider mock …`) để khởi tạo thư mục dữ liệu.', started, env.now, 'data');
  }
  const files = env.readDir(env.dataDir);
  const interesting = ['bots.json', 'team.json', 'detected-engines.json', 'routines-v2.json'].filter((f) => files.includes(f));
  return makeCheck(
    'data-dir',
    'Thư mục dữ liệu',
    'pass',
    `${env.dataDir} (${files.length} mục${interesting.length > 0 ? `, có ${interesting.join(', ')}` : ', chưa có bot nào'})`,
    undefined,
    started,
    env.now,
    'data',
  );
}
