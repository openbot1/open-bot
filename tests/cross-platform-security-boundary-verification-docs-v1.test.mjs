import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const runbook = fs.readFileSync(
  path.join(process.cwd(), 'docs', 'CROSS-PLATFORM-SECURITY-BOUNDARY-VERIFICATION.md'),
  'utf8',
);

test('pins the runbook to the reviewed remote main snapshot', () => {
  assert.ok(runbook.includes("2d14cc1b73c3f9fecb4b92614c180fb15a404aec"));
  assert.ok(runbook.includes("Windows, macOS and Linux"));
  assert.ok(runbook.includes("exact application source SHA"));
});

test('defines the product as local-first but not offline-only', () => {
  assert.ok(runbook.includes("local-first Electron desktop application, not an offline-only application"));
  assert.ok(runbook.includes("model providers, web tools, MCP servers, plugins, webhooks and integrations"));
  assert.ok(runbook.includes("external services"));
});

test('lists concrete repository implementation paths for all major boundaries', () => {
  for (const file of [
    "apps/desktop/src/main/preload.ts",
    "apps/desktop/src/main/ipcSenderGuard.ts",
    "packages/core/src/vault/vault.ts",
    "packages/core/src/composio/keyStore.ts",
    "packages/core/src/composio/sandboxV129.ts",
    "packages/core/src/routerV2/processManager.ts",
    "packages/core/src/providers/cli/process.ts",
    "packages/tools/src/plugins/sandbox.ts",
    "packages/core/src/egress/policy.ts",
    "packages/core/src/update/artifactTrust.ts",
    "apps/desktop/src/main/updateService.ts",
  ]) {
    assert.ok(runbook.includes(file), "missing repository implementation reference: " + file);
  }
});

test('states the same-user malware and compromised-OS threat-model limits', () => {
  assert.ok(runbook.includes("malware already running as that user"));
  assert.ok(runbook.includes("compromised OS/kernel"));
  assert.ok(runbook.includes("malicious extension with the same user's rights"));
});

test('requires exact source, artifact, OS and account identity before verification', () => {
  assert.ok(runbook.includes("full source commit SHA"));
  assert.ok(runbook.includes("artifact filename/hash"));
  assert.ok(runbook.includes("OS edition/release/build"));
  assert.ok(runbook.includes("logged-in OS account"));
  assert.ok(runbook.includes("test date/time in UTC"));
});

test('requires a disposable profile and redaction of secrets', () => {
  assert.ok(runbook.includes("dedicated non-administrator/non-root test account"));
  assert.ok(runbook.includes("disposable test profile and synthetic credentials"));
  assert.ok(runbook.includes("Do not export a Keychain/DPAPI/libsecret secret"));
  assert.ok(runbook.includes("dump Vault content"));
});

test('defines the renderer-preload-main IPC boundary', () => {
  assert.ok(runbook.includes("Only the intended primary renderer may invoke privileged IPC"));
  assert.ok(runbook.includes("window.openBot"));
  assert.ok(runbook.includes("ipcRenderer"));
  assert.ok(runbook.includes("top-level frame identity"));
});

test('requires IPC negative tests for hostile frames and WebContents', () => {
  assert.ok(runbook.includes("node --test tests/ipc-sender-validation-v144.test.mjs"));
  assert.ok(runbook.includes("untrusted URLs, missing/subframe sender frames"));
  assert.ok(runbook.includes("ERR_IPC_UNTRUSTED_SENDER"));
  assert.ok(runbook.includes("unexpected WebContents"));
});

test('documents the concrete Vault filenames and OS-backed backends', () => {
  assert.ok(runbook.includes("vault.json"));
  assert.ok(runbook.includes("vault.json.key"));
  assert.ok(runbook.includes("DPAPI on Windows"));
  assert.ok(runbook.includes("Keychain on macOS"));
  assert.ok(runbook.includes("libsecret on Linux"));
});

test('describes the fallback encryption mode and its weaker protection', () => {
  assert.ok(runbook.includes("AES-256-GCM"));
  assert.ok(runbook.includes("scrypt-derived key"));
  assert.ok(runbook.includes("weaker fallback"));
  assert.ok(runbook.includes("read both fallback files"));
});

test('provides concrete Windows filesystem ACL checks', () => {
  assert.ok(runbook.includes("icacls $VaultDir"));
  assert.ok(runbook.includes("icacls (Join-Path $VaultDir"));
  assert.ok(runbook.includes("unexpected access by broad principals"));
  assert.ok(runbook.includes("Get-CimInstance Win32_Process"));
});

test('provides concrete macOS filesystem, ACL and Keychain checks', () => {
  assert.ok(runbook.includes("stat -f"));
  assert.ok(runbook.includes('ls -ldeO "$VAULT_DIR"'));
  assert.ok(runbook.includes("security list-keychains -d user"));
  assert.ok(runbook.includes("Activity Monitor"));
});

