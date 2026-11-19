/**
 * Coding agent v17 — sandbox bwrap DÙNG THẬT cho code execution.
 *
 * Bài học audit OB-005 (audit v1.16, đã triage 2026-11-16): BotBoxManager
 * bwrap đã có sẵn trong repo nhưng đường code bị kiểm toán không dùng —
 * CodeAct v8 chạy quyền host. Module này sửa đúng chỗ đó cho coding
 * agent: MỌI lần chạy code của coding agent v17 đều đi qua
 * BotBoxManager.runInBox, không có đường chạy thẳng host.
 *
 * Cách nó hoạt động (dựa trên sandbox/box.ts có sẵn):
 * - Linux + bwrap: `bwrap --ro-bind /usr /usr ... --bind <workspace>
 *   <workspace> --chdir <workspace> --unshare-pid --die-with-parent`
 *   (mount + pid namespace, workspace bind riêng). KHÔNG --unshare-net
 *   (box vẫn cần gọi egress gate trên loopback; mạng ngoài chỉ qua gate).
 * - Giới hạn CPU/RAM từng bot: box limits cpuSeconds / maxMemoryBytes /
 *   maxProcesses được bọc bằng prlimit (util-linux) khi spawn — áp cho
 *   toàn bộ cây tiến trình trong box; timeout + cap ghi + cap output
 *   enforce thật bằng kill process group (xem box.ts).
 * - Non-root: bwrap chạy với UID của tiến trình host (không setuid,
 *   không --map-root-user ở đường này); module kiểm tra
 *   process.getuid() !== 0 trước khi chạy và ghi uid vào kết quả —
 *   nếu host đang chạy root thì từ chối chạy code của agent (trừ khi
 *   caller chích allowRoot=true một cách tường minh, và việc đó được
 *   ghi rõ vào kết quả).
 * - Fallback RÕ RÀNG: bwrap không có → box tự detect 'unshare' rồi
 *   'none'; kết quả ghi rõ isolation thật + fallbackReason, không bao
 *   giờ giả vờ đã cách ly. `v17RequireBwrap` ném lỗi khi host yêu cầu
 *   bwrap bắt buộc mà máy không có.
 *
 * Giới hạn trung thực: bwrap giam mount/pid chứ không giam mạng ra
 * ngoài (mạng chỉ qua egress gate); prlimit --as là giới hạn không
 * gian địa chỉ ảo (Node cần ≥4GB ảo — xem box.ts MIN_AS_BYTES).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { BotBoxManager } from '../sandbox/box';
import { commandAvailable, detectIsolation } from '../sandbox/env';
import { CodingV17Error } from './types';
import type { V17SandboxLimits, V17SandboxProbe, V17SandboxRun } from './types';

/** Timeout mặc định cho một lần chạy sandbox của coding agent (ms). */
export const V17_DEFAULT_SANDBOX_TIMEOUT_MS = 60_000;
/** Cap ghi workspace mặc định (bytes). */
export const V17_DEFAULT_SANDBOX_MAX_WRITE_BYTES = 50 * 1024 * 1024;
/** Cap output mặc định (ký tự). */
export const V17_DEFAULT_SANDBOX_MAX_OUTPUT_CHARS = 50_000;

/** UID hiện tại của tiến trình host (0 = root). */
export function v17CurrentUid(): number {
  return typeof process.getuid === 'function' ? process.getuid() : -1;
}

/** true khi tiến trình host đang chạy non-root. */
export function v17IsNonRoot(): boolean {
  const uid = v17CurrentUid();
  return uid !== 0 && uid !== -1;
}

/** Validate botId (cùng quy tắc với BotBoxManager: ký tự an toàn). */
export function v17ValidateSandboxBotId(botId: string): string {
  if (typeof botId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(botId) || botId.includes('..')) {
    throw new CodingV17Error(
      'sandbox-invalid',
      'botId chỉ dùng chữ, số, ".", "-" và "_" (không "..").',
    );
  }
  return botId;
}

