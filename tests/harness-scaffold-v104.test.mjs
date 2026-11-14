/**
 * Tests for the v1.04 scaffold harness (packages/core/src/harness/scaffold.ts):
 * the minimal runnable agent loop — a fake model, a tool table, a loop,
 * a named stop condition. No provider, no network: this test IS the demo
 * from docs/harness-scaffold-v104.md.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/harness-scaffold-v104.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runScaffoldHarness } from '../packages/core/dist/harness/scaffold.js';

const addTool = {
  name: 'add',
  description: 'Add two numbers.',
  run: (args) => String(Number(args.a) + Number(args.b)),
};

test('scaffold: tool call then final answer (the doc example)', async () => {
  const result = await runScaffoldHarness(
    async (messages) => {
      const last = messages[messages.length - 1];
      if (last.role === 'tool') return { text: `Kết quả là: ${last.content}` };
      return { toolCall: { name: 'add', args: { a: 2, b: 3 } } };
    },
    'Tính 2 + 3',
    { tools: [addTool] },
  );
  assert.equal(result.finishReason, 'final');
  assert.equal(result.finalText, 'Kết quả là: 5');
  assert.equal(result.steps, 2);
  assert.deepEqual(
    result.messages.map((m) => m.role),
    ['user', 'assistant', 'tool', 'assistant'],
  );
  assert.equal(result.messages[2].content, '5');
});

test('scaffold: direct answer without any tool call', async () => {
  const result = await runScaffoldHarness(
    async () => ({ text: 'Hello!' }),
    'Say hello',
    { tools: [addTool] },
  );
  assert.equal(result.finishReason, 'final');
  assert.equal(result.finalText, 'Hello!');
  assert.equal(result.steps, 1);
  assert.equal(result.messages.length, 2);
});

test('scaffold: max-steps stops a looping model', async () => {
  let calls = 0;
  const result = await runScaffoldHarness(
    async () => {
      calls++;
      return { toolCall: { name: 'add', args: { a: calls, b: 1 } } };
    },
    'Loop forever',
    { tools: [addTool], maxSteps: 3 },
  );
  assert.equal(result.finishReason, 'max-steps');
  assert.equal(result.steps, 3);
  assert.equal(calls, 3);
  assert.equal(result.finalText, undefined);
});

test('scaffold: unknown tool stops with a named reason (never fakes a result)', async () => {
  const result = await runScaffoldHarness(
    async () => ({ toolCall: { name: 'nope', args: {} } }),
    'Call a missing tool',
    { tools: [addTool] },
  );
  assert.equal(result.finishReason, 'unknown-tool');
  assert.equal(result.steps, 1);
  assert.equal(result.messages.length, 1, 'no fake tool result was appended');
});

test('scaffold: async tools work; default maxSteps is 10', async () => {
  const slow = {
    name: 'slow',
    run: async () => {
      await new Promise((r) => setTimeout(r, 5));
      return 'slow-ok';
    },
  };
  const result = await runScaffoldHarness(
    async (messages) => {
      if (messages.some((m) => m.role === 'tool')) return { text: 'done' };
      return { toolCall: { name: 'slow', args: {} } };
    },
    'Run the slow tool',
    { tools: [slow] },
  );
  assert.equal(result.finishReason, 'final');
  assert.equal(result.messages[2].content, 'slow-ok');
  // Default maxSteps: a model that always calls a tool stops at 10.
  const looping = await runScaffoldHarness(
    async () => ({ toolCall: { name: 'slow', args: {} } }),
    'Loop',
    { tools: [slow] },
  );
  assert.equal(looping.finishReason, 'max-steps');
  assert.equal(looping.steps, 10);
});

test('scaffold: no tools registered means any tool call is unknown', async () => {
  const result = await runScaffoldHarness(
    async () => ({ toolCall: { name: 'add', args: { a: 1, b: 2 } } }),
    'No tools here',
  );
  assert.equal(result.finishReason, 'unknown-tool');
});
