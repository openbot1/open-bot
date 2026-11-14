/**
 * Path safety cho workspace v3 (v1.03, Đội T4).
 *
 * Mọi thao tác file của workspace đều đi qua đây: đường dẫn tương
 * đối do agent đưa phải resolve nằm trong thư mục workspace, kể cả
 * khi có symlink trỏ ra ngoài (kiểm tra bằng realpath từng thành
 * phần, không chỉ kiểm tra chuỗi — chuỗi `a/../../etc` đã bị chặn,
 * nhưng symlink `a -> /etc` thì chỉ realpath mới bắt được).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspacePathError';
  }
}

/**
 * Resolve `relPath` (tương đối, dùng `/`) thành đường dẫn tuyệt đối
 * trong `root`. Ném WorkspacePathError khi:
 * - relPath là đường dẫn tuyệt đối, hoặc
 * - resolve ra ngoài root (`..` escape), hoặc
 * - bất kỳ thành phần nào đã tồn tại trên đường dẫn là symlink trỏ
 *   ra ngoài root.
 * `mustExist` = true thì ném lỗi khi file chưa tồn tại.
 */
export function resolveWithinRoot(root: string, relPath: string, mustExist = false): string {
  if (path.isAbsolute(relPath)) {
    throw new WorkspacePathError(`absolute paths are not allowed inside a workspace: ${relPath}`);
  }
  const normalized = relPath.replace(/\\/g, '/');
  const target = path.resolve(root, normalized);
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new WorkspacePathError(`path escapes the workspace: ${relPath}`);
  }
  // Kiểm tra symlink: đi từng thành phần từ root xuống; thành phần
  // nào đã tồn tại thì realpath và chắc chắn vẫn nằm trong real root.
  // Phần chưa tồn tại thì không thể là symlink — dừng ở đó.
  if (fs.existsSync(root)) {
    const realRoot = fs.realpathSync(root);
    const segments = rel.split(path.sep).filter((s) => s.length > 0);
    let cur = realRoot;
    for (const seg of segments) {
      cur = path.join(cur, seg);
      if (!fs.existsSync(cur)) break;
      const real = fs.realpathSync(cur);
      const realRel = path.relative(realRoot, real);
      if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
        throw new WorkspacePathError(`path escapes the workspace via symlink: ${relPath}`);
      }
      cur = real;
    }
  }
  if (mustExist && !fs.existsSync(target)) {
    throw new WorkspacePathError(`file does not exist in workspace: ${relPath}`);
  }
  return target;
}

/** True khi relPath hợp lệ trong root (không ném lỗi). */
export function isPathInsideRoot(root: string, relPath: string): boolean {
  try {
    resolveWithinRoot(root, relPath);
    return true;
  } catch {
    return false;
  }
}

/** Chuẩn hoá đường dẫn tương đối dùng trong manifest/list (luôn dùng `/`). */
export function toRelPath(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join('/');
}
