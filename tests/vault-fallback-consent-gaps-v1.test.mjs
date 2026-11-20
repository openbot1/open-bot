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
import {
  getComposioApiKey,
  getComposioTriggerSigningSecret,
  getComposioUserId,
  setComposioApiKey,
  setComposioTriggerSigningSecret,
  setComposioUserId,
} from '../packages/core/dist/composio/index.js';
import {
  getMediaApiKey,
  setMediaApiKey,
} from '../packages/core/dist/media/index.js';
import {
  getSlackSigningSecret,
  setSlackSigningSecret,
} from '../packages/core/dist/slack/index.js';

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

test('all five remaining Vault-backed setters forward one-write LocalEncryptor consent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-settings-consent-'));
  try {
    const vault = new Vault({
      storePath: path.join(dir, 'vault.json'),
      writePolicy: 'require-local-fallback-consent',
    });
    const cases = [
      {
        label: 'Composio API key',
        writeWithoutConsent: () => setComposioApiKey(vault, 'fake-composio-api-key'),
        writeWithConsent: () => setComposioApiKey(vault, 'fake-composio-api-key', { allowLocalFallback: true }),
        read: () => getComposioApiKey(vault),
        expected: 'fake-composio-api-key',
      },
      {
        label: 'Composio user id',
        writeWithoutConsent: () => setComposioUserId(vault, 'open-bot-test-user-1'),
        writeWithConsent: () => setComposioUserId(vault, 'open-bot-test-user-1', { allowLocalFallback: true }),
        read: () => getComposioUserId(vault),
        expected: 'open-bot-test-user-1',
      },
      {
        label: 'Media API key',
        writeWithoutConsent: () => setMediaApiKey(vault, 'openai', 'fake-media-api-key'),
        writeWithConsent: () => setMediaApiKey(vault, 'openai', 'fake-media-api-key', { allowLocalFallback: true }),
        read: () => getMediaApiKey(vault, 'openai'),
        expected: 'fake-media-api-key',
      },
      {
        label: 'Composio trigger signing secret',
        writeWithoutConsent: () => setComposioTriggerSigningSecret(vault, 'test-trigger-1', 'fake-composio-trigger-secret'),
        writeWithConsent: () => setComposioTriggerSigningSecret(vault, 'test-trigger-1', 'fake-composio-trigger-secret', { allowLocalFallback: true }),
        read: () => getComposioTriggerSigningSecret(vault, 'test-trigger-1'),
        expected: 'fake-composio-trigger-secret',
      },
      {
        label: 'Slack signing secret',
        writeWithoutConsent: () => setSlackSigningSecret(vault, 'test-slack-1', 'fake-slack-signing-secret'),
        writeWithConsent: () => setSlackSigningSecret(vault, 'test-slack-1', 'fake-slack-signing-secret', { allowLocalFallback: true }),
        read: () => getSlackSigningSecret(vault, 'test-slack-1'),
        expected: 'fake-slack-signing-secret',
      },
    ];

    for (const entry of cases) {
      assert.throws(
        entry.writeWithoutConsent,
        /explicit confirmation/i,
        `${entry.label} must refuse a degraded-mode write without consent`,
      );
      entry.writeWithConsent();
      assert.equal(
        entry.read(),
        entry.expected,
        `${entry.label} must persist after one-write consent is supplied`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
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
  const patHarness = fs.readFileSync(
    path.join(process.cwd(), 'tests/github-pat-revalidate-e2e-v071.test.mjs'),
    'utf8',
  );
  assert.match(patHarness, /NODE_ENV: 'test'/);
});
