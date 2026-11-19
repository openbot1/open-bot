/**
 * Tests for v1.39 (Team T2) — protocols v8 Skills over MCP:
 * packages/core/src/protocolsV8/skillsOverMcpV8.ts
 *
 * Covers:
 *  - pack validation (name format, semver, description cap,
 *    body size cap, asset path safety, script names)
 *  - progressive disclosure: metadata is cheap (no body),
 *    body + assets fetched on demand only
 *  - skill:// URI resolution (metadata / body / asset tiers,
 *    invalid URIs rejected)
 *  - registry: register / list / search / read / unregister /
 *    resource URIs / registry cap
 *  - publisher: listResources + readResource over the registry
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v8-skills.test.mjs
 *
 * No network, no model, no disk.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  McpV8SkillPackPublisher,
  McpV8SkillPackRegistry,
  mcpV8SkillAssetUri,
  mcpV8SkillBodyUri,
  mcpV8SkillMetadata,
  mcpV8SkillMetadataUri,
  resolveMcpV8SkillUri,
  validateMcpV8SkillAssetPath,
  validateMcpV8SkillPack,
} from '../packages/core/dist/index.js';

function goodPack(overrides = {}) {
  return {
    name: 'summarize-doc',
    version: '1.2.0',
    description: 'Summarize a document into three bullets.',
    body: '# summarize-doc\n\nRead the document and return three bullets.',
    allowedTools: ['read-file'],
    argumentHint: 'path to the document',
    scripts: [{ name: 'check.sh', content: '#!/bin/sh\necho ok\n', language: 'bash' }],
    assets: [{ path: 'templates/bullets.md', content: '- {{one}}\n- {{two}}\n- {{three}}\n', mimeType: 'text/markdown' }],
    ...overrides,
  };
}

test('pack validation: happy path + every structural problem', () => {
  assert.deepEqual(validateMcpV8SkillPack(goodPack()), []);
  assert.ok(validateMcpV8SkillPack(goodPack({ name: 'Bad_Name' })).some((p) => p.includes('Skill name')));
  assert.ok(validateMcpV8SkillPack(goodPack({ version: '1.2' })).some((p) => p.includes('semver')));
  assert.ok(validateMcpV8SkillPack(goodPack({ description: '' })).some((p) => p.includes('description')));
  assert.ok(validateMcpV8SkillPack(goodPack({ description: 'x'.repeat(501) })).some((p) => p.includes('max 500')));
  assert.ok(validateMcpV8SkillPack(goodPack({ body: '' })).some((p) => p.includes('SKILL.md body')));
  assert.ok(validateMcpV8SkillPack(goodPack({ body: 'x'.repeat(20 * 1024 + 1) })).some((p) => p.includes('max 20480')));
  assert.ok(validateMcpV8SkillPack(goodPack({ scripts: [{ name: 'sub/run.sh', content: 'x' }] })).some((p) => p.includes('bare file name')));
  assert.ok(validateMcpV8SkillPack(goodPack({ assets: [{ path: '../escape.md', content: 'x', mimeType: 'text/plain' }] })).some((p) => p.includes('escape the pack')));
  assert.ok(validateMcpV8SkillPack(goodPack({ assets: [{ path: '/abs.md', content: 'x', mimeType: 'text/plain' }] })).some((p) => p.includes('relative')));
  assert.deepEqual(validateMcpV8SkillAssetPath('templates/ok.md'), []);
  assert.ok(validateMcpV8SkillAssetPath('a/../b.md').length > 0);
  assert.ok(validateMcpV8SkillAssetPath('a\\b.md').length > 0);
});

test('URI scheme: metadata / body / asset tiers resolve; junk rejected', () => {
  assert.equal(mcpV8SkillMetadataUri('summarize-doc'), 'skill://summarize-doc');
  assert.equal(mcpV8SkillBodyUri('summarize-doc'), 'skill://summarize-doc/SKILL.md');
  assert.equal(mcpV8SkillAssetUri('summarize-doc', 'templates/bullets.md'), 'skill://summarize-doc/assets/templates/bullets.md');
  assert.deepEqual(resolveMcpV8SkillUri('skill://summarize-doc'), { name: 'summarize-doc', tier: 'metadata' });
  assert.deepEqual(resolveMcpV8SkillUri('skill://summarize-doc/SKILL.md'), { name: 'summarize-doc', tier: 'body' });
  assert.deepEqual(
    resolveMcpV8SkillUri('skill://summarize-doc/assets/templates/bullets.md'),
    { name: 'summarize-doc', tier: 'assets', assetPath: 'templates/bullets.md' },
  );
  assert.equal(resolveMcpV8SkillUri('https://example.com/x'), undefined);
  assert.equal(resolveMcpV8SkillUri('skill://Bad_Name'), undefined);
  assert.equal(resolveMcpV8SkillUri('skill://summarize-doc/other.txt'), undefined);
  assert.equal(resolveMcpV8SkillUri('skill://summarize-doc/assets/../escape.md'), undefined);
  assert.equal(resolveMcpV8SkillUri('skill://'), undefined);
});

test('metadata is tier 1: cheap, no body, token estimate + asset/script names only', () => {
  const meta = mcpV8SkillMetadata(goodPack());
  assert.equal(meta.name, 'summarize-doc');
  assert.equal(meta.uri, 'skill://summarize-doc');
  assert.equal(meta.bodyUri, 'skill://summarize-doc/SKILL.md');
  assert.equal(meta.body, undefined);
  assert.ok(meta.approxTokens > 0 && meta.approxTokens < 200);
  assert.deepEqual(meta.assetPaths, ['templates/bullets.md']);
  assert.deepEqual(meta.scriptNames, ['check.sh']);
  assert.deepEqual(meta.allowedTools, ['read-file']);
  assert.equal(meta.argumentHint, 'path to the document');
});

test('registry: register / list / body / asset / read / search / unregister', () => {
  const registry = new McpV8SkillPackRegistry();
  assert.equal(registry.size(), 0);
  const meta = registry.register(goodPack());
  assert.equal(meta.name, 'summarize-doc');
  assert.equal(registry.size(), 1);
  assert.deepEqual(registry.names(), ['summarize-doc']);
  assert.equal(registry.listMetadata().length, 1);
  assert.equal(registry.listMetadata()[0].body, undefined);
  assert.equal(registry.body('summarize-doc'), '# summarize-doc\n\nRead the document and return three bullets.');
  assert.equal(registry.body('missing'), undefined);
  const asset = registry.asset('summarize-doc', 'templates/bullets.md');
  assert.equal(asset?.mimeType, 'text/markdown');
  assert.equal(registry.asset('summarize-doc', 'nope.md'), undefined);
  assert.deepEqual(registry.search('summarize').map((m) => m.name), ['summarize-doc']);
  assert.deepEqual(registry.search('SUMMARIZE').map((m) => m.name), ['summarize-doc']);
  assert.deepEqual(registry.search('zzz'), []);

  // read() per tier.
  const metaRead = registry.read('skill://summarize-doc');
  assert.equal(metaRead.mimeType, 'application/json');
  assert.equal(JSON.parse(metaRead.text).name, 'summarize-doc');
  const bodyRead = registry.read('skill://summarize-doc/SKILL.md');
  assert.equal(bodyRead.mimeType, 'text/markdown');
  assert.match(bodyRead.text, /three bullets/);
  const assetRead = registry.read('skill://summarize-doc/assets/templates/bullets.md');
  assert.equal(assetRead.mimeType, 'text/markdown');
  assert.match(assetRead.text, /\{\{one\}\}/);
  assert.throws(() => registry.read('skill://missing'), /not registered/);
  assert.throws(() => registry.read('skill://summarize-doc/assets/nope.md'), /not part of skill/);
  assert.throws(() => registry.read('https://example.com/x'), /not a valid skill:\/\//);

  // resource URIs cover all three tiers.
  assert.deepEqual(registry.resourceUris(), [
    'skill://summarize-doc',
    'skill://summarize-doc/SKILL.md',
    'skill://summarize-doc/assets/templates/bullets.md',
  ]);

  // Invalid pack refused; get() returns a copy.
  assert.throws(() => registry.register(goodPack({ name: 'Bad' })), /Skill name/);
  const copy = registry.get('summarize-doc');
  copy.description = 'mutated';
  assert.notEqual(registry.get('summarize-doc')?.description, 'mutated');

  assert.equal(registry.unregister('summarize-doc'), true);
  assert.equal(registry.unregister('summarize-doc'), false);
  assert.equal(registry.size(), 0);
});

test('registry cap: refuses past maxPacks, replacing an existing pack is fine', () => {
  const registry = new McpV8SkillPackRegistry({ maxPacks: 1 });
  registry.register(goodPack());
  assert.throws(() => registry.register(goodPack({ name: 'other-skill' })), /registry is full/);
  assert.doesNotThrow(() => registry.register(goodPack({ version: '1.2.1' })));
  assert.equal(registry.get('summarize-doc')?.version, '1.2.1');
});

test('publisher: listResources + readResource over the registry', () => {
  const registry = new McpV8SkillPackRegistry();
  registry.register(goodPack());
  registry.register(goodPack({ name: 'second-skill', description: 'Second.', body: '# second\n' }));
  const publisher = new McpV8SkillPackPublisher(registry);
  const list = publisher.listResources();
  // summarize-doc: metadata + body + 1 asset = 3; second-skill inherits
  // the default asset too (only name/description/body overridden) = 3.
  assert.equal(list.length, 6);
  assert.ok(list.some((r) => r.uri === 'skill://summarize-doc' && r.mimeType === 'application/json'));
  assert.ok(list.some((r) => r.uri === 'skill://summarize-doc/SKILL.md' && r.mimeType === 'text/markdown'));
  const read = publisher.readResource('skill://second-skill/SKILL.md');
  assert.equal(read.contents[0].text, '# second\n');
  assert.throws(() => publisher.readResource('skill://missing'), /not registered/);
});
