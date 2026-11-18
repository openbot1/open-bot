/**
 * Tests cho Sandbox v3 — policy-as-code (v1.35, Đội T2).
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/sandbox-v3-policy.test.mjs
 *
 * Không chạy gì thật: chỉ parse / validate / derive policy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILTIN_SANDBOX_V3_POLICIES,
  SANDBOX_V3_POLICY_SCHEMA_VERSION,
  assertValidSandboxV3Policy,
  builtinPolicyV3ForTrust,
  checkDeniedPaths,
  createSandboxV3Policy,
  defaultCapsV3ForTrust,
  defaultEgressForTrust,
  defaultLifetimeForTrust,
  deriveSandboxV3Policy,
  getBuiltinSandboxV3Policy,
  isDeniedSandboxV3Path,
  isPathUnderPrefixesV3,
  minTierV3ForTrust,
  parseSandboxV3Policy,
  serializeSandboxV3Policy,
  validateSandboxV3Policy,
} from '../packages/core/dist/index.js';

test('policy: five builtins with the right shape', () => {
  assert.deepEqual(Object.keys(BUILTIN_SANDBOX_V3_POLICIES).sort(), [
    'hostile',
    'standard',
    'strict',
    'trusted',
    'untrusted',
  ]);
  const strict = BUILTIN_SANDBOX_V3_POLICIES.strict;
  assert.equal(strict.trust, 'untrusted');
  assert.equal(strict.syscallMode, 'strict');
  assert.equal(strict.shellEnabled, false);
  assert.equal(strict.egress.enabled, false);
  assert.equal(strict.hooks.length, 1);
  const standard = BUILTIN_SANDBOX_V3_POLICIES.standard;
  assert.equal(standard.syscallMode, 'standard');
  assert.equal(standard.shellEnabled, true);
  const trusted = BUILTIN_SANDBOX_V3_POLICIES.trusted;
  assert.equal(trusted.syscallMode, 'permissive');
  assert.equal(trusted.egress.enabled, true);
  const hostile = BUILTIN_SANDBOX_V3_POLICIES.hostile;
  assert.equal(hostile.minTier, 'microvm');
  assert.equal(hostile.minTierLevel, 3);
  assert.equal(hostile.lifetime.maxLifetimeMs, 5 * 60 * 1000);
  assert.equal(hostile.hooks.length, 2);
  for (const policy of Object.values(BUILTIN_SANDBOX_V3_POLICIES)) {
    assert.equal(policy.schemaVersion, SANDBOX_V3_POLICY_SCHEMA_VERSION);
    assert.equal(policy.version, 1);
  }
});

test('policy: trust defaults — tiers, lifetimes, caps, egress', () => {
  assert.equal(minTierV3ForTrust('hostile'), 'microvm');
  assert.equal(minTierV3ForTrust('untrusted'), 'syscall-policy');
  assert.equal(minTierV3ForTrust('trusted'), 'bwrap');
  assert.equal(defaultLifetimeForTrust('hostile').maxLifetimeMs, 5 * 60 * 1000);
  assert.equal(defaultLifetimeForTrust('trusted').maxLifetimeMs, 2 * 60 * 60 * 1000);
  assert.equal(defaultLifetimeForTrust('untrusted').idleTimeoutMs, 5 * 60 * 1000);
  assert.ok(defaultCapsV3ForTrust('hostile').maxSteps < defaultCapsV3ForTrust('trusted').maxSteps);
  assert.equal(defaultCapsV3ForTrust('hostile').maxSnapshots, 1);
  assert.equal(defaultEgressForTrust('trusted').enabled, true);
  assert.equal(defaultEgressForTrust('standard').enabled, false);
  assert.equal(defaultEgressForTrust('hostile').enabled, false);
  assert.equal(builtinPolicyV3ForTrust('trusted').id, 'trusted');
  assert.equal(builtinPolicyV3ForTrust('hostile').id, 'hostile');
  assert.equal(builtinPolicyV3ForTrust('standard').id, 'standard');
});

test('policy: builtin lookup returns a copy, unknown id is undefined', () => {
  const first = getBuiltinSandboxV3Policy('standard');
  assert.ok(first);
  first.name = 'MUTATED';
  const second = getBuiltinSandboxV3Policy('standard');
  assert.equal(second.name, 'Standard');
  assert.equal(getBuiltinSandboxV3Policy('no-such-policy'), undefined);
});

test('policy: create fills defaults from the trust level', () => {
  const policy = createSandboxV3Policy({
    id: 'custom',
    name: 'Custom',
    description: 'Custom policy for CI.',
    trust: 'untrusted',
  });
  assert.equal(policy.syscallMode, 'strict');
  assert.equal(policy.minTier, 'syscall-policy');
  assert.equal(policy.minTierLevel, 2);
  assert.equal(policy.egress.enabled, false);
  assert.equal(policy.lifetime.maxLifetimeMs, 15 * 60 * 1000);
  assert.equal(policy.shellEnabled, true);
  assert.equal(policy.version, 1);
  assert.ok(policy.updatedAt.length > 0);
});

test('policy: validation accepts builtins and rejects bad documents', () => {
  for (const policy of Object.values(BUILTIN_SANDBOX_V3_POLICIES)) {
    const result = validateSandboxV3Policy(policy);
    assert.equal(result.valid, true, policy.id);
    assert.deepEqual(result.problems, []);
  }
  assert.deepEqual(validateSandboxV3Policy(null).problems, [
    'Sandbox v3 policy must be a JSON object',
  ]);
  assert.deepEqual(validateSandboxV3Policy('nope').problems, [
    'Sandbox v3 policy must be a JSON object',
  ]);
  const base = createSandboxV3Policy({
    id: 't', name: 'T', description: 'd', trust: 'standard',
  });
  const badSchema = validateSandboxV3Policy({ ...base, schemaVersion: 99 });
  assert.equal(badSchema.valid, false);
  assert.ok(badSchema.problems.some((p) => p.includes('schemaVersion')));
  const badTrust = validateSandboxV3Policy({ ...base, trust: 'god-mode' });
  assert.equal(badTrust.valid, false);
  const badMode = validateSandboxV3Policy({ ...base, syscallMode: 'yolo' });
  assert.equal(badMode.valid, false);
  const hostileShell = validateSandboxV3Policy({
    ...BUILTIN_SANDBOX_V3_POLICIES.hostile,
    shellEnabled: true,
  });
  assert.equal(hostileShell.valid, false);
  assert.ok(hostileShell.problems.some((p) => p.includes('hostile policy must not enable the shell')));
  const badLifetime = validateSandboxV3Policy({
    ...base,
    lifetime: { ...base.lifetime, maxLifetimeMs: 60_000 * 60 * 5 },
  });
  assert.equal(badLifetime.valid, false);
  const badCaps = validateSandboxV3Policy({
    ...base,
    caps: { ...base.caps, maxSteps: 99_999 },
  });
  assert.equal(badCaps.valid, false);
  const badHook = validateSandboxV3Policy({
    ...base,
    hooks: [{ name: 'x', timing: 'pre', decision: 'modify' }],
  });
  assert.equal(badHook.valid, false);
  assert.ok(badHook.problems.some((p) => p.includes('without modifyArgs')));
});

test('policy: dangerous syscalls in allow, and denied paths, are rejected', () => {
  const base = createSandboxV3Policy({
    id: 't', name: 'T', description: 'd', trust: 'standard',
  });
  const dangerous = validateSandboxV3Policy({
    ...base,
    syscalls: { allow: ['read', 'ptrace', 'mount'], deny: [], logOnlyDeny: false },
  });
  assert.equal(dangerous.valid, false);
  assert.ok(dangerous.problems.some((p) => p.includes('ptrace')));
  const badPaths = validateSandboxV3Policy({
    ...base,
    files: { readPrefixes: ['/home/user/.ssh'], writePrefixes: [], denyPrefixes: [] },
  });
  assert.equal(badPaths.valid, false);
  assert.ok(badPaths.problems.some((p) => p.includes('.ssh')));
  const badSuffix = validateSandboxV3Policy({
    ...base,
    files: { readPrefixes: ['/home/user/id_rsa'], writePrefixes: [], denyPrefixes: [] },
  });
  assert.equal(badSuffix.valid, false);
});

test('policy: parse / serialize round-trip, assert throws on invalid', () => {
  const policy = BUILTIN_SANDBOX_V3_POLICIES.standard;
  const json = serializeSandboxV3Policy(policy);
  const parsed = parseSandboxV3Policy(json);
  assert.equal(parsed.id, 'standard');
  assert.equal(parsed.version, 1);
  assert.throws(() => parseSandboxV3Policy('{bad'), /not valid JSON/);
  assert.throws(() => parseSandboxV3Policy('{"id":1}'), /Invalid sandbox v3 policy/);
  assert.throws(() => assertValidSandboxV3Policy({}), /Invalid sandbox v3 policy/);
  assert.equal(assertValidSandboxV3Policy(policy).id, 'standard');
});

test('policy: derive only ever tightens — never loosens', () => {
  const base = BUILTIN_SANDBOX_V3_POLICIES.trusted;
  const derived = deriveSandboxV3Policy(base, {
    maxLifetimeMs: 60_000,
    maxSteps: 10,
    extraDenySyscalls: ['socket'],
    egressAllowedHosts: ['registry.npmjs.org'],
    shellEnabled: false,
    extraHooks: [
      { name: 'extra-deny', timing: 'pre', decision: 'deny', matcher: { toolPattern: 'shell_*' } },
    ],
  });
  assert.equal(derived.version, 2);
  assert.equal(derived.previousVersion, 1);
  assert.equal(derived.lifetime.maxLifetimeMs, 60_000);
  assert.equal(derived.caps.maxSteps, 10);
  assert.ok(derived.syscalls.deny.includes('socket'));
  assert.equal(derived.shellEnabled, false);
  assert.equal(derived.hooks.length, base.hooks.length + 1);
  // Growing back is ignored: the derived policy stays at the tighter value.
  const grown = deriveSandboxV3Policy(derived, { maxLifetimeMs: 10 * 60 * 60 * 1000, maxSteps: 9999 });
  assert.equal(grown.lifetime.maxLifetimeMs, 60_000);
  assert.equal(grown.caps.maxSteps, 10);
  assert.equal(grown.version, 3);
  // Loosening the syscall mode is ignored too.
  const loosened = deriveSandboxV3Policy(BUILTIN_SANDBOX_V3_POLICIES.strict, { syscallMode: 'permissive' });
  assert.equal(loosened.syscallMode, 'strict');
  const tightened = deriveSandboxV3Policy(BUILTIN_SANDBOX_V3_POLICIES.trusted, { syscallMode: 'standard' });
  assert.equal(tightened.syscallMode, 'standard');
});

test('policy: denied-path helpers', () => {
  assert.deepEqual(checkDeniedPaths(['/home/u/.ssh', '/tmp/x']), ['/home/u/.ssh']);
  assert.deepEqual(checkDeniedPaths(['/tmp/x', '/tmp/y']), []);
  assert.deepEqual(checkDeniedPaths(['/home/u/key.pem']), ['/home/u/key.pem']);
  assert.equal(isDeniedSandboxV3Path('/home/u/.aws/credentials'), true);
  assert.equal(isDeniedSandboxV3Path('/home/u/.ssh/id_ed25519'), true);
  assert.equal(isDeniedSandboxV3Path('/home/u/notes.txt'), false);
  assert.equal(isDeniedSandboxV3Path('/home/u/secret.env'), true);
  const policy = createSandboxV3Policy({
    id: 't', name: 'T', description: 'd', trust: 'standard',
    files: { readPrefixes: ['/work'], writePrefixes: [], denyPrefixes: ['/work/secret'] },
  });
  assert.equal(isDeniedSandboxV3Path('/work/secret/a.txt', policy), true);
  assert.equal(isDeniedSandboxV3Path('/work/ok.txt', policy), false);
  assert.equal(isDeniedSandboxV3Path('/elsewhere.txt', policy), true);
  assert.equal(isPathUnderPrefixesV3('/work/a.txt', ['/work']), true);
  assert.equal(isPathUnderPrefixesV3('/other/a.txt', ['/work']), false);
});
