import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const runbook = fs.readFileSync(
  path.join(process.cwd(), 'docs', 'CREDENTIAL-COMPROMISE-RESPONSE.md'),
  'utf8',
);

test('anchors the procedure to the reviewed local-first repository snapshot', () => {
  assert.match(runbook, /2d14cc1b73c3f9fecb4b92614c180fb15a404aec/);
  assert.match(runbook, /local-first architecture/i);
  assert.match(runbook, /do not introduce a hosted incident system/i);
});

test('defines activation signals and assigns an incident owner', () => {
  assert.match(runbook, /Activate this procedure when a credential/i);
  assert.match(runbook, /incident owner/i);
  assert.match(runbook, /CRED-YYYY-NNN/);
  assert.match(runbook, /discovery time/i);
});

test('prioritises containment and revocation over evidence perfection', () => {
  assert.match(runbook, /Do not wait for proof of successful abuse/i);
  assert.match(runbook, /Do not delay urgent revocation or containment/i);
  assert.match(runbook, /do not keep the old credential active/i);
});

test('defines P0 through P3 priorities and makes response targets non-contractual', () => {
  for (const priority of ['P0 / Critical', 'P1 / High', 'P2 / Moderate', 'P3 / Low']) {
    assert.ok(runbook.includes(priority), 'missing severity: ' + priority);
  }
  assert.match(runbook, /not guaranteed response times or a contractual SLA/i);
});

test('prohibits disclosure of live credentials and secret-bearing files', () => {
  for (const term of ['live or revoked secret', 'refresh token', 'private key', 'unredacted environment file']) {
    assert.ok(runbook.includes(term), 'missing secret-handling restriction: ' + term);
  }
  assert.match(runbook, /Never paste/i);
});

test('requires scope assessment across exposure, privileges and consumers', () => {
  for (const term of ['Exposure window', 'Privileges', 'Consumers', 'Impact', 'Dependencies', 'Recovery']) {
    assert.ok(runbook.includes(term), 'missing scope field: ' + term);
  }
  assert.match(runbook, /first and last observed use/i);
  assert.match(runbook, /Do not assume that a missing audit event proves there was no access/i);
});

test('checks shared and downstream credential reuse', () => {
  assert.match(runbook, /Check for credential reuse/i);
  assert.match(runbook, /distinct replacements per environment/i);
  assert.match(runbook, /rotate those downstream credentials too/i);
});

