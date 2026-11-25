# Windows Authenticode verification for release installers

**Status:** maintainer-operated release evidence procedure. This document does not sign, modify, publish, or automatically approve an installer.

## Scope and trust boundary

The configured Windows release target is an **NSIS x64 installer** and electron-builder sets **win.forceCodeSigning: true**. Verify the exact final .exe produced for the candidate release, not an intermediate executable or a different rebuild.

Authenticode verification answers two separate questions:

1. Does Windows validate the signature and certificate chain for these exact bytes?
2. Is the validated signer the publisher identity that the maintainer approved for this release?

A Valid status alone does not answer the second question. The expected signer thumbprint must come from a separately approved, trusted release identity record. Never learn the expected value from the installer being checked.

This is a manual Windows-host gate. The existing release workflow's upload metadata checks, a GitHub API digest, a checksum, or a static test do not replace it.

## Required inputs

Before running the commands, record:

- The exact release tag and full source commit SHA used to build the installer.
- The exact final NSIS x64 installer filename and the draft-release asset URL.
- The approved publisher certificate thumbprint, obtained independently of the installer.
- The Windows host identity, Windows version, PowerShell version, UTC verification time, and operator.

First identify the exact installer intended for the draft release. Compute SHA-256 for the final local installer and for an independently downloaded copy of the uploaded GitHub asset. Reconcile both computed hashes with the GitHub Release API asset digest and byte size using the release asset reconciliation procedure. The API digest is metadata from the same service; it is not an independent publisher trust anchor.

Do not continue if the local file, downloaded asset, source SHA, filename, size, or digest is ambiguous or mismatched.

## 1. Verify signature status and approved signer with PowerShell

Run on Windows PowerShell or PowerShell 7 on a Windows host. Replace the installer path and the thumbprint placeholder with the exact values for this release.

```powershell
$ErrorActionPreference = 'Stop'

$installerPath = (Resolve-Path -LiteralPath '.\open-bot-setup.exe').Path
$expectedThumbprint = 'REPLACE_WITH_APPROVED_40_HEX_THUMBPRINT'

if ($expectedThumbprint -notmatch '^[A-Fa-f0-9]{40}$') {
  throw 'Supply the independently approved 40-hex certificate thumbprint.'
}

$expectedThumbprint = $expectedThumbprint.ToUpperInvariant()
$signature = Get-AuthenticodeSignature -LiteralPath $installerPath

if ($signature.Status -ne 'Valid') {
  throw "Authenticode status is not Valid: $($signature.Status) — $($signature.StatusMessage)"
}
if ($null -eq $signature.SignerCertificate) {
  throw 'Authenticode result has no signer certificate.'
}

$actualThumbprint = ($signature.SignerCertificate.Thumbprint -replace '\s', '').ToUpperInvariant()
if ($actualThumbprint -ne $expectedThumbprint) {
  throw "Signer thumbprint does not match the approved publisher identity: $actualThumbprint"
}

$fileHash = Get-FileHash -LiteralPath $installerPath -Algorithm SHA256
$evidence = [pscustomobject]@{
  File                   = $installerPath
  SizeBytes              = (Get-Item -LiteralPath $installerPath).Length
  SHA256                 = $fileHash.Hash
  SignatureStatus        = $signature.Status
  SignatureStatusMessage = $signature.StatusMessage
  SignerSubject          = $signature.SignerCertificate.Subject
  SignerIssuer           = $signature.SignerCertificate.Issuer
  SignerThumbprint       = $actualThumbprint
  SignerNotBefore        = $signature.SignerCertificate.NotBefore.ToUniversalTime().ToString('o')
  SignerNotAfter         = $signature.SignerCertificate.NotAfter.ToUniversalTime().ToString('o')
  TimestampSubject       = if ($signature.TimeStamperCertificate) { $signature.TimeStamperCertificate.Subject } else { $null }
  TimestampThumbprint    = if ($signature.TimeStamperCertificate) { $signature.TimeStamperCertificate.Thumbprint } else { $null }
}
$evidence | Format-List
```

