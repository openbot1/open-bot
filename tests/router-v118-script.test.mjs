/**
 * Router local v118 — programmatic tool calling (v1.41, Doi T3, node:test).
 *
 * Covers (thuan, khong model that, khong network — executor gia):
 * - validateScript: rong / qua lon / dinh danh cam / loi cu phap /
 *   hop le + extractCalledTools.
 * - runScript: let/const, if/else, for...of, while, ternary, member/
 *   index access, call + log, input chi-doc, results tich luy.
 * - Chi ket qua cuoi vao context: tokenSaving (intermediate vs
 *   returned) tinh dung.
 * - An toan: chan require/process/fetch/eval/constructor/__proto__;
 *   allowlist; khong co executor -> loi; step budget (while true);
 *   maxCalls; ket qua bi cat (truncated).
 * - Loi -> fallback: ok=false, fallbackToNormalToolCalls=true,
 *   completedCalls giu cac call da xong.
 * - Audit store: ghi moi call, gioi han 200, loc theo tool.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/router-v118-script.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ScriptAuditStore,
  extractCalledTools,
  runScript,
  validateScript,
} from '../packages/core/dist/router/local/programmaticToolCallingV118.js';

function fakeExecutors() {
  const seen = [];
  return {
    seen,
    executors: {
      math_add: async (_name, args) => {
        seen.push(['math_add', args]);
        return (args.a ?? 0) + (args.b ?? 0);
      },
      text_upper: async (_name, args) => {
        seen.push(['text_upper', args]);
        return String(args.text ?? '').toUpperCase();
      },
      big_list: async () => Array.from({ length: 5 }, (_, i) => `item-${i}`),
      failer: async () => {
        throw new Error('boom from failer');
      },
      echo: async (_name, args) => args,
    },
  };
}

test('validate: rong / cam / loi cu phap / hop le', () => {
  assert.equal(validateScript('').ok, false);
  assert.equal(validateScript('   ').errors[0].kind, 'empty');

  const forbidden = validateScript('let x = require("fs");');
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.errors[0].kind, 'forbidden-identifier');

  for (const bad of [
    'let x = process.env;',
    'fetch("http://x");',
    'let f = eval("1");',
    'let y = globalThis.foo;',
    'x.constructor;',
    'a.__proto__;',
  ]) {
    assert.equal(validateScript(bad).ok, false, bad);
  }

  const syntax = validateScript('let x = ;');
  assert.equal(syntax.ok, false);
  assert.equal(syntax.errors[0].kind, 'syntax');

  const unclosed = validateScript('if (true) { let x = 1;');
  assert.equal(unclosed.ok, false);

  const good = validateScript('let a = call("math_add", {a: 1, b: 2}); return a;');
  assert.equal(good.ok, true);
  assert.deepEqual(good.calledTools, ['math_add']);

  assert.deepEqual(extractCalledTools('call("a", {}); call("b", {}); call("a", {});'), ['a', 'b']);

  const huge = validateScript('x'.repeat(20001));
  assert.equal(huge.ok, false);
  assert.equal(huge.errors[0].kind, 'too-large');
});

test('run: goi nhieu tool, chi ket qua cuoi vao context', async () => {
  const { executors } = fakeExecutors();
  const result = await runScript(
    `
    let sum = call("math_add", {a: 40, b: 2});
    let loud = call("text_upper", {text: "hello"});
    log("sum is", sum);
    return { sum: sum, loud: loud };
    `,
    { executors },
  );
  assert.equal(result.ok, true);
  assert.equal(result.returned, true);
  assert.deepEqual(result.returnValue, { sum: 42, loud: 'HELLO' });
  assert.equal(result.callsUsed, 2);
  assert.equal(result.calls.length, 2);
  assert.equal(result.calls[0].toolName, 'math_add');
  assert.equal(result.calls[0].ok, true);
  assert.equal(result.calls[1].toolName, 'text_upper');
  assert.deepEqual(result.logs, ['sum is 42']);
  // Chi ket qua cuoi (JSON ~30 ky tu) vao context, 2 ket qua trung gian
  // (~2 + ~7 ky tu) van duoc tinh — saved >= 0 va cong thuc dung.
  assert.equal(
    result.tokenSaving.intermediateResultChars,
    result.calls.reduce((s, c) => s + c.resultChars, 0),
  );
  assert.ok(result.tokenSaving.returnedChars > 0);
  assert.equal(
    result.tokenSaving.savedChars,
    Math.max(0, result.tokenSaving.intermediateResultChars - result.tokenSaving.returnedChars),
  );
});

test('run: for...of / while / if / ternary / member access / results', async () => {
  const { executors } = fakeExecutors();
  const loop = await runScript(
    `
    let items = call("big_list", {});
    let total = 0;
    for (let item of items) {
      total = total + 1;
    }
    let i = 0;
    while (i < 3) { i = i + 1; }
    let label = total == 5 ? "five" : "other";
    return { count: total, i: i, label: label, first: items[0], n: items.length, lastCall: results[0] };
    `,
    { executors },
  );
  assert.equal(loop.ok, true, loop.error);
  assert.deepEqual(loop.returnValue, {
    count: 5,
    i: 3,
    label: 'five',
    first: 'item-0',
    n: 5,
    lastCall: ['item-0', 'item-1', 'item-2', 'item-3', 'item-4'],
  });

  const cond = await runScript(
    'let x = input.flag ? call("math_add", {a: 1, b: 1}) : 0; if (x > 1) { return "big"; } else { return "small"; }',
    { input: { flag: true }, executors },
  );
  assert.equal(cond.ok, true);
  assert.equal(cond.returnValue, 'big');

  const noReturn = await runScript('let x = 1 + 2;', { executors });
  assert.equal(noReturn.ok, true);
  assert.equal(noReturn.returned, false);
  assert.equal(noReturn.returnValue, null);
});

test('run: chan host access + allowlist + thieu executor', async () => {
  const { executors } = fakeExecutors();

  const forbidden = await runScript('let x = require("fs"); return x;', { executors });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.fallback.fallbackToNormalToolCalls, true);

  const blocked = await runScript('return call("math_add", {a: 1, b: 2});', {
    executors,
    allowedTools: ['text_upper'],
  });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.error.includes('allowlist'));

  const noExecutor = await runScript('return call("math_add", {a: 1, b: 2});', {});
  assert.equal(noExecutor.ok, false);
  assert.ok(noExecutor.error.includes('executor'));

  const unknownFn = await runScript('return nosuchfn(1);', { executors });
  assert.equal(unknownFn.ok, false);
  assert.ok(unknownFn.error.includes('nosuchfn'));

  const undeclared = await runScript('return missingVar;', { executors });
  assert.equal(undeclared.ok, false);

  const constReassign = await runScript('const x = 1; x = 2; return x;', { executors });
  assert.equal(constReassign.ok, false);
  assert.ok(constReassign.error.includes('const'));
});

test('run: step budget chan loop vo han + maxCalls + cat ket qua', async () => {
  const { executors } = fakeExecutors();

  const infinite = await runScript('let i = 0; while (true) { i = i + 1; } return i;', {
    executors,
    limits: { maxSteps: 500, maxWallMs: 5000 },
  });
  assert.equal(infinite.ok, false);
  assert.ok(infinite.error.includes('step budget') || infinite.error.includes('thoi gian'));

  const many = await runScript(
    'let a = call("math_add", {a: 1, b: 1}); let b = call("math_add", {a: 2, b: 2}); let c = call("math_add", {a: 3, b: 3}); return c;',
    { executors, limits: { maxCalls: 2 } },
  );
  assert.equal(many.ok, false);
  assert.ok(many.error.includes('toi da'));

  // Ket qua lon bi cat o maxResultChars.
  const trunc = await runScript('let x = call("big_list", {}); return x;', {
    executors,
    limits: { maxResultChars: 10 },
  });
  assert.equal(trunc.ok, true);
  assert.equal(trunc.calls[0].truncated, true);
  assert.ok(trunc.calls[0].resultChars > 10);
});

test('run: loi giua chung -> fallback giu call da xong', async () => {
  const { executors } = fakeExecutors();
  const audit = new ScriptAuditStore();
  const result = await runScript(
    `
    let a = call("math_add", {a: 1, b: 2});
    let b = call("failer", {});
    return a;
    `,
    { executors },
    audit,
  );
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('failer'));
  assert.equal(result.calls.length, 2);
  assert.equal(result.calls[0].ok, true);
  assert.equal(result.calls[1].ok, false);
  assert.equal(result.fallback.fallbackToNormalToolCalls, true);
  assert.equal(result.fallback.completedCalls.length, 1);
  assert.equal(result.fallback.completedCalls[0].toolName, 'math_add');
  assert.equal(result.fallback.suggestedNextCalls[0].toolName, 'failer');

  // Audit store ghi ca 2 call, loc theo tool duoc.
  assert.equal(audit.getRuns(), 1);
  assert.equal(audit.list().length, 2);
  assert.equal(audit.byTool('math_add').length, 1);
  assert.equal(audit.byTool('failer')[0].ok, false);
  audit.clear();
  assert.equal(audit.getRuns(), 0);
  assert.equal(audit.list().length, 0);
});

test('run: input chi-doc qua object + args phai la object', async () => {
  const { executors } = fakeExecutors();
  const result = await runScript(
    'let e = call("echo", {q: input.query, n: 3}); return e.q + "-" + e.n;',
    { input: { query: 'hello' }, executors },
  );
  assert.equal(result.ok, true);
  assert.equal(result.returnValue, 'hello-3');

  const badArgs = await runScript('return call("echo", 5);', { executors });
  assert.equal(badArgs.ok, false);
  assert.ok(badArgs.error.includes('object'));
});
