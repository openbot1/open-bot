# Cross-platform Security Boundary Verification Runbook

Reviewed repository base snapshot: 2d14cc1b73c3f9fecb4b92614c180fb15a404aec.

This runbook defines how an operator verifies the security boundaries that open-bot actually implements on Windows, macOS and Linux. It covers Electron renderer-to-main IPC, local files and Vault storage, child processes and plugins, outbound network access, Composio credentials/permissions and release/update artifacts.

open-bot is a local-first Electron desktop application, not an offline-only application. User-selected model providers, web tools, MCP servers, plugins, webhooks and integrations can send data to external services. A check is valid only for the exact application source SHA, installed artifact, OS version, user account and configuration recorded with the evidence.

This is an operator procedure, not a certification, penetration test, guarantee of OS isolation or claim that every boundary has been verified on every platform.

## 1. What counts as a security boundary

A boundary is a place where data or authority crosses between components with different trust or privilege. For this repository, verify these concrete boundaries:

| Boundary | What must be protected | Relevant implementation on the reviewed snapshot |
|---|---|---|
| Renderer to Electron main | Only the intended primary renderer may invoke privileged IPC; untrusted frames/navigation must be rejected | `apps/desktop/src/main/preload.ts`, `apps/desktop/src/main/ipcSenderGuard.ts`; IPC regression coverage in `tests/ipc-sender-validation-v144.test.mjs` |
| Filesystem and local state | Vault ciphertext, fallback key, settings and workspace data must not be exposed through overly broad OS permissions or unsafe paths | `packages/core/src/vault/vault.ts`; production handling notes in `docs/PRODUCTION-SECURITY.md` |
| Credential storage | OS-backed encryption status must be distinguished from the weaker local fallback; secret values must not leak into UI, IPC or logs | Electron `safeStorage` adapter and `LocalEncryptor` in `packages/core/src/vault/vault.ts`; Composio key handling in `packages/core/src/composio/keyStore.ts` |
| Child process and plugin execution | Child processes receive only intended environment/arguments and are terminated with their process tree; a separate process must not be mistaken for an OS sandbox | `packages/core/src/routerV2/processManager.ts`, `packages/core/src/providers/cli/process.ts`, `packages/tools/src/plugins/sandbox.ts` |
| Outbound network | Application-integrated network paths apply the configured egress rules; local/private/metadata destinations are not accidentally exposed | `packages/core/src/egress/policy.ts`, `docs/egress-policy.md`; related regression coverage in `tests/egress-p02.test.mjs` |
| Composio integration | The user's Composio API key remains in Vault; toolkit, write, call, job and result limits are enforced by the conversation-level policy | `packages/core/src/composio/keyStore.ts`, `packages/core/src/composio/sandboxV129.ts`; tests in `tests/composio-v129-sandbox.test.mjs` |
| Release/update trust | A release-feed entry must match the canonical repository/tag/assets, and each downloaded artifact must be verified separately on its native OS | `packages/core/src/update/artifactTrust.ts`, `apps/desktop/src/main/updateService.ts`, `docs/TESTING.md` |

The threat model assumes the user controls the OS account and device. It does not protect against malware already running as that user, a compromised OS/kernel, an administrator/root attacker, a compromised provider or a malicious extension with the same user's rights.

## 2. Common preparation for every platform

1. Record the full source commit SHA, application version, artifact filename/hash, OS edition/release/build, architecture, Node.js version used for verification, Electron version, logged-in OS account and test date/time in UTC.
2. Use a dedicated non-administrator/non-root test account where possible. Do not run the desktop application elevated for routine verification.
3. Use a disposable test profile and synthetic credentials. Never run boundary-failure or permission tests against the only copy of real user data.
4. Resolve the actual Electron `userData` directory from the running application's configuration or trusted operator record. Do not guess a path from an app display name or copy another platform's path.
5. Record whether Vault reports `available`, `degraded` or `unavailable`. Do not label fallback encryption as an OS keychain.
6. Capture configuration and command output with secret values redacted. Do not export a Keychain/DPAPI/libsecret secret, print environment values, dump Vault content or include tokens in process command lines.
7. Run the source regression checks after the repository build on each native OS. A test of pure logic, a GitHub matrix declaration or a check from another OS is not native platform evidence.

