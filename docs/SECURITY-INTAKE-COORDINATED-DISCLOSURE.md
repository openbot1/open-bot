# Security Intake and Coordinated Disclosure Runbook

This runbook defines a private, maintainer-operated process for receiving, triaging and coordinating reports of security vulnerabilities in open-bot. It is designed for a local-first project and does not require a hosted ticketing system, third-party intake vendor, telemetry or collection of end-user application data.

## 1. Contact channel and current repository status

The reviewed repository snapshot is `2d14cc1b73c3f9fecb4b92614c180fb15a404aec`. At this snapshot there is no root or `.github/SECURITY.md`, no `CONTRIBUTING.md`, and no published security email or dedicated disclosure address in the repository documentation. Do not invent or publish an email address on behalf of the maintainers.

Use this channel order:

1. **Preferred:** on the repository's GitHub **Security** tab, use **Report a vulnerability** / Private Vulnerability Reporting only when that private reporting feature is enabled for this repository. Confirm that the submission is private before entering technical details.
2. **Fallback when private reporting is unavailable:** contact the repository maintainer through a private contact method actually displayed on the maintainer's GitHub profile, if one is available. The public maintainer profile is https://github.com/openbot1; do not assume it exposes a private inbox or email.
3. **Last-resort channel discovery:** if no private route is available, create a minimal public issue titled `Security contact request` containing no vulnerability name, affected component, exploit details, logs, credentials or personal data. Ask only for a private reporting route. Move technical discussion off the public issue before sharing any details.

Never submit an unpatched vulnerability, proof-of-concept, crash dump, credential, customer record or exploit steps in a public issue, pull request, discussion or commit. A public issue is not a secure intake channel. The maintainer should add a verified private contact route to a future `SECURITY.md` only after deciding and confirming that route.

## 2. Scope and safe-reporting expectations

Accept reports about the open-bot application, its repository code, release artifacts and project-controlled build/release processes. Ask the reporter to test only systems and data they own or are explicitly authorised to assess.

Do not request or encourage destructive testing, denial of service, persistence, lateral movement, access to another person's workspace, collection of real user data, credential harvesting or exfiltration. A minimal proof using a disposable profile, synthetic credential and local fixture is preferred. Stop testing once impact is demonstrated.

Do not promise legal safe-harbor protection, bug-bounty payment or immunity from third-party terms. The maintainer can acknowledge good-faith, authorised research and commit to evaluating it responsibly, but legal assurances require explicit project/legal approval.

## 3. What to include in a private report

Ask for only the minimum information needed to reproduce and assess the issue:

- A short, non-sensitive summary and the affected security boundary/component.
- Product version, exact source commit SHA if known, OS/platform and architecture.
- Preconditions, configuration required and the smallest reproducible steps.
- Expected versus observed security impact; attacker prerequisites and affected trust boundary.
- A proof-of-concept using synthetic data, or a concise description when sharing code would create additional risk.
- Whether the issue is known to be exploited, has been publicly disclosed, or affects other products.
- A safe workaround or mitigation, if known.
- A contact method, preferred update cadence, disclosure/embargo preference and credit preference (name, pseudonym or anonymous).

Do not ask the reporter to send API keys, OAuth tokens, signing credentials, real prompts/conversations, user databases, workspace archives, customer information or unredacted logs. If evidence is needed, request a minimal sanitized excerpt with synthetic identifiers.

## 4. Intake acknowledgement and ownership

The maintainer receiving the report assigns an opaque case ID such as `SEC-YYYY-NNN`, records the received UTC timestamp and confirms that the report is in a private channel. Restrict access to the maintainer(s) needed for triage and remediation; do not mirror the report into a public issue or broad team channel.

Acknowledge receipt within **2 business days** as an operating target. The acknowledgement should confirm receipt and privacy handling, state the next expected update, and avoid prematurely confirming exploitability or severity. Assign one maintainer as case owner and one technical reviewer where available. If the report is outside project scope, explain that promptly without requesting more sensitive data.

## 5. Initial triage and severity

