/**
 * Git-backed memory versioning v9 (v1.08, Đội T1).
 *
 * Ý tưởng học từ Letta "git-backed memory" (memory được version như
 * code — xem diff, rollback về phiên bản cũ), viết lại hoàn toàn cho
 * open-bot trên nền projection v7 đã có. v7 đã lưu mỗi block thành
 * file .md trong repo git riêng (mỗi lần sửa là một commit) và có
 * blockHistory/blockDiff thô — nhưng chưa có API thống nhất cho
 * agent/UI:
 *
 *  - SNAPSHOT CÓ TÊN: chụp phiên bản hiện tại của block kèm ghi chú
 *    (vd "trước khi sleep nén", "trước khi sửa tay") — lưu đủ nội
 *    dung vào `.open-bot/memory-v9-snapshots.jsonl` nên rollback
 *    được cả khi máy không có git.
 *  - HISTORY GỘP: một danh sách phiên bản duy nhất, gộp snapshot v9
 *    + commit git v7 (+ history.jsonl dự phòng qua blockHistory) —
 *    dedupe theo (version + hash), mới nhất trước.
 *  - DIFF TỪNG DÒNG: thuật toán LCS tự viết (không gọi git diff),
 *    trả về hunks có context + số dòng hai phía; kèm text git diff
 *    thô khi cả hai phiên bản đều có commit.
 *  - ROLLBACK: ghi nội dung cũ lại thành phiên bản MỚI (version+1)
 *    qua projection.update — không bao giờ viết lại lịch sử; bản
 *    rollback cũng được snapshot + ghi chú rõ "rollback từ vN".
 *
 * Giới hạn: snapshot giữ tối đa 30 phiên bản/block (cũ nhất bị cắt);
 * diff LCS chạy trên toàn bộ dòng nên block rất dài (giới hạn ký tự
 * của projection) vẫn nhanh, nhưng không dùng cho file ngoài block.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { GitMemoryProjection } from '../gitProjection';
import { GitMemoryProjection as GitMemoryProjectionClass } from '../gitProjection';
import {
  normalizeV9BlockLabel,
  V9_MAX_NOTE_CHARS,
  V9_SNAPSHOTS_PER_BLOCK_KEEP,
  V9_SNAPSHOTS_REL_PATH,
  V9_VERSION_ACTOR,
  V9Error,
} from './types';
import type {
  V9DiffHunk,
  V9DiffLine,
  V9RollbackReport,
  V9Snapshot,
  V9VersionDiff,
  V9VersionInfo,
} from './types';

/** Số dòng context quanh mỗi hunk trong diff. */
export const V9_DIFF_CONTEXT_LINES = 3;
/** Số hunk tối đa trả về trong một diff (cắt khi block đổi quá nhiều). */
export const V9_DIFF_MAX_HUNKS = 50;

/** SHA-256 hex của một chuỗi (để đối chiếu nội dung nhanh). */
export function v9Sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Diff từng dòng giữa hai text (thuật toán LCS trên mảng dòng).
 * Trả về danh sách dòng có type ' ' (giữ nguyên), '+' (thêm),
 * '-' (xoá), kèm số dòng hai phía.
 */
export function lineDiff(oldText: string, newText: string): V9DiffLine[] {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const n = oldLines.length;
  const m = newLines.length;
  // Bảng LCS (n+1)x(m+1) — block có giới hạn ký tự nên bảng vừa phải.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      (dp[i] as number[])[j as number] =
        oldLines[i] === newLines[j]
          ? 1 + ((dp[i + 1] as number[])[j + 1] as number)
          : Math.max((dp[i + 1] as number[])[j] as number, (dp[i] as number[])[j + 1] as number);
    }
  }
  const out: V9DiffLine[] = [];
  let i = 0;
  let j = 0;
  let oldNo = 1;
  let newNo = 1;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      out.push({ type: ' ', text: oldLines[i] as string, oldLineNo: oldNo, newLineNo: newNo });
      i += 1;
      j += 1;
      oldNo += 1;
      newNo += 1;
    } else if (((dp[i + 1] as number[])[j] as number) >= ((dp[i] as number[])[j + 1] as number)) {
      out.push({ type: '-', text: oldLines[i] as string, oldLineNo: oldNo, newLineNo: null });
      i += 1;
      oldNo += 1;
    } else {
      out.push({ type: '+', text: newLines[j] as string, oldLineNo: null, newLineNo: newNo });
      j += 1;
      newNo += 1;
    }
  }
  while (i < n) {
    out.push({ type: '-', text: oldLines[i] as string, oldLineNo: oldNo, newLineNo: null });
    i += 1;
    oldNo += 1;
  }
  while (j < m) {
    out.push({ type: '+', text: newLines[j] as string, oldLineNo: null, newLineNo: newNo });
    j += 1;
    newNo += 1;
  }
  return out;
}

