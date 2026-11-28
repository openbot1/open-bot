# Release Rollback and Forward-Fix Rehearsal Runbook

Reviewed repository base snapshot: 2d14cc1b73c3f9fecb4b92614c180fb15a404aec.

This runbook defines a controlled rehearsal for responding when an already published open-bot release must be withdrawn, rolled back where safe, or superseded by a forward-fix. It covers decision authority, source and artifact identity, verification, data compatibility, user communication and evidence retention.

A rehearsal is a documented simulation unless a maintainer separately approves a real release action. Do not publish, withdraw, overwrite or downgrade a release during a tabletop exercise. This runbook does not assume an automatic in-app updater or a server-side application backend.

## 1. Objectives and safety boundaries

The exercise must demonstrate that maintainers can identify the exact affected release, choose a safe recovery direction, protect local user data, verify replacement artifacts and communicate precise user actions.

The rehearsal has these objectives:

- Decide whether rollback, forward-fix, temporary mitigation or distribution pause is safest for the verified incident.
- Identify who can authorise source changes, artifact publication, release withdrawal and user notification.
- Trace each release artifact to its exact tag, source commit SHA, platform, architecture and SHA-256.
- Verify that rollback or forward-fix preserves user data and does not reintroduce the vulnerability.
- Record evidence sufficient for an independent reviewer to reconstruct the decision and outcome.

Non-negotiable boundaries:

- Do not change production release state during a tabletop rehearsal.
- Do not downgrade users to a vulnerable version merely because rollback is operationally easier.
- Do not overwrite or move an existing immutable release tag to make the exercise appear successful.
- Do not delete user data, Vault material, SQLite databases or workspace files during rehearsal.
- Do not claim an artifact, signature, restore, rollback, update or user notification was verified unless evidence exists for that exact operation.
- Keep the exercise security and reliability focused; do not add features or bundle unrelated code changes.

## 2. Roles and decision authority

Assign named people before the exercise. One person may hold more than one operational role only when project staffing requires it; record the separation limitations.

| Role | Responsibility |
|---|---|
| Incident owner | Maintains the incident timeline, impact assessment, affected-version scope and recommendation |
| Release owner | Confirms release identity, artifact availability, distribution controls and publication/withdrawal actions |
| Technical patch owner | Prepares the rollback candidate or forward-fix and its regression evidence |
| Data-safety reviewer | Reviews SQLite schema/data compatibility, Vault handling and user-data preservation |
| Independent verifier | Reviews exact SHAs, tests, artifact hashes, platform evidence and decision record |
| Authorised maintainer / release approver | Makes the final rollback, forward-fix, mitigation, pause or resume decision |
| Communications owner | Prepares user and reporter notices using only verified facts and approved actions |

The authorised maintainer / release approver owns the final decision to publish a rollback or forward-fix, withdraw an artifact, pause distribution or resume the release channel. The incident owner recommends a path and records the rationale; the release owner executes only after approval; the independent verifier does not approve their own patch.

If the normal approver is unavailable, use only a formally delegated maintainer authority already recognised by the project. Do not invent emergency authority during the exercise. If no authorised approver is available, keep the affected distribution paused and record the escalation path.

## 3. Trigger, scope and initial containment

Start the process when a published release is defective, causes material regression or data risk, contains a security vulnerability, has incorrect provenance/signing, or cannot be safely installed or updated.

The incident owner records:

- Discovery time in UTC, reporter/source and incident identifier.
- Exact affected product version, release tag, source commit SHA, channel, platform and architecture.
- Artifact filename, byte size, SHA-256 and published download location.
- Known impact, reproduction confidence, affected user actions and whether exploitation is active.
- Whether the release is available for download, advertised by the updater or already installed by users.
- Immediate containment taken, approver, timestamp and user impact.

Containment options include pausing new publication, disabling or correcting an unsafe download link, marking an affected release as withdrawn, pausing a release channel, or issuing a temporary mitigation notice. Choose the smallest action that prevents additional harm without destroying evidence or blocking safe recovery.

If signing identity, provenance or artifact integrity is uncertain, quarantine the affected artifact and stop distribution until a trusted replacement is verified. Do not rely on a filename or version string as proof of artifact identity.

## 4. Rollback versus forward-fix decision

Choose the path based on user safety, exploit risk, data compatibility, release integrity and the ability to deliver a trusted replacement.

### Rollback is appropriate only when

- The prior release is verified as safe and does not contain the vulnerability or defect being addressed.
- The prior release is compatible with data already written by the newer release, or a separately verified backup/restore path exists.
- Downgrading application code will not corrupt, discard or misinterpret SQLite data, Vault material, settings, secrets or workspace state.
- The rollback artifact can be tied to its exact previously approved source SHA and verified artifact hash/signature.
- The distribution mechanism can clearly deliver the intended prior artifact without silently downgrading users or mixing platform versions.

### Forward-fix is preferred when

- The previous release is vulnerable, compromised or otherwise unsafe.
- The newer release may have migrated or written data that an older release cannot safely read.
- A narrow correction can be built and verified from a trusted source base without removing user data.
- Rollback would require destructive migration reversal, Vault downgrade or restoration of older user data.
- The current updater/distribution path cannot guarantee that users receive the intended older artifact safely.

