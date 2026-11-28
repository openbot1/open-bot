# Clean Install & First-Run Verification Runbook

Reviewed repository base snapshot: 2d14cc1b73c3f9fecb4b92614c180fb15a404aec.

This runbook verifies a clean installation and first launch of the existing open-bot Electron desktop application on Windows, macOS and Linux. It is an operator procedure, not a claim that a release artifact currently exists or that any platform has already passed.

## 1. Scope and acceptance rule

Verify the exact source commit, release version, downloaded artifact, operating-system build, installation method and user account. Keep the three outcomes separate: PASS means the check was performed and met its criterion; FAIL means it was performed and did not; NOT RUN means no evidence was collected. A package target or a successful build is not proof of a native first-run test.

The application is local-first, not offline-only. A provider, MCP server, plugin, webhook, Composio integration or other user-selected external service may receive data when configured and used. Do not enter production credentials into an untrusted test machine.

## 2. Requirements and preflight

- Supported host families for this procedure: Windows x64, macOS arm64/x64, and Linux x64. The checked-in electron-builder targets are Windows NSIS x64, macOS DMG arm64/x64, and Linux AppImage x64.
- Development/source setup requires Node.js 24+ and npm. Check with `node --version` and `npm --version`.
- For a source-based clean install, use a fresh checkout of the exact candidate SHA and run `npm ci` from the repository root. Do not substitute `npm install` when reproducing the lockfile-defined install.
- For a release-artifact test, obtain the artifact from the approved release location and record its URL, release tag, filename, byte size and SHA-256 before installation. Do not treat a locally built artifact as a published release.
- Confirm adequate disk space, a supported OS build, a non-admin standard user where practical, and a disposable test profile. Record whether the host is physical or virtual.
- Do not copy an existing open-bot userData directory, Vault, settings, workspace or credentials into the clean profile.

Record the candidate root `package.json` version and confirm the release tag/version relationship against the exact candidate commit. The root `version` field is the product version source; workspace and lockfile versions are synchronized metadata.

## 3. Platform-specific installation

### Windows

1. Record Windows edition, version and build from Settings → System → About or `winver`.
2. Verify the downloaded installer is the NSIS x64 artifact intended for the recorded release. Record its SHA-256 before launch.
3. Install as the test user. Record the installer publisher/signature status shown by Windows; do not bypass an unexpected publisher or signature warning.
4. Launch open-bot from the installed application entry. Record any SmartScreen, Defender, permission or first-launch prompt exactly as displayed.
5. Confirm the application opens and can be exited normally. Do not infer successful signing merely because installation completed.

### macOS

1. Record macOS version/build and hardware architecture using `sw_vers` and `uname -m`.
2. Verify the downloaded DMG filename, architecture, release tag and SHA-256.
3. Mount the DMG and inspect the app's signing/notarization status before first launch. For example, use `spctl --assess --type execute --verbose=4 /Applications/open-bot.app` after copying it to the test location; capture the complete result.
4. Record Gatekeeper prompts. Do not disable Gatekeeper or remove quarantine attributes to make a failed verification appear successful.
5. Launch the app as the test user, then quit normally. A configured notarization target is not evidence that this particular artifact was notarized.

### Linux

1. Record distribution, release, kernel and architecture using `cat /etc/os-release`, `uname -a` and `uname -m`.
2. Verify the downloaded AppImage filename, release tag and SHA-256. The checked-in Linux target is AppImage x64.
3. Run the AppImage as the test user, following the distribution's documented FUSE/runtime requirements. Record any dependency or permission failure; do not run the application as root to work around it.
4. The current release configuration does not code-sign the Linux AppImage. Record that limitation; do not describe a matching SHA-256 as a publisher signature.
5. Launch, inspect the first-run window and quit normally.

## 4. First launch and clean profile

- Confirm the application starts without an uncaught startup error, blank window or repeated crash. Record the exact displayed version and candidate SHA from the test manifest; if the UI does not expose the SHA, keep it as externally attested build metadata and mark runtime SHA display NOT RUN.
- Confirm the app creates/uses its own OS-specific Electron userData location. The documented locations are Linux `~/.config/open-bot`, macOS `~/Library/Application Support/open-bot`, and Windows `%APPDATA%/open-bot`.
- Confirm a fresh profile does not contain copied settings, prior conversation history, prior provider keys or a pre-existing `vault.json`. Do not dump file contents or secrets into evidence.
- Confirm the first-run UI is usable and Settings can be opened. Do not assume a seeded sample bot exists; the repository removed the automatic sample-bot seed to avoid surprising users.
- Close the app cleanly and relaunch once. Record whether the new profile and settings persist without importing data from another account.

## 5. Vault initialization and secret handling

The desktop main process initializes the Vault at `<userData>/vault.json` and passes Electron `safeStorage` into the core Vault adapter. On Windows this uses DPAPI, on macOS the Keychain, and on Linux libsecret when available. The core package itself does not import Electron.

