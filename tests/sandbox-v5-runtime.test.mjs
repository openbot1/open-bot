/**
 * Tests cho Sandbox v5 — per-bot runtime choice + safe tier switch
 * (v1.37, Đội T3).
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/sandbox-v5-runtime.test.mjs
 *
 * Không chạy gì thật: tier switch chạy trên registry + choice
 * store trong thư mục tạm, không spawn backend thật.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  SandboxV5ChoiceStore,
  SandboxV5RuntimeRegistry,
  SandboxV5RuntimeSwitcher,
  availableSandboxV5Tiers,
  describeSandboxV5TierChange,
  getSandboxV5TierInfo,
  listSandboxV5Tiers,
  minSandboxV5TierForTrust,
  readSandboxV5SwitchJournal,
  recommendSandboxV5Tier,
  validateSandboxV5TierForTrust,
} from '../packages/core/dist/index.js';

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Host capabilities with bwrap present, no VM backends (this Linux VM). */
const CAPS = { platform: 'linux', hasBwrap: true, hasMicrovmBackend: false, hasVmBackend: false };

function makeStores(t) {
  const base = tmpDir(t, 'sbv5-runtime-');
  const choices = new SandboxV5ChoiceStore({ baseDir: base, capabilities: CAPS });
  const registry = new SandboxV5RuntimeRegistry({ baseDir: base });
  return { base, choices, registry };
}

test('tiers: catalog has 5 tiers, weakest first, with min-trust ladder', () => {
  const tiers = listSandboxV5Tiers();
  assert.deepEqual(tiers.map((tier) => tier.tier), ['local', 'bwrap', 'syscall-policy', 'microvm', 'vm']);
  assert.equal(getSandboxV5TierInfo('local')?.isolatesProcess, false);
  assert.equal(getSandboxV5TierInfo('syscall-policy')?.syscallPolicy, true);
  assert.equal(getSandboxV5TierInfo('vm')?.startupCost, 5);
  assert.equal(minSandboxV5TierForTrust('trusted'), 'local');
  assert.equal(minSandboxV5TierForTrust('standard'), 'bwrap');
  assert.equal(minSandboxV5TierForTrust('untrusted'), 'syscall-policy');
  assert.equal(minSandboxV5TierForTrust('hostile'), 'microvm');
  assert.deepEqual(validateSandboxV5TierForTrust('local', 'standard'), [
    'Tier "local" is too weak for trust "standard": minimum is "bwrap". Run untrusted code on "bwrap" or stronger.',
  ]);
  assert.deepEqual(validateSandboxV5TierForTrust('bwrap', 'standard'), []);
});

test('tiers: availability follows host capabilities, recommendation never downgrades', () => {
  assert.deepEqual(availableSandboxV5Tiers(CAPS), ['local', 'bwrap', 'syscall-policy']);
  assert.equal(recommendSandboxV5Tier('trusted', CAPS), 'local');
  assert.equal(recommendSandboxV5Tier('standard', CAPS), 'bwrap');
  assert.equal(recommendSandboxV5Tier('untrusted', CAPS), 'syscall-policy');
  // Hostile needs microvm — this host has none, so no recommendation (refuse, not downgrade).
  assert.equal(recommendSandboxV5Tier('hostile', CAPS), undefined);
  assert.deepEqual(availableSandboxV5Tiers({ platform: 'linux', hasBwrap: false, hasMicrovmBackend: false, hasVmBackend: false }), ['local']);
});

test('tiers: downgrade description warns about lost guarantees', () => {
  const change = describeSandboxV5TierChange('syscall-policy', 'local');
  assert.equal(change.direction, 'downgrade');
  // Downgrade line + lost syscall policy + lost network + lost process isolation.
  assert.equal(change.warnings.length, 4);
  assert.equal(describeSandboxV5TierChange('bwrap', 'microvm').direction, 'upgrade');
  assert.deepEqual(describeSandboxV5TierChange('bwrap', 'bwrap').warnings, []);
});

