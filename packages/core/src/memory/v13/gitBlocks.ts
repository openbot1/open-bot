/**
 * Memory v13 — git-backed memory blocks (v1.14, Doi T1).
 *
 * Y tuong hoc tu Letta Code (memory commit/branch/rollback qua Git nhu
 * code) va Letta core memory (block la primitive co version) — tu thiet
 * ke lai hoan toan cho open-bot, chay 100% local, KHONG copy code/text/
 * tai san cua bat ky repo nao.
 *
 * Moi block co mot chuoi version rieng, luu trong file JSON
 * `.open-bot/memory-blocks-v13-git.json` trong workspace cua bot:
 *
 *  - `snapshot` — chup trang thai hien tai cua mot block thanh mot
 *    version moi (ke thua `recordBlockVersion` cua blockHistory v0.98:
 *    snapshot v13 vua ghi vao kho v13 vua ghi them snapshot tuong thich
 *    vao lich su cu, de UI cu van doc duoc).
 *  - `branch` — nhanh rieng cho mot block (vd thu nghiem sua `persona`
 *    tren nhanh `exp-funnier` ma khong dong den `main`).
 *  - `checkout` / `rollback` — dua block ve noi dung cua mot version
 *    cu. Rollback KHONG bao gio viet lai lich su: no tao mot version
 *    MOI mang noi dung cu (giong `readBlockVersion` + `restore` cua
 *    v11/v12, nhung them nhanh + message + diff).
 *  - `diff` — so sanh 2 version theo dong, de user thay chinh xac cai
 *    gi doi truoc khi rollback.
 *
 * Lich su khong bao gio bi xoa: `prune` chi bo cac version cu nhat
 * khi vuot `MAX_V13_VERSIONS_PER_BLOCK`, va chi khi caller goi tuong
 * minh (mac dinh khong prune).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { MemoryBlock, MemoryBlockStore } from '../blocks';
import { recordBlockVersion } from '../blockHistory';

/** Loi git-backed block — message tieng Viet. */
export class V13BlockGitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V13BlockGitError';
  }
}

/** Duong dan file kho version v13 (tuong doi trong workspace). */
export const V13_BLOCK_GIT_REL_PATH = path.join(
  '.open-bot',
  'memory-blocks-v13-git.json',
);
/** Nhan mac dinh — moi block deu co, khong can tao. */
export const V13_DEFAULT_BRANCH = 'main';
/** So version toi da giu moi block (chi prune khi goi tuong minh). */
export const MAX_V13_VERSIONS_PER_BLOCK = 100;
/** Do dai toi da cua ten nhanh. */
export const MAX_V13_BRANCH_NAME_LENGTH = 64;

/** Mot version cua mot block. */
export interface V13BlockVersion {
  id: string;
  blockId: string;
  label: string;
  /** So version cua block luc snapshot (tang theo MemoryBlock.version). */
  version: number;
  /** Nhan version nay thuoc ve (`main` mac dinh). */
  branch: string;
  /** Version cha trong cung nhanh (null = version dau tien cua nhanh). */
  parentId: string | null;
  content: string;
  description: string;
  charLimit: number;
  readOnly: boolean;
  /** SHA-256 cua content — dung de phat hien snapshot trung lap. */
  contentHash: string;
  /** Ghi chu cua nguoi chup (vd "truoc khi sua persona"). */
  message: string;
  actor: string;
  at: string;
}

/** Mot nhanh cua mot block. */
export interface V13BlockBranch {
  blockId: string;
  name: string;
  /** Version dau nhanh (head) hien tai. */
  headVersionId: string;
  /** Version ma nhanh nay tach ra (de biet diem re). */
  fromVersionId: string | null;
  createdAt: string;
  createdBy: string;
}

export interface V13BlockGitFile {
  version: 1;
  versions: V13BlockVersion[];
  branches: V13BlockBranch[];
}

export function v13BlockGitEmptyFile(): V13BlockGitFile {
  return { version: 1, versions: [], branches: [] };
}

/** SHA-256 hex cua mot chuoi. */
export function v13HashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function isValidV13BranchName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name ?? '');
}

export function normalizeV13BranchName(raw: string): string {
  return (raw ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_V13_BRANCH_NAME_LENGTH);
}

export interface V13SnapshotOptions {
  branch?: string;
  message?: string;
  actor?: string;
  /** true = snapshot ca khi content khong doi so voi head (mac dinh false = bo qua, tra ve head). */
  force?: boolean;
}

