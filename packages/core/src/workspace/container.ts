/**
 * Container workspace backend (v1.03, Đội T4).
 *
 * Backend `container`: mỗi workspace là một container docker/podman
 * chạy nền (`sleep infinity`), file workspace bind-mount vào
 * `/workspace`, exec qua `docker exec` / `podman exec`. Quota CPU/RAM
 * áp bằng cờ `--cpus` / `--memory` lúc `docker run` (kế thừa
 * compute/planner LEVEL_DEFAULTS — container cần ≥1 core / 1 GiB).
 *
 * TRUNG THỰC LÀ TÍNH NĂNG: máy này KHÔNG có Docker thật nên backend
 * này mặc định `available = false` + lý do rõ; `WorkspaceManager`
 * fallback về local backend và đánh dấu workspace `degraded` — không
 * bao giờ báo "đang chạy trong container" khi thực tế chạy local.
 * Mọi lệnh docker/podman đều đi qua `ContainerRunner` inject được,
 * nên test chạy bằng runner giả mà không cần Docker thật; test với
 * Docker thật được ghi rõ là bỏ qua khi không có runtime (xem
 * tests/workspace-v103.test.mjs).
 *
 * Giới hạn còn lại (ghi rõ, không giấu): image mặc định
 * `alpine:latest` (phải pull được mới tạo container); container
 * không tự xoá network namespace riêng — egress vẫn qua gate của host
 * khi agent gọi ra ngoài (xem sandbox/gate.ts); Windows/macOS chưa
 * kiểm chứng (chỉ dò `docker`/`podman` trong PATH).
 */

import { spawn, spawnSync, type SpawnOptionsWithoutStdio } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { dirFileCount, dirSizeBytes } from '../sandbox/box';
import type { IsolationInfo } from '../sandbox/types';
import type {
  WorkspaceBackend,
  WorkspaceBackendKind,
  WorkspaceExecOptions,
  WorkspaceExecResult,
  WorkspaceMeta,
} from './types';

/** Runtime container đã dò được. */
export type ContainerRuntime = 'docker' | 'podman';

/** Kết quả một lệnh chạy qua runner. */
export interface ContainerRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runner inject được — production dùng child_process, test dùng fake. */
export interface ContainerRunner {
  /** True khi lệnh có trong PATH (dò runtime). */
  commandAvailable(command: string): boolean;
  /** Chạy lệnh, chờ xong (timeout kill khi hết giờ). */
  run(
    command: string,
    args: string[],
    opts: { timeoutMs?: number; maxOutputChars?: number },
  ): Promise<ContainerRunResult>;
}

/** Runner thật bằng child_process (spawn, không qua shell — không inject argv). */
export const defaultContainerRunner: ContainerRunner = {
  commandAvailable(command: string): boolean {
    // `command -v` là cách portable nhất trên Unix; Windows: `where`.
    const probe = process.platform === 'win32' ? 'where' : 'command';
    const probeArgs = process.platform === 'win32' ? [command] : ['-v', command];
    try {
      const res = spawnSync(probe, probeArgs, { encoding: 'utf8', timeout: 5000 });
      return res.status === 0 && res.stdout.trim().length > 0;
    } catch {
      return false;
    }
  },
  async run(command, args, opts): Promise<ContainerRunResult> {
    return runProcess(command, args, opts);
  },
};

function runProcess(
  command: string,
  args: string[],
  opts: { timeoutMs?: number; maxOutputChars?: number },
): Promise<ContainerRunResult> {
  const maxOutputChars = opts.maxOutputChars ?? 200_000;
  return new Promise<ContainerRunResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, stdout, stderr, timedOut });
    };
    let child;
    try {
      child = spawn(command, args, { timeout: opts.timeoutMs ?? 120_000, killSignal: 'SIGKILL' } as SpawnOptionsWithoutStdio);
    } catch (err) {
      resolve({ exitCode: null, stdout: '', stderr: (err as Error).message, timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // tiến trình đã chết trước khi kill — bỏ qua.
      }
    }, opts.timeoutMs ?? 120_000);
    timer.unref();
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < maxOutputChars) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < maxOutputChars) stderr += chunk.toString('utf8');
    });
    child.on('error', (err: Error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: stderr + err.message, timedOut });
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      finish(code);
    });
  });
}

