/**
 * UI tests for v1.06 (Team T5) — MCP Tasks monitor panel.
 *
 * Part A (runtime): the pure monitor logic (mcpTasksMonitor.ts) is
 * compiled with the repo's own TypeScript into a temp dir and
 * executed — progress vs timeout, overdue flag, active/history split,
 * status + diacritic-insensitive search filtering.
 * Part B (static, repo pattern): i18n parity for the 32 mcpMonitor.*
 * keys in all 6 locales; McpTasksMonitorPanel only uses keys that
 * exist; the IPC it needs is registered in main, exposed by preload
 * and mirrored in global.d.ts; the panel is wired into App (view
 * union + render branch) and Sidebar (nav entry at the end).
 *
 * Run: node --test tests/ui-v106-mcp-tasks-monitor.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = ['vi', 'en', 'zh', 'ja', 'es', 'fr'];
const MONITOR_KEYS = 32;

function readLocale(locale) {
  return JSON.parse(
    fs.readFileSync(path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales', `${locale}.json`), 'utf8'),
  );
}

function read(rel) {
  return fs.readFileSync(path.join(REPO, ...rel), 'utf8');
}

function usedKeys(source) {
  return [...source.matchAll(/t\('([a-z][a-zA-Z0-9_]*\.[a-zA-Z0-9_.]+)'/g)].map((m) => m[1]);
}

/** Compile the pure monitor module (+ its botList dep) to CJS in a temp dir and require it. */
function loadMonitorModule() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-v106-monitor-'));
  const tsc = path.join(REPO, 'node_modules', 'typescript', 'bin', 'tsc');
  execFileSync(
    process.execPath,
    [
      tsc,
      '--module', 'commonjs',
      '--target', 'es2022',
      '--esModuleInterop',
      '--skipLibCheck',
      '--outDir', tmp,
      path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'components', 'mcpTasksMonitor.ts'),
      path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'components', 'botList.ts'),
    ],
    { stdio: 'pipe' },
  );
  // tsc preserves the source tree under outDir (…/components/*.js).
  return createRequire(import.meta.url)(findCompiled(tmp, 'mcpTasksMonitor.js'));
}

/** Walk a temp dir for a compiled file by basename. */
function findCompiled(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findCompiled(full, name);
      if (found) return found;
    } else if (entry.name === name) {
      return full;
    }
  }
  throw new Error(`compiled ${name} not found under ${dir}`);
}

const monitor = loadMonitorModule();
const NOW = Date.parse('2026-11-14T12:00:00.000Z');

function task(overrides) {
  return {
    key: 'k1', taskId: 't1', serverName: 'srv', method: 'tools/call', label: 'Do work',
    status: 'working', specVersion: '2025-11-25', createdAt: NOW - 30_000, updatedAt: NOW - 1000,
    timeoutMs: 120_000, timedOut: false, pollIntervalMs: 5000, workspaceDir: '/tmp/ws',
    ...overrides,
  };
}

test('monitor: progress is elapsed/timeout, capped at 100, null without a timeout', () => {
  assert.equal(monitor.mcpTaskProgress(task({}), NOW), 25);
  assert.equal(monitor.mcpTaskProgress(task({ createdAt: NOW - 200_000 }), NOW), 100);
  assert.equal(monitor.mcpTaskProgress(task({ timeoutMs: undefined }), NOW), null);
  assert.equal(monitor.mcpTaskProgress(task({ timeoutMs: 0 }), NOW), null);
});

test('monitor: overdue only for active tasks past their timeout', () => {
  assert.equal(monitor.isMcpTaskOverdue(task({}), NOW), false);
  assert.equal(monitor.isMcpTaskOverdue(task({ createdAt: NOW - 200_000 }), NOW), true);
  assert.equal(monitor.isMcpTaskOverdue(task({ createdAt: NOW - 200_000, status: 'completed' }), NOW), false);
  assert.equal(monitor.isMcpTaskOverdue(task({ timeoutMs: undefined, createdAt: NOW - 200_000 }), NOW), false);
});

test('monitor: elapsed formatting', () => {
  assert.equal(monitor.formatMcpElapsed(task({ createdAt: NOW - 5_000 }), NOW), '5s');
  assert.equal(monitor.formatMcpElapsed(task({ createdAt: NOW - 125_000 }), NOW), '2m 5s');
  assert.equal(monitor.formatMcpElapsed(task({ createdAt: NOW - 3_661_000 }), NOW), '1h 1m');
});

test('monitor: split active/history, newest first', () => {
  const tasks = [
    task({ key: 'a', status: 'working', updatedAt: NOW - 3000 }),
    task({ key: 'b', status: 'completed', updatedAt: NOW - 1000 }),
    task({ key: 'c', status: 'input_required', updatedAt: NOW - 2000 }),
    task({ key: 'd', status: 'failed', updatedAt: NOW - 500 }),
  ];
  const { active, history } = monitor.splitMcpTasks(tasks);
  assert.deepEqual(active.map((t) => t.key), ['c', 'a']);
  assert.deepEqual(history.map((t) => t.key), ['d', 'b']);
});

