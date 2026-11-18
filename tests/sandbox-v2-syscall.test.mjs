/**
 * Tests cho Sandbox v2 — syscall policy engine (v1.34, Đội T2).
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/sandbox-v2-syscall.test.mjs
 *
 * Không gọi mạng thật, không chạy syscall thật: engine chỉ quyết
 * định + ghi log, test kiểm tra quyết định đó.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SANDBOX_V2_BASE_SYSCALLS,
  SANDBOX_V2_DANGEROUS_SYSCALLS,
  SyscallPolicyEngine,
  builtinPolicyForTrust,
  syscallGroup,
} from '../packages/core/dist/index.js';

function engineFor(trust = 'standard', tier = 'syscall-policy', patch = {}) {
  const base = builtinPolicyForTrust(trust);
  const policy = { ...base, ...patch };
  return new SyscallPolicyEngine({ policy, tier });
}

test('syscall: base syscalls are allowed', () => {
  const engine = engineFor();
  for (const name of ['read', 'write', 'mmap', 'getpid', 'clock_gettime', 'futex']) {
    const check = engine.checkSyscall(name);
    assert.equal(check.verdict, 'allow', name);
    assert.equal(check.group, 'base');
  }
  assert.ok(SANDBOX_V2_BASE_SYSCALLS.length > 20);
});

test('syscall: dangerous syscalls are always denied, even when allow-listed', () => {
  const engine = engineFor('trusted', 'bwrap', {
    syscalls: { allow: ['ptrace', 'bpf'], deny: [], logOnlyDeny: false },
  });
  for (const name of ['ptrace', 'mount', 'bpf', 'init_module', 'reboot', 'keyctl', 'unshare']) {
    const check = engine.checkSyscall(name);
    assert.equal(check.verdict, 'deny', name);
    assert.equal(check.hardDenied, true);
    assert.equal(check.group, 'dangerous');
  }
  assert.ok(SANDBOX_V2_DANGEROUS_SYSCALLS.includes('ptrace'));
  assert.equal(engine.blockedEvents().length, 7);
});

test('syscall: unknown syscalls are denied fail-closed', () => {
  const engine = engineFor();
  const check = engine.checkSyscall('definitely_not_a_syscall');
  assert.equal(check.verdict, 'deny');
  assert.equal(check.group, 'unknown');
  assert.match(check.reason, /fail-closed/);
});

test('syscall: policy deny list denies, logOnlyDeny only logs', () => {
  const denying = engineFor('standard', 'syscall-policy', {
    syscalls: { allow: [], deny: ['connect'], logOnlyDeny: false },
  });
  assert.equal(denying.checkSyscall('connect').verdict, 'deny');
  assert.equal(denying.blockedEvents()[0].logOnly, false);

  const logging = engineFor('standard', 'syscall-policy', {
    syscalls: { allow: [], deny: ['connect'], logOnlyDeny: true },
  });
  const check = logging.checkSyscall('connect');
  assert.equal(check.verdict, 'log-only');
  assert.equal(logging.blockedEvents()[0].logOnly, true);
});

test('syscall: network syscalls denied when the policy disables network', () => {
  const engine = engineFor('untrusted');
  const check = engine.checkSyscall('connect');
  assert.equal(check.verdict, 'deny');
  assert.match(check.reason, /network is disabled/);
});

test('syscall: network syscalls allowed when the policy enables network', () => {
  const engine = engineFor('standard');
  assert.equal(engine.checkSyscall('socket').verdict, 'allow');
  assert.equal(engine.checkSyscall('connect').verdict, 'allow');
});

test('syscall: process syscalls denied when shell is disabled', () => {
  const engine = engineFor('hostile');
  const check = engine.checkSyscall('execve');
  assert.equal(check.verdict, 'deny');
  assert.match(check.reason, /shell is disabled/);
});

test('syscall: groups classify known syscalls', () => {
  assert.equal(syscallGroup('openat'), 'base');
  assert.equal(syscallGroup('unlink'), 'fs');
  assert.equal(syscallGroup('socket'), 'net');
  assert.equal(syscallGroup('execve'), 'process');
  assert.equal(syscallGroup('ptrace'), 'dangerous');
  assert.equal(syscallGroup('nope'), 'unknown');
});

test('file: read/write inside the allow-list pass, outside are denied', () => {
  const engine = engineFor();
  assert.equal(engine.checkFile('file-read', 'src/index.ts').allowed, true);
  assert.equal(engine.checkFile('file-write', 'out/result.txt').allowed, true);
  const denied = engineFor('standard', 'syscall-policy', {
    files: { readPrefixes: ['src'], writePrefixes: ['out'], denyPrefixes: [] },
  });
  assert.equal(denied.checkFile('file-read', 'src/a.ts').allowed, true);
  assert.equal(denied.checkFile('file-read', 'etc/passwd').allowed, false);
  assert.equal(denied.checkFile('file-write', 'src/a.ts').allowed, false);
  assert.equal(denied.checkFile('file-write', 'out/b.txt').allowed, true);
});

test('file: traversal and credential paths are always denied', () => {
  const engine = engineFor('trusted');
  assert.equal(engine.checkFile('file-read', '../etc/passwd').allowed, false);
  assert.equal(engine.checkFile('file-read', '/home/u/.ssh/id_rsa').allowed, false);
  assert.equal(engine.checkFile('file-write', 'work/.env').allowed, false);
  assert.equal(engine.checkFile('file-read', 'work/key.pem').allowed, false);
  assert.equal(engine.checkFile('file-read', '').allowed, false);
  const blocked = engine.blockedEvents();
  assert.ok(blocked.some((e) => e.kind === 'file-read' && e.target.includes('.ssh')));
  assert.ok(blocked.every((e) => e.tier === 'syscall-policy'));
});

test('file: policy deny prefixes beat the allow-list', () => {
  const engine = engineFor('standard', 'syscall-policy', {
    files: { readPrefixes: ['.'], writePrefixes: ['.'], denyPrefixes: ['secrets'] },
  });
  assert.equal(engine.checkFile('file-read', 'secrets/a.txt').allowed, false);
  assert.equal(engine.checkFile('file-read', 'public/a.txt').allowed, true);
});

test('network: exact host and suffix allow-list, port allow-list, off by default', () => {
  const engine = engineFor('standard');
  assert.equal(engine.checkNetwork('registry.npmjs.org', 443).allowed, true);
  assert.equal(engine.checkNetwork('api.github.com', 443).allowed, true);
  // 'xgithubusercontent.com' KHÔNG có dấu chấm trước suffix nên KHÔNG
  // phải subdomain của githubusercontent.com — suffix-attack phải deny.
  // (Trước đây ghi 'x.githubusercontent.com' — đó lại là subdomain hợp
  // lệ nên expect false là sai.)
  assert.equal(engine.checkNetwork('xgithubusercontent.com', 443).allowed, false);
  assert.equal(engine.checkNetwork('foo.githubusercontent.com', 443).allowed, true);
  assert.equal(engine.checkNetwork('evil.example.com', 443).allowed, false);
  assert.equal(engine.checkNetwork('registry.npmjs.org', 8080).allowed, false);
  assert.equal(engine.checkNetwork('registry.npmjs.org').allowed, true);

  const off = engineFor('untrusted');
  assert.equal(off.checkNetwork('registry.npmjs.org', 443).allowed, false);
});

test('exec: allow-listed commands pass, others denied, no shell denies all', () => {
  const engine = engineFor('standard');
  assert.equal(engine.checkExec('node').allowed, true);
  assert.equal(engine.checkExec('npm install').allowed, true);
  assert.equal(engine.checkExec('rm -rf /').allowed, false);
  assert.equal(engine.checkExec('/usr/bin/node').allowed, true);

  const noShell = engineFor('hostile');
  assert.equal(noShell.checkExec('node').allowed, false);
});

test('engine: blocked events are sequenced and counted by kind', () => {
  const engine = engineFor('untrusted');
  engine.checkSyscall('ptrace');
  engine.checkFile('file-read', '../etc/passwd');
  engine.checkNetwork('evil.example.com');
  engine.checkExec('curl');
  const events = engine.blockedEvents();
  assert.equal(events.length, 4);
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4]);
  assert.deepEqual(engine.blockedCounts(), { syscall: 1, 'file-read': 1, network: 1, exec: 1 });
});

test('engine: filter description + effective allow set exclude dangerous syscalls', () => {
  const engine = engineFor('standard');
  const desc = engine.describeFilter();
  assert.match(desc, /policy standard v1/);
  assert.match(desc, /DENY always/);
  assert.match(desc, /ptrace/);
  assert.match(desc, /NETWORK: enabled/);
  const allow = engine.effectiveAllowSet();
  assert.ok(allow.includes('read'));
  assert.ok(!allow.includes('ptrace'));
  assert.ok(!allow.includes('bpf'));
});
