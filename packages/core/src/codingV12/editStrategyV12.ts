/**
 * Coding agent v12 — edit strategy diff/patch kiểu Aider v2 (git-first).
 *
 * Học ý tưởng Aider v2 (chỉ học ý tưởng, tự thiết kế và viết lại hoàn
 * toàn, không copy code/text/tài sản): mỗi edit là một commit git riêng
 * (atomic), hỗ trợ cả hai định dạng edit, rollback được từng edit, và
 * verify bằng build/test thật sau mỗi edit. Module này làm 5 việc:
 *
 *   1. `diff` format: unified diff áp bằng `git apply` (git thật, argv,
 *      không shell) — đúng chuẩn Aider dùng diff để sửa nhiều chỗ.
 *   2. `patch` format: khối search/replace — đoạn cũ phải khớp đúng 1
 *      lần trong file (khớp 0 lần = sai vị trí, khớp 2+ lần = mơ hồ,
 *      cả hai đều từ chối thay vì đoán), rồi ghi file.
 *   3. Atomic commit: mỗi edit áp xong (và verify xanh, khi có lệnh
 *      verify) được commit riêng bằng `commitV9Atomic` — lịch sử là
 *      chuỗi commit 1-edit-1-commit, xem lại/rollback được từng cái.
 *   4. Verify sau mỗi edit: chạy lệnh verify của host (argv, không
 *      shell, có timeout); verify fail thì khôi phục cây làm việc về
 *      trạng thái trước edit và KHÔNG commit.
 *   5. Rollback từng edit: `git revert --no-edit <sha>` tạo commit
 *      revert riêng (lịch sử không bị viết lại), ghi vào history.
 *
 * Module không gọi model thật, không gọi mạng, không push remote — chỉ
 * làm việc trong workingDir (git repo). Giới hạn trung thực: `git
 * apply` yêu cầu diff có context khớp đúng file hiện tại (diff lệch
 * context thì fail rõ ràng, không tự sửa); patch block khớp theo chuỗi
 * chính xác (không fuzzy match); revert có thể conflict khi edit sau
 * đã sửa cùng vùng — khi đó báo lỗi, không ép.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { commitV9Atomic, runV9Git } from '../codingV9/gitAtomic';
import { CodingV12Error } from './types';
import type {
  V12Edit,
  V12EditApplyResult,
  V12EditHistoryEntry,
  V12PatchBlock,
  V12VerifyResult,
} from './types';

/** Timeout mặc định chạy lệnh verify sau mỗi edit, ms. */
export const V12_EDIT_DEFAULT_VERIFY_TIMEOUT_MS = 60_000;
/** Timeout tối đa cho một lệnh verify, ms. */
export const V12_EDIT_MAX_VERIFY_TIMEOUT_MS = 10 * 60_000;
/** Số ký tự output verify giữ lại trong kết quả. */
export const V12_EDIT_VERIFY_OUTPUT_LIMIT = 4000;
/** Số ký tự tối đa của một diff được chấp nhận. */
export const V12_EDIT_MAX_DIFF_CHARS = 1_000_000;
/** Số block tối đa trong một edit patch format. */
export const V12_EDIT_MAX_PATCH_BLOCKS = 100;
/** Author mặc định cho commit edit v12. */
export const V12_EDIT_AUTHOR_NAME = 'open-bot-coding-v12';
/** Email mặc định cho commit edit v12. */
export const V12_EDIT_AUTHOR_EMAIL = 'coding-v12@open-bot.local';

/** Id edit v12 mới (`v12e-<hex>`). */
export function v12NewEditId(): string {
  return `v12e-${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffffffff).toString(16).padStart(10, '0')}`;
}

