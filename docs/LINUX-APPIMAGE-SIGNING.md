# Linux AppImage keyless signing (Sigstore / Cosign)

## Purpose and limits

The Linux AppImage is not OS-code-signed by electron-builder. This workflow adds a separate **keyless Sigstore blob signature** for the exact AppImage bytes already uploaded to an existing GitHub **draft** release.

It uses GitHub Actions OIDC to obtain a short-lived signing identity; there is no long-lived Cosign private key or additional signing secret to store. Cosign's Sigstore bundle carries the signature and verification material, including certificate and transparency-log evidence. See the [Sigstore blob-signing guide](https://docs.sigstore.dev/cosign/signing/signing_with_blobs/) and [Cosign verification guide](https://docs.sigstore.dev/cosign/verifying/verify/).

This is **not** an AppImage/GPG code signature, does not make desktop environments treat the AppImage as trusted code, and does not prove that the binary was built from a particular source commit. It proves that the exact bytes in the bundle were signed by the specified GitHub Actions workflow identity. Build provenance, malware review, reproducible builds and the independent local/downloaded/API byte reconciliation remain separate release gates.

## Required repository protection

Before dispatching:

1. Create/configure the GitHub Environment named `release`.
2. Require an authorized reviewer for deployments to that environment, and restrict its deployment branches to `main`.
3. Keep the default branch protected. This workflow only runs when manually dispatched from `main`.
4. Ensure the draft release already contains the final Linux `.AppImage` asset and that GitHub reports an uploaded asset with a SHA-256 digest.

The job requires only `contents: write` (to upload the bundle) and `id-token: write` (for keyless Sigstore authentication). It never changes the release from draft to published.

## Run

Open **Actions → Sign Linux AppImage (Sigstore) → Run workflow**, select branch `main`, then supply:

- `release_tag`: exact tag of the existing draft release, such as `v0.2.0`.
- `appimage_asset`: exact filename of the uploaded AppImage, such as `open-bot-0.2.0.AppImage`.

The workflow fails closed unless the release exists with the exact tag and remains a draft; the requested asset exists exactly once, has upload state `uploaded`, positive size and a `sha256:` digest; and the downloaded bytes match both the reported size and digest. It then signs the file with Cosign 3.1.4, verifies that bundle against the workflow identity, uploads `<AppImage filename>.sigstore.json` to the same draft, and confirms the release is still a draft.

The Cosign installer action is pinned to commit `ba7bc0a3fef59531c69a25acd34668d6d3fe6f22` (v4.1.0), and the Cosign binary is pinned to v3.1.4. The signing workflow itself is the identity being trusted; do not change its path or run it from a different ref without updating the verification identity.

## Verify after downloading

Install Cosign 3.x, download both the AppImage and its matching `.sigstore.json` asset, then run:

```bash
cosign verify-blob ./open-bot-0.2.0.AppImage \
  --bundle ./open-bot-0.2.0.AppImage.sigstore.json \
  --certificate-identity "https://github.com/openbot1/open-bot/.github/workflows/sign-linux-appimage.yml@refs/heads/main" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
```

A successful verification checks the bytes against the keyless signature and expected workflow identity/issuer. It does not validate macOS notarization, Windows Authenticode, Linux desktop trust policy, or the source/build provenance. Preserve the workflow run URL, source commit SHA, tag, AppImage SHA-256, and bundle filename in the per-release approval evidence.

## Operational safety

- This workflow is manual-only and only runs from `main`.
- It signs an already-uploaded draft artifact; it does not build or publish releases.
- Existing signature-bundle assets are not overwritten. A rerun with an existing bundle fails and requires operator review.
- An absent or malformed GitHub API digest, size mismatch, SHA-256 mismatch, non-draft release, unuploaded asset, invalid filename or identity verification failure stops the job.
- A keyless signature is an integrity/authenticity statement by this workflow, not a substitute for the complete native release approval gate.
