/**
 * Git runner rieng cho coding agent v5 (v1.13, Doi T4).
 *
 * Y tuong hoc tu Aider git-first (chi hoc y tuong, tu thiet ke va viet
 * lai hoan toan tu dau — KHONG doc, KHONG copy code/text/tai san cua
 * Aider hay bat ky repo nao): moi edit cua agent la mot patch co the
 * xem truoc, duyet tung hunk, apply, commit, revert.
 *
 * Runner nay chi dung cho nhu cau cua v5 ma runner v2 chua co:
 * `git diff` (lay patch worktree/staged), `git apply` (apply patch
 * da duyet, co `--check` truoc), `git revert` (rollback theo commit),
 * `git reset --hard <sha>` (rollback pha huy — chi khi caller xac
 * nhan ro rang). Moi thu khac (status/log parse) tai dung ham parse
 * cua v2 de khong viet lap lai.
 *
 * An toan (giong v2, chat hon o cho apply):
 *   - Chi chay subcommand trong allowlist dong; argv dung tu tham so
 *     co cau truc, KHONG bao gio truyen chuoi cua user lam flag —
 *     chong option injection (`--upload-pack`, `--exec`, ...).
 *   - Patch apply chi qua stdin cua `git apply` (khong ghi file tam
 *     roi apply theo ten — tranh TOCTOU), `git apply --check` chay
 *     truoc khi apply that.
 *   - Duong dan file phai nam trong repo root (tuong doi, khong `..`,
 *     khong tuyet doi ngoai root). Patch text co duong dan tuyet doi
 *     hoac `../` se bi tu choi truoc khi apply.
 *   - Khong push, khong fetch, khong cham remote, khong dung config
 *     user (khong tu set user.name/email).
 *   - `reset --hard` la pha huy: chi chay khi caller truyen
 *     `allowDestructive: true` — neu khong thi tu choi ngay.
 *
 * Gioi han trung thuc:
 *   - Can `git` tren PATH va repo da `git init` (khong tu init).
 *   - `git apply` khong hieu rename/copy detection — patch rename
 *     phai di kem delete+add; preview van hien dung rename khi diff
 *     do git sinh ra.
 *   - Revert xung dot thi `git revert --abort` de repo ve trang thai
 *     truoc lenh, roi bao loi — khong de repo do dang.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  parseCodingV2GitLog,
  parseCodingV2GitStatusPorcelain,
} from '../codingV2/gitFirst';
import type {
  CodingV2GitCommitInfo,
  CodingV2GitStatus,
} from '../codingV2/gitFirst';

export const CODING_V5_GIT_TIMEOUT_MS = 30_000;
/** SHA hop le: 7-40 ky tu hex. */
const SHA_RE = /^[0-9a-f]{7,40}$/i;
/** Dong `diff --git a/<path> b/<path>` — dung de kiem tra duong dan trong patch. */
const DIFF_GIT_RE = /^diff --git (a\/\S+|"?[^"]+"?) (b\/\S+|"?[^"]+"?)\s*$/;
/** Dong `--- a/<path>` / `+++ b/<path>`. */
const DIFF_PATH_RE = /^(---|\+\+\+) (a\/|b\/)(\S+)\s*$/;

const ALLOWED_SUBCOMMANDS = new Set([
  'status',
  'add',
  'commit',
  'diff',
  'apply',
  'log',
  'show',
  'revert',
  'reset',
  'rev-parse',
]);

export class CodingV5GitError extends Error {
  constructor(
    message: string,
    public readonly command: string,
    public readonly stderr?: string,
  ) {
    super(message);
    this.name = 'CodingV5GitError';
  }
}

export interface CodingV5GitRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Flag nao duoc phep cho tung subcommand (danh sach dong). */
function isAllowedCodingV5GitFlag(subcommand: string, flag: string): boolean {
  const allowed: Record<string, Set<string>> = {
    status: new Set(['--porcelain', '--short', '--branch']),
    add: new Set(['--']),
    commit: new Set(['-m', '--message', '--allow-empty']),
    diff: new Set(['--cached', '--stat', '--', '--no-color', '--src-prefix=a/', '--dst-prefix=b/']),
    apply: new Set(['--check', '--whitespace=fix', '--cached', '--index', '--3way']),
    log: new Set(['--oneline', '--format=%H%x00%s%x00%an%x00%aI', '--max-count=20', '--max-count=50']),
    show: new Set(['--stat', '--patch', '--format=%H%x00%s%x00%an%x00%aI', '--no-color']),
    revert: new Set(['--no-edit', '--abort']),
    reset: new Set(['--hard', '--soft']),
    'rev-parse': new Set(['--git-dir', '--verify', '--abbrev-ref', 'HEAD']),
  };
  const set = allowed[subcommand];
  if (!set) return false;
  if (set.has(flag)) return true;
  if (subcommand === 'log' && /^--max-count=\d{1,3}$/.test(flag)) return true;
  // Cho phep --format=<bat ky> cho log/show chi khi dung dinh dang %H%x00...
  if (
    (subcommand === 'log' || subcommand === 'show') &&
    flag.startsWith('--format=%H%x00%s%x00%an%x00%aI')
  ) {
    return true;
  }
  return false;
}

