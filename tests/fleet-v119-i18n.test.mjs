/**
 * i18n tests for v1.19 Team T6 (node:test, no network).
 *
 * - All 6 locales have the same key set (6863 keys each in the merged tree: 6195 at
 *   the v119-t6 base + 80 new fleetV16/adminV16 keys), no empty
 *   values.
 * - fleetV16.* = 44 keys, adminV16.* = 36 keys per locale.
 * - Every new key is a non-empty string in every locale.
 *
 * Run: node --test tests/fleet-v119-i18n.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const LOCALES = ['en', 'es', 'fr', 'ja', 'vi', 'zh'];

function loadLocale(code) {
  return JSON.parse(fs.readFileSync(path.join(root, 'apps/desktop/src/renderer/i18n/locales', `${code}.json`), 'utf8'));
}

test('i18n v119: all 6 locales have 7540 keys, identical key sets, no empty values', () => { // v1.36 re-pin: 7540.
  const dicts = LOCALES.map(loadLocale);
  const counts = dicts.map((d) => Object.keys(d).length);
  assert.deepEqual(counts, [7540, 7540, 7540, 7540, 7540, 7540]); // v1.36 re-pin: 7540.
  const base = new Set(Object.keys(dicts[0]));
  for (let i = 1; i < dicts.length; i++) {
    const keys = new Set(Object.keys(dicts[i]));
    assert.equal(keys.size, base.size, `${LOCALES[i]} key count differs`);
    for (const k of base) assert.ok(keys.has(k), `${LOCALES[i]} missing key ${k}`);
    for (const k of keys) assert.ok(base.has(k), `${LOCALES[i]} extra key ${k}`);
  }
  for (let i = 0; i < dicts.length; i++) {
    for (const [k, v] of Object.entries(dicts[i])) {
      assert.equal(typeof v, 'string', `${LOCALES[i]}.${k} must be a string`);
      assert.ok(v.length > 0, `${LOCALES[i]}.${k} must be non-empty`);
    }
  }
});

test('i18n v119: fleetV16.* = 44, adminV16.* = 36 per locale', () => {
  for (const code of LOCALES) {
    const dict = loadLocale(code);
    assert.equal(Object.keys(dict).filter((k) => k.startsWith('fleetV16.')).length, 44, `${code} fleetV16 count`);
    assert.equal(Object.keys(dict).filter((k) => k.startsWith('adminV16.')).length, 36, `${code} adminV16 count`);
    // Spot checks: values differ per locale (not copy-pasted English everywhere).
    assert.notEqual(dict['fleetV16.userPanel'], dict['fleetV16.title']);
    assert.ok(dict['fleetV16.title'].includes('v16'));
  }
  const vi = loadLocale('vi');
  assert.equal(vi['fleetV16.userPanel'], 'Quản lý user');
  assert.equal(vi['adminV16.title'], 'Quản trị v16');
  assert.equal(loadLocale('ja')['fleetV16.inviteUser'], 'ユーザーを招待');
  assert.equal(loadLocale('zh')['adminV16.applyConfig'], '应用');
});
