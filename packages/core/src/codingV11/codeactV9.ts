/**
 * Coding agent v11 — CodeAct v9: engine hành động code.
 *
 * Nối CodeAct executor của v10 (chỉ chạy code node/python/bash rồi
 * trả Observation): v9 mở rộng thành ENGINE HÀNH ĐỘNG đầy đủ —
 * agent không chỉ chạy code mà còn đọc/ghi/append/xóa/di chuyển
 * file, chạy lệnh allowlist, commit git — mọi action chạy tuần tự
 * trong một plan, có 3 lớp an toàn mới:
 *
 *   1. dry-run: mô phỏng toàn bộ plan trước khi chạm đĩa — validate
 *      từng action (path trong workspace, file tồn tại, lệnh trong
 *      allowlist), mô tả tác động + preview diff; plan có action
 *      invalid thì không áp được (`canApply=false`).
 *   2. xác nhận: action rủi ro cao (xóa file, di chuyển file, ghi
 *      file nhạy cảm, lệnh phá hoại) BẮT BUỘC có xác nhận (id action
 *      nằm trong `confirmations`) — không có thì action bị skip với
 *      status `skipped-needs-confirmation`, không throw để agent đọc
 *      được như kết quả tool bình thường (pattern v10).
 *   3. rollback theo patch: trước mỗi lần ghi/xóa/di chuyển, nội
 *      dung cũ được lưu vào patch stack; `rollback()` khôi phục
 *      ngược thứ tự (file mới tạo thì xóa, file cũ thì ghi lại nội
 *      dung cũ) — có thể rollback cả plan đã áp xong.
 *
 * An toàn (kế thừa v9/v10, không chạy shell tuỳ tiện):
 * - Mọi path phải nằm trong workingDir (`v8IsOutsideWorkspace`).
 * - run-command chạy bằng argv qua `spawn` (không shell), lệnh đầu
 *   phải nằm trong allowlist + qua denylist argv của v9.
 * - run-code ủy thác cho `V10CodeActExecutor` (allowlist + denylist
 *   + timeout + cap output của v10), không viết lại.
 * - git-commit dùng `commitV9Atomic` của v9 (identity riêng, chỉ
 *   stage file trong phạm vi plan).
 */

import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { v9CheckDenyList, v9CountLineChanges, v9UnifiedDiff } from '../codingV9/diffUtil';
import { commitV9Atomic } from '../codingV9/gitAtomic';
import { v8IsOutsideWorkspace, v8NormalizeRelPath } from '../codingV8/refactor';
import { V10CodeActExecutor, V10_CODEACT_DEFAULT_ALLOWED_COMMANDS } from '../codingV10/codeactExec';
import { CodingV11Error } from './types';
import type {
  V11CodeActAction,
  V11CodeActActionResult,
  V11CodeActPlan,
  V11CodeActRollbackResult,
  V11CodeActRunResult,
  V11DryRunActionResult,
  V11DryRunResult,
  V11ActionRisk,
  V11PatchStackEntry,
} from './types';

/** Timeout mặc định mỗi lệnh run-command, ms. */
export const V11_CODEACT_DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
/** Timeout tối đa mỗi lệnh run-command, ms. */
export const V11_CODEACT_MAX_COMMAND_TIMEOUT_MS = 120_000;
/** Giới hạn ký tự output mỗi stream (run-command). */
export const V11_CODEACT_DEFAULT_COMMAND_OUTPUT_LIMIT = 20_000;
/** Số action tối đa trong một plan (chống plan phình). */
export const V11_CODEACT_MAX_ACTIONS_PER_PLAN = 100;
/** Số ký tự tối đa của diff preview trong dry-run. */
export const V11_CODEACT_DRY_RUN_DIFF_LIMIT = 20_000;

/** Path nhạy cảm: ghi vào đây luôn là rủi ro cao, cần xác nhận. */
export const V11_CODEACT_SENSITIVE_PATHS: readonly string[] = [
  'package.json',
  'package-lock.json',
  '.env',
  '.env.local',
  '.github/workflows/',
  'tsconfig.json',
];

/** Token phá hoại trong run-command: gặp là rủi ro cao (vẫn bị denylist chặn). */
export const V11_CODEACT_DESTRUCTIVE_TOKENS: readonly string[] = [
  'rm',
  'rmdir',
  'del',
  'format',
  'mkfs',
  'dd',
  'shutdown',
  'reboot',
  'push',
  '--force',
];

