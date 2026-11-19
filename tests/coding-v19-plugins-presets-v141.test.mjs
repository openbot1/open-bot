/**
 * Tests cho coding agent v19 — Agent Plugins mcp.json + presets
 * (v1.41, Đội T4).
 *
 * Chạy thật: validate manifest mcp.json (đúng/sai đủ loại), load/
 * unload/bật-tắt server, executable config validate-trước-khi-áp
 * (sai thì giữ config cũ, secret luôn bị che), marketplace list/
 * search, preset builtin + custom CRUD/clone/apply/allowlist.
 * Không gọi model/mạng, không chạy command của plugin.
 *   npm run build --workspace=@open-bot/core  (scoped, trong worktree)
 *   node --test tests/coding-v19-plugins-presets-v141.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  V19_PLUGIN_CATALOG,
  renderV19Marketplace,
  renderV19PluginState,
  renderV19Preset,
  renderV19PresetApplyResult,
  renderV19PresetList,
  v19AllPresets,
  v19ApplyPluginConfig,
  v19ApplyPreset,
  v19BuiltinPresetById,
  v19BuiltinPresets,
  v19ClonePreset,
  v19CreatePreset,
  v19DeletePreset,
  v19FindPreset,
  v19IsSecretKey,
  v19IsToolAllowed,
  v19LoadPlugin,
  v19ManifestToJson,
  v19MarketplaceList,
  v19MarketplaceSearch,
  v19NormalizeManifest,
  v19ParseManifestJson,
  v19PluginManifestTemplate,
  v19PresetFromJson,
  v19PresetIdFromName,
  v19PresetToJson,
  v19RedactSecret,
  v19RedactedConfig,
  v19SetServerEnabled,
  v19UnloadPlugin,
  v19UpdatePreset,
  v19ValidateConfigAgainstSchema,
  v19ValidateManifest,
  v19ValidateMcpServer,
  v19ValidatePresetInput,
} from '../packages/core/dist/index.js';

const NOW = 1794000000000;

function goodManifest() {
  return {
    name: 'filesystem',
    version: '1.2.0',
    description: 'Read/write files in the workspace.',
    author: 'open-bot',
    category: 'filesystem',
    servers: [
      { id: 'fs', transport: 'stdio', command: 'node', args: ['server.js'], env: { FS_ROOT: '/tmp' } },
      { id: 'fs-http', transport: 'http', url: 'https://example.com/mcp', headers: { 'X-Key': 'abc' } },
    ],
    tools: ['coding_v19_workspace'],
    permissions: ['read', 'write'],
    config: { rootDir: '/tmp/ws', maxDepth: 5, apiKey: 'sk-secret-123456' },
    configSchema: {
      rootDir: { type: 'string', required: true },
      maxDepth: { type: 'number', required: false, default: 5 },
      apiKey: { type: 'string', required: false },
    },
  };
}

test('v19 manifest: manifest đúng validate ok (chỉ warning quyền write)', () => {
  const result = v19ValidateManifest(goodManifest());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.match(result.warnings.join(' '), /write/);
  const parsed = v19ParseManifestJson(JSON.stringify(goodManifest()));
  assert.equal(parsed.name, 'filesystem');
  assert.equal(parsed.servers[0].timeoutMs, 30000);
  assert.equal(v19ManifestToJson(goodManifest()).includes('"name": "filesystem"'), true);
  assert.throws(() => v19ParseManifestJson('{nope'), /không phải JSON/);
});

test('v19 manifest: các lỗi schema đều bị chặn với thông báo rõ', () => {
  const cases = [
    [{ ...goodManifest(), name: 'Bad Name!' }, /name/],
    [{ ...goodManifest(), version: 'x' }, /version/],
    [{ ...goodManifest(), category: 'nope' }, /category/],
    [{ ...goodManifest(), servers: [] }, /ít nhất 1 MCP server/],
    [{ ...goodManifest(), servers: [{ id: 's', transport: 'stdio' }] }, /command bắt buộc/],
    [{ ...goodManifest(), servers: [{ id: 's', transport: 'stdio', command: 'node; rm -rf /' }] }, /ký tự shell/],
    [{ ...goodManifest(), servers: [{ id: 's', transport: 'http' }] }, /url bắt buộc/],
    [{ ...goodManifest(), servers: [{ id: 's', transport: 'http', url: 'ftp://x' }] }, /http/],
    [{ ...goodManifest(), servers: [{ id: 's', transport: 'http', url: 'https://x', command: 'node' }] }, /không dùng với transport http/],
    [{ ...goodManifest(), servers: [{ id: 'dup', transport: 'stdio', command: 'a' }, { id: 'dup', transport: 'stdio', command: 'b' }] }, /bị trùng/],
    [{ ...goodManifest(), tools: ['a', 'a'] }, /không được trùng/],
    [{ ...goodManifest(), permissions: ['root'] }, /permissions/],
    [{ ...goodManifest(), configSchema: { bad: { type: 'date' } } }, /type/],
    [{ ...goodManifest(), config: { rootDir: 123 }, configSchema: { rootDir: { type: 'string', required: true } } }, /phải là string/],
  ];
  for (const [manifest, re] of cases) {
    const result = v19ValidateManifest(manifest);
    assert.equal(result.ok, false, JSON.stringify(manifest).slice(0, 120));
    assert.match(result.errors.join(' '), re);
  }
  assert.throws(() => v19LoadPlugin({ ...goodManifest(), name: 'Bad!' }), /Không load được plugin/);
  assert.deepEqual(v19ValidateMcpServer(null, 0), ['servers[0] phải là object.']);
  assert.deepEqual(v19ValidateConfigAgainstSchema({ a: 'x' }, { a: { type: 'number', required: true } }), ['Config "a" phải là number (nhận string).']);
  assert.deepEqual(v19ValidateConfigAgainstSchema({}, { a: { type: 'string', required: true } }), ['Thiếu config bắt buộc "a".']);
  assert.deepEqual(v19ValidateConfigAgainstSchema({ strange: 1 }, { a: { type: 'string' } }), ['Config "strange" không có trong configSchema (key lạ — kiểm tra lại tên).']);
});

test('v19 plugin: load/unload/bật-tắt server, state giữ manifest + config', () => {
  const state = v19LoadPlugin(goodManifest(), NOW);
  assert.equal(state.loaded, true);
  assert.deepEqual(state.enabledServers, ['fs', 'fs-http']);
  assert.equal(state.configVersion, 1);
  assert.equal(state.appliedConfig.rootDir, '/tmp/ws');
  assert.equal(state.loadedAt, NOW);
  const disabled = v19SetServerEnabled(state, 'fs-http', false);
  assert.deepEqual(disabled.enabledServers, ['fs']);
  assert.equal(state.enabledServers.length, 2); // state cũ không bị sửa
  const reEnabled = v19SetServerEnabled(disabled, 'fs-http', true);
  assert.deepEqual(reEnabled.enabledServers.sort(), ['fs', 'fs-http']);
  assert.throws(() => v19SetServerEnabled(state, 'nope', true), /không có server/);
  const unloaded = v19UnloadPlugin(state);
  assert.equal(unloaded.loaded, false);
  assert.deepEqual(unloaded.enabledServers, []);
  assert.throws(() => v19UnloadPlugin(unloaded), /chưa load/);
  assert.throws(() => v19SetServerEnabled(unloaded, 'fs', true), /chưa load/);
  const normalized = v19NormalizeManifest({ name: 'x', version: '1', servers: [{ id: 's', transport: 'stdio', command: 'node' }] });
  assert.equal(normalized.category, 'other');
  assert.deepEqual(normalized.permissions, ['read']);
  assert.deepEqual(normalized.tools, []);
});

test('v19 plugin config: validate trước khi áp — sai thì giữ config cũ', () => {
  const state = v19LoadPlugin(goodManifest(), NOW);
  // Merge đúng: chỉ đổi maxDepth, rootDir giữ nguyên, version tăng.
  const { state: next, result } = v19ApplyPluginConfig(state, {
    pluginName: 'filesystem',
    config: { maxDepth: 9 },
  });
  assert.equal(result.applied, true);
  assert.equal(result.configVersion, 2);
  assert.equal(next.appliedConfig.maxDepth, 9);
  assert.equal(next.appliedConfig.rootDir, '/tmp/ws');
  assert.equal(state.configVersion, 1); // state cũ không bị sửa
  // Sai type: không áp, state trả về chính là state cũ.
  const bad = v19ApplyPluginConfig(state, { pluginName: 'filesystem', config: { maxDepth: 'deep' } });
  assert.equal(bad.result.applied, false);
  assert.match(bad.result.errors.join(' '), /maxDepth.*phải là number/);
  assert.equal(bad.state, state);
  // Thiếu required khi replace toàn bộ: không áp.
  const missing = v19ApplyPluginConfig(state, { pluginName: 'filesystem', config: {}, replace: true });
  assert.equal(missing.result.applied, false);
  assert.match(missing.result.errors.join(' '), /Thiếu config bắt buộc "rootDir"/);
  // Replace đúng: thay hẳn config.
  const replaced = v19ApplyPluginConfig(state, {
    pluginName: 'filesystem',
    config: { rootDir: '/new', maxDepth: 2 },
    replace: true,
    enabledServers: ['fs'],
  });
  assert.equal(replaced.result.applied, true);
  assert.deepEqual(replaced.result.enabledServers, ['fs']);
  assert.equal(replaced.state.appliedConfig.apiKey, undefined);
  // Server không tồn tại: không áp.
  const badServer = v19ApplyPluginConfig(state, {
    pluginName: 'filesystem',
    config: { maxDepth: 3 },
    enabledServers: ['ghost'],
  });
  assert.equal(badServer.result.applied, false);
  assert.match(badServer.result.errors.join(' '), /Không có server: ghost/);
  // Plugin chưa load: không áp.
  const unloaded = v19UnloadPlugin(state);
  const notLoaded = v19ApplyPluginConfig(unloaded, { pluginName: 'filesystem', config: { maxDepth: 1 } });
  assert.equal(notLoaded.result.applied, false);
  assert.match(notLoaded.result.errors.join(' '), /chưa load/);
  assert.throws(
    () => v19ApplyPluginConfig(state, { pluginName: 'other', config: {} }),
    /Config change cho plugin "other"/,
  );
});

test('v19 plugin: secret luôn bị che khi render/list config', () => {
  assert.equal(v19IsSecretKey('apiKey'), true);
  assert.equal(v19IsSecretKey('API_TOKEN'), true);
  assert.equal(v19IsSecretKey('password'), true);
  assert.equal(v19IsSecretKey('rootDir'), false);
  assert.equal(v19RedactSecret('sk-secret-123456'), 'sk****56');
  assert.equal(v19RedactSecret('ab'), '****');
  const redacted = v19RedactedConfig({ apiKey: 'sk-secret-123456', rootDir: '/tmp', token: 'tok-abcdef' });
  assert.equal(redacted.rootDir, '/tmp');
  assert.notEqual(redacted.apiKey, 'sk-secret-123456');
  assert.match(String(redacted.apiKey), /sk\*\*\*\*56/);
  assert.match(String(redacted.token), /\*\*\*\*/);
  const rendered = renderV19PluginState(v19LoadPlugin(goodManifest(), NOW));
  assert.match(rendered, /filesystem v1\.2\.0/);
  assert.match(rendered, /server fs \(stdio\): node/);
  assert.doesNotMatch(rendered, /sk-secret-123456/);
});

