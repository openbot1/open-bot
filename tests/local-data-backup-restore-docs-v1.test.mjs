import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const guide = fs.readFileSync(
  path.join(process.cwd(), 'docs', 'LOCAL-DATA-BACKUP-RESTORE.md'),
  'utf8',
);

test('documents separate Electron userData and workspace recovery roots', () => {
  assert.match(guide, /app\.getPath\('userData'\)/);
  assert.match(guide, /each workspace root/i);
});

test('documents the workspace SQLite database and its attachment sidecar data', () => {
  assert.match(guide, /\.open-bot\/memory\.db/);
  assert.match(guide, /\.open-bot\/attachments\//);
  assert.match(guide, /database-only copy is incomplete/i);
});

test('requires a stopped writer before copying SQLite-backed state', () => {
  assert.match(guide, /Exit open-bot normally/);
  assert.match(guide, /Do not copy a live SQLite database/i);
});

test('preserves the Vault store, fallback key and bounded backup generations', () => {
  assert.match(guide, /vault\.json\.key/);
  assert.match(guide, /bounded \.1[–-]\.3 copies/);
  assert.match(guide, /Never delete, regenerate/i);
});

test('treats the webhook key store as a separate recovery unit', () => {
  assert.match(guide, /automation-webhook-keys\.json/);
  assert.match(guide, /main Vault key protects this store/i);
});

test('explains OS-backed safeStorage recovery boundaries', () => {
  assert.match(guide, /DPAPI on Windows, Keychain on macOS, or libsecret on Linux/);
  assert.match(guide, /same supported OS account\/profile/i);
  assert.match(guide, /cross-machine decryption/i);
});

test('requires inventory, byte sizes, SHA-256 and post-copy reconciliation', () => {
  assert.match(guide, /byte sizes and SHA-256 hashes/i);
  assert.match(guide, /Verify the destination copy against that manifest/i);
});

test('requires encrypted, access-controlled backup storage', () => {
  assert.match(guide, /access-controlled destination/i);
  assert.match(guide, /Encrypt the backup at rest/i);
});

test('requires an isolated restore rehearsal and protects the only live copy', () => {
  assert.match(guide, /disposable copy or a dedicated test installation/i);
  assert.match(guide, /Never experiment against the only production copy/i);
  assert.match(guide, /quarantined and unchanged/i);
});

test('checks representative app data and image attachment restoration', () => {
  assert.match(guide, /conversation history, tasks and workspace files/i);
  assert.match(guide, /historical image attachments/i);
});

test('defines migration rollback and fail-closed HOLD conditions', () => {
  assert.match(guide, /pre-upgrade copy untouched/i);
  assert.match(guide, /backward compatibility is explicitly established/i);
  assert.match(guide, /HOLD/i);
});

test('does not treat an existing backup file as proof of recoverability', () => {
  assert.match(guide, /A successful copy command is not a verified backup/i);
  assert.match(guide, /backup file existing alone/i);
});
