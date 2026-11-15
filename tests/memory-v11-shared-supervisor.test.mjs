/**
 * Tests for v1.11 (Doi T1) — shared-block supervisor gate:
 * packages/core/src/memory/v11/sharedSupervisor.ts.
 *
 * Covers: supervisor-only writes (member bots rejected even with a
 * write role; user + supervisor + sleep-as-supervisor allowed),
 * setSupervisor (user-only, must be a member), shared size cap
 * (4000 chars, warning at 80%, over-cap write rejected), presets
 * (current_plan / organization / learned_context), listing with
 * usage + warnings, history entries (backend shared-v11).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v11-shared-supervisor.test.mjs
 *
 * No network. No model.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MemoryBlockStore } from '../packages/core/dist/memory/blocks.js';
import { SharedBlockGroupStore } from '../packages/core/dist/memory/sharedBlocks.js';
import {
  SharedSupervisor,
  SHARED_BLOCK_CHAR_LIMIT,
  SHARED_BLOCK_WARN_RATIO,
  sharedBlockLimitForLabel,
  sharedBlockUsage,
  sleepV11Actor,
  V11SharedError,
} from '../packages/core/dist/memory/v11/sharedSupervisor.js';
import { listBlockHistory } from '../packages/core/dist/memory/v11/blockHistoryTable.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-memv11-shared-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Workspace with a group (supervisor bot-1, member bot-2 with write role). */
function makeGroup(dir, { supervisor = 'bot-1' } = {}) {
  const blocks = new MemoryBlockStore(dir);
  const groups = new SharedBlockGroupStore(dir, blocks);
  const group = groups.createGroup({ name: 'team-alpha', description: 'test group' }, 'user');
  groups.addMember(group.id, 'bot-1', 'write', 'user');
  groups.addMember(group.id, 'bot-2', 'write', 'user');
  const supervisorGate = new SharedSupervisor(dir, blocks, groups);
  if (supervisor) supervisorGate.setSupervisor(group.id, supervisor, 'user');
  return { blocks, groups, group, supervisorGate };
}

test('sharedBlockLimitForLabel: capped at 4000 even for big kinds', () => {
  assert.equal(SHARED_BLOCK_CHAR_LIMIT, 4000);
  assert.equal(SHARED_BLOCK_WARN_RATIO, 0.8);
  assert.equal(sharedBlockLimitForLabel('project'), 4000);
  assert.equal(sharedBlockLimitForLabel('persona'), 2048);
  assert.equal(sharedBlockLimitForLabel('human'), 4000);
});

test('sharedBlockUsage: ok/warm/over + warnings', () => {
  const base = { id: 'x', label: 'current-plan', description: '', content: '', charLimit: 4000, readOnly: false, createdByBotId: '', version: 1, createdAt: '', updatedAt: '' };
  assert.equal(sharedBlockUsage({ ...base, content: 'a'.repeat(100) }).state, 'ok');
  assert.equal(sharedBlockUsage({ ...base, content: 'a'.repeat(100) }).warning, '');
  const warm = sharedBlockUsage({ ...base, content: 'a'.repeat(3200) });
  assert.equal(warm.state, 'warm');
  assert.ok(warm.warning.length > 0);
  const over = sharedBlockUsage({ ...base, content: 'a'.repeat(4001) });
  assert.equal(over.state, 'over');
  assert.ok(over.warning.length > 0);
});

test('ensureSharedPreset: creates preset block + attaches to all members', () => {
  const dir = makeTempDir();
  const { supervisorGate, group, blocks } = makeGroup(dir);
  const plan = supervisorGate.ensureSharedPreset(group.id, 'current-plan', 'user');
  assert.equal(plan.label, 'current-plan');
  assert.equal(plan.charLimit, 4000);
  assert.equal(blocks.isAttached('bot-1', plan.id), true);
  assert.equal(blocks.isAttached('bot-2', plan.id), true);
  // Idempotent.
  assert.equal(supervisorGate.ensureSharedPreset(group.id, 'current-plan', 'user').id, plan.id);
  const org = supervisorGate.ensureSharedPreset(group.id, 'organization', 'user');
  assert.equal(org.label, 'organization');
  assert.equal(supervisorGate.listSharedBlocks(group.id).length, 2);
});

