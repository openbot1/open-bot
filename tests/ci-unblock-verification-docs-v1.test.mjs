import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const runbook = fs.readFileSync(
  path.join(here, '..', 'docs', 'ops', 'CI-UNBLOCK-VERIFICATION.md'),
  'utf8',
);

test('the runbook identifies slice 3 and keeps release on HOLD', () => {
  assert.ok(runbook.includes('Slice 3/5'));
  assert.ok(runbook.includes('release decision remains **HOLD**'));
  assert.ok(runbook.includes('The release decision remains **HOLD**'));
});

test('the runbook describes both CI matrix jobs', () => {
  assert.ok(runbook.includes('build-test'));
  assert.ok(runbook.includes('platform'));
  assert.ok(runbook.includes('ubuntu-latest'));
  assert.ok(runbook.includes('windows-latest'));
  assert.ok(runbook.includes('macos-latest'));
});

test('the workflow trigger analysis is explicit', () => {
  assert.ok(runbook.includes('Both push and pull_request events'));
  assert.ok(runbook.includes('two independent six-job runs'));
  assert.ok(runbook.includes('not proof that duplicate events caused the queue'));
});

test('the initial candidate SHA is exact', () => {
  assert.ok(runbook.includes('e4626e8d6262ff531854322278c72221a7b1c0bc'));
  assert.ok(runbook.includes('2d14cc1b73c3f9fecb4b92614c180fb15a404aec'));
});

test('both observed run IDs and run numbers are recorded', () => {
  assert.ok(runbook.includes('45897416251'));
  assert.ok(runbook.includes('45897423615'));
  assert.ok(runbook.includes('643'));
  assert.ok(runbook.includes('644'));
});

test('the job-level queue evidence is described without overclaiming', () => {
  assert.ok(runbook.includes('runner_id: 0'));
  assert.ok(runbook.includes('empty runner_name'));
  assert.ok(runbook.includes('no steps'));
  assert.ok(runbook.includes('no runner is assigned'));
});

test('the root cause remains explicitly unknown', () => {
  assert.ok(runbook.includes('Root cause | Unknown; administrator-side evidence required'));
  assert.ok(runbook.includes('not, by itself, a diagnosis'));
});

test('the administrator diagnostic checklist covers policy and quota', () => {
  assert.ok(runbook.includes('GitHub-hosted runner usage/concurrency limits'));
  assert.ok(runbook.includes('billing or quota restrictions'));
  assert.ok(runbook.includes('runner-group access'));
  assert.ok(runbook.includes('GitHub Status'));
});

test('the safe sequence requires refreshed run and job records', () => {
  assert.ok(runbook.includes('GET /repos/openbot1/open-bot/actions/runs/{run_id}'));
  assert.ok(runbook.includes('GET /repos/openbot1/open-bot/actions/runs/{run_id}/jobs'));
  assert.ok(runbook.includes('run attempt'));
  assert.ok(runbook.includes('exact head_sha'));
});

test('the runbook prohibits noisy or evidence-destroying workarounds', () => {
  assert.ok(runbook.includes('Do not mass-rerun, dispatch, or push empty commits.'));
  assert.ok(runbook.includes('Do not cancel queued runs'));
  assert.ok(runbook.includes('Do not treat a successful docs-only static guard'));
  assert.ok(runbook.includes('continue-on-error'));
});

test('remediation is gated on an evidenced cause', () => {
  assert.ok(runbook.includes('only after the cause is evidenced'));
  assert.ok(runbook.includes('runner-group authorization defect'));
  assert.ok(runbook.includes('service incident'));
});

test('the success packet requires exact-SHA matrix evidence', () => {
  assert.ok(runbook.includes('All six expected matrix jobs'));
  assert.ok(runbook.includes('exact candidate SHA'));
  assert.ok(runbook.includes('full-suite'));
  assert.ok(runbook.includes('platform-test results'));
});

test('skips and failures require explicit classification', () => {
  assert.ok(runbook.includes('Explicit classification of every skipped test'));
  assert.ok(runbook.includes('unexplained or release-critical skips remain HOLD'));
});

test('local metrics are labelled operator-reported only', () => {
  assert.ok(runbook.includes('operator-reported'));
  assert.ok(runbook.includes('1,527,941 tracked lines'));
  assert.ok(runbook.includes('12,914 pass / 0 fail / 3 skipped'));
  assert.ok(runbook.includes('not verified by this PR author'));
});

test('the authoring boundary states no execution occurred', () => {
  assert.ok(runbook.includes('GitHub-only authoring, no test/build/typecheck was run.'));
  assert.ok(runbook.includes('does not claim CI ran successfully'));
  assert.ok(runbook.includes('not presented as LAND-READY'));
});

test('the release owner retains the GO decision', () => {
  assert.ok(runbook.includes('accepted by the release owner'));
  assert.ok(runbook.includes('No GO decision is made by this slice.'));
});
