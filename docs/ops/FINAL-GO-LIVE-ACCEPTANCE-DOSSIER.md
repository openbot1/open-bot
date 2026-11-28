# Final Go-Live Acceptance Dossier

Snapshot time: 2026-11-28 12:01 +07 (operator verification at 13:52 +07 and live GitHub read-back)
Repository: openbot1/open-bot
Phase: Release Candidate & Go-Live Evidence — Slice 5/5: GO Decision & Dossier Update
Purpose: consolidate exact-candidate evidence and record an explicit release-owner HOLD/GO decision. This dossier is an evidence register, not an automatic approval.

## 1. Executive decision

**CURRENT DECISION: HOLD — NOT AUTHORIZED FOR PRODUCTION GO-LIVE.**

This cycle updates the existing dossier PR #62 and records the successful source snapshot push. No PR closure or merge is performed by this author. No Production Rollout PR is created; the post-GO rollout phase remains deferred.

The successful 10:01 +07 snapshot push synchronized local source `bf89e113` to GitHub main `05f38baeab3af91d6db30f14f2026d93dfa6e9ab` (operator-reported sync record: 109 entries). Current local main is `c40465b7`, clean, with 3,988 tracked files; it is three commits ahead of remote, consisting of the in-progress PR #45 cherry-pick range. The full current local SHA and current line count were not supplied in this cycle and are intentionally not inferred. The eleven earlier local landings (#38, #39, #40, #44 and #53–#59) are now represented in the pushed snapshot. Live GitHub confirms all eleven PR records remain Open/Draft/unmerged pending separately authorized closure; the snapshot push is not a GitHub PR merge or closure.

GitHub main was read back at full SHA `05f38baeab3af91d6db30f14f2026d93dfa6e9ab`, a snapshot of local `bf89e113` (successful push at approximately 10:01 +07; operator reports sync record with 109 entries). The current local main `c40465b7` is three commits ahead of this remote snapshot, corresponding to the in-progress PR #45 landing.

Operator reports #59 was cherry-picked as three commits from PR #59 source head `6e788fc4`, adding two files and 275 lines, with local main now at `bf89e113fde085f491cab6df708e15ec1d256053`. Its gate history must retain the initial failure: r1 reported 13,109 tests, 13,104 passed and one failure, a 60-second timeout in the CLI `--help` test. The isolated retest of that CLI test group reportedly passed 7/7; this does not erase the original full-gate failure. r1: 13,109 tests = 13,104 pass + 1 fail + 0 cancelled + 4 skipped; all four skips are accounted for. The sole failure was the CLI `--help` test timing out at 60 seconds; the isolated CLI retest reportedly passed 7/7, which does not erase the original full-gate failure. r2 was cut off by coordinator timeout (NO VERDICT); r3 was cut off by VM restart (NO VERDICT). r4 is reported GREEN: 13,109 tests = 13,105 pass + 0 fail + 4 skipped. The reported suite size for #59 r4 is 13,109 tests. PR #45 is not landed. Its r1 full-suite gate is RED: 13,134 tests / 13,130 pass / 1 fail / 3 skipped (sole failure PKCE flake; isolated retest 10/10 pass). r2 is also RED: 13,134 / 13,130 / 1 / 3 (sole failure Ollama RPC timeout flake; isolated retest 27/27 pass). Both isolated retests are supplemental and do not erase the full-suite failures. r3 is currently running; no verdict is available yet. The last reported green full-suite gate before #45's current attempts remains PR #44 r2: 13,125 tests / 13,121 pass / 0 fail / 4 skipped.

The eleven snapshot-integrated PR records #38, #39, #40, #44 and #53–#59 remain Open/Draft/unmerged on GitHub. Their contents are represented in the successful remote snapshot according to the operator's 109-entry sync record; PR closure remains a separate pending authorization. Do not turn earlier #57/#58 static or verifier counts into current-head full-suite PASS.

Live GitHub read-back confirms PRs #38, #39, #40, #44 and #53–#59 remain Open/Draft/unmerged after the snapshot push. #45 is also Open/Draft/unmerged and is not yet landed. This author did not close or merge any PR. The previously closed PR records #41, #42, #43, #48, #51 and #52 remain separate from the eleven snapshot-integrated PR records.

