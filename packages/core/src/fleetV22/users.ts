/**
 * Đa người dùng cho fleet v22 (v1.35, Đội T6).
 *
 * Fleet v21 chỉ có một chủ (host) — mọi bot chạy chung quyền, chung
 * hạn mức. Fleet v22 thêm tầng NGƯỜI DÙNG: nhiều user cùng dùng một
 * fleet, mỗi user có vai trò, hạn mức tài nguyên riêng, bot riêng,
 * máy tính riêng (xem `computers.ts`), và chỉ thấy / chỉ chạm được
 * tài nguyên của mình (trừ admin).
 *
 * Module thuần (không I/O): dữ liệu + tính toán + validate. Host lưu
 * registry xuống disk nếu cần bền vững.
 *
 * Vai trò (mạnh dần):
 * - `viewer`: chỉ xem dashboard/panel của chính mình.
 * - `member`: tạo bot + chạy run trong hạn mức của mình.
 * - `operator`: member + quản lý máy tính (computer) của mình, drain
 *   node của mình, xem log fleet của mình.
 * - `admin`: mọi quyền trên mọi user (quản lý user, quota, node, xem
 *   toàn fleet). Chỉ admin mới tạo/xoá user và đổi vai trò người khác.
 *
 * Hạn mức (quota) tính theo tài nguyên đã CẤP (reserved), không phải
 * tài nguyên đã dùng — một user đặt 10 bot mỗi bot xin 4 core thì đã
 * chiếm 40 core quota dù bot chưa chạy. Như vậy fleet không bao giờ
 * over-commit vì "bot chưa chạy nên chưa tính".
 */

import type { SandboxTierV21 } from '../fleetV21/tiers';

/** Vai trò của user trong fleet v22. */
export type FleetV22UserRole = 'viewer' | 'member' | 'operator' | 'admin';

/** Mọi vai trò theo thứ tự mạnh dần. */
export const FLEET_V22_USER_ROLES: readonly FleetV22UserRole[] = ['viewer', 'member', 'operator', 'admin'];

/** Cấp số của vai trò (để so sánh "vai trò này có mạnh hơn vai trò kia"). */
export const FLEET_V22_ROLE_RANK: Readonly<Record<FleetV22UserRole, number>> = {
  viewer: 0,
  member: 1,
  operator: 2,
  admin: 3,
};

/** Hành động trong fleet — dùng cho kiểm tra quyền (xem `canFleetV22`). */
export type FleetV22Action =
  | 'view-own'
  | 'view-fleet'
  | 'create-bot'
  | 'run-bot'
  | 'manage-own-computers'
  | 'drain-own-node'
  | 'manage-automations'
  | 'manage-users'
  | 'manage-quotas'
  | 'manage-nodes'
  | 'view-audit'
  | 'impersonate';

/** Quyền tối thiểu cho từng hành động (vai trò >= mức này mới được làm). */
export const FLEET_V22_ACTION_MIN_ROLE: Readonly<Record<FleetV22Action, FleetV22UserRole>> = {
  'view-own': 'viewer',
  'view-fleet': 'operator',
  'create-bot': 'member',
  'run-bot': 'member',
  'manage-own-computers': 'operator',
  'drain-own-node': 'operator',
  'manage-automations': 'member',
  'manage-users': 'admin',
  'manage-quotas': 'admin',
  'manage-nodes': 'admin',
  'view-audit': 'operator',
  impersonate: 'admin',
};

/** true khi vai trò `role` đủ mạnh để làm `action`. */
export function roleCanV22(role: FleetV22UserRole, action: FleetV22Action): boolean {
  return FLEET_V22_ROLE_RANK[role] >= FLEET_V22_ROLE_RANK[FLEET_V22_ACTION_MIN_ROLE[action]];
}

/** Hạn mức tài nguyên của một user (đơn vị: core / byte / byte / số đếm). */
export interface FleetV22Quota {
  /** Tối đa CPU đã cấp (core, có thể lẻ). */
  maxCpuCores: number;
  /** Tối đa RAM đã cấp (byte). */
  maxRamBytes: number;
  /** Tối đa disk đã cấp (byte). */
  maxDiskBytes: number;
  /** Tối đa bot cùng lúc. */
  maxBots: number;
  /** Tối đa run cùng lúc. */
  maxConcurrentRuns: number;
  /** Tối đa máy tính (computer) cùng lúc. */
  maxComputers: number;
}

/** Quota mặc định cho member mới (đủ chạy bot nhỏ, không chiếm cả fleet). */
export const DEFAULT_FLEET_V22_QUOTA: FleetV22Quota = {
  maxCpuCores: 8,
  maxRamBytes: 16 * 1024 ** 3,
  maxDiskBytes: 100 * 1024 ** 3,
  maxBots: 5,
  maxConcurrentRuns: 10,
  maxComputers: 3,
};

