/**
 * Fleet v10 — multi-user fleet, local-first (v1.13, Doi T6).
 *
 * Tang tren tang fleet da co (`types.ts` / `registry.ts` / `quotas.ts` /
 * `isolation.ts` / `audit.ts`): fleet hien tai da co workspace theo
 * OS user + quota theo bot + audit chuoi hash + co lap thu muc. Module
 * nay them lop NGUOI DUNG tren cung fleet root, van local-first:
 *
 * - KHONG cloud VM, KHONG he thong tai khoan dang nhap, KHONG thanh
 *   toan. User o day la nguoi dung NOI BO cua may (vd cac thanh vien
 *   trong nha / trong nhom dung chung mot may): dang ky bang ten
 *   nguoi dung cuc bo, admin cua may them/xoa, khong co mat khau
 *   tap trung, khong dong bo len server nao.
 * - Phan quyen theo vai tro (tai dung `FleetRole` cua `types.ts`:
 *   `admin` / `member` / `chat-only`) qua ma tran quyen ro rang,
 *   fail-closed: vai tro khong biet / hanh dong khong biet = tu choi.
 * - Quota tai nguyen THEO USER (khac quota theo bot cua `quotas.ts`):
 *   so agent toi da, so lan chay dong thoi, so trigger/schedule, CPU /
 *   RAM / dia toi da, so lan chay moi ngay. Kiem tra truoc khi tao
 *   moi thu (ham thuan `checkFleetV10UserQuota`).
 * - Cach ly du lieu/workspace theo user: moi user co thu muc rieng
 *   duoi `<fleetRoot>/users/<userId>/`; moi duong dan ghi deu phai
 *   nam trong thu muc do (fail-closed, tu choi `..` va duong dan
 *   tuyet doi ben ngoai). Vault namespace rieng theo user (ten
 *   namespace, khong chua secret o day).
 * - Audit log THEO USER: moi user co file `audit.jsonl` rieng, chuoi
 *   hash SHA-256 noi theo kieu `audit.ts` cua fleet (phat hien sua
 *   len khong tinh lai hash; KHONG chong duoc nguoi co quyen sua file
 *   tinh lai chuoi — gioi han da ghi o fleet/audit.ts).
 * - File ben: `fleet-users-v113.json` + `fleet-user-quotas-v113.json`
 *   duoi fleet root (atomic tmp + rename, mode 0600) + `users/<id>/
 *   audit.jsonl` cho tung user. Khong chua secret.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { FleetRole } from './types';

/** File luu user v10 trong fleet root. */
export const FLEET_V10_USERS_FILE = 'fleet-users-v113.json';
/** File luu quota user v10 trong fleet root. */
export const FLEET_V10_USER_QUOTAS_FILE = 'fleet-user-quotas-v113.json';
/** Thu muc chua du lieu rieng cua tung user (duoi fleet root). */
export const FLEET_V10_USERS_DIR = 'users';
/** File audit rieng cua tung user. */
export const FLEET_V10_USER_AUDIT_FILE = 'audit.jsonl';
/** Gioi han so user trong mot fleet root. */
export const FLEET_V10_MAX_USERS = 100;
/** Ten user chi gom chu thuong, so, gach duoi, gach ngang. */
export const FLEET_V10_USER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Trang thai mot user trong fleet. */
export type FleetV10UserStatus = 'active' | 'suspended';

export const FLEET_V10_USER_STATUSES: readonly FleetV10UserStatus[] = ['active', 'suspended'];

/** Mot user noi bo cua fleet (local, khong phai tai khoan cloud). */
export interface FleetV10User {
  /** Id on dinh: ten dang nhap noi bo, vd `alice` (khong doi duoc). */
  id: string;
  /** Ten hien thi. */
  displayName: string;
  role: FleetRole;
  status: FleetV10UserStatus;
  /** User nao them user nay (`system` = tao tu may). */
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** Epoch ms lan hoat dong gan nhat (null = chua co). */
  lastActiveAt: number | null;
}