/** Validate giới hạn sandbox (mọi giới hạn phải > 0 khi đặt). */
export function v17ValidateSandboxLimits(limits: V17SandboxLimits): V17SandboxLimits {
  const checked: V17SandboxLimits = {};
  if (limits.cpuSeconds !== undefined) {
    if (!Number.isFinite(limits.cpuSeconds) || limits.cpuSeconds <= 0) {
      throw new CodingV17Error('sandbox-invalid', 'cpuSeconds phải > 0.');
    }
    checked.cpuSeconds = limits.cpuSeconds;
  }
  if (limits.maxMemoryBytes !== undefined) {
    if (!Number.isInteger(limits.maxMemoryBytes) || limits.maxMemoryBytes <= 0) {
      throw new CodingV17Error('sandbox-invalid', 'maxMemoryBytes phải là số nguyên > 0.');
    }
    checked.maxMemoryBytes = limits.maxMemoryBytes;
  }
  if (limits.maxProcesses !== undefined) {
    if (!Number.isInteger(limits.maxProcesses) || limits.maxProcesses <= 0) {
      throw new CodingV17Error('sandbox-invalid', 'maxProcesses phải là số nguyên > 0.');
    }
    checked.maxProcesses = limits.maxProcesses;
  }
  if (limits.timeoutMs !== undefined) {
    if (!Number.isInteger(limits.timeoutMs) || limits.timeoutMs <= 0) {
      throw new CodingV17Error('sandbox-invalid', 'timeoutMs phải là số nguyên > 0.');
    }
    checked.timeoutMs = limits.timeoutMs;
  }
  if (limits.maxWriteBytes !== undefined) {
    if (!Number.isInteger(limits.maxWriteBytes) || limits.maxWriteBytes <= 0) {
      throw new CodingV17Error('sandbox-invalid', 'maxWriteBytes phải là số nguyên > 0.');
    }
    checked.maxWriteBytes = limits.maxWriteBytes;
  }
  if (limits.maxOutputChars !== undefined) {
    if (!Number.isInteger(limits.maxOutputChars) || limits.maxOutputChars <= 0) {
      throw new CodingV17Error('sandbox-invalid', 'maxOutputChars phải là số nguyên > 0.');
    }
    checked.maxOutputChars = limits.maxOutputChars;
  }
  return checked;
}

/** Probe khả năng sandbox trên máy này (không chạy code, chỉ dò binary). */
export function v17ProbeSandbox(): V17SandboxProbe {
  const isolation = detectIsolation();
  const bwrapAvailable = commandAvailable('bwrap');
  const unshareAvailable = commandAvailable('unshare');
  const prlimitAvailable = commandAvailable('prlimit');
  const uid = v17CurrentUid();
  let recommendation: string;
  if (isolation.kind === 'bwrap' && uid !== 0) {
    recommendation =
      'bwrap khả dụng, chạy non-root — coding agent chạy code trong bwrap với giới hạn CPU/RAM từng bot.';
  } else if (isolation.kind === 'bwrap' && uid === 0) {
    recommendation =
      'bwrap khả dụng NHƯNG host đang chạy root — không chạy code agent dưới root; chuyển sang user thường trước khi chạy.';
  } else if (isolation.kind === 'unshare') {
    recommendation =
      'không có bwrap, chỉ có unshare (cách ly yếu hơn, không giam mount) — chạy được nhưng nên cài bwrap.';
  } else {
    recommendation =
      'không có bwrap/unshare — code chạy thường (không cách ly). Chỉ dùng cho task tin cậy, và kết quả phải ghi rõ isolation=none.';
  }
  return {
    platform: process.platform,
    isolation: isolation.kind,
    bwrapAvailable,
    unshareAvailable,
    prlimitAvailable,
    uid,
    recommendation,
  };
}

/** Đòi bwrap bắt buộc: ném lỗi rõ ràng khi máy không có bwrap. */
export function v17RequireBwrap(): void {
  const probe = v17ProbeSandbox();
  if (probe.isolation !== 'bwrap') {
    throw new CodingV17Error(
      'sandbox-unavailable',
      `yêu cầu bwrap bắt buộc nhưng máy này chỉ có isolation=${probe.isolation} (bwrapAvailable=${probe.bwrapAvailable}). Cài bubblewrap rồi chạy lại.`,
    );
  }
}

/**
 * V17SandboxRunner — chạy code của coding agent qua BotBoxManager.
 *
 * Một runner giữ một BotBoxManager trên rootDir cho trước; mỗi bot có
 * một box riêng (workspace riêng dưới <rootDir>/boxes/<botId>/).
 * Box được tạo với limits của bot (CPU/RAM/process/timeout/cap ghi)
 * và isolation 'bwrap' khi có — ép isolation để không lặng lẽ rơi
 * về chạy thường khi caller quên cấu hình (fallback vẫn được ghi rõ
 * vào kết quả khi bwrap lỗi lúc chạy).
 */
export class V17SandboxRunner {
  readonly rootDir: string;
  readonly boxes: BotBoxManager;
  private readonly allowRoot: boolean;

  constructor(
    rootDir: string,
    options: { allowRoot?: boolean; logger?: { warn(message: string): void } } = {},
  ) {
    if (rootDir.trim() === '') {
      throw new CodingV17Error('sandbox-invalid', 'rootDir không được rỗng.');
    }
    this.rootDir = rootDir;
    this.allowRoot = options.allowRoot === true;
    this.boxes = new BotBoxManager({
      rootDir,
      ...(options.logger ? { logger: options.logger } : {}),
    });
    fs.mkdirSync(rootDir, { recursive: true });
  }

