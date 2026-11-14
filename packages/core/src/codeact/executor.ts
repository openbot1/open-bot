/**
 * CodeAct v2 — executor (v1.04, Đội T4).
 *
 * Chạy `CodeActAction` trong `BotBoxManager` (sandbox local):
 * - bash: `/bin/sh -c <command>` trong box (timeout/cap ghi/cap output/
 *   prlimit CPU-RAM enforce thật bởi box, xem `sandbox/box.ts`).
 * - python: ghi code ra file tạm `<workspace>/.open-bot-codeact/
 *   codeact-<id>.py` rồi chạy `python3 <file> [args...]` trong box;
 *   file tạm xoá sau khi chạy (code vẫn nằm trong Action record).
 * - edit: ghi file qua `fs` trong `workspaceDir` của box — KHÔNG qua
 *   shell, path phải nằm trong workspace (chống `../` escape + kiểm
 *   `isPathAllowed` với allowlist `['.']`).
 *
 * An toàn:
 * - Denylist lệnh phá hoại (`isCodeActCommandBlocked`): `rm -rf /`,
 *   `mkfs`, ghi trực tiếp device (`dd of=/dev/...`), fork bomb,
 *   shutdown/reboot/poweroff, `chmod -R 777 /`… — kiểm tra TRƯỚC khi
 *   chạy, lệnh bị chặn trả Observation lỗi rõ ràng (exitCode null,
 *   stderr mang lý do), không throw (để agent đọc được như một kết
 *   quả tool bình thường).
 * - Mọi giới hạn đều enforce: timeout qua box, cap output qua box +
 *   cắt lại ở executor, cap code/edit qua validate.
 *
 * Giới hạn nói rõ: box trên máy này có thể là isolation `none` (không
 * có Docker/bwrap — xem `sandbox/env.ts` `detectIsolation`): khi đó
 * box chỉ là thư mục riêng + env allow-list + prlimit, KHÔNG phải
 * container. Observation ghi rõ `isolation` qua `limitsApplied` của
 * box khi có.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { BotBoxManager } from '../sandbox/box';
import { isPathAllowed } from '../sandbox/allowlist';
import type { BoxRunResult } from '../sandbox/types';
import {
  CODEACT_TMP_DIR,
  DEFAULT_CODEACT_LIMITS,
  type CodeActAction,
  type CodeActBashAction,
  type CodeActEditAction,
  type CodeActExecution,
  type CodeActLimits,
  type CodeActObservation,
  type CodeActPythonAction,
  type CodeActResult,
} from './types';

/** Lỗi ném ra khi action không hợp lệ (validate trước khi chạy). */
export class CodeActValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeActValidationError';
  }
}

/**
 * Mẫu lệnh phá hoại bị chặn (khớp trên command đã trim, không phân
 * biệt hoa thường). Denylist hẹp và tường minh — chỉ chặn hành vi phá
 * hoại hệ thống, không chặn workflow thường (`curl | sh` vẫn cho chạy
 * vì agent hay dùng để cài tool; sandbox box + prlimit là lớp chặn
 * còn lại).
 */
