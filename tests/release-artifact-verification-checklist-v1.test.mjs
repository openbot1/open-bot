/**
 * Docs regression guard for the native release-artifact verification checklist.
 *
 * This checks that the release instructions retain the expected commands and
 * platform-specific limitations. It does not run or prove artifact signatures.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const GUIDE = fs.readFileSync(path.join(process.cwd(), 'docs/RELEASING.md'), 'utf8');

test('macOS instructions require DMG integrity, nested-code, Gatekeeper and ticket checks', () => {
  assert.ok(GUIDE.includes('hdiutil verify'));
  assert.ok(GUIDE.includes('codesign --verify --deep --strict --verbose=2'));
  assert.ok(GUIDE.includes('spctl --assess --type execute --verbose=4'));
  assert.ok(GUIDE.includes('xcrun stapler validate'));
  assert.ok(GUIDE.includes('app bundle and disk image are separate possible stapling targets'));
  assert.ok(GUIDE.includes('notary submission as **Accepted**'));
});

test('Windows instructions require valid Authenticode and approved publisher identity', () => {
  assert.ok(GUIDE.includes('Get-AuthenticodeSignature -LiteralPath'));
  assert.ok(GUIDE.includes("$signature.Status -ne 'Valid'"));
  assert.ok(GUIDE.includes('SignerCertificate'));
  assert.ok(GUIDE.includes('subject and thumbprint'));
});

test('Linux instructions never imply AppImage has a signature', () => {
  assert.ok(GUIDE.includes('AppImage is **not GPG-signed**'));
  assert.ok(GUIDE.includes('sha256sum'));
  assert.ok(GUIDE.includes('checksum as a digital signature'));
});

test('release approval requires verification of the exact uploaded artifact', () => {
  assert.ok(GUIDE.includes('exact final DMG / NSIS / AppImage files'));
  assert.ok(GUIDE.includes('compare the uploaded asset names and digests'));
  assert.ok(GUIDE.includes('Keep the release in draft'));
  assert.ok(GUIDE.includes('does not verify any real signature, notarization or artifact'));
});