PR #62 at the start of this cycle is Open/Draft/unmerged, based on remote main `798d69ce226f12377131e2d7b37f3c7f45e89f5a`, with head `893af7bb5c9f825c71373cb94481a41a40599bbd`. The final head created by this update must be read back from live GitHub metadata; its CI status must be checked on that exact SHA. The updated dossier guard source contains 29 top-level test groups and 157 assertion calls / 157 literal `dossier.includes(...)` checks; static source comparison reports 157/157 literal matches, but the updated guard has not been executed by this author. No CI success, production GO, release-owner approval, signing, notarization or native acceptance is claimed.

## 2. Evidence vocabulary and decision rules

Use these states consistently:

- **SNAPSHOT-INTEGRATED / CLOSED-UNMERGED** — PR content is reported in the pushed snapshot and the individual GitHub PR record is now closed with merged=false; this is not a GitHub merge.
- **LOCAL-LANDED / PUSH-AND-PR-RECONCILIATION-PENDING** — the operator reports a local landing, but GitHub main has not yet advanced to include it and the corresponding PR remains open/Draft.
- **DYNAMIC-READY (OPERATOR-REPORTED)** — operator-reported checks passed on the stated local copy/head; this is not a substitute for a fresh dynamic run on the current local head.
- **PENDING-LAND** — the PR remains open and Draft on GitHub and is not yet included in the remote snapshot.
- **PASS** — the check was actually executed on the exact recorded candidate/artifact and met its observable criterion.
- **FAIL** — an executed check did not meet its criterion.
- **BLOCKED** — a prerequisite, authorization, service or safe environment prevented execution.
- **NOT RUN** — no execution evidence was collected.
- **NOT APPLICABLE** — the release owner explicitly records why a gate does not apply to this release.

Never convert a plan, static source inspection, documentation guard, CI configuration, queued job, draft PR, mock, screenshot or operator intention into PASS. Evidence must identify the full candidate SHA, artifact filename and SHA-256, OS/build/architecture, exact command or manual procedure, timestamp/timezone, operator, raw result, reviewer and retained sanitized evidence.

### Overall GO rule

GO may be recorded only by the accountable release owner, with a dated decision naming one exact candidate SHA, after every required gate is PASS or explicitly approved NOT APPLICABLE, all skips and exceptions have documented disposition, all required native platform packets are independently reviewed, rollback/forward-fix readiness is evidenced, and the published artifacts match their approved hashes. Any FAIL, BLOCKED, NOT RUN, unexplained skip, stale/mismatched SHA, missing reviewer, unsigned/unverified artifact or unresolved exception means HOLD.

## 3. Repository and snapshot identity

| Item | Current value | Evidence state | Decision rule |
|---|---|---|---|
| Current local source HEAD | `c40465b7` (short SHA only supplied) | OPERATOR-REPORTED | Clean; 3,988 tracked files; three commits ahead of remote for PR #45; full SHA/line count not supplied |
| GitHub main snapshot | `05f38baeab3af91d6db30f14f2026d93dfa6e9ab`; snapshot of local `bf89e113` | GITHUB-READ-BACK | Includes the eleven earlier local landings; current local main is three commits ahead for #45 |
| Previous snapshot source tree size / line count | 3,986 tracked files / 1,531,721 lines; clean tree (0 changes) at local HEAD bf89e113 | OPERATOR-REPORTED historical snapshot evidence | Not the current local main metrics; current local main c40465b7 has 3,988 tracked files |
| Snapshot-integrated PRs | #38, #39, #40, #44, #53–#59 | OPERATOR-REPORTED sync record + GITHUB-READ-BACK remote main | PR records remain Open/Draft/unmerged pending separately authorized closure |
| #59 cherry-pick | Three commits from source head `6e788fc4`; two files, +275 lines; local HEAD `bf89e113fde085f491cab6df708e15ec1d256053` | OPERATOR-REPORTED | Not independently visible on remote main |
| #59 gate r1 | 13,109 tests = 13,104 pass + 1 fail + 0 cancelled + 4 skipped; summary form: 13,109 tests / 13,104 pass / 1 fail; sole failure was CLI `--help` 60-second timeout | OPERATOR-REPORTED / FAIL | Four skips are accounted for; preserve initial failure |
| #59 isolated retest | CLI test group reportedly 7/7 pass | OPERATOR-REPORTED | Supplemental retest; does not convert r1 full gate to PASS |
| #59 gate r2 | Coordinator timeout; no verdict | OPERATOR-REPORTED / NO VERDICT | Not PASS; do not count partial run as green |
| #59 gate r4 | 13,109 tests; 13,105 pass; 0 fail; 4 skipped | OPERATOR-REPORTED / PASS | Latest reported full-suite green result on local main `bf89e113fde085f491cab6df708e15ec1d256053` |
| #59 gate r3 | VM restart interrupted run; no verdict | OPERATOR-REPORTED / NO VERDICT | Do not treat interrupted run as PASS |
| Full-suite size | Approximately 13,109 tests | OPERATOR-REPORTED | Approximate suite size, not a completed gate verdict |
| GitHub open PR queue | Prior cycle read-back: 23 open, all Draft | GITHUB-READ-BACK (prior read) | Re-read current inventory before using as a current-cycle count |
| PR #62 at cycle start | Head `69b6670f7359b28205c0c65dea0240d61ed302d5`; base `798d69ce226f12377131e2d7b37f3c7f45e89f5a` | GITHUB-READ-BACK | New dossier commit requires fresh CI read-back |
| PR #62 CI at cycle start | Not re-read for the exact cycle-start head in this update | PENDING | Do not transfer CI state between SHAs |
| Dossier documentation guard | 28 top-level groups after this update; source assertion inventory is static-only until exact-head CI completes | GitHub source inspection; NOT EXECUTED BY THIS AUTHOR | Static/documentation guard only; not product/full-suite acceptance |
| Release decision | Candidate evidence and release-owner GO approval incomplete | HOLD | No production GO authorized |

