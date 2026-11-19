/**
 * Test v1.44 T3: agent tools v2 — host dispatch for render / discover /
 * Tasks v2 / memory KG, plus tool definitions and i18n parity for the
 * mcpV144T3.* keys used by the two renderer components
 * (node:test, no network).
 *
 * Covers:
 *   - packages/core/src/mcp/mcpAppsV2Tools.ts
 *   - apps/desktop/src/renderer/components/McpAppsRenderV2.tsx
 *   - apps/desktop/src/renderer/components/McpTasksV2Panel.tsx
 *   - apps/desktop/src/renderer/i18n/locales/*.json (mcpV144T3.*)
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-v144-t3-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  McpAppsV2ToolHost,
  getMcpAppsV2ToolDefinitions,
  isMcpAppsV2ToolName,
  MCP_APPS_V2_TOOL_NAMES,
} from '../packages/core/dist/mcp/mcpAppsV2Tools.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = ['en', 'vi', 'zh', 'ja', 'fr', 'es'];

function readLocale(locale) {
  return JSON.parse(
    fs.readFileSync(path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales', `${locale}.json`), 'utf8'),
  );
}

function read(rel) {
  return fs.readFileSync(path.join(REPO, ...rel), 'utf8');
}

/** Keys the two v2 components use — direct t('...') calls AND the
 * status-key maps (SESSION_STATE_KEYS / JOB_STATUS_KEYS / ...). */
