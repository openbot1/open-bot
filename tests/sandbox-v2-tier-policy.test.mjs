/**
 * Tests cho Sandbox v2 — tier selector + policy-as-code (v1.34, Đội T2).
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/sandbox-v2-tier-policy.test.mjs
 *
 * Không gọi mạng thật, không chạy VM thật, không đọc credential thật:
 * host capabilities đều là fake inject qua probe/select options.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILTIN_SANDBOX_V2_POLICIES,
  SANDBOX_V2_POLICY_SCHEMA_VERSION,
  assertValidSandboxV2Policy,
  builtinPolicyForTrust,
  createSandboxV2Policy,
  deriveSandboxV2Policy,
  describeHostCapabilities,
  getBuiltinSandboxV2Policy,
  isDeniedSandboxV2Path,
  isPathUnderPrefixes,
  minTierForTrust,
  parseSandboxV2Policy,
  probeHostCapabilities,
  selectSandboxV2Tier,
  serializeSandboxV2Policy,
  tierSupportedOnHost,
  validateSandboxV2Policy,
} from '../packages/core/dist/index.js';

function fakeHost(overrides = {}) {
  return {
    platform: 'linux',
    bwrapAvailable: true,
    unshareAvailable: true,
    kvmAvailable: true,
    cpuCount: 4,
    totalMemoryBytes: 8 * 1024 * 1024 * 1024,
    firecrackerAvailable: true,
    ...overrides,
  };
}

test('tier selector: trusted code on a full host gets tier 1 bwrap', () => {
  const policy = builtinPolicyForTrust('trusted');
  const decision = selectSandboxV2Tier({ trust: 'trusted', policy, host: fakeHost() });
  assert.equal(decision.tier, 'bwrap');
  assert.equal(decision.level, 1);
  assert.equal(decision.downgraded, false);
});

test('tier selector: standard trust floors at tier 2 even when tier 1 requested', () => {
  const policy = builtinPolicyForTrust('standard');
  const decision = selectSandboxV2Tier({ trust: 'standard', policy, requestedTier: 'bwrap', host: fakeHost() });
  assert.equal(decision.tier, 'syscall-policy');
  assert.equal(decision.level, 2);
  assert.match(decision.reason, /below the floor/);
});

test('tier selector: hostile code requires tier 3 and is honoured on a KVM host', () => {
  const policy = builtinPolicyForTrust('hostile');
  const decision = selectSandboxV2Tier({ trust: 'hostile', policy, host: fakeHost() });
  assert.equal(decision.tier, 'microvm');
  assert.equal(decision.level, 3);
});

test('tier selector: requested tier above the floor is honoured', () => {
  const policy = builtinPolicyForTrust('standard');
  const decision = selectSandboxV2Tier({ trust: 'standard', policy, requestedTier: 'microvm', host: fakeHost() });
  assert.equal(decision.tier, 'microvm');
});

test('tier selector: downgrade is loud when the host has no KVM', () => {
  const policy = builtinPolicyForTrust('standard');
  const decision = selectSandboxV2Tier({
    trust: 'standard',
    policy,
    requestedTier: 'microvm',
    host: fakeHost({ kvmAvailable: false }),
  });
  assert.equal(decision.tier, 'syscall-policy');
  assert.equal(decision.downgraded, true);
  assert.match(decision.reason, /DOWNGRADED/);
  assert.equal(decision.requestedTier, 'microvm');
});

test('tier selector: hostile code is REFUSED (throws) when no KVM host exists', () => {
  const policy = builtinPolicyForTrust('hostile');
  assert.throws(
    () => selectSandboxV2Tier({ trust: 'hostile', policy, host: fakeHost({ kvmAvailable: false }) }),
    /Refusing hostile code/,
  );
});

test('tier selector: bwrap unsupported without bwrap/unshare, policy engine always supported', () => {
  const host = fakeHost({ bwrapAvailable: false, unshareAvailable: false });
  assert.equal(tierSupportedOnHost('bwrap', host), false);
  assert.equal(tierSupportedOnHost('syscall-policy', host), true);
  assert.equal(tierSupportedOnHost('microvm', fakeHost({ kvmAvailable: false })), false);
});

test('tier selector: policy minimum tier wins over trust floor', () => {
  const policy = createSandboxV2Policy({ id: 'paranoid', trust: 'trusted', minTier: 'microvm' });
  const decision = selectSandboxV2Tier({ trust: 'trusted', policy, host: fakeHost() });
  assert.equal(decision.tier, 'microvm');
});

test('host probe: injectable fns fake any host without touching /dev/kvm', () => {
  const host = probeHostCapabilities({
    platform: () => 'darwin',
    commandAvailable: () => false,
    kvmReadable: () => false,
    cpuCount: () => 8,
    totalMemoryBytes: () => 16 * 1024 * 1024 * 1024,
  });
  assert.equal(host.platform, 'darwin');
  assert.equal(host.bwrapAvailable, false);
  assert.equal(host.kvmAvailable, false);
  assert.equal(host.cpuCount, 8);
  assert.match(describeHostCapabilities(host), /platform=darwin/);
});

test('policy: builtin policies exist for every trust level and validate clean', () => {
  for (const trust of ['trusted', 'standard', 'untrusted', 'hostile']) {
    const policy = builtinPolicyForTrust(trust);
    const result = validateSandboxV2Policy(policy);
    assert.equal(result.valid, true, `${trust}: ${result.problems.join('; ')}`);
    assert.equal(policy.schemaVersion, SANDBOX_V2_POLICY_SCHEMA_VERSION);
  }
  assert.equal(Object.keys(BUILTIN_SANDBOX_V2_POLICIES).length, 4);
  assert.equal(minTierForTrust('trusted'), 'bwrap');
  assert.equal(minTierForTrust('standard'), 'syscall-policy');
  assert.equal(minTierForTrust('hostile'), 'microvm');
});

test('policy: strict policy has no shell and no network', () => {
  const strict = getBuiltinSandboxV2Policy('strict');
  assert.ok(strict);
  assert.equal(strict.shellEnabled, false);
  assert.equal(strict.network.enabled, false);
  assert.equal(strict.minTier, 'microvm');
  assert.equal(getBuiltinSandboxV2Policy('no-such-policy'), undefined);
});

test('policy: validation catches bad schema version, bad trust, tier below floor', () => {
  const base = builtinPolicyForTrust('standard');
  const badSchema = validateSandboxV2Policy({ ...base, schemaVersion: 99 });
  assert.equal(badSchema.valid, false);
  assert.match(badSchema.problems.join(' '), /schemaVersion/);

  const badTrust = validateSandboxV2Policy({ ...base, trust: 'god-mode' });
  assert.equal(badTrust.valid, false);
  assert.match(badTrust.problems.join(' '), /trust must be/);

  const belowFloor = validateSandboxV2Policy({ ...base, minTier: 'bwrap' });
  assert.equal(belowFloor.valid, false);
  assert.match(belowFloor.problems.join(' '), /below the floor/);
});

test('policy: validation catches syscall allow/deny overlap, bad ports, traversal prefixes', () => {
  const base = builtinPolicyForTrust('standard');
  const overlap = validateSandboxV2Policy({
    ...base,
    syscalls: { allow: ['open'], deny: ['open'], logOnlyDeny: false },
  });
  assert.equal(overlap.valid, false);
  assert.match(overlap.problems.join(' '), /both allow and deny/);

  const badPort = validateSandboxV2Policy({
    ...base,
    network: { enabled: true, hosts: ['example.com'], hostSuffixes: [], ports: [99999] },
  });
  assert.equal(badPort.valid, false);
  assert.match(badPort.problems.join(' '), /ports/);

  const traversal = validateSandboxV2Policy({
    ...base,
    files: { readPrefixes: ['../etc'], writePrefixes: ['.'], denyPrefixes: [] },
  });
  assert.equal(traversal.valid, false);
  assert.match(traversal.problems.join(' '), /\.\./);
});

test('policy: network enabled with no hosts warns but still validates', () => {
  const base = builtinPolicyForTrust('standard');
  const result = validateSandboxV2Policy({
    ...base,
    network: { enabled: true, hosts: [], hostSuffixes: [], ports: [] },
  });
  assert.equal(result.valid, true);
  assert.match(result.warnings.join(' '), /no hosts are allow-listed/);
});

test('policy: caps above the ceiling are rejected', () => {
  const base = builtinPolicyForTrust('standard');
  const result = validateSandboxV2Policy({
    ...base,
    caps: { ...base.caps, maxLifetimeMs: 99_999_999, maxTokenTtlMs: 99_999_999 },
  });
  assert.equal(result.valid, false);
  assert.match(result.problems.join(' '), /maxLifetimeMs/);
  assert.match(result.problems.join(' '), /maxTokenTtlMs/);
});

test('policy: parse/serialize round-trip and derive bumps the version', () => {
  const base = builtinPolicyForTrust('standard');
  const json = serializeSandboxV2Policy(base);
  const parsed = parseSandboxV2Policy(json);
  assert.equal(parsed.id, base.id);
  assert.equal(parsed.version, base.version);

  const derived = deriveSandboxV2Policy(base, { shellEnabled: true, commands: ['node'] });
  assert.equal(derived.version, base.version + 1);
  assert.equal(derived.previousVersion, base.version);
  assert.deepEqual(derived.commands, ['node']);
  assert.throws(() => parseSandboxV2Policy('{not json'), /not valid JSON/);
  assert.throws(() => assertValidSandboxV2Policy({ id: '' }), /Invalid sandbox v2 policy/);
});

test('policy: denied paths beat any allow-list; prefix matching is segment-based', () => {
  assert.equal(isDeniedSandboxV2Path('/home/u/.ssh/id_ed25519'), true);
  assert.equal(isDeniedSandboxV2Path('vault/token.json'), true);
  assert.equal(isDeniedSandboxV2Path('/tmp/work/file.txt'), false);
  assert.equal(isDeniedSandboxV2Path('notes/.env'), true);
  assert.equal(isPathUnderPrefixes('src/a/b.ts', ['src']), true);
  assert.equal(isPathUnderPrefixes('src2/a.ts', ['src']), false);
  assert.equal(isPathUnderPrefixes('anything/at/all', ['.']), true);
  assert.equal(isPathUnderPrefixes('/etc/passwd', ['.']), true);
});
