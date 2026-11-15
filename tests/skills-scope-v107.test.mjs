/**
 * Tests for directory-scoped skills (v1.07, Team T4).
 *
 * A skill may declare `scope` in its frontmatter: a list of directory
 * patterns (relative to the workspace root, or absolute). The skill is
 * only offered (tier-1 index), matched and applied while the agent
 * works inside one of its scoped directories; a skill without `scope`
 * is global and behaves exactly as before.
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/skills-scope-v107.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  SkillLoadError,
  SkillRegistry,
  buildDirectorySkillIndex,
  describeSkillScope,
  filterSkillsByDirectory,
  isSkillInScope,
  matchScopePattern,
  normalizeScopePattern,
  normalizeSkillScope,
  parseSkillMarkdown,
  resolveWorkingDir,
} from '../packages/core/dist/index.js';

const tempDirs = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-scope-v107-'));
  tempDirs.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function skill(name, scope) {
  return { name, scope };
}

function writeSkill(dir, name, description, scopeLine, body = 'Do the thing.') {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  const scope = scopeLine ? `\nscope: ${scopeLine}` : '';
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}${scope}\n---\n\n${body}\n`,
  );
}

// --- normalizeSkillScope ---

test('normalizeSkillScope: string, list, dedupe, empty -> undefined', () => {
  assert.deepEqual(normalizeSkillScope('src/server, docs/**'), ['src/server', 'docs']);
  assert.deepEqual(normalizeSkillScope(['a', 'a', ' b ', '']), ['a', 'b']);
  assert.equal(normalizeSkillScope(undefined), undefined);
  assert.equal(normalizeSkillScope(null), undefined);
  assert.equal(normalizeSkillScope(''), undefined);
  assert.equal(normalizeSkillScope([]), undefined);
});

test('normalizeSkillScope: rejects ".." escape, wrong type, too many entries', () => {
  assert.throws(() => normalizeSkillScope('../etc', 'x'), SkillLoadError);
  assert.throws(() => normalizeSkillScope('a/../b', 'x'), SkillLoadError);
  assert.throws(() => normalizeSkillScope(42, 'x'), SkillLoadError);
  assert.throws(() => normalizeSkillScope([42], 'x'), SkillLoadError);
  const many = Array.from({ length: 33 }, (_, i) => `dir${i}`);
  assert.throws(() => normalizeSkillScope(many, 'x'), SkillLoadError);
});

test('normalizeScopePattern: strips trailing /**, backslashes, dot segments', () => {
  assert.equal(normalizeScopePattern('docs/**'), 'docs');
  assert.equal(normalizeScopePattern('src\\server\\'), 'src/server');
  assert.equal(normalizeScopePattern('./src/./server'), 'src/server');
  assert.equal(normalizeScopePattern('apps/*/client'), 'apps/*/client');
});

// --- matchScopePattern ---

test('matchScopePattern: bare dir matches itself and its subtree', () => {
  const ws = '/ws';
  assert.equal(matchScopePattern('src/server', '/ws/src/server', ws), true);
  assert.equal(matchScopePattern('src/server', '/ws/src/server/a', ws), true);
  assert.equal(matchScopePattern('src/server', '/ws/src/server/a/b/c.ts', ws), true);
  assert.equal(matchScopePattern('src/server', '/ws/src/client', ws), false);
  assert.equal(matchScopePattern('src/server', '/ws/src', ws), false);
  assert.equal(matchScopePattern('src/server', '/ws/src/server2', ws), false);
});

test('matchScopePattern: * matches one segment, ** matches any depth', () => {
  const ws = '/ws';
  assert.equal(matchScopePattern('apps/*/client', '/ws/apps/foo/client', ws), true);
  assert.equal(matchScopePattern('apps/*/client', '/ws/apps/foo/bar/client', ws), false);
  assert.equal(matchScopePattern('apps/*/client', '/ws/apps/foo/client/deep', ws), false);
  assert.equal(matchScopePattern('**/migrations', '/ws/migrations', ws), true);
  assert.equal(matchScopePattern('**/migrations', '/ws/a/b/migrations', ws), true);
  assert.equal(matchScopePattern('**/migrations', '/ws/a/migrations/x', ws), false);
  assert.equal(matchScopePattern('docs/*.md', '/ws/docs/a.md', ws), true);
  assert.equal(matchScopePattern('docs/*.md', '/ws/docs/sub/a.md', ws), false);
});