Target an initial reproducibility and scope assessment within **5 business days**. Record the exact affected versions/commits, supported platforms, prerequisites, trust boundary and whether the problem is reachable in a default configuration. If the issue is actively exploited or could expose credentials/data or compromise a released build, escalate immediately rather than waiting for the normal triage window.

Use CVSS as a consistency aid, not as the sole decision. Consider impact, attack vector, privileges and user interaction together with real product exposure, exploit preconditions, reachability, default settings, required permissions, platform differences and available mitigations.

| Priority | Typical indicators | Handling target |
|---|---|---|
| P0 / Critical | Active exploitation; unauthenticated remote code execution; broad credential/data compromise; compromise of release signing or distribution | Same-day maintainer escalation and containment decision; target a verified fix or mitigation within 7 calendar days where feasible |
| P1 / High | Serious privilege boundary bypass, exploitable local/remote code execution, sensitive-data access or release-chain weakness with credible reachability | Target fix or mitigation within 14 calendar days |
| P2 / Moderate | Meaningful security impact with constrained prerequisites, scope or exposure | Target fix within 30 calendar days |
| P3 / Low | Limited impact, difficult exploitation or defence-in-depth weakness without a demonstrated practical path | Target fix or documented disposition within 90 calendar days |

These are proposed project operating targets, not an existing contractual SLA. Record the selected priority, rationale, confidence and reviewer; revise the rating when new evidence changes impact or reachability. If reproduction is not possible, use **UNCONFIRMED** rather than asserting that the report is invalid.

## 6. Coordinated disclosure timeline and embargo

Use **90 calendar days from the initial private report** as the default coordinated-disclosure window. This is a planning target, not a demand that the reporter remain silent regardless of circumstances.

- Acknowledge within 2 business days and provide the initial triage outcome/next steps within 5 business days where feasible.
- Send a private status update at least every **7 calendar days**, even when there is no material change. Explain blockers and the next planned update.
- Aim to provide the reporter with a remediation or mitigation plan and a proposed disclosure date as soon as scope is understood.
- Give the reporter at least **14 calendar days' notice** of the intended public advisory/release date where the fix and coordination timeline permit.
- If a fix cannot be safely delivered by day 90, explain why and agree a specific, time-bounded extension with the reporter where possible. Set a new review date; do not silently extend an embargo indefinitely.
- Do not delay urgent containment to preserve an embargo. For active exploitation or imminent harm, prioritise mitigation, credential rotation, release disablement or other containment and coordinate the minimum safe public notice.

An embargo is a coordination request, not a mechanism to suppress legitimate safety warnings. Do not disclose the reporter's identity, private report, proof-of-concept or unpatched technical details without consent, except where disclosure is legally required or necessary to address immediate harm; seek appropriate review first.

## 7. Investigation, evidence and local handling

Keep a restricted case record under maintainer-controlled local storage. No external case-management, analytics, telemetry or evidence-upload service is required. Use encrypted storage and OS account permissions; grant access only to named case handlers. Store the case ID and status separately from technical evidence.

Preserve the original report and any necessary evidence before analysis. Record capture time, source, byte size and SHA-256 for evidence files. Keep originals unchanged; analyse copies. Use synthetic fixtures wherever possible and redact credentials, user identifiers, paths and unrelated data from working copies. Never copy application userData, Vault files, memory databases, prompts or customer workspaces merely to make a report reproducible.

Do not paste report details into commit messages, branch names, test names, public CI logs or source comments. Use the opaque case ID in private tracking references. Keep access and evidence handling history. Delete temporary working copies when the case closes and the approved retention period expires; preserve only the minimum record required by the project's applicable policy. Do not promise forensic erasure from backups or SSDs.

## 8. Remediation and verification coordination

The case owner coordinates a fix with a minimal, private-by-default engineering scope. Do not expose the vulnerability in a public PR title, branch or test fixture before a fix is available. Use a restricted/private repository or access-limited review path when the hosting plan supports it; otherwise coordinate a safe publication sequence with the reporter and maintainer before opening a public PR.

The remediation record must identify affected and fixed source SHAs, versions, platforms, the security boundary changed, regression tests, and any residual limitations. Verify the fix on the exact candidate commit. Run focused regression tests and the required full-suite gate; perform platform-specific checks where relevant. For release-chain or installer findings, rebuild and verify the exact affected artifacts. A source patch without evidence on the released platform is not a completed remediation.

