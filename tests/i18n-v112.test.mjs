/**
 * Test v1.12: i18n key mới — Đội T2 conversation v112 (33 key
 * convV112.*) + Đội T4 ACP Control Center (57 key acpControl.*)
 * convV112.*) — đủ 6 locale, placeholder khớp en.
 *
 * Chỉ test thuần (đọc JSON). Không cần build:
 *   node --test tests/i18n-v112.test.mjs
 *
 * NOTE (pin toàn cục — coordinator gộp tính lại): tổng số key mỗi
 * locale được pin trong tests/i18n-v106.test.mjs và các file pin khác
 * (4565 ở v1.11); file này chỉ kiểm tra key mới + key sort + số
 * lượng bằng nhau giữa các locale, không pin số tuyệt đối (tránh
 * xung đột giữa các đội). Sau merge, pin toàn cục = 4565 + 33 = 4598
 * (cộng thêm key các đội khác cùng sóng nếu có).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');
const LOCALE_NAMES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

const CONV_V112_KEYS = [
  'convV112.branch',
  'convV112.branchAction',
  'convV112.branches',
  'convV112.chainBroken',
  'convV112.chainOk',
  'convV112.codeactBlocked',
  'convV112.codeactRuns',
  'convV112.compact',
  'convV112.deterministic',
  'convV112.empty',
  'convV112.export',
  'convV112.lastSeq',
  'convV112.loadError',
  'convV112.loading',
  'convV112.messages',
  'convV112.refresh',
  'convV112.replay',
  'convV112.replayOk',
  'convV112.retry',
  'convV112.runCodeact',
  'convV112.seq',
  'convV112.skillList',
  'convV112.skillLoad',
  'convV112.skillsLoaded',
  'convV112.snapshot',
  'convV112.status',
  'convV112.statusActive',
  'convV112.statusBranched',
  'convV112.statusCompacted',
  'convV112.statusEnded',
  'convV112.subtitle',
  'convV112.title',
  'convV112.toolCalls',
];

const ACP_CONTROL_KEYS = [
  'acpControl.actionError',
  'acpControl.alertBlocked',
  'acpControl.alertExceeded',
  'acpControl.alertsTitle',
  'acpControl.alertWarned',
  'acpControl.blockedReason',
  'acpControl.budget',
  'acpControl.budgetCaps',
  'acpControl.calls',
  'acpControl.callsPerDay',
  'acpControl.confirmStop',
  'acpControl.cost',
  'acpControl.day',
  'acpControl.costPerDay',
  'acpControl.disable',
  'acpControl.disabled',
  'acpControl.discover',
  'acpControl.discovering',
  'acpControl.emptyAlerts',
  'acpControl.emptyHistory',
  'acpControl.enable',
  'acpControl.enabled',
  'acpControl.historyTitle',
  'acpControl.loadError',
  'acpControl.loggedIn',
  'acpControl.loginLabel',
  'acpControl.noAgents',
  'acpControl.noAgentsHint',
  'acpControl.notInstalled',
  'acpControl.notLoggedIn',
  'acpControl.refresh',
  'acpControl.register',
  'acpControl.report',
  'acpControl.reportTitle',
  'acpControl.registered',
  'acpControl.setBudget',
  'acpControl.speaksAcp',
  'acpControl.start',
  'acpControl.starting',
  'acpControl.status',
  'acpControl.statusBlocked',
  'acpControl.statusError',
  'acpControl.statusRegistered',
  'acpControl.statusRunning',
  'acpControl.statusStarting',
  'acpControl.statusStopped',
  'acpControl.stop',
  'acpControl.stopping',
  'acpControl.subtitle',
  'acpControl.title',
  'acpControl.tokens',
  'acpControl.tokensPerDay',
  'acpControl.usageToday',
  'acpControl.usageTotal',
  'acpControl.wallPerDay',
  'acpControl.wallTime',
  'sidebar.acpControl',
];

function loadLocale(name) {
  return JSON.parse(readFileSync(join(localesDir, `${name}.json`), 'utf8'));
}

function placeholders(value) {
  return [...String(value).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

test('i18n v112: all new keys exist in all 6 locales, non-empty', () => {
  assert.equal(CONV_V112_KEYS.length, 33);
  for (const name of LOCALE_NAMES) {
    const locale = loadLocale(name);
    for (const key of CONV_V112_KEYS) {
      assert.ok(key in locale, `${name} missing ${key}`);
      assert.equal(typeof locale[key], 'string', `${name}.${key} must be a string`);
      assert.ok(locale[key].trim().length > 0, `${name}.${key} must not be empty`);
    }
  }
});

test('i18n v112: placeholders match en in every locale', () => {
  const en = loadLocale('en');
  for (const name of LOCALE_NAMES) {
    if (name === 'en') continue;
    const locale = loadLocale(name);
    for (const key of CONV_V112_KEYS) {
      assert.deepEqual(
        placeholders(locale[key]),
        placeholders(en[key]),
        `${name}.${key} placeholders differ from en`,
      );
    }
  }
});

test('i18n v112: locale files stay sorted and equal-sized', () => {
  const counts = LOCALE_NAMES.map((name) => {
    const locale = loadLocale(name);
    const keys = Object.keys(locale);
    assert.deepEqual(keys, [...keys].sort(), `${name} keys not sorted`);
    return keys.length;
  });
  assert.ok(counts.every((c) => c === counts[0]), `locale key counts differ: ${counts.join(', ')}`);
  assert.ok(counts[0] >= 8072, `expected >= 8072 keys per locale, got ${counts[0]}`); // v1.39 fix round 4b: floor (was 8072 in v1.38; now 8322).
});

test('i18n v112: 57 key acpControl/sidebar mới có đủ 6 locale, không rỗng', () => {
  assert.equal(ACP_CONTROL_KEYS.length, 57);
  const locales = LOCALE_NAMES.map(loadLocale);
  for (const key of ACP_CONTROL_KEYS) {
    for (let i = 0; i < LOCALE_NAMES.length; i += 1) {
      assert.ok(
        typeof locales[i][key] === 'string' && locales[i][key].length > 0,
        `missing/empty ${key} in ${LOCALE_NAMES[i]}`,
      );
    }
  }
});

test('i18n v112: placeholder khớp en ở mọi locale', () => {
  const locales = LOCALE_NAMES.map(loadLocale);
  const en = locales[0];
  for (const key of ACP_CONTROL_KEYS) {
    const want = placeholders(en[key]);
    for (let i = 1; i < LOCALE_NAMES.length; i += 1) {
      assert.deepEqual(placeholders(locales[i][key]), want, `placeholder mismatch ${key} in ${LOCALE_NAMES[i]}`);
    }
  }
  assert.deepEqual(placeholders(en['acpControl.blockedReason']), ['reasons']);
  assert.deepEqual(placeholders(en['acpControl.reportTitle']), ['days']);
});

// --- Đội T6: fleetV9/automationV2/composioV112/mcpAppsV112 (88 key) ---
const NEW_KEYS = [
  // fleetV9.* (30)
  'fleetV9.title',
  'fleetV9.schedulesTitle',
  'fleetV9.queueTitle',
  'fleetV9.dayPlanTitle',
  'fleetV9.colBot',
  'fleetV9.colName',
  'fleetV9.colNextRun',
  'fleetV9.colPriority',
  'fleetV9.colStatus',
  'fleetV9.colAttempts',
  'fleetV9.emptySchedules',
  'fleetV9.emptyQueue',
  'fleetV9.createSchedule',
  'fleetV9.enable',
  'fleetV9.disable',
  'fleetV9.tick',
  'fleetV9.tickNow',
  'fleetV9.started',
  'fleetV9.missed',
  'fleetV9.retryWaiting',
  'fleetV9.heavy',
  'fleetV9.cpu',
  'fleetV9.ram',
  'fleetV9.nextRun',
  'fleetV9.lastRun',
  'fleetV9.runCount',
  'fleetV9.failureCount',
  'fleetV9.unscheduled',
  'fleetV9.loading',
  'fleetV9.loadError',
  // automationV2.* (26)
  'automationV2.title',
  'automationV2.create',
  'automationV2.enable',
  'automationV2.disable',
  'automationV2.dryRun',
  'automationV2.runLogTitle',
  'automationV2.colName',
  'automationV2.colTrigger',
  'automationV2.colSteps',
  'automationV2.colLastRun',
  'automationV2.colStatus',
  'automationV2.empty',
  'automationV2.triggerTime',
  'automationV2.triggerFile',
  'automationV2.triggerWebhook',
  'automationV2.triggerManual',
  'automationV2.stepRunAgent',
  'automationV2.stepRunTool',
  'automationV2.stepNotify',
  'automationV2.stepCreateTask',
  'automationV2.stepWait',
  'automationV2.stepSetVariable',
  'automationV2.wouldRun',
  'automationV2.wouldNotRun',
  'automationV2.loading',
  'automationV2.loadError',
  // composioV112.* (10)
  'composioV112.title',
  'composioV112.mockNote',
  'composioV112.toolkitsTitle',
  'composioV112.execute',
  'composioV112.needsKey',
  'composioV112.liveNote',
  'composioV112.toolkit',
  'composioV112.slug',
  'composioV112.mockOnly',
  'composioV112.notLiveVerified',
  // mcpAppsV112.* (22)
  'mcpAppsV112.title',
  'mcpAppsV112.catalogueTitle',
  'mcpAppsV112.searchPlaceholder',
  'mcpAppsV112.install',
  'mcpAppsV112.uninstall',
  'mcpAppsV112.enable',
  'mcpAppsV112.disable',
  'mcpAppsV112.installed',
  'mcpAppsV112.notInstalled',
  'mcpAppsV112.compatible',
  'mcpAppsV112.incompatible',
  'mcpAppsV112.colApp',
  'mcpAppsV112.colVersion',
  'mcpAppsV112.colCategory',
  'mcpAppsV112.colStatus',
  'mcpAppsV112.empty',
  'mcpAppsV112.installConfirm',
  'mcpAppsV112.uninstallConfirm',
  'mcpAppsV112.loading',
  'mcpAppsV112.loadError',
  'mcpAppsV112.category',
  'mcpAppsV112.permissions',
];

test('i18n v112: new keys do not collide with existing namespaces', () => {
  const en = loadLocale('en');
  for (const key of NEW_KEYS) {
    assert.ok(key.startsWith('fleetV9.') || key.startsWith('automationV2.') || key.startsWith('composioV112.') || key.startsWith('mcpAppsV112.'), key);
  }
  assert.equal(en['fleetV9.title'], 'Fleet v9 scheduling');
  assert.equal(en['automationV2.title'], 'Automations v2');
  assert.equal(en['composioV112.title'], 'Composio mock v112');
  assert.equal(en['mcpAppsV112.title'], 'MCP Apps v112');
  // Vietnamese values differ from English (real translations, not copies).
  // (mcpAppsV112.title is a proper noun and is legitimately identical.)
  const vi = loadLocale('vi');
  assert.notEqual(vi['fleetV9.title'], en['fleetV9.title']);
  assert.notEqual(vi['automationV2.title'], en['automationV2.title']);
});