The current local main prefix `c40465b7` is three commits ahead of remote snapshot `05f38baeab3af91d6db30f14f2026d93dfa6e9ab` due to the not-yet-landed PR #45 range. Operator reports a clean tree and 3,988 tracked files; the current full local SHA and line count were not supplied. Remote main `05f38bae...` is GitHub-verified. The earlier 11 PR landing contents are represented in that snapshot per the operator's 109-entry sync record, but the PR records remain open until separately authorized closure.

### Current local-to-remote reconciliation inputs (operator-reported)

| Local landing PR | Local main commit at end of cherry-picked range |
|---|---|
| #38 | `b146ec61` |
| #39 | `71b287ae` |
| #53 | `46591ea6` |
| #54 | `0a59a89b` |
| #55 | `fd3743a5` |
| #56 | `16523040` |
| #57 | `f40a98ba` |
| #58 | `03bd0c1b` |
| #59 | `11c23e87` |
| #40 | `39bc2a43` |
| #44 | `bf89e113` |

Snapshot manifest `push-paths-bf89e113.nul`: 24 paths (23 added, one modified: `docs/RELEASING.md`), +3,780 lines, 257,636 bytes. Operator reports no divergence for `docs/RELEASING.md` from its base blob. The snapshot push succeeded at approximately 10:01 +07; GitHub main now reads `05f38baeab3af91d6db30f14f2026d93dfa6e9ab`, snapshot of local `bf89e113`. Operator reports a sync record with 109 entries. The eleven PR records remain open pending the separate closure authorization; the push itself did not merge or close them.

## 4. PR evidence register

All current GitHub PR states, head SHAs and base SHAs below were read back from the live GitHub API during this cycle. Local landing statuses and dynamic/static verifier results are operator-reported and are labelled accordingly.

### 4.1 Snapshot-integrated PRs — closed, not merged

| PR | GitHub head SHA | GitHub state | Disposition |
|---|---|---|---|
| #42 | 311160c63b34d4d710c80350f950702bbdae1cf0 | closed; merged=false | SNAPSHOT-INTEGRATED / CLOSED-UNMERGED |
| #43 | 2ab5e0869cb5a7a4d176de52c205ff4065bedaf6 | closed; merged=false | SNAPSHOT-INTEGRATED / CLOSED-UNMERGED |
| #48 | 36a8cb7ee307d33665ff9e0f2cbc53e18f58682e | closed; merged=false | SNAPSHOT-INTEGRATED / CLOSED-UNMERGED |
| #51 | 7e8b5d6ee888253c2eb66158ef2b6701083ae503 | closed; merged=false | SNAPSHOT-INTEGRATED / CLOSED-UNMERGED |
| #52 | d95a2c9f545ddc4e3fe7633957039edbd95ea206 | closed; merged=false | SNAPSHOT-INTEGRATED / CLOSED-UNMERGED |

The live GitHub PR records are closed but not merged. Their presence in the earlier pushed snapshot is a separate source-lineage fact; do not describe these PRs as GitHub-merged.

### 4.2 Locally landed — remote push and PR reconciliation still pending

