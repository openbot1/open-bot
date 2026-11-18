/**
 * Sandbox execution loop cho coding agent v9 (v1.17, Đội T4).
 *
 * Học ý tưởng OpenHands (survey v1.17 §2): Editor + Shell là tool
 * hạng nhất, chạy trong sandbox; vòng lặp plan → edit → run test →
 * lặp cho tới khi xanh hoặc hết vòng. Tự thiết kế lại hoàn toàn:
 *
 * - Lệnh chạy KHÔNG qua shell (argv tách sẵn, `spawn` với
 *   `shell: false`), cwd luôn là thư mục sandbox do caller chỉ định
 *   (thư mục làm việc riêng, vd repo tạm của task).
 * - Timeout giết cả process group (spawn `detached: true`, kill
 *   `-pid` khi hết giờ) để lệnh con cháu không chạy sót lại.
 * - Denylist lệnh nguy hiểm + policy v8 (`checkV8Policy`): chặn
 *   `rm -rf /`, ghi đè device, `curl|wget ... | sh`, `sudo`,
 *   `shutdown/reboot`, fork bomb, ...; allowlist tùy chọn giới hạn
 *   các lệnh đầu tiên được phép (node/npm/npx/git/python3/tsc...).
 * - Env tối thiểu: PATH + biến caller cho phép; không kế thừa toàn
 *   bộ env của host (tránh rò rỉ secret vào log/lệnh con).
 * - Vòng lặp: `editProvider(round, lastFailure)` → `verifyCommands`
 *   (mảng argv) → pass thì dừng, fail thì trích đoạn lỗi đưa cho
 *   `fixProvider(round, failureExcerpt)` để sửa lại ở vòng sau.
 *   Giới hạn số vòng cấu hình được (`maxRounds`); dừng khi xanh,
 *   hết vòng, edit lỗi, lệnh bị chặn, hoặc timeout.
 *
 * Giới hạn trung thực:
 * - Không phải Docker/microVM thật — chỉ là thư mục riêng + giới
 *   hạn lệnh + timeout trên máy này; code độc hại vẫn có thể đọc
 *   file ngoài cwd qua đường dẫn tuyệt đối (chỉ chạy task tin cậy
 *   hoặc code do agent tự sinh trong repo đó).
 * - Không giới hạn CPU/RAM (cần cgroup — ngoài phạm vi v9).
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkV8Policy, defaultV8SandboxPolicy } from '../codingV8/codeactV4';
import type { V8SandboxPolicy } from '../codingV8/codeactV4';
import { CodingV9Error } from './types';
import type {
  V9CommandResult,
  V9CommandStatus,
  V9EditResult,
  V9LoopResult,
  V9LoopRound,
} from './types';

/** Timeout mặc định cho một lệnh verify, ms. */
export const V9_LOOP_DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
/** Timeout tối đa cho một lệnh verify, ms. */
export const V9_LOOP_MAX_COMMAND_TIMEOUT_MS = 120_000;
/** Số vòng lặp mặc định. */
export const V9_LOOP_DEFAULT_MAX_ROUNDS = 5;
/** Số vòng lặp tối đa cho phép. */
export const V9_LOOP_MAX_ROUNDS = 20;
/** Số ký tự output tối đa giữ lại mỗi stream. */
export const V9_LOOP_OUTPUT_LIMIT = 20_000;
/** Số dòng lỗi cuối cùng trích ra cho fix provider. */
export const V9_LOOP_FAILURE_EXCERPT_LINES = 40;

/** Các lệnh đầu tiên được phép mặc định (khi dùng allowlist). */
export const V9_LOOP_DEFAULT_ALLOWED_COMMANDS: readonly string[] = [
  'node',
  'npm',
  'npx',
  'git',
  'python3',
  'python',
  'tsc',
  'ls',
  'cat',
  'echo',
  'pwd',
  'mkdir',
  'cp',
  'mv',
  'rm',
  'grep',
  'find',
  'head',
  'tail',
  'wc',
  'diff',
  'jq',
];

/**
 * Mẫu lệnh nguy hiểm bị chặn tuyệt đối (kiểm tra trên chuỗi lệnh
 * đã nối, trước cả policy v8). Mỗi mẫu có id + thông báo rõ ràng.
 */