### Pause distribution or use a mitigation when

- Neither rollback nor forward-fix has yet passed required verification.
- The signing identity, build provenance, release tag or artifact hash cannot be trusted.
- The data compatibility consequences are unknown.
- Required native platform checks or an authorised release approver are unavailable.
- A temporary safe user action can reduce exposure while a verified replacement is prepared.

Do not choose rollback solely because it is faster. When evidence is incomplete, prefer a reversible pause and a time-bounded decision review over an irreversible downgrade.

## 5. Data compatibility and local-state safety gate

Before recommending rollback, determine whether the affected release changed any persisted format or data lifecycle.

Review SQLite database schema versions, migration history, transaction boundaries, WAL/checkpoint behaviour, backup availability, downgrade compatibility and whether the newer version may have written rows or values that the older version cannot interpret. Check whether a database migration is reversible in practice, not merely whether a down-migration function exists.

Review Vault format/version, key derivation or encryption metadata, credential references, settings files and workspace state. Never assume that application rollback also rolls back data written by the newer version.

The data-safety reviewer must answer all of these questions:

- Which user-data locations can the release read or write?
- Did the affected version run a schema migration or change serialized data?
- Can the prior application version read the post-release data without destructive conversion?
- Is a verified backup available, and has restore integrity been demonstrated on a disposable copy?
- Could rollback invalidate, overwrite or orphan Vault entries, encryption keys, tokens, settings or workspace files?
- What exact user-data formats and version markers were checked?
- What is the recovery path if the first launch after rollback fails?

Do not test downgrade behaviour against a user's only copy of real data. Use synthetic fixtures or a disposable copy with recorded hashes. Preserve the original backup unchanged and verify the restored copy separately.

If compatibility is unknown, rollback is not approved. Prefer a forward-fix that preserves the current data format, or keep distribution paused until the data-safety gate is satisfied.

## 6. Rehearsal preparation and scenario selection

Run the rehearsal against a named scenario and a fixed source/release snapshot. At minimum, exercise one scenario in each category over the project rehearsal programme:

1. **Application regression:** a release causes a crash or severe regression, while the prior release is believed safe.
2. **Security vulnerability:** a release exposes a security boundary; determine whether the prior release is also vulnerable.
3. **Data migration incompatibility:** the new release has already migrated local data and the old binary may not read it.
4. **Artifact or signing issue:** release bytes, tag, signing identity or provenance cannot be trusted.
5. **Partial platform availability:** one platform's artifact is verified while another remains unavailable or fails native checks.

For each scenario, prepare a synthetic incident brief, affected-version matrix, exact release/tag/SHA identities, mock artifact hashes, data-format notes, role assignments and expected decision points. Do not include real credentials, reporter details, customer records or private exploit material in rehearsal fixtures.

The exercise coordinator announces START and STOP times, confirms no production write action is authorised, and records every simulated action with a SIMULATED label.

## 7. Rollback rehearsal procedure

1. Confirm the exercise is simulated and identify the release candidate under review.
2. Retrieve the prior published release metadata and confirm its exact tag, source SHA, version, platform, architecture and artifact hashes.
3. Review release notes, known vulnerabilities, security advisories and incident history to determine whether the prior release is genuinely safe.
4. Compare data-format changes between the affected release and the prior release. Complete the data-safety gate in Section 5.
5. On a disposable test profile, reproduce the state after the affected release has run. Preserve a copy and its SHA-256 before testing.
6. Simulate installation/launch of the prior version against that disposable state. Verify startup, database integrity, Vault access, settings and workspace behaviour without deleting or silently resetting data.
7. Verify that the exact prior artifact has the expected hash and publisher/signing status. A matching version label alone is insufficient.
8. Record whether update metadata can safely point to the prior release, whether manual download is required, and how users will be prevented from receiving a mixed or unsafe artifact.
9. Present the recommendation and evidence to the authorised release approver. Do not change production release metadata during a tabletop exercise.
10. Record the approval decision, unresolved risks and follow-up actions.

A rollback rehearsal passes only when the prior version is confirmed safe, data compatibility is demonstrated on disposable state, the exact artifact is verified and the release owner can describe a safe distribution procedure.

## 8. Forward-fix rehearsal procedure

1. Confirm the trusted source base and record the exact affected release SHA and intended patch base SHA.
2. Define the smallest fix, the security/regression behaviour it must enforce, and any required data compatibility constraints.
3. Create a dedicated patch candidate from the authorised base. Keep unrelated changes out and record the changed-file list.
4. Add or identify a regression test that reproduces the failure on the vulnerable baseline and passes on the candidate. Use synthetic, non-secret fixtures.
5. Run focused tests, build and typecheck, then the required full-suite gate on the exact candidate SHA. Record skipped tests separately; a skip is not a pass.
6. Verify native platform packaging and runtime behaviour for each artifact intended for release. Record unavailable platform checks as NOT RUN with a reason.
7. Verify artifact filename, platform, architecture, byte size, SHA-256, source/tag relationship, signature, certificate chain and provenance where applicable.
8. Test upgrade from the affected release using disposable user data. Verify SQLite migration state, Vault access, settings and workspace continuity after upgrade.
9. Confirm the forward-fix does not reintroduce the reported defect and that the release/update channel cannot select the vulnerable artifact as the recommended version.
10. Obtain independent verification and explicit approval from the authorised release approver before any real publication.