| PR | Local landing reported | Current GitHub head SHA | GitHub state | Local evidence reported by operator |
|---|---|---|---|---|
| #38 | Included in local main `bf89e113fde085f491cab6df708e15ec1d256053` | `e65bda54f599fb48dc16b9d5ba3fd486389b0488` | Open / Draft / unmerged | Earlier gate record: r1 had 3 failures diagnosed as flakes; r2 12,904 pass / 0 fail / 19 skipped |
| #39 | Included in local main `bf89e113fde085f491cab6df708e15ec1d256053` | `6ba8de831c6b4a21267e243e9aabb40c73e7bc0f` | Open / Draft / unmerged | Earlier first-run record: 12,910 pass / 0 fail / 19 skipped |
| #40 | Included in local main `bf89e113fde085f491cab6df708e15ec1d256053` | `be6cd6457c67b45302ae71e3cb125adc651fc114` | Open / Draft / unmerged | Local landing commit `39bc2a43`; included in operator-reported local source head |
| #44 | Included in local main `bf89e113fde085f491cab6df708e15ec1d256053` | `eb5a9f3bafc8c81d60949c0a064ffd49a266f9c9` | Open / Draft / unmerged | Local landing commit `bf89e113`; latest full-suite gate r2 GREEN: 13,125 tests / 13,121 pass / 0 fail / 4 skipped |
| #53 | Included in local main `bf89e113fde085f491cab6df708e15ec1d256053` | `8a1239e2bc114ed42843b921def8f9f4e772326f` | Open / Draft / unmerged | Earlier r4 record: 12,944 pass / 0 fail / 4 skipped |
| #54 | Included in local main `bf89e113fde085f491cab6df708e15ec1d256053` | `064bf8c11510d0183a3a8c2c30c7b457d5e2a5c7` | Open / Draft / unmerged | Earlier record: 12,971 pass / 0 fail / 4 skipped |
| #55 | Included in local main `bf89e113fde085f491cab6df708e15ec1d256053` | `2cf14e2baeee4475db3efebde444a5aaf3ac6ec4` | Open / Draft / unmerged | Earlier r2 record: 13,002 pass / 0 fail / 4 skipped |
| #56 | Included in local main `bf89e113fde085f491cab6df708e15ec1d256053` | `35cdce02aadb733eee13ff915893e070a44e397d` | Open / Draft / unmerged | Earlier record: 13,030 pass / 0 fail / 4 skipped; reported first-run green |
| #57 | Included in local main `bf89e113fde085f491cab6df708e15ec1d256053` | `2d14ddbfc288e60675632240caf37bb0fc9a1667` | Open / Draft / unmerged | Local landing reported; final gate summary not supplied in this cycle |
| #58 | Included in local main `bf89e113fde085f491cab6df708e15ec1d256053` | `4369feba884727818bffb1109101db096798f374` | Open / Draft / unmerged | Earlier 18/18 readiness result reported; not a full-suite verdict |
| #59 | Three commits cherry-picked from source head `6e788fc4`; two files, +275 lines; included in local main `bf89e113fde085f491cab6df708e15ec1d256053` | `6e788fc4d91d1a94487bad0493f3c945e57eab39` | Open / Draft / unmerged | r1: 13,109 = 13,104 pass + 1 fail + 0 cancelled + 4 skipped; sole failure CLI `--help` timeout; isolated retest 7/7; r2 coordinator timeout/no verdict; r3 VM restart/no verdict; r4 13,105 pass / 0 fail / 4 skipped |

The GitHub PR head SHAs are remote branch heads, not local landing commit SHAs. The local landing state and gate results are operator-reported. Do not close or merge these PR records until the next authorized snapshot push is read back and the coordinator reconciles the records. The initial #59 failure remains part of the evidence record even after its isolated 7/7 retest.

### 4.3 Cherry-pick and gate disposition — #59 is not a completed gate

PR #59 is reported locally cherry-picked. Preserve the r1 full-gate failure (13,104 pass + 1 fail + 0 cancelled + 4 skipped); the four skips are explicitly accounted for. The sole failure was the CLI `--help` 60-second timeout; its isolated CLI retest passed 7/7 but does not erase r1. r2 ended by coordinator timeout and r3 by VM restart; neither has a verdict. r4 is reported green at 13,109 tests / 13,105 pass / 0 fail / 4 skipped. This is operator-reported local evidence, not GitHub CI evidence.

### 4.3.1 Remaining local/remote reconciliation

The eleven earlier local landings #38, #39, #40, #44 and #53–#59 are represented in remote snapshot `05f38baeab3af91d6db30f14f2026d93dfa6e9ab` per the operator sync record. Live GitHub still shows all eleven PR records Open/Draft/unmerged; closure remains pending separate authorization. PR #45 is not in this snapshot and remains Open/Draft/unmerged.

