/**
 * Tests cho Sandbox v5 — profile-scoped secrets (v1.37, Đội T3).
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/sandbox-v5-secrets.test.mjs
 *
 * Secret values chỉ sống trong bộ nhớ của test process — không
 * ghi ra đĩa, không log. Test kiểm tra chính điều đó.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SandboxV5SecretManager } from '../packages/core/dist/index.js';

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const SCOPE = { botId: 'bot-a', runId: 'run-1', profileId: 'coder' };

test('secrets: grant + consume (single-use) + scope check', (t) => {
  const base = tmpDir(t, 'sbv5-sec-');
  const manager = new SandboxV5SecretManager({ baseDir: base });
  const grant = manager.grant({
    name: 'GITHUB_TOKEN',
    value: 'ghp-very-secret-value',
    ...SCOPE,
    grantedBy: 'user',
    purpose: 'push code',
  });
  assert.equal(grant.status, 'active');
  assert.equal(grant.maxUses, 1);
  assert.equal(grant.uses, 0);
  assert.equal(manager.liveValueCount(), 1);
  // Wrong scope is denied and the grant is untouched.
  assert.throws(
    () => manager.consume(grant.id, { botId: 'bot-b', runId: 'run-1', profileId: 'coder' }),
    /scoped to bot-a\/run-1\/coder/,
  );
  assert.throws(
    () => manager.consume(grant.id, { botId: 'bot-a', runId: 'run-2', profileId: 'coder' }),
    /scoped to/,
  );
  assert.equal(manager.get(grant.id)?.status, 'active');
  // Right scope consumes once; the value is returned ONLY here.
  const consumed = manager.consume(grant.id, SCOPE);
  assert.equal(consumed.value, 'ghp-very-secret-value');
  assert.equal(consumed.usesLeft, 0);
  assert.equal(consumed.status, 'consumed');
  assert.equal(manager.liveValueCount(), 0);
  // Second consume fails — the value is gone.
  assert.throws(() => manager.consume(grant.id, SCOPE), /is consumed/);
});

test('secrets: multi-use grant exhausts after maxUses', (t) => {
  const base = tmpDir(t, 'sbv5-sec-multi-');
  const manager = new SandboxV5SecretManager({ baseDir: base });
  const grant = manager.grant({ name: 'API_KEY', value: 'k3y', ...SCOPE, maxUses: 2 });
  assert.equal(manager.consume(grant.id, SCOPE).usesLeft, 1);
  assert.equal(manager.get(grant.id)?.status, 'active');
  assert.equal(manager.consume(grant.id, SCOPE).usesLeft, 0);
  assert.equal(manager.get(grant.id)?.status, 'consumed');
  assert.equal(manager.get(grant.id)?.uses, 2);
});

test('secrets: grant validation refuses bad names, scopes and empty values', (t) => {
  const base = tmpDir(t, 'sbv5-sec-bad-');
  const manager = new SandboxV5SecretManager({ baseDir: base });
  assert.throws(() => manager.grant({ name: 'lowercase', value: 'v', ...SCOPE }), /Invalid secret name/);
  assert.throws(() => manager.grant({ name: 'TOKEN', value: '', ...SCOPE }), /empty secret value/);
  assert.throws(() => manager.grant({ name: 'TOKEN', value: 'v', botId: '../x', runId: 'r', profileId: 'p' }), /Invalid botId/);
  assert.throws(() => manager.grant({ name: 'TOKEN', value: 'v', ...SCOPE, maxUses: 0 }), /maxUses/);
  assert.throws(() => manager.consume('grant-nope', SCOPE), /Unknown sandbox v5 secret grant/);
});

test('secrets: revokeRun ends every grant of the run, other runs untouched', (t) => {
  const base = tmpDir(t, 'sbv5-sec-run-');
  const manager = new SandboxV5SecretManager({ baseDir: base });
  const g1 = manager.grant({ name: 'TOKEN_A', value: 'a', ...SCOPE });
  const g2 = manager.grant({ name: 'TOKEN_B', value: 'b', ...SCOPE });
  const other = manager.grant({ name: 'TOKEN_C', value: 'c', botId: 'bot-a', runId: 'run-2', profileId: 'coder' });
  const result = manager.revokeRun('bot-a', 'run-1', 'user');
  assert.deepEqual(result.revokedGrantIds.sort(), [g1.id, g2.id].sort());
  assert.equal(result.alreadyEndedGrantIds.length, 0);
  assert.equal(manager.get(g1.id)?.status, 'revoked');
  assert.equal(manager.get(g2.id)?.status, 'revoked');
  assert.equal(manager.get(other.id)?.status, 'active');
  assert.equal(manager.liveValueCount(), 1);
  assert.throws(() => manager.consume(g1.id, SCOPE), /is revoked/);
  // Revoking again is a no-op (already ended).
  const again = manager.revokeRun('bot-a', 'run-1', 'user');
  assert.equal(again.revokedGrantIds.length, 0);
  assert.deepEqual(again.alreadyEndedGrantIds.sort(), [g1.id, g2.id].sort());
});

test('secrets: revoke one grant early; revoke of unknown/ended returns false', (t) => {
  const base = tmpDir(t, 'sbv5-sec-revoke-');
  const manager = new SandboxV5SecretManager({ baseDir: base });
  const grant = manager.grant({ name: 'TOKEN', value: 'v', ...SCOPE });
  assert.equal(manager.revoke('grant-nope'), false);
  assert.equal(manager.revoke(grant.id, 'user', 'no longer needed'), true);
  assert.equal(manager.get(grant.id)?.status, 'revoked');
  assert.equal(manager.get(grant.id)?.endedBy, 'user');
  assert.equal(manager.revoke(grant.id), false);
  assert.equal(manager.liveValueCount(), 0);
});

test('secrets: TTL expiry via sweep and at consume time', (t) => {
  const base = tmpDir(t, 'sbv5-sec-ttl-');
  let now = 1_000_000;
  const manager = new SandboxV5SecretManager({ baseDir: base, nowMs: () => now });
  const grant = manager.grant({ name: 'TOKEN', value: 'v', ...SCOPE, ttlMs: 1000 });
  assert.equal(grant.expiresAtMs, 1_001_000);
  now = 1_000_500;
  assert.deepEqual(manager.sweepExpired(), []);
  assert.equal(manager.get(grant.id)?.status, 'active');
  now = 1_001_000;
  assert.deepEqual(manager.sweepExpired(), [grant.id]);
  assert.equal(manager.get(grant.id)?.status, 'expired');
  // A grant that expires between grant and consume refuses the consume.
  const grant2 = manager.grant({ name: 'TOKEN2', value: 'v2', ...SCOPE, ttlMs: 1000 });
  now = 1_002_500;
  assert.throws(() => manager.consume(grant2.id, SCOPE), /expired/);
  assert.equal(manager.get(grant2.id)?.status, 'expired');
});

test('secrets: values never touch disk (grants file + audit log are metadata only)', (t) => {
  const base = tmpDir(t, 'sbv5-sec-disk-');
  const manager = new SandboxV5SecretManager({ baseDir: base });
  const secretValue = 'super-secret-value-12345';
  manager.grant({ name: 'MY_TOKEN', value: secretValue, ...SCOPE, purpose: 'test' });
  manager.consume(manager.list()[0].id, SCOPE);
  const grantsFile = fs.readFileSync(path.join(base, 'secret-grants.json'), 'utf8');
  const auditFile = fs.readFileSync(path.join(base, 'secret-audit.jsonl'), 'utf8');
  assert.equal(grantsFile.includes(secretValue), false);
  assert.equal(auditFile.includes(secretValue), false);
  // The name is metadata — it MAY appear; the value must not.
  assert.equal(grantsFile.includes('MY_TOKEN'), true);
  assert.equal(auditFile.includes('MY_TOKEN'), true);
  // redactText scrubs live values out of arbitrary text.
  const manager2 = new SandboxV5SecretManager({ baseDir: path.join(base, 'second') });
  manager2.grant({ name: 'OTHER', value: 'live-value-xyz', ...SCOPE });
  assert.equal(
    manager2.redactText('oops the key is live-value-xyz in this log line'),
    'oops the key is [REDACTED] in this log line',
  );
});

test('secrets: audit chain verifies, tampering is detected', (t) => {
  const base = tmpDir(t, 'sbv5-sec-audit-');
  const manager = new SandboxV5SecretManager({ baseDir: base });
  const g1 = manager.grant({ name: 'TOKEN_A', value: 'a', ...SCOPE });
  manager.consume(g1.id, SCOPE);
  const g2 = manager.grant({ name: 'TOKEN_B', value: 'b', ...SCOPE });
  manager.revoke(g2.id, 'user', 'done');
  manager.revokeRun('bot-a', 'run-1', 'user');
  const entries = manager.auditLog();
  // revokeRun adds nothing here: both grants already ended.
  assert.equal(entries.length, 4);
  assert.deepEqual(entries.map((entry) => entry.event), ['granted', 'consumed', 'granted', 'revoked']);
  assert.deepEqual(manager.verifyAuditChain(), []);
  // Tamper: change one entry's detail, the chain must break.
  const auditPath = path.join(base, 'secret-audit.jsonl');
  const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n');
  const tampered = JSON.parse(lines[0]);
  tampered.detail = 'tampered detail';
  lines[0] = JSON.stringify(tampered);
  fs.writeFileSync(auditPath, `${lines.join('\n')}\n`, 'utf8');
  const problems = manager.verifyAuditChain();
  assert.equal(problems.length > 0, true);
  assert.equal(problems.some((problem) => problem.includes('hash mismatch')), true);
});

test('secrets: grants loaded from disk after restart are expired (values are memory-only)', (t) => {
  const base = tmpDir(t, 'sbv5-sec-restart-');
  const first = new SandboxV5SecretManager({ baseDir: base });
  const grant = first.grant({ name: 'TOKEN', value: 'v', ...SCOPE });
  assert.equal(first.get(grant.id)?.status, 'active');
  // New process, same base dir: the value is gone with the old process.
  const second = new SandboxV5SecretManager({ baseDir: base });
  assert.equal(second.get(grant.id)?.status, 'expired');
  assert.equal(second.get(grant.id)?.endReason.includes('memory-only'), true);
  assert.equal(second.liveValueCount(), 0);
  assert.throws(() => second.consume(grant.id, SCOPE), /is expired/);
});

test('secrets: list filters by bot/run/profile', (t) => {
  const base = tmpDir(t, 'sbv5-sec-list-');
  const manager = new SandboxV5SecretManager({ baseDir: base });
  manager.grant({ name: 'A', value: 'a', ...SCOPE });
  manager.grant({ name: 'B', value: 'b', botId: 'bot-a', runId: 'run-2', profileId: 'coder' });
  manager.grant({ name: 'C', value: 'c', botId: 'bot-b', runId: 'run-1', profileId: 'coder' });
  assert.equal(manager.list().length, 3);
  assert.equal(manager.list({ botId: 'bot-a' }).length, 2);
  assert.equal(manager.list({ runId: 'run-1' }).length, 2);
  assert.equal(manager.list({ botId: 'bot-a', runId: 'run-2' }).length, 1);
  assert.equal(manager.listActiveForRun('bot-a', 'run-1').length, 1);
});
