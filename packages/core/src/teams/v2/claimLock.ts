/**
 * Agent Teams v2 — claim lock trên disk (v1.10, Đội T3).
 *
 * V1 claim là nguyên tử trong process (taskList.claimTask): hai
 * teammate trong cùng process không giành cùng task, nhưng hai
 * process/agent khác nhau (lead chạy riêng, worker chạy riêng, CLI
 * riêng) vẫn có thể cùng claim. V2 thêm lock file trên disk:
 *
 * - Lấy lock = tạo file `locks/<taskId>.lock.json` bằng flag `wx`
 *   (atomic: file đã tồn tại thì open thất bại với EEXIST — chỉ
 *   một bên thắng, bên kia nhận lỗi rõ ràng, không race).
 * - Lease có hạn: lock mang `leaseUntil`; teammate phải heartbeat
 *   (gia hạn lease) trước khi hết hạn. Quá hạn = lock treo.
 * - Thu hồi lock treo: đọc lại nội dung file, chỉ xóa khi nội dung
 *   không đổi từ lúc đọc (tránh xóa lock của owner vừa heartbeat),
 *   rồi lấy lock mới bằng `wx` — bên thua race vẫn nhận EEXIST.
 * - Nhả lock: chỉ owner mới được xóa (đọc file kiểm tra ownerId).
 *
 * Lock lưu JSON (mode 0600, cùng mẫu store v1): không chứa secret.
 * Mọi hàm đều đồng bộ (fs sync) để thao tác check-then-act không
 * bị chen ngang bởi await — race duy nhất còn lại là giữa các
 * process, và `wx` xử lý đúng trường hợp đó.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  DEFAULT_CLAIM_LEASE_MS,
  type ClaimLock,
  type ClaimLockResult,
} from './types';

function ok<T>(value: T): ClaimLockResult<T> {
  return { ok: true, value };
}

function fail<T>(error: string): ClaimLockResult<T> {
  return { ok: false, error };
}

/** Thư mục lock của một team: `<baseDir>/teams-v2/<teamId>/locks/`. */
export function teamLocksDir(baseDir: string, teamId: string): string {
  return path.join(baseDir, 'teams-v2', teamId, 'locks');
}

/** Đường dẫn file lock của một task. */
export function lockFilePath(baseDir: string, teamId: string, taskId: string): string {
  return path.join(teamLocksDir(baseDir, teamId), `${taskId}.lock.json`);
}

/** Đọc lock file (null = không có lock / file hỏng thì coi như không có nhưng báo lỗi đọc). */
export function readLockFile(
  filePath: string,
): { lock: ClaimLock | null; raw: string | null; readError?: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { lock: null, raw: null };
    return { lock: null, raw: null, readError: `Không đọc được lock file: ${(err as Error).message}` };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return { lock: null, raw, readError: 'Lock file không phải JSON object.' };
    }
    const lock = parsed as ClaimLock;
    if (typeof lock.taskId !== 'string' || typeof lock.ownerId !== 'string' || typeof lock.leaseUntil !== 'number') {
      return { lock: null, raw, readError: 'Lock file thiếu trường taskId/ownerId/leaseUntil.' };
    }
    return { lock, raw };
  } catch (err) {
    return { lock: null, raw, readError: `Lock file JSON hỏng: ${(err as Error).message}` };
  }
}

/** Lock đã hết lease chưa (treo). */
export function isLockStale(lock: ClaimLock, now = Date.now()): boolean {
  return now > lock.leaseUntil;
}

