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
import * as path from 'node:path';

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
  assert.ok(MAIN.includes("'automation webhook signing key',\n      webhookKeyStorageStatus ?? vaultStorageStatus,"));
  assert.ok(MAIN.includes("'rotated automation webhook signing key',\n      webhookKeyStorageStatus ?? vaultStorageStatus,"));
  assert.ok(MAIN.includes('return createAutomationWebhookKey(webhookKeyStores(), id, { allowLocalFallback });'));
  assert.ok(MAIN.includes('return rotateAutomationWebhookKey(webhookKeyStores(), id, { allowLocalFallback });'));
  assert.ok(MAIN.includes("storageStatus: 'available' | 'degraded' | 'unavailable' = vaultStorageStatus"));
  assert.ok(MAIN.includes("if (storageStatus !== 'degraded') return false;"));
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