test('matchScopePattern: absolute patterns match by absolute path; outside workspace only globals match', () => {
  assert.equal(matchScopePattern('/data/shared', '/data/shared/sub', '/ws'), true);
  assert.equal(matchScopePattern('/data/shared', '/data/other', '/ws'), false);
  assert.equal(matchScopePattern('src/server', '/elsewhere/src/server', '/ws'), false);
});

// --- isSkillInScope / filterSkillsByDirectory ---

test('isSkillInScope: global skills always in scope; scoped need a match', () => {
  const ws = '/ws';
  assert.equal(isSkillInScope(skill('g'), '/ws/anywhere', ws), true);
  assert.equal(isSkillInScope(skill('g', []), '/ws/anywhere', ws), true);
  assert.equal(isSkillInScope(skill('s', ['src/server']), '/ws/src/server', ws), true);
  assert.equal(isSkillInScope(skill('s', ['src/server']), '/ws/src/client', ws), false);
  assert.equal(
    isSkillInScope(skill('s', ['src/server', 'docs']), '/ws/docs/guide', ws),
    true,
  );
});

test('filterSkillsByDirectory: keeps globals + matches, drops the rest, never mutates', () => {
  const ws = '/ws';
  const skills = [
    skill('global-one'),
    skill('server-only', ['src/server']),
    skill('docs-only', ['docs']),
  ];
  const filtered = filterSkillsByDirectory(skills, '/ws/src/server', ws);
  assert.deepEqual(filtered.map((s) => s.name), ['global-one', 'server-only']);
  assert.equal(skills.length, 3);
});

test('describeSkillScope + resolveWorkingDir', () => {
  assert.equal(describeSkillScope(skill('g')), 'Global');
  assert.equal(describeSkillScope(skill('s', ['a', 'b'])), 'Chỉ trong: a, b');
  assert.equal(resolveWorkingDir('', '/ws'), path.resolve('/ws'));
  assert.equal(resolveWorkingDir('sub', '/ws'), path.resolve('/ws/sub'));
  assert.equal(resolveWorkingDir('/abs', '/ws'), path.resolve('/abs'));
});

// --- loader: scope frontmatter ---

test('parseSkillMarkdown: scope parses into skill.scope; ".." fails the load', () => {
  const parsed = parseSkillMarkdown(
    '---\nname: scoped-skill\ndescription: Use it in the server dir.\nscope: [src/server, docs/**]\n---\n\nDo the thing.\n',
    'user',
  );
  assert.deepEqual(parsed.scope, ['src/server', 'docs']);
  assert.throws(
    () =>
      parseSkillMarkdown(
        '---\nname: bad-scope\ndescription: Bad.\nscope: ../etc\n---\n\nDo the thing.\n',
        'user',
      ),
    SkillLoadError,
  );
  const global = parseSkillMarkdown(
    '---\nname: plain\ndescription: Plain skill.\n---\n\nDo the thing.\n',
    'user',
  );
  assert.equal(global.scope, undefined);
});

// --- registry: directory-aware index / match / apply ---

function registryWithSkills() {
  const ws = tmpDir();
  const userDir = path.join(ws, 'skills');
  fs.mkdirSync(userDir, { recursive: true });
  writeSkill(userDir, 'review-code', 'Review code changes for bugs.', undefined, 'Review the diff carefully.');
  writeSkill(userDir, 'deploy-server', 'Deploy the server to production.', '[src/server]', 'Deploy the server.');
  writeSkill(userDir, 'write-docs', 'Write documentation pages.', '[docs]', 'Write docs.');
  const registry = new SkillRegistry({ userSkillsDir: userDir, stateDir: tmpDir() });
  registry.load();
  return { ws, registry };
}

