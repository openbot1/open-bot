/**
 * Multi-user v5 — quản lý người dùng nâng cao: phân quyền theo tính
 * năng, vòng đời user (mời / tạm ngưng / kích hoạt lại / vô hiệu),
 * giới hạn session đồng thời, nhật ký thao tác quản trị (v1.19, Đội T6).
 *
 * Tầng trên của multi-user v4 (`fleetV15/multiUserV15.ts` — custom
 * role theo action, quota CPU/RAM/disk, session isolation, user-switch
 * audit). V4 trả lời "role này được làm ACTION gì"; v5 trả lời 4 câu
 * quản trị còn thiếu để vận hành nhiều user thật trên một máy
 * local-first:
 *
 * - PHÂN QUYỀN THEO TÍNH NĂNG: mỗi tính năng (chat, bots, tools,
 *   memory, voice, composio, fleet, media, admin) có một tập role
 *   mặc định; custom role kế thừa feature của base role rồi
 *   cộng/trừ feature; từng user có thêm grant/deny riêng — DENY
 *   thắng GRANT (nhất quán với quy tắc deny-thắng-allow của v4).
 *   Feature `admin` KHÔNG BAO GIỜ thuộc về member/viewer hay custom
 *   role có base không phải owner (chống leo thang quyền).
 * - VÒNG ĐỜI USER: mời bằng token có hạn (7 ngày), tạm ngưng
 *   (suspend — giữ dữ liệu, chặn đăng nhập), kích hoạt lại,
 *   vô hiệu hóa (deactivate — chặn vĩnh viễn tới khi reactivate);
 *   không được hạ cấp/vô hiệu owner cuối cùng của team.
 * - GIỚI HẠN SESSION: số session đồng thời tối đa theo role
 *   (owner 10, admin 5, member 3, viewer 2) + override theo user;
 *   vượt giới hạn thì session mới bị từ chối kèm lý do (caller tự
 *   revoke session cũ nhất nếu muốn "đăng xuất chỗ khác").
 * - NHẬT KÝ QUẢN TRỊ: mọi thao tác quản trị (mời, đổi role, tạm
 *   ngưng, vô hiệu, grant/deny feature) ghi vào log trong state
 *   (seq tăng dần, actor, target, thời gian) để panel Admin vẽ
 *   "ai đã làm gì với ai".
 *
 * Module này KHÔNG gọi mạng, KHÔNG tự đăng nhập/đăng xuất thật,
 * KHÔNG mount thư mục: nó quyết định "user này được dùng tính năng
 * nào, còn được tạo session không, thao tác này hợp lệ không" —
 * việc chặn thật / tạo session do caller làm theo kết quả trả về
 * (session thật vẫn do v4 `createTeamV15Session` quản lý).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TeamV13Role } from '../fleetV13/multiUserV13';
import { TEAM_V13_INVITE_TTL_MS, TEAM_V13_ROLES } from '../fleetV13/multiUserV13';

/** File lưu state multi-user v5 trong team root. */
export const TEAM_V16_STATE_FILE = 'team-v119.json';
/** Phiên bản định dạng state v5. */
export const TEAM_V16_STATE_VERSION = 1;
/** Số user tối đa trong một team. */
export const TEAM_V16_MAX_USERS = 500;
/** Số custom feature-role tối đa. */
export const TEAM_V16_MAX_CUSTOM_FEATURE_ROLES = 100;
/** Số entry nhật ký quản trị tối đa giữ trong state. */
export const TEAM_V16_MAX_ADMIN_LOG = 1000;
/** Độ dài token mời (ký tự hex). */
export const TEAM_V16_INVITE_TOKEN_LENGTH = 32;

// ---------------------------------------------------------------------------
// Tính năng + ma trận phân quyền theo tính năng
// ---------------------------------------------------------------------------

/** Một tính năng của hệ thống có thể bật/tắt theo user. */
export type TeamV16Feature =
  | 'chat'
  | 'bots'
  | 'tools'
  | 'memory'
  | 'voice'
  | 'composio'
  | 'fleet'
  | 'media'
  | 'admin';

export const TEAM_V16_FEATURES: readonly TeamV16Feature[] = [
  'chat',
  'bots',
  'tools',
  'memory',
  'voice',
  'composio',
  'fleet',
  'media',
  'admin',
];

/**
 * Feature mặc định theo role cứng. Nguyên tắc: viewer chỉ chat +
 * xem memory; member thêm bots/tools/voice/media của mình; admin
 * thêm composio + fleet; chỉ owner có `admin`.
 */