/** SHA hop le cho revert/reset/show/log. */
export function isValidCodingV5Sha(value: string): boolean {
  return SHA_RE.test(value);
}

/** Duong dan repo-relative hop le cho git add/diff. */
export function isValidCodingV5GitPath(relPath: string): boolean {
  if (typeof relPath !== 'string' || relPath.trim() === '') return false;
  if (relPath.startsWith('/') || relPath.startsWith('\\') || relPath.includes('\0')) return false;
  return !relPath.split('/').some((p) => p === '..' || p === '');
}

/**
 * Kiem tra patch text khong chua duong dan thoat khoi repo (tuyet doi
 * hoac `../`). Tra ve danh sach duong dan vi pham (rong = sach).
 * Chi kiem tra dong header (`diff --git`, `---`, `+++`) — noi dung
 * hunk co the chua bat ky chuoi nao ma khong anh huong duong dan.
 */
export function findCodingV5PatchPathViolations(patchText: string): string[] {
  const violations: string[] = [];
  for (const line of patchText.split('\n')) {
    const gitMatch = DIFF_GIT_RE.exec(line);
    if (gitMatch) {
      for (const p of [gitMatch[1], gitMatch[2]]) {
        const stripped = (p ?? '').replace(/^a\/|^b\//, '').replace(/^"|"$/g, '');
        if (!isValidCodingV5GitPath(stripped) || stripped.startsWith('/')) {
          violations.push(p ?? line);
        }
      }
      continue;
    }
    const pathMatch = DIFF_PATH_RE.exec(line);
    if (pathMatch) {
      const p = pathMatch[3] ?? '';
      if (p !== '/dev/null' && !isValidCodingV5GitPath(p)) {
        violations.push(p);
      }
    }
  }
  return violations;
}

/**
 * Chay `git -C <repoRoot> <subcommand> ...` (execFile, khong shell).
 * `stdinText` (neu co) duoc ghi vao stdin — dung cho `git apply`.
 */
export function runCodingV5Git(
  repoRoot: string,
  args: string[],
  options: { timeoutMs?: number; stdinText?: string; allowDestructive?: boolean } = {},
): Promise<CodingV5GitRunResult> {
  const subcommand = args[0];
  if (!subcommand || !ALLOWED_SUBCOMMANDS.has(subcommand)) {
    return Promise.reject(
      new CodingV5GitError(
        `Subcommand git khong duoc phep: "${String(subcommand)}".`,
        args.join(' '),
      ),
    );
  }
  // reset --hard la pha huy: doi xac nhan ro rang tu caller.
  if (subcommand === 'reset' && args.includes('--hard') && !options.allowDestructive) {
    return Promise.reject(
      new CodingV5GitError(
        'git reset --hard la pha huy — can allowDestructive: true de chay.',
        args.join(' '),
      ),
    );
  }
  for (const arg of args.slice(1)) {
    if (arg.startsWith('-') && !isAllowedCodingV5GitFlag(subcommand, arg)) {
      return Promise.reject(
        new CodingV5GitError(`Flag git khong duoc phep: "${arg}" cho ${subcommand}.`, args.join(' ')),
      );
    }
  }
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-C', repoRoot, ...args],
      { timeout: options.timeoutMs ?? CODING_V5_GIT_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(
            new CodingV5GitError(
              'Khong tim thay lenh `git` tren may (can git tren PATH).',
              args.join(' '),
            ),
          );
          return;
        }
        const exitCode = typeof error?.code === 'number' ? error.code : 0;
        if (error && exitCode !== 0) {
          reject(
            new CodingV5GitError(
              `git ${args.join(' ')} that bai (exit ${exitCode}): ${String(stderr).trim() || error.message}`,
              args.join(' '),
              String(stderr),
            ),
          );
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr), exitCode });
      },
    );
    if (options.stdinText !== undefined) {
      child.stdin?.end(options.stdinText);
    }
  });
}

