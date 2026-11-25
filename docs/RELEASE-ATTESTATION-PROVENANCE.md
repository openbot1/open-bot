# Release artifact attestation and provenance verification

**Status:** release verification policy and operator procedure. This document does not generate attestations, modify release workflows, or assert that any current release artifact already has provenance.

## 1. Scope and trust boundary

Verify a cryptographically signed GitHub Artifact Attestation for **each exact final release artifact**:

- each macOS arm64 / x64 DMG after code signing, notarization and any required stapling;
- each Windows x64 NSIS installer after Authenticode signing;
- the Linux x64 AppImage after packaging (and after any operation that changes its bytes).

An attestation binds a subject name and digest to a provenance predicate. Verification must establish both the artifact digest and the identity of the workflow that made the claim. A checksum, a GitHub Release asset digest, a successful build, a code signature, or a notarization ticket is not a build-provenance attestation.

**Important current-state limitation:** the current main tree contains no release-build workflow that generates GitHub Artifact Attestations. The existing release guide documents native signing and uploaded-byte reconciliation, but it does not establish that attestations exist. Therefore this procedure is a future release gate, not evidence that any current installer can pass it. If no matching attestation exists, the result is **HOLD**; do not substitute a successful hash comparison or a narrative assertion.

## 2. Producer prerequisite — attest the final bytes

Before this verification can pass, the trusted workflow that builds and signs the release artifacts must generate an attestation for every final artifact. GitHub's documented binary-provenance pattern requires workflow permissions:

~~~yaml
permissions:
  contents: read
  id-token: write
  attestations: write
~~~

Then, after the installer has reached its final byte state, the workflow adds a step using actions/attest with the exact file as its subject:

~~~yaml
- name: Generate provenance attestation for final release artifact
  uses: actions/attest@v4
  with:
    subject-path: '<EXACT_FINAL_ARTIFACT_PATH>'
~~~

The production implementation must pin the action to a reviewed immutable full commit SHA rather than rely only on a mutable version tag, and retain the workflow run, artifact path, digest and resulting attestation evidence.

The attestation step must run **after** every operation that changes the artifact bytes. In particular, macOS DMG stapling changes the DMG; attest only after the final staple, then compute the final SHA-256 and upload those same bytes. If a file is modified, rebuilt, signed, stapled or replaced after attestation, generate a new attestation for the new final bytes and repeat the release verification. Never reuse an attestation for a prior build or pre-staple file.

A producer workflow must bind provenance to the actual commit checked out and built. Do not assume the workflow dispatch ref, release tag, or GITHUB_SHA is the source commit if the workflow checks out another ref. The recorded source digest must equal the full commit SHA of the source actually built. Before enforcing a source ref, inspect the produced provenance and define the expected ref explicitly.

This repository has not yet integrated this producer step on the current main branch. That workflow change is separate from this documentation/static-test PR.

## 3. Verify each downloaded release artifact

Run from an online environment with a current supported GitHub CLI authenticated to GitHub. Download the exact installer from the candidate **draft** Release into a clean evidence directory. Keep the local final artifact and independently downloaded uploaded artifact separate, and complete the existing three-way byte reconciliation before proceeding.

For each exact file, set the release/source metadata:

~~~bash
set -euo pipefail

REPO="openbot1/open-bot"
RELEASE_TAG="REPLACE_WITH_EXACT_RELEASE_TAG"
SOURCE_SHA="REPLACE_WITH_FULL_SOURCE_COMMIT_SHA"
ARTIFACT_PATH="/absolute/path/to/exact-downloaded-final-artifact"
EVIDENCE_DIR="/absolute/path/to/release-evidence/attestations"
SIGNER_WORKFLOW="openbot1/open-bot/.github/workflows/REPLACE_WITH_APPROVED_SIGNER_WORKFLOW.yml"

mkdir -p "$EVIDENCE_DIR"
~~~

Verify the SLSA provenance attestation for that exact file:

~~~bash
gh attestation verify "$ARTIFACT_PATH" \
  --repo "$REPO" \
  --signer-workflow "$SIGNER_WORKFLOW" \
  --cert-oidc-issuer "https://token.actions.githubusercontent.com" \
  --predicate-type "https://slsa.dev/provenance/v1" \
  --source-digest "$SOURCE_SHA" \
  --format json \
  > "$EVIDENCE_DIR/$(basename "$ARTIFACT_PATH").attestation-verification.json"
~~~

