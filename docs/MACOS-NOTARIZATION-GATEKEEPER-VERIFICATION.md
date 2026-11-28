# macOS DMG signing, notarization and Gatekeeper verification

**Status:** maintainer-operated release evidence procedure. This document does not build, sign, notarize, staple, upload, or publish a release automatically.

## Scope and trust boundary

The configured macOS release target produces Developer ID-signed, hardened-runtime DMGs for **arm64 and x64**. Perform this procedure separately for every final architecture-specific DMG that will be attached to the candidate GitHub Release.

The checks answer different questions and are not interchangeable:

- `codesign` verifies the app bundle's code signature and sealed resources.
- The signing identity / Team ID comparison identifies the publisher independently of the signature's mere validity.
- Apple notarization returns a submission result and ticket after Apple's automated checks. A successful signature check is not proof of notarization.
- `stapler validate` confirms a ticket is attached to the exact item being checked. A ticket stapled to an app bundle is not proof that the outer DMG has its own stapled ticket, and vice versa.
- `spctl` asks Gatekeeper to assess the app under the host Mac's current security policy.

A passing static test, a GitHub Actions run, an uploaded asset digest, or a successful build is not evidence that a real DMG passes these native checks.

## Required inputs and evidence directory

Use a native macOS host with a supported Xcode installation (which supplies `notarytool` and `stapler`). Use the maintainer-approved Developer ID Application identity and Team ID from a trusted source independent of the artifact being checked. The App Store Connect API key / notarytool keychain profile must be provisioned securely before verification; do not put credentials in shell history or release evidence.

For each DMG, record:

- release tag, full immutable source commit SHA, macOS architecture, exact filename and draft-release URL;
- expected Developer ID Application identity and independently approved Team ID;
- Xcode / macOS versions, operator and UTC verification time;
- notarytool submission ID for the exact payload submitted, its final status and JSON log;
- local final-DMG SHA-256 and size, plus the independently downloaded uploaded-DMG SHA-256 and GitHub Release API digest.

Example variables (replace every placeholder):

```bash
set -euo pipefail
DMG_PATH="/absolute/path/to/open-bot-<version>-<arch>.dmg"
EXPECTED_TEAM_ID="REPLACE_WITH_APPROVED_TEAM_ID"
NOTARY_PROFILE="open-bot-notary"
EVIDENCE_DIR="/absolute/path/to/release-evidence/macos-<arch>"
MOUNT_POINT="$EVIDENCE_DIR/mount"
mkdir -p "$EVIDENCE_DIR" "$MOUNT_POINT"
```

Do not infer the expected Team ID from the app under test. Do not continue if the source SHA, architecture, filename or approved identity is ambiguous.

## 1. Verify the exact DMG container and inspect its app

Verify the DMG before mounting, then mount it read-only and identify the exact bundled app:

```bash
hdiutil verify "$DMG_PATH" 2>&1 | tee "$EVIDENCE_DIR/hdiutil-verify-before.txt"
hdiutil attach -readonly -nobrowse -mountpoint "$MOUNT_POINT" "$DMG_PATH" \
  2>&1 | tee "$EVIDENCE_DIR/hdiutil-attach.txt"

APP_PATH="$MOUNT_POINT/open-bot.app"
test -d "$APP_PATH"
```

If the app is nested under a volume subdirectory, resolve and record its actual path. Never verify a different copy from a developer build or a previously installed app.

Verify the complete code signature and capture the signing details:

```bash
codesign --verify --deep --strict --verbose=2 "$APP_PATH" \
  2>&1 | tee "$EVIDENCE_DIR/codesign-verify.txt"
codesign --display --verbose=4 "$APP_PATH" \
  2>&1 | tee "$EVIDENCE_DIR/codesign-details.txt"
grep -F "TeamIdentifier=$EXPECTED_TEAM_ID" "$EVIDENCE_DIR/codesign-details.txt"
```

Require all commands to exit successfully. Review the recorded `Authority` chain and confirm the signer is the expected **Developer ID Application** identity and the Team ID matches the independently approved value. A successful `codesign --verify` alone does not establish the intended publisher.

## 2. Confirm notarization for the exact distribution item

The release build may notarize and staple the app bundle as part of electron-builder's macOS signing flow. That does not, by itself, establish that the **outer DMG** has a ticket stapled to it.

Use a protected notarytool keychain profile and query the submission history to locate the submission matching the exact app or DMG filename and release build. Do not guess the submission ID or use a submission belonging to another release:

```bash
xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" \
  --output-format json | tee "$EVIDENCE_DIR/notary-history.json"
```

Record the exact submission ID. Query its status and download the full JSON log:

```bash
SUBMISSION_ID="REPLACE_WITH_EXACT_SUBMISSION_ID"

xcrun notarytool info "$SUBMISSION_ID" \
  --keychain-profile "$NOTARY_PROFILE" \
  --output-format json | tee "$EVIDENCE_DIR/notary-info.json"

xcrun notarytool log "$SUBMISSION_ID" \
  --keychain-profile "$NOTARY_PROFILE" \
  "$EVIDENCE_DIR/notary-log.json"
```

Require the submission's final status to be **Accepted**. An `In Progress`, missing, unknown, `Invalid`, or `Rejected` result is a hold. Inspect the log even when the status is Accepted: review every issue, error and warning, record the disposition of each warning, and retain the log with the release evidence.

If there is no submission for the final DMG itself, and the release policy requires a ticket on that distribution image, submit that exact final DMG to the notary service using the approved profile:

