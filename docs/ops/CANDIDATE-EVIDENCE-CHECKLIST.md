# Candidate Evidence Checklist

Snapshot: 2026-11-27 04:05 +07
Repository: `openbot1/open-bot`
Phase: Release Candidate & Go-Live Evidence — Slice 2/5
Decision: **HOLD — this checklist does not approve a candidate or authorize release.**

This runbook defines the minimum evidence packet for one immutable release-candidate commit. It is a collection and review procedure, not evidence that any candidate build, CI run, artifact, platform check or release approval has occurred.

## 1. Governing rules

1. One packet represents exactly one full 40-character candidate commit SHA. Never combine build, test, CI or artifact evidence from different commits.
2. Record immutable URLs/IDs and original outputs. A green status on a branch name, another SHA, a rerun with a different attempt, or an unrelated PR is not candidate evidence.
3. Every required field is either populated with a verifiable value or explicitly marked `NOT RUN`, `BLOCKED`, `NOT APPLICABLE` with rationale, or `MISSING`. Blank fields are not acceptable.
4. The overall result remains **HOLD** if any required gate is missing, failed, stale, unexplained, or not independently reviewed.
5. This checklist does not execute commands, unblock CI, sign artifacts, notarize packages, or grant release approval.

## 2. Candidate identity and packet index

Create a unique evidence packet directory or record keyed by the full candidate SHA. Preserve the following index before collecting downstream results:

| Field | Required value |
|---|---|
| Repository | Canonical repository URL and owner/name |
| Candidate SHA | Full immutable 40-character commit SHA |
| Candidate ref | Branch/tag at capture time; never sole identity |
| Parent SHA | Full parent commit SHA |
| Source state | Clean-tree confirmation and command/output reference |
| PR lineage | Every included PR number, title, landed commit and merge/squash mapping |
| Version | App/package version and version metadata check result |
| Packet owner | Responsible operator and contact |
| Created | UTC timestamp, timezone and packet location |
| Decision | HOLD until every required gate is reviewed |

Capture the candidate SHA from the checked-out commit and independently compare it with the GitHub commit page/API and workflow `head_sha`. If any source disagrees, stop and mark the packet BLOCKED.

## 3. Per-SHA evidence packet

Create one record for each required gate below. Attach raw logs or durable evidence URIs; summaries alone are insufficient.

### 3.1 Source and dependency preparation

- [ ] Full candidate SHA and parent SHA recorded.
- [ ] Working tree is clean; exact command, exit code and output retained.
- [ ] Dependency installation uses the repository lockfile and records Node.js/npm versions.
- [ ] Version synchronization and drift checks are recorded for this SHA.
- [ ] Included PRs are landed on the candidate's ancestry; no local-only commit is treated as remotely available.
- [ ] Reviewer confirms that all evidence below names the same candidate SHA.

### 3.2 Build and typecheck

For each workspace, record command, start/end time, exit code, log URI, produced artifact references and the full candidate SHA:

| Workspace | Build result | Typecheck result | Log/evidence URI |
|---|---|---|---|
| `@open-bot/core` | PASS / FAIL / NOT RUN | PASS / FAIL / NOT RUN | |
| `@open-bot/tools` | PASS / FAIL / NOT RUN | PASS / FAIL / NOT RUN | |
| `@open-bot/desktop` | PASS / FAIL / NOT RUN | PASS / FAIL / NOT RUN | |
| `@open-bot/cli` | PASS / FAIL / NOT RUN | PASS / FAIL / NOT RUN | |

A root aggregate does not excuse a missing workspace result when the release procedure requires explicit per-workspace evidence. Any failure or missing required log is HOLD.

### 3.3 Full test-suite evidence and disposition

Record the exact full-suite command appropriate to the OS, OS build, architecture, Node/npm versions, candidate SHA, start/end time, exit code and original complete runner summary.

| Field | Required disposition |
|---|---|
| Pass / fail / skipped | Preserve exact runner counts; do not round |
| Failed tests | List each test name, failure output, issue/fix commit and rerun reference |
| Skipped tests | List each test name and exact skip reason; identify whether expected and approved |
| Retry behavior | Record every attempt; do not replace the first failure with a later green summary |
| SHA match | Confirm the tested SHA equals the packet candidate SHA |

