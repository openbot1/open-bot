/**
 * Multi-user v6 — RBAC theo resource, user groups, invite flow v2,
 * session management (v1.20, Đội T6).
 *
 * Tầng trên của multi-user v5 (`fleetV16/multiUserV16.ts` — phân
 * quyền theo tính năng, vòng đời user, giới hạn session, nhật ký
 * quản trị). V5 trả lời "user này dùng được TÍNH NĂNG nào"; v6 trả
 * lời 4 câu quản trị còn thiếu để vận hành nhiều user thật:
 *
 * - RBAC THEO RESOURCE: quyền không còn chỉ là "được dùng tính
 *   năng X" mà là "được làm ACTION gì trên RESOURCE nào" —
 *   `bot:bot-1:execute`, `tenant:acme:read`, `fleet-node:*:read`.
 *   Grant có thể gắn vào role mặc định, custom role, group, hoặc
 *   từng user; DENY luôn thắng ALLOW (nhất quán v4/v5). Owner
 *   bypass mọi kiểm tra (trừ khi bị suspend/deactivate — user
 *   không active thì mất mọi quyền). Resource `*` = mọi resource
 *   cùng loại; resourceId `*` = mọi id.
 * - USER GROUPS: nhóm user (vd `dev-team`, `ops`) — grant gắn vào
 *   group, user vào group thì hưởng quyền của group; user thuộc
 *   nhiều group thì hợp nhất (deny ở bất kỳ đâu vẫn thắng). Nhóm
 *   có owner riêng để tự quản lý thành viên (không cần admin).
 * - INVITE FLOW V2: mời bằng email + role + group gán sẵn + hạn
 *   (mặc định 7 ngày, tối đa 30 ngày); token chỉ lưu hash SHA-256
 *   (state không chứa token gốc — như v3/v5); resend cấp token mới
 *   và vô hiệu token cũ; revoke; accept tạo user active; invite
 *   quá hạn → `expired` (không xóa, để audit).
 * - SESSION MANAGEMENT: session có device label, IP hint, idle
 *   timeout theo role, hết hạn tuyệt đối; `touch` cập nhật
 *   lastSeen và phát hiện idle quá hạn; revoke một session /
 *   revoke-all (đăng xuất mọi nơi); prune session hết hạn; giới
 *   hạn session đồng thời theo role (kế thừa v5) + override theo
 *   user; session mới vượt giới hạn → từ chối kèm session cũ nhất
 *   để caller gợi ý "đăng xuất chỗ khác".
 *
 * Module này KHÔNG gọi mạng, KHÔNG tự đăng nhập/đăng xuất thật,
 * KHÔNG gửi email mời thật: nó quyết định "user này được làm gì
 * trên resource nào, lời mời này còn hiệu lực không, session này
 * còn sống không" — việc chặn thật / gửi mail do caller làm theo
 * kết quả trả về.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TeamV13Role } from '../fleetV13/multiUserV13';
import { TEAM_V13_ROLES } from '../fleetV13/multiUserV13';
import { TEAM_V16_ROLE_MAX_SESSIONS } from '../fleetV16/multiUserV16';

/** File lưu state multi-user v6 trong team root. */
export const TEAM_V17_STATE_FILE = 'team-v120.json';
/** Phiên bản định dạng state v6. */
export const TEAM_V17_STATE_VERSION = 1;
/** Số user tối đa trong một team. */
export const TEAM_V17_MAX_USERS = 500;
/** Số group tối đa. */
export const TEAM_V17_MAX_GROUPS = 200;
/** Số thành viên tối đa mỗi group. */
export const TEAM_V17_MAX_GROUP_MEMBERS = 500;
/** Số invite tối đa giữ trong state. */
export const TEAM_V17_MAX_INVITES = 1000;
/** Số session tối đa giữ trong state (kể cả đã revoke/hết hạn). */
export const TEAM_V17_MAX_SESSIONS = 5000;
/** Số entry nhật ký quản trị tối đa. */
export const TEAM_V17_MAX_ADMIN_LOG = 1000;
/** Hạn mời mặc định: 7 ngày. */
export const TEAM_V17_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Hạn mời tối đa: 30 ngày. */
export const TEAM_V17_INVITE_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Độ dài token mời (ký tự hex). */
export const TEAM_V17_INVITE_TOKEN_LENGTH = 32;
/** Idle timeout mặc định theo role (owner lâu hơn vì hay làm việc dài). */
export const TEAM_V17_DEFAULT_IDLE_TIMEOUT_MS: Readonly<Record<TeamV13Role, number>> = {
  owner: 12 * 60 * 60 * 1000,
  admin: 8 * 60 * 60 * 1000,
  member: 4 * 60 * 60 * 1000,
  viewer: 2 * 60 * 60 * 1000,
};
/** Hạn tuyệt đối mặc định của session: 30 ngày. */
export const TEAM_V17_SESSION_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Resource + action
// ---------------------------------------------------------------------------

/** Loại resource có thể phân quyền. */
export type TeamV17ResourceType =
  | 'bot'
  | 'vault-key'
  | 'memory'
  | 'fleet-node'
  | 'tenant'
  | 'rollout'
  | 'tool'
  | 'team';

export const TEAM_V17_RESOURCE_TYPES: readonly TeamV17ResourceType[] = [
  'bot',
  'vault-key',
  'memory',
  'fleet-node',
  'tenant',
  'rollout',
  'tool',
  'team',
];

/** Action có thể làm trên một resource. */
export type TeamV17ResourceAction = 'read' | 'write' | 'delete' | 'execute' | 'manage';

export const TEAM_V17_RESOURCE_ACTIONS: readonly TeamV17ResourceAction[] = [
  'read',
  'write',
  'delete',
  'execute',
  'manage',
];

/** Action nào hợp lệ trên từng loại resource. */
export const TEAM_V17_RESOURCE_ACTION_MATRIX: Readonly<
  Record<TeamV17ResourceType, readonly TeamV17ResourceAction[]>
> = {
  bot: ['read', 'write', 'delete', 'execute', 'manage'],
  'vault-key': ['read', 'write', 'delete', 'manage'],
  memory: ['read', 'write', 'delete'],
  'fleet-node': ['read', 'write', 'delete', 'manage'],
  tenant: ['read', 'write', 'delete', 'manage'],
  rollout: ['read', 'write', 'execute', 'manage'],
  tool: ['read', 'execute', 'manage'],
  team: ['read', 'write', 'manage'],
};

/** Một grant/deny quyền trên resource. `resourceId: '*'` = mọi id. */
export interface TeamV17ResourceGrant {
  resourceType: TeamV17ResourceType;
  resourceId: string;
  action: TeamV17ResourceAction;
}

/** Lỗi validate grant, '' = hợp lệ. */
export function validateTeamV17ResourceGrant(grant: TeamV17ResourceGrant): string {
  if (!TEAM_V17_RESOURCE_TYPES.includes(grant.resourceType)) {
    return `resourceType không hợp lệ: ${grant.resourceType}`;
  }
  if (typeof grant.resourceId !== 'string' || grant.resourceId.length === 0) {
    return 'resourceId không được rỗng';
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._*-]{0,127}$/.test(grant.resourceId)) {
    return 'resourceId phải là slug (chữ/số/./_/-/\\*, tối đa 128 ký tự)';
  }
  const allowed = TEAM_V17_RESOURCE_ACTION_MATRIX[grant.resourceType];
  if (!allowed.includes(grant.action)) {
    return `action ${grant.action} không hợp lệ trên ${grant.resourceType} (chỉ: ${allowed.join(', ')})`;
  }
  return '';
}

