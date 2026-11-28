import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const runbook = fs.readFileSync(
  path.join(here, '..', 'docs', 'ops', 'RUNTIME-STABILITY-SHUTDOWN-VERIFICATION.md'),
  'utf8',
);

test('identifies the reviewed base and states this is a procedure, not execution evidence', () => {
  assert.ok(runbook.includes('2d14cc1b73c3f9fecb4b92614c180fb15a404aec'));
  assert.ok(runbook.includes('not evidence that a soak, shutdown rehearsal, or platform test has already passed'));
  assert.ok(runbook.includes('does not change application behavior'));
});

test('defines distinct acceptance outcomes', () => {
  assert.ok(runbook.includes('**PASS**'));
  assert.ok(runbook.includes('**FAIL**'));
  assert.ok(runbook.includes('**BLOCKED**'));
  assert.ok(runbook.includes('**NOT RUN**'));
});

test('distinguishes window close from application shutdown', () => {
  assert.ok(runbook.includes('A clean window close is not necessarily an application shutdown'));
  assert.ok(runbook.includes('Cmd+Q'));
  assert.ok(runbook.includes('app.quit()'));
});

test('requires exact candidate and artifact identity', () => {
  assert.ok(runbook.includes('full source commit SHA'));
  assert.ok(runbook.includes('artifact filename and SHA-256'));
  assert.ok(runbook.includes('Do not combine results from different build types or SHAs'));
});

test('requires a disposable profile and single-instance preflight', () => {
  assert.ok(runbook.includes('disposable OS account or test profile'));
  assert.ok(runbook.includes('single-instance lock'));
  assert.ok(runbook.includes('no other open-bot instance is running'));
});

test('references actual lifecycle implementation and repository gates', () => {
  assert.ok(runbook.includes('apps/desktop/src/main/main.ts'));
  assert.ok(runbook.includes('package.json'));
  assert.ok(runbook.includes('docs/TESTING.md'));
});

test('describes the two-phase startup sequence without overclaiming readiness', () => {
  assert.ok(runbook.includes('two bootstrap phases'));
  assert.ok(runbook.includes('Local API'));
  assert.ok(runbook.includes('file watcher'));
  assert.ok(runbook.includes('process existence alone'));
});

test('documents the actual before-quit cleanup responsibilities', () => {
  assert.ok(runbook.includes('saves settings'));
  assert.ok(runbook.includes('stops the update service and automation scheduler'));
  assert.ok(runbook.includes('clears dream/project-update timers'));
  assert.ok(runbook.includes('closes registered file watchers'));
});

test('calls out asynchronous cleanup that is not awaited', () => {
  assert.ok(runbook.includes('fire-and-forget'));
  assert.ok(runbook.includes('coordinator/fleet disposal are not awaited'));
  assert.ok(runbook.includes('verify actual process exit, child processes and released resources'));
});

test('requires repeated cold-start and UI readiness checks', () => {
  assert.ok(runbook.includes('fully stopped state'));
  assert.ok(runbook.includes('renderer finishes loading'));
  assert.ok(runbook.includes('at least three times'));
  assert.ok(runbook.includes('stale lock, orphan process'));
});

test('defines a minimum idle soak and periodic resource measurements', () => {
  assert.ok(runbook.includes('minimum 30-minute idle soak'));
  assert.ok(runbook.includes('5-minute intervals'));
  assert.ok(runbook.includes('CPU, memory, process count, open handles/files'));
});

test('defines a controlled-activity soak and safe workload boundaries', () => {
  assert.ok(runbook.includes('minimum 30-minute controlled-activity soak'));
  assert.ok(runbook.includes('short chat turn, cancellation'));
  assert.ok(runbook.includes('dedicated test token'));
  assert.ok(runbook.includes('without explicit owner approval'));
});

test('does not invent universal resource thresholds', () => {
  assert.ok(runbook.includes('Do not invent a universal CPU or memory threshold'));
  assert.ok(runbook.includes('release-owner thresholds'));
});

test('separates macOS window reactivation from explicit quit', () => {
  assert.ok(runbook.includes('closing the last window leaves the app available for reactivation'));
  assert.ok(runbook.includes("application menu's Quit command or Cmd+Q"));
  assert.ok(runbook.includes('Dock'));
});

test('checks process, child process and Local API listener termination', () => {
  assert.ok(runbook.includes('main Electron process exits'));
  assert.ok(runbook.includes('coordinator or other app-owned child process exits'));
  assert.ok(runbook.includes('loopback listener releases the recorded port'));
  assert.ok(runbook.includes('No orphaned app-owned process'));
});

test('requires subsequent relaunch and test-profile integrity checks', () => {
  assert.ok(runbook.includes('subsequent launch succeeds'));
  assert.ok(runbook.includes('unexplained lock, corruption warning or lost settings'));
  assert.ok(runbook.includes('same test profile'));
});

test('keeps forced termination separate from graceful shutdown acceptance', () => {
  assert.ok(runbook.includes('Mark the graceful-shutdown check FAIL'));
  assert.ok(runbook.includes('A forced kill is a separate recovery observation'));
  assert.ok(runbook.includes('before collecting evidence'));
});

test('documents exact build and test gates by operating system', () => {
  for (const command of [
    'npm ci',
    'npm run version:sync',
    'npm run version:check',
    'npm run build',
    'npm run typecheck',
  ]) {
    assert.ok(runbook.includes(command), 'missing release gate command: ' + command);
  }
  assert.ok(runbook.includes('xvfb-run -a npm test'));
  assert.ok(runbook.includes('Windows / macOS'));
});

test('requires exact-SHA evidence and explains HOLD conditions', () => {
  assert.ok(runbook.includes('same candidate SHA'));
  assert.ok(runbook.includes('pass/fail/skipped counts'));
  assert.ok(runbook.includes('Set overall status to HOLD'));
  assert.ok(runbook.includes('orphan process or resource leak'));
});

test('does not claim runtime, shutdown or platform acceptance was performed', () => {
  assert.ok(runbook.includes('operator procedure only'));
  assert.ok(runbook.includes('does not claim that any runtime soak'));
  assert.ok(runbook.includes('has been performed on a new candidate'));
});
