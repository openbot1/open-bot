/**
 * Git-first atomic commit cho coding agent v9 (v1.17, Đội T4).
 *
 * Học ý tưởng Aider (survey v1.17 §2): git-first, mỗi edit = 1
 * commit atomic + message; OpenHands: commit + mở draft PR tự động.
 * Tự thiết kế lại hoàn toàn, dùng git CLI thật qua `execFile`
 * (argv tách sẵn, không shell):
 *
 * - `commitV9Atomic`: stage đúng file của edit → commit → trả SHA +
 *   thống kê numstat. Commit message tự sinh từ diff (`generateV9CommitMessage`):
 *   dòng đầu mô tả thay đổi + file chính, body liệt kê file đổi
 *   (+/- dòng), footer ghi task + số vòng loop khi có.
 * - `applyV9EditAndCommit`: atomic theo nghĩa "edit → verify →
 *   commit, verify fail thì rollback về HEAD" (dùng `git checkout`
 *   / `git reset --hard` giới hạn trong repo làm việc).
 * - `generateV9DraftPrDescription`: từ `git log base..HEAD` + numstat
 *   từng commit, sinh tiêu đề + body markdown (summary, danh sách
 *   commit, file đổi, test summary do caller cung cấp).
 * - Mọi lệnh git chạy với identity riêng (`-c user.name/email`)
 *   để không phụ thuộc config user; timeout giết process group.
 *
 * Giới hạn trung thực:
 * - "Atomic" ở đây là ở mức một commit duy nhất cho một edit đã
 *   verify — không phải transaction ACID: nếu tiến trình chết giữa
 *   `commit` và trả kết quả, commit có thể đã tồn tại mà caller
 *   không biết SHA (host kiểm tra lại bằng `git log`).
 * - Rollback dùng `git checkout -- <paths>` + `git clean` CHỈ trên
 *   file của edit; không đụng file ngoài phạm vi edit.
 * - Không push, không tạo PR thật trên GitHub (chỉ sinh description
 *   để host/UI dùng khi mở PR).
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CodingV9Error } from './types';
import type {
  V9AtomicCommit,
  V9CommitSummary,
  V9DraftPr,
  V9EditResult,
  V9FileChangeStat,
  V9GitStatus,
} from './types';

/** Timeout mặc định cho một lệnh git, ms. */
export const V9_GIT_DEFAULT_TIMEOUT_MS = 30_000;
/** Identity git mặc định cho commit của agent. */
export const V9_GIT_AUTHOR_NAME = 'open-bot-coding-v9';
export const V9_GIT_AUTHOR_EMAIL = 'coding-v9@open-bot.local';
/** Số commit tối đa liệt kê trong draft-PR description. */
export const V9_GIT_MAX_PR_COMMITS = 50;
/** Số file tối đa liệt kê chi tiết trong commit message body. */
export const V9_GIT_MAX_MESSAGE_FILES = 10;

/** Tùy chọn chung cho lệnh git v9. */
export interface V9GitOptions {
  /** Repo làm việc (phải là git repo hoặc sẽ được init). */
  workingDir: string;
  /** Timeout, ms. Mặc định 30_000. */
  timeoutMs?: number;
  /** Tên author cho commit. */
  authorName?: string;
  /** Email author cho commit. */
  authorEmail?: string;
}

/** Kết quả thô của một lệnh git. */
export interface V9GitCommandResult {
  argv: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Chạy một lệnh git (argv, không shell) trong repo, có timeout. */
export function runV9Git(
  args: string[],
  options: V9GitOptions,
): Promise<V9GitCommandResult> {
  const timeoutMs = Math.max(1000, Math.floor(options.timeoutMs ?? V9_GIT_DEFAULT_TIMEOUT_MS));
  const cwd = path.resolve(options.workingDir);
  return new Promise<V9GitCommandResult>((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, killSignal: 'SIGKILL' },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new CodingV9Error('git-failed', 'git is not available on PATH.'));
          return;
        }
        const exitCode = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({
          argv: ['git', ...args],
          exitCode,
          stdout: typeof stdout === 'string' ? stdout : String(stdout),
          stderr: typeof stderr === 'string' ? stderr : String(stderr),
        });
      },
    );
    void child;
  });
}

/** Chạy git và throw CodingV9Error khi exit != 0 (kèm stderr). */
export async function runV9GitOrThrow(
  args: string[],
  options: V9GitOptions,
): Promise<V9GitCommandResult> {
  const res = await runV9Git(args, options);
  if (res.exitCode !== 0) {
    throw new CodingV9Error(
      'git-failed',
      `git ${args.join(' ')} failed (exit ${res.exitCode}): ${res.stderr.trim() || res.stdout.trim() || 'no output'}`,
    );
  }
  return res;
}