/** Ghi lock file nguyên tử (temp + rename, mode 0600). */
function writeLockAtomic(filePath: string, lock: ClaimLock): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(lock, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

/**
 * Lấy lock cho một task (nguyên tử qua `wx`).
 * - Chưa có lock → tạo mới, thắng.
 * - Đã có lock còn hạn, owner khác → lỗi (kèm tên owner + lease còn lại).
 * - Đã có lock nhưng hết hạn → thu hồi (chỉ xóa khi nội dung không
 *   đổi từ lúc đọc) rồi lấy mới; race lúc thu hồi thì bên thua nhận EEXIST.
 * - Đã có lock của chính owner → gia hạn lease (coi như heartbeat).
 */
export function acquireClaimLock(
  baseDir: string,
  teamId: string,
  taskId: string,
  ownerId: string,
  ownerName: string,
  leaseMs: number = DEFAULT_CLAIM_LEASE_MS,
  now = Date.now(),
): ClaimLockResult<ClaimLock> {
  if (!taskId.trim()) return fail('taskId không được rỗng.');
  if (!ownerId.trim()) return fail('ownerId không được rỗng.');
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) return fail('leaseMs phải là số > 0.');
  const filePath = lockFilePath(baseDir, teamId, taskId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lock: ClaimLock = {
    taskId,
    ownerId,
    ownerName,
    acquiredAt: now,
    heartbeatAt: now,
    leaseUntil: now + leaseMs,
    pid: process.pid,
  };
  const payload = JSON.stringify(lock, null, 2);
  try {
    // `wx`: tạo mới, thất bại nếu file đã tồn tại — đây là điểm nguyên tử.
    fs.writeFileSync(filePath, payload, { flag: 'wx', mode: 0o600 });
    return ok(lock);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      return fail(`Không tạo được lock file: ${(err as Error).message}`);
    }
  }
  // File đã tồn tại: đọc xem của ai, còn hạn không.
  const existing = readLockFile(filePath);
  if (existing.readError) {
    return fail(`Lock của task ${taskId} đang giữ nhưng không đọc được (${existing.readError}) — không giành lock hỏng.`);
  }
  const held = existing.lock;
  if (!held) {
    // File biến mất giữa chừng (owner vừa nhả): thử lại một lần.
    try {
      fs.writeFileSync(filePath, payload, { flag: 'wx', mode: 0o600 });
      return ok(lock);
    } catch (err) {
      return fail(`Task ${taskId} vừa bị teammate khác claim (race lúc nhả lock).`);
    }
  }
  if (held.ownerId === ownerId) {
    // Chính mình giữ rồi → gia hạn lease thay vì lỗi.
    const renewed: ClaimLock = { ...held, heartbeatAt: now, leaseUntil: now + leaseMs };
    try {
      writeLockAtomic(filePath, renewed);
    } catch (err) {
      return fail(`Không gia hạn được lock: ${(err as Error).message}`);
    }
    return ok(renewed);
  }
  if (!isLockStale(held, now)) {
    const remainingSec = Math.ceil((held.leaseUntil - now) / 1000);
    return fail(
      `Task ${taskId} đang bị "${held.ownerName}" giữ (lease còn ${remainingSec}s) — chờ hết lease hoặc nhờ lead thu hồi.`,
    );
  }
  // Lock treo: chỉ xóa khi nội dung file không đổi từ lúc đọc (tránh
  // xóa lock của owner vừa heartbeat giữa chừng), rồi lấy mới bằng `wx`.
  try {
    const current = fs.readFileSync(filePath, 'utf8');
    if (current !== existing.raw) {
      return fail(`Task ${taskId} vừa có lock mới (race lúc thu hồi lock treo) — thử lại.`);
    }
    fs.unlinkSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return fail(`Không thu hồi được lock treo: ${(err as Error).message}`);
    }
  }
  try {
    fs.writeFileSync(filePath, payload, { flag: 'wx', mode: 0o600 });
    return ok(lock);
  } catch (err) {
    return fail(`Task ${taskId} vừa bị teammate khác claim lúc thu hồi lock treo.`);
  }
}

/**
 * Heartbeat: gia hạn lease của lock mình đang giữ.
 * Chỉ owner mới được heartbeat; lock của người khác / lock treo / không có lock → lỗi.
 */
