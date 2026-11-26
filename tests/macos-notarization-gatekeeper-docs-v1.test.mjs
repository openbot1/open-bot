/**
 * Static regression guard for the macOS notarization / Gatekeeper procedure.
 *
 * These assertions lock the operator documentation only. They do not run
 * codesign, notarytool, stapler, spctl, or verify a real DMG on macOS.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const GUIDE = fs.readFileSync(
  path.join(process.cwd(), 'docs/MACOS-NOTARIZATION-GATEKEEPER-VERIFICATION.md'),
  'utf8',
);

test('procedure is scoped to every exact arm64 and x64 release DMG and source SHA', () => {
  assert.ok(GUIDE.includes('arm64 and x64'));
  assert.ok(GUIDE.includes('full immutable source commit SHA'));
  assert.ok(GUIDE.includes('exact filename'));
  assert.ok(GUIDE.includes('separately for every final architecture-specific DMG'));
});

test('DMG integrity and read-only mounting are required before inspecting the app', () => {
  assert.ok(GUIDE.includes('hdiutil verify'));
  assert.ok(GUIDE.includes('hdiutil attach -readonly -nobrowse'));
  assert.ok(GUIDE.includes('hdiutil detach'));
});

test('nested app signature and independently approved Developer ID team identity are checked', () => {
  assert.ok(GUIDE.includes('codesign --verify --deep --strict --verbose=2'));
  assert.ok(GUIDE.includes('codesign --display --verbose=4'));
  assert.ok(GUIDE.includes('TeamIdentifier=$EXPECTED_TEAM_ID'));
  assert.ok(GUIDE.includes('Developer ID Application'));
  assert.ok(GUIDE.includes('independently approved'));
});

test('notarytool history, info and log are tied to the exact submission ID', () => {
  assert.ok(GUIDE.includes('notarytool history --keychain-profile'));
  assert.ok(GUIDE.includes('notarytool info "$SUBMISSION_ID"'));
  assert.ok(GUIDE.includes('notarytool log "$SUBMISSION_ID"'));
  assert.ok(GUIDE.includes('notarytool submit "$DMG_PATH"'));
  assert.ok(GUIDE.includes('final status to be **Accepted**'));
});

test('notary logs are reviewed even after Accepted and unresolved issues cause a hold', () => {
  assert.ok(GUIDE.includes('Inspect the log even when the status is Accepted'));
  assert.ok(GUIDE.includes('record the disposition of each warning'));
  assert.ok(GUIDE.includes('unresolved errors/warnings'));
  assert.ok(GUIDE.includes('In Progress'));
});

test('app and outer DMG stapling targets remain distinct and final bytes are rehashed', () => {
  assert.ok(GUIDE.includes('xcrun stapler validate "$DMG_PATH"'));
  assert.ok(GUIDE.includes('xcrun stapler validate "$APP_PATH"'));
  assert.ok(GUIDE.includes('xcrun stapler staple "$DMG_PATH"'));
  assert.ok(GUIDE.includes('Never try to staple an app-bundle ticket to the outer DMG'));
  assert.ok(GUIDE.includes('after any staple operation, rerun'));
  assert.ok(GUIDE.includes('repeat the three-way byte reconciliation'));
});

test('Gatekeeper assessment requires acceptance without weakening host security', () => {
  assert.ok(GUIDE.includes('spctl --assess --type execute --verbose=4 "$APP_PATH"'));
  assert.ok(GUIDE.includes('Require exit status 0 and an **accepted** assessment'));
  assert.ok(GUIDE.includes('Do not disable Gatekeeper'));
  assert.ok(GUIDE.includes('manual override'));
});

test('release evidence and stop conditions keep the candidate draft on any missing proof', () => {
  assert.ok(GUIDE.includes('Keep the GitHub Release in draft'));
  assert.ok(GUIDE.includes('operator and UTC timestamp'));
  assert.ok(GUIDE.includes('notary submission ID, status and complete JSON log'));
  assert.ok(GUIDE.includes('Do not retain API keys, private keys, passwords'));
  assert.ok(GUIDE.includes('local final-DMG hash, downloaded-asset hash, and GitHub Release API digest'));
});

test('procedure cites the current Apple notarization, stapling and Gatekeeper references', () => {
  assert.ok(GUIDE.includes('developer.apple.com/documentation/security/notarizing-macos-software-before-distribution'));
  assert.ok(GUIDE.includes('developer.apple.com/documentation/security/customizing-the-notarization-workflow'));
  assert.ok(GUIDE.includes('developer.apple.com/documentation/technotes/tn3147-migrating-to-the-latest-notarization-tool'));
  assert.ok(GUIDE.includes('developer.apple.com/documentation/security/resolving-common-notarization-issues'));
  assert.ok(GUIDE.includes('developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution'));
});
