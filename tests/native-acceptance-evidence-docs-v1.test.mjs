import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.readFileSync(
  path.join(here, '..', 'docs', 'ops', 'NATIVE-ACCEPTANCE-EVIDENCE.md'),
  'utf8',
);
const windows = fs.readFileSync(
  path.join(here, '..', 'docs', 'ops', 'native-acceptance', 'WINDOWS.md'),
  'utf8',
);
const macos = fs.readFileSync(
  path.join(here, '..', 'docs', 'ops', 'native-acceptance', 'MACOS.md'),
  'utf8',
);
const linux = fs.readFileSync(
  path.join(here, '..', 'docs', 'ops', 'native-acceptance', 'LINUX.md'),
  'utf8',
);

test('the master runbook identifies slice 4 and preserves HOLD', () => {
  assert.ok(root.includes('Release Candidate & Go-Live Evidence — Slice 4/5'));
  assert.ok(root.includes('Release decision remains **HOLD**.'));
  assert.ok(root.includes('Only the release owner may record the final GO/HOLD decision'));
  assert.ok(root.includes('This slice defines what evidence must be collected; it does not approve a release.'));
});

test('the platform matrix matches the current package targets', () => {
  assert.ok(root.includes('Windows'));
  assert.ok(root.includes('NSIS installer'));
  assert.ok(root.includes('macOS'));
  assert.ok(root.includes('DMG'));
  assert.ok(root.includes('arm64 and x64'));
  assert.ok(root.includes('Linux'));
  assert.ok(root.includes('AppImage'));
  assert.ok(root.includes('Current configuration does not code-sign the AppImage'));
});

test('candidate and artifact identity are mandatory', () => {
  assert.ok(root.includes('Full source commit SHA'));
  assert.ok(root.includes('Root product version'));
  assert.ok(root.includes('Artifact filename, package format, byte size, download/source URL and SHA-256.'));
  assert.ok(root.includes('OS name, edition/distribution, version and exact build'));
  assert.ok(root.includes('Compute SHA-256 from the actual file that will be installed.'));
  assert.ok(root.includes('mark artifact identity BLOCKED'));
});

test('the evidence sequence is ordered and complete', () => {
  assert.ok(root.includes('1. **Lock candidate identity.**'));
  assert.ok(root.includes('2. **Clean install and first launch.**'));
  assert.ok(root.includes('3. **Upgrade and data preservation.**'));
  assert.ok(root.includes('4. **Provider and integration acceptance.**'));
  assert.ok(root.includes('5. **Runtime stability and lifecycle.**'));
  assert.ok(root.includes('6. **Platform trust checks.**'));
  assert.ok(root.includes('7. **Exception review and sign-off.**'));
});

test('outcome vocabulary distinguishes all four states', () => {
  assert.ok(root.includes('**PASS**'));
  assert.ok(root.includes('**FAIL**'));
  assert.ok(root.includes('**BLOCKED**'));
  assert.ok(root.includes('**NOT RUN**'));
  assert.ok(root.includes('Never mark PASS without actual evidence.'));
  assert.ok(root.includes('A platform not tested must be recorded as **NOT RUN**.'));
  assert.ok(root.includes('Do not infer or extrapolate acceptance from another OS'));
});

test('evidence hygiene prohibits secret leakage and unsafe bypasses', () => {
  assert.ok(root.includes('Never copy production userData, Vault, API keys or OAuth state'));
  assert.ok(root.includes('Never include API keys, bearer tokens, OAuth codes, session URLs'));
  assert.ok(root.includes('Do not disable Gatekeeper, SmartScreen, Defender'));
  assert.ok(root.includes('Do not run the app as root or administrator'));
  assert.ok(root.includes('external write actions'));
});

test('companion procedures and packet completion are identified', () => {
  assert.ok(root.includes('docs/ops/CLEAN-INSTALL-FIRST-RUN-VERIFICATION.md'));
  assert.ok(root.includes('docs/ops/UPGRADE-DATA-PRESERVATION-VERIFICATION.md'));
  assert.ok(root.includes('docs/ops/PROVIDER-INTEGRATION-ACCEPTANCE.md'));
  assert.ok(root.includes('docs/ops/RUNTIME-STABILITY-SHUTDOWN-VERIFICATION.md'));
  assert.ok(root.includes('docs/ops/CI-UNBLOCK-VERIFICATION.md'));
  assert.ok(root.includes('independent reviewer signature for that platform/architecture'));
});

test('the authoring and draft boundary is explicit', () => {
  assert.ok(root.includes('GitHub-only authoring, no test/build/typecheck was run.'));
  assert.ok(root.includes('This PR is intentionally Draft and is not presented as LAND-READY.'));
  assert.ok(root.includes('No native installation, first launch, upgrade, provider request, soak, shutdown, signing assessment or notarization check was executed'));
});

