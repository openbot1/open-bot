/**
 * Coding agent v19 — workspace tách bạch theo conversation (v1.41, Đội T4).
 *
 * Mỗi conversation có một workspace riêng (thư mục riêng dưới data
 * dir); mọi thao tác file phải đi qua path containment — resolve rồi
 * kiểm tra còn nằm trong workspace, chặn path traversal (`../`,
 * đường tuyệt đối ngoài workspace) cả ở dạng lexical lẫn symlink
 * (realpath khi file/thư mục cha đã tồn tại). Snapshot/checkpoint lưu
 * manifest hash + copy file; rollback khôi phục đúng snapshot và xoá
 * file sinh sau snapshot; diff viewer data so sánh hai snapshot (hoặc
 * snapshot với workspace hiện tại) bằng diff dòng đơn giản.
 *
 * Ý tưởng học từ survey v141 §3 (OpenHands SDK v1.49: `AgentSandbox
 * Workspace`, package path containment): workspace tách bạch + chặn
 * path thoát ra ngoài. Code của open-bot, chạy trên file local.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CodingV19Error, V19_DIFF_CONTEXT_LINES, V19_MAX_CHECKPOINTS_PER_CONVERSATION, V19_MAX_FILE_BYTES } from './types';
import type {
  V19DiffHunk,
  V19DiffLine,
  V19PathCheck,
  V19RollbackResult,
  V19SnapshotFileEntry,
  V19WorkspaceDiffEntry,
  V19WorkspaceFile,
  V19WorkspaceSnapshot,
} from './types';
import { v19HashText } from './events';

/** Chuẩn hoá đường dẫn tương đối: '/' làm separator, bỏ './' thừa. */
export function v19NormalizeRelPath(relPath: string): string {
  if (typeof relPath !== 'string') throw new CodingV19Error('Đường dẫn phải là string.');
  const normalized = relPath.replace(/\\/g, '/').trim();
  if (normalized === '' || normalized === '.') return '';
  const parts = normalized.split('/').filter((p) => p !== '' && p !== '.');
  return parts.join('/');
}

/**
 * Kiểm tra một path (tương đối hoặc tuyệt đối) có nằm trong workspace
 * không. Trả về cả relPath đã chuẩn hoá + absolutePath đã resolve.
 * Chặn: `..` thoát ra ngoài, path tuyệt đối ngoài root, symlink trỏ
 * ra ngoài (khi target/cha đã tồn tại trên đĩa).
 */
