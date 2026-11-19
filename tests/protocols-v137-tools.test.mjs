/**
 * Tests for v1.37 (Team T2) — protocols v6 tools:
 * packages/tools/src/protocolV6Tools.ts
 * packages/tools/src/registry.ts (registerProtocolV6Tools)
 *
 * Covers:
 *  - 12 tools, unique names, object parameters, descriptions,
 *    registry registration (fresh ToolRegistry -> 12 tools),
 *    duplicate registration refused.
 *  - protocol_v6_negotiate / protocol_v6_versions: single family
 *    + all families + bad family + capabilities.
 *  - protocol_v6_acp_session: prompt returns a message id.
 *  - protocol_v6_acp_update: out-of-turn updates.
 *  - protocol_v6_acp_file_changes: propose / preview / apply /
 *    reject / conflict / rollback (needs approval).
 *  - protocol_v6_elicit_form / protocol_v6_elicit_url /
 *    protocol_v6_elicit_modes: form submit, URL callback,
 *    mode negotiation.
 *  - protocol_v6_a2a_stream_start / send / control: loopback
 *    two-way stream with echo agent, interrupt/resume/cancel.
 *  - protocol_v6_registry: Poppy watch-only, tested-with rows.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/protocols-v137-tools.test.mjs
 *
 * No network, no model. The tools are NOT wired into
 * defaultToolFactory yet (the coordinator wires them and re-pins
 * the totals at merge time, same as the v1.29 protocol v5 tools).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROTOCOL_V6_TOOLS,
  PROTOCOL_V6_TOOL_NAMES,
  createProtocolV6Tools,
  isProtocolV6ToolName,
} from '../packages/tools/dist/protocolV6Tools.js';
import { ToolRegistry } from '../packages/tools/dist/registry.js';
import {
  AcpV6FileChangeSet,
  AcpV6FileStore,
  AcpV6SessionEngine,
  ElicitationV6Manager,
  ProtocolV6Registry,
} from '../packages/core/dist/index.js';

function toolsByName(tools) {
  return Object.fromEntries(tools.map((t) => [t.definition.name, t]));
}

function boundTools() {
  const engine = new AcpV6SessionEngine({
    runner: async (_id, prompt) => ({ text: `Answer: ${prompt}` }),
  });
  const store = new AcpV6FileStore();
  store.put('src/a.ts', 'line1\nline2\nline3');
  const fileSet = new AcpV6FileChangeSet(store);
  const elicitation = new ElicitationV6Manager();
  const registry = new ProtocolV6Registry();
  const tools = createProtocolV6Tools({
    getSessionEngine: () => engine,
    getFileChangeSet: () => fileSet,
    getElicitationManager: () => elicitation,
    getRegistry: () => registry,
  });
  return { tools, byName: toolsByName(tools), engine, store, fileSet, elicitation, registry };
}

async function run(tool, args) {
  const out = await tool.execute(args);
  try {
    return JSON.parse(out);
  } catch {
    return out; // "Error: ..." results are plain strings, not JSON
  }
}

test('12 tools: unique names, object params, descriptions, registry registration', () => {
  assert.equal(PROTOCOL_V6_TOOL_NAMES.length, 12);
  assert.equal(new Set(PROTOCOL_V6_TOOL_NAMES).size, 12);
  assert.ok(PROTOCOL_V6_TOOL_NAMES.every((n) => n.startsWith('protocol_v6_')));
  assert.ok(PROTOCOL_V6_TOOL_NAMES.every((n) => isProtocolV6ToolName(n)));
  assert.equal(isProtocolV6ToolName('protocol_v5_negotiate'), false);
  assert.equal(PROTOCOL_V6_TOOLS.length, 12);
  assert.ok(PROTOCOL_V6_TOOLS.every((t) => t.execute));

  const { tools } = boundTools();
  assert.equal(tools.length, 12);
  for (const tool of tools) {
    assert.equal(typeof tool.definition.description, 'string');
    assert.ok(tool.definition.description.length > 20, tool.definition.name);
    assert.equal(tool.definition.parameters.type, 'object');
    assert.equal(typeof tool.execute, 'function');
  }
  // Only the file-changes tool mutates files, so only it needs approval.
  const byName = toolsByName(tools);
  assert.equal(byName['protocol_v6_acp_file_changes'].needsApproval, true);
  assert.equal(byName['protocol_v6_negotiate'].needsApproval, false);
  assert.equal(byName['protocol_v6_acp_session'].needsApproval, false);

  const registry = new ToolRegistry();
  registry.registerProtocolV6Tools();
  assert.equal(registry.list().length, 12);
  assert.throws(() => registry.registerProtocolV6Tools(), /already registered|duplicate/i);
});

test('negotiate + versions: single family, all families, bad family, capabilities', async () => {
  const { byName } = boundTools();
  const single = await run(byName['protocol_v6_negotiate'], { family: 'acp', serverVersions: ['1.0', '2.0-draft'] });
  assert.equal(single.negotiation.negotiated, '2.0-draft');
  assert.equal(single.negotiation.implemented, true);
  const poppy = await run(byName['protocol_v6_negotiate'], { family: 'poppy', serverVersions: ['1.0'] });
  assert.equal(poppy.negotiation.implemented, false);
  assert.match(poppy.negotiation.note, /watch-only/);
  const all = await run(byName['protocol_v6_negotiate'], {
    serverVersionsByFamily: { acp: ['2.0-draft'], a2a: ['1.1'], mcp: ['2026-07-28'] },
    peerCapabilities: { elicitationModes: ['form'], a2aTwoWayStreaming: true },
  });
  assert.equal(all.negotiations.a2a.negotiated, '1.1');
  assert.deepEqual(all.capabilities.elicitationModes, ['form']);
  assert.equal(all.capabilities.a2aTwoWayStreaming, true);
  assert.equal(all.capabilities.acpStructuredFileChanges, false);
  const bad = await run(byName['protocol_v6_negotiate'], { family: 'nope' });
  assert.match(JSON.stringify(bad), /Error: Unknown protocol family/);
  const versions = await run(byName['protocol_v6_versions'], {});
  assert.match(versions.summary, /acp 2\.0-draft/);
  assert.equal(versions.deprecationCalendar.length, 6);
  assert.ok(versions.changesSinceV5.length >= 5);
  assert.equal(versions.downgradeToV5.length, 6);
});

test('acp session: prompt returns a message id; update flows outside turns', async () => {
  const { byName } = boundTools();
  const created = await run(byName['protocol_v6_acp_session'], { action: 'new', agentId: 'agent-1', v1SessionId: 'v1-1' });
  assert.equal(created.session.runsParallelV1, true);
  const sessionId = created.sessionId;
  const prompted = await run(byName['protocol_v6_acp_session'], { action: 'prompt', sessionId, text: 'hello' });
  assert.match(prompted.messageId, /^acp6-msg-/);
  assert.equal(prompted.text, 'Answer: hello');
  const update = await run(byName['protocol_v6_acp_update'], {
    action: 'send', sessionId, kind: 'progress', payload: { pct: 10 }, messageId: prompted.messageId,
  });
  assert.equal(update.update.kind, 'progress');
  assert.equal(update.update.inReplyToMessageId, prompted.messageId);
  const forMessage = await run(byName['protocol_v6_acp_update'], { action: 'for-message', sessionId, messageId: prompted.messageId });
  assert.equal(forMessage.updates.length, 1);
  const acked = await run(byName['protocol_v6_acp_update'], { action: 'ack', sessionId, updateId: update.update.updateId });
  assert.equal(acked.acknowledged, true);
  const parallel = await run(byName['protocol_v6_acp_session'], { action: 'list-parallel' });
  assert.equal(parallel.sessions.length, 1);
  const replayed = await run(byName['protocol_v6_acp_session'], { action: 'replay', sessionId, messageId: prompted.messageId });
  assert.equal(replayed.messages.length, 2);
  const bad = await run(byName['protocol_v6_acp_session'], { action: 'prompt', sessionId: 'nope', text: 'x' });
  assert.match(JSON.stringify(bad), /Error: Unknown ACP session/);
});

test('file changes: propose, preview, apply, reject, conflict, rollback', async () => {
  const { byName, store } = boundTools();
  const session = await run(byName['protocol_v6_acp_session'], { action: 'new', agentId: 'agent-1' });
  const proposed = await run(byName['protocol_v6_acp_file_changes'], {
    action: 'propose',
    sessionId: session.sessionId,
    path: 'src/a.ts',
    kind: 'update',
    hunks: [
      { summary: 'Replace line2', ops: [{ op: 'replace', startLine: 2, endLine: 2, lines: ['line2-new'], expectedBefore: ['line2'] }] },
      { summary: 'Bad hunk', ops: [{ op: 'delete', startLine: 1, endLine: 1, expectedBefore: ['wrong'] }] },
      { summary: 'To reject', ops: [{ op: 'insert', afterLine: 3, lines: ['line4'] }] },
    ],
  });
  const changeId = proposed.change.changeId;
  const hunk1 = proposed.change.hunks[0].hunkId;
  const hunk2 = proposed.change.hunks[1].hunkId;
  const hunk3 = proposed.change.hunks[2].hunkId;
  const preview = await run(byName['protocol_v6_acp_file_changes'], { action: 'preview', changeId, hunkId: hunk1 });
  assert.equal(preview.preview.resultingContent, 'line1\nline2-new\nline3');
  const applied = await run(byName['protocol_v6_acp_file_changes'], { action: 'apply-hunk', changeId, hunkId: hunk1 });
  assert.equal(applied.applied, true);
  assert.equal(store.get('src/a.ts'), 'line1\nline2-new\nline3');
  const conflict = await run(byName['protocol_v6_acp_file_changes'], { action: 'apply-hunk', changeId, hunkId: hunk2 });
  assert.equal(conflict.applied, false);
  assert.match(conflict.reason ?? '', /expected/);
  const rejected = await run(byName['protocol_v6_acp_file_changes'], { action: 'reject-hunk', changeId, hunkId: hunk3, reason: 'no' });
  assert.equal(rejected.change.status, 'partially-applied'); // one hunk applied, one conflicted, one rejected
  const rolledBack = await run(byName['protocol_v6_acp_file_changes'], { action: 'rollback-change', changeId });
  assert.equal(rolledBack.rolledBack, 1);
  assert.equal(store.get('src/a.ts'), 'line1\nline2\nline3');
  const summary = await run(byName['protocol_v6_acp_file_changes'], { action: 'summary' });
  assert.equal(summary.summary.changes, 1);
  const v1 = await run(byName['protocol_v6_acp_file_changes'], {
    action: 'v1-diff', sessionId: session.sessionId, path: 'src/a.ts', oldText: 'line2', newText: 'line2-v1', content: 'line1\nline2\nline3',
  });
  assert.equal(v1.converted.ok, true);
  const bad = await run(byName['protocol_v6_acp_file_changes'], {
    action: 'propose', sessionId: session.sessionId, path: '../x.ts', kind: 'update', hunks: [],
  });
  assert.match(JSON.stringify(bad), /Error: Unsafe file path/);
});

test('elicitation: form submit + cancel, URL callback, mode negotiation', async () => {
  const { byName } = boundTools();
  const form = await run(byName['protocol_v6_elicit_form'], {
    action: 'create',
    sessionId: 's1',
    title: 'About you',
    fields: [{ id: 'name', label: 'Name', kind: 'text', required: true }],
  });
  const elicitationId = form.elicitation.elicitationId;
  const badSubmit = await run(byName['protocol_v6_elicit_form'], { action: 'submit', elicitationId, values: {} });
  assert.equal(badSubmit.ok, false);
  assert.ok(badSubmit.issues.length > 0);
  const goodSubmit = await run(byName['protocol_v6_elicit_form'], { action: 'submit', elicitationId, values: { name: 'Ada' } });
  assert.equal(goodSubmit.ok, true);
  assert.equal(goodSubmit.request.status, 'submitted');
  const sensitive = await run(byName['protocol_v6_elicit_form'], {
    action: 'create', sessionId: 's1', title: 'T',
    fields: [{ id: 'pw', label: 'P', kind: 'password' }],
  });
  assert.match(JSON.stringify(sensitive), /Error:.*sensitive/);
  const modes = await run(byName['protocol_v6_elicit_modes'], { preferred: 'url' });
  assert.equal(modes.negotiated, 'url');
  const modesBad = await run(byName['protocol_v6_elicit_modes'], {
    preferred: 'url', advertised: { modes: ['form'], maxFields: 5, canOpenExternalUrl: false },
  });
  assert.match(JSON.stringify(modesBad), /Error:.*not advertised/);

  const url = await run(byName['protocol_v6_elicit_url'], {
    action: 'create',
    sessionId: 's1',
    title: 'Finish outside',
    url: 'https://example.com/flow',
    fields: [{ id: 'choice', label: 'Choice', kind: 'select', required: true, options: [{ value: 'yes', label: 'Yes' }] }],
  });
  const token = url.elicitation.callbackToken;
  const completed = await run(byName['protocol_v6_elicit_url'], { action: 'complete', callbackToken: token, values: { choice: 'yes' } });
  assert.equal(completed.ok, true);
  const again = await run(byName['protocol_v6_elicit_url'], { action: 'complete', callbackToken: token, values: { choice: 'yes' } });
  assert.match(JSON.stringify(again), /Error:.*already-used/);
  const http = await run(byName['protocol_v6_elicit_url'], {
    action: 'create', sessionId: 's1', title: 'T', url: 'http://example.com/x',
    fields: [{ id: 'n', label: 'N', kind: 'text' }],
  });
  assert.match(JSON.stringify(http), /Error:.*https/);
});

test('a2a stream: start, input echo, interrupt/resume, cancel, frames, reassemble', async () => {
  const { byName } = boundTools();
  const started = await run(byName['protocol_v6_a2a_stream_start'], { taskId: 'task-1' });
  assert.equal(started.taskId, 'task-1');
  assert.equal(typeof started.resumeToken, 'string');
  const sent = await run(byName['protocol_v6_a2a_stream_send'], { action: 'input', taskId: 'task-1', text: 'do it' });
  assert.equal(sent.frame.kind, 'input');
  const frames = await run(byName['protocol_v6_a2a_stream_control'], { action: 'frames', taskId: 'task-1', side: 'client' });
  assert.ok(frames.frames.some((f) => f.kind === 'message' && String(f.payload['text']).includes('Echo')));
  const interrupted = await run(byName['protocol_v6_a2a_stream_send'], { action: 'interrupt', taskId: 'task-1', reason: 'wait' });
  assert.equal(interrupted.client.taskState, 'paused');
  const resumed = await run(byName['protocol_v6_a2a_stream_send'], { action: 'resume', taskId: 'task-1' });
  assert.equal(resumed.client.taskState, 'working');
  const artifact = await run(byName['protocol_v6_a2a_stream_control'], {
    action: 'reassemble', taskId: 'task-1', artifactId: 'art-1', content: 'hello artifact',
  });
  assert.equal(artifact.reassembled, 'hello artifact');
  assert.ok(artifact.chunks.length >= 1);
  const token = await run(byName['protocol_v6_a2a_stream_control'], { action: 'resume-token', taskId: 'task-1' });
  assert.equal(token.parsed.taskId, 'task-1');
  const cancelled = await run(byName['protocol_v6_a2a_stream_send'], { action: 'cancel', taskId: 'task-1', reason: 'done' });
  assert.equal(cancelled.client.taskState, 'cancelled');
  const listed = await run(byName['protocol_v6_a2a_stream_control'], { action: 'list' });
  assert.equal(listed.streams.length, 1);
  const again = await run(byName['protocol_v6_a2a_stream_start'], { taskId: 'task-1' });
  assert.match(JSON.stringify(again), /Error:.*already exists/);
  const unknown = await run(byName['protocol_v6_a2a_stream_send'], { action: 'input', taskId: 'nope', text: 'x' });
  assert.match(JSON.stringify(unknown), /Error:.*No A2A v6 stream/);
});

test('registry: poppy watch-only, compatibility, tested-with rows', async () => {
  const { byName } = boundTools();
  const poppy = await run(byName['protocol_v6_registry'], { action: 'poppy' });
  assert.equal(poppy.poppy.status, 'watch-only');
  assert.match(poppy.poppy.note, /not implemented/);
  const compat = await run(byName['protocol_v6_registry'], { action: 'compatibility' });
  assert.equal(compat.compatibility.length, 6);
  assert.equal(compat.compatibility.find((r) => r.family === 'poppy').implemented, false);
  const added = await run(byName['protocol_v6_registry'], {
    action: 'tested-add', peer: 'loopback', family: 'acp', version: '2.0-draft',
    testedOn: '2026-11-18', result: 'pass', coverage: 'prompt returns message id',
  });
  assert.match(added.row.rowId, /^tested6-/);
  const listed = await run(byName['protocol_v6_registry'], { action: 'tested-list', family: 'acp' });
  assert.equal(listed.rows.length, 1);
  const removed = await run(byName['protocol_v6_registry'], { action: 'tested-remove', rowId: added.row.rowId });
  assert.equal(removed.removed, true);
  const summary = await run(byName['protocol_v6_registry'], { action: 'summary' });
  assert.match(summary.summary, /Poppy watch-only/);
});
