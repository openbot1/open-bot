# Emergency Security Patch Lane

Reviewed repository base snapshot: 2d14cc1b73c3f9fecb4b92614c180fb15a404aec.

This runbook defines an exceptional, security-only path from receipt of a serious vulnerability report through triage, containment, patch engineering, verification, out-of-cycle release and user notification. It supplements the normal release process; it does not authorise feature work, bypass security review or turn an unverified build into a release.

The lane is intended for a local-first desktop product. It does not assume a hosted application backend, telemetry collection, automatic in-app installation or a staffed 24-hour response team. Verify the actual distribution and update mechanism for the affected release before communicating user actions.

## 1. Activation and non-negotiable rules

Activate the emergency lane when a credible report or internal finding indicates a serious vulnerability in a released version, release artifact, update path, signing process or security boundary and waiting for the normal release cadence would leave users at material risk.

Examples include credible remote or local code execution, privilege-boundary bypass, access to credentials or private user data, exploitable unsafe deserialisation, malicious update or package substitution, compromised signing material, or an actively exploited weakness. A report is an activation signal, not proof that the issue is exploitable.

Non-negotiable rules:

- Protect users first. Containment and a safe mitigation take priority over a preferred release date, disclosure embargo or evidence completeness.
- Keep the change security-only and minimal. No unrelated refactoring, dependency refresh, feature work, broad formatting, or opportunistic cleanup.
- Do not publish vulnerability details, a working proof-of-concept, secrets, affected private data or an unpatched implementation path in a public issue, branch name, commit message, PR title or CI log.
- Do not claim a fix, affected-version range, platform result, signature, notarisation, successful update or user notification until evidence for that exact claim exists.
- Do not weaken required build, typecheck, test, signing, provenance or platform gates because the release is urgent. Record an explicit, reviewed exception only where the release process permits it; never relabel a skipped or unavailable check as passed.
- Do not land an emergency patch solely because it is urgent. The required maintainer approval and independent verification still apply.

## 2. Intake, ownership and initial containment

Receive the report through a private channel. Use the project's security-intake procedure when available; confirm that the channel is private before sharing details. If no private route is available, request a private contact route without putting technical details in a public issue.

The first maintainer handling the report must:

1. Record the receipt time in UTC, source/channel, affected product version if known, exact source SHA if known, platform/architecture, and a private incident identifier such as EMSEC-YYYY-NNN.
2. Assign one incident owner and one independent technical reviewer. Record an escalation contact for release/signing decisions.
3. Ask only for the minimum information needed: affected component/boundary, prerequisites, smallest reproducible steps, expected and observed impact, exposure window, and whether exploitation or public disclosure is known.
4. Tell the reporter not to send live API keys, OAuth tokens, signing credentials, passwords, user databases, prompts, conversations, workspace archives or unredacted crash dumps.
5. Preserve minimal evidence before destructive investigation where practical, but do not delay revocation, disabling an unsafe path, pausing publication or other urgent containment.
6. Create a restricted case record. Use the opaque incident ID in internal references; keep vulnerability details and reporter identity out of public artifacts.

If there is credible active exploitation, credential compromise, ongoing user-data exposure, or a potentially compromised release/signing identity, immediately evaluate disabling the affected integration, withdrawing or pausing the affected download, revoking exposed credentials, stopping signing/publication, or issuing a temporary safe-use warning. Record who authorised each action and its user impact.

## 3. Severity and emergency-lane decision

Rate severity using demonstrated impact, reachability, prerequisites, default configuration, privilege required, user interaction, scope of affected users, exploit maturity, current exploitation and available mitigations. Do not use a numeric score as the only decision input.

| Priority | Typical indicators | Lane decision and response |
|---|---|---|
| P0 / Critical | Active exploitation; credible unauthenticated or broadly reachable code execution; signing/update-chain compromise; broad credential or sensitive user-data compromise | Activate immediately; same-day containment decision; pause affected release/distribution paths until trusted |
| P1 / High | Serious exploitable trust-boundary bypass, local code execution, sensitive-data access or privilege escalation with credible reachability | Activate when normal cadence creates material exposure; target same-day owner/reviewer decision |
| P2 / Moderate | Material security weakness with constrained prerequisites or narrow exposure and a viable mitigation | Usually use the normal security release plan unless delay materially increases risk; document the decision |
| P3 / Low | Limited impact or defence-in-depth issue without a demonstrated practical exploit path | Do not use the emergency lane solely for convenience; schedule normal remediation |

The response windows above are proposed operating targets, not a contractual SLA or guarantee of staffed availability. If evidence is incomplete, record confidence as CONFIRMED, PROBABLE or UNCONFIRMED and explain the basis. Unknown scope for a high-privilege or actively exposed boundary is a reason to contain conservatively, not to downgrade automatically.

The incident owner records the selected priority, affected components/versions, assumptions, exploit status, mitigation options, decision to activate or decline the lane, approver and next review time. Reassess priority whenever new evidence changes the likely impact.

## 4. Scope, release identity and patch authorisation

