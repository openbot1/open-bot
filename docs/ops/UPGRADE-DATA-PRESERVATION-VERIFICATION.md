# Upgrade and Data Preservation Verification Runbook

This runbook defines the operator procedure for upgrading open-bot while preserving local durable state. It covers pre-upgrade backup, version transition, post-upgrade verification and recovery. It does not add an automatic migration or downgrade feature.

## 1. Scope and acceptance boundary

open-bot is local-first. Durable user state is distributed across the Electron `userData` directory and one or more workspace roots. Do not treat the application installer, the profile directory, or a single SQLite database as a complete backup.

The required recovery set includes:

- The complete active Electron `userData` directory, including settings, registries, Vault files and version-specific state.
- Every active workspace root, including the hidden `.open-bot` directory, `memory.db`, attachment files and user project files.
- The OS account/profile context required by OS-backed encryption.
- A manifest identifying the exact pre-upgrade application version, source/build identity when available, backup generation, file sizes and SHA-256 hashes.

Provider-side state, remote accounts, environment variables, OS keychain material and session-only credentials are not automatically made portable by copying local files.

## 2. Classify the candidate migration before touching data

Review the exact candidate source diff and release notes. Record every change affecting schema, rows, file layout, encryption, credential namespaces, or startup/first-use behavior. Classify each as additive schema, row/data rewrite, file-layout change, cryptographic migration, credential relocation, or no durable-data migration.

Current repository behavior to account for includes:

- Workspace SQLite schema initialization inspects existing columns and conditionally adds legacy columns. Do not assume an older binary can operate safely on a database opened by a newer release.
- Default-thread adoption can assign existing messages to a thread during first use. Opening a workspace after upgrade can therefore write data.
- Attachment reconciliation may remove attachment files that have no matching database row. Restore `memory.db` and `.open-bot/attachments/` from the same backup generation.
- Vault initialization can migrate LocalEncryptor entries to Electron `safeStorage` when the OS backend is available and all entries are decryptable.
- Credential relocation can move provider keys from settings into Vault namespaces. A deferred migration is not permission to delete the source value manually.

The current schema changes do not define a general reverse-migration path. Never infer migration completion or downgrade compatibility from the product version string alone.

## 3. Pre-upgrade backup gate

Do not start an upgrade until the following is complete:

1. Record the installed app version, exact source/build identity when available, OS version, OS account/profile, active `userData` path and every active workspace root.
2. Exit open-bot normally. Confirm the app and app-owned writers have stopped. Do not copy a live SQLite database as though it were a consistent snapshot.
3. Create one cold backup generation containing the complete `userData` directory and every complete active workspace root.
4. Include hidden `.open-bot` data, `memory.db`, `attachments/`, Vault stores, separate webhook-key files, sibling `.key` files when present, bounded backup copies and user project files.
5. Preserve the original OS account/profile needed by DPAPI, Keychain or libsecret when Electron `safeStorage` protects Vault entries.
6. Keep each encrypted store paired with its matching key and backup generation. Never combine files copied at different times.
7. Store the backup outside the live profile/workspaces on an access-controlled, encrypted destination.
8. Generate a manifest with relative paths, byte sizes and SHA-256 hashes. Reconcile the destination against the manifest. Do not include credential values, conversation contents or tokens in the manifest.
9. Retain the exact prior approved installer/version and the candidate artifact identity. Do not overwrite the only known-good installer or restore point.

A backup is **copy-verified** only when its inventory, sizes and hashes reconcile. It is **restore-verified** only after a rehearsal successfully restores the complete set and verifies the required data classes.

## 4. Upgrade execution

1. Confirm the candidate artifact is the approved release for the target OS and architecture. Record its source, filename, size and SHA-256; verify platform signature/notarization where the release process requires it.
2. Reconfirm that the cold backup is complete and untouched immediately before installation.
3. Install the candidate using the documented platform procedure. Record the prior and candidate versions and exact artifact identity.
4. Start open-bot under the intended OS account/profile. Watch startup and Vault status. Treat database, migration, decrypt, permission, missing-file or attachment errors as HOLD.
5. Do not launch the old version against a profile already opened or migrated by the new version unless backward compatibility has been explicitly established.
6. Keep the pre-upgrade backup untouched during the verification and observation period.

## 5. Post-upgrade data verification

Verify each data class; a successful window launch alone is not acceptance.

### Electron userData and settings

- Confirm the app uses the expected active `userData` path.
- Verify representative settings, bot configuration and local registries are present.
- Confirm the app can close and reopen without unexpected reset or reinitialization.
- Compare only approved metadata and hashes; do not publish raw profile contents.

### SQLite workspace state

For every active workspace:

