/**
 * Multi-user v3 — quota theo user/role, phân quyền truy cập bot/tool
 * theo user, audit log theo user (v1.17, Đội T6).
 *
 * Tầng trên của multi-user v2 (`fleetV13/multiUserV13.ts` — roles,
 * vault scoping theo user, invite, audit log hash-chained toàn team).
 * V2 trả lời "ai được làm gì, ai thấy key/bot nào"; v3 trả lời "mỗi
 * user được dùng BAO NHIÊU, được chạm vào bot/tool CỤ THỂ nào, và
 * từng user đã làm gì":
 *
 * - Quota: 6 loại quota (`tokens-per-day`, `tool-calls-per-day`,
 *   `bots`, `storage-mb`, `voice-minutes-per-day`,
 *   `concurrent-runs`). Mỗi role có quota mặc định (owner không
 *   giới hạn, admin cao, member vừa, viewer thấp); owner/admin có
 *   thể đặt quota riêng cho từng user (override). Usage đếm theo
 *   cửa sổ ngày (key `YYYY-MM-DD`, múi giờ UTC) — `consumeQuota`
 *   trừ trước khi chạy, vượt quota thì từ chối kèm số còn lại và
 *   thời điểm reset (nửa đêm UTC). Quota `bots` / `storage-mb` là
 *   quota "mức hiện tại" (không theo ngày): caller tự trừ khi tạo /
 *   cộng lại khi xóa.
 * - Phân quyền bot/tool theo user: ngoài ma trận role v2, v3 có
 *   grant từng cặp (user, bot/tool): `allow` / `deny`. Thứ tự quyết
 *   định: deny tường minh thắng mọi thứ (kể cả owner — để khóa một
 *   bot nguy hiểm với một user cụ thể), rồi allow tường minh, rồi
 *   mặc định theo role (viewer chỉ chạy bot, không dùng tool; member
 *   chạy bot + dùng tool; admin/owner mọi thứ). Grant có hạn dùng
 *   (expiresAt, 0 = vĩnh viễn) và ghi rõ người cấp.
 * - Audit theo user: cùng chuỗi hash v2 (SHA-256 nối tiếp) nhưng
 *   mỗi event mang `userId` là chủ thể bị tác động + `actorUserId`
 *   là người thực hiện; `verifyTeamV14UserAuditLog` kiểm tra chuỗi
 *   toàn cục, `filterTeamV14UserAudit` lọc theo user/action/khoảng
 *   thời gian để vẽ "lịch sử của user này". Lưu file
 *   `<teamRoot>/team-audit-user-v117.jsonl` (0600); quota + grant
 *   lưu `<teamRoot>/team-quotas-v117.json` (atomic tmp + rename,
 *   0600).
 *
 * Module này KHÔNG gọi mạng, KHÔNG tự chạy bot/tool, KHÔNG chặn
 * request thật: nó quyết định "còn quota không, được chạm không,
 * đã ghi lại chưa" — việc trừ quota / chặn thật do caller làm ngay
 * sau khi `consumeQuota` / `canUserAccess*` trả về.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TeamV13Role } from '../fleetV13/multiUserV13';
import { TEAM_V13_ROLES } from '../fleetV13/multiUserV13';

/** File lưu quota + grant v3 trong team root. */
export const TEAM_V14_QUOTA_FILE = 'team-quotas-v117.json';
/** File audit log theo user v3 (JSONL, một event một dòng). */
export const TEAM_V14_USER_AUDIT_FILE = 'team-audit-user-v117.jsonl';
/** Phiên bản định dạng state quota v3. */
export const TEAM_V14_QUOTA_VERSION = 1;
/** Số user tối đa có override quota trong một state. */
export const TEAM_V14_MAX_QUOTA_USERS = 500;
/** Số grant tối đa trong một state. */
export const TEAM_V14_MAX_GRANTS = 5000;
/** Số event audit tối đa giữ trong bộ nhớ (file giữ toàn bộ). */
export const TEAM_V14_MAX_AUDIT_EVENTS = 5000;
/** Số ngày usage giữ lại trước khi prune (cửa sổ ngày cũ hơn thì bỏ). */
export const TEAM_V14_USAGE_RETENTION_DAYS = 90;