test('v19 marketplace: list gộp installed + catalog, search theo tên/mô tả/nhóm', () => {
  assert.ok(V19_PLUGIN_CATALOG.length >= 6);
  const installed = [v19LoadPlugin(goodManifest(), NOW)];
  const entries = v19MarketplaceList(installed, true);
  assert.ok(entries.length >= V19_PLUGIN_CATALOG.length);
  const fsEntry = entries.find((e) => e.name === 'filesystem');
  assert.equal(fsEntry.source, 'installed');
  assert.equal(fsEntry.loaded, true);
  assert.equal(fsEntry.enabledServers, 2);
  assert.equal(fsEntry.totalServers, 2);
  // Catalog-only entry vẫn có mặt khi chưa cài.
  assert.equal(entries.find((e) => e.name === 'git-helper').source, 'catalog');
  // Search: tên, mô tả, tool, nhóm.
  assert.equal(v19MarketplaceSearch(entries, 'git').length, 1);
  assert.equal(v19MarketplaceSearch(entries, 'workspace').length >= 2, true);
  assert.equal(v19MarketplaceSearch(entries, '', 'testing').every((e) => e.category === 'testing'), true);
  assert.equal(v19MarketplaceSearch(entries, 'zzz-no-match').length, 0);
  // Không include catalog: chỉ còn installed.
  assert.deepEqual(v19MarketplaceList(installed, false).map((e) => e.name), ['filesystem']);
  assert.match(renderV19Marketplace(entries), /filesystem v1\.2\.0 \[filesystem\] \(installed/);
  assert.equal(renderV19Marketplace([]), '(không có plugin nào khớp)');
});

test('v19 presets: 5 builtin, apply resolve snapshot + báo plugin thiếu', () => {
  const builtin = v19BuiltinPresets(NOW);
  assert.equal(builtin.length, 5);
  assert.deepEqual(builtin.map((p) => p.id), ['general', 'reviewer', 'refactorer', 'test-writer', 'docs']);
  assert.ok(builtin.every((p) => p.builtin === true));
  assert.equal(v19BuiltinPresetById('reviewer', NOW).name, 'Code reviewer');
  assert.equal(v19BuiltinPresetById('nope', NOW), undefined);
  const reviewer = v19BuiltinPresetById('reviewer', NOW);
  const applied = v19ApplyPreset(reviewer, ['filesystem']);
  assert.equal(applied.presetId, 'reviewer');
  assert.deepEqual(applied.missingPlugins, ['code-search', 'git-helper']);
  assert.ok(applied.systemPrompt.includes('strict code reviewer'));
  assert.equal(applied.maxSteps, 30);
  const appliedFull = v19ApplyPreset(reviewer, ['filesystem', 'code-search', 'git-helper']);
  assert.deepEqual(appliedFull.missingPlugins, []);
  assert.match(renderV19PresetApplyResult(applied), /plugin chưa cài/);
  assert.match(renderV19Preset(reviewer), /Preset reviewer \[builtin\]/);
  assert.match(renderV19PresetList(builtin), /general \[builtin\]/);
  // Allowlist: rỗng = cho tất cả; reviewer chỉ cho 3 tool.
  assert.equal(v19IsToolAllowed([], 'anything'), true);
  assert.equal(v19IsToolAllowed(reviewer.toolAllowlist, 'coding_v19_workspace'), true);
  assert.equal(v19IsToolAllowed(reviewer.toolAllowlist, 'coding_v19_agent'), false);
  assert.equal(v19PresetIdFromName('My Cool Preset!'), 'my-cool-preset');
  assert.throws(() => v19PresetIdFromName('!!!'), /Không sinh được preset id/);
});

test('v19 presets: custom CRUD + clone, builtin không sửa/xoá trực tiếp', () => {
  const now = NOW;
  let custom = [];
  const created = v19CreatePreset(custom, {
    name: 'My Reviewer',
    systemPrompt: 'Review carefully.',
    pluginIds: ['filesystem'],
    toolAllowlist: ['coding_v19_workspace'],
    maxSteps: 25,
  }, now);
  assert.equal(created.id, 'my-reviewer');
  assert.equal(created.builtin, false);
  custom = [...custom, created];
  assert.throws(
    () => v19CreatePreset(custom, { name: 'My Reviewer', systemPrompt: 'dup' }),
    /Đã có preset "my-reviewer"/,
  );
  assert.throws(
    () => v19CreatePreset(custom, { name: 'Bad', systemPrompt: '' }),
    /systemPrompt không rỗng/,
  );
  assert.deepEqual(v19ValidatePresetInput({ name: 'x', systemPrompt: 'y', maxSteps: 0 }), [
    'Preset maxSteps phải là số nguyên 1..500.',
  ]);
  // Update custom ok; builtin thì chặn.
  custom = v19UpdatePreset(custom, 'my-reviewer', { name: 'My Reviewer', systemPrompt: 'Review very carefully.', maxSteps: 30 });
  assert.equal(custom[0].systemPrompt, 'Review very carefully.');
  assert.equal(custom[0].maxSteps, 30);
  assert.throws(
    () => v19UpdatePreset(v19BuiltinPresets(now), 'general', { name: 'General', systemPrompt: 'x' }),
    /là builtin/,
  );
  assert.throws(() => v19DeletePreset(v19BuiltinPresets(now), 'general'), /là builtin/);
  assert.throws(() => v19UpdatePreset(custom, 'ghost', { name: 'G', systemPrompt: 'x' }), /Không có preset/);
  // Clone builtin thành custom.
  const cloned = v19ClonePreset(v19AllPresets(custom, now), 'general', 'my-general', 'My General', now);
  assert.equal(cloned.builtin, false);
  assert.equal(cloned.systemPrompt, v19BuiltinPresetById('general', now).systemPrompt);
  custom = [...custom, cloned];
  assert.throws(
    () => v19ClonePreset(v19AllPresets(custom, now), 'general', 'my-general', 'Dup'),
    /Đã có preset "my-general"/,
  );
  // All = builtin trước + custom sau; find ưu tiên custom.
  const all = v19AllPresets(custom, now);
  assert.equal(all.length, 7);
  assert.equal(all[0].builtin, true);
  assert.equal(v19FindPreset(custom, 'my-reviewer', now).id, 'my-reviewer');
  assert.equal(v19FindPreset(custom, 'docs', now).builtin, true);
  assert.equal(v19FindPreset(custom, 'ghost', now), undefined);
  // Delete custom ok.
  custom = v19DeletePreset(custom, 'my-reviewer');
  assert.equal(custom.some((p) => p.id === 'my-reviewer'), false);
  assert.throws(() => v19DeletePreset(custom, 'my-reviewer'), /Không có preset/);
});

test('v19 plugin template: scaffold theo nhóm, manifest validate ok', () => {
  for (const category of ['filesystem', 'git', 'search', 'database', 'browser', 'testing', 'other']) {
    const manifest = v19PluginManifestTemplate(category, `tpl-${category}`);
    assert.equal(manifest.category, category);
    assert.equal(manifest.version, '0.1.0');
    assert.ok(manifest.servers.length >= 1);
    assert.equal(v19ValidateManifest(manifest).ok, true);
  }
  assert.equal(v19PluginManifestTemplate('filesystem').name, 'my-plugin');
  assert.throws(() => v19PluginManifestTemplate('nope'), /category phải là một trong/);
  assert.throws(() => v19PluginManifestTemplate('filesystem', 'Bad Name'), /không hợp lệ/);
});

test('v19 preset JSON: export/import round-trip, import luôn thành custom', () => {
  const preset = v19CreatePreset([], {
    name: 'Json Preset',
    systemPrompt: 'Do JSON things.',
    pluginIds: ['filesystem'],
    maxSteps: 15,
  }, NOW);
  const json = v19PresetToJson(preset);
  const imported = v19PresetFromJson(json);
  assert.equal(imported.id, preset.id);
  assert.equal(imported.name, 'Json Preset');
  assert.equal(imported.builtin, false);
  assert.deepEqual(imported.pluginIds, ['filesystem']);
  // Import preset builtin (trong JSON) vẫn thành custom.
  const builtinJson = v19PresetToJson({ ...v19BuiltinPresetById('general', NOW), builtin: true });
  assert.equal(v19PresetFromJson(builtinJson).builtin, false);
  assert.throws(() => v19PresetFromJson('nope'), /không phải JSON/);
  assert.throws(() => v19PresetFromJson(JSON.stringify({ name: 'x' })), /Preset JSON không hợp lệ/);
});
