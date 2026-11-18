/**
 * Tests cho Sandbox v3 — hooks Pre/PostToolUse + lifecycle (v1.35, Đội T2).
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/sandbox-v3-hooks-lifecycle.test.mjs
 *
 * Hooks là dữ liệu, không phải callback: test kiểm tra quyết định
 * allow / deny / modify, không chạy code người dùng.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LifecycleController,
  LifecycleRegistry,
  SandboxV3HookRegistry,
  canTransition,
  createBlockArgHook,
  createBlockToolHook,
  createForceArgsHook,
  createRedactResultHook,
  createWithholdResultHook,
  hookMatches,
  isLiveState,
  isTerminalState,
  matchToolPattern,
  validateHookMatcher,
} from '../packages/core/dist/index.js';

function fakeClock(startMs = 1_000_000) {
  const clock = { value: startMs };
  return { clock, nowMs: () => clock.value };
}

test('hooks: glob matching — prefix, suffix, middle, exact, star', () => {
  assert.equal(matchToolPattern('anything', '*'), true);
  assert.equal(matchToolPattern('shell_exec', 'shell_*'), true);
  assert.equal(matchToolPattern('shell', 'shell_*'), false);
  assert.equal(matchToolPattern('my_run', '*_run'), true);
  assert.equal(matchToolPattern('run', '*_run'), false);
  assert.equal(matchToolPattern('sandbox_v3_run', 'sandbox_*_run'), true);
  assert.equal(matchToolPattern('sandbox_run', 'sandbox_*_run'), false);
  assert.equal(matchToolPattern('read_file', 'read_file'), true);
  assert.equal(matchToolPattern('read_file', 'write_file'), false);
  assert.equal(matchToolPattern('Read_File', 'read_file'), false);
  assert.equal(matchToolPattern('a_b_c', 'a*b*c'), true);
  assert.equal(matchToolPattern('a_c', 'a*b*c'), false);
  assert.equal(
    hookMatches({ tool: 'shell_exec', args: { command: 'ls' } }, { toolPattern: 'shell_*', argKey: 'command' }),
    true,
  );
  assert.equal(
    hookMatches({ tool: 'shell_exec', args: {} }, { toolPattern: 'shell_*', argKey: 'command' }),
    false,
  );
  assert.equal(hookMatches({ tool: 'x', args: {} }, undefined), true);
  assert.deepEqual(validateHookMatcher({ toolPattern: '**' }), ['matcher.toolPattern must not contain "**"']);
  assert.deepEqual(validateHookMatcher({ argKey: '' }), ['matcher.argKey must be a non-empty string']);
  assert.deepEqual(validateHookMatcher(undefined), []);
});

test('hooks: pre-hook deny blocks, modify rewrites, deny beats modify', () => {
  const registry = new SandboxV3HookRegistry();
  const deny = registry.register(createBlockToolHook('block-shell', 'shell_*', 'No shell here.', 10));
  const force = registry.register(createForceArgsHook('force-dry-run', '*', { dryRun: true }, 50));
  assert.equal(registry.size(), 2);
  assert.equal(registry.enabledCount(), 2);

  const blocked = registry.evaluatePre({ tool: 'shell_exec', args: { command: 'rm -rf /' } });
  assert.equal(blocked.decision, 'deny');
  assert.equal(blocked.denied, true);
  assert.equal(blocked.modified, false);
  assert.ok(blocked.matchedHookIds.includes(deny.id));
  assert.match(blocked.reason, /block-shell/);

  const rewritten = registry.evaluatePre({ tool: 'write_file', args: { path: 'a.txt' } });
  assert.equal(rewritten.decision, 'modify');
  assert.equal(rewritten.modified, true);
  assert.equal(rewritten.args.dryRun, true);
  assert.equal(rewritten.args.path, 'a.txt');

  const allowed = registry.evaluatePre({ tool: 'read_file', args: { path: 'a.txt' } });
  assert.equal(allowed.decision, 'modify');
  assert.equal(allowed.args.dryRun, true);

  // Disabled deny hook lets the call through (modify still applies).
  registry.setEnabled(deny.id, false);
  const afterDisable = registry.evaluatePre({ tool: 'shell_exec', args: { command: 'ls' } });
  assert.equal(afterDisable.decision, 'modify');
  assert.equal(registry.deniedCount(), 1);
  assert.equal(registry.modifiedCount(), 3);
  assert.equal(registry.unregister(force.id), true);
  assert.equal(registry.unregister(force.id), false);
  assert.equal(registry.size(), 1);
});

test('hooks: post-hook withhold hides the result, redact rewrites it', () => {
  const registry = new SandboxV3HookRegistry();
  registry.register(createWithholdResultHook('hide-secrets', 'read_secret', 'Secrets are never shown.', 10));
  registry.register(createRedactResultHook('summarise-big', 'big_output', '[redacted: 1MB output]', 50));

  const withheld = registry.evaluatePost({ tool: 'read_secret', args: {} }, 'sk-live-abc123');
  assert.equal(withheld.decision, 'deny');
  assert.equal(withheld.denied, true);
  assert.equal(withheld.result, 'Secrets are never shown.');
  assert.ok(!withheld.result.includes('sk-live'));

  const redacted = registry.evaluatePost({ tool: 'big_output', args: {} }, 'x'.repeat(1000));
  assert.equal(redacted.decision, 'modify');
  assert.equal(redacted.result, '[redacted: 1MB output]');

  const plain = registry.evaluatePost({ tool: 'read_file', args: {} }, 'hello');
  assert.equal(plain.decision, 'allow');
  assert.equal(plain.result, 'hello');
  assert.equal(registry.auditLog().length, 3);
});

test('hooks: registration validates its spec', () => {
  const registry = new SandboxV3HookRegistry();
  assert.throws(() => registry.register({ name: '', timing: 'pre', decision: 'deny' }), /non-empty string/);
  assert.throws(() => registry.register({ name: 'x', timing: 'during', decision: 'deny' }), /pre.*post/);
  assert.throws(() => registry.register({ name: 'x', timing: 'pre', decision: 'maybe' }), /allow \| deny \| modify/);
  assert.throws(
    () => registry.register({ name: 'x', timing: 'pre', decision: 'modify' }),
    /must provide modifyArgs/,
  );
  assert.throws(
    () => registry.register({ name: 'x', timing: 'pre', decision: 'deny', matcher: { toolPattern: '**' } }),
    /Invalid hook matcher/,
  );
  const argHook = registry.register(createBlockArgHook('block-command-arg', 'command', undefined, 20));
  assert.equal(argHook.timing, 'pre');
  const denied = registry.evaluatePre({ tool: 'anything', args: { command: 'id' } });
  assert.equal(denied.decision, 'deny');
  const ok = registry.evaluatePre({ tool: 'anything', args: { path: 'a.txt' } });
  assert.equal(ok.decision, 'allow');
});

test('lifecycle: legal transitions, pause freezes steps, illegal moves refuse', () => {
  assert.equal(canTransition('created', 'running'), true);
  assert.equal(canTransition('running', 'paused'), true);
  assert.equal(canTransition('paused', 'running'), true);
  assert.equal(canTransition('running', 'stopped'), true);
  assert.equal(canTransition('paused', 'stopped'), true);
  assert.equal(canTransition('created', 'stopped'), true);
  assert.equal(canTransition('running', 'expired'), true);
  assert.equal(canTransition('stopped', 'running'), false);
  assert.equal(canTransition('expired', 'running'), false);
  assert.equal(canTransition('created', 'paused'), false);
  assert.equal(canTransition('running', 'running'), false);
  assert.equal(isLiveState('created'), true);
  assert.equal(isLiveState('running'), true);
  assert.equal(isLiveState('paused'), false);
  assert.equal(isTerminalState('stopped'), true);
  assert.equal(isTerminalState('expired'), true);
  assert.equal(isTerminalState('running'), false);

  const { clock, nowMs } = fakeClock();
  const lifecycle = new LifecycleController({ nowMs });
  assert.equal(lifecycle.getState(), 'created');
  assert.equal(lifecycle.mayRunStep(), false);
  assert.equal(lifecycle.pause(), false);
  assert.equal(lifecycle.resume(), false);
  assert.equal(lifecycle.start(), true);
  assert.equal(lifecycle.getState(), 'running');
  assert.equal(lifecycle.mayRunStep(), true);
  assert.equal(lifecycle.start(), false);
  assert.equal(lifecycle.pause('operator break'), true);
  assert.equal(lifecycle.isPaused(), true);
  assert.equal(lifecycle.mayRunStep(), false);
  assert.equal(lifecycle.getPauseCount(), 1);
  clock.value += 60_000;
  assert.equal(lifecycle.getTotalPausedMs(), 60_000);
  assert.equal(lifecycle.resume(), true);
  assert.equal(lifecycle.getTotalPausedMs(), 60_000);
  assert.equal(lifecycle.getState(), 'running');
  assert.equal(lifecycle.stop('done', 'completed'), true);
  assert.equal(lifecycle.getEndReason(), 'completed');
  assert.ok(lifecycle.getEndedAtMs() > 0);
  assert.equal(lifecycle.isTerminal(), true);
  assert.equal(lifecycle.stop(), false);
  assert.equal(lifecycle.describe().transitions, lifecycle.lifecycleEvents().length);
});

test('lifecycle: a pause that runs too long expires the session', () => {
  const { clock, nowMs } = fakeClock();
  const lifecycle = new LifecycleController({ maxPauseMs: 5_000, nowMs });
  lifecycle.start();
  lifecycle.pause();
  assert.equal(lifecycle.pauseRemainingMs(), 5_000);
  clock.value += 4_999;
  assert.equal(lifecycle.evaluatePauseExpiry(), false);
  clock.value += 1;
  assert.equal(lifecycle.evaluatePauseExpiry(), true);
  assert.equal(lifecycle.getState(), 'expired');
  assert.equal(lifecycle.getEndReason(), 'auto-stopped');
  assert.equal(lifecycle.evaluatePauseExpiry(), false);
});

test('lifecycle: registry tracks controllers and prunes terminated ones', () => {
  const registry = new LifecycleRegistry();
  const first = new LifecycleController({});
  const second = new LifecycleController({});
  registry.add('sess-a', first);
  registry.add('sess-b', second);
  assert.equal(registry.size(), 2);
  assert.throws(() => registry.add('sess-a', new LifecycleController({})), /already registered/);
  assert.equal(registry.has('sess-a'), true);
  assert.equal(registry.get('sess-a'), first);
  assert.deepEqual(registry.states().map((s) => s.sessionId).sort(), ['sess-a', 'sess-b']);
  first.start();
  first.stop();
  assert.deepEqual(registry.pruneTerminated(), ['sess-a']);
  assert.equal(registry.size(), 1);
  assert.equal(registry.remove('sess-b'), true);
  assert.equal(registry.remove('sess-b'), false);
  assert.equal(registry.size(), 0);
});