test('writeSharedBlock: supervisor + user + sleep-as-supervisor allowed', () => {
  const dir = makeTempDir();
  const { supervisorGate, group } = makeGroup(dir);
  supervisorGate.ensureSharedPreset(group.id, 'current-plan', 'user');

  const bySupervisor = supervisorGate.writeSharedBlock(group.id, 'current-plan', { content: 'Step 1: research.' }, 'agent:bot-1');
  assert.equal(bySupervisor.mode, 'replace');
  assert.equal(bySupervisor.block.content, 'Step 1: research.');
  assert.equal(bySupervisor.usage.state, 'ok');

  const byUser = supervisorGate.writeSharedBlock(group.id, 'current-plan', { append: '\nStep 2: build.' }, 'user');
  assert.equal(byUser.mode, 'append');
  assert.ok(byUser.block.content.includes('Step 2: build.'));

  const bySleep = supervisorGate.writeSharedBlock(
    group.id, 'current-plan', { append: '\nLearned: user likes tea.' }, sleepV11Actor('bot-1'),
  );
  assert.ok(bySleep.block.content.includes('Learned: user likes tea.'));
  assert.equal(sleepV11Actor('bot-1'), 'sleep:v11:bot-1');
});

test('writeSharedBlock: member bot rejected even with write role', () => {
  const dir = makeTempDir();
  const { supervisorGate, group } = makeGroup(dir);
  supervisorGate.ensureSharedPreset(group.id, 'current-plan', 'user');
  // bot-2 is a group member with role 'write' in v1.03 — v11 still rejects it.
  assert.throws(
    () => supervisorGate.writeSharedBlock(group.id, 'current-plan', { content: 'hijack' }, 'agent:bot-2'),
    V11SharedError,
  );
  // Sleep agent impersonating the wrong supervisor is also rejected.
  assert.throws(
    () => supervisorGate.writeSharedBlock(group.id, 'current-plan', { content: 'hijack' }, sleepV11Actor('bot-2')),
    V11SharedError,
  );
  // A stranger bot is rejected too.
  assert.throws(
    () => supervisorGate.writeSharedBlock(group.id, 'current-plan', { content: 'hijack' }, 'agent:bot-99'),
    V11SharedError,
  );
  // Content unchanged after all rejections.
  const blocks = new MemoryBlockStore(dir);
  assert.equal(blocks.get('current-plan').content, '');
});

test('writeSharedBlock: no supervisor yet -> only user may write', () => {
  const dir = makeTempDir();
  const { supervisorGate, group } = makeGroup(dir, { supervisor: null });
  supervisorGate.ensureSharedPreset(group.id, 'organization', 'user');
  assert.throws(
    () => supervisorGate.writeSharedBlock(group.id, 'organization', { content: 'x' }, 'agent:bot-1'),
    V11SharedError,
  );
  const ok = supervisorGate.writeSharedBlock(group.id, 'organization', { content: 'Acme Corp.' }, 'user');
  assert.equal(ok.block.content, 'Acme Corp.');
});

