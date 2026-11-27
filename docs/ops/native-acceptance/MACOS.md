# macOS Native Acceptance Packet

**Status:** PROCEDURE ONLY — macOS acceptance is NOT RUN until evidence is collected on the exact candidate artifact.

## 1. Current target and prerequisites

The repository's current desktop packaging target is a DMG for macOS arm64 and x64. Re-check the candidate builder configuration and actual artifact architecture before execution.

Record macOS version/build (for example, sw_vers), hardware architecture (uname -m), hardware/VM status, test account privilege level, candidate source SHA, root app version, DMG filename, byte size, source URL and SHA-256. Test each release-supported architecture separately; do not infer Apple Silicon acceptance from an Intel run or vice versa.

## 2. Artifact identity, signing and notarization

1. Obtain the DMG from the approved release location or explicitly label it as a local/source build.
2. Compute and record SHA-256 for the exact DMG before mounting it.
3. Inspect the app bundle's Developer ID signature and record the full verification output, signing identity, Team ID, certificate chain and designated requirement where available.
4. Verify notarization/stapling status for the exact artifact/app bundle using the approved Apple tooling. Preserve the full sanitized command output.
5. Assess Gatekeeper using the normal OS policy (for example, spctl --assess --type execute --verbose=4 /Applications/open-bot.app after copying to the test location). Record the exact result.
6. Record first-launch quarantine/Gatekeeper prompts exactly as shown.

Do not disable Gatekeeper, remove quarantine attributes, ad-hoc re-sign the bundle, or use an alternate copy to obtain a passing result. A configured notarization requirement is not proof that this artifact was notarized. A successful DMG mount is not proof of signature or Gatekeeper acceptance.

If signature, notarization or Gatekeeper assessment fails or is unavailable, record FAIL or BLOCKED under the release policy and retain the original evidence.

## 3. Clean install and first launch

1. Use a fresh disposable macOS user profile; do not import existing open-bot userData, Vault or credentials.
2. Mount the exact DMG, verify the expected app bundle and copy it to the intended test location.
3. Launch as the test user without bypassing security prompts. Record any Gatekeeper, privacy, accessibility or permission prompt.
4. Confirm the main window becomes usable without a persistent blank window, crash dialog or startup error.
5. Record displayed app version and externally attested candidate SHA. If the app does not display the SHA, record runtime SHA display as NOT RUN.
6. Confirm the clean Electron userData location, normally ~/Library/Application Support/open-bot. Record metadata only; do not expose secrets.
7. Open Settings, verify basic navigation, quit using the application menu or Cmd+Q, then relaunch and verify the profile remains usable.

## 4. Upgrade and data preservation

Use a separate disposable profile seeded by the approved previous macOS release. Record previous version, artifact identity and non-secret fixture inventory.

1. Install and launch the previous approved DMG; create harmless test conversations/workspace data and configure only disposable credentials.
2. Quit the app and back up the disposable profile using the approved procedure. Record backup SHA-256 and inventory without including secret values.
3. Install the candidate DMG using the supported upgrade procedure without deleting userData.
4. Launch the candidate and verify expected non-secret settings, conversation history, workspace references and supported migrations.
5. Verify Vault entries through the supported UI without exposing secret values. Inspect only the minimum metadata needed to confirm no plaintext leakage.
6. Record migration warnings, data loss, duplicate records, database/lock errors or unexpected reset.
7. Rehearse rollback only with disposable data and the approved rollback procedure; verify restored data and record both artifact identities.

Installer replacement alone is not evidence that user data survived.

## 5. Provider and integration acceptance

Use dedicated test accounts and credentials entered only through the supported settings/Vault flow.

- Test each configured provider separately with a harmless text request; record provider ID, selected model, timestamp and sanitized outcome.
- If Ollama is included, verify the local service and exact installed model on this Mac. Do not treat a fallback model catalogue as a successful inference.
- Test Composio or connected-app integration only with explicit owner authorization. Read-only discovery may be tested first; remote writes require a separate approval naming the disposable target and operation.
- Verify safe handling of missing/invalid test credentials without exposing real secrets.
- Mock tests and live results from Windows/Linux do not establish macOS provider acceptance.

## 6. Runtime, window lifecycle, shutdown and recovery

1. Perform at least three full stop/start cycles; record timestamps, process IDs and readiness.
2. Run a minimum 30-minute idle soak and 30-minute controlled-activity soak unless the release owner specifies a longer duration. Record CPU, memory, process count, open handles and app-owned listeners where available.
3. Close the last window and record whether the app remains available for reactivation. This is distinct from application termination.
4. Use the application menu's Quit command or Cmd+Q. Verify the main process exits and app-owned child processes/listeners are cleaned up.
5. Reopen the app through the Dock or Applications folder and verify the same disposable profile recovers without stale locks or data loss.
6. Preserve sanitized startup, runtime and shutdown logs, timestamps and evidence references.

Do not mark shutdown PASS merely because the last window disappeared. Do not invent resource or timeout thresholds; missing owner-defined thresholds make the corresponding criterion BLOCKED.

## 7. macOS result and reviewer record

| Check | Result (PASS / FAIL / BLOCKED / NOT RUN) | Evidence reference |
|---|---|---|
| Candidate SHA and DMG SHA-256 | NOT RUN | |
| Bundle signature and signing identity | NOT RUN | |
| Notarization/stapling | NOT RUN | |
| Gatekeeper assessment | NOT RUN | |
| Clean install and first launch | NOT RUN | |
| Upgrade and data preservation | NOT RUN | |
| Provider/integration acceptance | NOT RUN | |
| Runtime soak, Quit and recovery | NOT RUN | |

Hardware architecture:  
Operator:  
Execution timestamp/timezone:  
Independent reviewer:  
Reviewer decision and date:  
Exceptions and disposition:

**No PASS may be recorded until the exact macOS candidate artifact and architecture have been executed and evidence independently reviewed.**
