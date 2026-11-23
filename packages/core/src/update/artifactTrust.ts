/**
 * Validate the metadata that links a GitHub Releases feed entry to its
 * downloadable desktop artifacts.
 *
 * This is a feed-to-artifact consistency check only. GitHub's digest field
 * is metadata returned by the same API; this function does NOT download bytes,
 * recompute SHA-256, verify Authenticode/code signatures, or prove publisher
 * identity. Those checks remain a separate native release gate.
 */

export type VerifiedArtifactPlatform = 'linux' | 'macos' | 'windows';

export interface VerifiedReleaseArtifact {
  name: string;
  platform: VerifiedArtifactPlatform;
  size: number;
  sha256: string;
  browserDownloadUrl: string;
}

export interface ReleaseArtifactMetadataVerification {
  verified: boolean;
  tag: string | null;
  releaseUrl: string | null;
  artifacts: VerifiedReleaseArtifact[];
  reason?: string;
}

const TRUSTED_REPOSITORY = 'openbot1/open-bot';
const TRUSTED_RELEASE_BASE = `https://github.com/${TRUSTED_REPOSITORY}/releases`;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function platformForArtifactName(name: string): VerifiedArtifactPlatform | null {
  if (/\.appimage$/i.test(name)) return 'linux';
  if (/\.dmg$/i.test(name)) return 'macos';
  if (/\.exe$/i.test(name)) return 'windows';
  return null;
}

function validTag(tag: string): boolean {
  return /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(tag);
}

/**
 * Verify canonical repository URLs, release tag, publication state, and
 * every supported installer asset's uploaded state, file name, positive size
 * and GitHub-provided SHA-256 digest. Any malformed supported installer
 * rejects the release rather than silently trusting only another platform.
 */
export function verifyGitHubReleaseArtifactMetadata(
  release: unknown,
  expectedTag?: string,
): ReleaseArtifactMetadataVerification {
  const fail = (reason: string): ReleaseArtifactMetadataVerification => ({
    verified: false,
    tag: null,
    releaseUrl: null,
    artifacts: [],
    reason,
  });

  if (!isRecord(release)) return fail('release response is not an object');

  const tag = typeof release['tag_name'] === 'string' ? release['tag_name'] : '';
  if (!tag || tag.length > 128 || !validTag(tag)) return fail('release tag is missing or invalid');
  if (expectedTag !== undefined && tag !== expectedTag) return fail('release tag does not match the selected feed entry');

  if (release['draft'] !== false) return fail('release is draft or publication state is missing');
  if (typeof release['prerelease'] !== 'boolean') return fail('release prerelease flag is missing');

  const releaseUrl = `${TRUSTED_RELEASE_BASE}/tag/${encodeURIComponent(tag)}`;
  if (release['html_url'] !== releaseUrl) return fail('release page URL is not the canonical repository URL');

  const rawAssets = release['assets'];
  if (!Array.isArray(rawAssets)) return fail('release assets are missing or malformed');

  const artifacts: VerifiedReleaseArtifact[] = [];
  const seenNames = new Set<string>();
  const seenPlatforms = new Set<VerifiedArtifactPlatform>();
  let supportedAssetCount = 0;

  for (const rawAsset of rawAssets) {
    if (!isRecord(rawAsset)) continue;
    const name = typeof rawAsset['name'] === 'string' ? rawAsset['name'] : '';
    const platform = platformForArtifactName(name);
    if (!platform) continue;

    supportedAssetCount += 1;
    seenPlatforms.add(platform);
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._ +()\-]{0,199}$/.test(name) ||
      name === '.' ||
      name === '..'
    ) {
      return fail('installer asset name is not a safe basename');
    }
    if (seenNames.has(name)) return fail('release contains duplicate installer asset names');
    seenNames.add(name);

    if (rawAsset['state'] !== 'uploaded') return fail(`installer asset ${name} is not uploaded`);
    const size = rawAsset['size'];
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) {
      return fail(`installer asset ${name} has an invalid size`);
    }

    const digest = rawAsset['digest'];
    const digestMatch = typeof digest === 'string' ? /^sha256:([a-f0-9]{64})$/i.exec(digest) : null;
    if (!digestMatch) return fail(`installer asset ${name} is missing a valid SHA-256 digest`);

    const expectedDownloadUrl = `${TRUSTED_RELEASE_BASE}/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
    if (rawAsset['browser_download_url'] !== expectedDownloadUrl) {
      return fail(`installer asset ${name} download URL is not canonical for this tag/repository`);
    }

    artifacts.push({
      name,
      platform,
      size,
      sha256: digestMatch[1].toLowerCase(),
      browserDownloadUrl: expectedDownloadUrl,
    });
  }

  if (supportedAssetCount === 0 || artifacts.length === 0) {
    return fail('release contains no supported desktop installer asset (.AppImage, .dmg, or .exe)');
  }

  const requiredPlatforms: VerifiedArtifactPlatform[] = ['linux', 'macos', 'windows'];
  const missingPlatforms = requiredPlatforms.filter((platform) => !seenPlatforms.has(platform));
  if (missingPlatforms.length > 0) {
    return fail(`release is missing required desktop installer platforms: ${missingPlatforms.join(', ')}`);
  }

  return { verified: true, tag, releaseUrl, artifacts };
}
