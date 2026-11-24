# Release approval record — open-bot

> Copy this file for one release candidate. Replace every `[TODO]` field and retain evidence links or immutable log references. Do not paste credentials, certificate contents, private keys, passwords, API keys or secret environment values into this record.

## 1. Release identity and source snapshot

| Field | Value |
|---|---|
| Product version (root `package.json`) | [TODO] |
| Release tag | [TODO] |
| Track (`stable` / `dogfood` / `nightly` / `lab`) | [TODO] |
| Full source commit SHA | [TODO] |
| Source branch | [TODO] |
| Exact tag points to source SHA | [TODO: yes/no + evidence] |
| Working tree clean at release build | [TODO: yes/no + evidence] |
| `npm run version:check` | [TODO: pass/fail + log] |
| Node.js / npm versions | [TODO] |
| Build command and result | [TODO] |
| Typecheck command and result | [TODO] |
| Full-suite command and result | [TODO: pass / fail / skipped counts] |
| Full-suite failures | [TODO: must be 0 to approve] |
| Skipped tests and reasons | [TODO] |
| GitHub Actions run for this exact SHA (Ubuntu) | [TODO: URL + result] |
| GitHub Actions run for this exact SHA (Windows) | [TODO: URL + result] |
| GitHub Actions run for this exact SHA (macOS) | [TODO: URL + result] |
| Platform-test jobs for this exact SHA | [TODO: URLs + results] |

**Source gate:** do not approve a release unless build, typecheck, and the required full-suite gate pass on this exact SHA with zero test failures. A retest of an individual flaky test does not replace the original full-suite result; record both separately and resolve the full-suite failure before approval.

## 2. Exact artifacts reviewed

Create one row for every artifact actually produced, including separate architecture outputs where applicable. Compute the local SHA-256 from the exact final file after packaging, not from a rebuilt or intermediate file.

| Platform / target | Architecture | Exact filename | Size (bytes) | Local SHA-256 | Native verification result | Notes / evidence |
|---|---|---|---:|---|---|---|
| macOS DMG | [TODO] | [TODO] | [TODO] | [TODO] | [TODO] | [TODO] |
| Windows NSIS | x64 | [TODO] | [TODO] | [TODO] | [TODO] | [TODO] |
| Linux AppImage | x64 | [TODO] | [TODO] | [TODO] | **Unsigned** | [TODO] |

## 3. macOS Developer ID and notarization evidence

Complete on a native macOS host for every final DMG / architecture.

| Check | Result / evidence |
|---|---|
| `hdiutil verify` on exact DMG | [TODO] |
| Read-only mount completed and exact `open-bot.app` identified | [TODO] |
| `codesign --verify --deep --strict --verbose=2` | [TODO] |
| `spctl --assess --type execute --verbose=4` | [TODO] |
| Signing identity / certificate subject | [TODO] |
| Team ID matches maintainer-approved identity | [TODO] |
| Notary submission ID | [TODO] |
| Notary result is **Accepted** | [TODO] |
| Notary log reviewed; warnings/errors disposition | [TODO] |
| Stapled item (`open-bot.app` or DMG) | [TODO] |
| `xcrun stapler validate` on that exact stapled item | [TODO] |
| Evidence references (commands, logs, timestamps) | [TODO] |

A successful code-signature check alone is not evidence of notarization. The stapler check must target the exact item that received the ticket.

## 4. Windows Authenticode evidence

Complete on a native Windows host for every final NSIS installer.

| Check | Result / evidence |
|---|---|
| `Get-AuthenticodeSignature -LiteralPath` status is `Valid` | [TODO] |
| Signer certificate subject | [TODO] |
| Signer thumbprint | [TODO] |
| Thumbprint matches maintainer-approved release identity | [TODO] |
| Certificate validity / chain result and verification time | [TODO] |
| Evidence reference (PowerShell output, timestamp) | [TODO] |

A `Valid` status does not by itself prove the signer is the intended open-bot publisher. Compare subject and thumbprint with the separately approved identity.

## 5. Linux AppImage integrity (not publisher authentication)

The current Linux AppImage is **not GPG-signed**. Do not label it signed or authenticated. Record only the exact-file integrity check:

| Check | Result / evidence |
|---|---|
| `sha256sum` of exact AppImage | [TODO] |
| Size and architecture | [TODO] |
| Explicit status recorded as **unsigned / no publisher signature** | [TODO] |

A checksum can detect a changed copy when compared with a trusted reference; it does not establish publisher identity.

## 6. GitHub Release upload reconciliation

Keep the Release as **draft** while collecting evidence. Record each uploaded asset independently; do not assume the release page or tag alone identifies the reviewed bytes.

| Field | Value |
|---|---|
| GitHub Release URL | [TODO] |
| Release ID / tag | [TODO] |
| `draft` remains `true` during review | [TODO] |
| `prerelease` matches the selected track | [TODO] |
| Uploaded asset names / states | [TODO: every required asset must be `uploaded`] |
| GitHub API `assets[].digest` values (required) | [TODO] |
| Download URLs from the exact Release | [TODO] |

For every asset, independently download the uploaded file from the exact release URL and recompute SHA-256. Compare:

1. local final artifact SHA-256;
2. SHA-256 of the independently downloaded uploaded asset;
3. GitHub API asset digest (required by the updater trust gate).

All three values must agree. A digest field returned by the same API feed is metadata, not a publisher signature and not a substitute for recomputing the downloaded file's hash.

## 7. Final approval and publication decision

- [ ] Source SHA, tag and root version agree.
- [ ] Build and typecheck passed on the exact source SHA.
- [ ] Full suite for the exact source SHA has zero failures; every skip has a recorded reason.
- [ ] Required CI and platform-test checks passed on the exact SHA.
- [ ] Every configured platform artifact exists and the exact file has been recorded.
- [ ] macOS signing, Gatekeeper and notarization/stapling checks are complete for each DMG.
- [ ] Windows Authenticode is valid and the signer matches the approved identity for each NSIS installer.
- [ ] Linux AppImage remains explicitly labelled unsigned.
- [ ] Each uploaded asset was independently downloaded and hash-compared with the reviewed local artifact.
- [ ] No artifact was rebuilt, replaced or modified after verification.
- [ ] All evidence is retained without including secrets.

| Approval | Name / role | Date (UTC or +07) | Evidence / notes |
|---|---|---|---|
| Release operator | [TODO] | [TODO] | [TODO] |
| Independent reviewer | [TODO] | [TODO] | [TODO] |
| Final publisher / maintainer | [TODO] | [TODO] | [TODO] |

**Decision:** [TODO: HOLD / APPROVED TO PUBLISH]

**Stop condition:** if any required check is missing, fails, refers to a different source SHA/artifact, or cannot be independently evidenced, keep the GitHub Release in draft. Never override a failed signature, notarization, hash comparison, or full-suite gate with a narrative explanation alone.
