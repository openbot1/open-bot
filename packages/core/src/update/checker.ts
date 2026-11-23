/**
 * Self-update check (v0.7, ROADMAP §2d: "Cơ chế tự cập nhật").
 *
 * Realistic scope for an unsigned Electron app: CHECK + NOTIFY, not
 * silent self-replacement. `checkForUpdate` asks the GitHub releases
 * API for the repo's latest `v*` tag and compares semver with the
 * running version. When a newer release exists the UI shows the
 * version + a download link and offers to open it in the browser.
 * The app NEVER overwrites its own files while running (Electron
 * autoUpdater needs code-signing + a feed the project does not have
 * yet — that is a documented limitation, not a silent gap).
 *
 * v0.59: `checkForTrackUpdate` extends the same check to the
 * `dogfood` / `nightly` / `lab` tracks. It lists releases
 * (`/releases?per_page=20`, newest first) and picks the first release
 * of the track's channel:
 *   - `stable`: first release with `prerelease: false`;
 *   - `dogfood` / `nightly` / `lab`: first release with
 *     `prerelease: true` whose tag carries the channel suffix, e.g.
 *     `v0.59.0-dogfood.1`, `v0.59.0-nightly.20261109`,
 *     `v0.59.0-lab.1`.
 * The code is real (fetch + parse + semver compare, injectable fetch
 * so tests use a fake feed and never hit the network), but no channel
 * releases exist yet — push GitHub is still deferred — so until such
 * releases are actually published the check honestly answers "no newer
 * release for this channel". The releases-list URL is configurable
 * (`releasesListApiUrl`) for a self-hosted feed later.
 *
 * Pure except for the injected fetch: tests pass a mock fetch, main
 * passes the global fetch. No network call is made when the caller
 * passes no fetch implementation and none exists globally.
 */
import { verifyGitHubReleaseArtifactMetadata } from './artifactTrust';
import type { UpdateTrack } from './tracks';

export const UPDATE_REPO = 'openbot1/open-bot';
export const UPDATE_RELEASES_API = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
/** Releases list (newest first) — source for the non-stable track checks. */
export const UPDATE_RELEASES_LIST_API = `https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=20`;

export interface UpdateCheckResult {
  /** True when a newer stable release exists. */
  available: boolean;
  /** Version of the running app (as passed in). */
  currentVersion: string;
  /** Latest release tag, e.g. "v0.7.0" (null when the API gave none). */
  latestVersion: string | null;
  /** Release tag as published. */
  latestTag: string | null;
  /** Browser URL of the release page (null when unknown). */
  htmlUrl: string | null;
  /** True when the check itself failed (network/API) — `available` is false then. */
  checkFailed: boolean;
  error?: string;
}

export type UpdateFetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; url?: string; json: () => Promise<unknown> }>;

