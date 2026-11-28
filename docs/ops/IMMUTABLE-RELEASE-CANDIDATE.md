# Immutable Release Candidate — Freeze Register and Evidence Contract

Snapshot time: 2026-11-28 12:01 +07
Repository: openbot1/open-bot
Phase: Release Candidate & Go-Live Evidence — Immutable RC
Decision: **HOLD — no immutable release candidate has been created or authorized**

## 1. Purpose and boundary

This slice defines the evidence contract and freeze procedure for one immutable release candidate. It is a preparation register, not a candidate artifact, release tag, build, signing operation, or production authorization. Creating this document or its Draft PR does not freeze source and does not authorize publication.

The predecessor Snapshot Reconciliation slice is PR #67. Its documentation guard was statically reviewed, but its dynamic test and exact-head CI verdict are still pending. This Immutable RC slice remains Draft/HOLD until PR #67 is dynamically verified and its reconciliation evidence is accepted.

## 2. Current source state and freeze blockers

| Item | Current value | Evidence class | Freeze disposition |
|---|---|---|---|
| GitHub main | 05f38baeab3af91d6db30f14f2026d93dfa6e9ab | GITHUB-READ-BACK | Snapshot of local bf89e113 |
| Snapshot sync record | 109 entries | OPERATOR-REPORTED | Preserve sync record and independently verify its contents |
| Current local main | c40465b7 (short SHA supplied) | OPERATOR-REPORTED | Three commits ahead of remote for PR #45; not freeze-ready |
| Local tree | Clean; 3,988 tracked files | OPERATOR-REPORTED | Full current SHA and line count not supplied |
| PR #45 | Open / Draft / unmerged | GITHUB-READ-BACK | Not landed; r1 and r2 full-suite gates RED; r3 running |
| PR #45 r1 | 13,134 tests / 13,130 pass / 1 fail / 3 skipped | OPERATOR-REPORTED / FAIL | PKCE flake; isolated retest 10/10 does not erase full-suite FAIL |
| PR #45 r2 | 13,134 tests / 13,130 pass / 1 fail / 3 skipped | OPERATOR-REPORTED / FAIL | Ollama RPC timeout flake; isolated retest 27/27 does not erase full-suite FAIL |
| PR #45 r3 | Running; no verdict | OPERATOR-REPORTED / PENDING | Must finish with an accepted full-suite verdict before landing |
| Remaining land queue | #46 → #47 → #49 → #50 → #60 → #61 → #63 → #64 → #65 → #66 | OPERATOR-REPORTED DYNAMIC-READY | Each requires its own full-suite gate at land time |
| PR #62 | Open / Draft / HOLD | GITHUB-READ-BACK | Dossier only; no GO decision |
| PR #67 | Open / Draft / HOLD | GITHUB-READ-BACK | Snapshot reconciliation slice; dynamic guard/CI pending |

