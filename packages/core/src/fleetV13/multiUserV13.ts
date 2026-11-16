/**
 * Multi-user / team v2 — roles, vault scoping theo user, audit log,
 * invite/deactivate member (v1.16, Đội T6).
 *
 * Bối cảnh (docs/repo-survey-v116.md mục 1, chỉ học ý tưởng):
 * OpenMausBot là single-user, key plaintext trong config — open-bot
 * v1.16 sửa đúng điểm yếu đó ở tầng team: nhiều user local-first
 * (không cloud account, không thanh toán), mỗi user chỉ thấy
 * key/bot của mình, mọi hành động nhạy cảm đều ghi audit log có
 * chuỗi hash để phát hiện sửa/xóa.
 *
 * - Roles: owner > admin > member > viewer. Ma trận quyền
 *   `TEAM_V13_PERMISSIONS`: chỉ owner đổi role owner/admin, chỉ
 *   owner+admin mời/kích hoạt/vô hiệu hóa member, viewer chỉ đọc.
 *   Mọi quyết định quyền đều qua `canTeamV13(role, action)` — hàm
 *   thuần, caller không tự suy luận quyền.
 * - Vault scoping: key/bot mang `ownerUserId`. `visibleVaultKeys`
 *   chỉ trả key của chính user đó; owner/admin được xem *metadata*
 *   (tên key, ngày tạo) của key người khác để quản trị nhưng KHÔNG
 *   được đọc giá trị secret (`canReadTeamV13KeyValue` chỉ true cho
 *   chủ key). Fail-closed: user không tồn tại / đã deactivate thì
 *   không thấy gì cả.
 * - Invite: owner/admin tạo invite (token ngẫu nhiên 32 byte, chỉ
 *   lưu SHA-256 của token, hết hạn 7 ngày, dùng 1 lần). Accept
 *   invite → member `active`. Deactivate: member mất mọi quyền xem
 *   vault/bot ngay, nhưng dữ liệu của họ không bị xóa (để owner
 *   re-assign hoặc GDPR erasure riêng xử lý).
 * - Audit log: append-only, mỗi event nối hash của event trước
 *   (`prevHash` + SHA-256 của nội dung) — sửa/xóa một dòng làm
 *   `verifyTeamV13AuditLog` fail tại đúng dòng đó. Lưu file
 *   `<teamRoot>/team-audit-v116.jsonl` (0600) + state member/invite
 *   ở `<teamRoot>/team-v116.json` (atomic tmp + rename, 0600).
 *
 * Module này KHÔNG gọi mạng, KHÔNG spawn process, KHÔNG tự gửi
 * invite thật (token trả về cho caller hiển thị/gửi qua kênh của
 * họ): nó quyết định "ai được làm gì, ai thấy gì, đã làm gì".
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** File lưu state team v2 trong team root. */
export const TEAM_V13_STATE_FILE = 'team-v116.json';
/** File audit log v2 (JSONL, một event một dòng). */
export const TEAM_V13_AUDIT_FILE = 'team-audit-v116.jsonl';
/** Invite hết hạn sau 7 ngày. */
export const TEAM_V13_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Số member tối đa trong một team local. */
export const TEAM_V13_MAX_MEMBERS = 200;
/** Số invite đang mở tối đa. */
export const TEAM_V13_MAX_INVITES = 100;
/** Số event audit tối đa giữ trong state bộ nhớ (file giữ toàn bộ). */
export const TEAM_V13_MAX_AUDIT_EVENTS = 5000;

/** Role trong team, theo thứ tự quyền giảm dần. */
export type TeamV13Role = 'owner' | 'admin' | 'member' | 'viewer';

export const TEAM_V13_ROLES: readonly TeamV13Role[] = [
  'owner',
  'admin',
  'member',
  'viewer',
];

/** Cấp bậc số của role (owner cao nhất) — dùng để so sánh. */
export const TEAM_V13_ROLE_RANK: Readonly<Record<TeamV13Role, number>> = {
  owner: 4,
  admin: 3,
  member: 2,
  viewer: 1,
};

/** Hành động cần phân quyền trong team v2. */
export type TeamV13Action =
  | 'invite-member'
  | 'deactivate-member'
  | 'reactivate-member'
  | 'change-role'
  | 'view-members'
  | 'view-vault-meta'
  | 'manage-own-vault'
  | 'manage-own-bots'
  | 'run-bots'
  | 'manage-fleet'
  | 'manage-rollout'
  | 'view-audit'
  | 'manage-team-settings';

export const TEAM_V13_ACTIONS: readonly TeamV13Action[] = [
  'invite-member',
  'deactivate-member',
  'reactivate-member',
  'change-role',
  'view-members',
  'view-vault-meta',
  'manage-own-vault',
  'manage-own-bots',
  'run-bots',
  'manage-fleet',
  'manage-rollout',
  'view-audit',
  'manage-team-settings',
];

