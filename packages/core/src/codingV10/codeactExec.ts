/**
 * Coding agent v10 — CodeAct-style code execution tool.
 *
 * Agent viết code (node / python) hoặc lệnh (bash) rồi chạy trong
 * sandbox local, đọc stdout/stderr/exit code thành Observation event
 * rồi lặp — đúng pattern CodeAct của OpenHands (chỉ học ý tưởng).
 *
 * Nối nền đã có, không viết lại:
 * - Chạy bằng argv qua `spawn` (không shell) như `runV9Command` của
 *   v9; bash chạy qua `/bin/sh -c` với command đã kiểm tra (v9 cũng
 *   dùng argv, không shell trực tiếp).
 * - Denylist lệnh phá hoại của codeact (`isCodeActCommandBlocked`)
 *   + denylist/allowlist argv của v9 (`v9CheckDenyList`,
 *   `v9CheckAllowList`) — lệnh bị chặn trả Observation lỗi, không
 *   throw (để agent đọc được như kết quả tool bình thường).
 * - Giới hạn: timeout (kill cả process), cap output mỗi stream,
 *   cap độ dài code. CPU/RAM: không có cgroup trên máy này — giới
 *   hạn nói rõ là timeout + output cap; khi chạy trong BotBox thì
 *   box enforce thêm (xem `sandbox/box.ts`).
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isCodeActCommandBlocked } from '../codeact/executor';
import { v9CheckAllowList, v9CheckDenyList } from '../codingV9/sandboxLoop';
import { CodingV10Error } from './types';
import type { V10CodeActRequest, V10CodeActResult } from './types';

/** Timeout mặc định mỗi lần chạy CodeAct, ms. */
export const V10_CODEACT_DEFAULT_TIMEOUT_MS = 30_000;
/** Timeout tối đa mỗi lần chạy CodeAct, ms. */
export const V10_CODEACT_MAX_TIMEOUT_MS = 120_000;
/** Giới hạn ký tự output mỗi stream (stdout/stderr). */
export const V10_CODEACT_DEFAULT_OUTPUT_LIMIT = 20_000;
/** Độ dài code tối đa (ký tự). */
export const V10_CODEACT_MAX_CODE_CHARS = 100_000;
/** Thư mục tạm chứa script CodeAct trong working dir. */
export const V10_CODEACT_TMP_DIR = '.open-bot-codeact-v10';
/** Allowlist lệnh đầu tiên mặc định cho bash (fail-closed). */
export const V10_CODEACT_DEFAULT_ALLOWED_COMMANDS: readonly string[] = [
  'node',
  'python3',
  'python',
  'git',
  'npm',
  'npx',
  'tsc',
  'ls',
  'cat',
  'echo',
  'pwd',
  'wc',
  'head',
  'tail',
  'grep',
  'find',
];