export const TEAM_V16_ROLE_FEATURES: Readonly<Record<TeamV13Role, readonly TeamV16Feature[]>> = {
  owner: [...TEAM_V16_FEATURES],
  admin: ['chat', 'bots', 'tools', 'memory', 'voice', 'composio', 'fleet', 'media'],
  member: ['chat', 'bots', 'tools', 'memory', 'voice', 'media'],
  viewer: ['chat', 'memory'],
};

/** Số session đồng thời tối đa mặc định theo role cứng. */
export const TEAM_V16_ROLE_MAX_SESSIONS: Readonly<Record<TeamV13Role, number>> = {
  owner: 10,
  admin: 5,
  member: 3,
  viewer: 2,
};

/** Ref role: role cứng (`owner`...) hoặc custom (`custom:<id>`). */
export function teamV16RoleRef(role: string): string {
  return role;
}

/** True khi ref là custom role (`custom:<id>`). */
export function isTeamV16CustomRoleRef(roleRef: string): boolean {
  return roleRef.startsWith('custom:') && roleRef.length > 'custom:'.length;
}

/** Id custom role từ ref (`custom:abc` → `abc`, role cứng → ''). */
export function teamV16CustomRoleId(roleRef: string): string {
  return isTeamV16CustomRoleRef(roleRef) ? roleRef.slice('custom:'.length) : '';
}

/**
 * Định nghĩa feature cho một custom role: kế thừa feature của base
 * role rồi cộng `extraFeatures`, trừ `deniedFeatures`. `admin`
 * trong extra chỉ có hiệu lực khi base là owner.
 */
export interface TeamV16CustomFeatureRole {
  id: string;
  name: string;
  baseRole: TeamV13Role;
  extraFeatures: TeamV16Feature[];
  deniedFeatures: TeamV16Feature[];
}

/** Lỗi validate custom feature-role, '' = hợp lệ. */
export function validateTeamV16CustomFeatureRole(
  input: Omit<TeamV16CustomFeatureRole, 'extraFeatures' | 'deniedFeatures'> & {
    extraFeatures?: readonly TeamV16Feature[];
    deniedFeatures?: readonly TeamV16Feature[];
  },
): string {
  if (typeof input.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.id)) {
    return 'id custom role phải là slug: chữ thường/số/gạch nối, bắt đầu bằng chữ/số';
  }
  if (typeof input.name !== 'string' || input.name.trim().length === 0 || input.name.length > 80) {
    return 'tên custom role không được rỗng và tối đa 80 ký tự';
  }
  if (!TEAM_V13_ROLES.includes(input.baseRole)) {
    return `baseRole phải là một trong: ${TEAM_V13_ROLES.join(', ')}`;
  }
  const extra = input.extraFeatures ?? [];
  const denied = input.deniedFeatures ?? [];
  for (const f of [...extra, ...denied]) {
    if (!TEAM_V16_FEATURES.includes(f)) return `feature không hợp lệ: ${f}`;
  }
  if (extra.includes('admin') && input.baseRole !== 'owner') {
    return 'chỉ custom role có base owner mới được cộng feature admin';
  }
  const clash = extra.filter((f) => denied.includes(f));
  if (clash.length > 0) return `feature vừa cộng vừa trừ: ${clash.join(', ')}`;
  return '';
}

/**
 * Feature hiệu lực của một custom feature-role (base + extra −
 * denied). Feature `admin` bị loại bỏ trừ khi base là owner — kể
 * cả khi dữ liệu cũ trong state chứa nó (fail-closed).
 */
export function effectiveTeamV16CustomRoleFeatures(
  def: TeamV16CustomFeatureRole,
): TeamV16Feature[] {
  const base = new Set<TeamV16Feature>(TEAM_V16_ROLE_FEATURES[def.baseRole]);
  for (const f of def.extraFeatures) base.add(f);
  for (const f of def.deniedFeatures) base.delete(f);
  if (def.baseRole !== 'owner') base.delete('admin');
  return TEAM_V16_FEATURES.filter((f) => base.has(f));
}

/**
 * Feature hiệu lực của một role ref (cứng hoặc `custom:<id>`).
 * Ref không rõ → [] (fail-closed: không feature nào).
 */
