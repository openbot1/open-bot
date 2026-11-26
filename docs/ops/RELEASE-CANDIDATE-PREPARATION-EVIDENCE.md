# Release Candidate Preparation & Evidence

Snapshot: 2026-11-27 04:05 +07 (GitHub metadata re-read during authoring; operator-reported local state is explicitly labeled)
Repository: `openbot1/open-bot`
Phase: Release Candidate & Go-Live Evidence — Slice 1/5
Decision: **HOLD — no release candidate is approved for production go-live.**

This runbook defines how to prepare one immutable release candidate and collect reproducible evidence. It is a procedure and evidence template, not a record that the listed commands or platform checks have already run successfully.

## 1. Current release disposition

### 1.1 Verified GitHub state

Immediately before branch creation, GitHub `main` was read as:

- Full SHA: `2d14cc1b73c3f9fecb4b92614c180fb15a404aec`
- Commit message: `snapshot: local main 4dbb0883 (PRs #31, #37, #36, #41)`

GitHub PR metadata was read back during this authoring cycle. PRs #38–#40 and #42–#62 are open Draft, except #41 which is closed. The 19 remaining landing candidates are #53–#62, #38–#40, #44–#47, #49 and #50. Their current head SHA prefixes and order are recorded in §3. No PR is treated as landed merely because it has a verifier report or a Draft review state.

### 1.2 Operator-reported local state — not independently verified here

The operator reports:

- Local `main`: `8dc29d67`, clean tree; 3,963 tracked files; 1,527,941 total tracked lines; 957,713 TypeScript lines.
- Full suite on exact local SHA `8dc29d67`: 12,914 pass / 0 fail / 3 skipped, at approximately 21:06 +07 on 2026-11-26, first run green.
- #42, #43, #48, #51 and #52 are landed locally on that snapshot and await the snapshot push and GitHub reconciliation.
- Snapshot delivery has been attempted three times (approximately 22:32, 22:37 and 22:42 +07 on 2026-11-26); all three approval cards timed out after service restarts (21:09, 21:31 and 23:34 +07). At 04:05 +07 on 2026-11-27 there was no active approval card. The operator reports an 8-file resumable push package and manifest are ready.
- The push is intentionally deferred until daytime when the owner can approve it. No push is authorized by this runbook or this PR.

These local details are included as operator-reported context only. They are not visible in the GitHub remote branch and have not been reproduced by this author. In particular, do not describe `8dc29d67` as the current public GitHub `main`.

### 1.3 Current HOLD decision

**HOLD.** The public default branch is behind the reported local snapshot; five local landings remain pending push/reconciliation; 19 PRs remain open Draft and pending landing; required candidate build/test/CI evidence and native acceptance evidence have not been established by this runbook. GitHub Actions status reported as Queued is not a pass and supplies no release signal.

Do not create or publish release artifacts, tag a production release, or announce GO based on this document.

## 2. Immutable candidate preparation

### 2.1 Establish the candidate source

