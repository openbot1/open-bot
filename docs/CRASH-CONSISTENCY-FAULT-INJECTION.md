# Crash-Consistency and Fault-Injection Runbook

This runbook defines a controlled production-readiness procedure for interrupted writes and crash recovery in open-bot. It describes how to exercise the current persistence boundaries and collect evidence; it does not add application fault-injection hooks or promise power-loss durability beyond the guarantees of the filesystem and operating system.

## 1. Safety and scope

Run all destructive or interruption tests only against disposable temporary profiles, copied workspaces and synthetic credentials. Never point fault injection at a user's live `userData`, workspace, production Vault or only copy of a database. Keep the original recovery point read-only and separate from the test target.

The covered persistence boundaries are:

- Workspace SQLite state: `.open-bot/memory.db`, transactions, messages, attachments and run checkpoints.
- Vault durable-file writes: temporary file, file fsync, bounded backup rotation, final rename and best-effort directory fsync.
- Vault key rotation: old key backup, staged `.new` key, rewritten ciphertext store, key promotion and crash repair.
- Durable run journal and checkpoint recovery: append-only journal records, unfinished runs, completed steps and resume behavior.
- Restart reconciliation: missing live Vault file, retained backup copies, orphan attachment cleanup and incomplete-run discovery.

This is not a claim that every write path in the application is power-loss safe. In particular, directory fsync is best-effort and may not be supported on every platform. A process-kill test is not equivalent to sudden power loss, kernel failure, storage-controller failure or filesystem corruption.

## 2. Existing implementation contracts to validate

### SQLite and attachments

`BotMemory.saveMessage` writes attachment bytes first, then inserts the message and attachment metadata rows inside one SQLite transaction. On a caught failure it rolls back the transaction and best-effort removes the files written for that message. Startup also prunes attachment directories that have no corresponding attachment rows.

`deleteBotData` deletes the bot's rows in one transaction, then removes its attachment directories best-effort. An interruption between those phases can leave orphan files for the startup sweep; it must not leave a partially deleted set of SQLite rows.

Run against a disposable workspace and verify these invariants:

- A committed message has its expected message row, attachment rows and readable attachment files.
- A failed or interrupted pre-commit save does not expose a committed partial message; any orphan files are either removed by cleanup or safely identified for the startup sweep.
- A bot-data deletion is all-or-nothing at the SQLite row level; leftover attachment directories are orphan-only and are reconciled on reopen.
- Existing messages, unrelated bots and unrelated attachments remain unchanged.

### Vault durable file writes

`writeDurableFileSync` writes a same-directory temporary file, fsyncs that file, rotates bounded previous copies, renames the temporary file to the live path, then attempts a directory fsync. The default is three previous copies. If interruption occurs after the old live file has moved to `.1` but before the final rename, the live path can be absent while the previous bytes remain in the newest backup. `readDurableFileSync` reads the live file first and then the bounded copies; callers still decide how to parse and validate the result.

Do not interpret atomic rename as a guarantee against every hardware or power-loss failure. Validate both the live-file state and its backup chain after each injected failure. A corrupt live Vault file is not silently replaced by a backup by the generic reader; fallback behavior depends on the Vault caller and must be tested as a separate case.

### Vault key rotation

The LocalEncryptor rotation sequence stages the old key as `.bak`, writes the new key to `.new`, rewrites the encrypted store durably using the new key, promotes `.new` to the active key path, and removes `.bak`. If promotion fails after the store was rewritten, the staged key material is required for recovery. On Vault reopen, `repairKeyAfterCrash` checks candidate keys against the store and only repairs when a candidate can decrypt the entire store.

Existing `tests/vault.test.mjs` cases simulate interruption before store rewrite, after store rewrite but before key promotion, key-rename failure, retry, and durable-store final-rename failure. Treat these as deterministic fault simulations, not real machine power-loss tests.

Never manually delete `.new` or `.bak`, regenerate a key, mix a key with a store from another generation, or retry rotation repeatedly before preserving the full store/key/backup set.

### Run journal and checkpoints

The workspace SQLite checkpoint table stores per-step snapshots. The separate durable run journal appends JSONL events such as run start, step completion, tool result, checkpoint and run finish. Recovery identifies unfinished runs from journal/checkpoint evidence; completed steps and tool calls must not be executed a second time during resume.

