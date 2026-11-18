/**
 * Eval Harness v2 — rollout worker sandbox (v1.34, Đội T4).
 *
 * Worker stateless, local-first: mỗi trial chạy trong một workdir tạm
 * riêng, lệnh test/oracle/agent chạy qua lớp này.
 *
 * Cách ly (theo thứ tự ưu tiên):
 * 1. `bwrap` (bubblewrap) khi có trên máy: bind workdir + ro-bind hệ
 *    thống (/usr, /lib, /lib64, /bin), --unshare-net (loopback-only,
 *    không mạng ngoài), --die-with-parent, --proc /proc, --dev /dev,
 *    --tmpfs /tmp. Exit code của tiến trình con được bwrap truyền
 *    thẳng ra nên pass/fail của test không bị lẫn với lỗi sandbox.
 *    Nếu kernel/VM từ chối lập netns mới (--unshare-net chết ở
 *    "loopback: Failed RTM_NEWADDR") thì thử lại không có --unshare-net
 *    (vẫn cách ly mount, chỉ mất cách ly mạng — ghi vào sandboxWarning);
 *    chỉ khi bwrap hoàn toàn không dựng được mới fallback local.
 * 2. Fallback chạy local trực tiếp khi không có bwrap (hoặc bwrap lỗi
 *    lúc probe) — kết quả vẫn đúng nhưng kèm `sandboxed: false` +
 *    `sandboxWarning` để runner/scorer/UI báo rõ, không giả vờ đã
 *    cách ly. Đây là fallback có cảnh báo, không phải cách ly thật.
 * Lỗi dựng sandbox (stderr của chính bwrap, lệnh chưa chạy) KHÔNG BAO
 * GIỜ được báo thành test fail — phân biệt bằng isBwrapSetupFailure.
 *
 * Timeout: kill cả process group (SIGKILL) khi quá hạn; kết quả ghi
 * `timedOut: true`. Output cắt ngắn (mặc định 8_000 ký tự) để report
 * không phình.
 *
 * LƯU Ý: đây là sandbox nhẹ cho eval mẫu local-first, KHÔNG thay
 * BotBoxManager (packages/core/src/sandbox/box.ts) dùng cho agent thật.
 * Khi cần cách ly mạnh (cgroup, quota, audit), caller nên chạy trial
 * qua BotBoxManager thay vì gọi trực tiếp module này.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const EVAL_HARNESS_V2_MAX_OUTPUT_CHARS = 8_000;

/** Kết quả chạy một lệnh trong sandbox. */
export interface EvalHarnessV2SandboxResult {
  /** Exit code (null khi bị kill/timeout hoặc spawn lỗi). */
  exitCode: number | null;
  /** true khi exitCode === 0. */
  passed: boolean;
  stdout: string;
  stderr: string;
  /** Thời gian chạy (ms). */
  durationMs: number;
  /** true khi bị kill vì quá timeout. */
  timedOut: boolean;
  /** true khi chạy qua bwrap; false = fallback local (xem sandboxWarning). */
  sandboxed: boolean;
  /** Cảnh báo khi fallback local hoặc bwrap lỗi. */
  sandboxWarning?: string;
  /** Lệnh đã chạy (dạng hiển thị, để debug). */
  command: string;
}

let bwrapProbeCache: boolean | null = null;

/** Probe `bwrap` trong PATH một lần rồi cache (tránh kiểm tra mỗi lệnh). */
export function isBwrapAvailable(): boolean {
  if (bwrapProbeCache !== null) return bwrapProbeCache;
  const pathDirs = (process.env['PATH'] ?? '').split(path.delimiter);
  let found = false;
  for (const dir of pathDirs) {
    try {
      if (dir !== '' && fs.existsSync(path.join(dir, 'bwrap'))) {
        found = true;
        break;
      }
    } catch {
      // Thư mục PATH không đọc được — bỏ qua.
    }
  }
  bwrapProbeCache = found;
  return found;
}

/** Reset cache probe (dùng trong test). */
export function resetBwrapProbeCache(): void {
  bwrapProbeCache = null;
}

