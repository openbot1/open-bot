/**
 * Tests for the MCP conformance eval suite
 * (packages/core/src/eval/mcpConformanceEval.ts) and the eval runner
 * (packages/core/src/eval/index.ts).
 *
 * Covers the full suite run (7 cases — stateless format, discover,
 * elicitation form/URL, Tasks poll, Tasks cancel, fallback handshake)
 * plus the runner: running both suites, saving/loading/listing
 * reports, and text formatting.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/eval-mcp-v106.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runMcpConformanceEval } from '../packages/core/dist/eval/mcpConformanceEval.js';
import {
  formatEvalReportText,
  listEvalReports,
  loadEvalReport,
  runEval,
  saveEvalReport,
} from '../packages/core/dist/eval/index.js';

test('runMcpConformanceEval: all 7 cases pass against the fake transport', async () => {
  const result = await runMcpConformanceEval();
  assert.equal(result.suite, 'mcp-conformance');
  assert.equal(result.cases.length, 7);
  assert.equal(result.failed, 0, result.cases.filter((c) => !c.passed).map((c) => `${c.id}: ${c.detail}`).join('; '));
  assert.equal(result.passed, 7);
  const ids = result.cases.map((c) => c.id);
  for (const expected of [
    'mcp.stateless-request-format',
    'mcp.discover',
    'mcp.elicitation-form',
    'mcp.elicitation-url',
    'mcp.tasks-poll',
    'mcp.tasks-cancel',
    'mcp.fallback-handshake-old-server',
  ]) {
    assert.ok(ids.includes(expected), `missing case ${expected}`);
  }
});

test('runEval(all) runs both suites and the report round-trips through disk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-eval-runner-'));
  const { report, reportPath } = await runEval(['memory', 'mcp-conformance'], { saveDir: dir });
  assert.equal(report.suites.length, 2);
  assert.equal(report.results.length, 2);
  assert.equal(report.failed, 0);
  assert.equal(report.passed, 15);
  assert.ok(reportPath !== null);
  assert.ok(fs.existsSync(reportPath));
  const loaded = loadEvalReport(dir, report.id);
  assert.ok(loaded !== null);
  assert.equal(loaded.id, report.id);
  assert.equal(loaded.passed, 15);
  const listed = listEvalReports(dir);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, report.id);
  assert.equal(listed[0].passed, 15);
  assert.deepEqual(listed[0].suites, ['memory', 'mcp-conformance']);
  const text = formatEvalReportText(report);
  assert.match(text, /15 passed, 0 failed/);
  assert.match(text, /\[memory\]/);
  assert.match(text, /\[mcp-conformance\]/);
  assert.match(text, /PASS  memory\.recall-after-20-turns/);
  assert.match(text, /PASS  mcp\.tasks-poll/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runEval without saveDir does not write a report file', async () => {
  const { report, reportPath } = await runEval(['memory']);
  assert.equal(reportPath, null);
  assert.equal(report.failed, 0);
});

test('loadEvalReport returns null for an unknown id; listEvalReports is empty on a fresh dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-eval-empty-'));
  assert.equal(loadEvalReport(dir, 'eval-nope'), null);
  assert.deepEqual(listEvalReports(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('saveEvalReport refuses to overwrite silently — a second save keeps both files distinct', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-eval-save-'));
  const { report } = await runEval(['mcp-conformance']);
  const p1 = saveEvalReport(dir, report);
  const { report: report2 } = await runEval(['mcp-conformance']);
  const p2 = saveEvalReport(dir, report2);
  assert.notEqual(p1, p2);
  assert.equal(listEvalReports(dir).length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
