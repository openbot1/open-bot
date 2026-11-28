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
  assert.ok(dossier.includes('snapshot of local `bf89e113`'));
  assert.ok(dossier.includes('798d69ce226f12377131e2d7b37f3c7f45e89f5a'));
  assert.ok(dossier.includes('The current local main prefix `c40465b7` is three commits ahead of remote snapshot `05f38baeab3af91d6db30f14f2026d93dfa6e9ab` due to the not-yet-landed PR #45 range.'));
  assert.ok(dossier.includes('893af7bb5c9f825c71373cb94481a41a40599bbd'));
  assert.ok(dossier.includes('three commits ahead of remote for PR #45'));
});

test('3. Local tree and test counts are attributed to the operator', () => {
  assert.ok(dossier.includes('3,986 tracked files / 1,531,721 lines; clean tree (0 changes)'));
  assert.ok(dossier.includes('12,904 pass / 0 fail / 19 skipped'));
  assert.ok(dossier.includes('12,910 pass / 0 fail / 19 skipped'));
  assert.ok(dossier.includes('12,944 pass / 0 fail / 4 skipped'));
  assert.ok(dossier.includes('the current full local SHA and line count were not supplied'));
  assert.ok(dossier.includes('OPERATOR-REPORTED'));
});

test('4. Snapshot identity and snapshot-integrated state are explicit', () => {
  assert.ok(dossier.includes('snapshot of local `bf89e113`'));
  assert.ok(dossier.includes('SNAPSHOT-INTEGRATED'));
  assert.ok(dossier.includes('CLOSED-UNMERGED'));
  assert.ok(dossier.includes('closed with merged=false'));
});

test('5. The current open queue is recorded without claiming snapshot PRs are closed', () => {
  assert.ok(dossier.includes('exactly 25 open PRs'));
  assert.ok(dossier.includes('every returned PR was Draft'));
  assert.ok(dossier.includes('all eleven PR records remain Open/Draft/unmerged pending separately authorized closure'));
  assert.ok(dossier.includes('PR #62 final head at update 7 is `ef6fd1da3a2875399b8625be3a638ad940a42457`; the preceding source commit `5f3d716a363234c97569b521f92ef88889d663cf` has two queued workflow runs (pull_request `46119649057`; push `46119646487`), and both runs report that exact preceding source SHA. Queued runs are NOT PASS.'));
  assert.ok(dossier.includes('PR #62 final head at update 7 is `ef6fd1da3a2875399b8625be3a638ad940a42457`; the two workflow run IDs for preceding source commit `5f3d716a363234c97569b521f92ef88889d663cf` are pull_request `46119649057` and push `46119646487`, both queued and not a completed verdict.'));
  assert.ok(dossier.includes('PR #45 remains Open/Draft/unmerged and is not in the snapshot'));
});

test('6. Evidence vocabulary contains every allowed disposition', () => {
  assert.ok(dossier.includes('**SNAPSHOT-INTEGRATED / CLOSED-UNMERGED**'));
  assert.ok(dossier.includes('**LOCAL-LANDED / PUSH-AND-PR-RECONCILIATION-PENDING**'));
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
  assert.ok(dossier.includes('Current local source HEAD'));
  assert.ok(dossier.includes('GitHub main snapshot'));
  assert.ok(dossier.includes('current local main prefix `c40465b7`'));
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
  assert.ok(dossier.includes('12,944 pass / 0 fail / 4 skipped'));
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
  assert.ok(dossier.includes('Draft/HOLD'));
  assert.ok(dossier.includes('No slice is LAND-READY solely because its documentation guard is static PASS.'));
});

test('13. Candidate evidence gates require one immutable full SHA', () => {
  assert.ok(dossier.includes('one and the same immutable full candidate SHA'));
  assert.ok(dossier.includes('A new commit invalidates downstream evidence'));
  assert.ok(dossier.includes('Workflow run IDs, job IDs, URLs, full head SHA'));
  assert.ok(dossier.includes('Queued, pending, cancelled, missing, stale or failed job'));
});

test('14. Artifact, signing and native platform evidence are mandatory', () => {
  assert.ok(dossier.includes('Artifact filename, package format, byte size, source URL and SHA-256.'));
  assert.ok(dossier.includes('downloaded-byte comparison'));
  assert.ok(dossier.includes('Windows Authenticode'));
  assert.ok(dossier.includes('macOS notarization/Gatekeeper'));
  assert.ok(dossier.includes('Linux signing'));
  assert.ok(dossier.includes('Native install/upgrade'));
});

test('15. Provider and runtime gates require actual execution', () => {
  assert.ok(dossier.includes('Required provider matrix'));
  assert.ok(dossier.includes('explicit authorization'));
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
  assert.ok(dossier.includes('no production GO'));
  assert.ok(dossier.includes('The final head created by this update must be read back from live GitHub metadata'));
  assert.ok(dossier.includes('No CI success, production GO'));
});


test('19. Local landings remain distinct from live GitHub PR state', () => {
  assert.ok(dossier.includes('Local landing reported'));
  assert.ok(dossier.includes('Open / Draft / unmerged'));
  assert.ok(dossier.includes('Do not close or merge these PR records until the next authorized snapshot push is read back'));
  assert.ok(dossier.includes('Current local main is `c40465b7`, clean, 3,988 tracked files'));
});

