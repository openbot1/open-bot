/**
 * Git-first cho coding agent v2 (v1.08, Đội T2).
 *
 * Ý tưởng học từ Aider git-first (chỉ học ý tưởng, tự thiết kế và
 * viết lại hoàn toàn từ đầu — KHÔNG đọc, KHÔNG copy code/text/tài
 * sản của Aider hay bất kỳ repo nào khác):
 *
 *   - Mỗi edit của agent thành 1 commit riêng, có thể revert từng
 *     bước; message ghi rõ plan/step để lịch sử đọc được.
 *   - Diff xem được ngay (worktree hoặc từng commit), revert 1 commit,
 *     squash chuỗi commit thành 1 — tất cả qua git CLI của máy user.
 *
 * An toàn:
 *   - Chỉ chạy các subcommand trong allowlist; argv được dựng từ
 *     tham số có cấu trúc, KHÔNG bao giờ truyền chuỗi của user làm
 *     flag — chống option injection (`--upload-pack`, ...).
 *   - Mọi đường dẫn file phải nằm trong repo root (tương đối, không
 *     `..`, không tuyệt đối ngoài root).
 *   - Không push, không fetch, không chạm remote, không đụng config
 *     user (không tự set user.name/email — commit thiếu identity thì
 *     báo lỗi rõ ràng để user tự cấu hình).
 *   - Revert xung đột thì `git revert --abort` để repo về trạng thái
 *     trước lệnh, rồi báo lỗi — không để repo dở dang.
 *
 * Giới hạn trung thực:
 *   - Cần `git` trên PATH và repo đã `git init` (không tự init —
 *     agent không âm thầm biến thư mục thường thành repo).
 *   - Squash dùng `git reset --soft` nên yêu cầu HEAD và base đều
 *     là commit thường (không squash qua merge commit, không squash
 *     commit đầu tiên — base phải có commit cha... thực ra base là
 *     commit giữ lại, nên squash base..HEAD cần base tồn tại; squash
 *     toàn bộ lịch sử kể cả root commit thì base phải là root — reset
 *     --soft root vẫn chạy được, commit mới thay thế; chỉ cấm base
 *     không phải ancestor của HEAD).
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const CODING_V2_GIT_TIMEOUT_MS = 30_000;
/** Trần ký tự cho diff trả về (tránh tool result phình). */
export const CODING_V2_GIT_DIFF_MAX_CHARS = 20_000;
/** SHA hợp lệ: 7-40 ký tự hex. */
const SHA_RE = /^[0-9a-f]{7,40}$/i;

const ALLOWED_SUBCOMMANDS = new Set([
  'status',
  'add',
  'commit',
  'diff',
  'log',
  'show',
  'revert',
  'reset',
  'rev-parse',
  'merge-base',
]);

export class CodingV2GitError extends Error {
  constructor(
    message: string,
    public readonly command: string,
    public readonly stderr?: string,
  ) {
    super(message);
    this.name = 'CodingV2GitError';
  }
}

export interface CodingV2GitRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Chạy `git -C <repoRoot> <subcommand> ...` (execFile, không shell). */
export function runCodingV2Git(
  repoRoot: string,
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<CodingV2GitRunResult> {
  const subcommand = args[0];
  if (!subcommand || !ALLOWED_SUBCOMMANDS.has(subcommand)) {
    return Promise.reject(
      new CodingV2GitError(
        `Subcommand git không được phép: "${String(subcommand)}".`,
        args.join(' '),
      ),
    );
  }
  for (const arg of args.slice(1)) {
    if (arg.startsWith('-') && !isAllowedCodingV2GitFlag(subcommand, arg)) {
      return Promise.reject(
        new CodingV2GitError(`Flag git không được phép: "${arg}" cho ${subcommand}.`, args.join(' ')),
      );
    }
  }
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', repoRoot, ...args],
      { timeout: options.timeoutMs ?? CODING_V2_GIT_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(
            new CodingV2GitError(
              'Không tìm thấy lệnh `git` trên máy (cần git trên PATH).',
              args.join(' '),
            ),
          );
          return;
        }
        const exitCode = typeof error?.code === 'number' ? error.code : 0;
        if (error && exitCode !== 0) {
          reject(
            new CodingV2GitError(
              `git ${args.join(' ')} thất bại (exit ${exitCode}): ${String(stderr).trim() || error.message}`,
              args.join(' '),
              String(stderr),
            ),
          );
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr), exitCode });
      },
    );
  });
}

