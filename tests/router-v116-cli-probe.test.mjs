/**
 * Router v2 CLI probe tests (v1.16, Doi T3 — node:test, no real CLI).
 *
 * Covers (fake finder + fake runner + tmp HOME):
 * - probeCliAgent cho ca 6 CLI: ton tai, version, versionSupported,
 *   login, account label (CHI NHAN), model list.
 * - Version qua cu -> versionSupported=false + ly do.
 * - Version moi hon max da kiem chung -> versionUntested + warning.
 * - Format output la -> formatStatus='unknown' + warning (khong crash).
 * - Khong cai -> exists=false + not-installed.
 * - Version probe loi/timeout -> version-probe-failed.
 * - Gemini: nhan tu google_accounts.json (chi email); khong doc
 *   oauth_creds.json; khong co file -> not-signed-in.
 * - Aider: env-present — co bien API key -> loggedIn; khong co -> false.
 * - parseCliVersion / compareCliVersions / safeParseJson.
 * - probeAllCliAgents: tra du 6 ket qua, enabled theo enabledKinds.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/router-v116-cli-probe.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  compareCliVersions,
  geminiOauthCredsExist,
  parseCliVersion,
  probeAllCliAgents,
  probeCliAgent,
  readGeminiAccountLabel,
  safeParseJson,
  CLI_ADAPTERS,
} from '../packages/core/dist/routerV2/index.js';

/** Fake finder: tra duong dan gia cho binary co trong map. */
function makeFinder(installed) {
  return (names) => {
    for (const name of names) {
      if (installed.has(name)) return `/usr/bin/${name}`;
    }
    return null;
  };
}

/**
 * Fake runner: tra output theo (binary, args.join(' ')).
 * `scenarios` la map tu khoa args -> { code, stdout, stderr }.
 */
function makeRunner(scenarios) {
  return async (binary, args) => {
    const key = `${binary} ${args.join(' ')}`;
    for (const [needle, res] of scenarios) {
      if (key.includes(needle)) return { code: res.code ?? 0, stdout: res.stdout ?? '', stderr: res.stderr ?? '', timedOut: false };
    }
    return { code: 1, stdout: '', stderr: 'unknown command', timedOut: false };
  };
}

const FULL_SCENARIOS = [
  ['codex --version', { stdout: 'codex-cli version 0.5.0\n' }],
  ['codex login status', { stdout: 'Logged in as dev@example.com (ChatGPT)\n' }],
  ['claude --version', { stdout: '2.0.1 (Claude Code)\n' }],
  ['claude auth status --json', { stdout: '{"status":"signed in","email":"claude-user@example.com"}' }],
  ['opencode --version', { stdout: 'opencode version 1.2.0\n' }],
  ['opencode auth list', { stdout: 'anthropic (oauth)\nopenai (api-key)\n' }],
  ['gemini --version', { stdout: 'gemini version 0.9.0\n' }],
  ['cursor-agent --version', { stdout: 'cursor-agent version 0.3.0\n' }],
  ['cursor-agent status --format json', { stdout: '{"authenticated":true,"email":"cursor@example.com"}' }],
  ['aider --version', { stdout: 'aider version 1.0.0\n' }],
];

function makeHomeWithGemini() {
  const home = mkdtempSync(join(tmpdir(), 'r2-home-'));
  mkdirSync(join(home, '.gemini'));
  writeFileSync(join(home, '.gemini', 'google_accounts.json'), JSON.stringify({ email: 'gemini-user@example.com' }));
  return home;
}

test('parseCliVersion + compareCliVersions + safeParseJson', () => {
  assert.equal(parseCliVersion('codex-cli version 0.5.0'), '0.5.0');
  assert.equal(parseCliVersion('2.0.1 (Claude Code)'), '2.0.1');
  assert.equal(parseCliVersion('version 1.2'), '1.2.0');
  assert.equal(parseCliVersion('no version here'), null);
  assert.equal(compareCliVersions('0.5.0', '0.5.0'), 0);
  assert.equal(compareCliVersions('0.4.9', '0.5.0'), -1);
  assert.equal(compareCliVersions('2.0.1', '1.9.9'), 1);
  assert.deepEqual(safeParseJson('{"a":1}'), { a: 1 });
  assert.equal(safeParseJson('{broken'), null);
});