export interface ContainerWorkspaceBackendOptions {
  /** Thư mục gốc chứa mọi workspace (`<root>/<id>/...`). */
  rootDir: string;
  /** Image dùng cho container workspace (mặc định 'alpine:latest'). */
  image?: string;
  /** Runner (mặc định defaultContainerRunner; test inject fake). */
  runner?: ContainerRunner;
  /** Nơi ghi cảnh báo (mặc định im lặng). */
  logger?: { warn(message: string): void };
}

/** Tên container cho một workspace id. */
export function containerNameForWorkspace(workspaceId: string): string {
  return `open-bot-ws-${workspaceId}`;
}

/** Dò runtime container: docker trước, podman sau (trả undefined khi không có). */
export function detectContainerRuntime(runner: ContainerRunner = defaultContainerRunner): ContainerRuntime | undefined {
  if (runner.commandAvailable('docker')) return 'docker';
  if (runner.commandAvailable('podman')) return 'podman';
  return undefined;
}

export class ContainerWorkspaceBackend implements WorkspaceBackend {
  readonly kind: WorkspaceBackendKind = 'container';
  readonly isolation: IsolationInfo;
  readonly available: boolean;
  readonly unavailableReason?: string;
  readonly rootDir: string;
  readonly image: string;
  private readonly runner: ContainerRunner;
  private readonly runtime: ContainerRuntime | undefined;
  private readonly warn: (message: string) => void;

  constructor(options: ContainerWorkspaceBackendOptions) {
    this.rootDir = options.rootDir;
    this.image = options.image ?? 'alpine:latest';
    this.runner = options.runner ?? defaultContainerRunner;
    this.warn = options.logger ? (m) => options.logger?.warn(m) : () => undefined;
    this.runtime = detectContainerRuntime(this.runner);
    this.available = this.runtime !== undefined;
    if (!this.available) {
      this.unavailableReason =
        'no container runtime found (docker/podman not in PATH) — container workspaces fall back to local execution';
      this.isolation = {
        kind: 'none',
        isolated: false,
        detail: 'none — container runtime missing, no isolation',
        warning: this.unavailableReason,
      };
    } else {
      this.isolation = {
        kind: 'vm',
        isolated: true,
        detail: `${this.runtime} container (mount + pid + net namespace)`,
      };
    }
  }

  get detectedRuntime(): ContainerRuntime | undefined {
    return this.runtime;
  }

  /** Thư mục làm việc của workspace — bind-mount vào /workspace trong container. */
  filesDir(workspaceId: string): string {
    return path.join(this.rootDir, workspaceId, 'files');
  }

  containerName(workspaceId: string): string {
    return containerNameForWorkspace(workspaceId);
  }

  prepare(meta: WorkspaceMeta): void {
    if (!this.available || !this.runtime) {
      throw new Error(
        `container backend unavailable for workspace "${meta.id}": ${this.unavailableReason}`,
      );
    }
    fs.mkdirSync(this.filesDir(meta.id), { recursive: true });
    fs.mkdirSync(meta.dir, { recursive: true });
  }

