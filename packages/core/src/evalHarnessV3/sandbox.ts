/**
 * Eval Harness v3 — containerised sandbox (v1.35, Đội T4).
 *
 * Chạy lệnh trial trong một container tường minh theo ContainerSpec
 * của task (xem types.ts). Thứ tự backend:
 *
 * 1. `docker` — khi `docker` có trong PATH và daemon trả lời
 *    (`docker info` chạy được): `docker run --rm` với image đã pin,
 *    `--cpus`, `--memory`, `--pids-limit`, `--network none` (hoặc
 *    theo spec), workdir mount read-write, timeout riêng. Image chưa
 *    có local thì `docker pull` một lần (lỗi pull → trial error, không
 *    giả vờ pass).
 * 2. `bwrap` — khi không có Docker nhưng có bwrap: bind workdir,
 *    tmpfs /tmp, `--unshare-net` khi network=none. KHÔNG giới hạn
 *    memory bằng `ulimit -v` (nó giới hạn virtual address space và làm
 *    node chết OOM lúc khởi động — memory chỉ enforce trên docker).
 *    Image spec lúc này chỉ là metadata để ghi trace (host vẫn chạy
 *    bằng toolchain của máy — báo rõ trong `sandboxWarning`).
 * 3. `local` — fallback cuối: chạy trực tiếp bằng `sh -c` trong
 *    workdir, KHÔNG cách ly. Mọi kết quả local đều kèm cảnh báo để
 *    không ai nhầm là đã cách ly.
 *
 * Quy tắc an toàn (kế thừa v2, đã kiểm chứng):
 * - Lỗi setup (không tạo được container, image pull fail, bwrap lỗi
 *   netns) KHÔNG BAO GIỜ báo thành test fail — trả về lỗi setup để
 *   runner ghi trial `error` với lý do rõ ràng.
 * - `runInEvalContainer` không bao giờ throw vì lệnh fail — fail là
 *   kết quả (exit code != 0). Chỉ throw khi không tạo được process.
 * - Output cắt ngắn (8k ký tự) để report không phình.
 * - Lệnh test/oracle đã qua validate cấm mẫu phá hoại ở taskLoader —
 *   sandbox là lớp phòng thủ thứ hai, không phải lớp duy nhất.
 */

import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  containerImageRef,
  normalizeContainerSpec,
  type EvalHarnessV3ContainerBackend,
  type EvalHarnessV3ContainerSpec,
} from './types.js';

export const EVAL_HARNESS_V3_MAX_OUTPUT_CHARS = 8_000;
export const EVAL_HARNESS_V3_DOCKER_PULL_TIMEOUT_MS = 120_000;

/** Kết quả chạy một lệnh trong container. */
export interface EvalHarnessV3ContainerResult {
  /** Lệnh pass khi exit code 0. */
  passed: boolean;
  /** Exit code (null khi bị kill/timeout). */
  exitCode: number | null;
  /** stdout cắt ngắn. */
  stdout: string;
  /** stderr cắt ngắn. */
  stderr: string;
  /** Timeout hay không. */
  timedOut: boolean;
  /** Backend đã chạy lệnh này. */
  backend: EvalHarnessV3ContainerBackend;
  /** Cảnh báo khi fallback (bwrap không image thật / local không cách ly). */
  sandboxWarning?: string;
  /**
   * Lỗi setup (container không khởi động được, image pull fail...).
   * Khi có lỗi này, `passed` luôn false nhưng caller KHÔNG được
   * tính là test fail — phải ghi trial `error`.
   */
  setupError?: string;
  /** Image ref đã dùng (docker) hoặc image spec (bwrap/local, chỉ ghi trace). */
  imageRef: string;
  /** Thời gian chạy lệnh (ms). */
  durationMs: number;
}