test('provides concrete Linux filesystem and ACL checks', () => {
  assert.ok(runbook.includes("stat -c"));
  assert.ok(runbook.includes('getfacl -p "$VAULT_DIR"'));
  assert.ok(runbook.includes("normally mode"));
  assert.ok(runbook.includes("libsecret is unavailable or locked"));
});

test('requires Vault storage status to distinguish available and degraded modes', () => {
  assert.ok(runbook.includes("degraded"));
  assert.ok(runbook.includes("Do not label fallback encryption as an OS keychain"));
  assert.ok(runbook.includes("different macOS user or login profile"));
});

test('documents the Router V2 environment-filtering boundary', () => {
  assert.ok(runbook.includes("safeEnvForHookScript()"));
  assert.ok(runbook.includes("packages/core/src/routerV2/processManager.ts"));
  assert.ok(runbook.includes("no shell is inserted for the managed model process"));
});

test('documents POSIX process groups and Windows process-tree termination', () => {
  assert.ok(runbook.includes("separate POSIX process group"));
  assert.ok(runbook.includes("taskkill /T"));
  assert.ok(runbook.includes("confirm the process tree is gone"));
});

test('does not misrepresent the plugin worker process as an OS sandbox', () => {
  assert.ok(runbook.includes("A plugin worker is not a security boundary against malicious code"));
  assert.ok(runbook.includes("same OS user's authority"));
  assert.ok(runbook.includes("not a Windows AppContainer"));
  assert.ok(runbook.includes("macOS sandbox profile"));
  assert.ok(runbook.includes("Linux namespace/seccomp sandbox"));
});

test('requires process ancestry and orphan checks without exposing arguments', () => {
  assert.ok(runbook.includes("Record parent PID, child PID"));
  assert.ok(runbook.includes("Confirm the expected child process exits"));
  assert.ok(runbook.includes("whether any orphan remains"));
  assert.ok(runbook.includes("Do not record CommandLine or environment values"));
});

test('defines the egress policy default and private-destination restrictions', () => {
  assert.ok(runbook.includes("fail-closed when no usable policy is configured"));
  assert.ok(runbook.includes("allowlist with no remote hosts/IPs"));
  assert.ok(runbook.includes("private destinations disabled"));
  assert.ok(runbook.includes("local-service loopback explicitly allowed"));
});

test('requires existing egress regression coverage', () => {
  assert.ok(runbook.includes("node --test tests/egress-p02.test.mjs"));
  assert.ok(runbook.includes("injected DNS fixtures"));
  assert.ok(runbook.includes("not a live network test"));
});

test('documents the limits of app-level egress enforcement', () => {
  assert.ok(runbook.includes("not an OS firewall or a universal network monitor"));
  assert.ok(runbook.includes("opens a socket directly may be outside those app-level checks"));
  assert.ok(runbook.includes("not a complete shell parser"));
  assert.ok(runbook.includes("synchronous check does not resolve DNS"));
});

test('provides OS-specific active network connection inspection', () => {
  assert.ok(runbook.includes("Get-NetTCPConnection -State Established"));
  assert.ok(runbook.includes("lsof -nP -iTCP -iUDP"));
  assert.ok(runbook.includes("ss -tpn"));
  assert.ok(runbook.includes("Correlate PIDs with the process tree"));
});

test('anchors Composio project API key storage to the Vault namespace and key', () => {
  assert.ok(runbook.includes("Composio project API key is stored in the Vault namespace"));
  assert.ok(runbook.includes("does not return the key value to the UI"));
  assert.ok(runbook.includes("redacts it from Composio error messages"));
});

test('distinguishes Composio-managed OAuth from the local Vault key', () => {
  assert.ok(runbook.includes("OAuth tokens for individual Composio apps are managed on the Composio side"));
  assert.ok(runbook.includes("are not stored on this device"));
  assert.ok(runbook.includes("Do not query or export Composio-managed tokens"));
});

test('documents Composio conversation-level quotas and write defaults', () => {
  for (const term of [
    "200 calls",
    "5 concurrent jobs",
    "1,000 polls",
    "1,000,000 result bytes",
    "30-minute wall-clock limit",
    "allowWrite: false",
  ]) {
    assert.ok(runbook.includes(term), "missing Composio boundary limit: " + term);
  }
  assert.ok(runbook.includes("An empty allowed-toolkit list means all catalog toolkits are permitted"));
});

test('requires Composio sandbox regression checks and safe live verification', () => {
  assert.ok(runbook.includes("node --test tests/composio-v129-sandbox.test.mjs"));
  assert.ok(runbook.includes("mock/pure-policy regression check"));
  assert.ok(runbook.includes("approved read-only toolkit action"));
  assert.ok(runbook.includes("Do not issue a real write/delete action"));
});

