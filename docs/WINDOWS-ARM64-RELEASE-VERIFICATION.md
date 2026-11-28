# Windows ARM64 release installer verification

**Status:** operator procedure and acceptance criteria only. This document does not enable an ARM64 build target, create an ARM64 installer, sign files, or publish a release.

## 1. Current repository limitation — do not infer ARM64 support

On the base snapshot used for this procedure:

- apps/desktop/electron-builder.yml configures the Windows NSIS target for **x64 only**.
- apps/desktop/package.json defines dist:win as electron-builder --win; the root release:win script invokes that command and does not add --arm64.
- The existing Windows release procedure and native workflow therefore do not prove that an ARM64 installer is produced.

A future implementation must explicitly configure or invoke the NSIS ARM64 target, ensure all Electron/native dependencies support ARM64, produce a separately identifiable ARM64 artifact (or a deliberately designed multi-architecture installer), and bind the release workflow / asset manifest to that output.

**Until that producer work is implemented and a real ARM64 payload is available, this gate is NOT RUN / HOLD.** An x64 installer that happens to launch through Windows emulation on an ARM device is not an ARM64-native release and must not be reported as one.

electron-builder v26 documents Windows ARM64 as a supported target via --win --arm64 and an NSIS target architecture entry. That upstream capability does not mean this repository currently configures it.

## 2. Required test environment and exact artifact

Perform the release verification on a real Windows on ARM64 device or a genuine ARM64 Windows VM. Record the Windows edition/build, host processor, OS system type, PowerShell version, Windows SDK / SignTool version, and verification time.

Do not use an x64 Windows VM, x64 emulation, or an ordinary x64 CI runner as proof of native ARM64 runtime behavior. Windows 11 on ARM can emulate x64 applications; successful installation or launch alone therefore does not prove that the application binary is ARM64.

For each release candidate, identify and record:

- exact release tag and full source commit SHA;
- exact ARM64 NSIS installer filename and draft-release asset URL;
- expected publisher certificate subject and independently approved certificate thumbprint;
- installed application executable path and relevant native helper / .node modules;
- the intended architecture policy: ARM64-native payload, not x64-under-emulation.

The installer wrapper and the application payload are different things. A setup executable may have a different PE machine type from the installed application executable. Verify the installer's Authenticode signature, but determine application architecture from the **installed open-bot.exe and its native runtime components**, not from the setup wrapper alone.

## 3. Confirm the installed application payload is ARM64

Install the exact candidate on the ARM64 Windows host. Resolve the installed main executable, normally under the per-user Programs directory, and inspect its PE header. The PE Machine field value for native ARM64 is 0xAA64 (IMAGE_FILE_MACHINE_ARM64).

The following read-only PowerShell helper reads only the PE header of the specified installed executable:

~~~powershell
$ErrorActionPreference = 'Stop'

function Get-PeMachine {
  param([Parameter(Mandatory)][string]$LiteralPath)

  $stream = [System.IO.File]::OpenRead((Resolve-Path -LiteralPath $LiteralPath).Path)
  $reader = [System.IO.BinaryReader]::new($stream)
  try {
    if ($stream.Length -lt 0x40) { throw 'File is too small to contain a DOS header.' }

    $stream.Position = 0x3c
    $peOffset = $reader.ReadInt32()
    if ($peOffset -lt 0x40 -or ($peOffset + 6) -gt $stream.Length) {
      throw 'Invalid or out-of-range PE header offset.'
    }

    $stream.Position = $peOffset
    if ($reader.ReadUInt32() -ne 0x00004550) {
      throw 'PE signature is missing.'
    }

    return ('0x{0:X4}' -f $reader.ReadUInt16())
  }
  finally {
    $reader.Dispose()
  }
}

$installedExe = 'C:\Users\<user>\AppData\Local\Programs\open-bot\open-bot.exe'
$machine = Get-PeMachine -LiteralPath $installedExe
if ($machine -ne '0xAA64') {
  throw "Installed application is not a native ARM64 PE image: $machine"
}
"Installed application PE machine: $machine"
~~~

