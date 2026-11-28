# CI Unblock & Verification Runbook

**Phase:** Release Candidate & Go-Live Evidence — Slice 3/5  
**Status:** INVESTIGATION ONLY — CI is not verified green; release decision remains **HOLD**.

## 1. Purpose and evidence boundary

This runbook records the GitHub Actions queue investigation visible through the public GitHub API and defines a safe, evidence-led unblock sequence. It does not assert a root cause that the available API cannot prove.

The repository workflow inspected was .github/workflows/ci.yml on base main SHA 2d14cc1b73c3f9fecb4b92614c180fb15a404aec. The workflow named CI has two jobs, each with an OS matrix of ubuntu-latest, windows-latest, and macos-latest:

- build-test: checkout, Node.js 24 setup, npm cache, npm ci, version check, build, typecheck, and the full test suite (Linux under xvfb-run).
- platform: checkout, Node.js 24 setup, npm cache, npm ci, version check, build, and tests/platform.test.mjs.

Both push and pull_request events target all branches. No workflow-level or job-level concurrency group is declared in the inspected file. A push followed by its pull-request event can therefore create two independent six-job runs for one head SHA. This is an observed workflow property, not proof that duplicate events caused the queue.

## 2. GitHub API observation snapshot

Snapshot time: **2026-11-27 06:01–06:06 +07**. Re-fetch the API before acting; run state is mutable.

| Run | Event | Run ID | Run number | Candidate head SHA | Observed status |
|---|---|---:|---:|---|---|
| Push | push | 45897416251 | 643 | e4626e8d6262ff531854322278c72221a7b1c0bc | queued |
| PR #64 | pull_request | 45897423615 | 644 | e4626e8d6262ff531854322278c72221a7b1c0bc | queued |

Both runs reference branch hardening/candidate-evidence-checklist and base SHA 2d14cc1b73c3f9fecb4b92614c180fb15a404aec. Each run exposed six matrix jobs. Across the two runs, all 12 jobs were queued; the job records had runner_id: 0, empty runner_name, no steps, and no completion timestamp. The run records had no conclusion.

**Primary candidate SHA for the initial unblock probe:** e4626e8d6262ff531854322278c72221a7b1c0bc.

**Additional verification target:** after this slice is opened, record its actual PR head SHA and both associated run IDs (push and pull_request if both are emitted). Do not assume this documentation PR's SHA in advance.

## 3. What the evidence does and does not establish

Established by API read-back:

1. The two named runs exist and are still reported as queued in the snapshot.
2. Their six jobs each are queued, with no runner assigned in the job records.
3. The workflow has two three-OS matrix jobs and both push and pull-request triggers.
4. No job step has begun in the observed run records.

Not established:

- Whether GitHub-hosted runner capacity, account/organization concurrency, billing/quota, a service incident, runner-group access policy, repository Actions policy, or a transient scheduling defect is the cause.
- Whether older runs are still queued at the time this runbook is used.
- Whether any job will eventually start, or whether a rerun would help.
- Whether the candidate SHA is release-ready.

A queued job with runner_id: 0 is evidence that no runner is assigned in that API response. It is not, by itself, a diagnosis of why assignment has not occurred.

## 4. Safe unblock sequence

Perform these checks in order and preserve the output with UTC timestamps.

### A. Refresh exact run and job state

For each run ID above, read:

- GET /repos/openbot1/open-bot/actions/runs/{run_id}
- GET /repos/openbot1/open-bot/actions/runs/{run_id}/jobs

Record run ID, run attempt, event, branch, head_sha, status, conclusion, created/started/completed timestamps, and every job's ID, name, labels, status, runner ID/name, and step list. Confirm the run still targets the intended candidate SHA. Never infer a current status from this historical snapshot.

### B. Check repository and organization controls

A repository administrator/owner should inspect GitHub Actions settings and organization policy for:

- Actions enabled/disabled state and allowed actions policy.
- Repository/organization runner availability and runner-group access, if self-hosted runners are involved.
- GitHub-hosted runner usage/concurrency limits, billing or quota restrictions, and any usage-limit banner.
- Organization-level concurrency or policy restrictions that are not exposed by the public run/job payload.
- GitHub Status for an Actions incident matching the observation window.

