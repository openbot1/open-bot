/**
 * Tests for the inline secret request flow (v1.07, Team T4).
 *
 * When a tool needs a secret the Vault does not have, the agent asks
 * for it right in the conversation: a pending request + prompt
 * payload, resolved by the host when the user answers. The value
 * never appears in a prompt, a log line or a tool result — it goes
 * user -> Vault -> the waiting tool, in memory only.
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/secret-request-v107.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  InlineSecretService,
  SecretRequestError,
  Vault,
  clampSecretRequestTimeoutMs,
  createSecretRequestPrompt,
  formatSecretRequestMessage,
  isValidSecretName,
  validateSecretValue,
} from '../packages/core/dist/index.js';

const tempDirs = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-secret-v107-'));
  tempDirs.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeVault() {
  return new Vault({ storePath: path.join(tmpDir(), 'vault.json') });
}

const REQ = {
  namespace: 'composio',
  key: 'api-key',
  label: 'Composio API key',
  reason: 'to call Composio tools',
  requestedBy: 'composio_call',
};

// --- pure helpers ---

test('validateSecretValue / isValidSecretName / clampSecretRequestTimeoutMs', () => {
  assert.deepEqual(validateSecretValue('abc'), { ok: true });
  assert.equal(validateSecretValue('').ok, false);
  assert.equal(validateSecretValue('   ').ok, false);
  assert.equal(validateSecretValue('x'.repeat(4097)).ok, false);
  assert.equal(validateSecretValue(42).ok, false);
  assert.equal(isValidSecretName('composio'), true);
  assert.equal(isValidSecretName('media-keys'), true);
  assert.equal(isValidSecretName('bad key!'), false);
  assert.equal(isValidSecretName(''), false);
  assert.equal(clampSecretRequestTimeoutMs(undefined), 300_000);
  assert.equal(clampSecretRequestTimeoutMs(1000), 10_000);
  assert.equal(clampSecretRequestTimeoutMs(9_999_999), 3_600_000);
});

test('createSecretRequestPrompt + formatSecretRequestMessage carry metadata only, never a value', () => {
  const request = {
    id: 'r1',
    namespace: 'composio',
    key: 'api-key',
    label: 'Composio API key',
    reason: 'to call Composio',
    status: 'pending',
    createdAtMs: 1000,
    expiresAtMs: 2000,
  };
  const prompt = createSecretRequestPrompt(request);
  assert.equal(prompt.kind, 'secret-request');
  assert.equal(prompt.inputType, 'password');
  assert.equal(prompt.cancellable, true);
  assert.equal(prompt.requestId, 'r1');
  assert.ok(!('value' in prompt));
  assert.ok(!JSON.stringify(prompt).includes('sk-secret'));
  const text = formatSecretRequestMessage(prompt);
  assert.ok(text.includes('Composio API key'));
  assert.ok(!text.includes('sk-secret'));
});

// --- service: fast path (vault already has it) ---

test('requestSecret: vault already has it -> no prompt, wait resolves at once', async () => {
  const vault = makeVault();
  vault.setSecret('composio', 'api-key', 'sk-live-123');
  const service = new InlineSecretService(vault);
  const handle = service.requestSecret(REQ);
  assert.equal(handle.fromVault, true);
  assert.equal(handle.prompt, null);
  const result = await handle.wait();
  assert.equal(result.status, 'fulfilled');
  assert.equal(result.value, 'sk-live-123');
  assert.equal(result.fromVault, true);
  assert.equal(service.listPending().length, 0);
});

// --- service: ask inline, resolve, decline, cancel ---

test('requestSecret + resolveSecret: prompt -> user answers -> vault has it -> waiter gets the value', async () => {
  const vault = makeVault();
  const service = new InlineSecretService(vault);
  const handle = service.requestSecret(REQ);
  assert.equal(handle.fromVault, false);
  assert.ok(handle.prompt);
  assert.equal(handle.prompt.label, 'Composio API key');
  assert.equal(handle.prompt.namespace, 'composio');
  assert.ok(!('value' in handle.prompt));
  assert.equal(service.listPending().length, 1);
  assert.equal(service.getRequest(handle.request.id).status, 'pending');
  const waited = handle.wait();
  const resolved = service.resolveSecret(handle.request.id, 'sk-user-typed');
  assert.equal(resolved.ok, true);
  const result = await waited;
  assert.equal(result.status, 'fulfilled');
  assert.equal(result.value, 'sk-user-typed');
  assert.equal(result.fromVault, false);
  assert.equal(vault.getSecret('composio', 'api-key'), 'sk-user-typed');
  assert.equal(service.getRequest(handle.request.id).status, 'fulfilled');
  // A second request for the same secret now takes the fast path.
  const second = service.requestSecret(REQ);
  assert.equal(second.fromVault, true);
  assert.equal((await second.wait()).value, 'sk-user-typed');
});

test('resolveSecret: empty/oversize value refused, request stays pending; second resolve refused', async () => {
  const vault = makeVault();
  const service = new InlineSecretService(vault);
  const handle = service.requestSecret(REQ);
  assert.equal(service.resolveSecret(handle.request.id, '').ok, false);
  assert.equal(service.resolveSecret(handle.request.id, 'x'.repeat(5000)).ok, false);
  assert.equal(service.getRequest(handle.request.id).status, 'pending');
  assert.equal(service.resolveSecret(handle.request.id, 'sk-ok').ok, true);
  assert.equal(service.resolveSecret(handle.request.id, 'sk-again').ok, false);
  assert.equal(service.resolveSecret('no-such-id', 'sk-x').ok, false);
  await handle.wait();
});

test('resolveSecret with saveToVault:false keeps the secret session-only', async () => {
  const dir = tmpDir();
  const storePath = path.join(dir, 'vault.json');
  const vault = new Vault({ storePath });
  const service = new InlineSecretService(vault);
  const handle = service.requestSecret(REQ);
  assert.equal(service.resolveSecret(handle.request.id, 'sk-temp', { saveToVault: false }).ok, true);
  await handle.wait();
  assert.equal(vault.getSecret('composio', 'api-key'), 'sk-temp');
  // A fresh Vault on the same store file does NOT see it (never hit the disk).
  const fresh = new Vault({ storePath });
  assert.equal(fresh.getSecret('composio', 'api-key'), null);
});

test('declineSecret: waiter gets declined; ensureSecret throws SecretRequestError', async () => {
  const vault = makeVault();
  const service = new InlineSecretService(vault);
  const handle = service.requestSecret(REQ);
  const waited = handle.wait();
  const declined = service.declineSecret(handle.request.id, 'user said no');
  assert.equal(declined.ok, true);
  const result = await waited;
  assert.equal(result.status, 'declined');
  assert.equal(result.value, null);
  assert.equal(service.getRequest(handle.request.id).status, 'declined');
  assert.equal(service.getRequest(handle.request.id).finishReason, 'user said no');
  assert.equal(vault.getSecret('composio', 'api-key'), null);
  // ensureSecret on a fresh request that gets declined throws with kind 'declined'.
  const service2 = new InlineSecretService(makeVault());
  const pending = service2.ensureSecret(REQ);
  const req2 = service2.listPending()[0];
  service2.declineSecret(req2.id);
  await assert.rejects(pending, (err) => {
    assert.ok(err instanceof SecretRequestError);
    assert.equal(err.kind, 'declined');
    return true;
  });
});

test('cancelSecret: waiter gets cancelled', async () => {
  const service = new InlineSecretService(makeVault());
  const handle = service.requestSecret(REQ);
  const waited = handle.wait();
  assert.equal(service.cancelSecret(handle.request.id).ok, true);
  assert.equal((await waited).status, 'cancelled');
  assert.equal(service.cancelSecret(handle.request.id).ok, false);
});

test('expireStaleRequests: a request past its deadline expires (fake clock)', async () => {
  let nowMs = 1_000_000;
  const service = new InlineSecretService(makeVault(), { now: () => nowMs });
  const handle = service.requestSecret({ ...REQ, timeoutMs: 10_000 });
  const waited = handle.wait();
  assert.equal(service.listPending().length, 1);
  nowMs += 9_000;
  assert.equal(service.expireStaleRequests(), 0);
  nowMs += 2_000;
  assert.equal(service.expireStaleRequests(), 1);
  assert.equal((await waited).status, 'expired');
  assert.equal(service.getRequest(handle.request.id).status, 'expired');
  assert.equal(service.listPending().length, 0);
});

test('requestSecret dedupes concurrent requests for the same secret', async () => {
  const service = new InlineSecretService(makeVault());
  const first = service.requestSecret(REQ);
  const second = service.requestSecret({ ...REQ, label: 'A different label' });
  assert.equal(first.request.id, second.request.id);
  assert.equal(service.listPending().length, 1);
  const r1 = first.wait();
  const r2 = second.wait();
  service.resolveSecret(first.request.id, 'sk-shared');
  assert.equal((await r1).value, 'sk-shared');
  assert.equal((await r2).value, 'sk-shared');
});

test('ensureSecret: returns the vault value, or waits for the inline answer', async () => {
  const vault = makeVault();
  vault.setSecret('composio', 'api-key', 'sk-already');
  const service = new InlineSecretService(vault);
  assert.equal(await service.ensureSecret(REQ), 'sk-already');
  const vault2 = makeVault();
  const service2 = new InlineSecretService(vault2);
  const pending = service2.ensureSecret(REQ);
  const req = service2.listPending()[0];
  service2.resolveSecret(req.id, 'sk-inline');
  assert.equal(await pending, 'sk-inline');
});

test('requestSecret: invalid namespace/key/label throw SecretRequestError', () => {
  const service = new InlineSecretService(makeVault());
  assert.throws(() => service.requestSecret({ ...REQ, namespace: 'bad ns!' }), SecretRequestError);
  assert.throws(() => service.requestSecret({ ...REQ, key: '' }), SecretRequestError);
  assert.throws(() => service.requestSecret({ ...REQ, label: '  ' }), SecretRequestError);
});

test('listRequests: bounded history, newest first', () => {
  const service = new InlineSecretService(makeVault());
  const a = service.requestSecret(REQ);
  service.resolveSecret(a.request.id, 'sk-a');
  const b = service.requestSecret({ ...REQ, key: 'other-key', label: 'Other' });
  service.declineSecret(b.request.id);
  const all = service.listRequests();
  assert.equal(all.length, 2);
  assert.equal(all[0].id, b.request.id);
  assert.equal(all[1].id, a.request.id);
});