The remote snapshot includes the eleven earlier local landings (#38, #39, #40, #44 and #53–#59) according to the operator-reported 109-entry sync record. Their GitHub PR records remain open pending separate authorized closure. This is not equivalent to GitHub PR merges.

Do not create an immutable candidate from 05f38bae while local main is ahead by the PR #45 commits and the remaining land queue is incomplete. Do not infer the missing full local SHA from the short prefix c40465b7.

## 3. Candidate identity — mandatory fields

The candidate identity record must contain all of the following before a freeze can be declared:

| Field | Required value | Current disposition |
|---|---|---|
| Candidate version | Exact release version from repository version metadata | UNSET — must be read from final source |
| Candidate source commit | Full 40-character commit SHA | UNSET — current source is not final |
| Candidate Git tree | Full tree SHA | UNSET |
| GitHub main commit | Full 40-character SHA | Current read-back: 05f38baeab3af91d6db30f14f2026d93dfa6e9ab |
| Source branch/ref | Exact immutable ref or tag name | UNSET — do not create a tag in this slice |
| Source tree state | Clean working tree, no untracked release inputs | Current local clean state is operator-reported at non-final c40465b7 |
| Version metadata | package version, app version, lockstep metadata and release manifest | UNSET — must be captured from final source |
| Dependency lock | Exact lockfile paths and blob hashes | UNSET |
| Build toolchain | Node, package manager, OS image, compiler and signing-tool versions | UNSET |
| PR-to-commit map | Every included PR and exact landed commit/range | Incomplete until the land queue and snapshot reconciliation finish |
| Snapshot sync evidence | Push transaction and complete reconciliation record | 109-entry sync record reported; full reconciliation remains a prerequisite |
| Candidate manifest | Canonical machine-readable manifest and its SHA-256 | NOT CREATED |
| Reviewer | Independent reviewer and approval reference | UNSET |
| Freeze authority | Accountable release owner and dated explicit freeze approval | UNSET |

A short SHA, branch name, mutable tag, PR head, workflow run, commit message or version string alone is not an immutable candidate identity.

## 4. Freeze prerequisites — all mandatory

1. Finish PR #45 r3 and record the complete full-suite result. Preserve r1 and r2 RED outcomes and their isolated retests in the evidence history.
2. Land #45 only after its accepted full-suite gate and explicit operator decision. Record every cherry-picked commit and the resulting local full SHA.
3. Process the remaining land queue in order: #46, #47, #49, #50, #60, #61, #63, #64, #65, #66. Each PR gets its own full-suite gate at land time; no result transfers across heads.
4. Complete dynamic verification and exact-head CI for the preceding evidence slices #62 and #67. Queued or missing checks are not PASS.
5. Complete snapshot reconciliation after the final landings. Push only with explicit authorization; read back GitHub main and require exact full-SHA equality with the final local main.
6. Verify source tree identity and all path/blob/mode differences. Reconcile all included PR contents and close their PR records only with separate explicit authorization; do not merge them.
7. Capture final version metadata, dependency lockfile hashes, toolchain versions and release configuration from that exact source SHA.
8. Confirm the final tree is clean and no source or release-input changes occur after the freeze point.
9. Obtain independent review of the complete candidate identity and manifest.
10. Obtain explicit release-owner authorization naming the exact full source SHA and candidate manifest hash.

If any prerequisite is missing, failed, stale, blocked, or tied to a different SHA, the candidate remains NOT FROZEN and the release gate remains HOLD.

## 5. Canonical candidate manifest contract

The canonical manifest must be generated from the frozen source and must be immutable once approved. It must record:

- Repository identity and canonical source URL.
- Full source commit SHA and full Git tree SHA.
- Candidate version and all synchronized version metadata.
- Immutable source ref/tag, if one is created by an authorized freeze procedure.
- Complete PR-to-commit inclusion map.
- Every build input path with its Git blob SHA and file mode.
- Dependency lockfile paths and SHA-256 values.
- Build toolchain and environment versions.
- Build commands and configuration identifiers.
- Expected artifact names, target OS/architecture, packaging format and output locations.
- Manifest creation timestamp in UTC and local timezone.
- Manifest SHA-256, author/operator, independent reviewer and approval reference.

Do not put credentials, signing keys, tokens, private environment values or raw secret-bearing logs in the manifest. Reference protected secret identifiers only where required.

The manifest itself must be retained as a release evidence artifact. Recompute and compare its SHA-256 after every transfer; any byte difference invalidates the approved manifest and requires a new review.

## 6. Freeze procedure and mutation rules

1. Start from the final, reconciled GitHub main commit and verify its full SHA and tree SHA.
2. Verify the local checkout is exactly that commit, with a clean tree and no untracked release inputs.
3. Read version metadata and dependency lockfiles from the exact checkout; record their blob hashes.
4. Record the full PR-to-commit map and confirm each included change is present in the source tree.
5. Generate the canonical candidate manifest and compute its SHA-256.
6. Have an independent reviewer verify the source identity, tree, version metadata, lockfiles, PR map and manifest hash.
7. Obtain release-owner authorization naming both the full source SHA and manifest SHA-256.
8. Only then may the authorized operator create the immutable candidate ref or tag. Record the exact ref target and read it back from GitHub.
9. After freeze, prohibit source, dependency, version, workflow, packaging or manifest changes. Any change creates a new candidate identity and invalidates downstream evidence tied to the prior candidate.

This slice does not itself create a Git tag, release object, build artifact, signature, notarization ticket or candidate manifest.

## 7. Downstream gate binding

The next gate is Exact-SHA CI. It must run against the exact frozen candidate SHA, not a branch tip or a later commit. Record workflow run IDs, job IDs, URLs, event, conclusion, timestamps, runner OS, toolchain, command, logs and all skipped-test dispositions.

After Exact-SHA CI, proceed in order:

1. Drift-26 adjudication.
2. Signing and notarization.
3. Native acceptance.
4. Operational/security sign-off.
5. Release-owner GO.

Signing, notarization and native acceptance must bind to the artifact hashes produced from the frozen candidate. A rebuild from a different SHA or changed dependency/toolchain state is a different candidate.

## 8. Stop conditions

Keep the candidate NOT FROZEN and release gate HOLD if:

- PR #45 or any required land-queue item is not accepted and reconciled.
- PR #62 or #67 exact-head dynamic verification/CI remains queued, missing or failed.
- Local main and GitHub main differ, or their full SHA/tree identity cannot be reconciled.
- Any PR inclusion, source path, blob, file mode or lockfile hash is unexplained.
- The working tree is dirty or the full source SHA is unavailable.
- Version metadata is inconsistent or not read from the exact candidate source.
- The manifest is missing, mutable, unhashed or not independently reviewed.
- Freeze authority or release-owner approval is absent.
- Any source or release input changes after the proposed freeze.

A stop condition is a blocker, not permission to force-push, rewrite history, bypass a gate, suppress a failure or silently regenerate the manifest.

## 9. Current disposition and next action

**HOLD — NO IMMUTABLE RC EXISTS.** Remote main is 05f38baeab3af91d6db30f14f2026d93dfa6e9ab, snapshot of local bf89e113. Current local main prefix c40465b7 is three commits ahead for PR #45. PR #45 r1 and r2 full-suite gates are RED; r3 is running without a verdict. The remaining land queue is #46 → #47 → #49 → #50 → #60 → #61 → #63 → #64 → #65 → #66. PR #62 and #67 remain Draft/HOLD with exact-head CI queued. Candidate version, final source SHA, tree SHA, immutable ref, dependency hashes and manifest SHA-256 are not yet established.

The immediate next action is to finish #45 r3, land #45 only if its gate and owner decision permit, then process the ordered land queue with a full-suite gate at each landing. Do not freeze a candidate until all source and reconciliation prerequisites above are satisfied.

## 10. Authoring and verification boundary

This PR was authored through GitHub source APIs from remote main 05f38baeab3af91d6db30f14f2026d93dfa6e9ab. The author did not access the operator's local filesystem or the 109-entry sync artifact, execute tests, build, typecheck, CI, create a candidate tag, generate artifacts, sign, notarize, or perform native acceptance. Static guard source comparison is not test execution. All local state and gate results are attributed to the operator unless explicitly marked GITHUB-READ-BACK.