/**
 * Gom dòng diff thành hunks: mỗi hunk là một cụm dòng đổi liền kề
 * kèm tối đa V9_DIFF_CONTEXT_LINES dòng context mỗi phía. Hunk nào
 * chỉ toàn dòng giữ nguyên thì bỏ.
 */
export function groupDiffHunks(lines: V9DiffLine[], context = V9_DIFF_CONTEXT_LINES): V9DiffHunk[] {
  const changedIdx: number[] = [];
  lines.forEach((l, idx) => {
    if (l.type !== ' ') changedIdx.push(idx);
  });
  if (changedIdx.length === 0) return [];
  const groups: number[][] = [];
  let current: number[] = [changedIdx[0] as number];
  for (let k = 1; k < changedIdx.length; k += 1) {
    const prev = changedIdx[k - 1] as number;
    const cur = changedIdx[k] as number;
    if (cur - prev <= context * 2 + 1) {
      current.push(cur);
    } else {
      groups.push(current);
      current = [cur];
    }
  }
  groups.push(current);
  const hunks: V9DiffHunk[] = [];
  for (const group of groups.slice(0, V9_DIFF_MAX_HUNKS)) {
    const first = Math.max(0, (group[0] as number) - context);
    const last = Math.min(lines.length - 1, (group[group.length - 1] as number) + context);
    const hunkLines = lines.slice(first, last + 1);
    const oldStart = hunkLines.find((l) => l.oldLineNo !== null)?.oldLineNo ?? 1;
    const newStart = hunkLines.find((l) => l.newLineNo !== null)?.newLineNo ?? 1;
    hunks.push({
      oldStart,
      oldCount: hunkLines.filter((l) => l.type !== '+').length,
      newStart,
      newCount: hunkLines.filter((l) => l.type !== '-').length,
      lines: hunkLines,
    });
  }
  return hunks;
}

/* ------------------------------------------------------------------ */
/* Snapshot store (JSONL)                                             */
/* ------------------------------------------------------------------ */

/** Đọc mọi snapshot trong file (cũ nhất trước). */
export function readV9Snapshots(workspaceDir: string): V9Snapshot[] {
  const filePath = path.join(workspaceDir, V9_SNAPSHOTS_REL_PATH);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const out: V9Snapshot[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as V9Snapshot;
      if (parsed && typeof parsed.label === 'string' && typeof parsed.version === 'number') out.push(parsed);
    } catch {
      // Dòng hỏng — bỏ qua.
    }
  }
  return out;
}

/** Snapshot của một block, mới nhất trước. */
export function readV9SnapshotsForLabel(workspaceDir: string, label: string): V9Snapshot[] {
  const slug = normalizeV9BlockLabel(label);
  return readV9Snapshots(workspaceDir)
    .filter((s) => s.label === slug)
    .sort((a, b) => b.version - a.version || (Date.parse(b.at) - Date.parse(a.at)));
}

/* ------------------------------------------------------------------ */
/* Version store                                                      */
/* ------------------------------------------------------------------ */

/** Tuỳ chọn version store v9. */
export interface MemoryV9VersionStoreOptions {
  /** Projection block v7 (mặc định tạo mới từ workspace). */
  projection?: GitMemoryProjection;
}

/**
 * Version store cho memory block: snapshot / history / diff /
 * rollback, chạy trên projection git-backed v7.
 */
export class MemoryV9VersionStore {
  private readonly workspaceDir: string;
  private readonly projection: GitMemoryProjection;

  constructor(workspaceDir: string, opts: MemoryV9VersionStoreOptions = {}) {
    this.workspaceDir = workspaceDir;
    this.projection = opts.projection ?? new GitMemoryProjectionClass(workspaceDir);
  }

  /** Projection đang dùng (để caller tái dùng cùng instance). */
  getProjection(): GitMemoryProjection {
    return this.projection;
  }

