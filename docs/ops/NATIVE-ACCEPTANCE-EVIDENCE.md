# Native Acceptance Evidence Runbook

Reviewed repository base snapshot: 2d14cc1b73c3f9fecb4b92614c180fb15a404aec.

**Phase:** Release Candidate & Go-Live Evidence — Slice 4/5  
**Status:** PROCEDURE ONLY — no platform is declared accepted by this document. Release decision remains **HOLD**.

## 1. Purpose and acceptance boundary

This runbook defines the evidence packet required to accept the packaged open-bot desktop application on each target operating system. It coordinates clean install/first launch, upgrade/data preservation, provider/integration checks, runtime/shutdown, artifact identity and platform trust checks. It does not assert that any candidate artifact has been published, signed, notarized, installed or tested.

A packaging target is not proof of a successful native run. A source test, CI matrix result, static review, screenshot of a build configuration, or result from another operating system cannot substitute for execution on the target OS.

Use the exact immutable candidate source SHA and the exact artifact intended for release. Keep results separate by OS, architecture, OS build, artifact and test profile. Never combine evidence from different candidate SHAs or silently transfer a PASS between platforms.

## 2. Target platform and artifact matrix

The repository's current packaging configuration and operational notes identify these targets:

| Platform | Current package target | Architecture in current target | Trust/signing boundary |
|---|---|---|---|
| Windows | NSIS installer | x64 | Verify Authenticode publisher/signature on the exact installer; do not bypass SmartScreen or unexpected warnings |
| macOS | DMG | arm64 and x64 | Verify Developer ID signature, notarization and Gatekeeper assessment on the exact app/artifact |
| Linux | AppImage | x64 | Current configuration does not code-sign the AppImage; SHA-256 identifies bytes but is not a publisher signature |

Re-check the candidate's actual builder configuration before testing. If a target or architecture changed, record the change and obtain release-owner approval before treating this matrix as current. A configured target does not prove that an artifact exists or that the OS/architecture has been tested.

## 3. Mandatory evidence identity record

Create one evidence packet per platform and architecture. Record all of the following before installation:

- Full source commit SHA and candidate branch/tag.
- Root product version from the candidate root package manifest.
- Artifact filename, package format, byte size, download/source URL and SHA-256.
- Release tag and publication location, or explicitly state SOURCE/LOCAL BUILD — NOT A PUBLISHED RELEASE.
- OS name, edition/distribution, version and exact build; hardware/VM status and CPU architecture.
- Installer/runtime prerequisites and their versions where relevant.
- Test account/profile identifier that does not expose personal data; whether the account is standard or administrator.
- Test operator, independent reviewer, start/end timestamps with timezone, and evidence directory/reference.
- Build provenance or attestation reference, if available. Do not invent provenance when it is absent.

Compute SHA-256 from the actual file that will be installed. Preserve the command output and compare it with the approved artifact record. A filename, release tag, version string or screenshot alone is not artifact identity.

If the artifact cannot be tied to the exact candidate SHA, mark artifact identity BLOCKED and do not proceed to a release PASS.

## 4. Required execution sequence

Perform these stages in order for every applicable platform:

1. **Lock candidate identity.** Freeze source SHA, root app version, release tag, artifact filename and SHA-256. Do not replace the artifact during the test cycle.
2. **Clean install and first launch.** Use a fresh disposable OS profile. Install the exact artifact, record installer/trust prompts, launch the app and verify the first-run experience.
3. **Upgrade and data preservation.** Starting from the approved previous release and disposable seeded profile, upgrade to the candidate. Verify expected settings, workspace and non-secret data migration; test rollback only using the approved rollback procedure.
4. **Provider and integration acceptance.** Use dedicated test credentials and harmless requests. Verify each provider/integration independently; keep external write operations disabled unless separately approved.
5. **Runtime stability and lifecycle.** Perform startup/relaunch, idle and controlled-activity soak, window lifecycle, graceful quit, restart and recovery checks. Record process/resource evidence and sanitized logs.
6. **Platform trust checks.** Verify Windows signing, macOS signing/notarization/Gatekeeper, or Linux's explicitly unsigned AppImage status as applicable.
7. **Exception review and sign-off.** Classify every check as PASS, FAIL, BLOCKED or NOT RUN. Attach evidence references and obtain an independent reviewer signature for that platform/architecture.