/**
 * Ma trận quyền: role nào được làm hành động nào. Nguyên tắc:
 * viewer chỉ đọc (chạy bot + xem member của mình); member quản lý
 * vault/bot của mình; admin thêm mời/vô hiệu hóa + fleet/rollout;
 * owner là admin + đổi role + xem audit + đổi setting team.
 */
export const TEAM_V13_PERMISSIONS: Readonly<Record<TeamV13Role, readonly TeamV13Action[]>> = {
  owner: [...TEAM_V13_ACTIONS],
  admin: [
    'invite-member',
    'deactivate-member',
    'reactivate-member',
    'view-members',
    'view-vault-meta',
    'manage-own-vault',
    'manage-own-bots',
    'run-bots',
    'manage-fleet',
    'manage-rollout',
    'view-audit',
  ],
  member: ['view-members', 'manage-own-vault', 'manage-own-bots', 'run-bots'],
  viewer: ['view-members', 'run-bots'],
};

/** True khi role được phép làm action (hàm thuần, fail-closed). */
export function canTeamV13(role: TeamV13Role | string | null | undefined, action: TeamV13Action): boolean {
  if (typeof role !== 'string') return false;
  const allowed = TEAM_V13_PERMISSIONS[role as TeamV13Role];
  if (!allowed) return false;
  return allowed.includes(action);
}

/** True khi role A có cấp >= role B (dùng khi đổi role người khác). */
export function teamV13RoleAtLeast(role: TeamV13Role, min: TeamV13Role): boolean {
  return TEAM_V13_ROLE_RANK[role] >= TEAM_V13_ROLE_RANK[min];
}

/** Trạng thái của một member. */
export type TeamV13MemberStatus = 'active' | 'invited' | 'deactivated';

export const TEAM_V13_MEMBER_STATUSES: readonly TeamV13MemberStatus[] = [
  'active',
  'invited',
  'deactivated',
];

/** Một member trong team local. */
export interface TeamV13Member {
  /** Id ổn định, vd `u_huy`. */
  id: string;
  displayName: string;
  /** Email chỉ để hiển thị/liên lạc, không dùng làm account cloud. */
  email: string;
  role: TeamV13Role;
  status: TeamV13MemberStatus;
  invitedBy: string;
  invitedAt: number;
  /** Epoch ms kích hoạt lần đầu (null = chưa accept invite). */
  activatedAt: number | null;
  deactivatedBy: string;
  deactivatedAt: number | null;
  /** Epoch ms hoạt động gần nhất (null = chưa bao giờ). */
  lastSeenAt: number | null;
}

/** Một lời mời đang mở (chỉ lưu hash token, không lưu token gốc). */
export interface TeamV13Invite {
  id: string;
  email: string;
  role: TeamV13Role;
  invitedBy: string;
  invitedAt: number;
  expiresAt: number;
  /** SHA-256 hex của token (token gốc chỉ trả về 1 lần lúc tạo). */
  tokenHash: string;
  /** true = đã accept / đã thu hồi, không dùng được nữa. */
  used: boolean;
  usedAt: number | null;
  usedBy: string;
}

/** Một key vault đã scope theo user. */
export interface TeamV13VaultKey {
  /** Tên key trong namespace của user, vd `openai-api-key`. */
  name: string;
  ownerUserId: string;
  /** Namespace lưu trữ, vd `u:u_huy:openai-api-key`. */
  namespace: string;
  createdAt: number;
  updatedAt: number;
  /** Gợi ý hiển thị (không bao giờ chứa secret). */
  hint: string;
}

/** Một bot đã scope theo user. */
export interface TeamV13Bot {
  id: string;
  name: string;
  ownerUserId: string;
  createdAt: number;
}

/** Một event audit (chuỗi hash: hash = sha256(prevHash + nội dung)). */
export interface TeamV13AuditEvent {
  seq: number;
  at: number;
  actorUserId: string;
  actorRole: TeamV13Role;
  action: string;
  targetUserId: string;
  detail: string;
  /** Hash của event trước ('' cho event đầu tiên). */
  prevHash: string;
  /** SHA-256 hex của event này. */
  hash: string;
}