/** Quota không giới hạn (chỉ admin tự gán cho mình / cho service account). */
export const UNLIMITED_FLEET_V22_QUOTA: FleetV22Quota = {
  maxCpuCores: Number.POSITIVE_INFINITY,
  maxRamBytes: Number.POSITIVE_INFINITY,
  maxDiskBytes: Number.POSITIVE_INFINITY,
  maxBots: Number.POSITIVE_INFINITY,
  maxConcurrentRuns: Number.POSITIVE_INFINITY,
  maxComputers: Number.POSITIVE_INFINITY,
};

/** Tài nguyên một user ĐÃ CẤP (đếm từ bot/computer/run đang giữ chỗ). */
export interface FleetV22Usage {
  cpuCores: number;
  ramBytes: number;
  diskBytes: number;
  bots: number;
  concurrentRuns: number;
  computers: number;
}

/** Usage rỗng (user mới chưa cấp gì). */
export function emptyFleetV22Usage(): FleetV22Usage {
  return { cpuCores: 0, ramBytes: 0, diskBytes: 0, bots: 0, concurrentRuns: 0, computers: 0 };
}

/** Một người dùng của fleet v22. */
export interface FleetV22User {
  /** Id duy nhất, ổn định (không dùng email đổi được). */
  id: string;
  /** Tên hiển thị. */
  displayName: string;
  /** Email (duy nhất trong fleet — để đăng nhập / liên hệ). */
  email: string;
  role: FleetV22UserRole;
  /** User có đang hoạt động không (false = bị khoá, không chạy được gì). */
  active: boolean;
  quota: FleetV22Quota;
  /** Tier cách ly tối đa user được dùng (vd viewer chỉ bwrap). */
  maxTier: SandboxTierV21;
  /** Nhóm/team user thuộc về (để gom báo cáo theo team). */
  team?: string;
  /** Khi user được tạo (epoch ms). */
  createdAt: number;
  /** Lần cuối user hoạt động (epoch ms) — null khi chưa hoạt động. */
  lastActiveAt: number | null;
}

/** Tạo user mới với quota mặc định theo vai trò (admin = không giới hạn). */
export function createFleetV22User(input: {
  id: string;
  displayName: string;
  email: string;
  role?: FleetV22UserRole;
  quota?: Partial<FleetV22Quota>;
  maxTier?: SandboxTierV21;
  team?: string;
  now?: number;
}): FleetV22User {
  const now = input.now ?? Date.now();
  const role = input.role ?? 'member';
  return {
    id: input.id,
    displayName: input.displayName,
    email: input.email,
    role,
    active: true,
    quota: { ...(role === 'admin' ? UNLIMITED_FLEET_V22_QUOTA : DEFAULT_FLEET_V22_QUOTA), ...(input.quota ?? {}) },
    maxTier: input.maxTier ?? 'microvm',
    ...(input.team ? { team: input.team } : {}),
    createdAt: now,
    lastActiveAt: null,
  };
}

// ---------------------------------------------------------------------------
// Quota: còn đủ không? thiếu bao nhiêu?
// ---------------------------------------------------------------------------

/** true khi usage + thêm `extra` vẫn trong quota (Infinity = không giới hạn). */
export function quotaFitsV22(quota: FleetV22Quota, usage: FleetV22Usage, extra: Partial<FleetV22Usage>): boolean {
  const after: FleetV22Usage = {
    cpuCores: usage.cpuCores + (extra.cpuCores ?? 0),
    ramBytes: usage.ramBytes + (extra.ramBytes ?? 0),
    diskBytes: usage.diskBytes + (extra.diskBytes ?? 0),
    bots: usage.bots + (extra.bots ?? 0),
    concurrentRuns: usage.concurrentRuns + (extra.concurrentRuns ?? 0),
    computers: usage.computers + (extra.computers ?? 0),
  };
  return (
    after.cpuCores <= quota.maxCpuCores &&
    after.ramBytes <= quota.maxRamBytes &&
    after.diskBytes <= quota.maxDiskBytes &&
    after.bots <= quota.maxBots &&
    after.concurrentRuns <= quota.maxConcurrentRuns &&
    after.computers <= quota.maxComputers
  );
}