Repeat the architecture inspection for every native executable or .node module that is required to run the application. Classify any x64 component explicitly; do not silently count it as ARM64. Any intentional ARM64EC / ARM64X component requires a separately reviewed compatibility decision and evidence; it is not interchangeable with a plain ARM64 image.

For runtime confirmation, launch the app on the ARM64 host and inspect the actual process architecture using a tool/API that distinguishes a native ARM64 process from an emulated x64 process (for example, IsWow64Process2). Record the process machine and native machine. A process reported as AMD64 under an ARM64 native OS is emulated x64, not native ARM64.

## 4. Verify Authenticode on the exact installer and installed executable

Use the final installer downloaded from the candidate draft Release. Also verify the installed main executable when it is Authenticode-signed. Obtain the expected thumbprint from a separate maintainer-approved identity record; never derive the expected identity from the file being checked.

~~~powershell
$ErrorActionPreference = 'Stop'

$installerPath = (Resolve-Path -LiteralPath '.\open-bot-<version>-arm64-setup.exe').Path
$expectedThumbprint = 'REPLACE_WITH_APPROVED_40_HEX_THUMBPRINT'

if ($expectedThumbprint -notmatch '^[A-Fa-f0-9]{40}$') {
  throw 'Supply the independently approved 40-hex certificate thumbprint.'
}
$expectedThumbprint = $expectedThumbprint.ToUpperInvariant()

$signature = Get-AuthenticodeSignature -LiteralPath $installerPath
if ($signature.Status -ne 'Valid') {
  throw "Installer Authenticode status is not Valid: $($signature.Status) — $($signature.StatusMessage)"
}
if ($null -eq $signature.SignerCertificate) {
  throw 'Installer has no signer certificate.'
}

$actualThumbprint = ($signature.SignerCertificate.Thumbprint -replace '\s', '').ToUpperInvariant()
if ($actualThumbprint -ne $expectedThumbprint) {
  throw "Unexpected installer signer thumbprint: $actualThumbprint"
}

$installerHash = Get-FileHash -LiteralPath $installerPath -Algorithm SHA256
[pscustomobject]@{
  File            = $installerPath
  SizeBytes       = (Get-Item -LiteralPath $installerPath).Length
  SHA256          = $installerHash.Hash
  Status          = $signature.Status
  StatusMessage   = $signature.StatusMessage
  SignerSubject   = $signature.SignerCertificate.Subject
  SignerIssuer    = $signature.SignerCertificate.Issuer
  SignerThumbprint = $actualThumbprint
  NotBefore       = $signature.SignerCertificate.NotBefore.ToUniversalTime().ToString('o')
  NotAfter        = $signature.SignerCertificate.NotAfter.ToUniversalTime().ToString('o')
} | Format-List
~~~

Repeat the signature and approved-thumbprint checks for the installed open-bot.exe when the release signing policy expects the application binary to be signed. Record any unsigned helper only when that helper is explicitly allowed by the approved signing policy; otherwise it is a hold.

Corroborate the embedded signature with SignTool from the Windows SDK:

~~~powershell
$signtool = (Get-Command signtool.exe -ErrorAction Stop).Source
& $signtool verify /pa /all /v $installerPath
$signToolExitCode = $LASTEXITCODE
if ($signToolExitCode -ne 0) {
  throw "SignTool did not return success (exit code $signToolExitCode)."
}
~~~

Use /pa for the Default Authentication Verification Policy and /all to verify all embedded signatures. Accept only exit code 0; exit code 1 is failure and exit code 2 means completion with warnings, which must remain HOLD until reviewed and resolved. Do not disable revocation checks, import an untrusted root, or weaken Windows trust policy to turn a failure into a pass.

## 5. Verify exact release bytes

After signing and packaging are complete:

1. Compute SHA-256 and byte size for the local final ARM64 installer.
2. Independently download the exact .exe asset from the candidate draft GitHub Release and compute its SHA-256 and byte size.
3. Compare both with the digest and size in the GitHub Releases API.
4. Require all three SHA-256 values and both byte sizes to agree.

