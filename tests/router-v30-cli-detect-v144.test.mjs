/**
 * Router v30 — auto-detect CLI agent v2 (v1.44, Doi T5, node:test).
 *
 * Covers (thuan, mock runner — KHONG spawn that, KHONG doc file):
 * - Dinh nghia 6 CLI: codex, claude-code, opencode, gemini-cli, aider,
 *   cursor-cli (binary + versionArgs + model mac dinh).
 * - Detect qua mock runner: tim thay 3, khong thay 3, runner throw
 *   thi ghi reason, khong throw ca ham.
 * - Forbidden paths: isForbiddenCliPathV30 chan auth/config cua CLI
 *   khac (.codex/auth.json, .claude.json, .config/gemini, ...).
 * - Consent: mac dinh chua dong y -> resolve ra rong; dong y ->
 *   tra nguon da phat hien + dang bat; thu hoi -> rong lai.
 * - Bat/tat tung nguon: tat codex thi resolve khong co codex.
 * - Account label: mac dinh 'via CLI login'; user dat label thi hien
 *   label do; xoa label ve lai mac dinh. Label khong doc tu dia.
 * - Model override: user chon model khac thi resolve tra model do.
 * - Summarize: dong tom tat moi CLI (installed / not installed /
 *   waiting for consent / disabled).
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/router-v30-cli-detect-v144.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLI_AGENT_DEFINITIONS_V30,
  cliAgentDefinitionV30,
  defaultCliAgentConsentV30,
  detectCliAgentsV30,
  isForbiddenCliPathV30,
  resolveCliModelSourcesV30,
  setCliAccountLabelV30,
  setCliConsentV30,
  setCliModelOverrideV30,
  setCliSourceEnabledV30,
  summarizeCliSourcesV30,
} from '../packages/core/dist/routerV30/index.js';

/** Mock runner: co codex + claude-code + gemini-cli, khong co 3 cai con lai. */
const mockRunner = async (definition) => {
  const found = {
    codex: { binary: 'codex', version: 'codex-cli 0.42.0' },
    'claude-code': { binary: 'claude', version: '1.0.0 (Claude Code)' },
    'gemini-cli': { binary: 'gemini', version: 'gemini 0.9.1' },
  };
  return found[definition.kind] ?? null;
};

test('dinh nghia 6 CLI: binary + versionArgs + model mac dinh', () => {
  assert.equal(CLI_AGENT_DEFINITIONS_V30.length, 6);
  const kinds = CLI_AGENT_DEFINITIONS_V30.map((d) => d.kind);
  assert.deepEqual(kinds, [
    'codex',
    'claude-code',
    'opencode',
    'gemini-cli',
    'aider',
    'cursor-cli',
  ]);
  assert.equal(cliAgentDefinitionV30('codex').binary, 'codex');
  assert.equal(cliAgentDefinitionV30('claude-code').binary, 'claude');
  assert.equal(cliAgentDefinitionV30('opencode').binary, 'opencode');
  assert.equal(cliAgentDefinitionV30('gemini-cli').binary, 'gemini');
  assert.equal(cliAgentDefinitionV30('aider').binary, 'aider');
  assert.equal(cliAgentDefinitionV30('cursor-cli').binary, 'cursor-agent');
  for (const def of CLI_AGENT_DEFINITIONS_V30) {
    assert.deepEqual(def.versionArgs, ['--version']);
    assert.ok(def.defaultModelId.length > 0);
    assert.ok(def.displayName.length > 0);
    assert.ok(def.description.length > 0);
  }
  assert.throws(() => cliAgentDefinitionV30('unknown-cli'), /unknown CLI agent kind/);
});

test('detect qua mock runner: 3 thay, 3 khong thay', async () => {
  const detections = await detectCliAgentsV30(mockRunner, 5000);
  assert.equal(detections.length, 6);
  assert.equal(detections.filter((d) => d.detected).length, 3);
  const codex = detections.find((d) => d.kind === 'codex');
  assert.equal(codex.binary, 'codex');
  assert.equal(codex.version, 'codex-cli 0.42.0');
  assert.equal(codex.detectedAt, 5000);
  assert.equal(codex.reason, undefined);
  const opencode = detections.find((d) => d.kind === 'opencode');
  assert.equal(opencode.detected, false);
  assert.equal(opencode.binary, null);
  assert.equal(opencode.version, null);
  assert.match(opencode.reason, /not found/);
});

test('detect: runner throw thi ghi reason, khong throw ca ham', async () => {
  const throwing = async (definition) => {
    if (definition.kind === 'codex') throw new Error('spawn boom');
    return null;
  };
  const detections = await detectCliAgentsV30(throwing, 6000);
  const codex = detections.find((d) => d.kind === 'codex');
  assert.equal(codex.detected, false);
  assert.equal(codex.reason, 'spawn boom');
  assert.equal(detections.length, 6);
});