test('SkillRegistry.listForDirectory: scope gates the list', () => {
  const { ws, registry } = registryWithSkills();
  // Built-ins are global, so they appear everywhere; the scoped user
  // skills appear only in their own directories.
  const server = registry.listForDirectory('src/server', ws).map((s) => s.name);
  assert.ok(server.includes('deploy-server'));
  assert.ok(server.includes('review-code'));
  assert.ok(!server.includes('write-docs'));
  const docs = registry.listForDirectory('docs', ws).map((s) => s.name);
  assert.ok(docs.includes('write-docs'));
  assert.ok(docs.includes('review-code'));
  assert.ok(!docs.includes('deploy-server'));
  const elsewhere = registry.listForDirectory('elsewhere', ws).map((s) => s.name);
  assert.ok(elsewhere.includes('review-code'));
  assert.ok(!elsewhere.includes('deploy-server'));
  assert.ok(!elsewhere.includes('write-docs'));
});

test('SkillRegistry.directorySkillIndex: tier-1 entries + hidden accounting', () => {
  const { ws, registry } = registryWithSkills();
  const total = registry.list().length; // 3 user skills + built-ins (all global)
  const index = registry.directorySkillIndex('src/server', ws);
  assert.equal(index.totalSkills, total);
  assert.equal(index.inScope, total - 1); // only write-docs is hidden here
  assert.equal(index.hiddenByScope, 1);
  assert.deepEqual(index.hiddenNames, ['write-docs']);
  assert.ok(index.entries.some((e) => e.name === 'deploy-server'));
  assert.ok(index.entries.some((e) => e.name === 'review-code'));
  assert.ok(!index.entries.some((e) => e.name === 'write-docs'));
  assert.ok(index.estimatedTokens > 0);
  const text = registry.formatSkillIndexForDirectory('src/server', ws);
  assert.ok(text.includes('deploy-server'));
  assert.ok(!text.includes('write-docs'));
});

test('SkillRegistry.matchSkillsForDirectory: a scoped skill never matches outside its dirs', () => {
  const { ws, registry } = registryWithSkills();
  const inScope = registry.matchSkillsForDirectory('deploy the server', 'src/server', ws);
  // The scoped skill ranks first in its own directory (built-in
  // globals may also match the task — the property under test is
  // that the SCOPED skill is present here and absent outside).
  assert.equal(inScope[0].skill.name, 'deploy-server');
  assert.ok(inScope[0].score > 0);
  const outOfScope = registry.matchSkillsForDirectory('deploy the server', 'docs', ws);
  assert.ok(!outOfScope.some((m) => m.skill.name === 'deploy-server'));
});

test('SkillRegistry.applySkillsForDirectory: injects only in-scope winners', () => {
  const { ws, registry } = registryWithSkills();
  const prompt = registry.applySkillsForDirectory('You are an agent.', 'deploy the server', 'src/server', ws);
  assert.ok(prompt.includes('Deploy the server.'));
  // Outside its directories the scoped skill's body is never injected,
  // even though the task matches it (built-in globals may still match —
  // the property under test is that the SCOPED skill stays out).
  const outside = registry.applySkillsForDirectory('You are an agent.', 'deploy the server', 'docs', ws);
  assert.ok(!outside.includes('Deploy the server.'));
  assert.ok(!outside.includes('### Skill: deploy-server'));
});

test('buildDirectorySkillIndex: pure helper over a skill list', () => {
  const ws = '/ws';
  const skills = [
    { name: 'a', description: 'A', context: undefined, allowedTools: [], enabled: true, disableModelInvocation: false, scope: undefined },
    { name: 'b', description: 'B', context: undefined, allowedTools: [], enabled: true, disableModelInvocation: false, scope: ['src'] },
  ];
  const index = buildDirectorySkillIndex(skills, { workspaceDir: ws, workingDir: '/ws/other' });
  assert.equal(index.inScope, 1);
  assert.deepEqual(index.hiddenNames, ['b']);
});
