/**
 * Composio v129 tests — per-conversation sandbox + app bindings
 * (v1.29, Doi T4 — node:test, no network, no key, mock-only).
 *
 * Covers packages/core/src/composio/sandboxV129.ts +
 * appBindingsV129.ts:
 * - Sandbox create: defaults, custom limits, validation, audit
 *   entry, deterministic id
 * - Admit (fail-closed, in order): expired -> toolkit denied/not
 *   allowed -> write disallowed -> call quota -> concurrent jobs
 *   -> poll quota -> result-bytes estimate
 * - Record: call/job-submit/poll usage moves, denial counted +
 *   audited, job finish frees a concurrent slot, audit capped
 * - Summary: headroom math, expiry, audit tail
 * - Checkpoint serialize/parse + store snapshot/restore, one
 *   boundary per conversation (replace on re-create)
 * - Bindings: create validation (empty scopes, unknown default
 *   params rejected), scope rule (write needs write, read covered
 *   by write), check with conversation binding vs machine default
 *   (fail-closed when neither), effective apps list, param merge
 *   order (call > binding > tool default)
 * - Binding store: bind upsert keeps createdAt, unbind/enable/
 *   disable, audit, snapshot/restore
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/composio-v129-sandbox.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MemoryComposioV129SandboxStore,
  admitComposioV129SandboxCall,
  composioV129SandboxId,
  createComposioV129SandboxBoundary,
  filterComposioV129SandboxAudit,
  isComposioV129SandboxExpired,
  isComposioV129ToolkitAllowed,
  parseComposioV129SandboxBoundary,
  recordComposioV129SandboxCall,
  recordComposioV129SandboxDenial,
  recordComposioV129SandboxJobFinished,
  resolveComposioV129SandboxLimits,
  serializeComposioV129SandboxBoundary,
  summarizeComposioV129Sandbox,
  validateComposioV129SandboxLimits,
} from '../packages/core/dist/composio/sandboxV129.js';
import {
  MemoryComposioV129BindingStore,
  checkComposioV129AppBinding,
  composioV129ScopeForSlug,
  composioV129ScopesCover,
  createComposioV129AppBinding,
  defaultComposioV129MachineBindings,
  listComposioV129EffectiveApps,
  resolveComposioV129EffectiveParams,
  summarizeComposioV129Bindings,
  validateComposioV129BindingDefaultParams,
} from '../packages/core/dist/composio/appBindingsV129.js';

const NOW = 1780000000000;

function makeSandbox(over = {}, nowMs = NOW) {
  return createComposioV129SandboxBoundary({ conversationId: 'conv-1', ...over }, nowMs);
}

test('sandbox: create defaults + custom limits + validation', () => {
  const b = makeSandbox();
  assert.equal(b.conversationId, 'conv-1');
  assert.deepEqual(b.allowedToolkits, []);
  assert.deepEqual(b.deniedToolkits, []);
  assert.equal(b.limits.maxCalls, 200);
  assert.equal(b.limits.maxConcurrentJobs, 5);
  assert.equal(b.limits.maxTotalResultBytes, 1000000);
  assert.equal(b.limits.maxPolls, 1000);
  assert.equal(b.limits.maxWallMs, 30 * 60 * 1000);
  assert.equal(b.limits.allowWrite, false);
  assert.equal(b.usage.calls, 0);
  assert.equal(b.audit.length, 1);
  assert.equal(b.audit[0].action, 'boundary-created');
  assert.equal(b.id, composioV129SandboxId(`conv-1:${NOW}`));
  const custom = makeSandbox({ allowedToolkits: ['smartsheet'], limits: { maxCalls: 3, allowWrite: true } });
  assert.deepEqual(custom.allowedToolkits, ['smartsheet']);
  assert.equal(custom.limits.maxCalls, 3);
  assert.equal(custom.limits.allowWrite, true);
  assert.equal(custom.limits.maxPolls, 1000); // untouched limits keep defaults
  assert.throws(() => makeSandbox({ conversationId: '' }), /conversationId/);
  assert.throws(() => makeSandbox({ limits: { maxCalls: -1 } }), /maxCalls/);
  assert.throws(() => makeSandbox({ limits: { maxWallMs: 0 } }), /maxWallMs/);
  assert.deepEqual(validateComposioV129SandboxLimits({}), []);
  assert.deepEqual(resolveComposioV129SandboxLimits({ maxCalls: 1 }).maxCalls, 1);
});

test('sandbox: toolkit allow/deny (deny beats allow)', () => {
  const open = makeSandbox();
  assert.equal(isComposioV129ToolkitAllowed(open, 'anything'), true);
  const scoped = makeSandbox({ allowedToolkits: ['smartsheet', 'klaviyo'], deniedToolkits: ['klaviyo'] });
  assert.equal(isComposioV129ToolkitAllowed(scoped, 'smartsheet'), true);
  assert.equal(isComposioV129ToolkitAllowed(scoped, 'klaviyo'), false); // denied wins
  assert.equal(isComposioV129ToolkitAllowed(scoped, 'onedrive'), false); // not in allowlist
});

test('sandbox: admit is fail-closed, in order', () => {
  // Expired first.
  const expired = makeSandbox({}, NOW - 31 * 60 * 1000);
  assert.equal(isComposioV129SandboxExpired(expired, NOW), true);
  assert.deepEqual(admitComposioV129SandboxCall(expired, { toolkit: 'smartsheet', slug: 'SMARTSHEET_LIST_ROWS', kind: 'call' }, NOW).allowed, false);
  assert.match(
    admitComposioV129SandboxCall(expired, { toolkit: 'smartsheet', slug: 'SMARTSHEET_LIST_ROWS', kind: 'call' }, NOW).reason,
    /expired/,
  );
  assert.equal(isComposioV129SandboxExpired(makeSandbox(), NOW + 29 * 60 * 1000), false);

  // Toolkit not allowed.
  const scoped = makeSandbox({ allowedToolkits: ['smartsheet'] });
  const deniedToolkit = admitComposioV129SandboxCall(scoped, { toolkit: 'klaviyo', slug: 'KLAVIYO_LIST_LISTS', kind: 'call' }, NOW);
  assert.equal(deniedToolkit.allowed, false);
  assert.match(deniedToolkit.reason, /not allowed/);

  // Write tool with allowWrite=false.
  const noWrite = makeSandbox();
  const deniedWrite = admitComposioV129SandboxCall(noWrite, { toolkit: 'smartsheet', slug: 'SMARTSHEET_CREATE_ROW', kind: 'call' }, NOW);
  assert.equal(deniedWrite.allowed, false);
  assert.match(deniedWrite.reason, /allowWrite=false/);
  const withWrite = makeSandbox({ limits: { allowWrite: true } });
  assert.equal(admitComposioV129SandboxCall(withWrite, { toolkit: 'smartsheet', slug: 'SMARTSHEET_CREATE_ROW', kind: 'call' }, NOW).allowed, true);

  // Call quota.
  const tiny = makeSandbox({ limits: { maxCalls: 1 } });
  const afterOne = recordComposioV129SandboxCall(tiny, { toolkit: 'smartsheet', slug: 'SMARTSHEET_LIST_ROWS', kind: 'call' }, 100, NOW);
  assert.equal(afterOne.usage.calls, 1);
  const overCalls = admitComposioV129SandboxCall(afterOne, { toolkit: 'smartsheet', slug: 'SMARTSHEET_LIST_ROWS', kind: 'call' }, NOW);
  assert.equal(overCalls.allowed, false);
  assert.match(overCalls.reason, /Call quota/);
  // Polls do not consume the call quota, but have their own.
  assert.equal(admitComposioV129SandboxCall(afterOne, { toolkit: 'smartsheet', slug: 'SMARTSHEET_LIST_ROWS', kind: 'poll' }, NOW).allowed, true);

  // Concurrent jobs.
  const oneJob = makeSandbox({ limits: { maxConcurrentJobs: 1, allowWrite: true } });
  const withJob = recordComposioV129SandboxCall(oneJob, { toolkit: 'smartsheet', slug: 'SMARTSHEET_LIST_ROWS', kind: 'job-submit' }, 0, NOW);
  assert.equal(withJob.usage.jobsRunning, 1);
  assert.equal(withJob.usage.jobsSubmitted, 1);
  const secondJob = admitComposioV129SandboxCall(withJob, { toolkit: 'smartsheet', slug: 'SMARTSHEET_LIST_ROWS', kind: 'job-submit' }, NOW);
  assert.equal(secondJob.allowed, false);
  assert.match(secondJob.reason, /Concurrent job limit/);

  // Poll quota.
  const fewPolls = makeSandbox({ limits: { maxPolls: 1 } });
  const polled = recordComposioV129SandboxCall(fewPolls, { toolkit: 'smartsheet', slug: 'SMARTSHEET_LIST_ROWS', kind: 'poll' }, 0, NOW);
  assert.equal(polled.usage.polls, 1);
  assert.equal(admitComposioV129SandboxCall(polled, { toolkit: 'smartsheet', slug: 'SMARTSHEET_LIST_ROWS', kind: 'poll' }, NOW).allowed, false);

  // Result-bytes estimate.
  const smallBytes = makeSandbox({ limits: { maxTotalResultBytes: 100 } });
  const tooBig = admitComposioV129SandboxCall(smallBytes, { toolkit: 'smartsheet', slug: 'SMARTSHEET_LIST_ROWS', kind: 'call', bytesEstimate: 101 }, NOW);
  assert.equal(tooBig.allowed, false);
  assert.match(tooBig.reason, /Result size limit/);
  assert.equal(admitComposioV129SandboxCall(smallBytes, { toolkit: 'smartsheet', slug: 'SMARTSHEET_LIST_ROWS', kind: 'call', bytesEstimate: 100 }, NOW).allowed, true);
});

test('sandbox: record denial + job finish frees a slot + audit capped', () => {
  let b = makeSandbox({ limits: { maxConcurrentJobs: 1 } });
  b = recordComposioV129SandboxCall(b, { toolkit: 'smartsheet', slug: 'SMARTSHEET_LIST_ROWS', kind: 'job-submit' }, 0, NOW);
  b = recordComposioV129SandboxDenial(b, { toolkit: 'klaviyo', slug: 'KLAVIYO_LIST_LISTS', kind: 'call' }, 'toolkit denied', NOW + 1);
  assert.equal(b.usage.deniedCalls, 1);
  assert.equal(b.audit[b.audit.length - 1].action, 'call-denied');
  assert.equal(b.audit[b.audit.length - 1].outcome, 'denied');
  b = recordComposioV129SandboxJobFinished(b, 'job-1', 'done', NOW + 2);
  assert.equal(b.usage.jobsRunning, 0);
  assert.equal(b.usage.jobsFinished, 1);
  assert.equal(b.audit[b.audit.length - 1].action, 'job-finished');
  // Audit filter.
  assert.equal(filterComposioV129SandboxAudit(b, 'call-denied').length, 1);
  assert.equal(filterComposioV129SandboxAudit(b).length, b.audit.length);
  // Summary headroom.
  const summary = summarizeComposioV129Sandbox(b, NOW + 2);
  assert.equal(summary.expired, false);
  assert.equal(summary.headroom.callsLeft, 199); // job-submit consumes one call slot
  assert.equal(summary.headroom.concurrentJobsLeft, 1);
  assert.equal(summary.auditTotal, b.audit.length);
  assert.equal(summary.auditTail.length, 4);
});

test('sandbox: checkpoint + store snapshot, one boundary per conversation', () => {
  const b = makeSandbox();
  const parsed = parseComposioV129SandboxBoundary(serializeComposioV129SandboxBoundary(b));
  assert.deepEqual(parsed, b);
  assert.throws(() => parseComposioV129SandboxBoundary('{"version":9,"boundary":{}}'), /Unsupported/);
  assert.throws(() => parseComposioV129SandboxBoundary('nope'), /not JSON/);
  const store = new MemoryComposioV129SandboxStore();
  store.create({ conversationId: 'c1', allowedToolkits: ['smartsheet'] }, NOW);
  assert.equal(store.size(), 1);
  assert.equal(store.getByConversation('c1').allowedToolkits[0], 'smartsheet');
  // Re-create replaces the old boundary for the same conversation.
  const replaced = store.create({ conversationId: 'c1', allowedToolkits: ['klaviyo'] }, NOW + 1);
  assert.equal(store.size(), 1);
  assert.equal(store.getByConversation('c1').id, replaced.id);
  assert.equal(store.getById('nope'), undefined);
  assert.throws(() => store.save(makeSandbox({ conversationId: 'ghost' })), /Unknown.*sandbox/);
  const snap = store.snapshot();
  const store2 = new MemoryComposioV129SandboxStore();
  store2.restore(snap);
  assert.equal(store2.getByConversation('c1').allowedToolkits[0], 'klaviyo');
  assert.equal(store.removeByConversation('c1'), true);
  assert.equal(store.removeByConversation('c1'), false);
  assert.throws(() => store2.restore('{"version":9,"boundaries":[]}'), /Unsupported/);
});

test('bindings: scope rule + create validation', () => {
  assert.equal(composioV129ScopeForSlug('SMARTSHEET_LIST_ROWS'), 'read');
  assert.equal(composioV129ScopeForSlug('SMARTSHEET_CREATE_ROW'), 'write');
  assert.equal(composioV129ScopesCover(['read'], 'read'), true);
  assert.equal(composioV129ScopesCover(['read'], 'write'), false);
  assert.equal(composioV129ScopesCover(['write'], 'read'), true); // write covers read
  assert.equal(composioV129ScopesCover(['write'], 'write'), true);
  assert.equal(composioV129ScopesCover([], 'read'), false);
  // Unknown default params rejected for v129 toolkits.
  assert.deepEqual(validateComposioV129BindingDefaultParams('smartsheet', { limit: 5 }), []);
  assert.deepEqual(validateComposioV129BindingDefaultParams('smartsheet', { bogus: 1 }), ['bogus']);
  // Non-v129 toolkits are not checked (no param table for them).
  assert.deepEqual(validateComposioV129BindingDefaultParams('gmail', { anything: 1 }), []);
  assert.throws(
    () => createComposioV129AppBinding({ conversationId: 'c1', toolkit: 'smartsheet', defaultParams: { bogus: 1 } }, NOW),
    /unknown params/,
  );
  assert.throws(() => createComposioV129AppBinding({ conversationId: '', toolkit: 't' }, NOW), /conversationId/);
  assert.throws(() => createComposioV129AppBinding({ conversationId: 'c1', toolkit: 't', scopes: [] }, NOW), /scopes/);
  assert.throws(() => createComposioV129AppBinding({ conversationId: 'c1', toolkit: 't', scopes: ['admin'] }, NOW), /scopes/);
  const binding = createComposioV129AppBinding({ conversationId: 'c1', toolkit: 'klaviyo', scopes: ['read', 'write'] }, NOW);
  assert.equal(binding.enabled, true);
  assert.equal(binding.id, 'bind-v129-c1:klaviyo');
});

test('bindings: check — conversation binding beats machine default, fail-closed', () => {
  const machineDefaults = defaultComposioV129MachineBindings(NOW);
  assert.equal(machineDefaults.length, 4);
  assert.ok(machineDefaults.every((b) => b.scopes.join() === 'read'));
  // No binding anywhere -> denied.
  const noBinding = checkComposioV129AppBinding([], 'c1', 'gmail', 'GMAIL_LIST_MESSAGES', []);
  assert.equal(noBinding.allowed, false);
  assert.match(noBinding.reason, /not bound/);
  // Machine default covers read for v129 mock toolkits.
  const viaDefault = checkComposioV129AppBinding([], 'c1', 'smartsheet', 'SMARTSHEET_LIST_ROWS', machineDefaults);
  assert.equal(viaDefault.allowed, true);
  assert.equal(viaDefault.binding.conversationId, '*');
  // Machine default does NOT cover write.
  const writeViaDefault = checkComposioV129AppBinding([], 'c1', 'smartsheet', 'SMARTSHEET_CREATE_ROW', machineDefaults);
  assert.equal(writeViaDefault.allowed, false);
  assert.match(writeViaDefault.reason, /lacks 'write' scope/);
  // Conversation binding with write covers it.
  const convBinding = createComposioV129AppBinding({ conversationId: 'c1', toolkit: 'smartsheet', scopes: ['write'] }, NOW);
  const viaConv = checkComposioV129AppBinding([convBinding], 'c1', 'smartsheet', 'SMARTSHEET_CREATE_ROW', machineDefaults);
  assert.equal(viaConv.allowed, true);
  assert.equal(viaConv.binding.conversationId, 'c1');
  // Disabled conversation binding denies even reads.
  const disabled = { ...convBinding, enabled: false };
  const deniedDisabled = checkComposioV129AppBinding([disabled], 'c1', 'smartsheet', 'SMARTSHEET_LIST_ROWS', machineDefaults);
  assert.equal(deniedDisabled.allowed, false);
  assert.match(deniedDisabled.reason, /disabled/);
  // A binding for another conversation does not apply.
  const other = checkComposioV129AppBinding([convBinding], 'c2', 'smartsheet', 'SMARTSHEET_CREATE_ROW', machineDefaults);
  assert.equal(other.allowed, false);
});

test('bindings: effective apps + param merge order + summary', () => {
  const machineDefaults = defaultComposioV129MachineBindings(NOW);
  const convBinding = createComposioV129AppBinding({ conversationId: 'c1', toolkit: 'smartsheet', scopes: ['write'] }, NOW);
  const effective = listComposioV129EffectiveApps([convBinding], 'c1', machineDefaults);
  assert.equal(effective.length, 4);
  const smart = effective.find((e) => e.toolkit === 'smartsheet');
  assert.equal(smart.source, 'conversation');
  assert.deepEqual(smart.scopes, ['write']);
  const klaviyo = effective.find((e) => e.toolkit === 'klaviyo');
  assert.equal(klaviyo.source, 'machine-default');
  // Param merge: call > binding > tool default.
  const merged = resolveComposioV129EffectiveParams(
    { limit: 3 },
    { limit: 10, listId: 'l1' },
    { limit: 50, status: 'open' },
  );
  assert.deepEqual(merged, { limit: 3, listId: 'l1', status: 'open' });
  const summary = summarizeComposioV129Bindings([convBinding, { ...convBinding, conversationId: 'c2', enabled: false }]);
  assert.equal(summary.total, 2);
  assert.equal(summary.enabled, 1);
  assert.equal(summary.disabled, 1);
  assert.deepEqual(summary.conversations, ['c1', 'c2']);
});

test('bindings: store bind upsert/unbind/enable/snapshot', () => {
  const store = new MemoryComposioV129BindingStore();
  const first = store.bind({ conversationId: 'c1', toolkit: 'smartsheet', scopes: ['read'] }, NOW);
  assert.equal(store.size(), 1);
  assert.equal(store.get('c1', 'smartsheet').scopes.join(), 'read');
  // Upsert keeps createdAt + id, updates scopes.
  const second = store.bind({ conversationId: 'c1', toolkit: 'smartsheet', scopes: ['read', 'write'] }, NOW + 1000);
  assert.equal(second.createdAtMs, first.createdAtMs);
  assert.equal(second.id, first.id);
  assert.deepEqual(second.scopes, ['read', 'write']);
  assert.equal(store.size(), 1);
  const disabled = store.setEnabled('c1', 'smartsheet', false, NOW + 2000);
  assert.equal(disabled.enabled, false);
  assert.equal(store.setEnabled('c1', 'nope', true, NOW), undefined);
  assert.equal(store.check('c1', 'smartsheet', 'SMARTSHEET_LIST_ROWS').allowed, false);
  assert.equal(store.listForConversation('c1').length, 1);
  assert.equal(store.auditLog().length, 3); // bound, scopes-changed, disabled
  assert.equal(store.auditLog()[0].action, 'bound');
  assert.equal(store.unbind('c1', 'smartsheet', NOW + 3000), true);
  assert.equal(store.unbind('c1', 'smartsheet', NOW + 3000), false);
  assert.equal(store.size(), 0);
  store.bind({ conversationId: 'c1', toolkit: 'klaviyo' }, NOW);
  const snap = store.snapshot();
  const store2 = new MemoryComposioV129BindingStore();
  store2.restore(snap);
  assert.equal(store2.size(), 1);
  assert.equal(store2.get('c1', 'klaviyo').toolkit, 'klaviyo');
  assert.throws(() => store2.restore('{"version":9,"bindings":[]}'), /Unsupported/);
  assert.equal(store.summary().total, 1);
});
