import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const guide = fs.readFileSync(
  path.join(here, '..', 'docs', 'ops', 'UPGRADE-DATA-PRESERVATION-VERIFICATION.md'),
  'utf8',
);

test('defines the complete local recovery boundary', () => {
  assert.ok(guide.includes('complete active Electron `userData` directory'));
  assert.ok(guide.includes('every active workspace root'));
  assert.ok(guide.includes('OS account/profile context required by OS-backed encryption'));
  assert.ok(guide.includes('Provider-side state, remote accounts'));
});

test('requires classifying candidate data migrations before upgrade', () => {
  assert.ok(guide.includes('additive schema, row/data rewrite, file-layout change, cryptographic migration'));
  assert.ok(guide.includes('credential relocation'));
  assert.ok(guide.includes('general reverse-migration path'));
});

test('documents existing SQLite schema and thread migration behavior', () => {
  assert.ok(guide.includes('conditionally adds legacy columns'));
  assert.ok(guide.includes('Default-thread adoption'));
  assert.ok(guide.includes('Opening a workspace after upgrade can therefore write data'));
});

test('documents attachment reconciliation pairing', () => {
  assert.ok(guide.includes('attachment files that have no matching database row'));
  assert.ok(guide.includes('memory.db'));
  assert.ok(guide.includes('.open-bot/attachments/'));
  assert.ok(guide.includes('same backup generation'));
});

test('documents Vault safeStorage migration and credential relocation', () => {
  assert.ok(guide.includes('Electron `safeStorage`'));
  assert.ok(guide.includes('LocalEncryptor entries'));
  assert.ok(guide.includes('Credential relocation can move provider keys from settings into Vault namespaces'));
  assert.ok(guide.includes('Do not clear the Vault or regenerate keys'));
});

test('requires a cold pre-upgrade backup of profile and all workspaces', () => {
  assert.ok(guide.includes('Exit open-bot normally'));
  assert.ok(guide.includes('Do not copy a live SQLite database'));
  assert.ok(guide.includes('one cold backup generation'));
  assert.ok(guide.includes('every complete active workspace root'));
});

test('requires key and ciphertext generation pairing', () => {
  assert.ok(guide.includes('sibling `.key` files when present'));
  assert.ok(guide.includes('Never combine files copied at different times'));
  assert.ok(guide.includes('matching key and backup generation'));
});

test('requires manifest size and hash reconciliation', () => {
  assert.ok(guide.includes('byte sizes and SHA-256 hashes'));
  assert.ok(guide.includes('Reconcile the destination against the manifest'));
  assert.ok(guide.includes('copy-verified'));
  assert.ok(guide.includes('restore-verified'));
});

test('requires prior installer and candidate artifact identity', () => {
  assert.ok(guide.includes('exact prior approved installer/version'));
  assert.ok(guide.includes('candidate artifact identity'));
  assert.ok(guide.includes('platform signature/notarization'));
});

test('defines upgrade execution stop conditions', () => {
  assert.ok(guide.includes('Treat database, migration, decrypt, permission, missing-file or attachment errors as HOLD'));
  assert.ok(guide.includes('Keep the pre-upgrade backup untouched'));
  assert.ok(guide.includes('Do not launch the old version'));
});

test('verifies userData and settings after upgrade', () => {
  assert.ok(guide.includes('expected active `userData` path'));
  assert.ok(guide.includes('representative settings, bot configuration and local registries'));
  assert.ok(guide.includes('close and reopen'));
});

test('verifies SQLite workspace data classes', () => {
  for (const field of ['bots, conversations, threads, memory entries, tasks, goals, todos, projects and run checkpoints',
    'SQLite integrity/schema errors', 'small, non-destructive local workflow',
    'persists after a normal close and restart']) {
    assert.ok(guide.includes(field), 'missing SQLite verification: ' + field);
  }
});

test('verifies attachments and workspace files', () => {
  assert.ok(guide.includes('Open representative historical image attachments'));
  assert.ok(guide.includes('both their database references and corresponding files'));
  assert.ok(guide.includes('representative user project files'));
  assert.ok(guide.includes('missing referenced attachment'));
});

test('verifies Vault backend and credential state without exposing secrets', () => {
  assert.ok(guide.includes('Vault status and active backend in the UI'));
  assert.ok(guide.includes('without exposing secret values'));
  assert.ok(guide.includes('matching store/key pair'));
  assert.ok(guide.includes('approved re-authentication process'));
});

test('requires runtime workflow and sanitized log review', () => {
  assert.ok(guide.includes('Complete a harmless local workflow'));
  assert.ok(guide.includes('sanitized logs'));
  assert.ok(guide.includes('PASS, FAIL or NOT RUN'));
  assert.ok(guide.includes('must never be represented as passed'));
});

test('defines rollback triggers and forbids unsafe in-place repair', () => {
  assert.ok(guide.includes('Prepare rollback when'));
  assert.ok(guide.includes('in-place reverse SQL migration'));
  assert.ok(guide.includes('repeated launches against failing data'));
});

test('requires quarantining failed state and restoring one matching generation', () => {
  assert.ok(guide.includes('quarantined copy of the failed post-upgrade'));
  assert.ok(guide.includes('one complete matching backup generation'));
  assert.ok(guide.includes('exact previously approved application version'));
  assert.ok(guide.includes('original supported OS account/profile'));
});

test('defines evidence and PASS/HOLD acceptance criteria', () => {
  assert.ok(guide.includes('Backup generation ID, manifest, file counts, byte sizes, hashes'));
  assert.ok(guide.includes('Operator, UTC timestamps, commands, exit codes'));
  assert.ok(guide.includes('An upgrade is **PASS** only'));
  assert.ok(guide.includes('A rollback is **PASS** only'));
  assert.ok(guide.includes('is **HOLD**'));
});
