/**
 * Tests for the v1.07 skills & plugins agent tools (Team T4).
 *
 * Covers: the 8 tools are registered in ALL_TOOLS (no placeholder
 * left out), the factory binds them (replace-in-place via
 * createDefaultTools, never a duplicate), and each tool's behaviour
 * with temp dirs + real registries (mock Vault via a real Vault in a
 * temp dir, mock secret service via InlineSecretService).
 *
 * Run after building both packages:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/skills-plugins-v107-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ALL_TOOLS,
  createDefaultTools,
  createSkillsPluginsV107Tools,
  SKILLS_PLUGINS_V107_TOOLS,
  SKILLS_PLUGINS_V107_TOOL_NAMES,
} from '../packages/tools/dist/index.js';
import {
  HookRegistry,
  InlineSecretService,
  SkillRegistry,
  Vault,
} from '../packages/core/dist/index.js';

const tempDirs = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-v107-tools-'));
  tempDirs.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function writeSkill(dir, name, description, scopeLine, body = 'Do the thing.') {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  const scope = scopeLine ? `\nscope: ${scopeLine}` : '';
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}${scope}\n---\n\n${body}\n`,
  );
}

function setup() {
  const root = tmpDir();
  const workspaceDir = path.join(root, 'ws');
  const skillsDir = path.join(root, 'skills');
  const pluginsDir = path.join(root, 'plugins');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(pluginsDir, { recursive: true });
  writeSkill(skillsDir, 'review-code', 'Review code changes.', undefined, 'Review the diff.');
  writeSkill(skillsDir, 'deploy-server', 'Deploy the server.', '[src/server]', 'Deploy it.');
  const skillRegistry = new SkillRegistry({ userSkillsDir: skillsDir, stateDir: tmpDir() });
  skillRegistry.load();
  const hookRegistry = new HookRegistry({ stateDir: tmpDir() });
  const vault = new Vault({ storePath: path.join(root, 'vault.json') });
  const secretService = new InlineSecretService(vault);
  const opts = {
    getWorkspaceDir: () => workspaceDir,
    getPluginsDir: () => pluginsDir,
    getSkillRegistry: () => skillRegistry,
    getHookRegistry: () => hookRegistry,
    getSecretService: () => secretService,
  };
  return { root, workspaceDir, skillsDir, pluginsDir, skillRegistry, hookRegistry, vault, secretService, opts };
}

function toolByName(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `tool ${name} exists`);
  return tool;
}

test('all 8 v1.07 tools are registered in ALL_TOOLS (no placeholder left out)', () => {
  for (const name of SKILLS_PLUGINS_V107_TOOL_NAMES) {
    const found = ALL_TOOLS.filter((t) => t.definition.name === name);
    assert.equal(found.length, 1, `${name} appears exactly once in ALL_TOOLS`);
  }
  assert.equal(SKILLS_PLUGINS_V107_TOOLS.length, 8);
  // No duplicate tool names across the whole registry.
  const names = ALL_TOOLS.map((t) => t.definition.name);
  assert.equal(new Set(names).size, names.length);
});

test('createDefaultTools replaces the placeholders in place (never a duplicate)', () => {
  const { opts } = setup();
  const tools = createDefaultTools({ getSkillsPluginsV107Opts: () => opts });
  for (const name of SKILLS_PLUGINS_V107_TOOL_NAMES) {
    assert.equal(tools.filter((t) => t.definition.name === name).length, 1, name);
  }
  // Without the opts the placeholders stay (unbound).
  const plain = createDefaultTools();
  assert.equal(
    plain.filter((t) => t.definition.name === 'skill_list_directory').length,
    1,
  );
});

test('unbound placeholders report "not configured" instead of guessing', async () => {
  const list = toolByName(SKILLS_PLUGINS_V107_TOOLS, 'skill_list_directory');
  const out = await list.execute({});
  assert.ok(out.startsWith('Error:'));
  assert.ok(out.includes('Chưa cấu hình'));
});

test('skill_list_directory: scope-gated tier-1 list per working directory', async () => {
  const { opts } = setup();
  const tools = createSkillsPluginsV107Tools(opts);
  const list = toolByName(tools, 'skill_list_directory');
  const serverOut = await list.execute({ workingDir: 'src/server' });
  assert.ok(serverOut.includes('- deploy-server:'));
  assert.ok(serverOut.includes('- review-code:'));
  assert.ok(!serverOut.includes('Bị ẩn bởi scope'));
  const docsOut = await list.execute({ workingDir: 'docs' });
  assert.ok(!docsOut.includes('- deploy-server:'));
  assert.ok(docsOut.includes('- review-code:'));
  assert.ok(docsOut.includes('Bị ẩn bởi scope (1): deploy-server'));
});

test('skill_show: loads a skill body by name; unknown skill errors', async () => {
  const { opts } = setup();
  const tools = createSkillsPluginsV107Tools(opts);
  const show = toolByName(tools, 'skill_show');
  const out = await show.execute({ name: 'review-code' });
  assert.ok(out.includes('Review the diff.'));
  assert.ok(out.includes('toàn cục'));
  const scoped = await show.execute({ name: 'deploy-server' });
  assert.ok(scoped.includes('src/server'));
  const missing = await show.execute({ name: 'no-such-skill' });
  assert.ok(missing.startsWith('Error:'));
});

test('plugin_bundle_install + list + toggle round-trip', async () => {
  const { opts, pluginsDir } = setup();
  const tools = createSkillsPluginsV107Tools(opts);
  // Build a bundle source dir.
  const root = tmpDir();
  const source = path.join(root, 'bundle-src');
  fs.mkdirSync(path.join(source, 'skills', 'bundle-skill'), { recursive: true });
  fs.writeFileSync(
    path.join(source, 'skills', 'bundle-skill', 'SKILL.md'),
    '---\nname: bundle-skill\ndescription: From the bundle.\n---\n\nBundle skill body.\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(source, 'manifest.json'),
    JSON.stringify({
      id: 'tool-bundle',
      name: 'Tool Bundle',
      version: '0.1.0',
      description: 'Bundle made by the tools test.',
      permissions: ['fs'],
      skills: [{ dir: 'skills/bundle-skill' }],
    }),
    'utf8',
  );
  const install = toolByName(tools, 'plugin_bundle_install');
  const installed = await install.execute({ sourceDir: source });
  assert.ok(installed.includes('Đã cài bundle "tool-bundle"'));
  assert.ok(installed.includes('Skill: 1 thư mục'));
  assert.ok(fs.existsSync(path.join(pluginsDir, 'tool-bundle', 'manifest.json')));
  const again = await install.execute({ sourceDir: source });
  assert.ok(again.startsWith('Error:'));
  const list = toolByName(tools, 'plugin_bundle_list');
  const listed = await list.execute({});
  assert.ok(listed.includes('tool-bundle'));
  assert.ok(listed.includes('đang bật'));
  const toggle = toolByName(tools, 'plugin_bundle_toggle');
  const off = await toggle.execute({ pluginId: 'tool-bundle', enabled: false });
  assert.ok(off.includes('đã tắt'));
  const listedOff = await list.execute({});
  assert.ok(listedOff.includes('đã tắt'));
  const unknown = await toggle.execute({ pluginId: 'nope', enabled: true });
  assert.ok(unknown.startsWith('Error:'));
});

test('hook_config_apply: applies hooks.json from the workspace', async () => {
  const { opts, workspaceDir } = setup();
  const tools = createSkillsPluginsV107Tools(opts);
  const hookDir = path.join(workspaceDir, '.open-bot');
  fs.mkdirSync(hookDir, { recursive: true });
  fs.writeFileSync(
    path.join(hookDir, 'stop.mjs'),
    'let buf = "";\nprocess.stdin.on("data", (d) => (buf += d));\nprocess.stdin.on("end", () => console.log(JSON.stringify({ action: "allow" })));\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(hookDir, 'hooks.json'),
    JSON.stringify({
      version: 1,
      hooks: [{ name: 'stop-hook', script: 'stop.mjs', events: ['Stop'] }],
    }),
    'utf8',
  );
  const apply = toolByName(tools, 'hook_config_apply');
  const out = await apply.execute({});
  assert.ok(out.includes('stop-hook'));
  // Re-applying the same file by explicit path re-registers (last wins), still fine.
  const out2 = await apply.execute({ filePath: path.join(hookDir, 'hooks.json') });
  assert.ok(out2.includes('stop-hook'));
});

test('hook_config_apply: no hooks file found reports a clear error', async () => {
  const { opts } = setup();
  const tools = createSkillsPluginsV107Tools(opts);
  const apply = toolByName(tools, 'hook_config_apply');
  const out = await apply.execute({});
  assert.ok(out.startsWith('Error:'));
  assert.ok(out.includes('hooks.json'));
});

test('secret_request + secret_request_status: prompt payload, status only, never the value', async () => {
  const { opts, secretService, vault } = setup();
  const tools = createSkillsPluginsV107Tools(opts);
  const request = toolByName(tools, 'secret_request');
  const out = await request.execute({
    namespace: 'media-keys',
    key: 'openai-key',
    label: 'OpenAI API key',
    reason: 'to generate an image',
    requestedBy: 'generate_image',
  });
  const prompt = JSON.parse(out);
  assert.equal(prompt.kind, 'secret-request');
  assert.equal(prompt.label, 'OpenAI API key');
  assert.equal(prompt.inputType, 'password');
  assert.ok(!('value' in prompt));
  assert.ok(!out.includes('sk-'));
  const status = toolByName(tools, 'secret_request_status');
  const pending = await status.execute({ requestId: prompt.requestId });
  assert.ok(pending.includes('pending'));
  assert.ok(!pending.includes('sk-'));
  // The user answers out of band (host side); the service fulfils it.
  assert.equal(secretService.resolveSecret(prompt.requestId, 'sk-answered').ok, true);
  const done = await status.execute({ requestId: prompt.requestId });
  assert.ok(done.includes('fulfilled'));
  assert.ok(done.includes('Đã lưu vào Vault'));
  assert.ok(!done.includes('sk-answered'));
  assert.equal(vault.getSecret('media-keys', 'openai-key'), 'sk-answered');
  // Unknown request id errors.
  const unknown = await status.execute({ requestId: 'no-such-id' });
  assert.ok(unknown.startsWith('Error:'));
});

test('secret_request: vault already has it -> no prompt', async () => {
  const { opts, vault } = setup();
  vault.setSecret('media-keys', 'openai-key', 'sk-present');
  const tools = createSkillsPluginsV107Tools(opts);
  const request = toolByName(tools, 'secret_request');
  const out = await request.execute({
    namespace: 'media-keys',
    key: 'openai-key',
    label: 'OpenAI API key',
  });
  assert.ok(out.includes('đã có trong Vault'));
  assert.ok(!out.includes('sk-present'));
});
