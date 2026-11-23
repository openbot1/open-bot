/**
 * Regression coverage for the dedicated automation webhook-key Vault status.
 *
 * Run after building the desktop application:
 *   node --test tests/vault-webhook-storage-status-v1.test.mjs
 *
 * This GitHub-only authoring session did not execute this test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openVaultWithSafeStorage } from '../packages/core/dist/vault/index.js';

const ROOT = process.cwd();
const MAIN = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/main.ts'), 'utf8');
const SECURITY = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/renderer/components/SettingsSecurityTab.tsx'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/preload.ts'), 'utf8');
const GLOBAL = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/renderer/global.d.ts'), 'utf8');

test('main process retains dedicated webhook store status separately from the primary Vault', () => {
  assert.ok(MAIN.includes("let webhookKeyStorageStatus: 'available' | 'degraded' | 'unavailable' | null = null;"));
  assert.ok(MAIN.includes('webhookKeyStorageStatus = opened.status;'));
  assert.ok(MAIN.includes('function webhookKeyStoreHasPersistedFile(dir: string): boolean'));
  assert.ok(MAIN.includes('`${storePath}.1`') && MAIN.includes('`${storePath}.2`') && MAIN.includes('`${storePath}.3`'));
  assert.ok(MAIN.includes('webhookKeyStorageStatus === null'));
  assert.ok(MAIN.includes('status: webhookKeyStorageStatus,'));
});

test('webhook-key create and rotate obtain one-write consent from the relevant store state', () => {
  assert.ok(MAIN.includes('const webhookStorageStatus = getWebhookKeyStorageStatusForConsent();'));
  assert.ok(MAIN.includes("'automation webhook signing key',\n      webhookStorageStatus,"));
  assert.ok(MAIN.includes("'rotated automation webhook signing key',\n      webhookStorageStatus,"));
  assert.ok(MAIN.includes('return createAutomationWebhookKey(webhookKeyStores(allowLocalFallback), id, { allowLocalFallback });'));
  assert.ok(MAIN.includes('return rotateAutomationWebhookKey(webhookKeyStores(allowLocalFallback), id, { allowLocalFallback });'));
  assert.ok(MAIN.includes("storageStatus: 'available' | 'degraded' | 'unavailable' = vaultStorageStatus"));
  assert.ok(MAIN.includes("if (storageStatus !== 'degraded') return false;"));
  assert.ok(MAIN.includes('function getWebhookKeyStorageStatusForConsent():'));
  assert.ok(MAIN.includes('createLocalFallbackKey: allowLocalFallbackKeyCreation,'));
});

test('declined degraded fallback consent is rejected before either webhook store is opened', () => {
  const createStart = MAIN.indexOf("registerMainWindowIpcHandler('automations:webhook-key:create'");
  const rotateStart = MAIN.indexOf("registerMainWindowIpcHandler('automations:webhook-key:rotate'");
  const deleteStart = MAIN.indexOf("registerMainWindowIpcHandler('automations:webhook-key:delete'");
  assert.ok(createStart >= 0 && rotateStart > createStart && deleteStart > rotateStart);
  const handlers = [
    MAIN.slice(createStart, rotateStart),
    MAIN.slice(rotateStart, deleteStart),
  ];
  for (const handler of handlers) {
    const guard = handler.indexOf("if (webhookStorageStatus === 'degraded' && !allowLocalFallback)");
    const storeOpen = handler.indexOf('webhookKeyStores(');
    assert.ok(guard >= 0, 'degraded + declined consent must be rejected explicitly');
    assert.ok(storeOpen > guard, 'the store factory must not run before the consent guard');
    assert.ok(handler.includes("throw new Error('Đã huỷ lưu secret: LocalEncryptor fallback cần xác nhận riêng cho từng lần lưu.')"));
  }
  // Available storage legitimately returns allowLocalFallback=false; the guard
  // must remain conditional on degraded status, not on the boolean alone.
  assert.ok(MAIN.includes("if (webhookStorageStatus === 'degraded' && !allowLocalFallback)"));
});

test('safeStorage probe and no-create Vault open avoid fallback key creation before consent', () => {
  const core = fs.readFileSync(path.join(ROOT, 'packages/core/src/vault/vault.ts'), 'utf8');
  assert.ok(MAIN.includes('const encryptor = createSafeStorageEncryptor(safeStorage);'));
  assert.ok(MAIN.includes("return isWebhookKeySafeStorageAvailable() ? 'available' : 'degraded';"));
  assert.ok(core.includes('createLocalFallbackKey?: boolean;'));
  assert.ok(core.includes('if (options.createLocalFallbackKey === false)'));
  assert.ok(core.includes('encryptor: new LocalEncryptor(machineKey)'));
  assert.ok(core.includes('Creating a LocalEncryptor fallback machine key requires explicit consent.'));
});

test('no-consent fallback open refuses before creating a machine-key file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-webhook-vault-'));
  try {
    assert.throws(
      () =>
        openVaultWithSafeStorage({
          storePath: path.join(dir, 'automation-webhook-keys.json'),
          safeStorage: {
            isEncryptionAvailable: () => false,
            encryptString: () => Buffer.alloc(0),
            decryptString: () => '',
          },
          createLocalFallbackKey: false,
        }),
      /explicit consent/,
    );
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Settings surfaces the separate webhook store and both unsafe storage states', () => {
  assert.ok(SECURITY.includes('<strong>{t(\'settings.vaultTitle\')} — webhook signing keys</strong>'));
  assert.ok(SECURITY.includes("vaultStorageStatus?.webhookKeyStore?.status === 'degraded'"));
  assert.ok(SECURITY.includes("vaultStorageStatus?.webhookKeyStore?.status === 'unavailable'"));
  assert.ok(SECURITY.includes('data-testid="vault-webhook-storage-available"'));
  assert.ok(SECURITY.includes('data-testid="vault-webhook-storage-degraded"'));
  assert.ok(SECURITY.includes('data-testid="vault-webhook-storage-unavailable"'));
});

test('preload and renderer contracts expose only the separate status metadata', () => {
  for (const source of [PRELOAD, GLOBAL]) assert.ok(source.includes('webhookKeyStore: { status:'));
  assert.ok(!MAIN.includes('webhookKeyStore: { secret:'));
});
