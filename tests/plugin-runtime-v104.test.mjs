/**
 * Tests for v1.04 plugin runtime (packages/core/src/acp/pluginRuntime.ts):
 * hooks.json parsing (both shapes), prompt-template reading/rendering,
 * activation (hooks registered as shell-command hooks, runnable via the
 * runner) and deactivation (rollback on failure, unregister on demand).
 *
 * All fixtures are plugin dirs built in temp dirs. Hook commands use
 * `node -e` so they run on any platform with node (exit 0 = allow,
 * exit 2 = block — the shell-command hook contract).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/plugin-runtime-v104.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  activateClaudePlugin,
  deactivateClaudePlugin,
  extractPluginMcpServers,
  parsePluginHooks,
  parsePromptTemplateFrontmatter,
  pluginHookBaseName,
  readPluginHooksFile,
  readPluginSkill,
  readPromptTemplates,
  renderPluginCommand,
  splitPluginMatcher,
  stripPromptTemplateFrontmatter,
} from '../packages/core/dist/acp/pluginRuntime.js';
import { HookRegistry, HookRunner } from '../packages/core/dist/hooks/index.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-plugin-v104-'));
  tempDirs.push(dir);
  return dir;
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

/** A valid fixture plugin with hooks.json shape A (object map). */
function makePluginA(dir) {
  writeFile(
    path.join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({
      name: 'review-helper',
      version: '1.2.0',
      description: 'Reviews code before it lands.',
      commands: ['review'],
      agents: ['reviewer'],
      skills: ['review-skill'],
    }),
  );
  writeFile(
    path.join(dir, 'hooks', 'hooks.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'shell-*',
            hooks: [{ type: 'command', command: 'node -e "process.exit(0)"', timeout: 5 }],
          },
        ],
        PostToolUse: [
          {
            hooks: [{ type: 'command', command: 'node -e "process.exit(2)"' }],
          },
        ],
      },
    }),
  );
  writeFile(
    path.join(dir, 'commands', 'review.md'),
    '---\nname: review\ndescription: Review the diff\nargument-hint: <path>\n---\n\nReview this code: $ARGUMENTS\n',
  );
  writeFile(
    path.join(dir, 'agents', 'reviewer.md'),
    '---\nname: reviewer\ndescription: A code reviewer\n---\n\nYou are a strict code reviewer.\n',
  );
  writeFile(
    path.join(dir, 'skills', 'review-skill', 'SKILL.md'),
    '---\nname: review-skill\ndescription: Review skill\n---\n\nReview carefully.\n',
  );
  return dir;
}

/** A fixture plugin with hooks.json shape B (array) + a bad hook. */
function makePluginB(dir) {
  writeFile(
    path.join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'b-plugin', version: '0.1.0', description: 'B shape.' }),
  );
  writeFile(
    path.join(dir, 'hooks', 'hooks.json'),
    JSON.stringify({
      hooks: [
        { event: 'PreToolUse', matcher: 'Write|Edit', command: 'node -e "process.exit(0)"' },
        { event: 'Nope', command: 'node -e "process.exit(0)"' },
        { event: 'Stop', type: 'prompt', command: 'node -e "process.exit(0)"' },
        { event: 'Stop', command: '' },
      ],
    }),
  );
  return dir;
}

test('splitPluginMatcher: | alternatives, regex-looking warns', () => {
  const warnings = [];
  assert.deepEqual(splitPluginMatcher('Write|Edit', warnings, 'h'), ['Write', 'Edit']);
  assert.equal(splitPluginMatcher(undefined, warnings, 'h'), undefined);
  assert.equal(warnings.length, 0);
  splitPluginMatcher('^Bash$', warnings, 'h');
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('regex'));
});

test('parsePluginHooks: shape A (object map)', () => {
  const { hooks, warnings } = parsePluginHooks({
    hooks: {
      PreToolUse: [{ matcher: 'shell-*', hooks: [{ type: 'command', command: 'echo hi', timeout: 5 }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: 'echo start' }] }],
    },
  });
  assert.equal(warnings.length, 0, JSON.stringify(warnings));
  assert.equal(hooks.length, 2);
  assert.deepEqual(hooks[0].matcher, ['shell-*']);
  assert.equal(hooks[0].timeoutMs, 5000, 'timeout seconds → ms');
  assert.equal(hooks[1].event, 'SessionStart');
  assert.equal(hooks[1].matcher, undefined);
});

