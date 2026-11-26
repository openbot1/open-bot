import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const runbook = fs.readFileSync(
  path.join(here, '..', 'docs', 'ops', 'CANDIDATE-EVIDENCE-CHECKLIST.md'),
  'utf8',
);

test('the checklist is explicitly HOLD and does not authorize release', () => {
  assert.match(runbook, /Decision: \*\*HOLD/);
  assert.match(runbook, /does not approve a candidate/);
  assert.match(runbook, /does not itself authorize GO/);
  assert.match(runbook, /not LAND-READY/);
});

test('each packet is bound to one immutable full candidate SHA', () => {
  assert.match(runbook, /full 40-character candidate commit SHA/);
  assert.match(runbook, /Never combine build, test, CI or artifact evidence/);
  assert.match(runbook, /full candidate SHA/);
});

test('candidate identity records source lineage and version metadata', () => {
  for (const field of ['Parent SHA', 'PR lineage', 'Source state', 'Version', 'Packet owner']) {
    assert.ok(runbook.includes(field));
  }
  assert.match(runbook, /clean-tree confirmation/);
});

test('the checklist requires explicit disposition for missing evidence', () => {
  assert.match(runbook, /NOT RUN/);
  assert.match(runbook, /BLOCKED/);
  assert.match(runbook, /NOT APPLICABLE/);
  assert.match(runbook, /MISSING/);
});

test('all four workspaces have build and typecheck evidence rows', () => {
  for (const workspace of ['@open-bot/core', '@open-bot/tools', '@open-bot/desktop', '@open-bot/cli']) {
    assert.ok(runbook.includes(workspace));
  }
  assert.match(runbook, /Build result/);
  assert.match(runbook, /Typecheck result/);
});

test('full suite evidence preserves exact counts and environment', () => {
  for (const field of ['Pass / fail / skipped', 'OS build', 'Node/npm versions', 'original complete runner summary']) {
    assert.ok(runbook.includes(field));
  }
  assert.match(runbook, /exact full-suite command/);
});

test('every skipped test requires an individual disposition', () => {
  assert.match(runbook, /every skip must be individually classified/);
  assert.match(runbook, /Unexplained, newly introduced or release-critical skips are HOLD/);
});

test('failures require preserved first run and full rerun on a new SHA', () => {
  assert.match(runbook, /preserve the failing run/);
  assert.match(runbook, /complete rerun on the new candidate SHA/);
  assert.match(runbook, /invalidates downstream evidence/);
});

test('CI manifest captures immutable run identity and attempt', () => {
  for (const field of ['workflow run ID', 'run attempt number', 'full `head_sha`', 'canonical run URL']) {
    assert.ok(runbook.includes(field));
  }
  assert.match(runbook, /exact candidate SHA/);
});

test('queued, pending and other incomplete CI states are not PASS', () => {
  assert.match(runbook, /queued/);
  assert.match(runbook, /pending/);
  assert.match(runbook, /cancelled/);
  assert.match(runbook, /missing, stale or failed/);
  assert.match(runbook, /not PASS/);
});

test('artifact manifest records size, SHA-256 and transfer identity', () => {
  for (const field of ['File size in bytes and SHA-256', 'Uploaded bytes', 'Downloaded bytes', 'byte-for-byte comparison']) {
    assert.ok(runbook.includes(field));
  }
  assert.match(runbook, /actual produced, uploaded and downloaded files/);
});

test('signing, notarization and attestation require real evidence', () => {
  assert.match(runbook, /Signature status/);
  assert.match(runbook, /Notarization/);
  assert.match(runbook, /Attestation/);
  assert.match(runbook, /mock, fixture or checklist/);
});

test('reviewer roles are explicit and independent', () => {
  for (const role of ['Candidate owner', 'Build/test operator', 'CI reviewer', 'Artifact reviewer', 'Platform reviewer', 'Release owner']) {
    assert.ok(runbook.includes(role));
  }
  assert.match(runbook, /reviewer identity/);
});

test('reviewers must verify the candidate SHA before approval', () => {
  assert.match(runbook, /reviewer must not approve evidence/);
  assert.match(runbook, /source SHA they have not checked/);
});

test('failure and exception register retains owner and closure evidence', () => {
  for (const field of ['First observed', 'Impact', 'Disposition', 'Follow-up', 'Revalidation', 'Closure']) {
    assert.ok(runbook.includes(field));
  }
  assert.match(runbook, /Do not delete or overwrite an earlier failure/);
});

test('exceptions are not PASS and require risk acceptance', () => {
  assert.match(runbook, /An exception is not a PASS/);
  assert.match(runbook, /compensating controls/);
  assert.match(runbook, /rollback plan/);
  assert.match(runbook, /release owner who accepts the residual risk/);
});

test('completeness checklist covers all required evidence categories', () => {
  for (const term of ['Candidate SHA', 'workspace build', 'Full suite', 'GitHub Actions', 'artifact', 'reviewer roles', 'Rollback owner']) {
    assert.ok(runbook.includes(term));
  }
  assert.match(runbook, /No unresolved FAIL/);
});

test('GO is reserved for the accountable release owner', () => {
  assert.match(runbook, /only the accountable release owner may record this/);
  assert.match(runbook, /same SHA/);
  assert.match(runbook, /retain HOLD/);
});

test('the evidence record template captures provenance and decision fields', () => {
  for (const field of ['Candidate SHA (full)', 'workflow run IDs', 'Per-artifact size and SHA-256', 'Reviewer decisions and timestamps', 'Release-owner decision and rationale']) {
    assert.ok(runbook.includes(field));
  }
});

test('the next phase slices are planned and not claimed as opened', () => {
  for (const slice of ['CI Unblock & Verification', 'Native Acceptance Evidence', 'GO Decision & Dossier Update']) {
    assert.ok(runbook.includes(slice));
  }
  assert.match(runbook, /planned and are not opened/);
});

