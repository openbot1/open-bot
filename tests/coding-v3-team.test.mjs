/**
 * Tests for coding agent v3 — manager/explorer/worker (v1.10, Đội T4):
 * `packages/core/src/codingV3/team.ts` (semaphore, explorer brief,
 * patch executor, manager split/run/aggregate).
 *
 * Manager with a fake executor (no LLM, no network); patch executor
 * runs for real in temp dirs. Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/coding-v3-team.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildCodingV2Graph,
} from '../packages/core/dist/codingV2/repoMapGraph.js';
import {
  applyCodingV3Edit,
  CodingV3Explorer,
  CodingV3Manager,
  CodingV3Semaphore,
  createCodingV3PatchExecutor,
  defaultCodingV3Splitter,
  resolveCodingV3EditPath,
  CODING_V3_DEFAULT_MAX_THREADS,
  CODING_V3_MAX_THREADS_CAP,
} from '../packages/core/dist/codingV3/team.js';

function tmpDir(t, prefix = 'coding-v3-team-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function fixtureGraph() {
  const files = [
    {
      relPath: 'src/a.ts',
      language: 'typescript',
      mtimeMs: 1000,
      size: 100,
      symbols: [{ kind: 'function', name: 'alpha', qualifiedName: 'alpha', line: 1, column: 1, endLine: 1 }],
      imports: [],
      hasError: false,
    },
    {
      relPath: 'src/b.ts',
      language: 'typescript',
      mtimeMs: 1000,
      size: 100,
      symbols: [{ kind: 'function', name: 'gamma', qualifiedName: 'gamma', line: 1, column: 1, endLine: 1 }],
      imports: ['src/a.ts'],
      hasError: false,
    },
  ];
  const idents = new Map([['src/b.ts', new Map([['alpha', 2]])]]);
  return { files, graph: buildCodingV2Graph({ files, idents }) };
}

// --- Semaphore ---------------------------------------------------------------

test('semaphore: caps concurrency and reports max observed', async () => {
  const sem = new CodingV3Semaphore(2);
  let running = 0;
  let maxSeen = 0;
  const work = async () => {
    const release = await sem.acquire();
    try {
      running += 1;
      maxSeen = Math.max(maxSeen, running);
      await new Promise((r) => setTimeout(r, 10));
      running -= 1;
    } finally {
      release();
    }
  };
  await Promise.all([work(), work(), work(), work(), work()]);
  assert.equal(maxSeen, 2);
  assert.equal(sem.maxObservedConcurrency, 2);
  assert.equal(sem.current, 0);
  assert.throws(() => new CodingV3Semaphore(0), /max threads/);
  assert.throws(() => new CodingV3Semaphore(1.5), /max threads/);
});

// --- Splitter ----------------------------------------------------------------

test('default splitter: one subtask per hinted file, one subtask when no files', () => {
  const split = defaultCodingV3Splitter({
    id: 't1',
    title: 'Do things',
    spec: 'spec',
    files: ['src/a.ts', 'src/b.ts'],
  });
  assert.equal(split.length, 2);
  assert.equal(split[0].id, 't1-1');
  assert.equal(split[1].id, 't1-2');
  assert.equal(split[0].status, 'pending');
  assert.equal(split[0].parentId, 't1');
  const single = defaultCodingV3Splitter({ id: 't2', title: 'No files', spec: 'spec' });
  assert.equal(single.length, 1);
  assert.equal(single[0].id, 't2-1');
});

// --- Manager with fake executor ----------------------------------------------

test('manager: runs workers in parallel under the cap and aggregates', async () => {
  let running = 0;
  let maxSeen = 0;
  const executor = async (subTask, { workerId }) => {
    running += 1;
    maxSeen = Math.max(maxSeen, running);
    await new Promise((r) => setTimeout(r, 15));
    running -= 1;
    return {
      subTaskId: subTask.id,
      workerId,
      success: true,
      summary: `did ${subTask.id}`,
      filesChanged: [{ path: 'x.ts', kind: 'write', linesAdded: 1, linesRemoved: 0 }],
      durationMs: 15,
    };
  };
  const manager = new CodingV3Manager({ maxConcurrentThreads: 2, executor });
  const result = await manager.run({
    id: 'task-1',
    title: 'Parallel task',
    spec: 'spec',
    files: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
  });
  assert.equal(result.status, 'done');
  assert.equal(result.subTasks.length, 4);
  assert.equal(result.results.length, 4);
  assert.equal(result.maxConcurrencyObserved, 2);
  assert.ok(maxSeen <= 2, `observed ${maxSeen} > cap 2`);
  assert.equal(result.filesChanged.length, 4);
  assert.equal(result.subTasks.every((s) => s.status === 'done'), true);
  assert.equal(new Set(result.subTasks.map((s) => s.claimedBy)).size, 4, 'each subtask claimed by one worker');
});

test('manager: a failing worker does not stop the team (partial status)', async () => {
  const executor = async (subTask, { workerId }) => {
    if (subTask.id.endsWith('-2')) {
      return { subTaskId: subTask.id, workerId, success: false, summary: 'boom', filesChanged: [], error: 'boom', durationMs: 1 };
    }
    return { subTaskId: subTask.id, workerId, success: true, summary: 'ok', filesChanged: [], durationMs: 1 };
  };
  const manager = new CodingV3Manager({ maxConcurrentThreads: 4, executor });
  const result = await manager.run({
    id: 'task-2',
    title: 'Partial task',
    spec: 'spec',
    files: ['a.ts', 'b.ts', 'c.ts'],
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.subTasks.filter((s) => s.status === 'done').length, 2);
  assert.equal(result.subTasks.filter((s) => s.status === 'failed').length, 1);
  assert.equal(result.subTasks.find((s) => s.id.endsWith('-2')).error, 'boom');
});

test('manager: executor crash becomes a failed subtask, not a crash', async () => {
  const executor = async () => {
    throw new Error('executor exploded');
  };
  const manager = new CodingV3Manager({ maxConcurrentThreads: 2, executor });
  const result = await manager.run({ id: 'task-3', title: 'Crash task', spec: 'spec' });
  assert.equal(result.status, 'failed');
  assert.equal(result.subTasks[0].status, 'failed');
  assert.match(result.subTasks[0].error, /executor exploded/);
});

test('manager: invalid maxConcurrentThreads rejected, cap applied', () => {
  assert.throws(() => new CodingV3Manager({ maxConcurrentThreads: 0 }), /maxConcurrentThreads/);
  assert.equal(new CodingV3Manager({ maxConcurrentThreads: 999 }).maxConcurrentThreads, CODING_V3_MAX_THREADS_CAP);
  assert.equal(new CodingV3Manager({}).maxConcurrentThreads, CODING_V3_DEFAULT_MAX_THREADS);
});

// --- Explorer ----------------------------------------------------------------

test('explorer: brief ranks the seed file first and reads hinted files', (t) => {
  const dir = tmpDir(t, 'coding-v3-explorer-');
  write(dir, 'src/a.ts', 'export function alpha() {\n  return 1;\n}\n');
  write(dir, 'src/b.ts', "import { alpha } from './a';\nexport function gamma() {\n  return alpha();\n}\n");
  const { files, graph } = fixtureGraph();
  const explorer = new CodingV3Explorer(graph, files, dir);
  const brief = explorer.brief('gamma');
  assert.equal(brief.relevantFiles[0].relPath, 'src/b.ts');
  assert.equal(brief.relevantFiles[0].match, 'seed');
  assert.equal(brief.filesRead.length, 2);
  assert.equal(brief.filesRead.find((f) => f.relPath === 'src/b.ts').lines, 5);
  assert.ok(brief.filesRead.find((f) => f.relPath === 'src/b.ts').preview.includes('gamma'));
  assert.deepEqual(brief.unreadableFiles, []);
  assert.ok(brief.generatedAt.length > 0);
});

test('explorer: unknown query falls back to global ranking and warns', () => {
  const { files, graph } = fixtureGraph();
  const explorer = new CodingV3Explorer(graph, files);
  const brief = explorer.brief('zzzzqqq');
  assert.ok(brief.risks.some((r) => r.includes('không khớp')));
  assert.ok(brief.relevantFiles.length > 0);
});

// --- Patch executor ------------------------------------------------------------

test('patch executor: create/write/edit/delete work for real in a temp dir', async (t) => {
  const dir = tmpDir(t, 'coding-v3-patch-');
  write(dir, 'src/old.ts', 'export const x = 1;\n');
  const executor = createCodingV3PatchExecutor();
  const run = async (id, edits) => {
    const subTask = { id, parentId: 'p', title: 't', spec: JSON.stringify({ edits }), status: 'pending' };
    return executor(subTask, { workerId: 'worker-1', rootDir: dir });
  };
  const created = await run('s1', [{ path: 'src/new.ts', kind: 'create', content: 'hello\n' }]);
  assert.equal(created.success, true);
  assert.equal(fs.readFileSync(path.join(dir, 'src/new.ts'), 'utf8'), 'hello\n');
  const edited = await run('s2', [{ path: 'src/old.ts', kind: 'edit', oldText: 'x = 1', newText: 'x = 2' }]);
  assert.equal(edited.success, true);
  assert.match(fs.readFileSync(path.join(dir, 'src/old.ts'), 'utf8'), /x = 2/);
  const written = await run('s3', [{ path: 'src/new.ts', kind: 'write', content: 'bye\n' }]);
  assert.equal(written.success, true);
  assert.equal(written.filesChanged[0].linesAdded, 2);
  const deleted = await run('s4', [{ path: 'src/new.ts', kind: 'delete' }]);
  assert.equal(deleted.success, true);
  assert.equal(fs.existsSync(path.join(dir, 'src/new.ts')), false);
});

test('patch executor: bad edits fail with a clear reason and stop at the bad edit', async (t) => {
  const dir = tmpDir(t, 'coding-v3-patch-bad-');
  write(dir, 'a.ts', 'const a = 1;\nconst a = 2;\n');
  const executor = createCodingV3PatchExecutor();
  const subTask = {
    id: 'bad-1',
    parentId: 'p',
    title: 't',
    spec: JSON.stringify({
      edits: [
        { path: 'a.ts', kind: 'edit', oldText: 'const a', newText: 'const b' },
        { path: 'missing.ts', kind: 'edit', oldText: 'x', newText: 'y' },
      ],
    }),
    status: 'pending',
  };
  const result = await executor(subTask, { workerId: 'worker-1', rootDir: dir });
  assert.equal(result.success, false);
  assert.match(result.error, /khớp nhiều chỗ/);
  assert.equal(result.filesChanged.length, 0, 'stops at the first bad edit');

  const noEdits = await executor(
    { id: 'bad-2', parentId: 'p', title: 't', spec: 'free text, no JSON edits', status: 'pending' },
    { workerId: 'worker-1', rootDir: dir },
  );
  assert.equal(noEdits.success, false);
  assert.equal(noEdits.error, 'no-edits');
});

test('edit path resolution: absolute paths and .. escapes are rejected', (t) => {
  const dir = tmpDir(t, 'coding-v3-escape-');
  assert.equal(resolveCodingV3EditPath(dir, '../outside.ts'), null);
  assert.equal(resolveCodingV3EditPath(dir, '/etc/passwd'), null);
  assert.equal(resolveCodingV3EditPath(dir, ''), null);
  assert.ok(resolveCodingV3EditPath(dir, 'src/a.ts')?.startsWith(dir));
  assert.throws(
    () => applyCodingV3Edit(dir, { path: '../evil.ts', kind: 'create', content: 'x' }),
    /thoát khỏi root/,
  );
});
