# Credential Compromise Response Runbook

This runbook defines a maintainer-operated response when an API key, OAuth credential, GitHub credential or release-signing credential may have been exposed or misused. It is designed for open-bot's local-first architecture: contain credentials at their issuer, keep evidence access-restricted, and do not introduce a hosted incident system, telemetry or collection of end-user application data.

Reviewed repository base snapshot: 2d14cc1b73c3f9fecb4b92614c180fb15a404aec.

This is a proposed manual procedure. It does not claim that the project has staffed security operations, a contractual response SLA, a bug-bounty programme or automatic secrets management.

## 1. Activation and immediate priorities

Activate this procedure when a credential is found in a public repository, issue, pull request, build log, crash report, workstation, backup or other unapproved location; when an unknown party may have accessed an account; or when provider audit data shows unexpected use.

Treat credible exposure as compromise. Do not wait for proof of successful abuse before containing a high-impact credential.

1. Assign an incident owner and record the UTC discovery time, source, affected provider or signing system, and a private incident ID such as CRED-YYYY-NNN.
2. Classify the highest plausible impact using Section 3. Treat a potentially compromised signing key, broad administrator token or actively abused production credential as P0 until scope is bounded.
3. Stop further exposure: remove public copies where possible, restrict access to the affected account, repository, runner or workstation, pause affected release/signing jobs, and disable exposed automation when safe.
4. Preserve the minimum evidence needed to understand the event. Do not delay urgent revocation or containment to collect perfect evidence.
5. Revoke or disable the compromised credential at its issuing provider. For a credible compromise, do not keep the old credential active merely to create an overlap window.
6. Issue a replacement with the narrowest required permissions, install it through the approved secret store or OS-protected credential mechanism, and perform Section 10 verification.
7. Review provider audit events and downstream systems for use during the possible exposure window. Notify affected users or providers when action or coordination is required.

For active exploitation, suspected user-data access, a compromised release artifact or a signing identity, use the urgent containment path even if the full impact assessment is incomplete.

## 2. Handling rules

- Never paste a live or revoked secret, refresh token, private key, recovery code, certificate bundle, password or unredacted environment file into a GitHub issue, pull request, commit, chat, test fixture or CI log.
- Do not ask a reporter or user to send the credential itself. Ask for provider, credential type, approximate exposure time, affected account/project and a redacted identifier only when useful.
- Do not copy the application's userData directory, Vault contents, conversation database, prompts, customer workspace or unrelated personal files as incident evidence.
- Do not put secret values in shell arguments, terminal transcripts, screenshots, branch names or commit messages. Prefer provider consoles, OS credential stores and masked CI secret settings.
- Preserve original evidence unchanged, restrict it to named responders, and analyse a redacted working copy. Record why each item is needed and its approved deletion date.
- Rotation is not complete merely because a new value was issued. The old credential must be revoked, every known consumer updated, and the exact replacement path verified.
- Removing a visible file from public Git history does not revoke the secret or erase all copies. Revoke first; coordinate history cleanup separately and do not rewrite shared history without an approved plan.

## 3. Severity and response order

Select the highest applicable priority. Record the evidence and uncertainty; raise priority when scope is unknown and the credential has broad privileges.

| Priority | Examples | Initial handling target |
|---|---|---|
| P0 / Critical | Release-signing private key or publisher identity compromised; broad organisation/admin credential; active abuse; credible access to multiple users' data or production systems | Immediate containment, stop affected signing/release activity, maintainer escalation and provider coordination |
| P1 / High | Production API key with write/admin scope; GitHub token with repository or organisation write access; OAuth grant with sensitive account access; confirmed unauthorised use | Contain as soon as practicable; same-day scope and recovery plan |
| P2 / Moderate | Credential limited to one service, repository or non-production environment, with no evidence of broader access | Revoke and rotate promptly; target initial scope assessment within 2 business days |
| P3 / Low | Suspected exposure of a narrow, expired or strongly constrained credential, with no observed use | Validate expiry and residual access; target documented disposition within 5 business days |

These are proposed operational targets, not guaranteed response times or a contractual SLA. P0/P1 containment takes precedence over normal release work. Low confidence is not a reason to leave a powerful credential active.