function usedKeys(source) {
  const direct = [...source.matchAll(/t\('([a-z][a-zA-Z0-9_]*\.[a-zA-Z0-9_.]+)'/g)].map((m) => m[1]);
  const literals = [...source.matchAll(/'(mcpV144T3\.[a-zA-Z0-9_.]+)'/g)].map((m) => m[1]);
  return [...new Set([...direct, ...literals])];
}

const TEMPLATE = {
  id: 'acme-card',
  serverName: 'acme',
  title: 'Acme card',
  allowedActions: ['tool-call', 'form-submit'],
};

const DESCRIPTOR = {
  version: 1,
  templateId: 'acme-card',
  root: {
    id: 'root',
    kind: 'container',
    children: [
      { id: 'pay', kind: 'button', text: 'Pay', action: { kind: 'tool-call', toolName: 'pay', args: {} } },
      {
        id: 'form1', kind: 'form', action: { kind: 'form-submit', toolName: 'save' },
        children: [{ id: 'note', kind: 'input', name: 'note', text: 'Note', value: 'hi' }],
      },
    ],
  },
};

function makeHost(kgPath) {
  // Offline executor: succeeds for every node except id 'boom'.
  const executor = async (node) => {
    if (node.id === 'boom') throw new Error('boom failed');
    return { done: node.id };
  };
  return new McpAppsV2ToolHost({
    executor,
    ...(kgPath ? { memoryKgPath: kgPath } : {}),
  });
}

test('tool definitions: 13 tools, unique names, valid JSON-schema params', () => {
  assert.equal(MCP_APPS_V2_TOOL_NAMES.length, 13);
  assert.equal(new Set(MCP_APPS_V2_TOOL_NAMES).size, 13);
  const defs = getMcpAppsV2ToolDefinitions();
  assert.equal(defs.length, 13);
  for (const def of defs) {
    assert.ok(isMcpAppsV2ToolName(def.name));
    assert.equal(typeof def.description, 'string');
    assert.ok(def.description.length > 20);
    assert.equal(def.parameters.type, 'object');
    assert.ok(Array.isArray(def.parameters.required));
  }
  assert.equal(isMcpAppsV2ToolName('mcp_apps_render_v2'), true);
  assert.equal(isMcpAppsV2ToolName('mcp_tasks_create'), false);
  assert.equal(isMcpAppsV2ToolName('nope'), false);
});

test('render tools: render -> action -> list -> close; bad descriptor rejected', async () => {
  const host = makeHost();
  const rendered = await host.runTool('mcp_apps_render_v2', { template: TEMPLATE, descriptor: DESCRIPTOR });
  assert.equal(rendered.ok, true);
  const sessionId = rendered.data.sessionId;
  assert.equal(typeof sessionId, 'string');
  assert.equal(rendered.data.snapshot.state, 'mounted');

  const action = await host.runTool('mcp_apps_render_v2_action', { sessionId, nodeId: 'pay' });
  assert.equal(action.ok, true);
  assert.equal(action.data.toolName, 'pay');

  const form = await host.runTool('mcp_apps_render_v2_action', { sessionId, nodeId: 'form1' });
  assert.equal(form.ok, true);
  assert.deepEqual(form.data.formValues, { note: 'hi' });

  const listed = await host.runTool('mcp_apps_render_v2_list', {});
  assert.equal(listed.data.sessions.length, 1);

  const bad = await host.runTool('mcp_apps_render_v2_action', { sessionId, nodeId: 'ghost' });
  assert.equal(bad.ok, false);

  const closed = await host.runTool('mcp_apps_render_v2_close', { sessionId });
  assert.equal(closed.ok, true);
  assert.equal((await host.runTool('mcp_apps_render_v2_list', {})).data.sessions.length, 0);

  const badDescriptor = await host.runTool('mcp_apps_render_v2', {
    template: TEMPLATE,
    descriptor: { version: 1, templateId: 'other', root: { id: 'r', kind: 'container' } },
  });
  assert.equal(badDescriptor.ok, false);

  const unknown = await host.runTool('mcp_nope', {});
  assert.equal(unknown.ok, false);
  assert.match(unknown.error ?? '', /không tồn tại/);
});

test('discover tool: ready server scores 100; unknown protocol is incompatible', async () => {
  const host = makeHost();
  const doc = {
    protocolVersion: '2026-07-28',
    capabilities: { tools: {}, tasks: { supported: true }, apps: { supported: true } },
    serverInfo: { name: 'acme', version: '1.0.0' },
    extensions: ['io.modelcontextprotocol/tasks'],
    tools: [{ name: 'search', description: 'Search' }],
  };
  const ok = await host.runTool('mcp_apps_discover_v2', { discover: doc });
  assert.equal(ok.ok, true);
  assert.equal(ok.data.verdict, 'ready');
  assert.equal(ok.data.score, 100);
  assert.equal(ok.data.tools.length, 1);

  const bad = await host.runTool('mcp_apps_discover_v2', {
    discover: { ...doc, protocolVersion: '1999-01-01' },
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.data.verdict, 'incompatible');

  const missing = await host.runTool('mcp_apps_discover_v2', {});
  assert.equal(missing.ok, false);
});

test('tasks v2 tools: submit DAG -> status -> retry failed node; duplicate job rejected', async () => {
  const host = makeHost();
  const submitted = await host.runTool('mcp_tasks_v2_submit', {
    jobId: 'job-1',
    tasks: [
      { id: 'a', serverName: 'acme', method: 'tools/call' },
      { id: 'boom', serverName: 'acme', method: 'tools/call', dependsOn: ['a'], maxAttempts: 1 },
      { id: 'c', serverName: 'acme', method: 'tools/call', dependsOn: ['boom'] },
    ],
  });
  assert.equal(submitted.ok, false); // partial: boom failed, c skipped
  assert.equal(submitted.data.status, 'partial');
  assert.equal(submitted.data.progress.done, 1);

  const status = await host.runTool('mcp_tasks_v2_status', { jobId: 'job-1' });
  assert.equal(status.ok, true);
  assert.equal(status.data.nodes.find((n) => n.id === 'c')?.status, 'skipped');

  // Retry keeps failing (executor always fails 'boom') -> still not completed.
  const retried = await host.runTool('mcp_tasks_v2_retry', { jobId: 'job-1', taskId: 'boom' });
  assert.equal(retried.ok, false);

  const dup = await host.runTool('mcp_tasks_v2_submit', {
    jobId: 'job-1',
    tasks: [{ id: 'x', serverName: 'acme', method: 'tools/call' }],
  });
  assert.equal(dup.ok, false);
  assert.match(dup.error ?? '', /đã tồn tại/);

  const unknown = await host.runTool('mcp_tasks_v2_status', { jobId: 'ghost' });
  assert.equal(unknown.ok, false);
  const cancelled = await host.runTool('mcp_tasks_v2_cancel', { jobId: 'ghost' });
  assert.equal(cancelled.ok, false);
});

test('tasks v2 tools: happy-path job completes and returns artifacts', async () => {
  const host = makeHost();
  const submitted = await host.runTool('mcp_tasks_v2_submit', {
    jobId: 'job-ok',
    tasks: [
      { id: 'a', serverName: 'acme', method: 'tools/call' },
      { id: 'b', serverName: 'acme', method: 'tools/call', dependsOn: ['a'] },
    ],
  });
  assert.equal(submitted.ok, true);
  assert.equal(submitted.data.status, 'completed');
  assert.equal(submitted.data.artifacts.length, 2);
});

test('tasks v2 tools: no transport and no executor -> clear error, not a crash', async () => {
  const host = new McpAppsV2ToolHost();
  const result = await host.runTool('mcp_tasks_v2_submit', {
    jobId: 'job-x',
    tasks: [{ id: 'a', serverName: 'acme', method: 'tools/call' }],
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /transport/);
});

test('tasks v2 tools: save + list persist jobs to the store dir', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-tools-store-'));
  const host = new McpAppsV2ToolHost({
    executor: async (node) => ({ done: node.id }),
    tasksV2StoreDir: dir,
  });
  const submitted = await host.runTool('mcp_tasks_v2_submit', {
    jobId: 'job-save',
    tasks: [{ id: 'a', serverName: 'acme', method: 'tools/call' }],
  });
  assert.equal(submitted.ok, true);

  const saved = await host.runTool('mcp_tasks_v2_save', { jobId: 'job-save' });
  assert.equal(saved.ok, true);
  assert.equal(saved.data.jobId, 'job-save');
  assert.equal(saved.data.status, 'completed');

  const listed = await host.runTool('mcp_tasks_v2_list', {});
  assert.equal(listed.ok, true);
  assert.equal(listed.data.count, 1);
  assert.equal(listed.data.jobs[0].jobId, 'job-save');

  // Host without a store dir reports a clear error instead of crashing.
  const bare = new McpAppsV2ToolHost({ executor: async () => 1 });
  assert.equal((await bare.runTool('mcp_tasks_v2_save', { jobId: 'x' })).ok, false);
  assert.equal((await bare.runTool('mcp_tasks_v2_list', {})).ok, false);
  assert.equal((await host.runTool('mcp_tasks_v2_save', { jobId: 'ghost' })).ok, false);
});

test('memory KG tools: remember -> recall; KG unconfigured -> clear error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-tools-'));
  const kgPath = path.join(dir, 'kg.jsonl');
  const host = makeHost(kgPath);
  const remembered = await host.runTool('mcp_memory_kg_remember', {
    text: 'Huy builds open-bot in Saigon',
    entities: [{ id: 'huy', label: 'Huy', kind: 'person' }],
  });
  assert.equal(remembered.ok, true);
  assert.equal(remembered.data.entityIds.length, 1);

  const recalled = await host.runTool('mcp_memory_kg_recall', { query: 'Huy open-bot' });
  assert.equal(recalled.ok, true);
  assert.ok(recalled.data.count >= 1);
  assert.ok(recalled.data.hits.some((h) => h.id === 'huy'));

  const noKg = new McpAppsV2ToolHost();
  assert.equal((await noKg.runTool('mcp_memory_kg_recall', { query: 'x' })).ok, false);
  assert.equal((await noKg.runTool('mcp_memory_kg_remember', { text: 'x' })).ok, false);
  assert.equal((await host.runTool('mcp_memory_kg_recall', {})).ok, false);
});

