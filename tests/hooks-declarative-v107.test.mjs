/**
 * Tests for declarative hooks (v1.07, Team T4).
 *
 * Hooks declared in a `hooks.json` file (script or shell command) are
 * parsed, validated and registered into the HookRegistry — one bad
 * entry never blocks the others. Also covered: the SessionStart
 * context-injection helper and the Stop cleanup helper.
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/hooks-declarative-v107.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  HookRegistry,
  HookRunner,
  applyHooksConfig,
  createSessionStartContextHook,
  createStopCleanupHook,
  findHooksConfigFiles,
  loadAndApplyHooksConfig,
  loadHooksConfigFile,
  parseHooksConfig,
} from '../packages/core/dist/index.js';

const tempDirs = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-hooks-decl-v107-'));
  tempDirs.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function writeScript(dir, name, decisionJson) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    'let buf = "";\n' +
      'process.stdin.on("data", (d) => (buf += d));\n' +
      'process.stdin.on("end", () => {\n' +
      `  console.log(JSON.stringify(${decisionJson}));\n` +
      '});\n',
    'utf8',
  );
  return file;
}

function registry() {
  return new HookRegistry({ stateDir: tmpDir() });
}

// --- parseHooksConfig ---

test('parseHooksConfig: a good config parses (script resolved absolute)', () => {
  const dir = tmpDir();
  writeScript(dir, 'guard.mjs', '{ action: "allow" }');
  const result = parseHooksConfig(
    {
      version: 1,
      hooks: [
        { name: 'guard', script: 'guard.mjs', events: ['PreToolUse'], matcher: 'shell_exec' },
        { name: 'fmt', command: 'npm run format', events: ['PostToolUse'] },
      ],
    },
    { baseDir: dir },
  );
  assert.deepEqual(result.issues, []);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].name, 'guard');
  assert.equal(result.entries[0].resolvedScript, path.join(dir, 'guard.mjs'));
  assert.equal(result.entries[1].command, 'npm run format');
});

test('parseHooksConfig: rejects bad version, bad events, both/neither script+command, duplicates', () => {
  const dir = tmpDir();
  writeScript(dir, 'a.mjs', '{ action: "allow" }');
  assert.ok(parseHooksConfig({ version: 2, hooks: [] }, { baseDir: dir }).issues.length > 0);
  assert.ok(parseHooksConfig({ hooks: 'nope' }, { baseDir: dir }).issues.length > 0);
  assert.ok(
    parseHooksConfig(
      { version: 1, hooks: [{ name: 'x', script: 'a.mjs', events: ['Nope'] }] },
      { baseDir: dir },
    ).issues.length > 0,
  );
  assert.ok(
    parseHooksConfig(
      { version: 1, hooks: [{ name: 'x', script: 'a.mjs', command: 'echo', events: ['Stop'] }] },
      { baseDir: dir },
    ).issues.length > 0,
  );
  assert.ok(
    parseHooksConfig(
      { version: 1, hooks: [{ name: 'x', events: ['Stop'] }] },
      { baseDir: dir },
    ).issues.length > 0,
  );
  assert.ok(
    parseHooksConfig(
      {
        version: 1,
        hooks: [
          { name: 'x', script: 'a.mjs', events: ['Stop'] },
          { name: 'x', command: 'echo', events: ['Stop'] },
        ],
      },
      { baseDir: dir },
    ).issues.length > 0,
  );
});

test('parseHooksConfig: script must exist inside the base dir, with a script extension', () => {
  const dir = tmpDir();
  writeScript(dir, 'a.mjs', '{ action: "allow" }');
  const missing = parseHooksConfig(
    { version: 1, hooks: [{ name: 'x', script: 'nope.mjs', events: ['Stop'] }] },
    { baseDir: dir },
  );
  assert.ok(missing.issues.some((i) => i.includes('hooks[0].script')));
  const escaping = parseHooksConfig(
    { version: 1, hooks: [{ name: 'x', script: '../evil.mjs', events: ['Stop'] }] },
    { baseDir: dir },
  );
  assert.ok(escaping.issues.some((i) => i.includes('hooks[0].script')));
  const wrongExt = parseHooksConfig(
    { version: 1, hooks: [{ name: 'x', script: 'a.txt', events: ['Stop'] }] },
    { baseDir: dir },
  );
  assert.ok(wrongExt.issues.some((i) => i.includes('hooks[0].script')));
});

test('parseHooksConfig: command hooks go through the command validator (secret env rejected)', () => {
  const dir = tmpDir();
  const result = parseHooksConfig(
    {
      version: 1,
      hooks: [
        {
          name: 'leaky',
          command: 'echo hi',
          events: ['Stop'],
          env: { MY_API_KEY: 'x' },
        },
      ],
    },
    { baseDir: dir },
  );
  assert.ok(result.issues.some((i) => i.includes('env')));
  assert.equal(result.entries.length, 0);
});

test('loadHooksConfigFile: reads from disk; findHooksConfigFiles finds both locations', () => {
  const ws = tmpDir();
  writeScript(path.join(ws, '.open-bot'), 'a.mjs', '{ action: "allow" }');
  fs.writeFileSync(
    path.join(ws, '.open-bot', 'hooks.json'),
    JSON.stringify({ version: 1, hooks: [{ name: 'a', script: 'a.mjs', events: ['Stop'] }] }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(ws, 'hooks.json'),
    JSON.stringify({ version: 1, hooks: [{ name: 'b', command: 'echo hi', events: ['Stop'] }] }),
    'utf8',
  );
  const found = findHooksConfigFiles(ws);
  assert.deepEqual(found, [path.join(ws, '.open-bot', 'hooks.json'), path.join(ws, 'hooks.json')]);
  const loaded = loadHooksConfigFile(path.join(ws, '.open-bot', 'hooks.json'));
  assert.deepEqual(loaded.issues, []);
  assert.equal(loaded.entries[0].name, 'a');
  const missing = loadHooksConfigFile(path.join(ws, 'nope.json'));
  assert.ok(missing.issues.length > 0);
  const badJson = path.join(ws, 'bad.json');
  fs.writeFileSync(badJson, '{oops', 'utf8');
  assert.ok(loadHooksConfigFile(badJson).issues.length > 0);
});

// --- applyHooksConfig ---

test('applyHooksConfig: registers script + command hooks; disabled entries are skipped', async () => {
  const dir = tmpDir();
  writeScript(dir, 'allow.mjs', '{ action: "allow" }');
  const reg = registry();
  const parsed = parseHooksConfig(
    {
      version: 1,
      hooks: [
        { name: 'allow-it', script: 'allow.mjs', events: ['PreToolUse'] },
        { name: 'echo-it', command: 'echo hi', events: ['Stop'] },
        { name: 'off-it', script: 'allow.mjs', events: ['Stop'], enabled: false },
      ],
    },
    { baseDir: dir },
  );
  assert.deepEqual(parsed.issues, []);
  const applied = applyHooksConfig(reg, parsed.entries, { workspaceDir: dir });
  assert.deepEqual(applied.applied, ['allow-it', 'echo-it']);
  assert.deepEqual(applied.skipped, ['off-it']);
  assert.deepEqual(applied.invalid, []);
  assert.ok(reg.get('allow-it'));
  assert.ok(reg.get('echo-it'));
  assert.equal(reg.get('off-it'), undefined);
  // The registered script hook really runs.
  const runner = new HookRunner(reg);
  const outcome = await runner.runPreToolUse(
    { toolName: 'shell_exec', toolCallId: 'c1', args: {} },
    { workspaceDir: dir },
  );
  assert.equal(outcome.decision, 'allow');
  assert.deepEqual(outcome.hooksRun, ['allow-it']);
});

test('applyHooksConfig: one bad entry never blocks the others', () => {
  const dir = tmpDir();
  writeScript(dir, 'ok.mjs', '{ action: "allow" }');
  const reg = registry();
  const parsed = parseHooksConfig(
    {
      version: 1,
      hooks: [{ name: 'ok-hook', script: 'ok.mjs', events: ['Stop'] }],
    },
    { baseDir: dir },
  );
  // A hand-built entry with a dangling script path (parse would have rejected it).
  const applied = applyHooksConfig(
    reg,
    [...parsed.entries, { name: 'bad-hook', script: 'missing.mjs', events: ['Stop'], resolvedScript: path.join(dir, 'missing.mjs') }],
    { workspaceDir: dir },
  );
  assert.deepEqual(applied.applied, ['ok-hook']);
  assert.equal(applied.invalid.length, 1);
  assert.equal(applied.invalid[0].name, 'bad-hook');
});

test('loadAndApplyHooksConfig: parse issues short-circuit, good file applies', () => {
  const dir = tmpDir();
  writeScript(dir, 'ok.mjs', '{ action: "allow" }');
  const file = path.join(dir, 'hooks.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, hooks: [{ name: 'ok-hook', script: 'ok.mjs', events: ['Stop'] }] }),
    'utf8',
  );
  const reg = registry();
  const good = loadAndApplyHooksConfig(reg, file, { workspaceDir: dir });
  assert.deepEqual(good.parseIssues, []);
  assert.deepEqual(good.applied.applied, ['ok-hook']);
  const badFile = path.join(dir, 'bad.json');
  fs.writeFileSync(badFile, JSON.stringify({ version: 1, hooks: [{ name: 'x' }] }), 'utf8');
  const bad = loadAndApplyHooksConfig(reg, badFile, { workspaceDir: dir });
  assert.ok(bad.parseIssues.length > 0);
  assert.equal(reg.get('x'), undefined);
});

// --- lifecycle helpers ---

test('createSessionStartContextHook: injects context; provider returning nothing allows', async () => {
  const reg = registry();
  reg.register(
    createSessionStartContextHook('inject-rules', () => 'Workspace rules: be careful.'),
  );
  reg.register(
    createSessionStartContextHook('inject-nothing', () => null),
  );
  reg.register(
    createSessionStartContextHook('inject-throws', () => {
      throw new Error('boom');
    }),
  );
  const runner = new HookRunner(reg);
  const outcome = await runner.runSessionStart({ source: 'startup' }, {});
  assert.equal(outcome.context.length, 1);
  assert.ok(outcome.context[0].includes('Workspace rules'));
});

test('createStopCleanupHook: runs cleanups in order; a throwing cleanup never breaks the stop', async () => {
  const seen = [];
  const logs = [];
  const reg = registry();
  reg.register(
    createStopCleanupHook(
      'cleanup',
      [
        () => {
          seen.push('first');
        },
        () => {
          seen.push('second');
          throw new Error('cleanup boom');
        },
        async () => {
          seen.push('third');
        },
      ],
      { logger: (msg) => logs.push(msg) },
    ),
  );
  const runner = new HookRunner(reg);
  const outcome = await runner.runStop({ reason: 'user' }, {});
  assert.deepEqual(seen, ['first', 'second', 'third']);
  assert.deepEqual(outcome.context, []);
  assert.deepEqual(outcome.hooksRun, ['cleanup']);
  assert.ok(logs.some((l) => l.includes('cleanup boom')));
});
