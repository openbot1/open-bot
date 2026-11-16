/**
 * CodeAct-lite v112 (Đội T2).
 *
 * Khác với CodeAct v2 (`codeact/`, agent gọi tool `bash`/`python`/
 * `edit` tường minh): CodeAct-lite trích các fenced code block từ
 * TEXT TỰ DO của agent (` ```bash … ``` `, ` ```python … ``` `) rồi
 * chạy chúng trong BotBox sandbox qua `CodeActExecutor` — agent
 * không cần gọi tool riêng, chỉ cần viết code trong câu trả lời.
 * Ý tưởng học từ OpenHands CodeAct (agent hành động bằng code):
 * chỉ học ý tưởng, không copy code.
 *
 * Luồng một lần chạy (`runCodeActLiteText`):
 * 1. `extractCodeBlocks(text)` — trích block bash/python (bỏ qua
 *    block ngôn ngữ khác, bỏ qua block rỗng).
 * 2. Với mỗi block (theo thứ tự xuất hiện, tối đa
 *    `maxActionsPerTurn`): kiểm tra policy (`policy.ts`); bị chặn →
 *    observation `blocked: true`, KHÔNG chạy, vẫn ghi action event
 *    (để replay thấy agent đã thử).
 * 3. Chạy qua `CodeActExecutor` (bash: `/bin/sh -c`; python: file
 *    tạm trong box) — timeout/cap output/cap ghi enforce bởi box +
 *    executor như CodeAct v2.
 * 4. Trả về danh sách `{ action, execution, observation, blocked }`
 *    theo đúng thứ tự — caller (session/tool) ghi thành event
 *    `action.codeact` / `observation.codeact` vào conversation log.
 *
 * An toàn: code chạy trong box (workspace riêng, prlimit, env
 * allow-list); policy chặn thêm leo thang/mạng/shell-pipe; code quá
 * dài → validation error (throw) để caller báo lại cho agent sửa.
 * Không chạy code khi executor chưa được host bind (trả về lỗi rõ).
 */

import { randomUUID } from 'node:crypto';
import {
  CodeActExecutor,
  CodeActValidationError,
  runCodeActAction,
  type CodeActAction,
  type CodeActResult,
} from '../codeact/index';
import { checkCodeActLitePolicy, codeActLiteBudgetExceeded, DEFAULT_CODEACT_LITE_LIMITS, type CodeActLiteLimits } from './policy';
import { truncateV112 } from './redact';

/** Lỗi ném ra khi input CodeAct-lite không hợp lệ (trước khi chạy). */
export class CodeActLiteValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeActLiteValidationError';
  }
}

/** Một fenced code block trích được từ text agent. */
export interface ExtractedCodeBlock {
  /** Loại code: bash | python. */
  kind: 'bash' | 'python';
  /** Code thô (chưa trim? đã trim). */
  code: string;
  /** Ngôn ngữ ghi trong fence (vd 'bash', 'sh', 'python', 'py'). */
  language: string;
  /** Vị trí block trong text (index bắt đầu của fence). */
  index: number;
}

/** Ngôn ngữ fence được chấp nhận cho từng loại. */
const BASH_LANGUAGES = new Set(['bash', 'sh', 'shell', 'zsh']);
const PYTHON_LANGUAGES = new Set(['python', 'py', 'python3']);

/**
 * Trích các fenced code block bash/python từ text. Bỏ qua:
 * - Fence không có ngôn ngữ hoặc ngôn ngữ khác (js, json, ts…).
 * - Block rỗng (chỉ whitespace).
 * - Fence không đóng (không có ``` kết thúc) — bỏ qua, không đoán.
 */
export function extractCodeBlocks(text: string): ExtractedCodeBlock[] {
  const blocks: ExtractedCodeBlock[] = [];
  const fenceRe = /```([A-Za-z0-9_-]*)\s*\n([\s\S]*?)\n?```/g;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(text)) !== null) {
    const language = (match[1] ?? '').trim().toLowerCase();
    const code = (match[2] ?? '').trim();
    if (code.length === 0) continue;
    if (BASH_LANGUAGES.has(language)) {
      blocks.push({ kind: 'bash', code, language, index: match.index });
    } else if (PYTHON_LANGUAGES.has(language)) {
      blocks.push({ kind: 'python', code, language, index: match.index });
    }
  }
  return blocks;
}

/** Kết quả một action CodeAct-lite (đã chạy hoặc bị chặn). */
export interface CodeActLiteRun {
  /** Action đã trích (bash/python). */
  action: CodeActAction;
  /** Id lần chạy (khớp action event ↔ observation event). */
  executionId: string;
  /** Chỉ số thứ tự trong turn (1-based). */
  actionIndex: number;
  /** True khi bị policy chặn (không chạy). */
  blocked: boolean;
  blockedReason?: string;
  /** Kết quả chạy (chỉ khi không bị chặn). */
  result?: CodeActResult;
  /** Observation rút gọn (luôn có — bị chặn cũng có observation lỗi). */
  observation: {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    truncated: boolean;
    durationMs: number;
  };
}

export interface CodeActLiteRunnerOptions {
  /** Executor CodeAct v2 đã bind với BotBoxManager (bắt buộc để chạy). */
  executor?: CodeActExecutor;
  /** Giới hạn lite (mặc định DEFAULT_CODEACT_LITE_LIMITS). */
  limits?: Partial<CodeActLiteLimits>;
  /** Cho phép `curl|sh` (host tin cậy). Mặc định false. */
  allowPipeToShell?: boolean;
  /** Timeout riêng cho lần chạy này (ghi đè limits.timeoutMs). */
  timeoutMs?: number;
}