  /**
   * Chụp snapshot phiên bản hiện tại của block (kèm ghi chú).
   * Trả về snapshot đã tạo. Throw khi block không tồn tại.
   */
  snapshot(label: string, note = '', actor = V9_VERSION_ACTOR): V9Snapshot {
    const slug = normalizeV9BlockLabel(label);
    if (!slug) throw new V9Error('Label block rỗng.');
    const block = this.projection.get(slug);
    if (!block) throw new V9Error(`Không tìm thấy memory block "${slug}" để snapshot.`);
    const snap: V9Snapshot = {
      id: randomUUID(),
      label: block.label,
      version: block.version,
      content: block.content,
      contentHash: v9Sha256Hex(block.content),
      commit: block.commit ?? '',
      note: (note ?? '').slice(0, V9_MAX_NOTE_CHARS),
      actor,
      at: new Date().toISOString(),
    };
    const filePath = path.join(this.workspaceDir, V9_SNAPSHOTS_REL_PATH);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(snap)}\n`, { mode: 0o600 });
    this.pruneSnapshots(block.label);
    return snap;
  }

  /** Cắt snapshot của một block xuống tối đa V9_SNAPSHOTS_PER_BLOCK_KEEP (giữ mới nhất). */
  pruneSnapshots(label: string): void {
    try {
      const slug = normalizeV9BlockLabel(label);
      const filePath = path.join(this.workspaceDir, V9_SNAPSHOTS_REL_PATH);
      const raw = fs.readFileSync(filePath, 'utf8');
      const lines = raw.split('\n').filter((l) => l.trim() !== '');
      const kept: string[] = [];
      const blockLines: string[] = [];
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as V9Snapshot;
          if (parsed.label === slug) blockLines.push(line);
          else kept.push(line);
        } catch {
          kept.push(line);
        }
      }
      if (blockLines.length <= V9_SNAPSHOTS_PER_BLOCK_KEEP) return;
      const pruned = blockLines.slice(-V9_SNAPSHOTS_PER_BLOCK_KEEP);
      const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, [...kept, ...pruned].join('\n') + '\n', { mode: 0o600 });
      fs.renameSync(tmp, filePath);
    } catch {
      // Prune best-effort.
    }
  }

  /** Snapshot của một block (mới nhất trước). */
  snapshots(label: string): V9Snapshot[] {
    return readV9SnapshotsForLabel(this.workspaceDir, label);
  }

  /**
   * Lịch sử phiên bản gộp của block: snapshot v9 + commit git v7
   * (qua projection.blockHistory, tự rơi về history.jsonl khi
   * không có git). Dedupe theo (version + hash), mới nhất trước.
   */
  history(label: string, limit = 50): V9VersionInfo[] {
    const slug = normalizeV9BlockLabel(label);
    if (!slug) throw new V9Error('Label block rỗng.');
    const block = this.projection.get(slug);
    if (!block) throw new V9Error(`Không tìm thấy memory block "${slug}".`);
    const byKey = new Map<string, V9VersionInfo>();
    for (const snap of this.snapshots(slug)) {
      const key = `${snap.version}|${snap.contentHash}`;
      if (!byKey.has(key)) {
        byKey.set(key, {
          version: snap.version,
          at: snap.at,
          actor: snap.actor,
          action: 'snapshot',
          commit: snap.commit,
          contentHash: snap.contentHash,
          chars: snap.content.length,
          ...(snap.note ? { note: snap.note } : {}),
          source: 'snapshot',
        });
      }
    }
    try {
      const gitEntries = this.projection.blockHistory(slug, 100);
      for (const entry of gitEntries) {
        const hash = v9Sha256Hex(entry.content);
        const key = `${entry.version}|${hash}`;
        if (!byKey.has(key)) {
          byKey.set(key, {
            version: entry.version,
            at: entry.at,
            actor: entry.author,
            action: entry.message.startsWith('memory-v7: delete') ? 'delete' : 'update',
            commit: entry.commit,
            contentHash: hash,
            chars: entry.chars,
            source: entry.commit ? 'git' : 'history-log',
          });
        }
      }
    } catch {
      // Git history lỗi thì chỉ còn snapshot — vẫn trả được lịch sử.
    }
    const out = [...byKey.values()].sort(
      (a, b) => b.version - a.version || Date.parse(b.at) - Date.parse(a.at),
    );
    return out.slice(0, Math.max(1, Math.min(200, limit)));
  }

  /**
   * Nội dung của block ở một phiên bản: snapshot trước, rồi tới
   * git history. Trả null khi không tìm thấy phiên bản đó.
   */
  contentAtVersion(label: string, version: number): { content: string; at: string; commit: string } | null {
    const slug = normalizeV9BlockLabel(label);
    for (const snap of this.snapshots(slug)) {
      if (snap.version === version) {
        return { content: snap.content, at: snap.at, commit: snap.commit };
      }
    }
    try {
      const entries = this.projection.blockHistory(slug, 200);
      const found = entries.find((e) => e.version === version);
      if (found) return { content: found.content, at: found.at, commit: found.commit };
    } catch {
      // Không có git history — trả null.
    }
    return null;
  }

  /**
   * Diff giữa hai phiên bản của block (from -> to). Mặc định to là
   * phiên bản hiện tại. Throw khi thiếu phiên bản.
   */
  diff(label: string, fromVersion: number, toVersion?: number): V9VersionDiff {
    const slug = normalizeV9BlockLabel(label);
    const block = this.projection.get(slug);
    if (!block) throw new V9Error(`Không tìm thấy memory block "${slug}".`);
    const to = toVersion ?? block.version;
    if (fromVersion === to) {
      return {
        label: block.label,
        fromVersion,
        toVersion: to,
        fromAt: block.updatedAt,
        toAt: block.updatedAt,
        addedLines: 0,
        removedLines: 0,
        hunks: [],
      };
    }
    const from = this.contentAtVersion(slug, fromVersion);
    if (!from) throw new V9Error(`Không tìm thấy phiên bản ${fromVersion} của block "${slug}".`);
    const toContent =
      to === block.version
        ? { content: block.content, at: block.updatedAt, commit: block.commit ?? '' }
        : this.contentAtVersion(slug, to);
    if (!toContent) throw new V9Error(`Không tìm thấy phiên bản ${to} của block "${slug}".`);
    const lines = lineDiff(from.content, toContent.content);
    const addedLines = lines.filter((l) => l.type === '+').length;
    const removedLines = lines.filter((l) => l.type === '-').length;
    const result: V9VersionDiff = {
      label: block.label,
      fromVersion,
      toVersion: to,
      fromAt: from.at,
      toAt: toContent.at,
      addedLines,
      removedLines,
      hunks: groupDiffHunks(lines),
    };
    // Kèm text git diff thô khi cả hai phía đều có commit.
    if (from.commit && toContent.commit && from.commit !== toContent.commit) {
      try {
        const raw = this.projection.blockDiff(slug, toContent.commit, from.commit);
        if (raw) result.gitDiff = raw;
      } catch {
        // Không có git diff thì thôi — hunks LCS vẫn đủ.
      }
    }
    return result;
  }

  /**
   * Rollback block về nội dung của phiên bản cũ: ghi nội dung cũ
   * lại thành phiên bản MỚI (version+1), snapshot lại với ghi chú
   * "rollback từ vN". Không bao giờ viết lại lịch sử. Throw khi
   * không tìm thấy phiên bản hoặc block là read-only / system mà
   * actor là agent (projection tự chặn).
   */
  rollback(label: string, version: number, actor = V9_VERSION_ACTOR): V9RollbackReport {
    const slug = normalizeV9BlockLabel(label);
    const block = this.projection.get(slug);
    if (!block) throw new V9Error(`Không tìm thấy memory block "${slug}".`);
    const target = this.contentAtVersion(slug, version);
    if (!target) throw new V9Error(`Không tìm thấy phiên bản ${version} của block "${slug}".`);
    const fromVersion = block.version;
    if (target.content === block.content) {
      return {
        label: block.label,
        fromVersion,
        toVersion: version,
        newVersion: fromVersion,
        actor,
        at: new Date().toISOString(),
        changed: false,
        snapshotId: null,
      };
    }
    const updated = this.projection.update(slug, { content: target.content }, actor);
    const snap = this.snapshot(slug, `rollback từ v${version} (v${fromVersion} -> v${updated.version})`, actor);
    return {
      label: block.label,
      fromVersion,
      toVersion: version,
      newVersion: updated.version,
      actor,
      at: new Date().toISOString(),
      changed: true,
      snapshotId: snap.id,
    };
  }
}
