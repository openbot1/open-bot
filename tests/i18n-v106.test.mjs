/**
 * Test v1.06 (Đội T1): i18n key mới cho memory v7 — đủ 6 locale,
 * placeholder khớp en.
 *
 * Chỉ test thuần (đọc JSON). Không cần build:
 *   node --test tests/i18n-v106.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');

const V106_KEYS = [
  'memoryV7.title',
  'memoryV7.intro',
  'memoryV7.blocksTitle',
  'memoryV7.tiersTitle',
  'memoryV7.tier.working',
  'memoryV7.tier.session',
  'memoryV7.tier.episodic',
  'memoryV7.tier.semantic',
  'memoryV7.gitBacked',
  'memoryV7.gitMissing',
  'memoryV7.historyTitle',
  'memoryV7.recompiled',
  'memoryV7.reused',
  'memoryV7.promote',
  'memoryV7.demote',
  'memoryV7.systemBlockLocked',
  'memoryV7.searchEpisodic',
  'memoryV7.consolidateDryRun',
  'memoryV7.loadError',
];

function loadLocale(loc) {
  return JSON.parse(readFileSync(join(localesDir, `${loc}.json`), 'utf8'));
}

function placeholders(value) {
  return [...String(value).matchAll(/\{[^}]+\}/g)].map((m) => m[0]).sort();
}

test('memory v7 keys exist in all 6 locales with matching placeholders', () => {
  const locales = ['en', 'vi', 'es', 'fr', 'ja', 'zh'].map(loadLocale);
  const [en, ...rest] = locales;
  assert.equal(Object.keys(en).length, 7540); // v1.14 merge: 4983 + 35 + 24 + 39 = 5081. // v1.36 re-pin: 7540.
  for (const key of V106_KEYS) {
    assert.ok(key in en, `missing in en: ${key}`);
    assert.ok(String(en[key]).length > 0, `empty in en: ${key}`);
    for (let i = 0; i < rest.length; i += 1) {
      const loc = ['vi', 'es', 'fr', 'ja', 'zh'][i];
      assert.ok(key in rest[i], `missing in ${loc}: ${key}`);
      assert.ok(String(rest[i][key]).length > 0, `empty in ${loc}: ${key}`);
      assert.deepEqual(
        placeholders(rest[i][key]),
        placeholders(en[key]),
        `placeholder mismatch in ${loc} for ${key}`,
      );
    }
  }
  for (const loc of locales) {
    assert.equal(Object.keys(loc).length, 7540); // v1.14 merge: 4983 + 35 + 24 + 39 = 5081. // v1.36 re-pin: 7540.
    assert.deepEqual(Object.keys(loc), [...Object.keys(loc)].sort());
  }
});

// v1.07 (Đội T6): 12 key fleetV4Teams_* — đủ 6 locale, không rỗng, placeholder khớp en.
const V107_FLEET_TEAMS_KEYS = [
  'fleetV4Teams.title',
  'fleetV4Teams.subtitle',
  'fleetV4Teams.createTeam',
  'fleetV4Teams.teamName',
  'fleetV4Teams.goal',
  'fleetV4Teams.coordinator',
  'fleetV4Teams.members',
  'fleetV4Teams.workstreams',
  'fleetV4Teams.status',
  'fleetV4Teams.contextStrategy',
  'fleetV4Teams.promptCache',
  'fleetV4Teams.worktreePlan',
];

test('fleet v4 teams keys exist in all 6 locales with matching placeholders', () => {
  const locales = ['en', 'vi', 'es', 'fr', 'ja', 'zh'].map(loadLocale);
  const [en, ...rest] = locales;
  for (const key of V107_FLEET_TEAMS_KEYS) {
    assert.ok(key in en, `missing in en: ${key}`);
    assert.ok(String(en[key]).length > 0, `empty in en: ${key}`);
    for (let i = 0; i < rest.length; i += 1) {
      const loc = ['vi', 'es', 'fr', 'ja', 'zh'][i];
      assert.ok(key in rest[i], `missing in ${loc}: ${key}`);
      assert.ok(String(rest[i][key]).length > 0, `empty in ${loc}: ${key}`);
      assert.deepEqual(
        placeholders(rest[i][key]),
        placeholders(en[key]),
        `placeholder mismatch in ${loc} for ${key}`,
      );
    }
  }
});