/** Tạo id plan duy nhất (`v11ca-<hex>`). */
export function v11NewCodeActPlanId(): string {
  return `v11ca-${crypto.randomBytes(6).toString('hex')}`;
}

/** Mức rủi ro của một action (quyết định có cần xác nhận không). */
export function v11ActionRisk(action: V11CodeActAction): V11ActionRisk {
  switch (action.kind) {
    case 'read-file':
      return 'low';
    case 'delete-file':
    case 'move-file':
      return 'high';
    case 'write-file': {
      const p = (action.path ?? '').replace(/\\/g, '/');
      if (V11_CODEACT_SENSITIVE_PATHS.some((s) => p === s || p.endsWith(`/${s}`) || p.startsWith(s))) {
        return 'high';
      }
      return 'medium';
    }
    case 'append-file':
      return 'medium';
    case 'run-command': {
      const tokens = (action.command ?? []).join(' ').toLowerCase();
      if (V11_CODEACT_DESTRUCTIVE_TOKENS.some((t) => tokens.split(/[\s;|&]+/).includes(t))) return 'high';
      return 'medium';
    }
    case 'run-code':
      return action.codeKind === 'bash' ? 'high' : 'medium';
    case 'git-commit':
      return 'medium';
    default:
      return 'high';
  }
}

/** true = action này bắt buộc có xác nhận trước khi áp thật. */
export function v11NeedsConfirmation(action: V11CodeActAction): boolean {
  return v11ActionRisk(action) === 'high';
}

/** Validate plan (throw CodingV11Error khi sai định dạng). */
export function validateV11CodeActPlan(plan: V11CodeActPlan): void {
  if (!plan || typeof plan.id !== 'string' || plan.id.trim() === '') {
    throw new CodingV11Error('codeact-action-invalid', 'CodeAct v9: plan thiếu id.');
  }
  if (!Array.isArray(plan.actions)) {
    throw new CodingV11Error('codeact-action-invalid', 'CodeAct v9: plan.actions phải là mảng.');
  }
  if (plan.actions.length === 0) {
    throw new CodingV11Error('codeact-action-invalid', 'CodeAct v9: plan rỗng, không có action nào.');
  }
  if (plan.actions.length > V11_CODEACT_MAX_ACTIONS_PER_PLAN) {
    throw new CodingV11Error(
      'codeact-action-invalid',
      `CodeAct v9: plan có ${plan.actions.length} action, vượt giới hạn ${V11_CODEACT_MAX_ACTIONS_PER_PLAN}.`,
    );
  }
  const seen = new Set<string>();
  for (const action of plan.actions) {
    if (!action || typeof action.id !== 'string' || action.id.trim() === '') {
      throw new CodingV11Error('codeact-action-invalid', 'CodeAct v9: action thiếu id.');
    }
    if (seen.has(action.id)) {
      throw new CodingV11Error('codeact-action-invalid', `CodeAct v9: trùng id action "${action.id}".`);
    }
    seen.add(action.id);
    const kinds: readonly string[] = [
      'read-file',
      'write-file',
      'append-file',
      'delete-file',
      'move-file',
      'run-code',
      'run-command',
      'git-commit',
    ];
    if (!kinds.includes(action.kind)) {
      throw new CodingV11Error('codeact-action-invalid', `CodeAct v9: kind action không hợp lệ: ${String(action.kind)}.`);
    }
  }
}

export interface V11CodeActEngineOptions {
  /** Working dir = repo root (mọi path đều tương đối với đây). */
  workingDir: string;
  /** Timeout mặc định mỗi lệnh run-command, ms. */
  commandTimeoutMs?: number;
  /** Giới hạn output mặc định mỗi stream (run-command). */
  commandOutputLimit?: number;
  /** Allowlist lệnh đầu tiên cho run-command (mặc định: allowlist v10). */
  allowedCommands?: readonly string[];
  /** Timeout/code executor v10 dùng cho run-code (mặc định tự tạo). */
  codeActExecutor?: V10CodeActExecutor;
}

