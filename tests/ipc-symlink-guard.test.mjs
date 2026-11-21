/**
 * Regression tests for IPC path confinement through filesystem symlinks.
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then:
 *   node --test tests/ipc-symlink-guard.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  resolveWithin,
  validateWorkspaceDir,
} from '../packages/core/dist/ipc/index.js';

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('IPC path guard rejects an existing symlink that escapes every allowed root', () => {
  const root = tempDir('open-bot-ipc-root-');
  const outside = tempDir('open-bot-ipc-outside-');
  const link = join(root, 'outside-link');

  try {
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');

    const escapedTarget = join(link, 'secret.txt');
    assert.throws(
      () => resolveWithin([root], escapedTarget, 'workspaceDir'),
      /symlink/i,
    );
    assert.throws(
      () => validateWorkspaceDir(escapedTarget, [root]),
      /symlink/i,
    );

    // A normal path that remains beneath the allowed root stays valid.
    const normalTarget = join(root, 'new-workspace', 'file.txt');
    assert.equal(
      resolveWithin([root], normalTarget),
      resolve(normalTarget),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('IPC path guard permits a symlink whose real target stays inside the allowed root', () => {
  const root = tempDir('open-bot-ipc-internal-');
  const realDir = join(root, 'real-dir');
  const link = join(root, 'internal-link');

  try {
    mkdirSync(realDir);
    symlinkSync(realDir, link, process.platform === 'win32' ? 'junction' : 'dir');

    const target = join(link, 'future.txt');
    assert.equal(resolveWithin([root], target), resolve(target));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