The signer workflow value is deliberately a placeholder: set it to the **actual reviewed workflow that generates the attestation**. Do not assume a workflow file that only exists on an unmerged PR is the production signer. If attestation generation uses a reusable workflow, pin the reusable signer workflow/repository as required by the GitHub CLI verification contract.

Only add --source-ref after the release workflow's provenance has been inspected and the expected source ref is unambiguous. A manual workflow may be dispatched from one ref while checking out a different release tag; never assert refs/tags/<tag> merely because the artifact is named after that tag.

The command must run against the exact downloaded bytes. Do not use --bundle for the normal online release gate: online lookup through the GitHub API also checks that the attestation belongs to the repository currently named in --repo. Offline bundle verification is a separate procedure and does not provide that current-name check.

Repeat verification separately for every architecture-specific DMG and every installer file. One successful verification must not be generalized to another file, architecture, release tag, or digest.

## 4. Review the verification result

A zero exit status from gh attestation verify is necessary, not sufficient for release approval. Preserve the JSON output and verify:

- the attestation subject digest is the SHA-256 of the exact downloaded artifact and matches the local final artifact and GitHub Release API digest;
- the predicate type is exactly https://slsa.dev/provenance/v1;
- the signer certificate identifies openbot1/open-bot and the approved signer workflow / identity;
- the certificate OIDC issuer is https://token.actions.githubusercontent.com;
- the source repository and source commit digest match the approved release source;
- the signed transparency-log / timestamp evidence is present and valid;
- the attestation is for the same final bytes that were uploaded, including any post-signing or post-stapling modifications.

For --format json, GitHub CLI returns verification output containing the attestation and a verificationResult with the certificate, verified timestamps and parsed statement. The certificate and verified timestamps are cryptographically grounded. Treat fields inside statement.predicate as workflow-supplied claims: inspect them for consistency, but do not treat arbitrary predicate text as an independent trust anchor. Cross-check the source SHA and artifact digest against the release record and independently computed hashes.

Do not rely only on the subject filename; names are not content identity. Do not treat an attestation as proof that the artifact is free of vulnerabilities, that native signing/notarization is valid, or that the application behaves correctly. Keep Authenticode, macOS codesign/notarization/Gatekeeper, Cosign/AppImage policy, and uploaded-byte reconciliation as separate gates.

## 5. Evidence to retain

For every artifact, record:

| Field | Evidence |
|---|---|
| Release tag and full source commit SHA | Exact tag and commit actually built |
| Artifact filename and target architecture | Exact downloaded release asset |
| Local / downloaded SHA-256 and file size | Independently computed; values must agree |
| GitHub Release URL and API asset digest | Exact draft asset and API response |
| Attestation verification command and GitHub CLI version | Complete command and gh version output |
| Verification JSON | Full output from gh attestation verify --format json |
| Subject digest and predicate type | From the verified statement, cross-checked with the file |
| Signer workflow and OIDC issuer | From verified certificate identity |
| Source repository / source digest / source ref | Compared with the approved release source |
| Verified timestamp / transparency-log evidence | Preserve the returned verification evidence |
| Workflow run URL and attestation generation reference | Exact producer run and artifact step |

Do not store access tokens, signing credentials, private keys or secret values in the evidence record.

## 6. Pass / hold criteria

**Pass only when all are true for every final installer:**

- A signed SLSA provenance attestation exists and gh attestation verify succeeds for the exact downloaded artifact.
- The verified subject digest matches the local final file, independently downloaded Release asset and GitHub API digest.
- The attestation is linked to openbot1/open-bot and the independently approved signer workflow / OIDC identity.
- The source digest matches the exact full commit SHA actually built; any enforced source ref matches the reviewed provenance.
- The expected SLSA provenance predicate type and signed timestamp/transparency evidence verify.
- All native signing, notarization, platform verification and uploaded-byte reconciliation gates also pass.
- The evidence record is complete and refers to the same tag, source SHA, architecture and exact final bytes.

**Keep the GitHub Release in draft** if an attestation is missing, verification fails, the workflow identity is unexpected, the source digest or subject digest differs, timestamp evidence is absent/invalid, the predicate type is wrong, the artifact changes after attestation, or any evidence is ambiguous. No attestation means **not verified**, not an implied pass.

## References

- [GitHub Docs: Using artifact attestations to establish provenance for builds](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations) — producer permissions, actions/attest, and gh attestation verify.
- [GitHub CLI: gh attestation verify](https://cli.github.com/manual/gh_attestation_verify) — identity, predicate, signer-workflow, source-ref/source-digest and JSON verification result.
- [GitHub Docs: Managing the lifecycle of artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/manage-attestations) — finding and managing attestations.