export interface V11CodeActRunOptions {
  /** true = chỉ mô phỏng, không chạm đĩa. */
  dryRun?: boolean;
  /** Id action đã được xác nhận (chỉ áp action rủi ro cao khi có trong này). */
  confirmations?: ReadonlySet<string> | readonly string[];
  /** Có dừng ở action fail đầu tiên không (mặc định: dừng). */
  stopOnFailure?: boolean;
}

/**
 * Engine CodeAct v9: dry-run + apply plan action tuần tự, rollback
 * theo patch stack. Không gọi model, không gọi mạng.
 */
export class V11CodeActEngine {
  readonly workingDir: string;
  readonly commandTimeoutMs: number;
  readonly commandOutputLimit: number;
  readonly allowedCommands: readonly string[];
  private readonly codeActExecutor: V10CodeActExecutor;
  /** Patch stack của lần apply gần nhất (để rollback sau). */
  private lastPatchStack: V11PatchStackEntry[] = [];
  private lastPlanId: string | null = null;

  constructor(options: V11CodeActEngineOptions) {
    this.workingDir = path.resolve(options.workingDir);
    this.commandTimeoutMs = options.commandTimeoutMs ?? V11_CODEACT_DEFAULT_COMMAND_TIMEOUT_MS;
    this.commandOutputLimit = options.commandOutputLimit ?? V11_CODEACT_DEFAULT_COMMAND_OUTPUT_LIMIT;
    this.allowedCommands = options.allowedCommands ?? V10_CODEACT_DEFAULT_ALLOWED_COMMANDS;
    this.codeActExecutor = options.codeActExecutor ?? new V10CodeActExecutor({ workingDir: this.workingDir });
    fs.mkdirSync(this.workingDir, { recursive: true });
  }

  /** Patch stack của lần apply gần nhất (bản sao). */
  getPatchStack(): V11PatchStackEntry[] {
    return this.lastPatchStack.map((e) => ({ ...e }));
  }

  /** Plan id của lần apply gần nhất (null khi chưa apply lần nào). */
  getLastPlanId(): string | null {
    return this.lastPlanId;
  }

  /** Đọc nội dung file trong workspace (null = không tồn tại). */
  private readWorkspaceFile(relPath: string): string | null {
    try {
      return fs.readFileSync(path.join(this.workingDir, relPath), 'utf8');
    } catch {
      return null;
    }
  }

  /** Kiểm tra path của action (trả lý do lỗi hoặc null). */
  private checkPath(relPath: string | undefined, label: string): string | null {
    if (!relPath || relPath.trim() === '') return `${label}: thiếu path.`;
    if (v8IsOutsideWorkspace(relPath)) return `${label}: path thoát workspace: ${relPath}.`;
    return null;
  }

  /**
   * Mô phỏng toàn bộ plan: validate từng action, mô tả tác động,
   * preview diff — không chạm đĩa, không chạy code/lệnh.
   */
  dryRun(plan: V11CodeActPlan): V11DryRunResult {
    validateV11CodeActPlan(plan);
    const actions: V11DryRunActionResult[] = [];
    let validCount = 0;
    let needsConfirmationCount = 0;
    let invalidCount = 0;
    let willModifyDisk = false;
    for (const action of plan.actions) {
      const risk = v11ActionRisk(action);
      const needsConfirmation = v11NeedsConfirmation(action);
      if (needsConfirmation) needsConfirmationCount += 1;
      const result = this.dryRunAction(action, risk, needsConfirmation);
      if (result.valid) validCount += 1;
      else invalidCount += 1;
      if (['write-file', 'append-file', 'delete-file', 'move-file', 'git-commit'].includes(action.kind) && result.valid) {
        willModifyDisk = true;
      }
      actions.push(result);
    }
    return {
      planId: plan.id,
      title: plan.title,
      actions,
      validCount,
      needsConfirmationCount,
      invalidCount,
      canApply: invalidCount === 0,
      willModifyDisk,
    };
  }