test('20. DYNAMIC-READY and fixpack results are attributed to the operator', () => {
  assert.ok(dossier.includes('r2 coordinator timeout/no verdict'));
  assert.ok(dossier.includes('r3 VM restart/no verdict'));
  assert.ok(dossier.includes('18/18'));
  assert.ok(dossier.includes('71/71'));
  assert.ok(dossier.includes('OPERATOR-REPORTED'));
});

test('21. The post-GO operational assurance phase is explicitly deferred', () => {
  assert.ok(dossier.includes('Work explicitly deferred until AFTER GO'));
  assert.ok(dossier.includes('Production Rollout & Post-Go-Live Operational Assurance'));
  assert.ok(dossier.includes('Do not create or land PRs for this phase before the release owner has explicitly authorized GO.'));
});


test('22. Current local main and eleven local landings are recorded distinctly', () => {
  assert.ok(dossier.includes('local source `bf89e113`'));
  assert.ok(dossier.includes('The eleven earlier local landings #38, #39, #40, #44 and #53–#59'));
  assert.ok(dossier.includes('OPERATOR-REPORTED'));
});

test('23. PR 59 preserves failure, retest and inconclusive gate history', () => {
  assert.ok(dossier.includes('PR #59 is reported locally cherry-picked'));
  assert.ok(dossier.includes('13,109 tests / 13,104 pass / 1 fail'));
  assert.ok(dossier.includes('isolated CLI retest passed 7/7'));
  assert.ok(dossier.includes('r2 coordinator timeout/no verdict'));
  assert.ok(dossier.includes('r3 VM restart/no verdict'));
  assert.ok(dossier.includes('0 cancelled + 4 skipped'));
  assert.ok(dossier.includes('13,105 pass / 0 fail / 4 skipped'));
  assert.ok(dossier.includes('893af7bb5c9f825c71373cb94481a41a40599bbd'));
});

test('24. Current local identity and metrics are explicitly not GitHub-verified', () => {
  assert.ok(dossier.includes('bf89e113fde085f491cab6df708e15ec1d256053'));
  assert.ok(dossier.includes('the current full local SHA and line count were not supplied'));
  assert.ok(dossier.includes('Previous snapshot source tree size / line count'));
  assert.ok(dossier.includes('3,986 tracked files / 1,531,721 lines; clean tree (0 changes)'));
  assert.ok(dossier.includes('Current local main is `c40465b7`, clean, 3,988 tracked files, three commits ahead of remote for PR #45'));
});

test('25. Exactly eight ordered GO blockers are enumerated', () => {
  assert.ok(dossier.includes('## 8. Ordered GO blockers — all must be closed before a GO decision'));
  assert.ok(dossier.includes('1. **Preserve #59 gate history and complete PR-record reconciliation for the eleven snapshot-integrated landings.**'));
  assert.ok(dossier.includes('2. **Finish the remaining PR queue and reconcile dependencies.**'));
  assert.ok(dossier.includes('3. **Reconcile local and remote source lineage.**'));
  assert.ok(dossier.includes('4. **Produce one immutable final candidate.**'));
  assert.ok(dossier.includes('5. **Complete exact-SHA CI/build/typecheck/test gates.**'));
  assert.ok(dossier.includes('6. **Complete artifact, signing, provenance and native platform acceptance.**'));
  assert.ok(dossier.includes('7. **Complete operational/security acceptance and independent review.**'));
  assert.ok(dossier.includes('8. **Obtain explicit release-owner GO/HOLD decision.**'));
});

test('26. The post-GO rollout phase remains deferred', () => {
  assert.ok(dossier.includes('Work explicitly deferred until AFTER GO'));
  assert.ok(dossier.includes('Production Rollout & Post-Go-Live Operational Assurance'));
  assert.ok(dossier.includes('no PR for that phase is created or requested here'));
});


test('27. The exact PR #62 self-head at the start of this update is recorded', () => {
  assert.ok(dossier.includes('893af7bb5c9f825c71373cb94481a41a40599bbd'));
});

test('28. The current local source identity, clean tree and manifest are recorded', () => {
  assert.ok(dossier.includes('bf89e113fde085f491cab6df708e15ec1d256053'));
  assert.ok(dossier.includes('3,986 tracked files / 1,531,721 lines; clean tree (0 changes)'));
  assert.ok(dossier.includes('push-paths-bf89e113.nul'));
  assert.ok(dossier.includes('24 paths (23 added, one modified: `docs/RELEASING.md`), +3,780 lines, 257,636 bytes'));
});
test('29. Successful snapshot push, open PR reconciliation and #45 gate state are current', () => {
  assert.ok(dossier.includes('05f38baeab3af91d6db30f14f2026d93dfa6e9ab'));
  assert.ok(dossier.includes('successful 10:01 +07 snapshot push'));
  assert.ok(dossier.includes('sync record: 109 entries'));
  assert.ok(dossier.includes('3,988 tracked files'));
  assert.ok(dossier.includes('three commits ahead of remote for PR #45'));
  assert.ok(dossier.includes('Its r1 full-suite gate is RED: 13,134 tests / 13,130 pass / 1 fail / 3 skipped'));
  assert.ok(dossier.includes('r2 is also RED: 13,134 / 13,130 / 1 / 3'));
  assert.ok(dossier.includes('r3 is currently running; no verdict is available yet'));
  assert.ok(dossier.includes('Remaining land queue: #46 → #47 → #49 → #50 → #60 → #61 → #63 → #64 → #65 → #66'));
  assert.ok(dossier.includes('PR #45 remains Open/Draft/unmerged and is not in the snapshot'));
});
