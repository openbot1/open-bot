# Updater production smoke-test checklist

This checklist covers the updater that exists today: release discovery, track selection, status reporting and opening the official download page. It does **not** test or imply in-app download, signature verification during update, automatic installation or rollback.

Run this checklist only against a release that has been published and is visible through the public GitHub Releases API. A draft release is not a live updater test.

## Evidence to record

For every run, record:

- Full source commit SHA of the installed build and the root product version.
- OS and architecture, app build date, and selected update track.
- The exact release tag/version expected from the published feed.
- The observed updater status: `currentVersion`, `track`, `available`, `latestVersion`, `latestTag`, `htmlUrl`, `checkFailed`, `feedStatus`, `lastCheckedAt` and `lastError`.
- Whether the UI showed the expected update state and opened the expected official release page.

Do not include API keys, tokens, signing credentials, private environment values or user data in the evidence.

## Preconditions

1. Confirm the test build's exact source SHA and root `package.json` version. Do not rely on a version label alone.
2. Confirm the intended GitHub Release is published and its tag/version is correct.
3. For `stable`, use a published non-prerelease release. For `dogfood`, `nightly` and `lab`, use a published prerelease whose tag follows the corresponding channel convention in [update-tracks.md](update-tracks.md).
4. Confirm the test build's current version is lower than the candidate version for a positive update test. Use a separate same-version or newer-version build for the negative test.
5. Use a clean test profile or record the current track before changing it.

## Test procedure

### 1. Track selection and persistence

For each of `stable`, `dogfood`, `nightly` and `lab`:

1. Open Settings → Updates and select the intended track.
2. Confirm the status view reports that exact track.
3. Restart the app and confirm the selection persists.
4. Confirm a missing or invalid stored track safely falls back to `stable` only in a disposable test profile; do not edit a production user's update-track file.

### 2. Positive update discovery

Use a build whose current version is lower than the published candidate.

1. Trigger **Check for updates** manually.
2. Confirm `available` becomes true and `checkFailed` remains false.
3. Confirm `latestVersion` and `latestTag` identify the expected release for the selected track.
4. Confirm `htmlUrl` points to that release in the official `openbot1/open-bot` GitHub Releases area.
5. Confirm the UI presents the update and the manual download action opens that exact release page.

Do not accept a different channel's release as a valid result. A newer release on another track is not a substitute for the selected channel's candidate.

### 3. No-update and channel-isolation cases

Run each case with a build whose current version is equal to or newer than the candidate:

- No newer release exists for the selected track.
- A newer release exists only on a different prerelease track.
- The selected prerelease track has no matching published release.

Expected outcome: `available: false` and `checkFailed: false` when the feed was successfully checked and simply contains no applicable newer release. The UI must not advertise a nonexistent update or silently substitute another track.

### 4. Feed failure and disabled-check cases

Exercise these cases in a disposable test environment:

- GitHub API/network unavailable or returns an error.
- Feed response is malformed or cannot be interpreted.
- Update checking is disabled with `OPEN_BOT_DISABLE_UPDATE=1` (also verify the documented `true` form).

Expected outcome: `available: false`, `checkFailed: true`, and a useful failure status/error. A feed failure must not be presented as “up to date”. When checking is disabled, verify the documented disabled error code and that the check does not make a feed request.

After restoring network access and removing the disable flag, trigger another manual check. Confirm a successful check clears the previous error. Also confirm a later periodic check remains scheduled after a transient failure; the default interval is six hours.

### 5. Manual download boundary

1. Activate the update's download action.
2. Confirm it opens the expected official GitHub Release page rather than an arbitrary host or a direct unverified binary URL.
3. Download the installer manually and follow the native artifact verification procedure in [RELEASING.md](RELEASING.md) before installation.
4. Confirm the UI does not claim that the update was installed automatically.

The current `quitAndInstallUpdate()` path deliberately returns `installed: false`. The application is check-and-manual-download only. Do not mark this checklist complete by testing only the button label or a mocked updater response.

## Acceptance record

| Track | Published tag | Positive discovery | No-update / isolation | Feed failure | Official page opened | Result |
|---|---|---|---|---|---|---|
| stable | | | | | | |
| dogfood | | | | | | |
| nightly | | | | | | |
| lab | | | | | | |

Record the exact build SHA and OS/architecture beside this table. Attach sanitized status output or screenshots where useful.

A successful smoke test proves only that the published feed and existing manual-download path behaved as expected for the recorded build and environment. It does not prove artifact authenticity, native signing/notarization, byte-for-byte agreement with uploaded assets, in-app installation, migration or rollback. Complete the separate gates in [RELEASING.md](RELEASING.md) and [TESTING.md](TESTING.md) before production sign-off.