### 4.4 Fixpack disposition — local landings and dynamic-ready queue

| PR | Scope | Current GitHub head SHA | Operator-reported result | Remaining gate |
|---|---|---|---|---|
| #40 | Linux AppImage cosign | be6cd6457c67b45302ae71e3cb125adc651fc114 | LOCAL-LANDED at local commit `39bc2a43` | Included in local source HEAD; GitHub PR remains Open/Draft until authorized snapshot reconciliation |
| #44 | Windows Authenticode verification | eb5a9f3bafc8c81d60949c0a064ffd49a266f9c9 | LOCAL-LANDED at local commit `bf89e113` | Latest full-suite gate r2 GREEN: 13,125 tests / 13,121 pass / 0 fail / 4 skipped; GitHub PR remains Open/Draft pending snapshot reconciliation |
| #45 | macOS notarization and Gatekeeper | 73c0bfa024f7f9c2d317a44e2c061c194d65dc55 | Local cherry-pick range is three commits ahead at local prefix `c40465b7`; not landed | r1 RED (PKCE flake, isolated 10/10); r2 RED (Ollama RPC timeout flake, isolated 27/27); r3 running, no verdict |
| #46 | Release attestation provenance | ae065c71c2bce1755a62abcb15b8ae3f7a54eddb | Operator-reported DYNAMIC-READY | Full-suite gate required at land time |
| #47 | Windows ARM64 release verification | 8dcaed5f6b9d35192ad460c7dc301f57c005389b | Operator-reported DYNAMIC-READY | Full-suite gate required at land time |
| #49 | Local data migration and rollback | 817a42547f4b51601821e322c937239f581464ad | Operator-reported DYNAMIC-READY | Full-suite gate required at land time |
| #50 | Crash consistency fault injection | a665caf162316a046f07b53634a0b2dc9461c6ab | Operator-reported DYNAMIC-READY | Full-suite gate required at land time |

The historical 71/71 /tmp-copy result is superseded. PR #45 is undergoing full-suite gate r3 after two RED attempts: r1 PKCE flake (isolated 10/10 retest) and r2 Ollama RPC timeout flake (isolated 27/27 retest); neither RED full-suite verdict is erased by its isolated retest. r3 has no verdict yet. The remaining land queue is #46 → #47 → #49 → #50 → #60 → #61 → #63 → #64 → #65 → #66; operator reports these as DYNAMIC-READY, but each requires its own full-suite gate at land time. #63–#66 are operator-reported DYNAMIC-READY (21/21, 20/20, 16/16, 21/21 respectively), not full-suite gates.

### 4.5 Dynamic-ready queue and subsequent evidence slices — Draft/HOLD

| Slice / PR | Scope | Current GitHub head SHA | Evidence boundary |
|---|---|---|---|
| #60 | Provider and integration acceptance | 9c922cf3df3f68d13024bf8f7c750fe4e780d411 | Operator-reported DYNAMIC-READY; full-suite gate required at land time; Draft/HOLD |
| #61 | Runtime stability and shutdown | b8ddfe80be8b39606ea6e73ea96ccde487bf3bba | Operator-reported DYNAMIC-READY; full-suite gate required at land time; Draft/HOLD |
| 1/5 #63 | Release candidate preparation | 4bc52e659253bff681e10afc40c4e636995bdcda | Operator-reported DYNAMIC-READY 21/21; full-suite gate required at land time; Draft/HOLD |
| 2/5 #64 | Candidate evidence checklist | e4626e8d6262ff531854322278c72221a7b1c0bc | Operator-reported DYNAMIC-READY 20/20; full-suite gate required at land time; Draft/HOLD |
| 3/5 #65 | CI unblock and verification | c2560e110254665008bb965befd76f4f19cc00c3 | Operator-reported DYNAMIC-READY 16/16; full-suite gate required at land time; Draft/HOLD |
| 4/5 #66 | Native acceptance evidence | ef7c85399b2b73dba8f5044b6817c06a2e98b6d7 | Operator-reported DYNAMIC-READY 21/21; full-suite gate required at land time; Draft/HOLD |
| Snapshot #67 | Snapshot reconciliation | `82df4ee39d5a4b79ee59612920d57ed639ad5230` | Draft/HOLD; static review PASS per operator, guard execution and exact-head CI pending |\n| Immutable RC #68 | Immutable release candidate freeze register | `68ca757fe4d75bdbd6e99ae6402d8d1477ae769a` | New Draft/HOLD slice; static source comparison 70/70; CI queued |\n| GO dossier #62 | Final go-live acceptance dossier | Current head recorded in PR metadata | Existing PR updated in place; 29 documentation-guard groups / 157 assertions; CI queued; Draft/HOLD |