export const V9_LOOP_DENY_PATTERNS: ReadonlyArray<{ id: string; pattern: RegExp; message: string }> = [
  {
    id: 'device-write',
    pattern: />\s*\/dev\/(sda|nvme|disk|zero|null|random|urandom|full|tty)/,
    message: 'Refusing write to a device path.',
  },
  {
    id: 'curl-pipe-shell',
    pattern: /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh|python3?|node)\b/,
    message: 'Refusing to pipe a download straight into a shell.',
  },
  {
    id: 'sudo',
    pattern: /(^|\s)sudo(\s|$)/,
    message: 'sudo is not allowed in the sandbox loop.',
  },
  {
    id: 'shutdown',
    pattern: /\b(shutdown|reboot|halt|poweroff|init\s+0)\b/,
    message: 'Refusing shutdown/reboot command.',
  },
  {
    id: 'fork-bomb',
    pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/,
    message: 'Refusing fork bomb.',
  },
  {
    id: 'chmod-777-root',
    pattern: /\bchmod\s+(-R\s+)?777\s+(\/|\$HOME|\~)\b/,
    message: 'Refusing chmod 777 on a root/home path.',
  },
  {
    id: 'mkfs-dd',
    pattern: /\b(mkfs|dd\b[^|]*\bof=\/dev\/)/,
    message: 'Refusing disk format / raw device write.',
  },
  {
    id: 'env-dump',
    pattern: /\b(env|printenv|set)\b[^|]*\|\s*(curl|wget|nc|netcat)\b/,
    message: 'Refusing to exfiltrate environment variables.',
  },
  {
    id: 'history-dump',
    pattern: />\s*~\/?\.?(bash_history|zsh_history|ssh\/)/,
    message: 'Refusing write into shell history / .ssh.',
  },
];

/** Tùy chọn chạy một lệnh trong sandbox. */
export interface V9RunCommandOptions {
  /** Thư mục làm việc (sandbox dir). */
  cwd: string;
  /** Timeout, ms. Mặc định 30_000, tối đa 120_000. */
  timeoutMs?: number;
  /** Biến môi trường thêm (ngoài PATH). */
  env?: Record<string, string>;
  /** Giới hạn ký tự output mỗi stream. Mặc định 20_000. */
  outputLimit?: number;
  /** Policy sandbox v8 (mặc định strict, không mạng). */
  policy?: V8SandboxPolicy;
  /** Allowlist lệnh đầu tiên (undefined = không giới hạn theo allowlist). */
  allowedCommands?: readonly string[];
}

/** Provider edit của một vòng: nhận số vòng + lỗi vòng trước, trả về edit đã áp. */
export type V9LoopEditProvider = (
  round: number,
  lastFailure: string,
) => Promise<V9EditResult | null> | V9EditResult | null;

/** Provider sửa lỗi: nhận lỗi trích ra, trả về ghi chú sửa (để log). */
export type V9LoopFixProvider = (
  round: number,
  failureExcerpt: string,
) => Promise<string> | string;

/** Tùy chọn cho sandbox execution loop. */
export interface V9SandboxLoopOptions {
  /** Thư mục sandbox (repo làm việc). */
  workingDir: string;
  /** Số vòng tối đa. Mặc định 5, tối đa 20. */
  maxRounds?: number;
  /** Lệnh verify chạy mỗi vòng (mảng argv, không shell). Ít nhất 1 lệnh. */
  verifyCommands: string[][];
  /** Timeout mỗi lệnh verify, ms. */
  commandTimeoutMs?: number;
  /** Provider edit chạy đầu mỗi vòng (vòng 1: edit ban đầu; vòng sau: sửa lỗi). */
  editProvider?: V9LoopEditProvider;
  /** Provider sửa lỗi (gọi khi verify fail, trước vòng sau). */
  fixProvider?: V9LoopFixProvider;
  /** Biến môi trường thêm cho lệnh verify. */
  env?: Record<string, string>;
  /** Policy sandbox v8. */
  policy?: V8SandboxPolicy;
  /** Allowlist lệnh đầu tiên. */
  allowedCommands?: readonly string[];
  /** Ghi chú vòng 1 (hiển thị trong report). */
  firstRoundNote?: string;
}

/** Kiểm tra một argv có bị denylist chặn không; trả về lý do hoặc null. */
export function v9CheckDenyList(argv: string[]): string | null {
  if (argv.length === 0) return 'Empty command (no argv).';
  // rm đệ quy + force nhắm vào / hoặc home: kiểm tra theo token
  // (flag gộp `-rf` cũng bị bắt, regex khó diễn đạt hết các dạng).
  const first = path.basename(argv[0] as string);
  if (first === 'rm') {
    let recursive = false;
    let force = false;
    let targetRoot = false;
    for (const token of argv.slice(1)) {
      if (token === '--recursive' || token === '--force') {
        if (token === '--recursive') recursive = true;
        else force = true;
      } else if (token.startsWith('-') && !token.startsWith('--') && token !== '-') {
        const flags = token.slice(1);
        if (flags.includes('r') || flags.includes('R')) recursive = true;
        if (flags.includes('f')) force = true;
      } else if (token === '/' || token === '/*' || token === '$HOME' || token === '~') {
        targetRoot = true;
      }
    }
    if (recursive && force && targetRoot) {
      return 'rm-root: Refusing recursive delete of a root/home path.';
    }
  }
  const joined = argv.join(' ');
  for (const rule of V9_LOOP_DENY_PATTERNS) {
    if (rule.pattern.test(joined)) {
      return `${rule.id}: ${rule.message}`;
    }
  }
  return null;
}

