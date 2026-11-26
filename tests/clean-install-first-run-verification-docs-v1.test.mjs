import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const runbook = fs.readFileSync(
  path.join(here, '..', 'docs', 'ops', 'CLEAN-INSTALL-FIRST-RUN-VERIFICATION.md'),
  'utf8',
);

test('identifies the exact source and artifact under test', () => {
  assert.match(runbook, /exact application source SHA, installed artifact, OS version/);
  assert.match(runbook, /artifact.*SHA-256|SHA-256.*artifact/);
  assert.ok(runbook.includes('PASS means the check was performed and met its criterion'));
  assert.ok(runbook.includes('NOT RUN means no evidence was collected'));
});

test('documents Node and reproducible source installation requirements', () => {
  assert.ok(runbook.includes('Node.js 24+ and npm'));
  assert.ok(runbook.includes('npm ci'));
  assert.ok(runbook.includes('Do not substitute'));
});

test('matches the configured Windows packaging target', () => {
  assert.ok(runbook.includes('Windows NSIS x64'));
  assert.ok(runbook.includes('Windows'));
  assert.ok(runbook.includes('winver'));
  assert.ok(runbook.includes('SmartScreen'));
});

test('matches the configured macOS packaging and signing requirements', () => {
  assert.ok(runbook.includes('macOS DMG arm64/x64'));
  assert.ok(runbook.includes('sw_vers'));
  assert.ok(runbook.includes('spctl --assess --type execute --verbose=4'));
  assert.ok(runbook.includes('Do not disable Gatekeeper'));
});

test('matches the configured Linux AppImage target and signing limitation', () => {
  assert.ok(runbook.includes('Linux AppImage x64'));
  assert.ok(runbook.includes('cat /etc/os-release'));
  assert.ok(runbook.includes('does not code-sign the Linux AppImage'));
  assert.ok(runbook.includes('do not run the application as root'));
});

test('records the actual userData locations', () => {
  assert.ok(runbook.includes('~/.config/open-bot'));
  assert.ok(runbook.includes('~/Library/Application Support/open-bot'));
  assert.ok(runbook.includes('%APPDATA%/open-bot'));
  assert.ok(runbook.includes('vault.json'));
});

test('guards clean first-run state without assuming a sample bot', () => {
  assert.ok(runbook.includes('does not contain copied settings'));
  assert.ok(runbook.includes('removed the automatic sample-bot seed'));
  assert.ok(runbook.includes('relaunch once'));
});

test('describes the Vault OS-backed encryption implementations', () => {
  assert.ok(runbook.includes('DPAPI'));
  assert.ok(runbook.includes('Keychain'));
  assert.ok(runbook.includes('libsecret'));
  assert.ok(runbook.includes('safeStorage'));
});

test('distinguishes degraded Vault fallback from OS-backed encryption', () => {
  assert.ok(runbook.includes('local machine-key fallback'));
  assert.ok(runbook.includes('explicit consent'));
  assert.ok(runbook.includes('not present in plaintext in'));
  assert.ok(runbook.includes('Do not delete or recreate the Vault'));
});

test('documents provider setup without leaking keys', () => {
  assert.ok(runbook.includes('Settings → Providers'));
  assert.ok(runbook.includes('without echoing the key value'));
  assert.ok(runbook.includes('Remove the disposable key after the test'));
});

test('documents Ollama local defaults accurately', () => {
  assert.ok(runbook.includes('localhost:11434/v1'));
  assert.ok(runbook.includes('llama3.1'));
  assert.ok(runbook.includes('needs no API key'));
});

test('distinguishes CLI binary detection from authentication', () => {
  assert.ok(runbook.includes('local binary-availability check'));
  assert.ok(runbook.includes('not proof that the CLI is logged in'));
  assert.ok(runbook.includes('Do not inspect another CLI\'s auth/session files'));
  assert.ok(runbook.includes('A separate process is not an OS sandbox'));
});

test('requires consent for external provider and CLI activity', () => {
  assert.ok(runbook.includes('explicitly approves an outbound request'));
  assert.ok(runbook.includes('Obtain explicit user consent'));
  assert.ok(runbook.includes('record NOT RUN when no binary, login or consent is available'));
});

test('defines the evidence package', () => {
  for (const field of [
    'Candidate source commit SHA',
    'Artifact download source, byte size and SHA-256',
    'OS edition/version/build, architecture',
    'First-launch, clean userData and relaunch observations',
    'Vault status/backend and consent state',
    'Operator, UTC timestamp, exact commands, exit codes',
  ]) {
    assert.ok(runbook.includes(field), 'missing evidence field: ' + field);
  }
});

test('prohibits secret-bearing evidence', () => {
  assert.ok(runbook.includes('raw Vault contents'));
  assert.ok(runbook.includes('unredacted environment dumps'));
  assert.ok(runbook.includes('Screenshots with secrets'));
});

test('defines severity and immediate containment', () => {
  assert.match(runbook, /P0 \/ immediate containment/);
  assert.match(runbook, /P1 \/ release blocker/);
  assert.match(runbook, /P2 \/ platform blocker/);
  assert.match(runbook, /P3 \/ non-blocking issue/);
  assert.ok(runbook.includes('revoke exposed test credentials'));
});

test('keeps platform acceptance independent', () => {
  assert.ok(runbook.includes('Report Windows, macOS and Linux separately'));
  assert.ok(runbook.includes('A successful result on one OS does not certify another OS'));
  assert.ok(runbook.includes('exact artifact'));
});

test('does not claim a release artifact or platform test already exists', () => {
  assert.ok(runbook.includes('not a claim that a release artifact currently exists'));
  assert.ok(runbook.includes('have been tested'));
});
