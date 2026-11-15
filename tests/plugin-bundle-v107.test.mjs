/**
 * Tests for the plugin bundle layer (v1.07, Team T4).
 *
 * A bundle is one installable directory (manifest.json + optional
 * skills / hook scripts / MCP servers). The manifest is validated
 * before anything is installed or activated; install copies the
 * bundle into pluginsDir, activate registers its skills + hooks and
 * merges its MCP servers, deactivate undoes exactly that.
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/plugin-bundle-v107.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  HookRegistry,
  HookRunner,
  PluginBundleError,
  SkillRegistry,
  activatePluginBundle,
  deactivatePluginBundle,
  installPluginBundle,
  isPluginBundleEnabled,
  isSafeBundleRelativePath,
  listPluginBundles,
  parsePluginBundleManifest,
  scanBundleDir,
  setPluginBundleEnabled,
  summarizePluginBundle,
  uninstallPluginBundle,
  validatePluginBundleManifest,
} from '../packages/core/dist/index.js';

const tempDirs = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-bundle-v107-'));
  tempDirs.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function writeSkill(dir, name, description, body = 'Do the thing.') {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
  );
}

function makeBundle(dir, manifest, { withSkill = true, withHook = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, 'manifest.json'), manifest);
  if (withSkill) writeSkill(path.join(dir, 'skills', 'bundle-skill'), 'bundle-skill', 'A skill from the bundle.');
  if (withHook) {
    fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'hooks', 'guard.mjs'),
      'const line = await new Promise((r) => { let s = ""; process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => r(s)); });\n' +
        'const event = JSON.parse(line);\n' +
        'if (event.toolName === "shell_exec" && String(event.args?.command ?? "").includes("rm -rf")) {\n' +
        '  console.log(JSON.stringify({ action: "block", reason: "rm -rf is blocked by the bundle hook" }));\n' +
        '} else {\n' +
        '  console.log(JSON.stringify({ action: "allow" }));\n' +
        '}\n',
    );
  }
  return dir;
}

const GOOD_MANIFEST = {
  id: 'my-bundle',
  name: 'My Bundle',
  version: '1.2.0',
  description: 'A test bundle.',
  author: 'open-bot',
  permissions: ['fs'],
  skills: [{ dir: 'skills/bundle-skill' }],
  hooks: [
    { name: 'guard-rm', script: 'hooks/guard.mjs', events: ['PreToolUse'], matcher: ['shell_exec'] },
  ],
  mcpServers: {
    'bundle-server': { command: 'node', args: ['server.js'] },
  },
};

// --- validation ---

test('validatePluginBundleManifest: a good manifest validates', () => {
  const dir = tmpDir();
  makeBundle(path.join(dir, 'b'), GOOD_MANIFEST);
  const result = validatePluginBundleManifest(GOOD_MANIFEST, path.join(dir, 'b'));
  assert.equal(result.valid, true);
  assert.deepEqual(result.issues, []);
  assert.equal(result.manifest.id, 'my-bundle');
});

test('validatePluginBundleManifest: bad id / version / description', () => {
  assert.equal(validatePluginBundleManifest({ ...GOOD_MANIFEST, id: 'bad id!' }).valid, false);
  assert.equal(validatePluginBundleManifest({ ...GOOD_MANIFEST, version: 'v1' }).valid, false);
  assert.equal(validatePluginBundleManifest({ ...GOOD_MANIFEST, description: 42 }).valid, false);
  assert.equal(validatePluginBundleManifest(null).valid, false);
  assert.equal(validatePluginBundleManifest('nope').valid, false);
});

test('validatePluginBundleManifest: unknown permission is rejected (fail-closed)', () => {
  const result = validatePluginBundleManifest({ ...GOOD_MANIFEST, permissions: ['fs', 'root'] });
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.includes('root')));
});

test('validatePluginBundleManifest: skill dir must exist and hold a skill', () => {
  const dir = tmpDir();
  const bundleDir = path.join(dir, 'b');
  fs.mkdirSync(bundleDir, { recursive: true });
  writeJson(path.join(bundleDir, 'manifest.json'), GOOD_MANIFEST);
  const missing = validatePluginBundleManifest(GOOD_MANIFEST, bundleDir);
  assert.equal(missing.valid, false);
  assert.ok(missing.issues.some((i) => i.includes('skills[0].dir')));
  // Empty skill dir (no SKILL.md anywhere) is also rejected.
  fs.mkdirSync(path.join(bundleDir, 'skills', 'bundle-skill'), { recursive: true });
  const empty = validatePluginBundleManifest(GOOD_MANIFEST, bundleDir);
  assert.equal(empty.valid, false);
});

test('validatePluginBundleManifest: hook must declare exactly one of script/command; script must exist + stay inside', () => {
  const dir = tmpDir();
  const bundleDir = makeBundle(path.join(dir, 'b'), GOOD_MANIFEST);
  const both = {
    ...GOOD_MANIFEST,
    hooks: [{ name: 'h', script: 'hooks/guard.mjs', command: 'echo hi', events: ['Stop'] }],
  };
  assert.equal(validatePluginBundleManifest(both, bundleDir).valid, false);
  const neither = { ...GOOD_MANIFEST, hooks: [{ name: 'h', events: ['Stop'] }] };
  assert.equal(validatePluginBundleManifest(neither, bundleDir).valid, false);
  const escaping = {
    ...GOOD_MANIFEST,
    hooks: [{ name: 'h', script: '../evil.mjs', events: ['Stop'] }],
  };
  assert.equal(validatePluginBundleManifest(escaping, bundleDir).valid, false);
  const missing = {
    ...GOOD_MANIFEST,
    hooks: [{ name: 'h', script: 'hooks/nope.mjs', events: ['Stop'] }],
  };
  assert.equal(validatePluginBundleManifest(missing, bundleDir).valid, false);
  const badEvent = {
    ...GOOD_MANIFEST,
    hooks: [{ name: 'h', script: 'hooks/guard.mjs', events: ['NotAnEvent'] }],
  };
  assert.equal(validatePluginBundleManifest(badEvent, bundleDir).valid, false);
  const duplicate = {
    ...GOOD_MANIFEST,
    hooks: [
      { name: 'h', script: 'hooks/guard.mjs', events: ['Stop'] },
      { name: 'h', command: 'echo hi', events: ['Stop'] },
    ],
  };
  assert.equal(validatePluginBundleManifest(duplicate, bundleDir).valid, false);
});

test('validatePluginBundleManifest: MCP servers go through the mcp.json validator', () => {
  const badUrl = {
    ...GOOD_MANIFEST,
    mcpServers: { s: { url: 'ftp://example.com/mcp' } },
  };
  assert.equal(validatePluginBundleManifest(badUrl).valid, false);
  const neither = { ...GOOD_MANIFEST, mcpServers: { s: {} } };
  assert.equal(validatePluginBundleManifest(neither).valid, false);
  const good = {
    ...GOOD_MANIFEST,
    mcpServers: { s: { url: 'https://example.com/mcp' } },
  };
  assert.equal(validatePluginBundleManifest(good).valid, true);
});

test('isSafeBundleRelativePath', () => {
  assert.equal(isSafeBundleRelativePath('skills/a'), true);
  assert.equal(isSafeBundleRelativePath('../evil'), false);
  assert.equal(isSafeBundleRelativePath('/abs'), false);
  assert.equal(isSafeBundleRelativePath(''), false);
  assert.equal(isSafeBundleRelativePath('a//b'), false);
});

test('parsePluginBundleManifest throws PluginBundleError with issues', () => {
  assert.throws(() => parsePluginBundleManifest({ id: 'x' }), PluginBundleError);
  try {
    parsePluginBundleManifest({ id: 'x' });
    assert.fail('should throw');
  } catch (err) {
    assert.ok(err.issues.length > 0);
  }
});

test('scanBundleDir: missing manifest / bad JSON', () => {
  const dir = tmpDir();
  assert.equal(scanBundleDir(path.join(dir, 'nope')).valid, false);
  const bad = path.join(dir, 'bad');
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, 'manifest.json'), '{not json', 'utf8');
  assert.equal(scanBundleDir(bad).valid, false);
});

test('summarizePluginBundle', () => {
  const summary = summarizePluginBundle(
    validatePluginBundleManifest(GOOD_MANIFEST).manifest,
  );
  assert.equal(summary.pluginId, 'my-bundle');
  assert.deepEqual(summary.skillDirs, ['skills/bundle-skill']);
  assert.deepEqual(summary.hookNames, ['guard-rm']);
  assert.deepEqual(summary.mcpServerNames, ['bundle-server']);
  assert.equal(summary.hasToolEntry, false);
});

// --- install / list / toggle / uninstall ---

test('installPluginBundle: installs, lists, refuses overwrite, overwrites when asked', () => {
  const root = tmpDir();
  const source = makeBundle(path.join(root, 'src'), GOOD_MANIFEST);
  const pluginsDir = path.join(root, 'plugins');
  const first = installPluginBundle(source, pluginsDir);
  assert.equal(first.ok, true);
  assert.equal(first.pluginId, 'my-bundle');
  assert.ok(fs.existsSync(path.join(pluginsDir, 'my-bundle', 'manifest.json')));
  assert.equal(isPluginBundleEnabled(pluginsDir, 'my-bundle'), true);
  const again = installPluginBundle(source, pluginsDir);
  assert.equal(again.ok, false);
  const over = installPluginBundle(source, pluginsDir, { overwrite: true });
  assert.equal(over.ok, true);
  assert.equal(over.overwritten, true);
  const listed = listPluginBundles(pluginsDir);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].valid, true);
  assert.equal(listed[0].enabled, true);
  assert.deepEqual(listed[0].hookNames, ['guard-rm']);
});

test('installPluginBundle: an invalid bundle never lands in pluginsDir', () => {
  const root = tmpDir();
  const source = path.join(root, 'src');
  fs.mkdirSync(source, { recursive: true });
  writeJson(path.join(source, 'manifest.json'), { ...GOOD_MANIFEST, permissions: ['root'] });
  const pluginsDir = path.join(root, 'plugins');
  const result = installPluginBundle(source, pluginsDir);
  assert.equal(result.ok, false);
  assert.equal(fs.existsSync(path.join(pluginsDir, 'my-bundle')), false);
});

test('setPluginBundleEnabled + listPluginBundles with an invalid manifest', () => {
  const root = tmpDir();
  const pluginsDir = path.join(root, 'plugins');
  const source = makeBundle(path.join(root, 'src'), GOOD_MANIFEST);
  installPluginBundle(source, pluginsDir);
  const disabled = setPluginBundleEnabled(pluginsDir, 'my-bundle', false);
  assert.equal(disabled.ok, true);
  assert.equal(isPluginBundleEnabled(pluginsDir, 'my-bundle'), false);
  // A directory with a broken manifest is listed, not hidden.
  const broken = path.join(pluginsDir, 'broken-bundle');
  fs.mkdirSync(broken, { recursive: true });
  fs.writeFileSync(path.join(broken, 'manifest.json'), '{"id": 1}', 'utf8');
  const listed = listPluginBundles(pluginsDir);
  assert.equal(listed.length, 2);
  const brokenEntry = listed.find((e) => e.pluginId === 'broken-bundle');
  assert.equal(brokenEntry.valid, false);
  assert.ok(brokenEntry.issues.length > 0);
  // Toggling an unknown plugin fails.
  assert.equal(setPluginBundleEnabled(pluginsDir, 'nope', true).ok, false);
});

test('uninstallPluginBundle: removes dir + enabled entry; refuses a foreign dir', () => {
  const root = tmpDir();
  const pluginsDir = path.join(root, 'plugins');
  const source = makeBundle(path.join(root, 'src'), GOOD_MANIFEST);
  installPluginBundle(source, pluginsDir);
  const removed = uninstallPluginBundle(pluginsDir, 'my-bundle');
  assert.equal(removed.ok, true);
  assert.equal(fs.existsSync(path.join(pluginsDir, 'my-bundle')), false);
  assert.equal(uninstallPluginBundle(pluginsDir, 'my-bundle').ok, false);
  // A directory whose manifest names a different id is never deleted.
  const foreign = path.join(pluginsDir, 'my-bundle');
  makeBundle(foreign, { ...GOOD_MANIFEST, id: 'other-bundle' });
  const refused = uninstallPluginBundle(pluginsDir, 'my-bundle');
  assert.equal(refused.ok, false);
  assert.equal(fs.existsSync(foreign), true);
});

// --- activate / deactivate ---

test('activatePluginBundle: registers skill + hook, merges MCP server; deactivate undoes it', async () => {
  const root = tmpDir();
  const workspaceDir = path.join(root, 'ws');
  const pluginsDir = path.join(root, 'plugins');
  fs.mkdirSync(workspaceDir, { recursive: true });
  const bundleDir = makeBundle(path.join(root, 'bundle'), GOOD_MANIFEST);
  const skillRegistry = new SkillRegistry({ stateDir: tmpDir() });
  skillRegistry.load();
  const hookRegistry = new HookRegistry({ stateDir: tmpDir() });
  const activation = activatePluginBundle(bundleDir, {
    skillRegistry,
    hookRegistry,
    workspaceDir,
    pluginsDir,
  });
  assert.deepEqual(activation.skillsAdded, ['bundle-skill']);
  assert.deepEqual(activation.skillErrors, []);
  assert.deepEqual(activation.hooksApplied, ['guard-rm']);
  assert.deepEqual(activation.hookErrors, []);
  assert.deepEqual(activation.mcp.added, ['bundle-server']);
  assert.ok(skillRegistry.get('bundle-skill'));
  assert.equal(skillRegistry.get('bundle-skill').source, 'plugin');
  assert.ok(hookRegistry.get('guard-rm'));
  // The MCP server landed in the workspace mcp.json.
  const mcpJson = JSON.parse(fs.readFileSync(path.join(workspaceDir, '.open-bot', 'mcp.json'), 'utf8'));
  assert.ok(mcpJson.servers['bundle-server']);
  // The hook really blocks: run it through the runner.
  const runner = new HookRunner(hookRegistry);
  const blocked = await runner.runPreToolUse(
    { toolName: 'shell_exec', toolCallId: 'c1', args: { command: 'rm -rf /tmp/x' } },
    { workspaceDir },
  );
  assert.equal(blocked.decision, 'block');
  assert.equal(blocked.blockedBy, 'guard-rm');
  const allowed = await runner.runPreToolUse(
    { toolName: 'shell_exec', toolCallId: 'c2', args: { command: 'ls' } },
    { workspaceDir },
  );
  assert.equal(allowed.decision, 'allow');
  // Deactivate removes all three again.
  const deactivation = deactivatePluginBundle(bundleDir, {
    skillRegistry,
    hookRegistry,
    workspaceDir,
    pluginsDir,
  });
  assert.deepEqual(deactivation.skillsRemoved, ['bundle-skill']);
  assert.deepEqual(deactivation.hooksRemoved, ['guard-rm']);
  assert.deepEqual(deactivation.mcp.removed, ['bundle-server']);
  assert.equal(skillRegistry.get('bundle-skill'), undefined);
  assert.equal(hookRegistry.get('guard-rm'), undefined);
  const mcpAfter = JSON.parse(fs.readFileSync(path.join(workspaceDir, '.open-bot', 'mcp.json'), 'utf8'));
  assert.equal(mcpAfter.servers['bundle-server'], undefined);
});

test('activatePluginBundle: a user-owned MCP server with the same name is never overwritten', () => {
  const root = tmpDir();
  const workspaceDir = path.join(root, 'ws');
  const pluginsDir = path.join(root, 'plugins');
  fs.mkdirSync(workspaceDir, { recursive: true });
  writeJson(path.join(workspaceDir, '.open-bot', 'mcp.json'), {
    servers: { 'bundle-server': { name: 'bundle-server', command: 'node', args: ['mine.js'] } },
  });
  const bundleDir = makeBundle(path.join(root, 'bundle'), GOOD_MANIFEST);
  const activation = activatePluginBundle(bundleDir, { workspaceDir, pluginsDir });
  assert.deepEqual(activation.mcp.added, []);
  assert.deepEqual(activation.mcp.existsDifferent, ['bundle-server']);
  const mcpJson = JSON.parse(fs.readFileSync(path.join(workspaceDir, '.open-bot', 'mcp.json'), 'utf8'));
  assert.deepEqual(mcpJson.servers['bundle-server'].args, ['mine.js']);
});

test('activatePluginBundle: invalid manifest throws before anything registers', () => {
  const root = tmpDir();
  const bundleDir = path.join(root, 'bundle');
  fs.mkdirSync(bundleDir, { recursive: true });
  writeJson(path.join(bundleDir, 'manifest.json'), { id: 'bad bundle!' });
  const skillRegistry = new SkillRegistry({ stateDir: tmpDir() });
  assert.throws(() => activatePluginBundle(bundleDir, { skillRegistry }), PluginBundleError);
  assert.equal(skillRegistry.list().length, 0);
});