export function teamV16FeaturesForRoleRef(
  roleRef: string,
  customRoles: readonly TeamV16CustomFeatureRole[],
): TeamV16Feature[] {
  if ((TEAM_V13_ROLES as readonly string[]).includes(roleRef)) {
    return [...TEAM_V16_ROLE_FEATURES[roleRef as TeamV13Role]];
  }
  if (isTeamV16CustomRoleRef(roleRef)) {
    const def = customRoles.find((r) => r.id === teamV16CustomRoleId(roleRef));
    if (!def) return [];
    return effectiveTeamV16CustomRoleFeatures(def);
  }
  return [];
}

/** Số session tối đa của một role ref (custom = theo base role). */
export function teamV16MaxSessionsForRoleRef(
  roleRef: string,
  customRoles: readonly TeamV16CustomFeatureRole[],
): number {
  if ((TEAM_V13_ROLES as readonly string[]).includes(roleRef)) {
    return TEAM_V16_ROLE_MAX_SESSIONS[roleRef as TeamV13Role];
  }
  if (isTeamV16CustomRoleRef(roleRef)) {
    const def = customRoles.find((r) => r.id === teamV16CustomRoleId(roleRef));
    if (!def) return 0;
    return TEAM_V16_ROLE_MAX_SESSIONS[def.baseRole];
  }
  return 0;
}

// ---------------------------------------------------------------------------
// User v5: vòng đời + grant/deny theo tính năng
// ---------------------------------------------------------------------------

/** Trạng thái vòng đời của user. */
export type TeamV16UserStatus = 'active' | 'invited' | 'suspended' | 'deactivated';

export const TEAM_V16_USER_STATUSES: readonly TeamV16UserStatus[] = [
  'active',
  'invited',
  'suspended',
  'deactivated',
];

/** Một user trong team (v5). */
export interface TeamV16User {
  userId: string;
  displayName: string;
  /** Role cứng hoặc `custom:<id>`. */
  roleRef: string;
  status: TeamV16UserStatus;
  /** Epoch ms tạo user. */
  createdAt: number;
  /** Epoch ms hoạt động gần nhất (null = chưa từng). */
  lastActiveAt: number | null;
  /** Feature cộng thêm ngoài role (grant riêng). */
  featureGrants: TeamV16Feature[];
  /** Feature trừ đi dù role có (deny riêng — thắng grant). */
  featureDenies: TeamV16Feature[];
  /** Override số session tối đa (null = theo role). */
  maxSessionsOverride: number | null;
  /** Token mời còn hiệu lực (chỉ khi status = invited). */
  inviteToken: string | null;
  /** Epoch ms token mời hết hạn (null = không có lời mời). */
  inviteExpiresAt: number | null;
}

/** Một entry nhật ký thao tác quản trị. */
export interface TeamV16AdminLogEntry {
  seq: number;
  at: number;
  actorUserId: string;
  action: string;
  targetUserId: string;
  detail: string;
}

/** State multi-user v5. */
export interface TeamV16State {
  version: number;
  users: TeamV16User[];
  customFeatureRoles: TeamV16CustomFeatureRole[];
  adminLog: TeamV16AdminLogEntry[];
  /** Seq tiếp theo của admin log. */
  nextAdminSeq: number;
  createdAt: number;
  updatedAt: number;
}

export function createTeamV16State(now = Date.now()): TeamV16State {
  return {
    version: TEAM_V16_STATE_VERSION,
    users: [],
    customFeatureRoles: [],
    adminLog: [],
    nextAdminSeq: 1,
    createdAt: now,
    updatedAt: now,
  };
}

/** Ghi một entry vào nhật ký quản trị (cắt cũ khi quá giới hạn). */
export function recordTeamV16AdminAction(
  state: TeamV16State,
  input: { actorUserId: string; action: string; targetUserId: string; detail?: string },
  now = Date.now(),
): TeamV16State {
  const entry: TeamV16AdminLogEntry = {
    seq: state.nextAdminSeq,
    at: now,
    actorUserId: input.actorUserId,
    action: input.action,
    targetUserId: input.targetUserId,
    detail: input.detail ?? '',
  };
  const adminLog = [...state.adminLog, entry].slice(-TEAM_V16_MAX_ADMIN_LOG);
  return { ...state, adminLog, nextAdminSeq: state.nextAdminSeq + 1, updatedAt: now };
}