## 3. Renderer, preload and IPC boundary

### Expected boundary

The preload exposes the intended `window.openBot` application bridge; it must not expose raw `ipcRenderer`, Node APIs or credential values to the renderer. The main-process sender guard checks the sender WebContents identity, renderer URL and top-level frame identity. A matching URL alone is not sufficient. A rejected invocation uses `ERR_IPC_UNTRUSTED_SENDER`.

### Verification steps

1. Review the exact candidate source for `apps/desktop/src/main/preload.ts` and `apps/desktop/src/main/ipcSenderGuard.ts`. Confirm that the renderer API remains narrow and that privileged IPC handlers pass through the guarded registration helpers.
2. Build the application on the target OS, then run `node --test tests/ipc-sender-validation-v144.test.mjs`. This test covers untrusted URLs, missing/subframe sender frames, destroyed windows/WebContents and the guarded IPC registrations in `main.ts`.
3. With a disposable development profile, load the intended packaged renderer and confirm normal application IPC succeeds.
4. In an isolated test harness or controlled development session, attempt IPC from a remote navigation, an unexpected WebContents and an iframe. Each privileged invocation must reject; capture the error code and renderer/frame metadata without recording user content.
5. Confirm an unexpected navigation cannot keep privileged IPC access after the trusted renderer is replaced or destroyed.

Do not probe a live user's application by injecting scripts into a production session. Do not treat a test of the pure sender-guard helper as proof that every real handler registration or packaged renderer is correct; inspect the handler wiring and run the existing registration test.

## 4. Filesystem, Vault and credential-store boundaries

### Repository facts to preserve

The Vault store is `vault.json`. Electron `safeStorage` uses the OS-backed facility documented for this code: DPAPI on Windows, Keychain on macOS and libsecret on Linux. When `safeStorage` is unavailable, `LocalEncryptor` is a weaker fallback using AES-256-GCM and a scrypt-derived key from a separate machine-key file, normally `vault.json.key`, with restrictive file permissions. Anyone who can read both fallback files may be able to decrypt the Vault.

The Composio project API key is stored in the Vault namespace `provider` under key `composio`. The key store exposes configured/not-configured state rather than returning the key to the UI. OAuth tokens for individual Composio apps are managed by Composio and are not stored on this device according to the repository's integration notes. Do not claim they are protected by the local Vault.

### Windows

1. Resolve the actual Vault directory for the signed-in application user. Inspect the directory and any existing `vault.json` / `vault.json.key` files; do not create missing files for the purpose of this check.
2. Run PowerShell:
   ```powershell
   $VaultDir = '<resolved-userData-directory>'
   icacls $VaultDir
   if (Test-Path (Join-Path $VaultDir 'vault.json')) {
     icacls (Join-Path $VaultDir 'vault.json')
   }
   if (Test-Path (Join-Path $VaultDir 'vault.json.key')) {
     icacls (Join-Path $VaultDir 'vault.json.key')
   }
   Get-Item (Join-Path $VaultDir 'vault.json') -ErrorAction SilentlyContinue |
     Select-Object Name,Length,LastWriteTime
   ```
3. Review the ACL for unexpected access by broad principals or other user accounts. Record the relevant principal names and allow/deny rights, not file contents. Do not weaken inherited ACLs as part of a rehearsal.
4. Verify the application reports the intended `safeStorage` status while running as the expected Windows account. If it is degraded/unavailable, record that fact and evaluate the fallback key's ACL separately.
5. Inspect the process tree with `Get-CimInstance Win32_Process` or Task Manager. Record PID, parent PID and image name only; do not export full command lines or environment blocks because they may contain secrets.
6. For an installer, verify the exact `.exe` with `Get-AuthenticodeSignature -LiteralPath '<artifact.exe>'`; record status, signer subject, thumbprint and timestamp. A valid signature must still be checked against the maintainer-approved publisher identity.

