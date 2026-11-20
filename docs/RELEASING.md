# Desktop release procedure

Updated: 2026-11-20. Applies to the electron-builder v26 configuration in this repository.

## What this pipeline publishes

The desktop package targets already declared in `apps/desktop/electron-builder.yml` are:

| Target | Artifact | Signing status |
|---|---|---|
| Linux x64 | AppImage | Not GPG-signed by this configuration |
| macOS arm64/x64 | DMG | Developer ID code signing + Apple notarization required |
| Windows x64 | NSIS installer | Authenticode code signing required |

The configured publisher is the repository's existing GitHub Releases provider (`openbot1/open-bot`). Build commands create/update a **draft** release so a maintainer can review artifacts and publish it. No separate update server is introduced. `publishAutoUpdate: false` deliberately suppresses electron-updater `latest*.yml` manifests because this app does not yet use electron-updater for installation; the current client continues to query the GitHub Releases API directly.

The update checker already reads the stable GitHub Releases endpoint and filters prerelease tags for `dogfood`, `nightly`, and `lab`. Once a release is published, the existing checker can discover it and the desktop app can open its release page.

**This does not implement in-app auto-install.** `UpdateService.quitAndInstallUpdate()` intentionally returns `installed: false`; the app does not download, verify and replace itself. A safe installer still needs signed artifact verification and end-to-end testing against a real release. Until that exists, users download and install manually from the official GitHub release page.

## Single version source

The root `package.json` is the canonical release version. Workspace package manifests and the corresponding `package-lock.json` entries are derived npm metadata.

```bash
npm run version:sync
npm run version:check
```

The sync runs before root build/typecheck/dev/dist entry points and before desktop workspace build/dist. The CLI reads the root manifest at runtime (falling back to npm's synchronized workspace version when relocated). Electron's `app.getVersion()` reads the desktop package version, which is synchronized before packaging.

When intentionally changing the product version:
1. Change only `package.json` at the repository root.
2. Run `npm run version:sync`.
3. Commit all changed workspace manifests and `package-lock.json`.
4. Require `npm run version:check` to pass before tagging.

Do not hand-edit workspace version numbers independently.

## Release prerequisites

All release commands require:

- A clean Git working tree.
- An exact tag matching the root package version: `v<version>`; prerelease tags may append `-dogfood...`, `-nightly...`, or `-lab...`.
- Workspace metadata passing `npm run version:check`.
- `GH_TOKEN` with permission to create/update releases in `openbot1/open-bot`.

The preflight script checks the host platform, tag, clean tree, synchronized versions, and required credentials. It never reads or prints certificate contents.

### macOS

Run on a macOS host. Configure these CI secrets/environment variables:

- `CSC_LINK`: base64 or path to a Developer ID Application `.p12` certificate.
- `CSC_KEY_PASSWORD`: certificate password.
- `APPLE_API_KEY`: App Store Connect `.p8` file path or base64 content.
- `APPLE_API_KEY_ID`: App Store Connect key ID.
- `APPLE_API_ISSUER`: App Store Connect issuer ID.
- `GH_TOKEN`: GitHub Releases publishing token.

The configuration sets `mac.forceCodeSigning: true`, `mac.hardenedRuntime: true`, and `mac.notarize: true`. Missing signing or notarization credentials must fail the release build rather than silently producing an unsigned/unnotarized DMG.

```bash
npm run release:mac
```

### Windows

Run on a Windows host. Configure:

- `WIN_CSC_LINK`: base64 or path to the Authenticode `.pfx`/`.p12` certificate (or `CSC_LINK`).
- `WIN_CSC_KEY_PASSWORD`: certificate password (or `CSC_KEY_PASSWORD`).
- `GH_TOKEN`: GitHub Releases publishing token.

The configuration sets `win.forceCodeSigning: true`.

```bash
npm run release:win
```

### Linux

Run on a Linux host with `GH_TOKEN`. The current configuration creates an AppImage, then publishes it to a draft GitHub Release:

```bash
npm run release:linux
```

The Linux AppImage is **not GPG-signed** by this configuration. Do not describe it as a signed release artifact.

## Release order

1. Merge the release-gate and other approved hardening work only after the independent checks described in `docs/TESTING.md` are green on the intended source snapshot.
2. Confirm that `npm run version:check`, build, typecheck and the full test suite pass on the exact commit being released.
3. Create and push the exact version tag from the approved commit.
4. Run the platform release command on each native host with its secrets configured.
5. Review the draft GitHub Release, verify each artifact and signature/notarization on the target OS, then publish the draft manually.
6. Confirm the published release appears in the existing GitHub Releases API and the desktop app shows the official download link.

Do not run release commands from a pull-request build or while the working tree contains generated changes.

## Known release limitations

- No release artifacts were published in the GitHub repository when this document was authored.
- No code-signing or notarization was executed as part of this pull request.
- Release credentials are external prerequisites and must be stored as CI secrets; never commit certificates, private keys, passwords or API key files.
- Linux AppImage signing/GPG verification is not configured here.
- The current updater is check-and-manual-download only; self-install, automatic signature verification during update and end-to-end update migration remain unimplemented.
