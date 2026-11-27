import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dossier = fs.readFileSync(
  path.join(here, '..', 'docs', 'ops', 'FINAL-GO-LIVE-ACCEPTANCE-DOSSIER.md'),
  'utf8',
);

test('1. Slice 5/5 is identified and the decision defaults to HOLD', () => {
  assert.ok(dossier.includes('Release Candidate & Go-Live Evidence — Slice 5/5: GO Decision & Dossier Update'));
  assert.ok(dossier.includes('CURRENT DECISION: HOLD — NOT AUTHORIZED FOR PRODUCTION GO-LIVE.'));
  assert.ok(dossier.includes('HOLD remains in force.'));
  assert.ok(dossier.includes('This dossier is an evidence register, not an automatic approval.'));
});

test('2. Local source SHA and remote snapshot SHA remain distinct', () => {
  assert.ok(dossier.includes('8dc29d6714b047b4fb304ea1e98eede260481925'));
  assert.ok(dossier.includes('798d69ce226f12377131e2d7b37f3c7f45e89f5a'));
  assert.ok(dossier.includes('The local source HEAD and GitHub snapshot commit are different commit identities.'));
  assert.ok(dossier.includes('never shorten or conflate them in final evidence'));
});

test('3. Local tree and test counts are attributed to the operator', () => {
  assert.ok(dossier.includes('3,963 tracked files and 1,527,941 lines'));
  assert.ok(dossier.includes('12,914 pass / 0 fail / 3 skipped'));
  assert.ok(dossier.includes('These local tree counts and test results are operator-reported'));
  assert.ok(dossier.includes('this author did not run or independently reproduce them'));
});

test('4. Snapshot identity and snapshot-integrated state are explicit', () => {
  assert.ok(dossier.includes('snapshot: local main 8dc29d67 (PRs #42, #43, #48, #51, #52)'));
  assert.ok(dossier.includes('SNAPSHOT-INTEGRATED'));
  assert.ok(dossier.includes('PR-CLOSURE-PENDING'));
  assert.ok(dossier.includes('does not itself change their individual GitHub PR state'));
});

test('5. The current open queue is recorded without claiming snapshot PRs are closed', () => {
  assert.ok(dossier.includes('GitHub listed 28 open PRs at read-back, all Draft.'));
  assert.ok(dossier.includes('Five are snapshot-integrated with PR closure pending; 23 other PRs remain PENDING-LAND.'));
  assert.ok(dossier.includes('those five PRs open and Draft'));
  assert.ok(dossier.includes('maximum listed PR number was #66'));
});

test('6. Evidence vocabulary contains every allowed disposition', () => {
  assert.ok(dossier.includes('**SNAPSHOT-INTEGRATED**'));
  assert.ok(dossier.includes('**PR-CLOSURE-PENDING**'));
  assert.ok(dossier.includes('**PENDING-LAND**'));
  assert.ok(dossier.includes('**PASS**'));
  assert.ok(dossier.includes('**FAIL**'));
  assert.ok(dossier.includes('**BLOCKED**'));
  assert.ok(dossier.includes('**NOT RUN**'));
  assert.ok(dossier.includes('**NOT APPLICABLE**'));
});

test('7. The GO rule requires exact candidate evidence and release-owner authority', () => {
  assert.ok(dossier.includes('GO may be recorded only by the accountable release owner'));
  assert.ok(dossier.includes('one exact candidate SHA'));
  assert.ok(dossier.includes('all skips and exceptions have documented disposition'));
  assert.ok(dossier.includes('rollback/forward-fix readiness is evidenced'));
  assert.ok(dossier.includes('Any FAIL, BLOCKED, NOT RUN'));
});

test('8. Repository identity table records remote and local roles separately', () => {
  assert.ok(dossier.includes('Local source HEAD'));
  assert.ok(dossier.includes('GitHub main snapshot'));
  assert.ok(dossier.includes('Source/snapshot relationship'));
  assert.ok(dossier.includes('OPERATOR-REPORTED'));
  assert.ok(dossier.includes('GITHUB-READ-BACK'));
});

test('9. Five snapshot PRs and their exact heads are listed', () => {
  assert.ok(dossier.includes('311160c63b34d4d710c80350f950702bbdae1cf0'));
  assert.ok(dossier.includes('2ab5e0869cb5a7a4d176de52c205ff4065bedaf6'));
  assert.ok(dossier.includes('36a8cb7ee307d33665ff9e0f2cbc53e18f58682e'));
  assert.ok(dossier.includes('7e8b5d6ee888253c2eb66158ef2b6701083ae503'));
  assert.ok(dossier.includes('d95a2c9f545ddc4e3fe7633957039edbd95ea206'));
});