### macOS

1. Resolve the actual Vault directory for the signed-in macOS user. Inspect only metadata for existing Vault files.
2. Run:
   ```sh
   VAULT_DIR='<resolved-userData-directory>'
   stat -f '%Sp %Su:%Sg %N' "$VAULT_DIR"
   [ ! -e "$VAULT_DIR/vault.json" ] || stat -f '%Sp %Su:%Sg %N' "$VAULT_DIR/vault.json"
   [ ! -e "$VAULT_DIR/vault.json.key" ] || stat -f '%Sp %Su:%Sg %N' "$VAULT_DIR/vault.json.key"
   ls -ldeO "$VAULT_DIR"
   security list-keychains -d user
   ```
3. Confirm the Vault directory and fallback key are not readable by unintended users and review any unexpected ACL entries or file flags. Record permissions and owner only; do not run commands that reveal password/keychain item values or export keychain contents.
4. Verify the app's reported `safeStorage` status under the same login/keychain session used for normal operation. A different macOS user or login profile may not be able to decrypt OS-backed ciphertext.
5. Inspect process ancestry with Activity Monitor or `ps -o pid=,ppid=,uid=,comm= -p <pid>`. Do not capture full arguments if they may include secrets.
6. Verify the exact `.dmg` / app using `codesign --verify --deep --strict --verbose=2 '<app-or-binary>'` and `spctl --assess --type execute --verbose=4 '<app-or-binary>'`. Record signing identity and Gatekeeper result. Notarisation must be verified separately for the exact release artifact.

### Linux

1. Resolve the actual Vault directory for the logged-in desktop user. Inspect metadata and ACLs for files that exist.
2. Run:
   ```sh
   VAULT_DIR='<resolved-userData-directory>'
   stat -c '%A %a %U:%G %n' "$VAULT_DIR"
   [ ! -e "$VAULT_DIR/vault.json" ] || stat -c '%A %a %U:%G %n' "$VAULT_DIR/vault.json"
   [ ! -e "$VAULT_DIR/vault.json.key" ] || stat -c '%A %a %U:%G %n' "$VAULT_DIR/vault.json.key"
   getfacl -p "$VAULT_DIR"
   ```
3. Confirm the fallback machine-key file, if present, is restricted to the intended user (normally mode `0600`) and the parent directory does not allow unintended users to replace or read it. Record owner, mode and ACL; never cat the key or Vault.
4. Verify the app's reported `safeStorage` status under the actual desktop session/keyring. If libsecret is unavailable or locked and the app enters fallback/degraded mode, record it and apply the project's fallback policy. Do not describe fallback as equivalent to libsecret.
5. Inspect process ancestry with `ps -o pid,ppid,uid,comm -p <pid>` and `pstree -ap <pid>` when available. Avoid full command-line capture where arguments could contain secrets.
6. Verify the exact AppImage hash using `sha256sum '<artifact.AppImage>'` and compare it with a trusted, independently obtained release digest. The current production security notes state Linux AppImage is not GPG-signed; a checksum alone does not authenticate the publisher.

## 5. Process and plugin boundary

### Expected boundary and limitation

Router V2 starts its managed process with an environment produced by `safeEnvForHookScript()`. The CLI process helper uses a separate POSIX process group and uses `taskkill /T` on Windows to stop a process tree. The plugin host in `packages/tools/src/plugins/sandbox.ts` forks a worker process with heap/time/restart limits.

A plugin worker is not a security boundary against malicious code: it runs with the same OS user's authority and may access files or open sockets available to that user. The process split improves lifecycle/fault handling; it is not a Windows AppContainer, macOS sandbox profile, Linux namespace/seccomp sandbox or separate OS account. Egress policy likewise does not constrain arbitrary sockets opened by a process outside the integrated app paths.

