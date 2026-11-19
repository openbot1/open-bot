/**
 * Tests for fleet v26 hooks + plugins + MCP Apps + admission
 * (v1.39, Team T6).
 *
 * Covers:
 * - Hooks: glob matching, priority order, first deny wins, ask,
 *   PostToolUse deny is a flag (the call already ran), bot-tag
 *   scoping, enable/disable, log counts, JSON round-trip.
 * - Plugins: checksum mismatch refuses install, missing dependency /
 *   missing hook refuses install, install ships skills into the pack,
 *   enable/disable flips its hooks, remove refuses when another
 *   plugin depends on it, JSON round-trip.
 * - MCP Apps: uri/domain/HTML validation, CSP (declared + allowlist
 *   domains only, strict defaults), render decisions (disabled /
 *   blocked / trusted / ask-first), bridge guard (session + tool
 *   allowlist), settings validation, JSON round-trip.
 * - Admission: per-source rules, default fallback, evidence rule for
 *   memory, blocked patterns, oversize deny, ask spam cap, history
 *   counts, JSON round-trip.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v26-hooks-plugins-mcpapps-v139.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FleetV26AdmissionStore,
  FleetV26HookRegistry,
  FleetV26McpAppRegistry,
  FleetV26PluginRegistry,
  FleetV26SkillPack,
  buildFleetV26AppCsp,
  checksumFleetV26PluginBundle,
  decideFleetV26AppRender,
  defaultFleetV26AdmissionPolicy,
  defaultFleetV26McpAppSettings,
  evaluateFleetV26Admission,
  fleetV26GlobMatch,
  isFleetV26ValidDomain,
  summarizeFleetV26Admission,
  summarizeFleetV26Hooks,
  summarizeFleetV26McpApps,
  summarizeFleetV26Plugins,
  validateFleetV26AppHtml,
} from '../packages/core/dist/fleetV26/index.js';

const NOW = Date.UTC(2026, 10, 18, 10, 0, 0);

const GOOD_HTML =
  '<!-- text/html;profile=mcp-app --><html><head></head><body><p>hi</p><script>console.log(1)</script></body></html>';

// --- hooks ------------------------------------------------------------------

test('hooks v26: glob + first deny wins + ask + tag scope', () => {
  assert.equal(fleetV26GlobMatch('*', 'anything'), true);
  assert.equal(fleetV26GlobMatch('shell-*', 'shell-exec'), true);
  assert.equal(fleetV26GlobMatch('shell-*', 'file-read'), false);
  assert.equal(fleetV26GlobMatch('file-?', 'file-a'), true);
  assert.equal(fleetV26GlobMatch('file-?', 'file-ab'), false);

  const reg = new FleetV26HookRegistry();
  assert.equal(reg.add({ id: 'bad id', event: 'PreToolUse', action: 'deny' }).ok, false);
  assert.equal(reg.add({ id: 'h1', event: 'PreToolUse', toolPattern: 'shell-*', action: 'deny', message: 'No shell.', priority: 10 }).ok, true);
  assert.equal(reg.add({ id: 'h1', event: 'PreToolUse', action: 'allow' }).ok, false); // duplicate
  reg.add({ id: 'h2', event: 'PreToolUse', toolPattern: '*', action: 'ask', message: 'Ask a human.', priority: 20 });
  reg.add({ id: 'h3', event: 'PreToolUse', toolPattern: '*', action: 'deny', botTag: 'nightly', message: 'Nightly bots may not run this.', priority: 5 });

  // Priority 5 deny (tag-scoped) beats priority 10 deny for nightly bots.
  const d1 = reg.evaluate({ event: 'PreToolUse', toolName: 'shell-exec', botId: 'b1', botTags: ['nightly'] }, NOW);
  assert.equal(d1.decision, 'deny');
  assert.equal(d1.decidingHook?.id, 'h3');
  assert.deepEqual(d1.matched.map((h) => h.id), ['h3', 'h1', 'h2']);

  // Without the tag, h1 (deny, priority 10) still beats h2 (ask).
  const d2 = reg.evaluate({ event: 'PreToolUse', toolName: 'shell-exec', botId: 'b2', botTags: [] }, NOW);
  assert.equal(d2.decision, 'deny');
  assert.equal(d2.decidingHook?.id, 'h1');

  // A non-shell tool only matches the ask hook.
  const d3 = reg.evaluate({ event: 'PreToolUse', toolName: 'read-file', botId: 'b2', botTags: [] }, NOW);
  assert.equal(d3.decision, 'ask');
  assert.equal(d3.decidingHook?.id, 'h2');

  // Nothing matches: allow.
  const empty = new FleetV26HookRegistry();
  assert.equal(empty.evaluate({ event: 'Stop', toolName: '-', botId: 'b1' }, NOW).decision, 'allow');

  // PostToolUse deny is a flag, not a time machine.
  reg.add({ id: 'h4', event: 'PostToolUse', toolPattern: 'shell-*', action: 'deny', message: 'Shell output contained a secret.', priority: 1 });
  const d4 = reg.evaluate({ event: 'PostToolUse', toolName: 'shell-exec', botId: 'b2', botTags: [] }, NOW);
  assert.equal(d4.decision, 'deny');
  assert.match(d4.message, /flagged the completed call/);

  // Disable h1: the ask hook now decides for shell tools.
  assert.equal(reg.setEnabled('h1', false), true);
  assert.equal(reg.evaluate({ event: 'PreToolUse', toolName: 'shell-exec', botId: 'b2', botTags: [] }, NOW).decision, 'ask');
  assert.equal(reg.remove('h2'), true);
  assert.equal(reg.get('h2'), undefined);

  const counts = reg.logCounts();
  assert.ok(counts.total >= 5);
  assert.ok(counts.deny >= 2);
  assert.equal(reg.recentLog(1)[0].botId, 'b2');
  assert.ok(summarizeFleetV26Hooks(reg).includes('hook(s)'));

  const restored = FleetV26HookRegistry.fromJSON(reg.toJSON());
  assert.equal(restored.list().length, reg.list().length);
  assert.equal(restored.recentLog(100).length, reg.recentLog(100).length);
});

// --- plugins ----------------------------------------------------------------

function makeBundle(overrides = {}) {
  const base = {
    id: 'weather-pack',
    name: 'Weather pack',
    version: '1.0.0',
    description: 'Weather skills + hooks.',
    author: 'fleet-team',
    skills: [
      {
        name: 'weather-check', description: 'Check the weather for a city.', body: 'Call the weather tool, then summarise. ' + 'x'.repeat(30),
        triggers: ['weather'], allowedTools: ['get-weather'], argumentHint: '<city>', version: '1.0.0', author: 'fleet-team', files: [],
      },
    ],
    hookIds: [],
    mcpServers: [{ id: 'weather-server', command: 'weather-mcp', args: [], tools: ['get-weather'] }],
    dependencies: [],
    signature: null,
    signatureVerified: false,
    ...overrides,
  };
  return { ...base, checksum: checksumFleetV26PluginBundle(base) };
}

test('plugins v26: checksum + deps + skills + enable/disable + remove guard', () => {
  const plugins = new FleetV26PluginRegistry();
  const skills = new FleetV26SkillPack();
  const hooks = new FleetV26HookRegistry();
  const deps = { skills, hooks };

  // Tampered bundle: checksum mismatch refuses.
  const tampered = makeBundle();
  tampered.description = 'EVIL';
  assert.equal(plugins.install(tampered, deps, {}, NOW).ok, false);

  // Missing dependency refuses.
  const needy = makeBundle({ id: 'needy-pack', dependencies: ['ghost-pack'] });
  assert.match(plugins.install(needy, deps, {}, NOW).message, /needs plugin "ghost-pack"/);

  // Missing hook reference refuses.
  const hooky = makeBundle({ id: 'hooky-pack', hookIds: ['ghost-hook'] });
  assert.match(plugins.install(hooky, deps, {}, NOW).message, /hook "ghost-hook"/);

  // Happy path: skill lands in the pack.
  const bundle = makeBundle();
  const ok = plugins.install(bundle, deps, {}, NOW);
  assert.equal(ok.ok, true);
  assert.match(ok.message, /1 skill\(s\), 0 hook\(s\), 1 MCP server/);
  assert.equal(skills.get('weather-check')?.description, 'Check the weather for a city.');
  assert.equal(plugins.install(bundle, deps, {}, NOW).ok, false); // duplicate without overwrite
  assert.equal(plugins.install(bundle, deps, { overwrite: true }, NOW + 1000).ok, true);

  // Enable/disable flips the bundle's hooks.
  hooks.add({ id: 'weather-hook', event: 'PreToolUse', toolPattern: 'get-weather', action: 'ask', priority: 50 });
  const withHook = makeBundle({ id: 'hook-pack', hookIds: ['weather-hook'], skills: [] });
  assert.equal(plugins.install(withHook, deps, {}, NOW).ok, true);
  assert.equal(plugins.setEnabled('hook-pack', false, hooks).ok, true);
  assert.equal(hooks.get('weather-hook')?.enabled, false);
  assert.equal(plugins.setEnabled('hook-pack', true, hooks).ok, true);
  assert.equal(hooks.get('weather-hook')?.enabled, true);

  // Remove guard: a dependent blocks removal.
  const child = makeBundle({ id: 'child-pack', dependencies: ['weather-pack'], skills: [] });
  assert.equal(plugins.install(child, deps, {}, NOW).ok, true);
  assert.match(plugins.remove('weather-pack').message, /required by "child-pack"/);
  assert.equal(plugins.remove('child-pack').ok, true);
  assert.equal(plugins.remove('weather-pack').ok, true);
  assert.equal(plugins.remove('weather-pack').ok, false);
  assert.ok(summarizeFleetV26Plugins(plugins).includes('plugin(s)'));

  const restored = FleetV26PluginRegistry.fromJSON(plugins.toJSON());
  assert.equal(restored.list().length, plugins.list().length);
});

// --- MCP Apps ---------------------------------------------------------------

test('mcpApps v26: validation + CSP + render decisions + bridge guard', () => {
  assert.equal(isFleetV26ValidDomain('example.com'), true);
  assert.equal(isFleetV26ValidDomain('*.example.com'), true);
  assert.equal(isFleetV26ValidDomain('not a domain'), false);
  assert.equal(isFleetV26ValidDomain('example.com/path'), false);

  assert.equal(validateFleetV26AppHtml(GOOD_HTML).ok, true);
  assert.equal(validateFleetV26AppHtml('<html><body>no marker</body></html>').ok, false);
  assert.equal(validateFleetV26AppHtml(GOOD_HTML.replace('</body>', '<meta http-equiv="refresh" content="0"></body>')).ok, false);
  assert.equal(validateFleetV26AppHtml(GOOD_HTML.replace('</body>', '<a target="_top" href="x">x</a></body>')).ok, false);

  const reg = new FleetV26McpAppRegistry();
  assert.equal(reg.register({ uri: 'not-a-ui-uri', serverId: 's', toolName: 't', html: GOOD_HTML }).ok, false);
  assert.equal(reg.register({ uri: 'ui://weather/current', serverId: 'weather', toolName: 'get-weather', html: GOOD_HTML, declaredDomains: ['bad domain'] }).ok, false);
  const ok = reg.register({
    uri: 'ui://weather/current', serverId: 'weather', toolName: 'get-weather', title: 'Weather',
    html: GOOD_HTML, declaredDomains: ['cdn.example.com'], allowedTools: ['get-weather'],
  }, NOW);
  assert.equal(ok.ok, true);
  assert.equal(reg.register({ uri: 'ui://weather/current', serverId: 'weather', toolName: 'get-weather', html: GOOD_HTML }).ok, false);

  // CSP: declared domain only (+ user allowlist), strict defaults.
  const csp = reg.cspFor('ui://weather/current');
  assert.ok(csp?.includes("default-src 'none'"));
  assert.ok(csp?.includes('https://cdn.example.com'));
  assert.ok(csp?.includes("frame-ancestors 'none'"));
  assert.ok(csp?.includes("navigate-to 'none'"));
  reg.setSettings({ domainAllowlist: ['assets.example.org'] });
  assert.ok((reg.cspFor('ui://weather/current') ?? '').includes('https://assets.example.org'));
  assert.equal(reg.setSettings({ domainAllowlist: ['bad domain'] }).ok, false);
  assert.equal(reg.setSettings({ defaultPolicy: 'sometimes' }).ok, false);

  // Render decisions: default ask -> needsAsk; trusted -> allowed; blocked -> refused; disabled -> refused.
  const ask = reg.renderDecision('ui://weather/current');
  assert.equal(ask?.allowed, false);
  assert.equal(ask?.needsAsk, true);
  reg.setSettings({ trustedServers: ['weather'] });
  assert.equal(reg.renderDecision('ui://weather/current')?.allowed, true);
  reg.setSettings({ trustedServers: [], blockedServers: ['weather'] });
  assert.equal(reg.renderDecision('ui://weather/current')?.allowed, false);
  assert.equal(reg.renderDecision('ui://weather/current')?.needsAsk, false);
  reg.setSettings({ blockedServers: [], appsEnabled: false });
  assert.match(reg.renderDecision('ui://weather/current')?.reason ?? '', /disabled/);
  reg.setSettings({ appsEnabled: true, defaultPolicy: 'deny' });
  assert.equal(reg.renderDecision('ui://weather/current')?.allowed, false);
  reg.setSettings({ defaultPolicy: 'allow' });
  assert.equal(reg.renderDecision('ui://weather/current')?.allowed, true);

  // Bridge guard: wrong session -> dropped; unlisted tool -> dropped; right session + listed tool -> accepted.
  const session = { uri: 'ui://weather/current', sessionId: 's1', nonce: 'n1', expectedSessionId: 's1', expectedNonce: 'n1', toolName: 'get-weather' };
  assert.equal(reg.checkBridgeMessage(session).ok, true);
  assert.equal(reg.checkBridgeMessage({ ...session, nonce: 'wrong' }).ok, false);
  assert.equal(reg.checkBridgeMessage({ ...session, toolName: 'shell-exec' }).ok, false);
  assert.equal(reg.checkBridgeMessage({ ...session, toolName: null }).ok, true); // no tool call, just a message
  assert.equal(reg.checkBridgeMessage({ ...session, uri: 'ui://ghost/x' }).ok, false);

  assert.equal(reg.remove('ui://weather/current'), true);
  assert.equal(reg.cspFor('ui://weather/current'), null);
  assert.ok(summarizeFleetV26McpApps(reg).includes('MCP Apps'));
  assert.deepEqual(defaultFleetV26McpAppSettings().defaultPolicy, 'ask');
  const res = reg.listByServer('weather');
  assert.equal(res.length, 0);
  void buildFleetV26AppCsp;
  void decideFleetV26AppRender;
});

// --- admission --------------------------------------------------------------

test('admission v26: rules, evidence, blocked patterns, oversize, ask cap', () => {
  const policy = defaultFleetV26AdmissionPolicy();
  assert.equal(policy.defaultAction, 'ask');
  assert.equal(policy.requireEvidenceForMemory, true);
  assert.equal(policy.rules.find((r) => r.source === 'operator')?.action, 'auto');

  const base = { source: 'memory-v24', text: 'The fleet ships daily.', evidence: 'standup notes 18/11', offeredBy: 'bot-a' };
  // Memory fact WITH evidence: per-source rule says ask.
  assert.equal(evaluateFleetV26Admission(policy, base, NOW).decision, 'ask-user');
  // Memory fact WITHOUT evidence: ask with the evidence reason.
  const noEvidence = evaluateFleetV26Admission(policy, { ...base, evidence: null }, NOW);
  assert.equal(noEvidence.decision, 'ask-user');
  assert.ok(noEvidence.reasons.some((r) => r.includes('no evidence')));
  // Operator is always admitted.
  assert.equal(evaluateFleetV26Admission(policy, { source: 'operator', text: 'do it', evidence: null, offeredBy: 'huy' }, NOW).decision, 'admitted');
  // Blocked pattern wins over everything.
  const blocked = evaluateFleetV26Admission(
    { ...policy, blockedPatterns: ['password\\s*:\\s*\\S+'] },
    { source: 'operator', text: 'my password: hunter2', evidence: null, offeredBy: 'bot-a' },
    NOW,
  );
  assert.equal(blocked.decision, 'denied');
  // Oversize is denied, never truncated.
  assert.equal(evaluateFleetV26Admission(policy, { ...base, text: 'x'.repeat(policy.maxChars + 1) }, NOW).decision, 'denied');
  // Unknown source falls back to the default (ask).
  assert.equal(evaluateFleetV26Admission(policy, { source: 'plugin', text: 'hi', evidence: null, offeredBy: 'bot-a' }, NOW).decision, 'ask-user');

  // Store: rule change + ask spam cap.
  const store = new FleetV26AdmissionStore();
  assert.equal(store.setRule('memory-v24', 'auto', 'trusted bot').ok, true);
  assert.equal(store.evaluate({ ...base, source: 'memory-v24' }, NOW).decision, 'admitted');
  assert.equal(store.setRule('memory-v24', 'ask').ok, true);
  assert.equal(store.setPolicy({ maxChars: -5 }).ok, false);
  assert.equal(store.setPolicy({ blockedPatterns: ['[invalid'] }).ok, false);
  assert.equal(store.setPolicy({ defaultAction: 'sometimes' }).ok, false);

  // Ask cap: maxAsksPerDay = 1 -> second ask auto-denies.
  const capped = new FleetV26AdmissionStore();
  capped.setPolicy({ maxAsksPerDay: 1 });
  assert.equal(capped.evaluate({ source: 'skill-pack', text: 'skill one', evidence: null, offeredBy: 'bot-a' }, NOW).decision, 'ask-user');
  const second = capped.evaluate({ source: 'skill-pack', text: 'skill two', evidence: null, offeredBy: 'bot-a' }, NOW + 1000);
  assert.equal(second.decision, 'denied');
  assert.ok(second.reasons.some((r) => r.includes('Ask cap')));
  const counts = capped.counts();
  assert.deepEqual(counts, { admitted: 0, askUser: 1, denied: 1, total: 2 });
  assert.ok(summarizeFleetV26Admission(capped).includes('2 decision(s)'));
  assert.equal(capped.recentHistory(1)[0].decision, 'denied');

  const restored = FleetV26AdmissionStore.fromJSON(store.toJSON());
  assert.equal(restored.getPolicy().rules.find((r) => r.source === 'memory-v24')?.action, 'ask');
});