test('choice store: set/get/list, validation refuses weak and unavailable tiers', (t) => {
  const { choices } = makeStores(t);
  const choice = choices.set('bot-a', { tier: 'bwrap', trust: 'standard', setBy: 'user', reason: 'test' });
  assert.equal(choice.botId, 'bot-a');
  assert.equal(choice.tier, 'bwrap');
  assert.equal(choice.version, 1);
  assert.equal(choices.get('bot-a')?.tier, 'bwrap');
  assert.equal(choices.list().length, 1);
  // Too weak for the trust.
  assert.throws(() => choices.set('bot-b', { tier: 'local', trust: 'standard' }), /too weak/);
  // Unavailable on this host (no microvm backend).
  assert.throws(() => choices.set('bot-c', { tier: 'microvm', trust: 'hostile' }), /not available/);
  // Bad bot id / bad profile id.
  assert.throws(() => choices.set('../evil', { tier: 'bwrap' }), /Invalid botId/);
  assert.throws(() => choices.set('bot-d', { tier: 'bwrap', profileId: 'Bad Profile!' }), /Invalid profileId/);
  // Setting again bumps the version and keeps limits.
  const again = choices.set('bot-a', { tier: 'syscall-policy', limits: { timeoutMs: 5000 } });
  assert.equal(again.version, 2);
  assert.equal(again.limits.timeoutMs, 5000);
  // Choices survive a reload from disk.
  const reloaded = new SandboxV5ChoiceStore({ baseDir: choices.baseDir, capabilities: CAPS });
  assert.equal(reloaded.get('bot-a')?.tier, 'syscall-policy');
  assert.equal(reloaded.get('bot-a')?.version, 2);
});

test('registry: register/start/pause/stop lifecycle + double-register refused', (t) => {
  const { base, registry } = makeStores(t);
  const workdir = path.join(base, 'work-bot-a');
  fs.mkdirSync(workdir, { recursive: true });
  const runtime = registry.register({ botId: 'bot-a', tier: 'bwrap', workdir });
  assert.equal(runtime.state, 'created');
  assert.throws(() => registry.register({ botId: 'bot-a', tier: 'local', workdir }), /already has a live runtime/);
  assert.equal(registry.start('bot-a').state, 'running');
  assert.equal(registry.heartbeat('bot-a', true).runCount, 1);
  assert.equal(registry.pause('bot-a').state, 'paused');
  assert.equal(registry.start('bot-a').state, 'running');
  assert.equal(registry.stop('bot-a', 'done').state, 'stopped');
  assert.throws(() => registry.stop('bot-a'), /Cannot stop/);
  assert.throws(() => registry.start('bot-a'), /Cannot start/);
  const summary = registry.summarize()[0];
  assert.equal(summary.botId, 'bot-a');
  assert.equal(summary.state, 'stopped');
  assert.equal(summary.idleMs >= 0, true);
  assert.throws(() => registry.register({ botId: '../evil', tier: 'local', workdir }), /Invalid botId/);
});

test('switch: plan blocks same-tier and unknown runtime, allows upgrade', (t) => {
  const { base, choices, registry } = makeStores(t);
  const switcher = new SandboxV5RuntimeSwitcher(choices, registry, { baseDir: base });
  const workdir = path.join(base, 'work-bot-a');
  fs.mkdirSync(workdir, { recursive: true });
  registry.register({ botId: 'bot-a', tier: 'bwrap', workdir });
  const plan = switcher.plan('bot-a', 'syscall-policy');
  assert.equal(plan.allowed, true);
  assert.equal(plan.needsDrain, false);
  assert.deepEqual(plan.steps, ['validate', 'snapshot-state', 'stop-old', 'start-new', 'restore-state', 'verify', 'done']);
  assert.deepEqual(switcher.plan('bot-a', 'bwrap').blockers, [
    'Bot "bot-a" already runs on tier "bwrap" — nothing to switch.',
  ]);
  assert.deepEqual(switcher.plan('bot-a', 'microvm').blockers.length, 1);
  const unknownPlan = switcher.plan('bot-unknown', 'bwrap');
  assert.equal(unknownPlan.allowed, false);
  assert.equal(unknownPlan.blockers[0].includes('No runtime registered'), true);
});