/** Dau vao tao user (id + thoi gian do ham tao). */
export interface CreateFleetV10UserInput {
  id: string;
  displayName: string;
  role: FleetRole;
  createdBy?: string;
}

/** Quota tai nguyen cua mot user (tat ca gioi han deu la tran tren). */
export interface FleetV10UserQuota {
  userId: string;
  /** So agent (bot) toi da user duoc so huu. */
  maxAgents: number;
  /** So lan chay agent dong thoi toi da. */
  maxConcurrentRuns: number;
  /** So trigger toi da. */
  maxTriggers: number;
  /** So lich chay dinh ky toi da. */
  maxSchedules: number;
  /** Tong CPU (core) toi da cho tat ca agent cua user. */
  cpuCoresMax: number;
  /** Tong RAM (byte) toi da cho tat ca agent cua user. */
  ramBytesMax: number;
  /** Tong dia (byte) toi da cho du lieu cua user. */
  diskBytesMax: number;
  /** So lan chay agent toi da moi ngay (0 = khong gioi han). */
  maxRunsPerDay: number;
  enabled: boolean;
  updatedAt: number;
  updatedBy: string;
}

/** Muc su dung hien tai cua mot user (de so voi quota). */
export interface FleetV10UserUsage {
  userId: string;
  agents: number;
  concurrentRuns: number;
  triggers: number;
  schedules: number;
  cpuCores: number;
  ramBytes: number;
  diskBytes: number;
  runsToday: number;
}

/** Mot vi pham quota (truong nao, dung bao nhieu, gioi han bao nhieu). */
export interface FleetV10QuotaViolation {
  field: keyof FleetV10UserUsage;
  used: number;
  limit: number;
  message: string;
}

/** Ket qua kiem tra quota: cho phep hay khong + danh sach vi pham. */
export interface FleetV10QuotaCheck {
  allowed: boolean;
  violations: FleetV10QuotaViolation[];
}

/** Hanh dong can phan quyen trong fleet. */
export type FleetV10Action =
  | 'agent.start'
  | 'agent.stop'
  | 'agent.pause'
  | 'trigger.create'
  | 'trigger.delete'
  | 'schedule.create'
  | 'schedule.delete'
  | 'user.manage'
  | 'quota.manage'
  | 'audit.read'
  | 'dashboard.read';

export const FLEET_V10_ACTIONS: readonly FleetV10Action[] = [
  'agent.start',
  'agent.stop',
  'agent.pause',
  'trigger.create',
  'trigger.delete',
  'schedule.create',
  'schedule.delete',
  'user.manage',
  'quota.manage',
  'audit.read',
  'dashboard.read',
];

/**
 * Ma tran quyen: vai tro nao duoc lam gi.
 * - admin: tat ca.
 * - member: chay/dung/tam dung agent cua minh, tao/xoa trigger +
 *   schedule cua minh, xem dashboard; KHONG quan ly user/quota,
 *   KHONG doc audit cua nguoi khac (audit.read o day la audit cua
 *   chinh minh — doc audit nguoi khac can admin, kiem tra o ham
 *   `canFleetV10UserReadAudit`).
 * - chat-only: chi chat (khong dieu khien agent, khong tao
 *   trigger/schedule); chi xem dashboard cua chinh minh.
 */
export const FLEET_V10_PERMISSION_MATRIX: Record<FleetRole, readonly FleetV10Action[]> = {
  admin: FLEET_V10_ACTIONS,
  member: [
    'agent.start',
    'agent.stop',
    'agent.pause',
    'trigger.create',
    'trigger.delete',
    'schedule.create',
    'schedule.delete',
    'audit.read',
    'dashboard.read',
  ],
  'chat-only': ['dashboard.read'],
};