### Verification steps on each OS

1. Start only a known, reviewed CLI/plugin in a disposable profile. Record parent PID, child PID, executable path, OS account and start/stop timestamps.
2. Review `packages/core/src/routerV2/processManager.ts` and `packages/core/src/providers/cli/process.ts` on the exact SHA. Confirm the configured environment filtering function is used, no shell is inserted for the managed model process, and the platform-specific termination path is present.
3. Inspect process ancestry with the commands in Section 4. Do not collect environment-variable values or full process arguments.
4. Stop the run, dispose the plugin host and exit the app. Confirm the expected child process exits. On POSIX, confirm the process group is gone; on Windows, confirm the process tree is gone. A surviving child is a containment failure.
5. Repeat with an intentionally non-responsive test worker only in a disposable profile. Confirm the documented timeout/restart/kill path, and record whether any orphan remains.
6. For every third-party plugin/MCP command, separately review package origin, version, manifest permissions, executable path and credential exposure. Do not infer isolation from the word "sandbox" in a class or UI label.

### Platform-specific process inspection

- Windows: use Task Manager's Details tab or `Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name`; use `tasklist /FI "PID eq <pid>"` to confirm the process is gone after stop. Do not record CommandLine or environment values.
- macOS: use Activity Monitor or `ps -o pid=,ppid=,uid=,comm= -p <pid>`; confirm the child PID exits after stop.
- Linux: use `ps -o pid,ppid,uid,comm -p <pid>` and `pstree -ap <pid>` if installed; confirm the relevant process group and child PID exit.

## 6. Network and egress boundary

### Expected boundary and limitation

The repository's egress policy is fail-closed when no usable policy is configured. The default policy is an allowlist with no remote hosts/IPs, private destinations disabled, local-service loopback explicitly allowed and fail-closed enabled. Agent-context localhost/LAN/metadata targets are blocked unless an explicit reviewed exception applies.

The policy is wired into specific application paths, including shell/network tools and HTTP tools. It is not an OS firewall or a universal network monitor. A plugin, MCP server, child process or other code that opens a socket directly may be outside those app-level checks. The shell target extractor is a heuristic, not a complete shell parser, and the synchronous check does not resolve DNS.

### Verification steps

1. Record the effective egress policy for the tested profile with secrets removed. Confirm `enabled`, `mode`, `allowHosts`, `allowIpRanges`, `allowPrivateDestinations`, `allowLocalServices` and `failClosed`.
2. Run `node --test tests/egress-p02.test.mjs` after the required build. This exercises policy logic with injected DNS fixtures; it is not a live network test.
3. In a controlled test profile, verify that an unlisted public host, loopback/LAN host, link-local address and metadata destination are blocked in agent context; verify that an explicitly intended local provider uses the documented `local-service` context.
4. Verify that a missing/invalid policy fails closed on the relevant path. Do not turn off `failClosed` merely to make a test pass or hide DNS errors.
5. During a harmless, approved integration test, inspect active network connections for the app and its children:
   - Windows: `Get-NetTCPConnection -State Established | Select-Object OwningProcess,LocalAddress,LocalPort,RemoteAddress,RemotePort`.
   - macOS: `lsof -nP -iTCP -iUDP`.
   - Linux: `ss -tpn`.
   Correlate PIDs with the process tree; compare destinations with the intended provider/MCP/Composio endpoint list. Do not capture payloads, tokens or unrelated user traffic.
6. Treat any unexpected destination as a triage item. Establish whether it came from an app-integrated path, a plugin/MCP child or unrelated OS activity before attributing it to open-bot.

## 7. Composio credential and permission boundary

The user's Composio project API key is stored in Vault under namespace `provider`, key `composio`. The repository key store does not return the key value to the UI and redacts it from Composio error messages. OAuth tokens for individual Composio apps are managed on the Composio side, not held in this local Vault according to the repository integration notes.