test('10. Release engineering PR heads are recorded', () => {
  assert.ok(dossier.includes('e65bda54f599fb48dc16b9d5ba3fd486389b0488'));
  assert.ok(dossier.includes('6ba8de831c6b4a21267e243e9aabb40c73e7bc0f'));
  assert.ok(dossier.includes('be6cd6457c67b45302ae71e3cb125adc651fc114'));
  assert.ok(dossier.includes('eb5a9f3bafc8c81d60949c0a064ffd49a266f9c9'));
  assert.ok(dossier.includes('73c0bfa024f7f9c2d317a44e2c061c194d65dc55'));
  assert.ok(dossier.includes('ae065c71c2bce1755a62abcb15b8ae3f7a54eddb'));
  assert.ok(dossier.includes('8dcaed5f6b9d35192ad460c7dc301f57c005389b'));
  assert.ok(dossier.includes('817a42547f4b51601821e322c937239f581464ad'));
  assert.ok(dossier.includes('a665caf162316a046f07b53634a0b2dc9461c6ab'));
});

test('11. Security, operations and lifecycle PR heads are recorded', () => {
  assert.ok(dossier.includes('8a1239e2bc114ed42843b921def8f9f4e772326f'));
  assert.ok(dossier.includes('064bf8c11510d0183a3a8c2c30c7b457d5e2a5c7'));
  assert.ok(dossier.includes('2cf14e2baeee4475db3efebde444a5aaf3ac6ec4'));
  assert.ok(dossier.includes('35cdce02aadb733eee13ff915893e070a44e397d'));
  assert.ok(dossier.includes('2d14ddbfc288e60675632240caf37bb0fc9a1667'));
  assert.ok(dossier.includes('4369feba884727818bffb1109101db096798f374'));
  assert.ok(dossier.includes('6e788fc4d91d1a94487bad0493f3c945e57eab39'));
  assert.ok(dossier.includes('9c922cf3df3f68d13024bf8f7c750fe4e780d411'));
  assert.ok(dossier.includes('b8ddfe80be8b39606ea6e73ea96ccde487bf3bba'));
});

test('12. Slices one through four have exact heads and remain Draft pending land', () => {
  assert.ok(dossier.includes('4bc52e659253bff681e10afc40c4e636995bdcda'));
  assert.ok(dossier.includes('e4626e8d6262ff531854322278c72221a7b1c0bc'));
  assert.ok(dossier.includes('c2560e110254665008bb965befd76f4f19cc00c3'));
  assert.ok(dossier.includes('ef7c85399b2b73dba8f5044b6817c06a2e98b6d7'));
  assert.ok(dossier.includes('Draft / PENDING-LAND'));
  assert.ok(dossier.includes('static-review PASS is not a dynamic release gate'));
});

test('13. Candidate evidence gates require one immutable full SHA', () => {
  assert.ok(dossier.includes('one and the same immutable full candidate SHA'));
  assert.ok(dossier.includes('A new commit invalidates downstream evidence'));
  assert.ok(dossier.includes('Workflow run IDs, job IDs, URLs, full head SHA'));
  assert.ok(dossier.includes('Queued, pending, cancelled, missing, stale or failed job'));
});

test('14. Artifact, signing and native platform evidence are mandatory', () => {
  assert.ok(dossier.includes('Artifact filename, package format, byte size, source URL and SHA-256.'));
  assert.ok(dossier.includes('uploaded/downloaded bytes'));
  assert.ok(dossier.includes('Windows Authenticode'));
  assert.ok(dossier.includes('macOS notarization/Gatekeeper'));
  assert.ok(dossier.includes('Linux signing'));
  assert.ok(dossier.includes('Native install/upgrade'));
});

test('15. Provider and runtime gates require actual execution', () => {
  assert.ok(dossier.includes('Required provider matrix'));
  assert.ok(dossier.includes('explicit consent'));
  assert.ok(dossier.includes('harmless live requests'));
  assert.ok(dossier.includes('Idle and controlled-activity soak'));
  assert.ok(dossier.includes('window-close vs quit'));
  assert.ok(dossier.includes('listener leak'));
});

test('16. Exception register preserves failures, skips and ownership', () => {
  assert.ok(dossier.includes('Every skipped test, reason, risk, owner and disposition.'));
  assert.ok(dossier.includes('Every failure, retry, deviation and exception'));
  assert.ok(dossier.includes('An exception is not a PASS.'));
  assert.ok(dossier.includes('No failure may be deleted or overwritten'));
  assert.ok(dossier.includes('Compensating control'));
});

test('17. Independent review and rollback readiness are recorded separately', () => {
  assert.ok(dossier.includes('Independent reviewer identity, role, review date and approval reference.'));
  assert.ok(dossier.includes('Release owner identity and explicit approval statement.'));
  assert.ok(dossier.includes('Rollback and forward-fix readiness evidence'));
  assert.ok(dossier.includes('Only the accountable release owner may record GO.'));
});

test('18. No assistant test execution or production GO is claimed', () => {
  assert.ok(dossier.includes('This author used GitHub-only source authoring'));
  assert.ok(dossier.includes('did not run tests, build, typecheck, CI'));
  assert.ok(dossier.includes('This dossier records no production GO.'));
  assert.ok(dossier.includes('No production GO'));
});
