/**
 * Static regression guard for the release artifact attestation policy.
 *
 * These assertions lock the written producer prerequisite and verification
 * policy. They do not create or verify a GitHub attestation for a real artifact.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const GUIDE = fs.readFileSync(
  path.join(process.cwd(), 'docs/RELEASE-ATTESTATION-PROVENANCE.md'),
  'utf8',
);

test('policy covers each final platform artifact and explicitly states the current producer gap', () => {
  assert.ok(GUIDE.includes('macOS arm64 / x64 DMG'));
  assert.ok(GUIDE.includes('Windows x64 NSIS installer'));
  assert.ok(GUIDE.includes('Linux x64 AppImage'));
  assert.ok(GUIDE.includes('current main tree contains no release-build workflow'));
  assert.ok(GUIDE.includes('If no matching attestation exists, the result is **HOLD**'));
});

test('producer prerequisite requires minimal GitHub Actions permissions and attest action', () => {
  assert.ok(GUIDE.includes('id-token: write'));
  assert.ok(GUIDE.includes('attestations: write'));
  assert.ok(GUIDE.includes('contents: read'));
  assert.ok(GUIDE.includes('uses: actions/attest@v4'));
  assert.ok(GUIDE.includes('subject-path:'));
  assert.ok(GUIDE.includes('immutable full commit SHA'));
});

test('attestation is generated only after all byte-changing signing and stapling steps', () => {
  assert.ok(GUIDE.includes('after every operation that changes the artifact bytes'));
  assert.ok(GUIDE.includes('after the final staple'));
  assert.ok(GUIDE.includes('generate a new attestation for the new final bytes'));
});

test('verification is scoped to the repo, signer workflow, OIDC issuer and SLSA predicate', () => {
  assert.ok(GUIDE.includes('--repo "$REPO"'));
  assert.ok(GUIDE.includes('--signer-workflow "$SIGNER_WORKFLOW"'));
  assert.ok(GUIDE.includes('--cert-oidc-issuer "https://token.actions.githubusercontent.com"'));
  assert.ok(GUIDE.includes('--predicate-type "https://slsa.dev/provenance/v1"'));
});

test('source digest must bind to the actual checked-out commit, not an assumed tag or dispatch ref', () => {
  assert.ok(GUIDE.includes('--source-digest "$SOURCE_SHA"'));
  assert.ok(GUIDE.includes('full commit SHA of the source actually built'));
  assert.ok(GUIDE.includes('Only add --source-ref after'));
  assert.ok(GUIDE.includes('never assert refs/tags/<tag> merely because'));
});

test('online verification avoids the bundle mode current-repository identity limitation', () => {
  assert.ok(GUIDE.includes('Do not use --bundle for the normal online release gate'));
  assert.ok(GUIDE.includes('online lookup through the GitHub API'));
});

test('JSON review distinguishes cryptographic certificate evidence from workflow-supplied predicate claims', () => {
  assert.ok(GUIDE.includes('verificationResult'));
  assert.ok(GUIDE.includes('verified timestamps'));
  assert.ok(GUIDE.includes('Treat fields inside statement.predicate as workflow-supplied claims'));
  assert.ok(GUIDE.includes('not an independent trust anchor'));
});

test('pass and hold conditions require exact artifact digest and all independent release gates', () => {
  assert.ok(GUIDE.includes('independently downloaded Release asset'));
  assert.ok(GUIDE.includes('all native signing, notarization, platform verification'));
  assert.ok(GUIDE.includes('No attestation means **not verified**'));
  assert.ok(GUIDE.includes('Keep the GitHub Release in draft'));
});

test('procedure cites the GitHub CLI and artifact attestation producer and lifecycle references', () => {
  assert.ok(GUIDE.includes('cli.github.com/manual/gh_attestation_verify'));
  assert.ok(GUIDE.includes('docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations'));
  assert.ok(GUIDE.includes('docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/manage-attestations'));
});