/** Quota mac dinh cho user moi (admin co the doi sau). */
export const DEFAULT_FLEET_V10_USER_QUOTA: Omit<FleetV10UserQuota, 'userId' | 'updatedAt' | 'updatedBy'> = {
  maxAgents: 5,
  maxConcurrentRuns: 2,
  maxTriggers: 20,
  maxSchedules: 20,
  cpuCoresMax: 2,
  ramBytesMax: 4 * 1024 ** 3,
  diskBytesMax: 10 * 1024 ** 3,
  maxRunsPerDay: 200,
  enabled: true,
};

/** Mot su kien audit cua mot user (chuoi hash). */
export interface FleetV10UserAuditEvent {
  /** So thu tu trong chuoi (bat dau 1). */
  seq: number;
  /** Epoch ms. */
  at: number;
  /** User la chu the cua hanh dong. */
  userId: string;
  /** Ai thuc hien (co the khac userId khi admin lam thay). */
  actorUserId: string;
  /** Hanh dong, vd `agent.start`, `quota.change`. */
  action: string;
  /** Doi tuong bi tac dong (id agent / trigger / ...). */
  target: string;
  /** Chi tiet them (khong chua secret). */
  detail: string;
  /** Hash cua su kien truoc (`GENESIS` cho su kien dau). */
  prevHash: string;
  /** Hash SHA-256 cua ban ghi nay. */
  hash: string;
}

// --- Helper -----------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

function isNonNegativeNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function isPositiveNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

const FLEET_ROLES: readonly FleetRole[] = ['admin', 'member', 'chat-only'];

// --- Validate + tao ------------------------------------------------------------

/** Validate mot user day du (nem loi khi truong nao hong). */
export function validateFleetV10User(raw: unknown): FleetV10User {
  if (!isRecord(raw)) throw new Error('fleet v10 user must be an object.');
  const { id, displayName, role, status, createdBy, createdAt, updatedAt, lastActiveAt } = raw;
  if (!isNonEmptyString(id) || !FLEET_V10_USER_ID_PATTERN.test((id as string).trim())) {
    throw new Error('user id must match /^[a-z0-9][a-z0-9_-]{0,63}$/ (lowercase, no spaces).');
  }
  if (!isNonEmptyString(displayName)) throw new Error('user needs a non-empty displayName.');
  if (!FLEET_ROLES.includes(role as FleetRole)) {
    throw new Error(`user role must be one of: ${FLEET_ROLES.join(', ')}.`);
  }
  if (!FLEET_V10_USER_STATUSES.includes(status as FleetV10UserStatus)) {
    throw new Error(`user status must be one of: ${FLEET_V10_USER_STATUSES.join(', ')}.`);
  }
  if (!isNonEmptyString(createdBy)) throw new Error('user needs a non-empty createdBy.');
  if (!isNonNegativeInt(createdAt)) throw new Error('user createdAt must be a non-negative integer.');
  if (!isNonNegativeInt(updatedAt)) throw new Error('user updatedAt must be a non-negative integer.');
  if (lastActiveAt !== null && !isNonNegativeInt(lastActiveAt)) throw new Error('user lastActiveAt must be null or a non-negative integer.');
  return {
    id: (id as string).trim(),
    displayName: (displayName as string).trim(),
    role: role as FleetRole,
    status: status as FleetV10UserStatus,
    createdBy: (createdBy as string).trim(),
    createdAt: createdAt as number,
    updatedAt: updatedAt as number,
    lastActiveAt: lastActiveAt as number | null,
  };
}

