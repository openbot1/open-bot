/**
 * Regression tests for update-version precedence.
 *
 * Run after building the core workspace:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/update-semver-precedence-v1.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkForTrackUpdate,
  compareSemver,
  evaluateUpdatePolicy,
  parseSemver,
} from '../packages/core/dist/update/index.js';

test('SemVer compares prerelease identifiers using numeric and lexical precedence', () => {
  assert.equal(compareSemver('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(compareSemver('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1);
  assert.equal(compareSemver('1.0.0-alpha.beta', '1.0.0-beta'), -1);
  assert.equal(compareSemver('1.0.0-beta', '1.0.0-rc.1'), -1);
  assert.equal(compareSemver('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(compareSemver('1.0.0-nightly.9', '1.0.0-nightly.10'), -1);
  assert.equal(compareSemver('1.0.0-nightly.10', '1.0.0-nightly.9'), 1);
});

test('SemVer ignores build metadata and preserves existing version input compatibility', () => {
  assert.equal(compareSemver('v1.2.3+build.1', '1.2.3+build.2'), 0);
  assert.equal(compareSemver('1.0', '1.0.0'), 0);
  assert.equal(compareSemver('v0.2.0', '0.2.0'), 0);
  assert.deepEqual(parseSemver('v0.7.0'), [0, 7, 0]);
  assert.deepEqual(parseSemver('1.0'), [1, 0, 0]);
  assert.equal(parseSemver('1.0.0-beta..1'), null);
  assert.equal(parseSemver('1.0.0-beta.01'), null);
  assert.equal(parseSemver('not-a-version'), null);
});

test('minimum-client policy treats a prerelease as older than its stable minimum', () => {
  const prerelease = evaluateUpdatePolicy({
    currentVersion: '1.0.0-beta.1',
    minClientVersion: '1.0.0',
  });
  assert.equal(prerelease.required, true);
  assert.equal(prerelease.belowMinVersion, true);

  const stable = evaluateUpdatePolicy({
    currentVersion: '1.0.0',
    minClientVersion: '1.0.0-beta.1',
  });
  assert.equal(stable.required, false);
  assert.equal(stable.belowMinVersion, false);
});

test('track updater detects a newer nightly build with the same numeric core version', async () => {
  const result = await checkForTrackUpdate({
    currentVersion: '0.59.0-nightly.20261109',
    track: 'nightly',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => [{
        tag_name: 'v0.59.0-nightly.20261110',
        draft: false,
        prerelease: true,
        html_url: 'https://github.com/openbot1/open-bot/releases/tag/v0.59.0-nightly.20261110',
        assets: [
          {
            name: 'open-bot-0.59.0-nightly.20261110.AppImage',
            state: 'uploaded',
            size: 1024,
            digest: `sha256:${'a'.repeat(64)}`,
            browser_download_url: 'https://github.com/openbot1/open-bot/releases/download/v0.59.0-nightly.20261110/open-bot-0.59.0-nightly.20261110.AppImage',
          },
          {
            name: 'open-bot-0.59.0-nightly.20261110.dmg',
            state: 'uploaded',
            size: 2048,
            digest: `sha256:${'b'.repeat(64)}`,
            browser_download_url: 'https://github.com/openbot1/open-bot/releases/download/v0.59.0-nightly.20261110/open-bot-0.59.0-nightly.20261110.dmg',
          },
          {
            name: 'open-bot-0.59.0-nightly.20261110-setup.exe',
            state: 'uploaded',
            size: 3072,
            digest: `sha256:${'c'.repeat(64)}`,
            browser_download_url: 'https://github.com/openbot1/open-bot/releases/download/v0.59.0-nightly.20261110/open-bot-0.59.0-nightly.20261110-setup.exe',
          },
        ],
      }],
    }),
  });

  assert.equal(result.checkFailed, false);
  assert.equal(result.available, true);
  assert.equal(result.latestTag, 'v0.59.0-nightly.20261110');
});
