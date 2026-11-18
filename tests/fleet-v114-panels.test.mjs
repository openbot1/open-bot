/**
 * Fleet panels v11 tests (v1.14, Đội T6 — node:test, no network).
 *
 * Covers:
 * - Memory panel: ACL (systemOwned chỉ user; readOnly không sửa; agent
 *   chỉ được block của mình), lọc theo loại + tìm kiếm, sắp xếp system
 *   label trước, đếm version từ history, over-limit.
 * - Memory rollback: plan đúng version (nội dung khôi phục), chặn khi
 *   không có quyền / version không tồn tại / đã ở version đó.
 * - Memory history: mới nhất trước, charsChanged, isCurrent.
 * - Voice panel: latency rows theo stage + over-budget, slowest stage,
 *   barge-in validate (threshold 0-1, minSpeech 0-5000), wake word
 *   validate (rỗng / ngắn / >3 từ / ký tự lạ), provider picker
 *   (available theo key, selected fallback về provider dùng được).
 * - MCP Apps panel: search/category/onlyCompatible, install state,
 *   permission review (blocked/risky), CSP summary (cảnh báo khi app
 *   cần mạng mà host chặn), template blank/note/dashboard.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v114-panels.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFleetV11McpAppTemplate,
  buildFleetV11McpAppsPanel,
  buildFleetV11MemoryHistory,
  buildFleetV11MemoryPanel,
  buildFleetV11VoicePanel,
  checkFleetV11MemoryAcl,
  planFleetV11MemoryRollback,
  reviewFleetV11McpPermissions,
  summarizeFleetV11McpCsp,
  validateFleetV11BargeInConfig,
  validateFleetV11WakeWord,
} from '../packages/core/dist/index.js';

const T0 = '2026-11-16T00:00:00.000Z';

function block(overrides = {}) {
  return {
    id: 'blk-1',
    label: 'so-thich',
    description: 'Sở thích.',
    content: 'Thích phở.',
    charLimit: 2000,
    readOnly: false,
    systemOwned: false,
    createdByBotId: '',
    version: 2,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function historyFor(id, versions) {
  return versions.map((v) => ({
    blockId: id,
    label: 'so-thich',
    version: v,
    content: `nội dung v${v}`,
    description: 'Sở thích.',
    charLimit: 2000,
    readOnly: false,
    action: v === 1 ? 'create' : 'update',
    actor: 'user',
    at: T0,
  }));
}

test('memory ACL: systemOwned chỉ user, readOnly không sửa, agent chỉ block của mình', () => {
  const sys = block({ systemOwned: true });
  assert.equal(checkFleetV11MemoryAcl(sys, 'user').canEdit, true);
  const agentAcl = checkFleetV11MemoryAcl(sys, 'agent:bot-1');
  assert.equal(agentAcl.canEdit, false);
  assert.equal(agentAcl.canDelete, false);
  assert.equal(agentAcl.canRestore, false);
  assert.match(agentAcl.deniedReason, /hệ thống/);

  const ro = block({ readOnly: true });
  assert.equal(checkFleetV11MemoryAcl(ro, 'user').canEdit, false);
  assert.equal(checkFleetV11MemoryAcl(ro, 'user').canRestore, true);
  assert.equal(checkFleetV11MemoryAcl(ro, 'agent:bot-1').canRestore, false);

  const own = block({ createdByBotId: 'bot-1' });
  assert.equal(checkFleetV11MemoryAcl(own, 'agent:bot-1').canEdit, true);
  assert.equal(checkFleetV11MemoryAcl(own, 'agent:bot-2').canEdit, false);
  assert.match(checkFleetV11MemoryAcl(own, 'agent:bot-2').deniedReason, /bot khác/);

  const unowned = block({ createdByBotId: '' });
  assert.equal(checkFleetV11MemoryAcl(unowned, 'agent:bot-9').canEdit, true);
  assert.equal(checkFleetV11MemoryAcl(unowned, 'user').canView, true);
});

test('memory panel: lọc + tìm kiếm + sắp xếp + đếm version + over-limit', () => {
  const blocks = [
    block({ id: 'blk-food', label: 'so-thich', version: 2, description: 'Sở thích ăn uống.', content: 'Thích phở.' }),
    block({ id: 'blk-human', label: 'human', systemOwned: true, version: 3, description: 'Thông tin về người dùng.', content: 'Tên Huy.' }),
    block({ id: 'blk-locked', label: 'quy-tac', readOnly: true, version: 1, description: 'Quy tắc đã khóa.', content: 'Không đăng khi chưa duyệt.' }),
    block({ id: 'blk-long', label: 'dai', content: 'x'.repeat(2500), charLimit: 2000, version: 1, description: 'Block dài.' }),
  ];
  const history = {
    'blk-food': historyFor('blk-food', [1, 2]),
    'blk-human': historyFor('blk-human', [1, 2, 3]),
  };
  const panel = buildFleetV11MemoryPanel(blocks, history, 'user');
  assert.equal(panel.totalBlocks, 4);
  assert.equal(panel.shownBlocks, 4);
  assert.equal(panel.systemBlocks, 1);
  assert.equal(panel.readOnlyBlocks, 1);
  assert.equal(panel.overLimitBlocks, 1);
  assert.equal(panel.rows[0].block.label, 'human', 'system label xếp trước');
  assert.equal(panel.rows.find((r) => r.block.id === 'blk-food').versionCount, 2);
  assert.equal(panel.rows.find((r) => r.block.id === 'blk-food').latestVersion, 2);
  assert.equal(panel.rows.find((r) => r.block.id === 'blk-long').overLimit, true);
  assert.equal(panel.rows.find((r) => r.block.id === 'blk-locked').acl.canEdit, false);

  const sysOnly = buildFleetV11MemoryPanel(blocks, history, 'user', { filter: 'system' });
  assert.equal(sysOnly.shownBlocks, 1);
  const search = buildFleetV11MemoryPanel(blocks, history, 'user', { query: 'phở' });
  assert.equal(search.shownBlocks, 1);
  assert.equal(search.rows[0].block.id, 'blk-food');
  const none = buildFleetV11MemoryPanel(blocks, history, 'user', { query: 'zzz-khong-co' });
  assert.equal(none.shownBlocks, 0);
  assert.match(none.summary, /Không có block/);
});

test('memory rollback: plan đúng, chặn khi không quyền / sai version / đã ở version đó', () => {
  const b = block({ version: 2 });
  const hist = historyFor('blk-1', [1, 2]);
  const plan = planFleetV11MemoryRollback(b, hist, 1, 'user');
  assert.equal(plan.ok, true);
  assert.equal(plan.toVersion, 1);
  assert.equal(plan.fromVersion, 2);
  assert.equal(plan.restoreContent, 'nội dung v1');

  const missing = planFleetV11MemoryRollback(b, hist, 9, 'user');
  assert.equal(missing.ok, false);
  assert.match(missing.error, /không tìm thấy version 9/);

  const same = planFleetV11MemoryRollback(b, hist, 2, 'user');
  assert.equal(same.ok, false);
  assert.match(same.error, /đã ở version 2/);

  const sys = block({ version: 2, systemOwned: true });
  const denied = planFleetV11MemoryRollback(sys, hist, 1, 'agent:bot-1');
  assert.equal(denied.ok, false);
  assert.match(denied.error, /hệ thống/);
});

test('memory history: mới nhất trước, charsChanged, isCurrent', () => {
  const b = block({ version: 2 });
  const rows = buildFleetV11MemoryHistory(b, historyFor('blk-1', [1, 2]));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].snapshot.version, 2);
  assert.equal(rows[0].isCurrent, true);
  assert.equal(rows[1].isCurrent, false);
  assert.equal(rows[0].charsChanged, 'nội dung v2'.length - 'nội dung v1'.length);
  assert.equal(rows[1].charsChanged, null, 'version đầu tiên không có prev');
});

function latencySummary(p50, p95, p99, count = 10) {
  return { count, minMs: 1, maxMs: p99 + 10, meanMs: p50, p50Ms: p50, p95Ms: p95, p99Ms: p99, lastMs: p50, buckets: [] };
}

function voiceReport(overrides = {}) {
  return {
    sessionId: 's1',
    mode: 'balanced',
    turns: 5,
    stages: {
      capture: latencySummary(10, 20, 30),
      vad: latencySummary(40, 70, 100),
      stt: latencySummary(200, 300, 400),
      llm: latencySummary(400, 900, 1200),
      tts: latencySummary(100, 200, 300),
      playback: latencySummary(20, 50, 80),
    },
    endToEnd: latencySummary(800, 1100, 1400),
    slowestStage: { stage: 'llm', p95Ms: 900 },
    jitterBufferMs: 120,
    at: Date.now(),
    ...overrides,
  };
}

test('voice barge-in: validate ngưỡng 0-1 và minSpeech 0-5000', () => {
  const ok = validateFleetV11BargeInConfig({ enabled: true, threshold: 0.5, minSpeechMs: 300 });
  assert.equal(ok.ok, true);
  assert.equal(ok.config.threshold, 0.5);
  const bad = validateFleetV11BargeInConfig({ threshold: 1.5, minSpeechMs: 99999 });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 2);
  const def = validateFleetV11BargeInConfig(null);
  assert.equal(def.ok, true);
  assert.equal(def.config.enabled, true);
  assert.equal(def.config.threshold, 0.5);
});

test('voice wake word: rỗng/ngắn/dài/>3 từ/ký tự lạ đều lỗi, hợp lệ thì ok', () => {
  assert.equal(validateFleetV11WakeWord('hey bot').ok, true);
  assert.equal(validateFleetV11WakeWord('hey bot').wakeWord, 'hey bot');
  assert.equal(validateFleetV11WakeWord('  hey   bot  ').wakeWord, 'hey bot', 'gộp khoảng trắng');
  assert.equal(validateFleetV11WakeWord('').ok, false);
  assert.equal(validateFleetV11WakeWord('hi').ok, false, 'quá ngắn');
  assert.equal(validateFleetV11WakeWord('a b c d').ok, false, '4 từ');
  assert.equal(validateFleetV11WakeWord('hey bot!').ok, false, 'ký tự !');
  assert.equal(validateFleetV11WakeWord('x'.repeat(41)).ok, false, 'quá 40 ký tự');
  assert.equal(validateFleetV11WakeWord(123).ok, false, 'không phải string');
});

test('voice panel: latency rows, over-budget, slowest stage, provider picker', () => {
  const panel = buildFleetV11VoicePanel(voiceReport(), {
    bargeIn: { enabled: true, threshold: 0.5, minSpeechMs: 300 },
    wakeWord: 'hey bot',
    providersWithKey: ['gemini'],
    selectedProviderId: 'gemini',
  });
  assert.equal(panel.turns, 5);
  assert.equal(panel.latencyRows.length, 6);
  assert.equal(panel.slowestStage.stage, 'llm');
  assert.equal(panel.endToEndP95Ms, 1100);
  assert.equal(panel.endToEndOverBudget, false);
  assert.equal(panel.bargeIn.enabled, true);
  assert.deepEqual(panel.bargeInErrors, []);
  assert.deepEqual(panel.wakeWordErrors, []);
  assert.equal(panel.selectedProviderId, 'gemini');
  const gemini = panel.providers.find((p) => p.id === 'gemini');
  assert.equal(gemini.available, true, 'gemini có key');
  const openai = panel.providers.find((p) => p.id === 'openai');
  assert.equal(openai.available, false, 'openai chưa có key');
  assert.equal(openai.needsKey, true);
  assert.ok(panel.providers.length >= 4, 'catalog v10 có ít nhất 4 provider');
  assert.ok(panel.providers.every((p) => p.defaultVoiceId !== null));

  // End-to-end p95 vượt ngân sách 1200 -> overBudget + summary cảnh báo.
  const over = buildFleetV11VoicePanel(voiceReport({ endToEnd: latencySummary(1000, 1500, 1800) }), {});
  assert.equal(over.endToEndOverBudget, true);
  assert.match(over.summary, /vượt ngân sách/);

  // Không có report -> rows rỗng, summary mời bắt đầu phiên.
  const empty = buildFleetV11VoicePanel(null, { wakeWord: 'bad!' });
  assert.equal(empty.latencyRows.length, 0);
  assert.match(empty.summary, /Chưa có dữ liệu/);
  assert.ok(empty.wakeWordErrors.length > 0);
  assert.equal(empty.sessionId, null);
});

test('mcp apps panel: search/category/onlyCompatible, install state, summary', () => {
  const panel = buildFleetV11McpAppsPanel({});
  assert.ok(panel.totalApps >= 10, 'catalogue v112 có ít nhất 10 app');
  assert.equal(panel.shownApps, panel.totalApps);
  assert.ok(panel.categories.length >= 3);
  assert.ok(panel.rows.every((r) => typeof r.compatible === 'boolean'));

  const kanban = buildFleetV11McpAppsPanel({ query: 'kanban' });
  assert.equal(kanban.shownApps, 1);
  assert.equal(kanban.rows[0].app.id, 'kanban-board');

  const none = buildFleetV11McpAppsPanel({ query: 'zzz-khong-co' });
  assert.equal(none.shownApps, 0);
  assert.match(none.summary, /Không có app/);

  const installed = buildFleetV11McpAppsPanel({
    installs: [{ appId: 'kanban-board', version: '1.2.0', serverId: 'open-bot-apps', installedAtMs: 1, enabled: true }],
  });
  assert.equal(installed.installedCount, 1);
  const row = installed.rows.find((r) => r.app.id === 'kanban-board');
  assert.equal(row.installed, true);
  assert.equal(row.enabled, true);
  assert.equal(row.installedVersion, '1.2.0');
});

test('mcp permissions review: blocked khi host chưa cấp, risky cho write-files/network', () => {
  // Catalogue v112 không có app nào cần mạng — dùng entry tùy chỉnh.
  const netEntry = {
    id: 'net-app', name: 'Net App', version: '1.0.0', description: 'App cần mạng.',
    serverId: 'test', category: 'data', permissions: ['read-files', 'network'],
    minHostVersion: '0.1.0', maxHostVersion: null, needsNetwork: true, needsScripts: true,
    tags: [], installSizeKb: 10,
  };
  const panel = buildFleetV11McpAppsPanel({ catalogue: [netEntry] });
  const netApp = panel.rows.find((r) => r.app.needsNetwork);
  assert.ok(netApp, 'catalogue tùy chỉnh có app cần mạng');
  const review = reviewFleetV11McpPermissions(netApp.app, {
    hostVersion: '0.2.0',
    grantedPermissions: ['read-files', 'clipboard', 'notifications'],
    allowNetwork: false,
    sandboxStrict: true,
  });
  const network = review.find((x) => x.permission === 'network');
  assert.equal(network.requested, true);
  assert.equal(network.granted, false);
  assert.equal(network.blocked, true);
  assert.equal(network.risky, true);
  const read = review.find((x) => x.permission === 'read-files');
  assert.equal(read.blocked, false);
});

test('mcp CSP: cảnh báo khi app cần mạng mà host chặn, an toàn khi đủ quyền', () => {
  const netEntry = {
    id: 'net-app', name: 'Net App', version: '1.0.0', description: 'App cần mạng.',
    serverId: 'test', category: 'data', permissions: ['read-files', 'network'],
    minHostVersion: '0.1.0', maxHostVersion: null, needsNetwork: true, needsScripts: true,
    tags: [], installSizeKb: 10,
  };
  const panel = buildFleetV11McpAppsPanel({ catalogue: [netEntry] });
  const netApp = panel.rows.find((r) => r.app.needsNetwork);
  assert.ok(netApp, 'catalogue tùy chỉnh có app cần mạng');
  const blocked = summarizeFleetV11McpCsp(netApp.app, {
    hostVersion: '0.2.0',
    grantedPermissions: ['read-files', 'clipboard', 'notifications'],
    allowNetwork: false,
    sandboxStrict: true,
  });
  assert.equal(blocked.allowsNetwork, false);
  assert.ok(blocked.warnings.length > 0);
  assert.ok(blocked.sandboxDirectives.some((d) => d.includes('connect-src none')));

  const ok = summarizeFleetV11McpCsp(netApp.app, {
    hostVersion: '0.2.0',
    grantedPermissions: ['read-files', 'write-files', 'network', 'clipboard', 'notifications'],
    allowNetwork: true,
    sandboxStrict: true,
  });
  assert.equal(ok.allowsNetwork, true);
  assert.equal(ok.warnings.filter((w) => w.includes('mạng')).length, 0);
});

test('mcp template: blank/note/dashboard có manifest + file mẫu hợp lệ', () => {
  for (const kind of ['blank', 'note', 'dashboard']) {
    const tpl = buildFleetV11McpAppTemplate(kind, 'My App!');
    assert.equal(tpl.kind, kind);
    assert.equal(tpl.files['manifest.json'] !== undefined, true);
    const manifest = JSON.parse(tpl.files['manifest.json']);
    assert.equal(manifest.id, 'my-app', 'id được slugify');
    assert.equal(manifest.version, '0.1.0');
    assert.ok(tpl.files['index.html'].includes('<h1>'));
  }
  const note = buildFleetV11McpAppTemplate('note', 'ghi-chu');
  assert.ok(note.files['index.html'].includes('textarea'));
  assert.ok(note.files['index.html'].includes('localStorage'));
  const dash = buildFleetV11McpAppTemplate('dashboard', 'dash');
  assert.ok(dash.files['index.html'].includes('setInterval'));
});