/** Các loại quota v3. */
export type TeamV14QuotaKind =
  | 'tokens-per-day'
  | 'tool-calls-per-day'
  | 'bots'
  | 'storage-mb'
  | 'voice-minutes-per-day'
  | 'concurrent-runs';

export const TEAM_V14_QUOTA_KINDS: readonly TeamV14QuotaKind[] = [
  'tokens-per-day',
  'tool-calls-per-day',
  'bots',
  'storage-mb',
  'voice-minutes-per-day',
  'concurrent-runs',
];

/** Quota nào tính theo ngày (reset nửa đêm UTC), quota nào là mức hiện tại. */
export const TEAM_V14_DAILY_QUOTA_KINDS: readonly TeamV14QuotaKind[] = [
  'tokens-per-day',
  'tool-calls-per-day',
  'voice-minutes-per-day',
];

export function isTeamV14DailyQuota(kind: TeamV14QuotaKind): boolean {
  return (TEAM_V14_DAILY_QUOTA_KINDS as readonly TeamV14QuotaKind[]).includes(kind);
}

/** Giới hạn quota: -1 = không giới hạn, >= 0 = giới hạn cứng. */
export type TeamV14QuotaLimit = number;

/** Quota mặc định theo role (-1 = không giới hạn). */
export const TEAM_V14_ROLE_QUOTAS: Readonly<Record<TeamV13Role, Readonly<Record<TeamV14QuotaKind, TeamV14QuotaLimit>>>> = {
  owner: {
    'tokens-per-day': -1,
    'tool-calls-per-day': -1,
    bots: -1,
    'storage-mb': -1,
    'voice-minutes-per-day': -1,
    'concurrent-runs': -1,
  },
  admin: {
    'tokens-per-day': 10_000_000,
    'tool-calls-per-day': 100_000,
    bots: 200,
    'storage-mb': 102_400,
    'voice-minutes-per-day': 10_000,
    'concurrent-runs': 20,
  },
  member: {
    'tokens-per-day': 1_000_000,
    'tool-calls-per-day': 10_000,
    bots: 50,
    'storage-mb': 10_240,
    'voice-minutes-per-day': 1_000,
    'concurrent-runs': 5,
  },
  viewer: {
    'tokens-per-day': 100_000,
    'tool-calls-per-day': 1_000,
    bots: 10,
    'storage-mb': 1_024,
    'voice-minutes-per-day': 60,
    'concurrent-runs': 1,
  },
};

/** Một grant truy cập bot/tool cho một user cụ thể. */
export type TeamV14GrantKind = 'bot' | 'tool';

export const TEAM_V14_GRANT_KINDS: readonly TeamV14GrantKind[] = ['bot', 'tool'];

export type TeamV14GrantAccess = 'allow' | 'deny';

export interface TeamV14AccessGrant {
  userId: string;
  kind: TeamV14GrantKind;
  /** Id bot hoặc tên tool, vd `bot-support` / `fleetV13.pinModel`. */
  targetId: string;
  access: TeamV14GrantAccess;
  grantedBy: string;
  grantedAt: number;
  /** Epoch ms hết hạn (0 = không hết hạn). */
  expiresAt: number;
  reason: string;
}

/** Một event audit gắn với một user (chuỗi hash nối tiếp toàn cục). */
export interface TeamV14UserAuditEvent {
  seq: number;
  at: number;
  /** User là chủ thể bị tác động (người bị đổi quota, bị cấp quyền...). */
  userId: string;
  /** Người thực hiện ('' = hệ thống). */
  actorUserId: string;
  actorRole: string;
  action: string;
  target: string;
  detail: string;
  prevHash: string;
  hash: string;
}

/** Usage quota: userId -> dayKey (YYYY-MM-DD) -> kind -> đã dùng. */
export type TeamV14UsageMap = Record<string, Record<string, Partial<Record<TeamV14QuotaKind, number>>>>;

