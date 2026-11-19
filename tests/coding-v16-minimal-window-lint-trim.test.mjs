/**
 * Tests cho coding agent v16 — minimal harness, file window, lint
 * gate, history trimmer, benchmark, agent (v1.38, Đội T4).
 *
 * Chạy thật: core thật trong bộ nhớ + file tạm (không gọi model/mạng).
 *   npm run build --workspace=@open-bot/core  (scoped, trong worktree)
 *   node --test tests/coding-v16-minimal-window-lint-trim.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CodingAgentV16,
  V16_MINIMAL_PREAMBLE,
  V16_MINIMAL_PREAMBLE_SECTIONS,
  renderV16BenchmarkReport,
  renderV16BenchmarkRerunReport,
  renderV16FileOutline,
  renderV16FileWindow,
  renderV16LintResult,
  renderV16MinimalReport,
  renderV16TrimResult,
  renderV16TrimRoundsResult,
  runV16Agent,
  runV16AgentResume,
  runV16Benchmark,
  runV16BenchmarkRerun,
  runV16Minimal,
  v16ApplyFileWrite,
  v16BuildDefaultPreamble,
  v16BuildPreamble,
  v16CheckJsonDuplicateKeys,
  v16FileOutline,
  v16GetWindow,
  v16LintAllowsWrite,
  v16LintContent,
  v16MinimalPreambleTokens,
  v16NewHistoryEntry,
  v16PageForLine,
  v16PreambleSavedVsFull,
  v16SearchInFile,
  v16ShouldTrim,
  v16TotalPages,
  v16TrimHistory,
  v16TrimUntilFit,
  v16ValidateMinimalStep,
  v16WindowAroundLine,
  v16WindowCenteredOnLine,
  v16AgentStateFromReport,
  v16BashStep,
  v16DoneStep,
} from '../packages/core/dist/index.js';

function entry(seq, role, text, extra = {}) {
  return { id: `e${seq}`, role, text, tokens: Math.ceil(text.length / 4), seq, at: 1000 + seq, ...extra };
}

test('preamble: compact (<1000 tokens) and builder drops optional sections over budget', () => {
  const tokens = v16MinimalPreambleTokens();
  assert.ok(tokens < 1000, `preamble ${tokens} tokens should be < 1000`);
  assert.ok(tokens > 50);
  assert.ok(V16_MINIMAL_PREAMBLE.includes('100-line windows'));
  assert.ok(v16PreambleSavedVsFull(tokens) > 15000);
  assert.equal(v16PreambleSavedVsFull(16600), 0);
  const full = v16BuildPreamble(V16_MINIMAL_PREAMBLE_SECTIONS, 1000);
  assert.ok(full.tokens < 1000);
  assert.ok(full.included.includes('role'));
  assert.ok(full.included.includes('tools'));
  const tiny = v16BuildPreamble(V16_MINIMAL_PREAMBLE_SECTIONS, 100);
  assert.ok(tiny.included.includes('role'));
  assert.ok(tiny.dropped.includes('tools'));
  assert.ok(tiny.dropped.includes('repo'));
  assert.ok(tiny.tokens <= 200);
  const def = v16BuildDefaultPreamble(1000, [
    { id: 'extra', text: 'Extra note.', required: false },
  ]);
  assert.ok(def.included.includes('extra'));
  assert.throws(() => v16BuildPreamble(V16_MINIMAL_PREAMBLE_SECTIONS, 0), /maxTokens/);
});

test('validate minimal step: rejects bad shapes', () => {
  assert.throws(() => v16ValidateMinimalStep(null, 0), /must be an object/);
  assert.throws(() => v16ValidateMinimalStep({ done: true }, 0), /\.text/);
  assert.throws(() => v16ValidateMinimalStep({ text: 'x' }, 0), /\.done/);
  assert.throws(
    () => v16ValidateMinimalStep({ text: 'x', done: false, fileWrite: { path: 'a.ts', kind: 'edit', content: 'y' } }, 0),
    /oldText/,
  );
  const ok = v16ValidateMinimalStep(
    { text: 'hi', done: true, bashCommand: 'ls', bashOutput: 'a', promptTokens: 5, completionTokens: 2 },
    0,
  );
  assert.equal(ok.bashCommand, 'ls');
});

test('apply file write: write/create/edit + exact-once rule', () => {
  assert.equal(v16ApplyFileWrite(null, { path: 'a.txt', kind: 'create', content: 'hi' }), 'hi');
  assert.equal(v16ApplyFileWrite('old', { path: 'a.txt', kind: 'write', content: 'new' }), 'new');
  assert.equal(
    v16ApplyFileWrite('hello world', { path: 'a.txt', kind: 'edit', content: 'there', oldText: 'world' }),
    'hello there',
  );
  assert.throws(
    () => v16ApplyFileWrite(null, { path: 'a.txt', kind: 'edit', content: 'x', oldText: 'y' }),
    /missing file/,
  );
  assert.throws(
    () => v16ApplyFileWrite('aaa', { path: 'a.txt', kind: 'edit', content: 'x', oldText: 'b' }),
    /not found/,
  );
  assert.throws(
    () => v16ApplyFileWrite('a a a', { path: 'a.txt', kind: 'edit', content: 'x', oldText: 'a' }),
    /exactly once/,
  );
  assert.throws(
    () => v16ApplyFileWrite('old', { path: 'a.txt', kind: 'create', content: 'x' }),
    /already exists/,
  );
});

test('minimal harness: bash steps + lint-blocked write + done + budget stop', () => {
  const { report, files } = runV16Minimal({
    runId: 'run-1',
    prompt: 'Fix the bug.',
    steps: [
      v16BashStep('Checking tests.', 'npm test', '2 passing'),
      { text: 'Writing fix.', done: false, fileWrite: { path: 'src/a.ts', kind: 'create', content: 'export const a = 1;\n' } },
      { text: 'Bad edit attempt.', done: false, fileWrite: { path: 'src/b.ts', kind: 'create', content: 'const x = {;\n' } },
      v16DoneStep('Done.'),
    ],
  });
  assert.equal(report.stepsRun, 4);
  assert.equal(report.done, true);
  assert.equal(report.lintBlocks, 1);
  assert.deepEqual(report.filesWritten, ['src/a.ts']);
  assert.equal(files.get('src/a.ts'), 'export const a = 1;\n');
  assert.equal(files.get('src/b.ts'), undefined);
  assert.ok(report.preambleTokens < 1000);
  assert.ok(report.preambleSavedVsFull > 15000);
  assert.equal(report.transcript.length, 5);
  assert.match(renderV16MinimalReport(report), /DONE/);
  // Budget stop: tiny budget halts after step 1.
  const stopped = runV16Minimal({
    runId: 'run-2',
    prompt: 'Long task.',
    steps: [v16BashStep('a', 'ls', 'x'), v16BashStep('b', 'ls', 'x'), v16DoneStep('c')],
    budgetTokens: 1,
  });
  assert.equal(stopped.report.done, false);
  assert.equal(stopped.report.stepsRun, 1);
  assert.throws(() => runV16Minimal({ runId: '', prompt: 'x', steps: [v16DoneStep('d')] }), /runId/);
  assert.throws(() => runV16Minimal({ runId: 'r', prompt: 'x', steps: [] }), /at least one/);
  assert.throws(
    () => runV16Minimal({ runId: 'r', prompt: 'x', steps: [v16DoneStep('d')], config: { maxPreambleTokens: 10 } }),
    /over maxPreambleTokens/,
  );
});

test('file window: pages, around/centered, search, outline', () => {
  const content = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join('\n');
  assert.equal(v16TotalPages(250, 100), 3);
  assert.equal(v16TotalPages(0, 100), 0);
  assert.equal(v16PageForLine(150, 100, 250), 2);
  assert.throws(() => v16PageForLine(251, 100, 250), /out of range/);
  const w1 = v16GetWindow('a.txt', content, 1);
  assert.equal(w1.startLine, 1);
  assert.equal(w1.endLine, 100);
  assert.equal(w1.totalPages, 3);
  assert.equal(w1.lines[0], 'line 1');
  assert.match(w1.numbered, /1\| line 1/);
  const w3 = v16GetWindow('a.txt', content, 3);
  assert.equal(w3.startLine, 201);
  assert.equal(w3.endLine, 250);
  assert.throws(() => v16GetWindow('a.txt', content, 4), /out of range/);
  const empty = v16GetWindow('e.txt', '', 1);
  assert.equal(empty.totalLines, 0);
  assert.equal(renderV16FileWindow(empty), 'e.txt: empty file (0 lines).');
  assert.match(renderV16FileWindow(w1), /lines 1-100 of 250/);
  const around = v16WindowAroundLine('a.txt', content, 150);
  assert.equal(around.page, 2);
  assert.equal(around.startLine, 101);
  const centered = v16WindowCenteredOnLine('a.txt', content, 150);
  assert.equal(centered.startLine, 100);
  assert.equal(centered.endLine, 199);
  const hits = v16SearchInFile(content, 'line 15');
  assert.ok(hits.length >= 10);
  assert.equal(hits[0]?.line, 15);
  assert.equal(hits[0]?.page, 1);
  assert.throws(() => v16SearchInFile(content, ''), /query/);
  const ci = v16SearchInFile('Foo\nfoo\nFOO', 'foo', { caseInsensitive: true });
  assert.equal(ci.length, 3);
  const cs = v16SearchInFile('Foo\nfoo\nFOO', 'foo');
  assert.equal(cs.length, 1);
});

test('file outline: TS classes/functions + markdown headings', () => {
  const ts = [
    'export class Foo {',
    '  method() { return 1; }',
    '}',
    'export function bar() { return 2; }',
    'export const baz = () => 3;',
    'export interface Qux { x: number; }',
  ].join('\n');
  const outline = v16FileOutline('a.ts', ts);
  assert.ok(outline.some((e) => e.kind === 'class' && e.name === 'Foo' && e.line === 1));
  assert.ok(outline.some((e) => e.kind === 'function' && e.name === 'bar'));
  assert.ok(outline.some((e) => e.kind === 'function' && e.name === 'baz'));
  assert.ok(outline.some((e) => e.kind === 'interface' && e.name === 'Qux'));
  assert.ok(outline.every((e) => e.page === 1));
  assert.match(renderV16FileOutline(outline, 'a.ts'), /outline entr/);
  const md = v16FileOutline('doc.md', '# Title\n\n## Section\ntext');
  assert.equal(md.length, 2);
  assert.equal(md[0]?.kind, 'heading');
  assert.equal(md[0]?.name, 'Title');
  assert.equal(v16FileOutline('data.json', '{"a": 1}').length, 0);
  assert.equal(renderV16FileOutline([], 'x.ts'), 'x.ts: no outline entries found.');
});

test('lint gate: JSON invalid/dup keys, delimiters, HTML tags, python indent, generic', () => {
  // Valid TS passes.
  const ok = v16LintContent('src/a.ts', 'export const a = 1;\n');
  assert.equal(ok.blocked, false);
  assert.equal(ok.language, 'ts');
  assert.equal(ok.errorCount, 0);
  assert.equal(v16LintAllowsWrite('src/a.ts', 'export const a = 1;\n'), true);
  // Unbalanced delimiter blocks.
  const bad = v16LintContent('src/b.ts', 'const x = { a: 1;\n');
  assert.equal(bad.blocked, true);
  assert.ok(bad.issues.some((i) => i.code === 'unbalanced-delimiter'));
  assert.match(renderV16LintResult(bad), /BLOCKED/);
  const extra = v16LintContent('src/c.ts', 'const x = 1; }\n');
  assert.equal(extra.blocked, true);
  // JSON invalid + duplicate keys.
  const badJson = v16LintContent('cfg.json', '{"a": 1, "a": 2}');
  assert.equal(badJson.blocked, true);
  assert.ok(badJson.issues.some((i) => i.code === 'json-duplicate-key'));
  assert.equal(v16CheckJsonDuplicateKeys('{"a": 1}').length, 0);
  const invalidJson = v16LintContent('cfg.json', '{"a": }');
  assert.equal(invalidJson.blocked, true);
  assert.ok(invalidJson.issues.some((i) => i.code === 'json-invalid'));
  // Unclosed string / comment.
  const str = v16LintContent('src/d.ts', 'const s = "oops;\n');
  assert.equal(str.blocked, true);
  assert.ok(str.issues.some((i) => i.code === 'unclosed-string'));
  const comment = v16LintContent('src/e.ts', '/* never closed\nconst a = 1;\n');
  assert.equal(comment.blocked, true);
  assert.ok(comment.issues.some((i) => i.code === 'unclosed-comment'));
  // HTML mismatched tags.
  const html = v16LintContent('index.html', '<div><span>hi</div>\n');
  assert.equal(html.blocked, true);
  assert.ok(html.issues.some((i) => i.code === 'html-mismatched-tag'));
  const htmlOk = v16LintContent('index.html', '<div><br><span>hi</span></div>\n');
  assert.equal(htmlOk.blocked, false);
  // Python mixed indent.
  const py = v16LintContent('a.py', 'def f():\n\treturn 1\n    return 2\n');
  assert.ok(py.issues.some((i) => i.code === 'python-mixed-indent-file'));
  // Markdown: no delimiter enforcement.
  assert.equal(v16LintContent('doc.md', '# Hi { unbalanced is fine\n').blocked, false);
  // Missing final newline = warning only.
  const warn = v16LintContent('src/f.ts', 'export const a = 1;');
  assert.equal(warn.blocked, false);
  assert.ok(warn.issues.some((i) => i.code === 'missing-final-newline'));
  assert.throws(() => v16LintContent('', 'x'), /path/);
});

test('history trimmer: keeps pinned + 5 recent tool outputs, summarizes trimmed part', () => {
  const entries = [
    entry(0, 'system', 'You are an agent.', { pinned: true }),
    entry(1, 'user', 'Fix bug.'),
    ...Array.from({ length: 8 }, (_, i) => entry(2 + i, 'tool', `tool output ${i} `.repeat(20), { toolName: 'bash' })),
    entry(10, 'model', 'Working on it.'),
    entry(11, 'user', 'Continue.'),
  ];
  const beforeTokens = entries.reduce((s, e) => s + e.tokens, 0);
  assert.equal(v16ShouldTrim(entries, { maxTokens: 100 }), true);
  assert.equal(v16ShouldTrim(entries, { maxTokens: 100000 }), false);
  const { kept, result } = v16TrimHistory(entries, { maxTokens: 100 });
  assert.ok(result.trimmedEntries > 0);
  assert.ok(result.tokensSaved > 0);
  assert.equal(result.summarized, true);
  assert.ok(result.summaryText?.includes('Trimmed'));
  assert.ok(kept.some((e) => e.pinned));
  const toolKept = kept.filter((e) => e.role === 'tool');
  assert.ok(toolKept.length <= 5);
  assert.ok(kept.some((e) => e.role === 'summary'));
  assert.ok(kept.some((e) => e.text === 'Continue.'));
  assert.match(renderV16TrimResult(result), /Trimmed/);
  // Under budget: no-op.
  const noTrim = v16TrimHistory(entries, { maxTokens: 100000 });
  assert.equal(noTrim.result.trimmedEntries, 0);
  assert.equal(noTrim.kept.length, entries.length);
  assert.equal(renderV16TrimResult(noTrim.result), `No trim needed: ${entries.length} entries, ${beforeTokens} tokens.`);
  assert.throws(() => v16TrimHistory(entries, { maxTokens: 0 }), /maxTokens/);
});

test('history trimmer: trim-until-fit rounds + still-over-budget', () => {
  const entries = [
    entry(0, 'system', 'System prompt that is pinned and long. '.repeat(10), { pinned: true }),
    ...Array.from({ length: 6 }, (_, i) => entry(1 + i, 'tool', `output ${i} `.repeat(30), { toolName: 'bash' })),
    entry(7, 'model', 'done'),
  ];
  const rounds = v16TrimUntilFit(entries, { maxTokens: 120 }, 3);
  assert.ok(rounds.roundsRun >= 1);
  assert.ok(rounds.totalTrimmedEntries > 0);
  assert.match(renderV16TrimRoundsResult(rounds), /round\(s\)/);
  // Pinned entry alone exceeds the budget -> still over.
  const pinnedOnly = [entry(0, 'system', 'x'.repeat(400), { pinned: true }), entry(1, 'model', 'y')];
  const stuck = v16TrimUntilFit(pinnedOnly, { maxTokens: 10 }, 2);
  assert.equal(stuck.stillOverBudget, true);
  assert.match(renderV16TrimRoundsResult(stuck), /Still over budget/);
  assert.throws(() => v16TrimUntilFit(entries, { maxTokens: 100 }, 0), /maxRounds/);
  const made = v16NewHistoryEntry({ role: 'user', text: 'hello' });
  assert.equal(made.role, 'user');
  assert.equal(made.tokens, 2);
});

test('benchmark: same tasks across harnesses, cost ratio + verdict', () => {
  const tasks = [
    {
      id: 'fix-auth',
      prompt: 'Fix auth bug.',
      expectedScore: 1,
      scripts: {
        minimal: [v16BashStep('check', 'npm test', 'pass'), v16DoneStep('done')],
        'claude-code': [
          v16BashStep('check', 'npm test', 'pass'),
          v16BashStep('check again', 'npm test', 'pass'),
          v16DoneStep('done'),
        ],
      },
    },
    {
      id: 'add-feature',
      prompt: 'Add feature.',
      expectedScore: 1,
      scripts: {
        minimal: [v16DoneStep('done')],
        'claude-code': [v16BashStep('x', 'ls', 'y'), v16DoneStep('done')],
      },
    },
  ];
  const report = runV16Benchmark({ tasks, model: 'claude-sonnet-4' });
  assert.equal(report.taskIds.length, 2);
  assert.deepEqual(report.harnessIds.sort(), ['claude-code', 'minimal']);
  assert.equal(report.preambleTokensByHarness['minimal'], 829);
  assert.equal(report.preambleTokensByHarness['claude-code'], 16600);
  // claude-code costs much more (preamble delta) at the same score.
  assert.ok((report.costAccuracy.maxCostRatio ?? 0) > 2);
  assert.equal(report.costAccuracy.maxScoreGap, 0);
  assert.match(report.verdict, /buys tokens, not accuracy/);
  assert.match(renderV16BenchmarkReport(report), /Benchmark v16/);
  assert.throws(() => runV16Benchmark({ tasks: [] }), /at least one task/);
  assert.throws(
    () => runV16Benchmark({ tasks: [{ id: '', prompt: 'x', expectedScore: 1, scripts: { minimal: [v16DoneStep('d')] } }] }),
    /id/,
  );
});

test('benchmark rerun: two runs, flakiness measured', () => {
  const tasks = [
    {
      id: 't1',
      prompt: 'Task one.',
      expectedScore: 1,
      scripts: { minimal: [v16DoneStep('done')], 'claude-code': [v16DoneStep('done')] },
    },
  ];
  const rerun = runV16BenchmarkRerun({ tasks });
  assert.equal(rerun.runs.length, 2);
  assert.equal(rerun.flakinessSummary.tasksRerun, 1);
  assert.equal(rerun.flakinessSummary.tasksFlipped, 0);
  assert.match(renderV16BenchmarkRerunReport(rerun), /Benchmark rerun/);
  assert.match(renderV16BenchmarkRerunReport(rerun), /No task was rerun|Flakiness/);
});

test('agent: end-to-end run + class run/resume + budget + cost record', () => {
  const report = runV16Agent({
    runId: 'agent-1',
    prompt: 'Fix it.',
    steps: [v16BashStep('test', 'npm test', 'pass'), v16DoneStep('done')],
    budget: { id: 'agent-1', limitTokens: 50000 },
  });
  assert.equal(report.done, true);
  assert.equal(report.stepsRun, 2);
  assert.equal(report.budget?.state, 'ok');
  assert.equal(report.cost?.harnessId, 'minimal');
  assert.equal(report.cost?.score, 1);
  assert.ok((report.cost?.costUsd ?? 0) > 0);
  assert.match(report.summary, /Minimal harness run agent-1/);
  const state = v16AgentStateFromReport(report);
  assert.equal(state.runId, 'agent-1');
  assert.equal(state.totalTokens, report.minimal.totalTokens);
  // Resume a done run is refused.
  assert.throws(
    () => runV16AgentResume({ resumeFrom: state, steps: [v16DoneStep('x')] }),
    /already done/,
  );
  // Class: run + resume an unfinished run.
  const agent = new CodingAgentV16();
  const first = agent.run({
    runId: 'class-1',
    prompt: 'Long task.',
    steps: [v16BashStep('step 1', 'ls', 'ok')],
  });
  assert.equal(first.done, false);
  assert.equal(agent.state('class-1')?.stepsRun, 1);
  const resumed = agent.resume({ runId: 'class-1', steps: [v16DoneStep('finished')] });
  assert.equal(resumed.done, true);
  assert.equal(resumed.stepsRun, 2);
  assert.equal(agent.budgetStatus('class-1')?.state, 'ok');
  assert.ok(agent.costReport().comparisons.length >= 1);
  assert.throws(() => agent.resume({ runId: 'missing', steps: [v16DoneStep('x')] }), /No saved state/);
  assert.equal(agent.forgetRun('class-1'), true);
  agent.reset();
  assert.equal(agent.runIds().length, 0);
  assert.throws(() => runV16Agent({ runId: 'x', prompt: 'y', steps: [v16DoneStep('d')], score: 2 }), /score/);
});
