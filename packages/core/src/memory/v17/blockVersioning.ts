/**
 * Memory v17 — Block versioning + audit git-backed (v1.18, Doi T1).
 *
 * Y tuong hoc tu Letta Code / MemFS (thu muc memory co git that:
 * moi lan agent hoc duoc gi thi commit, lich su version la lich su
 * git that) + OpenHands V1 SDK (event-sourced state: append-only
 * log la single source of truth, replay de khoi phuc) — tu thiet
 * ke lai hoan toan cho open-bot, chay 100% local, KHONG copy
 * code/text/tai san cua bat ky repo nao, KHONG dung git that cua
 * repo (de tranh xung dot voi git cua du an).
 *
 * Ke thua, khong viet lai:
 *  - `V15BlockStore` / `V15BlockVersion` cua memoryV15/blocks:
 *    history version trong bo nho (snapshot cu); v17 la lop
 *    GIT-STYLE ben tren: moi thay doi block = 1 commit co hash
 *    chuoi (parent hash), diff dong, tac gia, ly do — luu FILE
 *    duoi `.open-bot/memory-v17-block-git/` nen song qua restart.
 *  - `blockHistory.ts` cua memory (v0.x): y tuong lich su block;
 *    v17 khong dung lai code do.
 *
 * Moi trong v17:
 *  1. `V17BlockCommit` — commit git-style: hash sha256
 *     (parent + label + content + author + reason + at), parent
 *     hash (chuoi commit), label, content snapshot, author
 *     (agent/user/system), reason, at, so dong them/bot.
 *  2. `commitBlockV17` — chup block hien tai thanh commit moi
 *     (chi commit khi content doi so voi commit cuoi — tranh
 *     commit rong); `diffCommitsV17` — diff dong (added/removed/
 *     unchanged) giua 2 commit bat ky.
 *  3. `rollbackToCommitV17` — khoi phuc block ve noi dung cua
 *     mot commit cu (tao commit MOI ghi lai viec rollback — lich
 *     su khong bao gio bi xoa, giong git revert).
 *  4. `queryBlockAuditV17` — audit log truy van duoc: loc theo
 *     label / author / khoang thoi gian / chuoi ly do; tra ve
 *     commit sap xep moi nhat truoc. Audit luu append-only JSONL.
 *  5. Luu tru file: `.open-bot/memory-v17-block-git/commits/
 *     <hash>.json` + `refs.json` (HEAD moi label) + `audit.jsonl`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import { V15BlockStore } from '../../memoryV15/blocks';
import type { V15MemoryBlock } from '../../memoryV15/blocks';

/** Loi block versioning v17 — message tieng Viet. */
export class V17BlockVersioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V17BlockVersioningError';
  }
}

/** Mot commit git-style cua block. */
export interface V17BlockCommit {
  /** Hash sha256 (12 ky tu dau hien thi, day du luu trong file). */
  hash: string;
  /** Hash commit cha (null = commit dau tien cua label). */
  parent: string | null;
  label: string;
  /** Snapshot noi dung block tai commit nay. */
  content: string;
  /** Tac gia: 'user' | 'agent:<botId>' | 'system:...'. */
  author: string;
  /** Ly do thay doi (vd 'sleep-time merge', 'user edit'). */
  reason: string;
  /** Thoi diem commit (ISO). */
  at: string;
  /** So dong them so voi commit cha. */
  linesAdded: number;
  /** So dong bot so voi commit cha. */
  linesRemoved: number;
}

/** Mot dong diff giua 2 commit. */
export interface V17DiffLine {
  type: 'added' | 'removed' | 'unchanged';
  text: string;
}

/** Ket qua diff 2 commit. */
export interface V17BlockDiff {
  fromHash: string;
  toHash: string;
  label: string;
  lines: V17DiffLine[];
  added: number;
  removed: number;
  unchanged: number;
}

