/**
 * Protocols v7 — i18n keys tests (v1.38, Team T2).
 *
 * The 32 `protocols.v138.*` keys must exist in all 6 locales,
 * non-empty, with placeholders matching `en`.
 *
 * Pure JSON test, no build needed:
 *   node --test tests/protocols-v138-i18n.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');
const LOCALE_NAMES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

const V138_KEYS = [
  'protocols.v138.title',
  'protocols.v138.a2aCardTitle',
  'protocols.v138.a2aCardVerifyOk',
  'protocols.v138.a2aCardVerifyFailed',
  'protocols.v138.a2aCardExpired',
  'protocols.v138.a2aCardRevoked',
  'protocols.v138.a2aCardRotated',
  'protocols.v138.a2aTaskTitle',
  'protocols.v138.a2aTaskSubmitted',
  'protocols.v138.a2aTaskWorking',
  'protocols.v138.a2aTaskInputRequired',
  'protocols.v138.a2aTaskCompleted',
  'protocols.v138.a2aTaskFailed',
  'protocols.v138.a2aTaskCanceled',
  'protocols.v138.a2aTaskRejected',
  'protocols.v138.mcpStatelessTitle',
  'protocols.v138.mcpStatelessNoSession',
  'protocols.v138.mcpStatelessRefused',
  'protocols.v138.ucpReadOnlyTitle',
  'protocols.v138.ucpMoneyRefused',
  'protocols.v138.ucpCatalogEmpty',
  'protocols.v138.ucpOrderStatus',
  'protocols.v138.governTitle',
  'protocols.v138.governGrantCreated',
  'protocols.v138.governGrantRevoked',
  'protocols.v138.governCheckAllowed',
  'protocols.v138.governCheckDenied',
  'protocols.v138.governEscalateTitle',
  'protocols.v138.governEscalateApproved',
  'protocols.v138.governEscalateDenied',
  'protocols.v138.governAuditTitle',
  'protocols.v138.governAuditTampered',
];

function placeholders(value) {
  return [...value.matchAll(/\{[^}]+\}/g)].map((m) => m[0]).sort();
}

test('protocols.v138 keys exist in all 6 locales, non-empty, placeholders match en', () => {
  const locales = {};
  for (const name of LOCALE_NAMES) {
    locales[name] = JSON.parse(readFileSync(join(localesDir, `${name}.json`), 'utf-8'));
  }
  assert.equal(V138_KEYS.length, 32);
  for (const key of V138_KEYS) {
    for (const name of LOCALE_NAMES) {
      const value = locales[name][key];
      assert.equal(typeof value, 'string', `${name} missing ${key}`);
      assert.ok(value.trim().length > 0, `${name} empty ${key}`);
      assert.deepEqual(
        placeholders(value),
        placeholders(locales['en'][key]),
        `${name} placeholder mismatch on ${key}`,
      );
    }
  }
});
