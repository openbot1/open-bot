/**
 * CodeAct v2 — contract Action → Execution → Observation (v1.04, Đội T4).
 *
 * Tầng mỏng trên `CodeActExecutor`: parse action từ tool-call args,
 * chạy, rồi render observation thành text cho model / tool result.
 * Không chứa logic chạy — logic chạy nằm ở `executor.ts`.
 */

import type { CodeActExecutor } from './executor';
import { CodeActValidationError } from './executor';
import type { CodeActAction, CodeActResult } from './types';

/** Parse action CodeAct từ args của một tool call (unknown → typed). */
export function codeActActionFromToolArgs(args: unknown): CodeActAction {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new CodeActValidationError('CodeAct: args phải là object { kind, ... }.');
  }
  const a = args as Record<string, unknown>;
  const kind = a['kind'];
  if (kind === 'bash') {
    if (typeof a['command'] !== 'string') {
      throw new CodeActValidationError('CodeAct bash: thiếu command (string).');
    }
    const action: CodeActAction = { kind: 'bash', command: a['command'] };
    if (typeof a['timeoutMs'] === 'number') action.timeoutMs = a['timeoutMs'];
    return action;
  }
  if (kind === 'python') {
    if (typeof a['code'] !== 'string') {
      throw new CodeActValidationError('CodeAct python: thiếu code (string).');
    }
    const action: CodeActAction = { kind: 'python', code: a['code'] };
    if (Array.isArray(a['args']) && a['args'].every((x) => typeof x === 'string')) {
      action.args = [...(a['args'] as string[])];
    }
    if (typeof a['timeoutMs'] === 'number') action.timeoutMs = a['timeoutMs'];
    return action;
  }
  if (kind === 'edit') {
    if (typeof a['path'] !== 'string') {
      throw new CodeActValidationError('CodeAct edit: thiếu path (string, tương đối trong workspace).');
    }
    if (typeof a['content'] !== 'string') {
      throw new CodeActValidationError('CodeAct edit: thiếu content (string).');
    }
    const mode = a['mode'];
    if (mode !== 'write' && mode !== 'append') {
      throw new CodeActValidationError('CodeAct edit: mode phải là "write" hoặc "append".');
    }
    return { kind: 'edit', path: a['path'], content: a['content'], mode };
  }
  throw new CodeActValidationError(
    `CodeAct: kind không biết ${JSON.stringify(kind)} (chỉ bash | python | edit).`,
  );
}

/**
 * Chạy một action qua executor, trả kết quả đầy đủ. Đây là điểm vào
 * duy nhất mà loop/tool nên gọi — contract Action → Execution →
 * Observation nằm ở đúng một chỗ.
 */
export async function runCodeActAction(
  executor: CodeActExecutor,
  action: CodeActAction,
): Promise<CodeActResult> {
  return executor.execute(action);
}

/** Mô tả ngắn một action (để log/audit, không chứa nội dung dài). */
export function describeCodeActAction(action: CodeActAction): string {
  switch (action.kind) {
    case 'bash':
      return `bash: ${action.command.length > 120 ? `${action.command.slice(0, 119)}…` : action.command}`;
    case 'python':
      return `python: ${action.code.length} chars${(action.args ?? []).length > 0 ? ` args=${(action.args ?? []).join(' ')}` : ''}`;
    case 'edit':
      return `edit ${action.mode}: ${action.path} (${action.content.length} chars)`;
    default:
      return 'unknown action';
  }
}

/** Render observation thành text đưa lại cho model (tool result). */
export function codeActResultToText(result: CodeActResult): string {
  const o = result.observation;
  const lines: string[] = [];
  lines.push(`$ ${describeCodeActAction(result.action)}`);
  const status =
    o.timedOut
      ? `timed out after ${o.durationMs}ms`
      : o.writeCapExceeded
        ? `write cap exceeded after ${o.durationMs}ms`
        : `exit ${o.exitCode === null ? 'null' : o.exitCode}${o.signal !== null ? ` (signal ${o.signal})` : ''} in ${o.durationMs}ms`;
  lines.push(`[${status}]`);
  if (o.stdout !== '') lines.push(o.stdout);
  if (o.stderr !== '') lines.push(`stderr:\n${o.stderr}`);
  if (o.truncated) lines.push('(output truncated at limit)');
  return lines.join('\n');
}

/** Tóm tắt một dòng cho UI/log (không chứa output dài). */
export function summarizeCodeActResult(result: CodeActResult): string {
  const o = result.observation;
  if (o.timedOut) return `${describeCodeActAction(result.action)} → timed out (${o.durationMs}ms)`;
  if (o.writeCapExceeded) return `${describeCodeActAction(result.action)} → write cap exceeded`;
  if (o.exitCode !== 0) {
    return `${describeCodeActAction(result.action)} → exit ${o.exitCode === null ? 'null' : o.exitCode}`;
  }
  return `${describeCodeActAction(result.action)} → ok (${o.durationMs}ms)`;
}