The command fails closed unless Windows reports Valid, a signer certificate is present, and its complete thumbprint exactly matches the independently approved value. Preserve the output; do not copy the certificate's private material or signing password into release evidence.

Record the timestamp signer when one is present. Do not reject a certificate merely because its NotAfter date is in the past without evaluating the signature's trusted timestamp and Windows verification result; a valid timestamp can affect how certificate expiry is evaluated. If the release policy requires a timestamp, make that an explicit gate and use the SignTool /tw check below.

## 2. Corroborate with SignTool

Install the Windows SDK or use a Windows developer shell where signtool.exe is available. Verify the installer using the Default Authentication Verification Policy, all embedded signatures, and verbose output:

```powershell
$signtoolPath = (Get-Command signtool.exe -ErrorAction Stop).Source
& $signtoolPath verify /pa /all /v $installerPath
$signToolExitCode = $LASTEXITCODE
if ($signToolExitCode -ne 0) {
  throw "SignTool verification did not return success (exit code $signToolExitCode)."
}
```

Use /pa: without it SignTool uses the Windows Driver Verification Policy rather than the Default Authentication Verification Policy. /all asks it to verify all signatures embedded in a file that has multiple signatures. Do not add catalog-search options when the intent is to verify the installer's embedded signature.

SignTool exit codes are **0 = success, 1 = failure, 2 = completed with warnings**. The release gate accepts only exit code 0. Investigate and record warnings; do not reinterpret exit code 2 as a pass.

When the approved release policy requires a timestamp, also run the verification with /tw. Microsoft documents that /tw emits a warning when the signature is not timestamped. Treat that warning as a hold unless the release approver explicitly resolves the policy exception. Do not claim that timestamp presence proves the publisher identity.

## 3. Pass / hold criteria

**Pass only when all are true:**

- The verified file is the exact final NSIS x64 installer for the recorded tag and source SHA.
- Local and independently downloaded artifact bytes reconcile with the release asset metadata.
- PowerShell reports Status = Valid and returns a signer certificate.
- The full signer thumbprint exactly matches the independently approved publisher thumbprint.
- SignTool returns exit code 0 under /pa /all /v.
- Any timestamp requirement in the release policy is met and its evidence is recorded.
- The evidence below is complete and points to this exact artifact.

**Keep the GitHub Release in draft** if signature status is not Valid, the signer is missing or unexpected, SignTool fails or warns, a required timestamp is missing, certificate-chain/revocation status cannot be established, the artifact bytes do not reconcile, or any evidence refers to a different installer/source SHA. Do not disable revocation checks, import an untrusted root, or weaken Windows trust policy to turn a failure into a pass.

## 4. Evidence to retain

For each final installer, retain:

| Field | Evidence |
|---|---|
| Release tag and full source commit SHA | Exact values from the approved release source |
| Installer filename, architecture and byte size | Exact final NSIS x64 artifact |
| Local SHA-256 and downloaded-asset SHA-256 | Independently computed values |
| GitHub Release asset digest and URL | API metadata and draft asset URL |
| PowerShell status and status message | Full result for the exact installer |
| Signer subject, issuer and thumbprint | From the verified signer certificate |
| Approved expected thumbprint and approval reference | Separate maintainer-approved source |
| Signer validity dates and timestamp certificate details | Preserve returned values; record timestamp absence too |
| SignTool command, version, full output and exit code | Exit code must be 0 |
| Windows / PowerShell version, operator and UTC time | Reproducibility context |

Do not place .pfx / .p12 files, certificate passwords, access tokens, or private keys in the evidence record. Keep the release in draft until all native checks and the overall release approval are complete.

## References

- [Microsoft: Get-AuthenticodeSignature](https://learn.microsoft.com/powershell/module/microsoft.powershell.security/get-authenticodesignature) — Windows-only cmdlet and signature-object behavior.
- [Microsoft: Use SignTool to verify a file signature](https://learn.microsoft.com/windows/win32/seccrypto/using-signtool-to-verify-a-file-signature) — verification policy and exit codes.
- [Microsoft: SignTool](https://learn.microsoft.com/windows/win32/seccrypto/signtool) — /pa, /all, /tw, and verification options.