/** Mot muc audit (dong JSONL) — chinh la commit + loai hanh dong. */
export interface V17BlockAuditEntry {
  at: string;
  action: 'commit' | 'rollback' | 'create';
  label: string;
  hash: string;
  parent: string | null;
  author: string;
  reason: string;
  linesAdded: number;
  linesRemoved: number;
}

/** Bo loc truy van audit. */
export interface V17AuditQuery {
  label?: string;
  author?: string;
  /** Loc ly do chua chuoi nay (khong phan biet hoa/thuong). */
  reasonContains?: string;
  /** Chi lay commit tu thoi diem nay (ISO). */
  from?: string;
  /** Chi lay commit den thoi diem nay (ISO). */
  to?: string;
  /** So muc toi da (mac dinh 100). */
  limit?: number;
}

/** Thu muc goc cua git-store block v17 (tuong doi workspace). */
export const V17_BLOCK_GIT_REL_PATH = path.join('.open-bot', 'memory-v17-block-git');
export const V17_BLOCK_GIT_COMMITS_DIR = 'commits';
export const V17_BLOCK_GIT_REFS_FILE = 'refs.json';
export const V17_BLOCK_GIT_AUDIT_FILE = 'audit.jsonl';
/** Do dai hash hien thi. */
export const V17_COMMIT_HASH_SHORT_LEN = 12;

/** Tinh hash commit (sha256 cua parent + label + content + author + reason + at). */
export function computeCommitHashV17(
  parent: string | null,
  label: string,
  content: string,
  author: string,
  reason: string,
  at: string,
): string {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify({ parent, label, content, author, reason, at }));
  return hash.digest('hex');
}

/** Rút gọn hash để hiển thị (12 ký tự đầu). */
export function shortHashV17(hash: string): string {
  return (hash ?? '').slice(0, V17_COMMIT_HASH_SHORT_LEN);
}

function gitDirV17(workspaceDir: string): string {
  return path.join(workspaceDir, V17_BLOCK_GIT_REL_PATH);
}

function commitsDirV17(workspaceDir: string): string {
  return path.join(gitDirV17(workspaceDir), V17_BLOCK_GIT_COMMITS_DIR);
}

function commitPathV17(workspaceDir: string, hash: string): string {
  return path.join(commitsDirV17(workspaceDir), `${hash}.json`);
}

function refsPathV17(workspaceDir: string): string {
  return path.join(gitDirV17(workspaceDir), V17_BLOCK_GIT_REFS_FILE);
}

function auditPathV17(workspaceDir: string): string {
  return path.join(gitDirV17(workspaceDir), V17_BLOCK_GIT_AUDIT_FILE);
}

function ensureGitDirV17(workspaceDir: string): void {
  fs.mkdirSync(commitsDirV17(workspaceDir), { recursive: true });
}

