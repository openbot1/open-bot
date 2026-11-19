/**
 * Tests for scripts/i18n-audit (v1.44, Doi T1): gate nhanh liet ke
 * CHINH XAC key i18n thieu theo tung locale.
 *
 * Pure node — no build needed:
 *   node --test tests/i18n-audit-v144.test.mjs
 *
 * Kiem tra:
 *  - tren locale that: PASS, exit 0, 6 locale bang nhau.
 *  - tren ban copy thieu 1 key + 1 key rong: FAIL, exit 1, liet ke dung key.
 *  - --json tra JSON hop le co ok=false khi thieu.
 *  - loc theo prefix: chi tinh key co prefix do.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const script = join(repoRoot, 'scripts', 'i18n-audit');
const realLocalesDir = join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales');

function runAudit(args = []) {
  try {
    const stdout = execFileSync('node', [script, ...args], { encoding: 'utf8' });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      code: error.status ?? 1,
      stdout: error.stdout?.toString() ?? '',
      stderr: error.stderr?.toString() ?? '',
    };
  }
}

test('i18n-audit: locale that PASS, exit 0', () => {
  const result = runAudit();
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PASS/);
  assert.match(result.stdout, /thieu 0 key/);
});

test('i18n-audit: ban copy thieu key + rong key thi FAIL, exit 1, liet ke dung key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'openbot-i18n-audit-'));
  try {
    for (const code of ['en', 'vi', 'zh', 'ja', 'fr', 'es']) {
      cpSync(join(realLocalesDir, `${code}.json`), join(dir, `${code}.json`));
    }
    const vi = JSON.parse(readFileSync(join(dir, 'vi.json'), 'utf8'));
    delete vi['memoryV28.title'];
    vi['memoryV28.intro'] = '   ';
    writeFileSync(join(dir, 'vi.json'), `${JSON.stringify(vi, null, 2)}\n`, 'utf8');

    const result = runAudit(['--locales-dir', dir]);
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, /FAIL/);
    assert.match(result.stdout, /thieu: memoryV28\.title/);
    assert.match(result.stdout, /rong: memoryV28\.intro/);
    assert.match(result.stdout, /vi: thieu 1 key, rong 1 key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('i18n-audit: --json tra JSON hop le, ok=false khi thieu key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'openbot-i18n-audit-'));
  try {
    for (const code of ['en', 'vi', 'zh', 'ja', 'fr', 'es']) {
      cpSync(join(realLocalesDir, `${code}.json`), join(dir, `${code}.json`));
    }
    const es = JSON.parse(readFileSync(join(dir, 'es.json'), 'utf8'));
    delete es['memoryV28.rollback'];
    writeFileSync(join(dir, 'es.json'), `${JSON.stringify(es, null, 2)}\n`, 'utf8');

    const result = runAudit(['--json', '--locales-dir', dir]);
    assert.equal(result.code, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.deepEqual(report.perLocale.es.missing, ['memoryV28.rollback']);
    assert.equal(report.perLocale.es.missingCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('i18n-audit: loc theo prefix chi tinh key co prefix do', () => {
  const result = runAudit(['memoryV28']);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /48 key \(union\)/);
  assert.match(result.stdout, /loc theo prefix: "memoryV28"/);
});