test('defines API key revocation, least-privilege replacement and consumer updates', () => {
  assert.match(runbook, /## 5\. API key response/);
  assert.match(runbook, /disable or delete the exposed key/i);
  assert.match(runbook, /minimum API scopes/i);
  assert.match(runbook, /approved OS credential store/i);
  assert.match(runbook, /old key is rejected/i);
});

test('distinguishes OAuth access tokens, refresh tokens and application grants', () => {
  assert.match(runbook, /access tokens, refresh tokens, device codes, client secrets/i);
  assert.match(runbook, /Revoke the entire compromised application grant/i);
  assert.match(runbook, /newly added redirect URIs/i);
  assert.match(runbook, /old access and refresh credentials are rejected/i);
});

test('covers GitHub PAT revocation and scope review', () => {
  assert.match(runbook, /fine-grained or classic personal access token/i);
  assert.match(runbook, /revoke the exposed token/i);
  assert.match(runbook, /minimum repositories and permissions/i);
});

test('covers GitHub Apps, deploy keys and webhook-secret rotation', () => {
  assert.match(runbook, /App private key is compromised/i);
  assert.match(runbook, /delete the compromised key/i);
  assert.match(runbook, /Never reuse the exposed private key/i);
  assert.match(runbook, /Webhook secret/i);
});

test('covers GitHub Actions secrets and self-hosted runner containment', () => {
  assert.match(runbook, /Actions secrets and environment secrets/i);
  assert.match(runbook, /pause compromised runners/i);
  assert.match(runbook, /rebuilt from a trusted image/i);
});

test('requires review of GitHub audit activity and release-related changes', () => {
  assert.match(runbook, /Review repository and organisation audit logs/i);
  assert.match(runbook, /branch-protection changes/i);
  assert.match(runbook, /package publication/i);
  assert.match(runbook, /unexpected API calls/i);
});

test('treats release-signing compromise as critical and pauses publication', () => {
  assert.match(runbook, /Treat possible compromise of a signing private key/i);
  assert.match(runbook, /as P0/i);
  assert.match(runbook, /pause signing and publication jobs/i);
});

test('protects signing keys and requires issuer coordination and replacement identity', () => {
  assert.match(runbook, /Never export or attach the private key/i);
  assert.match(runbook, /certificate authority, signing platform or provider/i);
  assert.match(runbook, /hardware-backed or managed signing/i);
  assert.match(runbook, /replacement signing identity/i);
});

test('keeps platform-specific signing claims conditional', () => {
  assert.match(runbook, /macOS Developer ID\/notarisation/i);
  assert.match(runbook, /Windows Authenticode/i);
  assert.match(runbook, /Linux signing mechanism such as cosign\/GPG if one is in use/i);
  assert.match(runbook, /Do not describe an unsigned artifact as signed/i);
});

test('defines safe sequencing for compromised credentials versus routine expiry', () => {
  assert.match(runbook, /For a compromised credential, revoke\/disable the old value first/i);
  assert.match(runbook, /do not preserve an overlap window/i);
  assert.match(runbook, /routine expiry rather than compromise/i);
});

test('requires dependent credentials and all consumers to be inventoried', () => {
  assert.match(runbook, /each known consumer/i);
  assert.match(runbook, /Dependent tokens, app grants, webhook secrets, deploy keys/i);
  assert.match(runbook, /no stale copy remains/i);
});

test('defines post-rotation rejection checks for the old credential', () => {
  assert.match(runbook, /Old credential rejection/i);
  assert.match(runbook, /provider's authoritative revoked status/i);
  assert.match(runbook, /Never paste the old value/i);
});

test('verifies the replacement through a harmless least-privilege operation', () => {
  assert.match(runbook, /New credential acceptance/i);
  assert.match(runbook, /minimal read-only or otherwise harmless operation/i);
  assert.match(runbook, /expected permission/i);
});

test('checks consumer recovery, audit activity and release signatures', () => {
  assert.match(runbook, /Consumer recovery/i);
  assert.match(runbook, /Provider-side review/i);
  assert.match(runbook, /Release-signing check/i);
  assert.match(runbook, /exact candidate artifact/i);
});

test('requires exact-SHA regression and full-suite release-gate evidence', () => {
  assert.match(runbook, /exact candidate SHA/i);
  assert.match(runbook, /focused tests and the required full-suite gate/i);
  assert.match(runbook, /native platform verification/i);
});

test('preserves minimal evidence with hashes and UTC timestamps', () => {
  assert.match(runbook, /UTC timeline/i);
  assert.match(runbook, /capture time, byte size and SHA-256/i);
  assert.match(runbook, /Keep the original immutable/i);
});

test('prohibits retaining raw secrets or unrelated end-user application data', () => {
  assert.match(runbook, /Never store raw API keys, OAuth tokens, PATs, private signing keys/i);
  assert.match(runbook, /Do not request or preserve application user databases/i);
  assert.match(runbook, /Vault files, prompts, conversations or workspace archives/i);
});

test('defines communication, user action and coordinated disclosure boundaries', () => {
  assert.match(runbook, /Notify users when their credential, account, data or update action may be affected/i);
  assert.match(runbook, /separate Security Intake and Coordinated Disclosure Runbook/i);
  assert.match(runbook, /state only verified impact/i);
});

test('requires closure evidence, residual-risk ownership and second review', () => {
  assert.match(runbook, /Close the incident only after recording/i);
  assert.match(runbook, /Residual risk/i);
  assert.match(runbook, /Owner and second-reviewer approval/i);
});

test('does not claim an existing SLA, staffing guarantee or automatic rotation system', () => {
  assert.match(runbook, /does not establish a contractual SLA/i);
  assert.match(runbook, /security-response staffing guarantee/i);
  assert.match(runbook, /automatic credential rotation/i);
});