export function v19CheckWorkspacePath(workspaceRoot: string, inputPath: string): V19PathCheck {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim() === '') {
    throw new CodingV19Error('workspaceRoot không được rỗng.');
  }
  if (typeof inputPath !== 'string' || inputPath.trim() === '') {
    throw new CodingV19Error('Đường dẫn file không được rỗng.');
  }
  const root = path.resolve(workspaceRoot);
  const candidate = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(root, inputPath);
  const rel = path.relative(root, candidate);
  const inside = rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
  if (!inside) {
    return {
      inside: false,
      relPath: '',
      absolutePath: candidate,
      reason: `Path "${inputPath}" thoát ra ngoài workspace (chỉ được thao tác trong workspace của conversation).`,
    };
  }
  const relPath = v19NormalizeRelPath(rel.split(path.sep).join('/'));
  // Symlink: nếu file (hoặc thư mục cha gần nhất đã tồn tại) là symlink
  // trỏ ra ngoài workspace thì chặn — lexical check một mình không đủ.
  let probe = candidate;
  for (let depth = 0; depth < 32; depth += 1) {
    try {
      const stat = fs.lstatSync(probe);
      if (stat.isSymbolicLink()) {
        const real = fs.realpathSync(probe);
        const realRel = path.relative(root, real);
        const realInside =
          realRel === '' || (!realRel.startsWith(`..${path.sep}`) && realRel !== '..' && !path.isAbsolute(realRel));
        if (!realInside) {
          return {
            inside: false,
            relPath,
            absolutePath: candidate,
            reason: `Path "${inputPath}" đi qua symlink trỏ ra ngoài workspace ("${probe}" -> "${real}").`,
          };
        }
      }
      break;
    } catch {
      // Chưa tồn tại: leo lên thư mục cha để kiểm tra symlink ở trên.
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return { inside: true, relPath, absolutePath: candidate, reason: '' };
}

/** Resolve path trong workspace, throw CodingV19Error khi bị chặn. */
export function v19ResolveWorkspacePath(workspaceRoot: string, inputPath: string): V19PathCheck {
  const check = v19CheckWorkspacePath(workspaceRoot, inputPath);
  if (!check.inside) throw new CodingV19Error(check.reason);
  return check;
}

/** Đảm bảo workspace root tồn tại, trả đường dẫn tuyệt đối. */
export function v19EnsureWorkspace(workspaceRoot: string): string {
  const root = path.resolve(workspaceRoot);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** Đọc một file trong workspace (throw khi ngoài workspace / không có). */
export function v19WorkspaceRead(workspaceRoot: string, inputPath: string): V19WorkspaceFile {
  const check = v19ResolveWorkspacePath(workspaceRoot, inputPath);
  if (check.relPath === '') throw new CodingV19Error('Không đọc được chính thư mục workspace root như file.');
  if (!fs.existsSync(check.absolutePath)) {
    throw new CodingV19Error(`File "${check.relPath}" không có trong workspace.`);
  }
  const stat = fs.statSync(check.absolutePath);
  if (!stat.isFile()) throw new CodingV19Error(`"${check.relPath}" không phải file.`);
  if (stat.size > V19_MAX_FILE_BYTES) {
    throw new CodingV19Error(`File "${check.relPath}" quá lớn (${stat.size} bytes > giới hạn ${V19_MAX_FILE_BYTES}).`);
  }
  const content = fs.readFileSync(check.absolutePath, 'utf8');
  return { relPath: check.relPath, content, size: stat.size, hash: v19HashText(content) };
}

/**
 * Ghi file vào workspace (tạo thư mục cha khi cần). Trả file đã ghi.
 * Ghi qua file tạm + rename để không để lại file nửa chừng khi lỗi.
 */
export function v19WorkspaceWrite(
  workspaceRoot: string,
  inputPath: string,
  content: string,
): V19WorkspaceFile {
  const check = v19ResolveWorkspacePath(workspaceRoot, inputPath);
  if (check.relPath === '') throw new CodingV19Error('Không ghi được lên chính thư mục workspace root.');
  if (typeof content !== 'string') throw new CodingV19Error('Nội dung file phải là string.');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > V19_MAX_FILE_BYTES) {
    throw new CodingV19Error(`Nội dung file "${check.relPath}" quá lớn (${bytes} bytes > giới hạn ${V19_MAX_FILE_BYTES}).`);
  }
  const root = v19EnsureWorkspace(workspaceRoot);
  void root;
  fs.mkdirSync(path.dirname(check.absolutePath), { recursive: true });
  const tmpPath = `${check.absolutePath}.v19tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, check.absolutePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Bỏ qua lỗi dọn file tạm.
    }
    throw err;
  }
  const stat = fs.statSync(check.absolutePath);
  return { relPath: check.relPath, content, size: stat.size, hash: v19HashText(content) };
}

/**
 * Sửa file bằng cách thay oldText bằng newContent (edit). Khi oldText
 * không có trong file thì throw (không append lén — agent phải đọc
 * trước khi sửa). Khi file chưa có thì throw (dùng create qua write).
 */
export function v19WorkspaceEdit(
  workspaceRoot: string,
  inputPath: string,
  oldText: string,
  newContent: string,
): V19WorkspaceFile {
  if (typeof oldText !== 'string' || oldText === '') {
    throw new CodingV19Error('oldText không được rỗng (đọc file trước khi sửa).');
  }
  const current = v19WorkspaceRead(workspaceRoot, inputPath);
  if (!current.content.includes(oldText)) {
    throw new CodingV19Error(`Không tìm thấy oldText trong "${current.relPath}" — đọc lại file trước khi sửa.`);
  }
  const next = current.content.replace(oldText, newContent);
  return v19WorkspaceWrite(workspaceRoot, inputPath, next);
}

/** Xoá file trong workspace (throw khi không có / ngoài workspace). */
export function v19WorkspaceDelete(workspaceRoot: string, inputPath: string): string {
  const check = v19ResolveWorkspacePath(workspaceRoot, inputPath);
  if (check.relPath === '') throw new CodingV19Error('Không xoá được chính thư mục workspace root.');
  if (!fs.existsSync(check.absolutePath)) {
    throw new CodingV19Error(`File "${check.relPath}" không có trong workspace.`);
  }
  fs.unlinkSync(check.absolutePath);
  return check.relPath;
}

/** Liệt kê mọi file trong workspace (đệ quy, đường dẫn tương đối, sort). */
export function v19WorkspaceList(workspaceRoot: string): V19WorkspaceFile[] {
  const root = path.resolve(workspaceRoot);
  if (!fs.existsSync(root)) return [];
  const out: V19WorkspaceFile[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue; // Không đi theo symlink khi list.
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        try {
          const content = fs.readFileSync(abs, 'utf8');
          out.push({ relPath: rel, content, size: Buffer.byteLength(content, 'utf8'), hash: v19HashText(content) });
        } catch {
          // File đọc lỗi (quyền/binary): bỏ qua, không chặn list.
        }
      }
    }
  };
  walk(root, '');
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

/** Đọc trạng thái workspace dưới dạng map relPath -> {size, hash} (nhẹ, không đọc nội dung). */
export function v19WorkspaceManifest(workspaceRoot: string): Record<string, V19SnapshotFileEntry> {
  const files = v19WorkspaceList(workspaceRoot);
  const manifest: Record<string, V19SnapshotFileEntry> = {};
  for (const file of files) manifest[file.relPath] = { size: file.size, hash: file.hash };
  return manifest;
}

/** Id snapshot ổn định: `ckpt-<conversationId>-<seq>-<millis>`. */
export function v19SnapshotId(conversationId: string, atSeq: number, at: number): string {
  return `ckpt-${conversationId}-${atSeq}-${at}`;
}

/**
 * Tạo snapshot/checkpoint của workspace: copy toàn bộ file vào
 * snapshotDir + manifest hash. Trả snapshot (chưa ghi event log —
 * caller append event `checkpoint` với snapshotId này).
 */
export function v19CreateSnapshot(
  workspaceRoot: string,
  snapshotDir: string,
  conversationId: string,
  label: string,
  atSeq: number,
  at: number,
): V19WorkspaceSnapshot {
  const id = v19SnapshotId(conversationId, atSeq, at);
  const dest = path.join(snapshotDir, id);
  if (fs.existsSync(dest)) throw new CodingV19Error(`Snapshot "${id}" đã tồn tại.`);
  const files = v19WorkspaceList(workspaceRoot);
  fs.mkdirSync(dest, { recursive: true });
  const manifest: Record<string, V19SnapshotFileEntry> = {};
  for (const file of files) {
    const target = path.join(dest, file.relPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content, 'utf8');
    manifest[file.relPath] = { size: file.size, hash: file.hash };
  }
  const snapshot: V19WorkspaceSnapshot = { id, conversationId, label, atSeq, createdAt: at, files: manifest };
  fs.writeFileSync(path.join(dest, '.v19-snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  return snapshot;
}

/** Load snapshot từ đĩa (undefined khi không có / manifest hỏng). */
export function v19LoadSnapshot(snapshotDir: string, snapshotId: string): V19WorkspaceSnapshot | undefined {
  const manifestFile = path.join(snapshotDir, snapshotId, '.v19-snapshot.json');
  try {
    if (!fs.existsSync(manifestFile)) return undefined;
    const parsed = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as V19WorkspaceSnapshot;
    if (!parsed || parsed.id !== snapshotId || typeof parsed.files !== 'object') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** Liệt kê snapshot của một conversation (mới nhất trước). */
export function v19ListSnapshots(snapshotDir: string, conversationId: string): V19WorkspaceSnapshot[] {
  if (!fs.existsSync(snapshotDir)) return [];
  const out: V19WorkspaceSnapshot[] = [];
  for (const name of fs.readdirSync(snapshotDir)) {
    if (!name.startsWith(`ckpt-${conversationId}-`)) continue;
    const snapshot = v19LoadSnapshot(snapshotDir, name);
    if (snapshot) out.push(snapshot);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt || b.atSeq - a.atSeq);
}

/**
 * Prune snapshot cũ: chỉ giữ `keep` snapshot mới nhất của conversation,
 * xoá thư mục snapshot còn lại khỏi đĩa. Trả id đã xoá (rỗng khi chưa
 * vượt giới hạn). Không xoá snapshot đang được event log trỏ tới? —
 * snapshot là dữ liệu phái sinh (tạo lại được từ workspace hiện tại
 * + event log), nên prune an toàn: rollback về snapshot đã prune sẽ
 * báo không có snapshot, event log không bị ảnh hưởng.
 */
export function v19PruneSnapshots(
  snapshotDir: string,
  conversationId: string,
  keep = 10,
): string[] {
  if (!Number.isInteger(keep) || keep < 1 || keep > V19_MAX_CHECKPOINTS_PER_CONVERSATION) {
    throw new CodingV19Error(`keep phải là số nguyên 1..${V19_MAX_CHECKPOINTS_PER_CONVERSATION}.`);
  }
  const snapshots = v19ListSnapshots(snapshotDir, conversationId);
  if (snapshots.length <= keep) return [];
  const toDelete = snapshots.slice(keep);
  const deleted: string[] = [];
  for (const snapshot of toDelete) {
    fs.rmSync(path.join(snapshotDir, snapshot.id), { recursive: true, force: true });
    deleted.push(snapshot.id);
  }
  return deleted;
}

/**
 * Rollback workspace về snapshot: khôi phục file trong manifest,
 * xoá file hiện có nhưng không có trong snapshot (file sinh sau
 * snapshot). Trả danh sách restored/deleted để ghi event `rollback`.
 */
export function v19RollbackSnapshot(
  workspaceRoot: string,
  snapshotDir: string,
  snapshotId: string,
  at: number,
): V19RollbackResult {
  const snapshot = v19LoadSnapshot(snapshotDir, snapshotId);
  if (!snapshot) throw new CodingV19Error(`Không có snapshot "${snapshotId}".`);
  const root = v19EnsureWorkspace(workspaceRoot);
  void root;
  const snapshotRoot = path.join(snapshotDir, snapshotId);
  const restored: string[] = [];
  for (const relPath of Object.keys(snapshot.files).sort()) {
    const source = path.join(snapshotRoot, relPath);
    const check = v19ResolveWorkspacePath(workspaceRoot, relPath);
    fs.mkdirSync(path.dirname(check.absolutePath), { recursive: true });
    fs.copyFileSync(source, check.absolutePath);
    restored.push(relPath);
  }
  // Xoá file hiện có nhưng không nằm trong snapshot.
  const current = v19WorkspaceList(workspaceRoot);
  const deleted: string[] = [];
  for (const file of current) {
    if (!(file.relPath in snapshot.files)) {
      v19WorkspaceDelete(workspaceRoot, file.relPath);
      deleted.push(file.relPath);
    }
  }
  return {
    snapshotId,
    conversationId: snapshot.conversationId,
    restored,
    deleted,
    atSeq: snapshot.atSeq,
    at,
  };
}

/* ------------------------------------------------------------------ */
/* Diff viewer data                                                    */
/* ------------------------------------------------------------------ */

/** Diff dòng đơn giản: prefix/suffix chung + phần giữa đổi (đủ cho viewer). */
export function v19LineDiff(oldText: string, newText: string): { added: number; removed: number; hunks: V19DiffHunk[] } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const oldMid = oldLines.slice(prefix, oldLines.length - suffix);
  const newMid = newLines.slice(prefix, newLines.length - suffix);
  const added = newMid.length;
  const removed = oldMid.length;
  if (added === 0 && removed === 0) return { added: 0, removed: 0, hunks: [] };
  const context = V19_DIFF_CONTEXT_LINES;
  const hunkOldStart = Math.max(1, prefix - context + 1);
  const hunkNewStart = Math.max(1, prefix - context + 1);
  const lines: V19DiffLine[] = [];
  for (let i = hunkOldStart - 1; i < prefix; i += 1) {
    lines.push({ kind: 'context', text: oldLines[i] ?? '' });
  }
  for (const line of oldMid) lines.push({ kind: 'remove', text: line });
  for (const line of newMid) lines.push({ kind: 'add', text: line });
  const tailStart = oldLines.length - suffix;
  for (let i = tailStart; i < Math.min(oldLines.length, tailStart + context); i += 1) {
    lines.push({ kind: 'context', text: oldLines[i] ?? '' });
  }
  const hunk: V19DiffHunk = {
    oldStart: hunkOldStart,
    oldCount: Math.min(context, prefix - (hunkOldStart - 1)) + oldMid.length + Math.min(context, suffix),
    newStart: hunkNewStart,
    newCount: Math.min(context, prefix - (hunkNewStart - 1)) + newMid.length + Math.min(context, suffix),
    lines,
  };
  return { added, removed, hunks: [hunk] };
}

/**
 * So sánh hai manifest (+ nội dung file khi cần) thành diff entries
 * cho diff viewer. `readContent` đọc nội dung file theo relPath từ
 * phía "mới" (undefined = file đã xoá); `readOldContent` tương tự
 * phía "cũ". Khi cả hai đều không đọc được nội dung thì chỉ đếm dòng
 * bằng 0 và vẫn báo status.
 */
export function v19DiffManifests(
  oldManifest: Record<string, V19SnapshotFileEntry>,
  newManifest: Record<string, V19SnapshotFileEntry>,
  readOldContent?: (relPath: string) => string | undefined,
  readNewContent?: (relPath: string) => string | undefined,
): V19WorkspaceDiffEntry[] {
  const paths = new Set([...Object.keys(oldManifest), ...Object.keys(newManifest)]);
  const entries: V19WorkspaceDiffEntry[] = [];
  for (const relPath of [...paths].sort()) {
    const oldEntry = oldManifest[relPath];
    const newEntry = newManifest[relPath];
    if (oldEntry && !newEntry) {
      const oldText = readOldContent?.(relPath) ?? '';
      entries.push({
        relPath,
        status: 'deleted',
        oldLines: oldText === '' ? 0 : oldText.split('\n').length,
        newLines: 0,
        addedLines: 0,
        removedLines: oldText === '' ? 0 : oldText.split('\n').length,
        hunks: [],
      });
      continue;
    }
    if (!oldEntry && newEntry) {
      const newText = readNewContent?.(relPath) ?? '';
      entries.push({
        relPath,
        status: 'added',
        oldLines: 0,
        newLines: newText === '' ? 0 : newText.split('\n').length,
        addedLines: newText === '' ? 0 : newText.split('\n').length,
        removedLines: 0,
        hunks: [],
      });
      continue;
    }
    if (oldEntry && newEntry && oldEntry.hash === newEntry.hash) {
      entries.push({
        relPath,
        status: 'unchanged',
        oldLines: 0,
        newLines: 0,
        addedLines: 0,
        removedLines: 0,
        hunks: [],
      });
      continue;
    }
    const oldText = readOldContent?.(relPath) ?? '';
    const newText = readNewContent?.(relPath) ?? '';
    const diff = v19LineDiff(oldText, newText);
    entries.push({
      relPath,
      status: 'modified',
      oldLines: oldText === '' ? 0 : oldText.split('\n').length,
      newLines: newText === '' ? 0 : newText.split('\n').length,
      addedLines: diff.added,
      removedLines: diff.removed,
      hunks: diff.hunks,
    });
  }
  return entries;
}

/** So sánh snapshot với workspace hiện tại (diff viewer: snapshot -> now). */
export function v19DiffSnapshotToWorkspace(
  workspaceRoot: string,
  snapshotDir: string,
  snapshotId: string,
): V19WorkspaceDiffEntry[] {
  const snapshot = v19LoadSnapshot(snapshotDir, snapshotId);
  if (!snapshot) throw new CodingV19Error(`Không có snapshot "${snapshotId}".`);
  const current = v19WorkspaceManifest(workspaceRoot);
  const snapshotRoot = path.join(snapshotDir, snapshotId);
  const readOld = (relPath: string): string | undefined => {
    try {
      return fs.readFileSync(path.join(snapshotRoot, relPath), 'utf8');
    } catch {
      return undefined;
    }
  };
  const readNew = (relPath: string): string | undefined => {
    try {
      return v19WorkspaceRead(workspaceRoot, relPath).content;
    } catch {
      return undefined;
    }
  };
  return v19DiffManifests(snapshot.files, current, readOld, readNew);
}

/** Render diff entries thành text ngắn (cho tool output / UI fallback). */
export function renderV19WorkspaceDiff(entries: readonly V19WorkspaceDiffEntry[]): string {
  const changed = entries.filter((e) => e.status !== 'unchanged');
  if (changed.length === 0) return 'Không có thay đổi.';
  const lines = changed.map((e) => {
    if (e.status === 'added') return `+ ${e.relPath} (mới, ${e.newLines} dòng)`;
    if (e.status === 'deleted') return `- ${e.relPath} (đã xoá, ${e.oldLines} dòng)`;
    return `~ ${e.relPath} (+${e.addedLines}/-${e.removedLines} dòng)`;
  });
  return lines.join('\n');
}

/** Render danh sách file workspace (một dòng một file). */
export function renderV19WorkspaceList(files: readonly V19WorkspaceFile[]): string {
  if (files.length === 0) return '(workspace rỗng)';
  return files.map((f) => `${f.relPath} (${f.size} bytes)`).join('\n');
}

/* ------------------------------------------------------------------ */
/* Cây thư mục workspace (cho UI tree view)                            */
/* ------------------------------------------------------------------ */

/** Một node trong cây thư mục workspace. */
export interface V19WorkspaceTreeNode {
  name: string;
  relPath: string;
  kind: 'file' | 'dir';
  /** Kích thước (file) hoặc tổng bytes con cháu (dir). */
  size: number;
  children?: V19WorkspaceTreeNode[];
}

/**
 * Dựng cây thư mục workspace từ danh sách file (đã sort). Dir tổng
 * hợp size từ con cháu; cây rỗng khi workspace rỗng.
 */
export function v19WorkspaceTree(files: readonly V19WorkspaceFile[]): V19WorkspaceTreeNode[] {
  interface MutableNode extends V19WorkspaceTreeNode {
    children: V19WorkspaceTreeNode[];
  }
  const roots: MutableNode[] = [];
  const dirIndex = new Map<string, MutableNode>();
  const getDir = (relPath: string, name: string): MutableNode => {
    const existing = dirIndex.get(relPath);
    if (existing) return existing;
    const node: MutableNode = { name, relPath, kind: 'dir', size: 0, children: [] };
    dirIndex.set(relPath, node);
    const parentPath = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
    if (parentPath === '') {
      roots.push(node);
    } else {
      const parentName = parentPath.slice(parentPath.lastIndexOf('/') + 1);
      getDir(parentPath, parentName).children.push(node);
    }
    return node;
  };
  for (const file of [...files].sort((a, b) => a.relPath.localeCompare(b.relPath))) {
    const slash = file.relPath.lastIndexOf('/');
    const name = slash === -1 ? file.relPath : file.relPath.slice(slash + 1);
    const fileNode: V19WorkspaceTreeNode = { name, relPath: file.relPath, kind: 'file', size: file.size };
    if (slash === -1) {
      roots.push(fileNode as MutableNode);
      continue;
    }
    const parentPath = file.relPath.slice(0, slash);
    const parentName = parentPath.slice(parentPath.lastIndexOf('/') + 1);
    const parent = getDir(parentPath, parentName);
    parent.children.push(fileNode);
    parent.size += file.size;
    // Cộng size lên các dir tổ tiên.
    let cursor = parentPath;
    while (cursor.includes('/')) {
      cursor = cursor.slice(0, cursor.lastIndexOf('/'));
      const ancestor = dirIndex.get(cursor);
      if (ancestor) ancestor.size += file.size;
    }
  }
  const sortNode = (node: V19WorkspaceTreeNode): void => {
    if (!node.children) return;
    node.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const child of node.children) sortNode(child);
  };
  roots.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const root of roots) sortNode(root);
  return roots;
}

/** Render cây workspace dạng text thụt lề (cho tool output / UI fallback). */
export function renderV19WorkspaceTree(nodes: readonly V19WorkspaceTreeNode[], depth = 0): string {
  const lines: string[] = [];
  for (const node of nodes) {
    const indent = '  '.repeat(depth);
    lines.push(`${indent}${node.kind === 'dir' ? '[dir]' : '[file]'} ${node.name}${node.kind === 'file' ? ` (${node.size} bytes)` : ''}`);
    if (node.children) lines.push(renderV19WorkspaceTree(node.children, depth + 1));
  }
  return lines.join('\n');
}
