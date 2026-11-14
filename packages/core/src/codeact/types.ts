/**
 * CodeAct v2 — types (v1.04, Đội T4).
 *
 * Ý tưởng học từ OpenHands V1 SDK (CodeActAgent): thay vì 20 tool
 * bespoke, cho agent bash + Python + editor, mọi hành động biểu diễn
 * bằng code qua contract thống nhất:
 *
 *   Action → Execution → Observation
 *
 * - `CodeActAction`: việc agent muốn làm (bash | python | edit).
 * - `CodeActExecution`: bản ghi lần chạy (id, thời gian, lệnh, giới
 *   hạn đã áp dụng) — để audit/replay.
 * - `CodeActObservation`: kết quả quan sát được (exit code, stdout,
 *   stderr, timedOut, cap vượt…) — thứ duy nhất agent nhìn thấy sau
 *   khi hành động chạy xong.
 *
 * Giới hạn tài nguyên là một phần của contract, không phải gợi ý:
 * timeout, cap output, cap ghi, cap CPU/RAM (qua prlimit của box),
 * kích thước code/file tối đa. Vượt giới hạn → observation ghi rõ
 * `timedOut` / `writeCapExceeded` / `truncated`, không crash.
 */

import type { AppliedResourceLimits } from '../sandbox/types';

/** Loại hành động CodeAct. */
export type CodeActActionKind = 'bash' | 'python' | 'edit';

/** Chạy lệnh shell trong box (`/bin/sh -c <command>`). */
export interface CodeActBashAction {
  kind: 'bash';
  /** Lệnh shell (vd `ls -la`, `npm test`). Không được rỗng. */
  command: string;
  /** Ghi đè timeout lần chạy này (ms). */
  timeoutMs?: number;
}

/** Chạy code Python trong box (`python3 <file tạm>`). */
export interface CodeActPythonAction {
  kind: 'python';
  /** Code Python (ghi ra file tạm trong box rồi chạy). Không được rỗng. */
  code: string;
  /** Đối số dòng lệnh đưa cho script (sys.argv[1:]). */
  args?: string[];
  /** Ghi đè timeout lần chạy này (ms). */
  timeoutMs?: number;
}

/** Ghi/sửa file trong workspace của box (qua fs, không qua shell). */
export interface CodeActEditAction {
  kind: 'edit';
  /** Đường dẫn tương đối trong workspace của box (vd `src/a.ts`). */
  path: string;
  /** Nội dung ghi. */
  content: string;
  /** `write` = ghi đè/tạo mới; `append` = nối vào cuối file. */
  mode: 'write' | 'append';
}

/** Một hành động CodeAct — việc agent muốn làm. */
export type CodeActAction = CodeActBashAction | CodeActPythonAction | CodeActEditAction;

/** Giới hạn tài nguyên cho CodeAct (đều được enforce thật). */
export interface CodeActLimits {
  /** Timeout mặc định mỗi lần chạy, ms. Mặc định 30_000. */
  timeoutMs: number;
  /** Số ký tự output tối đa giữ lại (stdout+stderr mỗi bên). Mặc định 20_000. */
  maxOutputChars: number;
  /** Tổng dung lượng ghi tối đa trong workspace, bytes. Mặc định 10 MB. */
  maxWriteBytes: number;
  /** Code Python tối đa, ký tự. Mặc định 64_000. */
  maxCodeChars: number;
  /** File edit tối đa, bytes. Mặc định 1 MB. */
  maxEditBytes: number;
  /** Tổng thời gian CPU tối đa một lần chạy, giây (prlimit). Mặc định không giới hạn. */
  cpuSeconds?: number;
  /** Bộ nhớ ảo tối đa một lần chạy, bytes (prlimit --as). Mặc định không giới hạn. */
  maxMemoryBytes?: number;
}

/** Giới hạn mặc định của CodeAct v2. */
export const DEFAULT_CODEACT_LIMITS: CodeActLimits = {
  timeoutMs: 30_000,
  maxOutputChars: 20_000,
  maxWriteBytes: 10 * 1024 * 1024,
  maxCodeChars: 64_000,
  maxEditBytes: 1024 * 1024,
};

/** Thư mục chứa file Python tạm trong workspace của box. */
export const CODEACT_TMP_DIR = '.open-bot-codeact';

/** Bản ghi một lần chạy CodeAct (để audit/replay). */
export interface CodeActExecution {
  /** Id duy nhất của lần chạy. */
  id: string;
  actionKind: CodeActActionKind;
  startedAt: string;
  /** Thời gian chạy, ms. */
  durationMs: number;
  /** Lệnh đã chạy (bash: command; python: `python3 <file>`; edit: `edit <path>`). */
  command: string;
  /** Đối số đã chạy (python args; các loại khác rỗng). */
  args: string[];
  /** Giới hạn đã áp dụng thật (trả về từ box/prlimit). */
  limitsApplied?: AppliedResourceLimits;
  /** File Python tạm đã dùng (chỉ kind python; file đã xoá sau khi chạy). */
  tempFile?: string;
}

/** Kết quả quan sát được sau khi chạy — thứ agent nhìn thấy. */
export interface CodeActObservation {
  actionKind: CodeActActionKind;
  /** Exit code (null khi bị signal kill; edit thành công = 0). */
  exitCode: number | null;
  /** Signal đã kill process (nếu có). */
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** True khi bị kill vì quá timeout. */
  timedOut: boolean;
  /** True khi bị kill vì vượt cap ghi. */
  writeCapExceeded: boolean;
  /** True khi output đã bị cắt ở maxOutputChars (ước lượng theo độ dài). */
  truncated: boolean;
  /** Thời gian chạy, ms. */
  durationMs: number;
  /** Dung lượng workspace sau khi chạy, bytes (bash/python). */
  workspaceBytes?: number;
  /** File đã ghi (chỉ kind edit). */
  fileWritten?: { path: string; bytes: number };
}

/** Kết quả đầy đủ một lần chạy CodeAct: Action → Execution → Observation. */
export interface CodeActResult {
  action: CodeActAction;
  execution: CodeActExecution;
  observation: CodeActObservation;
}
