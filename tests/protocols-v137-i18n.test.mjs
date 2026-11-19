/**
 * Protocols v6 — i18n keys tests (v1.37, Team T2).
 *
 * The 28 `protocols.v137.*` keys must exist in all 6 locales,
 * non-empty, with placeholders matching `en`.
 *
 * Pure JSON test, no build needed:
 *   node --test tests/protocols-v137-i18n.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');
const LOCALE_NAMES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

const V137_KEYS = [
  'protocols.v137.title',
  'protocols.v137.acpTitle',
  'protocols.v137.acpDraftWarning',
  'protocols.v137.acpSessionStarted',
  'protocols.v137.acpMessageId',
  'protocols.v137.acpUpdateTitle',
  'protocols.v137.acpUpdateSent',
  'protocols.v137.acpParallelV1',
  'protocols.v137.fileChangeTitle',
  'protocols.v137.fileChangeProposed',
  'protocols.v137.fileChangeApplied',
  'protocols.v137.fileChangeRejected',
  'protocols.v137.fileChangeConflict',
  'protocols.v137.fileChangeRolledBack',
  'protocols.v137.elicitTitle',
  'protocols.v137.elicitFormSubmitted',
  'protocols.v137.elicitUrlSent',
  'protocols.v137.elicitCancelled',
  'protocols.v137.elicitExpired',
  'protocols.v137.elicitModeNegotiated',
  'protocols.v137.a2aStreamTitle',
  'protocols.v137.a2aStreamStarted',
  'protocols.v137.a2aStreamCancelled',
  'protocols.v137.a2aStreamResumed',
  'protocols.v137.registryTitle',
  'protocols.v137.poppyWatchOnly',
  'protocols.v137.ietfWatch',
  'protocols.v137.testedWithTitle',
];

function placeholders(value) {
  return [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

function loadLocale(name) {
  return JSON.parse(readFileSync(join(localesDir, `${name}.json`), 'utf8'));
}

test('all 28 protocols.v137 keys exist in all 6 locales and are non-empty', () => {
  for (const locale of LOCALE_NAMES) {
    const data = loadLocale(locale);
    for (const key of V137_KEYS) {
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
    for (const key of V137_KEYS) {
      assert.deepEqual(placeholders(data[key]), placeholders(en[key]), `${locale}:${key} placeholders differ from en`);
    }
  }
});

test('no protocol v137 value is a copy of the English text in another locale (except shared terms)', () => {
  const en = loadLocale('en');
  for (const locale of ['vi', 'es', 'fr', 'ja', 'zh']) {
    const data = loadLocale(locale);
    for (const key of V137_KEYS) {
      if (key === 'protocols.v137.title') continue; // "Protocols v6" style titles may share the shape
      if (key === 'protocols.v137.acpMessageId') continue; // "Message" is the same word in French
      assert.notEqual(data[key], en[key], `${locale}:${key} is identical to en`);
    }
  }
});