/** Validate một edit v12 (throw CodingV12Error khi không hợp lệ). */
export function validateV12Edit(edit: V12Edit): void {
  if (!edit || typeof edit !== 'object') {
    throw new CodingV12Error('edit-invalid', 'Edit v12: edit không hợp lệ.');
  }
  if (typeof edit.id !== 'string' || edit.id.trim() === '') {
    throw new CodingV12Error('edit-invalid', 'Edit v12: id không được rỗng.');
  }
  if (typeof edit.file !== 'string' || edit.file.trim() === '' || path.posix.isAbsolute(edit.file) || edit.file.includes('..')) {
    throw new CodingV12Error('edit-invalid', `Edit v12: file đích không hợp lệ: "${String(edit.file)}".`);
  }
  if (typeof edit.summary !== 'string' || edit.summary.trim() === '') {
    throw new CodingV12Error('edit-invalid', 'Edit v12: summary không được rỗng.');
  }
  if (edit.format === 'diff') {
    if (typeof edit.diff !== 'string' || edit.diff.trim() === '') {
      throw new CodingV12Error('edit-invalid', 'Edit v12 (diff): diff không được rỗng.');
    }
    if (edit.diff.length > V12_EDIT_MAX_DIFF_CHARS) {
      throw new CodingV12Error('edit-invalid', `Edit v12 (diff): diff quá lớn (${edit.diff.length} ký tự).`);
    }
    const files = v12ParseUnifiedDiffFiles(edit.diff);
    if (files.length === 0) {
      throw new CodingV12Error('edit-invalid', 'Edit v12 (diff): không tìm thấy file nào trong diff (thiếu header ---/+++).');
    }
    if (!files.includes(edit.file)) {
      throw new CodingV12Error(
        'edit-invalid',
        `Edit v12 (diff): diff sửa ${files.join(', ')} nhưng edit khai file "${edit.file}".`,
      );
    }
  } else if (edit.format === 'patch') {
    if (!Array.isArray(edit.blocks) || edit.blocks.length === 0) {
      throw new CodingV12Error('edit-invalid', 'Edit v12 (patch): cần ít nhất một block search/replace.');
    }
    if (edit.blocks.length > V12_EDIT_MAX_PATCH_BLOCKS) {
      throw new CodingV12Error('edit-invalid', `Edit v12 (patch): quá nhiều block (${edit.blocks.length}).`);
    }
    for (const block of edit.blocks) {
      if (typeof block.oldText !== 'string' || block.oldText === '') {
        throw new CodingV12Error('edit-invalid', 'Edit v12 (patch): oldText của block không được rỗng.');
      }
      if (typeof block.newText !== 'string') {
        throw new CodingV12Error('edit-invalid', 'Edit v12 (patch): newText của block phải là chuỗi.');
      }
      if (block.oldText === block.newText) {
        throw new CodingV12Error('edit-invalid', 'Edit v12 (patch): block không thay đổi gì (oldText == newText).');
      }
    }
  } else {
    throw new CodingV12Error('edit-invalid', `Edit v12: format không hỗ trợ: "${String((edit as V12Edit).format)}".`);
  }
}

/** Lấy danh sách file đích trong một unified diff (từ header `+++ b/<file>`). */
export function v12ParseUnifiedDiffFiles(diff: string): string[] {
  const files: string[] = [];
  for (const line of diff.split('\n')) {
    const m = /^\+\+\+ b\/(.+)$/.exec(line.trimEnd());
    if (m && m[1] && m[1] !== '/dev/null' && !files.includes(m[1])) files.push(m[1]);
  }
  return files;
}

/** Đếm dòng thêm/xóa trong một unified diff (dòng `+`/`-` thật, trừ header). */
export function v12CountDiffLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { added, removed };
}

/**
 * Áp các block search/replace lên nội dung file (pure, không chạm đĩa).
 * Mỗi oldText phải khớp đúng 1 lần — 0 lần là sai vị trí, 2+ lần là mơ
 * hồ, cả hai đều throw để caller không áp sai chỗ.
 */
export function v12ApplyPatchBlocksToContent(content: string, blocks: V12PatchBlock[]): { content: string; added: number; removed: number } {
  let out = content;
  let added = 0;
  let removed = 0;
  for (const block of blocks) {
    const first = out.indexOf(block.oldText);
    if (first === -1) {
      throw new CodingV12Error(
        'edit-apply-failed',
        `Edit v12 (patch): không tìm thấy đoạn cần thay (bắt đầu bằng "${block.oldText.slice(0, 60).replace(/\n/g, ' ')}…") — file có thể đã đổi.`,
      );
    }
    if (out.indexOf(block.oldText, first + 1) !== -1) {
      throw new CodingV12Error(
        'edit-apply-failed',
        `Edit v12 (patch): đoạn cần thay khớp nhiều lần (mơ hồ) — bắt đầu bằng "${block.oldText.slice(0, 60).replace(/\n/g, ' ')}…" — hãy cho thêm context để khớp đúng 1 lần.`,
      );
    }
    out = out.slice(0, first) + block.newText + out.slice(first + block.oldText.length);
    added += block.newText.split('\n').length - 1;
    removed += block.oldText.split('\n').length - 1;
  }
  return { content: out, added, removed };
}

/** Bỏ các biến môi trường của node:test runner khỏi env của process con. */
export function stripTestRunnerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out.NODE_TEST_CONTEXT;
  return out;
}

