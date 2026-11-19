/**
 * Tests cho Sandbox v6 — secret scoping theo bot (v1.38, Đội T3).
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/sandbox-v6-secrets.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SandboxV6SecretStore } from '../packages/core/dist/sandboxV6/index.js';

const tempDirs = [];
function makeTempDir(prefix = 'open-bot-sandbox-v6-secrets-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

test.afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function makeStore(botId = 'bot-a', opts = {}) {
  const dir = makeTempDir();
  const denied = [];
  const store = new SandboxV6SecretStore({
    dir: path.join(dir, 'secrets'),
    botId,
    onAccessDenied: (info) => denied.push(info),
    ...opts,
  });
  return { dir, store, denied };
}

test('owner can put + get; list carries metadata only, never values', () => {
  const { store } = makeStore();
  const meta = store.put({ ownerBotId: 'bot-a', name: 'api-key', value: 'sk-secret-123', purposes: ['github'] });
  assert.equal(meta.name, 'api-key');
  assert.equal(meta.ownerBotId, 'bot-a');
  assert.deepEqual(meta.purposes, ['github']);
  assert.equal(meta.readCount, 0);
  const got = store.get('bot-a', 'api-key', 'github');
  assert.equal(got.access.allowed, true);
  assert.equal(got.value, 'sk-secret-123');
  assert.equal(store.meta('api-key').readCount, 1);
  const list = store.list();
  assert.equal(list.length, 1);
  assert.equal(JSON.stringify(list).includes('sk-secret-123'), false);
  assert.deepEqual(store.names(), ['api-key']);
  assert.equal(store.has('api-key'), true);
});

test('another bot cannot read: denied, counted, reported via hook', () => {
  const { store, denied } = makeStore();
  store.put({ ownerBotId: 'bot-a', name: 'api-key', value: 'sk-secret-123' });
  const got = store.get('bot-b', 'api-key');
  assert.equal(got.access.allowed, false);
  assert.equal(got.value, undefined);
  assert.match(got.access.reason ?? '', /not the owner/);
  assert.equal(denied.length, 1);
  assert.equal(denied[0].callerBotId, 'bot-b');
  assert.equal(store.meta('api-key').deniedCount, 1);
  // checkAccess does not count a read and does not fire the hook.
  const check = store.checkAccess('bot-b', 'api-key');
  assert.equal(check.allowed, false);
  assert.equal(denied.length, 1);
  assert.equal(store.meta('api-key').deniedCount, 1);
});

test('purpose restriction: wrong purpose denied, right purpose allowed, no purpose = any', () => {
  const { store } = makeStore();
  store.put({ ownerBotId: 'bot-a', name: 'gh-token', value: 'tok-1', purposes: ['github'] });
  assert.equal(store.get('bot-a', 'gh-token', 'slack').access.allowed, false);
  assert.equal(store.get('bot-a', 'gh-token', 'github').access.allowed, true);
  assert.equal(store.get('bot-a', 'gh-token').access.allowed, true);
  store.put({ ownerBotId: 'bot-a', name: 'open-key', value: 'tok-2' });
  assert.equal(store.get('bot-a', 'open-key', 'anything').access.allowed, true);
});

test('expiry: expired secrets are dropped and read as denied', () => {
  let now = 1_000_000;
  const { store } = makeStore('bot-a', { nowMs: () => now });
  store.put({ ownerBotId: 'bot-a', name: 'short', value: 'v', ttlMs: 1000 });
  assert.equal(store.get('bot-a', 'short').access.allowed, true);
  now += 1001;
  const got = store.get('bot-a', 'short');
  assert.equal(got.access.allowed, false);
  assert.match(got.access.reason ?? '', /expired/);
  assert.equal(store.has('short'), false);
});

test('revoke deletes; purge deletes everything; put validates names + values', () => {
  const { store } = makeStore();
  store.put({ ownerBotId: 'bot-a', name: 'one', value: 'v1' });
  store.put({ ownerBotId: 'bot-a', name: 'two', value: 'v2' });
  assert.equal(store.revoke('one'), true);
  assert.equal(store.revoke('one'), false);
  assert.equal(store.get('bot-a', 'one').access.allowed, false);
  assert.equal(store.purge(), 1);
  assert.deepEqual(store.names(), []);
  assert.throws(() => store.put({ ownerBotId: 'bot-a', name: 'Bad Name', value: 'v' }), /Invalid secret name/);
  assert.throws(() => store.put({ ownerBotId: 'bot-a', name: 'ok', value: '' }), /non-empty string/);
  assert.throws(() => store.put({ ownerBotId: 'bot-b', name: 'ok', value: 'v' }), /belongs to bot/);
  assert.throws(() => store.put({ ownerBotId: 'bot-a', name: 'ok', value: 'v', purposes: ['BAD!'] }), /Invalid secret purpose/);
  assert.throws(() => new SandboxV6SecretStore({ dir: makeTempDir(), botId: 'bad id!' }), /Invalid botId/);
});

test('persistence: reload from disk keeps values + counts; file is 0600', () => {
  const dir = makeTempDir();
  const opts = { dir: path.join(dir, 'secrets'), botId: 'bot-a' };
  const s1 = new SandboxV6SecretStore(opts);
  s1.put({ ownerBotId: 'bot-a', name: 'api-key', value: 'sk-persist-1', purposes: ['github'] });
  s1.get('bot-a', 'api-key');
  const mode = fs.statSync(path.join(dir, 'secrets', 'secrets.json')).mode & 0o777;
  assert.equal(mode, 0o600);
  const s2 = new SandboxV6SecretStore(opts);
  assert.equal(s2.get('bot-a', 'api-key', 'github').value, 'sk-persist-1');
  assert.equal(s2.meta('api-key').readCount, 2); // 1 read by s1 + 1 read by s2 just now
  // Corrupt file: store starts empty instead of crashing.
  fs.writeFileSync(path.join(dir, 'secrets', 'secrets.json'), '{broken json', 'utf8');
  const s3 = new SandboxV6SecretStore(opts);
  assert.deepEqual(s3.names(), []);
});

test('valuesForScrubbing returns live values only', () => {
  const { store } = makeStore();
  store.put({ ownerBotId: 'bot-a', name: 'a', value: 'val-a' });
  store.put({ ownerBotId: 'bot-a', name: 'b', value: 'val-b' });
  store.revoke('a');
  assert.deepEqual(store.valuesForScrubbing(), ['val-b']);
});
