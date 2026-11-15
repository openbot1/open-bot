/**
 * Test v1.06 T2: MRTR elicitation handler (node:test).
 * Local only: fake prompt / URL opener / tracker, no network.
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-v106-mrtr-elicitation.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createMrtrElicitationHandler,
  findSensitiveElicitationFields,
  parseMrtrElicitationNeed,
  MrtrElicitationHandler,
  MrtrElicitationRefusedError,
  DEFAULT_MRTR_ELICITATION_URL_TIMEOUT_MS,
} from '../packages/core/dist/mcp/mrtrElicitation.js';
import { ElicitationUrlTracker } from '../packages/core/dist/mcp/elicitation.js';
import { MrtrError } from '../packages/core/dist/mcp/mrtr.js';

const FORM_SCHEMA = {
  type: 'object',
  properties: {
    nickname: { type: 'string', description: 'Tên hiển thị' },
    age: { type: 'integer', minimum: 0 },
  },
  required: ['nickname'],
};

const SECRET_SCHEMA = {
  type: 'object',
  properties: {
    nickname: { type: 'string' },
    password: { type: 'string' },
    apiKey: { type: 'string' },
  },
  required: ['nickname', 'password'],
};

function formNeed(schema = FORM_SCHEMA, prompt = 'Server cần tên hiển thị của bạn.') {
  return { resultType: 'needs_elicitation', prompt, schema };
}

test('mrtr elicitation: findSensitiveElicitationFields lists all sensitive fields', () => {
  assert.deepEqual(findSensitiveElicitationFields(SECRET_SCHEMA), ['password', 'apiKey']);
  assert.deepEqual(findSensitiveElicitationFields(FORM_SCHEMA), []);
  assert.deepEqual(findSensitiveElicitationFields({ type: 'object', properties: { token: { type: 'string', format: 'password' } } }), ['token']);
  assert.deepEqual(findSensitiveElicitationFields(null), []);
  assert.deepEqual(findSensitiveElicitationFields('nope'), []);
});

test('mrtr elicitation: parseMrtrElicitationNeed — form from schema, url from detail', () => {
  const form = parseMrtrElicitationNeed(formNeed(), 'srv-a');
  assert.equal(form.mode, 'form');
  assert.equal(form.serverName, 'srv-a');
  assert.equal(form.fields.length, 2);
  assert.equal(form.fields[0].name, 'nickname');

  const url = parseMrtrElicitationNeed(
    {
      resultType: 'needs_elicitation',
      prompt: 'Đăng nhập để tiếp tục.',
      detail: { mode: 'url', url: 'https://auth.example.invalid/login', elicitationId: 'el-1' },
    },
    'srv-a',
  );
  assert.equal(url.mode, 'url');
  assert.equal(url.url, 'https://auth.example.invalid/login');
  assert.equal(url.elicitationId, 'el-1');

  assert.throws(
    () => parseMrtrElicitationNeed({ resultType: 'needs_elicitation' }, 'srv-a'),
    (err) => err instanceof MrtrError,
  );
});

test('mrtr elicitation: form accept returns validated content, audits it', async () => {
  const audits = [];
  const promptCalls = [];
  const handler = new MrtrElicitationHandler({
    serverName: 'srv-a',
    prompt: async (req) => {
      promptCalls.push(req);
      return { action: 'accept', content: { nickname: 'Huy', age: '30' } };
    },
    onAudit: (e) => audits.push(e),
  });
  const answer = await handler.handle(formNeed(), 1);
  assert.deepEqual(answer, { nickname: 'Huy', age: 30 });
  assert.equal(promptCalls.length, 1);
  assert.equal(promptCalls[0].mode, 'form');
  assert.equal(audits.some((e) => e.kind === 'form-accepted'), true);
  assert.equal(handler.secretRefusals, 0);
  // Audit must not contain the user's values.
  assert.equal(JSON.stringify(audits).includes('Huy'), false);
});

test('mrtr elicitation: secret fields are REFUSED — prompt never called', async () => {
  let promptCalled = 0;
  const refused = [];
  const audits = [];
  const handler = new MrtrElicitationHandler({
    serverName: 'srv-a',
    prompt: async () => {
      promptCalled += 1;
      return { action: 'accept', content: {} };
    },
    onSecretRefused: (fields, round) => refused.push({ fields, round }),
    onAudit: (e) => audits.push(e),
  });
  await assert.rejects(handler.handle(formNeed(SECRET_SCHEMA), 2), (err) => {
    assert.ok(err instanceof MrtrElicitationRefusedError);
    assert.ok(err instanceof MrtrError);
    assert.deepEqual(err.refusedFields, ['password', 'apiKey']);
    assert.equal(err.resultType, 'needs_elicitation');
    assert.equal(err.round, 2);
    return true;
  });
  assert.equal(promptCalled, 0);
  assert.equal(handler.secretRefusals, 1);
  assert.deepEqual(refused, [{ fields: ['password', 'apiKey'], round: 2 }]);
  assert.equal(audits.some((e) => e.kind === 'secret-refused'), true);
  // Refusal message must not contain any secret value (there is none to leak).
  assert.equal(handler.audit[0].kind, 'secret-refused');
});

test('mrtr elicitation: user decline aborts the round trip', async () => {
  const handler = new MrtrElicitationHandler({
    serverName: 'srv-a',
    prompt: async () => ({ action: 'decline' }),
  });
  await assert.rejects(handler.handle(formNeed(), 1), (err) => {
    assert.ok(err instanceof MrtrError);
    assert.match(err.message, /từ chối/);
    return true;
  });
  assert.equal(handler.audit.some((e) => e.kind === 'form-declined'), true);
});

test('mrtr elicitation: user cancel (prompt returns null) aborts', async () => {
  const handler = new MrtrElicitationHandler({
    serverName: 'srv-a',
    prompt: async () => null,
  });
  await assert.rejects(handler.handle(formNeed(), 1), MrtrError);
});

test('mrtr elicitation: URL mode opens URL, waits for tracker completion, returns completed', async () => {
  const tracker = new ElicitationUrlTracker();
  const opened = [];
  const audits = [];
  const handler = new MrtrElicitationHandler({
    serverName: 'srv-oauth',
    prompt: async () => ({ action: 'accept' }),
    openUrl: async (url) => {
      opened.push(url);
    },
    urlTracker: tracker,
    urlCompletionTimeoutMs: 2000,
    onAudit: (e) => audits.push(e),
  });
  const promise = handler.handle(
    {
      resultType: 'needs_elicitation',
      prompt: 'Đăng nhập GitHub để tiếp tục.',
      detail: { mode: 'url', url: 'https://auth.example.invalid/oauth', elicitationId: 'el-9' },
    },
    1,
  );
  // Simulate the server reporting completion shortly after the URL opens.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(opened, ['https://auth.example.invalid/oauth']);
  assert.equal(tracker.complete('el-9'), true);
  const answer = await promise;
  assert.deepEqual(answer, { completed: true, elicitationId: 'el-9' });
  assert.equal(audits.some((e) => e.kind === 'url-opened'), true);
  assert.equal(audits.some((e) => e.kind === 'url-completed'), true);
});

test('mrtr elicitation: URL mode without openUrl fails clearly (no silent skip)', async () => {
  const handler = new MrtrElicitationHandler({
    serverName: 'srv-oauth',
    prompt: async () => ({ action: 'accept' }),
  });
  await assert.rejects(
    handler.handle(
      {
        resultType: 'needs_elicitation',
        prompt: 'Mở URL.',
        detail: { mode: 'url', url: 'https://auth.example.invalid/oauth' },
      },
      1,
    ),
    /openUrl/,
  );
});

test('mrtr elicitation: URL mode timeout throws MrtrError and audits it', async () => {
  const tracker = new ElicitationUrlTracker();
  const handler = new MrtrElicitationHandler({
    serverName: 'srv-oauth',
    prompt: async () => ({ action: 'accept' }),
    openUrl: async () => undefined,
    urlTracker: tracker,
    urlCompletionTimeoutMs: 30,
  });
  await assert.rejects(
    handler.handle(
      {
        resultType: 'needs_elicitation',
        prompt: 'Mở URL.',
        detail: { mode: 'url', url: 'https://auth.example.invalid/oauth', elicitationId: 'el-t' },
      },
      1,
    ),
    (err) => {
      assert.ok(err instanceof MrtrError);
      assert.match(err.message, /hết thời gian/);
      return true;
    },
  );
  assert.equal(handler.audit.some((e) => e.kind === 'url-timeout'), true);
});

test('mrtr elicitation: URL mode without elicitationId returns completed after opening', async () => {
  const opened = [];
  const handler = new MrtrElicitationHandler({
    serverName: 'srv-oauth',
    prompt: async () => ({ action: 'accept' }),
    openUrl: async (url) => {
      opened.push(url);
    },
  });
  const answer = await handler.handle(
    {
      resultType: 'needs_elicitation',
      prompt: 'Mở URL.',
      detail: { mode: 'url', url: 'https://auth.example.invalid/pay' },
    },
    1,
  );
  assert.deepEqual(answer, { completed: true, url: 'https://auth.example.invalid/pay' });
  assert.deepEqual(opened, ['https://auth.example.invalid/pay']);
});

test('mrtr elicitation: createMrtrElicitationHandler factory returns a working callback', async () => {
  const { onNeedsElicitation, handler } = createMrtrElicitationHandler({
    serverName: 'srv-a',
    prompt: async () => ({ action: 'accept', content: { nickname: 'Bot' } }),
  });
  const answer = await onNeedsElicitation(formNeed(), 1);
  assert.deepEqual(answer, { nickname: 'Bot' });
  assert.ok(handler instanceof MrtrElicitationHandler);
  assert.equal(DEFAULT_MRTR_ELICITATION_URL_TIMEOUT_MS, 10 * 60 * 1000);
});

test('mrtr elicitation: aborted signal aborts before asking the user', async () => {
  const controller = new AbortController();
  controller.abort();
  const handler = new MrtrElicitationHandler({
    serverName: 'srv-a',
    prompt: async () => ({ action: 'accept', content: {} }),
    signal: controller.signal,
  });
  await assert.rejects(handler.handle(formNeed(), 1), /đã bị huỷ/);
});