/** Chạy một lệnh argv (không shell) với timeout, trả V12VerifyResult. */
export function runV12Command(argv: string[], cwd: string, timeoutMs = V12_EDIT_DEFAULT_VERIFY_TIMEOUT_MS): Promise<V12VerifyResult> {
  const started = Date.now();
  const timeout = Math.max(1000, Math.min(Math.floor(timeoutMs), V12_EDIT_MAX_VERIFY_TIMEOUT_MS));
  return new Promise<V12VerifyResult>((resolve) => {
    if (!Array.isArray(argv) || argv.length === 0 || typeof argv[0] !== 'string' || argv[0] === '') {
      resolve({
        command: argv,
        exitCode: null,
        ok: false,
        output: 'Lệnh verify rỗng.',
        timedOut: false,
        durationMs: Date.now() - started,
      });
      return;
    }
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      shell: false,
      // Lệnh con không được kế thừa NODE_TEST_CONTEXT của test runner:
      // khi harness chạy dưới `node --test`, process con `node --test`
      // sẽ bị Node bỏ qua test và exit 0 ("run() is being called
      // recursively") — test fail cũng thành pass. Xóa biến này để
      // lệnh test chạy thật trong mọi môi trường.
      env: stripTestRunnerEnv(process.env),
    });
    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // Process đã thoát.
      }
    }, timeout);
    timer.unref?.();
    const append = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      if (output.length > V12_EDIT_VERIFY_OUTPUT_LIMIT) output = output.slice(0, V12_EDIT_VERIFY_OUTPUT_LIMIT);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (err: Error) => {
      clearTimeout(timer);
      resolve({
        command: argv,
        exitCode: null,
        ok: false,
        output: `spawn error: ${err.message}`.slice(0, V12_EDIT_VERIFY_OUTPUT_LIMIT),
        timedOut: false,
        durationMs: Date.now() - started,
      });
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      resolve({
        command: argv,
        exitCode: timedOut ? null : code,
        ok: !timedOut && code === 0,
        output,
        timedOut,
        durationMs: Date.now() - started,
      });
    });
  });
}

/** Chạy lệnh verify sau một edit (alias rõ nghĩa của runV12Command). */
export async function runV12Verify(
  command: string[],
  workingDir: string,
  timeoutMs = V12_EDIT_DEFAULT_VERIFY_TIMEOUT_MS,
): Promise<V12VerifyResult> {
  return runV12Command(command, workingDir, timeoutMs);
}

/** Message commit cho một edit v12. */
export function v12CommitMessageForEdit(edit: V12Edit): string {
  return `v12: ${edit.summary}\n\nFile: ${edit.file} (format ${edit.format}, edit ${edit.id})`;
}

/** Lấy SHA HEAD hiện tại (undefined khi repo chưa có commit nào). */
async function currentHeadSha(workingDir: string): Promise<string | undefined> {
  const res = await runV9Git(['rev-parse', 'HEAD'], { workingDir });
  return res.exitCode === 0 ? res.stdout.trim() : undefined;
}

/** Khôi phục cây làm việc của một file về HEAD (dùng khi verify fail). */
async function restoreFileToHead(workingDir: string, file: string): Promise<void> {
  await runV9Git(['checkout', '--', file], { workingDir });
}

/** Số dòng thêm/xóa của file đích so với HEAD (qua `git diff --numstat`). */
async function numstatForFile(workingDir: string, file: string): Promise<{ added: number; removed: number }> {
  const res = await runV9Git(['diff', '--numstat', '--', file], { workingDir });
  if (res.exitCode !== 0) return { added: 0, removed: 0 };
  const line = res.stdout.trim().split('\n').find((l) => l.endsWith(`\t${file}`));
  if (!line) return { added: 0, removed: 0 };
  const [a, r] = line.split('\t');
  return { added: a === '-' ? 0 : Number(a) || 0, removed: r === '-' ? 0 : Number(r) || 0 };
}

export interface V12EditStrategyOptions {
  /** Lệnh verify chạy sau mỗi edit (argv, không shell). Không có = bỏ qua verify. */
  verifyCommand?: string[];
  /** Timeout lệnh verify, ms. Mặc định 60_000. */
  verifyTimeoutMs?: number;
  /** true = commit riêng từng edit sau khi verify xanh (mặc định true). */
  commit?: boolean;
  authorName?: string;
  authorEmail?: string;
}