/** Tao mot user moi (khong trung id trong danh sach hien co). */
export function createFleetV10User(
  users: readonly FleetV10User[],
  input: CreateFleetV10UserInput,
  now: number = Date.now(),
): FleetV10User {
  const id = input.id.trim().toLowerCase();
  if (!FLEET_V10_USER_ID_PATTERN.test(id)) {
    throw new Error('user id must match /^[a-z0-9][a-z0-9_-]{0,63}$/ (lowercase, no spaces).');
  }
  if (users.some((u) => u.id === id)) throw new Error(`user already exists: ${id}`);
  if (!isNonEmptyString(input.displayName)) throw new Error('createFleetV10User needs a non-empty displayName.');
  if (!FLEET_ROLES.includes(input.role)) {
    throw new Error(`user role must be one of: ${FLEET_ROLES.join(', ')}.`);
  }
  if (users.length >= FLEET_V10_MAX_USERS) {
    throw new Error(`too many users: ${users.length} >= ${FLEET_V10_MAX_USERS}`);
  }
  return {
    id,
    displayName: input.displayName.trim(),
    role: input.role,
    status: 'active',
    createdBy: (input.createdBy ?? 'system').trim(),
    createdAt: now,
    updatedAt: now,
    lastActiveAt: null,
  };
}

/** Tim user theo id (undefined khi khong co). */
export function findFleetV10User(
  users: readonly FleetV10User[],
  id: string,
): FleetV10User | undefined {
  return users.find((u) => u.id === id);
}

/** Doi vai tro user (chi admin moi goi — kiem tra quyen o lop tren). */
export function setFleetV10UserRole(
  users: readonly FleetV10User[],
  id: string,
  role: FleetRole,
  now: number = Date.now(),
): FleetV10User[] {
  if (!FLEET_ROLES.includes(role)) throw new Error(`user role must be one of: ${FLEET_ROLES.join(', ')}.`);
  const found = users.some((u) => u.id === id);
  if (!found) throw new Error(`user not found: ${id}`);
  return users.map((u) => (u.id === id ? { ...u, role, updatedAt: now } : u));
}

/** Tam dung / mo lai user (user bi tam dung khong chay duoc agent). */
export function setFleetV10UserStatus(
  users: readonly FleetV10User[],
  id: string,
  status: FleetV10UserStatus,
  now: number = Date.now(),
): FleetV10User[] {
  if (!FLEET_V10_USER_STATUSES.includes(status)) {
    throw new Error(`user status must be one of: ${FLEET_V10_USER_STATUSES.join(', ')}.`);
  }
  const found = users.some((u) => u.id === id);
  if (!found) throw new Error(`user not found: ${id}`);
  return users.map((u) => (u.id === id ? { ...u, status, updatedAt: now } : u));
}

/** Xoa user (tra ve danh sach moi; du lieu rieng phai xoa o lop tren). */
export function removeFleetV10User(
  users: readonly FleetV10User[],
  id: string,
): FleetV10User[] {
  const found = users.some((u) => u.id === id);
  if (!found) throw new Error(`user not found: ${id}`);
  return users.filter((u) => u.id !== id);
}

// --- Phan quyen ---------------------------------------------------------------

/**
 * Vai tro co duoc lam hanh dong khong — fail-closed: vai tro hoac
 * hanh dong khong biet deu tra ve false. Khong xet den trang thai
 * suspended o day (xem `isFleetV10UserUsable`).
 */
export function canFleetV10User(role: FleetRole | string, action: FleetV10Action | string): boolean {
  if (!FLEET_ROLES.includes(role as FleetRole)) return false;
  if (!FLEET_V10_ACTIONS.includes(action as FleetV10Action)) return false;
  return FLEET_V10_PERMISSION_MATRIX[role as FleetRole].includes(action as FleetV10Action);
}

/** User co con dung duoc khong (ton tai + active). */
export function isFleetV10UserUsable(
  users: readonly FleetV10User[],
  userId: string,
): { usable: boolean; reason: string } {
  const user = findFleetV10User(users, userId);
  if (!user) return { usable: false, reason: `unknown user: ${userId}` };
  if (user.status !== 'active') return { usable: false, reason: `user ${userId} is ${user.status}` };
  return { usable: true, reason: 'ok' };
}

/**
 * Ai duoc doc audit cua ai: admin doc duoc audit moi user; member /
 * chat-only chi doc audit cua chinh minh. Tra ve false khi khong
 * duoc phep (ke ca khi actor khong ton tai).
 */
