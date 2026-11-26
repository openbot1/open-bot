import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const runbook = fs.readFileSync(
  path.join(process.cwd(), 'docs', 'EMERGENCY-SECURITY-PATCH-LANE.md'),
  'utf8',
);

test('pins the procedure to the reviewed remote main snapshot', () => {
  assert.match(runbook, /2d14cc1b73c3f9fecb4b92614c180fb15a404aec/);
  assert.match(runbook, /local-first desktop product/i);
  assert.match(runbook, /does not authorise feature work/i);
});

test('defines when a serious vulnerability activates the emergency lane', () => {
  assert.match(runbook, /Activate the emergency lane when a credible report/i);
  assert.match(runbook, /released version, release artifact, update path/i);
  assert.match(runbook, /waiting for the normal release cadence/i);
});

test('lists representative high-impact vulnerability classes', () => {
  for (const term of ['remote or local code execution', 'privilege-boundary bypass', 'private user data', 'malicious update or package substitution', 'compromised signing material']) {
    assert.ok(runbook.includes(term), 'missing activation example: ' + term);
  }
});

test('keeps the emergency patch security-only and minimal', () => {
  assert.match(runbook, /security-only and minimal/i);
  assert.match(runbook, /No unrelated refactoring, dependency refresh, feature work/i);
  assert.match(runbook, /opportunistic cleanup/i);
});

test('prohibits premature public disclosure and unsupported release claims', () => {
  assert.match(runbook, /Do not publish vulnerability details/i);
  assert.match(runbook, /unpatched implementation path/i);
  assert.match(runbook, /Do not claim a fix, affected-version range/i);
  assert.match(runbook, /until evidence for that exact claim exists/i);
});

test('defines private intake metadata, ownership and incident identity', () => {
  assert.match(runbook, /Receive the report through a private channel/i);
  assert.match(runbook, /receipt time in UTC/i);
  assert.match(runbook, /EMSEC-YYYY-NNN/);
  assert.match(runbook, /one incident owner and one independent technical reviewer/i);
});

test('minimises reporter evidence and forbids secret or user-data collection', () => {
  for (const term of ['live API keys', 'OAuth tokens', 'signing credentials', 'user databases', 'prompts', 'workspace archives']) {
    assert.ok(runbook.includes(term), 'missing sensitive-data restriction: ' + term);
  }
  assert.match(runbook, /minimum information needed/i);
});

test('prioritises urgent containment over perfect evidence', () => {
  assert.match(runbook, /do not delay revocation, disabling an unsafe path/i);
  assert.match(runbook, /pausing publication/i);
  assert.match(runbook, /Protect users first/i);
});

test('defines P0 through P3 severity criteria and lane decisions', () => {
  for (const priority of ['P0 / Critical', 'P1 / High', 'P2 / Moderate', 'P3 / Low']) {
    assert.ok(runbook.includes(priority), 'missing severity: ' + priority);
  }
  assert.match(runbook, /Lane decision and response/i);
});

test('does not present response targets as a contractual SLA', () => {
  assert.match(runbook, /proposed operating targets/i);
  assert.match(runbook, /not a contractual SLA or guarantee/i);
});

test('records confidence, assumptions and reassessment triggers', () => {
  assert.match(runbook, /CONFIRMED, PROBABLE or UNCONFIRMED/i);
  assert.match(runbook, /Unknown scope for a high-privilege/i);
  assert.match(runbook, /Reassess priority whenever new evidence changes/i);
});

test('requires exact affected version, tag, source SHA and platform scope', () => {
  assert.match(runbook, /exact released version, tag, source commit SHA/i);
  assert.match(runbook, /supported platforms\/architectures/i);
  assert.match(runbook, /artifact identifiers potentially affected/i);
});

test('requires a dedicated patch branch from a trusted release base', () => {
  assert.match(runbook, /smallest trusted release base/i);
  assert.match(runbook, /dedicated private or access-restricted patch branch/i);
  assert.match(runbook, /exact release\/source SHA/i);
  assert.match(runbook, /Do not silently depend on an unlanded PR/i);
});

test('keeps the patch minimal and requires a security-boundary explanation', () => {
  assert.match(runbook, /narrowest correction that closes the exploit path/i);
  assert.match(runbook, /threat-to-fix explanation/i);
  assert.match(runbook, /attacker preconditions/i);
  assert.match(runbook, /residual limitations/i);
});

test('requires a regression test with vulnerable and fixed behaviour', () => {
  assert.match(runbook, /Add a regression test that fails against the vulnerable behaviour/i);
  assert.match(runbook, /passes for the corrected behaviour/i);
  assert.match(runbook, /fail-before\/pass-after demonstration/i);
});