A forward-fix rehearsal passes only when the regression is closed on the exact candidate SHA, required gates and applicable platform checks are documented, data compatibility is demonstrated, and the exact replacement artifacts are verified.

## 9. Release execution controls

For a real incident after rehearsal, use the existing release procedure and record explicit approval before taking production action.

- Build from the approved immutable source SHA in the trusted release environment.
- Use a new release version and tag according to the existing version policy; do not move or overwrite an existing tag.
- Record exact artifact filenames, byte sizes and SHA-256 hashes before upload.
- Verify signatures, publisher identity, provenance and platform trust for each exact artifact. State unsigned platforms accurately.
- Confirm that uploaded bytes match the approved local artifact hashes and that the release tag points to the approved source SHA.
- Check release channel metadata, download links and updater messaging before publication.
- If the application requires manual download and installation, say so explicitly; do not promise automatic in-app installation unless separately implemented and verified.
- Keep a copy of the prior release metadata and evidence needed to withdraw or correct the release without deleting the audit trail.

For a real rollback, publish or point only to the exact safe prior artifact after the approver confirms data compatibility. For a forward-fix, publish only the verified replacement. If neither path is safe, keep distribution paused and communicate the mitigation.

## 10. User communication and notification rehearsal

The communications owner prepares a draft notice before the final decision and updates it only with verified facts.

A user notice must state:

- Product version range and platforms confirmed affected.
- Whether the release is withdrawn, paused, rolled back or replaced by a forward-fix.
- The exact fixed/safe version and official download location, once verified.
- Whether users must manually download/install, restart, revoke a credential, restore a backup or take another action.
- Whether user data is preserved and any backup or compatibility warning.
- Known platform gaps, limitations and the next update time.
- Publication timestamp and private route for reporting additional security issues.

Do not state that all users are protected if one platform or channel remains unresolved. Do not ask users to downgrade to a version that is still vulnerable or incompatible with their migrated data. Avoid exposing exploit steps, secrets, private incident evidence or reporter identity without consent.

During the tabletop exercise, label all notices SIMULATED and do not publish them. For a real incident, the authorised release approver confirms the notice and the communications owner records the publication URL and timestamp.

## 11. Evidence and rehearsal record

The exercise coordinator maintains one record with:

- Exercise identifier, scenario, START/STOP timestamps in UTC and participant/role list.
- Affected/replacement versions, tags, exact source SHAs, platforms and architectures.
- Artifact filenames, byte sizes, SHA-256 hashes and signature/provenance evidence references.
- Incident summary, severity, impact assumptions and rollback/forward-fix/pause recommendation.
- Data compatibility matrix covering SQLite, Vault, settings, secrets and workspace state.
- Test/build/typecheck/full-suite results for a real candidate, including exact SHA and skipped/NOT RUN reasons; simulated values must be clearly labelled SIMULATED.
- Approval decision, decision-maker, independent reviewer, rationale and residual risks.
- User notice draft or publication URL, timestamp, audience and next update commitment.
- Follow-up actions, owner, due date and closure evidence.

For each retained evidence file, record source, capture time, byte size and SHA-256. Preserve originals unchanged and analyse redacted copies. Do not place raw credentials, private keys, full user databases, prompts, conversations or workspace archives in the rehearsal record.

## 12. Pass criteria, failure handling and closure

The rehearsal is complete only when participants can identify the affected release, assign decision authority, choose rollback/forward-fix/pause using explicit criteria, demonstrate the data-safety checks, verify exact artifact identity, describe the user communication and produce a complete evidence record.

Record each criterion as PASS, FAIL, NOT RUN or SIMULATED. A NOT RUN or SIMULATED result is not evidence that a real release action succeeded.

The rehearsal fails if decision authority is unclear, the prior release's safety is assumed rather than checked, data downgrade risk is unknown, artifact identity cannot be proven, required verification is skipped without disposition, or user instructions could cause a vulnerable downgrade or data loss.

For every failure, record the observed gap, user/release risk, owner, corrective action and due date. Repeat the affected scenario after the correction and preserve both records.

Close the exercise only after the coordinator records the outcome, the authorised maintainer accepts residual risk, the independent reviewer confirms evidence completeness and every follow-up has an owner and due date. A rehearsal completion does not approve a real rollback, forward-fix or release.

## 13. Review and maintenance

Review this runbook after a real rollback/forward-fix incident, a failed rehearsal, a material change to release or updater behaviour, or a change to SQLite/Vault data formats. Keep the procedure aligned with the current release policy and supported platforms.

This runbook defines a proposed manual rehearsal process. It does not establish an automatic rollback service, automatic updater installation, guaranteed recovery time, contractual SLA or authority to bypass release approval and verification controls.