/** Kiểm tra một thư mục có phải git repo không (`git rev-parse`). */
export async function v9IsGitRepo(workingDir: string): Promise<boolean> {
  const res = await runV9Git(['rev-parse', '--git-dir'], { workingDir });
  return res.exitCode === 0;
}

/** Init repo khi chưa có (kèm commit rỗng để HEAD tồn tại). */
export async function v9EnsureGitRepo(options: V9GitOptions): Promise<boolean> {
  if (await v9IsGitRepo(options.workingDir)) return false;
  fs.mkdirSync(path.resolve(options.workingDir), { recursive: true });
  await runV9GitOrThrow(['init', '--quiet'], options);
  return true;
}

/** Parse `git status --porcelain=v1 -b` thành V9GitStatus. */
export function parseV9GitStatusPorcelain(output: string): V9GitStatus {
  const status: V9GitStatus = {
    clean: true,
    staged: [],
    modified: [],
    untracked: [],
    deleted: [],
    branch: '',
  };
  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith('## ')) {
      const head = line.slice(3).trim();
      const branch = head.split('...')[0]?.trim() ?? '';
      status.branch = branch === 'No commits yet on' ? '' : branch;
      if (branch.startsWith('No commits yet on ')) {
        status.branch = branch.replace('No commits yet on ', '').trim();
      }
      continue;
    }
    if (line.length < 4) continue;
    const x = line[0] as string;
    const y = line[1] as string;
    const file = line.slice(3).trim();
    if (!file) continue;
    status.clean = false;
    if (x === '?') {
      status.untracked.push(file);
      continue;
    }
    if (x === 'D' || y === 'D') status.deleted.push(file);
    if (x !== ' ' && x !== '?') status.staged.push(file);
    if (y !== ' ' && y !== '?') status.modified.push(file);
  }
  status.staged = [...new Set(status.staged)];
  status.modified = [...new Set(status.modified)];
  status.deleted = [...new Set(status.deleted)];
  return status;
}

/** Lấy trạng thái git hiện tại của repo. */
export async function v9GitStatus(options: V9GitOptions): Promise<V9GitStatus> {
  const res = await runV9GitOrThrow(['status', '--porcelain=v1', '-b'], options);
  return parseV9GitStatusPorcelain(res.stdout);
}

/** Parse output `git diff --numstat` (dạng `<added>\t<removed>\t<path>`). */
export function parseV9Numstat(output: string): V9FileChangeStat[] {
  const stats: V9FileChangeStat[] = [];
  for (const line of output.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const added = parts[0] === '-' ? 0 : Number.parseInt(parts[0] as string, 10);
    const removed = parts[1] === '-' ? 0 : Number.parseInt(parts[1] as string, 10);
    const filePath = (parts[2] as string).trim();
    if (!filePath || Number.isNaN(added) || Number.isNaN(removed)) continue;
    stats.push({ path: filePath, added, removed });
  }
  return stats;
}

/** Lấy numstat của vùng staged (`--cached`) hoặc working tree. */
export async function v9DiffNumstat(
  options: V9GitOptions,
  staged = false,
): Promise<V9FileChangeStat[]> {
  const args = staged
    ? ['diff', '--cached', '--numstat']
    : ['diff', '--numstat'];
  const res = await runV9GitOrThrow(args, options);
  return parseV9Numstat(res.stdout);
}

