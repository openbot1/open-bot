/**
 * Lich su patch + rollback theo commit cho coding agent v5
 * (v1.13, Doi T4).
 *
 * Y tuong hoc tu Aider git-first (moi edit la mot commit, revert
 * tung buoc) — chi hoc y tuong, tu thiet ke va viet lai hoan toan
 * tu dau, KHONG doc, KHONG copy code/text/tai san cua Aider hay bat
 * ky repo nao:
 *
 *   - Moi patch agent apply (ke ca patch commit luon) duoc ghi mot
 *     ban ghi: commit SHA, message, type/scope, file anh huong,
 *     so hunk duyet/tu choi, thoi gian, SHA cha truoc patch.
 *   - Rollback theo commit id: mac dinh `git revert --no-edit`
 *     (an toan, giu lich su); che do `reset-hard` ve SHA cha chi
 *     chay khi caller xac nhan ro rang (`allowDestructive: true`)
 *     vi no xoa thay doi chua commit.
 *   - Lich su luu JSON duoi `.open-bot/coding-v5/patch-history.json`
 *     trong repo (cung quy uoc cache voi v4) — doc/ghi chiu loi
 *     (file hong thi tra ve lich su rong + ly do, khong crash host).
 *
 * Gioi han trung thuc:
 *   - Ban ghi chi ton tai khi host goi `recordPatch` (tool
 *     `coding_v5_patch_apply` tu ghi); patch apply bang tay ngoai
 *     agent khong co trong lich su.
 *   - Rollback bang revert co the xung dot neu commit sau da sua
 *     cung vung — luc do revert abort va bao loi, repo giu nguyen.
 *   - `reset-hard` khong khoi phuc duoc commit bi xoa khoi lich su
 *     neu khong con ref nao tro toi no (chi dung khi hieu ro).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CodingV5GitSession, isValidCodingV5Sha } from './gitV5';
import type { CodingV5ChangeType } from './commitMessage';

export const CODING_V5_PATCH_HISTORY_REL_PATH = '.open-bot/coding-v5/patch-history.json';
export const CODING_V5_PATCH_HISTORY_VERSION = 1;
export const CODING_V5_MAX_PATCH_HISTORY_RECORDS = 500;

export interface CodingV5PatchRecord {
  /** Id ban ghi (on dinh): `patch-<sha-ngan>-<thoi-gian>`. */
  id: string;
  /** SHA day du cua commit chua patch. */
  commitSha: string;
  shortSha: string;
  /** SHA cha truoc patch (de rollback reset-hard neu can). */
  parentSha: string | null;
  message: string;
  type: CodingV5ChangeType;
  scope: string;
  files: string[];
  additions: number;
  deletions: number;
  /** So hunk da duyet truoc khi apply. */
  hunksApproved: number;
  /** So hunk bi tu choi (khong apply). */
  hunksRejected: number;
  appliedAt: string;
  /** Thoi gian rollback (neu da rollback). */
  rolledBackAt: string | null;
  /** SHA cua commit revert (neu rollback bang revert). */
  rollbackSha: string | null;
  /** Che do rollback da dung: 'revert' | 'reset-hard' | null. */
  rollbackMode: 'revert' | 'reset-hard' | null;
}

export interface CodingV5PatchHistoryFile {
  version: number;
  repoRoot: string;
  records: CodingV5PatchRecord[];
}

export class CodingV5PatchHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodingV5PatchHistoryError';
  }
}

/** Duong dan file lich su patch trong repo. */
export function resolveCodingV5PatchHistoryPath(repoRoot: string): string {
  return path.join(path.resolve(repoRoot), ...CODING_V5_PATCH_HISTORY_REL_PATH.split('/'));
}

export interface CodingV5RecordPatchInput {
  commitSha: string;
  parentSha?: string | null;
  message: string;
  type: CodingV5ChangeType;
  scope: string;
  files: string[];
  additions: number;
  deletions: number;
  hunksApproved: number;
  hunksRejected: number;
}

