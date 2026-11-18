/**
 * Protocols v4 — i18n keys tests (v1.20, Team T2).
 *
 * The 17 `protocols.v120.*` keys must exist in all 6 locales,
 * non-empty, with placeholders matching `en`.
 *
 * Pure JSON test, no build needed:
 *   node --test tests/protocols-v120-i18n.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');
const LOCALE_NAMES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

const V120_KEYS = [
  'protocols.v120.a2aLiveTitle',
  'protocols.v120.a2aLiveStreaming',
  'protocols.v120.a2aLiveBackpressure',
  'protocols.v120.a2aLiveResumed',
  'protocols.v120.a2aLiveClientArtifact',
  'protocols.v120.a2aLiveNotSupported',
  'protocols.v120.mcpSamplingTitle',
  'protocols.v120.mcpSamplingDeprecated',
  'protocols.v120.mcpSamplingReplacement',
  'protocols.v120.mcpSamplingStrictBlocked',
  'protocols.v120.aguiConformanceTitle',
  'protocols.v120.aguiConformanceGap',
  'protocols.v120.aguiConformanceMissing',
  'protocols.v120.aguiConformanceNonSpec',
  'protocols.v120.ietfWatchTitle',
  'protocols.v120.ietfWatchNextMilestone',
  'protocols.v120.ietfWatchNoProtocol',
];

function placeholders(value) {
  return [...value.matchAll(/\{[^}]+\}/g)].map((m) => m[0]).sort();
}

test('protocols.v120 keys exist in all 6 locales, non-empty, placeholders match en', () => {
  const locales = {};
  for (const name of LOCALE_NAMES) {
    locales[name] = JSON.parse(readFileSync(join(localesDir, `${name}.json`), 'utf-8'));
  }
  assert.equal(V120_KEYS.length, 17);
  for (const key of V120_KEYS) {
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
