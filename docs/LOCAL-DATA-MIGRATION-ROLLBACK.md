# Local Data Migration and Rollback Runbook

This runbook defines the operator procedure for upgrading and, when necessary, rolling back open-bot without losing or mismatching local durable state. It is an operational gate, not a schema downgrade tool and not an application feature.

## 1. Scope and data boundaries

The procedure covers three related but distinct areas:

- Electron `userData`: settings, machine/profile state, the main Vault, the separate webhook-key store, and other app-owned durable files.
- Every active workspace: `.open-bot/memory.db`, `.open-bot/attachments/`, and the user's project files. A user may have more than one workspace root.
- OS-bound encryption context: the Windows DPAPI user context, macOS Keychain context, or Linux libsecret/keyring context used by Electron `safeStorage`.

The app's current release procedure downloads and installs updates manually. The release/version metadata sync is not a migration of user data. Do not assume that replacing the application binary also upgrades, rolls back, or repairs the data it opens.

This runbook is the migration/rollback companion to the local backup procedure. A restore point must contain a consistent, identifiable copy of both the complete `userData` directory and every active workspace root.

## 2. Migration classes present in the current repository

Classify each release's data changes from the exact source diff before approving an upgrade. The examples below describe the current source snapshot; they are not a promise that every future release uses the same migration.

| Area | Current behavior / migration shape | Operator consequence |
|---|---|---|
| Workspace SQLite schema | `BotMemory` creates required tables if absent, inspects columns using `PRAGMA table_info`, and conditionally adds legacy columns with `ALTER TABLE`. Current guarded additions include `tasks.tags`, `projects.updatesEnabled`, `projects.lastUpdateAt`, `messages.threadId`, and `threads.titleCustom`. | These are additive schema changes. Preserve the original database; do not hand-edit columns or assume an older binary can safely operate on a newer schema. |
| Conversation thread adoption | `ensureDefaultThread` lazily creates a default thread and assigns existing rows with `messages.threadId IS NULL` to it. The original messages remain, but the rows are changed. | This is a data migration that may happen after startup when thread history is first listed. Treat the first upgraded use of a workspace as a write. |
| Attachment reconciliation | `BotMemory` startup prunes attachment files that have no matching database row. | Restore `memory.db` and `attachments/` from the same backup generation before opening the workspace. A mismatched older database can cause newer unreferenced attachment files to be pruned. |
| Vault backend migration | `openVaultWithSafeStorage` probes the OS backend, checks whether all entries can be decrypted, and re-encrypts legacy LocalEncryptor entries with `safeStorage` when applicable. Vault writes use durable atomic persistence and bounded backups. | Treat the Vault and its matching fallback key/backup files as one recovery unit. Do not rotate keys or delete fallback keys during an incident. |
| Vault unavailable / degraded state | If any existing entry cannot be decrypted, the Vault reports unavailable, disables persistent writes and preserves ciphertext. If OS storage is unavailable, LocalEncryptor fallback is degraded and persistent writes require explicit consent. | Unavailable or unexpected degraded status is HOLD. Do not clear legacy values or force a migration to get past startup. |
| Credential relocation | Startup moves legacy provider API keys from `settings.json` into the Vault and clears the old field only after a successful save. The migration is idempotent and defers when Vault is unavailable or persistence is refused. A separate namespace migration moves credentials to their expected Vault namespaces. | Preserve both the settings file and Vault. A deferred migration is not permission to remove the source value manually. |

The current workspace migration code uses schema introspection and guarded additions rather than a single release-wide schema version marker. Review the actual source changes for every candidate release; do not infer migration completion from the product version string alone.

## 3. Pre-upgrade gate: identify and freeze the recovery point

Do not begin an upgrade until all items below are complete:

1. Record the current app version, exact installed/source build identity when available, OS version, OS account/profile, active `userData` path, and every active workspace root.
2. Review the candidate release's source diff for schema changes, data rewrites, encryption/backend changes, renamed or removed files, and code that runs migrations during startup or first use.
3. Classify each change as additive schema, row/data rewrite, file-layout change, cryptographic migration, or no durable-data migration. Record any downgrade incompatibility explicitly.
4. Exit open-bot normally. Confirm the desktop app and app-owned workers that can write durable state have stopped. Do not copy a live SQLite database as the release restore point.
5. Create one cold, consistent backup generation containing the complete `userData` directory and every complete active workspace root. Include hidden `.open-bot` data, `memory.db`, attachment files, Vault files, separate webhook-key files, sibling `.key` files, and bounded backup copies.
6. Preserve the original OS account/profile needed by `safeStorage`. Keep store/key pairs together; never assemble one restore point from files copied at different times.
7. Build a manifest with relative path, byte size and SHA-256 for the backup files. Reconcile the destination copy against the manifest. Retain the untouched backup outside the live profile/workspaces.
8. Record the prior app installer/version and the exact candidate installer/source identity. Do not overwrite the only known-good installer or recovery point.