function truncate(text: string, max = EVAL_HARNESS_V2_MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... (cắt ngắn, còn ${text.length - max} ký tự)`;
}

function runLocal(
  command: string,
  workDir: string,
  timeoutMs: number,
): Promise<Omit<EvalHarnessV2SandboxResult, 'sandboxed' | 'sandboxWarning' | 'command'>> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = execFile('sh', ['-c', command], {
      cwd: workDir,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      killSignal: 'SIGKILL',
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.on('data', (d: Buffer | string) => {
      stdout += String(d);
    });
    child.stderr?.on('data', (d: Buffer | string) => {
      stderr += String(d);
    });
    child.on('error', (err: Error & { code?: string }) => {
      resolve({
        exitCode: null,
        passed: false,
        stdout: truncate(stdout),
        stderr: truncate(stderr || err.message),
        durationMs: Date.now() - started,
        timedOut: false,
      });
    });
    child.on('close', (code, signal) => {
      timedOut = signal === 'SIGKILL' || signal === 'SIGTERM';
      resolve({
        exitCode: code,
        passed: code === 0,
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        durationMs: Date.now() - started,
        timedOut,
      });
    });
  });
}

function runBwrap(
  command: string,
  workDir: string,
  timeoutMs: number,
  opts: { unshareNet?: boolean } = {},
): Promise<Omit<EvalHarnessV2SandboxResult, 'sandboxed' | 'sandboxWarning' | 'command'>> {
  const started = Date.now();
  // THỨ TỰ QUAN TRỌNG: --tmpfs /tmp PHẢI đứng trước --bind workDir —
  // workdir trial nằm dưới os.tmpdir() (/tmp), tmpfs mount sau sẽ che
  // mất bind workdir và bwrap chết ở chdir ("Can't chdir ...").
  // --unshare-net: khi kernel/VM từ chối lập loopback trong netns mới
  // ("loopback: Failed RTM_NEWADDR") thì caller thử lại không có nó —
  // vẫn cách ly bằng mount, chỉ mất cách ly mạng (ghi vào warning).
  const args = [
    ...(opts.unshareNet === false ? [] : ['--unshare-net']),
    '--die-with-parent',
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/lib', '/lib',
    '--ro-bind', '/lib64', '/lib64',
    '--ro-bind', '/bin', '/bin',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--bind', workDir, workDir,
    '--chdir', workDir,
    'sh', '-c', command,
  ];
  return new Promise((resolve) => {
    const child = execFile('bwrap', args, {
      cwd: workDir,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      killSignal: 'SIGKILL',
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer | string) => {
      stdout += String(d);
    });
    child.stderr?.on('data', (d: Buffer | string) => {
      stderr += String(d);
    });
    child.on('error', (err: Error) => {
      resolve({
        exitCode: null,
        passed: false,
        stdout: truncate(stdout),
        stderr: truncate(stderr || err.message),
        durationMs: Date.now() - started,
        timedOut: false,
      });
    });
    child.on('close', (code, signal) => {
      resolve({
        exitCode: code,
        // bwrap trả exit code của con; bwrap lỗi namespace trả 1 kèm
        // stderr 'Creating new namespace failed' — caller phân biệt
        // bằng cách kiểm tra stderr, không đoán ở đây.
        passed: code === 0,
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        durationMs: Date.now() - started,
        timedOut: signal === 'SIGKILL' || signal === 'SIGTERM',
      });
    });
  });
}

/**
 * true khi bwrap chết ở khâu dựng sandbox (lệnh chưa hề chạy): exit != 0
 * và stderr là thông báo của chính bwrap (vd "bwrap: loopback: Failed
 * RTM_NEWADDR", "bwrap: Creating new namespace failed"). Lệnh chạy rồi
 * fail thì stderr là của lệnh, không khớp — không được nhầm thành lỗi
 * setup (ngược lại sẽ chạy lại lệnh 2 lần và giấu kết quả fail thật).
 */
function isBwrapSetupFailure(
  result: Omit<EvalHarnessV2SandboxResult, 'sandboxed' | 'sandboxWarning' | 'command'>,
): boolean {
  if (result.exitCode === 0) return false;
  const first = result.stderr.split('\n').find((l) => l.trim() !== '');
  return first !== undefined && first.trimStart().startsWith('bwrap:');
}

/**
 * Chạy một lệnh shell trong workdir, qua bwrap khi có, fallback local
 * có cảnh báo khi không có. Không bao giờ throw vì lệnh fail — fail
 * là kết quả (exitCode != 0), chỉ throw khi workdir không tồn tại.
 */
export async function runInEvalSandbox(
  command: string,
  workDir: string,
  timeoutMs: number,
): Promise<EvalHarnessV2SandboxResult> {
  if (!fs.existsSync(workDir) || !fs.statSync(workDir).isDirectory()) {
    throw new Error(`Eval sandbox cần workdir tồn tại: "${workDir}".`);
  }
  if (isBwrapAvailable()) {
    const result = await runBwrap(command, workDir, timeoutMs);
    if (isBwrapSetupFailure(result)) {
      // bwrap không dựng được sandbox (vd kernel/VM từ chối netns mới,
      // "loopback: Failed RTM_NEWADDR"): thử lại KHÔNG --unshare-net —
      // vẫn cách ly bằng mount, chỉ mất cách ly mạng (ghi rõ warning).
      // KHÔNG được báo lỗi setup này thành "test fail": lệnh chưa chạy.
      const noNet = await runBwrap(command, workDir, timeoutMs, { unshareNet: false });
      if (!isBwrapSetupFailure(noNet)) {
        return {
          ...noNet,
          sandboxed: true,
          sandboxWarning:
            'bwrap --unshare-net không dùng được trên máy này nên chạy không cách ly mạng (vẫn cách ly mount): ' +
            (result.stderr.split('\n')[0] ?? '').slice(0, 200),
          command,
        };
      }
      const local = await runLocal(command, workDir, timeoutMs);
      return {
        ...local,
        sandboxed: false,
        sandboxWarning:
          'bwrap không dựng được sandbox nên chạy fallback local (không cách ly): ' +
          (noNet.stderr.split('\n')[0] ?? '').slice(0, 200),
        command,
      };
    }
    return { ...result, sandboxed: true, command };
  }
  const local = await runLocal(command, workDir, timeoutMs);
  return {
    ...local,
    sandboxed: false,
    sandboxWarning:
      'Không có bwrap trên máy — trial chạy local trực tiếp, KHÔNG cách ly. ' +
      'Cài bubblewrap để chạy sandbox thật.',
    command,
  };
}

/** Ghi map file vào workdir (tạo thư mục con khi cần, chặn path thoát). */
export function writeFilesToWorkDir(
  workDir: string,
  files: Record<string, string>,
): string[] {
  const written: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const target = path.resolve(workDir, rel);
    if (!target.startsWith(path.resolve(workDir) + path.sep) && target !== path.resolve(workDir)) {
      throw new Error(`Từ chối ghi file thoát khỏi workdir: "${rel}".`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
    written.push(rel);
  }
  return written;
}

/** Tạo workdir tạm cho một trial (mkdtemp dưới os.tmpdir). */
export function createEvalTrialWorkDir(prefix = 'eval-harness-v2-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Xoá workdir tạm (bỏ qua lỗi — dọn dẹp không được làm hỏng kết quả). */
export function removeEvalTrialWorkDir(workDir: string): void {
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    // Bỏ qua.
  }
}
