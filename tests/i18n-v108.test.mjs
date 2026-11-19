/**
 * Test v1.08: i18n key mới — Đội T1 memory v9 (24) + Đội T4 providers v2 /
 * Composio v2 (24) + Đội T5 voice v7 + memory-blocks editor + event-log
 * time travel (135) + Đội T6 fleet v5 (24) — đủ 6 locale, placeholder khớp en.
 *
 * Chỉ test thuần (đọc JSON). Không cần build:
 *   node --test tests/i18n-v108.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');
const LOCALE_NAMES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

const MEMORY_V9_KEYS = [
  'memory.v9.noConflicts',
  'memory.v9.noSharedBlocks',
  'memory.v9.sharedAcl',
  'memory.v9.sharedConflicts',
  'memory.v9.sharedKeepMine',
  'memory.v9.sharedKeepTheirs',
  'memory.v9.sharedMerged',
  'memory.v9.sharedRegister',
  'memory.v9.sharedResolve',
  'memory.v9.sharedSync',
  'memory.v9.sharedTitle',
  'memory.v9.sharedWrite',
  'memory.v9.sleepDaemonOff',
  'memory.v9.sleepDaemonOn',
  'memory.v9.sleepEnable',
  'memory.v9.sleepLog',
  'memory.v9.sleepNextRun',
  'memory.v9.sleepRunNow',
  'memory.v9.sleepTitle',
  'memory.v9.versionCurrent',
  'memory.v9.versionDiff',
  'memory.v9.versionHistory',
  'memory.v9.versionRollback',
  'memory.v9.versionSnapshot',
];
const PROVIDERS_V108_KEYS = [
  'providers.v108.title',
  'providers.v108.healthTitle',
  'providers.v108.statusUp',
  'providers.v108.statusDegraded',
  'providers.v108.statusDown',
  'providers.v108.statusUnknown',
  'providers.v108.lastError',
  'providers.v108.quotaLow',
  'providers.v108.quotaUnknown',
  'providers.v108.latency',
  'providers.v108.lastChecked',
  'providers.v108.checkNow',
  'providers.v108.resetHealth',
  'providers.v108.alertsTitle',
  'providers.v108.historyTitle',
  'providers.v108.modelsTitle',
  'providers.v108.keyConfigured',
  'providers.v108.keyMissing',
  'composio.v108.title',
  'composio.v108.toolkitStatusTitle',
  'composio.v108.triggerMappingsTitle',
  'composio.v108.pollNow',
  'composio.v108.noChanges',
  'composio.v108.unhealthyToolkits',
];
const VOICE_V7_KEYS = [
  'sidebar.voiceSessions',
  'memory.tabBlocksEditor',
  'eventlog.timeTravel',
  'voice.v7.agent',
  'voice.v7.back',
  'voice.v7.bargeInError',
  'voice.v7.connect',
  'voice.v7.connectError',
  'voice.v7.connectNow',
  'voice.v7.connected',
  'voice.v7.create',
  'voice.v7.createError',
  'voice.v7.createTitle',
  'voice.v7.created',
  'voice.v7.delete',
  'voice.v7.deleteError',
  'voice.v7.deleted',
  'voice.v7.detailTitle',
  'voice.v7.duck',
  'voice.v7.ducked',
  'voice.v7.empty',
  'voice.v7.filterAgent',
  'voice.v7.filterAll',
  'voice.v7.filterUser',
  'voice.v7.finishedTitle',
  'voice.v7.interim',
  'voice.v7.interrupt',
  'voice.v7.interrupted',
  'voice.v7.interruptedLine',
  'voice.v7.intro',
  'voice.v7.lastPartial',
  'voice.v7.loadError',
  'voice.v7.loading',
  'voice.v7.mockOnly',
  'voice.v7.phase',
  'voice.v7.phaseIdle',
  'voice.v7.phaseListening',
  'voice.v7.phaseSpeaking',
  'voice.v7.phaseThinking',
  'voice.v7.presetNoisy',
  'voice.v7.presetOffice',
  'voice.v7.presetQuiet',
  'voice.v7.presetVeryNoisy',
  'voice.v7.provider',
  'voice.v7.restored',
  'voice.v7.resume',
  'voice.v7.resumed',
  'voice.v7.rowStats',
  'voice.v7.runningTitle',
  'voice.v7.select',
  'voice.v7.selected',
  'voice.v7.simulate',
  'voice.v7.simulateBusy',
  'voice.v7.simulateError',
  'voice.v7.simulateNeedsConnection',
  'voice.v7.simulateReply',
  'voice.v7.simulateReplyPlaceholder',
  'voice.v7.simulateTitle',
  'voice.v7.simulateUser',
  'voice.v7.simulateUserPlaceholder',
  'voice.v7.simulated',
  'voice.v7.stop',
  'voice.v7.stopError',
  'voice.v7.stopped',
  'voice.v7.title',
  'voice.v7.transcriptEmpty',
  'voice.v7.transcriptTitle',
  'voice.v7.unavailable',
  'voice.v7.user',
  'voice.v7.vadError',
  'voice.v7.vadPreset',
  'voice.v7.vadPresetSet',
  'voice.v7.vadStatus',
  'memoryBlockEditor.block',
  'memoryBlockEditor.bot',
  'memoryBlockEditor.cancel',
  'memoryBlockEditor.compareA',
  'memoryBlockEditor.compareB',
  'memoryBlockEditor.content',
  'memoryBlockEditor.contentPlaceholder',
  'memoryBlockEditor.create',
  'memoryBlockEditor.createError',
  'memoryBlockEditor.createTitle',
  'memoryBlockEditor.created',
  'memoryBlockEditor.delete',
  'memoryBlockEditor.deleteConfirm',
  'memoryBlockEditor.deleteError',
  'memoryBlockEditor.deleted',
  'memoryBlockEditor.description',
  'memoryBlockEditor.diffSame',
  'memoryBlockEditor.diffTitle',
  'memoryBlockEditor.empty',
  'memoryBlockEditor.historyEmpty',
  'memoryBlockEditor.historyError',
  'memoryBlockEditor.historyLoading',
  'memoryBlockEditor.historyTitle',
  'memoryBlockEditor.historyUnavailable',
  'memoryBlockEditor.intro',
  'memoryBlockEditor.label',
  'memoryBlockEditor.labelPlaceholder',
  'memoryBlockEditor.loadError',
  'memoryBlockEditor.loading',
  'memoryBlockEditor.localOnly',
  'memoryBlockEditor.meta',
  'memoryBlockEditor.noBot',
  'memoryBlockEditor.readOnly',
  'memoryBlockEditor.refresh',
  'memoryBlockEditor.restore',
  'memoryBlockEditor.restoreError',
  'memoryBlockEditor.restored',
  'memoryBlockEditor.save',
  'memoryBlockEditor.saveError',
  'memoryBlockEditor.updated',
  'eventLogTravel.back',
  'eventLogTravel.count',
  'eventLogTravel.empty',
  'eventLogTravel.future',
  'eventLogTravel.hidePayload',
  'eventLogTravel.intro',
  'eventLogTravel.jumpToEnd',
  'eventLogTravel.lastText',
  'eventLogTravel.lastTool',
  'eventLogTravel.nothingYet',
  'eventLogTravel.pause',
  'eventLogTravel.play',
  'eventLogTravel.remaining',
  'eventLogTravel.restart',
  'eventLogTravel.showFuture',
  'eventLogTravel.showPayload',
  'eventLogTravel.speed',
  'eventLogTravel.stateAtStep',
  'eventLogTravel.stateLine',
  'eventLogTravel.step',
  'eventLogTravel.stepOf',
  'eventLogTravel.title',
];
const FLEET_V5_KEYS = [
  'fleetV5.blockedTasks',
  'fleetV5.budget',
  'fleetV5.budgetHard',
  'fleetV5.budgetSoft',
  'fleetV5.budgetStop',
  'fleetV5.budgetThrottle',
  'fleetV5.campaign',
  'fleetV5.campaigns',
  'fleetV5.createCampaign',
  'fleetV5.dedupMerged',
  'fleetV5.goal',
  'fleetV5.health',
  'fleetV5.noCampaigns',
  'fleetV5.priority',
  'fleetV5.priorityCritical',
  'fleetV5.priorityHigh',
  'fleetV5.priorityLow',
  'fleetV5.priorityMedium',
  'fleetV5.progress',
  'fleetV5.repos',
  'fleetV5.subtitle',
  'fleetV5.task',
  'fleetV5.tasks',
  'fleetV5.title',
];
const V108_KEYS = [...MEMORY_V9_KEYS, ...PROVIDERS_V108_KEYS, ...VOICE_V7_KEYS, ...FLEET_V5_KEYS];

function loadLocale(loc) {
  return JSON.parse(readFileSync(join(localesDir, `${loc}.json`), 'utf8'));
}

function placeholders(value) {
  return [...String(value).matchAll(/\{[^}]+\}/g)].map((m) => m[0]).sort();
}

function checkKeys(keys, label) {
  const locales = LOCALE_NAMES.map(loadLocale);
  const [en, ...rest] = locales;
  for (const key of keys) {
    assert.ok(key in en, `missing in en: ${key}`);
    assert.ok(String(en[key]).length > 0, `empty in en: ${key}`);
    for (let i = 0; i < rest.length; i += 1) {
      const loc = LOCALE_NAMES[i + 1];
      assert.ok(key in rest[i], `missing in ${loc}: ${key}`);
      assert.ok(String(rest[i][key]).length > 0, `empty in ${loc}: ${key}`);
      assert.deepEqual(
        placeholders(rest[i][key]),
        placeholders(en[key]),
        `placeholder mismatch for ${key} in ${loc}`,
      );
    }
  }
}

test('memory v9 keys exist in all 6 locales with matching placeholders', () => {
  assert.equal(MEMORY_V9_KEYS.length, 24);
  checkKeys(MEMORY_V9_KEYS);
});

test('providers v2 + composio v2 keys exist in all 6 locales with matching placeholders', () => {
  assert.equal(PROVIDERS_V108_KEYS.length, 24);
  checkKeys(PROVIDERS_V108_KEYS);
});

test('voice v7 + memory-blocks editor + event-log keys exist in all 6 locales with matching placeholders', () => {
  assert.equal(VOICE_V7_KEYS.length, 135); // 3 nav + 70 voice.v7 + 40 memoryBlockEditor + 22 eventLogTravel
  checkKeys(VOICE_V7_KEYS);
});

test('fleet v5 keys exist in all 6 locales with matching placeholders', () => {
  assert.equal(FLEET_V5_KEYS.length, 24);
  checkKeys(FLEET_V5_KEYS);
});

test('all 6 locales have identical key sets', () => {
  const locales = LOCALE_NAMES.map(loadLocale);
  const [en, ...rest] = locales;
  const enKeys = Object.keys(en).sort();
  for (let i = 0; i < rest.length; i += 1) {
    assert.deepEqual(Object.keys(rest[i]).sort(), enKeys, `key set mismatch in ${LOCALE_NAMES[i + 1]}`);
  }
});

test('all 6 locales have the same total key count', () => {
  const counts = LOCALE_NAMES.map((loc) => Object.keys(loadLocale(loc)).length);
  assert.ok(counts.every((c) => c === counts[0]), `6 locales must have equal key counts, got ${counts.join(', ')}`);
  assert.ok(counts[0] >= 8072, `expected >= 8072 keys per locale, got ${counts[0]}`); // v1.39 fix round 4b: floor (was 8072 in v1.38; now 8322).
});

test('no locale is missing a v108 key the others have', () => {
  const locales = LOCALE_NAMES.map(loadLocale);
  const allKeys = new Set(locales.flatMap((l) => Object.keys(l)));
  for (const key of V108_KEYS) {
    assert.ok(allKeys.has(key), `key ${key} missing everywhere`);
  }
  for (const key of Object.keys(locales[0])) {
    for (let i = 1; i < locales.length; i += 1) {
      assert.ok(key in locales[i], `key ${key} missing in ${LOCALE_NAMES[i]}`);
    }
  }
});
