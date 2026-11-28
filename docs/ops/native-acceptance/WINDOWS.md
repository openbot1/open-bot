# Windows Native Acceptance Packet

**Status:** PROCEDURE ONLY — Windows acceptance is NOT RUN until evidence is collected on the exact candidate artifact.

## 1. Current target and prerequisites

The repository's current desktop packaging target is an NSIS installer for Windows x64. Re-check the candidate builder configuration before execution; a target declaration is not evidence of a published installer or a successful Windows run.

Record Windows edition, version and OS build (for example, from winver), CPU architecture, hardware/VM status, available disk space, test account privilege level, candidate source SHA, root app version, installer filename, byte size, source URL and SHA-256. Use a fresh disposable standard-user profile where practical.

## 2. Artifact identity and signing

1. Download the installer only from the approved release location, or label it explicitly as a local/source build.
2. Compute SHA-256 on the exact installer file and compare it with the frozen candidate manifest.
3. Inspect the Authenticode signature and record signer/publisher, signature status, timestamp/certificate chain and verification tool output.
4. Record SmartScreen, Defender, UAC or other OS trust prompts exactly as displayed.
5. Do not bypass an unexpected publisher warning, disable security controls, or mark signing PASS because the installer launched.

If the installer is unsigned, has an invalid signature, or the publisher identity does not match the approved release identity, record FAIL or BLOCKED according to the release policy. Do not infer signing from the NSIS package format.

## 3. Clean install and first launch

1. Start with a fresh disposable Windows user profile; do not copy existing open-bot userData or Vault data.
2. Install the exact NSIS x64 artifact as the test user. Record install path, prompts, exit status and timestamps.
3. Launch open-bot from the installed Start Menu/desktop entry. Confirm the main window becomes usable and no persistent blank window, crash dialog or startup error occurs.
4. Record the displayed app version and relate it to the externally attested candidate SHA. If the app does not display the SHA, record runtime SHA display as NOT RUN; do not guess.
5. Confirm the clean profile is created under the expected Electron userData location, normally %APPDATA%/open-bot. Record only metadata; do not expose settings or secrets.
6. Open Settings and verify basic navigation. Confirm no prior conversations, provider credentials, workspace state or Vault entries were imported.
7. Quit normally, relaunch once, and verify the profile remains usable.

Record each step, expected and actual result, timestamp, sanitized logs and evidence reference.

## 4. Upgrade and data preservation

Use a separate disposable profile seeded by the approved previous release. Record the previous app version, source/artifact identity and data fixture inventory before upgrade.

1. Install and launch the previous approved Windows release; create harmless test conversations and workspace data and configure only disposable credentials.
2. Close the app normally and back up the disposable profile using the documented backup procedure. Hash the backup and record the inventory without copying secrets into the evidence packet.
3. Install the candidate NSIS artifact using the documented upgrade path. Do not uninstall or delete userData unless the supported upgrade procedure explicitly requires it.
4. Launch the candidate and verify expected non-secret settings, conversations, workspace references and supported migrations.
5. Confirm Vault entries remain available through the supported UI without displaying or exporting secret values. Check that secrets are not exposed in plaintext in logs or evidence.
6. Record migration warnings, data loss, duplicate records, lock/database errors or unexpected resets.
7. Rehearse rollback only with a disposable profile and the approved rollback instructions. Verify restored data and record the exact old/new artifact identities.

A successful installer exit is not proof of data preservation. Any unexplained loss or migration error is FAIL and keeps the platform packet from PASS.

## 5. Provider and integration acceptance

Use a dedicated test account and test credentials stored through the application's supported settings/Vault flow. Redact all keys and tokens.

- Verify each configured API provider independently with a harmless text request and record provider ID, model, timestamp, sanitized outcome and error category.
- If Ollama is in scope, record local service state, endpoint and exact installed model; unavailable local service is BLOCKED/NOT RUN, not PASS.
- Verify optional Composio or other connected-app integrations only when explicitly authorized. Start with read-only discovery; external write actions require separate approval naming the disposable target.
- Verify an unconfigured provider fails with an actionable, secret-safe error where the negative case can be performed safely.
- Do not treat mocked provider tests, shared transport unit tests or another OS's live request as Windows native acceptance.

## 6. Runtime, shutdown and recovery

On the same candidate installation and profile:

1. Perform at least three full stop/start cycles and record launch timestamps, process IDs and readiness.
2. Perform a minimum 30-minute idle soak and a minimum 30-minute controlled-activity soak unless the release owner specifies a longer period. Record CPU, memory, process count, open handles where available and app-owned listeners at start, intervals and end.
3. Test window close separately from explicit application Quit. On Windows, verify the expected last-window behavior and confirm the main process exits after Quit.
4. Inspect the process tree after exit; verify no orphaned app-owned child process or stale listener remains.
5. Relaunch and confirm the disposable profile opens without corruption, stale lock or unexplained state loss.
6. Record sanitized startup, runtime and shutdown logs, exact timestamps, observations and evidence references.

Do not invent resource or shutdown thresholds. If the release owner has not specified a threshold, record the measurement and mark threshold-dependent acceptance BLOCKED.

## 7. Windows result and reviewer record

| Check | Result (PASS / FAIL / BLOCKED / NOT RUN) | Evidence reference |
|---|---|---|
| Candidate SHA and installer SHA-256 | NOT RUN | |
| Authenticode publisher/signature | NOT RUN | |
| Clean install and first launch | NOT RUN | |
| Upgrade and data preservation | NOT RUN | |
| Provider/integration acceptance | NOT RUN | |
| Runtime soak and lifecycle | NOT RUN | |
| Graceful shutdown and recovery | NOT RUN | |

Operator:  
Execution timestamp/timezone:  
Independent reviewer:  
Reviewer decision and date:  
Exceptions and disposition:

**No PASS may be recorded until the exact Windows candidate artifact has been executed and evidence independently reviewed.**
