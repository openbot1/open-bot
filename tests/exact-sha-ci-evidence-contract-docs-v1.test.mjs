import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dossier = fs.readFileSync(
  path.join(here, '..', 'docs', 'ops', 'EXACT-SHA-CI-EVIDENCE-CONTRACT.md'),
  'utf8',
);

test('1. Exact-SHA CI slice is a contract, not a PASS or release authorization', () => {
  assert.ok(dossier.includes('Exact-SHA CI'));
  assert.ok(dossier.includes('HOLD — no immutable candidate SHA is currently authorized'));
  assert.ok(dossier.includes('not a CI PASS'));
  assert.ok(dossier.includes('No CI dispatch or release workflow is triggered'));
});

test('2. Immutable RC freeze register is the predecessor', () => {
  assert.ok(dossier.includes('Immutable Release Candidate freeze register (PR #68)'));
  assert.ok(dossier.includes('freeze prerequisites are satisfied'));
  assert.ok(dossier.includes('manifest SHA-256'));
});

test('3. Source base is the verified historical remote snapshot, not a candidate', () => {
  assert.ok(dossier.includes('05f38baeab3af91d6db30f14f2026d93dfa6e9ab'));
  assert.ok(dossier.includes('historical snapshot, not an authorized release candidate'));
  assert.ok(dossier.includes('remote GitHub main remains'));
});

test('4. Entry criteria require reconciliation and explicit authorization', () => {
  assert.ok(dossier.includes('## 2. Entry criteria — all mandatory'));
  assert.ok(dossier.includes('full 40-character commit SHA'));
  assert.ok(dossier.includes('full Git tree SHA'));
  assert.ok(dossier.includes('Complete local-to-remote source reconciliation'));
  assert.ok(dossier.includes('explicit release-owner authorization'));
});

test('5. Dispatch must bind to one full candidate SHA and fail closed', () => {
  assert.ok(dossier.includes('Every workflow and job in the gate must bind to the same full candidate SHA'));
  assert.ok(dossier.includes('git rev-parse HEAD'));
  assert.ok(dossier.includes('fail closed'));
  assert.ok(dossier.includes('Never silently fall back to'));
});

test('6. The required command matrix is explicit', () => {
  for (const command of [
    'npm ci',
    'npm run version:sync',
    'npm run version:check',
    'npm run build',
    'npm run typecheck',
    'xvfb-run -a npm test',
    'npm test',
  ]) assert.ok(dossier.includes(command));
  assert.ok(dossier.includes('Windows full suite'));
  assert.ok(dossier.includes('macOS full suite'));
});

test('7. Job-level provenance and test accounting are mandatory', () => {
  assert.ok(dossier.includes('Workflow run ID, job ID, run URL and job URL'));
  assert.ok(dossier.includes('Candidate full source SHA and full tree SHA'));
  assert.ok(dossier.includes('discovered, passed, failed, cancelled and skipped'));
  assert.ok(dossier.includes('classify every skip'));
});

test('8. Pending, retries and failures cannot be converted to PASS', () => {
  assert.ok(dossier.includes('PENDING, not PASS'));
  assert.ok(dossier.includes('Preserve original failures'));
  assert.ok(dossier.includes('A successful retry does not erase an earlier failure'));
});

test('9. Aggregate PASS requires all mandatory jobs on the same candidate', () => {
  assert.ok(dossier.includes('Exact-SHA CI is PASS only when'));
  assert.ok(dossier.includes('same approved full candidate SHA'));
  assert.ok(dossier.includes('independent reviewer signs off'));
});

test('10. Drift-26 is the next downstream gate', () => {
  assert.ok(dossier.includes('Only after Exact-SHA CI is accepted'));
  assert.ok(dossier.includes('Drift-26 adjudication'));
  assert.ok(dossier.includes('Signing and notarization'));
  assert.ok(dossier.includes('Native acceptance'));
  assert.ok(dossier.includes('Operational/security sign-off'));
  assert.ok(dossier.includes('Release-owner GO/HOLD decision'));
});

test('11. Current local and remote state are not conflated', () => {
  assert.ok(dossier.includes('local main `5ee33a1c`'));
  assert.ok(dossier.includes('PR #45 and #46 have landed locally'));
  assert.ok(dossier.includes('PR #47 is present on local main but its gate r2 is still running'));
  assert.ok(dossier.includes('remote GitHub main remains'));
  assert.ok(dossier.includes('No final full source SHA/tree SHA'));
});

test('12. No CI execution or candidate creation is claimed', () => {
  assert.ok(dossier.includes('EXACT-SHA CI NOT STARTED'));
  assert.ok(dossier.includes('No approved candidate exists'));
  assert.ok(dossier.includes('did not access the operator\'s local filesystem'));
  assert.ok(dossier.includes('dispatch CI'));
  assert.ok(dossier.includes('Static source inspection is not CI execution'));
});
