/**
 * Test v1.44 T3: MCP Apps render v2 — descriptor validation,
 * session lifecycle, action dispatch, registry (node:test, no network).
 *
 * Covers:
 *   - packages/core/src/mcp/appsRenderV2.ts
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-v144-t3-apps-render.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { declareAppTemplate, reviewAppTemplate } from '../packages/core/dist/mcp/appsV2.js';
import {
  AppRenderRegistry,
  AppRenderSession,
  AppRenderV2Error,
  describeRenderSession,
  flattenDescriptor,
  validateAppUiDescriptor,
} from '../packages/core/dist/mcp/appsRenderV2.js';

function makeTemplate(overrides = {}) {
  return declareAppTemplate({
    id: 'acme-card',
    serverName: 'acme',
    title: 'Acme card',
    allowedActions: ['tool-call', 'link-open', 'form-submit'],
    ...overrides,
  });
}

function makeDescriptor(overrides = {}) {
  return {
    version: 1,
    templateId: 'acme-card',
    root: {
      id: 'root',
      kind: 'container',
      children: [
        { id: 'title', kind: 'heading', text: 'Invoice' },
        { id: 'body', kind: 'text', text: 'Total: $42' },
        {
          id: 'pay',
          kind: 'button',
          text: 'Pay now',
          action: { kind: 'tool-call', toolName: 'pay_invoice', args: { amount: 42 } },
        },
        {
          id: 'docs',
          kind: 'button',
          text: 'Docs',
          action: { kind: 'link-open', href: 'https://docs.acme.example/pay' },
        },
        {
          id: 'form1',
          kind: 'form',
          action: { kind: 'form-submit', toolName: 'submit_note' },
          children: [
            { id: 'note', kind: 'input', name: 'note', text: 'Note', value: 'hello' },
          ],
        },
        { id: 'prog', kind: 'progress', progress: 0.5, progressLabel: 'Halfway' },
        { id: 'items', kind: 'list', items: ['a', 'b'] },
      ],
    },
    ...overrides,
  };
}

test('validate: a well-formed descriptor validates with node count', () => {
  const template = makeTemplate();
  const result = validateAppUiDescriptor(makeDescriptor(), template);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.nodeCount, 9);
  assert.equal(result.descriptor?.templateId, 'acme-card');
});

test('validate: wrong version, wrong templateId, non-object are rejected', () => {
  const template = makeTemplate();
  assert.equal(validateAppUiDescriptor({ version: 2, templateId: 'acme-card', root: {} }, template).valid, false);
  assert.equal(
    validateAppUiDescriptor(makeDescriptor({ templateId: 'other' }), template).valid,
    false,
  );
  assert.equal(validateAppUiDescriptor(null, template).valid, false);
  assert.equal(validateAppUiDescriptor('nope', template).valid, false);
});

test('validate: duplicate ids, unknown kind, bad image src, deep tree are rejected', () => {
  const template = makeTemplate();
  const dup = makeDescriptor();
  dup.root.children.push({ id: 'title', kind: 'text', text: 'dup' });
  assert.match(validateAppUiDescriptor(dup, template).errors.join(' '), /trùng/);

  const badKind = makeDescriptor();
  badKind.root.children.push({ id: 'weird', kind: 'video', text: 'x' });
  assert.equal(validateAppUiDescriptor(badKind, template).valid, false);

  const badImage = makeDescriptor();
  badImage.root.children.push({ id: 'pic', kind: 'image', src: 'http://evil.example/x.png' });
  assert.equal(validateAppUiDescriptor(badImage, template).valid, false);

  let deep = { id: 'leaf', kind: 'text', text: 'deep' };
  for (let i = 0; i < 10; i += 1) {
    deep = { id: `c${i}`, kind: 'container', children: [deep] };
  }
  const deepDesc = { version: 1, templateId: 'acme-card', root: deep };
  assert.equal(validateAppUiDescriptor(deepDesc, template).valid, false);
});

test('validate: action not in template allowedActions is rejected at declaration time', () => {
  const template = makeTemplate({ allowedActions: ['link-open'] });
  const result = validateAppUiDescriptor(makeDescriptor(), template);
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /tool-call/);
});

test('validate: tool-call without toolName, link-open without https href, bad select are rejected', () => {
  const template = makeTemplate();
  const noTool = makeDescriptor();
  noTool.root.children[2].action = { kind: 'tool-call' };
  assert.equal(validateAppUiDescriptor(noTool, template).valid, false);

  const badLink = makeDescriptor();
  badLink.root.children[3].action = { kind: 'link-open', href: 'javascript:alert(1)' };
  assert.equal(validateAppUiDescriptor(badLink, template).valid, false);

  const badSelect = makeDescriptor();
  badSelect.root.children.push({ id: 'sel', kind: 'select', name: 'choice', options: [] });
  assert.equal(validateAppUiDescriptor(badSelect, template).valid, false);

  const goodSelect = makeDescriptor();
  goodSelect.root.children.push({
    id: 'sel', kind: 'select', name: 'choice', value: 'a',
    options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
  });
  assert.equal(validateAppUiDescriptor(goodSelect, template).valid, true);
});

test('session: mount -> dispatch tool-call + form-submit (with input values) -> suspend/resume -> unmount', () => {
  const template = makeTemplate();
  const { descriptor } = validateAppUiDescriptor(makeDescriptor(), template);
  assert.ok(descriptor);
  const session = new AppRenderSession('s1', template, descriptor);
  assert.equal(session.state, 'mounting');
  session.mount();
  assert.equal(session.state, 'mounted');
  assert.equal(session.getInputs().note, 'hello');

  const pay = session.dispatchAction('pay');
  assert.equal(pay.ok, true);
  if (pay.ok) {
    assert.equal(pay.kind, 'tool-call');
    assert.equal(pay.toolName, 'pay_invoice');
    assert.deepEqual(pay.args, { amount: 42 });
  }

  session.setInput('note', 'updated');
  const submit = session.dispatchAction('form1');
  assert.equal(submit.ok, true);
  if (submit.ok) assert.deepEqual(submit.formValues, { note: 'updated' });

  const link = session.dispatchAction('docs');
  assert.equal(link.ok, true);
  if (link.ok) assert.equal(link.href, 'https://docs.acme.example/pay');

  session.suspend();
  assert.equal(session.state, 'suspended');
  const denied = session.dispatchAction('pay');
  assert.equal(denied.ok, false);
  assert.match(denied.ok === false ? denied.reason : '', /chưa sẵn sàng/);
  session.resume();
  assert.equal(session.state, 'mounted');

  const snap = session.snapshot();
  assert.equal(snap.actionCount, 3);
  assert.equal(snap.deniedCount, 1);
  assert.equal(snap.reviewWarning, true); // unreviewed template
  assert.match(describeRenderSession(session), /CHƯA REVIEW/);
  session.unmount();
  assert.equal(session.state, 'unmounted');
  assert.throws(() => session.mount(), AppRenderV2Error);
});

test('session: unknown node, action-less node, unknown input, bad transitions throw or deny', () => {
  const template = makeTemplate();
  const { descriptor } = validateAppUiDescriptor(makeDescriptor(), template);
  assert.ok(descriptor);
  const session = new AppRenderSession('s2', template, descriptor);
  session.mount();
  assert.equal(session.dispatchAction('nope').ok, false);
  assert.equal(session.dispatchAction('title').ok, false); // heading has no action
  assert.throws(() => session.setInput('ghost', 'x'), AppRenderV2Error);
  assert.throws(() => session.resume(), AppRenderV2Error); // only from suspended
  session.fail('boom');
  assert.equal(session.state, 'error');
  assert.equal(session.snapshot().error, 'boom');
  session.clearError();
  assert.equal(session.state, 'mounted');
});

test('session: rejected template flags reviewWarning; approved template does not', () => {
  const template = reviewAppTemplate(makeTemplate(), 'rejected', 'qa', { note: 'unsafe' });
  const { descriptor } = validateAppUiDescriptor(makeDescriptor(), template);
  assert.ok(descriptor);
  const session = new AppRenderSession('s3', template, descriptor);
  assert.equal(session.reviewWarning, true);
  assert.equal(session.nodeCount(), 9);
  assert.equal(session.getHistory().length, 0);

  const approved = reviewAppTemplate(makeTemplate(), 'approved', 'qa');
  const ok = validateAppUiDescriptor(makeDescriptor(), approved);
  assert.ok(ok.descriptor);
  const session2 = new AppRenderSession('s4', approved, ok.descriptor);
  assert.equal(session2.reviewWarning, false);
});

test('registry: create/list/remove/clear manage sessions', () => {
  const template = makeTemplate();
  const { descriptor } = validateAppUiDescriptor(makeDescriptor(), template);
  assert.ok(descriptor);
  const registry = new AppRenderRegistry();
  const a = registry.create(template, descriptor);
  const b = registry.create(template, descriptor);
  assert.equal(registry.size, 2);
  assert.equal(a.state, 'mounted');
  assert.notEqual(a.sessionId, b.sessionId);
  assert.equal(registry.listSnapshots().length, 2);
  assert.equal(registry.remove(a.sessionId), true);
  assert.equal(registry.remove(a.sessionId), false);
  assert.equal(registry.get(b.sessionId)?.sessionId, b.sessionId);
  registry.clear();
  assert.equal(registry.size, 0);
});

test('flattenDescriptor: depth-first order with depths', () => {
  const template = makeTemplate();
  const { descriptor } = validateAppUiDescriptor(makeDescriptor(), template);
  assert.ok(descriptor);
  const flat = flattenDescriptor(descriptor);
  assert.equal(flat.length, 9);
  assert.equal(flat[0]?.node.id, 'root');
  assert.equal(flat[0]?.depth, 0);
  assert.equal(flat[1]?.node.id, 'title');
  assert.equal(flat[1]?.depth, 1);
  assert.equal(flat[6]?.node.id, 'note');
  assert.equal(flat[6]?.depth, 2);
});
