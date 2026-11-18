/**
 * Multi-user v4 — custom role, quota mở rộng (CPU/RAM/disk/bot),
 * session isolation, user-switch audit (v1.18, Đội T6).
 *
 * Tầng trên của multi-user v3 (`fleetV14/multiUserV14.ts` — quota 6
 * loại theo ngày/mức, grant bot/tool tường minh, audit theo user
 * nối chuỗi hash). V3 trả lời "mỗi user được dùng BAO NHIÊU và chạm
 * vào bot/tool nào"; v4 trả lời 4 câu còn thiếu để chạy multi-user
 * thật trên một máy local-first:
 *
 * - CUSTOM ROLE: ngoài 4 role cứng v2 (owner/admin/member/viewer),
 *   owner/admin được định nghĩa role riêng (vd `support-lead`,
 *   `auditor`) từ một base role + thêm/bớt action. Deny thắng
 *   allow; role custom KHÔNG BAO GIỜ được cấp `change-role` hay
 *   `manage-team-settings` trừ khi base là owner (chống leo thang
 *   quyền qua role tự chế). Role được tham chiếu bằng `custom:<id>`.
 * - QUOTA MỞ RỘNG: thêm 3 loại quota mức hiện tại theo tài nguyên
 *   máy — `cpu-cores` (số core đang chiếm), `ram-mb`, `disk-mb` —
 *   bên cạnh 6 loại v3 (được ủy thác nguyên vẹn cho v3: v4 KHÔNG
 *   re-implement quota ngày). Quota `bots` của v3 vẫn là quota số
 *   bot; v4 bổ sung quota tài nguyên để một user không chiếm hết
 *   máy chạy bot nặng. Consume/release/summarize cho 9 loại.
 * - SESSION ISOLATION: mỗi lần user đăng nhập/đổi user tạo một
 *   session có thư mục làm việc riêng (`users/<userId>/session-
 *   <sessionId>`, sanitize tên) — session của user A không đọc
 *   được dữ liệu session của user B (caller thực thi bằng cách chỉ
 *   mount đúng thư mục đó). Session có hạn dùng, touch gia hạn
 *   hoạt động, revoke một session hoặc toàn bộ session của user.
 * - USER-SWITCH AUDIT: đổi user đang dùng (switch) được ghi vào
 *   đúng chuỗi audit v3 (hash nối tiếp, `action = 'user.switch'`)
 *   để lịch sử "ai đã dùng máy dưới tên ai, khi nào" không thể
 *   sửa lén mà không lộ; danh sách switch gần nhất giữ trong state
 *   v4 để panel vẽ nhanh.
 *
 * Module này KHÔNG gọi mạng, KHÔNG tự chạy bot/tool, KHÔNG mount
 * thư mục thật: nó quyết định "role này được làm gì, còn quota
 * không, session này hợp lệ không, đã ghi lại chưa" — việc trừ
 * quota / chặn thật / mount thư mục do caller làm theo kết quả trả về.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TeamV13Action, TeamV13Role } from '../fleetV13/multiUserV13';
import { TEAM_V13_ACTIONS, TEAM_V13_PERMISSIONS, TEAM_V13_ROLES } from '../fleetV13/multiUserV13';
import type {
  TeamV14QuotaKind,
  TeamV14QuotaLimit,
  TeamV14QuotaState,
} from '../fleetV14/multiUserV14';
import {
  appendTeamV14UserAuditEvent,
  consumeTeamV14Quota,
  createTeamV14QuotaState,
  isTeamV14DailyQuota,
  releaseTeamV14Quota,
  setTeamV14QuotaOverride,
  teamV14DayKey,
  teamV14NextDayResetMs,
  teamV14QuotaLimitFor,
  teamV14UsedAmount,
  TEAM_V14_QUOTA_KINDS,
} from '../fleetV14/multiUserV14';

/** File lưu state multi-user v4 trong team root. */
export const TEAM_V15_STATE_FILE = 'team-v118.json';
/** Phiên bản định dạng state v4. */
export const TEAM_V15_STATE_VERSION = 1;
/** Số custom role tối đa trong một team. */
export const TEAM_V15_MAX_CUSTOM_ROLES = 100;
/** Số session tối đa lưu trong state (session hết hạn/revoke vẫn giữ tới khi prune). */
export const TEAM_V15_MAX_SESSIONS = 5000;
/** Số lần switch user tối đa giữ trong state. */
export const TEAM_V15_MAX_SWITCHES = 1000;
/** Thời gian session mặc định: 8 giờ. */
export const TEAM_V15_DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
/** Session hết hạn quá 30 ngày thì prune khỏi state. */
export const TEAM_V15_SESSION_PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Custom role
// ---------------------------------------------------------------------------