export function heartbeatClaimLock(
  baseDir: string,
  teamId: string,
  taskId: string,
  ownerId: string,
  leaseMs: number = DEFAULT_CLAIM_LEASE_MS,
  now = Date.now(),
): ClaimLockResult<ClaimLock> {
  const filePath = lockFilePath(baseDir, teamId, taskId);
  const existing = readLockFile(filePath);
  if (existing.readError) return fail(existing.readError);
  const held = existing.lock;
  if (!held) return fail(`Task ${taskId} không có lock — heartbeat thất bại, claim lại từ đầu.`);
  if (held.ownerId !== ownerId) {
    return fail(`Lock task ${taskId} thuộc về "${held.ownerName}", không heartbeat được.`);
  }
  if (isLockStale(held, now)) {
    return fail(`Lock task ${taskId} đã hết lease — heartbeat quá muộn, claim lại từ đầu.`);
  }
  const renewed: ClaimLock = { ...held, heartbeatAt: now, leaseUntil: now + leaseMs };
  try {
    writeLockAtomic(filePath, renewed);
  } catch (err) {
    return fail(`Không gia hạn được lock: ${(err as Error).message}`);
  }
  return ok(renewed);
}

/**
 * Nhả lock: chỉ owner mới được nhả. Nhả lock không tồn tại = ok
 * (idempotent — teammate crash rồi nhả lại không lỗi).
 */
export function releaseClaimLock(
  baseDir: string,
  teamId: string,
  taskId: string,
  ownerId: string,
): ClaimLockResult<boolean> {
  const filePath = lockFilePath(baseDir, teamId, taskId);
  const existing = readLockFile(filePath);
  if (existing.readError) return fail(existing.readError);
  const held = existing.lock;
  if (!held) return ok(true);
  if (held.ownerId !== ownerId) {
    return fail(`Lock task ${taskId} thuộc về "${held.ownerName}", không nhả được.`);
  }
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return fail(`Không xóa được lock file: ${(err as Error).message}`);
    }
  }
  return ok(true);
}

/** Đọc lock hiện tại của một task (null = không ai giữ). */
export function getClaimLock(
  baseDir: string,
  teamId: string,
  taskId: string,
): ClaimLock | null {
  const { lock } = readLockFile(lockFilePath(baseDir, teamId, taskId));
  return lock;
}

/** Liệt kê mọi lock của team (kèm trạng thái treo). */
export function listClaimLocks(
  baseDir: string,
  teamId: string,
  now = Date.now(),
): { lock: ClaimLock; stale: boolean }[] {
  const dir = teamLocksDir(baseDir, teamId);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.lock.json'));
  } catch {
    return [];
  }
  const out: { lock: ClaimLock; stale: boolean }[] = [];
  for (const file of files) {
    const { lock, readError } = readLockFile(path.join(dir, file));
    if (!lock || readError) continue;
    out.push({ lock, stale: isLockStale(lock, now) });
  }
  return out.sort((a, b) => a.lock.acquiredAt - b.lock.acquiredAt);
}

/** Các lock treo của team (quá lease) — để lead/service requeue task. */
export function findStaleClaimLocks(
  baseDir: string,
  teamId: string,
  now = Date.now(),
): ClaimLock[] {
  return listClaimLocks(baseDir, teamId, now)
    .filter((entry) => entry.stale)
    .map((entry) => entry.lock);
}

/**
 * Thu hồi lock treo (lead gọi): chỉ xóa khi lock còn treo lúc đọc
 * lại — lock đã được heartbeat kịp thì không đụng tới.
 * Trả về lock đã thu hồi, hoặc lỗi khi lock không treo/không tồn tại.
 */
export function reclaimStaleClaimLock(
  baseDir: string,
  teamId: string,
  taskId: string,
  now = Date.now(),
): ClaimLockResult<ClaimLock> {
  const filePath = lockFilePath(baseDir, teamId, taskId);
  const existing = readLockFile(filePath);
  if (existing.readError) return fail(existing.readError);
  const held = existing.lock;
  if (!held) return fail(`Task ${taskId} không có lock để thu hồi.`);
  if (!isLockStale(held, now)) {
    return fail(`Lock task ${taskId} của "${held.ownerName}" còn hạn, không thu hồi được.`);
  }
  try {
    const current = fs.readFileSync(filePath, 'utf8');
    if (current !== existing.raw) {
      return fail(`Lock task ${taskId} vừa đổi (owner heartbeat kịp) — không thu hồi.`);
    }
    fs.unlinkSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return fail(`Không thu hồi được lock: ${(err as Error).message}`);
    }
  }
  return ok(held);
}
