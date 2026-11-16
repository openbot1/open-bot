/**
 * CodeAct-lite v2 — MỘT format action thống nhất (v1.14, Đội T3).
 *
 * Ý tưởng học từ OpenHands CodeActAgent (survey v1.14 §2): thay vì
 * 20 tool hẹp, cho agent bash + Python và để nó viết code làm mọi
 * việc. Nối với CodeAct v2 (`codeact/`, v1.04: bash/python/edit qua
 * `CodeActExecutor` trong BotBox sandbox) và CodeAct-lite v112
 * (v1.12: trích fenced block từ text tự do của agent): v2 gộp cả ba
 * nguồn input về MỘT kiểu `V6Action` duy nhất:
 *
 *   1. JSON: `{"kind":"bash","command":"..."}` (hoặc python/edit/
 *      think/finish/delegate) — format chính cho tool call.
 *   2. Fenced code block trong text tự do (` ```bash / ```python `)
 *      — trích bằng `extractCodeBlocks` của v112.
 *   3. Tool-call args `{kind, ...}` — parse bằng
 *      `codeActActionFromToolArgs` của CodeAct v2 (+ think/finish/
 *      delegate do v6 tự parse).
 *
 * Thêm hai kind mới so với CodeAct v2: `think` (suy luận không
 * commit action — ghi quyết định vào log) và `finish` (kết thúc
 * turn). `delegate` được parse ở đây nhưng chạy ở `delegate.ts`.
 *
 * An toàn: validate trước khi chạy (rỗng / quá dài / path `..` /
 * absolute / lệnh trong denylist của CodeAct v2 đều bị chặn, KHÔNG
 * chạy); chạy qua `CodeActExecutor` (BotBox sandbox, timeout/cap
 * output/cap ghi); security gate (xem `security.ts`) chạy TRƯỚC
 * execute — hàm `runV6Actions` nhận một `gate` callback, action
 * HIGH/UNKNOWN thì dừng lại chờ duyệt thay vì chạy lén.
 */

import { CodeActExecutor, CodeActValidationError, codeActActionFromToolArgs, isCodeActCommandBlocked } from '../codeact/index';
import { extractCodeBlocks } from '../conversationV112/index';
import type { V6Action, V6BashAction, V6DelegateAction, V6DelegateBudget, V6EditAction, V6FinishAction, V6Observation, V6PythonAction, V6ThinkAction } from './types';
import { clipV6Text } from './conversationLog';

/** Lỗi ném ra khi input action không hợp lệ (trước khi chạy). */
export class V6ActionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V6ActionValidationError';
  }
}

/** Số action tối đa trong một turn (chống model spam action). */
export const V6_MAX_ACTIONS_PER_TURN = 10;

/** Độ dài tối đa của một action text (think/finish). */
export const V6_MAX_ACTION_TEXT_CHARS = 8000;

/** Kết quả parse: action hợp lệ + cảnh báo (vd block bị bỏ qua). */
export interface V6ParseResult {
  actions: V6Action[];
  /** Cảnh báo không chặn parse (vd block ngôn ngữ khác bị bỏ). */
  warnings: string[];
}

