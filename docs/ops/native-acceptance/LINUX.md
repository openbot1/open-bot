# Linux Native Acceptance Packet

**Status:** PROCEDURE ONLY — Linux acceptance is NOT RUN until evidence is collected on the exact candidate artifact.

## 1. Current target and prerequisites

The repository's current desktop packaging target is an AppImage for Linux x64. Re-check the candidate builder configuration and supported runtime requirements before execution.

Record distribution and release (/etc/os-release), kernel (uname -a), architecture (uname -m), desktop environment/display server, hardware/VM status, test account privilege level, candidate source SHA, root app version, AppImage filename, byte size, source URL and SHA-256. Record FUSE/runtime prerequisites and any distribution-specific dependencies.

## 2. Artifact identity and trust boundary

1. Obtain the AppImage from the approved release location or label it explicitly as a local/source build.
2. Compute SHA-256 on the exact AppImage and compare it with the frozen candidate manifest.
3. Record executable permissions, file metadata and download provenance.
4. The current release configuration does not code-sign the Linux AppImage. Record signature status as UNSIGNED / NOT PROVIDED; do not describe SHA-256 as a publisher signature.
5. Record any desktop trust or execution warning. Do not disable host security controls or run the application as root to bypass an execution/permission failure.

If artifact identity cannot be tied to the candidate SHA, mark BLOCKED. If the release policy requires a publisher signature and none is supplied, record the policy failure explicitly.

## 3. Clean install and first launch

1. Use a fresh disposable Linux user profile; do not copy existing open-bot userData, Vault or credentials.
2. Verify the AppImage checksum, set only the required executable permission and launch as the test user.
3. Follow the distribution's documented FUSE/runtime requirements. Record missing FUSE, library or permission errors; do not silently install untracked dependencies or run as root.
4. Confirm the main window becomes usable without a persistent blank window, crash dialog or startup error.
5. Record displayed app version and externally attested candidate SHA. If the app does not display the SHA, mark runtime SHA display NOT RUN.
6. Confirm the clean Electron userData location, normally ~/.config/open-bot. Record metadata only; do not expose settings or secrets.
7. Open Settings, verify basic navigation, quit normally and relaunch to confirm the clean profile persists.

## 4. Upgrade and data preservation

Use a separate disposable profile seeded by the approved previous Linux release. Record previous artifact identity and a non-secret fixture inventory.

1. Install and launch the previous approved AppImage; create harmless conversations/workspace data and configure only disposable credentials.
2. Quit normally and back up the disposable profile using the approved backup procedure. Record the backup SHA-256 and non-secret inventory.
3. Launch the candidate AppImage using the documented upgrade process without deleting userData.
4. Verify expected settings, conversations, workspace references and supported migrations.
5. Verify Vault entries through the supported UI without exposing secret values. Record any degraded storage backend and consent behavior accurately.
6. Record data loss, migration warnings, database errors, stale locks or unexpected reset.
7. Rehearse rollback only with disposable data and the approved procedure; record old/new artifact identities and verify restored data.

A new AppImage launching successfully does not prove upgrade or data preservation.

## 5. Provider and integration acceptance

Use dedicated test credentials and harmless requests.

- Verify each configured API provider independently with a minimal text request. Record provider ID, model, timestamp and sanitized result.
- For Ollama, record local endpoint availability and exact installed model; a fallback catalogue or unavailable service is not a successful live inference.
- Exercise optional Composio/connected-app paths only with explicit owner approval. Start with read-only discovery; remote write actions require separate approval for the disposable target.
- Verify missing/invalid disposable credentials fail safely without leaking secrets.
- Do not infer Linux acceptance from mocks, CI tests, or another OS's provider result.

## 6. Runtime, shutdown and recovery

1. Perform at least three full stop/start cycles; record launch timestamps, process IDs and readiness.
2. Run a minimum 30-minute idle soak and 30-minute controlled-activity soak unless the release owner specifies a longer period. Record CPU, memory, process count, open handles where available and app-owned listening ports.
3. Close the main window and verify the expected last-window behavior for the current Linux build.
4. Explicitly quit the application and verify the main process and app-owned child processes exit. Check that app-owned listeners are released and no orphan remains.
5. Relaunch and verify the same disposable profile recovers without corruption, stale lock or unexplained state loss.
6. Preserve sanitized startup, runtime and shutdown logs with exact timestamps and evidence references.

Do not invent a resource threshold or shutdown timeout. If the release owner has not specified one, record the measured result and mark the threshold-dependent criterion BLOCKED.

## 7. Linux result and reviewer record

| Check | Result (PASS / FAIL / BLOCKED / NOT RUN) | Evidence reference |
|---|---|---|
| Candidate SHA and AppImage SHA-256 | NOT RUN | |
| AppImage signature status / unsigned limitation | NOT RUN | |
| Clean install and first launch | NOT RUN | |
| Upgrade and data preservation | NOT RUN | |
| Provider/integration acceptance | NOT RUN | |
| Runtime soak and lifecycle | NOT RUN | |
| Graceful shutdown and recovery | NOT RUN | |

Distribution/version:  
Kernel:  
Architecture:  
Operator:  
Execution timestamp/timezone:  
Independent reviewer:  
Reviewer decision and date:  
Exceptions and disposition:

**No PASS may be recorded until the exact Linux x64 candidate artifact has been executed and evidence independently reviewed.**