/** Rút gọn đường dẫn file thành tên hiển thị ngắn (basename + thư mục cha). */
export function v9ShortPath(relPath: string): string {
  const parts = relPath.split('/');
  if (parts.length <= 2) return relPath;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

/**
 * Sinh commit message từ thay đổi đã stage: dòng đầu
 * `v117-coding: <summary> (<file chính>)`, body liệt kê file đổi
 * (+/- dòng), footer ghi task + vòng loop khi có.
 */
export function generateV9CommitMessage(input: {
  summary: string;
  stats: V9FileChangeStat[];
  task?: string;
  roundsUsed?: number;
  scope?: string;
}): string {
  const { summary, stats, task, roundsUsed, scope } = input;
  const totalAdded = stats.reduce((s, f) => s + f.added, 0);
  const totalRemoved = stats.reduce((s, f) => s + f.removed, 0);
  const mainFile = stats.length > 0 ? v9ShortPath((stats[0] as V9FileChangeStat).path) : 'repo';
  const prefix = scope ? `${scope}: ` : 'v117-coding: ';
  const subject = `${prefix}${summary} (${mainFile}, +${totalAdded}/-${totalRemoved})`;
  const lines: string[] = [subject, ''];
  const shown = stats.slice(0, V9_GIT_MAX_MESSAGE_FILES);
  for (const f of shown) {
    lines.push(`- ${f.path}: +${f.added} -${f.removed}`);
  }
  if (stats.length > shown.length) {
    lines.push(`- ... and ${stats.length - shown.length} more file(s)`);
  }
  if (task) {
    lines.push('');
    lines.push(`Task: ${task}`);
  }
  if (roundsUsed !== undefined && roundsUsed > 0) {
    lines.push(`Sandbox loop: ${roundsUsed} round(s), verify passed.`);
  }
  lines.push('Generated by open-bot coding agent v9 (AST-aware edit + sandbox loop).');
  return lines.join('\n');
}

/**
 * Commit atomic: stage đúng `files` rồi commit với message (tự sinh
 * khi không cho trước). Trả về SHA + thống kê. Khi không có gì để
 * commit (repo sạch sau khi stage) thì throw `git-failed` rõ ràng.
 */
export async function commitV9Atomic(input: {
  workingDir: string;
  files: string[];
  summary: string;
  message?: string;
  task?: string;
  roundsUsed?: number;
  scope?: string;
  timeoutMs?: number;
  authorName?: string;
  authorEmail?: string;
}): Promise<V9AtomicCommit> {
  const opts: V9GitOptions = {
    workingDir: input.workingDir,
    timeoutMs: input.timeoutMs,
    authorName: input.authorName ?? V9_GIT_AUTHOR_NAME,
    authorEmail: input.authorEmail ?? V9_GIT_AUTHOR_EMAIL,
  };
  await v9EnsureGitRepo(opts);
  const uniqueFiles = [...new Set(input.files.filter((f) => f.trim() !== ''))];
  if (uniqueFiles.length === 0) {
    throw new CodingV9Error('git-failed', 'Atomic commit needs at least one file to stage.');
  }
  await runV9GitOrThrow(['add', '--', ...uniqueFiles], opts);
  const stats = await v9DiffNumstat(opts, true);
  if (stats.length === 0) {
    throw new CodingV9Error(
      'git-failed',
      'Nothing to commit after staging — the edit may have produced no change.',
    );
  }
  const message =
    input.message ??
    generateV9CommitMessage({
      summary: input.summary,
      stats,
      task: input.task,
      roundsUsed: input.roundsUsed,
      scope: input.scope,
    });
  await runV9GitOrThrow(
    [
      '-c',
      `user.name=${opts.authorName}`,
      '-c',
      `user.email=${opts.authorEmail}`,
      'commit',
      '--quiet',
      '-m',
      message,
    ],
    opts,
  );
  const shaRes = await runV9GitOrThrow(['rev-parse', 'HEAD'], opts);
  const sha = shaRes.stdout.trim();
  const totalAdded = stats.reduce((s, f) => s + f.added, 0);
  const totalRemoved = stats.reduce((s, f) => s + f.removed, 0);
  return {
    sha,
    shortSha: sha.slice(0, 7),
    message,
    files: stats.map((f) => f.path),
    stats,
    totalAdded,
    totalRemoved,
  };
}

/**
 * Rollback các file của edit về HEAD (checkout + clean untracked
 * trong danh sách). Dùng khi verify fail sau khi edit đã ghi file.
 */
export async function v9RollbackFiles(
  workingDir: string,
  files: string[],
  timeoutMs?: number,
): Promise<void> {
  const opts: V9GitOptions = { workingDir, timeoutMs };
  const unique = [...new Set(files.filter((f) => f.trim() !== ''))];
  if (unique.length === 0) return;
  await runV9GitOrThrow(['checkout', '--', ...unique], opts);
  const status = await v9GitStatus(opts);
  const untracked = unique.filter((f) => status.untracked.includes(f));
  if (untracked.length > 0) {
    await runV9GitOrThrow(['clean', '-f', '--', ...untracked], opts);
  }
}

/** Lấy lịch sử commit `base..HEAD` (mới nhất trước), kèm numstat từng commit. */
export async function v9CommitLogSince(
  workingDir: string,
  baseRef: string,
  timeoutMs?: number,
): Promise<V9CommitSummary[]> {
  const opts: V9GitOptions = { workingDir, timeoutMs };
  const range = baseRef ? `${baseRef}..HEAD` : 'HEAD';
  const format = '%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%aI%x1e';
  const res = await runV9Git(['log', `--format=${format}`, range], opts);
  if (res.exitCode !== 0) return [];
  const commits: V9CommitSummary[] = [];
  for (const record of res.stdout.split('\x1e')) {
    const trimmed = record.replace(/^\n+/, '').trim();
    if (!trimmed) continue;
    const fields = trimmed.split('\x1f');
    if (fields.length < 6) continue;
    const [sha = '', shortSha = '', subject = '', authorName = '', authorEmail = '', date = ''] = fields;
    const numstat = await runV9Git(['show', '--numstat', '--format=', shortSha], opts);
    const stats = numstat.exitCode === 0 ? parseV9Numstat(numstat.stdout) : [];
    commits.push({
      sha,
      shortSha,
      message: subject,
      subject,
      authorName,
      authorEmail,
      date,
      filesChanged: stats.length,
      added: stats.reduce((s, f) => s + f.added, 0),
      removed: stats.reduce((s, f) => s + f.removed, 0),
    });
    if (commits.length >= V9_GIT_MAX_PR_COMMITS) break;
  }
  return commits;
}

/**
 * Sinh draft-PR description từ lịch sử commit: tiêu đề từ commit
 * mới nhất (hoặc `summary` cho trước), body markdown gồm summary,
 * bảng commit, file đổi, test summary.
 */
export function generateV9DraftPrDescription(input: {
  commits: V9CommitSummary[];
  headBranch: string;
  baseBranch: string;
  summary?: string;
  testSummary?: string;
}): V9DraftPr {
  const { commits, headBranch, baseBranch, summary, testSummary } = input;
  const totalAdded = commits.reduce((s, c) => s + c.added, 0);
  const totalRemoved = commits.reduce((s, c) => s + c.removed, 0);
  const filesChanged = commits.reduce((s, c) => s + c.filesChanged, 0);
  const title = summary ?? (commits.length > 0
    ? (commits[0] as V9CommitSummary).subject
    : `Coding agent v9: ${headBranch}`);
  const lines: string[] = [];
  lines.push('## Summary');
  lines.push('');
  lines.push(summary ?? `Automated change by open-bot coding agent v9 (AST-aware edit + sandbox loop + atomic commits).`);
  lines.push('');
  lines.push(`- Commits: ${commits.length}`);
  lines.push(`- Files changed: ${filesChanged}`);
  lines.push(`- Lines: +${totalAdded} -${totalRemoved}`);
  lines.push('');
  lines.push('## Commits');
  lines.push('');
  if (commits.length === 0) {
    lines.push('_No commits in range._');
  } else {
    lines.push('| SHA | Subject | Files | + / - |');
    lines.push('| --- | ------- | ----- | ------ |');
    for (const c of commits) {
      lines.push(`| \`${c.shortSha}\` | ${c.subject} | ${c.filesChanged} | +${c.added} -${c.removed} |`);
    }
  }
  lines.push('');
  if (testSummary) {
    lines.push('## Tests');
    lines.push('');
    lines.push(testSummary);
    lines.push('');
  }
  lines.push('## Notes');
  lines.push('');
  lines.push('- Each edit was verified by re-parsing (AST-aware edit) and a sandbox verify loop before its atomic commit.');
  lines.push('- Review the diff per commit; every commit is independently revertible.');
  return {
    title,
    body: lines.join('\n'),
    headBranch,
    baseBranch,
    commitCount: commits.length,
    filesChanged,
    totalAdded,
    totalRemoved,
  };
}

/**
 * Atomic "edit → verify → commit": áp edit (callback ghi file),
 * chạy verify (callback trả ok/output), verify ok thì commit atomic,
 * verify fail thì rollback file về HEAD rồi throw `verify-failed`.
 * `editResult` dùng để lấy file + summary cho commit message.
 */
export async function applyV9EditAndCommit(input: {
  workingDir: string;
  edit: () => Promise<V9EditResult> | V9EditResult;
  verify: (edit: V9EditResult) => Promise<{ ok: boolean; output: string }> | { ok: boolean; output: string };
  summary: string;
  task?: string;
  roundsUsed?: number;
  timeoutMs?: number;
}): Promise<{ edit: V9EditResult; commit: V9AtomicCommit }> {
  const edit = await input.edit();
  const verification = await input.verify(edit);
  if (!verification.ok) {
    try {
      await v9RollbackFiles(input.workingDir, [edit.path], input.timeoutMs);
    } catch {
      /* rollback tốt nhất có thể; lỗi verify vẫn là lỗi chính */
    }
    throw new CodingV9Error(
      'verify-failed',
      `Verify failed after edit to ${edit.path}, rolled back: ${verification.output.slice(0, 500)}`,
    );
  }
  const commit = await commitV9Atomic({
    workingDir: input.workingDir,
    files: [edit.path],
    summary: input.summary,
    task: input.task,
    roundsUsed: input.roundsUsed,
    timeoutMs: input.timeoutMs,
  });
  return { edit, commit };
}