test('Windows packet names the exact current artifact target', () => {
  assert.ok(windows.includes('NSIS installer for Windows x64'));
  assert.ok(windows.includes('Windows edition, version and OS build'));
  assert.ok(windows.includes('installer filename, byte size, source URL and SHA-256'));
});

test('Windows packet requires signature and safe trust handling', () => {
  assert.ok(windows.includes('Inspect the Authenticode signature'));
  assert.ok(windows.includes('SmartScreen, Defender, UAC'));
  assert.ok(windows.includes('Do not bypass an unexpected publisher warning'));
  assert.ok(windows.includes('Do not infer signing from the NSIS package format.'));
});

test('Windows packet covers clean install and userData isolation', () => {
  assert.ok(windows.includes('fresh disposable Windows user profile'));
  assert.ok(windows.includes('%APPDATA%/open-bot'));
  assert.ok(windows.includes('no prior conversations, provider credentials, workspace state or Vault entries'));
});

test('Windows packet covers upgrade, data preservation and rollback', () => {
  assert.ok(windows.includes('Upgrade and data preservation'));
  assert.ok(windows.includes('Install the candidate NSIS artifact'));
  assert.ok(windows.includes('Vault entries remain available through the supported UI'));
  assert.ok(windows.includes('Rehearse rollback only with a disposable profile'));
});

test('Windows packet covers providers, runtime and independent review', () => {
  assert.ok(windows.includes('Provider and integration acceptance'));
  assert.ok(windows.includes('minimum 30-minute idle soak'));
  assert.ok(windows.includes('process tree'));
  assert.ok(windows.includes('Windows result and reviewer record'));
  assert.ok(windows.includes('No PASS may be recorded until the exact Windows candidate artifact'));
});

test('macOS packet covers both target architectures and trust checks', () => {
  assert.ok(macos.includes('DMG for macOS arm64 and x64'));
  assert.ok(macos.includes('Test each release-supported architecture separately'));
  assert.ok(macos.includes('Developer ID signature'));
  assert.ok(macos.includes('notarization/stapling status'));
  assert.ok(macos.includes('Gatekeeper'));
});

test('macOS packet prohibits bypassing platform security', () => {
  assert.ok(macos.includes('Do not disable Gatekeeper'));
  assert.ok(macos.includes('remove quarantine attributes'));
  assert.ok(macos.includes('A configured notarization requirement is not proof'));
  assert.ok(macos.includes('spctl --assess --type execute --verbose=4 /Applications/open-bot.app'));
});

test('macOS packet covers install, upgrade, providers and data preservation', () => {
  assert.ok(macos.includes('fresh disposable macOS user profile'));
  assert.ok(macos.includes('~/Library/Application Support/open-bot'));
  assert.ok(macos.includes('Upgrade and data preservation'));
  assert.ok(macos.includes('Provider and integration acceptance'));
  assert.ok(macos.includes('Vault entries through the supported UI'));
});

test('macOS packet distinguishes window close from application Quit', () => {
  assert.ok(macos.includes('Close the last window'));
  assert.ok(macos.includes('application menu\'s Quit command or Cmd+Q'));
  assert.ok(macos.includes('Do not mark shutdown PASS merely because the last window disappeared.'));
  assert.ok(macos.includes('macOS result and reviewer record'));
});

test('Linux packet identifies AppImage and unsigned limitation', () => {
  assert.ok(linux.includes('AppImage for Linux x64'));
  assert.ok(linux.includes('The current release configuration does not code-sign the Linux AppImage.'));
  assert.ok(linux.includes('UNSIGNED / NOT PROVIDED'));
  assert.ok(linux.includes('SHA-256 as a publisher signature'));
});

test('Linux packet covers clean install, FUSE and userData isolation', () => {
  assert.ok(linux.includes('fresh disposable Linux user profile'));
  assert.ok(linux.includes('FUSE/runtime requirements'));
  assert.ok(linux.includes('run as root'));
  assert.ok(linux.includes('~/.config/open-bot'));
});

test('Linux packet covers upgrade, providers, shutdown and recovery', () => {
  assert.ok(linux.includes('Upgrade and data preservation'));
  assert.ok(linux.includes('Provider and integration acceptance'));
  assert.ok(linux.includes('Graceful shutdown and recovery'));
  assert.ok(linux.includes('verify the main process and app-owned child processes exit'));
  assert.ok(linux.includes('Linux result and reviewer record'));
});

test('all platform packets require actual execution and reviewer evidence', () => {
  assert.ok(windows.includes('Independent reviewer:'));
  assert.ok(macos.includes('Independent reviewer:'));
  assert.ok(linux.includes('Independent reviewer:'));
  assert.ok(windows.includes('exact Windows candidate artifact has been executed'));
  assert.ok(macos.includes('exact macOS candidate artifact and architecture have been executed'));
  assert.ok(linux.includes('exact Linux x64 candidate artifact has been executed'));
});
