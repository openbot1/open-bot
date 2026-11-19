/**
 * Tests for v1.40 (Team T2) — protocols v9 ACP agent sessions:
 * packages/core/src/protocolsV9/acpSessionsV9.ts
 *
 * Covers:
 *  - detection with a fake probe (binary on PATH + login
 *    marker presence; markers are existence-only, never read)
 *  - detection result shape (usable only when binary + marker)
 *  - create refuses an unusable agent unless allowUnverified
 *  - send-prompt round-trip (user message + agent reply,
 *    reply linked via inReplyToMessageId, session idle after)
 *  - prompt validation (empty / too long / terminal session)
 *  - runner failure marks the session failed
 *  - set-mode (ask / auto / read-only; terminal refuses)
 *  - suspend / resume-suspended
 *  - resume as a new session (thread carried over, old
 *    session retired, fresh resume token)
 *  - cancel / complete / terminal guards
 *  - snapshot / restore (restored active sessions come back
 *    idle; unknown agents dropped)
 *  - pruneTerminal
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v9-acp.test.mjs
 *
 * No network, no process spawning, no credential access — the
 * probe and the runner are both injected fakes here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AcpV9SessionManager,
  detectAcpV9CliAgents,
  ACP_V9_KNOWN_AGENT_INFO,
} from '../packages/core/dist/index.js';

/** Fake machine: claude installed + logged in, codex installed only, gemini absent. */
function fakeProbe() {
  const binaries = new Map([
    ['claude', '/usr/local/bin/claude'],
    ['codex', '/usr/local/bin/codex'],
  ]);
  const markers = new Set(['/home/tester/.claude.json']);
  return {
    findBinary: (name) => binaries.get(name),
    markerExists: (path) => markers.has(path),
    homeDir: () => '/home/tester',
  };
}

function fakeProbeEmpty() {
  return {
    findBinary: () => undefined,
    markerExists: () => false,
    homeDir: () => '/home/tester',
  };
}

test('detection: usable only when binary + login marker are both present', () => {
  const detections = detectAcpV9CliAgents(fakeProbe());
  assert.equal(detections.length, 3);
  const claude = detections.find((d) => d.agent === 'claude');
  assert.equal(claude.binaryFound, true);
  assert.equal(claude.binaryPath, '/usr/local/bin/claude');
  assert.equal(claude.loginMarkerPresent, true);
  assert.equal(claude.usable, true);
  assert.match(claude.note, /heuristic, not proof of a live login/);
  assert.equal(claude.loginMarkerPath, '/home/tester/.claude.json');
  const codex = detections.find((d) => d.agent === 'codex');
  assert.equal(codex.binaryFound, true);
  assert.equal(codex.loginMarkerPresent, false);
  assert.equal(codex.usable, false);
  assert.match(codex.note, /no login marker found/);
  const gemini = detections.find((d) => d.agent === 'gemini');
  assert.equal(gemini.binaryFound, false);
  assert.equal(gemini.usable, false);
  // Marker paths are the documented well-known locations (existence only).
  assert.equal(ACP_V9_KNOWN_AGENT_INFO.claude.loginMarkerRelativePath, '.claude.json');
  assert.equal(ACP_V9_KNOWN_AGENT_INFO.codex.loginMarkerRelativePath, '.codex/auth.json');
  assert.equal(ACP_V9_KNOWN_AGENT_INFO.gemini.loginMarkerRelativePath, '.gemini/oauth_creds.json');
});

test('detection on an empty machine: nothing usable', () => {
  const detections = detectAcpV9CliAgents(fakeProbeEmpty());
  assert.equal(detections.filter((d) => d.usable).length, 0);
  for (const d of detections) {
    assert.equal(d.binaryFound, false);
    assert.equal(d.loginMarkerPresent, false);
  }
});

