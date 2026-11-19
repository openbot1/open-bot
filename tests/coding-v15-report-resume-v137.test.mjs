/**
 * Tests cho coding agent v15 — run report + resume + export/import + panel (v1.37, Đội T4).
 *
 * Chạy thật: report thật từ agent run thật, export/import budget thật,
 * resume agent thật (chạy tiếp từ step đã dừng), panel kiểm tra tĩnh
 * (mọi key i18n dùng trong tsx đều có trong en.json, không hard-code
 * tiếng Việt trong renderer).
 *   npm run build --workspace=@open-bot/core (scoped, trong worktree)
 *   node --test tests/coding-v15-report-resume-v137.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CodingV15BudgetMeter,
  CodingV15ProfileStore,
  buildV15RunReport,
  renderV15RunReportMarkdown,
  runV15Agent,
  scriptedV15Agent,
  v15BuildResumeState,
  v15ExportBudgetHistory,
  v15ImportBudgetHistory,
  v15IsValidUsageRecord,
} from '../packages/core/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Không chặn test.
  }
}

test('run report: gom profile + budget + hooks + verify thành một báo cáo markdown', () => {
  const dir = tmpDir('open-bot-v15-report-');
  try {
    const steps = [
      { text: 'Edit.', toolCalls: [], done: false, inputTokens: 100, outputTokens: 50 },
      { text: 'Done.', toolCalls: [], done: true, inputTokens: 10, outputTokens: 5, stopHookFeedback: { source: 'stop-hook', title: 'Stopped', body: 'Done.', severity: 'info' } },
    ];
    const result = runV15Agent(
      { runId: 'rep-1', prompt: 'Do it', profileId: 'v15-fixer', botId: 'bot-1', budgetCap: { maxTokens: 1000 } },
      scriptedV15Agent(steps),
      { dataDir: dir },
    );
    const store = new CodingV15ProfileStore({ dataDir: dir });
    const applied = store.apply('v15-fixer', 'fallback');
    const report = buildV15RunReport({ result, applied });
    assert.equal(report.runId, 'rep-1');
    assert.equal(report.profileId, 'v15-fixer');
    assert.ok(report.profileSummary.includes('Fixer'));
    assert.equal(report.stepsExecuted, 2);
    assert.equal(report.done, true);
    assert.equal(report.budget.state.totalTokens, 165);
    assert.equal(report.hooksDialog.pending, 1);
    assert.equal(report.verify, null);
    assert.ok(report.summary.includes('rep-1'));
    assert.ok(report.summary.includes('Fixer [ACP]'));
    const md = renderV15RunReportMarkdown(report);
    assert.ok(md.startsWith('# Coding agent v15 — run rep-1'));
    assert.ok(md.includes('## Budget (report-only)'));
    assert.ok(md.includes('## Hooks dialog'));
    assert.ok(md.includes('## Verify scenarios'));
    assert.ok(md.includes('Not run for this run.'));
    assert.ok(md.includes('Stopped'));
    // Verify kèm theo → markdown có bảng verify.
    const withVerify = { ...result, verify: { runId: 'rep-1-verify', profileId: 'v15-fixer', total: 9, passed: 9, failed: 0, results: [], durationMs: 5, summary: 'Verify rep-1-verify: 9/9 scenarios passed.', createdAt: '2026-11-18T00:00:00.000Z' } };
    const report2 = buildV15RunReport({ result: withVerify, applied });
    assert.ok(renderV15RunReportMarkdown(report2).includes('9/9 scenarios passed'));
    assert.throws(() => buildV15RunReport({ result: null, applied }), /agent result/);
    assert.throws(() => buildV15RunReport({ result, applied: null }), /profile apply/);
  } finally {
    cleanup(dir);
  }
});

test('budget export/import: record hợp lệ nạp lại, record hỏng bị bỏ qua', () => {
  const meter = new CodingV15BudgetMeter('bot-e', { maxTokens: 10000 });
  meter.record({ runId: 'e-1', model: 'gpt-5', inputTokens: 100, outputTokens: 20, profileId: 'v15-general' });
  meter.record({ runId: 'e-1', model: 'gpt-5', inputTokens: 50, outputTokens: 10, profileId: 'v15-general' });
  meter.record({ runId: 'e-2', model: 'gpt-5', inputTokens: 10, outputTokens: 0, profileId: 'v15-fixer' });
  const exported = v15ExportBudgetHistory(meter);
  assert.equal(exported.version, 1);
  assert.equal(exported.botId, 'bot-e');
  assert.equal(exported.records.length, 3);
  // Import vào meter mới: đủ 3 record, history 2 run.
  const meter2 = new CodingV15BudgetMeter('bot-e', { maxTokens: 10000 });
  const imported = v15ImportBudgetHistory(meter2, exported);
  assert.equal(imported.imported, 3);
  assert.equal(imported.skipped, 0);
  assert.equal(imported.history.length, 2);
  assert.equal(meter2.totals().totalTokens, 190);
  // File lẫn record hỏng: 1 hợp lệ + 2 hỏng → import 1, skip 2.
  const mixed = {
    version: 1,
    exportedAt: '2026-11-18T00:00:00.000Z',
    botId: 'bot-e',
    records: [
      { runId: 'm-1', botId: 'bot-e', profileId: '', model: 'gpt-5', inputTokens: 5, outputTokens: 0, costUsd: null, tokensEstimated: false, step: 0, at: '2026-11-18T00:00:00.000Z' },
      { runId: '', model: 'gpt-5', inputTokens: 5, outputTokens: 0, costUsd: null, at: 'x' },
      { runId: 'm-2', model: 'gpt-5', inputTokens: -1, outputTokens: 0, costUsd: null, at: 'x' },
    ],
  };
  const meter3 = new CodingV15BudgetMeter('bot-e', {});
  const res3 = v15ImportBudgetHistory(meter3, mixed);
  assert.equal(res3.imported, 1);
  assert.equal(res3.skipped, 2);
  assert.equal(v15IsValidUsageRecord(mixed.records[0]), true);
  assert.equal(v15IsValidUsageRecord(mixed.records[1]), false);
  assert.equal(v15IsValidUsageRecord(null), false);
  assert.throws(() => v15ImportBudgetHistory(meter3, { version: 2, records: [] }), /version phải là 1/);
  assert.throws(() => v15ImportBudgetHistory(meter3, { version: 1 }), /mảng records/);
});

test('profiles export/import: custom qua lại giữa 2 store, trùng + hỏng bị bỏ qua', () => {
  const dirA = tmpDir('open-bot-v15-exp-a-');
  const dirB = tmpDir('open-bot-v15-exp-b-');
  try {
    const storeA = new CodingV15ProfileStore({ dataDir: dirA });
    storeA.create({ name: 'Shared', kind: 'general', persona: 'Shared persona.', exposeViaAcp: true });
    storeA.create({ name: 'Local Only', kind: 'planner', persona: 'Planner persona.' });
    const exported = storeA.exportCustom();
    assert.equal(exported.version, 1);
    assert.equal(exported.profiles.length, 2);
    assert.ok(exported.profiles.every((p) => !p.builtin));
    const storeB = new CodingV15ProfileStore({ dataDir: dirB });
    const res = storeB.importProfiles(exported);
    assert.equal(res.imported, 2);
    assert.equal(res.skipped, 0);
    assert.deepEqual(res.ids.sort(), ['local-only', 'shared']);
    assert.equal(storeB.get('shared').persona, 'Shared persona.');
    // Import lại lần nữa: trùng id → skip hết.
    const res2 = storeB.importProfiles(exported);
    assert.equal(res2.imported, 0);
    assert.equal(res2.skipped, 2);
    // File lẫn built-in + hỏng: built-in skip, hỏng skip, hợp lệ import.
    const mixed = {
      version: 1,
      exportedAt: '2026-11-18T00:00:00.000Z',
      profiles: [
        { id: 'v15-general', builtin: true, name: 'General', kind: 'general', persona: 'x' },
        { name: '', persona: 'x' },
        { name: 'Third', kind: 'custom', persona: 'Third persona.' },
      ],
    };
    const res3 = storeB.importProfiles(mixed);
    assert.equal(res3.imported, 1);
    assert.equal(res3.skipped, 2);
    assert.equal(storeB.get('third').kind, 'custom');
    assert.throws(() => storeB.importProfiles({ version: 2, profiles: [] }), /version phải là 1/);
  } finally {
    cleanup(dirA);
    cleanup(dirB);
  }
});

test('agent resume: chạy tiếp từ step đã dừng, giữ lỗi/file cũ, sai runId bị chặn', () => {
  const dir = tmpDir('open-bot-v15-resume-');
  try {
    const steps = [
      { text: 'Step 0.', toolCalls: [{ tool: 'edit_file', args: { path: 'f.txt' }, status: 'ok', fileChange: { path: 'f.txt', kind: 'create', afterContent: 'v1' } }], done: false, inputTokens: 10, outputTokens: 0 },
      { text: 'Step 1 fails.', toolCalls: [{ tool: 'run_tests', args: {}, status: 'error', error: 'fail' }], done: false, inputTokens: 10, outputTokens: 0 },
      { text: 'Step 2 done.', toolCalls: [], done: true, inputTokens: 10, outputTokens: 0 },
    ];
    // Chạy 2 step đầu rồi dừng (maxSteps 2).
    const first = runV15Agent(
      { runId: 'res-1', prompt: 'Resume me', profileId: 'v15-general', maxSteps: 2 },
      scriptedV15Agent(steps),
      { dataDir: dir },
    );
    assert.equal(first.stepsExecuted, 2);
    assert.equal(first.done, false);
    assert.equal(first.toolErrors.length, 1);
    assert.deepEqual(first.filesWritten, ['f.txt']);
    // Resume: chạy tiếp step 2, lỗi + file cũ còn nguyên.
    const resume = v15BuildResumeState(first);
    assert.equal(resume.stepsExecuted, 2);
    const second = runV15Agent(
      { runId: 'res-1', prompt: 'Resume me', profileId: 'v15-general' },
      scriptedV15Agent(steps),
      { dataDir: dir, resumeFrom: resume },
    );
    assert.equal(second.stepsExecuted, 3);
    assert.equal(second.done, true);
    assert.equal(second.toolErrors.length, 1);
    assert.deepEqual(second.filesWritten, ['f.txt']);
    // Resume sai runId/profile → throw.
    assert.throws(
      () => runV15Agent({ runId: 'other', prompt: 'x', profileId: 'v15-general' }, scriptedV15Agent(steps), { dataDir: dir, resumeFrom: resume }),
      /không khớp runId/,
    );
  } finally {
    cleanup(dir);
  }
});

test('panel: CodingV15Panel.tsx dùng key i18n codingV15.* có trong en.json, không hard-code tiếng Việt', () => {
  const panelPath = join(here, '..', 'apps/desktop/src/renderer/components/CodingV15Panel.tsx');
  assert.ok(fs.existsSync(panelPath), 'thiếu CodingV15Panel.tsx');
  const src = readFileSync(panelPath, 'utf8');
  const en = JSON.parse(readFileSync(join(here, '..', 'apps/desktop/src/renderer/i18n/locales/en.json'), 'utf8'));
  // Mọi key t('codingV15....') trong panel đều tồn tại.
  const used = [...src.matchAll(/t\('([a-zA-Z0-9_.]+)'\)/g)].map((m) => m[1]);
  assert.ok(used.length > 10, `panel dùng quá ít key i18n: ${used.length}`);
  for (const key of new Set(used)) {
    if (key.startsWith('codingV15.')) {
      assert.ok(key in en, `panel dùng key ${key} nhưng en.json không có`);
    }
  }
  // Không hard-code tiếng Việt trong renderer: không có ký tự tiếng Việt có dấu.
  const vietnamese = src.match(/[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ]/g);
  assert.equal(vietnamese, null, `panel hard-code tiếng Việt: ${vietnamese?.slice(0, 5).join('')}`);
  // Panel có đủ 4 tab + demo builder + callback hook decision.
  for (const tab of ['profiles', 'budget', 'hooks', 'verify']) {
    assert.ok(src.includes(`'${tab}'`), `panel thiếu tab ${tab}`);
  }
  assert.ok(src.includes('demoCodingV15Panel'));
  assert.ok(src.includes('onHookDecision'));
  assert.ok(src.includes('onSelectProfile'));
  assert.ok(src.includes('MeterBar'));
});
