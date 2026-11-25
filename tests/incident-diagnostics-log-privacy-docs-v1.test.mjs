import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const runbook = fs.readFileSync(
  path.join(process.cwd(), 'docs', 'INCIDENT-DIAGNOSTICS-LOG-PRIVACY.md'),
  'utf8',
);

test('anchors the inventory to the reviewed source snapshot', () => {
  assert.match(runbook, /2d14cc1b73c3f9fecb4b92614c180fb15a404aec/);
  assert.match(runbook, /minimum confirmed inventory, not a claim/i);
});

test('sets non-negotiable secret and PII handling rules', () => {
  for (const term of ['OAuth access/refresh tokens', 'full environment dumps', 'raw tool arguments', 'sanitized copy']) {
    assert.ok(runbook.includes(term), `missing privacy rule: ${term}`);
  }
});

test('documents the opt-in local crash-report surface and its caps', () => {
  for (const term of ['default OFF', '<userData>/crash-reports/<id>.json', '2,000 chars', '8,000', 'mode `0600`', '50 reports or 5 MiB']) {
    assert.ok(runbook.includes(term), `missing crash-report contract: ${term}`);
  }
});

test('does not describe thread logs as conversation-free', () => {
  assert.match(runbook, /assistant text and result text may be retained/i);
  assert.match(runbook, /5 MiB per file and 50 MiB per thread/i);
  assert.match(runbook, /Tool-call records keep argument-key names, not argument values/i);
});

test('documents run-log payloads and default rotation limits', () => {
  for (const term of ['<userData>/run-logs/<runId>.jsonl', 'prompts, model response text', '8 MiB per file and 64 MiB per run', 'SHA-256 hash chain']) {
    assert.ok(runbook.includes(term), `missing run-log detail: ${term}`);
  }
});

test('states that event redaction markers do not erase original JSONL', () => {
  assert.match(runbook, /original JSONL event remains on disk/i);
  assert.match(runbook, /not secure deletion/i);
});

test('documents journal checkpoint sensitivity and retention behaviour', () => {
  for (const term of ['<journalDir>/<runId>.journal.jsonl', 'conversation messages', '20 newest finished journals', 'never prunes unfinished runs']) {
    assert.ok(runbook.includes(term), `missing journal handling: ${term}`);
  }
});

test('documents trace summary bounds and explicit file permissions', () => {
  assert.match(runbook, /<userData>\/traces\.jsonl/);
  assert.match(runbook, /500 chars/);
  assert.match(runbook, /100 finished traces/);
  assert.match(runbook, /appends and rewrite files use mode `0600`/);
});

test('documents hook log fields and bounded pruning', () => {
  assert.match(runbook, /<userData>\/hook-executions\.jsonl/);
  assert.match(runbook, /1,000,000 bytes and keeps the newest 1,000 lines/);
  assert.match(runbook, /Hook stdout\/stderr are deliberately not stored/i);
});

test('documents sandbox audit content and known-secret limitations', () => {
  assert.match(runbook, /<botDir>\/audit\/audit\.jsonl/);
  assert.match(runbook, /10 MiB or 100,000 entries/);
  assert.match(runbook, /Unknown\/unregistered secrets and PII are not guaranteed/i);
});

test('distinguishes aggregate egress telemetry from request data', () => {
  assert.match(runbook, /fixed context label/i);
  assert.match(runbook, /not URL, host, path, query or request\/response content/i);
});

test('does not overstate uniform permissions or global log policy', () => {
  assert.match(runbook, /depends on the parent directory, process umask and platform ACLs/i);
  assert.match(runbook, /No single severity-level, retention or export policy is established/i);
});

test('defines bounded severity levels and keeps DEBUG off by default', () => {
  for (const term of ['FATAL / ERROR', 'WARN', 'INFO', 'DEBUG', 'DEBUG must be OFF by default']) {
    assert.ok(runbook.includes(term), `missing severity policy: ${term}`);
  }
});

test('requires preservation and hashing of originals before analysis', () => {
  assert.match(runbook, /copy the relevant original files into a restricted incident directory/i);
  assert.match(runbook, /SHA-256/);
  assert.match(runbook, /Do not redact, truncate, rotate or reformat the only original/i);
});

test('requires manual review and sentinel checks for sanitized exports', () => {
  assert.match(runbook, /inspect every line and every attachment manually/i);
  assert.match(runbook, /search for sentinel values and known secret fragments/i);
  assert.match(runbook, /zero-match scan is necessary but not sufficient/i);
});

test('requires credential revocation and bounded evidence retention', () => {
  assert.match(runbook, /revoke or rotate it at its issuing provider/i);
  assert.match(runbook, /30 calendar days after incident closure/i);
  assert.match(runbook, /90 days or the shorter applicable project policy/i);
});

test('defines objective PASS and HOLD conditions without claiming total coverage', () => {
  assert.match(runbook, /\*\*PASS\*\*/);
  assert.match(runbook, /\*\*HOLD\*\*/);
  assert.match(runbook, /does not prove that every logger, plugin, worker, OS log or future code path has been audited/i);
});
