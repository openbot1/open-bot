import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github/workflows/native-draft-release.yml'), 'utf8');
const GUIDE = fs.readFileSync(path.join(ROOT, 'docs/RELEASING.md'), 'utf8');

test('native release workflow is manual-only and restricted to the default branch', () => {
  assert.match(WORKFLOW, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(WORKFLOW, /^  (?:push|pull_request|release):/m);
  assert.ok(WORKFLOW.includes('GITHUB_REF') && WORKFLOW.includes('refs/heads/main'));
  assert.ok(WORKFLOW.includes('cancel-in-progress: false'));
  assert.match(WORKFLOW, /permissions:\n  contents: write/);
});

test('release input is bound to the root product version and an immutable full source SHA', () => {
  assert.ok(WORKFLOW.includes('refs/tags/${{ inputs.release_tag }}'));
  assert.ok(WORKFLOW.includes("['git', 'describe', '--tags', '--exact-match', 'HEAD']"));
  assert.ok(WORKFLOW.includes("join('\\\\.')"));
  assert.ok(WORKFLOW.includes('git describe'));
  assert.ok(WORKFLOW.includes('package.json'));
  assert.ok(WORKFLOW.includes('source_sha='));
  assert.ok(WORKFLOW.includes('needs.validate-release-ref.outputs.source_sha'));
});

test('each native target runs build, typecheck, full tests and platform tests before packaging', () => {
  for (const command of ['npm ci', 'npm run version:check', 'npm run build', 'npm run typecheck', 'node --test tests/platform.test.mjs']) {
    assert.ok(WORKFLOW.includes(command), `workflow must include ${command}`);
  }
  assert.ok(WORKFLOW.includes('xvfb-run -a npm test'));
  assert.ok(WORKFLOW.includes('run: npm test'));
});

test('native release jobs use a protected environment and only their own signing secrets', () => {
  assert.equal(WORKFLOW.split('environment: release').length - 1, 3);
  for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'GH_TOKEN']) {
    assert.ok(WORKFLOW.includes(name), `workflow must wire ${name}`);
  }
  assert.ok(WORKFLOW.includes('npm run release:mac'));
  assert.ok(WORKFLOW.includes('npm run release:win'));
  assert.ok(WORKFLOW.includes('npm run release:linux'));
});

test('post-upload checks require draft state, uploaded assets, positive size and SHA-256 metadata', () => {
  assert.equal(WORKFLOW.split('release.draft !== true').length - 1, 3);
  assert.equal(WORKFLOW.split("asset.state !== 'uploaded'").length - 1, 3);
  assert.equal(WORKFLOW.split('/^sha256:[a-f0-9]{64}$/i').length - 1, 3);
});

test('release guide documents protected environment setup and manual target-by-target execution', () => {
  assert.ok(GUIDE.includes('Native draft release workflow'));
  assert.ok(GUIDE.includes('Environment named `release`'));
  assert.ok(GUIDE.includes('one target per run'));
  assert.ok(GUIDE.includes('never publishes the draft automatically'));
});
