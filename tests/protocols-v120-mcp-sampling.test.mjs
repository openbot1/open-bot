/**
 * Protocols v4 — MCP sampling cleanup tests (v1.20, Team T2).
 *
 * Covers packages/core/src/protocolsV4/mcpSamplingV4.ts: the
 * surface audit (methods + capabilities), the capability
 * stripper, the migration guard (warn mode warns once, strict
 * mode refuses with the replacement), and the elicitation
 * replacement builder (human-answerable question -> MRTR
 * input_required round; model-only sampling -> refuse and say
 * to call the provider directly).
 *
 * No network, no provider: everything runs in-process against
 * the built core dist.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v120-mcp-sampling.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MCP_SAMPLING_V4_REMOVAL_FLOOR,
  McpSamplingV4MigrationGuard,
  auditMcpSurfaceV4,
  buildElicitationReplacementV4,
  isDeprecatedMcpMethodV4,
  samplingReplacementForV4,
  stripDeprecatedCapabilitiesV4,
} from '../packages/core/dist/index.js';

test('audit flags sampling/roots/logging methods and capabilities; clean surfaces pass', () => {
  const dirty = auditMcpSurfaceV4({
    methods: ['sampling/createMessage', 'tools/call', 'roots/list'],
    capabilities: ['sampling', 'tools'],
  });
  assert.equal(dirty.clean, false);
  assert.deepEqual(
    dirty.findings.map((f) => f.surface),
    ['roots/list', 'sampling', 'sampling/createMessage'],
  );
  assert.ok(dirty.findings.every((f) => f.removeAfter === MCP_SAMPLING_V4_REMOVAL_FLOOR));
  assert.match(dirty.summary, /3 deprecated/);

  // The same surface twice (method + capability) is reported once per kind, not duplicated.
  const capOnly = auditMcpSurfaceV4({ capabilities: { sampling: {}, logging: {} } });
  assert.deepEqual(capOnly.findings.map((f) => f.surface), ['logging', 'sampling']);

  const clean = auditMcpSurfaceV4({ methods: ['tools/call', 'prompts/get'], capabilities: ['tools'] });
  assert.equal(clean.clean, true);
  assert.deepEqual(clean.findings, []);
  assert.match(clean.summary, /clean/);

  // Unknown methods are ignored (they may be extensions).
  assert.equal(auditMcpSurfaceV4({ methods: ['acme/custom'] }).clean, true);
});

test('replacement table names the durable replacement; current methods return null', () => {
  const sampling = samplingReplacementForV4('sampling/createMessage');
  assert.ok(sampling);
  assert.match(sampling.replacement, /directly/);
  assert.match(sampling.replacement, /input_required/);

  const roots = samplingReplacementForV4('roots/list');
  assert.ok(roots);
  assert.match(roots.replacement, /local configuration|_meta/);

  const elicitation = samplingReplacementForV4('elicitation/create');
  assert.ok(elicitation);
  assert.match(elicitation.replacement, /needs_elicitation/);
  assert.match(elicitation.replacement, /NOT deprecated/);

  assert.equal(samplingReplacementForV4('tools/call'), null);
  assert.equal(isDeprecatedMcpMethodV4('sampling/createMessage'), true);
  assert.equal(isDeprecatedMcpMethodV4('tools/call'), false);
});

test('capability stripper drops sampling/roots/logging, keeps the rest, does not mutate', () => {
  const input = { sampling: {}, roots: {}, logging: {}, tools: { listChanged: true }, elicitation: {} };
  const { kept, stripped } = stripDeprecatedCapabilitiesV4(input);
  assert.deepEqual(stripped, ['logging', 'roots', 'sampling']);
  assert.deepEqual(Object.keys(kept).sort(), ['elicitation', 'tools']);
  assert.deepEqual(kept['tools'], { listChanged: true });
  assert.deepEqual(Object.keys(input).sort(), ['elicitation', 'logging', 'roots', 'sampling', 'tools']);
});

test('migration guard warn mode: warns once, delegates, counts', async () => {
  const warnings = [];
  const guard = new McpSamplingV4MigrationGuard(
    async (params) => ({ echoed: params }),
    { onWarning: (m) => warnings.push(m), serverName: 'sys' },
  );
  const first = await guard.call({ prompt: 'hi' });
  assert.deepEqual(first, { echoed: { prompt: 'hi' } });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /sampling\/createMessage/);
  assert.match(warnings[0], /deprecated/);

  await guard.call({ prompt: 'again' });
  assert.equal(warnings.length, 1, 'warns exactly once');
  const report = guard.report();
  assert.equal(report.calls, 2);
  assert.equal(report.warned, true);
  assert.equal(report.strict, false);
  assert.match(report.replacement, /directly/);
});

test('migration guard strict mode refuses with the replacement; bad handler rejected', async () => {
  const guard = new McpSamplingV4MigrationGuard(async () => 'never', { strict: true, serverName: 'sys' });
  await assert.rejects(guard.call({}), /strict mode/);
  await assert.rejects(guard.call({}), /sampling\/createMessage is disabled/);
  assert.equal(guard.report().calls, 2);
  assert.equal(guard.report().strict, true);

  assert.throws(
    () => new McpSamplingV4MigrationGuard(null),
    /needs a legacy sampling handler/,
  );
});

test('elicitation replacement: human question -> input_required round', () => {
  const built = buildElicitationReplacementV4({
    userQuestion: 'Which folder should I save this in?',
    prompt: 'pick a folder',
  });
  assert.equal(built.ok, true);
  if (built.ok) {
    assert.equal(built.replacement.need, 'input_required');
    assert.deepEqual(built.replacement.schema.required, ['answer']);
    assert.equal(built.replacement.message, 'Which folder should I save this in?');
    assert.equal(built.replacement.schema.properties.answer.type, 'string');
  }
});

test('elicitation replacement: model-only sampling has no user replacement', () => {
  const noQuestion = buildElicitationReplacementV4({ prompt: 'summarise this', maxTokens: 100 });
  assert.equal(noQuestion.ok, false);
  if (!noQuestion.ok) assert.match(noQuestion.reason, /Call the LLM provider API directly/);

  const tooLong = buildElicitationReplacementV4({ userQuestion: 'x'.repeat(2001) });
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.match(tooLong.reason, /too long/);
});