/** Phần quota còn thiếu khi cộng `extra` (0 cho mục đã đủ) — để báo lỗi rõ. */
export function quotaShortfallV22(
  quota: FleetV22Quota,
  usage: FleetV22Usage,
  extra: Partial<FleetV22Usage>,
): Partial<FleetV22Usage> {
  const short: Partial<FleetV22Usage> = {};
  const checks: [keyof FleetV22Usage, keyof FleetV22Quota][] = [
    ['cpuCores', 'maxCpuCores'],
    ['ramBytes', 'maxRamBytes'],
    ['diskBytes', 'maxDiskBytes'],
    ['bots', 'maxBots'],
    ['concurrentRuns', 'maxConcurrentRuns'],
    ['computers', 'maxComputers'],
  ];
  for (const [useKey, quotaKey] of checks) {
    const over = usage[useKey] + (extra[useKey] ?? 0) - quota[quotaKey];
    if (over > 0) short[useKey] = Math.round(over * 100) / 100;
  }
  return short;
}

/** Tỉ lệ dùng quota của từng mục 0..1 (Infinity → 0, "không giới hạn"). */
export function quotaFractionsV22(quota: FleetV22Quota, usage: FleetV22Usage): Record<keyof FleetV22Usage, number> {
  const frac = (used: number, max: number): number => (Number.isFinite(max) && max > 0 ? Math.min(1, used / max) : 0);
  return {
    cpuCores: frac(usage.cpuCores, quota.maxCpuCores),
    ramBytes: frac(usage.ramBytes, quota.maxRamBytes),
    diskBytes: frac(usage.diskBytes, quota.maxDiskBytes),
    bots: frac(usage.bots, quota.maxBots),
    concurrentRuns: frac(usage.concurrentRuns, quota.maxConcurrentRuns),
    computers: frac(usage.computers, quota.maxComputers),
  };
}

/** Mức dùng quota nặng nhất 0..1 — để cảnh báo user sắp hết quota. */
export function quotaMaxFractionV22(quota: FleetV22Quota, usage: FleetV22Usage): number {
  return Math.max(...Object.values(quotaFractionsV22(quota, usage)));
}

/** true khi user sắp hết quota (>= 80% ở bất kỳ mục nào có giới hạn). */
export function quotaIsNearLimitV22(quota: FleetV22Quota, usage: FleetV22Usage): boolean {
  return quotaMaxFractionV22(quota, usage) >= 0.8;
}

// ---------------------------------------------------------------------------
// Kiểm tra quyền: user này có được làm hành động này trên tài nguyên kia?
// ---------------------------------------------------------------------------

/** Kết quả kiểm tra quyền (được/không + lý do). */
export interface FleetV22PermissionCheck {
  allowed: boolean;
  reason?: string;
}

/**
 * Kiểm tra quyền đầy đủ: user phải active + đủ vai trò + (khi chạm tài
 * nguyên của người khác) phải là admin, hoặc tài nguyên đó là của chính
 * mình. `ownerId` undefined = tài nguyên chung của fleet (chỉ admin /
 * operator theo action mới được chạm).
 */
export function canFleetV22(
  user: FleetV22User,
  action: FleetV22Action,
  ownerId?: string,
): FleetV22PermissionCheck {
  if (!user.active) return { allowed: false, reason: `User "${user.id}" đang bị khoá (active=false).` };
  if (!roleCanV22(user.role, action)) {
    return {
      allowed: false,
      reason: `Vai trò "${user.role}" không đủ quyền "${action}" (cần tối thiểu "${FLEET_V22_ACTION_MIN_ROLE[action]}").`,
    };
  }
  if (ownerId !== undefined && ownerId !== user.id && user.role !== 'admin') {
    return { allowed: false, reason: `Tài nguyên thuộc về user "${ownerId}" — chỉ admin mới được chạm.` };
  }
  return { allowed: true };
}

/** true khi user được dùng tier này (tier yêu cầu <= maxTier của user). */
export function userCanUseTierV22(user: FleetV22User, tier: SandboxTierV21): boolean {
  const rank: Record<SandboxTierV21, number> = { bwrap: 0, 'syscall-policy': 1, microvm: 2 };
  return rank[tier] <= rank[user.maxTier];
}

// ---------------------------------------------------------------------------
// Registry user trong bộ nhớ
// ---------------------------------------------------------------------------

/** Registry user trong bộ nhớ — host giữ 1 instance cho cả fleet. */
export class FleetV22UserRegistry {
  private readonly users = new Map<string, FleetV22User>();
  private readonly emails = new Map<string, string>(); // email (lowercase) -> user id

  /** Thêm user (id hoặc email trùng → throw). */
  add(user: FleetV22User): void {
    if (this.users.has(user.id)) throw new Error(`User "${user.id}" đã tồn tại trong fleet v22.`);
    const emailKey = user.email.trim().toLowerCase();
    if (this.emails.has(emailKey)) throw new Error(`Email "${user.email}" đã được dùng bởi user khác.`);
    this.users.set(user.id, structuredClone(user));
    this.emails.set(emailKey, user.id);
  }