/** Lich su patch cua mot repo (luu JSON tren dia). */
export class CodingV5PatchHistory {
  readonly repoRoot: string;
  readonly historyPath: string;
  private records: CodingV5PatchRecord[] = [];
  /** Ly do file lich su khong doc duoc (neu co) — de host bao user. */
  loadWarning: string | null = null;

  constructor(repoRoot: string) {
    const resolved = path.resolve(repoRoot);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new CodingV5PatchHistoryError(`Repo root khong ton tai hoac khong phai thu muc: ${repoRoot}.`);
    }
    this.repoRoot = resolved;
    this.historyPath = resolveCodingV5PatchHistoryPath(resolved);
    this.loadFromDisk();
  }

  /** So ban ghi trong lich su. */
  get size(): number {
    return this.records.length;
  }

  /** Doc lich su tu dia (file khong co/hong thi bat dau rong). */
  loadFromDisk(): void {
    this.records = [];
    this.loadWarning = null;
    if (!fs.existsSync(this.historyPath)) return;
    let text: string;
    try {
      text = fs.readFileSync(this.historyPath, 'utf8');
    } catch (e) {
      this.loadWarning = `Khong doc duoc file lich su patch: ${e instanceof Error ? e.message : String(e)}.`;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.loadWarning = `File lich su patch hong (JSON loi) — bat dau lich su moi: ${this.historyPath}.`;
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { records?: unknown }).records)) {
      this.loadWarning = `File lich su patch sai dinh dang — bat dau lich su moi: ${this.historyPath}.`;
      return;
    }
    const parsedRecords = (parsed as { records: unknown[] }).records;
    for (const r of parsedRecords) {
      if (typeof r !== 'object' || r === null) continue;
      const rec = r as Partial<CodingV5PatchRecord>;
      if (typeof rec.commitSha !== 'string' || !isValidCodingV5Sha(rec.commitSha)) continue;
      if (typeof rec.message !== 'string') continue;
      this.records.push({
        id: typeof rec.id === 'string' ? rec.id : `patch-${rec.commitSha.slice(0, 7)}`,
        commitSha: rec.commitSha,
        shortSha: typeof rec.shortSha === 'string' ? rec.shortSha : rec.commitSha.slice(0, 7),
        parentSha: typeof rec.parentSha === 'string' ? rec.parentSha : null,
        message: rec.message,
        type: isValidPatchType(rec.type) ? rec.type : 'chore',
        scope: typeof rec.scope === 'string' ? rec.scope : 'repo',
        files: Array.isArray(rec.files) ? rec.files.filter((f): f is string => typeof f === 'string') : [],
        additions: typeof rec.additions === 'number' ? rec.additions : 0,
        deletions: typeof rec.deletions === 'number' ? rec.deletions : 0,
        hunksApproved: typeof rec.hunksApproved === 'number' ? rec.hunksApproved : 0,
        hunksRejected: typeof rec.hunksRejected === 'number' ? rec.hunksRejected : 0,
        appliedAt: typeof rec.appliedAt === 'string' ? rec.appliedAt : new Date().toISOString(),
        rolledBackAt: typeof rec.rolledBackAt === 'string' ? rec.rolledBackAt : null,
        rollbackSha: typeof rec.rollbackSha === 'string' ? rec.rollbackSha : null,
        rollbackMode: rec.rollbackMode === 'revert' || rec.rollbackMode === 'reset-hard' ? rec.rollbackMode : null,
      });
    }
  }

  /** Ghi lich su xuong dia (tao thu muc neu chua co). */
  saveToDisk(): void {
    fs.mkdirSync(path.dirname(this.historyPath), { recursive: true });
    const file: CodingV5PatchHistoryFile = {
      version: CODING_V5_PATCH_HISTORY_VERSION,
      repoRoot: this.repoRoot,
      records: this.records,
    };
    fs.writeFileSync(this.historyPath, JSON.stringify(file, null, 2), 'utf8');
  }

  /** Ghi mot patch vua apply/commit vao lich su. */
  recordPatch(input: CodingV5RecordPatchInput): CodingV5PatchRecord {
    if (!isValidCodingV5Sha(input.commitSha)) {
      throw new CodingV5PatchHistoryError(`SHA commit khong hop le: "${input.commitSha}".`);
    }
    const shortSha = input.commitSha.slice(0, 7);
    const appliedAt = new Date().toISOString();
    const record: CodingV5PatchRecord = {
      id: `patch-${shortSha}-${Date.now()}`,
      commitSha: input.commitSha,
      shortSha,
      parentSha: input.parentSha ?? null,
      message: input.message,
      type: input.type,
      scope: input.scope,
      files: [...input.files],
      additions: input.additions,
      deletions: input.deletions,
      hunksApproved: input.hunksApproved,
      hunksRejected: input.hunksRejected,
      appliedAt,
      rolledBackAt: null,
      rollbackSha: null,
      rollbackMode: null,
    };
    this.records.push(record);
    // Cat bot lich su cu (giu moi nhat) de file khong phinh vo han.
    if (this.records.length > CODING_V5_MAX_PATCH_HISTORY_RECORDS) {
      this.records = this.records.slice(-CODING_V5_MAX_PATCH_HISTORY_RECORDS);
    }
    this.saveToDisk();
    return record;
  }

  /** Tat ca ban ghi (moi nhat truoc). */
  list(): CodingV5PatchRecord[] {
    return [...this.records].reverse();
  }

  /** Tim ban ghi theo commit SHA (day du hoac viet tat >= 7 ky tu). */
  findByCommit(sha: string): CodingV5PatchRecord | null {
    const normalized = sha.trim().toLowerCase();
    if (!isValidCodingV5Sha(normalized)) return null;
    return (
      this.records.find(
        (r) => r.commitSha.toLowerCase() === normalized || r.commitSha.toLowerCase().startsWith(normalized),
      ) ?? null
    );
  }

  /** Ban ghi chua rollback (de biet patch nao con hieu luc). */
  listActive(): CodingV5PatchRecord[] {
    return this.list().filter((r) => r.rolledBackAt === null);
  }

  /** Ban ghi da rollback. */
  listRolledBack(): CodingV5PatchRecord[] {
    return this.list().filter((r) => r.rolledBackAt !== null);
  }

  /** Danh dau mot ban ghi da rollback (luu dia ngay). */
  markRolledBack(commitSha: string, rollbackSha: string | null, mode: 'revert' | 'reset-hard'): CodingV5PatchRecord {
    const record = this.findByCommit(commitSha);
    if (!record) {
      throw new CodingV5PatchHistoryError(`Khong co ban ghi patch cho commit "${commitSha}" trong lich su.`);
    }
    record.rolledBackAt = new Date().toISOString();
    record.rollbackSha = rollbackSha;
    record.rollbackMode = mode;
    this.saveToDisk();
    return record;
  }
}