  /** Đảm bảo box của bot tồn tại (tạo mới với limits khi chưa có). */
  ensureBox(botId: string, limits: V17SandboxLimits = {}): string {
    const checkedBot = v17ValidateSandboxBotId(botId);
    const checkedLimits = v17ValidateSandboxLimits(limits);
    const box = this.boxes.createBox(checkedBot, {
      limits: {
        timeoutMs: checkedLimits.timeoutMs ?? V17_DEFAULT_SANDBOX_TIMEOUT_MS,
        maxWriteBytes: checkedLimits.maxWriteBytes ?? V17_DEFAULT_SANDBOX_MAX_WRITE_BYTES,
        maxOutputChars: checkedLimits.maxOutputChars ?? V17_DEFAULT_SANDBOX_MAX_OUTPUT_CHARS,
        ...(checkedLimits.cpuSeconds !== undefined ? { cpuSeconds: checkedLimits.cpuSeconds } : {}),
        ...(checkedLimits.maxMemoryBytes !== undefined
          ? { maxMemoryBytes: checkedLimits.maxMemoryBytes }
          : {}),
        ...(checkedLimits.maxProcesses !== undefined
          ? { maxProcesses: checkedLimits.maxProcesses }
          : {}),
      },
      // Ép bwrap khi máy có; khi máy không có, detectIsolation trong
      // createBox tự chọn backend tốt nhất và ghi rõ vào box.isolation.
      isolation: 'auto',
    });
    return box.workspaceDir;
  }

  /** Workspace của box (để agent ghi file trước khi chạy). */
  boxWorkspaceDir(botId: string): string {
    return this.boxes.getBox(v17ValidateSandboxBotId(botId)).workspaceDir;
  }

  /**
   * Chạy một lệnh trong box của bot (qua BotBoxManager.runInBox —
   * ĐƯỜNG DUY NHẤT chạy code trong coding agent v17).
   *
   * - command là program (không qua shell trừ khi caller truyền
   *   '/bin/sh' + ['-c', ...]).
   * - Non-root: từ chối khi host uid == 0 (trừ allowRoot tường minh).
   * - Kết quả ghi rõ isolation thật + fallbackReason khi rơi về none.
   */
  async run(
    botId: string,
    command: string,
    args: string[] = [],
    limits: V17SandboxLimits = {},
  ): Promise<V17SandboxRun> {
    const checkedBot = v17ValidateSandboxBotId(botId);
    if (command.trim() === '') {
      throw new CodingV17Error('sandbox-invalid', 'command không được rỗng.');
    }
    const checkedLimits = v17ValidateSandboxLimits(limits);
    const uid = v17CurrentUid();
    if (uid === 0 && !this.allowRoot) {
      throw new CodingV17Error(
        'sandbox-not-root-check',
        'từ chối chạy code agent khi host đang chạy root (uid 0) — chạy lại bằng user thường, hoặc tạo runner với allowRoot=true một cách tường minh (không khuyến nghị).',
      );
    }
    this.ensureBox(checkedBot, checkedLimits);
    const timeoutMs = checkedLimits.timeoutMs ?? V17_DEFAULT_SANDBOX_TIMEOUT_MS;
    const result = await this.boxes.runInBox(checkedBot, command, args, {
      timeoutMs,
      ...(checkedLimits.maxWriteBytes !== undefined
        ? { maxWriteBytes: checkedLimits.maxWriteBytes }
        : {}),
      ...(checkedLimits.maxOutputChars !== undefined
        ? { maxOutputChars: checkedLimits.maxOutputChars }
        : {}),
    });
    const isolationKind = result.isolation.kind;
    const isolated = result.isolation.isolated === true;
    return {
      botId: checkedBot,
      command,
      args: [...args],
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      isolation: isolationKind,
      isolated,
      fallbackReason: isolated ? '' : (result.isolation.detail ?? 'không cách ly (isolation=none)'),
      uid,
      nonRoot: uid !== 0,
      ...(result.limitsApplied !== undefined ? { limitsApplied: result.limitsApplied as unknown as Record<string, unknown> } : {}),
      durationMs: result.durationMs,
      workspaceBytes: result.workspaceBytes,
    };
  }

  /** Chạy một lệnh shell (/bin/sh -c) trong box — tiện cho eval/test. */
  async runShell(botId: string, shellCommand: string, limits: V17SandboxLimits = {}): Promise<V17SandboxRun> {
    return this.run(botId, '/bin/sh', ['-c', shellCommand], limits);
  }