test('writeSharedBlock: over-cap content rejected (replace + append)', () => {
  const dir = makeTempDir();
  const { supervisorGate, group } = makeGroup(dir);
  supervisorGate.ensureSharedPreset(group.id, 'current-plan', 'user');
  const big = 'x'.repeat(4001);
  assert.throws(
    () => supervisorGate.writeSharedBlock(group.id, 'current-plan', { content: big }, 'user'),
    V11SharedError,
  );
  supervisorGate.writeSharedBlock(group.id, 'current-plan', { content: 'x'.repeat(3900) }, 'user');
  assert.throws(
    () => supervisorGate.writeSharedBlock(group.id, 'current-plan', { append: 'y'.repeat(200) }, 'user'),
    V11SharedError,
  );
  // Exactly at the cap is fine (store append adds one '\n' separator).
  const atCap = supervisorGate.writeSharedBlock(group.id, 'current-plan', { append: 'y'.repeat(99) }, 'user');
  assert.equal(atCap.block.content.length, 4000);
  assert.equal(atCap.usage.state, 'warm');
  // Both content and append (or neither) is an error.
  assert.throws(
    () => supervisorGate.writeSharedBlock(group.id, 'current-plan', { content: 'a', append: 'b' }, 'user'),
    V11SharedError,
  );
  assert.throws(
    () => supervisorGate.writeSharedBlock(group.id, 'current-plan', {}, 'user'),
    V11SharedError,
  );
});

test('writeSharedBlock: block outside the group / unknown group rejected', () => {
  const dir = makeTempDir();
  const { supervisorGate, group, blocks } = makeGroup(dir);
  const outside = blocks.create({ label: 'private', description: '', content: '', charLimit: 2000 }, 'user');
  void outside;
  assert.throws(
    () => supervisorGate.writeSharedBlock(group.id, 'private', { content: 'x' }, 'user'),
    V11SharedError,
  );
  assert.throws(
    () => supervisorGate.writeSharedBlock('no-such-group', 'current-plan', { content: 'x' }, 'user'),
    V11SharedError,
  );
});

test('setSupervisor: user-only, must be a member', () => {
  const dir = makeTempDir();
  const { supervisorGate, group } = makeGroup(dir);
  assert.equal(supervisorGate.getSupervisor(group.id), 'bot-1');
  assert.throws(() => supervisorGate.setSupervisor(group.id, 'bot-2', 'agent:bot-1'), V11SharedError);
  assert.throws(() => supervisorGate.setSupervisor(group.id, 'bot-99', 'user'), V11SharedError);
  assert.throws(() => supervisorGate.setSupervisor(group.id, '', 'user'), V11SharedError);
  const updated = supervisorGate.setSupervisor(group.id, 'bot-2', 'user');
  assert.equal(updated.id, group.id);
  assert.equal(supervisorGate.getSupervisor(group.id), 'bot-2');
  // Old supervisor can no longer write; new one can.
  supervisorGate.ensureSharedPreset(group.id, 'organization', 'user');
  assert.throws(
    () => supervisorGate.writeSharedBlock(group.id, 'organization', { content: 'x' }, 'agent:bot-1'),
    V11SharedError,
  );
  assert.equal(
    supervisorGate.writeSharedBlock(group.id, 'organization', { content: 'ok' }, 'agent:bot-2').block.content,
    'ok',
  );
});

test('listSharedBlocks: views carry group + supervisor + members + usage', () => {
  const dir = makeTempDir();
  const { supervisorGate, group } = makeGroup(dir);
  supervisorGate.ensureSharedPreset(group.id, 'current-plan', 'user');
  const views = supervisorGate.listSharedBlocks();
  assert.equal(views.length, 1);
  assert.equal(views[0].groupName, 'team-alpha');
  assert.equal(views[0].supervisorBotId, 'bot-1');
  assert.deepEqual(views[0].memberBotIds, ['bot-1', 'bot-2']);
  assert.equal(views[0].usage.limit, 4000);
  assert.throws(() => supervisorGate.listSharedBlocks('no-such-group'), V11SharedError);
});

test('shared writes are recorded in the unified block_history table', () => {
  const dir = makeTempDir();
  const { supervisorGate, group } = makeGroup(dir);
  const plan = supervisorGate.ensureSharedPreset(group.id, 'current-plan', 'user');
  supervisorGate.writeSharedBlock(group.id, 'current-plan', { content: 'Plan v1.' }, 'user');
  const entries = listBlockHistory(dir, plan.id, { limit: 10 });
  assert.ok(entries.some((e) => e.backend === 'shared-v11' && e.action === 'create'));
  assert.ok(entries.some((e) => e.backend === 'shared-v11' && e.action === 'replace'));
});