/** Toàn bộ state team v2 (lưu file, không chứa secret/token gốc). */
export interface TeamV13State {
  version: 1;
  teamName: string;
  members: TeamV13Member[];
  invites: TeamV13Invite[];
  auditEvents: TeamV13AuditEvent[];
  updatedAt: number;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function normalizeId(id: string): string {
  return id.trim().toLowerCase();
}

/** Namespace vault của một key thuộc về một user. */
export function teamV13VaultNamespace(userId: string, keyName: string): string {
  return `u:${userId.trim()}:${keyName.trim()}`;
}

/** Tạo key vault đã scope (hàm thuần, không ghi secret). */
export function createTeamV13VaultKey(
  ownerUserId: string,
  keyName: string,
  hint = '',
  now = Date.now(),
): TeamV13VaultKey {
  return {
    name: keyName.trim(),
    ownerUserId: ownerUserId.trim(),
    namespace: teamV13VaultNamespace(ownerUserId, keyName),
    createdAt: now,
    updatedAt: now,
    hint: hint.trim(),
  };
}

/** Validate tên key vault (rỗng / chứa khoảng trắng / chứa ':' thì lỗi). */
export function validateTeamV13VaultKeyName(name: string): string[] {
  const errors: string[] = [];
  if (!isNonEmptyString(name)) errors.push('tên key không được trống');
  else {
    if (/\s/.test(name)) errors.push('tên key không được chứa khoảng trắng');
    if (name.includes(':')) errors.push('tên key không được chứa dấu ":" (dùng làm phân tách namespace)');
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Members: tạo state, tìm, invite, deactivate, đổi role
// ---------------------------------------------------------------------------

export function createTeamV13State(teamName: string, now = Date.now()): TeamV13State {
  return {
    version: 1,
    teamName: teamName.trim(),
    members: [],
    invites: [],
    auditEvents: [],
    updatedAt: now,
  };
}

export function findTeamV13Member(state: TeamV13State, userId: string): TeamV13Member | null {
  if (!isNonEmptyString(userId)) return null;
  return state.members.find((m) => m.id === userId.trim()) ?? null;
}

/** Member có đang active không (deactivated/invited thì không có quyền). */
export function isTeamV13MemberActive(member: TeamV13Member | null | undefined): member is TeamV13Member {
  return !!member && member.status === 'active';
}

/** Validate input tạo member đầu tiên / thêm member trực tiếp. */
export function validateTeamV13MemberInput(input: {
  id?: string;
  displayName?: string;
  email?: string;
  role?: string;
}): string[] {
  const errors: string[] = [];
  if (!isNonEmptyString(input?.id)) errors.push('id member không được trống');
  if (!isNonEmptyString(input?.displayName)) errors.push('tên hiển thị không được trống');
  if (!isNonEmptyString(input?.email)) errors.push('email không được trống');
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) {
    errors.push('email không đúng định dạng');
  }
  if (!isNonEmptyString(input?.role) || !TEAM_V13_ROLES.includes(input.role as TeamV13Role)) {
    errors.push(`role phải là một trong: ${TEAM_V13_ROLES.join(', ')}`);
  }
  return errors;
}

export type TeamV13AddMemberResult =
  | { ok: true; state: TeamV13State; member: TeamV13Member }
  | { ok: false; state: TeamV13State; error: string };

/**
 * Thêm member trực tiếp (owner tạo team, hoặc admin thêm khi đã có
 * team). Người đầu tiên trong team trống phải là owner. Member trùng
 * id/email thì từ chối. Hàm thuần — không ghi audit, caller ghi audit
 * bằng `appendTeamV13AuditEvent` sau khi thành công.
 */
export function addTeamV13Member(
  state: TeamV13State,
  input: { id: string; displayName: string; email: string; role: TeamV13Role },
  addedBy: string,
  now = Date.now(),
): TeamV13AddMemberResult {
  const errors = validateTeamV13MemberInput(input);
  if (errors.length > 0) {
    return { ok: false, state, error: `member không hợp lệ: ${errors.join('; ')}` };
  }
  if (state.members.length >= TEAM_V13_MAX_MEMBERS) {
    return { ok: false, state, error: `team đã đủ ${TEAM_V13_MAX_MEMBERS} member tối đa` };
  }
  if (findTeamV13Member(state, input.id)) {
    return { ok: false, state, error: `member "${input.id}" đã tồn tại` };
  }
  if (state.members.some((m) => normalizeId(m.email) === normalizeId(input.email))) {
    return { ok: false, state, error: `email "${input.email}" đã có trong team` };
  }
  if (state.members.length === 0 && input.role !== 'owner') {
    return { ok: false, state, error: 'member đầu tiên của team phải là owner' };
  }
  const member: TeamV13Member = {
    id: input.id.trim(),
    displayName: input.displayName.trim(),
    email: input.email.trim(),
    role: input.role,
    status: 'active',
    invitedBy: addedBy.trim(),
    invitedAt: now,
    activatedAt: now,
    deactivatedBy: '',
    deactivatedAt: null,
    lastSeenAt: null,
  };
  return {
    ok: true,
    state: { ...state, members: [...state.members, member], updatedAt: now },
    member,
  };
}

export type TeamV13InviteResult =
  | { ok: true; state: TeamV13State; invite: TeamV13Invite; token: string }
  | { ok: false; state: TeamV13State; error: string };

/**
 * Tạo invite: chỉ owner/admin (actor phải active) mới được mời, và
 * không được mời role cao hơn hoặc bằng role của chính mình (admin
 * không mời được admin/owner khác — chống leo thang quyền). Token
 * ngẫu nhiên 32 byte, trả về 1 lần duy nhất; state chỉ giữ SHA-256.
 */
export function inviteTeamV13Member(
  state: TeamV13State,
  actor: TeamV13Member,
  email: string,
  role: TeamV13Role,
  now = Date.now(),
): TeamV13InviteResult {
  if (!isTeamV13MemberActive(actor)) {
    return { ok: false, state, error: 'chỉ member đang active mới được mời người khác' };
  }
  if (!canTeamV13(actor.role, 'invite-member')) {
    return { ok: false, state, error: `role "${actor.role}" không được mời member` };
  }
  if (!isNonEmptyString(email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return { ok: false, state, error: 'email mời không đúng định dạng' };
  }
  if (!TEAM_V13_ROLES.includes(role)) {
    return { ok: false, state, error: `role mời phải là một trong: ${TEAM_V13_ROLES.join(', ')}` };
  }
  if (TEAM_V13_ROLE_RANK[role] >= TEAM_V13_ROLE_RANK[actor.role]) {
    return {
      ok: false,
      state,
      error: `không được mời role "${role}" cao hơn hoặc bằng role "${actor.role}" của bạn`,
    };
  }
  if (state.members.some((m) => normalizeId(m.email) === normalizeId(email))) {
    return { ok: false, state, error: `email "${email}" đã là member của team` };
  }
  const openInvites = state.invites.filter((i) => !i.used && i.expiresAt > now);
  if (openInvites.some((i) => normalizeId(i.email) === normalizeId(email))) {
    return { ok: false, state, error: `email "${email}" đã có invite đang mở` };
  }
  if (openInvites.length >= TEAM_V13_MAX_INVITES) {
    return { ok: false, state, error: `đã đủ ${TEAM_V13_MAX_INVITES} invite đang mở tối đa` };
  }
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const invite: TeamV13Invite = {
    id: `inv_${crypto.randomBytes(8).toString('hex')}`,
    email: email.trim(),
    role,
    invitedBy: actor.id,
    invitedAt: now,
    expiresAt: now + TEAM_V13_INVITE_TTL_MS,
    tokenHash,
    used: false,
    usedAt: null,
    usedBy: '',
  };
  return {
    ok: true,
    state: { ...state, invites: [...state.invites, invite], updatedAt: now },
    invite,
    token,
  };
}

export type TeamV13AcceptInviteResult =
  | { ok: true; state: TeamV13State; member: TeamV13Member }
  | { ok: false; state: TeamV13State; error: string };

/**
 * Accept invite bằng token gốc: hash token so với tokenHash đã lưu,
 * invite phải còn hạn + chưa dùng, email chưa là member. Token đúng
 * → member mới `active` (role theo invite), invite đánh `used`.
 * Token sai/hết hạn/không tìm thấy đều trả cùng một lỗi chung để
 * không lộ invite nào tồn tại (fail-closed, chống dò token).
 */
export function acceptTeamV13Invite(
  state: TeamV13State,
  token: string,
  input: { id: string; displayName: string },
  now = Date.now(),
): TeamV13AcceptInviteResult {
  const genericError = 'invite không hợp lệ hoặc đã hết hạn';
  if (!isNonEmptyString(token) || !isNonEmptyString(input?.id) || !isNonEmptyString(input?.displayName)) {
    return { ok: false, state, error: genericError };
  }
  const tokenHash = crypto.createHash('sha256').update(token.trim()).digest('hex');
  const invite = state.invites.find((i) => i.tokenHash === tokenHash);
  if (!invite || invite.used || invite.expiresAt <= now) {
    return { ok: false, state, error: genericError };
  }
  if (findTeamV13Member(state, input.id)) {
    return { ok: false, state, error: `member "${input.id}" đã tồn tại` };
  }
  if (state.members.some((m) => normalizeId(m.email) === normalizeId(invite.email))) {
    return { ok: false, state, error: `email "${invite.email}" đã là member của team` };
  }
  const member: TeamV13Member = {
    id: input.id.trim(),
    displayName: input.displayName.trim(),
    email: invite.email,
    role: invite.role,
    status: 'active',
    invitedBy: invite.invitedBy,
    invitedAt: invite.invitedAt,
    activatedAt: now,
    deactivatedBy: '',
    deactivatedAt: null,
    lastSeenAt: null,
  };
  const invites = state.invites.map((i) =>
    i.id === invite.id ? { ...i, used: true, usedAt: now, usedBy: member.id } : i,
  );
  return {
    ok: true,
    state: { ...state, members: [...state.members, member], invites, updatedAt: now },
    member,
  };
}

export type TeamV13MemberActionResult =
  | { ok: true; state: TeamV13State; member: TeamV13Member }
  | { ok: false; state: TeamV13State; error: string };

/**
 * Vô hiệu hóa member: chỉ owner/admin active, không tự vô hiệu hóa
 * mình, không vô hiệu hóa owner cuối cùng, không vô hiệu hóa người
 * có role cao hơn hoặc bằng mình. Deactivated mất mọi quyền xem
 * vault/bot ngay (xem `visibleTeamV13VaultKeys`).
 */
export function deactivateTeamV13Member(
  state: TeamV13State,
  actor: TeamV13Member,
  targetUserId: string,
  now = Date.now(),
): TeamV13MemberActionResult {
  if (!isTeamV13MemberActive(actor)) {
    return { ok: false, state, error: 'chỉ member đang active mới được vô hiệu hóa người khác' };
  }
  if (!canTeamV13(actor.role, 'deactivate-member')) {
    return { ok: false, state, error: `role "${actor.role}" không được vô hiệu hóa member` };
  }
  const target = findTeamV13Member(state, targetUserId);
  if (!target) return { ok: false, state, error: `không tìm thấy member "${targetUserId}"` };
  if (target.id === actor.id) {
    return { ok: false, state, error: 'không được tự vô hiệu hóa chính mình' };
  }
  if (target.status === 'deactivated') {
    return { ok: false, state, error: `member "${target.id}" đã bị vô hiệu hóa rồi` };
  }
  if (TEAM_V13_ROLE_RANK[target.role] >= TEAM_V13_ROLE_RANK[actor.role]) {
    return {
      ok: false,
      state,
      error: `không được vô hiệu hóa role "${target.role}" cao hơn hoặc bằng role "${actor.role}" của bạn`,
    };
  }
  if (target.role === 'owner') {
    const owners = state.members.filter((m) => m.role === 'owner' && m.status === 'active');
    if (owners.length <= 1) {
      return { ok: false, state, error: 'không được vô hiệu hóa owner cuối cùng của team' };
    }
  }
  const member: TeamV13Member = {
    ...target,
    status: 'deactivated',
    deactivatedBy: actor.id,
    deactivatedAt: now,
  };
  return {
    ok: true,
    state: {
      ...state,
      members: state.members.map((m) => (m.id === target.id ? member : m)),
      updatedAt: now,
    },
    member,
  };
}

/** Kích hoạt lại member đã deactivate (chỉ owner/admin, cùng luật cấp bậc). */
export function reactivateTeamV13Member(
  state: TeamV13State,
  actor: TeamV13Member,
  targetUserId: string,
  now = Date.now(),
): TeamV13MemberActionResult {
  if (!isTeamV13MemberActive(actor)) {
    return { ok: false, state, error: 'chỉ member đang active mới được kích hoạt lại người khác' };
  }
  if (!canTeamV13(actor.role, 'reactivate-member')) {
    return { ok: false, state, error: `role "${actor.role}" không được kích hoạt lại member` };
  }
  const target = findTeamV13Member(state, targetUserId);
  if (!target) return { ok: false, state, error: `không tìm thấy member "${targetUserId}"` };
  if (target.status !== 'deactivated') {
    return { ok: false, state, error: `member "${target.id}" không ở trạng thái deactivated` };
  }
  if (TEAM_V13_ROLE_RANK[target.role] >= TEAM_V13_ROLE_RANK[actor.role]) {
    return {
      ok: false,
      state,
      error: `không được kích hoạt lại role "${target.role}" cao hơn hoặc bằng role "${actor.role}" của bạn`,
    };
  }
  const member: TeamV13Member = {
    ...target,
    status: 'active',
    deactivatedBy: '',
    deactivatedAt: null,
    activatedAt: now,
  };
  return {
    ok: true,
    state: {
      ...state,
      members: state.members.map((m) => (m.id === target.id ? member : m)),
      updatedAt: now,
    },
    member,
  };
}

/**
 * Đổi role member: chỉ owner được đổi role (admin không được — tránh
 * leo thang), không tự đổi role mình, không hạ owner cuối cùng,
 * role mới phải thấp hơn role của actor trừ khi actor là owner thì
 * được gán mọi role (owner là cấp cao nhất). Target phải active.
 */
export function changeTeamV13Role(
  state: TeamV13State,
  actor: TeamV13Member,
  targetUserId: string,
  newRole: TeamV13Role,
  now = Date.now(),
): TeamV13MemberActionResult {
  if (!isTeamV13MemberActive(actor)) {
    return { ok: false, state, error: 'chỉ member đang active mới được đổi role' };
  }
  if (!canTeamV13(actor.role, 'change-role')) {
    return { ok: false, state, error: `role "${actor.role}" không được đổi role member (chỉ owner)` };
  }
  if (!TEAM_V13_ROLES.includes(newRole)) {
    return { ok: false, state, error: `role mới phải là một trong: ${TEAM_V13_ROLES.join(', ')}` };
  }
  const target = findTeamV13Member(state, targetUserId);
  if (!target) return { ok: false, state, error: `không tìm thấy member "${targetUserId}"` };
  if (target.id === actor.id) {
    return { ok: false, state, error: 'không được tự đổi role chính mình' };
  }
  if (target.status !== 'active') {
    return { ok: false, state, error: `member "${target.id}" không ở trạng thái active` };
  }
  if (target.role === 'owner' && newRole !== 'owner') {
    const owners = state.members.filter((m) => m.role === 'owner' && m.status === 'active');
    if (owners.length <= 1) {
      return { ok: false, state, error: 'không được hạ cấp owner cuối cùng của team' };
    }
  }
  const member: TeamV13Member = { ...target, role: newRole };
  return {
    ok: true,
    state: {
      ...state,
      members: state.members.map((m) => (m.id === target.id ? member : m)),
      updatedAt: now,
    },
    member,
  };
}

// ---------------------------------------------------------------------------
// Vault / bot scoping
// ---------------------------------------------------------------------------

/**
 * Key vault mà một user được THẤY (giá trị vẫn do caller giữ):
 * deactivated → rỗng; user thường → chỉ key của mình; owner/admin
 * cũng chỉ thấy key của mình ở đây — xem metadata người khác dùng
 * `listTeamV13VaultKeyMeta` riêng (không kèm giá trị).
 */
export function visibleTeamV13VaultKeys(
  viewer: TeamV13Member | null | undefined,
  keys: readonly TeamV13VaultKey[],
): TeamV13VaultKey[] {
  if (!isTeamV13MemberActive(viewer)) return [];
  return keys.filter((k) => k.ownerUserId === viewer.id);
}

/**
 * Metadata key vault cho quản trị: owner/admin active thấy metadata
 * (tên + chủ + hint) của mọi key; member/viewer chỉ thấy của mình.
 * Kết quả KHÔNG bao giờ chứa giá trị secret.
 */
export function listTeamV13VaultKeyMeta(
  viewer: TeamV13Member | null | undefined,
  keys: readonly TeamV13VaultKey[],
): { name: string; ownerUserId: string; namespace: string; hint: string; createdAt: number }[] {
  if (!isTeamV13MemberActive(viewer)) return [];
  const scoped = viewer.role === 'owner' || viewer.role === 'admin'
    ? [...keys]
    : keys.filter((k) => k.ownerUserId === viewer.id);
  return scoped.map((k) => ({
    name: k.name,
    ownerUserId: k.ownerUserId,
    namespace: k.namespace,
    hint: k.hint,
    createdAt: k.createdAt,
  }));
}

/** True khi user được đọc GIÁ TRỊ của một key (chỉ chủ key, đang active). */
export function canReadTeamV13KeyValue(
  viewer: TeamV13Member | null | undefined,
  key: TeamV13VaultKey | null | undefined,
): boolean {
  if (!isTeamV13MemberActive(viewer) || !key) return false;
  return key.ownerUserId === viewer.id;
}

/** Bot mà một user được thấy: deactivated → rỗng, còn lại chỉ bot của mình. */
export function visibleTeamV13Bots(
  viewer: TeamV13Member | null | undefined,
  bots: readonly TeamV13Bot[],
): TeamV13Bot[] {
  if (!isTeamV13MemberActive(viewer)) return [];
  return bots.filter((b) => b.ownerUserId === viewer.id);
}

/** True khi user được chạy/quản lý một bot (chủ bot + có quyền run-bots). */
export function canManageTeamV13Bot(
  viewer: TeamV13Member | null | undefined,
  bot: TeamV13Bot | null | undefined,
): boolean {
  if (!isTeamV13MemberActive(viewer) || !bot) return false;
  return bot.ownerUserId === viewer.id && canTeamV13(viewer.role, 'manage-own-bots');
}

// ---------------------------------------------------------------------------
// Audit log (chuỗi hash)
// ---------------------------------------------------------------------------

/** Hash của một audit event (nội dung + hash event trước). */
export function hashTeamV13AuditEvent(
  event: Omit<TeamV13AuditEvent, 'hash'>,
): string {
  const payload = JSON.stringify({
    seq: event.seq,
    at: event.at,
    actorUserId: event.actorUserId,
    actorRole: event.actorRole,
    action: event.action,
    targetUserId: event.targetUserId,
    detail: event.detail,
    prevHash: event.prevHash,
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Ghi một event audit nhạy cảm (hàm thuần): nối vào chuỗi hash, cắt
 * bộ nhớ ở TEAM_V13_MAX_AUDIT_EVENTS (file JSONL giữ toàn bộ).
 * Actor deactivated vẫn ghi được (để lưu dấu vết hành vi bị chặn)?
 * Không — caller chỉ ghi event của actor active; hàm này từ chối
 * actor rỗng để audit không có event vô chủ.
 */
export type TeamV13AuditResult =
  | { ok: true; state: TeamV13State; event: TeamV13AuditEvent }
  | { ok: false; state: TeamV13State; error: string };

export function appendTeamV13AuditEvent(
  state: TeamV13State,
  input: {
    actorUserId: string;
    actorRole: TeamV13Role;
    action: string;
    targetUserId?: string;
    detail?: string;
  },
  now = Date.now(),
): TeamV13AuditResult {
  if (!isNonEmptyString(input?.actorUserId)) {
    return { ok: false, state, error: 'audit event cần actorUserId' };
  }
  if (!isNonEmptyString(input?.action)) {
    return { ok: false, state, error: 'audit event cần action' };
  }
  if (!TEAM_V13_ROLES.includes(input.actorRole)) {
    return { ok: false, state, error: `actorRole phải là một trong: ${TEAM_V13_ROLES.join(', ')}` };
  }
  const prev = state.auditEvents[state.auditEvents.length - 1];
  const base: Omit<TeamV13AuditEvent, 'hash'> = {
    seq: prev ? prev.seq + 1 : 1,
    at: now,
    actorUserId: input.actorUserId.trim(),
    actorRole: input.actorRole,
    action: input.action.trim(),
    targetUserId: input.targetUserId?.trim() ?? '',
    detail: input.detail?.trim() ?? '',
    prevHash: prev ? prev.hash : '',
  };
  const event: TeamV13AuditEvent = { ...base, hash: hashTeamV13AuditEvent(base) };
  const auditEvents = [...state.auditEvents, event].slice(-TEAM_V13_MAX_AUDIT_EVENTS);
  return { ok: true, state: { ...state, auditEvents, updatedAt: now }, event };
}

/** Kết quả verify chuỗi audit. */
export interface TeamV13AuditVerifyResult {
  ok: boolean;
  checked: number;
  /** Số dòng của event đầu tiên bị hỏng (-1 khi chuỗi nguyên vẹn). */
  badSeq: number;
  reason: string;
}

/**
 * Verify chuỗi audit: từng event hash phải khớp nội dung + prevHash
 * phải bằng hash event trước. Trả về dòng đầu tiên hỏng để UI chỉ
 * rõ chỗ bị sửa/xóa.
 */
export function verifyTeamV13AuditLog(events: readonly TeamV13AuditEvent[]): TeamV13AuditVerifyResult {
  let prevHash = '';
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.prevHash !== prevHash) {
      return {
        ok: false,
        checked: i,
        badSeq: e.seq,
        reason: `event seq ${e.seq}: prevHash không khớp hash event trước (log có thể đã bị xóa/sửa dòng)`,
      };
    }
    const { hash, ...base } = e;
    if (hashTeamV13AuditEvent(base) !== hash) {
      return {
        ok: false,
        checked: i,
        badSeq: e.seq,
        reason: `event seq ${e.seq}: hash không khớp nội dung (nội dung đã bị sửa sau khi ghi)`,
      };
    }
    if (i > 0 && e.seq !== events[i - 1].seq + 1) {
      return {
        ok: false,
        checked: i,
        badSeq: e.seq,
        reason: `event seq ${e.seq}: seq không liên tục (thiếu event ${events[i - 1].seq + 1})`,
      };
    }
    prevHash = hash;
  }
  return { ok: true, checked: events.length, badSeq: -1, reason: `chuỗi audit nguyên vẹn (${events.length} event)` };
}

/** Lọc audit event theo actor/action/khoảng thời gian (cho panel UI). */
export function filterTeamV13AuditEvents(
  events: readonly TeamV13AuditEvent[],
  filter: { actorUserId?: string; action?: string; fromAt?: number; toAt?: number },
): TeamV13AuditEvent[] {
  return events.filter((e) => {
    if (filter.actorUserId && e.actorUserId !== filter.actorUserId) return false;
    if (filter.action && e.action !== filter.action) return false;
    if (typeof filter.fromAt === 'number' && e.at < filter.fromAt) return false;
    if (typeof filter.toAt === 'number' && e.at > filter.toAt) return false;
    return true;
  });
}

/** Tóm tắt team cho UI: số member theo role/status, invite mở, audit. */
export interface TeamV13Summary {
  teamName: string;
  memberCount: number;
  activeCount: number;
  deactivatedCount: number;
  owners: number;
  admins: number;
  openInvites: number;
  auditEventCount: number;
  summary: string;
}

export function summarizeTeamV13(state: TeamV13State, now = Date.now()): TeamV13Summary {
  const active = state.members.filter((m) => m.status === 'active');
  const openInvites = state.invites.filter((i) => !i.used && i.expiresAt > now).length;
  return {
    teamName: state.teamName,
    memberCount: state.members.length,
    activeCount: active.length,
    deactivatedCount: state.members.filter((m) => m.status === 'deactivated').length,
    owners: active.filter((m) => m.role === 'owner').length,
    admins: active.filter((m) => m.role === 'admin').length,
    openInvites,
    auditEventCount: state.auditEvents.length,
    summary:
      state.members.length === 0
        ? `Team "${state.teamName}" chưa có member nào.`
        : `Team "${state.teamName}": ${active.length}/${state.members.length} member active, ` +
          `${openInvites} invite đang mở, ${state.auditEvents.length} audit event.`,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function getTeamV13StatePath(teamRoot: string): string {
  return path.join(teamRoot, TEAM_V13_STATE_FILE);
}

export function getTeamV13AuditPath(teamRoot: string): string {
  return path.join(teamRoot, TEAM_V13_AUDIT_FILE);
}

function atomicWriteFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Nền tảng không hỗ trợ chmod (Windows) — file vẫn dùng được.
  }
}

function isValidMember(v: unknown): v is TeamV13Member {
  if (!v || typeof v !== 'object') return false;
  const m = v as Partial<TeamV13Member>;
  return (
    typeof m.id === 'string' &&
    typeof m.email === 'string' &&
    TEAM_V13_ROLES.includes(m.role as TeamV13Role) &&
    TEAM_V13_MEMBER_STATUSES.includes(m.status as TeamV13MemberStatus)
  );
}

function isValidInvite(v: unknown): v is TeamV13Invite {
  if (!v || typeof v !== 'object') return false;
  const i = v as Partial<TeamV13Invite>;
  return (
    typeof i.id === 'string' &&
    typeof i.email === 'string' &&
    typeof i.tokenHash === 'string' &&
    typeof i.expiresAt === 'number'
  );
}

function isValidAuditEvent(v: unknown): v is TeamV13AuditEvent {
  if (!v || typeof v !== 'object') return false;
  const e = v as Partial<TeamV13AuditEvent>;
  return (
    typeof e.seq === 'number' &&
    typeof e.hash === 'string' &&
    typeof e.action === 'string' &&
    typeof e.actorUserId === 'string'
  );
}

export function loadTeamV13State(teamRoot: string): TeamV13State | null {
  try {
    const raw = fs.readFileSync(getTeamV13StatePath(teamRoot), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const p = parsed as Partial<TeamV13State>;
    if (p.version !== 1 || !Array.isArray(p.members) || !Array.isArray(p.invites)) return null;
    return {
      version: 1,
      teamName: typeof p.teamName === 'string' ? p.teamName : '',
      members: p.members.filter(isValidMember).slice(0, TEAM_V13_MAX_MEMBERS),
      invites: (p.invites as unknown[]).filter(isValidInvite).slice(0, TEAM_V13_MAX_INVITES),
      auditEvents: Array.isArray(p.auditEvents)
        ? (p.auditEvents as unknown[]).filter(isValidAuditEvent).slice(-TEAM_V13_MAX_AUDIT_EVENTS)
        : [],
      updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

export function saveTeamV13State(teamRoot: string, state: TeamV13State): void {
  atomicWriteFile(getTeamV13StatePath(teamRoot), `${JSON.stringify(state, null, 2)}\n`);
}

/** Ghi thêm một event audit xuống file JSONL (append, 0600 khi tạo mới). */
export function appendTeamV13AuditToFile(teamRoot: string, event: TeamV13AuditEvent): void {
  const filePath = getTeamV13AuditPath(teamRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

/** Đọc toàn bộ audit log từ file JSONL (dòng hỏng bị bỏ qua, có đếm). */
export function readTeamV13AuditFromFile(teamRoot: string): {
  events: TeamV13AuditEvent[];
  skippedLines: number;
} {
  try {
    const raw = fs.readFileSync(getTeamV13AuditPath(teamRoot), 'utf8');
    const events: TeamV13AuditEvent[] = [];
    let skippedLines = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isValidAuditEvent(parsed)) events.push(parsed);
        else skippedLines++;
      } catch {
        skippedLines++;
      }
    }
    return { events, skippedLines };
  } catch {
    return { events: [], skippedLines: 0 };
  }
}