test('parsePluginHooks: shape B (array) — bad entries skipped with warnings', () => {
  const { hooks, warnings } = parsePluginHooks({
    hooks: [
      { event: 'PreToolUse', matcher: 'Write|Edit', command: 'echo hi' },
      { event: 'Nope', command: 'echo hi' },
      { event: 'Stop', type: 'prompt', command: 'echo hi' },
      { event: 'Stop', command: '' },
      { event: 'Stop', command: 'x'.repeat(5000) },
    ],
  });
  assert.equal(hooks.length, 1);
  assert.deepEqual(hooks[0].matcher, ['Write', 'Edit']);
  assert.equal(warnings.length, 4);
  assert.deepEqual(parsePluginHooks({}).hooks, []);
  assert.deepEqual(parsePluginHooks({ hooks: 'nope' }).hooks, []);
});

test('parsePromptTemplateFrontmatter + strip + render', () => {
  const text = '---\nname: review\ndescription: Review it\nargument-hint: <path>\nallowed-tools: Read, Glob\nmodel: opus\n---\n\nReview $ARGUMENTS now.\n';
  const fm = parsePromptTemplateFrontmatter(text);
  assert.equal(fm.name, 'review');
  assert.equal(fm.description, 'Review it');
  assert.equal(fm.argumentHint, '<path>');
  assert.deepEqual(fm.allowedTools, ['Read', 'Glob']);
  assert.equal(fm.model, 'opus');
  assert.equal(stripPromptTemplateFrontmatter(text), 'Review $ARGUMENTS now.\n');
  assert.equal(
    renderPluginCommand({ name: 'review', file: 'commands/review.md', prompt: 'Review $ARGUMENTS now.' }, 'src/a.ts'),
    'Review src/a.ts now.',
  );
  assert.equal(
    renderPluginCommand({ name: 'x', file: 'x.md', prompt: 'Do it.' }, 'extra args'),
    'Do it.\n\nextra args',
  );
  assert.equal(renderPluginCommand({ name: 'x', file: 'x.md', prompt: 'Do it.' }, ''), 'Do it.');
});

test('readPromptTemplates + readPluginSkill', () => {
  const dir = makePluginA(makeTempDir());
  const { templates, warnings } = readPromptTemplates(dir, 'commands');
  assert.equal(warnings.length, 0);
  assert.equal(templates.length, 1);
  assert.equal(templates[0].name, 'review');
  assert.equal(templates[0].argumentHint, '<path>');
  assert.ok(templates[0].prompt.includes('$ARGUMENTS'));
  const agents = readPromptTemplates(dir, 'agents');
  assert.equal(agents.templates[0].name, 'reviewer');
  assert.ok(readPluginSkill(dir, 'review-skill').includes('Review carefully.'));
  assert.equal(readPluginSkill(dir, 'missing'), null);
  assert.equal(readPluginSkill(dir, '../escape'), null);
  assert.deepEqual(readPromptTemplates(dir, 'commands').templates.length, 1);
  assert.deepEqual(readPromptTemplates(makeTempDir(), 'commands'), { templates: [], warnings: [] });
});

test('pluginHookBaseName sanitises names for HOOK_NAME_RE', () => {
  assert.equal(pluginHookBaseName('review-helper'), 'review-helper');
  assert.equal(pluginHookBaseName('My.Plugin v2'), 'my-plugin-v2');
  assert.equal(pluginHookBaseName('...'), 'plugin');
});

test('activateClaudePlugin: hooks registered + runnable, commands listed', async () => {
  const dir = makePluginA(makeTempDir());
  const registry = new HookRegistry({ stateDir: makeTempDir() });
  const runner = new HookRunner(registry);
  const { plugin, errors, warnings } = activateClaudePlugin(registry, dir, { workspaceDir: makeTempDir() });
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 0, JSON.stringify(warnings));
  assert.equal(plugin.id, 'claude-plugin:review-helper');
  assert.equal(plugin.version, '1.2.0');
  assert.equal(plugin.hooks.length, 2);
  assert.equal(plugin.hookNames.length, 2);
  assert.equal(plugin.commands.length, 1);
  assert.equal(plugin.agents.length, 1);
  assert.equal(plugin.skills.length, 1);
  // The PreToolUse hook runs only for shell tools (matcher) and allows.
  const shell = await runner.runPreToolUse({ toolName: 'shell-exec', toolCallId: 'c1', args: {} });
  assert.equal(shell.decision, 'allow');
  assert.equal(shell.hooksRun.length, 1);
  const other = await runner.runPreToolUse({ toolName: 'read', toolCallId: 'c2', args: {} });
  assert.deepEqual(other.hooksRun, [], 'matcher skips non-shell tools');
  // The PostToolUse hook exits 2 → blocks (replaces the result with not-ok).
  const post = await runner.runPostToolUse({
    toolName: 'read', toolCallId: 'c3', args: {}, result: { ok: true, output: 'done' },
  });
  assert.equal(post.ok, false);
  assert.equal(post.blockedBy, 'claude-plugin-review-helper-posttooluse-1');
  // Deactivate: hooks are gone.
  const removed = deactivateClaudePlugin(registry, plugin);
  assert.equal(removed.length, 2);
  const after = await runner.runPreToolUse({ toolName: 'shell-exec', toolCallId: 'c4', args: {} });
  assert.deepEqual(after.hooksRun, []);
});