/** Lấy tên lệnh đầu tiên của một command bash (bỏ path + quote). */
export function v10FirstCommand(command: string): string {
  const first = command.trim().split(/[\s;|&]+/)[0] ?? '';
  return path.basename(first.replace(/^['"]|['"]$/g, ''));
}

/** Kiểm tra một request CodeAct có bị chặn không (trả lý do hoặc null). */
export function v10CheckCodeActDenied(request: V10CodeActRequest): string | null {
  const allowed = request.allowedCommands ?? V10_CODEACT_DEFAULT_ALLOWED_COMMANDS;
  if (request.code.trim() === '') return 'CodeAct: code/command rỗng.';
  if (request.code.length > V10_CODEACT_MAX_CODE_CHARS) {
    return `CodeAct: code dài ${request.code.length} ký tự, vượt giới hạn ${V10_CODEACT_MAX_CODE_CHARS}.`;
  }
  if (request.kind === 'bash') {
    const blocked = isCodeActCommandBlocked(request.code);
    if (blocked.blocked) return `codeact-denylist: ${blocked.reason ?? 'lệnh bị chặn'}`;
    const deny = v9CheckDenyList(['/bin/sh', '-c', request.code]);
    if (deny) return deny;
    const first = v10FirstCommand(request.code);
    if (!allowed.includes(first)) {
      return `Command "${first}" is not in the CodeAct allowlist.`;
    }
    return null;
  }
  // node / python: chạy qua argv [bin, file, ...args] nên denylist
  // argv của v9 cũng áp được (chặn `rm -rf /` trong args).
  const bin = request.kind === 'node' ? 'node' : 'python3';
  if (!allowed.includes(bin)) return `Command "${bin}" is not in the CodeAct allowlist.`;
  const deny = v9CheckDenyList([bin, ...(request.args ?? [])]);
  if (deny) return deny;
  return null;
}

/** Cắt output về giới hạn, giữ đầu + cuối, đánh dấu phần đã cắt. */
export function v10TruncateCodeActOutput(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.slice(0, half)}\n... [truncated ${text.length - limit} chars] ...\n${text.slice(text.length - half)}`;
}

export interface V10CodeActExecutorOptions {
  /** Working dir: script tạm + cwd của lệnh chạy. */
  workingDir: string;
  /** Timeout mặc định, ms. */
  timeoutMs?: number;
  /** Giới hạn output mặc định mỗi stream. */
  outputLimit?: number;
  /** Allowlist lệnh đầu tiên mặc định (bash). */
  allowedCommands?: readonly string[];
}

/**
 * Executor CodeAct v10: chạy code trong working dir, trả Observation.
 * Không gọi model, không gọi mạng — chỉ chạy code agent đã viết.
 */
export class V10CodeActExecutor {
  readonly workingDir: string;
  readonly timeoutMs: number;
  readonly outputLimit: number;
  readonly allowedCommands: readonly string[];

  constructor(options: V10CodeActExecutorOptions) {
    this.workingDir = path.resolve(options.workingDir);
    this.timeoutMs = options.timeoutMs ?? V10_CODEACT_DEFAULT_TIMEOUT_MS;
    this.outputLimit = options.outputLimit ?? V10_CODEACT_DEFAULT_OUTPUT_LIMIT;
    this.allowedCommands = options.allowedCommands ?? V10_CODEACT_DEFAULT_ALLOWED_COMMANDS;
    fs.mkdirSync(this.workingDir, { recursive: true });
  }

  /** Chạy một request CodeAct, trả kết quả (không throw khi lệnh fail). */
  async run(request: V10CodeActRequest): Promise<V10CodeActResult> {
    const timeoutMs = Math.min(
      Math.max(1, request.timeoutMs ?? this.timeoutMs),
      V10_CODEACT_MAX_TIMEOUT_MS,
    );
    const outputLimit = request.outputLimit ?? this.outputLimit;
    const startedAt = Date.now();
    const denied = v10CheckCodeActDenied({
      ...request,
      allowedCommands: request.allowedCommands ?? this.allowedCommands,
    });
    if (denied) {
      return {
        kind: request.kind,
        status: 'denied',
        exitCode: null,
        stdout: '',
        stderr: denied,
        durationMs: Date.now() - startedAt,
        timedOut: false,
        reason: denied,
        argvPreview: [request.kind],
      };
    }
    let argv: string[] = [];
    let scriptPath: string | null = null;
    try {
      if (request.kind === 'bash') {
        argv = ['/bin/sh', '-c', request.code];
      } else {
        const ext = request.kind === 'node' ? 'mjs' : 'py';
        const tmpDir = path.join(this.workingDir, V10_CODEACT_TMP_DIR);
        fs.mkdirSync(tmpDir, { recursive: true });
        scriptPath = path.join(tmpDir, `codeact-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
        fs.writeFileSync(scriptPath, request.code, 'utf8');
        argv = [request.kind === 'node' ? 'node' : 'python3', scriptPath, ...(request.args ?? [])];
      }
      const result = await this.spawn(argv, timeoutMs, outputLimit);
      return { ...result, kind: request.kind };
    } finally {
      if (scriptPath) {
        try {
          fs.unlinkSync(scriptPath);
        } catch {
          // File tạm đã bị xóa hoặc không xóa được — không chặn kết quả.
        }
      }
    }
  }

  /** Spawn argv (không shell), enforce timeout + cap output. */
  private spawn(
    argv: string[],
    timeoutMs: number,
    outputLimit: number,
  ): Promise<Omit<V10CodeActResult, 'kind'>> {
    const startedAt = Date.now();
    return new Promise((resolve) => {
      const child = spawn(argv[0] as string, argv.slice(1), {
        cwd: this.workingDir,
        shell: false,
        env: { ...process.env, PATH: process.env.PATH ?? '' },
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // Process đã thoát — không làm gì thêm.
        }
      }, timeoutMs);
      // Ngăn timer giữ process sống khi child đã thoát mà timer chưa clear.
      timer.unref?.();
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        if (stdout.length > outputLimit * 2) stdout = stdout.slice(0, outputLimit * 2);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        if (stderr.length > outputLimit * 2) stderr = stderr.slice(0, outputLimit * 2);
      });
      child.on('error', (err: Error) => {
        clearTimeout(timer);
        resolve({
          status: 'failed',
          exitCode: null,
          stdout: v10TruncateCodeActOutput(stdout, outputLimit),
          stderr: v10TruncateCodeActOutput(`${stderr}\nspawn error: ${err.message}`, outputLimit),
          durationMs: Date.now() - startedAt,
          timedOut: false,
          reason: `Không chạy được lệnh: ${err.message}`,
          argvPreview: argv.slice(0, 2),
        });
      });
      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        const exitCode = code ?? -1;
        resolve({
          status: timedOut ? 'timeout' : exitCode === 0 ? 'ok' : 'failed',
          exitCode: timedOut ? null : exitCode,
          stdout: v10TruncateCodeActOutput(stdout, outputLimit),
          stderr: v10TruncateCodeActOutput(stderr, outputLimit),
          durationMs: Date.now() - startedAt,
          timedOut,
          reason: timedOut ? `Hết timeout ${timeoutMs}ms.` : undefined,
          argvPreview: argv.slice(0, 2),
        });
      });
    });
  }
}

/** Chạy nhanh một request CodeAct mà không cần giữ executor. */
export async function runV10CodeAct(
  workingDir: string,
  request: V10CodeActRequest,
): Promise<V10CodeActResult> {
  const executor = new V10CodeActExecutor({ workingDir });
  return executor.run(request);
}

/** Validate request CodeAct (throw CodingV10Error khi sai định dạng). */
export function validateV10CodeActRequest(request: V10CodeActRequest): void {
  if (request.kind !== 'node' && request.kind !== 'python' && request.kind !== 'bash') {
    throw new CodingV10Error('codeact-denied', `CodeAct kind không hợp lệ: ${String(request.kind)}.`);
  }
  if (typeof request.code !== 'string' || request.code.trim() === '') {
    throw new CodingV10Error('codeact-denied', 'CodeAct: code/command rỗng.');
  }
  if (request.code.length > V10_CODEACT_MAX_CODE_CHARS) {
    throw new CodingV10Error(
      'codeact-too-large',
      `CodeAct: code dài ${request.code.length} ký tự, vượt giới hạn ${V10_CODEACT_MAX_CODE_CHARS}.`,
    );
  }
}