/** Chữ ký của một action — dùng để phát hiện lặp (stuck detection). */
export function v6ActionSignature(action: V6Action): string {
  switch (action.kind) {
    case 'bash':
      return `bash:${action.command.trim()}`;
    case 'python':
      return `python:${action.code.trim().slice(0, 200)}`;
    case 'edit':
      return `edit:${action.path}:${action.mode}`;
    case 'think':
      return `think:${action.text.trim().slice(0, 120)}`;
    case 'finish':
      return 'finish';
    case 'delegate':
      return `delegate:${action.task.trim().slice(0, 120)}`;
    default:
      return 'unknown';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseBudget(value: unknown): V6DelegateBudget | undefined {
  if (!isRecord(value)) return undefined;
  const budget: V6DelegateBudget = {};
  if (typeof value['maxSteps'] === 'number') budget.maxSteps = value['maxSteps'];
  if (typeof value['timeoutMs'] === 'number') budget.timeoutMs = value['timeoutMs'];
  if (typeof value['maxTokens'] === 'number') budget.maxTokens = value['maxTokens'];
  return budget;
}

/**
 * Parse MỘT action từ object (JSON đã parse hoặc tool-call args).
 * bash/python/edit đi qua `codeActActionFromToolArgs` của CodeAct v2
 * (cùng một validation); think/finish/delegate do v6 parse.
 */
export function parseV6ActionFromObject(value: unknown): V6Action {
  if (!isRecord(value)) {
    throw new V6ActionValidationError('V6 action phải là object { kind, ... }.');
  }
  const kind = value['kind'];
  if (kind === 'bash' || kind === 'python' || kind === 'edit') {
    // CodeAct v2 validate + parse (command/code/path/content/mode).
    const base = codeActActionFromToolArgs(value);
    if (base.kind === 'bash') {
      const action: V6BashAction = { kind: 'bash', command: base.command };
      if (typeof base.timeoutMs === 'number') action.timeoutMs = base.timeoutMs;
      validateV6Action(action); // chặn lệnh trong denylist ngay khi parse
      return action;
    }
    if (base.kind === 'python') {
      const action: V6PythonAction = { kind: 'python', code: base.code };
      if (base.args) action.args = base.args;
      if (typeof base.timeoutMs === 'number') action.timeoutMs = base.timeoutMs;
      validateV6Action(action);
      return action;
    }
    const edit: V6EditAction = { kind: 'edit', path: base.path, content: base.content, mode: base.mode };
    validateV6Action(edit); // chặn path absolute / `..` ngay khi parse
    return edit;
  }
  if (kind === 'think') {
    if (typeof value['text'] !== 'string' || value['text'].trim() === '') {
      throw new V6ActionValidationError('V6 think: thiếu text (string, không rỗng).');
    }
    if (value['text'].length > V6_MAX_ACTION_TEXT_CHARS) {
      throw new V6ActionValidationError(`V6 think: text dài ${value['text'].length} ký tự, vượt giới hạn ${V6_MAX_ACTION_TEXT_CHARS}.`);
    }
    const action: V6ThinkAction = { kind: 'think', text: value['text'] };
    return action;
  }
  if (kind === 'finish') {
    if (typeof value['summary'] !== 'string' || value['summary'].trim() === '') {
      throw new V6ActionValidationError('V6 finish: thiếu summary (string, không rỗng).');
    }
    const action: V6FinishAction = { kind: 'finish', summary: value['summary'] };
    if (value['suggestCommit'] === true) action.suggestCommit = true;
    return action;
  }
  if (kind === 'delegate') {
    if (typeof value['task'] !== 'string' || value['task'].trim() === '') {
      throw new V6ActionValidationError('V6 delegate: thiếu task (string, không rỗng).');
    }
    const action: V6DelegateAction = { kind: 'delegate', task: value['task'] };
    if (typeof value['scope'] === 'string') action.scope = value['scope'];
    if (typeof value['role'] === 'string') action.role = value['role'];
    const budget = parseBudget(value['budget']);
    if (budget) action.budget = budget;
    return action;
  }
  throw new V6ActionValidationError(`V6 action: kind không biết ${JSON.stringify(kind)} (bash|python|edit|think|finish|delegate).`);
}

/** Parse MỘT action từ text JSON (fence ```json hoặc JSON trần). */
export function parseV6ActionFromJsonText(text: string): V6Action {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  const jsonText = fenced?.[1] ?? trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText ?? '');
  } catch {
    throw new V6ActionValidationError('V6 action: text không phải JSON hợp lệ.');
  }
  return parseV6ActionFromObject(parsed);
}

/**
 * Parse action từ text tự do của model (nguồn chính của CodeAct):
 * 1. Text là JSON (một action hoặc `{actions:[...]}`) → parse JSON.
 * 2. Có fenced block bash/python → mỗi block một action (v112).
 * 3. Không có gì chạy được → một action `think` giữ lại text (model
 *    chỉ suy luận, không commit action nào).
 */