export const CODEACT_BLOCKED_COMMAND_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /(^|\s)rm\s+.*-rf?\s+(\/|\~|\$HOME)(\s|$)/i, reason: 'rm -rf thư mục gốc/home' },
  { pattern: /(^|\s)rm\s+.*--no-preserve-root/i, reason: 'rm --no-preserve-root' },
  { pattern: /(^|;|\s)mkfs(\s|\.)/i, reason: 'mkfs (format ổ đĩa)' },
  { pattern: /(^|;|\s)dd\s+.*of=\/dev\//i, reason: 'dd ghi trực tiếp device' },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/, reason: 'fork bomb' },
  { pattern: /(^|;|\s)(shutdown|reboot|poweroff|halt)(\s|;|$)/i, reason: 'shutdown/reboot/poweroff' },
  { pattern: /(^|;|\s)chmod\s+(-R\s+)?777\s+\//i, reason: 'chmod 777 thư mục gốc' },
  { pattern: />\s*\/dev\/sd[a-z]/i, reason: 'ghi trực tiếp ổ đĩa' },
];

/** Kiểm tra lệnh bash có nằm trong denylist phá hoại không. */
export function isCodeActCommandBlocked(command: string): { blocked: boolean; reason?: string } {
  const trimmed = command.trim();
  for (const { pattern, reason } of CODEACT_BLOCKED_COMMAND_PATTERNS) {
    if (pattern.test(trimmed)) return { blocked: true, reason };
  }
  return { blocked: false };
}

/** Tùy chọn của `CodeActExecutor`. */
export interface CodeActExecutorOptions {
  /** Box manager đã có (caller sở hữu vòng đời). */
  boxes: BotBoxManager;
  /** Bot sở hữu box (workspace riêng của bot). */
  botId: string;
  /** Ghi đè giới hạn mặc định. */
  limits?: Partial<CodeActLimits>;
  /** Binary python trong box. Mặc định `python3`. */
  pythonBin?: string;
}

/** Executor chạy CodeActAction trong box. */
export class CodeActExecutor {
  readonly botId: string;
  readonly limits: CodeActLimits;
  private readonly boxes: BotBoxManager;
  private readonly pythonBin: string;

  constructor(options: CodeActExecutorOptions) {
    this.boxes = options.boxes;
    this.botId = options.botId;
    this.limits = { ...DEFAULT_CODEACT_LIMITS, ...(options.limits ?? {}) };
    this.pythonBin = options.pythonBin ?? 'python3';
  }

  /** Đảm bảo box của bot tồn tại (tạo mới với limits CodeAct nếu chưa có). */
  ensureBox(): void {
    try {
      this.boxes.getBox(this.botId);
    } catch {
      this.boxes.createBox(this.botId, {
        limits: {
          timeoutMs: this.limits.timeoutMs,
          maxWriteBytes: this.limits.maxWriteBytes,
          maxOutputChars: this.limits.maxOutputChars,
          cpuSeconds: this.limits.cpuSeconds,
          maxMemoryBytes: this.limits.maxMemoryBytes,
        },
      });
    }
  }

  /** Thư mục workspace của box (nơi edit + file python tạm nằm). */
  workspaceDir(): string {
    this.ensureBox();
    return this.boxes.getBox(this.botId).workspaceDir;
  }

  /** Validate action trước khi chạy (ném `CodeActValidationError`). */
  validate(action: CodeActAction): void {
    switch (action.kind) {
      case 'bash': {
        const command = action.command.trim();
        if (command === '') {
          throw new CodeActValidationError('CodeAct bash: command rỗng.');
        }
        if (command.length > this.limits.maxCodeChars) {
          throw new CodeActValidationError(
            `CodeAct bash: command dài ${command.length} ký tự, vượt giới hạn ${this.limits.maxCodeChars}.`,
          );
        }
        break;
      }
      case 'python': {
        if (action.code.trim() === '') {
          throw new CodeActValidationError('CodeAct python: code rỗng.');
        }
        if (action.code.length > this.limits.maxCodeChars) {
          throw new CodeActValidationError(
            `CodeAct python: code dài ${action.code.length} ký tự, vượt giới hạn ${this.limits.maxCodeChars}.`,
          );
        }
        break;
      }
      case 'edit': {
        if (action.path.trim() === '') {
          throw new CodeActValidationError('CodeAct edit: path rỗng.');
        }
        const bytes = Buffer.byteLength(action.content, 'utf8');
        if (bytes > this.limits.maxEditBytes) {
          throw new CodeActValidationError(
            `CodeAct edit: nội dung ${bytes} bytes, vượt giới hạn ${this.limits.maxEditBytes}.`,
          );
        }
        break;
      }
      default:
        throw new CodeActValidationError(
          `CodeAct: kind không biết ${(action as { kind?: unknown }).kind}.`,
        );
    }
  }

  /**
   * Chạy một action, trả `CodeActResult` đầy đủ (Action → Execution →
   * Observation). Lệnh bị denylist chặn → Observation lỗi, KHÔNG throw
   * (để agent đọc như kết quả tool). Action không hợp lệ → throw
   * `CodeActValidationError` (lỗi của caller, không phải kết quả chạy).
   */
  async execute(action: CodeActAction): Promise<CodeActResult> {
    this.validate(action);
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    if (action.kind === 'bash') {
      const blocked = isCodeActCommandBlocked(action.command);
      if (blocked.blocked) {
        const durationMs = Date.now() - startedMs;
        return {
          action,
          execution: {
            id,
            actionKind: 'bash',
            startedAt,
            durationMs,
            command: action.command,
            args: [],
          },
          observation: {
            actionKind: 'bash',
            exitCode: null,
            signal: null,
            stdout: '',
            stderr: `CodeAct: lệnh bị chặn — ${blocked.reason ?? 'lệnh không được phép'}.`,
            timedOut: false,
            writeCapExceeded: false,
            truncated: false,
            durationMs,
          },
        };
      }
      const result = await this.runBash(action, id);
      return { action, execution: result.execution, observation: result.observation };
    }
    if (action.kind === 'python') {
      const result = await this.runPython(action, id, startedAt);
      return { action, execution: result.execution, observation: result.observation };
    }
    const result = this.runEdit(action, id, startedAt);
    return { action, execution: result.execution, observation: result.observation };
  }

  private async runBash(
    action: CodeActBashAction,
    id: string,
  ): Promise<{ execution: CodeActExecution; observation: CodeActObservation }> {
    this.ensureBox();
    const startedAt = new Date().toISOString();
    const boxResult: BoxRunResult = await this.boxes.runInBox(
      this.botId,
      '/bin/sh',
      ['-c', action.command],
      {
        timeoutMs: action.timeoutMs ?? this.limits.timeoutMs,
        // Xin thêm 1 ký tự so với cap để phát hiện tràn: box cắt đúng
        // bằng cap nên không có sentinel thì không biết output đã bị
        // cắt hay vừa đúng cap (xem observationFromBox).
        maxOutputChars: this.limits.maxOutputChars + 1,
      },
    );
    return {
      execution: {
        id,
        actionKind: 'bash',
        startedAt,
        durationMs: boxResult.durationMs,
        command: action.command,
        args: [],
        ...(boxResult.limitsApplied !== undefined ? { limitsApplied: boxResult.limitsApplied } : {}),
      },
      observation: this.observationFromBox('bash', boxResult),
    };
  }

  private async runPython(
    action: CodeActPythonAction,
    id: string,
    startedAt: string,
  ): Promise<{ execution: CodeActExecution; observation: CodeActObservation }> {
    this.ensureBox();
    const box = this.boxes.getBox(this.botId);
    const tmpDir = path.join(box.workspaceDir, CODEACT_TMP_DIR);
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, `codeact-${id}.py`);
    fs.writeFileSync(tmpFile, action.code, 'utf8');
    try {
      const boxResult: BoxRunResult = await this.boxes.runInBox(
        this.botId,
        this.pythonBin,
        [tmpFile, ...(action.args ?? [])],
        {
          timeoutMs: action.timeoutMs ?? this.limits.timeoutMs,
          // +1 sentinel để phát hiện tràn output (xem runBash).
          maxOutputChars: this.limits.maxOutputChars + 1,
        },
      );
      return {
        execution: {
          id,
          actionKind: 'python',
          startedAt,
          durationMs: boxResult.durationMs,
          command: `${this.pythonBin} ${tmpFile}`,
          args: [...(action.args ?? [])],
          tempFile: tmpFile,
          ...(boxResult.limitsApplied !== undefined
            ? { limitsApplied: boxResult.limitsApplied }
            : {}),
        },
        observation: this.observationFromBox('python', boxResult),
      };
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // File tạm đã mất (vd box reset) — không sao.
      }
    }
  }

  private runEdit(
    action: CodeActEditAction,
    id: string,
    startedAt: string,
  ): { execution: CodeActExecution; observation: CodeActObservation } {
    this.ensureBox();
    const startedMs = Date.now();
    const box = this.boxes.getBox(this.botId);
    const relative = action.path.replace(/\\/g, '/');
    // Path phải nằm trong workspace: chặn `../` escape + kiểm allowlist.
    const resolved = path.resolve(box.workspaceDir, relative);
    const inside =
      resolved === box.workspaceDir || resolved.startsWith(`${box.workspaceDir}${path.sep}`);
    if (!inside || !isPathAllowed(relative, { paths: ['.'] })) {
      throw new CodeActValidationError(
        `CodeAct edit: path "${action.path}" nằm ngoài workspace của box.`,
      );
    }
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    if (action.mode === 'append') {
      fs.appendFileSync(resolved, action.content, 'utf8');
    } else {
      fs.writeFileSync(resolved, action.content, 'utf8');
    }
    const bytes = Buffer.byteLength(action.content, 'utf8');
    const durationMs = Date.now() - startedMs;
    return {
      execution: {
        id,
        actionKind: 'edit',
        startedAt,
        durationMs,
        command: `edit ${relative}`,
        args: [],
      },
      observation: {
        actionKind: 'edit',
        exitCode: 0,
        signal: null,
        stdout: `Wrote ${bytes} bytes to ${relative} (${action.mode}).`,
        stderr: '',
        timedOut: false,
        writeCapExceeded: false,
        truncated: false,
        durationMs,
        fileWritten: { path: relative, bytes },
      },
    };
  }

  /** Đổi `BoxRunResult` thành `CodeActObservation` (cắt output lần nữa ở mức CodeAct). */
  private observationFromBox(
    kind: 'bash' | 'python',
    boxResult: BoxRunResult,
  ): CodeActObservation {
    const cap = this.limits.maxOutputChars;
    const stdoutCapped = boxResult.stdout.length > cap;
    const stderrCapped = boxResult.stderr.length > cap;
    return {
      actionKind: kind,
      exitCode: boxResult.exitCode,
      signal: boxResult.signal,
      stdout: stdoutCapped ? boxResult.stdout.slice(0, cap) : boxResult.stdout,
      stderr: stderrCapped ? boxResult.stderr.slice(0, cap) : boxResult.stderr,
      timedOut: boxResult.timedOut,
      writeCapExceeded: boxResult.writeCapExceeded,
      truncated: stdoutCapped || stderrCapped,
      durationMs: boxResult.durationMs,
      workspaceBytes: boxResult.workspaceBytes,
    };
  }
}