A backup that only contains `userData` is incomplete when workspace databases or attachments are active. A backup that only contains workspace data is incomplete when the installation uses Vault credentials, settings or profile state.

## 4. Upgrade execution and post-migration verification

1. Install the exact approved candidate using the documented platform release procedure. The application updater currently opens the official release page; it does not perform an in-app download-and-install migration.
2. Start the app once under the intended OS account/profile. Watch startup output and Vault status. Do not dismiss a decrypt warning, database error, missing attachment, permission failure or migration exception as a harmless first-run message.
3. Verify the main Vault reports the expected state. `unavailable` is always HOLD. `degraded` is HOLD unless the release record explicitly approves that fallback state and its restricted write policy for this installation.
4. Open each active workspace and verify expected bots, conversation/thread history, tasks, memory and project state. Check representative image attachments; confirm both the database references and the referenced files are present.
5. Exercise a small, non-destructive local workflow. Confirm that new writes persist after a normal close and restart, and inspect logs for migration, SQLite, decrypt, missing-file or permission errors without capturing secret values.
6. Record the candidate version/build identity, migration observations, workspace checks, Vault state, test results, operator and UTC time. Keep the pre-upgrade backup untouched through the agreed observation period.

Do not mark the upgrade PASS merely because the window opens. Required data classes and the local workflow must be verified.

## 5. Rollback decision and execution

### Rollback triggers

Enter HOLD and prepare rollback when any of the following occurs:

- A migration throws, stalls, or leaves the app unable to open required local state.
- SQLite reports an integrity or schema error, expected history disappears, or an attachment reference points to a missing file.
- Vault status becomes unavailable, or an unexpected degraded state prevents required credentials from being safely persisted.
- A credential migration is incomplete and the source value is no longer available, or the expected Vault namespace is missing.
- The upgraded app crashes repeatedly during startup or a required production workflow cannot complete.

### Required rollback sequence

1. Stop open-bot and all app-owned writers. Do not repeatedly launch either version against the failing data.
2. Preserve a separate, read-only/quarantined copy of the failed post-upgrade `userData` and all affected workspace roots for diagnosis. Do not overwrite it with the restore point.
3. Re-check the pre-upgrade backup manifest and hashes. Select one complete backup generation; confirm that its `userData`, workspace databases, attachment files and Vault/key files belong together.
4. Reinstall the exact previously approved application version. Do not assume an older binary can safely downgrade a database or reverse a data migration in place; the current schema changes do not define a general reverse-migration path.
5. Restore the complete matching pre-upgrade `userData` directory and every affected workspace root from that same generation. Do not mix a new `memory.db` with old attachments, or a Vault store with a key file from another generation.
6. Open the restored installation under the original supported OS account/profile so OS-backed `safeStorage` can access its protected data. If that context is unavailable, record the credential recovery limitation and use the approved re-authentication process; do not replace keys or bypass encryption.
7. Verify Vault availability, expected bots/settings/conversation history, representative image attachments, workspace files, and a non-destructive local workflow. Confirm the app closes and reopens without the original migration failure.
8. Record the rollback source version, restored backup generation, manifest result, OS/profile, Vault status, data checks, operator and UTC completion time. Keep the failed copy quarantined until the incident is resolved.

Restoring a consistent pre-upgrade data set is the default rollback method. Do not attempt ad-hoc SQL column drops, reverse `ALTER TABLE` operations, manual Vault edits, key regeneration, or partial file replacement as a production rollback.

## 6. PASS / HOLD record

An upgrade is **PASS** only when:

- [ ] Candidate source/build identity and migration classes were reviewed.
- [ ] A cold pre-upgrade backup of complete `userData` and all active workspace roots was verified by manifest.
- [ ] The candidate started under the intended OS account/profile without unresolved migration or storage errors.
- [ ] Every required workspace data class, including representative image attachments, was verified.
- [ ] Vault state and credential namespace migration are understood and usable.
- [ ] A non-destructive workflow and restart persistence check passed.
- [ ] Evidence records contain source/build identity, prior version, backup generation, operator and UTC time, without secret values.

A rollback is **PASS** only when the exact prior app version and a complete matching pre-upgrade data generation have been restored and the same data checks pass. Any missing backup component, checksum mismatch, unknown key pairing, unavailable Vault, missing workspace/attachment, unresolved migration error or unverified OS security context is **HOLD**.

This runbook documents the operator procedure and current known migration behavior. It does not implement database downgrade logic, guarantee arbitrary cross-version compatibility, or substitute for a real disposable upgrade/rollback rehearsal.