- Open the expected workspace and verify representative bots, conversations, threads, memory entries, tasks, goals, todos, projects and run checkpoints as applicable.
- Confirm the expected database opens without SQLite integrity/schema errors.
- Check representative historical records, including records created before the upgrade.
- Exercise one small, non-destructive local workflow and confirm its new state persists after a normal close and restart.
- Do not hand-edit schema or delete database files to make a failed migration appear successful.

### Attachments and workspace files

- Confirm `.open-bot/attachments/` exists where expected.
- Open representative historical image attachments and verify both their database references and corresponding files.
- Verify representative user project files and directory structure remain present.
- Treat a missing referenced attachment or unexpected workspace change as HOLD.

### Vault and credentials

- Confirm Vault status and active backend in the UI without exposing secret values.
- Where `safeStorage` is active, verify expected entries remain usable under the intended OS security context.
- If LocalEncryptor fallback is active, preserve the matching store/key pair and verify its documented consent/write policy. Do not treat fallback as equivalent to OS-backed encryption.
- Verify required provider credential namespaces and settings-to-Vault migration outcomes without printing or logging keys.
- If Vault is unavailable, an expected credential is missing, or a decrypt error occurs, stop writes and enter HOLD. Do not clear the Vault or regenerate keys.

### Runtime and logs

- Complete a harmless local workflow, close normally and relaunch.
- Inspect sanitized logs for migration, SQLite, decrypt, missing attachment and permission errors.
- Record PASS, FAIL or NOT RUN for each check. A check that was not performed must never be represented as passed.

## 6. Rollback decision

Prepare rollback when the candidate repeatedly fails startup, a required workspace cannot open, SQLite reports integrity/schema errors, expected history or attachments are missing, Vault becomes unavailable, credential migration is incomplete, or required local workflows cannot complete.

Do not attempt an in-place reverse SQL migration, manual Vault edits, key regeneration, partial file replacement or repeated launches against failing data.

## 7. Rollback procedure

1. Stop open-bot and all app-owned writers. Do not repeatedly open the failed profile with either version.
2. Preserve a separate quarantined copy of the failed post-upgrade `userData` and all affected workspace roots for diagnosis.
3. Verify the pre-upgrade backup manifest and hashes. Select one complete matching backup generation.
4. Reinstall the exact previously approved application version. Do not assume an older binary can reverse a newer data migration in place.
5. Restore the complete matching `userData` directory and every affected workspace root from that same generation. Do not mix a database with attachments or a Vault store with a key from another generation.
6. Restore under the original supported OS account/profile required to unlock OS-backed `safeStorage`. If that context is unavailable, record the credential recovery limitation and use the approved re-authentication process.
7. Verify Vault state, settings, representative bots/conversations/tasks, attachments, project files and a non-destructive local workflow.
8. Confirm normal close and restart. Retain the failed copy quarantined until incident review is complete.
9. Record the restored app version, backup generation, manifest result, OS/profile, Vault status, checks, operator and UTC completion time.

Restoring the complete pre-upgrade generation is the default rollback method. If no complete verified restore point exists, keep the installation in HOLD and escalate; do not improvise a partial restore.

## 8. Evidence record

For each upgrade and rollback rehearsal, retain:

- Source/build identity, prior and candidate app versions, release tag and artifact filename.
- Artifact source, byte size, SHA-256 and platform signature/notarization result where applicable.
- OS version/build, architecture, OS account/profile and active `userData`/workspace path identifiers.
- Backup generation ID, manifest, file counts, byte sizes, hashes and verification outcome.
- Migration classification and reviewed source/release references.
- Per-workspace SQLite, bot/configuration, conversation, attachment and project-file results.
- Vault backend/status and credential namespace outcomes without secret values.
- Rollback decision, restored generation and post-restore checks if rollback was exercised.
- Operator, UTC timestamps, commands, exit codes, sanitized logs, deviations and follow-up owner.

Store evidence in the approved restricted project location. Redact secrets, tokens, conversation text, personal data and sensitive filesystem paths from reports shared outside the authorized operations group.

## 9. PASS / HOLD criteria

An upgrade is **PASS** only when the exact candidate artifact is identified, a complete cold backup is copy-verified, every required workspace data class and Vault state is checked, a non-destructive workflow persists across restart, and no unresolved migration/storage error remains.

A rollback is **PASS** only when the exact prior approved application version and one complete matching pre-upgrade data generation are restored, the manifest reconciles, and the same required data checks pass.

Any missing backup component, hash mismatch, mixed key/store generation, unavailable Vault, missing referenced attachment, unresolved SQLite/migration error, unverified OS security context or untested required data class is **HOLD**.

This runbook defines an operator verification procedure. It does not add automatic backup, migration or downgrade behavior, guarantee arbitrary cross-version compatibility, or claim that an upgrade/rollback rehearsal has already been performed.