test('forbidden paths: chan auth/config cua CLI khac', () => {
  const forbidden = [
    '/home/u/.codex/auth.json',
    '/home/u/.codex/config.toml',
    '/home/u/.claude.json',
    '/home/u/.claude/settings.json',
    '/home/u/.config/claude-code/settings.json',
    '/home/u/.config/opencode/opencode.json',
    '/home/u/.config/gemini/settings.json',
    '/home/u/.gemini/oauth_creds.json',
    '/home/u/.cursor/auth.json',
    '/home/u/.aider.conf.yml',
    'C:\\Users\\u\\.codex\\auth.json',
  ];
  for (const p of forbidden) {
    assert.equal(isForbiddenCliPathV30(p), true, p);
  }
  const allowed = [
    '/home/u/.codex/README.md',
    '/usr/bin/codex',
    '/home/u/projects/app/index.ts',
    '/home/u/.open-bot/config.json',
  ];
  for (const p of allowed) {
    assert.equal(isForbiddenCliPathV30(p), false, p);
  }
});

test('consent: chua dong y -> rong; dong y -> co nguon; thu hoi -> rong', async () => {
  const detections = await detectCliAgentsV30(mockRunner, 5000);
  const consent0 = defaultCliAgentConsentV30();
  assert.equal(consent0.consented, false);
  assert.equal(consent0.consentedAt, null);
  assert.deepEqual(resolveCliModelSourcesV30(detections, consent0), []);

  const granted = setCliConsentV30(consent0, true, 7000);
  assert.equal(granted.consented, true);
  assert.equal(granted.consentedAt, 7000);
  const sources = resolveCliModelSourcesV30(detections, granted);
  assert.equal(sources.length, 3);
  assert.deepEqual(sources.map((s) => s.kind), ['codex', 'claude-code', 'gemini-cli']);
  assert.ok(sources.every((s) => s.via === 'cli-session'));
  assert.equal(sources[0].modelId, 'gpt-5.2');
  assert.equal(sources[0].accountLabel, 'via CLI login');
  assert.equal(sources[0].binary, 'codex');

  const revoked = setCliConsentV30(granted, false, 8000);
  assert.equal(revoked.consented, false);
  assert.equal(revoked.consentedAt, null);
  assert.deepEqual(resolveCliModelSourcesV30(detections, revoked), []);
  // Consent goc khong bi doi (immutable).
  assert.equal(consent0.consented, false);
});

test('bat/tat tung nguon + label + model override', async () => {
  const detections = await detectCliAgentsV30(mockRunner, 5000);
  let consent = setCliConsentV30(defaultCliAgentConsentV30(), true, 7000);
  consent = setCliSourceEnabledV30(consent, 'codex', false);
  let sources = resolveCliModelSourcesV30(detections, consent);
  assert.equal(sources.length, 2);
  assert.ok(!sources.some((s) => s.kind === 'codex'));
  consent = setCliSourceEnabledV30(consent, 'codex', true);
  sources = resolveCliModelSourcesV30(detections, consent);
  assert.equal(sources.length, 3);

  consent = setCliAccountLabelV30(consent, 'codex', 'huy@work');
  sources = resolveCliModelSourcesV30(detections, consent);
  assert.equal(sources.find((s) => s.kind === 'codex').accountLabel, 'huy@work');
  // Label khong phai tu dia: chi la chuoi user nhap.
  assert.equal(sources.find((s) => s.kind === 'claude-code').accountLabel, 'via CLI login');
  consent = setCliAccountLabelV30(consent, 'codex', '   ');
  sources = resolveCliModelSourcesV30(detections, consent);
  assert.equal(sources.find((s) => s.kind === 'codex').accountLabel, 'via CLI login');

  consent = setCliModelOverrideV30(consent, 'gemini-cli', 'gemini-3-flash');
  sources = resolveCliModelSourcesV30(detections, consent);
  assert.equal(sources.find((s) => s.kind === 'gemini-cli').modelId, 'gemini-3-flash');
  consent = setCliModelOverrideV30(consent, 'gemini-cli', '');
  sources = resolveCliModelSourcesV30(detections, consent);
  assert.equal(sources.find((s) => s.kind === 'gemini-cli').modelId, 'gemini-3-pro');
});

test('summarize: dong tom tat tung trang thai', async () => {
  const detections = await detectCliAgentsV30(mockRunner, 5000);
  const noConsent = summarizeCliSourcesV30(detections, defaultCliAgentConsentV30());
  assert.equal(noConsent.detected, 3);
  assert.equal(noConsent.total, 6);
  assert.equal(noConsent.consented, false);
  assert.equal(noConsent.enabledSources.length, 0);
  assert.equal(noConsent.lines.length, 6);
  assert.ok(noConsent.lines.some((l) => l.includes('Codex CLI') && l.includes('waiting for consent')));
  assert.ok(noConsent.lines.some((l) => l.includes('OpenCode') && l.includes('not installed')));

  let consent = setCliConsentV30(defaultCliAgentConsentV30(), true, 7000);
  consent = setCliSourceEnabledV30(consent, 'claude-code', false);
  consent = setCliAccountLabelV30(consent, 'codex', 'huy@work');
  const s = summarizeCliSourcesV30(detections, consent);
  assert.equal(s.enabledSources.length, 2);
  assert.ok(s.lines.some((l) => l === 'Codex CLI: gpt-5.2 via huy@work'));
  assert.ok(s.lines.some((l) => l.includes('Claude Code') && l.includes('disabled')));
});
