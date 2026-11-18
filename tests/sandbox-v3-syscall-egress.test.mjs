/**
 * Tests cho Sandbox v3 — syscall allowlist + egress gate (v1.35, Đội T2).
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/sandbox-v3-syscall-egress.test.mjs
 *
 * Không gọi mạng thật, không chạy syscall thật: engine chỉ quyết
 * định + ghi log, test kiểm tra quyết định đó.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SANDBOX_V3_BASE_SYSCALLS,
  SANDBOX_V3_DANGEROUS_SYSCALLS,
  SANDBOX_V3_EGRESS_OFFLINE,
  SANDBOX_V3_EGRESS_RESTRICTED,
  SandboxV3EgressGate,
  SyscallAllowlist,
  defaultSyscallModeForTrust,
  diffSyscallModes,
  isPrivateEgressTarget,
  isPrivateIPv4,
  matchAnyEgressHost,
  matchEgressHost,
  parseEgressPolicy,
  parseEgressUrl,
  parseSyscallMode,
  syscallV3Group,
  validateSandboxV3EgressPolicy,
} from '../packages/core/dist/index.js';

test('syscall: strict mode allows base + read-only fs, denies net/process', () => {
  const engine = new SyscallAllowlist({ mode: 'strict' });
  for (const name of ['read', 'write', 'mmap', 'getpid', 'clock_gettime', 'futex']) {
    assert.equal(engine.checkSyscall(name).verdict, 'allow', name);
  }
  assert.equal(engine.checkSyscall('openat').verdict, 'allow');
  assert.equal(engine.checkSyscall('stat').verdict, 'allow');
  for (const name of ['socket', 'connect', 'fork', 'execve', 'mkdir', 'shmget']) {
    assert.equal(engine.checkSyscall(name).verdict, 'deny', name);
  }
  assert.ok(SANDBOX_V3_BASE_SYSCALLS.length > 20);
});

test('syscall: standard mode allows net + fs writes, denies execve + IPC', () => {
  const engine = new SyscallAllowlist({ mode: 'standard' });
  assert.equal(engine.checkSyscall('socket').verdict, 'allow');
  assert.equal(engine.checkSyscall('connect').verdict, 'allow');
  assert.equal(engine.checkSyscall('mkdir').verdict, 'allow');
  assert.equal(engine.checkSyscall('fork').verdict, 'allow');
  assert.equal(engine.checkSyscall('execve').verdict, 'deny');
  assert.equal(engine.checkSyscall('execveat').verdict, 'deny');
  assert.equal(engine.checkSyscall('shmget').verdict, 'deny');
  assert.equal(engine.checkSyscall('msgget').verdict, 'deny');
});

test('syscall: permissive mode allows execve + IPC, still denies dangerous', () => {
  const engine = new SyscallAllowlist({ mode: 'permissive' });
  assert.equal(engine.checkSyscall('execve').verdict, 'allow');
  assert.equal(engine.checkSyscall('shmget').verdict, 'allow');
  assert.equal(engine.checkSyscall('mq_open').verdict, 'allow');
  for (const name of ['ptrace', 'mount', 'bpf', 'init_module', 'reboot', 'keyctl', 'unshare', 'kexec_load']) {
    const check = engine.checkSyscall(name);
    assert.equal(check.verdict, 'deny', name);
    assert.equal(check.hardDenied, true, name);
    assert.equal(check.group, 'dangerous', name);
  }
  assert.ok(SANDBOX_V3_DANGEROUS_SYSCALLS.includes('ptrace'));
});

test('syscall: unknown syscalls are denied fail-closed', () => {
  const engine = new SyscallAllowlist({ mode: 'standard' });
  const check = engine.checkSyscall('definitely_not_a_syscall');
  assert.equal(check.verdict, 'deny');
  assert.equal(check.group, 'unknown');
  assert.match(check.reason, /fail-closed/);
});

test('syscall: extra deny wins over the mode set; extra allow cannot allow dangerous', () => {
  const engine = new SyscallAllowlist({
    mode: 'standard',
    extraDeny: ['socket'],
    extraAllow: ['ptrace', 'shmget'],
  });
  assert.equal(engine.checkSyscall('socket').verdict, 'deny');
  assert.equal(engine.checkSyscall('shmget').verdict, 'allow');
  const ptrace = engine.checkSyscall('ptrace');
  assert.equal(ptrace.verdict, 'deny');
  assert.equal(ptrace.hardDenied, true);
});

test('syscall: logOnlyDeny only logs policy denies, never dangerous ones', () => {
  const engine = new SyscallAllowlist({
    mode: 'standard',
    extraDeny: ['socket'],
    logOnlyDeny: true,
  });
  assert.equal(engine.checkSyscall('socket').verdict, 'log-only');
  assert.equal(engine.checkSyscall('ptrace').verdict, 'deny');
  assert.equal(engine.deniedCount(), 1);
});

test('syscall: batch check, allowsAll, group classification, mode diff', () => {
  const engine = new SyscallAllowlist({ mode: 'strict' });
  const batch = engine.checkBatch(['read', 'socket']);
  assert.equal(batch[0].verdict, 'allow');
  assert.equal(batch[1].verdict, 'deny');
  assert.equal(engine.allowsAll(['read', 'write']), true);
  assert.equal(engine.allowsAll(['read', 'socket']), false);
  assert.equal(syscallV3Group('read'), 'base');
  assert.equal(syscallV3Group('openat'), 'fs');
  assert.equal(syscallV3Group('connect'), 'net');
  assert.equal(syscallV3Group('fork'), 'process');
  assert.equal(syscallV3Group('shmget'), 'ipc');
  assert.equal(syscallV3Group('mount'), 'dangerous');
  assert.equal(syscallV3Group('nope'), 'unknown');
  const diff = diffSyscallModes('strict', 'standard');
  assert.ok(diff.added.includes('socket'));
  assert.ok(diff.added.includes('mkdir'));
  assert.deepEqual(diff.removed, []);
  assert.equal(parseSyscallMode('strict'), 'strict');
  assert.equal(parseSyscallMode('nope'), undefined);
  assert.equal(defaultSyscallModeForTrust('hostile'), 'strict');
  assert.equal(defaultSyscallModeForTrust('trusted'), 'permissive');
  assert.equal(defaultSyscallModeForTrust('standard'), 'standard');
  assert.ok(engine.describe().allowCount > 50);
});

test('egress: host matching is dot-boundary safe (suffix attack)', () => {
  assert.equal(matchEgressHost('api.example.com', '*.example.com'), true);
  assert.equal(matchEgressHost('a.b.example.com', '*.example.com'), true);
  assert.equal(matchEgressHost('example.com', '*.example.com'), false);
  assert.equal(matchEgressHost('xexample.com', '*.example.com'), false);
  assert.equal(matchEgressHost('notexample.com', '*.example.com'), false);
  assert.equal(matchEgressHost('xgithubusercontent.com', '*.githubusercontent.com'), false);
  assert.equal(matchEgressHost('example.com', '.example.com'), true);
  assert.equal(matchEgressHost('a.example.com', '.example.com'), true);
  assert.equal(matchEgressHost('example.com', 'example.com'), true);
  assert.equal(matchEgressHost('api.example.com', 'example.com'), false);
  assert.equal(matchEgressHost('anything.io', '*'), true);
  assert.equal(matchAnyEgressHost('api.example.com', ['other.com', '*.example.com']), true);
  assert.equal(matchAnyEgressHost('evil.com', ['other.com', '*.example.com']), false);
  assert.equal(matchEgressHost('EXAMPLE.COM.', 'example.com'), true);
});

test('egress: private / loopback / metadata targets are recognised', () => {
  assert.equal(isPrivateIPv4('10.0.0.1'), true);
  assert.equal(isPrivateIPv4('127.0.0.1'), true);
  assert.equal(isPrivateIPv4('192.168.1.1'), true);
  assert.equal(isPrivateIPv4('172.16.0.1'), true);
  assert.equal(isPrivateIPv4('172.31.255.255'), true);
  assert.equal(isPrivateIPv4('172.32.0.1'), false);
  assert.equal(isPrivateIPv4('8.8.8.8'), false);
  assert.equal(isPrivateIPv4('169.254.169.254'), true);
  assert.equal(isPrivateEgressTarget('169.254.169.254'), true);
  assert.equal(isPrivateEgressTarget('localhost'), true);
  assert.equal(isPrivateEgressTarget('api.local'), true);
  assert.equal(isPrivateEgressTarget('::1'), true);
  assert.equal(isPrivateEgressTarget('registry.npmjs.org'), false);
  const parsed = parseEgressUrl('https://registry.npmjs.org:8443/pkg');
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.scheme, 'https');
    assert.equal(parsed.host, 'registry.npmjs.org');
    assert.equal(parsed.port, 8443);
  }
  assert.equal(parseEgressUrl('not a url').ok, false);
  assert.equal(parseEgressUrl('https://').ok, false);
});

test('egress: offline policy denies everything', () => {
  const gate = new SandboxV3EgressGate({ policy: SANDBOX_V3_EGRESS_OFFLINE });
  const check = gate.check({ url: 'https://registry.npmjs.org/pkg' });
  assert.equal(check.verdict, 'deny');
  assert.equal(check.reason, 'network-disabled');
  assert.equal(gate.getDeniedCount(), 1);
});

test('egress: restricted policy allows listed hosts, denies the rest', () => {
  const gate = new SandboxV3EgressGate({ policy: SANDBOX_V3_EGRESS_RESTRICTED });
  assert.equal(gate.check({ url: 'https://registry.npmjs.org/pkg' }).verdict, 'allow');
  assert.equal(gate.check({ url: 'https://pypi.org/simple/' }).verdict, 'allow');
  assert.equal(gate.check({ url: 'https://files.pythonhosted.org/x' }).verdict, 'allow');
  assert.equal(gate.check({ url: 'https://api.github.com/repos' }).verdict, 'allow');
  assert.equal(gate.check({ url: 'https://evil.com/' }).reason, 'host-not-allowed');
  assert.equal(gate.check({ url: 'http://registry.npmjs.org/pkg' }).reason, 'scheme-not-allowed');
  assert.equal(gate.check({ url: 'https://registry.npmjs.org:8443/pkg' }).reason, 'port-not-allowed');
  assert.equal(gate.check({ url: 'https://169.254.169.254/latest/meta-data/' }).reason, 'host-blocked');
  assert.equal(gate.check({ url: 'https://api.internal.example.com/' }).reason, 'host-blocked');
  assert.equal(gate.check({ url: 'https://xgithubusercontent.com/' }).reason, 'host-not-allowed');
  assert.equal(gate.check({ url: 'not a url' }).reason, 'invalid-url');
});

test('egress: request budget and byte budget are enforced', () => {
  const requestGate = new SandboxV3EgressGate({
    policy: { ...SANDBOX_V3_EGRESS_RESTRICTED, maxRequests: 2, maxBytes: 0 },
  });
  assert.equal(requestGate.check({ url: 'https://registry.npmjs.org/a' }).verdict, 'allow');
  assert.equal(requestGate.check({ url: 'https://registry.npmjs.org/b' }).verdict, 'allow');
  const third = requestGate.check({ url: 'https://registry.npmjs.org/c' });
  assert.equal(third.verdict, 'deny');
  assert.equal(third.reason, 'request-budget-exceeded');
  assert.equal(requestGate.requestsRemaining(), 0);

  const byteGate = new SandboxV3EgressGate({
    policy: { ...SANDBOX_V3_EGRESS_RESTRICTED, maxRequests: 0, maxBytes: 100 },
  });
  assert.equal(byteGate.check({ url: 'https://registry.npmjs.org/a', expectedBytes: 60 }).verdict, 'allow');
  const over = byteGate.check({ url: 'https://registry.npmjs.org/b', expectedBytes: 60 });
  assert.equal(over.verdict, 'deny');
  assert.equal(over.reason, 'byte-budget-exceeded');
  byteGate.recordBytes(10);
  assert.equal(byteGate.getBytesUsed(), 70);
});

test('egress: policy validation flags bad shapes and warns on risky ones', () => {
  const ok = validateSandboxV3EgressPolicy(SANDBOX_V3_EGRESS_RESTRICTED);
  assert.equal(ok.valid, true);
  const bad = validateSandboxV3EgressPolicy({ enabled: 'yes' });
  assert.equal(bad.valid, false);
  assert.ok(bad.problems.length > 0);
  const empty = validateSandboxV3EgressPolicy({
    ...SANDBOX_V3_EGRESS_RESTRICTED,
    allowedHosts: [],
  });
  assert.equal(empty.valid, true);
  assert.ok(empty.warnings.some((w) => w.includes('allowedHosts is empty')));
  const parsed = parseEgressPolicy(JSON.stringify(SANDBOX_V3_EGRESS_RESTRICTED));
  assert.equal(parsed.enabled, true);
  assert.throws(() => parseEgressPolicy('{bad json'), /not valid JSON/);
  assert.throws(() => parseEgressPolicy('{"enabled":"yes"}'), /Invalid egress policy/);
});
