# Exact-SHA CI — Execution and Evidence Contract

Snapshot context: 2026-11-28 16:01 +07
Repository: openbot1/open-bot
Phase: Release Candidate & Go-Live Evidence — Exact-SHA CI
Decision: **HOLD — no immutable candidate SHA is currently authorized for CI acceptance**

## 1. Purpose and boundary

This slice defines how the required build, typecheck, full-suite and release-metadata checks must be executed and recorded against one immutable release candidate. It is an execution contract and evidence schema, not a CI PASS, a candidate freeze, a build, or release authorization.

The predecessor is the Immutable Release Candidate freeze register (PR #68). Exact-SHA CI may begin only after its freeze prerequisites are satisfied, the release owner has authorized one immutable candidate, and the exact full source SHA plus manifest SHA-256 have been read back. A branch name, PR head, short SHA, mutable tag, or the current remote main snapshot is not a substitute.

This PR is deliberately based on remote main `05f38baeab3af91d6db30f14f2026d93dfa6e9ab`. That commit is a historical snapshot, not an authorized release candidate. No CI dispatch or release workflow is triggered by this documentation PR.

## 2. Entry criteria — all mandatory

Before any Exact-SHA CI run:

1. Complete the remaining source landing queue and all required per-landing full-suite gates.
2. Complete local-to-remote source reconciliation; local main and GitHub main must match by full 40-character commit SHA and full Git tree SHA.
3. Confirm the source checkout is clean and contains no untracked build or release inputs.
4. Complete version synchronization and version checks on the final source.
5. Create the canonical candidate manifest from that exact source; record its SHA-256 and all build-input blob hashes.
6. Obtain independent review of source identity, manifest and release inputs.
7. Obtain explicit release-owner authorization naming the exact candidate source SHA and manifest SHA-256.
8. Read back the immutable candidate ref/tag and verify it resolves to the same full source SHA.

If any entry criterion is missing, stale, mismatched, failed or unapproved, record BLOCKED and do not dispatch the gate.

## 3. Exact source binding

Create one run record before dispatch. Every workflow and job in the gate must bind to the same full candidate SHA.

Required immutable identity:

| Field | Required value |
|---|---|
| Repository | `openbot1/open-bot` |
| Candidate ref | Exact immutable ref/tag; never a branch tip |
| Candidate source SHA | Full 40-character commit SHA |
| Candidate tree SHA | Full Git tree SHA |
| Candidate version | Read from version metadata at the candidate SHA |
| Manifest path and SHA-256 | Exact path and digest |
| Dependency lockfiles | Paths and SHA-256/blob identities |
| Workflow definition | Workflow path and blob SHA from the candidate |
| Dispatch input | Full candidate SHA, not a symbolic ref |
| Authorization | Release-owner identity, timestamp and approval reference |

The workflow must check out the supplied full SHA explicitly and fail closed if the checked-out `git rev-parse HEAD` differs. It must also verify the expected tree SHA and manifest digest before running build or tests. Never silently fall back to `main`, a PR merge ref, a branch name or a newer commit.

A rerun is a new execution attempt, not a replacement of history. Preserve every prior conclusion and explain retries, cancellations, runner failures and deviations.

## 4. Required CI matrix

Run the repository's required release checks on the exact candidate. Record each job independently.

| Gate | Required operation | PASS criterion |
|---|---|---|
| Checkout identity | Checkout exact full SHA; verify HEAD and tree SHA | Both exactly match the approved candidate identity |
| Dependency install | `npm ci` | Exit code 0; lockfile identity matches manifest |
| Version sync | `npm run version:sync` | Exit code 0 and no uncommitted change |
| Version check | `npm run version:check` | Exit code 0 |
| Build | `npm run build` | Exit code 0; outputs retained and attributable to candidate |
| Typecheck | `npm run typecheck` | Exit code 0 |
| Linux full suite | `xvfb-run -a npm test` | Exit code 0; all skips and retries classified |
| Windows full suite | `npm test` | Exit code 0; all skips and retries classified |
| macOS full suite | `npm test` | Exit code 0; all skips and retries classified |

The platform matrix must reflect the repository's supported release targets and required architectures. If an OS/architecture is not run, it is NOT RUN or explicitly approved NOT APPLICABLE by the release owner; it is never implicitly PASS.

A configured workflow, a green aggregate badge, a successful job on another SHA, a local-only run, or a partial test selection does not satisfy this gate.

## 5. Per-job evidence record

For every workflow run and job, retain:

- Candidate full source SHA and full tree SHA.
- Candidate ref and manifest path plus SHA-256.
- Workflow file path and blob SHA.
- Workflow run ID, job ID, run URL and job URL.
- Trigger event and exact dispatch inputs.
- Repository, runner OS/image, architecture and toolchain versions.
- Exact command, start/end timestamp with timezone, exit code and final conclusion.
- Test totals: discovered, passed, failed, cancelled and skipped; include the raw summary and classify every skip.
- Artifact/log references and retention location; redact credentials and personal data.
- Retry/attempt number and links to every earlier attempt.
- Operator, independent reviewer and approval reference.
- Deviations, failure analysis, owner, corrective PR/commit and rerun linkage.

Use only these result values: PASS, FAIL, BLOCKED, NOT RUN, NOT APPLICABLE. A job without a completed conclusion is PENDING, not PASS. Preserve original failures even when a later retry passes.

## 6. Aggregate decision

Exact-SHA CI is PASS only when:

1. Every mandatory job completed successfully on the same approved full candidate SHA.
2. Every job's checkout identity and tree identity match the approved manifest.
3. Required build, version, typecheck and OS test matrix is complete.
4. Every skipped, cancelled, retried or unavailable test/job has a documented disposition accepted by the release owner.
5. No unexplained warning, failure, artifact mismatch, stale run or missing evidence remains.
6. An independent reviewer signs off the complete evidence packet.

Otherwise the aggregate is FAIL or BLOCKED and the release gate remains HOLD. A successful retry does not erase an earlier failure; record both and obtain explicit disposition.

## 7. Downstream handoff

Only after Exact-SHA CI is accepted may the release coordinator proceed to Drift-26 adjudication. The next slices remain ordered:

1. Drift-26 adjudication.
2. Signing and notarization.
3. Native acceptance.
4. Operational/security sign-off.
5. Release-owner GO/HOLD decision.

Every downstream artifact and attestation must identify the same candidate source SHA and the exact build artifact hashes. A source, dependency, workflow, packaging or manifest change creates a new candidate identity and invalidates affected downstream evidence.

## 8. Current disposition

**HOLD — EXACT-SHA CI NOT STARTED; NO APPROVED CANDIDATE EXISTS IN THIS SLICE.**

The operator reports local main `5ee33a1c`; PR #45 and #46 have landed locally, and #47 is present on local main but its gate r2 is still running. The remote GitHub main remains `05f38baeab3af91d6db30f14f2026d93dfa6e9ab`, a prior snapshot. These local operator-reported changes have not been treated as a frozen candidate by this PR.

No final full source SHA/tree SHA, candidate tag, canonical manifest digest, release-owner freeze authorization, or exact-candidate CI run is asserted here. Do not dispatch Exact-SHA CI against `05f38bae`, `5ee33a1c`, a PR head, or any other convenient SHA. Wait for the immutable candidate procedure in PR #68 to complete and authorize one exact SHA.

## 9. Authoring and verification boundary

This slice is authored through GitHub source APIs on a branch created from remote main `05f38baeab3af91d6db30f14f2026d93dfa6e9ab`. The author did not access the operator's local filesystem, dispatch CI, execute tests, install dependencies, build, typecheck, sign, notarize or perform native acceptance. The documentation guard is a source-level regression guard and has not been executed by this author. Static source inspection is not CI execution or release acceptance.