- Open Settings → Vault and record the reported storage status and active backend without recording secret values.
- When OS-backed encryption is available, confirm the status is reported as available and that a disposable test credential can be saved and retrieved through the supported UI.
- If OS-backed encryption is unavailable, record the degraded/fallback status and exact consent/write policy shown by the app. Do not silently treat the local machine-key fallback as equivalent to the OS keychain; do not proceed with persistent secret storage without the required explicit consent.
- Confirm a test secret is not present in plaintext in `vault.json`, logs, screenshots or exported diagnostics. Inspect only metadata/encoding needed to establish that the stored value is ciphertext; never paste the file contents into a ticket.
- Remove the disposable test credential through the UI after verification. Do not delete or recreate the Vault to force a green result.

## 6. Provider, Ollama and CLI detection

### Cloud/API providers

1. Open Settings → Providers. A clean install may have no configured API key.
2. Configure only a disposable test key for a provider the operator is authorized to use. Verify the UI reports whether a key is set without echoing the key value.
3. Use the provider's built-in test action only if the operator explicitly approves an outbound request. Record provider id, endpoint host, timestamp and outcome, not request bodies or credentials.
4. Remove the disposable key after the test. Do not claim that provider connectivity was verified if no approved live request was made.

### Ollama

1. Ollama is an optional local provider and needs no API key. Its default OpenAI-compatible base URL is `http://localhost:11434/v1`; the default model id is `llama3.1`.
2. If Ollama is installed and running, record `ollama --version`, the locally available model names and whether the app can reach the configured local endpoint.
3. If Ollama is absent or stopped, record NOT CONFIGURED or NOT RUN as appropriate. Do not treat a failed local connection as a cloud-provider failure.

### Detected CLI agents

- The repository contains CLI-provider drivers and a CLI-agent detector. Detection is a local binary-availability check; it is not proof that the CLI is logged in, that a subscription is valid, or that a model request will succeed.
- Record which supported binaries the app detects and their reported versions, if exposed. Do not inspect another CLI's auth/session files or copy its credentials into open-bot.
- Obtain explicit user consent before enabling or invoking a detected CLI agent. Verify only a harmless, approved test action; record NOT RUN when no binary, login or consent is available.
- A detected CLI runs with the current OS user's privileges. A separate process is not an OS sandbox.

## 7. Evidence package

For every platform, retain a dated evidence record containing:

- Candidate source commit SHA, root product version, release tag and artifact filename.
- Artifact download source, byte size and SHA-256; signature/notarization result where the platform configuration supports it.
- OS edition/version/build, architecture, host type, account privilege level and installation steps.
- Node.js/npm versions and `npm ci` result only for a source-based install.
- First-launch, clean userData and relaunch observations.
- Vault status/backend and consent state, with no secret values or raw Vault contents.
- Provider/Ollama/CLI checks, explicit outbound-consent state and PASS/FAIL/NOT RUN result.
- Screenshots with secrets, personal data, tokens, email addresses and sensitive paths redacted.
- Operator, UTC timestamp, exact commands, exit codes, logs with secrets removed, deviations and follow-up owner.

Store evidence in the approved restricted project location. Do not attach credentials, raw `vault.json`, OAuth stores, provider request payloads or unredacted environment dumps.

## 8. Failure handling and escalation

- **P0 / immediate containment:** suspected credential disclosure, plaintext secret persistence, cross-user data exposure, or an installer that executes unexpected code. Stop testing, disconnect the host from external networks when safe, revoke exposed test credentials, preserve a restricted evidence copy and notify the security owner immediately.
- **P1 / release blocker:** wrong artifact/source identity, signature or notarization failure where required, startup crash, Vault unable to protect or recover secrets, or reproducible first-run data loss. Stop distribution of the affected artifact and escalate to the release owner.
- **P2 / platform blocker:** OS-specific install/runtime failure, missing dependency, provider/Ollama/CLI detection regression or unusable first-run path without evidence of secret exposure. Hold that platform's acceptance and file a reproducible report.
- **P3 / non-blocking issue:** cosmetic or documentation mismatch with a safe workaround. Record owner and target follow-up; do not silently omit it.

Do not disable OS protections, weaken Vault policy, run as administrator/root, or reuse production credentials to make a check pass. Resume only after the owner approves the mitigation and the affected check is repeated against the exact artifact.

## 9. Completion decision

A platform is accepted only when required installation, first-launch, userData and Vault checks have recorded PASS evidence for the exact artifact. Provider, Ollama and CLI checks may be NOT CONFIGURED/NOT RUN when the dependency is intentionally absent, but must not be reported as passed. Report Windows, macOS and Linux separately. A successful result on one OS does not certify another OS.

This runbook does not claim that a release artifact is currently published, that every provider is reachable, that CLI authentication is valid, or that all three native operating systems have been tested.
