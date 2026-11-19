/**
 * Tests for memory v22 tools (v1.37, Doi T1).
 * packages/tools/src/memoryV22Tools.ts
 *
 * Run after building core + tools (memoryV22Tools only):
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/memory-v22-tools-v137.test.mjs
 * No network. No model.
 *
 * NOTE: chi import dist/memoryV22Tools.js (scoped) — khong import
 * dist/tools.js (ALL_TOOLS) vi build full tools can cac dep nang
 * (playwright/pdfjs/...); coordinator kiem tra ALL_TOOLS o luc gop.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MEMORY_V22_TOOLS,
  MEMORY_V22_TOOL_NAMES,
  createMemoryV22Tools,
} from '../packages/tools/dist/memoryV22Tools.js';
import { V22Dreamer } from '../packages/core/dist/memory/v22/index.js';

const NOW = 1794000000000;

function toolByName(tools, name) {
  const found = tools.find((t) => t.definition.name === name);
  assert.ok(found, `thieu tool ${name}`);
  return found;
}

function freshTools() {
  const dreamer = new V22Dreamer();
  const tools = createMemoryV22Tools({ dreamer });
  return { dreamer, tools };
}

async function run(tools, name, args) {
  const tool = toolByName(tools, name);
  return tool.execute(args);
}

test('v22 tools: 10 tools, ten duy nhat, needsApproval dung (ghi=true, doc=false)', () => {
  assert.equal(MEMORY_V22_TOOL_NAMES.length, 10);
  assert.equal(new Set(MEMORY_V22_TOOL_NAMES).size, 10);
  assert.equal(MEMORY_V22_TOOLS.length, 10);
  const byName = new Map(MEMORY_V22_TOOLS.map((t) => [t.definition.name, t]));
  assert.equal(byName.get('memory_v22_dream_status').needsApproval, false);
  assert.equal(byName.get('memory_v22_dream_report').needsApproval, false);
  assert.equal(byName.get('memory_v22_wiki').needsApproval, false);
  assert.equal(byName.get('memory_v22_budget').needsApproval, false);
  assert.equal(byName.get('memory_v22_audit').needsApproval, false);
  for (const name of [
    'memory_v22_dream',
    'memory_v22_dream_config',
    'memory_v22_fact',
    'memory_v22_snapshot',
    'memory_v22_rollback',
  ]) {
    assert.equal(byName.get(name).needsApproval, true, `${name} ghi nen can duyet`);
  }
  for (const tool of MEMORY_V22_TOOLS) {
    assert.equal(tool.definition.parameters.type, 'object');
    assert.ok(tool.definition.description.length > 10);
    assert.equal(typeof tool.execute, 'function');
  }
  assert.equal(createMemoryV22Tools({}).length, 10);
});

test('v22 tools: fact CRUD qua tool (create/get/list/setConfidence/history)', async () => {
  const { tools } = freshTools();
  const created = await run(tools, 'memory_v22_fact', {
    action: 'create',
    fact: JSON.stringify({
      text: 'User thich ca phe den.',
      topic: 'user|thich_uong',
      value: 'ca-phe-den',
      confidence: 0.9,
      tags: ['ca-phe'],
    }),
  });
  assert.match(created, /Da tao fact dream-fact-/);
  const id = created.match(/dream-fact-[0-9-]+/)[0];
  const got = await run(tools, 'memory_v22_fact', { action: 'get', id });
  const parsed = JSON.parse(got);
  assert.equal(parsed.text, 'User thich ca phe den.');
  assert.equal(parsed.topic, 'user|thich_uong');
  const listed = await run(tools, 'memory_v22_fact', { action: 'list', topic: 'user|thich_uong' });
  assert.match(listed, /ca phe den/);
  const updated = await run(tools, 'memory_v22_fact', { action: 'setConfidence', id, confidence: 0.95 });
  assert.match(updated, /0.95/);
  const history = await run(tools, 'memory_v22_fact', { action: 'history', id });
  assert.match(history, /#1/); // chua supersede: lich su chi co 1 buoc
  const missing = await run(tools, 'memory_v22_fact', { action: 'get', id: 'khong-co' });
  assert.match(missing, /^Error:/);
  const badKind = await run(tools, 'memory_v22_fact', {
    action: 'create',
    fact: JSON.stringify({ text: 'Hop le.', kind: 'khong-hop-le' }),
  });
  assert.match(badKind, /^Error:/);
});

test('v22 tools: dream chay that + report + wiki + budget + audit', async () => {
  const { dreamer, tools } = freshTools();
  // Seed: cap trung + fact het han.
  await run(tools, 'memory_v22_fact', {
    action: 'create',
    fact: JSON.stringify({ text: 'User thich ca phe den moi sang.', confidence: 0.9 }),
  });
  await run(tools, 'memory_v22_fact', {
    action: 'create',
    fact: JSON.stringify({ text: 'User thich ca phe den moi sang khong duong.', confidence: 0.7 }),
  });
  await run(tools, 'memory_v22_fact', {
    action: 'create',
    fact: JSON.stringify({ text: 'User dang o Ha Noi den 20/11.', validUntil: NOW - 86_400_000 }),
  });
  // Wiki chua co truoc dream.
  assert.match(await run(tools, 'memory_v22_wiki', { action: 'list' }), /Chua co wiki/);
  // Dry-run truoc: bao gop 1 + het han 1, khong ghi gi.
  const dry = await run(tools, 'memory_v22_dream', { trigger: 'manual', dryRun: true });
  assert.match(dry, /dry-run/);
  assert.match(dry, /gop 1/);
  assert.equal(dreamer.store.activeCount(), 3);
  // Chay that.
  const out = await run(tools, 'memory_v22_dream', { trigger: 'manual' });
  assert.match(out, /Dream dream-v22-/);
  assert.match(out, /gop 1, supersede 0, het han 1/);
  assert.match(out, /Snapshot: snap-/);
  assert.equal(dreamer.store.activeCount(), 1);
  // Report chi tiet (JSON day du).
  const reportJson = await run(tools, 'memory_v22_dream_report', { detail: true });
  const report = JSON.parse(reportJson);
  assert.equal(report.factsBefore, 3);
  assert.equal(report.factsAfter, 1);
  assert.equal(report.changes.length, 3); // merge + expire + wiki
  assert.ok(report.changes.every((c) => c.reason.length > 0));
  // Wiki co trang sau dream; budget vua ngan sach.
  const wiki = await run(tools, 'memory_v22_wiki', { action: 'list' });
  assert.match(wiki, /general/);
  const budget = await run(tools, 'memory_v22_budget', { includeText: true });
  assert.match(budget, /Always-loaded:/);
  assert.match(budget, /vua ngan sach/);
  assert.match(budget, /User thich ca phe den/);
  // Audit co dream:done.
  const audit = await run(tools, 'memory_v22_audit', { action: 'dream:done' });
  assert.match(audit, /dream:done/);
  // Status tom tat dung.
  const status = await run(tools, 'memory_v22_dream_status', {});
  assert.match(status, /Trang thai: done/);
  assert.match(status, /Fact: 3 tong \(1 active/);
});

test('v22 tools: config get/set + trigger sai + dreaming tat', async () => {
  const { tools } = freshTools();
  const before = await run(tools, 'memory_v22_dream_config', { action: 'get' });
  assert.equal(JSON.parse(before).stepsThreshold, 50);
  const set = await run(tools, 'memory_v22_dream_config', {
    action: 'set',
    config: JSON.stringify({ stepsThreshold: 100, maxCharsAlwaysLoaded: 2000 }),
  });
  assert.match(set, /Da cap nhat/);
  const after = await run(tools, 'memory_v22_dream_config', { action: 'get' });
  assert.equal(JSON.parse(after).stepsThreshold, 100);
  assert.equal(JSON.parse(after).maxCharsAlwaysLoaded, 2000);
  const bad = await run(tools, 'memory_v22_dream_config', {
    action: 'set',
    config: JSON.stringify({ stepsThreshold: 0 }),
  });
  assert.match(bad, /^Error:/);
  const badTrigger = await run(tools, 'memory_v22_dream', { trigger: 'khong-hop-le' });
  assert.match(badTrigger, /^Error:/);
  // Tat dreaming -> dream that bao loi ro, dry-run van chay.
  await run(tools, 'memory_v22_dream_config', { action: 'set', config: JSON.stringify({ enabled: false }) });
  const off = await run(tools, 'memory_v22_dream', { trigger: 'manual' });
  assert.match(off, /Dreaming dang tat/);
  const dryOff = await run(tools, 'memory_v22_dream', { trigger: 'manual', dryRun: true });
  assert.match(dryOff, /dry-run/);
});

test('v22 tools: snapshot create/list + rollback khoi phuc dung trang thai', async () => {
  const { dreamer, tools } = freshTools();
  await run(tools, 'memory_v22_fact', {
    action: 'create',
    fact: JSON.stringify({ text: 'User thich ca phe den.' }),
  });
  const empty = await run(tools, 'memory_v22_snapshot', { action: 'list' });
  assert.match(empty, /Chua co snapshot/);
  const created = await run(tools, 'memory_v22_snapshot', { action: 'create', reason: 'truoc khi sua tay' });
  const snapId = created.match(/snap-[0-9-]+/)[0];
  assert.match(created, /Da chup snapshot/);
  // Sua store, roi rollback -> ve 1 fact ban dau.
  await run(tools, 'memory_v22_fact', {
    action: 'create',
    fact: JSON.stringify({ text: 'Fact tam se bien mat.' }),
  });
  assert.equal(dreamer.store.size(), 2);
  const list = await run(tools, 'memory_v22_snapshot', { action: 'list' });
  assert.match(list, new RegExp(snapId));
  const rolled = await run(tools, 'memory_v22_rollback', { snapshotId: snapId });
  assert.match(rolled, /Da rollback/);
  assert.equal(dreamer.store.size(), 1);
  assert.match(dreamer.store.list()[0].text, /ca phe den/);
  const badRollback = await run(tools, 'memory_v22_rollback', { snapshotId: 'snap-khong-co' });
  assert.match(badRollback, /^Error:/);
});