/**
 * Trích + chạy các code block trong text agent. Trả về danh sách
 * run theo thứ tự xuất hiện. Không throw khi một action bị chặn —
 * action đó trả về observation blocked. Throw
 * CodeActLiteValidationError khi text không có block nào hoặc code
 * vượt `maxCodeChars`.
 */
export async function runCodeActLiteText(
  text: string,
  options: CodeActLiteRunnerOptions = {},
): Promise<CodeActLiteRun[]> {
  const limits: CodeActLiteLimits = { ...DEFAULT_CODEACT_LITE_LIMITS, ...options.limits };
  const blocks = extractCodeBlocks(text);
  if (blocks.length === 0) {
    throw new CodeActLiteValidationError(
      'Không tìm thấy code block bash/python nào trong text (cần ```bash hoặc ```python).',
    );
  }
  if (blocks.length > limits.maxActionsPerTurn) {
    throw new CodeActLiteValidationError(
      `Text chứa ${blocks.length} code block, vượt ngân sách ${limits.maxActionsPerTurn} action/turn — tách nhỏ yêu cầu ra.`,
    );
  }
  const runs: CodeActLiteRun[] = [];
  let actionsRun = 0;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    const actionIndex = i + 1;
    const executionId = `lite-${randomUUID()}`;
    if (block.code.length > limits.maxCodeChars) {
      throw new CodeActLiteValidationError(
        `Code block #${actionIndex} dài ${block.code.length} ký tự, vượt giới hạn ${limits.maxCodeChars}.`,
      );
    }
    const policy = checkCodeActLitePolicy(block.kind, block.code, {
      allowPipeToShell: options.allowPipeToShell,
    });
    if (policy.blocked) {
      runs.push({
        action: toCodeActAction(block),
        executionId,
        actionIndex,
        blocked: true,
        blockedReason: policy.reason,
        observation: {
          exitCode: null,
          stdout: '',
          stderr: `Blocked by CodeAct-lite policy (${policy.source}): ${policy.reason}`,
          timedOut: false,
          truncated: false,
          durationMs: 0,
        },
      });
      continue;
    }
    if (codeActLiteBudgetExceeded(actionsRun, limits)) {
      runs.push({
        action: toCodeActAction(block),
        executionId,
        actionIndex,
        blocked: true,
        blockedReason: `vượt ngân sách ${limits.maxActionsPerTurn} action/turn`,
        observation: {
          exitCode: null,
          stdout: '',
          stderr: `Blocked: vượt ngân sách ${limits.maxActionsPerTurn} action/turn.`,
          timedOut: false,
          truncated: false,
          durationMs: 0,
        },
      });
      continue;
    }
    if (!options.executor) {
      throw new CodeActLiteValidationError(
        'CodeAct-lite chưa bind executor: host phải truyền CodeActExecutor (BotBoxManager) trước khi chạy code.',
      );
    }
    const action = toCodeActAction(block, options.timeoutMs ?? limits.timeoutMs);
    let result: CodeActResult;
    try {
      result = await runSingleAction(options.executor, action);
    } catch (err) {
      if (err instanceof CodeActValidationError) throw err;
      throw new CodeActLiteValidationError(
        `Chạy code block #${actionIndex} lỗi: ${(err as Error).message}`,
      );
    }
    actionsRun += 1;
    const truncated = result.observation.stdout.length >= limits.maxOutputChars ||
      result.observation.stderr.length >= limits.maxOutputChars;
    runs.push({
      action,
      executionId,
      actionIndex,
      blocked: false,
      result,
      observation: {
        exitCode: result.observation.exitCode,
        stdout: truncateV112(result.observation.stdout, limits.maxOutputChars).text,
        stderr: truncateV112(result.observation.stderr, limits.maxOutputChars).text,
        timedOut: result.observation.timedOut,
        truncated: result.observation.truncated || truncated,
        durationMs: result.observation.durationMs,
      },
    });
  }
  return runs;
}

function toCodeActAction(block: ExtractedCodeBlock, timeoutMs?: number): CodeActAction {
  if (block.kind === 'bash') {
    return { kind: 'bash', command: block.code, timeoutMs };
  }
  return { kind: 'python', code: block.code, timeoutMs };
}

async function runSingleAction(
  executor: CodeActExecutor,
  action: CodeActAction,
): Promise<CodeActResult> {
  return runCodeActAction(executor, action);
}

/** Lấy code/lệnh của một action CodeAct-lite (chỉ bash/python — lite không tạo edit). */
export function codeActLiteActionCode(action: CodeActAction): string {
  if (action.kind === 'bash') return action.command;
  if (action.kind === 'python') return action.code;
  return '';
}

/** Mô tả ngắn một run để ghi vào event payload (codePreview). */
export function describeCodeActLiteRun(run: CodeActLiteRun, maxChars = 2000): string {
  return truncateV112(codeActLiteActionCode(run.action), maxChars).text;
}

/** Render kết quả các run thành text cho model đọc ở turn sau. */
export function renderCodeActLiteRunsText(runs: CodeActLiteRun[]): string {
  const lines: string[] = [];
  for (const run of runs) {
    const header = run.blocked
      ? `CodeAct #${run.actionIndex} (${run.action.kind}): BLOCKED — ${run.blockedReason}`
      : `CodeAct #${run.actionIndex} (${run.action.kind}): exit ${run.observation.exitCode}${run.observation.timedOut ? ' (timeout)' : ''} in ${run.observation.durationMs}ms`;
    lines.push(header);
    if (run.observation.stdout) lines.push(`stdout:\n${run.observation.stdout}`);
    if (run.observation.stderr) lines.push(`stderr:\n${run.observation.stderr}`);
  }
  return lines.join('\n');
}