test('create refuses an unusable agent unless allowUnverified', () => {
  const manager = new AcpV9SessionManager({ probe: fakeProbe() });
  assert.throws(() => manager.create({ agent: 'codex' }), /not usable/);
  assert.throws(() => manager.create({ agent: 'gemini' }), /not usable/);
  assert.throws(() => manager.create({ agent: 'unknown' }), /Unknown ACP agent/);
  const unverified = manager.create({ agent: 'gemini', allowUnverified: true });
  assert.equal(unverified.agent, 'gemini');
  assert.equal(unverified.status, 'idle');
  const session = manager.create({ agent: 'claude', mode: 'read-only', cwd: '/tmp/work', model: 'sonnet' });
  assert.equal(session.displayName, 'Claude Code');
  assert.equal(session.mode, 'read-only');
  assert.equal(session.cwd, '/tmp/work');
  assert.equal(session.model, 'sonnet');
  assert.equal(session.resumeCount, 0);
  assert.equal(typeof session.resumeToken, 'string');
  assert.ok(session.resumeToken.length > 0);
  assert.throws(() => manager.create({ agent: 'claude', mode: 'nope' }), /Permission mode/);
});

test('send-prompt round-trip: user message + linked agent reply, idle after', async () => {
  const manager = new AcpV9SessionManager({
    probe: fakeProbe(),
    runner: (session, prompt) => ({ text: `done: ${prompt}`, toolCalls: ['read-file'] }),
  });
  const session = manager.create({ agent: 'claude' });
  const { session: after, reply } = await manager.sendPrompt(session.id, 'summarise this repo');
  assert.equal(after.status, 'idle');
  assert.equal(after.messages.length, 2);
  assert.equal(after.messages[0].role, 'user');
  assert.equal(after.messages[0].text, 'summarise this repo');
  assert.equal(reply.role, 'agent');
  assert.equal(reply.text, 'done: summarise this repo');
  assert.deepEqual(reply.toolCalls, ['read-file']);
  assert.equal(reply.inReplyToMessageId, after.messages[0].messageId);
  const history = manager.get(session.id);
  assert.equal(history.messages.length, 2);
});

test('send-prompt validation: empty, too long, terminal session', async () => {
  const manager = new AcpV9SessionManager({ probe: fakeProbe() });
  const session = manager.create({ agent: 'claude' });
  await assert.rejects(() => manager.sendPrompt(session.id, '   '), /non-empty/);
  await assert.rejects(() => manager.sendPrompt(session.id, 'x'.repeat(32 * 1024 + 1)), /max 32768/);
  manager.cancel(session.id, 'user stopped it');
  await assert.rejects(() => manager.sendPrompt(session.id, 'hello'), /is cancelled/);
  await assert.rejects(() => manager.sendPrompt('acp-999', 'hello'), /No ACP session/);
});

test('runner failure marks the session failed', async () => {
  const manager = new AcpV9SessionManager({
    probe: fakeProbe(),
    runner: () => { throw new Error('CLI crashed'); },
  });
  const session = manager.create({ agent: 'claude' });
  await assert.rejects(() => manager.sendPrompt(session.id, 'hi'), /runner failed/);
  assert.equal(manager.get(session.id).status, 'failed');
  assert.match(manager.get(session.id).reason, /CLI crashed/);
});

test('set-mode, suspend / resume-suspended, cancel / complete guards', () => {
  const manager = new AcpV9SessionManager({ probe: fakeProbe() });
  const session = manager.create({ agent: 'claude' });
  assert.equal(manager.setMode(session.id, 'auto').mode, 'auto');
  assert.throws(() => manager.setMode(session.id, 'yolo'), /Permission mode/);
  const suspended = manager.suspend(session.id, 'user paused');
  assert.equal(suspended.status, 'suspended');
  assert.throws(() => manager.suspend(session.id), /Only an active or idle session can be suspended/);
  assert.equal(manager.resumeSuspended(session.id).status, 'idle');
  assert.throws(() => manager.resumeSuspended(session.id), /Only a suspended session can be resumed/);
  const done = manager.complete(session.id, 'work finished');
  assert.equal(done.status, 'completed');
  assert.throws(() => manager.cancel(session.id), /already completed/);
  assert.throws(() => manager.setMode(session.id, 'ask'), /is completed/);
  assert.equal(manager.counts().completed, 1);
  assert.equal(manager.counts().running, 0);
});

