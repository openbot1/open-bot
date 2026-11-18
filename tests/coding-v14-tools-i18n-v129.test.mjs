/**
 * Tests cho coding agent v14 tools + i18n (v1.29, Đội T3 lần 5).
 *
 * Chạy thật: tool execute thật trên thư mục tạm (RunLogStore +
 * sidecar + workspace file thật), không gọi model/mạng; i18n là
 * JSON thuần (không cần build).
 *   npm run build --workspace=@open-bot/core  (scoped, trong worktree)
 *   npm run build --workspace=@open-bot/tools (scoped, trong worktree)
 *   node --test tests/coding-v14-tools-i18n-v129.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ALL_TOOLS,
  CODING_V14_TOOLS,
  CODING_V14_TOOL_NAMES,
  createCodingV14Tools,
  createDefaultTools,
  isCodingV14ToolName,
} from '../packages/tools/dist/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-v14-tools-'));
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Không chặn test.
  }
}

function getTool(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `tool not found: ${name}`);
  return tool;
}

async function runTool(tool, args, ctx) {
  const raw = await tool.execute(args, ctx);
  assert.equal(typeof raw, 'string');
  if (raw.startsWith('Error:')) throw new Error(`tool ${tool.definition.name} failed: ${raw}`);
  return JSON.parse(raw);
}

/** Script agent: 1 edit + 1 done (ghi file thật vào workspace). */
function successSteps() {
  return [
    {
      text: 'Fixing auth.ts now.',
      reasoning: { kind: 'thinking', text: 'Add a null check before reading user.' },
      toolCalls: [
        {
          tool: 'edit_file',
          args: { path: 'src/auth.ts' },
          status: 'ok',
          outputPreview: 'edited src/auth.ts',
          fileChange: { path: 'src/auth.ts', kind: 'edit', beforeContent: 'old-login', afterContent: 'new-login' },
        },
      ],
      done: false,
    },
    { text: 'Done.', toolCalls: [], done: true },
  ];
}

/** Script agent: lặp cùng lỗi 4 lần rồi done (để test stuck/recover). */
function loopingSteps() {
  const steps = [];
  for (let i = 0; i < 4; i += 1) {
    steps.push({
      text: '',
      toolCalls: [
        {
          tool: 'run_tests',
          args: { path: 'src/auth.ts' },
          status: 'error',
          outputPreview: "TypeError: Cannot read properties of undefined (reading 'user')",
        },
      ],
      done: false,
    });
  }
  steps.push({ text: 'Gave up looping, reporting back.', toolCalls: [], done: true });
  return steps;
}

/* ================================================================== */
/* Đăng ký tools                                                       */
/* ================================================================== */

test('tools: 6 tool coding_v14_* trong ALL_TOOLS, không trùng, bind giữ nguyên số lượng', () => {
  assert.equal(CODING_V14_TOOLS.length, 6);
  assert.deepEqual([...CODING_V14_TOOL_NAMES], [
    'coding_v14_condense',
    'coding_v14_stuck_check',
    'coding_v14_recover',
    'coding_v14_reasoning',
    'coding_v14_agent',
    'coding_v14_resume',
  ]);
  for (const name of CODING_V14_TOOL_NAMES) {
    assert.ok(isCodingV14ToolName(name));
  }
  assert.equal(isCodingV14ToolName('coding_v14_nope'), false);
  const names = ALL_TOOLS.map((t) => t.definition.name);
  for (const name of CODING_V14_TOOL_NAMES) {
    assert.equal(names.filter((n) => n === name).length, 1, `${name} must appear exactly once in ALL_TOOLS`);
  }
  // Bind với base dir thật: vẫn đúng 6 tool, không nhân đôi.
  const base = tmpDir();
  try {
    const bound = createDefaultTools({ getCodingV14BaseDir: () => base });
    const boundNames = bound.map((t) => t.definition.name);
    for (const name of CODING_V14_TOOL_NAMES) {
      assert.equal(boundNames.filter((n) => n === name).length, 1, `${name} duplicated after bind`);
    }
    assert.equal(bound.length, ALL_TOOLS.length, 'bind không được thêm/bớt tool');
  } finally {
    cleanup(base);
  }
});