**Skip disposition:** every skip must be individually classified as expected, environment-constrained, quarantined or unexplained, with evidence and an accountable reviewer. Unexplained, newly introduced or release-critical skips are HOLD.

**Failure disposition:** preserve the failing run. Link the defect, corrective commit and a complete rerun on the new candidate SHA. A fix on a later SHA invalidates downstream evidence collected against the previous SHA; rebuild the packet for the new SHA.

### 3.4 GitHub Actions run manifest

Record one row per required workflow run and matrix attempt. Use immutable run IDs and full SHA values.

| Field | Required value |
|---|---|
| Workflow | Exact workflow name and file path |
| Run | Numeric workflow run ID and canonical run URL |
| Attempt | Run attempt number |
| Trigger | Event, branch/ref and actor |
| Commit | Full `head_sha` matching candidate SHA |
| Matrix | Every required OS / architecture / job leg |
| Result | Original conclusion and completion timestamp |
| Logs | Job log and artifact download references |
| Reviewer | Independent reviewer and review timestamp |

Required CI jobs must finish successfully on the exact candidate SHA. `queued`, `pending`, `in_progress`, `cancelled`, `skipped`, missing, stale or failed required jobs are not PASS. If service availability blocks a run, record BLOCKED with run ID (if one exists), timestamps, observed status and escalation owner. Never infer success from workflow configuration or another commit.

### 3.5 Artifact manifest and byte identity

Create one manifest row for every distributable artifact and every platform/architecture variant.

| Field | Required value |
|---|---|
| Candidate SHA | Full source commit SHA |
| Workflow run | Run ID, attempt, job and URL |
| Artifact | Exact filename, format, OS and architecture |
| Build identity | Version, build configuration and producing job |
| Original bytes | File size in bytes and SHA-256 |
| Uploaded bytes | Storage location, upload timestamp, size and SHA-256 |
| Downloaded bytes | Retrieval location, timestamp, size and SHA-256 |
| Comparison | Explicit byte-for-byte comparison result |
| Signature | Signature status, signer/certificate identity and verification output |
| Notarization | Submission ID, ticket/status and native assessment where applicable |
| Attestation | Subject digest, repository/ref, workflow identity and provenance URI |
| Reviewer | Independent reviewer and timestamp |

A matching filename or version string does not prove byte identity. Hashes must be computed from the actual produced, uploaded and downloaded files. Any missing hash, mismatch, unknown source SHA or unverified signature/provenance is HOLD. Do not claim signing, notarization or attestation from a workflow definition, mock, fixture or checklist.

## 4. Reviewer and approval record

Each evidence packet requires distinct accountable roles. One person may not silently self-approve all roles; if role overlap is unavoidable, record the exception and obtain release-owner acceptance.

| Role | Required review |
|---|---|
| Candidate owner | Confirms immutable SHA, source cleanliness and PR lineage |
| Build/test operator | Confirms original commands, logs, exit codes and complete summaries |
| CI reviewer | Confirms run IDs, attempts, matrix coverage and exact SHA |
| Artifact reviewer | Independently recomputes hashes and verifies byte identity, signatures and provenance |
| Platform reviewer | Reviews native install/upgrade/runtime/recovery evidence for supported targets |
| Release owner | Reviews exceptions, rollback readiness and authorizes or rejects the exact candidate |

For every review capture reviewer identity, role, UTC timestamp, packet SHA, reviewed evidence references, decision (ACCEPT / REJECT / NEEDS-INFO) and comments. A reviewer must not approve evidence whose source SHA they have not checked.

## 5. Skip, failure and exception register

Every non-PASS item gets a register entry. Do not delete or overwrite an earlier failure after a fix.

