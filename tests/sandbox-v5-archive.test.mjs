/**
 * Tests cho Sandbox v5 — idle archiving (v1.37, Đội T3).
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/sandbox-v5-archive.test.mjs
 *
 * Archive thật trên thư mục tạm (tar.gz khi tar có mặt, copy
 * khi ép format) — không chạy backend thật.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  SandboxV5Archiver,
  isSandboxV5ArchiveExcluded,
  sandboxV5CopyManifestHash,
  sandboxV5DirSizeBytes,
  sandboxV5WalkFiles,
} from '../packages/core/dist/index.js';

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeWorkdir(base, name, files) {
  const workdir = path.join(base, name);
  fs.mkdirSync(workdir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(workdir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return workdir;
}

test('archive: excluded names never pack (secrets stay out of archives)', () => {
  assert.equal(isSandboxV5ArchiveExcluded('.env'), true);
  assert.equal(isSandboxV5ArchiveExcluded('.env.local'), true);
  assert.equal(isSandboxV5ArchiveExcluded('sub/.env'), true);
  assert.equal(isSandboxV5ArchiveExcluded('auth/session.json'), true);
  assert.equal(isSandboxV5ArchiveExcluded('key.pem'), true);
  assert.equal(isSandboxV5ArchiveExcluded('id_rsa'), true);
  assert.equal(isSandboxV5ArchiveExcluded('credentials.json'), true);
  assert.equal(isSandboxV5ArchiveExcluded('src/index.ts'), false);
  assert.equal(isSandboxV5ArchiveExcluded('notes.txt'), false);
});

test('archive: copy format round-trips files and excludes secrets', (t) => {
  const base = tmpDir(t, 'sbv5-arch-');
  const archiver = new SandboxV5Archiver({ baseDir: path.join(base, 'archives'), format: 'copy' });
  const workdir = makeWorkdir(base, 'work-bot-a', {
    'src/index.ts': 'export const a = 1;\n',
    'notes.txt': 'keep me',
    '.env': 'SECRET=do-not-pack',
    'auth/session.json': '{"token":"x"}',
    'key.pem': '-----BEGIN PRIVATE KEY-----',
  });
  const result = archiver.archive({
    botId: 'bot-a',
    runtimeId: 'rt-1',
    tier: 'bwrap',
    profileId: 'coder',
    workdir,
    runtimeCreatedAtMs: 1000,
    lastActivityAtMs: 2000,
    idleThresholdMs: 60_000,
    archivedBy: 'system',
    reason: 'idle',
  });
  assert.equal(result.archive.format, 'copy');
  assert.equal(result.archive.fileCount, 2);
  assert.deepEqual(result.archive.excludedSecrets.sort(), ['.env', 'auth/session.json', 'key.pem']);
  assert.equal(result.liveRemoved, true);
  assert.equal(fs.existsSync(workdir), false);
  assert.equal(result.archive.payloadSha256.length, 64);
  const dest = path.join(base, 'restored-bot-a');
  const restored = archiver.restore(result.archive.id, dest);
  assert.equal(restored.hashVerified, true);
  assert.equal(restored.restoredFiles, 2);
  assert.equal(fs.readFileSync(path.join(dest, 'src/index.ts'), 'utf8'), 'export const a = 1;\n');
  assert.equal(fs.existsSync(path.join(dest, '.env')), false);
  assert.equal(fs.existsSync(path.join(dest, 'auth')), false);
  assert.equal(archiver.get(result.archive.id)?.state, 'restored');
  assert.equal(archiver.list().length, 1);
});

test('archive: tar-gz format round-trips files and verifies hash on restore', (t) => {
  const base = tmpDir(t, 'sbv5-arch-tar-');
  const archiver = new SandboxV5Archiver({ baseDir: path.join(base, 'archives'), format: 'tar-gz' });
  const workdir = makeWorkdir(base, 'work-bot-a', {
    'a.txt': 'hello',
    'sub/b.txt': 'world',
    '.env': 'SECRET=do-not-pack',
  });
  const result = archiver.archive({
    botId: 'bot-a',
    runtimeId: 'rt-1',
    tier: 'bwrap',
    workdir,
    runtimeCreatedAtMs: 1000,
    lastActivityAtMs: 2000,
    idleThresholdMs: 60_000,
  });
  assert.equal(result.archive.format, 'tar-gz');
  assert.equal(result.archive.fileCount, 2);
  const dest = path.join(base, 'restored-bot-a');
  const restored = archiver.restore(result.archive.id, dest);
  assert.equal(restored.hashVerified, true);
  assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'hello');
  assert.equal(fs.readFileSync(path.join(dest, 'sub/b.txt'), 'utf8'), 'world');
  assert.equal(fs.existsSync(path.join(dest, '.env')), false);
});

test('archive: tampered payload is refused on restore', (t) => {
  const base = tmpDir(t, 'sbv5-arch-tamper-');
  const archiver = new SandboxV5Archiver({ baseDir: path.join(base, 'archives'), format: 'copy' });
  const workdir = makeWorkdir(base, 'work-bot-a', { 'a.txt': 'hello' });
  const result = archiver.archive({
    botId: 'bot-a',
    runtimeId: 'rt-1',
    tier: 'bwrap',
    workdir,
    runtimeCreatedAtMs: 1000,
    lastActivityAtMs: 2000,
    idleThresholdMs: 60_000,
  });
  // Tamper: change a packed file inside the archive payload.
  fs.writeFileSync(path.join(base, 'archives', result.archive.id, 'workspace', 'a.txt'), 'EVIL', 'utf8');
  assert.throws(
    () => archiver.restore(result.archive.id, path.join(base, 'restored')),
    /hash check/,
  );
});

test('archive: restore refuses an existing destination and unknown ids', (t) => {
  const base = tmpDir(t, 'sbv5-arch-dest-');
  const archiver = new SandboxV5Archiver({ baseDir: path.join(base, 'archives'), format: 'copy' });
  const workdir = makeWorkdir(base, 'work-bot-a', { 'a.txt': 'hello' });
  const result = archiver.archive({
    botId: 'bot-a',
    runtimeId: 'rt-1',
    tier: 'bwrap',
    workdir,
    runtimeCreatedAtMs: 1000,
    lastActivityAtMs: 2000,
    idleThresholdMs: 60_000,
  });
  const dest = path.join(base, 'existing');
  fs.mkdirSync(dest, { recursive: true });
  assert.throws(() => archiver.restore(result.archive.id, dest), /already exists/);
  assert.throws(() => archiver.restore('arc-nope', path.join(base, 'x')), /Unknown sandbox v5 archive/);
  assert.equal(archiver.delete('arc-nope'), false);
  assert.equal(archiver.delete(result.archive.id), true);
  assert.equal(archiver.list().length, 0);
});

test('archive: scanIdle only flags stopped runtimes past the threshold', (t) => {
  const base = tmpDir(t, 'sbv5-arch-scan-');
  const archiver = new SandboxV5Archiver({ baseDir: path.join(base, 'archives') });
  const now = 1_000_000;
  const candidates = archiver.scanIdle(
    [
      { botId: 'idle-bot', runtimeId: 'rt-1', state: 'stopped', lastActivityAtMs: now - 90_000, workspaceBytes: 100 },
      { botId: 'fresh-bot', runtimeId: 'rt-2', state: 'stopped', lastActivityAtMs: now - 1000, workspaceBytes: 100 },
      { botId: 'running-bot', runtimeId: 'rt-3', state: 'running', lastActivityAtMs: now - 999_999, workspaceBytes: 100 },
    ],
    60_000,
    now,
  );
  assert.equal(candidates[0]?.archivable, true);
  assert.equal(candidates[0]?.idleMs, 90_000);
  assert.equal(candidates[1]?.archivable, false);
  assert.equal(candidates[1]?.reason.includes('below'), true);
  assert.equal(candidates[2]?.archivable, false);
  assert.equal(candidates[2]?.reason.includes('running'), true);
});

test('archive: manifest hash is stable across copies, changes on tamper', (t) => {
  const base = tmpDir(t, 'sbv5-arch-hash-');
  const workdir = makeWorkdir(base, 'work', { 'a.txt': 'hello', 'b.txt': 'world' });
  const before = sandboxV5CopyManifestHash(workdir, ['a.txt', 'b.txt']);
  const copy = path.join(base, 'copy');
  fs.mkdirSync(copy, { recursive: true });
  fs.copyFileSync(path.join(workdir, 'a.txt'), path.join(copy, 'a.txt'));
  fs.copyFileSync(path.join(workdir, 'b.txt'), path.join(copy, 'b.txt'));
  assert.equal(sandboxV5CopyManifestHash(copy, ['a.txt', 'b.txt']), before);
  fs.writeFileSync(path.join(copy, 'a.txt'), 'tampered', 'utf8');
  assert.notEqual(sandboxV5CopyManifestHash(copy, ['a.txt', 'b.txt']), before);
  assert.equal(sandboxV5WalkFiles(workdir).length, 2);
  assert.equal(sandboxV5DirSizeBytes(workdir), 10);
});
