/**
 * Memory v20 — Block versioning (Letta-style, v1.28, Doi T1).
 *
 * Lich su cua moi block la append-only: moi edit ghi lai `before`
 * / `after` + version truoc/sau. Vi vay noi dung cua bat ky version
 * nao cung khoi phuc duoc bang cach replay lich su — khong can
 * snapshot rieng, khong bao gio viet lai lich su.
 *
 *  - `listBlockVersionsV20`: liet ke moi version kem noi dung,
 *    nguoi sua, ly do, thoi gian.
 *  - `getBlockVersionContentV20`: noi dung cua mot version cu.
 *  - `diffBlockVersionsV20`: diff theo dong giua hai version
 *    (LCS don gian, khong phu thuoc thu vien ngoai).
 *  - `rollbackBlockV20`: khoi phuc ve version cu — uy thac cho
 *    `V20CoreBlockStore.rollbackBlock`, luon tao version MOI copy
 *    noi dung cu (lich su khong bi viet lai).
 *  - `versioningSummaryV20`: tom tat nhanh de hien thi tren UI
 *    (so version, version hien tai, lan sua cuoi).
 *
 * Khong goi model, khong goi mang. Mọi loi tra ve ket qua co cau
 * truc thay vi throw, de host/tool hien thi duoc cho user.
 */
import type { V20BlockEdit, V20BlockEditResult, V20CoreBlock } from './types';
import type { V20CoreBlockStore } from './coreBlocks';

/** Mot version cua block, khoi phuc duoc tu lich su append-only. */
export interface V20VersionSnapshot {
  version: number;
  value: string;
  updatedAt: number;
  updatedBy: string;
  op: V20BlockEdit['op'];
  reason: string;
  editId: string;
}

/** Ket qua tra ve cua cac ham versioning (khong throw). */
export interface V20VersioningResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  errorCode?: 'block_not_found' | 'version_not_found' | 'version_conflict' | 'already_at_version' | 'invalid_args' | 'empty_content';
}

/** Mot dong thay doi trong diff giua hai version. */
export interface V20VersionDiffLine {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

export interface V20VersionDiff {
  blockId: string;
  label: string;
  fromVersion: number;
  toVersion: number;
  lines: V20VersionDiffLine[];
  addedCount: number;
  removedCount: number;
  unchangedCount: number;
}

export interface V20VersioningSummary {
  blockId: string;
  label: string;
  currentVersion: number;
  totalVersions: number;
  firstUpdatedAt: number;
  lastUpdatedAt: number;
  lastUpdatedBy: string;
  lastOp: V20BlockEdit['op'];
  lastReason: string;
  archived: boolean;
}

/**
 * Dung lich su append-only de dung lai moi version cua block.
 * Version 1 = `after` cua edit 'create'; moi version sau = `after`
 * cua edit co `versionAfter` tuong ung. Tra ve rong neu block
 * khong ton tai (caller kiem tra rieng de bao loi ro rang).
 */
export function listBlockVersionsV20(
  store: V20CoreBlockStore,
  blockId: string,
): V20VersionSnapshot[] {
  const block = store.getBlock(blockId);
  if (!block) return [];
  const history = store.getHistory(block.id);
  const snapshots: V20VersionSnapshot[] = [];
  for (const edit of history) {
    snapshots.push({
      version: edit.versionAfter,
      value: edit.after,
      updatedAt: edit.at,
      updatedBy: edit.actor,
      op: edit.op,
      reason: edit.reason,
      editId: edit.id,
    });
  }
  snapshots.sort((a, b) => a.version - b.version);
  return snapshots;
}

export function getBlockVersionContentV20(
  store: V20CoreBlockStore,
  blockId: string,
  version: number,
): V20VersioningResult<V20VersionSnapshot> {
  if (!Number.isInteger(version) || version < 1) {
    return { ok: false, error: `version phai la so nguyen >= 1 (nhan ${version})`, errorCode: 'invalid_args' };
  }
  const block = store.getBlock(blockId);
  if (!block) return { ok: false, error: `khong tim thay block "${blockId}"`, errorCode: 'block_not_found' };
  const found = listBlockVersionsV20(store, block.id).find((s) => s.version === version);
  if (!found) {
    return { ok: false, error: `block "${block.label}" khong co version ${version} (hien tai v${block.version})`, errorCode: 'version_not_found' };
  }
  return { ok: true, data: found };
}

/**
 * So sanh hai version theo dong bang LCS (longest common
 * subsequence) tren mang dong. Du cho block vai tram dong;
 * block lon hon nen diff o tang UI theo chunk, khong goi ham
 * nay tren toan bo value.
 */
export function diffBlockVersionsV20(
  store: V20CoreBlockStore,
  blockId: string,
  fromVersion: number,
  toVersion: number,
): V20VersioningResult<V20VersionDiff> {
  const from = getBlockVersionContentV20(store, blockId, fromVersion);
  if (!from.ok || !from.data) return { ok: false, error: from.error, errorCode: from.errorCode };
  const to = getBlockVersionContentV20(store, blockId, toVersion);
  if (!to.ok || !to.data) return { ok: false, error: to.error, errorCode: to.errorCode };
  const block = store.getBlock(blockId) as V20CoreBlock;
  const a = splitLinesV20(from.data.value);
  const b = splitLinesV20(to.data.value);
  const lines = diffLinesV20(a, b);
  let addedCount = 0;
  let removedCount = 0;
  let unchangedCount = 0;
  for (const l of lines) {
    if (l.kind === 'added') addedCount += 1;
    else if (l.kind === 'removed') removedCount += 1;
    else unchangedCount += 1;
  }
  return {
    ok: true,
    data: { blockId: block.id, label: block.label, fromVersion, toVersion, lines, addedCount, removedCount, unchangedCount },
  };
}

function splitLinesV20(value: string): string[] {
  if (!value) return [];
  return value.split('\n');
}

/**
 * LCS bang quy hoach dong tren bang (m+1)x(n+1). Dung bo nho
 * O(m*n) nen chi dung cho diff nho; caller gioi han so dong
 * truoc khi goi (xem `MAX_DIFF_LINES_V20`).
 */
export const MAX_DIFF_LINES_V20 = 500;

export function diffLinesV20(a: string[], b: string[]): V20VersionDiffLine[] {
  const m = a.length;
  const n = b.length;
  if (m > MAX_DIFF_LINES_V20 || n > MAX_DIFF_LINES_V20) {
    // Qua lon cho LCS day du: fallback — toan bo dong khac nhau
    // duoc bao la removed + added, dong giong nhau o dau/cuoi giu lai.
    return fallbackDiffV20(a, b);
  }
  const dp: number[][] = [];
  for (let i = 0; i <= m; i += 1) dp.push(new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: V20VersionDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: 'removed', text: a[i] });
      i += 1;
    } else {
      out.push({ kind: 'added', text: b[j] });
      j += 1;
    }
  }
  while (i < m) {
    out.push({ kind: 'removed', text: a[i] });
    i += 1;
  }
  while (j < n) {
    out.push({ kind: 'added', text: b[j] });
    j += 1;
  }
  return out;
}