Static-review and DYNAMIC-READY counts are attributed to their respective operator reports or source-only audit. None of these statements represents a successful CI run or assistant-executed test. No slice is LAND-READY solely because its documentation guard is static PASS.

### 4.6 Live GitHub queue summary

The live GitHub `GET /pulls?state=open&per_page=100` response contained exactly 25 open PRs, and every returned PR was Draft. The open numbers were: #38, #39, #40, #44, #45, #46, #47, #49, #50, #53, #54, #55, #56, #57, #58, #59, #60, #61, #62, #63, #64, #65, #66, #67 and #68. #41 and #42/#43/#48/#51/#52 were separately read back as closed with `merged=false`.

PR #62 live metadata at the start of this cycle: Open, Draft, unmerged; base main at `798d69ce226f12377131e2d7b37f3c7f45e89f5a`; head `893af7bb5c9f825c71373cb94481a41a40599bbd`.

PR #62 head at the start of this update: `893af7bb5c9f825c71373cb94481a41a40599bbd`. This is the exact prior self-head and is asserted by the documentation guard. The final head created by this update must be read back from live GitHub metadata and its checks inspected on that exact SHA.

PR #62 final head at update 7 is `ef6fd1da3a2875399b8625be3a638ad940a42457`; the preceding source commit `5f3d716a363234c97569b521f92ef88889d663cf` has two queued workflow runs (pull_request `46119649057`; push `46119646487`), and both runs report that exact preceding source SHA. Queued runs are NOT PASS. PR #67 exact head `82df4ee39d5a4b79ee59612920d57ed639ad5230`: 12 check runs queued and workflow runs 46103365218 / 46103361000 queued. PR #68 exact head `68ca757fe4d75bdbd6e99ae6402d8d1477ae769a`: 12 check runs queued and workflow runs 46119317681 / 46119290954 queued. Queued, missing or pending checks are NOT PASS.

## 5. Final candidate evidence gates

Every required row must refer to one and the same immutable full candidate SHA. A new commit invalidates downstream evidence unless each affected gate is rerun or formally reconciled.

| Gate | Required evidence | HOLD condition | GO condition |
|---|---|---|---|
| Source lineage | Clean tree, full local source SHA, full GitHub snapshot/candidate SHA, PR-to-commit mapping | Local-only or stale source; mismatched candidate identity | Remote candidate exactly matches the reviewed source lineage |
| Dependency/security | Dependency audit, vulnerability disposition, secret scan and security review | Untriaged critical/high finding or unexplained exception | Findings fixed or explicitly accepted by release owner with rationale/expiry |
| Version/build metadata | Version sync/check, release metadata and package identity | Drift or mismatch | All metadata consistent on candidate SHA |
| Build/typecheck/tests | npm ci, version sync/check, build, typecheck, full suite and exact CI jobs | Any failure, unknown job, stale SHA or unexplained skip | Required jobs green on exact candidate; every skip classified |
| CI evidence | Workflow run IDs, job IDs, URLs, full head SHA, conclusion and timestamps | Queued, pending, cancelled, missing, stale or failed job | Every required job completed successfully on exact candidate |
| Artifact integrity | Filename, byte size, SHA-256, source URL and downloaded-byte comparison | Missing asset, mismatch or unverified download | Every published artifact matches approved bytes and hash |
| Signing/provenance | Linux signing, Windows Authenticode, macOS notarization/Gatekeeper and attestation as applicable | Unsigned/untrusted artifact or provenance mismatch | Native tools validate the exact release artifacts |
| Native install/upgrade | Clean install, first run, upgrade, data preservation and rollback by OS/architecture | Failure, data loss, missing platform evidence | All required platform scenarios PASS with retained evidence |
| Provider/integration | Required provider matrix, CLI detection, approval boundaries and harmless live requests; external writes require explicit authorization | Mock-only evidence presented as live or unauthorized write | Required live paths PASS; optional paths explicitly scoped |
| Runtime/lifecycle | Idle and controlled-activity soak, window-close vs quit, process tree, listeners and resource observations | Crash, hang, orphan process, listener leak or unexplained growth | Required OS/build scenarios PASS with observed cleanup |
| Security operations | Disclosure, credential compromise, emergency patch, rollback and diagnostics procedures | Unowned escalation or unsafe secret/log handling | Owners, approvals and evidence handling reviewed |
| Governance | Independent reviewer, release owner, rollback authority and dated decision | Missing reviewer/owner or unresolved exception | Release owner approves the exact candidate and evidence packet |