test('activateClaudePlugin: shape B plugin activates the good hook, warns the rest', async () => {
  const dir = makePluginB(makeTempDir());
  const registry = new HookRegistry({ stateDir: makeTempDir() });
  const { plugin, errors, warnings } = activateClaudePlugin(registry, dir);
  assert.deepEqual(errors, []);
  assert.equal(plugin.hooks.length, 1);
  assert.deepEqual(plugin.hooks[0].matcher, ['Write', 'Edit']);
  assert.ok(warnings.length >= 3, JSON.stringify(warnings));
  const runner = new HookRunner(registry);
  const out = await runner.runPreToolUse({ toolName: 'Write', toolCallId: 'c1', args: {} });
  assert.deepEqual(out.hooksRun, ['claude-plugin-b-plugin-pretooluse-0']);
  deactivateClaudePlugin(registry, plugin);
});

test('activateClaudePlugin: invalid manifest refuses, nothing registered', () => {
  const dir = makeTempDir();
  writeFile(
    path.join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ version: '1.0.0', description: 'no name' }),
  );
  const registry = new HookRegistry({ stateDir: makeTempDir() });
  const { plugin, errors } = activateClaudePlugin(registry, dir);
  assert.equal(plugin, null);
  assert.ok(errors.length > 0);
  assert.equal(registry.list().length, 0);
  const missing = activateClaudePlugin(registry, makeTempDir());
  assert.equal(missing.plugin, null);
  assert.ok(missing.errors.length > 0);
});

test('readPluginHooksFile: missing file = no hooks, no warnings', () => {
  const dir = makeTempDir();
  assert.deepEqual(readPluginHooksFile(dir), { hooks: [], warnings: [] });
});

test('extractPluginMcpServers: stdio + http + sse; bad entries warned, never fatal', () => {
  const { servers, warnings } = extractPluginMcpServers({
    mcpServers: {
      'fs-tools': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'], env: { HOME: '/tmp' } },
      'remote': { url: 'https://mcp.example.com/v1', type: 'http', headers: { Authorization: 'Bearer x' } },
      'stream': { url: 'https://mcp.example.com/sse', type: 'sse' },
      'broken': { type: 'stdio' },
      'weird': 'not-an-object',
    },
  });
  assert.equal(servers.length, 3);
  assert.equal(servers[0].type, 'stdio');
  assert.equal(servers[0].command, 'npx');
  assert.deepEqual(servers[0].args, ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']);
  assert.equal(servers[1].type, 'http');
  assert.equal(servers[1].url, 'https://mcp.example.com/v1');
  assert.equal(servers[2].type, 'sse');
  assert.equal(warnings.length, 2);
  assert.deepEqual(extractPluginMcpServers({}), { servers: [], warnings: [] });
  assert.deepEqual(extractPluginMcpServers({ mcpServers: {} }), { servers: [], warnings: [] });
});

test('activateClaudePlugin: manifest MCP servers are extracted (not started)', () => {
  const dir = makeTempDir();
  writeFile(
    path.join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({
      name: 'mcp-plugin', version: '1.0.0', description: 'Has MCP.',
      mcpServers: { 'my-server': { command: 'node', args: ['server.js'] } },
    }),
  );
  const registry = new HookRegistry({ stateDir: makeTempDir() });
  const { plugin, errors } = activateClaudePlugin(registry, dir);
  assert.deepEqual(errors, []);
  assert.equal(plugin.mcpServers.length, 1);
  assert.equal(plugin.mcpServers[0].name, 'my-server');
  assert.equal(plugin.mcpServers[0].type, 'stdio');
});

after(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});
