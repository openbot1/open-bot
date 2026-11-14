/**
 * Test v1.04 T2: deprecation migration guide (node:test).
 * Local only, no network.
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-v104-deprecation-migration.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  allMigrationGuides,
  buildDeprecationMigrationMarkdown,
  buildDeprecationReport,
  describeDeprecationReport,
  migrationGuideFor,
  replacementModuleFor,
  DEPRECATION_MIGRATION_GUIDES,
} from '../packages/core/dist/mcp/deprecationMigration.js';
import { DEPRECATED_MCP_METHODS } from '../packages/core/dist/mcp/deprecation.js';
import { DeprecationShim } from '../packages/core/dist/mcp/deprecation.js';

test('every deprecated method has a migration guide', () => {
  assert.ok(DEPRECATION_MIGRATION_GUIDES.length >= 6);
  for (const meta of DEPRECATED_MCP_METHODS) {
    const guide = migrationGuideFor(meta.method);
    assert.ok(guide, `missing guide for ${meta.method}`);
    assert.equal(guide.method, meta.method);
    assert.equal(guide.removeAfter, '2027-07-28');
    assert.ok(guide.steps.length >= 2, `${meta.method} needs at least 2 steps`);
    assert.ok(guide.replacement.length > 0);
    assert.ok(['nhỏ', 'trung bình', 'lớn'].includes(guide.effort));
    assert.ok(replacementModuleFor(meta.method), `no replacement module for ${meta.method}`);
  }
  assert.equal(migrationGuideFor('tools/call'), null);
  assert.equal(allMigrationGuides().length, DEPRECATION_MIGRATION_GUIDES.length);
});

test('sampling guide points at MRTR needs_sampling; elicitation at needs_elicitation', () => {
  const sampling = migrationGuideFor('sampling/createMessage');
  assert.match(sampling.steps.map((s) => s.detail).join(' '), /needs_sampling/);
  const elicitation = migrationGuideFor('elicitation/create');
  assert.match(elicitation.steps.map((s) => s.detail).join(' '), /needs_elicitation/);
  assert.match(elicitation.steps.map((s) => s.detail).join(' '), /mrtrClient/);
  const roots = migrationGuideFor('roots/list');
  assert.match(roots.steps.map((s) => s.detail).join(' '), /needs_roots/);
  const logging = migrationGuideFor('notifications/message');
  assert.match(logging.steps.map((s) => s.detail).join(' '), /notifications\/progress/);
});

test('buildDeprecationReport summarizes shim notices, most-called first', () => {
  const shim = new DeprecationShim({});
  shim.record('sampling/createMessage');
  shim.record('sampling/createMessage');
  shim.record('roots/list');
  shim.record('sampling/createMessage');
  const report = buildDeprecationReport(shim.getNotices());
  assert.equal(report.totalCalls, 4);
  assert.equal(report.methodsInUse, 2);
  assert.equal(report.removeAfter, '2027-07-28');
  assert.equal(report.rows[0].method, 'sampling/createMessage');
  assert.equal(report.rows[0].callCount, 3);
  assert.ok(report.rows[0].steps.length >= 2);
  assert.equal(report.rows[1].method, 'roots/list');
  assert.match(describeDeprecationReport(report), /2 method MCP deprecated/);
  assert.match(describeDeprecationReport(report), /4 lần gọi/);

  const empty = buildDeprecationReport([]);
  assert.equal(empty.methodsInUse, 0);
  assert.equal(empty.totalCalls, 0);
  assert.match(describeDeprecationReport(empty), /Không có method/);
});

test('markdown guide covers every method and the removal date', () => {
  const md = buildDeprecationMigrationMarkdown();
  assert.match(md, /MCP 2\.0 — Migration guide/);
  assert.match(md, /2027-07-28/);
  for (const meta of DEPRECATED_MCP_METHODS) {
    assert.ok(md.includes(`\`${meta.method}\``), `markdown missing ${meta.method}`);
  }
  assert.match(md, /deprecationMigration\.ts/);
});