/** Flag nào được phép cho từng subcommand (danh sách đóng). */
function isAllowedCodingV2GitFlag(subcommand: string, flag: string): boolean {
  const allowed: Record<string, Set<string>> = {
    status: new Set(['--porcelain', '--short', '--branch']),
    add: new Set(['--']),
    commit: new Set(['-m', '--message', '--allow-empty']),
    diff: new Set(['--cached', '--stat', '--', '--no-color']),
    log: new Set(['--oneline', '--format=%H%x00%s%x00%an%x00%aI', '--max-count=20', '--max-count=50']),
    show: new Set(['--stat', '--patch', '--format=%H%x00%s%x00%an%x00%aI', '--no-color']),
    revert: new Set(['--no-edit', '--abort']),
    reset: new Set(['--soft']),
    'rev-parse': new Set(['--git-dir', '--verify', '--abbrev-ref', 'HEAD']),
    'merge-base': new Set(['--is-ancestor']),
  };
  const set = allowed[subcommand];
  if (!set) return false;
  if (set.has(flag)) return true;
  // Cho phép --max-count=<n> với n hợp lệ (log).
  if (subcommand === 'log' && /^--max-count=\d{1,3}$/.test(flag)) return true;
  return false;
}

/** Đường dẫn repo-relative hợp lệ cho git add/diff. */
export function isValidCodingV2GitPath(relPath: string): boolean {
  if (typeof relPath !== 'string' || relPath.trim() === '') return false;
  if (relPath.startsWith('/') || relPath.startsWith('\\') || relPath.includes('\0')) return false;
  return !relPath.split('/').some((p) => p === '..' || p === '');
}

export interface CodingV2GitStatus {
  clean: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  branch: string | null;
}

export interface CodingV2GitCommitInfo {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: string;
}

/** Parse `git status --porcelain=v1 --branch` thành cấu trúc. */
export function parseCodingV2GitStatusPorcelain(output: string): Omit<CodingV2GitStatus, 'branch'> {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  for (const line of output.split('\n')) {
    if (line.startsWith('##')) continue;
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    const file = line.slice(3).trim().replace(/^"(.*)"$/, '$1');
    if (code[0] === '?' && code[1] === '?') untracked.push(file);
    else {
      if (code[0] !== ' ' && code[0] !== '?') staged.push(file);
      if (code[1] !== ' ' && code[1] !== '?') unstaged.push(file);
    }
  }
  return {
    clean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0,
    staged,
    unstaged,
    untracked,
  };
}

/** Parse `git log --format=%H%x00%s%x00%an%x00%aI` thành commit info. */
export function parseCodingV2GitLog(output: string): CodingV2GitCommitInfo[] {
  const commits: CodingV2GitCommitInfo[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const [sha = '', message = '', author = '', date = ''] = line.split('\0');
    if (!SHA_RE.test(sha)) continue;
    commits.push({ sha, shortSha: sha.slice(0, 7), message, author, date });
  }
  return commits;
}

/**
 * Phiên git-first trên một repo: mỗi commit là một bước của agent,
 * revert/squash/diff đều qua đây. Không push/fetch, không remote.
 */
export class CodingV2GitSession {
  readonly repoRoot: string;

