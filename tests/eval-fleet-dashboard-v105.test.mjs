/**
 * Static wiring test for the v1.05 Team T6 desktop UI (eval + fleet
 * dashboard).
 *
 * No Electron needed: it reads the renderer/main/preload sources and
 * asserts the wiring is complete — the new component exists, every
 * i18n key it uses exists in all 6 locales, every new IPC channel
 * is declared in preload, implemented in the exposed API, and
 * handled in main.ts, and the new view is reachable from the
 * sidebar + App.
 *
 * Run:
 *   node --test tests/eval-fleet-dashboard-v105.test.mjs
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
  return fs.readFileSync(path.isAbsolute(rel) ? rel : path.join(ROOT, rel), 'utf8');
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

const NEW_COMPONENTS = ['components/EvalFleetDashboardView.tsx'];

const NEW_CHANNELS = [
  'memoryEval:datasets',
  'memoryEval:history',
  'memoryEval:run',
  'memoryEval:compare',
  'fleetV4:policy-get',
  'fleetV4:policy-set',
  'fleetV4:tasks-list',
];

const NEW_CAMEL_METHODS = [
  'memoryEvalDatasets',
  'memoryEvalHistory',
  'memoryEvalRun',
  'memoryEvalCompare',
  'fleetV4PolicyGet',
  'fleetV4PolicySet',
  'fleetV4TasksList',
];

test('new dashboard component exists and uses only known i18n keys', () => {
  for (const component of NEW_COMPONENTS) {
    const source = read(path.join(RENDERER, component));
    assert.ok(source.length > 1000, `${component} looks empty`);
    for (const key of usedKeys(source)) {
      for (const locale of LOCALES) {
        assert.ok(
          key in localeKeys(locale),
          `i18n key "${key}" used by ${component} is missing in ${locale}.json`,
        );
      }
    }
  }
  // The sidebar label key exists in all locales too.
  for (const locale of LOCALES) {
    assert.ok('sidebar.evalFleet' in localeKeys(locale), `sidebar.evalFleet missing in ${locale}.json`);
  }
});

test('new IPC channels are declared in preload, exposed, and handled in main', () => {
  const preload = read(path.join(MAIN, 'preload.ts'));
  const main = read(path.join(MAIN, 'main.ts'));
  for (const channel of NEW_CHANNELS) {
    assert.ok(preload.includes(`'${channel}'`), `preload is missing the '${channel}' declaration`);
    assert.ok(
      preload.includes(`ipcRenderer.invoke('${channel}'`),
      `preload does not expose an implementation for '${channel}'`,
    );
    assert.ok(main.includes(`ipcMain.handle('${channel}'`), `main.ts does not handle '${channel}'`);
  }
  for (const method of NEW_CAMEL_METHODS) {
    assert.ok(preload.includes(`${method}:`), `preload is missing the camelCase method ${method}`);
  }
});

test('dashboard view is reachable from the sidebar and App', () => {
  const sidebar = read(path.join(RENDERER, 'components/Sidebar.tsx'));
  assert.ok(sidebar.includes("key: 'eval-fleet'"), 'Sidebar has no eval-fleet entry');
  assert.ok(sidebar.includes('onOpenEvalFleet'), 'Sidebar has no onOpenEvalFleet prop');
  assert.ok(sidebar.includes("t('sidebar.evalFleet')"), 'Sidebar does not use sidebar.evalFleet');
  const app = read(path.join(RENDERER, 'App.tsx'));
  assert.ok(app.includes('EvalFleetDashboardView'), 'App does not import EvalFleetDashboardView');
  assert.ok(app.includes("'eval-fleet'"), 'App has no eval-fleet view');
  assert.ok(app.includes('onOpenEvalFleet={() => setView('), 'App does not wire onOpenEvalFleet');
});

test('dashboard calls the new IPC channels (and the existing fleet:list)', () => {
  const source = read(path.join(RENDERER, 'components/EvalFleetDashboardView.tsx'));
  for (const channel of [...NEW_CHANNELS.slice(0, 2), 'fleet:list', 'fleetV4:policy-get']) {
    assert.ok(source.includes(`'${channel}'`), `dashboard never calls ${channel}`);
  }
  // No fake data: the component shows an empty state when there is
  // no eval history yet, and never hard-codes a score.
  assert.ok(source.includes('noRuns'), 'dashboard has no empty state for zero runs');
  assert.ok(!/f1: 0\.[89]/.test(source), 'dashboard must not hard-code a fake F1 score');
});