test('resumeSession carries the thread into a new session and retires the old one', async () => {
  const manager = new AcpV9SessionManager({ probe: fakeProbe() });
  const old = manager.create({ agent: 'claude', mode: 'auto' });
  await manager.sendPrompt(old.id, 'first question');
  const next = manager.resumeSession(old.id);
  assert.notEqual(next.id, old.id);
  assert.equal(next.parentSessionId, old.id);
  assert.equal(next.resumeCount, 1);
  assert.equal(next.messages.length, 2);
  assert.equal(next.mode, 'auto');
  assert.notEqual(next.resumeToken, old.resumeToken);
  assert.equal(manager.get(old.id).status, 'completed');
  assert.match(manager.get(old.id).reason, new RegExp(`Resumed as ${next.id}`));
  assert.equal(manager.get(next.id).status, 'idle');
  // A failed session cannot be resumed.
  const failing = new AcpV9SessionManager({
    probe: fakeProbe(),
    runner: () => { throw new Error('boom'); },
  });
  const bad = failing.create({ agent: 'claude' });
  await assert.rejects(() => failing.sendPrompt(bad.id, 'hi'), /runner failed/);
  assert.throws(() => failing.resumeSession(bad.id), /cannot be resumed/);
});

test('snapshot / restore: active sessions come back idle, unknown agents dropped', async () => {
  const manager = new AcpV9SessionManager({ probe: fakeProbe() });
  const s1 = manager.create({ agent: 'claude' });
  await manager.sendPrompt(s1.id, 'hello');
  const s2 = manager.create({ agent: 'claude', allowUnverified: true });
  manager.cancel(s2.id);
  const snapshot = manager.snapshot();
  assert.equal(snapshot.version, 9);
  assert.equal(snapshot.sessions.length, 2);

  const manager2 = new AcpV9SessionManager({ probe: fakeProbeEmpty() });
  const restored = manager2.restore(snapshot);
  assert.equal(restored.restored, 2);
  assert.deepEqual(restored.dropped, []);
  assert.equal(manager2.get(s1.id).messages.length, 2);
  assert.equal(manager2.get(s1.id).status, 'idle');
  assert.equal(manager2.get(s2.id).status, 'cancelled');
  // New sessions keep counting past the restored nextId.
  const s3 = manager2.create({ agent: 'claude', allowUnverified: true });
  assert.notEqual(s3.id, s1.id);
  assert.notEqual(s3.id, s2.id);

  // Unknown agent rows are dropped.
  const bad = { ...snapshot, sessions: [...snapshot.sessions, { ...snapshot.sessions[0], id: 'acp-99', agent: 'nope' }] };
  const manager3 = new AcpV9SessionManager({ probe: fakeProbeEmpty() });
  const r3 = manager3.restore(bad);
  assert.equal(r3.restored, 2);
  assert.equal(r3.dropped.length, 1);
  assert.match(r3.dropped[0], /unknown agent/);
  assert.throws(() => manager3.restore({ version: 8, sessions: [] }), /version 9/);
});

test('pruneTerminal drops old terminal sessions only', () => {
  const manager = new AcpV9SessionManager({ probe: fakeProbe() });
  const s1 = manager.create({ agent: 'claude' });
  manager.cancel(s1.id);
  const s2 = manager.create({ agent: 'claude' });
  assert.equal(manager.pruneTerminal(), 0);
  // Age the cancelled session by restoring a snapshot with an old timestamp.
  // (snapshot lists newest first, so find the cancelled session by id.)
  const snap = manager.snapshot();
  snap.sessions.find((s) => s.id === s1.id).updatedAt = Date.now() - 100_000;
  const manager2 = new AcpV9SessionManager({ probe: fakeProbe() });
  manager2.restore(snap);
  assert.equal(manager2.pruneTerminal(60_000), 1);
  assert.equal(manager2.get(s1.id), undefined);
  assert.notEqual(manager2.get(s2.id), undefined);
  assert.equal(manager2.eventsFor(s1.id).at(-1).kind, 'pruned');
});
