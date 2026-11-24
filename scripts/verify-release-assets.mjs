#!/usr/bin/env node
/**
 * Reconcile exact local release artifacts with independently downloaded
 * GitHub Release assets while the Release is still a draft.
 *
 * This is a byte-integrity check only. It does not verify code signatures,
 * notarization, publisher identity, or the authenticity of GitHub API metadata.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPOSITORY = 'openbot1/open-bot';
const RELEASE_BASE_URL = `https://github.com/${REPOSITORY}/releases`;
const REQUIRED_PLATFORMS = ['linux', 'macos', 'windows'];

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function platformForAssetName(name) {
  const extension = path.extname(name).toLowerCase();
  if (extension === '.appimage') return 'linux';
  if (extension === '.dmg') return 'macos';
  if (extension === '.exe') return 'windows';
  return null;
}

function assertSafeAssetName(name) {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.length > 200 ||
    name === '.' ||
    name === '..' ||
    !/^[A-Za-z0-9][A-Za-z0-9._ +()\\-]{0,199}$/.test(name) ||
    name.includes('/') ||
    name.includes('\\')
  ) {
    throw new Error('Installer asset has an unsafe filename.');
  }
  return name;
}

function assertDirectory(directory, label) {
  if (typeof directory !== 'string' || directory.length === 0) {
    throw new Error(`${label} directory is required.`);
  }
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch {
    throw new Error(`${label} directory does not exist.`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} path must be a real directory.`);
  }
}

async function sha256File(filePath, label) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    throw new Error(`${label} file is missing.`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || !Number.isSafeInteger(stat.size)) {
    throw new Error(`${label} path must be a regular file with a safe size.`);
  }

  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk);
  }
  return { size: stat.size, sha256: hash.digest('hex') };
}

/**
 * Check each supported installer against both its local build and its
 * independently downloaded GitHub Release copy.
 *
 * The release must remain a draft. The function requires one or more assets
 * for each configured platform; additional architectures are supported.
 */
export async function verifyReleaseArtifacts({ release, localDir, downloadedDir }) {
  if (!isRecord(release)) throw new Error('Release response must be a JSON object.');
  if (release.draft !== true) throw new Error('Release must still be a draft during artifact verification.');
  if (typeof release.prerelease !== 'boolean') {
    throw new Error('Release prerelease flag is missing or invalid.');
  }

  const tag = release.tag_name;
  if (
    typeof tag !== 'string' ||
    tag.length > 128 ||
    !/^v?(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$/.test(tag)
  ) {
    throw new Error('Release tag is missing or invalid.');
  }

  const expectedReleaseUrl = `${RELEASE_BASE_URL}/tag/${encodeURIComponent(tag)}`;
  if (release.html_url !== expectedReleaseUrl) {
    throw new Error('Release page URL is not canonical for openbot1/open-bot.');
  }
  if (!Array.isArray(release.assets)) throw new Error('Release assets list is missing or invalid.');

  assertDirectory(localDir, 'Local artifact');
  assertDirectory(downloadedDir, 'Downloaded artifact');

  const seenNames = new Set();
  const seenPlatforms = new Set();
  const verifiedArtifacts = [];

  for (const rawAsset of release.assets) {
    if (!isRecord(rawAsset) || typeof rawAsset.name !== 'string') continue;
    const platform = platformForAssetName(rawAsset.name);
    if (!platform) continue;

    const name = assertSafeAssetName(rawAsset.name);
    if (seenNames.has(name)) throw new Error(`Duplicate installer asset name: ${name}`);
    seenNames.add(name);

    if (rawAsset.state !== 'uploaded') {
      throw new Error(`Installer asset ${name} is not fully uploaded.`);
    }
    if (
      typeof rawAsset.size !== 'number' ||
      !Number.isSafeInteger(rawAsset.size) ||
      rawAsset.size <= 0
    ) {
      throw new Error(`Installer asset ${name} has an invalid API size.`);
    }

    const digestMatch =
      typeof rawAsset.digest === 'string'
        ? /^sha256:([a-f0-9]{64})$/i.exec(rawAsset.digest)
        : null;
    if (!digestMatch) throw new Error(`Installer asset ${name} has no valid GitHub SHA-256 digest.`);

    const expectedDownloadUrl =
      `${RELEASE_BASE_URL}/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
    if (rawAsset.browser_download_url !== expectedDownloadUrl) {
      throw new Error(`Installer asset ${name} has a non-canonical download URL.`);
    }

    const local = await sha256File(path.join(localDir, name), `Local artifact ${name}`);
    const downloaded = await sha256File(
      path.join(downloadedDir, name),
      `Downloaded GitHub asset ${name}`,
    );

    if (local.size !== rawAsset.size || downloaded.size !== rawAsset.size) {
      throw new Error(`Installer asset ${name} size does not match the GitHub API metadata.`);
    }
    if (local.sha256 !== downloaded.sha256) {
      throw new Error(`Local and downloaded bytes differ for installer asset ${name}.`);
    }
    if (local.sha256 !== digestMatch[1].toLowerCase()) {
      throw new Error(`Installer asset ${name} SHA-256 does not match the GitHub API digest.`);
    }

    seenPlatforms.add(platform);
    verifiedArtifacts.push({
      name,
      platform,
      size: local.size,
      sha256: local.sha256,
    });
  }

  if (verifiedArtifacts.length === 0) {
    throw new Error('Release contains no supported desktop installer assets.');
  }

  const missingPlatforms = REQUIRED_PLATFORMS.filter((platform) => !seenPlatforms.has(platform));
  if (missingPlatforms.length > 0) {
    throw new Error(`Release is missing installer platforms: ${missingPlatforms.join(', ')}.`);
  }

  return { tag, releaseUrl: expectedReleaseUrl, artifacts: verifiedArtifacts };
}

async function main() {
  const [releaseJsonPath, localDir, downloadedDir] = process.argv.slice(2);
  if (!releaseJsonPath || !localDir || !downloadedDir) {
    console.error(
      'Usage: node scripts/verify-release-assets.mjs <release-json> <local-artifacts-dir> <downloaded-assets-dir>',
    );
    process.exitCode = 2;
    return;
  }

  try {
    const release = JSON.parse(fs.readFileSync(releaseJsonPath, 'utf8'));
    const result = await verifyReleaseArtifacts({ release, localDir, downloadedDir });
    console.log(
      `Verified ${result.artifacts.length} installer artifact(s) for ${result.tag}: local bytes, downloaded bytes and GitHub API SHA-256 agree.`,
    );
    for (const artifact of result.artifacts) {
      console.log(
        `- ${artifact.name} (${artifact.platform}, ${artifact.size} bytes, sha256:${artifact.sha256})`,
      );
    }
  } catch (error) {
    console.error(`Release artifact verification failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  void main();
}