test('i18n: every mcpV144T3.* key used by the v2 components exists in all 6 locales', () => {
  const renderSrc = read(['apps', 'desktop', 'src', 'renderer', 'components', 'McpAppsRenderV2.tsx']);
  const panelSrc = read(['apps', 'desktop', 'src', 'renderer', 'components', 'McpTasksV2Panel.tsx']);
  const used = [...new Set([...usedKeys(renderSrc), ...usedKeys(panelSrc)])].sort();
  assert.ok(used.length >= 50, `expected >=50 used keys, got ${used.length}`);
  assert.ok(used.every((k) => k.startsWith('mcpV144T3.')), 'all used keys must be mcpV144T3.*');
  for (const locale of LOCALES) {
    const data = readLocale(locale);
    for (const key of used) {
      assert.ok(key in data, `${locale}: missing key ${key}`);
      assert.equal(typeof data[key], 'string');
      assert.ok(data[key].length > 0, `${locale}: empty value for ${key}`);
    }
  }
});

test('i18n: mcpV144T3.* key sets are identical across all 6 locales', () => {
  const sets = LOCALES.map((locale) => {
    const data = readLocale(locale);
    return new Set(Object.keys(data).filter((k) => k.startsWith('mcpV144T3.')));
  });
  for (let i = 1; i < sets.length; i += 1) {
    assert.deepEqual([...sets[i]].sort(), [...sets[0]].sort(), `${LOCALES[i]} key set differs from en`);
  }
  assert.equal(sets[0].size, 60);
});

test('components: no raw HTML rendering, no innerHTML, no direct core import in v2 components', () => {
  const renderSrc = read(['apps', 'desktop', 'src', 'renderer', 'components', 'McpAppsRenderV2.tsx']);
  const panelSrc = read(['apps', 'desktop', 'src', 'renderer', 'components', 'McpTasksV2Panel.tsx']);
  for (const [name, src] of [['McpAppsRenderV2', renderSrc], ['McpTasksV2Panel', panelSrc]]) {
    // Real usages only — the word "innerHTML" in a comment does not count.
    assert.ok(!src.includes('dangerouslySetInnerHTML'), `${name}: must not use dangerouslySetInnerHTML`);
    assert.ok(!/\.innerHTML\s*=/.test(src), `${name}: must not assign innerHTML`);
    assert.ok(!src.includes('@open-bot/core'), `${name}: presentational, must not import core`);
  }
  assert.ok(renderSrc.includes('useT()'), 'render component uses i18n');
  assert.ok(panelSrc.includes('useT()'), 'panel uses i18n');
});