/**
 * Kiểm tra allowlist: lệnh đầu tiên phải nằm trong danh sách.
 * Trả về lý do khi bị chặn, null khi đạt.
 */
export function v9CheckAllowList(argv: string[], allowed: readonly string[]): string | null {
  if (argv.length === 0) return 'Empty command (no argv).';
  const first = argv[0] as string;
  const base = path.basename(first);
  if (!allowed.includes(first) && !allowed.includes(base)) {
    return `Command "${first}" is not in the sandbox allowlist.`;
  }
  return null;
}

/** Cắt output về giới hạn, giữ đầu + cuối, đánh dấu phần đã cắt. */
export function v9TruncateOutput(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return (
    text.slice(0, half) +
    `\n... [truncated ${text.length - limit} chars] ...\n` +
    text.slice(text.length - half)
  );
}

/**
 * Trích đoạn lỗi từ kết quả lệnh fail: ưu tiên stderr, rồi stdout;
 * lấy N dòng cuối (nơi thường chứa thông báo lỗi thật).
 */
export function v9FailureExcerpt(
  results: V9CommandResult[],
  lines = V9_LOOP_FAILURE_EXCERPT_LINES,
): string {
  const parts: string[] = [];
  for (const r of results) {
    if (r.status === 'ok') continue;
    const text = (r.stderr.trim() || r.stdout.trim() || r.reason || `exit ${r.exitCode}`).trim();
    if (!text) continue;
    const tail = text.split('\n').slice(-lines).join('\n');
    parts.push(`$ ${r.argv.join(' ')}\n${tail}`);
  }
  return parts.join('\n---\n');
}

/**
 * Chạy MỘT lệnh (argv, không shell) trong sandbox dir, có timeout
 * giết cả process group, output bị cắt ngắn, env tối thiểu.
 */
export function runV9Command(argv: string[], options: V9RunCommandOptions): Promise<V9CommandResult> {
  const startedAt = Date.now();
  const timeoutMs = Math.min(
    Math.max(100, Math.floor(options.timeoutMs ?? V9_LOOP_DEFAULT_COMMAND_TIMEOUT_MS)),
    V9_LOOP_MAX_COMMAND_TIMEOUT_MS,
  );
  const outputLimit = Math.max(100, Math.floor(options.outputLimit ?? V9_LOOP_OUTPUT_LIMIT));
  const cwd = path.resolve(options.cwd);

  const denied = v9CheckDenyList(argv);
  if (denied) {
    return Promise.resolve({
      argv,
      status: 'denied',
      exitCode: null,
      stdout: '',
      stderr: '',
      durationMs: Date.now() - startedAt,
      timedOut: false,
      reason: denied,
    });
  }
  if (options.allowedCommands) {
    const blocked = v9CheckAllowList(argv, options.allowedCommands);
    if (blocked) {
      return Promise.resolve({
        argv,
        status: 'denied',
        exitCode: null,
        stdout: '',
        stderr: '',
        durationMs: Date.now() - startedAt,
        timedOut: false,
        reason: blocked,
      });
    }
  }
  const policy = options.policy ?? defaultV8SandboxPolicy();
  const policyCheck = checkV8Policy({ kind: 'bash', command: argv.join(' ') }, policy, cwd);
  if (policyCheck.decision !== 'allow') {
    return Promise.resolve({
      argv,
      status: 'denied',
      exitCode: null,
      stdout: '',
      stderr: '',
      durationMs: Date.now() - startedAt,
      timedOut: false,
      reason: `v8 sandbox policy: ${policyCheck.denial?.message ?? 'denied'}`,
    });
  }
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    return Promise.resolve({
      argv,
      status: 'failed',
      exitCode: null,
      stdout: '',
      stderr: `Sandbox dir does not exist: ${cwd}`,
      durationMs: Date.now() - startedAt,
      timedOut: false,
      reason: 'sandbox dir missing',
    });
  }

  return new Promise<V9CommandResult>((resolve) => {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      ...(options.env ?? {}),
    };
    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd,
      env,
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already dead */
          }
        }
      } else {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already dead */
        }
      }
      resolve({
        argv,
        status: 'timeout',
        exitCode: null,
        stdout: v9TruncateOutput(stdout, outputLimit),
        stderr: v9TruncateOutput(stderr, outputLimit),
        durationMs: Date.now() - startedAt,
        timedOut: true,
        reason: `Timed out after ${timeoutMs}ms (process group killed).`,
      });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > outputLimit * 4) stdout = stdout.slice(-outputLimit * 4);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > outputLimit * 4) stderr = stderr.slice(-outputLimit * 4);
    });
    child.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        argv,
        status: 'failed',
        exitCode: null,
        stdout: v9TruncateOutput(stdout, outputLimit),
        stderr: v9TruncateOutput(stderr, outputLimit),
        durationMs: Date.now() - startedAt,
        timedOut: false,
        reason: `Failed to spawn: ${err.message}`,
      });
    });
    child.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const status: V9CommandStatus = code === 0 ? 'ok' : 'failed';
      resolve({
        argv,
        status,
        exitCode: code,
        stdout: v9TruncateOutput(stdout, outputLimit),
        stderr: v9TruncateOutput(stderr, outputLimit),
        durationMs: Date.now() - startedAt,
        timedOut: false,
        reason: code === 0 ? undefined : `Exit code ${code}.`,
      });
    });
  });
}