Do not reorder stages to conceal a failure. If an earlier stage fails, stop dependent stages or mark them BLOCKED with the dependency recorded.

## 5. Outcome vocabulary and PASS rules

- **PASS** — performed on the exact recorded candidate/artifact and met the documented observable criterion; evidence is attached and independently reviewed.
- **FAIL** — performed and did not meet the criterion. Preserve the failure evidence; do not rerun until green and discard the first result.
- **BLOCKED** — a prerequisite, authorization, service, artifact or safe test environment prevented execution.
- **NOT RUN** — no execution evidence was collected.

Never mark PASS without actual evidence. A platform not tested must be recorded as **NOT RUN**. Do not infer or extrapolate acceptance from another OS, architecture, CI runner, source build or packaging target. A skipped test is not a PASS. A retry does not erase a previous failure; retain both attempts and explain the disposition.

The release owner must define any numeric thresholds not specified by the project, including shutdown timeout and resource-growth limits. If a threshold is missing, record the observation and mark the threshold-dependent criterion BLOCKED rather than inventing a value.

## 6. Evidence hygiene and safety

- Use disposable OS accounts, profiles, workspaces and test data. Never copy production userData, Vault, API keys or OAuth state into the test profile.
- Use dedicated least-privilege provider accounts and harmless read-only actions. Never include API keys, bearer tokens, OAuth codes, session URLs, raw Vault contents or personal data in evidence.
- Redact secrets in screenshots, logs, crash reports and terminal output before storing or sharing them.
- Do not disable Gatekeeper, SmartScreen, Defender, OS security controls or signature verification to manufacture a pass.
- Do not run the app as root or administrator merely to bypass a permission failure.
- Do not perform external write actions (email, issue creation, Slack posts, remote file changes, payments or destructive actions) without explicit release-owner approval naming the disposable target and permitted operation.
- Preserve original logs and raw evidence in access-controlled storage; create redacted review copies. Record hashes for evidence bundles where practical.

## 7. Companion acceptance procedures

Use the corresponding platform sections in this evidence set and the focused operational procedures where present:

- Clean install / first launch: docs/ops/CLEAN-INSTALL-FIRST-RUN-VERIFICATION.md
- Upgrade / data preservation: docs/ops/UPGRADE-DATA-PRESERVATION-VERIFICATION.md
- Provider / integration acceptance: docs/ops/PROVIDER-INTEGRATION-ACCEPTANCE.md
- Runtime stability / shutdown: docs/ops/RUNTIME-STABILITY-SHUTDOWN-VERIFICATION.md
- CI exact-SHA verification: docs/ops/CI-UNBLOCK-VERIFICATION.md

A companion document is a procedure, not evidence that the procedure passed. If a companion file is not present in the candidate snapshot, record that dependency and do not silently substitute a different revision.

## 8. Platform packet completion checklist

For each OS/architecture, the evidence packet must include:

- Candidate/artifact identity record and SHA-256 verification.
- Clean install and first-launch result.
- Upgrade, migration, data-preservation and rollback result or explicit BLOCKED/NOT RUN status.
- Provider/integration matrix with credential-safe evidence.
- Runtime soak, restart, graceful quit, process cleanup and recovery evidence.
- Platform trust/signing assessment and any known limitation.
- Full exception register with owner, impact, mitigation and disposition.
- Operator statement and independent reviewer name/role/date/sign-off.

A platform packet is incomplete if any required item is missing, has a mismatched SHA, lacks an evidence reference, or has an unexplained failure/skip. Incomplete packets cannot support GO.

## 9. Release decision boundary

This slice defines what evidence must be collected; it does not approve a release. The release decision remains **HOLD** until required CI, all required platform packets, security/release checks and independent reviews are complete on the same candidate SHA. Only the release owner may record the final GO/HOLD decision in the final acceptance dossier.

**GitHub-only authoring, no test/build/typecheck was run.**

This PR is intentionally Draft and is not presented as LAND-READY. No native installation, first launch, upgrade, provider request, soak, shutdown, signing assessment or notarization check was executed by this PR author.
