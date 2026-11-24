import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { verifyReleaseArtifacts } from '../scripts/verify-release-assets.mjs';

const REPOSITORY = 'openbot1/open-bot';
const TAG = 'v1.2.3';

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-release-assets-'));
  const localDir = path.join(root, 'local');
  const downloadedDir = path.join(root, 'downloaded');
  fs.mkdirSync(localDir);
  fs.mkdirSync(downloadedDir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const contents = new Map([
    ['open-bot-1.2.3.AppImage', Buffer.from('linux-appimage-bytes')],
    ['open-bot-1.2.3-arm64.dmg', Buffer.from('macos-dmg-bytes')],
    ['open-bot-1.2.3-setup.exe', Buffer.from('windows-installer-bytes')],
  ]);

  const assets = [];
  for (const [name, bytes] of contents) {
    fs.writeFileSync(path.join(localDir, name), bytes);
    fs.writeFileSync(path.join(downloadedDir, name), bytes);
    assets.push({
      name,
      state: 'uploaded',
      size: bytes.length,
      digest: `sha256:${sha256(bytes)}`,
      browser_download_url:
        `https://github.com/${REPOSITORY}/releases/download/${TAG}/${encodeURIComponent(name)}`,
    });
  }

  return {
    localDir,
    downloadedDir,
    contents,
    release: {
      tag_name: TAG,
      draft: true,
      prerelease: false,
      html_url: `https://github.com/${REPOSITORY}/releases/tag/${TAG}`,
      assets,
    },
  };
}

test('release artifact byte gate accepts matching local, downloaded and GitHub API digests', async (t) => {
  const data = fixture(t);
  const result = await verifyReleaseArtifacts(data);
  assert.equal(result.tag, TAG);
  assert.equal(result.artifacts.length, 3);
  assert.deepEqual(
    result.artifacts.map((artifact) => artifact.platform).sort(),
    ['linux', 'macos', 'windows'],
  );
});

test('release artifact byte gate rejects a published release and missing platform', async (t) => {
  const published = fixture(t);
  published.release.draft = false;
  await assert.rejects(verifyReleaseArtifacts(published), /must still be a draft/);

  const missingPlatform = fixture(t);
  missingPlatform.release.assets = missingPlatform.release.assets.filter(
    (asset) => !asset.name.endsWith('.exe'),
  );
  await assert.rejects(verifyReleaseArtifacts(missingPlatform), /missing installer platforms: windows/);
});

test('release artifact byte gate rejects pending uploads and invalid GitHub digests', async (t) => {
  const pending = fixture(t);
  pending.release.assets[0].state = 'new';
  await assert.rejects(verifyReleaseArtifacts(pending), /not fully uploaded/);

  const badDigest = fixture(t);
  badDigest.release.assets[0].digest = `sha256:${'0'.repeat(64)}`;
  await assert.rejects(verifyReleaseArtifacts(badDigest), /does not match the GitHub API digest/);
});

test('release artifact byte gate rejects downloaded bytes that differ from the local build', async (t) => {
  const data = fixture(t);
  const name = data.release.assets[0].name;
  const expectedSize = data.release.assets[0].size;
  fs.writeFileSync(path.join(data.downloadedDir, name), Buffer.alloc(expectedSize, 0x78));
  await assert.rejects(verifyReleaseArtifacts(data), /Local and downloaded bytes differ/);
});

test('release artifact byte gate rejects malformed SemVer tags', async (t) => {
  const data = fixture(t);
  data.release.tag_name = 'v1.2.3-beta.01';
  await assert.rejects(verifyReleaseArtifacts(data), /tag is missing or invalid/);
});

test('release artifact byte gate rejects unsafe names and non-canonical release metadata', async (t) => {
  const unsafe = fixture(t);
  unsafe.release.assets[0].name = '../escape.AppImage';
  await assert.rejects(verifyReleaseArtifacts(unsafe), /unsafe filename/);

  const nonCanonical = fixture(t);
  nonCanonical.release.html_url = 'https://example.invalid/release';
  await assert.rejects(verifyReleaseArtifacts(nonCanonical), /not canonical/);
});
