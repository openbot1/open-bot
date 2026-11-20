/**
 * Regression coverage for Vault fallback consent gaps found after the
 * storage-status feature landed.
 *
 * Run after building @open-bot/core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/vault-fallback-consent-gaps-v1.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Vault, setProviderIdentity } from '../packages/core/dist/index.js';

const MAIN_TS = path.join(process.cwd(), 'apps/desktop/src/main/main.ts');

test('setProviderIdentity forwards one-write LocalEncryptor consent to Vault', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-identity-consent-'));
  try {
    const vault = new Vault({
      storePath: path.join(dir, 'vault.json'),
      writePolicy: 'require-local-fallback-consent',
    });
    const identity = { id: 'account-1', displayName: 'Test account', email: 'test@example.invalid' };

    assert.throws(
      () => setProviderIdentity(vault, 'google', identity),
      /explicit confirmation/i,
    );

    setProviderIdentity(vault, 'google', identity, { allowLocalFallback: true });
    const stored = JSON.parse(vault.getSecret('identity', 'google'));
    assert.equal(stored.id, identity.id);
    assert.equal(stored.displayName, identity.displayName);
    assert.equal(stored.email, identity.email);
    assert.equal(typeof stored.updatedAt, 'number');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('all remaining Vault-backed settings secret handlers request consent before writing', () => {
  const main = fs.readFileSync(MAIN_TS, 'utf8');
  const channels = [
    ['automations:composio-trigger-secret:set', 'setComposioTriggerSigningSecret'],
    ['automations:slack-signing-secret:set', 'setSlackSigningSecret'],
    ['composio:set-key', 'setComposioApiKey'],
    ['composio:set-user-id', 'setComposioUserId'],
    ['media:set-key', 'setMediaApiKey'],
  ];

  for (const [channel, writer] of channels) {
    const start = main.indexOf(`'${channel}'`);
    assert.notEqual(start, -1, `missing IPC channel ${channel}`);
    const next = main.indexOf('registerMainWindowIpcHandler(', start + 1);
    const block = main.slice(start, next === -1 ? undefined : next);
    assert.ok(
      block.indexOf('requestLocalFallbackConsent') !== -1 &&
        block.indexOf('requestLocalFallbackConsent') < block.indexOf(writer),
      `${channel} must request fallback consent before ${writer}`,
    );
  }
});

test('legacy API-key migration does not clear settings when Vault is unavailable', () => {
  const main = fs.readFileSync(MAIN_TS, 'utf8');
  const start = main.indexOf('function migrateApiKeysToVault(): void {');
  assert.notEqual(start, -1, 'migration function must exist');
  const end = main.indexOf('\n}', start);
  assert.ok(end > start, 'migration function boundary must exist');
  const body = main.slice(start, end);
  assert.match(body, /vaultStorageStatus === 'unavailable'/);
  assert.match(body, /settings\.json values were preserved/);
  assert.match(body, /return;/);
});

test('the E2E consent bypass is restricted to NODE_ENV=test', () => {
  const main = fs.readFileSync(MAIN_TS, 'utf8');
  assert.match(
    main,
    /process\.env\.NODE_ENV === 'test' && process\.env\.OPENBOT_VAULT_ALLOW_LOCAL_FALLBACK === '1'/,
  );
  const harness = fs.readFileSync(
    path.join(process.cwd(), 'tests/vault-confirm-l5-click.test.mjs'),
    'utf8',
  );
  assert.match(harness, /NODE_ENV: 'test'/);
});