/** Hai grant có trùng (cùng type + id + action) không. */
export function teamV17GrantsEqual(a: TeamV17ResourceGrant, b: TeamV17ResourceGrant): boolean {
  return a.resourceType === b.resourceType && a.resourceId === b.resourceId && a.action === b.action;
}

/** Grant có khớp yêu cầu không (id `*` khớp mọi id). */
export function teamV17GrantMatches(
  grant: TeamV17ResourceGrant,
  resourceType: TeamV17ResourceType,
  resourceId: string,
  action: TeamV17ResourceAction,
): boolean {
  if (grant.resourceType !== resourceType) return false;
  if (grant.action !== action && grant.action !== 'manage') return false;
  if (grant.action === 'manage' && action === 'manage') return true;
  // `manage` bao hàm mọi action khác trên cùng resource.
  if (grant.action === 'manage') return grant.resourceId === '*' || grant.resourceId === resourceId;
  return grant.resourceId === '*' || grant.resourceId === resourceId;
}

/**
 * Quyền mặc định theo role cứng: owner làm mọi thứ; admin quản lý
 * gần hết (không `team:*:delete/manage` — chỉ owner đổi team);
 * member đọc + ghi bot/memory/tool của mình, chạy tool/bot;
 * viewer chỉ đọc.
 */
export const TEAM_V17_ROLE_RESOURCE_GRANTS: Readonly<
  Record<TeamV13Role, readonly TeamV17ResourceGrant[]>
> = {
  owner: TEAM_V17_RESOURCE_TYPES.flatMap((t) =>
    TEAM_V17_RESOURCE_ACTION_MATRIX[t].map((a) => ({
      resourceType: t,
      resourceId: '*',
      action: a,
    })),
  ),
  admin: [
    ...(['bot', 'memory', 'rollout', 'tool', 'fleet-node', 'tenant'] as const).flatMap((t) =>
      TEAM_V17_RESOURCE_ACTION_MATRIX[t].map((a) => ({ resourceType: t, resourceId: '*', action: a })),
    ),
    { resourceType: 'vault-key', resourceId: '*', action: 'read' },
    { resourceType: 'vault-key', resourceId: '*', action: 'write' },
    { resourceType: 'team', resourceId: '*', action: 'read' },
    { resourceType: 'team', resourceId: '*', action: 'write' },
  ],
  member: [
    { resourceType: 'bot', resourceId: '*', action: 'read' },
    { resourceType: 'bot', resourceId: '*', action: 'write' },
    { resourceType: 'bot', resourceId: '*', action: 'execute' },
    { resourceType: 'memory', resourceId: '*', action: 'read' },
    { resourceType: 'memory', resourceId: '*', action: 'write' },
    { resourceType: 'tool', resourceId: '*', action: 'read' },
    { resourceType: 'tool', resourceId: '*', action: 'execute' },
    { resourceType: 'rollout', resourceId: '*', action: 'read' },
    { resourceType: 'fleet-node', resourceId: '*', action: 'read' },
    { resourceType: 'tenant', resourceId: '*', action: 'read' },
  ],
  viewer: [
    { resourceType: 'bot', resourceId: '*', action: 'read' },
    { resourceType: 'memory', resourceId: '*', action: 'read' },
    { resourceType: 'tool', resourceId: '*', action: 'read' },
    { resourceType: 'rollout', resourceId: '*', action: 'read' },
    { resourceType: 'fleet-node', resourceId: '*', action: 'read' },
    { resourceType: 'tenant', resourceId: '*', action: 'read' },
  ],
};

// ---------------------------------------------------------------------------
// User v6 + groups
// ---------------------------------------------------------------------------

/** Trạng thái vòng đời của user (kế thừa v5). */
export type TeamV17UserStatus = 'active' | 'invited' | 'suspended' | 'deactivated';

export const TEAM_V17_USER_STATUSES: readonly TeamV17UserStatus[] = [
  'active',
  'invited',
  'suspended',
  'deactivated',
];

/** Một user trong team (v6). */
export interface TeamV17User {
  userId: string;
  displayName: string;
  email: string;
  /** Role cứng hoặc `custom:<id>` (custom role kế thừa grant của base role). */
  roleRef: string;
  status: TeamV17UserStatus;
  createdAt: number;
  lastActiveAt: number | null;
  /** Grant riêng theo resource (cộng thêm ngoài role/group). */
  resourceGrants: TeamV17ResourceGrant[];
  /** Deny riêng theo resource — thắng mọi grant. */
  resourceDenies: TeamV17ResourceGrant[];
  /** Override số session tối đa (null = theo role). */
  maxSessionsOverride: number | null;
  /** Override idle timeout ms (null = theo role). */
  idleTimeoutOverrideMs: number | null;
}

/** Một user group. */
export interface TeamV17Group {
  id: string;
  name: string;
  description: string;
  /** User quản lý group (được thêm/xóa thành viên, sửa grant của group). */
  ownerUserId: string;
  memberUserIds: string[];
  /** Grant của group — thành viên hưởng chung. */
  grants: TeamV17ResourceGrant[];
  /** Deny của group — thắng grant (kể cả grant của role/user). */
  denies: TeamV17ResourceGrant[];
  createdAt: number;
  updatedAt: number;
}

/** Lỗi validate group, '' = hợp lệ. */
export function validateTeamV17Group(input: {
  id?: string;
  name?: string;
  ownerUserId?: string;
}): string {
  if (typeof input.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.id)) {
    return 'id group phải là slug: chữ thường/số/gạch nối, bắt đầu bằng chữ/số';
  }
  if (typeof input.name !== 'string' || input.name.trim().length === 0 || input.name.length > 80) {
    return 'tên group không được rỗng và tối đa 80 ký tự';
  }
  if (typeof input.ownerUserId !== 'string' || input.ownerUserId.length === 0) {
    return 'ownerUserId không được rỗng';
  }
  return '';
}

/** Lỗi validate user mới, '' = hợp lệ. */
export function validateTeamV17UserInput(input: {
  userId?: string;
  displayName?: string;
  email?: string;
  roleRef?: string;
}): string {
  if (typeof input.userId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.userId)) {
    return 'userId phải là slug: chữ thường/số/_/-, bắt đầu bằng chữ/số';
  }
  if (typeof input.displayName !== 'string' || input.displayName.trim().length === 0 || input.displayName.length > 80) {
    return 'displayName không được rỗng và tối đa 80 ký tự';
  }
  if (typeof input.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) {
    return 'email không hợp lệ';
  }
  if (typeof input.roleRef !== 'string' || input.roleRef.length === 0) {
    return 'roleRef không được rỗng';
  }
  return '';
}

// ---------------------------------------------------------------------------
// Invite v2
// ---------------------------------------------------------------------------

/** Trạng thái lời mời v2. */
export type TeamV17InviteStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export const TEAM_V17_INVITE_STATUSES: readonly TeamV17InviteStatus[] = [
  'pending',
  'accepted',
  'revoked',
  'expired',
];

