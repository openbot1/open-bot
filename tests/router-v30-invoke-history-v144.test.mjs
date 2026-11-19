/**
 * Router v30 — CLI invoke + routing history (v1.44, Doi T5, node:test).
 *
 * Covers (thuan, mock runner — KHONG spawn that, KHONG doc file):
 * - buildCliInvokeArgvV30: template argv tung CLI ({prompt} -> prompt
 *   that, 1 argv rieng, khong shell); customArgv ghi de.
 * - invokeCliAgentV30: prompt rong -> loi; chua dong y -> loi, KHONG
 *   goi runner; nguon tat -> loi; CLI chua phat hien -> loi; timeout
 *   (mock) -> loi timeout; exit != 0 -> loi; thanh cong -> output +
 *   exitCode 0 + ghi kind/binary; output vuot gioi han -> truncated.
 * - Runner mac dinh KHONG duoc goi trong test (chi mock).
 * - RoutingHistoryStoreV30: record quyet dinh (ok + fail), cap 500,
 *   recent/byModel, summary (tong chi phi, trung binh, ti le do that,
 *   model duoc chon nhieu nhat), snapshot/restore.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/router-v30-invoke-history-v144.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLI_INVOKE_TEMPLATES_V30,
  RoutingHistoryStoreV30,
  buildCliInvokeArgvV30,
  defaultModelCatalogV30,
  defaultRoutingPolicyV30,
  detectCliAgentsV30,
  defaultCliAgentConsentV30,
  invokeCliAgentV30,
  routeModelV30,
  setCliConsentV30,
  setCliSourceEnabledV30,
} from '../packages/core/dist/routerV30/index.js';

const mockRunner = async (definition) => {
  const found = {
    codex: { binary: 'codex', version: 'codex-cli 0.42.0' },
    'gemini-cli': { binary: 'gemini', version: 'gemini 0.9.1' },
  };
  return found[definition.kind] ?? null;
};

async function setup() {
  const detections = await detectCliAgentsV30(mockRunner, 5000);
  const consent = setCliConsentV30(defaultCliAgentConsentV30(), true, 7000);
  return { detections, consent };
}

test('buildCliInvokeArgvV30: template tung CLI + customArgv', () => {
  assert.deepEqual(buildCliInvokeArgvV30('codex', 'hello'), ['exec', 'hello']);
  assert.deepEqual(buildCliInvokeArgvV30('claude-code', 'hello'), ['-p', 'hello']);
  assert.deepEqual(buildCliInvokeArgvV30('opencode', 'hello'), ['run', 'hello']);
  assert.deepEqual(buildCliInvokeArgvV30('gemini-cli', 'hello'), ['-p', 'hello']);
  assert.deepEqual(buildCliInvokeArgvV30('aider', 'hello'), ['--message', 'hello']);
  assert.deepEqual(buildCliInvokeArgvV30('cursor-cli', 'hello'), ['-p', 'hello']);
  assert.deepEqual(Object.keys(CLI_INVOKE_TEMPLATES_V30).length, 6);
  // customArgv ghi de template.
  assert.deepEqual(
    buildCliInvokeArgvV30('codex', 'hi', ['custom', '{prompt}', '--flag']),
    ['custom', 'hi', '--flag'],
  );
  // Prompt la 1 argv rieng (khong noi chuoi shell).
  const argv = buildCliInvokeArgvV30('codex', 'a; rm -rf /');
  assert.equal(argv[1], 'a; rm -rf /');
});

test('invoke: chua dong y / nguon tat / chua phat hien / prompt rong -> loi, khong goi runner', async () => {
  const { detections } = await setup();
  let runnerCalls = 0;
  const countingRunner = async () => {
    runnerCalls += 1;
    return { stdout: 'x', stderr: '', exitCode: 0, timedOut: false };
  };
  const noConsent = defaultCliAgentConsentV30();
  const r1 = await invokeCliAgentV30({ kind: 'codex', prompt: 'hi' }, detections, noConsent, countingRunner);
  assert.equal(r1.ok, false);
  assert.match(r1.error, /consent/);

  const { consent } = await setup();
  const disabled = setCliSourceEnabledV30(consent, 'codex', false);
  const r2 = await invokeCliAgentV30({ kind: 'codex', prompt: 'hi' }, detections, disabled, countingRunner);
  assert.equal(r2.ok, false);
  assert.match(r2.error, /disabled/);

  const r3 = await invokeCliAgentV30({ kind: 'opencode', prompt: 'hi' }, detections, consent, countingRunner);
  assert.equal(r3.ok, false);
  assert.match(r3.error, /not detected/);

  const r4 = await invokeCliAgentV30({ kind: 'codex', prompt: '   ' }, detections, consent, countingRunner);
  assert.equal(r4.ok, false);
  assert.match(r4.error, /prompt is required/);

  const r5 = await invokeCliAgentV30({ kind: 'codex', prompt: 'hi', timeoutMs: 0 }, detections, consent, countingRunner);
  assert.equal(r5.ok, false);
  assert.match(r5.error, /timeoutMs/);

  assert.equal(runnerCalls, 0);
});

test('invoke: thanh cong tra output + kind/binary; timeout/exit!=0 -> loi', async () => {
  const { detections, consent } = await setup();
  const okRunner = async (binary, argv) => {
    assert.equal(binary, 'codex');
    assert.deepEqual(argv, ['exec', 'say hi']);
    return { stdout: 'hello from model', stderr: '', exitCode: 0, timedOut: false };
  };
  const ok = await invokeCliAgentV30({ kind: 'codex', prompt: 'say hi' }, detections, consent, okRunner);
  assert.equal(ok.ok, true);
  assert.equal(ok.output, 'hello from model');
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.kind, 'codex');
  assert.equal(ok.binary, 'codex');
  assert.equal(ok.truncated, false);
  assert.ok(ok.durationMs >= 0);

  const timeoutRunner = async () => ({ stdout: '', stderr: '', exitCode: null, timedOut: true });
  const timedOut = await invokeCliAgentV30({ kind: 'codex', prompt: 'hi' }, detections, consent, timeoutRunner);
  assert.equal(timedOut.ok, false);
  assert.match(timedOut.error, /timed out/);

  const failRunner = async () => ({ stdout: '', stderr: 'boom', exitCode: 1, timedOut: false, error: 'exit code 1' });
  const failed = await invokeCliAgentV30({ kind: 'codex', prompt: 'hi' }, detections, consent, failRunner);
  assert.equal(failed.ok, false);
  assert.equal(failed.exitCode, 1);

  // Output vuot gioi han -> cat + truncated.
  const longRunner = async () => ({ stdout: 'x'.repeat(1_500_000), stderr: '', exitCode: 0, timedOut: false });
  const long = await invokeCliAgentV30({ kind: 'codex', prompt: 'hi' }, detections, consent, longRunner);
  assert.equal(long.ok, true);
  assert.equal(long.truncated, true);
  assert.equal(long.output.length, 1_000_000);
});

test('routing history: record + cap + recent/byModel + summary + snapshot', () => {
  const store = new RoutingHistoryStoreV30();
  assert.equal(store.length, 0);
  assert.deepEqual(store.summary(), {
    total: 0,
    succeeded: 0,
    failed: 0,
    byModel: [],
    totalEstimatedCostUsd: 0,
    avgEstimatedCostUsd: 0,
    measuredLatencyRatio: 0,
    mostChosen: null,
  });
  const catalog = defaultModelCatalogV30(1_000_000);
  const policy = defaultRoutingPolicyV30();
  const d1 = routeModelV30(catalog, {}, policy, null, 2000);
  const e1 = store.record(d1, {});
  assert.equal(e1.ok, true);
  assert.ok(e1.chosenKey);
  assert.equal(e1.at, 2000);
  const d2 = routeModelV30(catalog, { minContextTokens: 99_999_999 }, policy, null, 3000);
  const e2 = store.record(d2, { needsToolCalling: true });
  assert.equal(e2.ok, false);
  assert.equal(e2.chosenKey, null);
  assert.equal(e2.explanation, 'no model fits');
  assert.equal(store.length, 2);
  assert.equal(store.recent(1)[0].at, 3000);
  assert.equal(store.recent(5).length, 2);
  const chosen = e1.chosenKey.split('::');
  assert.equal(store.byModel(chosen[0], chosen[1]).length, 1);
  assert.equal(store.byModel('nope', 'nope').length, 0);
  const s = store.summary();
  assert.equal(s.total, 2);
  assert.equal(s.succeeded, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.mostChosen, e1.chosenKey);
  assert.equal(s.byModel[0].count, 1);
  assert.ok(s.totalEstimatedCostUsd >= 0);
  assert.equal(s.measuredLatencyRatio, 0);

  // Snapshot/restore.
  const snap = store.snapshotV30();
  const store2 = new RoutingHistoryStoreV30();
  assert.equal(store2.restoreV30(snap), 2);
  assert.equal(store2.length, 2);
  assert.equal(store2.restoreV30([{ at: 'bad', ok: true }]), 0);
  store2.clear();
  assert.equal(store2.length, 0);

  // Cap 500.
  const big = new RoutingHistoryStoreV30();
  for (let i = 0; i < 520; i += 1) {
    big.record(routeModelV30(catalog, {}, policy, null, 1000 + i), {});
  }
  assert.equal(big.length, 500);
  assert.equal(big.all[0].at, 1020);
});
