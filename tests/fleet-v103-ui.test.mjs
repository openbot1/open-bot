/**
 * Static wiring test for the v1.03 Team T6 desktop UI
 * (fleet overview/schedule tabs, event-stream + eval harness views,
 * marketplace v3 UI, plugin v3 UI).
 *
 * No Electron needed: it reads the renderer/main/preload sources and
 * asserts the wiring is complete — new components exist, every i18n
 * key they use exists in all 6 locales, every new IPC channel is
 * declared in preload, implemented in the exposed API, and handled in
 * main.ts, and the new views are reachable from the sidebar + App.
 *
 * Run:
 *   node --test tests/fleet-v103-ui.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const RENDERER = path.join(ROOT, 'apps/desktop/src/renderer');
const MAIN = path.join(ROOT, 'apps/desktop/src/main');

const LOCALES = ['en', 'vi', 'zh', 'ja', 'es', 'fr'];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function localeKeys(locale) {
  return JSON.parse(read(`apps/desktop/src/renderer/i18n/locales/${locale}.json`));
}

/** i18n keys used as t('a.b.c') literals in a source file. */
function usedKeys(source) {
  const keys = new Set();
  for (const match of source.matchAll(/\bt\(\s*['"`]([a-zA-Z0-9_.]+)['"`]/g)) {
    keys.add(match[1]);
  }
  return keys;
}

const NEW_COMPONENTS = [
  'components/FleetOverviewTab.tsx',
  'components/FleetScheduleTab.tsx',
  'components/EventStreamView.tsx',
  'components/EvalHarnessView.tsx',
];

const CHANGED_COMPONENTS = [
  'components/FleetConsoleView.tsx',
  'components/BotMarketplaceView.tsx',
  'components/PluginMarketplaceView.tsx',
  'components/Sidebar.tsx',
];

const NEW_CHANNELS = [
  'fleet:overview',
  'fleet:schedule-plan',
  'fleet:schedule-queue',
  'fleet:schedule-enqueue',
  'fleet:schedule-claim',
  'fleet:schedule-cancel',
  'marketplace-v3:collections',
  'marketplace-v3:create-collection',
  'marketplace-v3:remove-collection',
  'marketplace-v3:versions',
  'marketplace-v3:record-version',
  'marketplace-v3:install-to-workspace',
  'marketplace-v3:installs',
  'plugin-marketplace-v3:updates',
  'plugin-marketplace-v3:dependencies',
  'plugin-marketplace-v3:queue',
  'plugin-marketplace-v3:rollbacks',
  'plugin-marketplace-v3:record-rollback',
  'evals:list',
  'evals:create-suite',
  'evals:remove-suite',
  'evals:add-case',
  'evals:remove-case',
  'evals:score-case',
  'evals:run-suite',
  'runlog:event-stream',
];

test('fleet v103 ui: new components exist and export a React component', () => {
  for (const file of NEW_COMPONENTS) {
    const source = read(`apps/desktop/src/renderer/${file}`);
    assert.match(source, /export (default )?function \w+/, `${file} must export a component`);
    assert.match(source, /useTranslation|useI18n|t\(/, `${file} must use i18n (no hard-coded UI strings)`);
  }
});

test('fleet v103 ui: every i18n key used by the new/changed views exists in all 6 locales', () => {
  const locales = Object.fromEntries(LOCALES.map((l) => [l, localeKeys(l)]));
  const allKeys = new Set();
  for (const file of [...NEW_COMPONENTS, ...CHANGED_COMPONENTS, 'App.tsx']) {
    const source = read(`apps/desktop/src/renderer/${file}`);
    for (const key of usedKeys(source)) allKeys.add(key);
  }
  assert.ok(allKeys.size > 100, `expected >100 keys used across the v103 views, got ${allKeys.size}`);
  const missing = [];
  for (const key of allKeys) {
    for (const locale of LOCALES) {
      if (!(key in locales[locale])) missing.push(`${key} missing in ${locale}`);
    }
  }
  assert.deepEqual(missing, [], `i18n gaps: ${missing.slice(0, 10).join('; ')}`);
  // The v103 key families are present (spot check, not exhaustive).
  for (const key of [
    'fleetOverview.title', 'fleetOverview.forecast', 'fleetSchedule.title',
    'eventStream.title', 'evalHarness.title', 'sidebar.eventStream', 'sidebar.evalHarness',
    'botMarketplace.collections', 'pluginMarketplace.installQueue',
  ]) {
    for (const locale of LOCALES) {
      assert.ok(key in locales[locale], `${key} missing in ${locale}`);
    }
  }
});

test('fleet v103 ui: new IPC channels are declared in preload, exposed, and handled in main', () => {
  const preload = read('apps/desktop/src/main/preload.ts');
  const main = read('apps/desktop/src/main/main.ts');
  for (const channel of NEW_CHANNELS) {
    assert.ok(preload.includes(`'${channel}'`), `preload interface must declare ${channel}`);
    assert.ok(preload.includes(`ipcRenderer.invoke('${channel}'`), `preload must expose ${channel}`);
    assert.ok(main.includes(`ipcMain.handle('${channel}'`), `main.ts must handle ${channel}`);
  }
});

test('fleet v103 ui: new views are reachable from the sidebar and App', () => {
  const sidebar = read('apps/desktop/src/renderer/components/Sidebar.tsx');
  assert.match(sidebar, /onOpenEventStream/, 'Sidebar must accept onOpenEventStream');
  assert.match(sidebar, /onOpenEvalHarness/, 'Sidebar must accept onOpenEvalHarness');
  assert.match(sidebar, /sidebar\.eventStream/, 'Sidebar must label the event-stream item');
  assert.match(sidebar, /sidebar\.evalHarness/, 'Sidebar must label the eval-harness item');

  const app = read('apps/desktop/src/renderer/App.tsx');
  assert.match(app, /'event-stream' \| 'eval-harness'/, 'App view union must include the two new views');
  assert.match(app, /import.*EventStreamView/, 'App must import EventStreamView');
  assert.match(app, /import.*EvalHarnessView/, 'App must import EvalHarnessView');
  assert.match(app, /<EventStreamView/, 'App must render EventStreamView');
  assert.match(app, /<EvalHarnessView/, 'App must render EvalHarnessView');
  assert.match(app, /onOpenEventStream=/, 'App must wire onOpenEventStream');
  assert.match(app, /onOpenEvalHarness=/, 'App must wire onOpenEvalHarness');
});

test('fleet v103 ui: fleet console has overview + schedule tabs wired', () => {
  const consoleView = read('apps/desktop/src/renderer/components/FleetConsoleView.tsx');
  assert.match(consoleView, /fleetConsole\.tabOverview/, 'Fleet console must have an overview tab label');
  assert.match(consoleView, /fleetConsole\.tabSchedule/, 'Fleet console must have a schedule tab label');
  assert.match(consoleView, /<FleetOverviewTab/, 'Fleet console must render FleetOverviewTab');
  assert.match(consoleView, /<FleetScheduleTab/, 'Fleet console must render FleetScheduleTab');
});