export function canFleetV10UserReadAudit(
  users: readonly FleetV10User[],
  actorUserId: string,
  targetUserId: string,
): boolean {
  const actor = findFleetV10User(users, actorUserId);
  if (!actor || actor.status !== 'active') return false;
  if (actor.role === 'admin') return true;
  return actorUserId === targetUserId;
}

/** User co so huu tai nguyen nay khong (admin so huu moi thu). */
export function canFleetV10UserAccessOwned(
  users: readonly FleetV10User[],
  actorUserId: string,
  ownerUserId: string,
): boolean {
  const actor = findFleetV10User(users, actorUserId);
  if (!actor || actor.status !== 'active') return false;
  if (actor.role === 'admin') return true;
  return actorUserId === ownerUserId;
}

// --- Quota ---------------------------------------------------------------------

/** Validate quota user (nem loi khi truong nao hong). */
export function validateFleetV10UserQuota(raw: unknown): FleetV10UserQuota {
  if (!isRecord(raw)) throw new Error('fleet v10 user quota must be an object.');
  const {
    userId, maxAgents, maxConcurrentRuns, maxTriggers, maxSchedules,
    cpuCoresMax, ramBytesMax, diskBytesMax, maxRunsPerDay,
    enabled, updatedAt, updatedBy,
  } = raw;
  if (!isNonEmptyString(userId) || !FLEET_V10_USER_ID_PATTERN.test((userId as string).trim())) {
    throw new Error('quota userId must be a valid user id.');
  }
  for (const [field, value] of [
    ['maxAgents', maxAgents],
    ['maxConcurrentRuns', maxConcurrentRuns],
    ['maxTriggers', maxTriggers],
    ['maxSchedules', maxSchedules],
  ] as const) {
    if (!isNonNegativeInt(value)) throw new Error(`quota ${field} must be a non-negative integer.`);
  }
  for (const [field, value] of [
    ['cpuCoresMax', cpuCoresMax],
    ['ramBytesMax', ramBytesMax],
    ['diskBytesMax', diskBytesMax],
  ] as const) {
    if (!isNonNegativeNumber(value)) throw new Error(`quota ${field} must be a number >= 0.`);
  }
  if (!isNonNegativeInt(maxRunsPerDay)) throw new Error('quota maxRunsPerDay must be a non-negative integer.');
  if (typeof enabled !== 'boolean') throw new Error('quota enabled must be a boolean.');
  if (!isNonNegativeInt(updatedAt)) throw new Error('quota updatedAt must be a non-negative integer.');
  if (!isNonEmptyString(updatedBy)) throw new Error('quota needs a non-empty updatedBy.');
  return {
    userId: (userId as string).trim(),
    maxAgents: maxAgents as number,
    maxConcurrentRuns: maxConcurrentRuns as number,
    maxTriggers: maxTriggers as number,
    maxSchedules: maxSchedules as number,
    cpuCoresMax: cpuCoresMax as number,
    ramBytesMax: ramBytesMax as number,
    diskBytesMax: diskBytesMax as number,
    maxRunsPerDay: maxRunsPerDay as number,
    enabled,
    updatedAt: updatedAt as number,
    updatedBy: (updatedBy as string).trim(),
  };
}

/** Quota mac dinh cho mot user (admin doi sau bang `setFleetV10UserQuota`). */
export function defaultFleetV10UserQuota(
  userId: string,
  updatedBy: string,
  now: number = Date.now(),
): FleetV10UserQuota {
  return { ...DEFAULT_FLEET_V10_USER_QUOTA, userId, updatedAt: now, updatedBy };
}

/** Dat / sua quota cua mot user (tra ve danh sach moi). */
export function setFleetV10UserQuota(
  quotas: readonly FleetV10UserQuota[],
  quota: FleetV10UserQuota,
): FleetV10UserQuota[] {
  const valid = validateFleetV10UserQuota(quota);
  const exists = quotas.some((q) => q.userId === valid.userId);
  return exists
    ? quotas.map((q) => (q.userId === valid.userId ? valid : q))
    : [...quotas, valid];
}