The Composio v1.29 conversation boundary is application-level policy, not an OS process or network sandbox. Its defaults include 200 calls, 5 concurrent jobs, 1,000 polls, 1,000,000 result bytes, a 30-minute wall-clock limit and `allowWrite: false`. Denied toolkits override allowed toolkits. An empty allowed-toolkit list means all catalog toolkits are permitted, so do not interpret an empty list as "deny all".

Verification:

1. Confirm Composio is disabled when not intentionally configured, and that the API key is marked configured without exposing its value.
2. Verify the key resides only in the Vault-backed path; never copy it into settings exports, screenshots, issue comments, command-line arguments or logs.
3. Inspect the effective conversation binding, allowed/denied toolkit lists, write permission, quotas, expiry and audit history. Confirm denied entries win over allowed entries and writes remain disabled unless explicitly approved for that conversation.
4. Run `node --test tests/composio-v129-sandbox.test.mjs` after the required core build. This is a mock/pure-policy regression check, not proof of a live Composio account's server-side OAuth settings.
5. In a controlled live account, verify only an approved read-only toolkit action and inspect the resulting audit record. Do not issue a real write/delete action just to prove that the write guard works.
6. Confirm no OAuth access/refresh token for a managed Composio app appears in local files, IPC payloads, process arguments or logs. Do not query or export Composio-managed tokens.

## 8. Updater and release-artifact boundary

The current `UpdateService` checks release feeds and exposes availability/status; it does not download and install updates in-app. `quitAndInstallUpdate()` reports `installed: false` until a real download/install mechanism exists. User instructions must therefore describe manual download/install when that is the actual release path.

`verifyGitHubReleaseArtifactMetadata()` checks canonical repository/release URLs, tag metadata, uploaded asset state/name/size and GitHub-provided SHA-256 metadata. It does not download artifact bytes, recompute SHA-256, verify Authenticode/code signatures or prove publisher identity. Native release checks remain separate.

For each platform, verify the exact release candidate:

- Windows: check the installer with `Get-AuthenticodeSignature -LiteralPath '<installer.exe>'`; record status, signer subject, thumbprint and timestamp; compare the signer with the maintainer-approved identity.
- macOS: run `codesign --verify --deep --strict --verbose=2` and `spctl --assess --type execute --verbose=4` against the exact app/binary; separately verify notarisation/stapling for the exact release item.
- Linux: run `sha256sum` on the exact AppImage and compare with a trusted release digest. Record accurately that the current AppImage is unsigned if no signing mechanism has been added.

On every platform, tie the artifact filename, platform, architecture, byte size and SHA-256 to the release tag and exact source SHA. A digest served by the same feed is a consistency signal, not independent proof of publisher identity. Never install an artifact solely because the URL looks official.

## 9. Severity, containment and escalation

Use the highest credible severity until scope is understood. These are proposed operational priorities, not a contractual SLA.

| Priority | Boundary failure | Immediate handling |
|---|---|---|
| P0 / Critical | Active exploitation; privileged IPC reachable from an untrusted frame; Vault/credential compromise; signing or update-chain compromise; broad unintended data egress | Stop affected operation/release path immediately; isolate the test/device if exfiltration may continue; revoke exposed credentials; pause distribution; escalate to authorised maintainer and incident owner |
| P1 / High | Reproducible access-control failure on one platform; child process retains access after stop; unexpected secret in process/log/IPC; egress policy bypass on an integrated path | Disable affected plugin/MCP/integration or feature path; preserve minimal evidence; restrict account/device access; start a security patch and affected-platform verification |
| P2 / Moderate | ACL/permission drift, degraded Vault backend, unexpected but bounded connection, or platform-specific verification gap without demonstrated exploitation | Restrict use of affected profile/credential; correct configuration; record owner and due date; repeat native check |
| P3 / Low | Documentation mismatch, non-security telemetry/diagnostic gap or defence-in-depth inconsistency with no demonstrated access path | Record and schedule remediation; reassess if new evidence changes reachability or impact |