function isValidPatchType(value: unknown): value is CodingV5ChangeType {
  return (
    value === 'feat' || value === 'fix' || value === 'refactor' || value === 'test' || value === 'docs' || value === 'chore'
  );
}

export type CodingV5RollbackMode = 'revert' | 'reset-hard';

export interface CodingV5RollbackResult {
  /** SHA commit goc bi rollback. */
  commitSha: string;
  shortSha: string;
  /** SHA cua commit revert (che do revert) hoac SHA dich (reset-hard). */
  rollbackSha: string;
  mode: CodingV5RollbackMode;
  /** Message cua commit goc (de xac nhan). */
  message: string;
  /** Ban ghi lich su sau khi danh dau (null neu khong co ban ghi). */
  record: CodingV5PatchRecord | null;
}

export interface CodingV5RollbackOptions {
  /** Che do rollback: 'revert' (mac dinh, an toan) hoac 'reset-hard' (pha huy). */
  mode?: CodingV5RollbackMode;
  /** Bat buoc true khi mode = 'reset-hard' (xac nhan pha huy). */
  allowDestructive?: boolean;
  /** Lich su patch de danh dau (neu co — khong co thi van rollback, chi khong ghi log). */
  history?: CodingV5PatchHistory;
}

/**
 * Rollback patch theo commit id.
 *
 * - `revert` (mac dinh): `git revert --no-edit <sha>` — tao commit
 *   moi hoan tac thay doi, lich su cu van nguyen. Xung dot thi abort.
 * - `reset-hard`: `git reset --hard <parent-sha>` — dua repo ve
 *   trang thai truoc patch, XOA commit do va moi commit sau no khoi
 *   lich su + mat thay doi chua commit. Can `allowDestructive: true`
 *   va commit phai co parent (khong rollback root commit bang cach
 *   nay).
 */