Keep the local final artifact and downloaded upload in separate directories. If the installer is rebuilt, re-signed, replaced, or otherwise changes after verification, repeat architecture inspection, Authenticode verification, and byte reconciliation for the new bytes.

The GitHub API digest is metadata, not an independent publisher trust anchor. Hashing the independently downloaded copy is essential.

## 6. Native ARM64 installation and runtime checks

On the same ARM64 Windows host:

- install the exact verified candidate using a standard user account, following the intended per-user installation mode;
- confirm the installed application executable is a native ARM64 PE image (0xAA64);
- start the application and verify its process is native ARM64, not an emulated AMD64 process;
- exercise startup, renderer, main process, updater release-page opening, and the core local-first workflow;
- inspect application logs and Windows Event Viewer for missing DLLs, unsupported native modules, crashes, or architecture-load errors;
- verify that every native dependency and helper executable needed for the tested workflow is available for ARM64 or has an explicitly approved compatibility mode;
- uninstall and reinstall once, then confirm user data is preserved according to the documented installation policy.

A successful NSIS install alone is not a runtime pass. A successful emulated x64 launch is compatibility evidence only; it does not satisfy the ARM64-native release requirement.

## 7. Evidence and pass / hold decision

For each ARM64 release artifact, retain:

| Field | Evidence |
|---|---|
| Release tag and full source SHA | Exact approved source |
| Installer filename, size and SHA-256 | Exact final NSIS asset |
| Independently downloaded asset SHA-256 and size | Recomputed from downloaded bytes |
| GitHub API asset digest / size / URL | Exact draft-release asset metadata |
| Windows edition, build and native host architecture | ARM64 hardware or genuine ARM64 VM |
| Installed app PE machine | 0xAA64 for native ARM64 |
| Native helper / .node architecture inventory | Exact files and approved exceptions |
| Runtime process/native machine | Evidence distinguishing ARM64 from emulated AMD64 |
| Authenticode status and status message | Must be Valid for every required signed file |
| Signer subject, issuer and thumbprint | Must match separately approved publisher identity |
| SignTool command, version, output and exit code | Must exit 0 |
| Installation/runtime smoke result and logs | Exact build and host |
| Operator and UTC verification time | Evidence reference |

**Pass only when** an ARM64-specific release artifact actually exists, its installed application payload and required native components are ARM64 (or have explicitly approved compatibility evidence), Authenticode is valid and matches the approved publisher, SignTool returns 0, exact uploaded bytes reconcile, and native ARM64 installation/runtime checks pass.

**Keep the GitHub Release in draft** if the repository still only produces x64, no ARM64 artifact exists, the payload is x64-under-emulation, a required binary is the wrong architecture, a signature or publisher identity fails, SignTool warns/fails, bytes differ, a required dependency is unavailable, or evidence is missing. Never describe an x64 build running under emulation as a native ARM64 release.

## References

- [electron-builder v26: Architecture and multi-architecture builds](https://www.electron.build/v26/docs/architecture/) — Windows ARM64 target support.
- [electron-builder: NSIS target](https://www.electron.build/v26/docs/nsis/) — NSIS installer behavior.
- [Microsoft: PE format and Machine types](https://learn.microsoft.com/windows/win32/debug/pe-format) — IMAGE_FILE_MACHINE_ARM64 is 0xAA64.
- [Microsoft: Get-AuthenticodeSignature](https://learn.microsoft.com/powershell/module/microsoft.powershell.security/get-authenticodesignature) — Windows signature status and signer certificate.
- [Microsoft: Use SignTool to verify a file signature](https://learn.microsoft.com/windows/win32/seccrypto/using-signtool-to-verify-a-file-signature) — /pa, verification and exit codes.
- [Microsoft: SignTool](https://learn.microsoft.com/windows/win32/seccrypto/signtool) — verification options including /pa, /all and /tw.
- [Microsoft: How emulation works on Arm](https://learn.microsoft.com/windows/arm/apps-on-arm-x86-emulation) — x86/x64 emulation distinction and process architecture.
- [Microsoft: IsWow64Process2](https://learn.microsoft.com/windows/win32/api/wow64apiset/nf-wow64apiset-iswow64process2) — identify guest and native process machine.