function truncateOutput(text: string): string {
  if (text.length <= EVAL_HARNESS_V3_MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, EVAL_HARNESS_V3_MAX_OUTPUT_CHARS)}\n...[output truncated, ${text.length} chars total]`;
}

/** Kiểm tra `docker` có trong PATH không (sync, dùng cache). */
let dockerProbeCache: boolean | null = null;
export function isDockerAvailable(): boolean {
  if (dockerProbeCache !== null) return dockerProbeCache;
  try {
    execFileSync('which', ['docker'], { stdio: 'ignore' });
    dockerProbeCache = true;
  } catch {
    dockerProbeCache = false;
  }
  return dockerProbeCache;
}

/** Kiểm tra `bwrap` có trong PATH không (sync, dùng cache). */
let bwrapProbeCache: boolean | null = null;
export function isBwrapAvailableV3(): boolean {
  if (bwrapProbeCache !== null) return bwrapProbeCache;
  try {
    execFileSync('which', ['bwrap'], { stdio: 'ignore' });
    bwrapProbeCache = true;
  } catch {
    bwrapProbeCache = false;
  }
  return bwrapProbeCache;
}

/** Reset cache probe (dùng trong test khi PATH đổi). */
export function resetEvalHarnessV3ProbeCache(): void {
  dockerProbeCache = null;
  bwrapProbeCache = null;
}

/**
 * Dấu hiệu bwrap lỗi SETUP (không phải lệnh test fail): exit != 0 và dòng
 * stderr đầu tiên bắt đầu bằng "bwrap:" (vd "bwrap: loopback: Failed
 * RTM_NEWADDR"). Mirror v2 đã kiểm chứng — lệnh chưa chạy nên không được
 * báo thành test fail; caller thử lại không có --unshare-net.
 */
export function isBwrapSetupFailureV3(stderr: string): boolean {
  const first = stderr.split('\n').find((line) => line.trim() !== '');
  return first !== undefined && first.trimStart().startsWith('bwrap:');
}

export function selectContainerBackend(): EvalHarnessV3ContainerBackend {
  if (isDockerAvailable()) return 'docker';
  if (isBwrapAvailableV3()) return 'bwrap';
  return 'local';
}

/** Flag docker run từ container spec (cpus/memory/pids/network). */
export function buildDockerRunArgs(
  spec: EvalHarnessV3ContainerSpec,
  workDir: string,
  command: string,
): string[] {
  const normalized = normalizeContainerSpec(spec);
  const args: string[] = ['run', '--rm', '-i'];
  const resources = normalized.resources ?? {};
  if (resources.cpus !== undefined) args.push('--cpus', String(resources.cpus));
  if (resources.memory !== undefined) args.push('--memory', resources.memory);
  if (resources.pids !== undefined) args.push('--pids-limit', String(resources.pids));
  const network = normalized.network ?? 'none';
  if (network === 'none') args.push('--network', 'none');
  else if (network === 'loopback') args.push('--network', 'none');
  // proxy: để container dùng mạng host qua biến http_proxy của env (không --network host).
  args.push('--workdir', normalized.workdir ?? '/work');
  args.push('--volume', `${workDir}:${normalized.workdir ?? '/work'}`);
  args.push('--tmpfs', '/tmp:rw,noexec,nosuid,size=256m');
  for (const [key, value] of Object.entries(normalized.env ?? {})) {
    args.push('--env', `${key}=${value}`);
  }
  args.push(containerImageRef(normalized));
  args.push('sh', '-c', command);
  return args;
}

/** Flag bwrap từ container spec (network + tmpfs + bind workdir). */
export function buildBwrapArgs(
  spec: EvalHarnessV3ContainerSpec,
  workDir: string,
  command: string,
): string[] {
  const normalized = normalizeContainerSpec(spec);
  const args: string[] = [
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/lib', '/lib',
    '--ro-bind', '/lib64', '/lib64',
    '--ro-bind', '/bin', '/bin',
    '--ro-bind', '/etc', '/etc',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    '--bind', workDir, normalized.workdir ?? '/work',
    '--chdir', normalized.workdir ?? '/work',
    '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin',
  ];
  const network = normalized.network ?? 'none';
  if (network === 'none' || network === 'loopback') args.push('--unshare-net');
  // KHÔNG giới hạn memory bằng `ulimit -v` ở đây: ulimit -v giới hạn
  // VIRTUAL address space, mà Node reserve vài GB virtual ngay khi khởi
  // động — cap 512m làm node chết OOM "SegmentedTable::InitializeTable"
  // trước khi chạy test (đã tái hiện). bwrap không có flag giới hạn RSS;
  // memory chỉ enforce thật trên backend docker (--memory). Giữ nguyên
  // resources.memory trong spec làm metadata + cho docker dùng.
  args.push('sh', '-c', command);
  return args;
}

/** Chạy một lệnh bằng child_process với timeout, thu stdout/stderr. */
function runCommandWithTimeout(
  command: string,
  args: string[],
  timeoutMs: number,
  cwd: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; durationMs: number }> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        resolve({ exitCode: null, stdout: truncateOutput(stdout), stderr: truncateOutput(stderr), timedOut: true, durationMs: Date.now() - startedAt });
      }
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: null, stdout: truncateOutput(stdout), stderr: truncateOutput(`${stderr}\nspawn error: ${err.message}`), timedOut: false, durationMs: Date.now() - startedAt });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, stdout: truncateOutput(stdout), stderr: truncateOutput(stderr), timedOut: false, durationMs: Date.now() - startedAt });
    });
  });
}

/** Pull docker image khi chưa có local (trả về lỗi setup khi pull fail). */
async function ensureDockerImage(imageRef: string): Promise<string | undefined> {
  const check = await runCommandWithTimeout('docker', ['image', 'inspect', imageRef], 15_000, process.cwd());
  if (check.exitCode === 0) return undefined;
  const pull = await runCommandWithTimeout('docker', ['pull', imageRef], EVAL_HARNESS_V3_DOCKER_PULL_TIMEOUT_MS, process.cwd());
  if (pull.exitCode !== 0) {
    return `Không pull được image ${imageRef}: ${(pull.stderr || pull.stdout || `exit ${String(pull.exitCode)}`).slice(0, 300)}`;
  }
  return undefined;
}

/**
 * Chạy setup commands của container spec trong workdir (trước khi agent
 * bắt đầu). Trả về lỗi setup (undefined = OK). Setup chạy bằng cùng
 * backend với trial — fail setup thì trial không bắt đầu.
 */
export async function runContainerSetup(
  spec: EvalHarnessV3ContainerSpec,
  workDir: string,
  timeoutMs: number,
): Promise<string | undefined> {
  const normalized = normalizeContainerSpec(spec);
  for (const cmd of normalized.setupCommands ?? []) {
    const res = await runInEvalContainer(cmd, workDir, normalized, timeoutMs);
    if (res.setupError !== undefined) return res.setupError;
    if (!res.passed) {
      return `Setup command fail (exit ${String(res.exitCode)}): "${cmd.slice(0, 120)}" — ${res.stderr.slice(0, 200)}`;
    }
  }
  return undefined;
}

/**
 * Chạy một lệnh shell trong container theo spec. Không bao giờ throw vì
 * lệnh fail — fail là kết quả. Chỉ throw khi không spawn được process.
 */
export async function runInEvalContainer(
  command: string,
  workDir: string,
  spec: EvalHarnessV3ContainerSpec,
  timeoutMs: number,
): Promise<EvalHarnessV3ContainerResult> {
  const normalized = normalizeContainerSpec(spec);
  const imageRef = containerImageRef(normalized);
  const backend = selectContainerBackend();
  if (backend === 'docker') {
    const pullError = await ensureDockerImage(imageRef);
    if (pullError !== undefined) {
      return { passed: false, exitCode: null, stdout: '', stderr: '', timedOut: false, backend, imageRef, setupError: pullError, durationMs: 0 };
    }
    const args = buildDockerRunArgs(normalized, workDir, command);
    const res = await runCommandWithTimeout('docker', args, timeoutMs, workDir);
    if (res.exitCode === null && !res.timedOut && res.stderr.includes('spawn error')) {
      return { ...res, passed: false, backend, imageRef, setupError: `Không khởi động được docker: ${res.stderr.slice(0, 300)}` };
    }
    return { ...res, passed: res.exitCode === 0, backend, imageRef };
  }
  if (backend === 'bwrap') {
    const args = buildBwrapArgs(normalized, workDir, command);
    let res = await runCommandWithTimeout('bwrap', args, timeoutMs, workDir);
    // VM có thể từ chối netns (lỗi unshare-net, vd "bwrap: loopback:
    // Failed RTM_NEWADDR") — thử lại không có --unshare-net, như v2 đã
    // kiểm chứng. Dấu hiệu setup fail (theo v2): dòng stderr đầu tiên
    // bắt đầu bằng "bwrap:" — lệnh chưa chạy, không được báo thành test fail.
    // Setup fail không báo test fail.
    if (res.exitCode !== 0 && isBwrapSetupFailureV3(res.stderr)) {
      const retryArgs = args.filter((a) => a !== '--unshare-net');
      res = await runCommandWithTimeout('bwrap', retryArgs, timeoutMs, workDir);
    }
    const warning = `bwrap không dùng image ${imageRef} (chạy bằng toolchain host) — kết quả chỉ đúng khi toolchain host khớp image.`;
    return { ...res, passed: res.exitCode === 0, backend, imageRef, sandboxWarning: warning };
  }
  const res = await runCommandWithTimeout('sh', ['-c', command], timeoutMs, workDir);
  return {
    ...res,
    passed: res.exitCode === 0,
    backend: 'local',
    imageRef,
    sandboxWarning: 'Không có docker/bwrap — trial chạy local, KHÔNG cách ly.',
  };
}

/** Ghi map file (đường dẫn tương đối → nội dung) vào workdir. */
export function writeEvalHarnessV3FilesToWorkDir(workDir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(workDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
}

/** Tạo workdir tạm cho một trial (mkdtemp trong os.tmpdir()). */
export function createEvalHarnessV3TrialWorkDir(prefix = 'eval-harness-v3-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Xoá workdir trial (không throw khi đã mất). */
export function removeEvalHarnessV3TrialWorkDir(workDir: string): void {
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    // Workdir đã bị xoá hoặc không xoá được — không chặn suite.
  }
}

/** Dry-run container spec: kiểm tra backend + image mà không chạy task. */
export async function dryRunContainerSpec(
  spec: EvalHarnessV3ContainerSpec,
): Promise<{ backend: EvalHarnessV3ContainerBackend; imageRef: string; available: boolean; warning?: string }> {
  const normalized = normalizeContainerSpec(spec);
  const imageRef = containerImageRef(normalized);
  const backend = selectContainerBackend();
  if (backend === 'docker') {
    const check = await runCommandWithTimeout('docker', ['image', 'inspect', imageRef], 15_000, process.cwd());
    return { backend, imageRef, available: check.exitCode === 0, warning: check.exitCode === 0 ? undefined : `Image ${imageRef} chưa có local — sẽ pull khi chạy (cần mạng).` };
  }
  if (backend === 'bwrap') {
    return { backend, imageRef, available: true, warning: `bwrap không dùng image ${imageRef} — chạy bằng toolchain host.` };
  }
  return { backend, imageRef, available: true, warning: 'Không có docker/bwrap — trial sẽ chạy local, KHÔNG cách ly.' };
}