export interface V13SnapshotResult {
  version: V13BlockVersion;
  /** true = version moi that su duoc tao; false = da co head giong het, khong tao them. */
  created: boolean;
}

export interface V13CheckoutOptions {
  actor?: string;
  message?: string;
}

export interface V13CheckoutResult {
  /** Block sau khi ap dung noi dung version dich. */
  block: MemoryBlock;
  /** Version MOI vua tao (mang noi dung cu) — lich su khong bi viet lai. */
  newVersion: V13BlockVersion;
  /** Version dich ma noi dung lay tu do. */
  fromVersion: V13BlockVersion;
}

export interface V13DiffLine {
  type: ' ' | '+' | '-';
  text: string;
}

export interface V13BlockDiff {
  fromVersionId: string;
  toVersionId: string;
  fromLabel: string;
  toLabel: string;
  added: number;
  removed: number;
  unchanged: number;
  lines: V13DiffLine[];
  /** true = mo ta block cung doi (khong chi noi dung). */
  descriptionChanged: boolean;
}

/**
 * Diff 2 danh sach dong bang LCS co dien (du cho block <= 20000 ky tu).
 * Dong giong nhau giu nguyen thu tu; dong chi co o mot phia danh dau
 * `+` / `-`. Khong phu thuoc thu vien ngoai.
 */