  /** Mô phỏng MỘT action (không chạm đĩa). */
  private dryRunAction(
    action: V11CodeActAction,
    risk: V11ActionRisk,
    needsConfirmation: boolean,
  ): V11DryRunActionResult {
    const base = { actionId: action.id, kind: action.kind, risk, needsConfirmation };
    const invalid = (error: string): V11DryRunActionResult => ({ ...base, valid: false, effect: '', error });
    switch (action.kind) {
      case 'read-file': {
        const err = this.checkPath(action.path, 'read-file');
        if (err) return invalid(err);
        const rel = v8NormalizeRelPath(action.path as string);
        const content = this.readWorkspaceFile(rel);
        if (content === null) return invalid(`read-file: file không tồn tại: ${rel}.`);
        return { ...base, valid: true, effect: `đọc ${rel} (${content.length} ký tự)` };
      }
      case 'write-file': {
        const err = this.checkPath(action.path, 'write-file');
        if (err) return invalid(err);
        if (typeof action.content !== 'string') return invalid('write-file: thiếu content.');
        const rel = v8NormalizeRelPath(action.path as string);
        const oldContent = this.readWorkspaceFile(rel);
        const { added, removed } = v9CountLineChanges(oldContent ?? '', action.content);
        const diff = v9UnifiedDiff(oldContent ?? '', action.content, rel).text;
        return {
          ...base,
          valid: true,
          effect:
            oldContent === null
              ? `tạo mới ${rel} (+${added} dòng)`
              : `ghi đè ${rel} (+${added}/-${removed} dòng)`,
          diffPreview: diff.slice(0, V11_CODEACT_DRY_RUN_DIFF_LIMIT),
        };
      }
      case 'append-file': {
        const err = this.checkPath(action.path, 'append-file');
        if (err) return invalid(err);
        if (typeof action.content !== 'string' || action.content === '') {
          return invalid('append-file: thiếu content.');
        }
        const rel = v8NormalizeRelPath(action.path as string);
        const oldContent = this.readWorkspaceFile(rel);
        if (oldContent === null) return invalid(`append-file: file không tồn tại: ${rel} (dùng write-file để tạo mới).`);
        const newContent = oldContent + action.content;
        const { added } = v9CountLineChanges(oldContent, newContent);
        const diff = v9UnifiedDiff(oldContent, newContent, rel).text;
        return {
          ...base,
          valid: true,
          effect: `thêm ${added} dòng vào cuối ${rel}`,
          diffPreview: diff.slice(0, V11_CODEACT_DRY_RUN_DIFF_LIMIT),
        };
      }
      case 'delete-file': {
        const err = this.checkPath(action.path, 'delete-file');
        if (err) return invalid(err);
        const rel = v8NormalizeRelPath(action.path as string);
        const oldContent = this.readWorkspaceFile(rel);
        if (oldContent === null) return invalid(`delete-file: file không tồn tại: ${rel}.`);
        return { ...base, valid: true, effect: `xóa ${rel} (${oldContent.split('\n').length} dòng) — rollback được` };
      }
      case 'move-file': {
        const err = this.checkPath(action.path, 'move-file');
        if (err) return invalid(err);
        const err2 = this.checkPath(action.targetPath, 'move-file đích');
        if (err2) return invalid(err2);
        const src = v8NormalizeRelPath(action.path as string);
        const dst = v8NormalizeRelPath(action.targetPath as string);
        if (src === dst) return invalid('move-file: nguồn và đích trùng nhau.');
        if (this.readWorkspaceFile(src) === null) return invalid(`move-file: file nguồn không tồn tại: ${src}.`);
        if (this.readWorkspaceFile(dst) !== null) {
          return invalid(`move-file: file đích đã tồn tại (không ghi đè): ${dst}.`);
        }
        return { ...base, valid: true, effect: `di chuyển ${src} → ${dst}` };
      }
      case 'run-code': {
        if (typeof action.code !== 'string' || action.code.trim() === '') {
          return invalid('run-code: thiếu code.');
        }
        if (action.codeKind !== 'node' && action.codeKind !== 'python' && action.codeKind !== 'bash') {
          return invalid(`run-code: codeKind không hợp lệ: ${String(action.codeKind)}.`);
        }
        return { ...base, valid: true, effect: `chạy code ${action.codeKind} (${action.code.length} ký tự, sandbox v10)` };
      }
      case 'run-command': {
        if (!Array.isArray(action.command) || action.command.length === 0) {
          return invalid('run-command: thiếu command (argv).');
        }
        const first = path.basename(action.command[0] as string);
        if (!this.allowedCommands.includes(first)) {
          return invalid(`run-command: lệnh "${first}" không nằm trong allowlist.`);
        }
        const deny = v9CheckDenyList(action.command);
        if (deny) return invalid(`run-command: ${deny}`);
        return { ...base, valid: true, effect: `chạy lệnh: ${action.command.join(' ')}` };
      }
      case 'git-commit': {
        if (typeof action.message !== 'string' || action.message.trim() === '') {
          return invalid('git-commit: thiếu message.');
        }
        return { ...base, valid: true, effect: `commit git: "${action.message}"` };
      }
      default:
        return invalid(`kind action không hợp lệ: ${String((action as V11CodeActAction).kind)}.`);
    }
  }

