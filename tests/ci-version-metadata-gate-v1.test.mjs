/**
 * CI must detect committed version-metadata drift before build hooks can
 * run version:sync and silently repair the working tree.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const CI = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');

function jobSection(name, nextName) {
  const start = CI.indexOf(`  ${name}:\n`);
  assert.ok(start >= 0, `CI must define the ${name} job`);
  const end = nextName ? CI.indexOf(`  ${nextName}:\n`, start + 1) : CI.length;
  assert.ok(!nextName || end > start, `CI must define ${nextName} after ${name}`);
  return CI.slice(start, end < 0 ? CI.length : end);
}

test('the build-and-test matrix checks version mirrors before build can auto-sync them', () => {
  const job = jobSection('build-test', 'platform');
  const check = job.indexOf('run: npm run version:check');
  const build = job.indexOf('run: npm run build');
  assert.ok(check >= 0, 'build-test job must run version:check');
  assert.ok(build > check, 'version:check must run before build');
});

test('the platform-test matrix checks version mirrors before build can auto-sync them', () => {
  const job = jobSection('platform');
  const check = job.indexOf('run: npm run version:check');
  const build = job.indexOf('run: npm run build');
  assert.ok(check >= 0, 'platform job must run version:check');
  assert.ok(build > check, 'version:check must run before build');
});

test('both version checks follow dependency installation', () => {
  assert.equal(CI.split('run: npm run version:check').length - 1, 2);
  const blocks = CI.split('run: npm run version:check');
  assert.equal(blocks.length, 3);
  for (const before of blocks.slice(0, 2)) {
    const install = before.lastIndexOf('run: npm ci');
    assert.ok(install >= 0, 'each version check must follow npm ci');
  }
});

test('CI uses the read-only check command, never the synchronizing command', () => {
  assert.equal(CI.split('npm run version:sync').length - 1, 0);
  assert.ok(CI.includes('npm run version:check'));
});