export interface V12ApplyEditOptions {
  /** Ghi đè commit của strategy cho edit này. */
  commit?: boolean;
  /** Ghi đè verify: false = bỏ verify cho edit này. */
  verify?: boolean;
}

/**
 * Strategy edit git-first: áp edit (diff hoặc patch) → verify → commit
 * riêng → ghi history. Mỗi instance gắn với một workingDir (git repo).
 */
export class V12EditStrategy {
  readonly workingDir: string;
  private readonly options: Required<Omit<V12EditStrategyOptions, 'verifyCommand'>> & { verifyCommand?: string[] };
  private readonly history: V12EditHistoryEntry[] = [];

  constructor(workingDir: string, options: V12EditStrategyOptions = {}) {
    if (typeof workingDir !== 'string' || workingDir.trim() === '') {
      throw new CodingV12Error('edit-invalid', 'Edit strategy v12: workingDir không được rỗng.');
    }
    this.workingDir = path.resolve(workingDir);
    this.options = {
      verifyCommand: options.verifyCommand,
      verifyTimeoutMs: options.verifyTimeoutMs ?? V12_EDIT_DEFAULT_VERIFY_TIMEOUT_MS,
      commit: options.commit ?? true,
      authorName: options.authorName ?? V12_EDIT_AUTHOR_NAME,
      authorEmail: options.authorEmail ?? V12_EDIT_AUTHOR_EMAIL,
    };
  }

  /** Lịch sử edit đã áp (bản sao, theo thứ tự áp). */
  getHistory(): V12EditHistoryEntry[] {
    return this.history.map((h) => ({ ...h }));
  }

  /** Tìm entry history theo editId (undefined khi không có). */
  getHistoryEntry(editId: string): V12EditHistoryEntry | undefined {
    return this.history.find((h) => h.editId === editId);
  }

