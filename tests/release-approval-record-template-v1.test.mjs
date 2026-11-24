import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const GUIDE = fs.readFileSync(path.join(ROOT, 'docs/RELEASING.md'), 'utf8');
const TEMPLATE = fs.readFileSync(path.join(ROOT, 'docs/RELEASE-APPROVAL-RECORD.md'), 'utf8');

test('release guide links the per-release approval evidence record', () => {
  assert.ok(GUIDE.includes('docs/RELEASE-APPROVAL-RECORD.md'));
  assert.ok(GUIDE.includes('exact source commit and final uploaded files'));
});

test('approval record binds quality evidence to one exact source SHA', () => {
  assert.ok(TEMPLATE.includes('Full source commit SHA'));
  assert.ok(TEMPLATE.includes('Full-suite failures'));
  assert.ok(TEMPLATE.includes('zero test failures'));
  assert.ok(TEMPLATE.includes('GitHub Actions run for this exact SHA'));
});

test('approval record captures native macOS notarization and Windows signer identity', () => {
  assert.ok(TEMPLATE.includes('Notary result is **Accepted**'));
  assert.ok(TEMPLATE.includes('xcrun stapler validate'));
  assert.ok(TEMPLATE.includes('codesign --verify --deep --strict --verbose=2'));
  assert.ok(TEMPLATE.includes('spctl --assess --type execute --verbose=4'));
  assert.ok(TEMPLATE.includes('Get-AuthenticodeSignature -LiteralPath'));
  assert.ok(TEMPLATE.includes('Thumbprint matches maintainer-approved release identity'));
});

test('approval record keeps Linux unsigned and requires independent uploaded-byte comparison', () => {
  assert.ok(TEMPLATE.includes('**not GPG-signed**'));
  assert.ok(TEMPLATE.includes('no publisher signature'));
  assert.ok(TEMPLATE.includes('independently download the uploaded file'));
  assert.ok(TEMPLATE.includes('GitHub API asset digest'));
  assert.ok(TEMPLATE.includes('All three values must agree'));
});

test('approval record blocks publication when evidence is missing or verification fails', () => {
  assert.ok(TEMPLATE.includes('Decision:** [TODO: HOLD / APPROVED TO PUBLISH]'));
  assert.ok(TEMPLATE.includes('keep the GitHub Release in draft'));
  assert.ok(TEMPLATE.includes('Never override a failed signature, notarization, hash comparison, or full-suite gate'));
  assert.ok(TEMPLATE.includes('Do not paste credentials'));
});