test('probe codex: installed, version ok, logged in with label', async () => {
  const res = await probeCliAgent('codex', {
    finder: makeFinder(new Set(['codex'])),
    runner: makeRunner(FULL_SCENARIOS),
  });
  assert.equal(res.exists, true);
  assert.equal(res.binaryPath, '/usr/bin/codex');
  assert.equal(res.version, '0.5.0');
  assert.equal(res.versionSupported, true);
  assert.equal(res.formatStatus, 'known');
  assert.equal(res.loggedIn, true);
  assert.equal(res.accountLabel, 'dev@example.com');
  assert.ok(res.models.length > 0);
});

test('probe claude: json auth status parsed, label from email', async () => {
  const res = await probeCliAgent('claude', {
    finder: makeFinder(new Set(['claude'])),
    runner: makeRunner(FULL_SCENARIOS),
  });
  assert.equal(res.version, '2.0.1');
  assert.equal(res.versionSupported, true);
  assert.equal(res.loggedIn, true);
  assert.equal(res.accountLabel, 'claude-user@example.com');
});

test('probe opencode + cursor: auth list / json status', async () => {
  const oc = await probeCliAgent('opencode', {
    finder: makeFinder(new Set(['opencode'])),
    runner: makeRunner(FULL_SCENARIOS),
  });
  assert.equal(oc.loggedIn, true);
  assert.equal(oc.version, '1.2.0');

  const cur = await probeCliAgent('cursor', {
    finder: makeFinder(new Set(['cursor-agent'])),
    runner: makeRunner(FULL_SCENARIOS),
  });
  assert.equal(cur.loggedIn, true);
  assert.equal(cur.accountLabel, 'cursor@example.com');
  assert.equal(cur.version, '0.3.0');
});

test('probe gemini: label from google_accounts.json email only', async () => {
  const home = makeHomeWithGemini();
  const res = await probeCliAgent('gemini', {
    finder: makeFinder(new Set(['gemini'])),
    runner: makeRunner(FULL_SCENARIOS),
    homeDir: home,
  });
  assert.equal(res.loggedIn, true);
  assert.equal(res.accountLabel, 'gemini-user@example.com');
  assert.deepEqual(res.models, ['gemini-2.5-pro', 'gemini-2.5-flash']);
  assert.equal(readGeminiAccountLabel(home), 'gemini-user@example.com');
  assert.equal(geminiOauthCredsExist(home), false);

  // Khong co file accounts -> not-signed-in, khong crash.
  const home2 = mkdtempSync(join(tmpdir(), 'r2-home2-'));
  const res2 = await probeCliAgent('gemini', {
    finder: makeFinder(new Set(['gemini'])),
    runner: makeRunner(FULL_SCENARIOS),
    homeDir: home2,
  });
  assert.equal(res2.loggedIn, false);
  assert.equal(res2.unavailableReason, 'not-signed-in');
  assert.equal(readGeminiAccountLabel(home2), undefined);
});

test('probe aider: env-present only, never reads key values', async () => {
  const withKey = await probeCliAgent('aider', {
    finder: makeFinder(new Set(['aider'])),
    runner: makeRunner(FULL_SCENARIOS),
    env: { OPENAI_API_KEY: 'sk-secret-that-must-not-appear' },
  });
  assert.equal(withKey.loggedIn, true);
  assert.ok(withKey.accountLabel.includes('OPENAI_API_KEY'));
  assert.ok(!withKey.accountLabel.includes('sk-secret'));

  const withoutKey = await probeCliAgent('aider', {
    finder: makeFinder(new Set(['aider'])),
    runner: makeRunner(FULL_SCENARIOS),
    env: {},
  });
  assert.equal(withoutKey.loggedIn, false);
  assert.equal(withoutKey.unavailableReason, 'not-signed-in');
});

test('probe: not installed -> exists false', async () => {
  const res = await probeCliAgent('codex', { finder: makeFinder(new Set()) });
  assert.equal(res.exists, false);
  assert.equal(res.binaryPath, null);
  assert.equal(res.unavailableReason, 'not-installed');
  assert.equal(res.loggedIn, null);
});