A journal append is not the same durability contract as the Vault's fsync-and-rename writer. Do not infer that every last appended byte survives abrupt power loss. Validate journal integrity, truncated/corrupt-line handling, the latest usable checkpoint and the finished/un-finished distinction before allowing resume.

## 3. Fault-injection matrix

For every scenario, record the exact source SHA, OS/filesystem, Node/Electron version, scenario identifier, injection point, expected result, observed result, test/log reference and UTC time. Use synthetic secrets and deterministic fixture data.

| Boundary | Injected interruption / failure | Required post-restart evidence |
|---|---|---|
| SQLite message transaction | Fail after attachment write; fail during metadata insert; fail before commit | No visible partially committed message; database opens; unrelated rows remain intact; orphan cleanup is safe |
| SQLite multi-row delete | Fail before commit and after commit/before attachment cleanup | Rows are wholly retained or wholly deleted; only orphan files may remain for cleanup |
| Durable file write | Fail temp write/fsync; interrupt during backup rotation; fail final temp-to-live rename | No partial file is accepted; live or a valid newest backup is available; backup count stays bounded; retry/reopen behavior is understood |
| Vault key rotation | Interrupt before store rewrite; after store rewrite but before key promotion; fail key rename | All existing secrets remain decryptable using the recoverable key candidate; `.new`/`.bak` are retained until repair is proven |
| Journal/checkpoint | Stop after a completed step/checkpoint but before run finish; truncate the final JSONL record in a fixture | Run is detected as unfinished; the last valid checkpoint is identified; completed tools are not replayed |
| Restart/reopen | Reopen the same disposable profile after each injected state | No silent data reset; Vault status, database integrity, attachment availability and recovery classification match the recorded expectation |

Do not claim PASS from a test that only checks an error was thrown. It must reopen the same disposable state and verify both positive invariants (required data still readable) and negative invariants (no partial state, no unintended re-execution, no unexpected loss).

## 4. Execution protocol

1. Start from a clean, isolated test directory and create known baseline records: multiple Vault entries, at least two workspace bots, messages with and without attachments, and a multi-step run with checkpoints.
2. Close all writers before taking the baseline copy. Record relative paths, byte sizes and SHA-256 hashes for the test fixture; keep the baseline outside the fault-injection target.
3. Run one failure scenario at a time. Inject only the selected filesystem/transaction failure; restore any monkey-patched function in a `finally` block so later tests are not contaminated.
4. Capture the expected error or interruption, then reopen the same target state through the normal constructor/recovery path. Do not repair files manually before observing the first recovery result.
5. Verify row counts and representative values, attachment readability, Vault decryptability for every fixture entry, backup/key pairing, journal verification and resume position.
6. Retry the operation only after its recovery state is understood. Confirm idempotency where the operation is designed to be retryable.
7. Preserve the failing fixture and sanitized logs for any unexpected state. Re-run the same scenario from a fresh copy to distinguish deterministic failure from cross-test contamination.

For a process-termination rehearsal, terminate only the disposable test process at a controlled barrier. Separately record that this simulates process interruption, not sudden power loss. A true power-loss or storage-failure claim requires a separately approved platform/virtual-machine methodology and evidence from the actual storage stack; do not infer it from unit tests.

## 5. PASS / HOLD criteria

A scenario is **PASS** only when the same interrupted fixture reopens, all required committed data is readable, no forbidden partial state is present, recovery selects the correct key/backup/checkpoint, and any retry behaves according to the documented idempotency contract.

The overall crash-consistency gate is **PASS** only when every required scenario in the approved matrix has evidence on the intended supported platforms and filesystems, with no unexplained data loss, Vault decrypt failure, corrupt committed SQLite state, missing committed attachment, duplicate completed tool execution or unsafe automatic repair.

Any unexplained missing live-and-backup state, mixed Vault/key generation, partial committed transaction, unreadable committed attachment, invalid checkpoint, unexpected replay of a completed tool, unverified repair, or test against non-disposable user data is **HOLD**.

Retain evidence without secret values, credential contents, conversation text, customer data or private workspace paths. This runbook is an operator/test procedure only; it does not modify application behavior, add fault-injection hooks, or replace the independent backup and migration/rollback procedures.