## 4. Scope assessment

Build a credential inventory before or immediately after revocation. Record non-secret metadata only:

| Field | Required assessment |
|---|---|
| Incident identity | Private incident ID, discovery time in UTC, owner and reviewer |
| Credential identity | Type, provider, account/project, non-secret label or safe fingerprint |
| Exposure window | Earliest plausible exposure, last known safe time, discovery time and time zone |
| Privileges | Read/write/admin scopes, repositories, organisations, projects, environments and permitted operations |
| Consumers | Desktop app, local config, OS credential store, CI workflow, release runner, webhook, integration or operator workstation |
| Evidence | Provider audit-event IDs, request IDs, timestamps, source IP/device when available, and redacted log references |
| Impact | Reads, writes, settings changes, billing, deployment, release, package publication, signing, data access or unknown activity |
| Dependencies | Other credentials derived from, shared with, copied from or protected by the affected account |
| Recovery | Revocation result, replacement identity, updated consumers, verification evidence and residual risk |

Use provider audit and access history to identify first and last observed use, source locations, actions, failed attempts, newly authorised applications, permission changes and credentials created during the window. Check downstream resources the credential could reach, not only where it was stored.

Search only approved repositories, CI settings and operator-controlled systems. Use secret-scanning alerts or provider metadata where available; do not dump whole secret stores or scan unrelated personal files. Do not assume that a missing audit event proves there was no access. Record unavailable logs and resulting uncertainty.

Check for credential reuse. If one secret was copied into multiple environments, revoke the shared value and issue distinct replacements per environment. If a credential could create or reveal another credential, assess and rotate those downstream credentials too.

## 5. API key response

1. Identify provider, owning account/project, key label, permissions, restrictions, creation time and last-use metadata without revealing the key value.
2. Determine which app setting, local credential store, CI secret, deployment or operator workflow consumes it. Check for copies in public source, test fixtures, issues or logs.
3. At the provider, disable or delete the exposed key. Confirm provider-side revocation; deleting a local copy is not enough.
4. Create a replacement with minimum API scopes, resource restrictions, quota and environment access. Use separate development, test and production keys when supported.
5. Store the replacement only in the approved OS credential store, protected local settings path or masked CI secret facility. Update each inventoried consumer without printing the value.
6. Restart or reconnect each affected consumer and perform one harmless, narrowly scoped request.
7. Verify that the old key is rejected and review provider usage/audit data for unexpected calls during the exposure window.

Reapply necessary project, origin, IP, model, endpoint or quota restrictions to the replacement. Do not assume it inherits the old key's restrictions.

## 6. OAuth token and grant response

Treat access tokens, refresh tokens, device codes, client secrets and application grants as distinct credential material. Revoking one access token may not invalidate a refresh token, application grant or other sessions.

1. Identify provider, user/service account, client/application, grant, scopes, affected resource and token type. Record provider-side grant identifiers only when non-secret.
2. Revoke the exposed access token and refresh token through the provider's supported interface. Revoke the entire compromised application grant or user session when token-level revocation cannot bound exposure.
3. Review authorised applications, active sessions, device authorisations, newly added redirect URIs and scope changes. Remove unrecognised grants and invalidate associated sessions where appropriate.
4. Rotate any exposed client secret or signing material too. Revoking a bearer token is not the same as rotating the OAuth application's client credential.
5. Re-authorise through the normal consent flow using only required scopes. Confirm the replacement flow issues expected permissions without logging token contents.
6. Verify old access and refresh credentials are rejected, and inspect audit history for unexpected resource access or newly issued tokens.

Where per-token revocation is unavailable, document the limitation and use the broadest safe session/grant revocation. Notify the account owner before invalidating unrelated sessions when time and safety permit.

## 7. GitHub credential response

Identify the credential class before acting: fine-grained or classic personal access token (PAT), OAuth authorisation, GitHub App installation token, GitHub App private key, deploy key, webhook secret, Actions secret or runner credential. These have different revocation controls.