### Required repository commands

On the exact candidate checkout, follow the repository's OS-specific test setup:

- npm ci
- npm run version:sync
- npm run version:check
- npm run build
- npm run typecheck
- Linux full suite: xvfb-run -a npm test
- Windows/macOS full suite: npm test

A configured CI matrix is not a passing result. Record each required job URL, run ID, job ID, conclusion and full SHA. Native signing, notarization, Gatekeeper, Authenticode, ARM64, installation and runtime acceptance cannot be inferred from a Linux unit-test result.

## 6. Immutable evidence packet and exception register

For every executed check, record:

- Gate and scenario.
- Result: PASS / FAIL / BLOCKED / NOT RUN / NOT APPLICABLE.
- Full candidate commit SHA and source/snapshot relationship.
- Artifact filename, package format, byte size, source URL and SHA-256.
- OS name, edition/distribution, exact version/build and architecture.
- Exact command or manual procedure and exit code/raw result.
- CI workflow run ID, job ID, URL, conclusion and full head SHA, where applicable.
- Start/end timestamp with timezone.
- Operator, independent reviewer and evidence location.
- Every skipped test, reason, risk, owner and disposition.
- Every failure, retry, deviation and exception; preserve original failure evidence.
- Compensating control, follow-up PR/issue, owner and closure criteria.
- Rollback/forward-fix procedure, rehearsal evidence and person authorized to execute it.

An exception is not a PASS. No failure may be deleted or overwritten by a later successful retry. A retry must retain both results and document why the final disposition is acceptable. Never put API keys, OAuth tokens, signing secrets, raw Vault contents, personal data or unredacted sensitive logs in the dossier.

## 7. Independent review and GO/HOLD decision record

The release owner must complete this record only after reviewing the immutable evidence packet:

- Decision: HOLD or GO.
- Decision date/time and timezone.
- Exact full candidate source SHA.
- Exact full GitHub candidate/snapshot SHA, if distinct.
- Release version and artifact manifest reference.
- Independent reviewer identity, role, review date and approval reference.
- Required CI/build/test evidence index and all skip dispositions.
- Windows, macOS and Linux platform packet references and reviewer sign-offs.
- Security, dependency, provenance and signing disposition.
- Complete exception register and residual-risk acceptance, if any.
- Rollback and forward-fix readiness evidence and authorized operator.
- Release owner identity and explicit approval statement.

Only the accountable release owner may record GO. A PR approval, static review, green test suite, successful build, snapshot push or assistant-generated dossier update is not a GO decision. If any required item is missing, stale, mismatched, failed, blocked or unexplained, record HOLD.

## 8. Ordered GO blockers — all must be closed before a GO decision

1. **Preserve #59 gate history and complete PR-record reconciliation for the eleven snapshot-integrated landings.** #59 is represented in the successful remote snapshot. r1 = 13,104 pass + 1 fail + 0 cancelled + 4 skipped = 13,109 total; the sole failure was the CLI `--help` timeout. Its isolated 7/7 retest is supplemental only. r2 ended by coordinator timeout (NO VERDICT); r3 was interrupted by VM restart (NO VERDICT); r4 = 13,105 pass / 0 fail / 4 skipped = 13,109 total (operator-reported GREEN). Preserve the initial r1 failure. #38/#39/#40/#44/#53–#58 are also represented in the pushed snapshot. All eleven corresponding PR records remain Open/Draft and require separately authorized closure with merged=false.
2. **Finish the remaining PR queue and reconcile dependencies.** Read current head/base and dependency for every PR before landing. Keep #60–#66 Draft/HOLD until their evidence prerequisites are met. Do not equate static PASS with LAND-READY. After each source change, rerun affected checks on the resulting head.
3. **Reconcile local and remote source lineage.** Reconfirm clean local tree, full local SHA, tracked file count and line count on final local main. The snapshot push is complete at remote main 05f38bae...; finish independent full tree/path/blob reconciliation. Reconcile/close locally landed PR records only after their contents are confirmed in the pushed snapshot and separate closure authorization is granted. The current local metrics remain operator-reported, not GitHub-verified.
4. **Produce one immutable final candidate.** Record exact full local and remote candidate SHAs, clean tree, version metadata, PR-to-commit mapping and artifact lineage. Any later source change invalidates affected downstream evidence and requires rerun/reconciliation.
5. **Complete exact-SHA CI/build/typecheck/test gates.** Run npm ci, version:sync, version:check, build, typecheck and the full required test suite/matrix on that exact candidate. Capture workflow run IDs, job IDs, URLs, conclusions, timestamps, full SHA and skip dispositions. Queued, pending, cancelled, stale or partial runs are not PASS.
6. **Complete artifact, signing, provenance and native platform acceptance.** Record artifact names, sizes, SHA-256 and uploaded/downloaded byte comparison; verify Linux signing, Windows Authenticode, macOS signing/notarization/Gatekeeper and provenance/attestation. Complete required native clean-install, first-run, upgrade, provider, runtime and lifecycle checks per OS/architecture.
7. **Complete operational/security acceptance and independent review.** Close security, credential compromise, incident response, migration, crash consistency, backup/restore, runtime stability, rollback/forward-fix and provider acceptance. Preserve all failures, skips and exceptions with owners/dispositions; obtain independent reviewer sign-off and name rollback authority.
8. **Obtain explicit release-owner GO/HOLD decision.** Only after blockers 1–7 are evidenced may the accountable release owner record a dated decision naming the exact full candidate SHA and artifact manifest. No production publication before explicit GO; otherwise remain HOLD.

