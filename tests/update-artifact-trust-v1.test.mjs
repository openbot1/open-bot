import test from 'node:test';
import assert from 'node:assert/strict';

import { checkForTrackUpdate, checkForUpdate, UPDATE_RELEASES_API, UPDATE_RELEASES_LIST_API, verifyGitHubReleaseArtifactMetadata } from '../packages/core/dist/update/index.js';

const REPO = 'openbot1/open-bot';
const TAG = 'v1.2.3-nightly.20261124';
const SHA256 = 'a'.repeat(64);

function makeRelease(overrides = {}) {
  const name = 'open-bot-1.2.3-nightly.20261124.AppImage';
  return {
    tag_name: TAG,
    draft: false,
    prerelease: true,
    html_url: `https://github.com/${REPO}/releases/tag/${TAG}`,
    assets: [
      {
        name,
        state: 'uploaded',
        size: 1024,
        digest: `sha256:${SHA256}`,
        browser_download_url: `https://github.com/${REPO}/releases/download/${TAG}/${name}`,
      },
      {
        name: 'open-bot-1.2.3.dmg',
        state: 'uploaded',
        size: 2048,
        digest: `sha256:${'b'.repeat(64)}`,
        browser_download_url: `https://github.com/${REPO}/releases/download/${TAG}/open-bot-1.2.3.dmg`,
      },
      {
        name: 'open-bot-1.2.3-setup.exe',
        state: 'uploaded',
        size: 4096,
        digest: `sha256:${'c'.repeat(64)}`,
        browser_download_url: `https://github.com/${REPO}/releases/download/${TAG}/open-bot-1.2.3-setup.exe`,
      },
      {
        name: 'latest.yml',
        state: 'uploaded',
        size: 100,
        digest: `sha256:${'d'.repeat(64)}`,
        browser_download_url: `https://github.com/${REPO}/releases/download/${TAG}/latest.yml`,
      },
    ],
    ...overrides,
  };
}

test('release artifact metadata accepts official release URLs and uploaded SHA-256 assets', () => {
  const result = verifyGitHubReleaseArtifactMetadata(makeRelease(), TAG);
  assert.equal(result.verified, true);
  assert.equal(result.tag, TAG);
  assert.equal(result.releaseUrl, `https://github.com/${REPO}/releases/tag/${TAG}`);
  assert.equal(result.artifacts.length, 3);
  assert.deepEqual(result.artifacts.map((asset) => asset.platform), ['linux', 'macos', 'windows']);
  assert.equal(result.artifacts[0].sha256, SHA256);
});

test('release artifact metadata rejects a non-canonical release page or selected tag mismatch', () => {
  assert.match(
    verifyGitHubReleaseArtifactMetadata(makeRelease({ html_url: 'https://evil.example/release' }), TAG).reason,
    /canonical repository URL/,
  );
  assert.match(verifyGitHubReleaseArtifactMetadata(makeRelease(), 'v9.9.9').reason, /does not match/);
});

test('release artifact metadata rejects off-repository, wrong-tag and query-bearing download URLs', () => {
  for (const browser_download_url of [
    'https://evil.example/open-bot.AppImage',
    `https://github.com/another/repo/releases/download/${TAG}/open-bot-1.2.3-nightly.20261124.AppImage`,
    `https://github.com/${REPO}/releases/download/v9.9.9/open-bot-1.2.3-nightly.20261124.AppImage`,
    `https://github.com/${REPO}/releases/download/${TAG}/open-bot-1.2.3-nightly.20261124.AppImage?download=1`,
  ]) {
    const release = makeRelease();
    release.assets[0].browser_download_url = browser_download_url;
    assert.equal(verifyGitHubReleaseArtifactMetadata(release, TAG).verified, false);
  }
});