function fallbackDiffV20(a: string[], b: string[]): V20VersionDiffLine[] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const out: V20VersionDiffLine[] = [];
  for (let k = 0; k < prefix; k += 1) out.push({ kind: 'same', text: a[k] });
  for (let k = prefix; k < a.length - suffix; k += 1) out.push({ kind: 'removed', text: a[k] });
  for (let k = prefix; k < b.length - suffix; k += 1) out.push({ kind: 'added', text: b[k] });
  for (let k = a.length - suffix; k < a.length; k += 1) out.push({ kind: 'same', text: a[k] });
  return out;
}

/**
 * Khoi phuc block ve mot version cu. Uy thac cho store: rollback
 * tao version MOI (version hien tai + 1) copy noi dung cu, lich su
 * cu van nguyen. Tra loi ro rang khi target khong ton tai, block
 * da o dung version do, hoac noi dung dich la rong.
 */
export function rollbackBlockV20(
  store: V20CoreBlockStore,
  blockId: string,
  targetVersion: number,
  actor: string,
  reason: string,
): V20BlockEditResult {
  if (!Number.isInteger(targetVersion) || targetVersion < 1) {
    return { ok: false, error: `version dich phai la so nguyen >= 1 (nhan ${targetVersion})`, errorCode: 'invalid_op' };
  }
  if (!reason || reason.trim().length < 3) {
    return { ok: false, error: 'can ly do rollback (toi thieu 3 ky tu)', errorCode: 'empty_reason' };
  }
  const block = store.getBlock(blockId);
  if (!block) return { ok: false, error: `khong tim thay block "${blockId}"`, errorCode: 'block_not_found' };
  if (block.version === targetVersion) {
    return { ok: false, error: `block "${block.label}" dang o version ${targetVersion}`, errorCode: 'invalid_op' };
  }
  const target = getBlockVersionContentV20(store, block.id, targetVersion);
  if (!target.ok || !target.data) {
    return { ok: false, error: target.error, errorCode: 'version_conflict' };
  }
  if (!target.data.value.trim()) {
    return { ok: false, error: `version ${targetVersion} cua block "${block.label}" rong, khong rollback ve noi dung rong`, errorCode: 'empty_value' };
  }
  return store.rollbackBlock(block.id, targetVersion, actor, reason.trim());
}

/** Tom tat lich su version de UI hien thi ma khong can load toan bo. */
export function versioningSummaryV20(
  store: V20CoreBlockStore,
  blockId: string,
): V20VersioningResult<V20VersioningSummary> {
  const block = store.getBlock(blockId);
  if (!block) return { ok: false, error: `khong tim thay block "${blockId}"`, errorCode: 'block_not_found' };
  const versions = listBlockVersionsV20(store, block.id);
  const first = versions[0];
  const last = versions[versions.length - 1];
  return {
    ok: true,
    data: {
      blockId: block.id,
      label: block.label,
      currentVersion: block.version,
      totalVersions: versions.length,
      firstUpdatedAt: first ? first.updatedAt : block.createdAt,
      lastUpdatedAt: last ? last.updatedAt : block.updatedAt,
      lastUpdatedBy: last ? last.updatedBy : block.updatedBy,
      lastOp: last ? last.op : 'create',
      lastReason: last ? last.reason : 'tao block moi',
      archived: block.archived,
    },
  };
}
