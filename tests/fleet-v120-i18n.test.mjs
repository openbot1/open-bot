/**
 * i18n tests for v1.20 Team T6 (node:test, no network).
 *
 * - All 6 locales have the same key set (6863 keys each at v1.20 merge: 6195 v1.19 base
 *   + 70 new fleetV17/adminV17 keys), no empty values.
 * - fleetV17.* = 40 keys, adminV17.* = 30 keys per locale.
 * - Every new key is a non-empty string in every locale.
 *
 * Run: node --test tests/fleet-v120-i18n.test.mjs
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

test('i18n v120: all 6 locales have 7540 keys, identical key sets, no empty values', () => { // v1.36 re-pin: 7540.
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

test('i18n v120: fleetV17.* = 40, adminV17.* = 30 per locale', () => {
  for (const code of LOCALES) {
    const dict = loadLocale(code);
    assert.equal(Object.keys(dict).filter((k) => k.startsWith('fleetV17.')).length, 40, `${code} fleetV17 count`);
    assert.equal(Object.keys(dict).filter((k) => k.startsWith('adminV17.')).length, 30, `${code} adminV17 count`);
  }
});

test('i18n v120: spot-check v17 values differ per locale', () => {
  const vi = loadLocale('vi');
  const en = loadLocale('en');
  assert.equal(vi['fleetV17.drainPlan'], 'Kế hoạch drain');
  assert.equal(en['fleetV17.drainPlan'], 'Drain plan');
  assert.equal(vi['adminV17.quotaManagement'], 'Quản lý quota');
  assert.equal(en['adminV17.quotaManagement'], 'Quota management');
  assert.equal(vi['fleetV17.overloaded'], 'Quá tải');
  assert.equal(en['fleetV17.overloaded'], 'Overloaded');
});