export function v13DiffLines(from: string, to: string): V13DiffLine[] {
  const a = from.split('\n');
  const b = to.split('\n');
  const n = a.length;
  const m = b.length;
  // Bang LCS (n+1)x(m+1). Block toi da 20000 ky tu ~ vai tram dong
  // nen bang nay nho; cat ngan khi qua lon de tranh tran bo nho.
  const cappedA = n > 2000 ? a.slice(0, 2000) : a;
  const cappedB = m > 2000 ? b.slice(0, 2000) : b;
  const nn = cappedA.length;
  const mm = cappedB.length;
  const dp: number[][] = Array.from({ length: nn + 1 }, () =>
    new Array<number>(mm + 1).fill(0),
  );
  for (let i = nn - 1; i >= 0; i--) {
    for (let j = mm - 1; j >= 0; j--) {
      dp[i][j] =
        cappedA[i] === cappedB[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: V13DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < nn && j < mm) {
    if (cappedA[i] === cappedB[j]) {
      out.push({ type: ' ', text: cappedA[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: '-', text: cappedA[i] });
      i++;
    } else {
      out.push({ type: '+', text: cappedB[j] });
      j++;
    }
  }
  while (i < nn) {
    out.push({ type: '-', text: cappedA[i] });
    i++;
  }
  while (j < mm) {
    out.push({ type: '+', text: cappedB[j] });
    j++;
  }
  if (n > 2000 || m > 2000) {
    out.push({
      type: ' ',
      text: `… [diff bi cat: block qua 2000 dong, chi so ${Math.min(n, 2000)}/${n} → ${Math.min(m, 2000)}/${m}]`,
    });
  }
  return out;
}

/** Kho version git-backed cho memory block (mot workspace = mot kho). */
export class V13BlockGitStore {
  private readonly filePath: string;
  private readonly workspaceDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
    this.filePath = path.join(workspaceDir, V13_BLOCK_GIT_REL_PATH);
  }

  get dir(): string {
    return this.workspaceDir;
  }

  private readFile(): V13BlockGitFile {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return v13BlockGitEmptyFile();
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new V13BlockGitError(
        `File version block v13 khong phai JSON hop le: ${V13_BLOCK_GIT_REL_PATH}`,
      );
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as V13BlockGitFile).version !== 1 ||
      !Array.isArray((parsed as V13BlockGitFile).versions) ||
      !Array.isArray((parsed as V13BlockGitFile).branches)
    ) {
      throw new V13BlockGitError(
        `File version block v13 co dinh dang khong ho tro: ${V13_BLOCK_GIT_REL_PATH}`,
      );
    }
    return parsed as V13BlockGitFile;
  }

  private writeFile(file: V13BlockGitFile): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  /** Head (version moi nhat) cua mot block tren mot nhanh. */
  headOf(blockId: string, branch = V13_DEFAULT_BRANCH): V13BlockVersion | null {
    const file = this.readFile();
    let best: V13BlockVersion | null = null;
    let bestIdx = -1;
    for (let idx = 0; idx < file.versions.length; idx++) {
      const v = file.versions[idx];
      if (v.blockId !== blockId || v.branch !== branch) continue;
      if (best === null) {
        best = v;
        bestIdx = idx;
        continue;
      }
      // Tiebreaker khi 2 version co cung `at` (cung mili-giay): version
      // chen sau (index lon hon) moi hon — sort on dinh, khong flaky.
      const newer =
        v.at.localeCompare(best.at) > 0 ||
        (v.at === best.at &&
          (v.version > best.version || (v.version === best.version && idx > bestIdx)));
      if (newer) {
        best = v;
        bestIdx = idx;
      }
    }
    return best === null ? null : { ...best };
  }

  /** Chup trang thai hien tai cua block thanh version moi. */
  snapshot(block: MemoryBlock, opts: V13SnapshotOptions = {}): V13SnapshotResult {
    const branch = normalizeV13BranchName(opts.branch ?? V13_DEFAULT_BRANCH);
    if (!isValidV13BranchName(branch)) {
      throw new V13BlockGitError(
        `Ten nhanh khong hop le: "${opts.branch ?? ''}" (chi gom chu thuong, so, "-" va "_").`,
      );
    }
    const actor = (opts.actor ?? 'user').trim() || 'user';
    const message = (opts.message ?? '').trim().slice(0, 500);
    const file = this.readFile();
    const head = this.headOf(block.id, branch);
    const hash = v13HashContent(block.content);
    if (head && head.contentHash === hash && opts.force !== true) {
      return { version: head, created: false };
    }
    const now = new Date().toISOString();
    const version: V13BlockVersion = {
      id: randomUUID(),
      blockId: block.id,
      label: block.label,
      version: block.version,
      branch,
      parentId: head ? head.id : null,
      content: block.content,
      description: block.description,
      charLimit: block.charLimit,
      readOnly: block.readOnly,
      contentHash: hash,
      message: message === '' ? `snapshot v${block.version} (${branch})` : message,
      actor,
      at: now,
    };
    file.versions.push(version);
    const branchRec = file.branches.find(
      (b) => b.blockId === block.id && b.name === branch,
    );
    if (branchRec) {
      branchRec.headVersionId = version.id;
    } else {
      file.branches.push({
        blockId: block.id,
        name: branch,
        headVersionId: version.id,
        fromVersionId: head ? head.id : null,
        createdAt: now,
        createdBy: actor,
      });
    }
    this.writeFile(file);
    // Tuong thich nguoc: ghi them snapshot vao lich su cu (v0.98).
    recordBlockVersion(this.workspaceDir, block, 'snapshot-v13', actor);
    return { version, created: true };
  }

  /** Liet ke version cua mot block (moi nhat truoc), loc theo nhanh neu co. */
  listVersions(blockId: string, branch?: string): V13BlockVersion[] {
    const file = this.readFile();
    return file.versions
      .map((v, idx) => ({ v, idx }))
      .filter(({ v }) => v.blockId === blockId && (branch === undefined || v.branch === branch))
      .sort(
        (a, b) =>
          b.v.at.localeCompare(a.v.at) ||
          b.v.version - a.v.version ||
          b.idx - a.idx,
      )
      .map(({ v }) => ({ ...v }));
  }

  /** Lay mot version theo id (null khi khong co). */
  getVersion(versionId: string): V13BlockVersion | null {
    const file = this.readFile();
    const found = file.versions.find((v) => v.id === versionId);
    return found ? { ...found } : null;
  }

  /** Liet ke nhanh cua mot block (luon co `main` khi da co version). */
  listBranches(blockId: string): V13BlockBranch[] {
    const file = this.readFile();
    return file.branches
      .filter((b) => b.blockId === blockId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((b) => ({ ...b }));
  }

  /**
   * Tao nhanh moi tu mot version (mac dinh tu head cua `main`).
   * Nhanh trung ten -> throw; version goc khong ton tai -> throw.
   */
  createBranch(
    blockId: string,
    name: string,
    opts: { fromVersionId?: string; actor?: string } = {},
  ): V13BlockBranch {
    const clean = normalizeV13BranchName(name);
    if (!isValidV13BranchName(clean)) {
      throw new V13BlockGitError(
        `Ten nhanh khong hop le: "${name}" (chi gom chu thuong, so, "-" va "_").`,
      );
    }
    const file = this.readFile();
    if (file.branches.some((b) => b.blockId === blockId && b.name === clean)) {
      throw new V13BlockGitError(`Block nay da co nhanh "${clean}".`);
    }
    const from =
      opts.fromVersionId !== undefined
        ? file.versions.find((v) => v.id === opts.fromVersionId && v.blockId === blockId)
        : this.headOf(blockId, V13_DEFAULT_BRANCH);
    if (!from) {
      throw new V13BlockGitError(
        'Khong tim thay version goc de tach nhanh (block chua co snapshot nao).',
      );
    }
    const branch: V13BlockBranch = {
      blockId,
      name: clean,
      headVersionId: from.id,
      fromVersionId: from.id,
      createdAt: new Date().toISOString(),
      createdBy: (opts.actor ?? 'user').trim() || 'user',
    };
    file.branches.push(branch);
    this.writeFile(file);
    return { ...branch };
  }

  /**
   * Dua block ve noi dung cua mot version (theo id hoac nhanh).
   * Tao version MOI tren nhanh dich mang noi dung cu — lich su khong
   * bao gio bi viet lai. Can `blockStore` de ap dung thay doi that.
   */
  checkout(
    blockStore: MemoryBlockStore,
    blockId: string,
    target: { versionId: string } | { branch: string },
    opts: V13CheckoutOptions = {},
  ): V13CheckoutResult {
    const actor = (opts.actor ?? 'user').trim() || 'user';
    const from =
      'versionId' in target
        ? this.getVersion(target.versionId)
        : this.headOf(blockId, normalizeV13BranchName(target.branch));
    if (!from || from.blockId !== blockId) {
      throw new V13BlockGitError('Khong tim thay version dich de checkout.');
    }
    const current = blockStore.get(blockId);
    if (!current) {
      throw new V13BlockGitError('Khong tim thay block can checkout.');
    }
    if (current.readOnly && actor !== 'user') {
      throw new V13BlockGitError(
        `Block "${current.label}" dang read-only — chi user moi checkout duoc.`,
      );
    }
    if (current.systemOwned === true && actor !== 'user') {
      throw new V13BlockGitError(
        `Block "${current.label}" la block he thong — chi user moi checkout duoc.`,
      );
    }
    const message =
      (opts.message ?? '').trim().slice(0, 500) ||
      `checkout ve version ${from.version} (${from.branch})`;
    // Ghi qua store.replace de tang version + ghi audit + lich su cu.
    const updated = blockStore.replace(blockId, from.content, actor);
    if (from.description !== current.description) {
      // replace chi doi content; dong bo mo ta qua update khi khac.
      blockStore.update(blockId, { description: from.description }, actor);
    }
    const fresh = blockStore.get(blockId) ?? updated;
    const snap = this.snapshot(fresh, {
      branch: from.branch,
      message,
      actor,
      force: true,
    });
    return { block: { ...fresh }, newVersion: snap.version, fromVersion: from };
  }

  /** Rollback = checkout ve version cu, voi message ghi ro la rollback. */
  rollback(
    blockStore: MemoryBlockStore,
    blockId: string,
    versionId: string,
    opts: V13CheckoutOptions = {},
  ): V13CheckoutResult {
    const from = this.getVersion(versionId);
    if (!from) {
      throw new V13BlockGitError('Khong tim thay version de rollback.');
    }
    return this.checkout(blockStore, blockId, { versionId }, {
      actor: opts.actor,
      message:
        (opts.message ?? '').trim() ||
        `rollback ve version ${from.version} (${from.branch}): ${from.message}`,
    });
  }

  /** So sanh 2 version cua cung block theo dong. */
  diffVersions(fromVersionId: string, toVersionId: string): V13BlockDiff {
    const from = this.getVersion(fromVersionId);
    const to = this.getVersion(toVersionId);
    if (!from || !to) {
      throw new V13BlockGitError('Khong tim thay mot trong hai version de diff.');
    }
    if (from.blockId !== to.blockId) {
      throw new V13BlockGitError('Chi diff duoc 2 version cua cung mot block.');
    }
    const lines = v13DiffLines(from.content, to.content);
    return {
      fromVersionId: from.id,
      toVersionId: to.id,
      fromLabel: `${from.label} v${from.version} (${from.branch})`,
      toLabel: `${to.label} v${to.version} (${to.branch})`,
      added: lines.filter((l) => l.type === '+').length,
      removed: lines.filter((l) => l.type === '-').length,
      unchanged: lines.filter((l) => l.type === ' ').length,
      lines,
      descriptionChanged: from.description !== to.description,
    };
  }

  /**
   * Hop nhat nhanh nguon vao nhanh dich (fast-forward don gian):
   * lay head cua nhanh nguon lam noi dung moi cho nhanh dich.
   * Khong tu dong giai quyet xung dot — neu ca hai nhanh deu co
   * version moi ke tu diem re thi tra ve `conflicted: true` va KHONG
   * ghi gi ca, de user tu chon.
   */
  mergeBranch(
    blockStore: MemoryBlockStore,
    blockId: string,
    sourceBranch: string,
    targetBranch: string,
    opts: V13CheckoutOptions = {},
  ): { merged: boolean; conflicted: boolean; result?: V13CheckoutResult; detail: string } {
    const source = normalizeV13BranchName(sourceBranch);
    const target = normalizeV13BranchName(targetBranch);
    const file = this.readFile();
    const sourceRec = file.branches.find((b) => b.blockId === blockId && b.name === source);
    const targetRec = file.branches.find((b) => b.blockId === blockId && b.name === target);
    if (!sourceRec || !targetRec) {
      throw new V13BlockGitError('Khong tim thay nhanh nguon hoac nhanh dich.');
    }
    const sourceHead = this.getVersion(sourceRec.headVersionId);
    const targetHead = this.getVersion(targetRec.headVersionId);
    if (!sourceHead || !targetHead) {
      throw new V13BlockGitError('Nhanh thieu head version.');
    }
    if (sourceHead.contentHash === targetHead.contentHash) {
      return { merged: false, conflicted: false, detail: 'Hai nhanh da giong nhau — khong can hop nhat.' };
    }
    // Xung dot: ca hai deu tien len ke tu diem re.
    const diverged =
      sourceHead.parentId !== targetHead.id &&
      targetHead.parentId !== sourceHead.id &&
      sourceRec.fromVersionId !== targetHead.id &&
      targetRec.fromVersionId !== sourceHead.id &&
      sourceHead.id !== targetHead.id;
    // Fast-forward khi target head nam tren duong dan cua source
    // (don gian: source tach tu target head, hoac target la to tien).
    const isFastForward =
      sourceRec.fromVersionId === targetHead.id || sourceHead.parentId === targetHead.id;
    if (diverged && !isFastForward) {
      return {
        merged: false,
        conflicted: true,
        detail:
          `Xung dot: nhanh "${source}" va "${target}" deu co thay doi rieng ke tu diem re — ` +
          'chon mot ben bang checkout thay vi merge tu dong.',
      };
    }
    const result = this.checkout(blockStore, blockId, { versionId: sourceHead.id }, {
      actor: opts.actor,
      message: (opts.message ?? '').trim() || `merge nhanh "${source}" vao "${target}"`,
    });
    // Snapshot vua tao nam tren nhanh cua version goc (source); ghi them
    // mot snapshot tren nhanh dich de head cua dich tien len dung.
    const fresh = blockStore.get(blockId);
    if (fresh) {
      this.snapshot(fresh, { branch: target, message: `merge "${source}" → "${target}"`, actor: opts.actor, force: true });
    }
    return { merged: true, conflicted: false, result, detail: `Da merge "${source}" vao "${target}".` };
  }

  /** Thong ke nhanh cho mot block (so version, so nhanh, head moi nhat). */
  stats(blockId: string): { versions: number; branches: number; latestAt: string | null; latestBranch: string | null } {
    const versions = this.listVersions(blockId);
    const branches = this.listBranches(blockId);
    return {
      versions: versions.length,
      branches: branches.length,
      latestAt: versions[0]?.at ?? null,
      latestBranch: versions[0]?.branch ?? null,
    };
  }

  /**
   * Cat bo version cu nhat khi vuot gioi han (mac dinh 100/block).
   * Chi goi tuong minh — binh thuong lich su duoc giu tron.
   * Tra ve so version da bo. Head cua moi nhanh khong bao gio bi bo.
   */
  prune(blockId: string, keep = MAX_V13_VERSIONS_PER_BLOCK): number {
    const file = this.readFile();
    const headIds = new Set(
      file.branches.filter((b) => b.blockId === blockId).map((b) => b.headVersionId),
    );
    const mine = file.versions
      .filter((v) => v.blockId === blockId)
      .sort((a, b) => a.at.localeCompare(b.at));
    if (mine.length <= keep) return 0;
    const removable = mine.filter((v) => !headIds.has(v.id));
    const excess = mine.length - keep;
    const toDrop = new Set(removable.slice(0, Math.max(0, excess)).map((v) => v.id));
    if (toDrop.size === 0) return 0;
    file.versions = file.versions.filter((v) => !toDrop.has(v.id));
    this.writeFile(file);
    return toDrop.size;
  }
}