/** Phien git v5 tren mot repo: diff/apply/commit/revert/rollback. */
export class CodingV5GitSession {
  readonly repoRoot: string;

  constructor(repoRoot: string) {
    const resolved = path.resolve(repoRoot);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new CodingV5GitError(`Repo root khong ton tai hoac khong phai thu muc: ${repoRoot}.`, 'init');
    }
    this.repoRoot = resolved;
  }

  /** true khi thu muc la git repo (co .git hoac worktree). */
  async isRepo(): Promise<boolean> {
    try {
      const result = await runCodingV5Git(this.repoRoot, ['rev-parse', '--git-dir']);
      return result.stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  async requireRepo(): Promise<void> {
    if (!(await this.isRepo())) {
      throw new CodingV5GitError(
        `Thu muc khong phai git repo: ${this.repoRoot} (agent khong tu git init — hay git init truoc).`,
        'rev-parse --git-dir',
      );
    }
  }

  /** Trang thai worktree (staged/unstaged/untracked). */
  async status(): Promise<CodingV2GitStatus> {
    await this.requireRepo();
    const result = await runCodingV5Git(this.repoRoot, ['status', '--porcelain', '--branch']);
    const parsed = parseCodingV2GitStatusPorcelain(result.stdout);
    const branchLine = result.stdout.split('\n').find((l) => l.startsWith('## '));
    const branch = branchLine
      ? branchLine.slice(3).split('...')[0]?.replace(/^No commits yet on /, '') ?? null
      : null;
    return { ...parsed, branch };
  }

  /** Lich su commit moi nhat (mac dinh 20). */
  async log(limit = 20): Promise<CodingV2GitCommitInfo[]> {
    await this.requireRepo();
    const result = await runCodingV5Git(this.repoRoot, [
      'log',
      `--max-count=${Math.max(1, Math.min(50, Math.floor(limit)))}`,
      '--format=%H%x00%s%x00%an%x00%aI',
    ]);
    return parseCodingV2GitLog(result.stdout);
  }

  /** SHA day du cua HEAD (null khi repo chua co commit). */
  async headSha(): Promise<string | null> {
    try {
      const result = await runCodingV5Git(this.repoRoot, ['rev-parse', '--verify', 'HEAD']);
      const sha = result.stdout.trim();
      return SHA_RE.test(sha) ? sha : null;
    } catch {
      return null;
    }
  }

  /** SHA cha cua mot commit (null khi la root commit). */
  async parentSha(sha: string): Promise<string | null> {
    if (!isValidCodingV5Sha(sha)) {
      throw new CodingV5GitError(`SHA khong hop le: "${sha}".`, `rev-parse ${sha}^`);
    }
    try {
      const result = await runCodingV5Git(this.repoRoot, ['rev-parse', '--verify', `${sha}^`]);
      const parent = result.stdout.trim();
      return SHA_RE.test(parent) ? parent : null;
    } catch {
      return null;
    }
  }

  /**
   * Diff cua worktree (mac dinh ca staged + unstaged) dang unified
   * diff text. `stagedOnly` = true chi lay staged (`--cached`).
   * `paths` gioi han file (phai hop le, nam trong repo).
   */
  async diff(options: { stagedOnly?: boolean; paths?: string[] } = {}): Promise<string> {
    await this.requireRepo();
    const args: string[] = ['diff', '--no-color'];
    if (options.stagedOnly) args.push('--cached');
    if (options.paths && options.paths.length > 0) {
      for (const p of options.paths) {
        if (!isValidCodingV5GitPath(p)) {
          throw new CodingV5GitError(`Duong dan khong hop le: "${p}".`, 'diff');
        }
      }
      args.push('--', ...options.paths);
    }
    const result = await runCodingV5Git(this.repoRoot, args);
    return result.stdout;
  }

  /**
   * Kiem tra patch co apply duoc khong (`git apply --check`) ma khong
   * doi gi. Tra ve { ok, reason } — khong throw khi check fail.
   */
  async checkPatch(patchText: string): Promise<{ ok: boolean; reason: string }> {
    const violations = findCodingV5PatchPathViolations(patchText);
    if (violations.length > 0) {
      return { ok: false, reason: `Patch chua duong dan thoat khoi repo: ${violations.join(', ')}.` };
    }
    if (patchText.trim() === '') {
      return { ok: false, reason: 'Patch rong — khong co gi de apply.' };
    }
    try {
      await runCodingV5Git(this.repoRoot, ['apply', '--check', '--whitespace=fix'], {
        stdinText: patchText,
      });
      return { ok: true, reason: 'Patch apply duoc (git apply --check pass).' };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, reason: message };
    }
  }

  /**
   * Apply patch (da duyet) vao worktree. Luon `--check` truoc; check
   * fail thi khong apply gi. Tra ve so file bi anh huong (dem tu
   * dong `diff --git`).
   */
  async applyPatch(patchText: string): Promise<{ filesAffected: number }> {
    const check = await this.checkPatch(patchText);
    if (!check.ok) {
      throw new CodingV5GitError(`Khong apply duoc patch: ${check.reason}`, 'apply --check');
    }
    await runCodingV5Git(this.repoRoot, ['apply', '--whitespace=fix'], { stdinText: patchText });
    const filesAffected = (patchText.match(/^diff --git /gm) ?? []).length;
    return { filesAffected };
  }

  /** `git add` cac file (phai hop le, nam trong repo). */
  async add(paths: string[]): Promise<void> {
    await this.requireRepo();
    if (paths.length === 0) return;
    for (const p of paths) {
      if (!isValidCodingV5GitPath(p)) {
        throw new CodingV5GitError(`Duong dan khong hop le: "${p}".`, 'add');
      }
    }
    await runCodingV5Git(this.repoRoot, ['add', '--', ...paths]);
  }

  /** Commit staged changes voi message (da validate o lop commit message). */
  async commit(message: string, options: { allowEmpty?: boolean } = {}): Promise<string> {
    await this.requireRepo();
    if (typeof message !== 'string' || message.trim() === '') {
      throw new CodingV5GitError('Commit message rong — tu choi commit.', 'commit');
    }
    const args: string[] = ['commit', '-m', message.trim()];
    if (options.allowEmpty) args.push('--allow-empty');
    await runCodingV5Git(this.repoRoot, args);
    const sha = await this.headSha();
    if (!sha) {
      throw new CodingV5GitError('Commit xong nhung khong doc duoc HEAD.', 'commit');
    }
    return sha;
  }

  /** Diff day du cua mot commit (`git show --patch`). */
  async showPatch(sha: string): Promise<string> {
    if (!isValidCodingV5Sha(sha)) {
      throw new CodingV5GitError(`SHA khong hop le: "${sha}".`, `show ${sha}`);
    }
    await this.requireRepo();
    const result = await runCodingV5Git(this.repoRoot, ['show', '--patch', '--no-color', sha]);
    return result.stdout;
  }

  /**
   * Revert mot commit (`git revert --no-edit`). Xung dot thi abort
   * roi bao loi — khong de repo do dang. Tra ve SHA cua commit revert.
   */
  async revertCommit(sha: string): Promise<string> {
    if (!isValidCodingV5Sha(sha)) {
      throw new CodingV5GitError(`SHA khong hop le: "${sha}".`, `revert ${sha}`);
    }
    await this.requireRepo();
    try {
      await runCodingV5Git(this.repoRoot, ['revert', '--no-edit', sha]);
    } catch (e) {
      try {
        await runCodingV5Git(this.repoRoot, ['revert', '--abort']);
      } catch {
        // Abort that bai (vd khong co revert dang chay): bao loi goc.
      }
      throw new CodingV5GitError(
        `Revert ${sha} that bai (da abort): ${e instanceof Error ? e.message : String(e)}`,
        `revert ${sha}`,
      );
    }
    const head = await this.headSha();
    if (!head) {
      throw new CodingV5GitError('Revert xong nhung khong doc duoc HEAD.', `revert ${sha}`);
    }
    return head;
  }

  /**
   * Reset cung ve mot SHA (`git reset --hard`). PHA HUY: mat moi thay
   * doi chua commit. Chi chay khi `allowDestructive: true`.
   */
  async resetHard(sha: string, options: { allowDestructive?: boolean } = {}): Promise<void> {
    if (!isValidCodingV5Sha(sha)) {
      throw new CodingV5GitError(`SHA khong hop le: "${sha}".`, `reset --hard ${sha}`);
    }
    if (!options.allowDestructive) {
      throw new CodingV5GitError(
        'git reset --hard la pha huy — can allowDestructive: true de chay.',
        `reset --hard ${sha}`,
      );
    }
    await this.requireRepo();
    await runCodingV5Git(this.repoRoot, ['reset', '--hard', sha], { allowDestructive: true });
  }
}
