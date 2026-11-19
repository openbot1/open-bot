/**
 * Tests cho Sandbox v6 — exec audit log (v1.38, Đội T3).
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/sandbox-v6-audit.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  SANDBOX_V6_AUDIT_FILE,
  SandboxV6AuditLogger,
  filterSandboxV6AuditEntries,
  readSandboxV6AuditFile,
  summarizeSandboxV6AuditEntries,
  verifySandboxV6AuditChain,
  verifySandboxV6AuditFiles,
  sandboxV6AuditFilesForBot,
  renderSandboxV6AuditMarkdown,
  scrubSandboxV6Secrets,
} from '../packages/core/dist/sandboxV6/index.js';

const tempDirs = [];
function makeTempDir(prefix = 'open-bot-sandbox-v6-audit-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

test.afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function makeLogger(botId = 'bot-a', opts = {}) {
  const dir = makeTempDir();
  const logger = new SandboxV6AuditLogger({ dir: path.join(dir, 'audit'), botId, ...opts });
  return { dir, logger };
}

test('record appends chained entries with seq + hash, reload rebuilds the chain', () => {
  const { logger } = makeLogger();
  const e1 = logger.record({ runtimeId: 'r1', kind: 'runtime-created', detail: 'created' });
  const e2 = logger.record({ runtimeId: 'r1', kind: 'exec-start', command: '/bin/echo', args: ['hi'] });
  assert.equal(e1.seq, 1);
  assert.equal(e2.seq, 2);
  assert.equal(e2.prevHash, e1.hash);
  assert.equal(e1.prevHash, '');
  assert.equal(logger.count, 2);
  assert.equal(logger.verifyChain().ok, true);
  // A fresh logger on the same dir continues the chain.
  const logger2 = new SandboxV6AuditLogger({ dir: logger.dir, botId: 'bot-a' });
  const e3 = logger2.record({ runtimeId: 'r1', kind: 'exec-finish', exitCode: 0 });
  assert.equal(e3.seq, 3);
  assert.equal(e3.prevHash, e2.hash);
  assert.equal(logger2.verifyChain().ok, true);
});

test('tampering with an entry breaks the chain at that seq', () => {
  const { logger } = makeLogger();
  logger.record({ runtimeId: 'r1', kind: 'exec-start', command: '/bin/echo' });
  logger.record({ runtimeId: 'r1', kind: 'exec-finish', exitCode: 0 });
  logger.record({ runtimeId: 'r1', kind: 'exec-start', command: '/bin/ls' });
  const file = path.join(logger.dir, SANDBOX_V6_AUDIT_FILE);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const tampered = JSON.parse(lines[1]);
  tampered.exitCode = 99; // edit history after the fact
  lines[1] = JSON.stringify(tampered);
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  const check = logger.verifyChain();
  assert.equal(check.ok, false);
  assert.deepEqual(check.brokenAt, [2]);
});

test('deleting a middle entry breaks the chain (seq gap)', () => {
  const { logger } = makeLogger();
  logger.record({ runtimeId: 'r1', kind: 'exec-start', command: 'a' });
  logger.record({ runtimeId: 'r1', kind: 'exec-finish', exitCode: 0 });
  logger.record({ runtimeId: 'r1', kind: 'exec-start', command: 'b' });
  const file = path.join(logger.dir, SANDBOX_V6_AUDIT_FILE);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  fs.writeFileSync(file, `${lines[0]}\n${lines[2]}\n`, 'utf8');
  const check = logger.verifyChain();
  assert.equal(check.ok, false);
  assert.ok(check.brokenAt.includes(3));
});

test('query filters by kind / text / exit code, newest first, limited', () => {
  const { logger } = makeLogger();
  logger.record({ runtimeId: 'r1', kind: 'exec-start', command: '/bin/echo', args: ['hello'] });
  logger.record({ runtimeId: 'r1', kind: 'exec-finish', command: '/bin/echo', exitCode: 0 });
  logger.record({ runtimeId: 'r1', kind: 'exec-start', command: '/bin/false' });
  logger.record({ runtimeId: 'r1', kind: 'exec-finish', command: '/bin/false', exitCode: 1 });
  logger.record({ runtimeId: 'r1', kind: 'quota-changed', detail: 'quota raised' });

  assert.equal(logger.query({ kind: 'exec-finish' }).length, 2);
  assert.equal(logger.query({ exitCode: 1 }).length, 1);
  assert.equal(logger.query({ text: 'echo' }).length, 2);
  assert.equal(logger.query({ text: 'ECHO' }).length, 2); // case-insensitive
  const limited = logger.query({ limit: 2 });
  assert.equal(limited.length, 2);
  assert.equal(limited[0].kind, 'quota-changed'); // newest first
  assert.equal(logger.query({ runtimeId: 'other' }).length, 0);
});

test('summarize counts kinds + exit codes + chain verdict', () => {
  const { logger } = makeLogger();
  logger.record({ runtimeId: 'r1', kind: 'exec-start', command: 'a' });
  logger.record({ runtimeId: 'r1', kind: 'exec-finish', exitCode: 0 });
  logger.record({ runtimeId: 'r1', kind: 'exec-start', command: 'b' });
  logger.record({ runtimeId: 'r1', kind: 'exec-timeout', exitCode: null });
  logger.record({ runtimeId: 'r1', kind: 'exec-refused', detail: 'disk full' });
  logger.record({ runtimeId: 'r1', kind: 'secret-access-denied', detail: 'bot-b tried' });
  const summary = logger.summarize();
  assert.equal(summary.totalEntries, 6);
  assert.equal(summary.execStarts, 2);
  assert.equal(summary.execFinishes, 1);
  assert.equal(summary.execTimeouts, 1);
  assert.equal(summary.execRefused, 1);
  assert.equal(summary.secretDenied, 1);
  assert.deepEqual(summary.exitCodes, { 0: 1 });
  assert.equal(summary.chainOk, true);
  assert.deepEqual(summary.chainBrokenAt, []);
  assert.ok(summary.firstMs > 0 && summary.lastMs >= summary.firstMs);
});

test('secrets are scrubbed from commands, args, detail and stdout excerpts', () => {
  const { logger } = makeLogger();
  const secret = 'sk-live-abcdef123456';
  logger.registerSecret(secret);
  const entry = logger.record({
    runtimeId: 'r1',
    kind: 'exec-finish',
    command: '/bin/sh',
    args: ['-c', `echo ${secret}`],
    detail: `stdout=token ${secret} end`,
    exitCode: 0,
  });
  assert.ok(!entry.command.includes(secret));
  assert.ok(!entry.args.join(' ').includes(secret));
  assert.ok(!entry.detail.includes(secret));
  assert.ok(entry.detail.includes('[REDACTED]'));
  // The file on disk must not contain the value either.
  const raw = fs.readFileSync(path.join(logger.dir, SANDBOX_V6_AUDIT_FILE), 'utf8');
  assert.ok(!raw.includes(secret));
  // Unregistering stops future scrubbing but old entries stay scrubbed.
  logger.unregisterSecret(secret);
  assert.equal(logger.scrub(`x ${secret}`), `x ${secret}`);
  assert.equal(scrubSandboxV6Secrets(`a ${secret} b`, ['short']), `a ${secret} b`); // <4 chars ignored
});

test('rotation moves the log aside and starts a fresh chain', () => {
  const { dir, logger } = makeLogger('bot-a', { maxEntries: 2 });
  logger.record({ runtimeId: 'r1', kind: 'runtime-created' });
  logger.record({ runtimeId: 'r1', kind: 'exec-start', command: 'a' });
  assert.equal(logger.rotatedFiles().length, 0);
  logger.record({ runtimeId: 'r1', kind: 'exec-finish', exitCode: 0 }); // 3rd -> rotates first
  const rotated = logger.rotatedFiles();
  assert.equal(rotated.length, 1);
  assert.equal(readSandboxV6AuditFile(rotated[0]).length, 2);
  assert.equal(logger.count, 1);
  assert.equal(logger.verifyChain().ok, true);
  // Export sees both files.
  const botDir = path.join(dir);
  const files = sandboxV6AuditFilesForBot(botDir);
  assert.ok(files.length >= 2);
  const bundle = verifySandboxV6AuditFiles('bot-a', files);
  assert.equal(bundle.entries.length, 3);
  assert.equal(bundle.chainOk, true);
  const md = renderSandboxV6AuditMarkdown(bundle);
  assert.match(md, /bot-a/);
  assert.match(md, /Hash chain: OK/);
});

test('rotation by size: maxBytes triggers rotate', () => {
  const { logger } = makeLogger('bot-a', { maxBytes: 10 });
  logger.record({ runtimeId: 'r1', kind: 'runtime-created', detail: 'x'.repeat(50) });
  logger.record({ runtimeId: 'r1', kind: 'exec-start', command: 'a' });
  assert.equal(logger.rotatedFiles().length, 1);
});

test('corrupt lines are skipped, never thrown', () => {
  const { logger } = makeLogger();
  logger.record({ runtimeId: 'r1', kind: 'exec-start', command: 'a' });
  const file = path.join(logger.dir, SANDBOX_V6_AUDIT_FILE);
  fs.appendFileSync(file, 'this is not json\n{"seq": "nope"}\n', 'utf8');
  logger.record({ runtimeId: 'r1', kind: 'exec-finish', exitCode: 0 });
  const entries = logger.readAll();
  assert.equal(entries.length, 2); // corrupt lines skipped
  assert.deepEqual(filterSandboxV6AuditEntries(entries, {}).map((e) => e.seq), [2, 1]);
  // The readable entries still chain cleanly (the corrupt lines
  // are invisible to the chain — the file lost data, not order).
  assert.deepEqual(summarizeSandboxV6AuditEntries('bot-a', entries).chainBrokenAt, []);
  assert.deepEqual(verifySandboxV6AuditChain(entries), []);
});

test('empty log summarizes cleanly', () => {
  const { logger } = makeLogger();
  const summary = logger.summarize();
  assert.equal(summary.totalEntries, 0);
  assert.equal(summary.chainOk, true);
  assert.equal(logger.verifyChain().ok, true);
});