Capture screenshots or exportable records with timestamp and scope. Do not publish secrets, billing identifiers, runner tokens, or environment variables.

### C. Separate service queueing from workflow defects

If the jobs remain queued and no runner is assigned, compare another minimal, trusted workflow run in the same repository and time window only if one already exists; do not create noisy test commits merely to probe capacity. Compare a known-good repository/workflow only if the same administrator can establish equivalent runner scope and policy.

If GitHub reports an incident or usage restriction, record the incident/limit evidence and follow the documented owner/support path. If self-hosted runners are used, inspect runner online/idle state and group authorization without exposing credentials.

### D. Avoid destructive or noisy actions

- Do not cancel queued runs merely to make the dashboard look clean.
- Do not mass-rerun, dispatch, or push empty commits.
- Do not change matrix size, disable an OS, weaken required checks, or add continue-on-error as a queue workaround.
- Do not add a concurrency cancellation policy until its impact on required release evidence is reviewed; cancellation can erase useful in-flight evidence.
- Do not treat a successful docs-only static guard as a substitute for build, typecheck, full-suite, or platform CI.

### E. Apply only a verified remediation

A workflow/configuration change is allowed only after the cause is evidenced and the change directly addresses it. Examples of evidence-gated actions:

- If an administrator confirms a runner-group authorization defect, correct the narrow access policy and capture before/after evidence.
- If an account/organization concurrency or usage limit is confirmed, resolve it with the owner; do not silently reduce the release matrix.
- If GitHub confirms a service incident, wait for recovery and rerun only the affected required checks when appropriate.
- If duplicate event load is proven to be material, propose a separate reviewed workflow change with explicit event semantics and proof that required PR and push validation remains intact. Do not implement this based only on the current snapshot.

## 5. Required successful verification packet

For the chosen immutable candidate SHA, capture:

- Candidate SHA and branch; base SHA; PR number and URL.
- Every required workflow run ID, event, run attempt, canonical URL, and exact head_sha.
- All six expected matrix jobs per run, with job IDs, OS labels, final status and conclusion.
- Build, typecheck, full-suite and platform-test results; preserve full logs and exact command/environment details where applicable.
- Explicit classification of every skipped test and every failure; unexplained or release-critical skips remain HOLD.
- Confirmation that no required run tested a different SHA.
- Independent reviewer sign-off and a dated decision record.

A run is not complete merely because it exists or leaves the queued state. A required run is acceptable only when all required jobs have completed successfully on the exact candidate SHA and the evidence packet has been reviewed.

## 6. Candidate and run register

| Field | Current value |
|---|---|
| Base main SHA | 2d14cc1b73c3f9fecb4b92614c180fb15a404aec |
| Initial candidate SHA | e4626e8d6262ff531854322278c72221a7b1c0bc |
| Push run | 45897416251 (run #643) |
| Pull-request run | 45897423615 (run #644, PR #64) |
| Latest status in snapshot | Queued; six queued jobs in each run |
| Root cause | Unknown; administrator-side evidence required |
| Release decision | **HOLD** |

Replace this register only with refreshed, attributable evidence. Preserve the previous snapshot in the PR discussion or evidence archive rather than overwriting history.

## 7. Operator-reported local status — not independently verified here

The operator reports local main 8dc29d67, a clean working tree, approximately **1,527,941 tracked lines**, and a full-suite result of **12,914 pass / 0 fail / 3 skipped**. These are **operator-reported** values, not verified by this PR author and not results from the GitHub candidate SHA above. The reported suite result must not be represented as GitHub Actions evidence.

## 8. Authoring boundary and release gate

**GitHub-only authoring, no test/build/typecheck was run.**

This PR is intentionally Draft and is not presented as LAND-READY. It adds an operational investigation runbook and a static documentation guard only. It does not claim CI ran successfully, does not claim the queue root cause is known, and does not establish native acceptance.

The release decision remains **HOLD** until required CI and native acceptance evidence is collected, independently reviewed, and accepted by the release owner. No GO decision is made by this slice.
