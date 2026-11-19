/**
 * Regression coverage for the desktop Vault safeStorage/fallback opener.
 *
 * Run after building @open-bot/core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/vault-safe-storage-fallback-v009.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  Vault,
  openVaultWithSafeStorage,
} from '../packages/core/dist/vault/index.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-safe-vault-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function fakeSafeStorage(initiallyAvailable = true) {
  let available = initiallyAvailable;
  const values = new Map();
  return {
    isEncryptionAvailable: () => available,
    setAvailable(value) {
      available = value;
    },
    encryptString(plaintext) {
      const handle = randomUUID();
      values.set(handle, plaintext);
      return Buffer.from(handle, 'utf8');
    },
    decryptString(ciphertext) {
      const handle = ciphertext.toString('utf8');
      if (!values.has(handle)) throw new Error('unknown fake keychain ciphertext');
      return values.get(handle);
    },
  };
}

const storePathIn = (dir) => path.join(dir, 'vault.json');
const keyPathIn = (dir) => path.join(dir, 'vault.json.key');

test('safeStorage available: opener reports available and persists a readable OS-backed secret', () => {
  const dir = makeTempDir();
  const safeStorage = fakeSafeStorage(true);
  const opened = openVaultWithSafeStorage({
    storePath: storePathIn(dir),
    safeStorage,
  });

  assert.equal(opened.status, 'available');
  opened.vault.setSecret('provider', 'openai', 'test-safe-storage-secret');
  assert.equal(opened.vault.getSecret('provider', 'openai'), 'test-safe-storage-secret');

  const reopened = openVaultWithSafeStorage({
    storePath: storePathIn(dir),
    safeStorage,
  });
  assert.equal(reopened.status, 'available');
  assert.equal(reopened.vault.getSecret('provider', 'openai'), 'test-safe-storage-secret');
});

test('safeStorage unavailable: opener reports degraded and requires one-write consent', () => {
  const dir = makeTempDir();
  const opened = openVaultWithSafeStorage({
    storePath: storePathIn(dir),
    safeStorage: fakeSafeStorage(false),
  });

  assert.equal(opened.status, 'degraded');
  assert.throws(
    () => opened.vault.setSecret('provider', 'openai', 'must-not-write-silently'),
    /explicit confirmation/i,
  );
  opened.vault.setSecret('provider', 'openai', 'confirmed-fallback-secret', {
    allowLocalFallback: true,
  });
  assert.equal(opened.vault.getSecret('provider', 'openai'), 'confirmed-fallback-secret');
});

test('safeStorage ciphertext without its OS keychain is unavailable and left byte-for-byte intact', () => {
  const dir = makeTempDir();
  const safeStorage = fakeSafeStorage(true);
  const first = openVaultWithSafeStorage({
    storePath: storePathIn(dir),
    safeStorage,
  });
  first.vault.setSecret('oauth-refresh', 'provider', 'keychain-only-secret');

  const before = fs.readFileSync(storePathIn(dir));
  safeStorage.setAvailable(false);
  const fallback = openVaultWithSafeStorage({
    storePath: storePathIn(dir),
    safeStorage,
  });

  assert.equal(fallback.status, 'unavailable');
  assert.throws(
    () => fallback.vault.setSecret('provider', 'new-key', 'must-not-overwrite'),
    /writes are disabled|unavailable/i,
  );
  assert.deepEqual(fs.readFileSync(storePathIn(dir)), before);
});

test('legacy LocalEncryptor ciphertext migrates to safeStorage without losing secrets', () => {
  const dir = makeTempDir();
  const storePath = storePathIn(dir);
  const keyPath = keyPathIn(dir);
  const legacy = new Vault({ storePath, keyFilePath: keyPath });
  legacy.setSecret('provider', 'openai', 'legacy-provider-secret');
  legacy.setSecret('connector', 'gmail', 'legacy-refresh-secret');
  const oldKey = fs.readFileSync(keyPath);
  const safeStorage = fakeSafeStorage(true);

  const migrated = openVaultWithSafeStorage({ storePath, keyFilePath: keyPath, safeStorage });

  assert.equal(migrated.status, 'available');
  assert.equal(migrated.vault.getSecret('provider', 'openai'), 'legacy-provider-secret');
  assert.equal(migrated.vault.getSecret('connector', 'gmail'), 'legacy-refresh-secret');
  assert.ok(fs.readFileSync(keyPath).equals(oldKey), 'legacy key is retained for backup recovery');
  assert.notDeepEqual(fs.readFileSync(storePath), fs.readFileSync(path.join(dir, 'vault.json.1')));

  const reopened = openVaultWithSafeStorage({ storePath, keyFilePath: keyPath, safeStorage });
  assert.equal(reopened.status, 'available');
  assert.equal(reopened.vault.getSecret('provider', 'openai'), 'legacy-provider-secret');
  assert.equal(reopened.vault.getSecret('connector', 'gmail'), 'legacy-refresh-secret');
});