/** Doc refs (label -> HEAD hash). */
export function readBlockRefsV17(workspaceDir: string): Record<string, string> {
  try {
    const filePath = refsPathV17(workspaceDir);
    if (!fs.existsSync(filePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { version?: number; refs?: Record<string, string> };
    if (parsed.version !== 1 || typeof parsed.refs !== 'object' || parsed.refs === null) return {};
    const out: Record<string, string> = {};
    for (const [label, hash] of Object.entries(parsed.refs)) {
      if (typeof hash === 'string' && hash !== '') out[label] = hash;
    }
    return out;
  } catch {
    return {};
  }
}

/** Ghi refs (best-effort). */
function writeBlockRefsV17(workspaceDir: string, refs: Record<string, string>): void {
  try {
    ensureGitDirV17(workspaceDir);
    fs.writeFileSync(
      refsPathV17(workspaceDir),
      `${JSON.stringify({ version: 1, refs, updatedAt: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    );
  } catch {
    // Best-effort.
  }
}

/** Giai hash day du tu hash rut gon (tien to duy nhat, kieu git). */
export function resolveCommitHashV17(workspaceDir: string, hash: string): string | null {
  const clean = (hash ?? '').trim().toLowerCase();
  if (clean === '') return null;
  if (fs.existsSync(commitPathV17(workspaceDir, clean))) return clean;
  try {
    const dir = commitsDirV17(workspaceDir);
    if (!fs.existsSync(dir)) return null;
    const matches = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .filter((h) => h.toLowerCase().startsWith(clean));
    if (matches.length === 1) return matches[0];
    return null; // Khong co hoac mo ho (nhieu commit cung tien to).
  } catch {
    return null;
  }
}

/** Doc mot commit theo hash day du hoac rut gon (null neu khong co). */
export function readBlockCommitV17(workspaceDir: string, hash: string): V17BlockCommit | null {
  try {
    const full = resolveCommitHashV17(workspaceDir, hash);
    if (!full) return null;
    const filePath = commitPathV17(workspaceDir, full);
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as V17BlockCommit;
    if (!parsed || typeof parsed.hash !== 'string' || typeof parsed.content !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Ghi mot commit xuong file (best-effort, tra ve false neu loi). */
function writeBlockCommitV17(workspaceDir: string, commit: V17BlockCommit): boolean {
  try {
    ensureGitDirV17(workspaceDir);
    fs.writeFileSync(commitPathV17(workspaceDir, commit.hash), `${JSON.stringify(commit, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Ghi mot muc audit (append-only JSONL, best-effort). */
function appendBlockAuditV17(workspaceDir: string, entry: V17BlockAuditEntry): void {
  try {
    ensureGitDirV17(workspaceDir);
    fs.appendFileSync(auditPathV17(workspaceDir), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Audit best-effort.
  }
}

/**
 * Diff dong don gian (deterministic, khong can thu vien): dong
 * giong nhau giu nguyen (theo thu tu xuat hien dau tien), dong chi
 * co o `to` la added, chi co o `from` la removed. Du cho audit
 * hien thi — khong phai diff tung ky tu.
 */
export function diffLinesV17(fromContent: string, toContent: string): V17DiffLine[] {
  const split = (s: string): string[] => (s === '' ? [] : s.split('\n'));
  const fromLines = split(fromContent);
  const toLines = split(toContent);
  const count = (lines: string[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const fromCounts = count(fromLines);
  const toCounts = count(toLines);
  // So lan moi dong xuat hien o ca hai ben (duoc giu nguyen).
  const unchangedBudget = new Map<string, number>();
  for (const [line, c] of fromCounts) {
    unchangedBudget.set(line, Math.min(c, toCounts.get(line) ?? 0));
  }
  const lines: V17DiffLine[] = [];
  const remainingTo = new Map(unchangedBudget);
  for (const l of toLines) {
    const rem = remainingTo.get(l) ?? 0;
    if (rem > 0) {
      lines.push({ type: 'unchanged', text: l });
      remainingTo.set(l, rem - 1);
    } else {
      lines.push({ type: 'added', text: l });
    }
  }
  const removed: V17DiffLine[] = [];
  const remainingFrom = new Map(unchangedBudget);
  for (const l of fromLines) {
    const rem = remainingFrom.get(l) ?? 0;
    if (rem > 0) {
      remainingFrom.set(l, rem - 1);
    } else {
      removed.push({ type: 'removed', text: l });
    }
  }
  return [...removed, ...lines];
}

/** Dem added/removed tu diff. */
export function countDiffV17(lines: V17DiffLine[]): { added: number; removed: number; unchanged: number } {
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const l of lines) {
    if (l.type === 'added') added += 1;
    else if (l.type === 'removed') removed += 1;
    else unchanged += 1;
  }
  return { added, removed, unchanged };
}

/**
 * Commit block hien tai: tao commit moi chi khi content khac commit
 * HEAD (khong commit rong). Tra ve commit moi, hoac commit HEAD neu
 * khong co gi doi (kem flag `created: false`).
 */
export function commitBlockV17(
  store: V15BlockStore,
  workspaceDir: string,
  label: string,
  author: string,
  reason: string,
  at = new Date(),
): { commit: V17BlockCommit; created: boolean } {
  const block = store.get(label);
  if (!block) throw new V17BlockVersioningError(`Khong tim thay block "${label}" de commit.`);
  if ((author ?? '').trim() === '') {
    throw new V17BlockVersioningError('Commit can co author (agent/user/system).');
  }
  const refs = readBlockRefsV17(workspaceDir);
  const parent = refs[block.label] ?? null;
  const parentCommit = parent ? readBlockCommitV17(workspaceDir, parent) : null;
  if (parentCommit && parentCommit.content === block.content) {
    return { commit: parentCommit, created: false };
  }
  const atIso = at.toISOString();
  const hash = computeCommitHashV17(parent, block.label, block.content, author, (reason ?? '').slice(0, 200), atIso);
  const diff = parentCommit ? diffLinesV17(parentCommit.content, block.content) : diffLinesV17('', block.content);
  const counts = countDiffV17(diff);
  const commit: V17BlockCommit = {
    hash,
    parent,
    label: block.label,
    content: block.content,
    author,
    reason: (reason ?? '').slice(0, 200),
    at: atIso,
    linesAdded: counts.added,
    linesRemoved: counts.removed,
  };
  if (!writeBlockCommitV17(workspaceDir, commit)) {
    throw new V17BlockVersioningError('Khong ghi duoc commit xuong dia (thu muc workspace chi doc?).');
  }
  refs[block.label] = hash;
  writeBlockRefsV17(workspaceDir, refs);
  appendBlockAuditV17(workspaceDir, {
    at: atIso,
    action: parent ? 'commit' : 'create',
    label: block.label,
    hash,
    parent,
    author,
    reason: commit.reason,
    linesAdded: counts.added,
    linesRemoved: counts.removed,
  });
  return { commit, created: true };
}

/** Lich su commit cua mot label (moi nhat truoc, toi da `limit`). */
export function blockCommitHistoryV17(
  workspaceDir: string,
  label: string,
  limit = 50,
): V17BlockCommit[] {
  const refs = readBlockRefsV17(workspaceDir);
  const head = refs[label];
  if (!head) return [];
  const out: V17BlockCommit[] = [];
  let hash: string | null = head;
  const seen = new Set<string>();
  while (hash && out.length < Math.max(0, limit) && !seen.has(hash)) {
    seen.add(hash);
    const commit = readBlockCommitV17(workspaceDir, hash);
    if (!commit) break;
    out.push(commit);
    hash = commit.parent;
  }
  return out;
}

/** Diff giua 2 commit bat ky (cung label). */
export function diffCommitsV17(workspaceDir: string, fromHash: string, toHash: string): V17BlockDiff {
  const from = readBlockCommitV17(workspaceDir, fromHash);
  const to = readBlockCommitV17(workspaceDir, toHash);
  if (!from) throw new V17BlockVersioningError(`Khong tim thay commit "${shortHashV17(fromHash)}".`);
  if (!to) throw new V17BlockVersioningError(`Khong tim thay commit "${shortHashV17(toHash)}".`);
  if (from.label !== to.label) {
    throw new V17BlockVersioningError(
      `Hai commit khac label ("${from.label}" vs "${to.label}") — khong diff duoc.`,
    );
  }
  const lines = diffLinesV17(from.content, to.content);
  const counts = countDiffV17(lines);
  return { fromHash: from.hash, toHash: to.hash, label: from.label, lines, ...counts };
}

/**
 * Rollback block ve mot commit cu: khoi phuc noi dung qua store
 * (tang version v15 nhu edit binh thuong) ROI commit MOI ghi lai
 * viec rollback — lich su git-style khong bao gio bi xoa.
 */
export function rollbackToCommitV17(
  store: V15BlockStore,
  workspaceDir: string,
  label: string,
  hash: string,
  author: string,
  reason: string,
  at = new Date(),
): { block: V15MemoryBlock; commit: V17BlockCommit } {
  const target = readBlockCommitV17(workspaceDir, hash);
  if (!target) throw new V17BlockVersioningError(`Khong tim thay commit "${shortHashV17(hash)}".`);
  const block = store.get(label);
  if (!block) throw new V17BlockVersioningError(`Khong tim thay block "${label}".`);
  if (target.label !== block.label) {
    throw new V17BlockVersioningError(
      `Commit "${shortHashV17(hash)}" thuoc block "${target.label}", khong phai "${label}".`,
    );
  }
  const updated = store.replace(block.label, target.content, author, `v17-rollback to ${shortHashV17(hash)}`);
  const atIso = at.toISOString();
  const refs = readBlockRefsV17(workspaceDir);
  const parent = refs[block.label] ?? null;
  const parentCommit = parent ? readBlockCommitV17(workspaceDir, parent) : null;
  const diff = parentCommit ? diffLinesV17(parentCommit.content, target.content) : diffLinesV17('', target.content);
  const counts = countDiffV17(diff);
  const rollbackReason = (reason ?? '').trim() !== '' ? reason : `Rollback ve commit ${shortHashV17(hash)}`;
  const commitHash = computeCommitHashV17(parent, block.label, target.content, author, rollbackReason.slice(0, 200), atIso);
  const commit: V17BlockCommit = {
    hash: commitHash,
    parent,
    label: block.label,
    content: target.content,
    author,
    reason: rollbackReason.slice(0, 200),
    at: atIso,
    linesAdded: counts.added,
    linesRemoved: counts.removed,
  };
  writeBlockCommitV17(workspaceDir, commit);
  refs[block.label] = commitHash;
  writeBlockRefsV17(workspaceDir, refs);
  appendBlockAuditV17(workspaceDir, {
    at: atIso,
    action: 'rollback',
    label: block.label,
    hash: commitHash,
    parent,
    author,
    reason: commit.reason,
    linesAdded: counts.added,
    linesRemoved: counts.removed,
  });
  return { block: { ...updated, history: [...updated.history] }, commit };
}

/** Doc toan bo audit log (moi nhat cuoi, gioi han so dong). */
export function readBlockAuditV17(workspaceDir: string, limit = 500): V17BlockAuditEntry[] {
  try {
    const filePath = auditPathV17(workspaceDir);
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter((l) => l.trim() !== '');
    const out: V17BlockAuditEntry[] = [];
    for (const line of lines.slice(-Math.max(0, limit))) {
      try {
        const parsed = JSON.parse(line) as V17BlockAuditEntry;
        if (parsed && typeof parsed.at === 'string' && typeof parsed.label === 'string') out.push(parsed);
      } catch {
        // Bo dong hong.
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Truy van audit log: loc theo label/author/ly do/khoang thoi gian. */
export function queryBlockAuditV17(workspaceDir: string, query: V17AuditQuery = {}): V17BlockAuditEntry[] {
  const limit = query.limit ?? 100;
  const entries = readBlockAuditV17(workspaceDir, 10000);
  const filtered = entries.filter((e) => {
    if (query.label && e.label !== query.label) return false;
    if (query.author && e.author !== query.author) return false;
    if (query.reasonContains && !e.reason.toLowerCase().includes(query.reasonContains.toLowerCase())) {
      return false;
    }
    if (query.from && e.at < query.from) return false;
    if (query.to && e.at > query.to) return false;
    return true;
  });
  filtered.sort((a, b) => b.at.localeCompare(a.at));
  return filtered.slice(0, Math.max(0, limit));
}

/** Thong ke git-store: so commit, so label, HEAD moi label. */
export function blockGitStatsV17(workspaceDir: string): {
  commitCount: number;
  labels: string[];
  heads: Record<string, string>;
} {
  const heads = readBlockRefsV17(workspaceDir);
  let commitCount = 0;
  try {
    const dir = commitsDirV17(workspaceDir);
    if (fs.existsSync(dir)) {
      commitCount = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length;
    }
  } catch {
    commitCount = 0;
  }
  return { commitCount, labels: Object.keys(heads).sort(), heads };
}