test('switch: stopped runtime upgrades tier and records the choice', async (t) => {
  const { base, choices, registry } = makeStores(t);
  const switcher = new SandboxV5RuntimeSwitcher(choices, registry, { baseDir: base });
  const workdir = path.join(base, 'work-bot-a');
  fs.mkdirSync(workdir, { recursive: true });
  fs.writeFileSync(path.join(workdir, 'notes.txt'), 'keep me', 'utf8');
  registry.register({ botId: 'bot-a', tier: 'bwrap', profileId: 'coder', workdir });
  registry.start('bot-a');
  registry.heartbeat('bot-a', true);
  registry.stop('bot-a', 'idle');
  const result = await switcher.switch('bot-a', 'syscall-policy', { reason: 'needs syscall policy' });
  assert.equal(result.switched, true);
  assert.equal(result.rolledBack, false);
  assert.equal(result.fromTier, 'bwrap');
  assert.equal(result.toTier, 'syscall-policy');
  assert.equal(registry.get('bot-a')?.tier, 'syscall-policy');
  assert.equal(registry.get('bot-a')?.state, 'running');
  assert.equal(registry.get('bot-a')?.runCount, 1);
  assert.equal(choices.get('bot-a')?.tier, 'syscall-policy');
  assert.equal(fs.readFileSync(path.join(workdir, 'notes.txt'), 'utf8'), 'keep me');
  const journal = readSandboxV5SwitchJournal(base);
  assert.equal(journal.length > 0, true);
  assert.equal(journal.some((entry) => entry.event === 'completed' && entry.step === 'done'), true);
});

test('switch: running runtime drains (quiesce step) before switching', async (t) => {
  const { base, choices, registry } = makeStores(t);
  const switcher = new SandboxV5RuntimeSwitcher(choices, registry, { baseDir: base });
  const workdir = path.join(base, 'work-bot-a');
  fs.mkdirSync(workdir, { recursive: true });
  registry.register({ botId: 'bot-a', tier: 'bwrap', workdir });
  registry.start('bot-a');
  let drained = false;
  const result = await switcher.switch('bot-a', 'syscall-policy', {
    hooks: {
      waitForDrain: () => {
        drained = true;
        return true;
      },
    },
  });
  assert.equal(drained, true);
  assert.equal(result.switched, true);
  assert.equal(result.steps.some((step) => step.step === 'quiesce' && step.ok), true);
});

test('switch: downgrade without a reason is refused', async (t) => {
  const { base, choices, registry } = makeStores(t);
  const switcher = new SandboxV5RuntimeSwitcher(choices, registry, { baseDir: base });
  const workdir = path.join(base, 'work-bot-a');
  fs.mkdirSync(workdir, { recursive: true });
  registry.register({ botId: 'bot-a', tier: 'syscall-policy', workdir });
  await assert.rejects(() => switcher.switch('bot-a', 'bwrap'), /needs an explicit reason/);
  assert.equal(registry.get('bot-a')?.tier, 'syscall-policy');
});

test('switch: backend failure after stop rolls back to the old tier', async (t) => {
  const { base, choices, registry } = makeStores(t);
  const switcher = new SandboxV5RuntimeSwitcher(choices, registry, { baseDir: base });
  const workdir = path.join(base, 'work-bot-a');
  fs.mkdirSync(workdir, { recursive: true });
  registry.register({ botId: 'bot-a', tier: 'bwrap', profileId: 'coder', workdir });
  registry.start('bot-a');
  registry.stop('bot-a', 'idle');
  const result = await switcher.switch('bot-a', 'syscall-policy', {
    hooks: {
      startBackend: (runtime) => {
        if (runtime.tier === 'syscall-policy') throw new Error('microvm backend down');
      },
    },
  });
  assert.equal(result.switched, false);
  assert.equal(result.rolledBack, true);
  assert.equal(registry.get('bot-a')?.tier, 'bwrap');
  assert.equal(registry.get('bot-a')?.state, 'stopped');
  assert.equal(choices.get('bot-a'), undefined);
  const journal = readSandboxV5SwitchJournal(base);
  assert.equal(journal.some((entry) => entry.event === 'rolled-back'), true);
});

test('switch: drain timeout aborts before anything stops', async (t) => {
  const { base, choices, registry } = makeStores(t);
  const switcher = new SandboxV5RuntimeSwitcher(choices, registry, { baseDir: base });
  const workdir = path.join(base, 'work-bot-a');
  fs.mkdirSync(workdir, { recursive: true });
  registry.register({ botId: 'bot-a', tier: 'bwrap', workdir });
  registry.start('bot-a');
  const result = await switcher.switch('bot-a', 'syscall-policy', {
    drainTimeoutMs: 100,
    hooks: { waitForDrain: () => false },
  });
  assert.equal(result.switched, false);
  assert.equal(result.rolledBack, false);
  assert.equal(result.detail.includes('quiesce'), true);
  assert.equal(registry.get('bot-a')?.state, 'running');
  assert.equal(registry.get('bot-a')?.tier, 'bwrap');
});