Before changing code, establish the source and release facts:

- Identify the exact released version, tag, source commit SHA, supported platforms/architectures and artifact identifiers potentially affected.
- Determine whether the issue exists in the tagged release, in later commits, only in a packaging/update path, or in a third-party/provider integration.
- Use the smallest trusted release base that contains the affected code. Create a dedicated private or access-restricted patch branch from that exact release/source SHA where repository controls support it.
- Record the patch branch name, base SHA, intended fixed version, incident ID and authorised reviewers in the restricted case record. Keep sensitive details out of branch and commit names.
- Confirm who can approve source changes, release metadata, signing identity, publication and user communications. One person's urgency is not a substitute for required authority.
- Check whether the chosen base includes any already approved prerequisite fix. Do not silently depend on an unlanded PR or copy unrelated changes into the emergency patch.

If the project cannot create a private review path for sensitive details, coordinate a safe publication sequence before opening a public PR. The public PR should describe the security impact at the minimum level necessary until a fix is available. Do not expose a proof-of-concept merely to demonstrate urgency.

## 5. Patch engineering: minimal, reviewable and reversible

The patch owner must document the vulnerable trust boundary and the exact unsafe behaviour before editing. Implement the narrowest correction that closes the exploit path while preserving legitimate behaviour.

- Add a regression test that fails against the vulnerable behaviour and passes for the corrected behaviour. Prefer synthetic fixtures and non-secret values.
- Cover the security boundary and relevant negative cases: unauthorised sender/permission, malformed or hostile input, unexpected environment, path/network boundary, replay or downgrade condition, and fail-closed behaviour as applicable.
- Avoid broad dependency upgrades. If an upgrade is necessary to close the vulnerability, pin the exact version, explain why it is the minimal safe change, review transitive impact and record lockfile changes.
- Do not add feature flags that leave the vulnerable path reachable by default. A mitigation switch must fail closed and have an explicit owner and removal/review date.
- Do not place exploit strings, tokens, private report details or user data in fixtures, snapshots, test names, comments or logs. Use synthetic identifiers.
- Keep generated output, lockfiles, release metadata and version mirrors consistent with the repository's documented single-source/version-sync process. Do not hand-edit mirrored version values independently.
- Record the exact files changed and why each is in scope. Any out-of-scope change blocks the emergency patch until removed or separately justified and approved.

The patch author must provide a concise threat-to-fix explanation: attacker preconditions, vulnerable path, boundary enforced by the change, expected safe behaviour, regression coverage and residual limitations. The independent reviewer must challenge whether the fix closes the complete reachable path rather than only the reported proof-of-concept.

## 6. Required verification before release

Verification is performed on the exact candidate SHA, not on a nearby branch, local working tree or earlier commit. Record tool versions, commands, exit status, timestamps and evidence links/log identifiers in the restricted release record.

Required checks, as applicable to the repository's release policy:

1. Confirm clean source state, exact branch/base relationship, version metadata consistency and absence of unintended changes.
2. Run focused regression tests first, including a fail-before/pass-after demonstration where safe and reproducible. Record the vulnerable baseline and fixed candidate SHA.
3. Run the required build and typecheck for every affected workspace.
4. Run the full required test suite on the exact candidate SHA. Any failure blocks release until resolved. Report skipped tests separately with reasons; a skip is not a pass.
5. Run security-specific checks and inspect the diff for secrets, accidental logging, weakened permissions, unsafe defaults or a bypass around the intended guard.
6. Run native platform/package checks for every artifact being published. A CI matrix entry or packaging target is not proof of a successful native installation or runtime check.
7. Verify signing, certificate identity, notarisation/Gatekeeper or Authenticode status, provenance/attestation and hashes according to the actual platform release policy. Never claim a signature or attestation that was not verified on the exact artifact.
8. Have an independent reviewer examine the patch, regression test, exact candidate SHA, release notes and verification record. Obtain explicit release approval from the authorised maintainer.

If a check cannot be run because a platform, credential, runner or provider is unavailable, record NOT RUN, the reason, risk, owner and compensating control. The release approver must decide whether policy permits an exception. Do not state that the full gate is green when any required check is failed, queued, skipped or unavailable.

## 7. Out-of-cycle release preparation

An emergency security release may occur outside the normal release calendar, but it follows the same source identity, artifact integrity and approval discipline.

1. Select a version that follows the repository's existing versioning and release policy. Do not invent a separate numbering scheme or silently overwrite an existing tag.
2. Generate release notes that state the verified affected range, fixed version, security impact at a safe level, user action and known limitations. Do not disclose exploit details while users remain exposed.
3. Build each supported artifact from the exact approved candidate SHA in the trusted release environment. Record artifact filename, platform, architecture, byte size and SHA-256.
4. Sign and verify each artifact using the approved release identity. For macOS and Windows, perform the platform's required signature and trust checks; for Linux, state accurately whether the artifact is signed or unsigned.
5. Verify the release tag resolves to the approved source SHA and that uploaded bytes match the locally verified artifact hashes. Preserve the release manifest and upload reconciliation evidence.
6. Confirm download links, release assets, channel metadata and any updater-facing metadata point only to the approved artifacts. Do not publish a partial or mixed-version set without an explicit platform availability notice.
7. Obtain a second-person release review and record approval before publication. Keep the affected old release available only if the incident owner determines it is safe; otherwise withdraw or clearly mark it according to the distribution mechanism.