  /**
   * Đảm bảo container của workspace đang chạy (tạo mới khi chưa có,
   * start lại khi đã dừng). Trả false + lý do khi không tạo được.
   */
  async ensureContainer(meta: WorkspaceMeta): Promise<{ ok: boolean; reason?: string }> {
    if (!this.available || !this.runtime) {
      return { ok: false, reason: this.unavailableReason };
    }
    const name = containerNameForWorkspace(meta.id);
    const filesDir = this.filesDir(meta.id);
    try {
      const listed = await this.runner.run(this.runtime, [
        'ps',
        '-a',
        '--filter',
        `name=^/${name}$`,
        '--format',
        '{{.Names}} {{.Status}}',
      ], { timeoutMs: 15_000 });
      const line = listed.stdout.split('\n').find((l) => l.startsWith(name));
      if (line && /\bUp\b/.test(line)) return { ok: true };
      if (line) {
        const started = await this.runner.run(this.runtime, ['start', name], { timeoutMs: 30_000 });
        if (started.exitCode === 0) return { ok: true };
        return { ok: false, reason: `could not start container ${name}: ${started.stderr.trim()}` };
      }
      const created = await this.runner.run(this.runtime, [
        'run',
        '-d',
        '--name',
        name,
        '--cpus',
        String(meta.quota.cpuCores),
        '--memory',
        `${Math.max(1, Math.floor(meta.quota.ramBytes / 1024 / 1024))}m`,
        ...(meta.quota.maxProcesses > 0 ? ['--pids-limit', String(meta.quota.maxProcesses)] : []),
        '-v',
        `${filesDir}:/workspace`,
        '-w',
        '/workspace',
        this.image,
        'sleep',
        'infinity',
      ], { timeoutMs: 120_000 });
      if (created.exitCode !== 0) {
        return { ok: false, reason: `could not create container ${name}: ${created.stderr.trim()}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `container ${this.runtime} failed: ${(err as Error).message}` };
    }
  }

  async exec(
    meta: WorkspaceMeta,
    command: string,
    args: string[],
    opts: WorkspaceExecOptions,
  ): Promise<WorkspaceExecResult> {
    const startedAt = Date.now();
    const filesDir = this.filesDir(meta.id);
    const fail = (stderr: string, extra: Partial<WorkspaceExecResult> = {}): WorkspaceExecResult => ({
      workspaceId: meta.id,
      command,
      args: [...args],
      isolation: this.isolation,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr,
      timedOut: false,
      writeCapExceeded: false,
      quotaDenied: false,
      workspaceBytes: fs.existsSync(filesDir) ? dirSizeBytes(filesDir) : 0,
      durationMs: Date.now() - startedAt,
      ...extra,
    });
    if (!this.available || !this.runtime) {
      return fail(`container backend unavailable: ${this.unavailableReason}`);
    }
    const ensured = await this.ensureContainer(meta);
    if (!ensured.ok) return fail(`could not start workspace container: ${ensured.reason}`);
    // Chạy qua `sh -c` trong container (một command line duy nhất —
    // args đã nối vào command line bởi caller, giống shell_exec).
    const commandLine = [command, ...args].join(' ');
    const envArgs: string[] = [];
    for (const [key, value] of Object.entries(opts.envValues ?? {})) {
      envArgs.push('-e', `${key}=${value}`);
    }
    const result = await this.runner.run(
      this.runtime,
      [
        'exec',
        '-w',
        '/workspace',
        ...envArgs,
        containerNameForWorkspace(meta.id),
        'sh',
        '-c',
        commandLine,
      ],
      {
        timeoutMs: opts.timeoutMs ?? meta.quota.timeoutMs,
        maxOutputChars: opts.maxOutputChars ?? meta.quota.maxOutputChars,
      },
    );
    const workspaceBytes = fs.existsSync(filesDir) ? dirSizeBytes(filesDir) : 0;
    return {
      workspaceId: meta.id,
      command,
      args: [...args],
      isolation: this.isolation,
      exitCode: result.exitCode,
      signal: null,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      writeCapExceeded: workspaceBytes > meta.quota.diskBytes,
      quotaDenied: false,
      workspaceBytes,
      durationMs: Date.now() - startedAt,
    };
  }

  destroy(meta: WorkspaceMeta): boolean {
    if (!this.available || !this.runtime) {
      // Không có runtime thì không có container để xoá — chỉ xoá thư mục.
      fs.rmSync(this.filesDir(meta.id), { recursive: true, force: true });
      return true;
    }
    // Xoá container (best-effort, không throw — manager vẫn xoá thư mục sau).
    void this.runner
      .run(this.runtime, ['rm', '-f', containerNameForWorkspace(meta.id)], { timeoutMs: 30_000 })
      .catch(() => undefined);
    fs.rmSync(this.filesDir(meta.id), { recursive: true, force: true });
    return true;
  }

  /** Đo dung lượng + số file thật của workspace (phục vụ quota/status). */
  measure(workspaceId: string): { diskBytes: number; fileCount: number } {
    const dir = this.filesDir(workspaceId);
    if (!fs.existsSync(dir)) return { diskBytes: 0, fileCount: 0 };
    return { diskBytes: dirSizeBytes(dir), fileCount: dirFileCount(dir) };
  }
}
