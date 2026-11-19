/**
 * Test v1.44 T3 (part 2): Tasks v2 job store, memory KG export/import,
 * render session serialize/restore (node:test, no network).
 *
 * Covers:
 *   - packages/core/src/mcp/tasksV2Store.ts
 *   - packages/core/src/mcp/memoryKgJsonl.ts (export/import)
 *   - packages/core/src/mcp/appsRenderV2.ts (toJSON/fromJSON)
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-v144-t3-store-export.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { declareAppTemplate } from '../packages/core/dist/mcp/appsV2.js';
import {
  AppRenderSession,
  validateAppUiDescriptor,
} from '../packages/core/dist/mcp/appsRenderV2.js';
import {
  MemoryKgJsonl,
  exportEventsToJson,
  parseExportedEvents,
} from '../packages/core/dist/mcp/memoryKgJsonl.js';
import { TaskV2Orchestrator } from '../packages/core/dist/mcp/tasksV2.js';
import {
  TaskV2JobStore,
  TasksV2StoreError,
  parseTaskV2Snapshot,
  stringifyTaskV2Snapshot,
} from '../packages/core/dist/mcp/tasksV2Store.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v144-t3-'));
}

const okExecutor = async (node) => ({ done: node.id });

async function makeDoneJob(jobId) {
  const job = new TaskV2Orchestrator(jobId, okExecutor, { concurrency: 2 });
  job.addTask({ id: 'a', serverName: 's', method: 'tools/call' });
  job.addTask({ id: 'b', serverName: 's', method: 'tools/call', dependsOn: ['a'] });
  await job.runAll();
  return job;
}

test('store: save -> exists -> loadSnapshot -> loadJob resumes; list/delete', async () => {
  const dir = tmpDir();
  const store = new TaskV2JobStore(dir);
  assert.equal(await store.exists('job-1'), false);
  assert.deepEqual(await store.list(), []);

  const job = await makeDoneJob('job-1');
  const entry = await store.save(job);
  assert.equal(entry.jobId, 'job-1');
  assert.equal(entry.status, 'completed');
  assert.equal(entry.nodes, 2);
  assert.equal(entry.done, 2);
  assert.equal(await store.exists('job-1'), true);

  const snap = await store.loadSnapshot('job-1');
  assert.equal(snap.version, 1);
  assert.equal(snap.nodes.length, 2);
  assert.equal(stringifyTaskV2Snapshot(snap).includes('"job-1"'), true);

  const loaded = await store.loadJob('job-1', okExecutor);
  assert.equal(loaded.getNode('a')?.status, 'completed');
  assert.deepEqual(loaded.getArtifactForTask('b')?.result, { done: 'b' });

  const entries = await store.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.jobId, 'job-1');

  assert.equal(await store.delete('job-1'), true);
  assert.equal(await store.delete('job-1'), false);
  assert.equal(await store.exists('job-1'), false);
  await assert.rejects(() => store.loadSnapshot('job-1'), TasksV2StoreError);
});

test('store: bad job id, corrupt file, pruneFinished only touches old finished jobs', async () => {
  const dir = tmpDir();
  const store = new TaskV2JobStore(dir);
  await assert.rejects(() => store.saveSnapshot({
    version: 1, jobId: '../escape', nodes: [], artifacts: [], status: 'idle', createdAt: 0, updatedAt: 0,
  }), /Job id không hợp lệ/);

  const job = await makeDoneJob('job-old');
  await store.save(job);
  // Corrupt the file by hand.
  fs.writeFileSync(path.join(dir, 'job-old.tasks-v2.json'), '{not json');
  await assert.rejects(() => store.loadSnapshot('job-old'), /JSON/);
  await assert.rejects(() => store.list(), /snapshot hỏng/);

  // Fresh store: prune keeps recent jobs, deletes old finished ones.
  const dir2 = tmpDir();
  const store2 = new TaskV2JobStore(dir2);
  const job2 = await makeDoneJob('job-new');
  await store2.save(job2);
  assert.deepEqual(await store2.pruneFinished(1000, Date.now() + 500), []);
  assert.deepEqual(await store2.pruneFinished(1000, Date.now() + 2000), ['job-new']);
  assert.deepEqual(await store2.list(), []);

  assert.throws(() => parseTaskV2Snapshot('{}'), /hình dạng/);
  assert.throws(() => parseTaskV2Snapshot('nope'), /JSON/);
  assert.throws(() => new TaskV2JobStore(''), /thư mục/);
});

test('memory KG: exportJson -> importJson into a fresh log replays the same facts', async () => {
  const dir = tmpDir();
  const src = new MemoryKgJsonl(path.join(dir, 'a.jsonl'));
  await src.load();
  await src.remember({
    text: 'Huy builds open-bot',
    entities: [{ id: 'huy', label: 'Huy', kind: 'person' }],
  });
  const exported = await src.exportJson();
  const parsed = parseExportedEvents(exported);
  assert.equal(parsed.length, 2); // entity.add + note.add

  const dst = new MemoryKgJsonl(path.join(dir, 'b.jsonl'));
  await dst.load();
  const result = await dst.importJson(exported);
  assert.equal(result.imported, 2);
  const hits = await dst.recall('Huy');
  assert.ok(hits.some((h) => h.kind === 'entity' && h.id === 'huy'));
  assert.equal((await dst.stats()).events, 2);
});

test('memory KG: export helpers reject corrupt exports', () => {
  assert.throws(() => parseExportedEvents('nope'), /JSON/);
  assert.throws(() => parseExportedEvents('{"version":2,"events":[]}'), /hình dạng/);
  assert.throws(() => parseExportedEvents('{"version":1,"events":[{"seq":1}]}'), /ts|seq|object|label/);
  const good = exportEventsToJson([], 1234);
  assert.equal(JSON.parse(good).version, 1);
  assert.deepEqual(parseExportedEvents(good), []);
});

test('render session: toJSON/fromJSON round-trip keeps state, inputs and counters', () => {
  const template = declareAppTemplate({
    id: 'card', serverName: 'acme', title: 'Card', allowedActions: ['tool-call', 'form-submit'],
  });
  const descriptor = {
    version: 1,
    templateId: 'card',
    root: {
      id: 'root', kind: 'container',
      children: [
        { id: 'pay', kind: 'button', text: 'Pay', action: { kind: 'tool-call', toolName: 'pay' } },
        {
          id: 'form1', kind: 'form', action: { kind: 'form-submit', toolName: 'save' },
          children: [{ id: 'note', kind: 'input', name: 'note', text: 'Note', value: 'hi' }],
        },
      ],
    },
  };
  const validated = validateAppUiDescriptor(descriptor, template);
  assert.ok(validated.descriptor);
  const session = new AppRenderSession('s-1', template, validated.descriptor);
  session.mount();
  session.setInput('note', 'restored-value');
  session.dispatchAction('pay');
  session.suspend();

  const json = session.toJSON();
  assert.equal(json.snapshot.state, 'suspended');
  assert.equal(json.snapshot.actionCount, 1);

  const restored = AppRenderSession.fromJSON(JSON.parse(JSON.stringify(json)), template);
  assert.equal(restored.sessionId, 's-1');
  assert.equal(restored.state, 'suspended');
  assert.equal(restored.getInputs().note, 'restored-value');
  assert.equal(restored.snapshot().actionCount, 1);
  restored.resume();
  assert.equal(restored.state, 'mounted');
  assert.equal(restored.dispatchAction('pay').ok, true);
});

test('render session: fromJSON rejects bad data, mismatched template, stale descriptor', () => {
  const template = declareAppTemplate({
    id: 'card', serverName: 'acme', title: 'Card', allowedActions: ['tool-call'],
  });
  const other = declareAppTemplate({
    id: 'other', serverName: 'acme', title: 'Other', allowedActions: ['tool-call'],
  });
  const descriptor = {
    version: 1, templateId: 'card',
    root: { id: 'root', kind: 'container', children: [{ id: 'b', kind: 'button', text: 'B' }] },
  };
  const validated = validateAppUiDescriptor(descriptor, template);
  assert.ok(validated.descriptor);
  const session = new AppRenderSession('s-2', template, validated.descriptor);
  session.mount();
  const json = session.toJSON();

  assert.throws(() => AppRenderSession.fromJSON(null, template), /không hợp lệ/);
  // Mismatched snapshot: descriptor belongs to `other` (validates fine)
  // but the snapshot claims template `card` -> template-mismatch error.
  const otherDescriptor = {
    version: 1, templateId: 'other',
    root: { id: 'root', kind: 'container', children: [{ id: 'b', kind: 'button', text: 'B' }] },
  };
  const otherValidated = validateAppUiDescriptor(otherDescriptor, other);
  assert.ok(otherValidated.descriptor);
  const otherSession = new AppRenderSession('s-3', other, otherValidated.descriptor);
  otherSession.mount();
  const otherJson = otherSession.toJSON();
  otherJson.snapshot.templateId = 'card';
  assert.throws(() => AppRenderSession.fromJSON(otherJson, other), /không phải/);
  const tampered = JSON.parse(JSON.stringify(json));
  tampered.descriptor.root.children.push({ id: 'evil', kind: 'button', text: 'E', action: { kind: 'form-submit', toolName: 'x' } });
  assert.throws(() => AppRenderSession.fromJSON(tampered, template), /không còn hợp lệ/);
});