The product's current updater/distribution behaviour must be checked against the exact release being handled. If the app only checks for a release, notifies the user and opens a download page, communicate that the user must download and install the patch manually. Do not promise silent, automatic or forced in-app installation unless that capability is separately implemented and verified.

## 8. Release decision, rollback and stop conditions

The authorised release approver must choose one of: publish the verified patch; publish a safe mitigation; keep the affected distribution paused; or reject/defer release with a documented reason and a next decision time.

Stop publication if any of the following applies:

- The source SHA or tag cannot be tied to the reviewed patch.
- A required test/build/typecheck or platform check fails, or an unexplained skip remains.
- The artifact hash differs from the verified build or upload.
- The signing identity, certificate chain, notarisation, provenance or publisher account is uncertain.
- The patch introduces unrelated changes, regresses data compatibility, or fails the security regression case.
- The download/update path can still deliver the vulnerable artifact without a clear warning or mitigation.
- The approver, reviewer or incident owner cannot establish who is responsible for the release.

If a published patch is defective, stop further distribution and decide between withdrawal/rollback and a forward-fix based on user-data compatibility and exploit risk. Do not automatically downgrade users to a vulnerable version. Preserve data, explain required user action and use a forward-fix when rollback would reintroduce the vulnerability or risk corrupting user data. Record the exact decision and affected artifacts.

## 9. User and reporter communication

Communicate promptly once the maintainer has a verified statement and a safe action users can take. Do not wait for a perfect postmortem while users remain exposed, but do not publish speculative impact or unverified fixed-version claims.

A user-facing notice should include:

- Product and version range confirmed affected, including platforms/architectures where known.
- Verified impact in plain language without exploit instructions or unnecessary implementation detail.
- Fixed version and exact download/release link, or the temporary mitigation if no patch is ready.
- Whether users must manually download/install, restart, revoke a credential, change a setting or take another specific action.
- Any data-preservation warning, incompatibility, known limitation or platform whose artifact is not yet available.
- Publication timestamp, next update time and a private route for security reports.

Notify the reporter privately about receipt, triage outcome, remediation progress and planned disclosure where coordination is possible. Ask explicitly before publishing reporter identity or credit. Do not promise a bounty, legal safe harbour or guaranteed response time unless separately authorised.

Use a coordinated disclosure window only when it does not delay urgent user protection. If active exploitation or public disclosure makes delay unsafe, prioritise containment and a factual notice. Do not ask users to install an unverified artifact or ask a reporter to suppress an urgent safety warning.

## 10. Evidence, incident record and closure

Maintain a restricted incident and release record with the minimum necessary evidence:

- Incident ID, receipt/discovery UTC timestamps, owner, reviewer, approver and priority rationale.
- Original report location and private communication references; redact reporter identity from general release records unless consented.
- Affected versions, source SHAs, tags, platforms, architectures, artifacts and exposure/exploitation timeline.
- Threat-to-fix explanation, changed-file list, regression test and independent review notes.
- Exact candidate SHA, build/test/platform results, tool versions, skipped/unavailable checks and exception decisions.
- Artifact filenames, byte sizes, SHA-256 hashes, signing identity and verification evidence, tag/upload reconciliation.
- Publication/withdrawal timestamps, user notice, download/update instructions, provider coordination and next-update commitments.
- Residual risk, follow-up owner, due date and evidence-retention/deletion date.

Preserve the minimum original evidence unchanged; record source, capture time, byte size and SHA-256 for retained files. Restrict access to named responders and analyse redacted copies. Never store raw credentials, signing private keys, full user databases, prompts, conversations or workspace archives in the incident record. Do not promise forensic erasure from backups or SSD media.

Close the emergency lane only after the approved fix or mitigation is available to affected users, the distribution/update path is verified, required notices are published, the reporter has received an appropriate update, residual risk is assigned, and the incident owner plus independent reviewer approve closure. If a platform artifact remains unavailable, keep the case open for that platform and communicate the limitation rather than declaring a universal fix.

## 11. Post-incident review

After containment, conduct a proportionate review of why the vulnerability existed, how it was introduced, why existing tests/review/release controls did not catch it, how detection and response performed, and whether the same root cause exists in other components or platforms.

Create narrowly scoped follow-up actions with owners and due dates. Do not expand the emergency patch retroactively with unrelated improvements. Update security tests, release procedures, operator guidance or this runbook only after the immediate incident is stable. Record lessons without publishing sensitive evidence or identifying the reporter without consent.

This runbook defines a proposed manual emergency process. It does not establish a 24-hour response guarantee, contractual SLA, automatic release capability, automatic updater behaviour, vulnerability bounty, legal safe harbour or permission to bypass required release controls.