If the report is not reproducible or is not considered a vulnerability, record the technical basis, versions and assumptions, have a second maintainer review where available, and privately explain the decision to the reporter. Do not publish the report or reporter's materials simply because the case is closed.

## 9. Reporter communication templates

### Receipt acknowledgement

```text
Subject: [SECURITY] Report received — <case-id>

Thank you for reporting this privately. We have recorded the report as <case-id> and limited access to the maintainers handling triage. Receipt does not yet confirm severity or exploitability.

Our target is to provide an initial assessment or next-step update within 5 business days. Please do not send credentials, real user data or unredacted application archives. We will contact you through this private channel if a minimal additional detail is needed.
```

### Progress update

```text
Subject: [SECURITY] Status update — <case-id>

Status: <investigating / confirmed / remediation in progress / verification / closed>
Current assessment: <brief, non-sensitive summary>
Work completed: <summary>
Next action and owner: <action>
Next update target: <UTC date>
Disclosure plan: <current target date or reason a revised date is being discussed>

We will notify you before any public advisory where coordination permits. Please tell us promptly if the issue becomes publicly known or exploitation is observed.
```

### Public security advisory / release note

```text
Title: Security update for open-bot <affected version range>

Summary: <sanitized impact statement>
Affected versions/platforms: <verified scope>
Fixed versions: <verified versions>
Mitigation: <safe workaround, if any>
Severity: <priority and rationale>
Acknowledgement: <reporter credit exactly as approved, or omitted>
References: <public fixed commit / release / advisory links>
```

Do not include exploit instructions, private evidence, secrets, personal information or unpatched implementation details in the public notice.

## 10. Reporter credit and disclosure consent

Ask explicitly whether the reporter wants public credit, and in what form: their chosen name, pseudonym, organisation (only with authority) or anonymous. Record the exact approved wording and obtain consent before publication. Do not infer consent from sending a report or participating in remediation. Do not publish contact details, employer, profile links or report contents unless separately approved.

The maintainer may acknowledge the report in the advisory or release notes after the fix is public. No payment, bounty or guaranteed recognition is promised by this runbook.

## 11. If the reporter discloses publicly before the agreed date

1. Do not reprimand, threaten or expose the reporter. Preserve a copy of the public statement and its timestamp, but do not redistribute exploit details unnecessarily.
2. Contact the reporter privately through the established case channel. Confirm what is public, whether a usable proof-of-concept exists and whether active exploitation is known. Do not ask them to remove truthful safety information as a condition of receiving a response.
3. Reassess severity and urgency immediately. If a working exploit or active exploitation creates imminent risk, prioritise containment, credential rotation where relevant, a verified patch and a concise user warning.
4. Ask platforms/hosts to restrict credentials, personal data or weaponised details only where appropriate and under their policies. Do not attempt to erase legitimate reporting or claim that a redacted copy removes the original.
5. Publish a factual status notice when user action is needed. State affected versions, safe mitigations and the next update; avoid unverified claims, sensitive technical details and reporter identity without consent.
6. Coordinate a revised advisory date with the reporter where possible. If coordination is no longer possible, publish once users can act on accurate mitigation guidance, and document why the original embargo ended.

A public disclosure changes the risk and communications plan; it does not remove the duty to validate, remediate and communicate accurately.

## 12. Closure checklist

Close a case only after recording: final disposition and severity; affected/fixed versions and SHAs; remediation and regression evidence or the reason no fix is warranted; any mitigation and residual risk; disclosure date and public reference (or reason for no disclosure); reporter credit consent; outstanding third-party coordination; and evidence-retention/deletion date.

Keep the private case record minimal and access-restricted. Do not include user application data that was not necessary to establish the vulnerability. Review this process after each P0/P1 case and update the contact route only after it has been verified by the maintainer.

This runbook defines a proposed manual process. It does not establish a published security contact, private-reporting feature availability, legal safe harbor, bounty program, contractual SLA or automatic vulnerability intake system.