  /**
   * Chạy một plan: dry-run thì chỉ mô phỏng; apply thì chạy tuần
   * tự, ghi patch stack để rollback. Action rủi ro cao chưa xác
   * nhận thì bị skip (không throw). Dừng ở action fail đầu tiên
   * khi `stopOnFailure` (mặc định true) — các action sau không chạy.
   */
  async run(plan: V11CodeActPlan, options: V11CodeActRunOptions = {}): Promise<V11CodeActRunResult> {
    const startedAt = Date.now();
    validateV11CodeActPlan(plan);
    const dryRun = options.dryRun ?? false;
    const stopOnFailure = options.stopOnFailure ?? true;
    const confirmations = new Set(
      Array.isArray(options.confirmations) ? options.confirmations : [...(options.confirmations ?? [])],
    );
    const preview = this.dryRun(plan);
    const results: V11CodeActActionResult[] = [];
    const patchStack: V11PatchStackEntry[] = [];
    let okCount = 0;
    let failedCount = 0;
    let deniedCount = 0;
    let skippedCount = 0;
    let stopped = false;
    for (const action of plan.actions) {
      if (stopped) break;
      const dry = preview.actions.find((a) => a.actionId === action.id);
      const started = Date.now();
      if (!dry || !dry.valid) {
        failedCount += 1;
        results.push({
          actionId: action.id,
          kind: action.kind,
          status: 'failed',
          durationMs: Date.now() - started,
          stdout: '',
          stderr: dry?.error ?? 'action không hợp lệ.',
          exitCode: null,
          reason: dry?.error ?? 'action không hợp lệ.',
        });
        if (stopOnFailure) stopped = true;
        continue;
      }
      if (dryRun) {
        // Dry-run: trả kết quả mô phỏng, không chạm đĩa.
        okCount += 1;
        results.push({
          actionId: action.id,
          kind: action.kind,
          status: 'ok',
          durationMs: 0,
          stdout: dry.effect,
          stderr: '',
          exitCode: null,
          diff: dry.diffPreview,
          reason: undefined,
        });
        continue;
      }
      if (dry.needsConfirmation && !confirmations.has(action.id)) {
        skippedCount += 1;
        results.push({
          actionId: action.id,
          kind: action.kind,
          status: 'skipped-needs-confirmation',
          durationMs: Date.now() - started,
          stdout: '',
          stderr: '',
          exitCode: null,
          reason: `Action "${action.id}" (${action.kind}) rủi ro cao, cần xác nhận trước khi áp.`,
        });
        if (stopOnFailure) stopped = true;
        continue;
      }
      const result = await this.applyAction(action, patchStack);
      if (result.status === 'ok') okCount += 1;
      else if (result.status === 'denied') deniedCount += 1;
      else failedCount += 1;
      results.push(result);
      if (result.status !== 'ok' && stopOnFailure) stopped = true;
    }
    if (!dryRun) {
      this.lastPatchStack = patchStack;
      this.lastPlanId = plan.id;
    }
    return {
      planId: plan.id,
      title: plan.title,
      dryRun,
      results,
      okCount,
      failedCount,
      deniedCount,
      skippedCount,
      ok: failedCount === 0 && deniedCount === 0 && skippedCount === 0 && results.length === plan.actions.length,
      patchStack,
      totalDurationMs: Date.now() - startedAt,
    };
  }