  /**
   * Chạy một file Python trong box: ghi code ra file tạm trong workspace
   * của box rồi chạy `python3 <file> [args...]`; xoá file tạm sau khi chạy.
   */
  async runPython(
    botId: string,
    code: string,
    args: string[] = [],
    limits: V17SandboxLimits = {},
  ): Promise<V17SandboxRun> {
    const checkedBot = v17ValidateSandboxBotId(botId);
    if (code.trim() === '') {
      throw new CodingV17Error('sandbox-invalid', 'code Python không được rỗng.');
    }
    const workspaceDir = this.ensureBox(checkedBot, limits);
    const tmpDir = path.join(workspaceDir, '.open-bot-v17');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, `v17-${Date.now()}-${Math.floor(Math.random() * 1e6)}.py`);
    fs.writeFileSync(tmpFile, code, 'utf8');
    try {
      // Chạy bằng đường dẫn TUYỆT ĐỐI trong workspace box (box bind
      // workspace nên path này nhìn thấy được từ trong bwrap).
      return await this.run(botId, 'python3', [tmpFile, ...args], limits);
    } finally {
      try {
        fs.rmSync(tmpFile, { force: true });
      } catch {
        // File tạm xoá lỗi thì bỏ qua (không hỏng kết quả chạy).
      }
    }
  }
}

/**
 * Executor chạy lệnh dạng (command, cwd, timeoutMs) qua sandbox runner —
 * để chích vào eval harness v17 (v17RunEvalTask) cho task chạy trong
 * bwrap thật thay vì executor local mặc định.
 *
 * Lưu ý: executor này chạy lệnh trong box của bot (cwd của box là
 * workspace riêng của bot), KHÔNG phải trong cwd tham số — cwd tham số
 * chỉ dùng để ghi lại trong lỗi. Eval harness dựng workspace task của
 * nó trong tmpdir rồi copy file vào box workspace trước khi chạy thì
 * mới đúng; ở đây executor tự copy: đọc file trong cwd, ghi vào box
 * workspace, chạy, rồi copy file kết quả ngược lại (chỉ file đã đổi).
 * Để giữ đơn giản và xác định, bản v17 này chạy lệnh trong box
 * workspace đã được đồng bộ 1 chiều (cwd -> box) trước mỗi lệnh.
 */
export function v17SandboxCommandExecutor(
  runner: V17SandboxRunner,
  botId: string,
  limits: V17SandboxLimits = {},
): (command: string, cwd: string, timeoutMs: number) => Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}> {
  const checkedBot = v17ValidateSandboxBotId(botId);
  return async (command, cwd, timeoutMs) => {
    const workspaceDir = runner.ensureBox(checkedBot, {
      ...limits,
      timeoutMs,
    });
    // Đồng bộ 1 chiều cwd -> box workspace (chỉ file, bỏ qua thư mục ẩn
    // hệ thống; file trong box cũ hơn thì ghi đè).
    const syncDir = (src: string, dest: string): void => {
      if (!fs.existsSync(src)) return;
      fs.mkdirSync(dest, { recursive: true });
      for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        if (entry.name.startsWith('.open-bot-v17')) continue;
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) syncDir(srcPath, destPath);
        else if (entry.isFile()) fs.copyFileSync(srcPath, destPath);
      }
    };
    syncDir(cwd, workspaceDir);
    const startedAt = Date.now();
    const run = await runner.runShell(checkedBot, command, { ...limits, timeoutMs });
    // Đồng bộ ngược: file trong box workspace -> cwd (để eval đọc kết quả).
    syncDir(workspaceDir, cwd);
    return {
      exitCode: run.exitCode,
      stdout: run.stdout,
      stderr: run.stderr,
      timedOut: run.timedOut,
      durationMs: Date.now() - startedAt,
    };
  };
}

/** Render kết quả chạy sandbox thành text (ghi rõ isolation). */
export function renderV17SandboxRun(run: V17SandboxRun): string {
  const lines = [
    `Sandbox ${run.botId}: ${run.command} ${run.args.join(' ')} — exit ${String(run.exitCode)} (${run.durationMs}ms).`,
    `Isolation: ${run.isolation} (${run.isolated ? 'đã cách ly thật' : `KHÔNG cách ly — ${run.fallbackReason}`}), uid=${run.uid} (${run.nonRoot ? 'non-root' : 'ROOT — cảnh báo'}).`,
  ];
  if (run.timedOut) lines.push('Timeout: lệnh bị kill khi hết giờ.');
  if (run.stdout.trim() !== '') lines.push(`stdout: ${run.stdout.slice(0, 1000)}`);
  if (run.stderr.trim() !== '') lines.push(`stderr: ${run.stderr.slice(0, 1000)}`);
  return lines.join('\n');
}