- **PAT:** revoke the exposed token from the owning account's developer settings. Review repositories, organisation access, permissions, expiry and recent use. Replace it with a fine-grained token limited to the minimum repositories and permissions where supported.
- **OAuth authorisation:** revoke the affected OAuth application authorisation or user grant, inspect scopes and account activity, and require fresh authorisation only if the application remains needed.
- **GitHub App:** revoke exposed installation/user tokens where supported. If the App private key is compromised, stop using it, generate a replacement through App settings, deploy it to protected storage, then delete the compromised key. Review permissions, installations, webhook configuration and activity.
- **Deploy key:** remove the exposed repository deploy key, check whether it had write access, and create a new unique key pair only when still required. Never reuse the exposed private key.
- **Webhook secret:** replace the secret at GitHub and the receiving service as a coordinated change. Verify signature validation with the new secret and reject deliveries signed only with the old value.
- **Actions and runners:** rotate affected Actions secrets and environment secrets, inspect workflow changes and recent runs, review self-hosted runner access and persistence, and pause compromised runners until rebuilt from a trusted image. A compromised runner may expose every secret available to its jobs.

Review repository and organisation audit logs for new collaborators, deploy keys, tokens, OAuth grants, workflow modifications, branch-protection changes, release/tag changes, package publication, altered secrets and unexpected API calls. Check private repositories and packages within the token's actual scope. Remove unauthorised access and preserve audit-event references.

Deleting a token from a local environment does not revoke it at GitHub. Never copy a replacement token into a workflow file or non-secret repository variable.

## 8. Release-signing credential response

Treat possible compromise of a signing private key, signing certificate, notarisation credential, release-publishing token or trusted build runner as P0 until impact is bounded.

1. Immediately pause signing and publication jobs that could use the affected identity. Restrict access to the release account, signing host, hardware token, CI environment and artifact repository.
2. Preserve the public certificate, key identifier, fingerprint, certificate chain, timestamp, affected artifact hashes, release/tag identities and CI/provider audit references. Never export or attach the private key as evidence.
3. Determine whether the private key, password/PIN, signing service token, notarisation credential or only a limited publishing token was exposed. Identify platforms and artifacts signed or published during the plausible exposure window.
4. Contact the relevant certificate authority, signing platform or provider through its verified incident/revocation procedure. Revoke or mark a certificate/key compromised when required by the issuer. Deleting a local key file does not invalidate signatures already made with it.
5. Generate a replacement signing identity in the strongest supported protected mechanism, preferably hardware-backed or managed signing. Update CI/operator access through approved secret storage; never commit private key material or put it in general-purpose logs.
6. Rebuild affected artifacts from a trusted source and builder, sign with the replacement identity, and independently verify exact produced files, signer identity, certificate chain and timestamps. Preserve SHA-256 hashes of affected and replacement artifacts.
7. Assess whether existing releases, update metadata, packages or download links must be withdrawn, quarantined, replaced or publicly explained. Coordinate with the issuer before making claims about certificate revocation or signature validity.
8. Resume signing only after a second maintainer reviews the new identity, secret distribution, build provenance and exact-artifact verification.

Apply platform-specific steps only when that mechanism is configured: macOS Developer ID/notarisation, Windows Authenticode, or a Linux signing mechanism such as cosign/GPG if one is in use. Do not describe an unsigned artifact as signed. An exposed upload token alone does not prove the source commit was compromised.

## 9. Replacement sequencing and dependency checks

For a compromised credential, revoke/disable the old value first, then provision the replacement; do not preserve an overlap window that leaves a known-compromised credential usable. For routine expiry rather than compromise, a short controlled overlap may be used only when the provider supports it and compromise is not suspected.

Before restoring service, confirm:

- The replacement has a distinct identity and minimum required permissions.
- Each known consumer points to the replacement and no stale copy remains in approved configuration locations.
- Secret values are masked in CI and absent from source, logs, screenshots, issue comments and test fixtures.
- Dependent tokens, app grants, webhook secrets, deploy keys, runner credentials and shared values have been assessed and rotated where needed.
- The old value is revoked at the issuer and its status is recorded.
- The credential owner and a second reviewer checked provider/account, scopes and the consumer inventory.

Never put a temporary credential into source control to restore service. If no secure storage route is available, keep the affected integration disabled.

## 10. Post-rotation verification

