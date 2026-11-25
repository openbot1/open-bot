/**
 * Static regression guard for the Windows Authenticode operator procedure.
 *
 * These tests lock the written release gate. They do not run PowerShell,
 * SignTool, certificate-chain validation, or verification of a real installer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const GUIDE = fs.readFileSync(
  path.join(process.cwd(), 'docs/WINDOWS-AUTHENTICODE-VERIFICATION.md'),
  'utf8',
);

test('procedure is scoped to the exact final Windows NSIS x64 release installer', () => {
  assert.ok(GUIDE.includes('NSIS x64 installer'));
  assert.ok(GUIDE.includes('exact final'));
  assert.ok(GUIDE.includes('full source commit SHA'));
  assert.ok(GUIDE.includes('Keep the GitHub Release in draft'));
});

test('PowerShell verification requires a valid Authenticode result and signer certificate', () => {
  assert.ok(GUIDE.includes('Get-AuthenticodeSignature -LiteralPath'));
  assert.ok(GUIDE.includes("$signature.Status -ne 'Valid'"));
  assert.ok(GUIDE.includes('$null -eq $signature.SignerCertificate'));
  assert.ok(GUIDE.includes('SignatureStatusMessage'));
});

test('publisher identity is pinned to an independently approved exact thumbprint', () => {
  assert.ok(GUIDE.includes('REPLACE_WITH_APPROVED_40_HEX_THUMBPRINT'));
  assert.ok(GUIDE.includes("^[A-Fa-f0-9]{40}$"));
  assert.ok(GUIDE.includes('SignerCertificate.Thumbprint'));
  assert.ok(GUIDE.includes('$actualThumbprint -ne $expectedThumbprint'));
  assert.ok(GUIDE.includes('independently approved'));
});

test('SignTool uses Authenticode policy, checks all embedded signatures and fails on warnings', () => {
  assert.ok(GUIDE.includes('verify /pa /all /v'));
  assert.ok(GUIDE.includes('$LASTEXITCODE'));
  assert.ok(GUIDE.includes('$signToolExitCode -ne 0'));
  assert.ok(GUIDE.includes('2 = completed with warnings'));
  assert.ok(GUIDE.includes('do not reinterpret exit code 2 as a pass'));
});

test('timestamp handling is explicit and does not replace publisher identity verification', () => {
  assert.ok(GUIDE.includes('TimeStamperCertificate'));
  assert.ok(GUIDE.includes('with /tw'));
  assert.ok(GUIDE.includes('timestamp presence proves the publisher identity'));
  assert.ok(GUIDE.includes('trusted timestamp'));
});

test('artifact-byte reconciliation and complete evidence are required before approval', () => {
  assert.ok(GUIDE.includes('Get-FileHash -LiteralPath'));
  assert.ok(GUIDE.includes('independently downloaded copy'));
  assert.ok(GUIDE.includes('GitHub Release API asset digest'));
  assert.ok(GUIDE.includes('SignTool command, version, full output and exit code'));
  assert.ok(GUIDE.includes('operator and UTC time'));
});

test('procedure preserves Windows trust policy and excludes signing secrets from evidence', () => {
  assert.ok(GUIDE.includes('Do not disable revocation checks'));
  assert.ok(GUIDE.includes('Do not place .pfx / .p12 files'));
  assert.ok(GUIDE.includes('Keep the release in draft'));
});

test('procedure links to the Microsoft references used for the verification contract', () => {
  assert.ok(GUIDE.includes('learn.microsoft.com/powershell/module/microsoft.powershell.security/get-authenticode-signature'));
  assert.ok(GUIDE.includes('learn.microsoft.com/windows/win32/seccrypto/using-signtool-to-verify-a-file-signature'));
  assert.ok(GUIDE.includes('learn.microsoft.com/windows/win32/seccrypto/signtool'));
});