test('documents the current updater check-only and manual-install behaviour', () => {
  assert.ok(runbook.includes("does not download and install updates in-app"));
  assert.ok(runbook.includes("installed: false"));
  assert.ok(runbook.includes("manual download/install"));
  assert.ok(runbook.includes("Do not promise silent, automatic or forced in-app installation"));
});

test('distinguishes feed metadata consistency from native artifact verification', () => {
  assert.ok(runbook.includes("canonical repository/release URLs"));
  assert.ok(runbook.includes("GitHub-provided SHA-256 metadata"));
  assert.ok(runbook.includes("does not download artifact bytes"));
  assert.ok(runbook.includes("not independent proof of publisher identity"));
});

test('specifies native Windows Authenticode verification', () => {
  assert.ok(runbook.includes("Get-AuthenticodeSignature -LiteralPath"));
  assert.ok(runbook.includes("signer subject, thumbprint and timestamp"));
  assert.ok(runbook.includes("maintainer-approved identity"));
});

test('specifies native macOS signing and Gatekeeper verification', () => {
  assert.ok(runbook.includes("codesign --verify --deep --strict --verbose=2"));
  assert.ok(runbook.includes("spctl --assess --type execute --verbose=4"));
  assert.ok(runbook.includes("Notarisation must be verified separately"));
});

test('specifies Linux AppImage digest verification and unsigned status', () => {
  assert.ok(runbook.includes("sha256sum"));
  assert.ok(runbook.includes("current AppImage is unsigned"));
  assert.ok(runbook.includes("checksum alone does not authenticate the publisher"));
});

test('requires native OS build and regression verification', () => {
  assert.ok(runbook.includes("Node.js version used for verification"));
  assert.ok(runbook.includes("Run the source regression checks after the repository build on each native OS"));
  assert.ok(runbook.includes("a check from another OS is not native platform evidence"));
});

test('defines severity priorities for cross-platform boundary failures', () => {
  for (const priority of ["P0 / Critical", "P1 / High", "P2 / Moderate", "P3 / Low"]) {
    assert.ok(runbook.includes(priority), "missing severity priority: " + priority);
  }
  assert.ok(runbook.includes("These are proposed operational priorities, not a contractual SLA"));
});

test('defines immediate containment and credential revocation steps', () => {
  assert.ok(runbook.includes("Stop the affected run, automation, plugin/MCP worker or release job"));
  assert.ok(runbook.includes("Disable the affected integration or pause distribution"));
  assert.ok(runbook.includes("Revoke/rotate any credential that may have been read"));
  assert.ok(runbook.includes("Resume only after the affected boundary is fixed or mitigated"));
});

test('preserves Vault and fallback evidence without destructive recovery', () => {
  assert.ok(runbook.includes("do not delete, recreate, rotate or migrate the only copy"));
  assert.ok(runbook.includes("vault.json"));
  assert.ok(runbook.includes("restore only a known matching pair on a disposable copy first"));
});

test('defines the evidence record for each platform and boundary', () => {
  for (const term of [
    "full source SHA",
    "OS edition/release/build",
    "PASS/FAIL/NOT RUN classification",
    "owner, mode/ACL and relevant access principals",
    "PID/parent PID/executable identity",
    "Network destination/IP/port",
    "Artifact signer identity/status",
    "residual risk, owner and follow-up date",
  ]) {
    assert.ok(runbook.includes(term), "missing evidence field: " + term);
  }
  assert.ok(runbook.includes("capture time, byte size and SHA-256"));
});

test('prohibits retaining raw credentials and private user data as evidence', () => {
  assert.ok(runbook.includes("Do not attach raw Vault files, machine keys"));
  assert.ok(runbook.includes("OAuth tokens, API keys, private signing keys"));
  assert.ok(runbook.includes("user databases, prompts, conversations or workspace archives"));
});

test('requires exact-SHA native checks, independent review and honest closure status', () => {
  assert.ok(runbook.includes("Identified the exact source SHA and installed artifact"));
  assert.ok(runbook.includes("Completed the applicable native OS checks"));
  assert.ok(runbook.includes("a skipped test or a mock-only result is not a native pass"));
  assert.ok(runbook.includes("Close a platform result as PASS, FAIL or NOT VERIFIED"));
  assert.ok(runbook.includes("Do not report a universal cross-platform PASS"));
});

test('states explicit limits on sandboxing, egress, updater and same-user malware', () => {
  assert.ok(runbook.includes("does not claim OS-level sandboxing for plugins"));
  assert.ok(runbook.includes("universal egress enforcement"));
  assert.ok(runbook.includes("protection from malware running as the same OS user"));
});