Verify the exact replacement path and real consumer configuration without revealing credential material.

1. **Old credential rejection:** use an approved protected test mechanism for a harmless request, or rely on authoritative provider revocation status when replay risks exposing the value. Record a redacted result. Never paste the old value into a command or test output.
2. **New credential acceptance:** perform a minimal read-only or otherwise harmless operation within intended scope. Verify provider/account identity and expected permission; do not use a destructive action as a test.
3. **Consumer recovery:** restart or reconnect the affected app, workflow, integration or release job. Confirm it reads the replacement from the intended secure store and no stale credential is cached.
4. **Least privilege:** compare actual scopes and resource access with the approved inventory. Confirm unrelated repositories, organisations, environments and user data remain inaccessible.
5. **Provider-side review:** inspect audit events after revocation for failed use of the old credential, unexpected use of the new one, new grants, permission changes and activity outside the expected source.
6. **Release-signing check:** for signing incidents, verify signer identity and certificate chain on each exact candidate artifact, compare file hashes with the release record, and confirm only the approved replacement identity is used.
7. **Regression and release gate:** add/update a regression check that contains no secrets, run focused tests and the required full-suite gate on the exact candidate SHA, and perform native platform verification when a release artifact or signing path is affected.

Record exact source SHA, artifact hashes where relevant, verification timestamp, operator, reviewer, tool outcome and skipped checks with reasons. A successful request alone does not prove old-credential revocation or least privilege.

## 11. Evidence preservation and privacy

Keep a restricted incident record under maintainer-controlled storage. Preserve only evidence needed to reconstruct access and response:

- UTC timeline, incident ID, affected provider/account and non-secret credential identifier.
- Provider audit-event/request IDs, status codes, timestamps and redacted activity summaries.
- Public repository/CI exposure location, commit SHA, workflow/run identifier and cleanup action.
- Revocation confirmation, replacement identifier, scope inventory and consumer-update checklist.
- Exact source SHA and artifact SHA-256 values for affected or replacement releases.
- Decision log, approvals, reviewer identity, notifications and residual-risk disposition.

For each evidence file, record source, capture time, byte size and SHA-256. Keep the original immutable and analyse a redacted copy. Restrict access to the incident owner and necessary reviewer; record access and transfer. Never store raw API keys, OAuth tokens, PATs, private signing keys, passwords or full secret-bearing environment dumps in the case record.

Do not request or preserve application user databases, Vault files, prompts, conversations or workspace archives unless a separate, explicit assessment establishes that a minimal sanitised item is necessary. Remove temporary copies when the approved retention period ends. Do not promise forensic erasure from backups, snapshots or SSD media.

## 12. Communication, recovery and closure

The incident owner maintains a private timeline and records containment decisions. Tell affected maintainers which integration or release path is paused, what action they must take, and how to verify recovery; never include the replacement secret. Notify users when their credential, account, data or update action may be affected. Coordinate provider or certificate-authority notifications through verified channels.

For coordinated vulnerability reporting, use the separate Security Intake and Coordinated Disclosure Runbook. Do not place sensitive incident details in a public issue or public PR before exposure is contained and a safe disclosure plan is agreed. If active exploitation requires a public warning, state only verified impact, affected versions, safe user actions and the next update; do not publish secrets or unnecessary exploit detail.

Close the incident only after recording:

- Credential type, provider, affected account/resources, exposure window and final severity.
- Revocation/disablement evidence for each compromised credential and the replacement identity.
- Completed consumer inventory, least-privilege review and post-rotation verification results.
- Audit-log review, suspected/confirmed unauthorised actions, notifications and provider coordination.
- Exact affected/fixed source SHAs and artifact hashes when code or release artifacts were involved.
- Residual risk, unavailable evidence, follow-up owner, due date and evidence-retention/deletion date.
- Owner and second-reviewer approval.

Keep the incident record minimal and access-restricted. Review this procedure after every P0/P1 event and update provider-specific steps only after verification against the provider's current controls.

This runbook describes a proposed manual process. It does not establish a contractual SLA, security-response staffing guarantee, bounty programme, legal safe harbour, automatic credential rotation or proof that any specific provider account is configured for these controls.