/** Tim quota cua mot user (undefined = chua dat, dung mac dinh). */
export function findFleetV10UserQuota(
  quotas: readonly FleetV10UserQuota[],
  userId: string,
): FleetV10UserQuota | undefined {
  return quotas.find((q) => q.userId === userId);
}

/** Kiem tra muc su dung hien tai co vuot quota khong — ham thuan. */
export function checkFleetV10UserQuota(
  quota: FleetV10UserQuota,
  usage: FleetV10UserUsage,
): FleetV10QuotaCheck {
  const violations: FleetV10QuotaViolation[] = [];
  if (!quota.enabled) return { allowed: true, violations };
  const checks: Array<{ field: keyof FleetV10UserUsage; used: number; limit: number }> = [
    { field: 'agents', used: usage.agents, limit: quota.maxAgents },
    { field: 'concurrentRuns', used: usage.concurrentRuns, limit: quota.maxConcurrentRuns },
    { field: 'triggers', used: usage.triggers, limit: quota.maxTriggers },
    { field: 'schedules', used: usage.schedules, limit: quota.maxSchedules },
    { field: 'cpuCores', used: usage.cpuCores, limit: quota.cpuCoresMax },
    { field: 'ramBytes', used: usage.ramBytes, limit: quota.ramBytesMax },
    { field: 'diskBytes', used: usage.diskBytes, limit: quota.diskBytesMax },
  ];
  for (const c of checks) {
    if (c.used > c.limit) {
      violations.push({
        field: c.field,
        used: c.used,
        limit: c.limit,
        message: `${c.field} ${c.used} exceeds limit ${c.limit}`,
      });
    }
  }
  if (quota.maxRunsPerDay > 0 && usage.runsToday > quota.maxRunsPerDay) {
    violations.push({
      field: 'runsToday',
      used: usage.runsToday,
      limit: quota.maxRunsPerDay,
      message: `runsToday ${usage.runsToday} exceeds limit ${quota.maxRunsPerDay}`,
    });
  }
  return { allowed: violations.length === 0, violations };
}

/**
 * Muc su dung SAU KHI them mot tai nguyen moi co vuot quota khong.
 * Dung truoc khi tao agent/trigger/schedule de tu choi som thay vi
 * tao xong roi moi phat hien vuot.
 */
export function checkFleetV10UserQuotaAfterAdd(
  quota: FleetV10UserQuota,
  usage: FleetV10UserUsage,
  add: Partial<FleetV10UserUsage>,
): FleetV10QuotaCheck {
  const next: FleetV10UserUsage = {
    userId: usage.userId,
    agents: usage.agents + (add.agents ?? 0),
    concurrentRuns: usage.concurrentRuns + (add.concurrentRuns ?? 0),
    triggers: usage.triggers + (add.triggers ?? 0),
    schedules: usage.schedules + (add.schedules ?? 0),
    cpuCores: usage.cpuCores + (add.cpuCores ?? 0),
    ramBytes: usage.ramBytes + (add.ramBytes ?? 0),
    diskBytes: usage.diskBytes + (add.diskBytes ?? 0),
    runsToday: usage.runsToday + (add.runsToday ?? 0),
  };
  return checkFleetV10UserQuota(quota, next);
}

// --- Cach ly du lieu theo user -------------------------------------------------

/** Thu muc rieng cua mot user duoi fleet root. */
export function getFleetV10UserDir(fleetRoot: string, userId: string): string {
  if (!FLEET_V10_USER_ID_PATTERN.test(userId)) throw new Error(`invalid user id: ${userId}`);
  return path.join(fleetRoot, FLEET_V10_USERS_DIR, userId);
}