/** Lỗi validate user mới, '' = hợp lệ. */
export function validateTeamV16UserInput(input: {
  userId?: string;
  displayName?: string;
  roleRef?: string;
}): string {
  if (typeof input.userId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.userId)) {
    return 'userId phải là slug: chữ thường/số/_/-, bắt đầu bằng chữ/số';
  }
  if (
    typeof input.displayName !== 'string' ||
    input.displayName.trim().length === 0 ||
    input.displayName.length > 80
  ) {
    return 'displayName không được rỗng và tối đa 80 ký tự';
  }
  if (typeof input.roleRef !== 'string' || input.roleRef.length === 0) {
    return 'roleRef không được rỗng';
  }
  return '';
}

export interface TeamV16MutateResult {
  ok: boolean;
  state: TeamV16State;
  error: string;
}

function failTeamV16(state: TeamV16State, error: string): TeamV16MutateResult {
  return { ok: false, state, error };
}

/** Tìm user theo id (null khi không có). */
export function findTeamV16User(state: TeamV16State, userId: string): TeamV16User | null {
  return state.users.find((u) => u.userId === userId) ?? null;
}

/** Số owner đang active (để chặn hạ cấp/vô hiệu owner cuối). */
export function countTeamV16ActiveOwners(state: TeamV16State): number {
  return state.users.filter((u) => u.roleRef === 'owner' && u.status === 'active').length;
}

/**
 * Tạo user active mới. Actor phải có quyền `invite-member` — hàm
 * này KHÔNG tự kiểm tra quyền của actor (caller kiểm bằng
 * `canTeamV13`/`canTeamV15` trước), chỉ kiểm tra tính hợp lệ của
 * dữ liệu + owner cuối + trùng id.
 */
export function createTeamV16User(
  state: TeamV16State,
  input: { userId: string; displayName: string; roleRef: string; actorUserId: string },
  now = Date.now(),
): TeamV16MutateResult {
  const invalid = validateTeamV16UserInput(input);
  if (invalid) return failTeamV16(state, invalid);
  if (teamV16FeaturesForRoleRef(input.roleRef, state.customFeatureRoles).length === 0) {
    return failTeamV16(state, `roleRef không tồn tại: ${input.roleRef}`);
  }
  if (findTeamV16User(state, input.userId)) {
    return failTeamV16(state, `userId đã tồn tại: ${input.userId}`);
  }
  if (state.users.length >= TEAM_V16_MAX_USERS) {
    return failTeamV16(state, `team đã đạt tối đa ${TEAM_V16_MAX_USERS} user`);
  }
  const user: TeamV16User = {
    userId: input.userId,
    displayName: input.displayName.trim(),
    roleRef: input.roleRef,
    status: 'active',
    createdAt: now,
    lastActiveAt: null,
    featureGrants: [],
    featureDenies: [],
    maxSessionsOverride: null,
    inviteToken: null,
    inviteExpiresAt: null,
  };
  const next: TeamV16State = { ...state, users: [...state.users, user], updatedAt: now };
  return {
    ok: true,
    state: recordTeamV16AdminAction(next, {
      actorUserId: input.actorUserId,
      action: 'user.create',
      targetUserId: input.userId,
      detail: `role=${input.roleRef}`,
    }, now),
    error: '',
  };
}