/* ================================================================== */
/* Tool execute thật                                                   */
/* ================================================================== */

test('coding_v14_agent + reasoning: chạy script thật, log/sidecar/journal đều có', async () => {
  const base = tmpDir();
  const workspace = path.join(base, 'ws');
  fs.mkdirSync(workspace, { recursive: true });
  try {
    const tools = createCodingV14Tools(() => base);
    const ctx = { workspaceDir: workspace };
    const agentTool = getTool(tools, 'coding_v14_agent');
    const out = await runTool(agentTool, {
      runId: 'tool-run-1',
      prompt: 'Fix auth.ts',
      stepsJson: JSON.stringify(successSteps()),
    }, ctx);
    assert.equal(out.report.outcome, 'completed');
    assert.equal(out.report.reasoningBlocks, 1);
    assert.deepEqual(out.report.filesChanged, ['src/auth.ts']);
    // File thật trong workspace đã đổi.
    assert.equal(fs.readFileSync(path.join(workspace, 'src/auth.ts'), 'utf8'), 'new-login');
    // Log + sidecar + journal thật trên đĩa.
    const dataDir = path.join(base, 'coding-v14');
    assert.ok(fs.existsSync(path.join(dataDir, 'run-logs', 'tool-run-1.jsonl')));
    assert.ok(fs.existsSync(path.join(dataDir, 'reasoning', 'tool-run-1.reasoning.jsonl')));
    assert.ok(fs.existsSync(path.join(dataDir, 'tool-run-1.journal.json')));

    // Reasoning tool: đọc + verify sidecar và digest.
    const reasoningTool = getTool(tools, 'coding_v14_reasoning');
    const r = await runTool(reasoningTool, { runId: 'tool-run-1' }, ctx);
    assert.equal(r.totalBlocks, 1);
    assert.equal(r.chain.ok, true);
    assert.equal(r.verification.ok, true);
    assert.equal(r.verification.matched, 1);
    assert.equal(r.blocks[0].kind, 'thinking');
  } finally {
    cleanup(base);
  }
});

test('coding_v14_stuck_check + recover rollback: loop lỗi rồi rollback file thật', async () => {
  const base = tmpDir();
  const workspace = path.join(base, 'ws');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'auth.ts'), 'original', 'utf8');
  try {
    const tools = createCodingV14Tools(() => base);
    const ctx = { workspaceDir: workspace };
    // Agent script: sửa file rồi lặp lỗi.
    const steps = [
      {
        text: 'Editing then testing.',
        toolCalls: [
          {
            tool: 'edit_file',
            args: { path: 'src/auth.ts' },
            status: 'ok',
            outputPreview: 'edited',
            fileChange: { path: 'src/auth.ts', kind: 'edit', beforeContent: 'original', afterContent: 'broken-edit' },
          },
        ],
        done: false,
      },
      ...loopingSteps().slice(0, 4),
      { text: 'Done looping.', toolCalls: [], done: true },
    ];
    const agentTool = getTool(tools, 'coding_v14_agent');
    const out = await runTool(agentTool, {
      runId: 'tool-run-2',
      prompt: 'Break then loop',
      stepsJson: JSON.stringify(steps),
    }, ctx);
    assert.equal(fs.readFileSync(path.join(workspace, 'src', 'auth.ts'), 'utf8'), 'broken-edit');
    assert.ok(out.report.stuckReports.length >= 1);

    // Stuck check đọc log từ đĩa → stuck.
    const stuckTool = getTool(tools, 'coding_v14_stuck_check');
    const stuck = await runTool(stuckTool, { runId: 'tool-run-2' }, ctx);
    assert.equal(stuck.report.stuck, true);
    assert.ok(stuck.report.signals.some((s) => s.kind === 'repeat_error'));

    // Recover với rollback_last_edit → file về 'original', journal undone.
    const recoverTool = getTool(tools, 'coding_v14_recover');
    const rec = await runTool(recoverTool, { runId: 'tool-run-2', strategy: 'rollback_last_edit' }, ctx);
    assert.equal(rec.result.strategy, 'rollback_last_edit');
    assert.equal(rec.result.applied, true);
    assert.equal(fs.readFileSync(path.join(workspace, 'src', 'auth.ts'), 'utf8'), 'original');
    const journal = JSON.parse(fs.readFileSync(path.join(base, 'coding-v14', 'tool-run-2.journal.json'), 'utf8'));
    assert.ok(journal.every((e) => e.undone), 'journal phải đánh dấu undone sau rollback');
  } finally {
    cleanup(base);
  }
});

