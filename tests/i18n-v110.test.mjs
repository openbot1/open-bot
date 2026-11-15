/**
 * Test v1.10: i18n key mới — Đội T2 MCP 2026-07-28 (25 key mcp110.*)
 * + Đội T3 Agent Teams v2 (47 key teamsV2.* + sidebar.agentTeamsV2)
 * + Đội T6 fleet campaign v2 (31 fleetV7.*) + Composio mock toolkit
 * (10 composioV110.*) + provider Cerebras (8 providerCerebras.*) —
 * đủ 6 locale, placeholder khớp en.
 *
 * Chỉ test thuần (đọc JSON). Không cần build:
 *   node --test tests/i18n-v110.test.mjs
 *
 * NOTE (pin toàn cục — coordinator gộp tính lại): tổng số key mỗi
 * locale được pin trong tests/i18n-v109.test.mjs và các file pin khác;
 * file này chỉ kiểm tra key mới + key sort + số lượng bằng nhau giữa
 * các locale, không pin số tuyệt đối (tránh xung đột giữa các đội).
 *
 * Lưu ý locale: repo có 6 locale en/vi/es/fr/ja/zh (KHÔNG có ko.json
 * — brief sóng ghi ko nhưng thư mục i18n hiện có dùng es thay ko).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');
const LOCALE_NAMES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

const MCP110_KEYS = [
  'mcp110.title',
  'mcp110.subtitle',
  'mcp110.inputRequired',
  'mcp110.inputRequiredDesc',
  'mcp110.resultTypeRequired',
  'mcp110.complete',
  'mcp110.inputRequiredRound',
  'mcp110.tasksExtension',
  'mcp110.tasksExtensionDesc',
  'mcp110.filesExtension',
  'mcp110.filesExtensionDesc',
  'mcp110.autoBackground',
  'mcp110.autoBackgroundDesc',
  'mcp110.backgrounded',
  'mcp110.uploadComplete',
  'mcp110.fileNotFound',
  'mcp110.taskWaitingInput',
  'mcp110.taskCompleted',
  'mcp110.toolMrtrInputRequired',
  'mcp110.toolTasksWait',
  'mcp110.toolTasksAutoBackground',
  'mcp110.toolFilesUpload',
  'mcp110.toolFilesDownload',
  'mcp110.securityAudit',
  'mcp110.securityAuditDesc',
];

// 46 teamsV2.* + sidebar.agentTeamsV2 (đếm tay từ component + sidebar).
// 'sidebar.*' sort trước 'teamsV2.*' ('s' < 't').
const TEAMS_V2_KEYS = [
  'sidebar.agentTeamsV2',
  'teamsV2.activityLog',
  'teamsV2.assigned',
  'teamsV2.back',
  'teamsV2.claimedBy',
  'teamsV2.cost',
  'teamsV2.costEstimate',
  'teamsV2.currentTask',
  'teamsV2.dependsOn',
  'teamsV2.empty',
  'teamsV2.emptyHint',
  'teamsV2.forkDepth',
  'teamsV2.forks',
  'teamsV2.from',
  'teamsV2.goal',
  'teamsV2.leaseUntil',
  'teamsV2.loadError',
  'teamsV2.loading',
  'teamsV2.lockStale',
  'teamsV2.locks',
  'teamsV2.mailbox',
  'teamsV2.merged',
  'teamsV2.name',
  'teamsV2.noEvents',
  'teamsV2.noFeedback',
  'teamsV2.noForks',
  'teamsV2.noLocks',
  'teamsV2.noMessages',
  'teamsV2.noTasks',
  'teamsV2.priority',
  'teamsV2.ready',
  'teamsV2.refresh',
  'teamsV2.results',
  'teamsV2.reviewFeedback',
  'teamsV2.role',
  'teamsV2.session',
  'teamsV2.sessionClosed',
  'teamsV2.sessionOpen',
  'teamsV2.sizeWarning',
  'teamsV2.status',
  'teamsV2.tasks',
  'teamsV2.tasksDone',
  'teamsV2.teammates',
  'teamsV2.teamsCount',
  'teamsV2.title',
  'teamsV2.tokens',
  'teamsV2.unread',
];

// Đội T6: 31 fleetV7.* + 10 composioV110.* + 8 providerCerebras.* (49 key).
const FLEET_V7_V110_KEYS = [
  'fleetV7.title',
  'fleetV7.subtitle',
  'fleetV7.campaign',
  'fleetV7.campaigns',
  'fleetV7.goal',
  'fleetV7.stage',
  'fleetV7.stageCanary',
  'fleetV7.stageStaged',
  'fleetV7.stageFull',
  'fleetV7.status',
  'fleetV7.statusDraft',
  'fleetV7.statusActive',
  'fleetV7.statusPaused',
  'fleetV7.statusDone',
  'fleetV7.statusRolledBack',
  'fleetV7.statusCancelled',
  'fleetV7.progress',
  'fleetV7.successRate',
  'fleetV7.bots',
  'fleetV7.nodes',
  'fleetV7.rollout',
  'fleetV7.rollback',
  'fleetV7.report',
  'fleetV7.noCampaigns',
  'fleetV7.gateClosed',
  'fleetV7.confirmRollback',
  'fleetV7.pause',
  'fleetV7.resume',
  'fleetV7.cancel',
  'fleetV7.clone',
  'fleetV7.plan',
  'composioV110.title',
  'composioV110.mockOnly',
  'composioV110.mockToolkit',
  'composioV110.needsLiveKey',
  'composioV110.liveKeyNote',
  'composioV110.execute',
  'composioV110.listTitle',
  'composioV110.slugUnverified',
  'composioV110.mockResponse',
  'composioV110.toolkitCount',
  'providerCerebras.title',
  'providerCerebras.defaultModel',
  'providerCerebras.knownModels',
  'providerCerebras.baseUrl',
  'providerCerebras.needsKey',
  'providerCerebras.modelsTitle',
  'providerCerebras.fallbackNote',
  'providerCerebras.vaultNamespace',
];

function loadLocale(loc) {
  return JSON.parse(readFileSync(join(localesDir, `${loc}.json`), 'utf8'));
}

function placeholders(value) {
  return [...String(value).matchAll(/\{[^}]+\}/g)].map((m) => m[0]).sort();
}

function checkKeys(keys) {
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

test('mcp110.* keys exist in all 6 locales, non-empty, placeholders match en', () => {
  checkKeys(MCP110_KEYS);
});

test('teams v2 keys exist in all 6 locales with matching placeholders', () => {
  assert.equal(TEAMS_V2_KEYS.length, 47);
  assert.deepEqual([...TEAMS_V2_KEYS].sort(), TEAMS_V2_KEYS, 'TEAMS_V2_KEYS phải sort sẵn');
  checkKeys(TEAMS_V2_KEYS);
});

test('fleet v7 / composio v110 / cerebras keys exist in all 6 locales with matching placeholders', () => {
  assert.equal(FLEET_V7_V110_KEYS.length, 49);
  checkKeys(FLEET_V7_V110_KEYS);
});

test('locale files stay key-sorted and keep the same key count', () => {
  const counts = LOCALE_NAMES.map((loc) => {
    const dict = loadLocale(loc);
    const keys = Object.keys(dict);
    assert.deepEqual(keys, [...keys].sort(), `keys not sorted in ${loc}`);
    return keys.length;
  });
  assert.ok(counts.every((c) => c === counts[0]), `key counts differ: ${counts.join(', ')}`);
});

test('teams v2 keys are sorted in every locale file', () => {
  for (const loc of LOCALE_NAMES) {
    const keys = Object.keys(loadLocale(loc));
    assert.deepEqual(keys, [...keys].sort(), `${loc} keys are not sorted`);
  }
});

test('every teamsV2 key used by AgentTeamsV2View exists in every locale', () => {
  const viewSrc = readFileSync(
    join(here, '..', 'apps/desktop/src/renderer/components/AgentTeamsV2View.tsx'),
    'utf8',
  );
  const used = new Set();
  for (const m of viewSrc.matchAll(/t\(\s*'([A-Za-z0-9_.]+)'/g)) used.add(m[1]);
  const teamsV2Used = [...used].filter((k) => k.startsWith('teamsV2.'));
  assert.ok(teamsV2Used.length > 20, `AgentTeamsV2View dùng quá ít key teamsV2: ${teamsV2Used.length}`);
  for (const loc of LOCALE_NAMES) {
    const dict = loadLocale(loc);
    for (const key of teamsV2Used) {
      assert.ok(key in dict, `${key} dùng trong AgentTeamsV2View nhưng thiếu ở ${loc}`);
    }
  }
  // Không còn chuỗi tiếng Việt hard-code trong component (i18n sống ở vi.json).
  // Loại comment khỏi nguồn trước khi kiểm tra (comment tiếng Việt được phép).
  const codeOnly = viewSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
  assert.ok(!/[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđÀÁẢÃẠĂẮẰẲẴẶÂẤẦẨẪẬÈÉẺẼẸÊẾỀỂỄỆÌÍỈĨỊÒÓỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢÙÚỦŨỤƯỨỪỬỮỰỲÝỶỸỴĐ]/.test(codeOnly), 'AgentTeamsV2View còn chuỗi tiếng Việt hard-code');
});