test('requires synthetic fixtures and forbids sensitive data in tests and logs', () => {
  assert.match(runbook, /Prefer synthetic fixtures and non-secret values/i);
  assert.match(runbook, /Do not place exploit strings, tokens/i);
  assert.match(runbook, /test names, comments or logs/i);
});

test('requires consistent version metadata and justified dependency changes', () => {
  assert.match(runbook, /Avoid broad dependency upgrades/i);
  assert.match(runbook, /pin the exact version/i);
  assert.match(runbook, /single-source\/version-sync process/i);
  assert.match(runbook, /Any out-of-scope change blocks the emergency patch/i);
});

test('requires verification on the exact candidate SHA', () => {
  assert.match(runbook, /exact candidate SHA/i);
  assert.match(runbook, /not on a nearby branch/i);
  assert.match(runbook, /tool versions, commands, exit status, timestamps/i);
});

test('requires focused regression, build, typecheck and full-suite gates', () => {
  assert.match(runbook, /Run focused regression tests first/i);
  assert.match(runbook, /required build and typecheck/i);
  assert.match(runbook, /full required test suite on the exact candidate SHA/i);
  assert.match(runbook, /Any failure blocks release/i);
});

test('treats skipped, queued or unavailable checks as non-passing', () => {
  assert.match(runbook, /a skip is not a pass/i);
  assert.match(runbook, /record NOT RUN/i);
  assert.match(runbook, /failed, queued, skipped or unavailable/i);
});

test('requires native platform, signing and artifact verification', () => {
  assert.match(runbook, /native platform\/package checks/i);
  assert.match(runbook, /exact artifact/i);
  assert.match(runbook, /certificate identity, notarisation\/Gatekeeper or Authenticode/i);
  assert.match(runbook, /independent reviewer/i);
});

test('supports an out-of-cycle release without weakening approval', () => {
  assert.match(runbook, /outside the normal release calendar/i);
  assert.match(runbook, /same source identity, artifact integrity and approval discipline/i);
  assert.match(runbook, /second-person release review/i);
});

test('requires artifact hash, tag and upload reconciliation', () => {
  assert.match(runbook, /byte size and SHA-256/i);
  assert.match(runbook, /release tag resolves to the approved source SHA/i);
  assert.match(runbook, /uploaded bytes match the locally verified artifact hashes/i);
});

test('does not promise automatic updater installation', () => {
  assert.match(runbook, /current updater\/distribution behaviour must be checked/i);
  assert.match(runbook, /must download and install the patch manually/i);
  assert.match(runbook, /Do not promise silent, automatic or forced in-app installation/i);
});

test('defines release stop conditions and forbids unverified artifacts', () => {
  assert.match(runbook, /Stop publication if any of the following applies/i);
  assert.match(runbook, /artifact hash differs from the verified build or upload/i);
  assert.match(runbook, /signing identity, certificate chain, notarisation, provenance/i);
});

test('defines rollback versus forward-fix without downgrading to a vulnerable version', () => {
  assert.match(runbook, /withdrawal\/rollback and a forward-fix/i);
  assert.match(runbook, /Do not automatically downgrade users to a vulnerable version/i);
  assert.match(runbook, /Preserve data/i);
});

test('specifies the required contents of a user-facing security notice', () => {
  for (const term of ['Product and version range confirmed affected', 'Fixed version and exact download\/release link', 'manually download\/install', 'Publication timestamp', 'next update time']) {
    assert.ok(runbook.includes(term), 'missing user-notice field: ' + term);
  }
});

test('requires private reporter updates and explicit consent for public credit', () => {
  assert.match(runbook, /Notify the reporter privately/i);
  assert.match(runbook, /Ask explicitly before publishing reporter identity or credit/i);
  assert.match(runbook, /Do not promise a bounty, legal safe harbour/i);
});

test('preserves restricted incident evidence with hashes and minimal data', () => {
  assert.match(runbook, /restricted incident and release record/i);
  assert.match(runbook, /capture time, byte size and SHA-256/i);
  assert.match(runbook, /Never store raw credentials, signing private keys/i);
});

test('defines closure conditions, residual-risk ownership and post-incident review', () => {
  assert.match(runbook, /Close the emergency lane only after/i);
  assert.match(runbook, /residual risk is assigned/i);
  assert.match(runbook, /independent reviewer approve closure/i);
  assert.match(runbook, /Post-incident review/i);
});

test('does not authorise bypassing controls or claim unsupported response capabilities', () => {
  assert.match(runbook, /does not establish a 24-hour response guarantee/i);
  assert.match(runbook, /automatic release capability/i);
  assert.match(runbook, /permission to bypass required release controls/i);
});