export async function rollbackCodingV5Patch(
  repoRoot: string,
  commitSha: string,
  options: CodingV5RollbackOptions = {},
): Promise<CodingV5RollbackResult> {
  const mode = options.mode ?? 'revert';
  const normalized = commitSha.trim().toLowerCase();
  if (!isValidCodingV5Sha(normalized)) {
    throw new CodingV5PatchHistoryError(`SHA commit khong hop le: "${commitSha}".`);
  }
  const session = new CodingV5GitSession(repoRoot);
  await session.requireRepo();
  const log = await session.log(50);
  const commit = log.find((c) => c.sha.toLowerCase() === normalized || c.sha.toLowerCase().startsWith(normalized));
  if (!commit) {
    throw new CodingV5PatchHistoryError(
      `Khong tim thay commit "${commitSha}" trong 50 commit gan nhat — kiem tra lai SHA.`,
    );
  }

  let rollbackSha: string;
  if (mode === 'revert') {
    rollbackSha = await session.revertCommit(commit.sha);
  } else {
    if (!options.allowDestructive) {
      throw new CodingV5PatchHistoryError(
        'Rollback reset-hard la pha huy — can allowDestructive: true de chay.',
      );
    }
    const parent = await session.parentSha(commit.sha);
    if (!parent) {
      throw new CodingV5PatchHistoryError(
        `Commit ${commit.shortSha} la root commit (khong co parent) — khong reset-hard duoc.`,
      );
    }
    await session.resetHard(parent, { allowDestructive: true });
    rollbackSha = parent;
  }

  let record: CodingV5PatchRecord | null = null;
  if (options.history) {
    try {
      record = options.history.markRolledBack(commit.sha, rollbackSha, mode);
    } catch {
      // Khong co ban ghi trong lich su: van rollback thanh cong, chi
      // khong danh dau duoc — bao qua record = null.
      record = null;
    }
  }
  return {
    commitSha: commit.sha,
    shortSha: commit.shortSha,
    rollbackSha,
    mode,
    message: commit.message,
    record,
  };
}

/** Render lich su patch dang text (bang gon). */
export function renderCodingV5PatchHistory(records: CodingV5PatchRecord[]): string {
  if (records.length === 0) {
    return 'Chua co patch nao trong lich su.';
  }
  const lines = [`Lich su patch: ${records.length} ban ghi (moi nhat truoc):`];
  for (const r of records) {
    const state = r.rolledBackAt
      ? `ROLLED BACK (${r.rollbackMode}, ${r.rollbackSha?.slice(0, 7) ?? '?'})`
      : 'active';
    lines.push(
      `  - ${r.shortSha} [${state}] ${r.message} ` +
        `(+${r.additions}/-${r.deletions}, ${r.files.length} file(s), ` +
        `hunk ${r.hunksApproved} duyet/${r.hunksRejected} tu choi, ${r.appliedAt})`,
    );
  }
  return lines.join('\n');
}