Current state against these blockers: (1) the eleven earlier landings are represented in remote snapshot `05f38bae...`; their PR records remain open pending authorized closure; #45 remains unlanded with r1/r2 RED and r3 running; (2) the remaining queue is #46/#47/#49/#50/#60/#61/#63–#66 and each requires its own land-time full-suite gate; (3) current local main `c40465b7` is three commits ahead of remote for #45; (4) no immutable candidate; (5) PR #62 final head CI is queued, not passed; (6) artifact/native evidence incomplete; (7) operational/security acceptance and independent sign-off incomplete; (8) no release-owner GO record exists.

## 8.1 Work explicitly deferred until AFTER GO

The separate phase Production Rollout & Post-Go-Live Operational Assurance remains deferred. Its six slices are: (1) controlled production rollout, (2) production observability, (3) incident-response drill, (4) backup/restore and disaster recovery rehearsal, (5) performance and long-running reliability/soak, and (6) patch, rollback and operational closure. Do not create or land PRs for this phase before the release owner has explicitly authorized GO.

## 9. Current disposition

**HOLD remains in force.** GitHub main is `05f38baeab3af91d6db30f14f2026d93dfa6e9ab`, the successfully pushed snapshot of local `bf89e113` at approximately 10:01 +07 (operator sync record: 109 entries). Current local main is `c40465b7`, clean, 3,988 tracked files, three commits ahead of remote for PR #45; full local SHA and current line count were not supplied. The eleven earlier PR landing contents (#38, #39, #40, #44, #53–#59) are represented in the snapshot, but all eleven PR records remain Open/Draft/unmerged pending separately authorized closure. PR #45 remains Open/Draft/unmerged and is not in the snapshot: r1 RED 13,134 / 13,130 pass / 1 fail / 3 skipped (PKCE flake; isolated retest 10/10); r2 RED 13,134 / 13,130 pass / 1 fail / 3 skipped (Ollama RPC timeout flake; isolated retest 27/27); r3 currently running with no verdict. Remaining land queue: #46 → #47 → #49 → #50 → #60 → #61 → #63 → #64 → #65 → #66, operator-reported DYNAMIC-READY but each requires its own full-suite gate at land time. PR #62 final head at update 7 is `ef6fd1da3a2875399b8625be3a638ad940a42457`; the two workflow run IDs for preceding source commit `5f3d716a363234c97569b521f92ef88889d663cf` are pull_request `46119649057` and push `46119646487`, both queued and not a completed verdict. PR #67 head `82df4ee39d5a4b79ee59612920d57ed639ad5230` each have 12 queued checks and two queued workflow runs; neither has a completed CI verdict. No immutable candidate, signing/notarization, native acceptance, operational/security sign-off or release-owner GO exists.


The eight GO blockers in Section 8 remain open. The Production Rollout & Post-Go-Live Operational Assurance phase remains explicitly deferred until after GO; no PR for that phase is created or requested here.


This author used GitHub-only source authoring and did not run tests, build, typecheck, CI, native installation, provider requests, soak, signing, notarization or production release checks. This dossier records no production GO.