```bash
xcrun notarytool submit "$DMG_PATH" \
  --keychain-profile "$NOTARY_PROFILE" \
  --wait --output-format json | tee "$EVIDENCE_DIR/notary-submit-dmg.json"
```

Capture the returned submission ID, then run the `info` and `log` commands above for that ID. Do not treat an Accepted submission for only the nested `.app` as the DMG's own submission. Apple accepts disk images as notarization inputs and supports stapling tickets to disk images and app bundles as distinct items.

## 3. Validate stapling on the exact item

After the relevant submission is Accepted, validate the ticket on the item that the release process actually stapled:

```bash
# If the final DMG itself was notarized and stapled:
xcrun stapler validate "$DMG_PATH" \
  2>&1 | tee "$EVIDENCE_DIR/stapler-validate-dmg.txt"

# If the app bundle was separately notarized and stapled:
xcrun stapler validate "$APP_PATH" \
  2>&1 | tee "$EVIDENCE_DIR/stapler-validate-app.txt"
```

If the final DMG has an Accepted ticket for that exact DMG but no staple is attached yet, staple it **before the final upload**, then validate it:

```bash
xcrun stapler staple "$DMG_PATH" \
  2>&1 | tee "$EVIDENCE_DIR/stapler-staple-dmg.txt"
xcrun stapler validate "$DMG_PATH" \
  2>&1 | tee "$EVIDENCE_DIR/stapler-validate-dmg.txt"
```

Never try to staple an app-bundle ticket to the outer DMG. Stapling changes the DMG bytes: after any staple operation, rerun `hdiutil verify`, recompute the final DMG size and SHA-256, and upload/re-upload that exact stapled file. If a previously uploaded asset is replaced, independently download it again and repeat the three-way byte reconciliation. Never leave an older, unstapled upload in the draft Release while recording evidence for a different local file.

## 4. Assess Gatekeeper on the mounted app

With the final DMG mounted read-only, assess the exact app bundle that it contains:

```bash
spctl --assess --type execute --verbose=4 "$APP_PATH" \
  2>&1 | tee "$EVIDENCE_DIR/gatekeeper-assessment.txt"
```

Require exit status 0 and an **accepted** assessment. Record the full verbose output, including the reported source and origin, and confirm the origin is consistent with the approved Developer ID / Team ID. An accepted result from `spctl` does not replace the explicit notarization-log and stapler checks above.

Do not disable Gatekeeper, clear quarantine to manufacture a pass, use a manual override, or weaken host security settings. For additional end-user confidence, repeat the assessment on a separate supported Mac using the exact DMG downloaded from the draft Release, not a local build copy.

When checks are complete, detach the read-only volume:

```bash
hdiutil detach "$MOUNT_POINT"
```

## 5. Hash the final distribution bytes and retain evidence

Only after all required stapling is complete, verify the final DMG again and compute its final digest:

```bash
hdiutil verify "$DMG_PATH" 2>&1 | tee "$EVIDENCE_DIR/hdiutil-verify-final.txt"
stat -f '%z' "$DMG_PATH" | tee "$EVIDENCE_DIR/dmg-size-bytes.txt"
shasum -a 256 "$DMG_PATH" | tee "$EVIDENCE_DIR/dmg-sha256.txt"
```

Independently download the exact uploaded asset and compute its SHA-256. Compare the local final-DMG hash, downloaded-asset hash, and GitHub Release API digest and byte size using the release asset reconciliation procedure. A GitHub API digest is metadata, not an independent publisher signature.

Retain the exact release tag/source SHA, architecture, DMG filename, size and hashes; codesign verification/details; approved Team ID and identity reference; notary submission ID, status and complete JSON log; stapler validation output for each stapled item; Gatekeeper verbose assessment; tool/OS versions; operator and UTC timestamp. Do not retain API keys, private keys, passwords, or other signing credentials.

## 6. Pass / hold criteria

**Pass only when all required checks for that architecture are complete:**

- The DMG is the exact final installer from the approved source SHA and its container verification succeeds.
- The bundled app's strict codesign verification succeeds and the Developer ID identity / Team ID matches the independently approved publisher.
- The exact notary submission is Accepted and its complete log has been reviewed, with all warnings dispositioned.
- The ticket validates on every distribution item that the release policy requires to be stapled; the outer DMG must not be assumed stapled merely because the app bundle is stapled.
- Gatekeeper accepts the app on the native host and its reported origin is consistent with the approved publisher.
- The final post-staple local DMG and independently downloaded uploaded DMG bytes reconcile with the GitHub API digest and size.
- Evidence is complete and unambiguously refers to this exact architecture, release tag, source SHA and artifact.

**Keep the GitHub Release in draft** if any command fails, the notary submission is not Accepted, the log has unresolved errors/warnings, the signer or Team ID is unexpected, stapler validation fails, Gatekeeper rejects or cannot establish the expected origin, the DMG changes after verification, or any evidence is missing or refers to another artifact. Do not publish based on a green build or a successful single command.

## References

- [Apple: Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [Apple: Customizing the notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow) — notarytool submit/status/log and stapling.
- [Apple TN3147: Migrating to the latest notarization tool](https://developer.apple.com/documentation/technotes/tn3147-migrating-to-the-latest-notarization-tool) — notarytool credentials, history, info and log.
- [Apple: Resolving common notarization issues](https://developer.apple.com/documentation/security/resolving-common-notarization-issues)
- [Apple: Packaging Mac software for distribution](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution) — stapling and testing the distributed product.
