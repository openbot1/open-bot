/**
 * Protocols v5 — i18n keys tests (v1.29, Team T2).
 *
 * The 21 `protocols.v129.*` keys must exist in all 6 locales,
 * non-empty, with placeholders matching `en`.
 *
 * Pure JSON test, no build needed:
 *   node --test tests/protocols-v129-i18n.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');
const LOCALE_NAMES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

const V129_KEYS = [
  'protocols.v129.title',
  'protocols.v129.bgTaskTitle',
  'protocols.v129.bgTaskStarted',
  'protocols.v129.bgTaskDone',
  'protocols.v129.bgTaskFailed',
  'protocols.v129.bgTaskCancelled',
  'protocols.v129.bgTaskTimeout',
  'protocols.v129.bgTaskNeedsInput',
  'protocols.v129.permissionTitle',
  'protocols.v129.permissionAllowed',
  'protocols.v129.permissionDenied',
  'protocols.v129.permissionAsk',
  'protocols.v129.oauthTitle',
  'protocols.v129.oauthNeedsAuth',
  'protocols.v129.oauthReconnected',
  'protocols.v129.oauthFailed',
  'protocols.v129.acpTitle',
  'protocols.v129.acpAgentDiscovered',
  'protocols.v129.acpSessionStarted',
  'protocols.v129.negotiateTitle',
  'protocols.v129.acpDraftWarning',
];

function placeholders(value) {
  return [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

function loadLocale(name) {
  return JSON.parse(readFileSync(join(localesDir, `${name}.json`), 'utf8'));
}

test('all 21 protocols.v129 keys exist in all 6 locales and are non-empty', () => {
  for (const locale of LOCALE_NAMES) {
    const data = loadLocale(locale);
    for (const key of V129_KEYS) {
      assert.ok(
        typeof data[key] === 'string' && data[key].trim().length > 0,
        `${locale} is missing or empty for key ${key}`,
      );
    }
  }
});

test('placeholders match en in every locale', () => {
  const en = loadLocale('en');
  for (const locale of LOCALE_NAMES) {
    if (locale === 'en') continue;
    const data = loadLocale(locale);
    for (const key of V129_KEYS) {
      assert.deepEqual(
        placeholders(data[key]),
        placeholders(en[key]),
        `${locale} placeholders differ for ${key}: ${data[key]} vs ${en[key]}`,
      );
    }
  }
});
