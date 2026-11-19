/**
 * Sandbox detection retry (v144 fix, production).
 *
 * r3 failed 7 tests from ONE root cause: binary detection ran
 * `bwrap --version` exactly once and treated ANY spawn error as
 * "binary absent". Under full-suite load a single fork can fail
 * transiently (EAGAIN), so detection reported bwrap missing while
 * other tests in the SAME run were happily running bwrap:
 * probe said bwrapAvailable=false + isolation='unshare', v5
 * choice_set refused bwrap ('Error: Tier "bwrap" is not
 * available...'), runtime fell back to 'local', M6 detect failed.
 *
 * Deterministic regression (no mocks): a fake `bwrap` on PATH that
 * fails its first N invocations, then succeeds. Detection must
 * survive the transient failures; a persistently failing binary
 * must still report false (fast, no hang); a truly absent binary
 * (ENOENT) must report false immediately.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { detectIsolation, v17ProbeSandbox } from '../packages/core/dist/index.js';

function makeFakeBwrap(dir, fails) {
  const counter = path.join(dir, 'counter');
  fs.writeFileSync(counter, '0');
  const script = path.join(dir, 'bwrap');
  fs.writeFileSync(
    script,
    '#!/bin/sh\n' +
      'c="$FAKE_BWRAP_COUNTER"\n' +
      'n=$(cat "$c" 2>/dev/null || echo 0)\n' +
      'n=$((n + 1))\n' +
      'echo "$n" > "$c"\n' +
      'if [ "$n" -le "$FAKE_BWRAP_FAILS" ]; then exit 1; fi\n' +
      'exit 0\n',
  );
  fs.chmodSync(script, 0o755);
  return counter;
}

test('detect: fake bwrap failing first 2 calls still detected (retry)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-detect-flaky-'));
  const counter = makeFakeBwrap(dir, 2);
  const oldPath = process.env.PATH ?? '';
  const oldCounter = process.env.FAKE_BWRAP_COUNTER;
  const oldFails = process.env.FAKE_BWRAP_FAILS;
  try {
    process.env.PATH = `${dir}:${oldPath}`;
    process.env.FAKE_BWRAP_COUNTER = counter;
    process.env.FAKE_BWRAP_FAILS = '2';
    const probe = v17ProbeSandbox();
    assert.equal(probe.bwrapAvailable, true, 'flaky bwrap must be detected after retry');
    assert.equal(probe.isolation, 'bwrap');
    assert.equal(detectIsolation().kind, 'bwrap');
    assert.ok(Number(fs.readFileSync(counter, 'utf8')) >= 3, 'at least one retry happened');
  } finally {
    process.env.PATH = oldPath;
    if (oldCounter === undefined) delete process.env.FAKE_BWRAP_COUNTER;
    else process.env.FAKE_BWRAP_COUNTER = oldCounter;
    if (oldFails === undefined) delete process.env.FAKE_BWRAP_FAILS;
    else process.env.FAKE_BWRAP_FAILS = oldFails;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detect: no bwrap/unshare on PATH reports none (ENOENT fast-false)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-detect-empty-'));
  const oldPath = process.env.PATH ?? '';
  try {
    process.env.PATH = dir;
    const probe = v17ProbeSandbox();
    assert.equal(probe.bwrapAvailable, false);
    assert.equal(probe.unshareAvailable, false);
    assert.equal(probe.isolation, 'none');
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detect: persistently failing bwrap still false, no hang', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-detect-bad-'));
  const counter = makeFakeBwrap(dir, 999);
  const oldPath = process.env.PATH ?? '';
  const oldCounter = process.env.FAKE_BWRAP_COUNTER;
  const oldFails = process.env.FAKE_BWRAP_FAILS;
  const start = Date.now();
  try {
    process.env.PATH = `${dir}:${oldPath}`;
    process.env.FAKE_BWRAP_COUNTER = counter;
    process.env.FAKE_BWRAP_FAILS = '999';
    const probe = v17ProbeSandbox();
    assert.equal(probe.bwrapAvailable, false);
    assert.ok(Date.now() - start < 10_000, 'must finish fast (bounded retries)');
  } finally {
    process.env.PATH = oldPath;
    if (oldCounter === undefined) delete process.env.FAKE_BWRAP_COUNTER;
    else process.env.FAKE_BWRAP_COUNTER = oldCounter;
    if (oldFails === undefined) delete process.env.FAKE_BWRAP_FAILS;
    else process.env.FAKE_BWRAP_FAILS = oldFails;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
