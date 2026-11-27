# Final Go-Live Acceptance Dossier

Snapshot time: 2026-11-27 12:10 +07 (GitHub main and PR metadata read back during this cycle)
Repository: openbot1/open-bot
Phase: Release Candidate & Go-Live Evidence — Slice 5/5: GO Decision & Dossier Update
Purpose: consolidate exact-candidate evidence and record an explicit release-owner HOLD/GO decision. This dossier is an evidence register, not an automatic approval.

## 1. Executive decision

**CURRENT DECISION: HOLD — NOT AUTHORIZED FOR PRODUCTION GO-LIVE.**

The operator reports local main at full source SHA 8dc29d6714b047b4fb304ea1e98eede260481925, clean, with 3,963 tracked files and 1,527,941 lines. The operator reports the full suite on that exact local SHA as 12,914 pass / 0 fail / 3 skipped, using xvfb-run -a npm test at approximately 2026-11-26 21:06 +07. These local tree counts and test results are operator-reported; this author did not run or independently reproduce them.

GitHub main was read back during this cycle at full snapshot commit SHA 798d69ce226f12377131e2d7b37f3c7f45e89f5a, commit message: snapshot: local main 8dc29d67 (PRs #42, #43, #48, #51, #52). The local source HEAD and GitHub snapshot commit are different commit identities. The snapshot commit is the remote representation of the reported local source snapshot; do not substitute one SHA for the other in evidence records.

The operator reports local and remote source contents are synchronized and that the snapshot includes local landings #42, #43, #48, #51 and #52. GitHub PR metadata read during this cycle still showed those five PRs open and Draft; their closure/reconciliation was not yet reflected in the listing. They are classified below as SNAPSHOT-INTEGRATED / PR-CLOSURE-PENDING, not as GitHub-merged PRs.

GitHub listed 28 open PRs at read-back, all Draft. Five are snapshot-integrated with PR closure pending; 23 other PRs remain PENDING-LAND. PR #62 is this dossier's existing PR and is intentionally kept Draft. No PR #67 was present in the open-PR listing at read-back; the maximum listed PR number was #66. The release gate remains HOLD.

## 2. Evidence vocabulary and decision rules

Use these states consistently:

- **SNAPSHOT-INTEGRATED** — the operator reports the PR content is included in local source SHA 8dc29d67 and GitHub main now points to the snapshot commit 798d69ce. This does not mean the individual PR was merged through GitHub.
- **PR-CLOSURE-PENDING** — the snapshot-integrated PR still appears open on GitHub and requires coordinator reconciliation/closure.
- **PENDING-LAND** — the PR remains open and Draft on GitHub and is not yet included in the verified snapshot.
- **PASS** — the check was actually executed on the exact recorded candidate/artifact and met its observable criterion.
- **FAIL** — an executed check did not meet its criterion.
- **BLOCKED** — a prerequisite, authorization, service or safe environment prevented execution.
- **NOT RUN** — no execution evidence was collected.
- **NOT APPLICABLE** — the release owner explicitly records why a gate does not apply to this release.

Never convert a plan, static source inspection, documentation guard, CI configuration, queued job, draft PR, mock, screenshot or operator intention into PASS. Evidence must identify the full candidate SHA, artifact filename and SHA-256, OS/build/architecture, exact command or manual procedure, timestamp/timezone, operator, raw result, reviewer and retained sanitized evidence.

### Overall GO rule

GO may be recorded only by the accountable release owner, with a dated decision naming one exact candidate SHA, after every required gate is PASS or explicitly approved NOT APPLICABLE, all skips and exceptions have documented disposition, all required native platform packets are independently reviewed, rollback/forward-fix readiness is evidenced, and the published artifacts match their approved hashes. Any FAIL, BLOCKED, NOT RUN, unexplained skip, stale/mismatched SHA, missing reviewer, unsigned/unverified artifact or unresolved exception means HOLD.

## 3. Repository and snapshot identity

| Item | Read-back / reported evidence | State | Decision rule |
|---|---|---|---|
| Local source HEAD | Operator reports 8dc29d6714b047b4fb304ea1e98eede260481925, clean | OPERATOR-REPORTED | Do not present local cleanliness or counts as independently verified by this author |
| GitHub main snapshot | 798d69ce226f12377131e2d7b37f3c7f45e89f5a; snapshot: local main 8dc29d67 (PRs #42, #43, #48, #51, #52) | GITHUB-READ-BACK | This is the remote snapshot commit SHA; use it when identifying the GitHub main snapshot |
| Source/snapshot relationship | Local source SHA 8dc29d6714b047b4fb304ea1e98eede260481925; remote snapshot SHA 798d69ce226f12377131e2d7b37f3c7f45e89f5a | DISTINCT IDENTITIES | Record both values and their roles; never shorten or conflate them in final evidence |
| Local tree size | Operator reports 3,963 tracked files and 1,527,941 lines | OPERATOR-REPORTED | Not independently counted from GitHub |
| Full automated suite | Operator reports 12,914 pass / 0 fail / 3 skipped on local source SHA 8dc29d6714b047b4fb304ea1e98eede260481925 | OPERATOR-REPORTED | Not an executed result from this author; rerun on the final candidate and classify all three skips |
| Snapshot contents | Operator reports 8 snapshot files and spot-checks dependency-vulnerability runbook against local | OPERATOR-REPORTED / PARTIAL SPOT-CHECK | Do not infer every file or every test from one spot-check |
| Open PR queue | GitHub read-back: 28 open PRs, all Draft | GITHUB-READ-BACK | Five snapshot-integrated PRs still appeared open; reconcile before treating queue as 23 |
| Release decision | No complete final candidate evidence packet or release-owner approval recorded here | HOLD | No production GO authorized |

The remote snapshot commit SHA is not the same as the local source HEAD SHA. CI, build, tests and artifacts must each state the actual commit SHA they used. A snapshot commit message mentioning the local short SHA is not a substitute for a full SHA recorded by the workflow.

## 4. PR evidence register

All head SHAs below were read from GitHub PR metadata during this cycle. The table records the head SHA observed at that time; re-read it before any landing or closure action.

### 4.1 Snapshot-integrated PRs — closure still pending

| PR | Scope | GitHub head SHA | Current disposition |
|---|---|---|---|
| #42 | Version sync CLI regression tests | 311160c63b34d4d710c80350f950702bbdae1cf0 | SNAPSHOT-INTEGRATED / PR-CLOSURE-PENDING |
| #43 | Updater live smoke checklist | 2ab5e0869cb5a7a4d176de52c205ff4065bedaf6 | SNAPSHOT-INTEGRATED / PR-CLOSURE-PENDING |
| #48 | Local data backup/restore runbook | 36a8cb7ee307d33665ff9e0f2cbc53e18f58682e | SNAPSHOT-INTEGRATED / PR-CLOSURE-PENDING |
| #51 | Incident diagnostics log privacy | 7e8b5d6ee888253c2eb66158ef2b6701083ae503 | SNAPSHOT-INTEGRATED / PR-CLOSURE-PENDING |
| #52 | Dependency vulnerability operations | d95a2c9f545ddc4e3fe7633957039edbd95ea206 | SNAPSHOT-INTEGRATED / PR-CLOSURE-PENDING |

These five PRs were still open/Draft in the GitHub listing read during this cycle. Their code being present in the snapshot does not itself change their individual GitHub PR state. The landing coordinator should verify the snapshot contents and close/reconcile each PR without merging duplicate changes.

### 4.2 PENDING-LAND — release engineering and platform artifacts

| PR | Scope | GitHub head SHA | HOLD condition |
|---|---|---|---|
| #38 | Release asset byte reconciliation | e65bda54f599fb48dc16b9d5ba3fd486389b0488 | Verify exact uploaded/downloaded bytes and hashes |
| #39 | Manual native release workflow | 6ba8de831c6b4a21267e243e9aabb40c73e7bc0f | Verify workflow permissions, artifact paths and manual safeguards |
| #40 | Linux AppImage cosign | be6cd6457c67b45302ae71e3cb125adc651fc114 | Verify actual signer identity, provenance and artifact signature |
| #44 | Windows Authenticode verification | eb5a9f3bafc8c81d60949c0a064ffd49a266f9c9 | Verify signature chain, publisher and timestamp on actual installer |
| #45 | macOS notarization and Gatekeeper | 73c0bfa024f7f9c2d317a44e2c061c194d65dc55 | Verify notarization ticket, stapling and Gatekeeper on actual artifact |
| #46 | Release attestation provenance | ae065c71c2bce1755a62abcb15b8ae3f7a54eddb | Match attestation subject, signer and source to exact artifact/SHA |
| #47 | Windows ARM64 release verification | 8dcaed5f6b9d35192ad460c7dc301f57c005389b | Execute native Windows ARM64 install, launch and update checks |
| #49 | Local data migration and rollback | 817a42547f4b51601821e322c937239f581464ad | Rehearse migration/rollback on disposable copies without data loss |
| #50 | Crash consistency fault injection | a665caf162316a046f07b53634a0b2dc9461c6ab | Execute safe crash/fault scenarios and recovery integrity checks |

### 4.3 PENDING-LAND — security, operations and lifecycle

| PR | Scope | GitHub head SHA | HOLD condition |
|---|---|---|---|
| #53 | Security intake and coordinated disclosure | 8a1239e2bc114ed42843b921def8f9f4e772326f | Verify intake/escalation ownership and safe disclosure handling |
| #54 | Credential compromise response | 064bf8c11510d0183a3a8c2c30c7b457d5e2a5c7 | Review rotation, revocation and escalation readiness |
| #55 | Emergency security patch lane | 2cf14e2baeee4475db3efebde444a5aaf3ac6ec4 | Rehearse emergency patch path and approvals |
| #56 | Release rollback and forward-fix | 35cdce02aadb733eee13ff915893e070a44e397d | Rehearse rollback and forward-fix against disposable state |
| #57 | Cross-platform security boundaries | 2d14ddbfc288e60675632240caf37bb0fc9a1667 | Execute native Windows/macOS/Linux boundary checks |
| #58 | Clean install and first run | 4369feba884727818bffb1109101db096798f374 | Exercise clean install, first run, Vault and provider setup per OS |
| #59 | Upgrade and data preservation | 6e788fc4d91d1a94487bad0493f3c945e57eab39 | Verify upgrade, backup/restore, SQLite/workspace/Vault preservation |
| #60 | Provider and integration acceptance | 9c922cf3df3f68d13024bf8f7c750fe4e780d411 | Test required live providers with explicit consent and harmless targets |
| #61 | Runtime stability and shutdown | b8ddfe80be8b39606ea6e73ea96ccde487bf3bba | Execute soak, quit, child-process exit and listener cleanup per OS |

### 4.4 Release Candidate & Go-Live Evidence — slices 1–4

| Slice | PR | GitHub head SHA | Operator-reported static review | Disposition |
|---|---|---|---|---|
| 1/5 Release candidate preparation | #63 | 4bc52e659253bff681e10afc40c4e636995bdcda | PASS 21/21 | Draft / PENDING-LAND |
| 2/5 Candidate evidence checklist | #64 | e4626e8d6262ff531854322278c72221a7b1c0bc | PASS 20/20 | Draft / PENDING-LAND |
| 3/5 CI unblock and verification | #65 | c2560e110254665008bb965befd76f4f19cc00c3 | PASS 16/16 | Draft / PENDING-LAND |
| 4/5 Native acceptance evidence | #66 | ef7c85399b2b73dba8f5044b6817c06a2e98b6d7 | PASS 21/21; 102/102 literal matches reported | Draft / PENDING-LAND |

The static-review counts above are operator-reported verifier results. They are not test executions by this author and do not prove CI, build, typecheck, signing, notarization, native install, provider acceptance or runtime soak. Slice 5/5 is this dossier update; it also does not authorize GO.

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
| Provider/integration | Required provider matrix, CLI detection, approval boundaries and harmless live requests | Mock-only evidence presented as live or unauthorized write | Required live paths PASS; optional paths explicitly scoped |
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

## 8. Ordered closure plan

1. Reconcile the five snapshot-integrated PRs #42, #43, #48, #51 and #52. Confirm their content is in GitHub main, then close/reconcile their still-open Draft PR records without duplicating merges.
2. Re-read all 23 PENDING-LAND PR heads and base relationships. Resolve dependencies and verify exact PR head content before landing; do not bulk-merge by number.
3. Land and verify the security/operations/lifecycle work in dependency-safe order, including #53 through #61, rerunning relevant checks after each base change.
4. Resolve release engineering dependencies and verify #38, #39, #40, #44, #45, #46, #47, #49 and #50 with real artifact, signing, provenance, native and recovery evidence.
5. Land slices #63–#66 only after independent exact-head verification and the required CI/build/test evidence. A static-review PASS is not a dynamic release gate.
6. Create a new clean final candidate after all required changes land. Run build, typecheck, full tests and required CI on that exact candidate; classify every skip.
7. Produce the immutable artifact manifest, verify uploaded/downloaded bytes, signatures, provenance and all native platform packets on the same candidate lineage.
8. Complete the exception register, obtain independent reviewer sign-offs and rollback/forward-fix readiness evidence.
9. The release owner records a dated GO/HOLD decision naming the exact full candidate SHA. Publish only after explicit GO; otherwise retain HOLD.

## 9. Current disposition

**HOLD remains in force.** GitHub main is the snapshot commit 798d69ce226f12377131e2d7b37f3c7f45e89f5a representing the operator-reported local source 8dc29d6714b047b4fb304ea1e98eede260481925. The reported local full-suite result remains operator-reported and has not been rerun by this author on the remote snapshot or a final release candidate. GitHub showed 28 open Draft PRs at read-back; five snapshot-integrated PRs still awaited PR-record reconciliation and 23 other PRs remained PENDING-LAND. Slices 1–4 have operator-reported static review results, but no final candidate CI/build/native/artifact evidence packet or release-owner GO approval is established here.

This dossier records no production GO. This author used GitHub-only source authoring and did not run tests, build, typecheck, CI, native installation, provider requests, soak, signing, notarization or production release checks.
