import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const guide = fs.readFileSync(
  path.join(process.cwd(), 'docs', 'LOCAL-DATA-MIGRATION-ROLLBACK.md'),
  'utf8',
);

test('separates application updates and version metadata from durable-data migration', () => {
  assert.match(guide, /downloads and installs updates manually/i);
  assert.match(guide, /release\/version metadata sync is not a migration/i);
});

test('defines the complete userData and workspace recovery boundary', () => {
  assert.match(guide, /Electron `userData`/);
  assert.match(guide, /every active workspace root/i);
  assert.match(guide, /OS-bound encryption context/i);
});

test('documents guarded SQLite schema additions by their actual column names', () => {
  for (const column of ['tasks.tags', 'projects.updatesEnabled', 'projects.lastUpdateAt', 'messages.threadId', 'threads.titleCustom']) {
    assert.ok(guide.includes(column), `missing documented SQLite migration: ${column}`);
  }
  assert.match(guide, /PRAGMA table_info/);
  assert.match(guide, /ALTER TABLE/);
});

test('documents lazy default-thread adoption as a data rewrite', () => {
  assert.match(guide, /ensureDefaultThread/);
  assert.match(guide, /messages.threadId IS NULL/);
  assert.match(guide, /original messages remain, but the rows are changed/i);
});

test('requires the database and attachments to be restored from one generation', () => {
  assert.match(guide, /prunes attachment files that have no matching database row/i);
  assert.match(guide, /same backup generation/i);
  assert.match(guide, /newer unreferenced attachment files to be pruned/i);
});

test('documents Vault safeStorage migration and its decryption gate', () => {
  assert.match(guide, /openVaultWithSafeStorage/);
  assert.match(guide, /re-encrypts legacy LocalEncryptor entries/i);
  assert.match(guide, /all entries can be decrypted/i);
});

test('fails closed on unavailable Vault and preserves ciphertext/key pairing', () => {
  assert.match(guide, /disables persistent writes and preserves ciphertext/i);
  assert.match(guide, /unexpected degraded status is HOLD/i);
  assert.match(guide, /matching fallback key/i);
  assert.match(guide, /Do not rotate keys or delete fallback keys during an incident/i);
});

test('documents idempotent credential migration and deferred legacy values', () => {
  assert.match(guide, /moves legacy provider API keys from `settings.json` into the Vault/i);
  assert.match(guide, /idempotent and defers/i);
  assert.match(guide, /Do not clear legacy values/i);
});

test('requires candidate source-diff classification before upgrade', () => {
  assert.match(guide, /Review the candidate release's source diff/i);
  assert.match(guide, /additive schema, row/data rewrite, file-layout change, cryptographic migration/i);
  assert.match(guide, /downgrade incompatibility/i);
});

test('requires a cold, complete backup before migration starts', () => {
  assert.match(guide, /Exit open-bot normally/i);
  assert.match(guide, /Do not copy a live SQLite database/i);
  assert.match(guide, /complete `userData` directory and every complete active workspace root/i);
  assert.match(guide, /byte size and SHA-256/i);
});

test('defines post-upgrade data, Vault, attachment and restart checks', () => {
  assert.match(guide, /Vault reports the expected state/i);
  assert.match(guide, /representative image attachments/i);
  assert.match(guide, /writes persist after a normal close and restart/i);
});

test('defines explicit rollback triggers and stops repeated writes', () => {
  assert.match(guide, /Rollback triggers/);
  assert.match(guide, /Do not repeatedly launch either version/i);
  assert.match(guide, /missing file/i);
});

test('requires restoring the prior app and one matching pre-upgrade generation', () => {
  assert.match(guide, /Reinstall the exact previously approved application version/i);
  assert.match(guide, /same generation/i);
  assert.match(guide, /Do not mix a new `memory.db` with old attachments/i);
  assert.match(guide, /original supported OS account/profile/i);
});

test('forbids manual downgrade edits and defines measurable PASS / HOLD states', () => {
  assert.match(guide, /ad-hoc SQL column drops/i);
  assert.match(guide, /A rollback is **PASS** only/i);
  assert.match(guide, /unverified OS security context is **HOLD**/i);
  assert.match(guide, /does not implement database downgrade logic/i);
});