| Field | Required content |
|---|---|
| Item | Gate, test name, job, matrix leg or artifact |
| Candidate SHA | Full affected SHA |
| State | FAIL / SKIPPED / BLOCKED / MISSING / EXCEPTION |
| First observed | Timestamp and original run/evidence URI |
| Reason | Exact failure, skip condition or blocker |
| Impact | User, platform, security and release impact |
| Disposition | Fix-and-rerun / approved skip / external unblock / reject |
| Owner | Named accountable person |
| Follow-up | Issue/PR and corrective commit SHA |
| Revalidation | New run ID, evidence URI and reviewer |
| Closure | Explicit closure criteria and timestamp |

An exception is not a PASS. It must identify affected platforms/users, compensating controls, expiry or review date, rollback plan and the release owner who accepts the residual risk. Security, data integrity, installation, upgrade and artifact-integrity failures cannot be waived by this checklist.

## 6. Packet completeness and decision

Before requesting a release-owner decision, verify all of the following:

- [ ] Candidate SHA is immutable, full-length, remotely available and matches all evidence.
- [ ] Source tree, PR lineage, version and dependency preparation are reviewed.
- [ ] Every required workspace build and typecheck has a complete result.
- [ ] Full suite ran on this SHA; every failure and skip has a documented disposition.
- [ ] Required GitHub Actions runs and matrix legs are complete and green on this SHA.
- [ ] Every artifact has source linkage, size, SHA-256 and transfer comparison.
- [ ] Required signing, notarization, attestation and native platform evidence is real and independently verified.
- [ ] All required reviewer roles have recorded decisions.
- [ ] No unresolved FAIL, unexplained SKIPPED, BLOCKED, MISSING or stale evidence remains.
- [ ] Rollback owner, recovery path and release authority are explicit.

Decision values:

- **HOLD** — default; any required evidence is incomplete, failed, stale or unreviewed.
- **BLOCKED** — evidence collection cannot proceed due to a named external/system blocker; overall release remains HOLD.
- **REJECT** — candidate is unsuitable; create a new candidate only after corrective work.
- **GO** — only the accountable release owner may record this after all mandatory gates are satisfied for the same SHA.

This checklist does not itself authorize GO. The final decision and evidence references must be transferred into the release dossier (PR #62) by the designated owner after the remaining release gates are complete.

## 7. Evidence packet record template

Copy once per candidate SHA and retain the completed record:

- Repository:
- Candidate SHA (full):
- Parent SHA:
- Candidate version:
- Packet URI / identifier:
- Packet owner:
- Source / PR lineage review:
- Dependency and version checks:
- Build results by workspace:
- Typecheck results by workspace:
- Full-suite command and environment:
- Test summary (pass / fail / skipped):
- Skip register URI and reviewer:
- Failure / exception register URI and reviewer:
- GitHub Actions workflow run IDs, attempts and URLs:
- Matrix coverage and exact-SHA confirmation:
- Artifact manifest URI:
- Per-artifact size and SHA-256:
- Upload/download hash comparison:
- Signing / notarization / attestation evidence:
- Native platform acceptance references:
- Reviewer decisions and timestamps:
- Rollback owner and recovery reference:
- Release-owner decision and rationale:
- Decision timestamp (UTC):
- Outstanding blockers / follow-up issues:

Redact credentials, access tokens, signing secrets, Vault contents, personal data and sensitive log fields before retaining or sharing evidence.

## 8. Relationship to the phase plan

This is **Slice 2/5** only. The next slices are planned and are not opened by this change:

1. **CI Unblock & Verification** — diagnose queued or stalled GitHub Actions, resolve service/workflow blockers, and capture required matrix runs with run IDs and exact candidate SHA.
2. **Native Acceptance Evidence** — collect actual supported-platform install, upgrade, provider, runtime, shutdown, recovery, signing, notarization and Gatekeeper evidence.
3. **GO Decision & Dossier Update** — update PR #62 with the final candidate SHA, reviewed evidence packet, residual exceptions and explicit release-owner decision; retain HOLD unless every mandatory gate passes.

## 9. Authoring and execution boundary

This document and its static Node.js guard are GitHub-authored documentation. No application code is imported or executed by the guard. No test, build, typecheck, CI run, artifact production, signature verification, notarization, native acceptance or production deployment was performed by this author. This PR is intentionally Draft and is not LAND-READY.
