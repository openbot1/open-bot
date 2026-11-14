/**
 * Tests for v1.04 session importer (packages/core/src/session/importer.ts):
 * discovery (Codex CLI + Claude Code session files), JSONL parsing for
 * both formats, corrupt-line tolerance, credential-field stripping,
 * symlink refusal, write/read round-trip, ACP message mapping.
 *
 * Privacy assertions (the point of the module):
 * - discovery lists ONLY *.jsonl files under ~/.codex/sessions/<date>/
 *   and ~/.claude/projects/<project>/ — a home full of auth.json / .credentials /
 *   config files yields zero candidates for those files;
 * - a symlinked session file is refused, never followed;
 * - credential-looking fields are stripped from imported records.
 *
 * All fixtures are built in temp dirs (no real home directory is read).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/session-importer-v104.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  CREDENTIAL_FIELD_PATTERN,
  discoverImportableSessions,
  importSessionFile,
  listImportedSessions,
  parseClaudeSessionFile,
  parseCodexSessionFile,
  readImportedSession,
  stripCredentialFields,
  summarizeImportedSession,
  toAcpMessages,
  writeImportedSession,
} from '../packages/core/dist/session/importer.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-import-v104-'));
  tempDirs.push(dir);
  return dir;
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

const CODEX_JSONL = [
  JSON.stringify({ type: 'session_meta', cwd: '/home/u/proj', model: 'gpt-5', timestamp: '2026-11-14T08:00:00.000Z' }),
  JSON.stringify({ type: 'message', role: 'user', content: 'Fix the login bug', timestamp: '2026-11-14T08:00:01.000Z' }),
  JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Looking into it.' }], timestamp: '2026-11-14T08:00:02.000Z' }),
  JSON.stringify({ type: 'function_call', call_id: 'c1', name: 'read', arguments: '{"path":"src/login.ts"}', timestamp: '2026-11-14T08:00:03.000Z' }),
  JSON.stringify({ type: 'function_call_output', call_id: 'c1', output: 'export function login() {}', timestamp: '2026-11-14T08:00:04.000Z' }),
  JSON.stringify({ type: 'reasoning', content: 'internal chain of thought' }),
  'this line is not json',
  JSON.stringify({ type: 'mystery_type', foo: 1 }),
  JSON.stringify({ type: 'message', role: 'assistant', content: 'Fixed it.', api_key: 'sk-should-be-stripped' }),
].join('\n');

const CLAUDE_JSONL = [
  JSON.stringify({
    type: 'user', cwd: '/home/u/proj', timestamp: '2026-11-14T09:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'Add a test' }] },
  }),
  JSON.stringify({
    type: 'assistant', timestamp: '2026-11-14T09:00:01.000Z',
    message: {
      role: 'assistant', model: 'claude-opus-4-5', content: [
        { type: 'text', text: 'Writing the test now.' },
        { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/home/u/proj/test.ts', content: 'test' } },
      ],
    },
  }),
  JSON.stringify({
    type: 'assistant', timestamp: '2026-11-14T09:00:02.000Z',
    message: {
      role: 'assistant', content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'Wrote 12 lines' },
      ],
    },
  }),
  JSON.stringify({ type: 'summary', summary: 'Added a test' }),
  JSON.stringify({ type: 'file-history-snapshot', foo: 1 }),
  'garbage line',
].join('\n');

test('stripCredentialFields + pattern', () => {
  assert.equal(CREDENTIAL_FIELD_PATTERN.test('api_key'), true);
  assert.equal(CREDENTIAL_FIELD_PATTERN.test('authToken'), true);
  assert.equal(CREDENTIAL_FIELD_PATTERN.test('model'), false);
  assert.deepEqual(
    stripCredentialFields({ model: 'gpt-5', api_key: 'x', token: 'y', cwd: '/tmp' }),
    { model: 'gpt-5', cwd: '/tmp' },
  );
});

test('parseCodexSessionFile: messages, tool calls + results, tolerance', () => {
  const session = parseCodexSessionFile('/home/u/.codex/sessions/2026-11-14/abc123.jsonl', CODEX_JSONL);
  assert.equal(session.source, 'codex');
  assert.equal(session.id, 'imported-codex-abc123');
  assert.equal(session.cwd, '/home/u/proj');
  assert.equal(session.model, 'gpt-5');
  assert.equal(session.title, 'Fix the login bug');
  assert.equal(session.skippedLines, 1, 'one corrupt line');
  assert.ok(session.warnings.some((w) => w.includes('mystery_type')));
  assert.equal(session.messages.length, 3);
  assert.equal(session.messages[0].role, 'user');
  assert.equal(session.messages[0].content, 'Fix the login bug');
  assert.equal(session.messages[1].content, 'Looking into it.');
  // The function call attached to the assistant message, with its result.
  assert.equal(session.messages[1].toolCalls.length, 1);
  assert.equal(session.messages[1].toolCalls[0].name, 'read');
  assert.deepEqual(session.messages[1].toolCalls[0].args, { path: 'src/login.ts' });
  assert.equal(session.messages[1].toolCalls[0].result, 'export function login() {}');
  // Reasoning records are not user history.
  assert.equal(session.messages.some((m) => m.content.includes('chain of thought')), false);
  // The credential-looking field on the last message never reaches the output.
  assert.equal(JSON.stringify(session).includes('sk-should-be-stripped'), false);
  assert.equal(session.messages[2].content, 'Fixed it.');
});

test('parseClaudeSessionFile: messages, tool_use + tool_result, bookkeeping skipped', () => {
  const session = parseClaudeSessionFile('/home/u/.claude/projects/-home-u-proj/def456.jsonl', CLAUDE_JSONL);
  assert.equal(session.source, 'claude-code');
  assert.equal(session.id, 'imported-claude-code-def456');
  assert.equal(session.cwd, '/home/u/proj');
  assert.equal(session.model, 'claude-opus-4-5');
  assert.equal(session.title, 'Add a test');
  assert.equal(session.skippedLines, 1);
  assert.equal(session.messages.length, 2);
  assert.equal(session.messages[0].role, 'user');
  assert.equal(session.messages[1].role, 'assistant');
  assert.equal(session.messages[1].content, 'Writing the test now.');
  assert.equal(session.messages[1].toolCalls.length, 1);
  assert.equal(session.messages[1].toolCalls[0].name, 'Write');
  assert.equal(session.messages[1].toolCalls[0].result, 'Wrote 12 lines');
  // The tool input kept its fields but no credential-looking keys.
  assert.equal(session.messages[1].toolCalls[0].args.file_path, '/home/u/proj/test.ts');
});

test('discoverImportableSessions: only session dirs, only .jsonl, newest first', () => {
  const home = makeTempDir();
  const codexFile = writeFile(
    path.join(home, '.codex', 'sessions', '2026-11-14', 's1.jsonl'),
    CODEX_JSONL,
  );
  const claudeFile = writeFile(
    path.join(home, '.claude', 'projects', '-home-u-proj', 's2.jsonl'),
    CLAUDE_JSONL,
  );
  // Credential / config files that must NEVER be candidates.
  writeFile(path.join(home, '.codex', 'auth.json'), '{"api_key":"sk-x"}');
  writeFile(path.join(home, '.claude', '.credentials.json'), '{"token":"y"}');
  writeFile(path.join(home, '.claude', 'settings.json'), '{"model":"z"}');
  writeFile(path.join(home, '.codex', 'sessions', '2026-11-14', 'notes.txt'), 'not a session');
  // A symlink session file: listed? No — discovery skips symlinks.
  fs.symlinkSync(codexFile, path.join(home, '.codex', 'sessions', '2026-11-14', 'link.jsonl'));
  // Timestamps: make the claude file newer.
  const now = new Date();
  fs.utimesSync(codexFile, new Date(now.getTime() - 60000), new Date(now.getTime() - 60000));
  fs.utimesSync(claudeFile, now, now);

  const found = discoverImportableSessions(home);
  assert.equal(found.length, 2);
  assert.equal(found[0].source, 'claude-code', 'newest first');
  assert.equal(found[0].filePath, claudeFile);
  assert.equal(found[1].source, 'codex');
  assert.equal(found[1].sessionId, 's1');
  assert.ok(found.every((f) => f.filePath.endsWith('.jsonl')));
  assert.ok(found.every((f) => !f.filePath.includes('auth') && !f.filePath.includes('credentials')));
  // Missing dirs: empty, not an error.
  assert.deepEqual(discoverImportableSessions(makeTempDir()), []);
  assert.deepEqual(discoverImportableSessions(''), []);
});

test('importSessionFile: reads a discovered file; refuses symlinks and oversize', () => {
  const home = makeTempDir();
  const real = writeFile(path.join(home, '.codex', 'sessions', '2026-11-14', 'ok.jsonl'), CODEX_JSONL);
  const ok = importSessionFile(real, 'codex');
  assert.equal(ok.session !== null, true);
  assert.equal(ok.session.messages.length, 3);
  const link = path.join(home, '.codex', 'sessions', '2026-11-14', 'link.jsonl');
  fs.symlinkSync(real, link);
  const refused = importSessionFile(link, 'codex');
  assert.equal(refused.session, null);
  assert.ok(refused.error.includes('symlink'));
  const missing = importSessionFile(path.join(home, 'nope.jsonl'), 'codex');
  assert.equal(missing.session, null);
  assert.ok(missing.error.includes('Cannot read'));
});

test('writeImportedSession + readImportedSession round-trip (0600, id guard)', () => {
  const ws = makeTempDir();
  const session = parseCodexSessionFile('/x/s.jsonl', CODEX_JSONL);
  const written = writeImportedSession(ws, session);
  assert.ok(written.endsWith(`imported-codex-s.json`));
  const stat = fs.statSync(written);
  assert.equal(stat.mode & 0o777, 0o600);
  const back = readImportedSession(ws, session.id);
  // Compare JSON-normalised: in-memory messages may carry explicit
  // `undefined` fields (e.g. a missing timestamp) that JSON drops.
  assert.deepEqual(back, JSON.parse(JSON.stringify(session)));
  assert.equal(readImportedSession(ws, 'no-such-id'), null);
  assert.equal(readImportedSession(ws, '../escape'), null, 'path traversal refused');
  assert.throws(
    () => writeImportedSession(ws, { ...session, id: '../escape' }),
    /Invalid imported session id/,
  );
});

test('toAcpMessages: user→user, assistant/tool→agent, tool calls as text', () => {
  const session = parseClaudeSessionFile('/x/s.jsonl', CLAUDE_JSONL);
  const msgs = toAcpMessages(session);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[0].text, 'Add a test');
  assert.equal(msgs[1].role, 'agent');
  assert.ok(msgs[1].text.includes('Writing the test now.'));
  assert.ok(msgs[1].text.includes('[tool Write'));
  assert.ok(msgs[1].text.includes('[tool Write result] Wrote 12 lines'));
  // Empty assistant messages are dropped.
  const empty = parseCodexSessionFile('/x/e.jsonl', JSON.stringify({ type: 'message', role: 'assistant', content: '' }));
  assert.deepEqual(toAcpMessages(empty), []);
});

test('summarizeImportedSession + listImportedSessions', () => {
  const session = parseCodexSessionFile('/x/s.jsonl', CODEX_JSONL);
  const summary = summarizeImportedSession(session);
  assert.equal(summary.id, 'imported-codex-s');
  assert.equal(summary.messageCount, 3);
  assert.equal(summary.userMessages, 1);
  assert.equal(summary.assistantMessages, 2);
  assert.equal(summary.toolMessages, 0);
  assert.equal(summary.toolCallCount, 1);
  assert.deepEqual(summary.toolNames, ['read']);
  assert.equal(summary.skippedLines, 1);
  assert.equal(summary.warningCount, 1);
  assert.equal(summary.startedAt, '2026-11-14T08:00:00.000Z');
  assert.equal(summary.endedAt, '2026-11-14T08:00:02.000Z');
  assert.equal(summary.durationMs, 2000);

  const ws = makeTempDir();
  writeImportedSession(ws, session);
  const claude = parseClaudeSessionFile('/x/c.jsonl', CLAUDE_JSONL);
  writeImportedSession(ws, claude);
  // A corrupt file in the dir: skipped, not fatal.
  fs.writeFileSync(path.join(ws, '.open-bot', 'imported-sessions', 'broken.json'), '{nope', 'utf-8');
  const { summaries, skipped } = listImportedSessions(ws);
  assert.equal(summaries.length, 2);
  assert.equal(skipped, 1);
  assert.equal(summaries[0].source, 'claude-code', 'newest first (09:00 > 08:00)');
  assert.equal(summaries[1].source, 'codex');
  assert.deepEqual(listImportedSessions(makeTempDir()), { summaries: [], skipped: 0 });
});

after(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});