1. Wait for the owner to approve the existing daytime snapshot push. Do not retry at night, create a duplicate approval request, or bypass the landing coordinator.
2. Have the authorized landing coordinator resume the existing 8-file manifest/package and push exactly once after approval.
3. Verify the remote default branch commit, full SHA, tree and expected contents. Reconcile the five local landings (#42, #43, #48, #51, #52) against GitHub only after the remote snapshot is confirmed.
4. Land the remaining PRs in the dependency-safe order in §3. Rebase/update each dependent PR as required; after every landing, record the resulting base and head identities and rerun the relevant checks on the updated exact head.
5. Once all required changes are landed, create a clean candidate checkout from the final pushed GitHub commit. Record the full 40-character commit SHA. Do not use a moving branch name as the sole candidate identity.
6. Confirm a clean working tree, expected remote and branch, exact source tree, version metadata, lockfile and release configuration. If any source changes after the recorded SHA, invalidate the candidate record and restart the candidate gates.

**Candidate identity record**

| Field | Required value |
|---|---|
| Repository | `openbot1/open-bot` |
| Candidate full commit SHA | 40-character immutable SHA |
| Git ref/tag | Exact ref and resolved SHA |
| Base/default branch SHA | Full SHA |
| Working tree | Clean; capture command output |
| Node.js / npm | Exact versions |
| OS / architecture | Exact OS build and architecture |
| Build type | Release configuration and channel |
| Operator / reviewer | Named responsible people |
| Preparation timestamp | ISO 8601 with timezone |

### 2.2 Install dependencies and synchronize metadata

Use the final candidate checkout, not a PR author's branch or an earlier local snapshot. Record command, start/end time, exit code and raw output for every step.

```bash
node --version
npm --version
npm ci
npm run version:sync
npm run version:check
```

The root version is the product version source of truth; workspace package metadata and lockfile mirrors must be synchronized. A version check failure, unexpected lockfile change, uncommitted generated file or unexplained version drift is HOLD. Do not silently commit generated changes into the candidate: review them, create a new candidate SHA if required, and restart all gates.

### 2.3 Build every workspace

The root `npm run build` script invokes all four workspace builds in this order: core → tools → desktop → CLI.

```bash
npm run build
```

For auditability, capture each workspace's result or use the equivalent explicit commands:

```bash
npm run build --workspace=@open-bot/core
npm run build --workspace=@open-bot/tools
npm run build --workspace=@open-bot/desktop
npm run build --workspace=@open-bot/cli
```

All four must complete successfully on the exact candidate SHA. Record each workspace, exit code, log location and artifact outputs. A partial build, stale output, cache-only assertion or success on another SHA is HOLD.

### 2.4 Typecheck every workspace

The root `npm run typecheck` invokes core → tools → desktop → CLI.

```bash
npm run typecheck
```

For explicit workspace evidence:

```bash
npm run typecheck --workspace=@open-bot/core
npm run typecheck --workspace=@open-bot/tools
npm run typecheck --workspace=@open-bot/desktop
npm run typecheck --workspace=@open-bot/cli
```

All four must exit successfully on the same candidate SHA used for build and tests. Record exact command, exit code and log. Any failure or missing workspace result is HOLD.

### 2.5 Run the full test suite

Root `npm test` invokes Node's test runner. Use the OS-specific full-suite command:

```bash
# Linux
xvfb-run -a npm test

# Windows / macOS
npm test
```

The release candidate requires **zero failed tests**. Preserve the original complete runner summary, including pass, fail and skipped counts. Explain every skipped test; new or unexplained skips are HOLD. A focused test, retry, test subset, prior commit result or aggregate from multiple commits does not replace a full-suite run on the exact candidate SHA.

Record OS build, architecture, Node/npm versions, exact SHA, command, start/end time, exit code, full summary and log/evidence URI. If any test fails, stop candidate promotion, diagnose, fix on a new commit, and rerun all candidate gates from the new SHA.

### 2.6 Verify GitHub Actions on the exact SHA

1. Open the GitHub Actions run/check suite associated with the exact candidate commit.
2. Record the workflow run ID, run URL, event, branch/ref, full commit SHA and attempt number.
3. Verify all required jobs and matrix legs, including Ubuntu, Windows and macOS build/test jobs and platform jobs, have completed successfully.
4. Confirm each job's tested SHA equals the candidate SHA. A queued, pending, cancelled, skipped, stale, missing or failed required job is not PASS.
5. If CI remains Queued or service infrastructure prevents completion, record BLOCKED with the run ID and reason. Do not infer success from workflow YAML, local tests, another PR's CI, or a green job on another SHA.

## 3. Remaining landing queue and order

The current order below is based on the operator's dependency plan and current GitHub PR metadata. All entries are **PENDING-LAND**. Head prefixes are GitHub-read-back identifiers; re-read the full SHA and diff immediately before each landing.

### 3.1 Operations, security and deployment lifecycle

| Order | PR | Scope | GitHub head SHA prefix | State / HOLD condition |
|---:|---:|---|---|---|
| 1 | #53 | Security intake and coordinated disclosure | `8a1239e2` | PENDING-LAND; hold until exact-head verification and authorized landing |
| 2 | #54 | Credential compromise response | `064bf8c1` | PENDING-LAND; hold until exact-head verification and authorized landing |
| 3 | #55 | Emergency security patch lane | `2cf14e2b` | PENDING-LAND; hold until exact-head verification and authorized landing |
| 4 | #56 | Release rollback and forward-fix rehearsal | `35cdce02` | PENDING-LAND; hold until exact-head verification and authorized landing |
| 5 | #57 | Cross-platform security boundary verification | `2d14ddbf` | PENDING-LAND; hold until exact-head verification and authorized landing |
| 6 | #58 | Clean install and first-run verification | `4369feba` | PENDING-LAND; hold until exact-head verification and authorized landing |
| 7 | #59 | Upgrade and data preservation verification | `6e788fc4` | PENDING-LAND; hold until exact-head verification and authorized landing |
| 8 | #60 | Provider and integration acceptance | `9c922cf3` | PENDING-LAND; hold until exact-head verification and authorized landing |
| 9 | #61 | Runtime stability and shutdown verification | `b8ddfe80` | PENDING-LAND; hold until exact-head verification and authorized landing |
| 10 | #62 | Final go-live acceptance dossier | `a8d15187` | PENDING-LAND; hold until exact-head verification and authorized landing |

### 3.2 Artifact workflow and release engineering

| Order | PR | Scope | GitHub head SHA prefix | State / HOLD condition |
|---:|---:|---|---|---|
| 11 | #38 | Exact uploaded artifact byte reconciliation | `e65bda54` | PENDING-LAND; hold until exact artifact bytes and hashes are verified |
| 12 | #39 | Protected manual native draft workflow | `6ba8de83` | PENDING-LAND; hold until workflow permissions, paths and protections are verified |

### 3.3 Platform signing, provenance and recovery

| Order | PR | Scope | GitHub head SHA prefix | State / HOLD condition |
|---:|---:|---|---|---|
| 13 | #40 | Keyless Linux AppImage signing | `be6cd645` | PENDING-LAND; hold until real artifact signature and provenance verification |
| 14 | #44 | Windows Authenticode verification | `eb5a9f3b` | PENDING-LAND; hold until native signature chain and timestamp checks |
| 15 | #45 | macOS notarization and Gatekeeper evidence | `73c0bfa0` | PENDING-LAND; hold until notarization ticket and native Gatekeeper assessment |
| 16 | #46 | Artifact attestation provenance verification | `ae065c71` | PENDING-LAND; hold until attestation subject and source provenance match |
| 17 | #47 | Windows ARM64 installer verification | `8dcaed5f` | PENDING-LAND; hold until native ARM64 install/launch/update checks |
| 18 | #49 | Local data migration and rollback procedure | `817a4254` | PENDING-LAND; hold until migration and rollback rehearsal protects user data |
| 19 | #50 | Crash consistency fault-injection runbook | `a665caf1` | PENDING-LAND; hold until recovery integrity scenarios are executed |

Operator-reported dynamic verification: #53–#62 and #38–#39 were tested on disposable `/tmp` copies at their exact heads; #40, #44–#47, #49 and #50 reportedly retained 71/71 checks after the fixpack. These are maintainer-reported verification results, not execution by this author and not evidence of landing. Re-verify exact current heads after base changes.

### 3.4 Push snapshot prerequisite

The five local landings #42, #43, #48, #51 and #52 are reported **LANDED-LOCAL / PENDING-PUSH** in local `8dc29d67`. The public GitHub `main` remains `2d14cc1b73c3f9fecb4b92614c180fb15a404aec`. The operator reports three timed-out approval attempts and no currently active card, with push deferred to daytime. This is **PENDING-PUSH**, not a successful push.

HOLD until the owner approves a live approval card and the authorized landing coordinator pushes the prepared manifest. Verify the resulting remote full SHA and tree before closing or otherwise reconciling those PRs. Do not start the 19-PR landing sequence against a stale base or bypass the approval boundary.

## 4. Candidate artifact and evidence manifest

For every release artifact, retain:

| Field | Required evidence |
|---|---|
| Candidate SHA | Full immutable commit SHA |
| Artifact | Exact filename, target OS/architecture and release channel |
| Build | Workflow/run ID, URL, job and build configuration |
| Byte identity | File size and SHA-256 from produced artifact |
| Transfer identity | SHA-256 and size after upload/download; byte-for-byte equality |
| Signing | Tool output, signer identity, certificate/chain and timestamp where applicable |
| Notarization | Submission ID, status/ticket and native Gatekeeper result where applicable |
| Attestation | Attestation identity, subject digest, source repository/ref and workflow provenance |
| Storage | Release asset URL/location and access controls |
| Reviewer | Independent verifier and timestamp |

A workflow, test fixture, mock signer, checklist, PR description or successful static guard is not proof that an actual release artifact has been signed, notarized or attested. This runbook does not claim that signing or notarization has occurred.

## 5. HOLD / GO decision matrix

| Gate | HOLD if… | GO evidence required |
|---|---|---|
| Source and push | Local-only candidate, stale remote, dirty tree or missing PR reconciliation | Clean exact candidate SHA exists on GitHub and maps to reviewed landed PRs |
| Landing queue | Any required PR remains Draft/unlanded or dependency order is unresolved | All required PRs landed and exact candidate lineage recorded |
| Install/version | Dependency install or version check fails; generated drift remains | `npm ci`, sync and check complete on candidate with reviewed metadata |
| Workspace build | Any core/tools/desktop/CLI build fails or lacks evidence | Every workspace build passes on exact candidate SHA |
| Typecheck | Any workspace fails or is missing | All four workspace typechecks pass on exact candidate SHA |
| Full suite | Any fail, unexplained skip, stale SHA or subset-only evidence | Full OS-appropriate suite passes with zero failures and reviewed skips |
| GitHub CI | Queued, pending, cancelled, missing, failed or stale required job | All required CI matrix jobs complete successfully on exact candidate SHA |
| Artifact integrity | Hash mismatch, missing artifact or unknown source SHA | Produced and transferred artifact sizes/hashes match and are recorded |
| Signing/provenance | Missing/invalid signature, ticket, signer identity or attestation | Native verification proves exact artifact signature/notarization/provenance |
| Native acceptance | Install, upgrade, migration, provider or shutdown scenario fails/not run | Required supported OS/architecture scenarios PASS with retained evidence |
| Governance | No accountable release owner, rollback authority or explicit approval | Named owner accepts the evidence and authorizes exact candidate |

**Overall GO requires every required row to have complete evidence for the same candidate.** Any HOLD, FAIL, BLOCKED, NOT RUN, unknown, stale SHA or unexplained exception keeps the overall decision at HOLD.

## 6. Evidence record template

Create one record per gate and platform. Do not combine results from different candidate SHAs.

- Gate / scenario:
- Result: PASS / FAIL / BLOCKED / NOT RUN:
- Full candidate commit SHA:
- PR(s) and landed commit mapping:
- GitHub Actions workflow run ID and URL:
- Exact command or manual steps:
- OS build / architecture:
- Node.js / npm versions:
- Start/end timestamp and timezone:
- Exit code and original summary:
- Pass / fail / skipped counts and skip rationale:
- Artifact filename, size and SHA-256:
- Signing / notarization / attestation evidence URI (if applicable):
- Operator and independent reviewer:
- Deviations, exceptions and approving owner:
- Follow-up issue and closure criteria:

Redact credentials, OAuth tokens, signing secrets, Vault contents, personal data and sensitive log fields before retaining or sharing evidence.

## 7. Subsequent slices in Release Candidate & Go-Live Evidence

This PR is **Slice 1 only**. The following slices are planned, not opened in this cycle:

1. **Candidate Evidence Checklist** — define the per-SHA evidence packet, CI run/artifact manifest, required reviewers, skip/failure disposition and completeness guard.
2. **CI Unblock & Verification** — investigate queued GitHub Actions, establish service/workflow health, and capture successful required matrix runs on the exact candidate SHA. Queued is not PASS.
3. **Native Acceptance Evidence** — collect real Windows/macOS/Linux and supported-architecture install, upgrade, provider, runtime, signing, notarization, Gatekeeper and recovery evidence. A workflow/checklist alone is insufficient.
4. **GO Decision & Dossier Update** — update the final dossier in PR #62 with final candidate identity, all evidence references, explicit exceptions and release-owner decision. Only change HOLD to GO after every required gate is satisfied.

## 8. Authoring and execution boundary

This is GitHub-authored documentation and a static Node.js documentation guard. No test, build, typecheck, CI job, native acceptance, artifact signing, notarization or production deployment was executed by this author. No test/build/typecheck was run. All operator-reported local state and verifier outcomes are labeled as such. This PR is intentionally Draft and is not LAND-READY.