test('coding_v14_condense: force=true nén được log nhỏ; không force thì báo chưa cần', async () => {
  const base = tmpDir();
  const workspace = path.join(base, 'ws');
  fs.mkdirSync(workspace, { recursive: true });
  try {
    const tools = createCodingV14Tools(() => base);
    const ctx = { workspaceDir: workspace };
    const agentTool = getTool(tools, 'coding_v14_agent');
    await runTool(agentTool, {
      runId: 'tool-run-3',
      prompt: 'Small task',
      stepsJson: JSON.stringify(successSteps()),
    }, ctx);
    const condenseTool = getTool(tools, 'coding_v14_condense');
    const notNeeded = await runTool(condenseTool, { runId: 'tool-run-3' }, ctx);
    assert.equal(notNeeded.needed, false);
    const forced = await runTool(condenseTool, { runId: 'tool-run-3', force: true }, ctx);
    assert.ok(forced.condensation.markerSeq > 0);
    assert.equal(forced.condensation.eventsCovered, 9, 'agent run nhỏ có đúng 9 event');
    assert.equal(forced.condensation.fromSeq, 0);
    assert.ok(fs.existsSync(path.join(base, 'coding-v14', 'run-logs', 'tool-run-3.v14condense.json')));
    // Condense lần nữa không force → đã compact hết, báo chưa cần.
    const again = await runTool(condenseTool, { runId: 'tool-run-3' }, ctx);
    assert.equal(again.needed, false);
  } finally {
    cleanup(base);
  }
});

test('coding_v14_resume: chạy tiếp từ resumeState, reasoning cũ còn nguyên', async () => {
  const base = tmpDir();
  const workspace = path.join(base, 'ws');
  fs.mkdirSync(workspace, { recursive: true });
  try {
    const tools = createCodingV14Tools(() => base);
    const ctx = { workspaceDir: workspace };
    const agentTool = getTool(tools, 'coding_v14_agent');
    const first = await runTool(agentTool, {
      runId: 'tool-run-4',
      prompt: 'Two-part task',
      stepsJson: JSON.stringify([
        {
          text: 'Part one done.',
          reasoning: { kind: 'plan', text: 'Plan: part one then part two.' },
          toolCalls: [],
          done: false,
        },
      ]),
      maxSteps: 1,
    }, ctx);
    assert.equal(first.report.outcome, 'max_steps');
    assert.equal(first.report.reasoningBlocks, 1);

    const resumeTool = getTool(tools, 'coding_v14_resume');
    const second = await runTool(resumeTool, {
      resumeStateJson: JSON.stringify(first.report.resumeState),
      stepsJson: JSON.stringify([{ text: 'Part two done.', toolCalls: [], done: true }]),
    }, ctx);
    assert.equal(second.report.outcome, 'completed');
    assert.equal(second.report.reasoningBlocks, 1, 'reasoning cũ phải còn sau resume');
    assert.equal(second.report.resumeState.nextStep, 2);

    // Lỗi arg: run không tồn tại / JSON sai → trả "Error:" chứ không throw.
    const stuckTool = getTool(tools, 'coding_v14_stuck_check');
    const raw = await stuckTool.execute({ runId: 'no-such-run' }, ctx);
    assert.match(raw, /^Error: /);
    const bad = await agentTool.execute({ runId: 'x', prompt: 'y', stepsJson: 'not json' }, ctx);
    assert.match(bad, /^Error: /);
  } finally {
    cleanup(base);
  }
});