test('release artifact metadata fails closed when installer assets lack GitHub SHA-256 digests', () => {
  const release = makeRelease();
  delete release.assets[0].digest;
  const result = verifyGitHubReleaseArtifactMetadata(release, TAG);
  assert.equal(result.verified, false);
  assert.match(result.reason, /SHA-256 digest/);
});

test('release artifact metadata fails closed for draft, pending, zero-size or duplicate installers', () => {
  assert.equal(verifyGitHubReleaseArtifactMetadata(makeRelease({ draft: true }), TAG).verified, false);
  const pending = makeRelease();
  pending.assets[0].state = 'new';
  assert.equal(verifyGitHubReleaseArtifactMetadata(pending, TAG).verified, false);
  const zero = makeRelease();
  zero.assets[0].size = 0;
  assert.equal(verifyGitHubReleaseArtifactMetadata(zero, TAG).verified, false);
  const duplicate = makeRelease();
  duplicate.assets.push({ ...duplicate.assets[0] });
  assert.match(verifyGitHubReleaseArtifactMetadata(duplicate, TAG).reason, /duplicate/);
});

test('release artifact metadata requires at least one supported installer and never treats same-feed digest as signature proof', () => {
  const release = makeRelease({ assets: [{ name: 'latest.yml', state: 'uploaded', size: 10, digest: `sha256:${SHA256}` }] });
  const result = verifyGitHubReleaseArtifactMetadata(release, TAG);
  assert.equal(result.verified, false);
  assert.match(result.reason, /no supported desktop installer/);
});

test('stable and channel checkers gate availability on trusted release artifact metadata', async () => {
  const tag = 'v2.0.0';
  const name = 'open-bot-2.0.0.AppImage';
  const stableRelease = {
    tag_name: tag,
    draft: false,
    prerelease: false,
    html_url: `https://github.com/${REPO}/releases/tag/${tag}`,
    assets: [{
      name,
      state: 'uploaded',
      size: 1024,
      digest: `sha256:${SHA256}`,
      browser_download_url: `https://github.com/${REPO}/releases/download/${tag}/${name}`,
    }],
  };
  const stableResult = await checkForUpdate({
    currentVersion: '1.0.0',
    fetchImpl: async (url) => ({ ok: true, status: 200, url, json: async () => stableRelease }),
  });
  assert.equal(stableResult.available, true);
  assert.equal(stableResult.checkFailed, false);
  assert.equal(stableResult.htmlUrl, stableRelease.html_url);

  const invalidTrackRelease = makeRelease();
  invalidTrackRelease.assets[0].digest = undefined;
  const trackResult = await checkForTrackUpdate({
    currentVersion: '1.0.0',
    track: 'nightly',
    fetchImpl: async (url) => ({ ok: true, status: 200, url, json: async () => [invalidTrackRelease] }),
  });
  assert.equal(trackResult.available, false);
  assert.equal(trackResult.checkFailed, true);
  assert.match(trackResult.error ?? '', /SHA-256 digest/);

  const redirectedStable = await checkForUpdate({
    currentVersion: '1.0.0',
    fetchImpl: async () => ({ ok: true, status: 200, url: 'https://evil.example/releases/latest', json: async () => stableRelease }),
  });
  assert.equal(redirectedStable.available, false);
  assert.equal(redirectedStable.checkFailed, true);

  const stableCalls = [];
  const customStable = await checkForUpdate({
    currentVersion: '1.0.0',
    releasesApiUrl: 'https://evil.example/releases/latest',
    fetchImpl: async (url) => {
      stableCalls.push(url);
      return { ok: true, status: 200, url, json: async () => stableRelease };
    },
  });
  assert.equal(customStable.available, false);
  assert.equal(customStable.checkFailed, true);
  assert.deepEqual(stableCalls, []);

  assert.equal(UPDATE_RELEASES_API, `https://api.github.com/repos/${REPO}/releases/latest`);
  assert.equal(UPDATE_RELEASES_LIST_API, `https://api.github.com/repos/${REPO}/releases?per_page=20`);
});
