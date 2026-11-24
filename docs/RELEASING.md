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

## Verify the exact release artifacts before publishing

The preflight above checks the source tag, working tree, synchronized versions, host and credential presence. It does **not** prove that the generated DMG or NSIS installer is correctly signed, that Apple's notary service accepted the app, or that the final artifact contains the expected ticket. Perform the checks below on the native host against the exact files intended for the draft release.

### macOS DMG (native macOS host)

1. Verify the DMG container before mounting it:

```bash
hdiutil verify "<path-to-open-bot.dmg>"
```

2. Mount the DMG read-only, locate the bundled `open-bot.app`, then verify the nested code and Gatekeeper assessment:

```bash
hdiutil attach -readonly -nobrowse "<path-to-open-bot.dmg>"
codesign --verify --deep --strict --verbose=2 "<mounted-path>/open-bot.app"
spctl --assess --type execute --verbose=4 "<mounted-path>/open-bot.app"
```

3. Validate the notarization ticket on the exact distribution item to which it was stapled. The app bundle and disk image are separate possible stapling targets; validate the one the release process actually stapled:

```bash
xcrun stapler validate "<mounted-path>/open-bot.app"
# Or, when the DMG itself is the stapled item:
xcrun stapler validate "<path-to-open-bot.dmg>"
```

4. Record the notary submission as **Accepted**, inspect its log for errors/warnings, and verify that the Team ID / signing identity matches the release identity configured by the maintainer. Do not treat a successful `codesign` check alone as proof of notarization or Gatekeeper acceptance.

### Windows NSIS installer (native Windows host)

Run PowerShell against the final installer file:

```powershell
$signature = Get-AuthenticodeSignature -LiteralPath "<path-to-open-bot-setup.exe>"
if ($signature.Status -ne 'Valid') {
  throw "Installer Authenticode verification failed: $($signature.Status) — $($signature.StatusMessage)"
}
$signature | Format-List Status, StatusMessage, SignerCertificate
```

Also compare the signer certificate subject and thumbprint with the release identity approved by the maintainer. A `Valid` status proves that Windows validated the Authenticode signature chain for that file; it does not by itself prove that the signer is the intended open-bot publisher.

### Linux AppImage

The current AppImage target is **not GPG-signed**. Do not claim signature authenticity or treat a checksum as a digital signature. Record the digest of the exact file reviewed:

```bash
sha256sum "<path-to-open-bot.AppImage>"
```

Use the digest only to compare copies of that exact artifact (for example, the file reviewed locally and the file attached to the draft release).

### Final release approval

- Verify the exact final DMG / NSIS / AppImage files after packaging; do not substitute a source build, a different architecture, or a rebuilt file after verification.
- Keep the release in draft if any required native signature, notarization, ticket or publisher-identity check fails or cannot be performed.
- Record the artifact filename, SHA-256 digest, target architecture, native verification result and signer/notary identity in the release approval record.
- After uploading assets, compare the uploaded asset names and digests with the verified files. Do not publish if an asset changed after verification.
- These are maintainer-operated release checks, not checks executed by the source PR gate. The new checklist regression test only prevents this procedure from silently disappearing; it does not verify any real signature, notarization or artifact.

References: [Apple code-signature verification and Gatekeeper assessment](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/Procedures/Procedures.html), [Apple notarization and stapling workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow), and [Microsoft Get-AuthenticodeSignature](https://learn.microsoft.com/powershell/module/microsoft.powershell.security/get-authenticodesignature).

### Release approval record

For each candidate version, copy [`docs/RELEASE-APPROVAL-RECORD.md`](RELEASE-APPROVAL-RECORD.md) into the release evidence bundle or approval issue and fill it using the exact source commit and final uploaded files. The record captures the build/test gate, per-artifact hashes, native signing/notarization evidence, GitHub asset state and independent uploaded-file comparison. Do not put certificate files, passwords, API keys or other secrets in the record. Keep the GitHub Release in draft until every required row is complete and approved.

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