function randomTeamV16Token(length: number): string {
  // Dùng crypto.randomBytes: LCG tự viết trước đây (`seed * 1103515245`)
  // tràn float64 (vượt 2^53) làm các bit thấp sụp về 0 — ~37% token
  // sinh ra toàn '0' và chỉ ~2,4k giá trị khác nhau trong 20k lần
  // sinh (đo thực tế), token mời đoán được dễ dàng. Token mời là
  // credential kiểm tra ở `acceptTeamV16Invite` nên phải ngẫu nhiên thật.
  return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

/**
 * Mời user mới: tạo user ở trạng thái `invited` kèm token có hạn
 * 7 ngày. `acceptTeamV16Invite` đổi sang `active` khi user nhận lời.
 */
export function inviteTeamV16User(
  state: TeamV16State,
  input: { userId: string; displayName: string; roleRef: string; actorUserId: string },
  now = Date.now(),
): TeamV16MutateResult & { inviteToken: string } {
  const invalid = validateTeamV16UserInput(input);
  if (invalid) return { ...failTeamV16(state, invalid), inviteToken: '' };
  if (teamV16FeaturesForRoleRef(input.roleRef, state.customFeatureRoles).length === 0) {
    return { ...failTeamV16(state, `roleRef không tồn tại: ${input.roleRef}`), inviteToken: '' };
  }
  if (findTeamV16User(state, input.userId)) {
    return { ...failTeamV16(state, `userId đã tồn tại: ${input.userId}`), inviteToken: '' };
  }
  if (state.users.length >= TEAM_V16_MAX_USERS) {
    return { ...failTeamV16(state, `team đã đạt tối đa ${TEAM_V16_MAX_USERS} user`), inviteToken: '' };
  }
  const token = randomTeamV16Token(TEAM_V16_INVITE_TOKEN_LENGTH);
  const user: TeamV16User = {
    userId: input.userId,
    displayName: input.displayName.trim(),
    roleRef: input.roleRef,
    status: 'invited',
    createdAt: now,
    lastActiveAt: null,
    featureGrants: [],
    featureDenies: [],
    maxSessionsOverride: null,
    inviteToken: token,
    inviteExpiresAt: now + TEAM_V13_INVITE_TTL_MS,
  };
  const next: TeamV16State = { ...state, users: [...state.users, user], updatedAt: now };
  const logged = recordTeamV16AdminAction(next, {
    actorUserId: input.actorUserId,
    action: 'user.invite',
    targetUserId: input.userId,
    detail: `role=${input.roleRef}`,
  }, now);
  return { ok: true, state: logged, error: '', inviteToken: token };
}

/** User nhận lời mời bằng token → `active` (token hết hạn → lỗi). */
export function acceptTeamV16Invite(
  state: TeamV16State,
  input: { userId: string; token: string },
  now = Date.now(),
): TeamV16MutateResult {
  const user = findTeamV16User(state, input.userId);
  if (!user) return failTeamV16(state, `không tìm thấy user: ${input.userId}`);
  if (user.status !== 'invited') return failTeamV16(state, `user không ở trạng thái invited: ${input.userId}`);
  if (user.inviteToken !== input.token) return failTeamV16(state, 'token mời không đúng');
  if (user.inviteExpiresAt !== null && now > user.inviteExpiresAt) {
    return failTeamV16(state, 'lời mời đã hết hạn');
  }
  const users = state.users.map((u) =>
    u.userId === input.userId
      ? { ...u, status: 'active' as const, inviteToken: null, inviteExpiresAt: null, lastActiveAt: now }
      : u,
  );
  const next: TeamV16State = { ...state, users, updatedAt: now };
  return {
    ok: true,
    state: recordTeamV16AdminAction(next, {
      actorUserId: input.userId,
      action: 'user.accept-invite',
      targetUserId: input.userId,
    }, now),
    error: '',
  };
}

function setTeamV16UserStatus(
  state: TeamV16State,
  input: { userId: string; status: TeamV16UserStatus; actorUserId: string; action: string },
  now = Date.now(),
): TeamV16MutateResult {
  const user = findTeamV16User(state, input.userId);
  if (!user) return failTeamV16(state, `không tìm thấy user: ${input.userId}`);
  if (user.status === input.status) return failTeamV16(state, `user đã ở trạng thái ${input.status}`);
  if (
    (input.status === 'suspended' || input.status === 'deactivated') &&
    user.roleRef === 'owner' &&
    user.status === 'active' &&
    countTeamV16ActiveOwners(state) <= 1
  ) {
    return failTeamV16(state, 'không được tạm ngưng/vô hiệu owner cuối cùng của team');
  }
  const users = state.users.map((u) => (u.userId === input.userId ? { ...u, status: input.status } : u));
  const next: TeamV16State = { ...state, users, updatedAt: now };
  return {
    ok: true,
    state: recordTeamV16AdminAction(next, {
      actorUserId: input.actorUserId,
      action: input.action,
      targetUserId: input.userId,
      detail: `${user.status} -> ${input.status}`,
    }, now),
    error: '',
  };
}

/** Tạm ngưng user (giữ dữ liệu, chặn đăng nhập mới). */
export function suspendTeamV16User(
  state: TeamV16State,
  input: { userId: string; actorUserId: string },
  now = Date.now(),
): TeamV16MutateResult {
  return setTeamV16UserStatus(state, { ...input, status: 'suspended', action: 'user.suspend' }, now);
}

/** Vô hiệu hóa user. */
export function deactivateTeamV16User(
  state: TeamV16State,
  input: { userId: string; actorUserId: string },
  now = Date.now(),
): TeamV16MutateResult {
  return setTeamV16UserStatus(state, { ...input, status: 'deactivated', action: 'user.deactivate' }, now);
}

/** Kích hoạt lại user đã tạm ngưng/vô hiệu. */
export function reactivateTeamV16User(
  state: TeamV16State,
  input: { userId: string; actorUserId: string },
  now = Date.now(),
): TeamV16MutateResult {
  const user = findTeamV16User(state, input.userId);
  if (!user) return failTeamV16(state, `không tìm thấy user: ${input.userId}`);
  if (user.status !== 'suspended' && user.status !== 'deactivated') {
    return failTeamV16(state, `chỉ kích hoạt lại user suspended/deactivated, hiện tại: ${user.status}`);
  }
  return setTeamV16UserStatus(state, { ...input, status: 'active', action: 'user.reactivate' }, now);
}

/**
 * Đổi role của user. Không được hạ cấp owner cuối cùng (đổi sang
 * role khác khi chỉ còn 1 owner active).
 */
export function changeTeamV16UserRole(
  state: TeamV16State,
  input: { userId: string; roleRef: string; actorUserId: string },
  now = Date.now(),
): TeamV16MutateResult {
  const user = findTeamV16User(state, input.userId);
  if (!user) return failTeamV16(state, `không tìm thấy user: ${input.userId}`);
  if (teamV16FeaturesForRoleRef(input.roleRef, state.customFeatureRoles).length === 0) {
    return failTeamV16(state, `roleRef không tồn tại: ${input.roleRef}`);
  }
  if (
    user.roleRef === 'owner' &&
    input.roleRef !== 'owner' &&
    user.status === 'active' &&
    countTeamV16ActiveOwners(state) <= 1
  ) {
    return failTeamV16(state, 'không được hạ cấp owner cuối cùng của team');
  }
  const users = state.users.map((u) =>
    u.userId === input.userId ? { ...u, roleRef: input.roleRef } : u,
  );
  const next: TeamV16State = { ...state, users, updatedAt: now };
  return {
    ok: true,
    state: recordTeamV16AdminAction(next, {
      actorUserId: input.actorUserId,
      action: 'user.change-role',
      targetUserId: input.userId,
      detail: `${user.roleRef} -> ${input.roleRef}`,
    }, now),
    error: '',
  };
}

/**
 * Đặt grant/deny feature riêng cho user. `admin` không được grant
 * cho user có role base không phải owner (chống leo thang quyền
 * qua grant riêng). Deny `admin` thì luôn được phép.
 */
export function setTeamV16UserFeatureAccess(
  state: TeamV16State,
  input: {
    userId: string;
    actorUserId: string;
    grants?: readonly TeamV16Feature[];
    denies?: readonly TeamV16Feature[];
  },
  now = Date.now(),
): TeamV16MutateResult {
  const user = findTeamV16User(state, input.userId);
  if (!user) return failTeamV16(state, `không tìm thấy user: ${input.userId}`);
  const grants = [...new Set(input.grants ?? user.featureGrants)];
  const denies = [...new Set(input.denies ?? user.featureDenies)];
  for (const f of [...grants, ...denies]) {
    if (!TEAM_V16_FEATURES.includes(f)) return failTeamV16(state, `feature không hợp lệ: ${f}`);
  }
  const clash = grants.filter((f) => denies.includes(f));
  if (clash.length > 0) return failTeamV16(state, `feature vừa grant vừa deny: ${clash.join(', ')}`);
  const baseRole: TeamV13Role | null = (TEAM_V13_ROLES as readonly string[]).includes(user.roleRef)
    ? (user.roleRef as TeamV13Role)
    : (state.customFeatureRoles.find((r) => r.id === teamV16CustomRoleId(user.roleRef))?.baseRole ?? null);
  if (grants.includes('admin') && baseRole !== 'owner') {
    return failTeamV16(state, 'chỉ user có base role owner mới được grant feature admin');
  }
  const users = state.users.map((u) =>
    u.userId === input.userId
      ? { ...u, featureGrants: grants, featureDenies: denies }
      : u,
  );
  const next: TeamV16State = { ...state, users, updatedAt: now };
  return {
    ok: true,
    state: recordTeamV16AdminAction(next, {
      actorUserId: input.actorUserId,
      action: 'user.set-feature-access',
      targetUserId: input.userId,
      detail: `grants=${grants.join(',') || '-'} denies=${denies.join(',') || '-'}`,
    }, now),
    error: '',
  };
}

/** Đặt override số session tối đa cho user (null = về mặc định theo role). */
export function setTeamV16UserMaxSessions(
  state: TeamV16State,
  input: { userId: string; actorUserId: string; maxSessions: number | null },
  now = Date.now(),
): TeamV16MutateResult {
  const user = findTeamV16User(state, input.userId);
  if (!user) return failTeamV16(state, `không tìm thấy user: ${input.userId}`);
  if (input.maxSessions !== null && (!Number.isInteger(input.maxSessions) || input.maxSessions < 0 || input.maxSessions > 100)) {
    return failTeamV16(state, 'maxSessions phải là số nguyên 0..100 hoặc null');
  }
  const users = state.users.map((u) =>
    u.userId === input.userId ? { ...u, maxSessionsOverride: input.maxSessions } : u,
  );
  const next: TeamV16State = { ...state, users, updatedAt: now };
  return {
    ok: true,
    state: recordTeamV16AdminAction(next, {
      actorUserId: input.actorUserId,
      action: 'user.set-max-sessions',
      targetUserId: input.userId,
      detail: `maxSessions=${input.maxSessions ?? 'role-default'}`,
    }, now),
    error: '',
  };
}

// ---------------------------------------------------------------------------
// Kiểm tra quyền theo tính năng + giới hạn session
// ---------------------------------------------------------------------------

/** Feature hiệu lực của một user (role + grant − deny). */
export function effectiveTeamV16UserFeatures(
  state: TeamV16State,
  user: TeamV16User,
): TeamV16Feature[] {
  const base = new Set(teamV16FeaturesForRoleRef(user.roleRef, state.customFeatureRoles));
  for (const f of user.featureGrants) base.add(f);
  for (const f of user.featureDenies) base.delete(f);
  if (!teamV16IsOwnerBase(state, user)) base.delete('admin');
  return TEAM_V16_FEATURES.filter((f) => base.has(f));
}

function teamV16IsOwnerBase(state: TeamV16State, user: TeamV16User): boolean {
  if (user.roleRef === 'owner') return true;
  if (isTeamV16CustomRoleRef(user.roleRef)) {
    return state.customFeatureRoles.find((r) => r.id === teamV16CustomRoleId(user.roleRef))?.baseRole === 'owner';
  }
  return false;
}

/**
 * User có được dùng feature không? Fail-closed: user không tồn tại
 * hoặc không active → false; feature không rõ → false.
 */
export function canTeamV16UseFeature(
  state: TeamV16State,
  userId: string,
  feature: TeamV16Feature,
): boolean {
  if (!TEAM_V16_FEATURES.includes(feature)) return false;
  const user = findTeamV16User(state, userId);
  if (!user || user.status !== 'active') return false;
  return effectiveTeamV16UserFeatures(state, user).includes(feature);
}

/** True khi user được phép đăng nhập (chỉ active mới đăng nhập được). */
export function canTeamV16UserLogin(state: TeamV16State, userId: string): boolean {
  const user = findTeamV16User(state, userId);
  return user !== null && user.status === 'active';
}

/** Số session tối đa hiệu lực của user (override thắng role). */
export function teamV16MaxSessionsForUser(state: TeamV16State, user: TeamV16User): number {
  if (user.maxSessionsOverride !== null) return user.maxSessionsOverride;
  return teamV16MaxSessionsForRoleRef(user.roleRef, state.customFeatureRoles);
}

/** Kiểm tra giới hạn session đồng thời trước khi tạo session mới. */
export function checkTeamV16SessionLimit(
  state: TeamV16State,
  userId: string,
  activeSessionCount: number,
): { allowed: boolean; maxSessions: number; reason: string } {
  const user = findTeamV16User(state, userId);
  if (!user) return { allowed: false, maxSessions: 0, reason: `không tìm thấy user: ${userId}` };
  if (user.status !== 'active') {
    return { allowed: false, maxSessions: 0, reason: `user không active (status=${user.status})` };
  }
  const maxSessions = teamV16MaxSessionsForUser(state, user);
  if (activeSessionCount >= maxSessions) {
    return {
      allowed: false,
      maxSessions,
      reason: `đã đạt tối đa ${maxSessions} session đồng thời (${activeSessionCount} đang mở)`,
    };
  }
  return { allowed: true, maxSessions, reason: '' };
}

// ---------------------------------------------------------------------------
// Custom feature-role trong state + tóm tắt + persistence
// ---------------------------------------------------------------------------

/** Thêm custom feature-role vào state. */
export function addTeamV16CustomFeatureRole(
  state: TeamV16State,
  def: TeamV16CustomFeatureRole,
  actorUserId: string,
  now = Date.now(),
): TeamV16MutateResult {
  const invalid = validateTeamV16CustomFeatureRole(def);
  if (invalid) return failTeamV16(state, invalid);
  if (state.customFeatureRoles.some((r) => r.id === def.id)) {
    return failTeamV16(state, `custom role đã tồn tại: ${def.id}`);
  }
  if (state.customFeatureRoles.length >= TEAM_V16_MAX_CUSTOM_FEATURE_ROLES) {
    return failTeamV16(state, `đã đạt tối đa ${TEAM_V16_MAX_CUSTOM_FEATURE_ROLES} custom role`);
  }
  const next: TeamV16State = {
    ...state,
    customFeatureRoles: [...state.customFeatureRoles, { ...def, extraFeatures: [...def.extraFeatures], deniedFeatures: [...def.deniedFeatures] }],
    updatedAt: now,
  };
  return {
    ok: true,
    state: recordTeamV16AdminAction(next, {
      actorUserId,
      action: 'role.create',
      targetUserId: '',
      detail: `custom:${def.id} base=${def.baseRole}`,
    }, now),
    error: '',
  };
}

/** Xóa custom feature-role (chỉ khi không còn user nào dùng nó). */
export function removeTeamV16CustomFeatureRole(
  state: TeamV16State,
  id: string,
  actorUserId: string,
  now = Date.now(),
): TeamV16MutateResult {
  if (!state.customFeatureRoles.some((r) => r.id === id)) {
    return failTeamV16(state, `không tìm thấy custom role: ${id}`);
  }
  const inUse = state.users.filter((u) => u.roleRef === `custom:${id}`).map((u) => u.userId);
  if (inUse.length > 0) {
    return failTeamV16(state, `custom role đang được dùng bởi: ${inUse.join(', ')}`);
  }
  const next: TeamV16State = {
    ...state,
    customFeatureRoles: state.customFeatureRoles.filter((r) => r.id !== id),
    updatedAt: now,
  };
  return {
    ok: true,
    state: recordTeamV16AdminAction(next, {
      actorUserId,
      action: 'role.remove',
      targetUserId: '',
      detail: `custom:${id}`,
    }, now),
    error: '',
  };
}

/** Một dòng tóm tắt user cho panel quản trị. */
export interface TeamV16UserSummary {
  userId: string;
  displayName: string;
  roleRef: string;
  status: TeamV16UserStatus;
  features: TeamV16Feature[];
  maxSessions: number;
  lastActiveAt: number | null;
}

export function summarizeTeamV16User(state: TeamV16State, user: TeamV16User): TeamV16UserSummary {
  return {
    userId: user.userId,
    displayName: user.displayName,
    roleRef: user.roleRef,
    status: user.status,
    features: effectiveTeamV16UserFeatures(state, user),
    maxSessions: teamV16MaxSessionsForUser(state, user),
    lastActiveAt: user.lastActiveAt,
  };
}

/** Tóm tắt toàn team: đếm theo status/role + nhật ký gần nhất. */
export interface TeamV16Summary {
  totalUsers: number;
  byStatus: Record<TeamV16UserStatus, number>;
  byRole: Record<string, number>;
  customRoles: number;
  recentAdminActions: TeamV16AdminLogEntry[];
}

export function summarizeTeamV16(state: TeamV16State, recentLimit = 10): TeamV16Summary {
  const byStatus: Record<TeamV16UserStatus, number> = {
    active: 0,
    invited: 0,
    suspended: 0,
    deactivated: 0,
  };
  const byRole: Record<string, number> = {};
  for (const u of state.users) {
    byStatus[u.status] += 1;
    byRole[u.roleRef] = (byRole[u.roleRef] ?? 0) + 1;
  }
  return {
    totalUsers: state.users.length,
    byStatus,
    byRole,
    customRoles: state.customFeatureRoles.length,
    recentAdminActions: state.adminLog.slice(-recentLimit).reverse(),
  };
}

/** Lưu state v5 xuống team root (JSON). */
export function saveTeamV16State(teamRoot: string, state: TeamV16State): void {
  fs.mkdirSync(teamRoot, { recursive: true });
  fs.writeFileSync(path.join(teamRoot, TEAM_V16_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/** Đọc state v5 (null khi chưa có file / file hỏng / sai version). */
export function loadTeamV16State(teamRoot: string): TeamV16State | null {
  try {
    const raw = fs.readFileSync(path.join(teamRoot, TEAM_V16_STATE_FILE), 'utf8');
    const parsed = JSON.parse(raw) as TeamV16State;
    if (parsed.version !== TEAM_V16_STATE_VERSION || !Array.isArray(parsed.users)) return null;
    return parsed;
  } catch {
    return null;
  }
}
