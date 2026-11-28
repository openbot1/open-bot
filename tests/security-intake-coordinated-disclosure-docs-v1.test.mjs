import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const runbook = fs.readFileSync(
  path.join(process.cwd(), 'docs', 'SECURITY-INTAKE-COORDINATED-DISCLOSURE.md'),
  'utf8',
);

test('anchors the intake policy to the reviewed repository snapshot', () => {
  assert.match(runbook, /2d14cc1b73c3f9fecb4b92614c180fb15a404aec/);
  assert.match(runbook, /local-first project/i);
});

test('does not invent a security email or claim an existing policy file', () => {
  assert.match(runbook, /no root or `.github\/SECURITY\.md`/);
  assert.match(runbook, /no `CONTRIBUTING\.md`/);
  assert.match(runbook, /no published security email/i);
  assert.match(runbook, /Do not invent or publish an email address/i);
});

test('defines conditional GitHub private reporting as the preferred channel', () => {
  assert.ok(runbook.includes('GitHub **Security** tab'));
  assert.match(runbook, /Private Vulnerability Reporting only when that private reporting feature is enabled/i);
  assert.match(runbook, /Confirm that the submission is private/i);
});

test('defines a safe fallback when private reporting is unavailable', () => {
  assert.match(runbook, /https:\/\/github\.com\/openbot1/);
  assert.match(runbook, /do not assume it exposes a private inbox or email/i);
  assert.match(runbook, /Security contact request/);
  assert.match(runbook, /A public issue is not a secure intake channel/i);
});

test('prohibits public disclosure of unpatched details and sensitive evidence', () => {
  for (const term of ['unpatched vulnerability', 'proof-of-concept', 'crash dump', 'exploit steps']) {
    assert.ok(runbook.includes(term), `missing public-disclosure restriction: ${term}`);
  }
});

test('defines authorised scope and non-destructive research boundaries', () => {
  assert.match(runbook, /systems and data they own or are explicitly authorised to assess/i);
  assert.match(runbook, /denial of service/i);
  assert.match(runbook, /Stop testing once impact is demonstrated/i);
  assert.match(runbook, /Do not promise legal safe-harbor protection/i);
});

test('requests a minimal report with version, SHA, platform and reproducibility', () => {
  for (const term of ['Product version', 'exact source commit SHA', 'OS/platform and architecture', 'Expected versus observed security impact', 'synthetic data', 'disclosure/embargo preference']) {
    assert.ok(runbook.includes(term), `missing intake field: ${term}`);
  }
});

test('prohibits collection of credentials and end-user application data', () => {
  for (const term of ['API keys', 'OAuth tokens', 'real prompts/conversations', 'user databases', 'customer information', 'workspace archives']) {
    assert.ok(runbook.includes(term), `missing data-minimisation restriction: ${term}`);
  }
});

test('requires case ID, private ownership and acknowledgement target', () => {
  assert.match(runbook, /SEC-YYYY-NNN/);
  assert.ok(runbook.includes('within **2 business days**'));
  assert.match(runbook, /one maintainer as case owner/i);
  assert.match(runbook, /do not mirror the report into a public issue/i);
});

test('defines an initial triage target and explicit severity priorities', () => {
  assert.ok(runbook.includes('within **5 business days**'));
  for (const priority of ['P0 / Critical', 'P1 / High', 'P2 / Moderate', 'P3 / Low']) {
    assert.ok(runbook.includes(priority), `missing severity: ${priority}`);
  }
  assert.match(runbook, /UNCONFIRMED/);
});

test('includes proposed remediation targets for each severity', () => {
  for (const term of ['within 7 calendar days', 'within 14 calendar days', 'within 30 calendar days', 'within 90 calendar days']) {
    assert.ok(runbook.includes(term), `missing remediation target: ${term}`);
  }
  assert.match(runbook, /not an existing contractual SLA/i);
});

test('defines the default coordinated disclosure window and status cadence', () => {
  assert.match(runbook, /90 calendar days from the initial private report/);
  assert.ok(runbook.includes('every **7 calendar days**'));
  assert.ok(runbook.includes("at least **14 calendar days' notice**"));
  assert.match(runbook, /do not silently extend an embargo indefinitely/i);
});

test('prioritises containment over embargo during active exploitation', () => {
  assert.match(runbook, /Do not delay urgent containment to preserve an embargo/i);
  assert.match(runbook, /active exploitation or imminent harm/i);
});

test('requires restricted local evidence handling and minimal collection', () => {
  assert.match(runbook, /restricted case record under maintainer-controlled local storage/i);
  assert.match(runbook, /No external case-management, analytics, telemetry or evidence-upload service is required/i);
  assert.match(runbook, /Use synthetic fixtures wherever possible/i);
  assert.match(runbook, /Keep originals unchanged; analyse copies/i);
});

test('requires exact-SHA remediation and regression evidence', () => {
  assert.match(runbook, /affected and fixed source SHAs/i);
  assert.match(runbook, /focused regression tests and the required full-suite gate/i);
  assert.match(runbook, /rebuild and verify the exact affected artifacts/i);
});

test('provides acknowledgement, status and public advisory templates', () => {
  for (const term of ['Receipt acknowledgement', 'Progress update', 'Public security advisory / release note', 'Next update target', 'Acknowledgement:']) {
    assert.ok(runbook.includes(term), `missing communication template field: ${term}`);
  }
});

test('requires explicit reporter consent for public credit', () => {
  assert.match(runbook, /Ask explicitly whether the reporter wants public credit/i);
  assert.match(runbook, /obtain consent before publication/i);
  assert.match(runbook, /No payment, bounty or guaranteed recognition is promised/i);
});

test('defines the response when a reporter discloses before the agreed date', () => {
  assert.match(runbook, /If the reporter discloses publicly before the agreed date/i);
  assert.match(runbook, /Do not reprimand, threaten or expose the reporter/i);
  assert.match(runbook, /Reassess severity and urgency immediately/i);
  assert.match(runbook, /A public disclosure changes the risk and communications plan/i);
});

test('defines closure evidence and avoids unsupported program claims', () => {
  assert.match(runbook, /Closure checklist/);
  assert.match(runbook, /final disposition and severity/i);
  assert.match(runbook, /does not establish a published security contact/i);
  assert.match(runbook, /legal safe harbor, bounty program, contractual SLA or automatic vulnerability intake system/i);
});
