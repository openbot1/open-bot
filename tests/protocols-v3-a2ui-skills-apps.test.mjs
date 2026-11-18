/**
 * Tests for v1.19 (Team T3) — protocols v3, part 4:
 * packages/core/src/protocolsV3/a2uiV3.ts
 * packages/core/src/protocolsV3/skillsMcpV3.ts
 * packages/core/src/protocolsV3/mcpAppsV3.ts
 *
 * Covers:
 *  - A2UI v3: 8 new kinds + fallbacks + default props, binding
 *    path resolution, action validation (https-only links,
 *    declared tools only, no code-ish keys), tree validation
 *    (unknown component, bad layout, depth + node caps, oversize
 *    text prop, invalid state), binding application, catalog
 *    render/update/answer/dismiss/expire/supersede lifecycle.
 *  - Skills over MCP v3: version comparison, multi-server catalog
 *    (priority wins, loser recorded in the winner's `shadowedBy`
 *    — regression test for the discover fix), search, load gated
 *    by user approval (missing / denied / allowed), invocation
 *    plans + placeholder filling, catalog diff, usage counters.
 *  - MCP Apps v3: lifecycle transitions, capabilities, default
 *    quotas, install/activate/suspend/resume/uninstall, per-app +
 *    per-surface permissions (template allowlist as default),
 *    surface open/hide/show/close + surface quota, prefetch +
 *    action quotas (suspend on breach), audit trail.
 *
 * No network, no model. Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v3-a2ui-skills-apps.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  A2UI_V3_COMPONENT_KINDS,
  A2UI_V3_FALLBACK_KINDS,
  A2UI_V3_MAX_TEXT_PROP,
  A2UI_V3_MAX_TREE_DEPTH,
  A2UI_V3_MAX_TREE_NODES,
  A2UI_V3_NEW_KINDS,
  A2UI_V3_VERSION,
  A2uiV3Catalog,
  A2uiV3Error,
  a2uiV3DefaultProps,
  applyA2uiV3Bindings,
  isA2uiV3ComponentKind,
  resolveA2uiV3BindingPath,
  validateA2uiV3Action,
  validateA2uiV3Tree,
} from '../packages/core/dist/protocolsV3/a2uiV3.js';
import {
  SKILLS_MCP_V3_MAX_BODY_CHARS,
  SKILLS_MCP_V3_MAX_CATALOG,
  SKILLS_MCP_V3_VERSION,
  SkillsMcpV3Catalog,
  SkillsMcpV3Error,
  compareSkillVersions,
} from '../packages/core/dist/protocolsV3/skillsMcpV3.js';
import { SkillsMcpServer, SkillActivationGate } from '../packages/core/dist/protocolsV2/skillsMcp.js';
import {
  MCP_APPS_V3_DEFAULT_ACTIONS_PER_MINUTE,
  MCP_APPS_V3_DEFAULT_PREFETCH_BYTES,
  MCP_APPS_V3_MAX_SURFACES_PER_APP,
  MCP_APPS_V3_TRANSITIONS,
  MCP_APPS_V3_VERSION,
  MCP_APP_V3_CAPABILITIES,
  McpAppsV3Error,
  McpAppsV3Manager,
  defaultMcpAppV3Quotas,
  isMcpAppV3Capability,
  isMcpAppV3TransitionAllowed,
} from '../packages/core/dist/protocolsV3/mcpAppsV3.js';

// ---------------------------------------------------------------------------
// A2UI v3: kinds, props, fallbacks
// ---------------------------------------------------------------------------

test('v3 a2ui: 8 new kinds, fallbacks, default props', () => {
  assert.equal(A2UI_V3_VERSION, '1.0');
  assert.deepEqual([...A2UI_V3_NEW_KINDS], [
    'tabs', 'stepper', 'timeline', 'kanban', 'media', 'code', 'markdown', 'metric',
  ]);
  for (const kind of A2UI_V3_NEW_KINDS) {
    assert.equal(isA2uiV3ComponentKind(kind), true, kind);
    assert.ok(A2UI_V3_COMPONENT_KINDS.includes(kind), kind);
    const props = a2uiV3DefaultProps(kind);
    assert.ok(props.length > 0, kind);
    assert.ok(props.some((p) => p.required), `${kind} has a required prop`);
  }
  assert.equal(isA2uiV3ComponentKind('nope'), false);
  assert.equal(isA2uiV3ComponentKind('card'), true); // v1.15 kind still known
  assert.deepEqual(A2UI_V3_FALLBACK_KINDS, {
    tabs: 'list',
    stepper: 'progress',
    timeline: 'list',
    kanban: 'table',
    media: 'card',
    code: 'message',
    markdown: 'message',
    metric: 'card',
  });
  assert.deepEqual(
    a2uiV3DefaultProps('metric').map((p) => p.name),
    ['label', 'value', 'delta'],
  );
  assert.deepEqual(
    a2uiV3DefaultProps('stepper').map((p) => p.name),
    ['steps', 'currentStep'],
  );
});

test('v3 a2ui: binding path resolution', () => {
  const state = { user: { name: 'Huy', tags: ['a'] }, count: 3 };
  assert.equal(resolveA2uiV3BindingPath(state, 'user.name'), 'Huy');
  assert.equal(resolveA2uiV3BindingPath(state, 'count'), 3);
  assert.deepEqual(resolveA2uiV3BindingPath(state, 'user.tags'), ['a']); // array as a final value is fine
  assert.equal(resolveA2uiV3BindingPath(state, 'user.missing'), undefined);
  assert.equal(resolveA2uiV3BindingPath(state, ''), undefined);
  assert.equal(resolveA2uiV3BindingPath(state, 'user.name.first'), undefined);
  assert.equal(resolveA2uiV3BindingPath(state, 'user.tags.0'), undefined); // cannot descend through an array
});

test('v3 a2ui: action validation', () => {
  assert.deepEqual(validateA2uiV3Action({ kind: 'submit', label: 'OK' }), []);
  assert.deepEqual(validateA2uiV3Action({ kind: 'dismiss' }), []);
  assert.deepEqual(validateA2uiV3Action({ kind: 'select', value: 'a' }), []);
  assert.deepEqual(validateA2uiV3Action({ kind: 'open-link', url: 'https://example.test/x' }), []);
  assert.deepEqual(validateA2uiV3Action({ kind: 'tool-call', toolName: 'read_file' }, ['read_file']), []);
  assert.equal(validateA2uiV3Action(null).length, 1);
  assert.match(validateA2uiV3Action({ kind: 'explode' })[0], /unknown action kind/);
  assert.match(
    validateA2uiV3Action({ kind: 'open-link', url: 'http://example.test/x' })[0],
    /https URL/,
  );
  assert.match(
    validateA2uiV3Action({ kind: 'tool-call', toolName: 'shell_exec' }, ['read_file'])[0],
    /undeclared tool/,
  );
  assert.match(validateA2uiV3Action({ kind: 'tool-call' })[0], /needs a toolName/);
  assert.match(validateA2uiV3Action({ kind: 'select' })[0], /needs a string value/);
  assert.match(
    validateA2uiV3Action({ kind: 'submit', onClick: 'evil()' })[0],
    /must not carry "onClick"/,
  );
});

// ---------------------------------------------------------------------------
// A2UI v3: tree validation + catalog
// ---------------------------------------------------------------------------

function v3Catalog() {
  return new A2uiV3Catalog(['read_file']);
}

function markdownNode(text = '# Hi') {
  return { kind: 'component', componentId: 'v3-markdown', state: { text } };
}

test('v3 a2ui: tree validation (good + every bad shape)', () => {
  const catalog = v3Catalog();
  const lookup = (id) => catalog.get(id);

  assert.deepEqual(validateA2uiV3Tree(markdownNode(), lookup), []);
  assert.deepEqual(validateA2uiV3Tree({
    kind: 'stack',
    children: [markdownNode(), { kind: 'component', componentId: 'v3-metric', state: { label: 'U', value: '1' } }],
  }, lookup), []);
  assert.deepEqual(validateA2uiV3Tree({
    kind: 'grid', columns: 2, children: [markdownNode()],
  }, lookup), []);

  const bad = [
    [{ kind: 'component', componentId: 'v3-nope', state: {} }, /Unknown component/],
    [{ kind: 'component', state: {} }, /needs a componentId/],
    [{ kind: 'component', componentId: 'v3-markdown', state: { text: '# x' }, children: [] }, /must not have children/],
    [{ kind: 'component', componentId: 'v3-markdown', state: {} }, /required prop "text" is missing/],
    [{ kind: 'component', componentId: 'v3-markdown', state: { text: 42 } }, /must be string/],
    [{ kind: 'component', componentId: 'v3-markdown', state: { text: 'x'.repeat(A2UI_V3_MAX_TEXT_PROP + 1) } }, /exceeds 50000 chars/],
    [{ kind: 'grid', children: [markdownNode()] }, /columns as an integer 1..6/],
    [{ kind: 'grid', columns: 7, children: [markdownNode()] }, /columns as an integer 1..6/],
    [{ kind: 'stack', children: [] }, /needs a non-empty children array/],
    [{ kind: 'weird' }, /Unknown render node kind/],
    [null, /must be an object/],
  ];
  for (const [tree, pattern] of bad) {
    const problems = validateA2uiV3Tree(tree, lookup);
    assert.ok(problems.length > 0, JSON.stringify(tree));
    assert.ok(problems.some((p) => pattern.test(p)), `${JSON.stringify(tree)} -> ${problems.join('; ')}`);
  }

  // Depth cap: 6 nested stacks exceed max depth 4.
  let deep = markdownNode();
  for (let i = 0; i < 6; i++) deep = { kind: 'stack', children: [deep] };
  assert.ok(validateA2uiV3Tree(deep, lookup).some((p) => /max depth 4/.test(p)));
  assert.equal(A2UI_V3_MAX_TREE_DEPTH, 4);

  // Node cap: 33 components in one stack exceed 32.
  const wide = {
    kind: 'stack',
    children: Array.from({ length: A2UI_V3_MAX_TREE_NODES }, () => markdownNode()),
  };
  assert.ok(validateA2uiV3Tree(wide, lookup).some((p) => /exceeds 32 nodes/.test(p)));
  assert.equal(A2UI_V3_MAX_TREE_NODES, 32);
});

test('v3 a2ui: apply bindings fills bound props only', () => {
  const out = applyA2uiV3Bindings(
    { text: 'old', other: 1 },
    [{ prop: 'text', path: 'title' }, { prop: 'missing', path: 'nope' }],
    { title: 'Hello' },
  );
  assert.deepEqual(out, { text: 'Hello', other: 1 });
});

test('v3 a2ui catalog: components, render + surface lifecycle', () => {
  const catalog = v3Catalog();
  const v3 = catalog.list().filter((c) => c.componentId.startsWith('v3-'));
  assert.equal(v3.length, 8);
  const tabs = catalog.get('v3-tabs');
  assert.equal(tabs.kind, 'tabs');
  assert.equal(tabs.fallbackKind, 'list');
  assert.equal(catalog.get('v3-nope'), null);

  catalog.register({ componentId: 'custom-card', kind: 'card', props: [], description: 'Custom.' });
  assert.equal(catalog.get('custom-card').description, 'Custom.');

  const { surface, frame } = catalog.renderSurface({
    surfaceId: 's1',
    runId: 'r1',
    title: 'Report',
    tree: { kind: 'stack', children: [markdownNode('placeholder')] },
    bindings: [{ prop: 'text', path: 'title' }],
    actions: [{ kind: 'submit', label: 'OK' }],
    runState: { title: '# Real title' },
  });
  assert.equal(surface.status, 'rendered');
  assert.equal(surface.stateVersion, 1);
  assert.equal(surface.tree.children[0].state.text, '# Real title');
  assert.equal(frame.surfaceId, 's1');
  assert.equal(frame.blocking, false);
  assert.equal(catalog.getSurface('s1').surfaceId, 's1');
  assert.equal(catalog.listSurfaces().length, 1);

  assert.throws(
    () => catalog.renderSurface({ surfaceId: 's1', runId: 'r1', title: 'Dup', tree: markdownNode() }),
    (err) => err instanceof A2uiV3Error && err.code === 'DUPLICATE_SURFACE',
  );
  assert.throws(
    () => catalog.renderSurface({ surfaceId: 's2', runId: 'r1', title: 'Bad', tree: { kind: 'component', componentId: 'v3-nope' } }),
    (err) => err instanceof A2uiV3Error && err.code === 'INVALID_TREE',
  );
  assert.throws(
    () => catalog.renderSurface({
      surfaceId: 's3', runId: 'r1', title: 'Bad action', tree: markdownNode(),
      actions: [{ kind: 'tool-call', toolName: 'shell_exec' }],
    }),
    (err) => err instanceof A2uiV3Error && err.code === 'INVALID_ACTION',
  );

  const updated = catalog.updateSurfaceState('s1', { title: '# Second title' });
  assert.equal(updated.status, 'updated');
  assert.equal(updated.stateVersion, 2);
  assert.equal(updated.tree.children[0].state.text, '# Second title');

  const answered = catalog.answerSurface('s1', { choice: 'OK' });
  assert.equal(answered.status, 'answered');
  assert.throws(
    () => catalog.updateSurfaceState('s1', { title: 'x' }),
    (err) => err instanceof A2uiV3Error && err.code === 'BAD_STATUS',
  );
  assert.throws(
    () => catalog.answerSurface('nope', {}),
    (err) => err instanceof A2uiV3Error && err.code === 'NO_SUCH_SURFACE',
  );

  catalog.renderSurface({ surfaceId: 's2', runId: 'r1', title: 'Two', tree: markdownNode() });
  assert.equal(catalog.dismissSurface('s2').status, 'dismissed');
  catalog.renderSurface({ surfaceId: 's3', runId: 'r1', title: 'Three', tree: markdownNode() });
  assert.equal(catalog.expireSurface('s3').status, 'expired');
  catalog.renderSurface({ surfaceId: 's4', runId: 'r1', title: 'Four', tree: markdownNode() });
  assert.equal(catalog.supersedeSurface('s3', 's4').status, 'superseded');
  assert.throws(
    () => catalog.supersedeSurface('s3', 'nope'),
    (err) => err instanceof A2uiV3Error && err.code === 'NO_SUCH_SURFACE',
  );
});

// ---------------------------------------------------------------------------
// Skills over MCP v3
// ---------------------------------------------------------------------------

const SKILL_MD = `---
name: code-review
description: Review code changes for bugs and style when the user asks for a review.
version: 1.0.0
allowed-tools: [read_file, grep_search]
---
# Code review
Review the diff carefully.
`;

const SKILL_MD_V2 = `---
name: code-review
description: Review code changes for bugs and style when the user asks for a review.
version: 2.0.0
allowed-tools: [read_file, grep_search]
---
# Code review v2
Review the diff carefully, v2 edition.
`;

const SUMMARIZE_MD = `---
name: summarize
description: Summarize a long document into bullet points.
version: 0.5.0
---
# Summarize
Summarize the input.
`;

function twoServerCatalog() {
  const s1 = new SkillsMcpServer();
  s1.register('code-review', SKILL_MD, 'builtin');
  const s2 = new SkillsMcpServer();
  s2.register('code-review', SKILL_MD_V2, 'user');
  s2.register('summarize', SUMMARIZE_MD, 'user');
  const catalog = new SkillsMcpV3Catalog();
  catalog.addServer({ serverId: 's1', serverName: 'Builtin', priority: 1, server: s1 });
  catalog.addServer({ serverId: 's2', serverName: 'User', priority: 2, server: s2 });
  return { catalog, s1, s2 };
}

test('v3 skills: version comparison', () => {
  assert.equal(SKILLS_MCP_V3_VERSION, '1.1.0');
  assert.equal(SKILLS_MCP_V3_MAX_CATALOG, 1000);
  assert.equal(SKILLS_MCP_V3_MAX_BODY_CHARS, 100_000);
  assert.equal(compareSkillVersions('1.0.0', '1.0.1'), -1);
  assert.equal(compareSkillVersions('1.0.1', '1.0.0'), 1);
  assert.equal(compareSkillVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareSkillVersions(undefined, '1.0.0'), -1);
  assert.equal(compareSkillVersions('2.0.0', '1.9.9'), 1);
  assert.equal(compareSkillVersions(undefined, undefined), 0);
});

test('v3 skills: servers, discover merge, priority + shadowedBy', () => {
  const { catalog } = twoServerCatalog();
  assert.equal(catalog.list().length, 0);
  assert.equal(catalog.getLastDiscoveredAt(), null);
  assert.deepEqual(catalog.listServers().map((s) => s.serverId), ['s1', 's2']);

  assert.throws(
    () => catalog.addServer({ serverId: 's1', serverName: 'Dup', priority: 3, server: new SkillsMcpServer() }),
    (err) => err instanceof SkillsMcpV3Error && err.code === 'DUPLICATE_SERVER',
  );

  const merged = catalog.discover();
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((e) => e.name), ['code-review', 'summarize']);
  const review = catalog.get('code-review');
  // Priority wins: the builtin server's v1.0.0, not the user's v2.0.0.
  assert.equal(review.serverId, 's1');
  assert.equal(review.version, '1.0.0');
  // ...and the conflict is visible: the winner records the loser.
  assert.equal(review.shadowedBy, 's2');
  assert.equal(catalog.get('summarize').serverId, 's2');
  assert.equal(catalog.get('nope'), null);
  assert.ok(catalog.getLastDiscoveredAt());
  assert.deepEqual(catalog.search('review').map((e) => e.name), ['code-review']);
  assert.deepEqual(catalog.search('SUMMARIZE').map((e) => e.name), ['summarize']);
  assert.equal(catalog.search('').length, 2);

  assert.equal(catalog.removeServer('s2'), true);
  assert.equal(catalog.removeServer('s2'), false);
  assert.deepEqual(catalog.discover().map((e) => e.name), ['code-review']);
});

test('v3 skills: load is gated by user approval', () => {
  const { catalog } = twoServerCatalog();
  catalog.discover();
  assert.throws(
    () => catalog.load('nope'),
    (err) => err instanceof SkillsMcpV3Error && err.code === 'UNKNOWN_SKILL',
  );
  assert.throws(
    () => catalog.load('code-review'),
    (err) => err instanceof SkillsMcpV3Error && err.code === 'NOT_APPROVED'
      && /no approval recorded/.test(err.message),
  );

  const gate = catalog.getGate();
  const entry = catalog.get('code-review');
  gate.approve('code-review', entry.contentHash, 'deny');
  assert.throws(
    () => catalog.load('code-review'),
    (err) => err instanceof SkillsMcpV3Error && err.code === 'NOT_APPROVED'
      && /user denied it/.test(err.message),
  );

  gate.approve('code-review', entry.contentHash, 'allow-always');
  const skill = catalog.load('code-review');
  assert.equal(skill.name, 'code-review');
  assert.match(skill.body, /Review the diff carefully/);
  assert.equal(catalog.usageFor('code-review').loads, 1);
  catalog.recordActivation('code-review');
  assert.equal(catalog.usageFor('code-review').activations, 1);
  assert.deepEqual(catalog.usageFor('nope'), { loads: 0, activations: 0, invocations: 0 });
  assert.ok(catalog.allUsage()['code-review']);
  assert.ok(catalog.allUsage()['code-review'].lastUsedAt);
});

test('v3 skills: invocation plan + placeholder filling + diff', () => {
  const { catalog } = twoServerCatalog();
  catalog.discover();
  const entry = catalog.get('code-review');
  catalog.getGate().approve('code-review', entry.contentHash, 'allow-always');
  catalog.load('code-review');

  assert.throws(
    () => catalog.planInvocation('nope', {}),
    (err) => err instanceof SkillsMcpV3Error && err.code === 'UNKNOWN_SKILL',
  );
  assert.throws(
    () => catalog.planInvocation('summarize', {}),
    (err) => err instanceof SkillsMcpV3Error && err.code === 'NO_TOOLS',
  );

  const plan = catalog.planInvocation('code-review', { diff: '--- a\n+++ b\n', path: 'src/x.ts' });
  assert.equal(plan.skillName, 'code-review');
  assert.equal(plan.serverId, 's1');
  assert.equal(plan.contentHash, entry.contentHash);
  assert.deepEqual(plan.inputKeys, ['diff', 'path']);
  assert.deepEqual(plan.steps.map((s) => s.toolName), ['read_file', 'grep_search']);
  assert.deepEqual(plan.steps[0].args, { diff: '{{input.diff}}', path: '{{input.path}}' });
  assert.match(plan.steps[0].reason, /Step 1\/2/);
  assert.equal(catalog.usageFor('code-review').invocations, 1);

  const filled = SkillsMcpV3Catalog.fillPlanInput(plan, { diff: 'D', path: 'P' });
  assert.deepEqual(filled[0].args, { diff: 'D', path: 'P' });
  // Unknown keys stay as placeholders.
  const partial = SkillsMcpV3Catalog.fillPlanInput(plan, { diff: 'D' });
  assert.equal(partial[0].args.path, undefined);

  // Diff: added / removed / updated / hash-changed.
  const prev = catalog.list();
  const fresh = [
    { ...prev[0], version: '1.1.0' },
    { name: 'new-skill', serverId: 's1', version: '0.1.0', contentHash: 'hash-new' },
  ];
  const diff = SkillsMcpV3Catalog.diffCatalogs(prev, fresh);
  const byName = new Map(diff.map((d) => [d.name, d]));
  assert.equal(byName.get('code-review').change, 'updated');
  assert.equal(byName.get('code-review').newVersion, '1.1.0');
  assert.equal(byName.get('new-skill').change, 'added');
  assert.equal(byName.get('summarize').change, 'removed');
  const hashChanged = SkillsMcpV3Catalog.diffCatalogs(prev, [
    { ...prev[0], contentHash: 'different-hash' },
    prev[1],
  ]);
  assert.equal(hashChanged.find((d) => d.name === 'code-review').change, 'hash-changed');
});

// ---------------------------------------------------------------------------
// MCP Apps v3
// ---------------------------------------------------------------------------

function appManager(quotas) {
  const manager = new McpAppsV3Manager();
  const record = manager.install(
    { id: 'app-one', serverName: 'srv', title: 'App One', allowedActions: ['tool-call'] },
    quotas ?? {},
  );
  return { manager, record };
}

test('v3 apps: version, transitions, capabilities, default quotas', () => {
  assert.equal(MCP_APPS_V3_VERSION, '3.0.0');
  assert.deepEqual(MCP_APPS_V3_TRANSITIONS, {
    installed: ['active', 'uninstalled'],
    active: ['suspended', 'uninstalled'],
    suspended: ['active', 'uninstalled'],
    uninstalled: [],
  });
  assert.equal(isMcpAppV3TransitionAllowed('installed', 'active'), true);
  assert.equal(isMcpAppV3TransitionAllowed('active', 'installed'), false);
  assert.equal(isMcpAppV3TransitionAllowed('suspended', 'active'), true);
  assert.equal(isMcpAppV3TransitionAllowed('uninstalled', 'active'), false);
  assert.equal(isMcpAppV3TransitionAllowed('installed', 'suspended'), false);
  assert.deepEqual([...MCP_APP_V3_CAPABILITIES], [
    'tool-call', 'link-open', 'form-submit', 'resource-read',
    'microphone', 'camera', 'clipboard', 'notifications',
  ]);
  assert.equal(isMcpAppV3Capability('clipboard'), true);
  assert.equal(isMcpAppV3Capability('nope'), false);
  assert.deepEqual(defaultMcpAppV3Quotas(), {
    maxPrefetchBytes: MCP_APPS_V3_DEFAULT_PREFETCH_BYTES,
    maxSurfaces: MCP_APPS_V3_MAX_SURFACES_PER_APP,
    maxActionsPerMinute: MCP_APPS_V3_DEFAULT_ACTIONS_PER_MINUTE,
  });
  assert.equal(MCP_APPS_V3_MAX_SURFACES_PER_APP, 8);
  assert.equal(MCP_APPS_V3_DEFAULT_ACTIONS_PER_MINUTE, 120);
  assert.equal(MCP_APPS_V3_DEFAULT_PREFETCH_BYTES, 8 * 1024 * 1024);
});

test('v3 apps: install / activate / suspend / resume / uninstall lifecycle', () => {
  const { manager, record } = appManager();
  assert.equal(record.lifecycle, 'installed');
  assert.equal(record.template.title, 'App One');
  assert.deepEqual(manager.list().map((a) => a.template.id), ['app-one']);
  assert.equal(manager.get('nope'), null);

  assert.throws(
    () => manager.install({ id: 'app-one', serverName: 'srv', title: 'Dup' }),
    (err) => err instanceof McpAppsV3Error && err.code === 'ALREADY_INSTALLED',
  );
  assert.throws(
    () => manager.transition('app-one', 'suspended'),
    (err) => err instanceof McpAppsV3Error && err.code === 'BAD_TRANSITION',
  );
  assert.throws(
    () => manager.transition('nope', 'active'),
    (err) => err instanceof McpAppsV3Error && err.code === 'UNKNOWN_APP',
  );

  assert.equal(manager.activate('app-one').lifecycle, 'active');
  const suspended = manager.suspend('app-one', 'policy');
  assert.equal(suspended.lifecycle, 'suspended');
  assert.equal(suspended.suspendReason, 'policy');
  assert.equal(manager.resume('app-one').lifecycle, 'active');
  const gone = manager.uninstall('app-one');
  assert.equal(gone.lifecycle, 'uninstalled');
  assert.equal(manager.list().length, 0); // uninstalled apps are not listed
  assert.equal(manager.get('app-one').lifecycle, 'uninstalled');
  assert.throws(
    () => manager.activate('app-one'),
    (err) => err instanceof McpAppsV3Error && err.code === 'BAD_TRANSITION',
  );
});

test('v3 apps: permissions — template allowlist, grants, surface scope, revoke', () => {
  const { manager } = appManager();
  // Not active yet: everything is denied.
  assert.deepEqual(manager.checkPermission('app-one', 'tool-call').decision, 'denied');
  manager.activate('app-one');
  // Declared in the template: granted by default.
  assert.equal(manager.checkPermission('app-one', 'tool-call').decision, 'granted');
  // Not declared and no grant: prompt the user.
  assert.equal(manager.checkPermission('app-one', 'clipboard').decision, 'prompt');
  // Unknown app: denied.
  assert.equal(manager.checkPermission('nope', 'tool-call').decision, 'denied');

  const grant = manager.setPermission('app-one', 'clipboard', 'granted');
  assert.equal(grant.decision, 'granted');
  assert.equal(grant.grantedBy, 'user');
  assert.equal(manager.checkPermission('app-one', 'clipboard').decision, 'granted');
  // A surface-scoped denial overrides the app-level grant.
  manager.setPermission('app-one', 'clipboard', 'denied', { surfaceId: 'surf-1' });
  assert.equal(manager.checkPermission('app-one', 'clipboard', 'surf-1').decision, 'denied');
  assert.equal(manager.checkPermission('app-one', 'clipboard').decision, 'granted');
  assert.equal(manager.listPermissions('app-one').length, 2);

  assert.equal(manager.revokePermission('app-one', 'clipboard', 'surf-1'), true);
  assert.equal(manager.checkPermission('app-one', 'clipboard', 'surf-1').decision, 'granted');
  assert.equal(manager.revokePermission('app-one', 'clipboard', 'surf-1'), false);
  assert.throws(
    () => manager.setPermission('app-one', 'nope', 'granted'),
    (err) => err instanceof McpAppsV3Error && err.code === 'UNKNOWN_CAPABILITY',
  );
  assert.throws(
    () => manager.setPermission('nope', 'clipboard', 'granted'),
    (err) => err instanceof McpAppsV3Error && err.code === 'UNKNOWN_APP',
  );
});

test('v3 apps: surfaces — open/hide/show/close, bad URI, surface quota suspends', () => {
  const { manager } = appManager({ maxSurfaces: 1 });
  assert.throws(
    () => manager.openSurface({ surfaceId: 's1', appId: 'app-one', placement: 'inline', title: 'One', uri: 'ui://app-one' }),
    (err) => err instanceof McpAppsV3Error && err.code === 'APP_NOT_ACTIVE',
  );
  manager.activate('app-one');
  assert.throws(
    () => manager.openSurface({ surfaceId: 's1', appId: 'app-one', placement: 'inline', title: 'One', uri: 'ftp://x' }),
    (err) => err instanceof McpAppsV3Error && err.code === 'BAD_URI',
  );
  const surface = manager.openSurface({
    surfaceId: 's1', appId: 'app-one', placement: 'sidebar', title: 'One', uri: 'ui://app-one',
  });
  assert.equal(surface.status, 'mounted');
  assert.equal(surface.placement, 'sidebar');
  assert.throws(
    () => manager.openSurface({ surfaceId: 's1', appId: 'app-one', placement: 'inline', title: 'Dup', uri: 'ui://app-one' }),
    (err) => err instanceof McpAppsV3Error && err.code === 'DUPLICATE_SURFACE',
  );
  // Second surface hits the quota (maxSurfaces 1): refused + app suspended.
  assert.throws(
    () => manager.openSurface({ surfaceId: 's2', appId: 'app-one', placement: 'inline', title: 'Two', uri: 'ui://app-one' }),
    (err) => err instanceof McpAppsV3Error && err.code === 'QUOTA_SURFACES',
  );
  assert.equal(manager.get('app-one').lifecycle, 'suspended');
  // Suspending closes the open surface.
  assert.equal(manager.getSurface('s1').status, 'closed');

  const { manager: manager2 } = appManager();
  manager2.activate('app-one');
  manager2.openSurface({ surfaceId: 'a', appId: 'app-one', placement: 'modal', title: 'A', uri: 'https://example.test/app' });
  assert.equal(manager2.hideSurface('a').status, 'hidden');
  assert.equal(manager2.showSurface('a').status, 'mounted');
  assert.equal(manager2.listSurfaces('app-one').length, 1);
  assert.equal(manager2.closeSurface('a').status, 'closed');
  assert.equal(manager2.getSurface('nope'), null);
});

test('v3 apps: prefetch + action quotas, audit trail', () => {
  const { manager } = appManager({ maxPrefetchBytes: 100, maxActionsPerMinute: 2 });
  manager.activate('app-one');
  manager.recordPrefetch('app-one', 60);
  assert.equal(manager.get('app-one').usage.prefetchBytes, 60);
  assert.throws(
    () => manager.recordPrefetch('app-one', 50),
    (err) => err instanceof McpAppsV3Error && err.code === 'QUOTA_PREFETCH',
  );
  assert.equal(manager.get('app-one').lifecycle, 'suspended');

  const { manager: manager2 } = appManager({ maxActionsPerMinute: 2 });
  manager2.activate('app-one');
  // No grant for clipboard: denied + audit event, no quota consumed.
  assert.deepEqual(manager2.recordAction('app-one', 'clipboard'), {
    allowed: false,
    reason: 'No grant for clipboard; ask the user',
  });
  // tool-call is declared in the template: allowed until the rate cap.
  assert.deepEqual(manager2.recordAction('app-one', 'tool-call'), { allowed: true });
  assert.deepEqual(manager2.recordAction('app-one', 'tool-call'), { allowed: true });
  const third = manager2.recordAction('app-one', 'tool-call');
  assert.equal(third.allowed, false);
  assert.match(third.reason, /Action quota exceeded \(2\/min\)/);
  assert.equal(manager2.get('app-one').lifecycle, 'suspended');

  // Audit trail: install + activate + grants + denials, filterable by app.
  const events = manager2.eventsFor('app-one');
  assert.ok(events.some((e) => e.kind === 'installed'));
  assert.ok(events.some((e) => e.kind === 'activated'));
  assert.ok(events.some((e) => e.kind === 'action-denied'));
  assert.ok(events.some((e) => e.kind === 'quota-hit'));
  assert.equal(manager2.eventsFor('other-app').length, 0);
  assert.ok(manager2.eventsFor().length >= events.length);
});
