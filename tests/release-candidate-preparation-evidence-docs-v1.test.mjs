import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const runbook = fs.readFileSync(
  path.join(here, '..', 'docs', 'ops', 'RELEASE-CANDIDATE-PREPARATION-EVIDENCE.md'),
  'utf8',
);

test('candidate procedure remains an explicit HOLD, not a release approval', () => {
  assert.match(runbook, /Decision: \*\*HOLD/);
  assert.match(runbook, /Current HOLD decision/);
  assert.match(runbook, /Do not create or publish release artifacts/);
  assert.match(runbook, /not LAND-READY/);
});

test('GitHub main and operator-reported local snapshot are clearly separated', () => {
  assert.ok(runbook.includes('2d14cc1b73c3f9fecb4b92614c180fb15a404aec'));
  assert.ok(runbook.includes('8dc29d67'));
  assert.match(runbook, /Operator-reported local state — not independently verified here/);
  assert.match(runbook, /not visible in the GitHub remote branch/);
  assert.match(runbook, /not independently verified/);
});

test('operator-reported suite counts are attributed and not presented as this author result', () => {
  assert.ok(runbook.includes('12,914 pass / 0 fail / 3 skipped'));
  assert.match(runbook, /operator reports/);
  assert.match(runbook, /not been reproduced by this author/);
  assert.match(runbook, /not execution by this author/);
});

test('the timed-out snapshot push is pending and must wait for daytime approval', () => {
  assert.match(runbook, /three approval cards timed out/);
  assert.match(runbook, /no active approval card/);
  assert.match(runbook, /deferred until daytime/);
  assert.match(runbook, /Do not start the 19-PR landing sequence against a stale base/);
});

test('all five local landings are classified LANDED-LOCAL and PENDING-PUSH', () => {
  for (const pr of ['#42', '#43', '#48', '#51', '#52']) assert.ok(runbook.includes(pr));
  assert.match(runbook, /LANDED-LOCAL \/ PENDING-PUSH/);
  assert.match(runbook, /five local landings/);
});

test('the 19 remaining PRs are listed in the requested landing order', () => {
  const ordered = ['#53', '#54', '#55', '#56', '#57', '#58', '#59', '#60', '#61', '#62', '#38', '#39', '#40', '#44', '#45', '#46', '#47', '#49', '#50'];
  let previous = -1;
  for (const pr of ordered) {
    const at = runbook.indexOf(pr, runbook.indexOf('## 3. Remaining landing queue'));
    assert.ok(at > previous, `PR order incorrect: ${pr}`);
    previous = at;
  }
});

test('every remaining PR head prefix is present in the dossier', () => {
  for (const sha of ['8a1239e2', '064bf8c1', '2cf14e2b', '35cdce02', '2d14ddbf', '4369feba', '6e788fc4', '9c922cf3', 'b8ddfe80', 'a8d15187', 'e65bda54', '6ba8de83', 'be6cd645', 'eb5a9f3b', '73c0bfa0', 'ae065c71', '8dcaed5f', '817a4254', 'a665caf1']) {
    assert.ok(runbook.includes(sha), `missing PR head: ${sha}`);
  }
});

test('all 19 remaining PR rows explicitly remain PENDING-LAND', () => {
  const section = runbook.split('### 3.1 Operations')[1].split('### 3.4 Push snapshot')[0];
  assert.equal((section.match(/\| #\d+ \|/g) || []).length, 19);
  assert.equal((section.match(/PENDING-LAND/g) || []).length, 19);
});

test('candidate identity requires an immutable full SHA and clean tree', () => {
  assert.match(runbook, /40-character immutable SHA/);
  assert.match(runbook, /clean working tree/);
  assert.match(runbook, /Do not use a moving branch name as the sole candidate identity/);
});

test('dependency install and version metadata checks are required', () => {
  for (const command of ['npm ci', 'npm run version:sync', 'npm run version:check']) {
    assert.ok(runbook.includes(command));
  }
});

test('all four workspace builds are explicitly covered', () => {
  for (const workspace of ['@open-bot/core', '@open-bot/tools', '@open-bot/desktop', '@open-bot/cli']) {
    assert.ok(runbook.includes(workspace));
  }
  assert.match(runbook, /npm run build/);
  assert.match(runbook, /core → tools → desktop → CLI/);
});

test('all four workspace typechecks are explicitly covered', () => {
  assert.match(runbook, /npm run typecheck/);
  assert.match(runbook, /npm run typecheck --workspace=@open-bot\/core/);
  assert.match(runbook, /npm run typecheck --workspace=@open-bot\/tools/);
  assert.match(runbook, /npm run typecheck --workspace=@open-bot\/desktop/);
  assert.match(runbook, /npm run typecheck --workspace=@open-bot\/cli/);
});

test('full suite uses the OS-specific command and requires zero failures', () => {
  assert.match(runbook, /xvfb-run -a npm test/);
  assert.match(runbook, /Windows \/ macOS/);
  assert.match(runbook, /zero failed tests/);
  assert.match(runbook, /[Ee]xplain every skipped test/);
});

test('CI verification requires workflow run ID and exact candidate SHA', () => {
  assert.match(runbook, /workflow run ID/);
  assert.match(runbook, /full commit SHA/);
  assert.match(runbook, /Queued is not PASS/);
  assert.match(runbook, /queued, pending, cancelled, skipped, stale, missing or failed/);
});

test('artifact records require hashes, transfer comparison and signing evidence', () => {
  for (const term of ['SHA-256', 'byte-for-byte equality', 'signer identity', 'notarization', 'attestation']) {
    assert.ok(runbook.toLowerCase().includes(term.toLowerCase()));
  }
});

test('dossier does not claim actual signing or notarization occurred', () => {
  assert.match(runbook, /does not claim that signing or notarization has occurred/);
  assert.match(runbook, /mock signer/);
});

test('HOLD and GO criteria cover source, build, CI, artifacts and governance', () => {
  for (const gate of ['Source and push', 'Landing queue', 'Workspace build', 'Typecheck', 'Full suite', 'GitHub CI', 'Artifact integrity', 'Signing/provenance', 'Native acceptance', 'Governance']) {
    assert.ok(runbook.includes(gate), `missing gate: ${gate}`);
  }
  assert.match(runbook, /Overall GO requires every required row/);
});

test('the next four phase slices are listed without claiming they were opened', () => {
  for (const slice of ['Candidate Evidence Checklist', 'CI Unblock & Verification', 'Native Acceptance Evidence', 'GO Decision & Dossier Update']) {
    assert.ok(runbook.includes(slice));
  }
  assert.match(runbook, /planned, not opened in this cycle/);
});

test('the authoring boundary explicitly disclaims execution', () => {
  assert.match(runbook, /No test, build, typecheck, CI job/);
  assert.match(runbook, /No test\/build\/typecheck was run/);
});

test('evidence records capture provenance, environment, result and reviewer', () => {
  for (const field of ['Full candidate commit SHA', 'GitHub Actions workflow run ID', 'OS build / architecture', 'Exit code and original summary', 'Operator and independent reviewer', 'Artifact filename, size and SHA-256']) {
    assert.ok(runbook.includes(field), `missing evidence field: ${field}`);
  }
});

test('evidence handling excludes secrets and personal data', () => {
  assert.match(runbook, /Redact credentials, OAuth tokens, signing secrets/);
  assert.match(runbook, /Vault contents/);
});
