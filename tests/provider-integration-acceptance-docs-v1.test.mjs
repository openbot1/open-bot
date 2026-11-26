import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const guide = fs.readFileSync(
  path.join(here, '..', 'docs', 'ops', 'PROVIDER-INTEGRATION-ACCEPTANCE.md'),
  'utf8',
);

test('defines provider and integration acceptance scope', () => {
  assert.ok(guide.includes('Gemini, OpenAI, Anthropic, xAI/Grok and Ollama'));
  assert.ok(guide.includes('Composio'));
  assert.ok(guide.includes('CLI auto-detection'));
  assert.ok(guide.includes('not evidence that every provider'));
});

test('anchors the runbook to checked-in implementation references', () => {
  assert.ok(guide.includes('packages/core/src/providers/index.ts'));
  assert.ok(guide.includes('packages/core/src/providers/gemini.ts'));
  assert.ok(guide.includes('packages/core/src/providers/openai.ts'));
  assert.ok(guide.includes('packages/core/src/providers/anthropic.ts'));
  assert.ok(guide.includes('packages/core/src/providers/xai.ts'));
  assert.ok(guide.includes('packages/core/src/providers/ollama.ts'));
  assert.ok(guide.includes('packages/core/src/providers/openaiCompatible.ts'));
});

test('requires exact candidate identity and sanitized evidence', () => {
  assert.ok(guide.includes('exact commit SHA'));
  assert.ok(guide.includes('PASS, FAIL, BLOCKED or NOT RUN'));
  assert.ok(guide.includes('Never include API keys'));
  assert.ok(guide.includes('sanitized error category'));
});

test('defines independent provider acceptance matrix', () => {
  for (const id of ['gemini', 'openai', 'anthropic', 'xai', 'ollama']) {
    assert.ok(guide.includes('`' + id + '`'), 'missing provider identity: ' + id);
  }
  assert.ok(guide.includes('A successful request through one provider does not validate another provider'));
});

test('requires harmless text and tool round-trip checks', () => {
  assert.ok(guide.includes('minimal harmless text request'));
  assert.ok(guide.includes('harmless read-only test tool'));
  assert.ok(guide.includes('tool result is returned to the model'));
  assert.ok(guide.includes('final response completes'));
});

test('distinguishes live model discovery from fallback catalogues', () => {
  assert.ok(guide.includes('live endpoint or a documented fallback'));
  assert.ok(guide.includes('fallback catalogue is not proof'));
});

test('documents Gemini live-test gate and evidence boundary', () => {
  assert.ok(guide.includes('OPENBOT_LIVE_GEMINI=1'));
  assert.ok(guide.includes('docs/live-test-gemini.md'));
  assert.ok(guide.includes('gemini-2.5-flash'));
});

test('keeps OpenAI and xAI live acceptance independent', () => {
  assert.ok(guide.includes('OpenAI and xAI use the shared OpenAI-compatible transport'));
  assert.ok(guide.includes('separate provider configuration'));
  assert.ok(guide.includes('separate live acceptance'));
});

test('documents Anthropic Messages and tool mapping boundary', () => {
  assert.ok(guide.includes('Messages API'));
  assert.ok(guide.includes('tool_use/tool_result'));
  assert.ok(guide.includes('Do not infer Anthropic acceptance'));
});

test('documents Ollama local endpoint and no-key behavior', () => {
  assert.ok(guide.includes('http://localhost:11434/v1'));
  assert.ok(guide.includes('llama3.1'));
  assert.ok(guide.includes('does not require an API key'));
  assert.ok(guide.includes('exact installed model'));
});

test('requires Composio opt-in and Vault key handling', () => {
  assert.ok(guide.includes('disabled by default'));
  assert.ok(guide.includes('namespace `provider`, key `composio`'));
  assert.ok(guide.includes('never put it in source, `.env`, logs or evidence'));
  assert.ok(guide.includes('not the key value'));
});

test('requires Composio session and read-only discovery validation', () => {
  assert.ok(guide.includes('server-returned MCP URL and headers'));
  assert.ok(guide.includes('COMPOSIO_SEARCH_TOOLS'));
  assert.ok(guide.includes('COMPOSIO_GET_TOOL_SCHEMAS'));
  assert.ok(guide.includes('tool_slug'));
  assert.ok(guide.includes('toolkits'));
});

test('blocks unapproved Composio write operations', () => {
  assert.ok(guide.includes('does not authorize write testing'));
  assert.ok(guide.includes('explicit owner approval'));
  assert.ok(guide.includes('BLOCKED / NOT RUN'));
  assert.ok(guide.includes('live discovery do not count as live write acceptance'));
});

test('anchors CLI detection to the V30 implementation', () => {
  assert.ok(guide.includes('packages/core/src/routerV30/cliAgentDetectV30.ts'));
  for (const cli of ['Codex CLI', 'Claude Code', 'OpenCode', 'Gemini CLI', 'Aider', 'Cursor CLI']) {
    assert.ok(guide.includes(cli), 'missing supported CLI: ' + cli);
  }
});

test('requires CLI consent and no-execution behavior before consent', () => {
  assert.ok(guide.includes('initially false'));
  assert.ok(guide.includes('Without consent, detection must not invoke model execution'));
  assert.ok(guide.includes('Grant consent explicitly'));
  assert.ok(guide.includes('Revoke consent'));
});

test('protects CLI credentials and separates detection from invocation', () => {
  assert.ok(guide.includes('does not read, copy or transmit CLI auth/config/session files'));
  assert.ok(guide.includes('FORBIDDEN_CLI_PATHS_V30'));
  assert.ok(guide.includes('Record detection and invocation as separate outcomes'));
});

test('distinguishes the earlier CLI probe adapter', () => {
  assert.ok(guide.includes('packages/core/src/routerV2/cliProbeV2.ts'));
  assert.ok(guide.includes('distinct adapter set'));
});

test('uses documented root build and test commands', () => {
  for (const command of ['npm ci', 'npm run version:sync', 'npm run version:check',
    'npm run build', 'npm run typecheck']) {
    assert.ok(guide.includes(command), 'missing root command: ' + command);
  }
  assert.ok(guide.includes('`npm test`'), 'missing root command: npm test');
  assert.ok(guide.includes('xvfb-run -a npm test'));
  assert.ok(guide.includes('docs/TESTING.md'));
});

test('requires exact-SHA release gates and explicit skip accounting', () => {
  assert.ok(guide.includes('exact candidate SHA'));
  assert.ok(guide.includes('full-suite result'));
  assert.ok(guide.includes('explain every skip'));
  assert.ok(guide.includes('Do not land with any unexplained failure'));
});

test('defines evidence fields and overall HOLD conditions', () => {
  assert.ok(guide.includes('Candidate commit SHA, app version, OS/build'));
  assert.ok(guide.includes('PASS / FAIL / BLOCKED / NOT RUN'));
  assert.ok(guide.includes('overall status is HOLD'));
  assert.ok(guide.includes('does not claim that any new live acceptance exercise has been performed'));
});