test('monitor: filter by status + diacritic-insensitive search', () => {
  const tasks = [
    task({ key: 'a', label: 'Quản lý file', serverName: 'fs', status: 'working' }),
    task({ key: 'b', label: 'other', serverName: 'srv', status: 'failed', error: 'boom' }),
  ];
  assert.equal(monitor.filterMcpTasks(tasks, { status: 'all', query: '' }).length, 2);
  assert.equal(monitor.filterMcpTasks(tasks, { status: 'failed', query: '' }).length, 1);
  assert.equal(monitor.filterMcpTasks(tasks, { status: 'all', query: 'quan ly' }).length, 1);
  assert.equal(monitor.filterMcpTasks(tasks, { status: 'all', query: 'boom' }).length, 1);
  assert.equal(monitor.filterMcpTasks(tasks, { status: 'working', query: 'boom' }).length, 0);
});

test(`i18n parity: ${MONITOR_KEYS} mcpMonitor.* keys in all 6 locales`, () => {
  const locales = Object.fromEntries(LOCALES.map((l) => [l, readLocale(l)]));
  const keys = Object.keys(locales.en).filter((k) => k.startsWith('mcpMonitor.'));
  assert.equal(keys.length, MONITOR_KEYS, `expected ${MONITOR_KEYS} mcpMonitor keys, got ${keys.length}`);
  for (const key of keys) {
    for (const locale of LOCALES) {
      assert.ok(key in locales[locale], `${locale} thiếu key ${key}`);
      assert.equal(typeof locales[locale][key], 'string', `${locale}.${key} phải là string`);
      assert.ok(locales[locale][key].trim() !== '', `${locale}.${key} rỗng`);
    }
  }
  for (const locale of LOCALES.slice(1)) {
    const ks = Object.keys(locales[locale]).filter((k) => k.startsWith('mcpMonitor.'));
    assert.deepEqual(ks.sort(), [...keys].sort(), `key set mcpMonitor lệch ở ${locale}`);
  }
});

test('McpTasksMonitorPanel chỉ dùng key i18n đã tồn tại', () => {
  const en = readLocale('en');
  const panel = read(['apps', 'desktop', 'src', 'renderer', 'components', 'McpTasksMonitorPanel.tsx']);
  for (const key of usedKeys(panel)) {
    assert.ok(key in en, `McpTasksMonitorPanel dùng key chưa có: ${key}`);
  }
  assert.ok(panel.includes("t('mcpMonitor.title')"));
  assert.ok(panel.includes("t('mcpMonitor.tabActive'"));
  assert.ok(panel.includes("t('mcpMonitor.tabHistory'"));
  for (const id of ['mcp-tasks-monitor', 'mcp-monitor-tabs', 'mcp-monitor-tab-active', 'mcp-monitor-tab-history', 'mcp-monitor-status-filter', 'mcp-monitor-search', 'mcp-monitor-list']) {
    assert.ok(panel.includes(id), `McpTasksMonitorPanel thiếu testid ${id}`);
  }
});

test('IPC the monitor needs exists in main + preload + global.d.ts', () => {
  const main = read(['apps', 'desktop', 'src', 'main', 'main.ts']);
  const preload = read(['apps', 'desktop', 'src', 'main', 'preload.ts']);
  const dts = read(['apps', 'desktop', 'src', 'renderer', 'global.d.ts']);
  for (const channel of ['mcp-tasks:list', 'mcp-tasks:cancel']) {
    assert.ok(main.includes(`'${channel}'`), `main thiếu IPC ${channel}`);
    assert.ok(preload.includes(`ipcRenderer.invoke('${channel}'`), `preload thiếu invoke ${channel}`);
  }
  for (const method of ['listMcpTasks', 'cancelMcpTask', 'onMcpTasksChanged']) {
    assert.ok(dts.includes(method), `global.d.ts thiếu ${method}`);
  }
});

test('monitor panel wired into App view + Sidebar nav (appended at the end)', () => {
  const app = read(['apps', 'desktop', 'src', 'renderer', 'App.tsx']);
  const sidebar = read(['apps', 'desktop', 'src', 'renderer', 'components', 'Sidebar.tsx']);
  assert.ok(app.includes("import McpTasksMonitorPanel from './components/McpTasksMonitorPanel'"));
  assert.ok(app.includes("'mcp-tasks-monitor'"));
  assert.ok(app.includes('<McpTasksMonitorPanel onBack={() => setView(\'chat\')} />'));
  assert.ok(app.includes('onOpenMcpTasksMonitor={() => setView(\'mcp-tasks-monitor\')}'));
  assert.ok(sidebar.includes('onOpenMcpTasksMonitor: () => void;'));
  assert.ok(sidebar.includes("t('sidebar.mcpTasksMonitor')"));
  const settingsIdx = sidebar.indexOf("t('sidebar.settings')");
  const monitorIdx = sidebar.indexOf("t('sidebar.mcpTasksMonitor')");
  assert.ok(monitorIdx > settingsIdx, 'monitor nav entry phải nằm cuối danh sách, sau settings');
});
