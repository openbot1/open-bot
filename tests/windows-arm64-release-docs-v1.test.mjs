/**
 * Static, read-only regression guards for the Windows ARM64 verification guide.
 *
 * This test reads the documentation only. It does not execute child processes,
 * make network requests, write files, inspect binaries, or run on Windows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const GUIDE = fs.readFileSync(
  path.join(process.cwd(), 'docs/WINDOWS-ARM64-RELEASE-VERIFICATION.md'),
  'utf8',
);

test('guide states the current repository does not yet configure an ARM64 release target', () => {
  assert.ok(GUIDE.includes('x64 only'));
  assert.ok(GUIDE.includes('does not add --arm64'));
  assert.ok(GUIDE.includes('NOT RUN / HOLD'));
});

test('guide requires a real ARM64 Windows host and rejects emulated x64 as native proof', () => {
  assert.ok(GUIDE.includes('real Windows on ARM64 device'));
  assert.ok(GUIDE.includes('genuine ARM64 Windows VM'));
  assert.ok(GUIDE.includes('not an ARM64-native release'));
});

test('guide distinguishes the NSIS setup wrapper from the installed application payload', () => {
  assert.ok(GUIDE.includes('installer wrapper and the application payload are different things'));
  assert.ok(GUIDE.includes('installed open-bot.exe'));
  assert.ok(GUIDE.includes('not from the setup wrapper alone'));
});

test('guide checks the installed PE machine field for native ARM64', () => {
  assert.ok(GUIDE.includes('0xAA64'));
  assert.ok(GUIDE.includes('IMAGE_FILE_MACHINE_ARM64'));
  assert.ok(GUIDE.includes('Get-PeMachine'));
  assert.ok(GUIDE.includes("if ($machine -ne '0xAA64')"));
});

test('guide requires runtime evidence that distinguishes native ARM64 from emulated AMD64', () => {
  assert.ok(GUIDE.includes('IsWow64Process2'));
  assert.ok(GUIDE.includes('process machine and native machine'));
  assert.ok(GUIDE.includes('emulated x64, not native ARM64'));
});

test('guide requires valid Authenticode status and an independently approved signer thumbprint', () => {
  assert.ok(GUIDE.includes('Get-AuthenticodeSignature -LiteralPath'));
  assert.ok(GUIDE.includes("$signature.Status -ne 'Valid'"));
  assert.ok(GUIDE.includes('$null -eq $signature.SignerCertificate'));
  assert.ok(GUIDE.includes('REPLACE_WITH_APPROVED_40_HEX_THUMBPRINT'));
  assert.ok(GUIDE.includes('$actualThumbprint -ne $expectedThumbprint'));
});

test('guide requires SignTool Default Authentication policy and zero exit code', () => {
  assert.ok(GUIDE.includes('verify /pa /all /v'));
  assert.ok(GUIDE.includes('$LASTEXITCODE'));
  assert.ok(GUIDE.includes('$signToolExitCode -ne 0'));
  assert.ok(GUIDE.includes('exit code 2'));
});

test('guide requires independent local and downloaded artifact byte reconciliation', () => {
  assert.ok(GUIDE.includes('Compute SHA-256 and byte size for the local final ARM64 installer'));
  assert.ok(GUIDE.includes('Independently download'));
  assert.ok(GUIDE.includes('all three SHA-256 values'));
  assert.ok(GUIDE.includes('not an independent publisher trust anchor'));
});

test('guide requires native ARM64 install/runtime tests and complete evidence before approval', () => {
  assert.ok(GUIDE.includes('Native ARM64 installation and runtime checks pass'));
  assert.ok(GUIDE.includes('Keep the GitHub Release in draft'));
  assert.ok(GUIDE.includes('Operator and UTC verification time'));
  assert.ok(GUIDE.includes('required native components'));
});

test('guide cites electron-builder v26 and Microsoft architecture/signature references', () => {
  assert.ok(GUIDE.includes('electron.build/v26/docs/architecture'));
  assert.ok(GUIDE.includes('learn.microsoft.com/windows/win32/debug/pe-format'));
  assert.ok(GUIDE.includes('learn.microsoft.com/powershell/module/microsoft.powershell.security/get-authenticodesignature'));
  assert.ok(GUIDE.includes('learn.microsoft.com/windows/win32/seccrypto/using-signtool-to-verify-a-file-signature'));
  assert.ok(GUIDE.includes('learn.microsoft.com/windows/win32/api/wow64apiset/nf-wow64apiset-iswow64process2'));
});