/** Một lời mời (chỉ lưu hash token, không lưu token gốc). */
export interface TeamV17Invite {
  id: string;
  email: string;
  displayName: string;
  roleRef: string;
  /** Group gán sẵn khi accept. */
  groupIds: string[];
  invitedByUserId: string;
  /** SHA-256 hex của token (token gốc chỉ trả về 1 lần lúc tạo/resend). */
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  /** Số lần resend. */
  resendCount: number;
  status: TeamV17InviteStatus;
  acceptedAt: number | null;
  acceptedUserId: string | null;
}

/** Hash token mời (SHA-256 hex). */
export function teamV17HashInviteToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Sinh token mời ngẫu nhiên (hex). */
export function teamV17NewInviteToken(): string {
  return crypto.randomBytes(TEAM_V17_INVITE_TOKEN_LENGTH / 2).toString('hex');
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** Một session đăng nhập. */
export interface TeamV17Session {
  id: string;
  userId: string;
  deviceLabel: string;
  /** Gợi ý IP / nguồn (do caller truyền, có thể rỗng). */
  ipHint: string;
  createdAt: number;
  lastSeenAt: number;
  /** Hết hạn tuyệt đối (null = không hết hạn tuyệt đối). */
  expiresAt: number | null;
  /** Idle timeout áp dụng cho session này (ms). */
  idleTimeoutMs: number;
  revokedAt: number | null;
  revokedReason: string;
}

/** Session còn sống tại `now` không (chưa revoke, chưa hết hạn tuyệt đối, chưa idle quá hạn). */
export function teamV17SessionAlive(session: TeamV17Session, now = Date.now()): boolean {
  if (session.revokedAt !== null) return false;
  if (session.expiresAt !== null && now >= session.expiresAt) return false;
  if (now - session.lastSeenAt >= session.idleTimeoutMs) return false;
  return true;
}

/** Lý do session chết tại `now` ('' = còn sống). */
export function teamV17SessionDeadReason(session: TeamV17Session, now = Date.now()): string {
  if (session.revokedAt !== null) return `revoked: ${session.revokedReason}`;
  if (session.expiresAt !== null && now >= session.expiresAt) return 'expired (absolute)';
  if (now - session.lastSeenAt >= session.idleTimeoutMs) return 'expired (idle timeout)';
  return '';
}

// ---------------------------------------------------------------------------
// State v6
// ---------------------------------------------------------------------------

/** Một entry nhật ký quản trị v6. */
export interface TeamV17AdminLogEntry {
  seq: number;
  at: number;
  actorUserId: string;
  action: string;
  targetUserId: string;
  detail: string;
}

/** State multi-user v6. */
export interface TeamV17State {
  version: number;
  users: TeamV17User[];
  groups: TeamV17Group[];
  invites: TeamV17Invite[];
  sessions: TeamV17Session[];
  adminLog: TeamV17AdminLogEntry[];
  nextAdminSeq: number;
  nextInviteSeq: number;
  nextSessionSeq: number;
  createdAt: number;
  updatedAt: number;
}

export function createTeamV17State(now = Date.now()): TeamV17State {
  return {
    version: TEAM_V17_STATE_VERSION,
    users: [],
    groups: [],
    invites: [],
    sessions: [],
    adminLog: [],
    nextAdminSeq: 1,
    nextInviteSeq: 1,
    nextSessionSeq: 1,
    createdAt: now,
    updatedAt: now,
  };
}

/** Ghi một entry vào nhật ký quản trị (cắt cũ khi quá giới hạn). */
export function recordTeamV17AdminAction(
  state: TeamV17State,
  input: { actorUserId: string; action: string; targetUserId: string; detail?: string },
  now = Date.now(),
): TeamV17State {
  const entry: TeamV17AdminLogEntry = {
    seq: state.nextAdminSeq,
    at: now,
    actorUserId: input.actorUserId,
    action: input.action,
    targetUserId: input.targetUserId,
    detail: input.detail ?? '',
  };
  const adminLog = [...state.adminLog, entry].slice(-TEAM_V17_MAX_ADMIN_LOG);
  return { ...state, adminLog, nextAdminSeq: state.nextAdminSeq + 1, updatedAt: now };
}

export interface TeamV17MutateResult {
  ok: boolean;
  state: TeamV17State;
  error: string;
}

function failTeamV17(state: TeamV17State, error: string): TeamV17MutateResult {
  return { ok: false, state, error };
}

/** Tìm user theo id (null khi không có). */
export function findTeamV17User(state: TeamV17State, userId: string): TeamV17User | null {
  return state.users.find((u) => u.userId === userId) ?? null;
}

/** Tìm group theo id (null khi không có). */
export function findTeamV17Group(state: TeamV17State, groupId: string): TeamV17Group | null {
  return state.groups.find((g) => g.id === groupId) ?? null;
}

/** Số owner đang active (để chặn hạ cấp/vô hiệu owner cuối). */
export function countTeamV17ActiveOwners(state: TeamV17State): number {
  return state.users.filter((u) => u.roleRef === 'owner' && u.status === 'active').length;
}

/** Các group mà user là thành viên. */
export function teamV17GroupsOfUser(state: TeamV17State, userId: string): TeamV17Group[] {
  return state.groups.filter((g) => g.memberUserIds.includes(userId));
}

/** Role cứng từ roleRef (`custom:<id>` → null; caller tự tra custom role của v5/v6). */
export function teamV17BaseRole(roleRef: string): TeamV13Role | null {
  return (TEAM_V13_ROLES as readonly string[]).includes(roleRef) ? (roleRef as TeamV13Role) : null;
}

// ---------------------------------------------------------------------------
// Đánh giá quyền theo resource (deny thắng allow)
// ---------------------------------------------------------------------------

/**
 * Tất cả grant ALLOW hiệu lực của user: role cứng + group + grant
 * riêng. `custom:<id>` không có grant mặc định ở tầng này (caller
 * truyền `customRoleGrants` khi có định nghĩa custom role v6).
 */
export function teamV17AllowGrantsForUser(
  state: TeamV17State,
  user: TeamV17User,
  customRoleGrants: readonly TeamV17ResourceGrant[] = [],
): TeamV17ResourceGrant[] {
  const out: TeamV17ResourceGrant[] = [];
  const base = teamV17BaseRole(user.roleRef);
  if (base) out.push(...TEAM_V17_ROLE_RESOURCE_GRANTS[base]);
  else out.push(...customRoleGrants);
  for (const g of teamV17GroupsOfUser(state, user.userId)) out.push(...g.grants);
  out.push(...user.resourceGrants);
  return out;
}

/** Tất cả grant DENY hiệu lực của user: group deny + deny riêng. */
export function teamV17DenyGrantsForUser(state: TeamV17State, user: TeamV17User): TeamV17ResourceGrant[] {
  const out: TeamV17ResourceGrant[] = [];
  for (const g of teamV17GroupsOfUser(state, user.userId)) out.push(...g.denies);
  out.push(...user.resourceDenies);
  return out;
}

/**
 * User có được làm `action` trên resource không? Thứ tự: user phải
 * tồn tại + active → deny nào khớp → từ chối → allow nào khớp →
 * cho phép → còn lại từ chối (fail-closed). Owner active bypass
 * deny của group/user (deny chỉ áp dụng cho non-owner — owner là
 * người sửa được deny đó).
 */
export function canTeamV17(
  state: TeamV17State,
  userId: string,
  resourceType: TeamV17ResourceType,
  resourceId: string,
  action: TeamV17ResourceAction,
  customRoleGrants: readonly TeamV17ResourceGrant[] = [],
): boolean {
  const user = findTeamV17User(state, userId);
  if (!user || user.status !== 'active') return false;
  if (user.roleRef === 'owner') return true;
  const deny = teamV17DenyGrantsForUser(state, user).some((g) =>
    teamV17GrantMatches(g, resourceType, resourceId, action),
  );
  if (deny) return false;
  return teamV17AllowGrantsForUser(state, user, customRoleGrants).some((g) =>
    teamV17GrantMatches(g, resourceType, resourceId, action),
  );
}

/** Giải thích ngắn gọn vì sao bị từ chối ('' = được phép). */
export function teamV17DenyReason(
  state: TeamV17State,
  userId: string,
  resourceType: TeamV17ResourceType,
  resourceId: string,
  action: TeamV17ResourceAction,
  customRoleGrants: readonly TeamV17ResourceGrant[] = [],
): string {
  const user = findTeamV17User(state, userId);
  if (!user) return `không có user ${userId}`;
  if (user.status !== 'active') return `user ${userId} đang ${user.status}`;
  if (user.roleRef === 'owner') return '';
  if (
    teamV17DenyGrantsForUser(state, user).some((g) =>
      teamV17GrantMatches(g, resourceType, resourceId, action),
    )
  ) {
    return `bị deny tường minh: ${resourceType}:${resourceId}:${action}`;
  }
  const allowed = teamV17AllowGrantsForUser(state, user, customRoleGrants).some((g) =>
    teamV17GrantMatches(g, resourceType, resourceId, action),
  );
  return allowed ? '' : `không có grant: ${resourceType}:${resourceId}:${action}`;
}

// ---------------------------------------------------------------------------
// User: tạo / vòng đời / grant riêng
// ---------------------------------------------------------------------------

/** Tạo user active. User đầu tiên của team phải là owner. */
export function createTeamV17User(
  state: TeamV17State,
  input: { userId: string; displayName: string; email: string; roleRef: string },
  now = Date.now(),
): TeamV17MutateResult {
  const err = validateTeamV17UserInput(input);
  if (err) return failTeamV17(state, err);
  if (findTeamV17User(state, input.userId)) return failTeamV17(state, `userId đã tồn tại: ${input.userId}`);
  if (state.users.some((u) => u.email.toLowerCase() === input.email.toLowerCase())) {
    return failTeamV17(state, `email đã tồn tại: ${input.email}`);
  }
  if (state.users.length === 0 && input.roleRef !== 'owner') {
    return failTeamV17(state, 'user đầu tiên của team phải là owner');
  }
  if (state.users.length >= TEAM_V17_MAX_USERS) return failTeamV17(state, 'team đã đủ số user tối đa');
  const user: TeamV17User = {
    userId: input.userId,
    displayName: input.displayName.trim(),
    email: input.email.trim(),
    roleRef: input.roleRef,
    status: 'active',
    createdAt: now,
    lastActiveAt: null,
    resourceGrants: [],
    resourceDenies: [],
    maxSessionsOverride: null,
    idleTimeoutOverrideMs: null,
  };
  let next = { ...state, users: [...state.users, user] };
  next = recordTeamV17AdminAction(
    next,
    { actorUserId: 'system', action: 'user.create', targetUserId: user.userId, detail: input.roleRef },
    now,
  );
  return { ok: true, state: next, error: '' };
}

/** Đổi role của user (chỉ owner làm; không tự đổi mình; không hạ owner cuối). */
export function changeTeamV17UserRole(
  state: TeamV17State,
  actorUserId: string,
  targetUserId: string,
  newRoleRef: string,
  now = Date.now(),
): TeamV17MutateResult {
  const actor = findTeamV17User(state, actorUserId);
  if (!actor || actor.roleRef !== 'owner' || actor.status !== 'active') {
    return failTeamV17(state, 'chỉ owner active mới được đổi role');
  }
  if (actorUserId === targetUserId) return failTeamV17(state, 'không được tự đổi role của mình');
  const target = findTeamV17User(state, targetUserId);
  if (!target) return failTeamV17(state, `không có user ${targetUserId}`);
  if (target.roleRef === 'owner' && newRoleRef !== 'owner' && countTeamV17ActiveOwners(state) <= 1) {
    return failTeamV17(state, 'không được hạ cấp owner cuối cùng');
  }
  if (typeof newRoleRef !== 'string' || newRoleRef.length === 0) return failTeamV17(state, 'roleRef không được rỗng');
  const users = state.users.map((u) => (u.userId === targetUserId ? { ...u, roleRef: newRoleRef } : u));
  let next = recordTeamV17AdminAction(
    { ...state, users },
    { actorUserId, action: 'user.change-role', targetUserId, detail: `${target.roleRef} -> ${newRoleRef}` },
    now,
  );
  return { ok: true, state: next, error: '' };
}

function setTeamV17UserStatus(
  state: TeamV17State,
  actorUserId: string,
  targetUserId: string,
  status: TeamV17UserStatus,
  action: string,
  now = Date.now(),
): TeamV17MutateResult {
  const actor = findTeamV17User(state, actorUserId);
  if (!actor || (actor.roleRef !== 'owner' && actor.roleRef !== 'admin') || actor.status !== 'active') {
    return failTeamV17(state, 'chỉ owner/admin active mới được đổi trạng thái user');
  }
  if (actorUserId === targetUserId) return failTeamV17(state, 'không được tự đổi trạng thái của mình');
  const target = findTeamV17User(state, targetUserId);
  if (!target) return failTeamV17(state, `không có user ${targetUserId}`);
  if (target.roleRef === 'owner' && status !== 'active' && countTeamV17ActiveOwners(state) <= 1) {
    return failTeamV17(state, 'không được vô hiệu owner cuối cùng');
  }
  if (target.status === status) return failTeamV17(state, `user đã ở trạng thái ${status}`);
  const users = state.users.map((u) => (u.userId === targetUserId ? { ...u, status } : u));
  let next = recordTeamV17AdminAction(
    { ...state, users },
    { actorUserId, action, targetUserId, detail: `${target.status} -> ${status}` },
    now,
  );
  // Vô hiệu/tạm ngưng thì revoke toàn bộ session đang sống của user đó.
  if (status === 'suspended' || status === 'deactivated') {
    const sessions = next.sessions.map((s) =>
      s.userId === targetUserId && s.revokedAt === null
        ? { ...s, revokedAt: now, revokedReason: `user ${status}` }
        : s,
    );
    next = { ...next, sessions };
  }
  return { ok: true, state: next, error: '' };
}

export function suspendTeamV17User(state: TeamV17State, actorUserId: string, targetUserId: string, now = Date.now()): TeamV17MutateResult {
  return setTeamV17UserStatus(state, actorUserId, targetUserId, 'suspended', 'user.suspend', now);
}

export function deactivateTeamV17User(state: TeamV17State, actorUserId: string, targetUserId: string, now = Date.now()): TeamV17MutateResult {
  return setTeamV17UserStatus(state, actorUserId, targetUserId, 'deactivated', 'user.deactivate', now);
}

export function reactivateTeamV17User(state: TeamV17State, actorUserId: string, targetUserId: string, now = Date.now()): TeamV17MutateResult {
  const target = findTeamV17User(state, targetUserId);
  if (!target) return failTeamV17(state, `không có user ${targetUserId}`);
  if (target.status === 'active') return failTeamV17(state, 'user đã active');
  if (target.status === 'invited') return failTeamV17(state, 'user đang invited — hãy accept lời mời thay vì reactivate');
  return setTeamV17UserStatus(state, actorUserId, targetUserId, 'active', 'user.reactivate', now);
}

/** Gán / gỡ grant riêng theo resource cho user (deny thắng grant). */
export function setTeamV17UserResourceAccess(
  state: TeamV17State,
  actorUserId: string,
  targetUserId: string,
  input: { grants?: TeamV17ResourceGrant[]; denies?: TeamV17ResourceGrant[] },
  now = Date.now(),
): TeamV17MutateResult {
  const actor = findTeamV17User(state, actorUserId);
  if (!actor || (actor.roleRef !== 'owner' && actor.roleRef !== 'admin') || actor.status !== 'active') {
    return failTeamV17(state, 'chỉ owner/admin active mới được gán quyền resource');
  }
  const target = findTeamV17User(state, targetUserId);
  if (!target) return failTeamV17(state, `không có user ${targetUserId}`);
  for (const g of [...(input.grants ?? []), ...(input.denies ?? [])]) {
    const err = validateTeamV17ResourceGrant(g);
    if (err) return failTeamV17(state, err);
  }
  // Không cho gán quyền team:manage cho non-owner (chống leo thang).
  const bad = [...(input.grants ?? [])].find(
    (g) => g.resourceType === 'team' && g.action === 'manage' && target.roleRef !== 'owner',
  );
  if (bad) return failTeamV17(state, 'chỉ owner mới được gán quyền team:manage');
  const users = state.users.map((u) =>
    u.userId === targetUserId
      ? {
          ...u,
          resourceGrants: input.grants !== undefined ? [...input.grants] : u.resourceGrants,
          resourceDenies: input.denies !== undefined ? [...input.denies] : u.resourceDenies,
        }
      : u,
  );
  const next = recordTeamV17AdminAction(
    { ...state, users },
    {
      actorUserId,
      action: 'user.set-resource-access',
      targetUserId,
      detail: `grants=${(input.grants ?? target.resourceGrants).length} denies=${(input.denies ?? target.resourceDenies).length}`,
    },
    now,
  );
  return { ok: true, state: next, error: '' };
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export interface TeamV17GroupResult extends TeamV17MutateResult {
  group: TeamV17Group | null;
}

/** Tạo group (owner/admin; owner của group phải là user active). */
export function createTeamV17Group(
  state: TeamV17State,
  actorUserId: string,
  input: { id: string; name: string; description?: string; ownerUserId: string },
  now = Date.now(),
): TeamV17GroupResult {
  const fail = (error: string): TeamV17GroupResult => ({ ok: false, state, error, group: null });
  const actor = findTeamV17User(state, actorUserId);
  if (!actor || (actor.roleRef !== 'owner' && actor.roleRef !== 'admin') || actor.status !== 'active') {
    return fail('chỉ owner/admin active mới được tạo group');
  }
  const err = validateTeamV17Group(input);
  if (err) return fail(err);
  if (findTeamV17Group(state, input.id)) return fail(`group đã tồn tại: ${input.id}`);
  const owner = findTeamV17User(state, input.ownerUserId);
  if (!owner || owner.status !== 'active') return fail(`owner của group phải là user active: ${input.ownerUserId}`);
  if (state.groups.length >= TEAM_V17_MAX_GROUPS) return fail('đã đủ số group tối đa');
  const group: TeamV17Group = {
    id: input.id,
    name: input.name.trim(),
    description: input.description ?? '',
    ownerUserId: input.ownerUserId,
    memberUserIds: [input.ownerUserId],
    grants: [],
    denies: [],
    createdAt: now,
    updatedAt: now,
  };
  let next = recordTeamV17AdminAction(
    { ...state, groups: [...state.groups, group] },
    { actorUserId, action: 'group.create', targetUserId: input.ownerUserId, detail: input.id },
    now,
  );
  return { ok: true, state: next, error: '', group };
}

/**
 * Thêm/xóa thành viên group. Actor phải là owner/admin, hoặc owner
 * của chính group đó. Không được xóa owner của group khỏi group.
 */
export function setTeamV17GroupMembers(
  state: TeamV17State,
  actorUserId: string,
  groupId: string,
  memberUserIds: string[],
  now = Date.now(),
): TeamV17GroupResult {
  const fail = (error: string): TeamV17GroupResult => ({ ok: false, state, error, group: null });
  const group = findTeamV17Group(state, groupId);
  if (!group) return fail(`không có group ${groupId}`);
  const actor = findTeamV17User(state, actorUserId);
  const canManage =
    actor &&
    actor.status === 'active' &&
    (actor.roleRef === 'owner' || actor.roleRef === 'admin' || group.ownerUserId === actorUserId);
  if (!canManage) return fail('chỉ owner/admin hoặc owner của group mới được sửa thành viên');
  const unique = [...new Set(memberUserIds)];
  if (unique.length > TEAM_V17_MAX_GROUP_MEMBERS) return fail('group vượt số thành viên tối đa');
  if (!unique.includes(group.ownerUserId)) return fail('không được xóa owner của group khỏi group');
  for (const id of unique) {
    const u = findTeamV17User(state, id);
    if (!u) return fail(`không có user ${id}`);
    if (u.status !== 'active' && u.status !== 'invited') return fail(`user ${id} đang ${u.status}, không thêm vào group được`);
  }
  const updated: TeamV17Group = { ...group, memberUserIds: unique, updatedAt: now };
  const groups = state.groups.map((g) => (g.id === groupId ? updated : g));
  const next = recordTeamV17AdminAction(
    { ...state, groups },
    { actorUserId, action: 'group.set-members', targetUserId: group.ownerUserId, detail: `${groupId}: ${unique.length} members` },
    now,
  );
  return { ok: true, state: next, error: '', group: updated };
}

/** Gán grant/deny cho group (owner/admin; deny của group thắng grant của role). */
export function setTeamV17GroupAccess(
  state: TeamV17State,
  actorUserId: string,
  groupId: string,
  input: { grants?: TeamV17ResourceGrant[]; denies?: TeamV17ResourceGrant[] },
  now = Date.now(),
): TeamV17GroupResult {
  const fail = (error: string): TeamV17GroupResult => ({ ok: false, state, error, group: null });
  const group = findTeamV17Group(state, groupId);
  if (!group) return fail(`không có group ${groupId}`);
  const actor = findTeamV17User(state, actorUserId);
  if (!actor || (actor.roleRef !== 'owner' && actor.roleRef !== 'admin') || actor.status !== 'active') {
    return fail('chỉ owner/admin active mới được gán quyền cho group');
  }
  for (const g of [...(input.grants ?? []), ...(input.denies ?? [])]) {
    const err = validateTeamV17ResourceGrant(g);
    if (err) return fail(err);
  }
  const updated: TeamV17Group = {
    ...group,
    grants: input.grants !== undefined ? [...input.grants] : group.grants,
    denies: input.denies !== undefined ? [...input.denies] : group.denies,
    updatedAt: now,
  };
  const groups = state.groups.map((g) => (g.id === groupId ? updated : g));
  const next = recordTeamV17AdminAction(
    { ...state, groups },
    { actorUserId, action: 'group.set-access', targetUserId: group.ownerUserId, detail: groupId },
    now,
  );
  return { ok: true, state: next, error: '', group: updated };
}

/** Xóa group (chỉ owner/admin; group rỗng quyền cũng bị xóa theo). */
export function deleteTeamV17Group(state: TeamV17State, actorUserId: string, groupId: string, now = Date.now()): TeamV17MutateResult {
  const actor = findTeamV17User(state, actorUserId);
  if (!actor || (actor.roleRef !== 'owner' && actor.roleRef !== 'admin') || actor.status !== 'active') {
    return failTeamV17(state, 'chỉ owner/admin active mới được xóa group');
  }
  if (!findTeamV17Group(state, groupId)) return failTeamV17(state, `không có group ${groupId}`);
  const next = recordTeamV17AdminAction(
    { ...state, groups: state.groups.filter((g) => g.id !== groupId) },
    { actorUserId, action: 'group.delete', targetUserId: '', detail: groupId },
    now,
  );
  return { ok: true, state: next, error: '' };
}

// ---------------------------------------------------------------------------
// Invite flow v2
// ---------------------------------------------------------------------------

export interface TeamV17InviteResult extends TeamV17MutateResult {
  invite: TeamV17Invite | null;
  /** Token gốc — chỉ trả về lúc tạo/resend, caller phải gửi cho user rồi quên. */
  token: string | null;
}

/** Tạo lời mời mới (owner/admin). Email trùng user active → lỗi. */
export function inviteTeamV17User(
  state: TeamV17State,
  actorUserId: string,
  input: {
    email: string;
    displayName: string;
    roleRef: string;
    groupIds?: string[];
    ttlMs?: number;
  },
  now = Date.now(),
): TeamV17InviteResult {
  const fail = (error: string): TeamV17InviteResult => ({ ok: false, state, error, invite: null, token: null });
  const actor = findTeamV17User(state, actorUserId);
  if (!actor || (actor.roleRef !== 'owner' && actor.roleRef !== 'admin') || actor.status !== 'active') {
    return fail('chỉ owner/admin active mới được mời user');
  }
  if (typeof input.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) {
    return fail('email không hợp lệ');
  }
  if (typeof input.displayName !== 'string' || input.displayName.trim().length === 0 || input.displayName.length > 80) {
    return fail('displayName không được rỗng và tối đa 80 ký tự');
  }
  if (typeof input.roleRef !== 'string' || input.roleRef.length === 0) return fail('roleRef không được rỗng');
  if (input.roleRef === 'owner' && actor.roleRef !== 'owner') {
    return fail('chỉ owner mới được mời owner khác');
  }
  const groupIds = [...new Set(input.groupIds ?? [])];
  for (const gid of groupIds) {
    if (!findTeamV17Group(state, gid)) return fail(`không có group ${gid}`);
  }
  if (state.users.some((u) => u.email.toLowerCase() === input.email.toLowerCase() && u.status === 'active')) {
    return fail(`email đã là user active: ${input.email}`);
  }
  if (state.invites.some((i) => i.email.toLowerCase() === input.email.toLowerCase() && i.status === 'pending' && i.expiresAt > now)) {
    return fail(`đã có lời mời đang chờ cho email này: ${input.email}`);
  }
  const ttlMs = input.ttlMs ?? TEAM_V17_INVITE_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > TEAM_V17_INVITE_MAX_TTL_MS) {
    return fail(`ttlMs phải > 0 và <= ${TEAM_V17_INVITE_MAX_TTL_MS} (30 ngày)`);
  }
  if (state.invites.length >= TEAM_V17_MAX_INVITES) return fail('đã đủ số lời mời tối đa');
  const token = teamV17NewInviteToken();
  const invite: TeamV17Invite = {
    id: `inv-${state.nextInviteSeq}`,
    email: input.email.trim(),
    displayName: input.displayName.trim(),
    roleRef: input.roleRef,
    groupIds,
    invitedByUserId: actorUserId,
    tokenHash: teamV17HashInviteToken(token),
    createdAt: now,
    expiresAt: now + ttlMs,
    resendCount: 0,
    status: 'pending',
    acceptedAt: null,
    acceptedUserId: null,
  };
  let next = recordTeamV17AdminAction(
    { ...state, invites: [...state.invites, invite], nextInviteSeq: state.nextInviteSeq + 1 },
    { actorUserId, action: 'user.invite', targetUserId: '', detail: `${input.email} as ${input.roleRef}` },
    now,
  );
  return { ok: true, state: next, error: '', invite, token };
}

/** Resend lời mời: cấp token mới, vô hiệu token cũ, gia hạn hạn. */
export function resendTeamV17Invite(
  state: TeamV17State,
  actorUserId: string,
  inviteId: string,
  now = Date.now(),
): TeamV17InviteResult {
  const fail = (error: string): TeamV17InviteResult => ({ ok: false, state, error, invite: null, token: null });
  const actor = findTeamV17User(state, actorUserId);
  if (!actor || (actor.roleRef !== 'owner' && actor.roleRef !== 'admin') || actor.status !== 'active') {
    return fail('chỉ owner/admin active mới được resend lời mời');
  }
  const invite = state.invites.find((i) => i.id === inviteId);
  if (!invite) return fail(`không có lời mời ${inviteId}`);
  if (invite.status !== 'pending') return fail(`lời mời đang ${invite.status}, không resend được`);
  const token = teamV17NewInviteToken();
  const updated: TeamV17Invite = {
    ...invite,
    tokenHash: teamV17HashInviteToken(token),
    expiresAt: now + TEAM_V17_INVITE_TTL_MS,
    resendCount: invite.resendCount + 1,
  };
  const invites = state.invites.map((i) => (i.id === inviteId ? updated : i));
  const next = recordTeamV17AdminAction(
    { ...state, invites },
    { actorUserId, action: 'user.invite-resend', targetUserId: '', detail: `${invite.email} (lần ${updated.resendCount})` },
    now,
  );
  return { ok: true, state: next, error: '', invite: updated, token };
}

/** Revoke lời mời đang chờ. */
export function revokeTeamV17Invite(
  state: TeamV17State,
  actorUserId: string,
  inviteId: string,
  now = Date.now(),
): TeamV17InviteResult {
  const fail = (error: string): TeamV17InviteResult => ({ ok: false, state, error, invite: null, token: null });
  const actor = findTeamV17User(state, actorUserId);
  if (!actor || (actor.roleRef !== 'owner' && actor.roleRef !== 'admin') || actor.status !== 'active') {
    return fail('chỉ owner/admin active mới được revoke lời mời');
  }
  const invite = state.invites.find((i) => i.id === inviteId);
  if (!invite) return fail(`không có lời mời ${inviteId}`);
  if (invite.status !== 'pending') return fail(`lời mời đang ${invite.status}, không revoke được`);
  const updated: TeamV17Invite = { ...invite, status: 'revoked' };
  const invites = state.invites.map((i) => (i.id === inviteId ? updated : i));
  const next = recordTeamV17AdminAction(
    { ...state, invites },
    { actorUserId, action: 'user.invite-revoke', targetUserId: '', detail: invite.email },
    now,
  );
  return { ok: true, state: next, error: '', invite: updated, token: null };
}

/** Đánh dấu các invite quá hạn thành `expired` (không xóa). */
export function expireTeamV17Invites(state: TeamV17State, now = Date.now()): TeamV17State {
  let changed = false;
  const invites = state.invites.map((i) => {
    if (i.status === 'pending' && i.expiresAt <= now) {
      changed = true;
      return { ...i, status: 'expired' as TeamV17InviteStatus };
    }
    return i;
  });
  return changed ? { ...state, invites, updatedAt: now } : state;
}

export interface TeamV17AcceptResult extends TeamV17MutateResult {
  user: TeamV17User | null;
}

/**
 * Accept lời mời bằng token. Token sai / hết hạn / đã dùng đều trả
 * cùng một lỗi chung (không lộ invite nào tồn tại). Accept thành
 * công tạo user active + thêm vào các group gán sẵn.
 */
export function acceptTeamV17Invite(
  state: TeamV17State,
  input: { userId: string; token: string },
  now = Date.now(),
): TeamV17AcceptResult {
  const fail = (error: string): TeamV17AcceptResult => ({ ok: false, state, error, user: null });
  const generic = 'lời mời không hợp lệ hoặc đã hết hạn';
  if (typeof input.token !== 'string' || input.token.length === 0) return fail(generic);
  const hash = teamV17HashInviteToken(input.token);
  const invite = state.invites.find((i) => i.tokenHash === hash);
  if (!invite || invite.status !== 'pending') return fail(generic);
  if (invite.expiresAt <= now) {
    const invites = state.invites.map((i) => (i.id === invite.id ? { ...i, status: 'expired' as TeamV17InviteStatus } : i));
    return { ok: false, state: { ...state, invites }, error: generic, user: null };
  }
  const err = validateTeamV17UserInput({
    userId: input.userId,
    displayName: invite.displayName,
    email: invite.email,
    roleRef: invite.roleRef,
  });
  if (err) return fail(err);
  if (findTeamV17User(state, input.userId)) return fail(`userId đã tồn tại: ${input.userId}`);
  if (state.users.length >= TEAM_V17_MAX_USERS) return fail('team đã đủ số user tối đa');
  const user: TeamV17User = {
    userId: input.userId,
    displayName: invite.displayName,
    email: invite.email,
    roleRef: invite.roleRef,
    status: 'active',
    createdAt: now,
    lastActiveAt: now,
    resourceGrants: [],
    resourceDenies: [],
    maxSessionsOverride: null,
    idleTimeoutOverrideMs: null,
  };
  const acceptedInvite: TeamV17Invite = { ...invite, status: 'accepted', acceptedAt: now, acceptedUserId: input.userId };
  let next: TeamV17State = {
    ...state,
    users: [...state.users, user],
    invites: state.invites.map((i) => (i.id === invite.id ? acceptedInvite : i)),
    groups: state.groups.map((g) =>
      invite.groupIds.includes(g.id) && !g.memberUserIds.includes(input.userId)
        ? { ...g, memberUserIds: [...g.memberUserIds, input.userId], updatedAt: now }
        : g,
    ),
  };
  next = recordTeamV17AdminAction(
    next,
    { actorUserId: input.userId, action: 'user.invite-accept', targetUserId: input.userId, detail: invite.email },
    now,
  );
  return { ok: true, state: next, error: '', user };
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

export interface TeamV17SessionResult extends TeamV17MutateResult {
  session: TeamV17Session | null;
  /** Session cũ nhất đang sống (để caller gợi ý revoke khi vượt giới hạn). */
  oldestLiveSession: TeamV17Session | null;
}

/** Số session tối đa của user (override > role; custom role = base role của v5). */
export function teamV17MaxSessionsForUser(state: TeamV17State, user: TeamV17User): number {
  if (user.maxSessionsOverride !== null) return user.maxSessionsOverride;
  const base = teamV17BaseRole(user.roleRef);
  if (base) return TEAM_V16_ROLE_MAX_SESSIONS[base];
  return 3;
}

/** Idle timeout của user (override > role). */
export function teamV17IdleTimeoutForUser(user: TeamV17User): number {
  if (user.idleTimeoutOverrideMs !== null) return user.idleTimeoutOverrideMs;
  const base = teamV17BaseRole(user.roleRef);
  if (base) return TEAM_V17_DEFAULT_IDLE_TIMEOUT_MS[base];
  return TEAM_V17_DEFAULT_IDLE_TIMEOUT_MS.member;
}

/** Tạo session mới (user phải active; vượt giới hạn đồng thời → từ chối). */
export function createTeamV17Session(
  state: TeamV17State,
  input: { userId: string; deviceLabel: string; ipHint?: string; absoluteTtlMs?: number },
  now = Date.now(),
): TeamV17SessionResult {
  const fail = (error: string, oldest: TeamV17Session | null = null): TeamV17SessionResult => ({
    ok: false,
    state,
    error,
    session: null,
    oldestLiveSession: oldest,
  });
  const user = findTeamV17User(state, input.userId);
  if (!user) return fail(`không có user ${input.userId}`);
  if (user.status !== 'active') return fail(`user ${input.userId} đang ${user.status}, không tạo session được`);
  if (typeof input.deviceLabel !== 'string' || input.deviceLabel.trim().length === 0 || input.deviceLabel.length > 80) {
    return fail('deviceLabel không được rỗng và tối đa 80 ký tự');
  }
  const live = state.sessions
    .filter((s) => s.userId === input.userId && teamV17SessionAlive(s, now))
    .sort((a, b) => a.createdAt - b.createdAt);
  const max = teamV17MaxSessionsForUser(state, user);
  if (live.length >= max) {
    return fail(
      `user ${input.userId} đã đủ ${max} session đồng thời — hãy revoke session cũ nhất trước`,
      live[0] ?? null,
    );
  }
  if (state.sessions.length >= TEAM_V17_MAX_SESSIONS) return fail('đã đủ số session tối đa trong state');
  const ttlMs = input.absoluteTtlMs ?? TEAM_V17_SESSION_ABSOLUTE_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return fail('absoluteTtlMs phải > 0');
  const session: TeamV17Session = {
    id: `sess-${state.nextSessionSeq}`,
    userId: input.userId,
    deviceLabel: input.deviceLabel.trim(),
    ipHint: input.ipHint ?? '',
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + ttlMs,
    idleTimeoutMs: teamV17IdleTimeoutForUser(user),
    revokedAt: null,
    revokedReason: '',
  };
  const next: TeamV17State = {
    ...state,
    sessions: [...state.sessions, session],
    nextSessionSeq: state.nextSessionSeq + 1,
    users: state.users.map((u) => (u.userId === input.userId ? { ...u, lastActiveAt: now } : u)),
    updatedAt: now,
  };
  return { ok: true, state: next, error: '', session, oldestLiveSession: null };
}

/** Touch session: cập nhật lastSeen; session chết → trả lý do. */
export function touchTeamV17Session(
  state: TeamV17State,
  sessionId: string,
  now = Date.now(),
): TeamV17SessionResult {
  const fail = (error: string): TeamV17SessionResult => ({ ok: false, state, error, session: null, oldestLiveSession: null });
  const session = state.sessions.find((s) => s.id === sessionId);
  if (!session) return fail(`không có session ${sessionId}`);
  const dead = teamV17SessionDeadReason(session, now);
  if (dead) return fail(`session đã chết: ${dead}`);
  const updated: TeamV17Session = { ...session, lastSeenAt: now };
  const next: TeamV17State = {
    ...state,
    sessions: state.sessions.map((s) => (s.id === sessionId ? updated : s)),
    users: state.users.map((u) => (u.userId === session.userId ? { ...u, lastActiveAt: now } : u)),
    updatedAt: now,
  };
  return { ok: true, state: next, error: '', session: updated, oldestLiveSession: null };
}

/** Revoke một session (chủ session, hoặc owner/admin). */
export function revokeTeamV17Session(
  state: TeamV17State,
  actorUserId: string,
  sessionId: string,
  reason = 'revoked by admin',
  now = Date.now(),
): TeamV17SessionResult {
  const fail = (error: string): TeamV17SessionResult => ({ ok: false, state, error, session: null, oldestLiveSession: null });
  const session = state.sessions.find((s) => s.id === sessionId);
  if (!session) return fail(`không có session ${sessionId}`);
  const actor = findTeamV17User(state, actorUserId);
  const canRevoke =
    actor &&
    actor.status === 'active' &&
    (actor.userId === session.userId || actor.roleRef === 'owner' || actor.roleRef === 'admin');
  if (!canRevoke) return fail('chỉ chủ session hoặc owner/admin mới được revoke session');
  if (session.revokedAt !== null) return fail(`session đã revoke từ trước: ${session.revokedReason}`);
  const updated: TeamV17Session = { ...session, revokedAt: now, revokedReason: reason };
  const next: TeamV17State = {
    ...state,
    sessions: state.sessions.map((s) => (s.id === sessionId ? updated : s)),
    updatedAt: now,
  };
  return { ok: true, state: next, error: '', session: updated, oldestLiveSession: null };
}

/** Revoke toàn bộ session đang sống của một user (đăng xuất mọi nơi). */
export function revokeAllTeamV17Sessions(
  state: TeamV17State,
  actorUserId: string,
  targetUserId: string,
  reason = 'revoke all sessions',
  now = Date.now(),
): { ok: boolean; state: TeamV17State; error: string; revokedCount: number } {
  const actor = findTeamV17User(state, actorUserId);
  const canRevoke =
    actor &&
    actor.status === 'active' &&
    (actor.userId === targetUserId || actor.roleRef === 'owner' || actor.roleRef === 'admin');
  if (!canRevoke) return { ok: false, state, error: 'chỉ chủ user hoặc owner/admin mới được revoke toàn bộ session', revokedCount: 0 };
  let revokedCount = 0;
  const sessions = state.sessions.map((s) => {
    if (s.userId === targetUserId && s.revokedAt === null) {
      revokedCount += 1;
      return { ...s, revokedAt: now, revokedReason: reason };
    }
    return s;
  });
  return { ok: true, state: { ...state, sessions, updatedAt: now }, error: '', revokedCount };
}

/** Các session đang sống của user tại `now` (mới nhất trước). */
export function listTeamV17LiveSessions(state: TeamV17State, userId: string, now = Date.now()): TeamV17Session[] {
  return state.sessions
    .filter((s) => s.userId === userId && teamV17SessionAlive(s, now))
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

/** Dọn session đã chết khỏi state (giữ lại tối đa 500 entry đã revoke gần nhất để audit). */
export function pruneTeamV17Sessions(state: TeamV17State, now = Date.now()): TeamV17State {
  const live = state.sessions.filter((s) => teamV17SessionAlive(s, now));
  const dead = state.sessions
    .filter((s) => !teamV17SessionAlive(s, now))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 500);
  const sessions = [...live, ...dead].sort((a, b) => a.createdAt - b.createdAt);
  return sessions.length === state.sessions.length ? state : { ...state, sessions, updatedAt: now };
}

// ---------------------------------------------------------------------------
// Tóm tắt + persistence
// ---------------------------------------------------------------------------

/** Tóm tắt một user (để panel vẽ). */
export interface TeamV17UserSummary {
  userId: string;
  displayName: string;
  email: string;
  roleRef: string;
  status: TeamV17UserStatus;
  groups: string[];
  allowGrantCount: number;
  denyGrantCount: number;
  liveSessions: number;
  maxSessions: number;
  lastActiveAt: number | null;
}

export function summarizeTeamV17User(state: TeamV17State, user: TeamV17User, now = Date.now()): TeamV17UserSummary {
  return {
    userId: user.userId,
    displayName: user.displayName,
    email: user.email,
    roleRef: user.roleRef,
    status: user.status,
    groups: teamV17GroupsOfUser(state, user.userId).map((g) => g.id),
    allowGrantCount: teamV17AllowGrantsForUser(state, user).length,
    denyGrantCount: teamV17DenyGrantsForUser(state, user).length,
    liveSessions: listTeamV17LiveSessions(state, user.userId, now).length,
    maxSessions: teamV17MaxSessionsForUser(state, user),
    lastActiveAt: user.lastActiveAt,
  };
}

/** Tóm tắt toàn team. */
export interface TeamV17Summary {
  totalUsers: number;
  byStatus: Record<TeamV17UserStatus, number>;
  byRole: Record<string, number>;
  totalGroups: number;
  pendingInvites: number;
  expiredInvites: number;
  liveSessions: number;
  recentAdminActions: TeamV17AdminLogEntry[];
}

export function summarizeTeamV17(state: TeamV17State, recentLimit = 10, now = Date.now()): TeamV17Summary {
  const byStatus = Object.fromEntries(TEAM_V17_USER_STATUSES.map((s) => [s, 0])) as Record<TeamV17UserStatus, number>;
  const byRole: Record<string, number> = {};
  for (const u of state.users) {
    byStatus[u.status] += 1;
    byRole[u.roleRef] = (byRole[u.roleRef] ?? 0) + 1;
  }
  return {
    totalUsers: state.users.length,
    byStatus,
    byRole,
    totalGroups: state.groups.length,
    pendingInvites: state.invites.filter((i) => i.status === 'pending' && i.expiresAt > now).length,
    expiredInvites: state.invites.filter((i) => i.status === 'expired').length,
    liveSessions: state.sessions.filter((s) => teamV17SessionAlive(s, now)).length,
    recentAdminActions: state.adminLog.slice(-recentLimit).reverse(),
  };
}

/** Lưu state xuống file trong team root. */
export function saveTeamV17State(teamRoot: string, state: TeamV17State): void {
  fs.mkdirSync(teamRoot, { recursive: true });
  fs.writeFileSync(path.join(teamRoot, TEAM_V17_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/** Đọc state từ file (null khi chưa có / file hỏng). */
export function loadTeamV17State(teamRoot: string): TeamV17State | null {
  try {
    const raw = fs.readFileSync(path.join(teamRoot, TEAM_V17_STATE_FILE), 'utf8');
    const parsed = JSON.parse(raw) as TeamV17State;
    if (!parsed || parsed.version !== TEAM_V17_STATE_VERSION || !Array.isArray(parsed.users)) return null;
    return parsed;
  } catch {
    return null;
  }
}
