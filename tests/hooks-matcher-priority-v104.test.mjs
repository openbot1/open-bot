/**
 * Tests for v1.04 hook extensions (packages/core/src/hooks/):
 * tool-name matcher (glob), run priority, per-hook timeout, and the
 * settings overrides for all three.
 *
 * Semantics under test:
 * - matchesToolName: `*` / `?` globs, case-sensitive, literal otherwise.
 * - listForEvent: Pre/PostToolUse hooks whose matcher does not admit
 *   the tool name are skipped; hooks run in priority order (lower
 *   first), ties keep registration order.
 * - Per-hook timeoutMs overrides the runner default (a 200ms hook
 *   times out under a 5s runner default only when its own timeout is
 *   50ms — and a hook with a 60s timeout survives a 100ms runner
 *   default... no: the runner default is the ceiling only when the
 *   hook sets no timeout; a hook timeout REPLACES it).
 * - applySettings: matcher / priority / timeoutMs overrides apply
 *   and are reversible (omitting the field clears the override).
 * - validateHookFunctionSettingsList reports bad matcher/priority/
 *   timeoutMs with field paths; validateHookCommandEntry accepts
 *   matcher/priority on command hooks.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/hooks-matcher-priority-v104.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  allowDecision,
  blockDecision,
  DEFAULT_HOOK_PRIORITY,
  HookRegistrationError,
  HookRegistry,
  HookRunner,
  matchesHookMatcher,
  matchesToolName,
  normalizeHookMatcher,
  validateHookCommandEntry,
  validateHookFunctionSettingsList,
  validateHookPriority,
  validateHookTimeoutMs,
} from '../packages/core/dist/hooks/index.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-hooks-v104-'));
  tempDirs.push(dir);
  return dir;
}

function registryWith(defs) {
  const registry = new HookRegistry({ stateDir: makeTempDir() });
  for (const def of defs) registry.register({ ...def, enabled: true });
  return registry;
}

const allow = () => allowDecision();
const noop = () => undefined;

test('matchesToolName: glob semantics', () => {
  assert.equal(matchesToolName('*', 'anything'), true);
  assert.equal(matchesToolName('shell-*', 'shell-exec'), true);
  assert.equal(matchesToolName('shell-*', 'shell'), false);
  assert.equal(matchesToolName('read', 'read'), true);
  assert.equal(matchesToolName('read', 'Read'), false, 'case-sensitive');
  assert.equal(matchesToolName('file-?', 'file-a'), true);
  assert.equal(matchesToolName('file-?', 'file-ab'), false);
  assert.equal(matchesToolName('a.b', 'a.b'), true);
  assert.equal(matchesToolName('a.b', 'axb'), false, 'dot is literal, not a wildcard');
  assert.equal(matchesToolName('*.env', 'x.env'), true);
});

test('matchesHookMatcher: undefined admits everything; list is any-match', () => {
  assert.equal(matchesHookMatcher(undefined, 'shell-exec'), true);
  assert.equal(matchesHookMatcher('*', 'shell-exec'), true);
  assert.equal(matchesHookMatcher(['read', 'glob_*'], 'glob_files'), true);
  assert.equal(matchesHookMatcher(['read', 'glob_*'], 'delete_file'), false);
});

test('normalizeHookMatcher: validates shape', () => {
  assert.equal(normalizeHookMatcher(undefined), undefined);
  assert.deepEqual(normalizeHookMatcher('shell-*'), ['shell-*']);
  assert.deepEqual(normalizeHookMatcher(['a', 'b']), ['a', 'b']);
  assert.throws(() => normalizeHookMatcher(''), HookRegistrationError);
  assert.throws(() => normalizeHookMatcher([]), HookRegistrationError);
  assert.throws(() => normalizeHookMatcher([123]), HookRegistrationError);
  assert.throws(() => normalizeHookMatcher(['ok', '']), HookRegistrationError);
});

test('validateHookPriority / validateHookTimeoutMs', () => {
  assert.equal(validateHookPriority(10, 'h'), 10);
  assert.equal(validateHookPriority(-5, 'h'), -5);
  assert.throws(() => validateHookPriority(1.5, 'h'), HookRegistrationError);
  assert.throws(() => validateHookPriority('10', 'h'), HookRegistrationError);
  assert.equal(validateHookTimeoutMs(1000, 'h'), 1000);
  assert.throws(() => validateHookTimeoutMs(50, 'h'), HookRegistrationError);
  assert.throws(() => validateHookTimeoutMs(300001, 'h'), HookRegistrationError);
  assert.throws(() => validateHookTimeoutMs('1000', 'h'), HookRegistrationError);
});

test('register: bad matcher / priority / timeoutMs are rejected', () => {
  const registry = new HookRegistry({ stateDir: makeTempDir() });
  assert.throws(
    () => registry.register({ name: 'bad-matcher', events: ['PreToolUse'], handler: noop, source: 'builtin', enabled: true, matcher: '' }),
    HookRegistrationError,
  );
  assert.throws(
    () => registry.register({ name: 'bad-prio', events: ['PreToolUse'], handler: noop, source: 'builtin', enabled: true, priority: 1.5 }),
    HookRegistrationError,
  );
  assert.throws(
    () => registry.register({ name: 'bad-timeout', events: ['PreToolUse'], handler: noop, source: 'builtin', enabled: true, timeoutMs: 10 }),
    HookRegistrationError,
  );
});

test('listForEvent: priority order (lower first), ties keep registration order', () => {
  const registry = registryWith([
    { name: 'late', events: ['Stop'], handler: noop, source: 'builtin', priority: 200 },
    { name: 'early', events: ['Stop'], handler: noop, source: 'builtin', priority: 10 },
    { name: 'mid-a', events: ['Stop'], handler: noop, source: 'builtin' },
    { name: 'mid-b', events: ['Stop'], handler: noop, source: 'builtin' },
    { name: 'first', events: ['Stop'], handler: noop, source: 'builtin', priority: 1 },
  ]);
  assert.deepEqual(
    registry.listForEvent('Stop').map((h) => h.name),
    ['first', 'early', 'mid-a', 'mid-b', 'late'],
  );
  assert.equal(registry.effectivePriority('mid-a'), DEFAULT_HOOK_PRIORITY);
});

test('listForEvent: matcher filters PreToolUse by tool name', () => {
  const registry = registryWith([
    { name: 'shell-only', events: ['PreToolUse'], handler: noop, source: 'builtin', matcher: 'shell-*' },
    { name: 'all-tools', events: ['PreToolUse'], handler: noop, source: 'builtin' },
    { name: 'read-only', events: ['PreToolUse'], handler: noop, source: 'builtin', matcher: ['read', 'glob_*'] },
  ]);
  assert.deepEqual(
    registry.listForEvent('PreToolUse', 'shell-exec').map((h) => h.name),
    ['shell-only', 'all-tools'],
  );
  assert.deepEqual(
    registry.listForEvent('PreToolUse', 'read').map((h) => h.name),
    ['all-tools', 'read-only'],
  );
  // No toolName given: matcher is not applied (back-compat for runHooks).
  assert.equal(registry.listForEvent('PreToolUse').length, 3);
  // Matcher is ignored for non-tool events.
  assert.equal(registry.listForEvent('Stop').length, 0);
});

test('runPreToolUse: matcher + priority decide which hooks run, in order', async () => {
  const seen = [];
  const registry = registryWith([
    {
      name: 'logger', events: ['PreToolUse'], handler: () => { seen.push('logger'); return allow(); },
      source: 'builtin', priority: 200,
    },
    {
      name: 'shell-gate', events: ['PreToolUse'], handler: () => { seen.push('shell-gate'); return allow(); },
      source: 'builtin', matcher: 'shell-*', priority: 10,
    },
  ]);
  const runner = new HookRunner(registry);
  const outcome = await runner.runPreToolUse({ toolName: 'shell-exec', toolCallId: 'c1', args: {} });
  assert.equal(outcome.decision, 'allow');
  assert.deepEqual(seen, ['shell-gate', 'logger']);
  assert.deepEqual(outcome.hooksRun, ['shell-gate', 'logger']);

  seen.length = 0;
  await runner.runPreToolUse({ toolName: 'read', toolCallId: 'c2', args: {} });
  assert.deepEqual(seen, ['logger'], 'shell-gate skipped for a non-shell tool');
});

test('runPreToolUse: a matched hook can still block; an unmatched one cannot', async () => {
  const registry = registryWith([
    {
      name: 'shell-blocker', events: ['PreToolUse'],
      handler: () => blockDecision('no shell here'), source: 'builtin', matcher: 'shell-*',
    },
  ]);
  const runner = new HookRunner(registry);
  const blocked = await runner.runPreToolUse({ toolName: 'shell-exec', toolCallId: 'c1', args: {} });
  assert.equal(blocked.decision, 'block');
  assert.equal(blocked.blockedBy, 'shell-blocker');
  const allowed = await runner.runPreToolUse({ toolName: 'read', toolCallId: 'c2', args: {} });
  assert.equal(allowed.decision, 'allow');
  assert.deepEqual(allowed.hooksRun, []);
});

test('per-hook timeout overrides the runner default', async () => {
  const slow = () => new Promise((resolve) => setTimeout(() => resolve(allow()), 300));
  const registry = registryWith([
    { name: 'slow-short', events: ['Stop'], handler: slow, source: 'builtin', timeoutMs: 100 },
    { name: 'slow-long', events: ['Stop'], handler: slow, source: 'builtin', timeoutMs: 5000 },
  ]);
  // Runner default is 5s: without the per-hook override, slow-short
  // would finish fine. With timeoutMs 100 it must time out.
  const runner = new HookRunner(registry, { timeoutMs: 5000, onHookError: 'allow' });
  const results = await runner.runHooks({ event: 'Stop', reason: 'test' });
  const byName = Object.fromEntries(results.map((r) => [r.hookName, r]));
  assert.ok(byName['slow-short'].error, 'slow-short must time out');
  assert.equal(byName['slow-short'].error.timedOut, true);
  assert.ok(byName['slow-long'].decision, 'slow-long must complete within its own timeout');
});

test('applySettings: matcher / priority / timeoutMs overrides apply and clear', () => {
  const registry = registryWith([
    { name: 'gate', events: ['PreToolUse'], handler: noop, source: 'builtin', matcher: 'shell-*', priority: 50, timeoutMs: 1000 },
  ]);
  const applied = registry.applySettings({
    hooks: [{ name: 'gate', matcher: 'read', priority: 5, timeoutMs: 2000 }],
  });
  assert.deepEqual(applied, { applied: ['gate'], unknown: [] });
  assert.deepEqual(registry.effectiveMatcher('gate'), ['read']);
  assert.equal(registry.effectivePriority('gate'), 5);
  assert.equal(registry.effectiveTimeoutMs('gate'), 2000);
  assert.deepEqual(
    registry.listForEvent('PreToolUse', 'read').map((h) => h.name),
    ['gate'],
  );
  assert.deepEqual(registry.listForEvent('PreToolUse', 'shell-exec'), []);
  // Omitting the fields clears the overrides (back to the hook's own values).
  registry.applySettings({ hooks: [{ name: 'gate' }] });
  assert.deepEqual(registry.effectiveMatcher('gate'), ['shell-*']);
  assert.equal(registry.effectivePriority('gate'), 50);
  assert.equal(registry.effectiveTimeoutMs('gate'), 1000);
  // A bad override is ignored, never fatal.
  registry.applySettings({ hooks: [{ name: 'gate', matcher: '', priority: 'high' }] });
  assert.deepEqual(registry.effectiveMatcher('gate'), ['shell-*']);
  assert.equal(registry.effectivePriority('gate'), 50);
});

test('validateHookFunctionSettingsList: reports bad fields with paths', () => {
  const issues = validateHookFunctionSettingsList([
    { name: 'good', events: ['PreToolUse'], matcher: 'shell-*', priority: 10, timeoutMs: 1000 },
    { name: 'Bad Name', events: ['Nope'], matcher: '', priority: 1.5, timeoutMs: 10 },
    { name: 'no-events', events: [] },
    'not-an-object',
  ]);
  assert.equal(issues.length, 5 + 1 + 1, `expected 7 issues, got ${JSON.stringify(issues)}`);
  const fields = issues.map((i) => i.field);
  assert.ok(fields.includes('hooks[1].name'));
  assert.ok(fields.includes('hooks[1].events'));
  assert.ok(fields.includes('hooks[1].matcher'));
  assert.ok(fields.includes('hooks[1].priority'));
  assert.ok(fields.includes('hooks[1].timeoutMs'));
  assert.ok(fields.includes('hooks[2].events'));
  assert.ok(fields.includes('hooks[3]'));
  // Unknown hook names are NOT flagged (the hook may register later).
  assert.deepEqual(validateHookFunctionSettingsList([{ name: 'not-registered-yet' }]), []);
});

test('validateHookCommandEntry: accepts matcher + priority', () => {
  const ok = validateHookCommandEntry({
    name: 'cmd-hook', command: 'echo hi', events: ['PreToolUse'],
    matcher: 'shell-*', priority: 5,
  });
  assert.equal(ok.valid, true);
  assert.equal(ok.entry.matcher, 'shell-*');
  assert.equal(ok.entry.priority, 5);
  const bad = validateHookCommandEntry({
    name: 'cmd-hook', command: 'echo hi', events: ['PreToolUse'],
    matcher: '', priority: 'soon',
  });
  assert.equal(bad.valid, false);
  assert.ok(bad.issues.some((i) => i.field === 'matcher'));
  assert.ok(bad.issues.some((i) => i.field === 'priority'));
});

test('command hook registered with matcher only runs for matching tools', async () => {
  const registry = new HookRegistry({ stateDir: makeTempDir() });
  registry.registerCommandHook({
    name: 'echo-gate', command: 'node -e "process.exit(0)"', events: ['PreToolUse'],
    matcher: 'shell-*',
  });
  const runner = new HookRunner(registry);
  const matched = await runner.runPreToolUse({ toolName: 'shell-exec', toolCallId: 'c1', args: {} });
  assert.deepEqual(matched.hooksRun, ['echo-gate']);
  const unmatched = await runner.runPreToolUse({ toolName: 'read', toolCallId: 'c2', args: {} });
  assert.deepEqual(unmatched.hooksRun, []);
});

after(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});