export function parseV6ActionsFromText(text: string): V6ParseResult {
  const trimmed = text.trim();
  if (trimmed === '') return { actions: [], warnings: ['text rỗng: không có action nào'] };
  // Dạng 1: JSON — một action hoặc danh sách actions. JSON parse
  // được thì PHẢI là action hợp lệ (kind lạ → throw, không nuốt
  // thành think); chỉ khi không phải JSON mới rơi xuống dạng khác.
  if (trimmed.startsWith('{') || trimmed.startsWith('```json')) {
    const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
    const jsonText = fenced?.[1] ?? trimmed;
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText as string);
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined) {
      if (isRecord(parsed) && Array.isArray(parsed['actions'])) {
        const actions = (parsed['actions'] as unknown[]).map(parseV6ActionFromObject);
        if (actions.length > V6_MAX_ACTIONS_PER_TURN) {
          throw new V6ActionValidationError(`V6: ${actions.length} action vượt giới hạn ${V6_MAX_ACTIONS_PER_TURN}/turn.`);
        }
        return { actions, warnings: [] };
      }
      // Một action đơn (kind lạ → parseV6ActionFromObject throw).
      return { actions: [parseV6ActionFromObject(parsed)], warnings: [] };
    }
    // JSON hỏng hẳn → rơi xuống dạng fenced/think bên dưới.
  }
  // Dạng 2: fenced bash/python (CodeAct-lite v112).
  const blocks = extractCodeBlocks(text);
  if (blocks.length > 0) {
    if (blocks.length > V6_MAX_ACTIONS_PER_TURN) {
      throw new V6ActionValidationError(`V6: ${blocks.length} code block vượt giới hạn ${V6_MAX_ACTIONS_PER_TURN}/turn.`);
    }
    const actions: V6Action[] = blocks.map((b) =>
      b.kind === 'bash' ? { kind: 'bash', command: b.code } : { kind: 'python', code: b.code },
    );
    return { actions, warnings: [] };
  }
  // Dạng 3: không có code chạy được — giữ text làm think.
  const warnings: string[] = [];
  const unsupported = [...text.matchAll(/```([a-zA-Z0-9_-]+)/g)].map((m) => m[1]).filter((l) => l !== 'bash' && l !== 'sh' && l !== 'python' && l !== 'py');
  if (unsupported.length > 0) {
    warnings.push(`bỏ qua code block ngôn ngữ không hỗ trợ: ${[...new Set(unsupported)].join(', ')}`);
  }
  return { actions: [{ kind: 'think', text: clipV6Text(trimmed, V6_MAX_ACTION_TEXT_CHARS) }], warnings };
}

/**
 * Validate một action TRƯỚC khi chạy (không cần executor).
 * Ném `V6ActionValidationError` khi không hợp lệ; lệnh trong
 * denylist của CodeAct v2 cũng ném ở đây (để caller ghi observation
 * blocked thay vì chạy).
 */
export function validateV6Action(action: V6Action): void {
  switch (action.kind) {
    case 'bash': {
      if (action.command.trim() === '') throw new V6ActionValidationError('V6 bash: command rỗng.');
      const blocked = isCodeActCommandBlocked(action.command);
      if (blocked.blocked) {
        throw new V6ActionValidationError(`V6 bash: lệnh bị chặn — ${blocked.reason ?? 'denylist'}.`);
      }
      break;
    }
    case 'python': {
      if (action.code.trim() === '') throw new V6ActionValidationError('V6 python: code rỗng.');
      break;
    }
    case 'edit': {
      const path = action.path.trim();
      if (path === '') throw new V6ActionValidationError('V6 edit: path rỗng.');
      if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) {
        throw new V6ActionValidationError(`V6 edit: path phải tương đối trong workspace, gặp "${path}".`);
      }
      const segments = path.split(/[\\/]/);
      if (segments.includes('..')) {
        throw new V6ActionValidationError(`V6 edit: path không được chứa "..", gặp "${path}".`);
      }
      if (action.content === '') throw new V6ActionValidationError('V6 edit: content rỗng.');
      break;
    }
    case 'think':
      if (action.text.trim() === '') throw new V6ActionValidationError('V6 think: text rỗng.');
      break;
    case 'finish':
      if (action.summary.trim() === '') throw new V6ActionValidationError('V6 finish: summary rỗng.');
      break;
    case 'delegate':
      if (action.task.trim() === '') throw new V6ActionValidationError('V6 delegate: task rỗng.');
      break;
    default:
      throw new V6ActionValidationError(`V6 action: kind không biết ${(action as { kind?: unknown }).kind}.`);
  }
}

/** Kết quả chạy một action qua executor (chỉ bash/python/edit). */
export interface V6ExecuteResult {
  observation: V6Observation;
}

/** Chạy MỘT action bash/python/edit qua CodeActExecutor (đã validate). */
export async function executeV6CodeAction(
  action: V6BashAction | V6PythonAction | V6EditAction,
  executor: CodeActExecutor,
): Promise<V6Observation> {
  const startedMs = Date.now();
  try {
    validateV6Action(action);
  } catch (e) {
    if (e instanceof V6ActionValidationError) {
      return {
        action,
        ok: false,
        stdout: '',
        stderr: e.message,
        exitCode: null,
        timedOut: false,
        blocked: true,
        blockReason: e.message,
        durationMs: Date.now() - startedMs,
      };
    }
    throw e;
  }
  let result;
  try {
    result = await executor.execute(action);
  } catch (e) {
    if (e instanceof CodeActValidationError) {
      return {
        action,
        ok: false,
        stdout: '',
        stderr: e.message,
        exitCode: null,
        timedOut: false,
        blocked: true,
        blockReason: e.message,
        durationMs: Date.now() - startedMs,
      };
    }
    throw e;
  }
  const obs = result.observation;
  return {
    action,
    ok: obs.exitCode === 0 && !obs.timedOut && !obs.writeCapExceeded,
    stdout: obs.stdout,
    stderr: obs.stderr,
    exitCode: obs.exitCode,
    timedOut: obs.timedOut,
    blocked: false,
    durationMs: obs.durationMs,
    ...(obs.fileWritten ? { fileWritten: obs.fileWritten } : {}),
  };
}

/** Observation cho think/finish (không chạy gì). */
export function observationForNonCodeAction(action: V6ThinkAction | V6FinishAction): V6Observation {
  return {
    action,
    ok: true,
    stdout: action.kind === 'think' ? action.text : action.summary,
    stderr: '',
    exitCode: null,
    timedOut: false,
    blocked: false,
    durationMs: 0,
  };
}

/**
 * Render observation thành text ngắn cho model đọc ở step sau
 * (giống observation text của CodeAct v2, thêm trạng thái chặn).
 */
export function renderV6ObservationText(observation: V6Observation): string {
  const action = observation.action;
  const label =
    action.kind === 'bash'
      ? `bash: ${action.command}`
      : action.kind === 'python'
        ? 'python: <code>'
        : action.kind === 'edit'
          ? `edit: ${action.path} (${action.mode})`
          : action.kind === 'think'
            ? 'think'
            : action.kind === 'finish'
              ? 'finish'
              : `delegate: ${action.task.slice(0, 80)}`;
  if (observation.blocked) {
    return `[blocked] ${label}\nLý do: ${observation.blockReason ?? 'bị chặn'}`;
  }
  const lines = [`[${observation.ok ? 'ok' : 'error'}] ${label}`];
  if (observation.exitCode !== null) lines.push(`exit: ${observation.exitCode}`);
  if (observation.timedOut) lines.push('timedOut: true');
  if (observation.stdout.trim() !== '') lines.push(`stdout:\n${clipV6Text(observation.stdout, 2000)}`);
  if (observation.stderr.trim() !== '') lines.push(`stderr:\n${clipV6Text(observation.stderr, 2000)}`);
  if (observation.fileWritten) lines.push(`file: ${observation.fileWritten.path} (${observation.fileWritten.bytes} bytes)`);
  return lines.join('\n');
}