Containment order:

1. Stop the affected run, automation, plugin/MCP worker or release job. If network exfiltration may be active, disconnect the test device from untrusted networks where operationally safe.
2. Disable the affected integration or pause distribution; do not destroy files or wipe the Vault during initial triage.
3. Revoke/rotate any credential that may have been read, at the issuing provider. Do not wait for a full forensic conclusion.
4. Preserve the minimum evidence in Section 10, restrict access and use redacted working copies.
5. Escalate P0/P1 to the authorised maintainer and incident owner. Coordinate with the provider, certificate authority or Composio where their credential/service is involved.
6. Resume only after the affected boundary is fixed or mitigated, the exact candidate is verified on the affected native OS, the independent reviewer accepts the evidence and the authorised maintainer approves.

If the failure involves Vault decryption or possible key mismatch, do not delete, recreate, rotate or migrate the only copy. Preserve `vault.json`, `vault.json.key` if present, backups, permissions and timestamps; restore only a known matching pair on a disposable copy first.

## 10. Evidence record

For every platform and boundary, record:

- Full source SHA, product version, artifact name/hash, OS edition/release/build, architecture, account context and verification timestamp in UTC.
- Boundary under test, threat/precondition, expected result, actual result and PASS/FAIL/NOT RUN classification.
- Exact command/test name, tool version, exit status and a redacted output excerpt or protected log reference.
- Filesystem path category, owner, mode/ACL and relevant access principals; never include file contents or secret values.
- Vault status (`available`/`degraded`/`unavailable`), OS-backed/fallback mode, and existence/metadata of `vault.json` / `vault.json.key`; never include ciphertext, machine key or decrypted values.
- IPC renderer/frame identity metadata and error code, with no prompt/message content.
- Process PID/parent PID/executable identity, account, start/stop times and orphan result; no full environment block or secret-bearing arguments.
- Network destination/IP/port, owning PID, policy decision/context and whether the path was expected; no packet payloads or unrelated traffic.
- Composio toolkit/binding decision, write permission, quota/audit result and whether the test was mock or live; no API key or OAuth token.
- Artifact signer identity/status, release tag, source SHA, byte size, digest and native verification result.
- Incident priority, containment action, approver, escalation/notification references, residual risk, owner and follow-up date.

For retained evidence files, record capture time, byte size and SHA-256. Keep originals unchanged, restrict access to named responders and analyse redacted copies. Do not attach raw Vault files, machine keys, OAuth tokens, API keys, private signing keys, user databases, prompts, conversations or workspace archives to public tickets or PRs.

## 11. Pass criteria and closure

A platform boundary is verified only when the operator has:

1. Identified the exact source SHA and installed artifact under test.
2. Completed the applicable native OS checks for filesystem/credential storage, process lifecycle, network path and release trust.
3. Recorded the expected and observed result for each relevant IPC, plugin/Composio and updater check.
4. Confirmed no unexplained secret exposure, broad file access, orphan process or unexpected network destination remains.
5. Recorded all unavailable checks as NOT RUN with a reason and residual risk; a skipped test or a mock-only result is not a native pass.
6. Obtained an independent review and authorised maintainer disposition for every P0/P1 or unresolved P2 finding.

Close a platform result as PASS, FAIL or NOT VERIFIED. Do not report a universal cross-platform PASS if any OS, architecture or relevant artifact was not tested. After a fix, repeat the failed check on the exact fixed SHA and the native OS; retain both the failure evidence and the post-fix record.

This runbook documents verification of the controls present in the reviewed repository snapshot. It does not claim OS-level sandboxing for plugins, universal egress enforcement, automatic update installation, hardware-backed Vault storage on every device, or protection from malware running as the same OS user.