  /** Áp MỘT action thật (đã qua dry-run + xác nhận). */
  private async applyAction(
    action: V11CodeActAction,
    patchStack: V11PatchStackEntry[],
  ): Promise<V11CodeActActionResult> {
    const started = Date.now();
    const ok = (extra: Partial<V11CodeActActionResult>): V11CodeActActionResult => ({
      actionId: action.id,
      kind: action.kind,
      status: 'ok',
      durationMs: Date.now() - started,
      stdout: '',
      stderr: '',
      exitCode: null,
      ...extra,
    });
    const failed = (reason: string): V11CodeActActionResult => ({
      actionId: action.id,
      kind: action.kind,
      status: 'failed',
      durationMs: Date.now() - started,
      stdout: '',
      stderr: reason,
      exitCode: null,
      reason,
    });
    try {
      switch (action.kind) {
        case 'read-file': {
          const rel = v8NormalizeRelPath(action.path as string);
          const content = this.readWorkspaceFile(rel);
          if (content === null) return failed(`read-file: file không tồn tại: ${rel}.`);
          return ok({ stdout: content });
        }
        case 'write-file': {
          const rel = v8NormalizeRelPath(action.path as string);
          const oldContent = this.readWorkspaceFile(rel);
          patchStack.push({ actionId: action.id, path: rel, oldContent, existed: oldContent !== null });
          const abs = path.join(this.workingDir, rel);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, action.content as string, 'utf8');
          const diff = v9UnifiedDiff(oldContent ?? '', action.content as string, rel).text;
          return ok({ stdout: `đã ghi ${rel}`, diff });
        }
        case 'append-file': {
          const rel = v8NormalizeRelPath(action.path as string);
          const oldContent = this.readWorkspaceFile(rel);
          if (oldContent === null) return failed(`append-file: file không tồn tại: ${rel}.`);
          patchStack.push({ actionId: action.id, path: rel, oldContent, existed: true });
          fs.appendFileSync(path.join(this.workingDir, rel), action.content as string, 'utf8');
          const diff = v9UnifiedDiff(oldContent, oldContent + (action.content as string), rel).text;
          return ok({ stdout: `đã thêm vào ${rel}`, diff });
        }
        case 'delete-file': {
          const rel = v8NormalizeRelPath(action.path as string);
          const oldContent = this.readWorkspaceFile(rel);
          if (oldContent === null) return failed(`delete-file: file không tồn tại: ${rel}.`);
          patchStack.push({ actionId: action.id, path: rel, oldContent, existed: true });
          fs.unlinkSync(path.join(this.workingDir, rel));
          return ok({ stdout: `đã xóa ${rel}` });
        }
        case 'move-file': {
          const src = v8NormalizeRelPath(action.path as string);
          const dst = v8NormalizeRelPath(action.targetPath as string);
          const srcContent = this.readWorkspaceFile(src);
          if (srcContent === null) return failed(`move-file: file nguồn không tồn tại: ${src}.`);
          if (this.readWorkspaceFile(dst) !== null) return failed(`move-file: file đích đã tồn tại: ${dst}.`);
          // Patch stack: nguồn (khôi phục nội dung cũ) + đích (file mới → xóa khi rollback).
          patchStack.push({ actionId: action.id, path: src, oldContent: srcContent, existed: true });
          patchStack.push({ actionId: action.id, path: dst, oldContent: null, existed: false });
          const absDst = path.join(this.workingDir, dst);
          fs.mkdirSync(path.dirname(absDst), { recursive: true });
          fs.renameSync(path.join(this.workingDir, src), absDst);
          return ok({ stdout: `đã di chuyển ${src} → ${dst}` });
        }
        case 'run-code': {
          const result = await this.codeActExecutor.run({
            kind: action.codeKind as 'node' | 'python' | 'bash',
            code: action.code as string,
          });
          if (result.status === 'denied') {
            return {
              actionId: action.id,
              kind: action.kind,
              status: 'denied',
              durationMs: result.durationMs,
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode,
              reason: result.reason,
            };
          }
          return {
            actionId: action.id,
            kind: action.kind,
            status: result.status === 'ok' ? 'ok' : 'failed',
            durationMs: result.durationMs,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            reason: result.reason,
          };
        }
        case 'run-command': {
          const argv = action.command as string[];
          const first = path.basename(argv[0] as string);
          if (!this.allowedCommands.includes(first)) {
            return {
              actionId: action.id,
              kind: action.kind,
              status: 'denied',
              durationMs: Date.now() - started,
              stdout: '',
              stderr: `Command "${first}" is not in the CodeAct allowlist.`,
              exitCode: null,
              reason: `Command "${first}" is not in the CodeAct allowlist.`,
            };
          }
          const deny = v9CheckDenyList(argv);
          if (deny) {
            return {
              actionId: action.id,
              kind: action.kind,
              status: 'denied',
              durationMs: Date.now() - started,
              stdout: '',
              stderr: deny,
              exitCode: null,
              reason: deny,
            };
          }
          return this.spawnCommand(action, argv);
        }
        case 'git-commit': {
          const changed = [...new Set(patchStack.map((e) => e.path))];
          const files = action.files && action.files.length > 0 ? action.files : changed;
          if (files.length === 0) return failed('git-commit: không có file nào để commit.');
          const commit = await commitV9Atomic({
            workingDir: this.workingDir,
            files,
            summary: action.message as string,
            message: action.message as string,
          });
          return ok({ stdout: `commit ${commit.sha}`, commitSha: commit.sha });
        }
        default:
          return failed(`kind action không hợp lệ: ${String(action.kind)}.`);
      }
    } catch (err) {
      return failed((err as Error).message);
    }
  }

  /** Spawn argv (không shell) cho run-command: timeout + cap output. */
  private spawnCommand(
    action: V11CodeActAction,
    argv: string[],
  ): Promise<V11CodeActActionResult> {
    const started = Date.now();
    const timeoutMs = Math.min(
      Math.max(1, this.commandTimeoutMs),
      V11_CODEACT_MAX_COMMAND_TIMEOUT_MS,
    );
    const outputLimit = this.commandOutputLimit;
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
          // Process đã thoát.
        }
      }, timeoutMs);
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
          actionId: action.id,
          kind: action.kind,
          status: 'failed',
          durationMs: Date.now() - started,
          stdout: stdout.slice(0, outputLimit),
          stderr: `${stderr.slice(0, outputLimit)}\nspawn error: ${err.message}`,
          exitCode: null,
          reason: `Không chạy được lệnh: ${err.message}`,
        });
      });
      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        const exitCode = code ?? -1;
        resolve({
          actionId: action.id,
          kind: action.kind,
          status: timedOut ? 'failed' : exitCode === 0 ? 'ok' : 'failed',
          durationMs: Date.now() - started,
          stdout: stdout.slice(0, outputLimit),
          stderr: stderr.slice(0, outputLimit),
          exitCode: timedOut ? null : exitCode,
          reason: timedOut ? `Hết timeout ${timeoutMs}ms.` : exitCode === 0 ? undefined : `Lệnh thoát với code ${exitCode}.`,
        });
      });
    });
  }

  /**
   * Rollback một plan đã áp: khôi phục patch stack ngược thứ tự.
   * File mới tạo thì xóa, file cũ thì ghi lại nội dung cũ. Không
   * throw khi một file lỗi — ghi vào `failures` và tiếp tục.
   */
  rollback(planId: string, patchStack?: V11PatchStackEntry[]): V11CodeActRollbackResult {
    const stack = patchStack ?? (this.lastPlanId === planId ? this.lastPatchStack : []);
    let restored = 0;
    const failures: Array<{ path: string; reason: string }> = [];
    for (const entry of [...stack].reverse()) {
      try {
        const abs = path.join(this.workingDir, entry.path);
        if (!entry.existed) {
          if (fs.existsSync(abs)) fs.unlinkSync(abs);
        } else {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, entry.oldContent as string, 'utf8');
        }
        restored += 1;
      } catch (err) {
        failures.push({ path: entry.path, reason: (err as Error).message });
      }
    }
    return { planId, restored, failed: failures.length, failures, ok: failures.length === 0 };
  }
}

/** Chạy nhanh một plan CodeAct v9 (tạo engine tạm, không giữ stack). */
export async function runV11CodeActPlan(
  workingDir: string,
  plan: V11CodeActPlan,
  options: V11CodeActRunOptions = {},
): Promise<V11CodeActRunResult> {
  const engine = new V11CodeActEngine({ workingDir });
  return engine.run(plan, options);
}

/** Dry-run nhanh một plan CodeAct v9 (không cần giữ engine). */
export function dryRunV11CodeActPlan(workingDir: string, plan: V11CodeActPlan): V11DryRunResult {
  const engine = new V11CodeActEngine({ workingDir });
  return engine.dryRun(plan);
}