/** Toàn bộ state quota + grant v3 (lưu file, không chứa secret). */
export interface TeamV14QuotaState {
  version: 1;
  teamName: string;
  /** Override quota riêng cho từng user (chỉ những kind khác mặc định). */
  overrides: Record<string, Partial<Record<TeamV14QuotaKind, TeamV14QuotaLimit>>>;
  usage: TeamV14UsageMap;
  grants: TeamV14AccessGrant[];
  auditEvents: TeamV14UserAuditEvent[];
  updatedAt: number;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isValidQuotaLimit(v: unknown): v is TeamV14QuotaLimit {
  return typeof v === 'number' && Number.isFinite(v) && (v === -1 || v >= 0) && Number.isInteger(v);
}

/** Key cửa sổ ngày UTC cho một thời điểm (YYYY-MM-DD). */
export function teamV14DayKey(now = Date.now()): string {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Epoch ms nửa đêm UTC kế tiếp (thời điểm quota ngày reset). */
export function teamV14NextDayResetMs(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0);
}

/** Tạo state quota v3 rỗng. */
export function createTeamV14QuotaState(teamName: string, now = Date.now()): TeamV14QuotaState {
  return {
    version: 1,
    teamName: teamName.trim(),
    overrides: {},
    usage: {},
    grants: [],
    auditEvents: [],
    updatedAt: now,
  };
}

/** Giới hạn quota hiệu lực cho một user: override > mặc định theo role. */
export function teamV14QuotaLimitFor(
  role: TeamV13Role | string | null | undefined,
  kind: TeamV14QuotaKind,
  overrides: Partial<Record<TeamV14QuotaKind, TeamV14QuotaLimit>> = {},
): TeamV14QuotaLimit {
  if (typeof overrides[kind] === 'number' && isValidQuotaLimit(overrides[kind])) {
    return overrides[kind] as TeamV14QuotaLimit;
  }
  if (typeof role === 'string') {
    const roleQuotas = TEAM_V14_ROLE_QUOTAS[role as TeamV13Role];
    if (roleQuotas) return roleQuotas[kind];
  }
  // Fail-closed: role lạ / không có → quota 0 (không được dùng).
  return 0;
}

/** Lượng đã dùng của một user trong cửa sổ ngày (quota ngày) hoặc mức hiện tại. */
export function teamV14UsedAmount(
  state: TeamV14QuotaState,
  userId: string,
  kind: TeamV14QuotaKind,
  now = Date.now(),
): number {
  const perUser = state.usage[userId];
  if (!perUser) return 0;
  if (isTeamV14DailyQuota(kind)) {
    return perUser[teamV14DayKey(now)]?.[kind] ?? 0;
  }
  // Quota mức hiện tại: cộng dồn mọi ngày (caller ghi usage dưới key 'current').
  return perUser.current?.[kind] ?? 0;
}

/** Số còn lại của quota (-1 = không giới hạn, 0 = đã hết). */
export function teamV14QuotaRemaining(
  state: TeamV14QuotaState,
  userId: string,
  role: TeamV13Role | string | null | undefined,
  kind: TeamV14QuotaKind,
  now = Date.now(),
): number {
  const limit = teamV14QuotaLimitFor(role, kind, state.overrides[userId]);
  if (limit === -1) return -1;
  const used = teamV14UsedAmount(state, userId, kind, now);
  return Math.max(0, limit - used);
}

/** True khi user còn đủ quota cho `amount` (hàm thuần). */
export function teamV14HasQuota(
  state: TeamV14QuotaState,
  userId: string,
  role: TeamV13Role | string | null | undefined,
  kind: TeamV14QuotaKind,
  amount: number,
  now = Date.now(),
): boolean {
  if (!isNonEmptyString(userId) || !Number.isFinite(amount) || amount < 0) return false;
  const limit = teamV14QuotaLimitFor(role, kind, state.overrides[userId]);
  if (limit === -1) return true;
  if (amount === 0) return true;
  return teamV14UsedAmount(state, userId, kind, now) + amount <= limit;
}

export interface TeamV14ConsumeResult {
  ok: boolean;
  state: TeamV14QuotaState;
  /** Số còn lại sau khi trừ (-1 = không giới hạn). */
  remaining: number;
  /** Lý do từ chối ('' khi ok). */
  reason: string;
  /** Epoch ms quota ngày reset (chỉ có ý nghĩa với quota ngày). */
  resetAt: number;
}

/**
 * Trừ quota cho một user (trả state MỚI, không mutate state cũ).
 * Vượt quota → ok=false, state không đổi, reason nói rõ còn lại bao nhiêu.
 */
export function consumeTeamV14Quota(
  state: TeamV14QuotaState,
  userId: string,
  role: TeamV13Role | string | null | undefined,
  kind: TeamV14QuotaKind,
  amount: number,
  now = Date.now(),
): TeamV14ConsumeResult {
  const resetAt = isTeamV14DailyQuota(kind) ? teamV14NextDayResetMs(now) : 0;
  if (!isNonEmptyString(userId)) {
    return { ok: false, state, remaining: 0, reason: 'invalid user id', resetAt };
  }
  if (!TEAM_V14_QUOTA_KINDS.includes(kind)) {
    return { ok: false, state, remaining: 0, reason: `unknown quota kind: ${String(kind)}`, resetAt };
  }
  if (!Number.isFinite(amount) || amount < 0 || !Number.isInteger(amount)) {
    return { ok: false, state, remaining: 0, reason: 'amount must be a non-negative integer', resetAt };
  }
  const limit = teamV14QuotaLimitFor(role, kind, state.overrides[userId]);
  if (limit === -1) {
    return { ok: true, state, remaining: -1, reason: '', resetAt };
  }
  if (amount === 0) {
    return { ok: true, state, remaining: limit - teamV14UsedAmount(state, userId, kind, now), reason: '', resetAt };
  }
  const used = teamV14UsedAmount(state, userId, kind, now);
  if (used + amount > limit) {
    return {
      ok: false,
      state,
      remaining: Math.max(0, limit - used),
      reason: `quota exceeded for ${kind}: used ${used}/${limit}, tried +${amount}`,
      resetAt,
    };
  }
  const dayKey = isTeamV14DailyQuota(kind) ? teamV14DayKey(now) : 'current';
  const next: TeamV14QuotaState = {
    ...state,
    usage: {
      ...state.usage,
      [userId]: {
        ...(state.usage[userId] ?? {}),
        [dayKey]: {
          ...((state.usage[userId] ?? {})[dayKey] ?? {}),
          [kind]: used + amount,
        },
      },
    },
    updatedAt: now,
  };
  return { ok: true, state: next, remaining: limit - (used + amount), reason: '', resetAt };
}

/**
 * Trả lại quota mức hiện tại (khi xóa bot / giải phóng storage...).
 * Không bao giờ âm; quota ngày không trả lại (đã dùng là đã dùng).
 */
export function releaseTeamV14Quota(
  state: TeamV14QuotaState,
  userId: string,
  kind: TeamV14QuotaKind,
  amount: number,
  now = Date.now(),
): TeamV14QuotaState {
  if (isTeamV14DailyQuota(kind)) return state;
  if (!Number.isFinite(amount) || amount <= 0) return state;
  const used = teamV14UsedAmount(state, userId, kind, now);
  const nextUsed = Math.max(0, used - amount);
  return {
    ...state,
    usage: {
      ...state.usage,
      [userId]: {
        ...(state.usage[userId] ?? {}),
        current: { ...((state.usage[userId] ?? {}).current ?? {}), [kind]: nextUsed },
      },
    },
    updatedAt: now,
  };
}

export interface TeamV14OverrideResult {
  ok: boolean;
  state: TeamV14QuotaState;
  reason: string;
}

/**
 * Đặt / xóa override quota cho một user. Chỉ owner/admin được đặt
 * (caller kiểm tra quyền bằng `canTeamV13` trước khi gọi — module
 * này chỉ validate giá trị). `limit = null` = xóa override của kind đó.
 */
export function setTeamV14QuotaOverride(
  state: TeamV14QuotaState,
  userId: string,
  kind: TeamV14QuotaKind,
  limit: TeamV14QuotaLimit | null,
  now = Date.now(),
): TeamV14OverrideResult {
  if (!isNonEmptyString(userId)) return { ok: false, state, reason: 'invalid user id' };
  if (!TEAM_V14_QUOTA_KINDS.includes(kind)) return { ok: false, state, reason: `unknown quota kind: ${String(kind)}` };
  if (limit !== null && !isValidQuotaLimit(limit)) {
    return { ok: false, state, reason: 'limit must be -1 (unlimited) or a non-negative integer' };
  }
  const userOverrides = { ...(state.overrides[userId] ?? {}) };
  if (limit === null) delete userOverrides[kind];
  else userOverrides[kind] = limit;
  const overrides = { ...state.overrides };
  if (Object.keys(userOverrides).length === 0) delete overrides[userId];
  else overrides[userId] = userOverrides;
  if (Object.keys(overrides).length > TEAM_V14_MAX_QUOTA_USERS) {
    return { ok: false, state, reason: 'too many users with quota overrides' };
  }
  return { ok: true, state: { ...state, overrides, updatedAt: now }, reason: '' };
}

/** Tóm tắt quota của một user: từng kind — limit / used / remaining / % dùng. */
export interface TeamV14QuotaRow {
  kind: TeamV14QuotaKind;
  limit: TeamV14QuotaLimit;
  used: number;
  remaining: number;
  /** 0..1 (1 = hết; -1 = không giới hạn thì 0). */
  usedFraction: number;
  daily: boolean;
  resetAt: number;
}

export function summarizeTeamV14Quota(
  state: TeamV14QuotaState,
  userId: string,
  role: TeamV13Role | string | null | undefined,
  now = Date.now(),
): TeamV14QuotaRow[] {
  return TEAM_V14_QUOTA_KINDS.map((kind) => {
    const limit = teamV14QuotaLimitFor(role, kind, state.overrides[userId]);
    const used = teamV14UsedAmount(state, userId, kind, now);
    const remaining = limit === -1 ? -1 : Math.max(0, limit - used);
    return {
      kind,
      limit,
      used,
      remaining,
      usedFraction: limit === -1 || limit === 0 ? (limit === 0 && used > 0 ? 1 : 0) : Math.min(1, used / limit),
      daily: isTeamV14DailyQuota(kind),
      resetAt: isTeamV14DailyQuota(kind) ? teamV14NextDayResetMs(now) : 0,
    };
  });
}

/**
 * Xóa usage của những ngày cũ hơn `retentionDays` (giữ file gọn).
 * Key 'current' (quota mức hiện tại) không bao giờ bị prune.
 */
export function pruneTeamV14Usage(
  state: TeamV14QuotaState,
  retentionDays = TEAM_V14_USAGE_RETENTION_DAYS,
  now = Date.now(),
): TeamV14QuotaState {
  const cutoff = teamV14DayKey(now - retentionDays * 24 * 60 * 60 * 1000);
  let changed = false;
  const usage: TeamV14UsageMap = {};
  for (const [userId, perUser] of Object.entries(state.usage)) {
    const kept: Record<string, Partial<Record<TeamV14QuotaKind, number>>> = {};
    for (const [dayKey, kinds] of Object.entries(perUser)) {
      if (dayKey === 'current' || dayKey >= cutoff) kept[dayKey] = kinds;
      else changed = true;
    }
    if (Object.keys(kept).length > 0) usage[userId] = kept;
    else changed = true;
  }
  if (!changed) return state;
  return { ...state, usage, updatedAt: now };
}

// ---------------------------------------------------------------------------
// Phân quyền truy cập bot/tool theo user (grant tường minh)
// ---------------------------------------------------------------------------

/** Mặc định theo role khi không có grant tường minh. */
export function teamV14RoleDefaultAccess(
  role: TeamV13Role | string | null | undefined,
  kind: TeamV14GrantKind,
): boolean {
  if (role === 'owner' || role === 'admin') return true;
  if (role === 'member') return true;
  if (role === 'viewer') return kind === 'bot';
  return false;
}

/** Grant còn hiệu lực không (chưa hết hạn). */
export function isTeamV14GrantActive(grant: TeamV14AccessGrant, now = Date.now()): boolean {
  return grant.expiresAt === 0 || grant.expiresAt > now;
}

/** Tìm grant tường minh cho (user, kind, targetId) — grant mới nhất thắng. */
export function findTeamV14Grant(
  state: TeamV14QuotaState,
  userId: string,
  kind: TeamV14GrantKind,
  targetId: string,
  now = Date.now(),
): TeamV14AccessGrant | null {
  let found: TeamV14AccessGrant | null = null;
  for (const grant of state.grants) {
    if (grant.userId !== userId || grant.kind !== kind || grant.targetId !== targetId) continue;
    if (!isTeamV14GrantActive(grant, now)) continue;
    if (!found || grant.grantedAt >= found.grantedAt) found = grant;
  }
  return found;
}

/**
 * User có được chạm vào bot/tool đó không?
 * Thứ tự: deny tường minh > allow tường minh > mặc định theo role.
 * User không tồn tại trong ngữ cảnh caller (role null) → fail-closed.
 */
export function canUserAccessTeamV14Target(
  state: TeamV14QuotaState,
  userId: string,
  role: TeamV13Role | string | null | undefined,
  kind: TeamV14GrantKind,
  targetId: string,
  now = Date.now(),
): boolean {
  if (!isNonEmptyString(userId) || !isNonEmptyString(targetId)) return false;
  const grant = findTeamV14Grant(state, userId, kind, targetId, now);
  if (grant) return grant.access === 'allow';
  return teamV14RoleDefaultAccess(role, kind);
}

export function canUserAccessTeamV14Bot(
  state: TeamV14QuotaState,
  userId: string,
  role: TeamV13Role | string | null | undefined,
  botId: string,
  now = Date.now(),
): boolean {
  return canUserAccessTeamV14Target(state, userId, role, 'bot', botId, now);
}

export function canUserUseTeamV14Tool(
  state: TeamV14QuotaState,
  userId: string,
  role: TeamV13Role | string | null | undefined,
  toolName: string,
  now = Date.now(),
): boolean {
  return canUserAccessTeamV14Target(state, userId, role, 'tool', toolName, now);
}

/** Liệt kê bot/tool mà user được phép chạm (từ danh sách ứng viên). */
export function listAccessibleTeamV14Targets(
  state: TeamV14QuotaState,
  userId: string,
  role: TeamV13Role | string | null | undefined,
  kind: TeamV14GrantKind,
  candidateIds: readonly string[],
  now = Date.now(),
): string[] {
  return candidateIds.filter((id) => canUserAccessTeamV14Target(state, userId, role, kind, id, now));
}

export interface TeamV14GrantResult {
  ok: boolean;
  state: TeamV14QuotaState;
  reason: string;
}

/**
 * Cấp / thu hồi quyền truy cập (grant mới thay thế grant cũ cùng
 * (user, kind, target) — grant cũ không bị xóa khỏi lịch sử grant,
 * chỉ bị grant mới hơn che đi; `revoke` thêm grant deny vĩnh viễn
 * để khóa hẳn). `ttlMs = 0` = không hết hạn.
 */
export function grantTeamV14Access(
  state: TeamV14QuotaState,
  userId: string,
  kind: TeamV14GrantKind,
  targetId: string,
  access: TeamV14GrantAccess,
  grantedBy: string,
  reason = '',
  ttlMs = 0,
  now = Date.now(),
): TeamV14GrantResult {
  if (!isNonEmptyString(userId) || !isNonEmptyString(targetId) || !isNonEmptyString(grantedBy)) {
    return { ok: false, state, reason: 'userId, targetId and grantedBy are required' };
  }
  if (!TEAM_V14_GRANT_KINDS.includes(kind)) {
    return { ok: false, state, reason: `unknown grant kind: ${String(kind)}` };
  }
  if (state.grants.length >= TEAM_V14_MAX_GRANTS) {
    return { ok: false, state, reason: 'too many grants' };
  }
  const grant: TeamV14AccessGrant = {
    userId,
    kind,
    targetId,
    access,
    grantedBy,
    grantedAt: now,
    expiresAt: ttlMs > 0 ? now + ttlMs : 0,
    reason: reason.trim(),
  };
  return { ok: true, state: { ...state, grants: [...state.grants, grant], updatedAt: now }, reason: '' };
}

export function revokeTeamV14Access(
  state: TeamV14QuotaState,
  userId: string,
  kind: TeamV14GrantKind,
  targetId: string,
  revokedBy: string,
  reason = '',
  now = Date.now(),
): TeamV14GrantResult {
  // Thu hồi = grant deny mới (deny thắng mọi thứ, kể cả mặc định role).
  return grantTeamV14Access(state, userId, kind, targetId, 'deny', revokedBy, reason || 'revoked', 0, now);
}

/** Toàn bộ grant đang hiệu lực của một user (để UI vẽ bảng quyền). */
export function listTeamV14UserGrants(
  state: TeamV14QuotaState,
  userId: string,
  now = Date.now(),
): TeamV14AccessGrant[] {
  return state.grants.filter((g) => g.userId === userId && isTeamV14GrantActive(g, now));
}

// ---------------------------------------------------------------------------
// Audit log theo user (chuỗi hash nối tiếp)
// ---------------------------------------------------------------------------

function hashTeamV14AuditEvent(prevHash: string, event: Omit<TeamV14UserAuditEvent, 'hash' | 'prevHash'>): string {
  const body = JSON.stringify([
    prevHash,
    event.seq,
    event.at,
    event.userId,
    event.actorUserId,
    event.actorRole,
    event.action,
    event.target,
    event.detail,
  ]);
  return crypto.createHash('sha256').update(body).digest('hex');
}

/**
 * Thêm event audit cho một user (trả state MỚI). Chuỗi hash nối
 * tiếp toàn cục — sửa/xóa một dòng làm verify fail tại đúng dòng.
 */
export function appendTeamV14UserAuditEvent(
  state: TeamV14QuotaState,
  input: {
    userId: string;
    actorUserId: string;
    actorRole: string;
    action: string;
    target: string;
    detail: string;
  },
  now = Date.now(),
): TeamV14QuotaState {
  const prev = state.auditEvents[state.auditEvents.length - 1];
  const seq = prev ? prev.seq + 1 : 1;
  const prevHash = prev ? prev.hash : '';
  const base = {
    seq,
    at: now,
    userId: input.userId,
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: input.action,
    target: input.target,
    detail: input.detail,
  };
  const event: TeamV14UserAuditEvent = { ...base, prevHash, hash: hashTeamV14AuditEvent(prevHash, base) };
  const auditEvents = [...state.auditEvents, event];
  const trimmed = auditEvents.length > TEAM_V14_MAX_AUDIT_EVENTS
    ? auditEvents.slice(auditEvents.length - TEAM_V14_MAX_AUDIT_EVENTS)
    : auditEvents;
  return { ...state, auditEvents: trimmed, updatedAt: now };
}

/** Lọc audit theo user / action / khoảng thời gian (mới nhất trước). */
export function filterTeamV14UserAudit(
  state: TeamV14QuotaState,
  filter: { userId?: string; action?: string; fromMs?: number; toMs?: number; limit?: number } = {},
): TeamV14UserAuditEvent[] {
  const out: TeamV14UserAuditEvent[] = [];
  for (let i = state.auditEvents.length - 1; i >= 0; i--) {
    const e = state.auditEvents[i];
    if (filter.userId !== undefined && e.userId !== filter.userId) continue;
    if (filter.action !== undefined && e.action !== filter.action) continue;
    if (filter.fromMs !== undefined && e.at < filter.fromMs) continue;
    if (filter.toMs !== undefined && e.at > filter.toMs) continue;
    out.push(e);
    if (filter.limit !== undefined && out.length >= filter.limit) break;
  }
  return out;
}

export interface TeamV14AuditVerifyResult {
  ok: boolean;
  /** Seq của event đầu tiên hỏng (-1 = không hỏng). */
  badSeq: number;
  reason: string;
}

/** Verify chuỗi hash audit (phát hiện sửa/xóa/đảo dòng). */
export function verifyTeamV14UserAuditLog(events: readonly TeamV14UserAuditEvent[]): TeamV14AuditVerifyResult {
  let prevHash = '';
  let prevSeq = 0;
  for (const e of events) {
    if (e.seq !== prevSeq + 1) {
      return { ok: false, badSeq: e.seq, reason: `sequence gap: expected ${prevSeq + 1}, got ${e.seq}` };
    }
    if (e.prevHash !== prevHash) {
      return { ok: false, badSeq: e.seq, reason: `prevHash mismatch at seq ${e.seq}` };
    }
    const recomputed = hashTeamV14AuditEvent(prevHash, {
      seq: e.seq,
      at: e.at,
      userId: e.userId,
      actorUserId: e.actorUserId,
      actorRole: e.actorRole,
      action: e.action,
      target: e.target,
      detail: e.detail,
    });
    if (recomputed !== e.hash) {
      return { ok: false, badSeq: e.seq, reason: `hash mismatch at seq ${e.seq}` };
    }
    prevHash = e.hash;
    prevSeq = e.seq;
  }
  return { ok: true, badSeq: -1, reason: '' };
}

// ---------------------------------------------------------------------------
// Persistence (file, atomic tmp + rename, 0600)
// ---------------------------------------------------------------------------

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

/** Lưu state quota + grant v3. */
export function saveTeamV14QuotaState(teamRoot: string, state: TeamV14QuotaState): void {
  atomicWriteFile(path.join(teamRoot, TEAM_V14_QUOTA_FILE), JSON.stringify(state, null, 2));
}

/** Đọc state quota v3 (null khi chưa có / file hỏng). */
export function loadTeamV14QuotaState(teamRoot: string): TeamV14QuotaState | null {
  const file = path.join(teamRoot, TEAM_V14_QUOTA_FILE);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as TeamV14QuotaState;
    if (parsed.version !== 1 || typeof parsed.teamName !== 'string') return null;
    if (!parsed.overrides || !parsed.usage || !Array.isArray(parsed.grants) || !Array.isArray(parsed.auditEvents)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Ghi thêm một event audit theo user vào file JSONL (0600). */
export function appendTeamV14UserAuditToFile(teamRoot: string, event: TeamV14UserAuditEvent): void {
  const file = path.join(teamRoot, TEAM_V14_USER_AUDIT_FILE);
  fs.mkdirSync(teamRoot, { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

/** Đọc audit log theo user từ file (dòng hỏng bị bỏ qua). */
export function readTeamV14UserAuditFromFile(teamRoot: string): TeamV14UserAuditEvent[] {
  const file = path.join(teamRoot, TEAM_V14_USER_AUDIT_FILE);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const events: TeamV14UserAuditEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as TeamV14UserAuditEvent;
        if (typeof parsed.seq === 'number' && typeof parsed.hash === 'string') events.push(parsed);
      } catch {
        // Bỏ dòng hỏng, giữ các dòng còn lại.
      }
    }
    return events;
  } catch {
    return [];
  }
}

/** Tóm tắt nhanh một user cho panel: quota đã dùng %, số grant, số audit event. */
export interface TeamV14UserSummary {
  userId: string;
  role: string;
  quotaRows: TeamV14QuotaRow[];
  /** Kind quota đang gần hết nhất (usedFraction cao nhất, -1 = không giới hạn). */
  tightestQuota: TeamV14QuotaKind | '';
  tightestFraction: number;
  activeGrants: number;
  deniedTargets: number;
  auditEventCount: number;
}

export function summarizeTeamV14User(
  state: TeamV14QuotaState,
  userId: string,
  role: TeamV13Role | string | null | undefined,
  now = Date.now(),
): TeamV14UserSummary {
  const quotaRows = summarizeTeamV14Quota(state, userId, role, now);
  let tightestQuota: TeamV14QuotaKind | '' = '';
  let tightestFraction = 0;
  for (const row of quotaRows) {
    if (row.limit !== -1 && row.usedFraction > tightestFraction) {
      tightestFraction = row.usedFraction;
      tightestQuota = row.kind;
    }
  }
  const grants = listTeamV14UserGrants(state, userId, now);
  return {
    userId,
    role: typeof role === 'string' ? role : '',
    quotaRows,
    tightestQuota,
    tightestFraction,
    activeGrants: grants.length,
    deniedTargets: grants.filter((g) => g.access === 'deny').length,
    auditEventCount: state.auditEvents.filter((e) => e.userId === userId).length,
  };
}

/** Re-export vai trò v2 để caller v3 không phải import 2 module. */
export { TEAM_V13_ROLES };
