import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dossier = fs.readFileSync(
  path.join(here, '..', 'docs', 'ops', 'IMMUTABLE-RELEASE-CANDIDATE.md'),
  'utf8',
);

test('1. Immutable RC slice is preparation only and HOLD', () => {
  assert.ok(dossier.includes('Immutable Release Candidate'));
  assert.ok(dossier.includes('Decision: **HOLD — no immutable release candidate has been created or authorized**'));
  assert.ok(dossier.includes('does not freeze source'));
  assert.ok(dossier.includes('does not authorize publication'));
});

test('2. Snapshot predecessor is explicit and dynamically pending', () => {
  assert.ok(dossier.includes('predecessor Snapshot Reconciliation slice is PR #67'));
  assert.ok(dossier.includes('dynamic test and exact-head CI verdict are still pending'));
  assert.ok(dossier.includes('remains Draft/HOLD'));
});

test('3. Current remote and local source identities are not conflated', () => {
  assert.ok(dossier.includes('05f38baeab3af91d6db30f14f2026d93dfa6e9ab'));
  assert.ok(dossier.includes('Snapshot of local bf89e113'));
  assert.ok(dossier.includes('Current local main'));
  assert.ok(dossier.includes('c40465b7'));
  assert.ok(dossier.includes('Three commits ahead of remote for PR #45'));
});

test('4. PR45 gate failures and pending rerun are preserved', () => {
  assert.ok(dossier.includes('PR #45'));
  assert.ok(dossier.includes('r1 and r2 full-suite gates RED'));
  assert.ok(dossier.includes('13,134 tests / 13,130 pass / 1 fail / 3 skipped'));
  assert.ok(dossier.includes('isolated retest 10/10'));
  assert.ok(dossier.includes('isolated retest 27/27'));
  assert.ok(dossier.includes('r3 running'));
});

test('5. Remaining land queue is ordered and needs individual gates', () => {
  assert.ok(dossier.includes('#46 → #47 → #49 → #50 → #60 → #61 → #63 → #64 → #65 → #66'));
  assert.ok(dossier.includes('Each requires its own full-suite gate at land time'));
});

test('6. Eleven earlier PR contents and PR-record status are distinct', () => {
  assert.ok(dossier.includes('eleven earlier local landings (#38, #39, #40, #44 and #53–#59)'));
  assert.ok(dossier.includes('PR records remain open pending separate authorized closure'));
  assert.ok(dossier.includes('not equivalent to GitHub PR merges'));
});

test('7. Candidate identity requires full commit and tree identity', () => {
  assert.ok(dossier.includes('Candidate source commit'));
  assert.ok(dossier.includes('Full 40-character commit SHA'));
  assert.ok(dossier.includes('Candidate Git tree'));
  assert.ok(dossier.includes('Full tree SHA'));
  assert.ok(dossier.includes('A short SHA, branch name, mutable tag, PR head'));
});

test('8. Missing candidate fields are explicitly unset', () => {
  assert.ok(dossier.includes('Candidate version'));
  assert.ok(dossier.includes('UNSET — must be read from final source'));
  assert.ok(dossier.includes('Candidate manifest'));
  assert.ok(dossier.includes('NOT CREATED'));
  assert.ok(dossier.includes('Freeze authority'));
});

test('9. Freeze prerequisites require all source and gate work', () => {
  assert.ok(dossier.includes('## 4. Freeze prerequisites — all mandatory'));
  assert.ok(dossier.includes('Finish PR #45 r3'));
  assert.ok(dossier.includes('Process the remaining land queue in order'));
  assert.ok(dossier.includes('Complete dynamic verification and exact-head CI'));
  assert.ok(dossier.includes('require exact full-SHA equality'));
  assert.ok(dossier.includes('Obtain explicit release-owner authorization'));
});

test('10. Canonical manifest is complete, hashed and secret-safe', () => {
  assert.ok(dossier.includes('## 5. Canonical candidate manifest contract'));
  assert.ok(dossier.includes('Full source commit SHA and full Git tree SHA'));
  assert.ok(dossier.includes('Every build input path with its Git blob SHA and file mode'));
  assert.ok(dossier.includes('Manifest SHA-256'));
  assert.ok(dossier.includes('Do not put credentials, signing keys, tokens'));
  assert.ok(dossier.includes('Recompute and compare its SHA-256 after every transfer'));
});

test('11. Freeze procedure prohibits post-freeze mutation', () => {
  assert.ok(dossier.includes('## 6. Freeze procedure and mutation rules'));
  assert.ok(dossier.includes('Obtain release-owner authorization'));
  assert.ok(dossier.includes('Only then may the authorized operator create the immutable candidate ref or tag'));
  assert.ok(dossier.includes('Any change creates a new candidate identity'));
  assert.ok(dossier.includes('does not itself create a Git tag'));
});

test('12. Exact-SHA CI and downstream gates are ordered', () => {
  assert.ok(dossier.includes('The next gate is Exact-SHA CI'));
  assert.ok(dossier.includes('exact frozen candidate SHA'));
  assert.ok(dossier.includes('Drift-26 adjudication'));
  assert.ok(dossier.includes('Signing and notarization'));
  assert.ok(dossier.includes('Native acceptance'));
  assert.ok(dossier.includes('Operational/security sign-off'));
  assert.ok(dossier.includes('Release-owner GO'));
});

test('13. Stop conditions preserve HOLD', () => {
  assert.ok(dossier.includes('## 8. Stop conditions'));
  assert.ok(dossier.includes('candidate NOT FROZEN and release gate HOLD'));
  assert.ok(dossier.includes('working tree is dirty'));
  assert.ok(dossier.includes('manifest is missing, mutable, unhashed'));
  assert.ok(dossier.includes('Freeze authority or release-owner approval is absent'));
  assert.ok(dossier.includes('not permission to force-push'));
});

test('14. Current disposition confirms no candidate exists', () => {
  assert.ok(dossier.includes('**HOLD — NO IMMUTABLE RC EXISTS.**'));
  assert.ok(dossier.includes('Candidate version, final source SHA, tree SHA'));
  assert.ok(dossier.includes('PR #62 and #67 remain Draft/HOLD'));
});

test('15. Authoring and execution boundaries are explicit', () => {
  assert.ok(dossier.includes('authored through GitHub source APIs'));
  assert.ok(dossier.includes('did not access the operator\'s local filesystem'));
  assert.ok(dossier.includes('execute tests, build, typecheck, CI'));
  assert.ok(dossier.includes('Static guard source comparison is not test execution.'));
});
