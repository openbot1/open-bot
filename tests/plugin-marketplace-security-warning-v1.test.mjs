/**
 * H1 production-hardening regression: the plugin marketplace must disclose
 * that a separate process is not an OS security boundary before install/enable.
 * Run: node --test tests/plugin-marketplace-security-warning-v1.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const renderer = join(repo, 'apps/desktop/src/renderer');

test('plugin marketplace renders the OS-boundary warning before plugin actions', () => {
  const view = readFileSync(join(renderer, 'components/PluginMarketplaceView.tsx'), 'utf8');
  const warningAt = view.indexOf('data-testid="plugin-security-warning"');
  const cardsAt = view.indexOf('filtered.map((entry)');
  assert.ok(warningAt >= 0, 'a stable security-warning test id must exist');
  assert.ok(cardsAt > warningAt, 'warning must render before install/enable cards');
  const warningBlock = view.slice(warningAt - 180, warningAt + 600);
  assert.ok(warningBlock.includes('role="alert"'), 'warning must be announced accessibly');
  assert.ok(view.includes("t('pluginMarketplace.securityWarningTitle')"));
  assert.ok(view.includes("t('pluginMarketplace.securityWarningBody')"));
});

test('the OS-boundary warning is translated in every shipped locale', () => {
  for (const locale of ['en', 'vi', 'es', 'fr', 'ja', 'zh']) {
    const dict = JSON.parse(readFileSync(join(renderer, 'i18n/locales', locale + '.json'), 'utf8'));
    assert.ok(dict['pluginMarketplace.securityWarningTitle']?.trim(), locale + ' title is missing');
    assert.ok(dict['pluginMarketplace.securityWarningBody']?.trim(), locale + ' body is missing');
  }
});