  /**
   * Áp một edit: validate → áp (diff qua `git apply`, patch qua
   * search/replace) → verify (khi có lệnh) → commit riêng. Verify
   * fail thì khôi phục file và không commit, trả ok=false.
   */
  async applyEdit(edit: V12Edit, opts: V12ApplyEditOptions = {}): Promise<V12EditApplyResult> {
    const started = Date.now();
    const fail = (error: string, verify?: V12VerifyResult): V12EditApplyResult => ({
      edit,
      ok: false,
      linesAdded: 0,
      linesRemoved: 0,
      verify,
      error,
      durationMs: Date.now() - started,
    });
    try {
      validateV12Edit(edit);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    const absFile = path.join(this.workingDir, edit.file);
    let parentSha: string | undefined;
    try {
      parentSha = await currentHeadSha(this.workingDir);
    } catch {
      parentSha = undefined;
    }
    // 1. Áp edit lên cây làm việc.
    let linesAdded = 0;
    let linesRemoved = 0;
    try {
      if (edit.format === 'diff') {
        const counts = v12CountDiffLines(edit.diff!);
        linesAdded = counts.added;
        linesRemoved = counts.removed;
        const tmpPatch = path.join(os.tmpdir(), `open-bot-v12-edit-${edit.id.replace(/[^a-zA-Z0-9]/g, '')}.patch`);
        fs.writeFileSync(tmpPatch, edit.diff!, 'utf8');
        try {
          const applied = await runV9Git(['apply', '--whitespace=nowarn', tmpPatch], { workingDir: this.workingDir });
          if (applied.exitCode !== 0) {
            return fail(
              `Edit v12 (diff): git apply thất bại (exit ${applied.exitCode}): ${(applied.stderr || applied.stdout).trim().slice(0, 500) || 'không có output'}`,
            );
          }
        } finally {
          try {
            fs.rmSync(tmpPatch, { force: true });
          } catch {
            // File tạm không xóa được — không chặn kết quả.
          }
        }
      } else {
        let content: string;
        try {
          content = fs.readFileSync(absFile, 'utf8');
        } catch {
          return fail(`Edit v12 (patch): không đọc được file "${edit.file}".`);
        }
        let replaced: { content: string; added: number; removed: number };
        try {
          replaced = v12ApplyPatchBlocksToContent(content, edit.blocks!);
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
        fs.writeFileSync(absFile, replaced.content, 'utf8');
        linesAdded = replaced.added;
        linesRemoved = replaced.removed;
      }
    } catch (err) {
      return fail(`Edit v12: áp edit thất bại: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Số dòng thật theo numstat (chính xác hơn đếm thô).
    const stat = await numstatForFile(this.workingDir, edit.file);
    if (stat.added + stat.removed > 0) {
      linesAdded = stat.added;
      linesRemoved = stat.removed;
    }
    if (linesAdded === 0 && linesRemoved === 0) {
      await restoreFileToHead(this.workingDir, edit.file).catch(() => undefined);
      return fail('Edit v12: edit không thay đổi gì trong file (diff rỗng sau khi áp).');
    }
    // 2. Verify sau edit (khi có lệnh và không bị tắt cho edit này).
    let verify: V12VerifyResult | undefined;
    const doVerify = opts.verify !== false && this.options.verifyCommand !== undefined;
    if (doVerify) {
      verify = await runV12Verify(this.options.verifyCommand!, this.workingDir, this.options.verifyTimeoutMs);
      if (!verify.ok) {
        await restoreFileToHead(this.workingDir, edit.file).catch(() => undefined);
        return fail(
          `Edit v12: verify thất bại sau edit "${edit.id}" (${verify.timedOut ? 'timeout' : `exit ${verify.exitCode}`}) — đã khôi phục file, không commit.`,
          verify,
        );
      }
    }
    // 3. Commit riêng cho edit này.
    const doCommit = opts.commit ?? this.options.commit;
    let commitSha: string | undefined;
    if (doCommit) {
      try {
        const commit = await commitV9Atomic({
          workingDir: this.workingDir,
          files: [edit.file],
          summary: edit.summary,
          message: v12CommitMessageForEdit(edit),
          authorName: this.options.authorName,
          authorEmail: this.options.authorEmail,
        });
        commitSha = commit.sha;
      } catch (err) {
        await restoreFileToHead(this.workingDir, edit.file).catch(() => undefined);
        return fail(
          `Edit v12: commit atomic thất bại cho edit "${edit.id}": ${err instanceof Error ? err.message : String(err)}`,
          verify,
        );
      }
      this.history.push({
        editId: edit.id,
        file: edit.file,
        format: edit.format,
        summary: edit.summary,
        commitSha: commitSha!,
        parentSha: parentSha ?? '',
        appliedAt: new Date().toISOString(),
      });
    }
    return {
      edit,
      ok: true,
      commitSha,
      parentSha,
      linesAdded,
      linesRemoved,
      verify,
      durationMs: Date.now() - started,
    };
  }

  /**
   * Rollback một edit đã commit: `git revert --no-edit <sha>` tạo
   * commit revert riêng (không viết lại lịch sử). Trả entry history
   * đã cập nhật rollbackSha.
   */
  async rollbackEdit(editId: string): Promise<V12EditHistoryEntry> {
    const entry = this.getHistoryEntry(editId);
    if (!entry) {
      throw new CodingV12Error('edit-not-found', `Edit v12: không có edit "${editId}" trong history để rollback.`);
    }
    if (entry.rollbackSha) {
      throw new CodingV12Error('edit-rollback-failed', `Edit v12: edit "${editId}" đã rollback rồi (${entry.rollbackSha.slice(0, 7)}).`);
    }
    const res = await runV9Git(
      ['-c', `user.name=${this.options.authorName}`, '-c', `user.email=${this.options.authorEmail}`, 'revert', '--no-edit', entry.commitSha],
      { workingDir: this.workingDir },
    );
    if (res.exitCode !== 0) {
      // Revert dở dang (conflict) thì abort để repo sạch rồi mới báo lỗi.
      await runV9Git(['revert', '--abort'], { workingDir: this.workingDir }).catch(() => undefined);
      throw new CodingV12Error(
        'edit-rollback-failed',
        `Edit v12: revert edit "${editId}" thất bại (exit ${res.exitCode}): ${(res.stderr || res.stdout).trim().slice(0, 500) || 'không có output'} — có thể edit sau đã sửa cùng vùng.`,
      );
    }
    const head = await currentHeadSha(this.workingDir);
    entry.rolledBackAt = new Date().toISOString();
    entry.rollbackSha = head ?? '';
    return { ...entry };
  }
}

/** Render history edit thành text ngắn (để log/UI). */
export function renderV12EditHistorySummary(history: V12EditHistoryEntry[]): string {
  if (history.length === 0) return 'Edit v12: chưa có edit nào.';
  const lines = [`Edit v12: ${history.length} edit đã commit.`];
  for (const h of history) {
    lines.push(
      `  ${h.editId} ${h.file} [${h.format}] ${h.commitSha.slice(0, 7)} — ${h.summary}${h.rollbackSha ? ` (đã rollback ${h.rollbackSha.slice(0, 7)})` : ''}`,
    );
  }
  return lines.join('\n');
}