/** Namespace Vault rieng cua user (ten namespace, khong chua secret). */
export function fleetV10VaultNamespace(userId: string): string {
  if (!FLEET_V10_USER_ID_PATTERN.test(userId)) throw new Error(`invalid user id: ${userId}`);
  return `fleet-user/${userId}`;
}

/**
 * Giai quyet duong dan file trong thu muc cua user — fail-closed.
 * Tu choi duong dan tuyet doi va `..` thoat khoi thu muc user.
 * Tra ve duong dan tuyet doi nam trong thu muc user.
 */
export function resolveFleetV10UserPath(
  fleetRoot: string,
  userId: string,
  relativePath: string,
): string {
  const userDir = getFleetV10UserDir(fleetRoot, userId);
  if (!isNonEmptyString(relativePath)) throw new Error('relative path must be a non-empty string.');
  if (path.isAbsolute(relativePath)) throw new Error(`absolute paths are not allowed: ${relativePath}`);
  const resolved = path.resolve(userDir, relativePath);
  const rel = path.relative(userDir, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path escapes user directory: ${relativePath}`);
  }
  return resolved;
}

/** Kiem tra mot duong dan co nam trong thu muc cua user khong. */
export function isPathInsideFleetV10UserDir(
  fleetRoot: string,
  userId: string,
  filePath: string,
): boolean {
  try {
    const userDir = getFleetV10UserDir(fleetRoot, userId);
    const rel = path.relative(userDir, path.resolve(filePath));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

// --- Audit theo user ------------------------------------------------------------

/** Duong dan file audit cua mot user. */
export function getFleetV10UserAuditPath(fleetRoot: string, userId: string): string {
  return path.join(getFleetV10UserDir(fleetRoot, userId), FLEET_V10_USER_AUDIT_FILE);
}

function hashFleetV10AuditEvent(
  event: Omit<FleetV10UserAuditEvent, 'hash'>,
): string {
  const payload = [
    event.seq,
    event.at,
    event.userId,
    event.actorUserId,
    event.action,
    event.target,
    event.detail,
    event.prevHash,
  ].join('|');
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

/** Doc audit cua mot user (ban ghi hong thi dung lai o do). */
export function readFleetV10UserAudit(
  fleetRoot: string,
  userId: string,
): FleetV10UserAuditEvent[] {
  let text: string;
  try {
    text = fs.readFileSync(getFleetV10UserAuditPath(fleetRoot, userId), 'utf8');
  } catch {
    return [];
  }
  const out: FleetV10UserAuditEvent[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const raw = JSON.parse(trimmed) as unknown;
      if (!isRecord(raw)) break;
      const { seq, at, userId: u, actorUserId, action, target, detail, prevHash, hash } = raw;
      if (
        !isPositiveInt(seq) ||
        !isNonNegativeInt(at) ||
        !isNonEmptyString(u) ||
        !isNonEmptyString(actorUserId) ||
        !isNonEmptyString(action) ||
        !isNonEmptyString(target) ||
        typeof detail !== 'string' ||
        !isNonEmptyString(prevHash) ||
        !isNonEmptyString(hash)
      ) {
        break;
      }
      out.push({
        seq: seq as number,
        at: at as number,
        userId: u as string,
        actorUserId: actorUserId as string,
        action: action as string,
        target: target as string,
        detail: detail as string,
        prevHash: prevHash as string,
        hash: hash as string,
      });
    } catch {
      break;
    }
  }
  return out;
}

/**
 * Ghi them mot su kien audit cho user (noi chuoi hash, append-only).
 * Tra ve su kien da ghi.
 */
export function appendFleetV10UserAudit(
  fleetRoot: string,
  userId: string,
  input: { actorUserId: string; action: string; target: string; detail?: string },
  now: number = Date.now(),
): FleetV10UserAuditEvent {
  if (!isNonEmptyString(input.actorUserId)) throw new Error('audit needs a non-empty actorUserId.');
  if (!isNonEmptyString(input.action)) throw new Error('audit needs a non-empty action.');
  if (!isNonEmptyString(input.target)) throw new Error('audit needs a non-empty target.');
  const prev = readFleetV10UserAudit(fleetRoot, userId);
  const last = prev[prev.length - 1];
  const event: Omit<FleetV10UserAuditEvent, 'hash'> = {
    seq: (last?.seq ?? 0) + 1,
    at: now,
    userId,
    actorUserId: input.actorUserId.trim(),
    action: input.action.trim(),
    target: input.target.trim(),
    detail: (input.detail ?? '').trim(),
    prevHash: last?.hash ?? 'GENESIS',
  };
  const full: FleetV10UserAuditEvent = { ...event, hash: hashFleetV10AuditEvent(event) };
  const filePath = getFleetV10UserAuditPath(fleetRoot, userId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(full)}\n`, { mode: 0o600 });
  return full;
}

