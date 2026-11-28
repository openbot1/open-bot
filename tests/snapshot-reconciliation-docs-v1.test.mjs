import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dossier = fs.readFileSync(
  path.join(here, '..', 'docs', 'ops', 'SNAPSHOT-RECONCILIATION.md'),
  'utf8',
);

test('1. Slice identity and HOLD boundary are explicit', () => {
  assert.ok(dossier.includes('Snapshot Reconciliation'));
  assert.ok(dossier.includes('Decision: **HOLD — snapshot push and remote reconciliation are not complete**'));
  assert.ok(dossier.includes('does not itself push commits, close PRs, merge PRs'));
  assert.ok(dossier.includes('or authorize production'));
});

test('2. Exact local and remote source identities remain distinct', () => {
  assert.ok(dossier.includes('bf89e113fde085f491cab6df708e15ec1d256053'));
  assert.ok(dossier.includes('798d69ce226f12377131e2d7b37f3c7f45e89f5a'));
  assert.ok(dossier.includes('local `8dc29d67`, PRs #42, #43, #48, #51, #52'));
  assert.ok(dossier.includes('CLEAN — 0 changes'));
  assert.ok(dossier.includes('3,986'));
  assert.ok(dossier.includes('1,531,721'));
});

test('3. All eleven local landing mappings are present', () => {
  assert.ok(dossier.includes('| #38 | `b146ec61` |'));
  assert.ok(dossier.includes('| #39 | `71b287ae` |'));
  assert.ok(dossier.includes('| #53 | `46591ea6` |'));
  assert.ok(dossier.includes('| #54 | `0a59a89b` |'));
  assert.ok(dossier.includes('| #55 | `fd3743a5` |'));
  assert.ok(dossier.includes('| #56 | `16523040` |'));
  assert.ok(dossier.includes('| #57 | `f40a98ba` |'));
  assert.ok(dossier.includes('| #58 | `03bd0c1b` |'));
  assert.ok(dossier.includes('| #59 | `11c23e87` |'));
  assert.ok(dossier.includes('| #40 | `39bc2a43` |'));
  assert.ok(dossier.includes('| #44 | `bf89e113` |'));
  assert.ok(dossier.includes('These are not GitHub merges.'));
});

test('4. The prepared manifest totals are exact and attributed', () => {
  assert.ok(dossier.includes('push-paths-bf89e113.nul'));
  assert.ok(dossier.includes('| Paths | 24 |'));
  assert.ok(dossier.includes('| Added | 23 |'));
  assert.ok(dossier.includes('| Modified | 1 |'));
  assert.ok(dossier.includes('`docs/RELEASING.md`'));
  assert.ok(dossier.includes('+3,780'));
  assert.ok(dossier.includes('257,636 bytes'));
  assert.ok(dossier.includes('operator evidence, not recomputed here'));
});

test('5. Push attempt and expired approval are not represented as success', () => {
  assert.ok(dossier.includes('approximately 09:17 +07'));
  assert.ok(dossier.includes('`64c696cd`'));
  assert.ok(dossier.includes('timed out at 10:08 +07 without being tapped'));
  assert.ok(dossier.includes('No successful snapshot push is claimed.'));
  assert.ok(dossier.includes('A fresh approval card is required'));
});

test('6. Post-push SHA verification requires exact identity', () => {
  assert.ok(dossier.includes('full 40-character SHA'));
  assert.ok(dossier.includes('must equal the intended local source SHA'));
  assert.ok(dossier.includes('matching commit message or short SHA is insufficient'));
  assert.ok(dossier.includes('full tree identity or perform an exhaustive path/blob comparison'));
});

test('7. Manifest reconciliation covers path status and blob content', () => {
  assert.ok(dossier.includes('exact 24 manifest paths'));
  assert.ok(dossier.includes('23 additions'));
  assert.ok(dossier.includes('one modification'));
  assert.ok(dossier.includes('byte content and executable/mode metadata'));
  assert.ok(dossier.includes('remote blob equalled base blob'));
});

test('8. Every local landing commit must be reconciled to pushed history', () => {
  assert.ok(dossier.includes('all eleven local landing commit prefixes'));
  assert.ok(dossier.includes('Record the full commit IDs and ancestry/path evidence'));
  assert.ok(dossier.includes('do not promote the 8-character prefixes'));
});

test('9. PR closure is conditional and explicitly non-merge', () => {
  assert.ok(dossier.includes('PRs #38, #39, #40, #44, #53, #54, #55, #56, #57, #58 and #59'));
  assert.ok(dossier.includes('before closing it with `merged=false`'));
  assert.ok(dossier.includes('Closing is a separate, explicitly authorized reconciliation action'));
  assert.ok(dossier.includes('do not merge these PRs'));
});

test('10. All required stop conditions preserve HOLD', () => {
  assert.ok(dossier.includes('Keep the release gate **HOLD**'));
  assert.ok(dossier.includes('The remote main SHA does not exactly equal the intended local full SHA.'));
  assert.ok(dossier.includes('Any manifest path is missing'));
  assert.ok(dossier.includes('Any of the eleven local landing commits cannot be reconciled'));
  assert.ok(dossier.includes('independent GitHub read-back is unavailable'));
});

test('11. Snapshot reconciliation does not imply immutable RC or GO', () => {
  assert.ok(dossier.includes('does not create the immutable RC'));
  assert.ok(dossier.includes('Exact-SHA CI'));
  assert.ok(dossier.includes('Drift-26 adjudication'));
  assert.ok(dossier.includes('Signing and notarization'));
  assert.ok(dossier.includes('Native acceptance'));
  assert.ok(dossier.includes('Operational/security sign-off'));
  assert.ok(dossier.includes('Release-owner GO'));
  assert.ok(dossier.includes('A snapshot push is source synchronization only'));
});

test('12. Authoring and execution boundaries are explicit', () => {
  assert.ok(dossier.includes('authored through GitHub source APIs'));
  assert.ok(dossier.includes('did not access the operator\\'s local filesystem or NUL manifest'));
  assert.ok(dossier.includes('did not run tests, build, typecheck, CI'));
  assert.ok(dossier.includes('Static guard source review is not test execution.'));
});
