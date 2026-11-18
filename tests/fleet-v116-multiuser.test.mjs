/**
 * Multi-user / team v2 tests (v1.16, Đội T6 — node:test, no network).
 *
 * Covers:
 * - Permission matrix: owner làm mọi thứ; admin không đổi role;
 *   member quản lý vault/bot của mình; viewer chỉ đọc + chạy bot;
 *   role lạ / null → không quyền nào (fail-closed).
 * - Add member: member đầu tiên phải là owner; trùng id/email lỗi;
 *   email sai định dạng lỗi.
 * - Invite: admin không mời role >= mình; token chỉ lưu hash
 *   (state không chứa token gốc); accept đúng token → active,
 *   invite đánh used; token sai/hết hạn/dùng lại → cùng lỗi chung.
 * - Deactivate/reactivate: không tự vô hiệu hóa mình, không vô hiệu
 *   hóa người cấp cao hơn/bằng, không vô hiệu hóa owner cuối cùng;
 *   deactivated mất quyền xem vault/bot ngay.
 * - Change role: chỉ owner; không tự đổi mình; không hạ owner cuối.
 * - Vault scoping: mỗi user chỉ thấy key của mình; admin/owner xem
 *   được metadata key người khác nhưng KHÔNG đọc được giá trị;
 *   deactivated không thấy gì.
 * - Audit log: chuỗi hash nối tiếp; sửa nội dung / xóa dòng / đảo
 *   seq → verify fail đúng dòng; filter theo actor/action.
 * - Persistence: save/load round-trip, file hỏng → null.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v116-multiuser.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  TEAM_V13_PERMISSIONS,
  TEAM_V13_ROLES,
  acceptTeamV13Invite,
  addTeamV13Member,
  appendTeamV13AuditEvent,
  appendTeamV13AuditToFile,
  canReadTeamV13KeyValue,
  canTeamV13,
  changeTeamV13Role,
  createTeamV13State,
  createTeamV13VaultKey,
  deactivateTeamV13Member,
  filterTeamV13AuditEvents,
  findTeamV13Member,
  inviteTeamV13Member,
  isTeamV13MemberActive,
  listTeamV13VaultKeyMeta,
  loadTeamV13State,
  reactivateTeamV13Member,
  readTeamV13AuditFromFile,
  saveTeamV13State,
  summarizeTeamV13,
  validateTeamV13VaultKeyName,
  verifyTeamV13AuditLog,
  visibleTeamV13Bots,
  visibleTeamV13VaultKeys,
} from '../packages/core/dist/fleetV13/index.js';

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);

function tmpTeamRoot() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-team-v13-')), 'team');
}

function makeTeam() {
  let state = createTeamV13State('Team Test', T0);
  const ownerRes = addTeamV13Member(
    state,
    { id: 'u_owner', displayName: 'Owner', email: 'owner@example.com', role: 'owner' },
    'system',
    T0,
  );
  assert.equal(ownerRes.ok, true);
  state = ownerRes.state;
  const adminRes = addTeamV13Member(
    state,
    { id: 'u_admin', displayName: 'Admin', email: 'admin@example.com', role: 'admin' },
    'u_owner',
    T0 + 1,
  );
  assert.equal(adminRes.ok, true);
  state = adminRes.state;
  const memberRes = addTeamV13Member(
    state,
    { id: 'u_member', displayName: 'Member', email: 'member@example.com', role: 'member' },
    'u_owner',
    T0 + 2,
  );
  assert.equal(memberRes.ok, true);
  state = memberRes.state;
  const viewerRes = addTeamV13Member(
    state,
    { id: 'u_viewer', displayName: 'Viewer', email: 'viewer@example.com', role: 'viewer' },
    'u_owner',
    T0 + 3,
  );
  assert.equal(viewerRes.ok, true);
  return viewerRes.state;
}

test('permission matrix: owner all, admin no change-role, viewer read-only, unknown fail-closed', () => {
  assert.equal(canTeamV13('owner', 'change-role'), true);
  assert.equal(canTeamV13('owner', 'view-audit'), true);
  assert.equal(canTeamV13('admin', 'change-role'), false);
  assert.equal(canTeamV13('admin', 'invite-member'), true);
  assert.equal(canTeamV13('admin', 'manage-fleet'), true);
  assert.equal(canTeamV13('member', 'manage-own-vault'), true);
  assert.equal(canTeamV13('member', 'invite-member'), false);
  assert.equal(canTeamV13('member', 'manage-fleet'), false);
  assert.equal(canTeamV13('viewer', 'run-bots'), true);
  assert.equal(canTeamV13('viewer', 'manage-own-vault'), false);
  assert.equal(canTeamV13('viewer', 'view-audit'), false);
  assert.equal(canTeamV13(null, 'run-bots'), false);
  assert.equal(canTeamV13('superuser', 'run-bots'), false);
  assert.equal(canTeamV13(undefined, 'view-members'), false);
  // Mọi role đều có trong ma trận; owner có đủ mọi action.
  for (const role of TEAM_V13_ROLES) {
    assert.ok(Array.isArray(TEAM_V13_PERMISSIONS[role]));
  }
  assert.equal(TEAM_V13_PERMISSIONS.owner.length, 13);
});

test('add member: first must be owner, duplicate id/email rejected, bad email rejected', () => {
  const empty = createTeamV13State('Empty', T0);
  const notOwner = addTeamV13Member(
    empty,
    { id: 'u1', displayName: 'A', email: 'a@example.com', role: 'member' },
    'system',
    T0,
  );
  assert.equal(notOwner.ok, false);
  assert.match(notOwner.error, /phải là owner/);
  const badEmail = addTeamV13Member(
    empty,
    { id: 'u1', displayName: 'A', email: 'not-an-email', role: 'owner' },
    'system',
    T0,
  );
  assert.equal(badEmail.ok, false);
  assert.match(badEmail.error, /email/);

  const state = makeTeam();
  const dupId = addTeamV13Member(
    state,
    { id: 'u_member', displayName: 'Dup', email: 'dup@example.com', role: 'member' },
    'u_owner',
    T0,
  );
  assert.equal(dupId.ok, false);
  assert.match(dupId.error, /đã tồn tại/);
  const dupEmail = addTeamV13Member(
    state,
    { id: 'u_new', displayName: 'Dup', email: 'member@example.com', role: 'member' },
    'u_owner',
    T0,
  );
  assert.equal(dupEmail.ok, false);
  assert.match(dupEmail.error, /email/);
  assert.equal(findTeamV13Member(state, 'u_owner')?.role, 'owner');
  assert.equal(findTeamV13Member(state, 'nope'), null);
  assert.equal(isTeamV13MemberActive(findTeamV13Member(state, 'u_member')), true);
  assert.equal(isTeamV13MemberActive(null), false);
});

test('invite: admin cannot invite admin/owner; token stored as hash only; accept flow', () => {
  let state = makeTeam();
  const owner = findTeamV13Member(state, 'u_owner');
  const admin = findTeamV13Member(state, 'u_admin');
  assert.ok(owner && admin);

  const tooHigh = inviteTeamV13Member(state, admin, 'new-admin@example.com', 'admin', T0);
  assert.equal(tooHigh.ok, false);
  assert.match(tooHigh.error, /cao hơn hoặc bằng/);
  const tooHighOwner = inviteTeamV13Member(state, admin, 'new-owner@example.com', 'owner', T0);
  assert.equal(tooHighOwner.ok, false);

  const invited = inviteTeamV13Member(state, admin, 'newbie@example.com', 'member', T0);
  assert.equal(invited.ok, true);
  assert.ok(invited.token.length >= 64);
  state = invited.state;
  // State chỉ lưu hash token, không chứa token gốc.
  assert.equal(JSON.stringify(state).includes(invited.token), false);
  assert.equal(invited.invite.tokenHash.length, 64);
  assert.equal(invited.invite.expiresAt, T0 + 7 * 24 * 60 * 60 * 1000);
  assert.equal(invited.invite.used, false);

  // Invite trùng email đang mở → lỗi.
  const dupInvite = inviteTeamV13Member(state, owner, 'newbie@example.com', 'viewer', T0 + 10);
  assert.equal(dupInvite.ok, false);

  // Token sai → lỗi chung (không lộ invite nào tồn tại).
  const wrong = acceptTeamV13Invite(state, '0'.repeat(64), { id: 'u_newbie', displayName: 'Newbie' }, T0 + 20);
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error, 'invite không hợp lệ hoặc đã hết hạn');

  const accepted = acceptTeamV13Invite(state, invited.token, { id: 'u_newbie', displayName: 'Newbie' }, T0 + 20);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.member.status, 'active');
  assert.equal(accepted.member.role, 'member');
  assert.equal(accepted.member.email, 'newbie@example.com');
  state = accepted.state;

  // Dùng lại token → lỗi.
  const reuse = acceptTeamV13Invite(state, invited.token, { id: 'u_newbie2', displayName: 'N2' }, T0 + 30);
  assert.equal(reuse.ok, false);

  // Invite hết hạn → lỗi.
  const exp = inviteTeamV13Member(state, owner, 'late@example.com', 'viewer', T0);
  assert.equal(exp.ok, true);
  const late = acceptTeamV13Invite(exp.state, exp.token, { id: 'u_late', displayName: 'Late' }, T0 + 8 * 24 * 60 * 60 * 1000);
  assert.equal(late.ok, false);
  assert.equal(late.error, 'invite không hợp lệ hoặc đã hết hạn');
});

test('deactivate/reactivate: self, higher rank, last owner blocked; deactivated loses vault/bot access', () => {
  let state = makeTeam();
  const owner = findTeamV13Member(state, 'u_owner');
  const admin = findTeamV13Member(state, 'u_admin');
  const member = findTeamV13Member(state, 'u_member');
  assert.ok(owner && admin && member);

  const selfDeact = deactivateTeamV13Member(state, admin, 'u_admin', T0);
  assert.equal(selfDeact.ok, false);
  assert.match(selfDeact.error, /chính mình/);
  const higherDeact = deactivateTeamV13Member(state, admin, 'u_owner', T0);
  assert.equal(higherDeact.ok, false);
  const lastOwner = deactivateTeamV13Member(state, owner, 'u_owner', T0);
  assert.equal(lastOwner.ok, false); // tự vô hiệu hóa mình cũng bị chặn trước

  const deacted = deactivateTeamV13Member(state, admin, 'u_member', T0 + 5);
  assert.equal(deacted.ok, true);
  assert.equal(deacted.member.status, 'deactivated');
  assert.equal(deacted.member.deactivatedBy, 'u_admin');
  state = deacted.state;

  const deactivatedMember = findTeamV13Member(state, 'u_member');
  assert.equal(isTeamV13MemberActive(deactivatedMember), false);
  const keys = [
    createTeamV13VaultKey('u_member', 'openai-api-key', 'sk-...', T0),
    createTeamV13VaultKey('u_admin', 'openai-api-key', 'sk-...', T0),
  ];
  assert.deepEqual(visibleTeamV13VaultKeys(deactivatedMember, keys), []);
  assert.deepEqual(visibleTeamV13Bots(deactivatedMember, [{ id: 'b1', name: 'B', ownerUserId: 'u_member', createdAt: T0 }]), []);

  // Deactivate lần nữa → lỗi.
  assert.equal(deactivateTeamV13Member(state, admin, 'u_member', T0 + 6).ok, false);
  // Reactivate bởi viewer → lỗi (viewer không có quyền).
  const viewer = findTeamV13Member(state, 'u_viewer');
  assert.ok(viewer);
  assert.equal(reactivateTeamV13Member(state, viewer, 'u_member', T0 + 7).ok, false);
  const reactivated = reactivateTeamV13Member(state, admin, 'u_member', T0 + 8);
  assert.equal(reactivated.ok, true);
  assert.equal(reactivated.member.status, 'active');
  assert.equal(reactivated.member.deactivatedAt, null);
});

test('change role: only owner; cannot demote last owner; cannot self-change', () => {
  let state = makeTeam();
  const owner = findTeamV13Member(state, 'u_owner');
  const admin = findTeamV13Member(state, 'u_admin');
  assert.ok(owner && admin);
  assert.equal(changeTeamV13Role(state, admin, 'u_member', 'viewer', T0).ok, false);
  assert.equal(changeTeamV13Role(state, owner, 'u_owner', 'admin', T0).ok, false);
  const demoteOwner = changeTeamV13Role(state, owner, 'u_owner', 'member', T0);
  assert.equal(demoteOwner.ok, false);
  assert.match(demoteOwner.error, /chính mình/);
  const changed = changeTeamV13Role(state, owner, 'u_member', 'viewer', T0 + 5);
  assert.equal(changed.ok, true);
  assert.equal(changed.member.role, 'viewer');
  state = changed.state;
  assert.equal(findTeamV13Member(state, 'u_member')?.role, 'viewer');
  // Hạ owner khi còn 2 owner thì được: thêm owner thứ hai trước.
  const second = addTeamV13Member(
    state,
    { id: 'u_owner2', displayName: 'Owner 2', email: 'owner2@example.com', role: 'owner' },
    'u_owner',
    T0 + 6,
  );
  assert.equal(second.ok, true);
  const demote = changeTeamV13Role(second.state, owner, 'u_owner2', 'admin', T0 + 7);
  assert.equal(demote.ok, true);
  assert.equal(demote.member.role, 'admin');
});

test('vault scoping: own keys only; admin sees others metadata but not values; key name validation', () => {
  const state = makeTeam();
  const member = findTeamV13Member(state, 'u_member');
  const admin = findTeamV13Member(state, 'u_admin');
  const viewer = findTeamV13Member(state, 'u_viewer');
  assert.ok(member && admin && viewer);
  const keys = [
    createTeamV13VaultKey('u_member', 'openai-api-key', 'sk-...m1', T0),
    createTeamV13VaultKey('u_member', 'gemini-api-key', 'AIza...', T0),
    createTeamV13VaultKey('u_admin', 'openai-api-key', 'sk-...a1', T0),
  ];
  assert.equal(keys[0].namespace, 'u:u_member:openai-api-key');
  assert.deepEqual(visibleTeamV13VaultKeys(member, keys).map((k) => k.name), ['openai-api-key', 'gemini-api-key']);
  assert.deepEqual(visibleTeamV13VaultKeys(admin, keys).map((k) => k.name), ['openai-api-key']);
  assert.deepEqual(visibleTeamV13VaultKeys(viewer, keys), []);
  // Admin thấy metadata key người khác nhưng không đọc được giá trị.
  const meta = listTeamV13VaultKeyMeta(admin, keys);
  assert.equal(meta.length, 3);
  assert.equal(meta.some((m) => m.ownerUserId === 'u_member'), true);
  assert.equal('value' in meta[0], false);
  assert.equal(canReadTeamV13KeyValue(member, keys[0]), true);
  assert.equal(canReadTeamV13KeyValue(admin, keys[0]), false);
  assert.equal(canReadTeamV13KeyValue(admin, keys[2]), true);
  assert.equal(canReadTeamV13KeyValue(null, keys[0]), false);
  assert.equal(canReadTeamV13KeyValue(member, null), false);

  const bots = [
    { id: 'b1', name: 'Bot A', ownerUserId: 'u_member', createdAt: T0 },
    { id: 'b2', name: 'Bot B', ownerUserId: 'u_admin', createdAt: T0 },
  ];
  assert.deepEqual(visibleTeamV13Bots(member, bots).map((b) => b.id), ['b1']);
  assert.deepEqual(visibleTeamV13Bots(null, bots), []);

  assert.deepEqual(validateTeamV13VaultKeyName('openai-api-key'), []);
  assert.ok(validateTeamV13VaultKeyName('').length > 0);
  assert.ok(validateTeamV13VaultKeyName('has space').length > 0);
  assert.ok(validateTeamV13VaultKeyName('has:colon').length > 0);
});

test('audit log: hash chain verifies; tamper/delete/seq-gap detected at the right event', () => {
  let state = createTeamV13State('Audit Team', T0);
  const ownerRes = addTeamV13Member(
    state,
    { id: 'u_owner', displayName: 'Owner', email: 'owner@example.com', role: 'owner' },
    'system',
    T0,
  );
  state = ownerRes.state;
  const e1 = appendTeamV13AuditEvent(state, { actorUserId: 'u_owner', actorRole: 'owner', action: 'invite-member', targetUserId: 'u_new', detail: 'invited newbie' }, T0 + 1);
  assert.equal(e1.ok, true);
  state = e1.state;
  const e2 = appendTeamV13AuditEvent(state, { actorUserId: 'u_owner', actorRole: 'owner', action: 'deactivate-member', targetUserId: 'u_old', detail: 'deactivated' }, T0 + 2);
  assert.equal(e2.ok, true);
  state = e2.state;
  assert.equal(e1.event.seq, 1);
  assert.equal(e2.event.seq, 2);
  assert.equal(e2.event.prevHash, e1.event.hash);
  assert.equal(e1.event.prevHash, '');

  const ok = verifyTeamV13AuditLog(state.auditEvents);
  assert.equal(ok.ok, true);
  assert.equal(ok.checked, 2);

  // Sửa nội dung event 2 → fail tại seq 2.
  const tampered = state.auditEvents.map((e, i) => (i === 1 ? { ...e, detail: 'forged' } : e));
  const badTamper = verifyTeamV13AuditLog(tampered);
  assert.equal(badTamper.ok, false);
  assert.equal(badTamper.badSeq, 2);
  assert.match(badTamper.reason, /hash không khớp/);

  // Xóa event 1 → fail tại seq 2 (prevHash không khớp).
  const deleted = verifyTeamV13AuditLog(state.auditEvents.slice(1));
  assert.equal(deleted.ok, false);
  assert.equal(deleted.badSeq, 2);

  // Đổi seq → fail.
  const seqGap = state.auditEvents.map((e, i) => (i === 1 ? { ...e, seq: 5 } : e));
  assert.equal(verifyTeamV13AuditLog(seqGap).ok, false);

  // Filter theo actor/action.
  assert.equal(filterTeamV13AuditEvents(state.auditEvents, { action: 'invite-member' }).length, 1);
  assert.equal(filterTeamV13AuditEvents(state.auditEvents, { actorUserId: 'nobody' }).length, 0);
  assert.equal(filterTeamV13AuditEvents(state.auditEvents, { fromAt: T0 + 2 }).length, 1);

  // Actor rỗng / action rỗng → từ chối ghi.
  assert.equal(appendTeamV13AuditEvent(state, { actorUserId: '', actorRole: 'owner', action: 'x' }, T0).ok, false);
  assert.equal(appendTeamV13AuditEvent(state, { actorUserId: 'u_owner', actorRole: 'owner', action: '' }, T0).ok, false);

  const summary = summarizeTeamV13(state);
  assert.equal(summary.memberCount, 1);
  assert.equal(summary.auditEventCount, 2);
  assert.match(summary.summary, /Team "Audit Team"/);
});

test('persistence: save/load round-trip; corrupt file returns null; audit JSONL append/read', () => {
  const root = tmpTeamRoot();
  const state = makeTeam();
  saveTeamV13State(root, state);
  const loaded = loadTeamV13State(root);
  assert.ok(loaded);
  assert.equal(loaded.teamName, 'Team Test');
  assert.equal(loaded.members.length, 4);
  assert.equal(loaded.members[0].id, 'u_owner');

  // File hỏng → null.
  fs.writeFileSync(path.join(root, 'team-v116.json'), '{not json');
  assert.equal(loadTeamV13State(root), null);
  // Không có file → null.
  assert.equal(loadTeamV13State(path.join(root, 'missing')), null);

  // Audit JSONL: append + read, dòng hỏng bị bỏ qua có đếm.
  const auditRoot = tmpTeamRoot();
  const ev = appendTeamV13AuditEvent(state, { actorUserId: 'u_owner', actorRole: 'owner', action: 'invite-member', targetUserId: 'u_x', detail: 'd1' }, T0);
  assert.equal(ev.ok, true);
  appendTeamV13AuditToFile(auditRoot, ev.event);
  fs.appendFileSync(path.join(auditRoot, 'team-audit-v116.jsonl'), '{bad line\n');
  const readBack = readTeamV13AuditFromFile(auditRoot);
  assert.equal(readBack.events.length, 1);
  assert.equal(readBack.skippedLines, 1);
  assert.equal(readBack.events[0].action, 'invite-member');
  assert.deepEqual(readTeamV13AuditFromFile(path.join(auditRoot, 'missing')), { events: [], skippedLines: 0 });
});