/** Kiem tra chuoi hash audit cua user (tra ve loi dau tien neu co). */
export function verifyFleetV10UserAudit(
  fleetRoot: string,
  userId: string,
): { ok: boolean; count: number; error?: string } {
  const events = readFleetV10UserAudit(fleetRoot, userId);
  let prevHash = 'GENESIS';
  for (let i = 0; i < events.length; i++) {
    const e = events[i] as FleetV10UserAuditEvent;
    if (e.seq !== i + 1) return { ok: false, count: events.length, error: `seq gap at line ${i + 1}: expected ${i + 1}, got ${e.seq}` };
    if (e.prevHash !== prevHash) return { ok: false, count: events.length, error: `prevHash mismatch at line ${i + 1}` };
    const { hash, ...rest } = e;
    if (hashFleetV10AuditEvent(rest) !== hash) {
      return { ok: false, count: events.length, error: `hash mismatch at line ${i + 1}` };
    }
    prevHash = hash;
  }
  return { ok: true, count: events.length };
}

// --- Persistence ---------------------------------------------------------------

export function getFleetV10UsersPath(fleetRoot: string): string {
  return path.join(fleetRoot, FLEET_V10_USERS_FILE);
}

export function getFleetV10UserQuotasPath(fleetRoot: string): string {
  return path.join(fleetRoot, FLEET_V10_USER_QUOTAS_FILE);
}

function atomicWriteJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows khong co chmod POSIX — bo qua.
  }
}

function loadJsonArray<T>(filePath: string, validate: (raw: unknown) => T): T[] {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: T[] = [];
  for (const item of parsed) {
    try {
      out.push(validate(item));
    } catch {
      // Ban ghi hong thi bo qua thay vi lam hong ca file.
    }
  }
  return out;
}

/** Doc user tu fleet root (file hong/missing = rong). */
export function loadFleetV10Users(fleetRoot: string): FleetV10User[] {
  return loadJsonArray(getFleetV10UsersPath(fleetRoot), validateFleetV10User);
}

/** Ghi user xuong fleet root (atomic, mode 0600). */
export function saveFleetV10Users(fleetRoot: string, users: readonly FleetV10User[]): void {
  if (users.length > FLEET_V10_MAX_USERS) {
    throw new Error(`too many users: ${users.length} > ${FLEET_V10_MAX_USERS}`);
  }
  atomicWriteJson(getFleetV10UsersPath(fleetRoot), users.map((u) => validateFleetV10User(u)));
}

/** Doc quota user (file hong/missing = rong). */
export function loadFleetV10UserQuotas(fleetRoot: string): FleetV10UserQuota[] {
  return loadJsonArray(getFleetV10UserQuotasPath(fleetRoot), validateFleetV10UserQuota);
}

/** Ghi quota user (atomic, mode 0600). */
export function saveFleetV10UserQuotas(fleetRoot: string, quotas: readonly FleetV10UserQuota[]): void {
  atomicWriteJson(getFleetV10UserQuotasPath(fleetRoot), quotas.map((q) => validateFleetV10UserQuota(q)));
}
