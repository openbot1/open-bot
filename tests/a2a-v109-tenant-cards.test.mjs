/**
 * Tests v1.09 (Đội T4): multi-tenant Agent Cards + A2A task streaming v1.1.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/a2a-v109-tenant-cards.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TenantCardRegistry,
  buildAgentCardV11,
  buildTenantCard,
  canTenantStartTask,
  canTenantStream,
  canTenantUseSkill,
  defaultTenantPermissions,
  generateA2aSigningKey,
  isValidAgentCardV11,
  mergeArtifactChunks,
  TaskStreamLog,
  TaskStreamView,
  seedTaskStreamEvents,
} from '../packages/core/dist/index.js';
import { verifyAgentCardSignature } from '../packages/core/dist/a2a/signing.js';

function baseCard() {
  return buildAgentCardV11({
    name: 'open-bot',
    description: 'Local-first agent',
    url: 'http://127.0.0.1:8765/',
    streaming: true,
    pushNotifications: true,
    resumableStreams: true,
    multiTenancy: true,
    skills: [
      { id: 'search', name: 'Search', description: 'Search' },
      { id: 'read', name: 'Read', description: 'Read' },
      { id: 'write', name: 'Write', description: 'Write' },
    ],
  });
}

test('tenantCards: đăng ký tenant — card con lọc skill + thu hẹp capability', () => {
  const registry = new TenantCardRegistry(baseCard());
  const entry = registry.registerTenant({
    tenantId: 'team-alpha',
    displayName: 'Team Alpha',
    allowedSkillIds: ['search', 'read'],
    permissions: { canUsePush: false },
  });
  assert.equal(entry.tenantId, 'team-alpha');
  assert.equal(entry.card.skills?.length, 2);
  assert.deepEqual(entry.card.skills?.map((s) => s.id), ['search', 'read']);
  assert.equal(entry.card.capabilities?.pushNotifications, false);
  assert.equal(entry.card.capabilities?.streaming, true);
  assert.equal(entry.card.capabilities?.multiTenancy, true);
  assert.equal(entry.card.tenants?.[0].tenantId, 'team-alpha');
  assert.equal(isValidAgentCardV11(entry.card), true);
  assert.equal(registry.tenantCount, 1);
  assert.equal(registry.hasTenant('team-alpha'), true);
  assert.equal(registry.hasTenant('team-beta'), false);
});

test('tenantCards: cô lập — tenant B không lấy được card tenant A, tenant lạ -> undefined', () => {
  const registry = new TenantCardRegistry(baseCard());
  registry.registerTenant({ tenantId: 'team-a', allowedSkillIds: ['search'] });
  registry.registerTenant({ tenantId: 'team-b', allowedSkillIds: ['write'] });
  const cardA = registry.getCardForTenant('team-a');
  const cardB = registry.getCardForTenant('team-b');
  assert.deepEqual(cardA?.skills?.map((s) => s.id), ['search']);
  assert.deepEqual(cardB?.skills?.map((s) => s.id), ['write']);
  assert.notDeepEqual(cardA?.skills, cardB?.skills);
  assert.equal(registry.getCardForTenant('team-ghost'), undefined);
  assert.equal(registry.getCardForTenant('../evil'), undefined);
  assert.equal(registry.getTenant('team-ghost'), undefined);
  // Tenant mặc định chưa đăng ký riêng -> card gốc.
  const def = registry.getCardForTenant('default');
  assert.equal(def?.name, 'open-bot');
  assert.equal(def?.skills?.length, 3);
});

test('tenantCards: tenantId sai định dạng / trùng -> throw', () => {
  const registry = new TenantCardRegistry(baseCard());
  assert.throws(() => registry.registerTenant({ tenantId: 'bad id!' }), /không hợp lệ/);
  registry.registerTenant({ tenantId: 'team-a' });
  assert.throws(() => registry.registerTenant({ tenantId: 'team-a' }), /đã đăng ký/);
  assert.throws(() => buildTenantCard(baseCard(), 'x y', defaultTenantPermissions()), /không hợp lệ/);
});

test('tenantCards: ký card con + verify chữ ký; đổi quyền không đổi card', () => {
  const registry = new TenantCardRegistry(baseCard());
  const key = generateA2aSigningKey();
  registry.registerTenant({ tenantId: 'team-a', allowedSkillIds: ['search'] });
  const signed = registry.signTenantCard('team-a', key);
  assert.equal(signed.signed, true);
  const verified = verifyAgentCardSignature(signed.card);
  assert.equal(verified.ok, true);
  assert.equal(verified.keyId, key.keyId);
  // Card con bị sửa sau khi ký -> verify fail.
  const tampered = { ...signed.card, description: 'giả mạo' };
  assert.equal(verifyAgentCardSignature(tampered).ok, false);
  const updated = registry.updateTenantPermissions('team-a', { maxConcurrentTasks: 2 });
  assert.equal(updated.permissions.maxConcurrentTasks, 2);
  assert.equal(updated.card.skills?.length, 1);
  assert.equal(registry.removeTenant('team-a'), true);
  assert.equal(registry.removeTenant('team-a'), false);
  assert.throws(() => registry.signTenantCard('team-a', key), /chưa đăng ký/);
});

test('tenantCards: quyền — skill allowlist, giới hạn task đồng thời, stream', () => {
  const perms = { ...defaultTenantPermissions(), allowedSkillIds: ['search'], maxConcurrentTasks: 1 };
  assert.equal(canTenantUseSkill(perms, 'search'), true);
  assert.equal(canTenantUseSkill(perms, 'write'), false);
  assert.equal(canTenantUseSkill(defaultTenantPermissions(), 'anything'), true);
  assert.deepEqual(canTenantStartTask(perms, 0), { allowed: true });
  assert.equal(canTenantStartTask(perms, 1).allowed, false);
  assert.match(canTenantStartTask(perms, 1).reason ?? '', /đồng thời/);
  assert.equal(canTenantStartTask({ ...perms, canSendTasks: false }, 0).allowed, false);
  assert.equal(canTenantStream(perms), true);
  assert.equal(canTenantStream({ ...perms, canStream: false }), false);
  const card = registryDiscoveryCard();
  assert.equal(card.tenants?.length, 2);
  function registryDiscoveryCard() {
    const r = new TenantCardRegistry(baseCard());
    r.registerTenant({ tenantId: 't1' });
    r.registerTenant({ tenantId: 't2', displayName: 'Team 2' });
    return r.buildDiscoveryCard();
  }
});

test('taskStream: log append + replay + checkpoint + view ghép đúng trạng thái', () => {
  const log = new TaskStreamLog('task-1', 'team-a');
  const e0 = log.appendStatus('submitted');
  const e1 = log.appendStatus('working');
  const e2 = log.appendMessage('hello ');
  const e3 = log.appendMessage('world');
  const e4 = log.appendArtifactComplete({
    artifactId: 'a1', name: 'out', parts: [{ kind: 'text', text: 'done' }],
  });
  const e5 = log.appendStatus('completed');
  assert.deepEqual([e0.sequence, e1.sequence, e2.sequence, e3.sequence, e4.sequence, e5.sequence], [0, 1, 2, 3, 4, 5]);
  assert.equal(log.state, 'completed');
  const replay = log.replayFrom(3);
  assert.equal(replay.truncated, false);
  assert.deepEqual(replay.events.map((e) => e.sequence), [3, 4, 5]);
  const view = new TaskStreamView('task-1');
  const applied = view.applyAll(replay.events);
  assert.deepEqual(applied, { applied: 3, skipped: 0 });
  // Replay từ giữa: view chưa có status đầu -> state từ event replay.
  const v2 = view.view();
  assert.equal(v2.state, 'completed');
  assert.equal(v2.textSoFar, 'world');
  assert.equal(v2.artifacts.length, 1);
  assert.equal(v2.terminal, true);
  const cp = log.makeCheckpoint();
  assert.equal(cp.sequence, 5);
  assert.equal(cp.terminal, true);
  assert.equal(cp.textSoFar, 'hello world');
  const v3 = new TaskStreamView('task-1');
  v3.loadCheckpoint(cp);
  assert.equal(v3.view().state, 'completed');
  assert.equal(v3.view().lastSequence, 5);
});

test('taskStream: view phát hiện gap + bỏ trùng + không áp task khác', () => {
  const view = new TaskStreamView('task-9');
  const ev = (sequence, state) => ({
    taskId: 'task-9', sequence, kind: 'status-update', timestamp: new Date().toISOString(), state,
  });
  assert.equal(view.apply(ev(0, 'submitted')), true);
  assert.equal(view.apply(ev(0, 'submitted')), false); // trùng
  assert.equal(view.apply({ taskId: 'other', sequence: 1, kind: 'status-update', timestamp: new Date().toISOString(), state: 'working' }), false);
  assert.equal(view.apply(ev(3, 'working')), true); // nhảy 1->3: mất 2
  const v = view.view();
  assert.equal(v.gapsDetected, 1);
  // Event sequence 1 thuộc task khác nên bị từ chối — vẫn thiếu 1 và 2.
  assert.deepEqual(v.missingSequences, [1, 2]);
  assert.equal(v.skippedDuplicates, 1);
  assert.equal(v.state, 'working');
});

test('taskStream: artifact chunk merge + seed từ task có sẵn', () => {
  const merged = mergeArtifactChunks('a1', [
    { artifactId: 'a1', parts: [{ kind: 'text', text: 'hel' }] },
    { artifactId: 'a1', parts: [{ kind: 'text', text: 'lo ' }] },
    { artifactId: 'a1', parts: [{ kind: 'text', text: 'world' }] },
  ]);
  assert.equal(merged.parts.length, 1);
  assert.equal(merged.parts[0].kind, 'text');
  assert.equal(merged.parts[0].text, 'hello world');
  assert.deepEqual(mergeArtifactChunks('empty', []).parts, []);

  const log = new TaskStreamLog('task-seed');
  const task = {
    id: 'task-seed',
    contextId: 'ctx-1',
    status: { state: 'working' },
    artifacts: [{ artifactId: 'a9', parts: [{ kind: 'text', text: 'seed' }] }],
  };
  const events = seedTaskStreamEvents(task, log);
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, 'status-update');
  assert.equal(events[1].kind, 'artifact-complete');
  const view = new TaskStreamView('task-seed');
  view.applyAll(events);
  assert.equal(view.view().artifacts[0].artifactId, 'a9');

  // Chunked artifact: 2 chunk + isLastChunk -> gộp thành 1 artifact.
  const log2 = new TaskStreamLog('task-chunk');
  log2.appendArtifactChunk({ artifactId: 'c1', parts: [{ kind: 'text', text: 'ab' }] }, false);
  log2.appendArtifactChunk({ artifactId: 'c1', parts: [{ kind: 'text', text: 'cd' }] }, true);
  const view2 = new TaskStreamView('task-chunk');
  view2.applyAll(log2.replayFrom(0).events);
  assert.equal(view2.view().artifacts.length, 1);
  assert.equal(view2.view().artifacts[0].parts[0].text, 'abcd');
});