/** Action chỉ owner mới được giữ — custom role không được leo thang lên chúng. */
export const TEAM_V15_OWNER_ONLY_ACTIONS: readonly TeamV13Action[] = [
  'change-role',
  'manage-team-settings',
];

/** Một custom role: base role + thêm/bớt action. */
export interface TeamV15CustomRole {
  id: string;
  name: string;
  description: string;
  baseRole: TeamV13Role;
  extraActions: TeamV13Action[];
  deniedActions: TeamV13Action[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/** Validate một custom role (trả lý do, '' = hợp lệ). */
export function validateTeamV15CustomRole(role: TeamV15CustomRole): string {
  if (!role.id || !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(role.id)) {
    return 'custom role id must be lowercase letters/digits/hyphens, start and end with a letter or digit';
  }
  if (!role.name || !role.name.trim()) return 'custom role name is required';
  if (!(TEAM_V13_ROLES as readonly string[]).includes(role.baseRole)) {
    return `unknown base role: ${String(role.baseRole)}`;
  }
  for (const a of [...role.extraActions, ...role.deniedActions]) {
    if (!(TEAM_V13_ACTIONS as readonly string[]).includes(a)) return `unknown action: ${String(a)}`;
  }
  if (new Set(role.extraActions).size !== role.extraActions.length) return 'extraActions has duplicates';
  if (new Set(role.deniedActions).size !== role.deniedActions.length) return 'deniedActions has duplicates';
  const overlap = role.extraActions.filter((a) => role.deniedActions.includes(a));
  if (overlap.length > 0) return `actions cannot be both extra and denied: ${overlap.join(', ')}`;
  // Chống leo thang: chỉ base owner mới được giữ action owner-only.
  if (role.baseRole !== 'owner') {
    const leaked = role.extraActions.filter((a) =>
      (TEAM_V15_OWNER_ONLY_ACTIONS as readonly string[]).includes(a),
    );
    if (leaked.length > 0) {
      return `only an owner-based custom role may gain owner-only action(s): ${leaked.join(', ')}`;
    }
  }
  return '';
}

/** Tạo một custom role (chưa validate trùng id — caller kiểm tra trong state). */
export function createTeamV15CustomRole(
  input: {
    id: string;
    name: string;
    description?: string;
    baseRole: TeamV13Role;
    extraActions?: TeamV13Action[];
    deniedActions?: TeamV13Action[];
  },
  createdBy: string,
  now = Date.now(),
): TeamV15CustomRole {
  return {
    id: input.id.trim().toLowerCase(),
    name: input.name.trim(),
    description: (input.description ?? '').trim(),
    baseRole: input.baseRole,
    extraActions: [...(input.extraActions ?? [])],
    deniedActions: [...(input.deniedActions ?? [])],
    createdBy,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Action hiệu lực của một custom role: quyền của base role +
 * extra − denied. Deny thắng allow (kể cả khi action đó nằm trong
 * quyền mặc định của base role).
 */
export function effectiveTeamV15CustomRoleActions(role: TeamV15CustomRole): TeamV13Action[] {
  const base = new Set<TeamV13Action>(TEAM_V13_PERMISSIONS[role.baseRole]);
  for (const a of role.extraActions) base.add(a);
  for (const a of role.deniedActions) base.delete(a);
  return TEAM_V13_ACTIONS.filter((a) => base.has(a));
}

/** True khi một custom role được làm một action. */
export function canTeamV15CustomRole(role: TeamV15CustomRole, action: TeamV13Action): boolean {
  return effectiveTeamV15CustomRoleActions(role).includes(action);
}

/** Tham chiếu role: role cứng ('owner'...) hoặc custom ('custom:<id>'). */
export function teamV15RoleRef(role: TeamV15CustomRole): string {
  return `custom:${role.id}`;
}

/** True khi chuỗi là tham chiếu custom role. */
export function isTeamV15CustomRoleRef(ref: string): boolean {
  return ref.startsWith('custom:') && ref.length > 'custom:'.length;
}

/** Tìm custom role theo ref (`custom:<id>`, null khi không phải custom / không có). */
export function findTeamV15CustomRole(
  customRoles: readonly TeamV15CustomRole[],
  ref: string,
): TeamV15CustomRole | null {
  if (!isTeamV15CustomRoleRef(ref)) return null;
  return customRoles.find((r) => r.id === ref.slice('custom:'.length)) ?? null;
}

/**
 * Kiểm tra quyền theo ref: role cứng dùng ma trận v2, custom role
 * dùng action hiệu lực. Ref lạ → fail-closed (không quyền gì).
 */
export function canTeamV15(
  customRoles: readonly TeamV15CustomRole[],
  roleRef: string,
  action: TeamV13Action,
): boolean {
  if ((TEAM_V13_ROLES as readonly string[]).includes(roleRef)) {
    return TEAM_V13_PERMISSIONS[roleRef as TeamV13Role].includes(action);
  }
  const custom = findTeamV15CustomRole(customRoles, roleRef);
  if (!custom) return false;
  return canTeamV15CustomRole(custom, action);
}

/** Liệt kê mọi action hiệu lực của một ref (role cứng hoặc custom). */
export function listTeamV15EffectiveActions(
  customRoles: readonly TeamV15CustomRole[],
  roleRef: string,
): TeamV13Action[] {
  if ((TEAM_V13_ROLES as readonly string[]).includes(roleRef)) {
    return [...TEAM_V13_PERMISSIONS[roleRef as TeamV13Role]];
  }
  const custom = findTeamV15CustomRole(customRoles, roleRef);
  if (!custom) return [];
  return effectiveTeamV15CustomRoleActions(custom);
}

// ---------------------------------------------------------------------------
// Quota mở rộng: CPU / RAM / disk (mức hiện tại) + 6 loại v3
// ---------------------------------------------------------------------------

/** 3 loại quota tài nguyên mới của v4 (mức hiện tại, không theo ngày). */
export type TeamV15ResourceQuotaKind = 'cpu-cores' | 'ram-mb' | 'disk-mb';

export const TEAM_V15_RESOURCE_QUOTA_KINDS: readonly TeamV15ResourceQuotaKind[] = [
  'cpu-cores',
  'ram-mb',
  'disk-mb',
];

/** Mọi loại quota v4 = 6 loại v3 + 3 loại tài nguyên. */
export type TeamV15QuotaKind = TeamV14QuotaKind | TeamV15ResourceQuotaKind;

export const TEAM_V15_QUOTA_KINDS: readonly TeamV15QuotaKind[] = [
  ...TEAM_V14_QUOTA_KINDS,
  ...TEAM_V15_RESOURCE_QUOTA_KINDS,
];

export function isTeamV15ResourceQuota(kind: TeamV15QuotaKind): boolean {
  return (TEAM_V15_RESOURCE_QUOTA_KINDS as readonly string[]).includes(kind);
}

/** Quota mặc định theo role cho 3 loại tài nguyên (-1 = không giới hạn). */
export const TEAM_V15_RESOURCE_ROLE_QUOTAS: Readonly<
  Record<TeamV13Role, Readonly<Record<TeamV15ResourceQuotaKind, TeamV14QuotaLimit>>>
> = {
  owner: { 'cpu-cores': -1, 'ram-mb': -1, 'disk-mb': -1 },
  admin: { 'cpu-cores': 32, 'ram-mb': 131_072, 'disk-mb': 524_288 },
  member: { 'cpu-cores': 8, 'ram-mb': 32_768, 'disk-mb': 102_400 },
  viewer: { 'cpu-cores': 2, 'ram-mb': 8_192, 'disk-mb': 20_480 },
};

/** Giới hạn quota tài nguyên mặc định cho custom role = giới hạn của base role. */
export function teamV15ResourceQuotaLimitForBase(
  baseRole: TeamV13Role | string | null | undefined,
  kind: TeamV15ResourceQuotaKind,
): TeamV14QuotaLimit {
  if (typeof baseRole === 'string') {
    const row = TEAM_V15_RESOURCE_ROLE_QUOTAS[baseRole as TeamV13Role];
    if (row) return row[kind];
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Session isolation
// ---------------------------------------------------------------------------

/** Một session đăng nhập của user (thư mục làm việc riêng). */
export interface TeamV15Session {
  sessionId: string;
  userId: string;
  /** Ref role lúc tạo session (role cứng hoặc `custom:<id>`). */
  roleRef: string;
  deviceLabel: string;
  createdAt: number;
  lastActiveAt: number;
  /** Epoch ms hết hạn (0 = không hết hạn). */
  expiresAt: number;
  revoked: boolean;
  revokeReason: string;
  /** Thư mục làm việc riêng của session (tương đối trong team root). */
  isolatedDir: string;
}

/** Sanitize userId thành một thành phần tên thư mục an toàn (không còn '..' đầu tên). */
export function sanitizeTeamV15UserDir(userId: string): string {
  const clean = userId.trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');
  return clean.length > 0 ? clean : 'unknown-user';
}

/** Thư mục làm việc riêng của một session (tương đối, không chứa '..'). */
export function teamV15SessionDir(userId: string, sessionId: string): string {
  return `users/${sanitizeTeamV15UserDir(userId)}/session-${sessionId}`;
}

/** Session còn hiệu lực không (chưa revoke, chưa hết hạn). */
export function isTeamV15SessionActive(session: TeamV15Session, now = Date.now()): boolean {
  if (session.revoked) return false;
  if (session.expiresAt > 0 && session.expiresAt <= now) return false;
  return true;
}

// ---------------------------------------------------------------------------
// User switch (ghi audit v3)
// ---------------------------------------------------------------------------

/** Một lần đổi user đang dùng (ghi lại để panel/audit vẽ). */
export interface TeamV15UserSwitch {
  at: number;
  fromUserId: string;
  toUserId: string;
  actorUserId: string;
  actorRole: string;
  reason: string;
  /** Seq của event audit v3 tương ứng (để đối chiếu chuỗi hash). */
  auditSeq: number;
}

// ---------------------------------------------------------------------------
// State v4
// ---------------------------------------------------------------------------

/** Toàn bộ state multi-user v4 (lưu file, không chứa secret). */
export interface TeamV15State {
  version: 1;
  teamName: string;
  /** Quota + grant + audit v3 (ủy thác nguyên vẹn). */
  v14: TeamV14QuotaState;
  customRoles: TeamV15CustomRole[];
  /** Override quota tài nguyên riêng từng user. */
  resourceOverrides: Record<string, Partial<Record<TeamV15ResourceQuotaKind, TeamV14QuotaLimit>>>;
  /** Mức tài nguyên đang dùng: userId -> kind -> đã dùng. */
  resourceUsage: Record<string, Partial<Record<TeamV15ResourceQuotaKind, number>>>;
  sessions: TeamV15Session[];
  switches: TeamV15UserSwitch[];
  updatedAt: number;
}

/** Tạo state v4 rỗng. */
export function createTeamV15State(teamName: string, now = Date.now()): TeamV15State {
  return {
    version: 1,
    teamName: teamName.trim(),
    v14: createTeamV14QuotaState(teamName, now),
    customRoles: [],
    resourceOverrides: {},
    resourceUsage: {},
    sessions: [],
    switches: [],
    updatedAt: now,
  };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isValidQuotaLimit(v: unknown): v is TeamV14QuotaLimit {
  return typeof v === 'number' && Number.isFinite(v) && (v === -1 || v >= 0) && Number.isInteger(v);
}

/** Base role của một ref (custom → base của nó; role cứng → chính nó; lạ → null). */
export function teamV15BaseRoleOf(
  customRoles: readonly TeamV15CustomRole[],
  roleRef: string,
): TeamV13Role | null {
  if ((TEAM_V13_ROLES as readonly string[]).includes(roleRef)) return roleRef as TeamV13Role;
  const custom = findTeamV15CustomRole(customRoles, roleRef);
  return custom ? custom.baseRole : null;
}

// ---------------------------------------------------------------------------
// Custom role trong state
// ---------------------------------------------------------------------------

export interface TeamV15CustomRoleResult {
  ok: boolean;
  state: TeamV15State;
  reason: string;
}

/** Thêm một custom role (validate + chống trùng id). */
export function addTeamV15CustomRole(
  state: TeamV15State,
  role: TeamV15CustomRole,
  now = Date.now(),
): TeamV15CustomRoleResult {
  const problem = validateTeamV15CustomRole(role);
  if (problem !== '') return { ok: false, state, reason: problem };
  if (state.customRoles.some((r) => r.id === role.id)) {
    return { ok: false, state, reason: `custom role id already exists: ${role.id}` };
  }
  if (state.customRoles.length >= TEAM_V15_MAX_CUSTOM_ROLES) {
    return { ok: false, state, reason: 'too many custom roles' };
  }
  return { ok: true, state: { ...state, customRoles: [...state.customRoles, role], updatedAt: now }, reason: '' };
}

/** Xóa một custom role (session đang dùng ref đó vẫn giữ ref cũ — caller revoke nếu cần). */
export function removeTeamV15CustomRole(
  state: TeamV15State,
  roleId: string,
  now = Date.now(),
): TeamV15CustomRoleResult {
  if (!state.customRoles.some((r) => r.id === roleId)) {
    return { ok: false, state, reason: `custom role not found: ${roleId}` };
  }
  return {
    ok: true,
    state: { ...state, customRoles: state.customRoles.filter((r) => r.id !== roleId), updatedAt: now },
    reason: '',
  };
}

// ---------------------------------------------------------------------------
// Quota v4: 9 loại (6 v3 + 3 tài nguyên)
// ---------------------------------------------------------------------------

/** Giới hạn quota hiệu lực cho một user (v3 ủy thác, tài nguyên tính riêng). */
export function teamV15QuotaLimitFor(
  state: TeamV15State,
  userId: string,
  roleRef: string,
  kind: TeamV15QuotaKind,
): TeamV14QuotaLimit {
  if (!isTeamV15ResourceQuota(kind)) {
    const base = teamV15BaseRoleOf(state.customRoles, roleRef);
    return teamV14QuotaLimitFor(base, kind as TeamV14QuotaKind, state.v14.overrides[userId]);
  }
  const resourceKind = kind as TeamV15ResourceQuotaKind;
  const override = state.resourceOverrides[userId]?.[resourceKind];
  if (typeof override === 'number' && isValidQuotaLimit(override)) return override;
  return teamV15ResourceQuotaLimitForBase(teamV15BaseRoleOf(state.customRoles, roleRef), resourceKind);
}

/** Lượng tài nguyên đang dùng của một user (quota mức hiện tại). */
export function teamV15ResourceUsed(
  state: TeamV15State,
  userId: string,
  kind: TeamV15ResourceQuotaKind,
): number {
  return state.resourceUsage[userId]?.[kind] ?? 0;
}

/** Lượng đã dùng của một user cho bất kỳ loại quota nào. */
export function teamV15UsedAmount(
  state: TeamV15State,
  userId: string,
  kind: TeamV15QuotaKind,
  now = Date.now(),
): number {
  if (isTeamV15ResourceQuota(kind)) return teamV15ResourceUsed(state, userId, kind as TeamV15ResourceQuotaKind);
  return teamV14UsedAmount(state.v14, userId, kind as TeamV14QuotaKind, now);
}

/** Số còn lại của quota (-1 = không giới hạn). */
export function teamV15QuotaRemaining(
  state: TeamV15State,
  userId: string,
  roleRef: string,
  kind: TeamV15QuotaKind,
  now = Date.now(),
): number {
  const limit = teamV15QuotaLimitFor(state, userId, roleRef, kind);
  if (limit === -1) return -1;
  return Math.max(0, limit - teamV15UsedAmount(state, userId, kind, now));
}

export interface TeamV15ConsumeResult {
  ok: boolean;
  state: TeamV15State;
  remaining: number;
  reason: string;
  resetAt: number;
}

/**
 * Trừ quota cho một user (trả state MỚI). 6 loại v3 ủy thác cho
 * `consumeTeamV14Quota`; 3 loại tài nguyên trừ vào `resourceUsage`
 * (mức hiện tại, không reset theo ngày).
 */
export function consumeTeamV15Quota(
  state: TeamV15State,
  userId: string,
  roleRef: string,
  kind: TeamV15QuotaKind,
  amount: number,
  now = Date.now(),
): TeamV15ConsumeResult {
  if (!isNonEmptyString(userId)) {
    return { ok: false, state, remaining: 0, reason: 'invalid user id', resetAt: 0 };
  }
  if (!TEAM_V15_QUOTA_KINDS.includes(kind)) {
    return { ok: false, state, remaining: 0, reason: `unknown quota kind: ${String(kind)}`, resetAt: 0 };
  }
  if (!Number.isFinite(amount) || amount < 0 || !Number.isInteger(amount)) {
    return { ok: false, state, remaining: 0, reason: 'amount must be a non-negative integer', resetAt: 0 };
  }
  if (!isTeamV15ResourceQuota(kind)) {
    const base = teamV15BaseRoleOf(state.customRoles, roleRef);
    const res = consumeTeamV14Quota(state.v14, userId, base, kind as TeamV14QuotaKind, amount, now);
    if (!res.ok) return { ok: false, state, remaining: res.remaining, reason: res.reason, resetAt: res.resetAt };
    return { ok: true, state: { ...state, v14: res.state, updatedAt: now }, remaining: res.remaining, reason: '', resetAt: res.resetAt };
  }
  const resourceKind = kind as TeamV15ResourceQuotaKind;
  const limit = teamV15QuotaLimitFor(state, userId, roleRef, kind);
  if (limit === -1) return { ok: true, state, remaining: -1, reason: '', resetAt: 0 };
  if (amount === 0) {
    return { ok: true, state, remaining: limit - teamV15ResourceUsed(state, userId, resourceKind), reason: '', resetAt: 0 };
  }
  const used = teamV15ResourceUsed(state, userId, resourceKind);
  if (used + amount > limit) {
    return {
      ok: false,
      state,
      remaining: Math.max(0, limit - used),
      reason: `quota exceeded for ${kind}: used ${used}/${limit}, tried +${amount}`,
      resetAt: 0,
    };
  }
  const next: TeamV15State = {
    ...state,
    resourceUsage: {
      ...state.resourceUsage,
      [userId]: { ...(state.resourceUsage[userId] ?? {}), [resourceKind]: used + amount },
    },
    updatedAt: now,
  };
  return { ok: true, state: next, remaining: limit - (used + amount), reason: '', resetAt: 0 };
}

/**
 * Trả lại quota (mức hiện tại: bots/storage v3 ủy thác, tài nguyên
 * v4 trừ trực tiếp). Không bao giờ âm; quota ngày không trả lại.
 */
export function releaseTeamV15Quota(
  state: TeamV15State,
  userId: string,
  kind: TeamV15QuotaKind,
  amount: number,
  now = Date.now(),
): TeamV15State {
  if (isTeamV15ResourceQuota(kind)) {
    if (!Number.isFinite(amount) || amount <= 0) return state;
    const resourceKind = kind as TeamV15ResourceQuotaKind;
    const used = teamV15ResourceUsed(state, userId, resourceKind);
    return {
      ...state,
      resourceUsage: {
        ...state.resourceUsage,
        [userId]: { ...(state.resourceUsage[userId] ?? {}), [resourceKind]: Math.max(0, used - amount) },
      },
      updatedAt: now,
    };
  }
  if (isTeamV14DailyQuota(kind as TeamV14QuotaKind)) return state;
  return { ...state, v14: releaseTeamV14Quota(state.v14, userId, kind as TeamV14QuotaKind, amount, now), updatedAt: now };
}

export interface TeamV15OverrideResult {
  ok: boolean;
  state: TeamV15State;
  reason: string;
}

/** Đặt / xóa override quota tài nguyên cho một user (owner/admin kiểm tra ở caller). */
export function setTeamV15ResourceQuotaOverride(
  state: TeamV15State,
  userId: string,
  kind: TeamV15ResourceQuotaKind,
  limit: TeamV14QuotaLimit | null,
  now = Date.now(),
): TeamV15OverrideResult {
  if (!isNonEmptyString(userId)) return { ok: false, state, reason: 'invalid user id' };
  if (!TEAM_V15_RESOURCE_QUOTA_KINDS.includes(kind)) {
    return { ok: false, state, reason: `unknown resource quota kind: ${String(kind)}` };
  }
  if (limit !== null && !isValidQuotaLimit(limit)) {
    return { ok: false, state, reason: 'limit must be -1 (unlimited) or a non-negative integer' };
  }
  const userOverrides = { ...(state.resourceOverrides[userId] ?? {}) };
  if (limit === null) delete userOverrides[kind];
  else userOverrides[kind] = limit;
  const overrides = { ...state.resourceOverrides };
  if (Object.keys(userOverrides).length === 0) delete overrides[userId];
  else overrides[userId] = userOverrides;
  return { ok: true, state: { ...state, resourceOverrides: overrides, updatedAt: now }, reason: '' };
}

/** Đặt / xóa override quota v3 (ủy thác; chỉ dùng cho 6 loại v3). */
export function setTeamV15QuotaOverride(
  state: TeamV15State,
  userId: string,
  kind: TeamV14QuotaKind,
  limit: TeamV14QuotaLimit | null,
  now = Date.now(),
): TeamV15OverrideResult {
  const res = setTeamV14QuotaOverride(state.v14, userId, kind, limit, now);
  if (!res.ok) return { ok: false, state, reason: res.reason };
  return { ok: true, state: { ...state, v14: res.state, updatedAt: now }, reason: '' };
}

/** Một dòng tóm tắt quota v4 (9 loại). */
export interface TeamV15QuotaRow {
  kind: TeamV15QuotaKind;
  limit: TeamV14QuotaLimit;
  used: number;
  remaining: number;
  usedFraction: number;
  daily: boolean;
  resetAt: number;
}

/** Tóm tắt quota của một user: cả 9 loại. */
export function summarizeTeamV15Quota(
  state: TeamV15State,
  userId: string,
  roleRef: string,
  now = Date.now(),
): TeamV15QuotaRow[] {
  return TEAM_V15_QUOTA_KINDS.map((kind) => {
    const limit = teamV15QuotaLimitFor(state, userId, roleRef, kind);
    const used = teamV15UsedAmount(state, userId, kind, now);
    const remaining = limit === -1 ? -1 : Math.max(0, limit - used);
    const daily = !isTeamV15ResourceQuota(kind) && isTeamV14DailyQuota(kind as TeamV14QuotaKind);
    return {
      kind,
      limit,
      used,
      remaining,
      usedFraction: limit === -1 || limit === 0 ? (limit === 0 && used > 0 ? 1 : 0) : Math.min(1, used / limit),
      daily,
      resetAt: daily ? teamV14NextDayResetMs(now) : 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Session: tạo / touch / revoke
// ---------------------------------------------------------------------------

export interface TeamV15SessionResult {
  ok: boolean;
  state: TeamV15State;
  session: TeamV15Session | null;
  reason: string;
}

let teamV15SessionCounter = 0;

/** Tạo session mới cho một user (id xác định trong test bằng counter + thời gian). */
export function createTeamV15Session(
  state: TeamV15State,
  userId: string,
  roleRef: string,
  deviceLabel: string,
  ttlMs: number = TEAM_V15_DEFAULT_SESSION_TTL_MS,
  now = Date.now(),
): TeamV15SessionResult {
  if (!isNonEmptyString(userId)) return { ok: false, state, session: null, reason: 'invalid user id' };
  if (teamV15BaseRoleOf(state.customRoles, roleRef) === null) {
    return { ok: false, state, session: null, reason: `unknown role ref: ${roleRef}` };
  }
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    return { ok: false, state, session: null, reason: 'ttlMs must be >= 0' };
  }
  if (state.sessions.length >= TEAM_V15_MAX_SESSIONS) {
    return { ok: false, state, session: null, reason: 'too many sessions' };
  }
  teamV15SessionCounter += 1;
  const sessionId = `s-${now.toString(36)}-${teamV15SessionCounter}`;
  const session: TeamV15Session = {
    sessionId,
    userId,
    roleRef,
    deviceLabel: deviceLabel.trim(),
    createdAt: now,
    lastActiveAt: now,
    expiresAt: ttlMs > 0 ? now + ttlMs : 0,
    revoked: false,
    revokeReason: '',
    isolatedDir: teamV15SessionDir(userId, sessionId),
  };
  return { ok: true, state: { ...state, sessions: [...state.sessions, session], updatedAt: now }, session, reason: '' };
}

/** Cập nhật lastActiveAt của session (gia hạn hoạt động, không đổi expiresAt). */
export function touchTeamV15Session(
  state: TeamV15State,
  sessionId: string,
  now = Date.now(),
): TeamV15State {
  const sessions = state.sessions.map((s) =>
    s.sessionId === sessionId && isTeamV15SessionActive(s, now) ? { ...s, lastActiveAt: now } : s,
  );
  return { ...state, sessions, updatedAt: now };
}

/** Revoke một session (lý do ghi lại; session hết hạn vẫn giữ để audit). */
export function revokeTeamV15Session(
  state: TeamV15State,
  sessionId: string,
  reason: string,
  now = Date.now(),
): TeamV15SessionResult {
  const session = state.sessions.find((s) => s.sessionId === sessionId);
  if (!session) return { ok: false, state, session: null, reason: `session not found: ${sessionId}` };
  if (session.revoked) return { ok: false, state, session, reason: `session already revoked: ${sessionId}` };
  const revoked: TeamV15Session = { ...session, revoked: true, revokeReason: reason.trim() };
  const sessions = state.sessions.map((s) => (s.sessionId === sessionId ? revoked : s));
  return { ok: true, state: { ...state, sessions, updatedAt: now }, session: revoked, reason: '' };
}

/** Revoke toàn bộ session đang active của một user (vd khi đổi role / khóa user). */
export function revokeAllTeamV15UserSessions(
  state: TeamV15State,
  userId: string,
  reason: string,
  now = Date.now(),
): { state: TeamV15State; revokedCount: number } {
  let revokedCount = 0;
  const sessions = state.sessions.map((s) => {
    if (s.userId === userId && isTeamV15SessionActive(s, now)) {
      revokedCount += 1;
      return { ...s, revoked: true, revokeReason: reason.trim() };
    }
    return s;
  });
  return { state: { ...state, sessions, updatedAt: now }, revokedCount };
}

/** Session đang active của một user (mới nhất trước). */
export function listTeamV15ActiveSessions(
  state: TeamV15State,
  userId: string,
  now = Date.now(),
): TeamV15Session[] {
  return state.sessions
    .filter((s) => s.userId === userId && isTeamV15SessionActive(s, now))
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

/** Xóa session đã revoke/hết hạn quá lâu khỏi state (giữ file gọn). */
export function pruneTeamV15Sessions(
  state: TeamV15State,
  now = Date.now(),
): TeamV15State {
  const cutoff = now - TEAM_V15_SESSION_PRUNE_AFTER_MS;
  const kept = state.sessions.filter((s) => {
    if (isTeamV15SessionActive(s, now)) return true;
    const endedAt = s.revoked ? s.lastActiveAt : s.expiresAt;
    return endedAt > cutoff;
  });
  if (kept.length === state.sessions.length) return state;
  return { ...state, sessions: kept, updatedAt: now };
}

// ---------------------------------------------------------------------------
// User switch (ghi audit v3)
// ---------------------------------------------------------------------------

export interface TeamV15SwitchResult {
  ok: boolean;
  state: TeamV15State;
  switchRecord: TeamV15UserSwitch | null;
  reason: string;
}

/**
 * Đổi user đang dùng: ghi event vào chuỗi audit v3 (hash nối tiếp)
 * + lưu bản ghi switch trong state v4. fromUserId == toUserId →
 * từ chối (không có gì để switch).
 */
export function switchTeamV15User(
  state: TeamV15State,
  input: { fromUserId: string; toUserId: string; actorUserId: string; actorRole: string; reason?: string },
  now = Date.now(),
): TeamV15SwitchResult {
  if (!isNonEmptyString(input.fromUserId) || !isNonEmptyString(input.toUserId)) {
    return { ok: false, state, switchRecord: null, reason: 'fromUserId and toUserId are required' };
  }
  if (input.fromUserId === input.toUserId) {
    return { ok: false, state, switchRecord: null, reason: 'cannot switch to the same user' };
  }
  if (!isNonEmptyString(input.actorUserId)) {
    return { ok: false, state, switchRecord: null, reason: 'actorUserId is required' };
  }
  const detail = `switched active user ${input.fromUserId} -> ${input.toUserId}${input.reason ? `: ${input.reason}` : ''}`;
  const nextV14 = appendTeamV14UserAuditEvent(
    state.v14,
    {
      userId: input.toUserId,
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      action: 'user.switch',
      target: `user:${input.fromUserId}`,
      detail,
    },
    now,
  );
  const lastAudit = nextV14.auditEvents[nextV14.auditEvents.length - 1];
  const record: TeamV15UserSwitch = {
    at: now,
    fromUserId: input.fromUserId,
    toUserId: input.toUserId,
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    reason: (input.reason ?? '').trim(),
    auditSeq: lastAudit ? lastAudit.seq : 0,
  };
  const switches = [...state.switches, record];
  const trimmed = switches.length > TEAM_V15_MAX_SWITCHES
    ? switches.slice(switches.length - TEAM_V15_MAX_SWITCHES)
    : switches;
  return {
    ok: true,
    state: { ...state, v14: nextV14, switches: trimmed, updatedAt: now },
    switchRecord: record,
    reason: '',
  };
}

/** Lịch sử switch gần nhất (mới nhất trước, giới hạn `limit`). */
export function listTeamV15Switches(state: TeamV15State, limit = 50): TeamV15UserSwitch[] {
  return [...state.switches].reverse().slice(0, Math.max(0, limit));
}

// ---------------------------------------------------------------------------
// Tóm tắt user + persistence
// ---------------------------------------------------------------------------

/** Tóm tắt nhanh một user v4 cho panel: quota 9 loại + session + switch. */
export interface TeamV15UserSummary {
  userId: string;
  roleRef: string;
  quotaRows: TeamV15QuotaRow[];
  tightestQuota: TeamV15QuotaKind | '';
  tightestFraction: number;
  activeSessions: number;
  totalSessions: number;
  switchCount: number;
  lastSwitchAt: number;
}

export function summarizeTeamV15User(
  state: TeamV15State,
  userId: string,
  roleRef: string,
  now = Date.now(),
): TeamV15UserSummary {
  const quotaRows = summarizeTeamV15Quota(state, userId, roleRef, now);
  let tightestQuota: TeamV15QuotaKind | '' = '';
  let tightestFraction = 0;
  for (const row of quotaRows) {
    if (row.limit !== -1 && row.usedFraction > tightestFraction) {
      tightestFraction = row.usedFraction;
      tightestQuota = row.kind;
    }
  }
  const userSwitches = state.switches.filter((s) => s.toUserId === userId || s.fromUserId === userId);
  return {
    userId,
    roleRef,
    quotaRows,
    tightestQuota,
    tightestFraction,
    activeSessions: listTeamV15ActiveSessions(state, userId, now).length,
    totalSessions: state.sessions.filter((s) => s.userId === userId).length,
    switchCount: userSwitches.length,
    lastSwitchAt: userSwitches.length > 0 ? userSwitches[userSwitches.length - 1].at : 0,
  };
}

function atomicWriteFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows không có chmod unix — bỏ qua.
  }
}

/** Lưu state v4. */
export function saveTeamV15State(teamRoot: string, state: TeamV15State): void {
  atomicWriteFile(path.join(teamRoot, TEAM_V15_STATE_FILE), JSON.stringify(state, null, 2));
}

/** Đọc state v4 (null khi chưa có / file hỏng). */
export function loadTeamV15State(teamRoot: string): TeamV15State | null {
  const file = path.join(teamRoot, TEAM_V15_STATE_FILE);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as TeamV15State;
    if (parsed.version !== 1 || typeof parsed.teamName !== 'string') return null;
    if (!parsed.v14 || !Array.isArray(parsed.customRoles) || !Array.isArray(parsed.sessions)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Re-export để caller v4 không phải import 2 module. */
export { TEAM_V13_ROLES, TEAM_V14_QUOTA_KINDS, teamV14DayKey };