  /** Thay thế user đã có (email đổi sang email của người khác → throw). */
  update(user: FleetV22User): void {
    const existing = this.users.get(user.id);
    if (!existing) throw new Error(`User "${user.id}" chưa có trong fleet v22.`);
    const emailKey = user.email.trim().toLowerCase();
    const owner = this.emails.get(emailKey);
    if (owner !== undefined && owner !== user.id) {
      throw new Error(`Email "${user.email}" đã được dùng bởi user khác.`);
    }
    this.emails.delete(existing.email.trim().toLowerCase());
    this.users.set(user.id, structuredClone(user));
    this.emails.set(emailKey, user.id);
  }

  /** Xoá user (không có → false). Không xoá user admin cuối cùng. */
  remove(userId: string): boolean {
    const existing = this.users.get(userId);
    if (!existing) return false;
    if (existing.role === 'admin' && this.list().filter((u) => u.role === 'admin').length <= 1) {
      throw new Error('Không thể xoá admin cuối cùng của fleet v22.');
    }
    this.emails.delete(existing.email.trim().toLowerCase());
    return this.users.delete(userId);
  }

  get(userId: string): FleetV22User | undefined {
    const user = this.users.get(userId);
    return user ? structuredClone(user) : undefined;
  }

  getByEmail(email: string): FleetV22User | undefined {
    const id = this.emails.get(email.trim().toLowerCase());
    return id ? this.get(id) : undefined;
  }

  list(): FleetV22User[] {
    return [...this.users.values()].map((u) => structuredClone(u));
  }

  /** User đang hoạt động. */
  active(): FleetV22User[] {
    return this.list().filter((u) => u.active);
  }

  /** User theo team. */
  byTeam(team: string): FleetV22User[] {
    return this.list().filter((u) => u.team === team);
  }

  /** Đổi vai trò (chỉ admin gọi — host kiểm tra quyền trước khi gọi). */
  setRole(userId: string, role: FleetV22UserRole): FleetV22User {
    const user = this.users.get(userId);
    if (!user) throw new Error(`User "${userId}" chưa có trong fleet v22.`);
    if (user.role === 'admin' && role !== 'admin' && this.list().filter((u) => u.role === 'admin').length <= 1) {
      throw new Error('Không thể hạ cấp admin cuối cùng của fleet v22.');
    }
    const updated: FleetV22User = { ...user, role };
    this.update(updated);
    return structuredClone(updated);
  }

  /** Khoá / mở khoá user. */
  setActive(userId: string, active: boolean): FleetV22User {
    const user = this.users.get(userId);
    if (!user) throw new Error(`User "${userId}" chưa có trong fleet v22.`);
    const updated: FleetV22User = { ...user, active };
    this.update(updated);
    return structuredClone(updated);
  }

  /** Ghi nhận user vừa hoạt động (để dashboard sắp xếp "ai đang dùng"). */
  touch(userId: string, now: number = Date.now()): void {
    const user = this.users.get(userId);
    if (!user) return;
    this.users.set(userId, { ...user, lastActiveAt: now });
  }

  get size(): number {
    return this.users.size;
  }
}

/** Validate user từ dữ liệu ngoài: lỗi → danh sách (rỗng = hợp lệ). */
export function validateFleetV22User(input: unknown): string[] {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null) return ['user phải là object.'];
  const u = input as Record<string, unknown>;
  if (typeof u.id !== 'string' || u.id.trim().length === 0) errors.push('user.id phải là chuỗi không rỗng.');
  if (typeof u.displayName !== 'string' || u.displayName.trim().length === 0) {
    errors.push('user.displayName phải là chuỗi không rỗng.');
  }
  if (typeof u.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u.email)) {
    errors.push('user.email phải là email hợp lệ.');
  }
  if (typeof u.role !== 'string' || !(FLEET_V22_USER_ROLES as readonly string[]).includes(u.role)) {
    errors.push(`user.role phải là một trong: ${FLEET_V22_USER_ROLES.join(', ')}.`);
  }
  const quota = u.quota as Record<string, unknown> | undefined;
  if (quota !== undefined) {
    for (const field of ['maxCpuCores', 'maxRamBytes', 'maxDiskBytes', 'maxBots', 'maxConcurrentRuns', 'maxComputers'] as const) {
      const v = quota[field];
      if (typeof v !== 'number' || !(v >= 0) && v !== Number.POSITIVE_INFINITY) {
        errors.push(`user.quota.${field} phải là số >= 0 hoặc Infinity.`);
      }
    }
  }
  return errors;
}