/** Parse "v1.2.3" / "1.2.3" / "1.2" into [major, minor, patch]; null when unparseable. */
export function parseSemver(version: string): [number, number, number] | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/.exec(version.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/** Compare two semver strings: -1 / 0 / 1. Unparseable versions compare as equal (0). */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

export async function checkForUpdate(opts: {
  currentVersion: string;
  fetchImpl?: UpdateFetchLike;
  releasesApiUrl?: string;
  timeoutMs?: number;
}): Promise<UpdateCheckResult> {
  const currentVersion = opts.currentVersion?.trim() || '0.0.0';
  const base: UpdateCheckResult = {
    available: false,
    currentVersion,
    latestVersion: null,
    latestTag: null,
    htmlUrl: null,
    checkFailed: false,
  };
  const fetchFn: UpdateFetchLike | undefined =
    opts.fetchImpl ?? (typeof globalThis.fetch === 'function'
      ? (globalThis.fetch as unknown as UpdateFetchLike)
      : undefined);
  if (!fetchFn) {
    return { ...base, checkFailed: true, error: 'Không có fetch để kiểm tra bản mới.' };
  }
  const releasesApiUrl = opts.releasesApiUrl ?? UPDATE_RELEASES_API;
  if (releasesApiUrl !== UPDATE_RELEASES_API) {
    return { ...base, checkFailed: true, error: 'Từ chối update feed không phải GitHub API endpoint canonical của openbot1/open-bot.' };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
    try {
      const res = await fetchFn(releasesApiUrl, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (typeof res.url === 'string' && res.url !== releasesApiUrl) {
        return { ...base, checkFailed: true, error: 'GitHub update feed redirect tới endpoint khác; đã từ chối.' };
      }
      const data = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        const msg = typeof data['message'] === 'string' ? data['message'] : `HTTP ${res.status}`;
        return { ...base, checkFailed: true, error: `GitHub API lỗi: ${msg}` };
      }
      const tag = typeof data['tag_name'] === 'string' ? data['tag_name'] : null;
      if (!tag) {
        return { ...base, checkFailed: true, error: 'Release stable thiếu tag_name hợp lệ.' };
      }
      if (data['prerelease'] !== false) {
        return { ...base, checkFailed: true, error: 'Feed stable trỏ tới release không được xác nhận là stable.' };
      }
      const artifactTrust = verifyGitHubReleaseArtifactMetadata(data, tag);
      if (!artifactTrust.verified || !artifactTrust.releaseUrl) {
        return {
          ...base,
          checkFailed: true,
          error: `Metadata release/artifact không hợp lệ: ${artifactTrust.reason ?? 'không xác định'}.`,
        };
      }
      const latest = tag.replace(/^v/, '');
      return {
        ...base,
        latestVersion: latest,
        latestTag: tag,
        htmlUrl: artifactTrust.releaseUrl,
        available: compareSemver(latest, currentVersion) > 0,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Lỗi không xác định.';
    return { ...base, checkFailed: true, error: `Không kiểm tra được bản mới: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// v0.59: per-track check (dogfood / nightly / lab via the releases list)
// ---------------------------------------------------------------------------

/** Minimal shape of one GitHub release as returned by the list API. */
export interface GitHubReleaseSummary {
  tag_name: string;
  prerelease: boolean;
  html_url: string | null;
  /** Raw trust-critical fields retained for validation before reporting availability. */
  draft?: unknown;
  assets?: unknown;
}

/**
 * Return the first prerelease identifier only for a valid SemVer release tag.
 * Channel names are defined as the first prerelease identifier (for example,
 * `-nightly.20261109`), not an arbitrary substring later in the tag.
 */
function firstPrereleaseIdentifier(tagName: string): string | null {
  const match =
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      tagName,
    );
  if (!match) return null;

  const coreParts = [match[1], match[2], match[3]];
  if (coreParts.some((part) => !Number.isSafeInteger(Number(part)))) return null;

  const identifiers = match[4].split('.');
  if (
    identifiers.some(
      (identifier) =>
        /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0'),
    )
  ) {
    return null;
  }
  return identifiers[0].toLowerCase();
}

/**
 * True when a release belongs to `track`'s channel. `stable` takes the
 * first non-prerelease; other tracks require the exact first prerelease
 * identifier to equal the channel name.
 */
export function releaseMatchesTrack(
  release: { tag_name?: unknown; prerelease?: unknown; draft?: unknown },
  track: UpdateTrack,
): boolean {
  if (typeof release.tag_name !== 'string' || release.tag_name === '') return false;
  if (release.draft === true) return false;
  if (track === 'stable') return release.prerelease === false;
  return release.prerelease === true && firstPrereleaseIdentifier(release.tag_name) === track;
}

/** First release of the track's channel in a newest-first list (null when none). */
export function pickReleaseForTrack(
  releases: ReadonlyArray<{
    tag_name?: unknown;
    prerelease?: unknown;
    draft?: unknown;
    html_url?: unknown;
    assets?: unknown;
  }>,
  track: UpdateTrack,
): GitHubReleaseSummary | null {
  for (const r of releases) {
    if (!releaseMatchesTrack(r, track)) continue;
    return {
      tag_name: r.tag_name as string,
      prerelease: r.prerelease === true,
      html_url: typeof r.html_url === 'string' ? r.html_url : null,
      draft: r.draft,
      assets: r.assets,
    };
  }
  return null;
}

/**
 * Check a track's channel for a newer release (real fetch + parse +
 * semver compare; `fetchImpl` injectable so tests use a fake feed).
 * No matching release for the channel is NOT an error — it means no
 * release has been published for that channel yet (`available: false`,
 * `checkFailed: false`). Network/API/malformed-feed failures are
 * fail-soft (`checkFailed: true`, `available: false`), same as stable.
 */
export async function checkForTrackUpdate(opts: {
  currentVersion: string;
  track: UpdateTrack;
  fetchImpl?: UpdateFetchLike;
  releasesListApiUrl?: string;
  timeoutMs?: number;
}): Promise<UpdateCheckResult> {
  const currentVersion = opts.currentVersion?.trim() || '0.0.0';
  const base: UpdateCheckResult = {
    available: false,
    currentVersion,
    latestVersion: null,
    latestTag: null,
    htmlUrl: null,
    checkFailed: false,
  };
  const fetchFn: UpdateFetchLike | undefined =
    opts.fetchImpl ?? (typeof globalThis.fetch === 'function'
      ? (globalThis.fetch as unknown as UpdateFetchLike)
      : undefined);
  if (!fetchFn) {
    return { ...base, checkFailed: true, error: 'Không có fetch để kiểm tra bản mới.' };
  }
  const releasesListApiUrl = opts.releasesListApiUrl ?? UPDATE_RELEASES_LIST_API;
  if (releasesListApiUrl !== UPDATE_RELEASES_LIST_API) {
    return { ...base, checkFailed: true, error: 'Từ chối update feed không phải GitHub API endpoint canonical của openbot1/open-bot.' };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
    try {
      const res = await fetchFn(releasesListApiUrl, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (typeof res.url === 'string' && res.url !== releasesListApiUrl) {
        return { ...base, checkFailed: true, error: 'GitHub update feed redirect tới endpoint khác; đã từ chối.' };
      }
      const data: unknown = await res.json();
      if (!res.ok) {
        const msg =
          typeof data === 'object' && data !== null && typeof (data as Record<string, unknown>)['message'] === 'string'
            ? ((data as Record<string, unknown>)['message'] as string)
            : `HTTP ${res.status}`;
        return { ...base, checkFailed: true, error: `GitHub API lỗi: ${msg}` };
      }
      if (!Array.isArray(data)) {
        return { ...base, checkFailed: true, error: 'Feed phát hành trả về dữ liệu không đúng dạng (cần một danh sách release).' };
      }
      const picked = pickReleaseForTrack(data as Array<Record<string, unknown>>, opts.track);
      if (!picked) {
        // Honest "nothing published for this channel yet" — not an error.
        return base;
      }
      const artifactTrust = verifyGitHubReleaseArtifactMetadata(picked, picked.tag_name);
      if (!artifactTrust.verified || !artifactTrust.releaseUrl) {
        return {
          ...base,
          checkFailed: true,
          error: `Metadata release/artifact không hợp lệ: ${artifactTrust.reason ?? 'không xác định'}.`,
        };
      }
      const latest = picked.tag_name.replace(/^v/, '');
      return {
        ...base,
        latestVersion: latest,
        latestTag: picked.tag_name,
        htmlUrl: artifactTrust.releaseUrl,
        available: compareSemver(latest, currentVersion) > 0,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Lỗi không xác định.';
    return { ...base, checkFailed: true, error: `Không kiểm tra được bản mới: ${message}` };
  }
}
