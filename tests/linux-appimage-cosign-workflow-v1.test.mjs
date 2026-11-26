/**
 * Static regression guards for the manual Linux AppImage Sigstore workflow.
 * These assertions check the checked-in policy shape; they do not run Cosign,
 * obtain an OIDC token, or prove a live draft-release signing operation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const WORKFLOW = fs.readFileSync(
  path.join(ROOT, '.github/workflows/sign-linux-appimage.yml'),
  'utf8',
);
const GUIDE = fs.readFileSync(
  path.join(ROOT, 'docs/LINUX-APPIMAGE-SIGNING.md'),
  'utf8',
);

test('workflow is manual-only and requires an explicit tag plus exact AppImage filename', () => {
  assert.match(WORKFLOW, /^on:\n  workflow_dispatch:/m);
  assert.match(WORKFLOW, /release_tag:\n[\s\S]*required: true/);
  assert.match(WORKFLOW, /appimage_asset:\n[\s\S]*required: true/);
  assert.doesNotMatch(WORKFLOW, /^  (?:push|pull_request|schedule):/m);
});

test('signing can run only from main and is gated by the protected release environment', () => {
  assert.ok(WORKFLOW.includes("if: github.ref == 'refs/heads/main'"));
  assert.match(WORKFLOW, /environment: release/);
  assert.ok(GUIDE.includes('authorized reviewer'));
  assert.ok(GUIDE.includes('deployment branches to `main`'));
});

test('OIDC and Release write permissions are job-scoped', () => {
  assert.match(WORKFLOW, /permissions:\n\s+contents: write\n\s+id-token: write/);
  assert.ok(GUIDE.includes('id-token: write'));
});

test('workflow accepts only supported version tags and a safe AppImage filename', () => {
  assert.ok(WORKFLOW.includes('dogfood|nightly|lab'));
  assert.ok(WORKFLOW.includes('\\.AppImage$'));
  assert.ok(WORKFLOW.includes('.draft == true'));
  assert.ok(WORKFLOW.includes('asset_state'));
});

test('downloaded bytes must match GitHub API size and SHA-256 before signing', () => {
  assert.ok(WORKFLOW.includes('Accept: application/octet-stream'));
  assert.ok(WORKFLOW.includes('actual_size" == "$asset_size"'));
  assert.ok(WORKFLOW.includes('actual_sha256" == "$expected_sha256"'));
  assert.ok(WORKFLOW.includes('sha256sum "$appimage_path"'));
});

test('Cosign action and binary are pinned; keyless signature is verified against workflow identity', () => {
  assert.ok(WORKFLOW.includes('sigstore/cosign-installer@ba7bc0a3fef59531c69a25acd34668d6d3fe6f22'));
  assert.ok(WORKFLOW.includes('cosign-release: v3.1.4'));
  assert.ok(WORKFLOW.includes('cosign sign-blob --yes --bundle'));
  assert.ok(WORKFLOW.includes('cosign verify-blob'));
  assert.ok(WORKFLOW.includes('.github/workflows/sign-linux-appimage.yml@refs/heads/main'));
  assert.ok(WORKFLOW.includes('https://token.actions.githubusercontent.com'));
});

test('the bundle is uploaded to the same still-draft release without a publish operation', () => {
  assert.ok(WORKFLOW.includes('gh release upload "$RELEASE_TAG" "$BUNDLE_PATH"'));
  assert.ok(WORKFLOW.includes('release_after'));
  assert.ok(WORKFLOW.includes('.draft == true'));
  assert.doesNotMatch(WORKFLOW, /gh release edit .*--draft=false|gh release create|releases\/generate-notes/);
  assert.ok(GUIDE.includes('never changes the release from draft to published'));
});

test('operator documentation explains the identity and non-provenance limitation', () => {
  assert.ok(GUIDE.includes('keyless Sigstore blob signature'));
  assert.ok(GUIDE.includes('does not prove that the binary was built from a particular source commit'));
  assert.ok(GUIDE.includes('--certificate-identity'));
  assert.ok(GUIDE.includes('--certificate-oidc-issuer'));
});