/**
 * Sandbox execution loop kiểu OpenHands: lặp edit → verify → fix.
 * Vòng 1 chạy `editProvider(1, '')` (edit ban đầu), các vòng sau
 * chạy `editProvider(round, lastFailure)` (sửa theo lỗi vòng trước).
 * Sau mỗi edit, chạy toàn bộ `verifyCommands` theo thứ tự; vòng nào
 * fail thì trích lỗi, gọi `fixProvider` (nếu có) rồi sang vòng sau.
 * Trả về kết quả đầy đủ (passed / roundsUsed / stopReason / transcript).
 */
export async function runV9SandboxLoop(options: V9SandboxLoopOptions): Promise<V9LoopResult> {
  const startedAt = Date.now();
  const maxRounds = Math.min(
    Math.max(1, Math.floor(options.maxRounds ?? V9_LOOP_DEFAULT_MAX_ROUNDS)),
    V9_LOOP_MAX_ROUNDS,
  );
  if (options.verifyCommands.length === 0) {
    throw new CodingV9Error('eval-task-invalid', 'Sandbox loop needs at least one verify command.');
  }
  const workingDir = path.resolve(options.workingDir);
  fs.mkdirSync(workingDir, { recursive: true });

  const rounds: V9LoopRound[] = [];
  let lastFailure = '';
  let totalLinesChanged = 0;
  let stopReason: V9LoopResult['stopReason'] = 'max-rounds';
  let passed = false;
  let pendingNote = '';

  for (let round = 1; round <= maxRounds; round += 1) {
    const roundStarted = Date.now();
    let edit: V9EditResult | undefined;
    const note = pendingNote || (round === 1 ? (options.firstRoundNote ?? 'initial edit') : `fix after round ${round - 1} failure`);
    pendingNote = '';
    try {
      if (options.editProvider) {
        const result = await options.editProvider(round, lastFailure);
        if (result) {
          edit = result;
          totalLinesChanged += result.linesAdded + result.linesRemoved;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      rounds.push({
        round,
        note: `${note} (edit failed)`,
        commands: [],
        passed: false,
        failureExcerpt: message,
        durationMs: Date.now() - roundStarted,
      });
      stopReason = 'edit-failed';
      break;
    }

    const commands: V9CommandResult[] = [];
    let roundPassed = true;
    let denied = false;
    let timedOut = false;
    for (const argv of options.verifyCommands) {
      const res = await runV9Command(argv, {
        cwd: workingDir,
        timeoutMs: options.commandTimeoutMs,
        env: options.env,
        policy: options.policy,
        allowedCommands: options.allowedCommands,
      });
      commands.push(res);
      if (res.status === 'denied') denied = true;
      if (res.status === 'timeout') timedOut = true;
      if (res.status !== 'ok') roundPassed = false;
    }
    const failureExcerpt = roundPassed ? '' : v9FailureExcerpt(commands);
    rounds.push({
      round,
      note,
      edit,
      commands,
      passed: roundPassed,
      failureExcerpt,
      durationMs: Date.now() - roundStarted,
    });

    if (roundPassed) {
      passed = true;
      stopReason = 'passed';
      break;
    }
    if (denied) {
      stopReason = 'denied';
      lastFailure = failureExcerpt;
      break;
    }
    if (timedOut) {
      stopReason = 'timeout';
      lastFailure = failureExcerpt;
      break;
    }
    lastFailure = failureExcerpt;
    if (options.fixProvider && round < maxRounds) {
      try {
        const fixNote = await options.fixProvider(round, failureExcerpt);
        if (fixNote) pendingNote = fixNote;
      } catch {
        /* fix provider lỗi thì vòng sau vẫn chạy editProvider với lastFailure */
      }
    }
  }

  return {
    passed,
    roundsUsed: rounds.length,
    maxRounds,
    stopReason,
    rounds,
    totalDurationMs: Date.now() - startedAt,
    totalLinesChanged,
  };
}