  constructor(repoRoot: string) {
    const resolved = path.resolve(repoRoot);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new CodingV2GitError(`Repo root không tồn tại hoặc không phải thư mục: ${repoRoot}.`, 'init');
    }
    this.repoRoot = resolved;
  }

  /** true khi thư mục là git repo (có .git hoặc worktree). */
  async isRepo(): Promise<boolean> {
    try {
      const result = await runCodingV2Git(this.repoRoot, ['rev-parse', '--git-dir']);
      return result.stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  async requireRepo(): Promise<void> {
    if (!(await this.isRepo())) {
      throw new CodingV2GitError(
        `Thư mục không phải git repo: ${this.repoRoot} (agent không tự git init — hãy git init trước).`,
        'rev-parse --git-dir',
      );
    }
  }

  /** Trạng thái worktree (staged/unstaged/untracked). */
  async status(): Promise<CodingV2GitStatus> {
    await this.requireRepo();
    const result = await runCodingV2Git(this.repoRoot, ['status', '--porcelain', '--branch']);
    const parsed = parseCodingV2GitStatusPorcelain(result.stdout);
    const branchLine = result.stdout.split('\n').find((l) => l.startsWith('## '));
    const branch = branchLine
      ? branchLine.slice(3).split('...')[0]?.replace(/^No commits yet on /, '') ?? null
      : null;
    return { ...parsed, branch };
  }

  /** Lịch sử commit mới nhất (mặc định 20). */
  async log(limit = 20): Promise<CodingV2GitCommitInfo[]> {
    await this.requireRepo();
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 50);
    const result = await runCodingV2Git(this.repoRoot, [
      'log',
      `--max-count=${safeLimit}`,
      '--format=%H%x00%s%x00%an%x00%aI',
    ]);
    return parseCodingV2GitLog(result.stdout);
  }

  /**
   * Commit các file đã đổi thành 1 commit riêng cho 1 bước.
   * Message ghi rõ plan/step để lịch sử đọc được, vd:
   * `[coding-v2] plan <id> step <step>: <summary>`.
   */
  async commitStep(options: {
    files: string[];
    message: string;
    planId?: string;
    stepId?: string;
  }): Promise<{ sha: string; shortSha: string; message: string; files: string[] }> {
    await this.requireRepo();
    if (!Array.isArray(options.files) || options.files.length === 0) {
      throw new CodingV2GitError('commitStep cần ít nhất 1 file để stage.', 'add');
    }
    for (const file of options.files) {
      if (!isValidCodingV2GitPath(file)) {
        throw new CodingV2GitError(`Đường dẫn không hợp lệ cho git: "${file}".`, 'add');
      }
    }
    const summary = options.message.trim();
    if (summary === '') throw new CodingV2GitError('commitStep cần message không rỗng.', 'commit');
    const fullMessage =
      options.planId && options.stepId
        ? `[coding-v2] plan ${options.planId} step ${options.stepId}: ${summary}`
        : `[coding-v2] ${summary}`;
    await runCodingV2Git(this.repoRoot, ['add', '--', ...options.files]);
    // Có gì staged không? --stat rỗng = không có gì để commit.
    // (Không dùng `diff --cached --quiet` vì exit 1 khi có diff, dễ
    // nhầm với lỗi thật.)
    const stat = await runCodingV2Git(this.repoRoot, ['diff', '--cached', '--stat']);
    if (stat.stdout.trim() === '') {
      throw new CodingV2GitError(
        'Không có thay đổi nào để commit (các file đưa vào không đổi so với HEAD).',
        'commit',
      );
    }
    try {
      await runCodingV2Git(this.repoRoot, ['commit', '-m', fullMessage]);
    } catch (e) {
      if (e instanceof CodingV2GitError && /user\.name|user\.email|identity/i.test(e.stderr ?? '')) {
        throw new CodingV2GitError(
          'Git chưa có identity (user.name/user.email) — hãy cấu hình `git config user.name` / `git config user.email` rồi thử lại. Agent không tự set identity.',
          'commit',
          e.stderr,
        );
      }
      throw e;
    }
    const head = await runCodingV2Git(this.repoRoot, [
      'log',
      '--max-count=1',
      '--format=%H%x00%s%x00%an%x00%aI',
    ]);
    const [info] = parseCodingV2GitLog(head.stdout);
    if (!info) throw new CodingV2GitError('Commit xong nhưng không đọc được HEAD.', 'log');
    return { sha: info.sha, shortSha: info.shortSha, message: fullMessage, files: [...options.files] };
  }

  /**
   * Diff view: worktree (`git diff`), staged (`--cached`), một commit
   * (`git show <sha>`), hoặc khoảng (`git diff <from>..<to>`).
   * Output cắt ở 20.000 ký tự, báo rõ khi bị cắt.
   */
  async diff(options: {
    commit?: string;
    from?: string;
    to?: string;
    staged?: boolean;
    paths?: string[];
  } = {}): Promise<{ text: string; truncated: boolean; kind: string }> {
    await this.requireRepo();
    let args: string[];
    let kind: string;
    if (options.commit !== undefined) {
      if (!SHA_RE.test(options.commit)) {
        throw new CodingV2GitError(`SHA commit không hợp lệ: "${options.commit}".`, 'show');
      }
      args = ['show', '--stat', '--patch', '--format=%H%x00%s%x00%an%x00%aI', '--no-color', options.commit];
      kind = `commit ${options.commit.slice(0, 7)}`;
    } else if (options.from !== undefined || options.to !== undefined) {
      const from = options.from ?? 'HEAD';
      const to = options.to ?? 'HEAD';
      if (!SHA_RE.test(from) && from !== 'HEAD') {
        throw new CodingV2GitError(`Ref không hợp lệ: "${from}".`, 'diff');
      }
      if (!SHA_RE.test(to) && to !== 'HEAD') {
        throw new CodingV2GitError(`Ref không hợp lệ: "${to}".`, 'diff');
      }
      args = ['diff', '--no-color', `${from}..${to}`];
      kind = `range ${from.slice(0, 7)}..${to.slice(0, 7)}`;
    } else {
      args = ['diff', '--no-color'];
      if (options.staged) args.push('--cached');
      kind = options.staged ? 'staged' : 'worktree';
    }
    if (options.paths && options.paths.length > 0) {
      for (const p of options.paths) {
        if (!isValidCodingV2GitPath(p)) {
          throw new CodingV2GitError(`Đường dẫn không hợp lệ cho git diff: "${p}".`, 'diff');
        }
      }
      args.push('--', ...options.paths);
    }
    const result = await runCodingV2Git(this.repoRoot, args);
    const text = result.stdout;
    if (text.length > CODING_V2_GIT_DIFF_MAX_CHARS) {
      return {
        text: `${text.slice(0, CODING_V2_GIT_DIFF_MAX_CHARS)}\n... (diff bị cắt ở ${CODING_V2_GIT_DIFF_MAX_CHARS} ký tự)`,
        truncated: true,
        kind,
      };
    }
    return { text, truncated: false, kind };
  }

  /** Revert 1 commit (tạo commit revert mới). Xung đột thì abort + báo lỗi. */
  async revert(sha: string): Promise<{ sha: string; shortSha: string; reverted: string }> {
    await this.requireRepo();
    if (!SHA_RE.test(sha)) {
      throw new CodingV2GitError(`SHA commit không hợp lệ: "${sha}".`, 'revert');
    }
    const status = await this.status();
    if (!status.clean) {
      throw new CodingV2GitError(
        'Worktree đang bẩn (có thay đổi chưa commit) — commit hoặc stash trước khi revert để tránh mất việc.',
        'revert',
      );
    }
    try {
      await runCodingV2Git(this.repoRoot, ['revert', '--no-edit', sha]);
    } catch (e) {
      try {
        await runCodingV2Git(this.repoRoot, ['revert', '--abort']);
      } catch {
        // abort cũng lỗi: repo có thể đang dở revert — báo rõ cho user.
      }
      throw new CodingV2GitError(
        `Revert ${sha.slice(0, 7)} thất bại (có thể xung đột — đã chạy revert --abort để trả repo về trạng thái cũ): ${
          e instanceof Error ? e.message : String(e)
        }`,
        'revert',
      );
    }
    const head = await runCodingV2Git(this.repoRoot, [
      'log',
      '--max-count=1',
      '--format=%H%x00%s%x00%an%x00%aI',
    ]);
    const [info] = parseCodingV2GitLog(head.stdout);
    if (!info) throw new CodingV2GitError('Revert xong nhưng không đọc được HEAD.', 'log');
    return { sha: info.sha, shortSha: info.shortSha, reverted: sha };
  }

  /**
   * Squash các commit từ sau `base` tới HEAD thành 1 commit duy nhất
   * (reset --soft base + commit mới). Base phải là ancestor của HEAD.
   */
  async squash(options: { base: string; message: string }): Promise<{
    sha: string;
    shortSha: string;
    squashed: CodingV2GitCommitInfo[];
    message: string;
  }> {
    await this.requireRepo();
    const base = options.base.trim();
    if (!SHA_RE.test(base)) {
      throw new CodingV2GitError(`SHA base không hợp lệ: "${options.base}".`, 'reset');
    }
    const message = options.message.trim();
    if (message === '') throw new CodingV2GitError('squash cần message không rỗng.', 'commit');
    const status = await this.status();
    if (!status.clean) {
      throw new CodingV2GitError(
        'Worktree đang bẩn — commit hoặc stash trước khi squash.',
        'reset',
      );
    }
    const squashed = await this.log(50);
    const baseIndex = squashed.findIndex((c) => c.sha.startsWith(base) || base.startsWith(c.sha));
    if (baseIndex === -1) {
      throw new CodingV2GitError(`Base ${base.slice(0, 7)} không nằm trong 50 commit gần nhất.`, 'log');
    }
    const toSquash = squashed.slice(0, baseIndex);
    if (toSquash.length < 2) {
      throw new CodingV2GitError(
        `Chỉ có ${toSquash.length} commit sau base — squash cần ít nhất 2 commit để gộp.`,
        'reset',
      );
    }
    // Xác nhận base là ancestor của HEAD (tránh reset nhầm nhánh).
    const ancestorCheck = await runCodingV2Git(this.repoRoot, ['merge-base', '--is-ancestor', base, 'HEAD'])
      .then(() => true)
      .catch(() => false);
    if (!ancestorCheck) {
      throw new CodingV2GitError(`Base ${base.slice(0, 7)} không phải ancestor của HEAD.`, 'merge-base');
    }
    await runCodingV2Git(this.repoRoot, ['reset', '--soft', base]);
    await runCodingV2Git(this.repoRoot, ['commit', '-m', `[coding-v2] squash: ${message}`]);
    const head = await runCodingV2Git(this.repoRoot, [
      'log',
      '--max-count=1',
      '--format=%H%x00%s%x00%an%x00%aI',
    ]);
    const [info] = parseCodingV2GitLog(head.stdout);
    if (!info) throw new CodingV2GitError('Squash xong nhưng không đọc được HEAD.', 'log');
    return { sha: info.sha, shortSha: info.shortSha, squashed: toSquash, message: `[coding-v2] squash: ${message}` };
  }
}