test('probe: version too old -> unsupported; version newer than tested -> warning', async () => {
  const oldRunner = makeRunner([
    ['codex --version', { stdout: 'codex-cli version 0.0.1\n' }],
  ]);
  const old = await probeCliAgent('codex', { finder: makeFinder(new Set(['codex'])), runner: oldRunner });
  assert.equal(old.version, '0.0.1');
  assert.equal(old.versionSupported, false);
  assert.equal(old.unavailableReason, 'version-too-old');

  const newRunner = makeRunner([
    ['codex --version', { stdout: 'codex-cli version 9.9.9\n' }],
    ['codex login status', { stdout: 'Logged in\n' }],
  ]);
  const fresh = await probeCliAgent('codex', { finder: makeFinder(new Set(['codex'])), runner: newRunner });
  assert.equal(fresh.versionSupported, true);
  assert.equal(fresh.versionUntested, true);
  assert.ok(fresh.warnings.some((w) => w.includes('kiem chung')));
});

test('probe: unknown output format -> degraded, not crashed', async () => {
  const weirdRunner = makeRunner([
    ['codex --version', { stdout: 'totally different output 1.2.3\n' }],
    ['codex login status', { stdout: 'Logged in\n' }],
  ]);
  const res = await probeCliAgent('codex', { finder: makeFinder(new Set(['codex'])), runner: weirdRunner });
  assert.equal(res.formatStatus, 'unknown');
  assert.ok(res.warnings.some((w) => w.includes('format')));
  assert.equal(res.loggedIn, true); // van thu dung, giam tin cay
});

test('probe: version command fails / times out -> version-probe-failed', async () => {
  const failing = async () => ({ code: 1, stdout: '', stderr: 'boom', timedOut: false });
  const res = await probeCliAgent('claude', { finder: makeFinder(new Set(['claude'])), runner: failing });
  assert.equal(res.unavailableReason, 'version-probe-failed');

  const timingOut = async () => ({ code: null, stdout: '', stderr: '', timedOut: true });
  const res2 = await probeCliAgent('claude', { finder: makeFinder(new Set(['claude'])), runner: timingOut });
  assert.equal(res2.unavailableReason, 'version-probe-failed');
});

test('probe: auth status unreadable -> loggedIn null + warning', async () => {
  const runner = makeRunner([
    ['claude --version', { stdout: '2.0.1 (Claude Code)\n' }],
    ['claude auth status --json', { stdout: 'some unexpected text without status\n' }],
  ]);
  const res = await probeCliAgent('claude', { finder: makeFinder(new Set(['claude'])), runner });
  assert.equal(res.version, '2.0.1');
  assert.equal(res.loggedIn, null);
  assert.ok(res.warnings.length > 0);
});

test('probeAllCliAgents: returns all 6, enabled flags respected', async () => {
  const home = makeHomeWithGemini();
  const results = await probeAllCliAgents({
    finder: makeFinder(new Set(['codex', 'claude', 'opencode', 'gemini', 'aider', 'cursor-agent'])),
    runner: makeRunner(FULL_SCENARIOS),
    env: { OPENAI_API_KEY: 'x' },
    homeDir: home,
    enabledKinds: new Set(['claude', 'codex']),
  });
  assert.equal(results.length, 6);
  assert.deepEqual(results.map((r) => r.kind), ['codex', 'claude', 'opencode', 'gemini', 'aider', 'cursor']);
  assert.equal(results.find((r) => r.kind === 'claude').enabled, true);
  assert.equal(results.find((r) => r.kind === 'codex').enabled, true);
  assert.equal(results.find((r) => r.kind === 'gemini').enabled, false);
  assert.ok(results.every((r) => r.exists));
  // Adapter table co du 6 kind, minVersion hop le.
  for (const kind of Object.keys(CLI_ADAPTERS)) {
    assert.ok(CLI_ADAPTERS[kind].minVersion.length > 0);
    assert.ok(CLI_ADAPTERS[kind].binaries.length > 0);
  }
});
