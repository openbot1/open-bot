# Local Data Backup and Restore Runbook

This runbook defines an operator-controlled backup and recovery procedure for the local data owned by an open-bot desktop installation. It is a production operations gate, not a new backup feature and not a guarantee that an arbitrary profile can be moved between machines.

## 1. Scope and recovery boundary

open-bot is local-first, but its durable state is not necessarily contained in one directory:

- Electron application state lives under the actual `app.getPath('userData')` directory for the installed application.
- Chat history, bot memory, task state, run checkpoints, and image attachments live under each workspace root in its `.open-bot` directory.
- Workspace files themselves may be user data and must be included when the operator intends to recover the complete workspace.
- Provider accounts, remote services, environment variables, OS keychain material, and secrets intentionally kept in memory only are not made portable merely by copying application files.

The platform examples in `docs/SETUP.md` are defaults, not a substitute for confirming the active profile path on the machine being backed up. Record every active workspace root separately. Do not assume that copying only `userData`, only `memory.db`, or only an application installer is a complete backup.

## 2. Known durable data and important pairings

Use the following as a minimum inventory, not an exhaustive list of every version-specific state file.

| Location | Durable data / why it matters |
|---|---|
| Electron `userData` | Application settings and local registries/configuration; capture the complete directory rather than attempting to enumerate only today's filenames |
| `userData/vault.json` and bounded `.1`–`.3` copies | Encrypted provider, connector, OAuth and other persisted secrets held by the main Vault |
| `userData/vault.json.key`, when present | Machine key used by the LocalEncryptor fallback; it must stay paired with the exact Vault store and backup generation |
| `userData/automation-webhook-keys.json` and its bounded copies | Separate encrypted webhook signing-key store |
| `userData/automation-webhook-keys.json.key`, when present | Fallback key for the separate webhook store; do not infer that the main Vault key protects this store |
| Each workspace's `.open-bot/memory.db` | SQLite chat history, bots, memory entries, tasks, goals, todos, projects, threads and run checkpoints |
| Each workspace's `.open-bot/attachments/` | Image bytes referenced by rows in `memory.db`; a database-only copy is incomplete |
| Each complete workspace root | User files and project state that live outside the hidden `.open-bot` directory |

The Vault may use Electron `safeStorage` (DPAPI on Windows, Keychain on macOS, or libsecret on Linux). That protection is bound to the relevant OS security context. A copied ciphertext file is not proof that its secrets can be decrypted on another machine or under another OS account.

When LocalEncryptor fallback is active, the ciphertext store and its sibling `.key` file form one recovery unit. Never delete, regenerate, rename independently, or mix a key file from one backup generation with another store. Preserve bounded backup copies and their timestamps.

Session-only credentials are intentionally not durable and are not part of a file backup. Provider-side data and external service state require their own recovery process.

## 3. Create a consistent cold backup

Perform a backup before an application upgrade, migration, Vault rotation, OS migration, device replacement, or other operation that could change durable state.

1. Record the UTC time, installed app version, full source/build identifier when available, OS version, OS account/profile, active Electron `userData` path, and every active workspace root.
2. Exit open-bot normally. Confirm that its main process and any app-owned process that can write the profile or workspace have stopped. Do not copy a live SQLite database as though it were a consistent snapshot.
3. Copy the complete `userData` directory, including hidden files, Vault stores, sibling key files, bounded copies, and other version-specific state. Preserve filesystem permissions/ACLs and timestamps where the backup medium supports them.
4. Copy each complete active workspace root, including its hidden `.open-bot` directory, `memory.db`, attachment files, and user project files. Do not copy only the SQLite database while omitting its attachment directory.
5. If SQLite sidecar files such as `memory.db-wal` or `memory.db-shm` exist, preserve them as part of the cold copy. The preferred procedure is still to stop the writer before copying.
6. Store the backup outside the live profile/workspace and on an access-controlled destination. Encrypt the backup at rest; the contents may include conversations, source code, credentials and personal data.
7. Generate a manifest containing relative paths, byte sizes and SHA-256 hashes for the copied files. Verify the destination copy against that manifest. The manifest must not contain credential values, tokens, prompts or conversation contents.
8. Keep at least one known-good pre-upgrade/pre-migration backup until the upgraded installation has passed its recovery and runtime checks.

