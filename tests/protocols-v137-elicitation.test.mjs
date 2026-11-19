/**
 * Protocols v6 — stable elicitation tests (v1.37, Team T2).
 *
 * Covers packages/core/src/protocolsV6/elicitationV6.ts:
 * form schema validation (all field kinds, required, ranges,
 * patterns, options, dates), sensitive-field refusal, submit /
 * cancel / expire, URL mode (https only, one-time callback
 * token, same schema validation), capability advertisement +
 * mode negotiation.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v137-elicitation.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ElicitationV6Manager,
  defaultElicitationV6Advertisement,
  negotiateElicitationV6Mode,
  validateElicitationV6Schema,
  validateElicitationV6Values,
} from '../packages/core/dist/index.js';

function makeIds() {
  let n = 0;
  return (prefix) => `${prefix}-test-${++n}`;
}

const FIELDS = [
  { id: 'name', label: 'Name', kind: 'text', required: true, minLength: 2, maxLength: 40 },
  { id: 'age', label: 'Age', kind: 'number', min: 0, max: 130 },
  { id: 'ok', label: 'Confirm', kind: 'boolean' },
  { id: 'color', label: 'Color', kind: 'select', options: [{ value: 'red', label: 'Red' }, { value: 'blue', label: 'Blue' }] },
  { id: 'tags', label: 'Tags', kind: 'multi-select', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
  { id: 'when', label: 'Date', kind: 'date' },
  { id: 'notes', label: 'Notes', kind: 'long-text', pattern: '^[A-Za-z ]*$' },
];

test('schema validation: valid schema passes, bad schemas are reported', () => {
  assert.deepEqual(validateElicitationV6Schema(FIELDS), []);
  const dup = validateElicitationV6Schema([
    { id: 'x', label: 'X', kind: 'text' },
    { id: 'x', label: 'X2', kind: 'text' },
  ]);
  assert.equal(dup.length, 1);
  assert.match(dup[0]?.reason ?? '', /Duplicate/);
  const noOptions = validateElicitationV6Schema([{ id: 's', label: 'S', kind: 'select' }]);
  assert.ok(noOptions.some((i) => i.reason.includes('at least one option')));
  const badRange = validateElicitationV6Schema([{ id: 'n', label: 'N', kind: 'number', min: 10, max: 5 }]);
  assert.ok(badRange.some((i) => i.reason.includes('min > max')));
  const badPattern = validateElicitationV6Schema([{ id: 't', label: 'T', kind: 'text', pattern: '[' }]);
  assert.ok(badPattern.some((i) => i.reason.includes('invalid regex')));
  const noLabel = validateElicitationV6Schema([{ id: 't', label: '  ', kind: 'text' }]);
  assert.ok(noLabel.some((i) => i.reason.includes('needs a label')));
});

test('sensitive fields are refused at schema level', () => {
  const password = validateElicitationV6Schema([{ id: 'pw', label: 'Password', kind: 'password' }]);
  assert.ok(password.some((i) => i.reason.includes('sensitive')));
  const flagged = validateElicitationV6Schema([{ id: 't', label: 'T', kind: 'text', sensitive: true }]);
  assert.ok(flagged.some((i) => i.reason.includes('sensitive')));
  const token = validateElicitationV6Schema([{ id: 't', label: 'T', kind: 'token' }]);
  assert.ok(token.some((i) => i.reason.includes('sensitive')));
});

test('value validation: every kind, required, ranges, patterns, options, dates', () => {
  const good = { name: 'Ada', age: 36, ok: true, color: 'red', tags: ['a', 'b'], when: '2026-11-18', notes: 'hello world' };
  assert.deepEqual(validateElicitationV6Values(FIELDS, good), []);
  const missing = validateElicitationV6Values(FIELDS, { age: 1 });
  assert.ok(missing.some((i) => i.fieldId === 'name' && i.reason.includes('required')));
  const short = validateElicitationV6Values(FIELDS, { name: 'A' });
  assert.ok(short.some((i) => i.reason.includes('at least 2')));
  const tooOld = validateElicitationV6Values(FIELDS, { name: 'Ada', age: 200 });
  assert.ok(tooOld.some((i) => i.reason.includes('at most 130')));
  const badColor = validateElicitationV6Values(FIELDS, { name: 'Ada', color: 'green' });
  assert.ok(badColor.some((i) => i.reason.includes('not one of its options')));
  const badTag = validateElicitationV6Values(FIELDS, { name: 'Ada', tags: ['z'] });
  assert.ok(badTag.some((i) => i.reason.includes('not one of its options')));
  const badDate = validateElicitationV6Values(FIELDS, { name: 'Ada', when: '2026-02-30' });
  assert.ok(badDate.some((i) => i.reason.includes('not a real calendar date')));
  const badNotes = validateElicitationV6Values(FIELDS, { name: 'Ada', notes: 'oops 123' });
  assert.ok(badNotes.some((i) => i.reason.includes('pattern')));
  const unknown = validateElicitationV6Values(FIELDS, { name: 'Ada', nope: 1 });
  assert.ok(unknown.some((i) => i.fieldId === 'nope' && i.reason.includes('Unknown field')));
  const wrongType = validateElicitationV6Values(FIELDS, { name: 'Ada', ok: 'yes' });
  assert.ok(wrongType.some((i) => i.reason.includes('must be a boolean')));
});

test('form mode: create, submit valid, submit invalid keeps it pending', () => {
  const manager = new ElicitationV6Manager({ generateId: makeIds() });
  const request = manager.create({
    sessionId: 's1',
    messageId: 'acp6-msg-test-1',
    mode: 'form',
    title: 'About you',
    fields: FIELDS,
  });
  assert.equal(request.status, 'pending');
  assert.equal(request.mode, 'form');
  assert.equal(request.messageId, 'acp6-msg-test-1');
  assert.equal(request.callbackToken, undefined);
  const bad = manager.submit(request.elicitationId, { name: 'A' });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.ok(bad.issues.length > 0);
  assert.equal(manager.get(request.elicitationId)?.status, 'pending');
  const good = manager.submit(request.elicitationId, { name: 'Ada', age: 36, color: 'blue', tags: ['a'], when: '2026-11-18' });
  assert.equal(good.ok, true);
  if (good.ok) {
    assert.equal(good.request.status, 'submitted');
    assert.equal(good.request.values?.['name'], 'Ada');
  }
  assert.throws(() => manager.submit(request.elicitationId, { name: 'Ada' }), /not pending/);
});

test('form mode: cancel, unknown ids, sensitive creation refused', () => {
  const manager = new ElicitationV6Manager({ generateId: makeIds() });
  const request = manager.create({ sessionId: 's1', mode: 'form', title: 'T', fields: [{ id: 'n', label: 'N', kind: 'text' }] });
  const cancelled = manager.cancel(request.elicitationId, 'user walked away');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancelReason, 'user walked away');
  assert.throws(() => manager.cancel(request.elicitationId), /not pending/);
  assert.equal(manager.get('nope'), undefined);
  assert.throws(() => manager.require('nope'), /Unknown elicitation/);
  assert.throws(
    () => manager.create({ sessionId: 's1', mode: 'form', title: 'T', fields: [{ id: 'pw', label: 'P', kind: 'password' }] }),
    /sensitive/,
  );
  assert.throws(
    () => manager.create({ sessionId: 's1', mode: 'form', title: 'T', fields: [] }),
    /at least one field/,
  );
});

test('expiry: overdue pending requests expire and cannot submit', () => {
  let now = 1000;
  const manager = new ElicitationV6Manager({ now: () => now, generateId: makeIds(), defaultTtlMs: 500 });
  const request = manager.create({ sessionId: 's1', mode: 'form', title: 'T', fields: [{ id: 'n', label: 'N', kind: 'text' }] });
  assert.equal(manager.expireOverdue(), 0);
  now = 2000;
  assert.equal(manager.expireOverdue(), 1);
  assert.equal(manager.get(request.elicitationId)?.status, 'expired');
  assert.throws(() => manager.submit(request.elicitationId, { n: 'x' }), /expired/);
  assert.equal(manager.summary().expired, 1);
});

test('URL mode: https only, one-time callback token, same schema validation', () => {
  const manager = new ElicitationV6Manager({ generateId: makeIds() });
  assert.throws(
    () => manager.create({ sessionId: 's1', mode: 'url', title: 'T', url: 'http://example.com/x', fields: [{ id: 'n', label: 'N', kind: 'text' }] }),
    /https/,
  );
  assert.throws(
    () => manager.create({ sessionId: 's1', mode: 'url', title: 'T', url: 'not-a-url', fields: [{ id: 'n', label: 'N', kind: 'text' }] }),
    /not a valid URL/,
  );
  const request = manager.create({
    sessionId: 's1',
    mode: 'url',
    title: 'Finish outside',
    url: 'https://example.com/flow',
    fields: [{ id: 'choice', label: 'Choice', kind: 'select', required: true, options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] }],
  });
  assert.equal(request.mode, 'url');
  assert.equal(request.url, 'https://example.com/flow');
  assert.match(request.callbackToken ?? '', /^elicit6-cb-test-/);
  const bad = manager.completeByCallback(request.callbackToken ?? '', { choice: 'maybe' });
  assert.equal(bad.ok, false);
  const good = manager.completeByCallback(request.callbackToken ?? '', { choice: 'yes' });
  assert.equal(good.ok, true);
  if (good.ok) assert.equal(good.request.status, 'submitted');
  // The token is single-use.
  assert.throws(() => manager.completeByCallback(request.callbackToken ?? 'used', { choice: 'yes' }), /Unknown or already-used/);
  assert.throws(() => manager.completeByCallback('no-such-token', {}), /Unknown or already-used/);
});

test('capability advertisement: negotiate picks the preference, form wins ties', () => {
  const advertised = defaultElicitationV6Advertisement();
  assert.deepEqual(advertised.modes, ['form', 'url']);
  assert.equal(advertised.maxFields, 20);
  assert.equal(negotiateElicitationV6Mode(advertised), 'form');
  assert.equal(negotiateElicitationV6Mode(advertised, 'url'), 'url');
  assert.equal(negotiateElicitationV6Mode({ modes: ['url'], maxFields: 5, canOpenExternalUrl: true }), 'url');
  assert.throws(() => negotiateElicitationV6Mode({ modes: [], maxFields: 5, canOpenExternalUrl: true }), /no elicitation mode/);
  assert.throws(() => negotiateElicitationV6Mode({ modes: ['form'], maxFields: 5, canOpenExternalUrl: false }, 'url'), /not advertised/);
  assert.throws(
    () => negotiateElicitationV6Mode({ modes: ['url'], maxFields: 5, canOpenExternalUrl: false }, 'url'),
    /cannot open an external URL/,
  );
});

test('too many fields for the client advertisement is refused', () => {
  const manager = new ElicitationV6Manager({ generateId: makeIds() });
  const fields = Array.from({ length: 3 }, (_, i) => ({ id: `f${i}`, label: `F${i}`, kind: 'text' }));
  assert.throws(
    () => manager.create({
      sessionId: 's1',
      mode: 'form',
      title: 'T',
      fields,
      advertised: { modes: ['form'], maxFields: 2, canOpenExternalUrl: false },
    }),
    /at most 2/,
  );
});

test('list / pending / summary', () => {
  const manager = new ElicitationV6Manager({ generateId: makeIds() });
  manager.create({ sessionId: 's1', mode: 'form', title: 'A', fields: [{ id: 'n', label: 'N', kind: 'text' }] });
  const second = manager.create({ sessionId: 's1', mode: 'form', title: 'B', fields: [{ id: 'n', label: 'N', kind: 'text' }] });
  manager.create({ sessionId: 's2', mode: 'form', title: 'C', fields: [{ id: 'n', label: 'N', kind: 'text' }] });
  manager.submit(second.elicitationId, { n: 'x' });
  assert.equal(manager.pendingForSession('s1').length, 1);
  assert.equal(manager.list({ sessionId: 's1' }).length, 2);
  assert.equal(manager.list({ status: 'submitted' }).length, 1);
  const summary = manager.summary();
  assert.deepEqual(summary, { total: 3, pending: 2, submitted: 1, cancelled: 0, expired: 0 });
});