A successful copy command is not a verified backup. A backup is only **copy-verified** when the recorded file inventory, sizes and hashes reconcile. It is only **restore-verified** after the recovery rehearsal in section 4 succeeds.

## 4. Restore and recovery rehearsal

Rehearse with a disposable copy or a dedicated test installation. Never experiment against the only production copy.

1. Select one backup generation. Verify its manifest and hashes before extracting or copying anything.
2. Confirm the target OS account/profile and the original OS security context. For OS-backed `safeStorage`, use the same supported OS account/profile that can unlock the original protected data. Do not promise cross-machine decryption from a copied `vault.json`.
3. Restore the complete `userData` directory and all corresponding workspace roots as one recovery set. Keep the original live directories quarantined and unchanged until verification is complete.
4. For LocalEncryptor fallback, confirm that each store is paired with its own matching `.key` file and matching bounded backups. Never create a replacement key to make an old ciphertext file appear usable.
5. Start the restored installation only after the copy is complete. Check that Vault storage reports the expected available state; a degraded or unavailable state is a HOLD, not a successful restore.
6. Verify that expected bots, settings, conversation history, tasks and workspace files are present. Open representative historical image attachments to verify both the database references and the corresponding files were restored.
7. Exercise a small, non-destructive local workflow and inspect application logs for database, migration, decrypt, missing-file or permission errors. Do not expose secret values while capturing evidence.
8. Record the backup generation, target OS/profile, app version, test cases, results, operator and UTC time. Mark the rehearsal **restore-verified** only when every required data class has passed.

If the target OS profile cannot unlock OS-backed secrets, record that limitation and plan explicit re-authentication. Do not downgrade the result to PASS because non-secret UI data loaded successfully.

## 5. Upgrade, rollback and incident rules

- Take and verify a cold backup before any release that may run a data migration or rotate encryption material.
- Keep the pre-upgrade copy untouched until the new release has passed its required startup, Vault, workspace and data-integrity checks.
- If startup reports a database migration failure, Vault decrypt error, missing attachment, or unexpected data loss, stop writes and preserve the failing profile for diagnosis.
- Do not open a profile that has been migrated by a newer app version in an older app version unless backward compatibility is explicitly established. Restore the untouched pre-upgrade copy instead.
- Before restoring, quarantine the current profile/workspace copy. Never overwrite the only copy that may contain newer user data.
- Treat backups as sensitive production data: restrict access, encrypt at rest, document retention and deletion, and redact paths and contents from external issue reports.

For Vault-specific failure handling, follow the more detailed procedures in `docs/PRODUCTION-SECURITY.md`. This runbook complements that procedure; it does not replace it.

## 6. PASS / HOLD evidence

A recovery rehearsal is **PASS** only when all applicable items below are evidenced:

- [ ] Complete `userData` inventory captured and checksum-verified.
- [ ] Every active workspace root captured, including `.open-bot/memory.db` and `.open-bot/attachments/`.
- [ ] Vault and separate webhook-key stores retain their correct key/store pairings and bounded backup copies.
- [ ] Restore performed without overwriting the only production copy.
- [ ] Vault is usable under the intended OS security context, or required re-authentication is explicitly recorded.
- [ ] Representative bots, settings, chats, memory, tasks, workspace files and image attachments are present.
- [ ] No unresolved migration, database, permission, decrypt or missing-file error remains.
- [ ] Manifest, hashes, app/source version, OS/profile, operator and UTC result are retained without secret values.

Any missing workspace, missing attachment, hash mismatch, unknown key pairing, unexplained Vault degradation, unresolved database error, or untested restore path is **HOLD**. Do not claim disaster-recovery readiness based on a backup file existing alone.
