/**
 * Tests for memory v21 — OKF-style format (v1.29, Doi T1).
 * packages/core/src/memory/v21/okfFormat.ts
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v21-okf-format-v129.test.mjs
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  hashRecordV21,
  isIsoDateV21,
  isRecordStaleV21,
  okfFilenameV21,
  parseOkfBundleV21,
  parseOkfDocumentV21,
  parseOkfFileV21,
  parseYamlSubsetV21,
  recordToOkfV21,
  serializeYamlSubsetV21,
  slugifyV21,
  validateOkfFrontmatterV21,
} from '../packages/core/dist/memory/v21/index.js';

const SAMPLE_OKF = `---
type: fact
title: User thich ca phe
tags: [ca-phe, so-thich]
sources:
- chat:session-1
- https://example.com/ca-phe
verified:
  by: user
  at: 1794000000000
  note: user xac nhan
stale_after: 2027-01-01
code_refs: [packages/core/src/memory/v21/types.ts]
---

User uong ca phe den moi sang, khong duong.
`;

function sampleRecord() {
  return {
    id: 'user-thich-ca-phe',
    type: 'fact',
    title: 'User thich ca phe',
    body: 'User uong ca phe den moi sang, khong duong.',
    tags: ['ca-phe', 'so-thich'],
    sources: ['chat:session-1'],
    verified: { by: 'user', at: 1794000000000, note: 'user xac nhan' },
    staleAfter: '2027-01-01',
    codeRefs: ['packages/core/src/memory/v21/types.ts'],
    version: 1,
    createdAt: 1794000000000,
    updatedAt: 1794000000000,
  };
}

test('v21 okf: parse full frontmatter (type/sources/verified/stale_after/code_refs)', () => {
  const parsed = parseOkfDocumentV21(SAMPLE_OKF, 'ca-phe.md');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.frontmatter.type, 'fact');
  assert.equal(parsed.data.frontmatter.title, 'User thich ca phe');
  assert.deepEqual(parsed.data.frontmatter.tags, ['ca-phe', 'so-thich']);
  assert.deepEqual(parsed.data.frontmatter.sources, ['chat:session-1', 'https://example.com/ca-phe']);
  assert.equal(parsed.data.frontmatter.verified.by, 'user');
  assert.equal(parsed.data.frontmatter.verified.at, 1794000000000);
  assert.equal(parsed.data.frontmatter.stale_after, '2027-01-01');
  assert.deepEqual(parsed.data.frontmatter.code_refs, ['packages/core/src/memory/v21/types.ts']);
  assert.match(parsed.data.body, /ca phe den/);
  assert.equal(parsed.data.issues.length, 0);
});

test('v21 okf: round-trip serialize -> parse keeps every field', () => {
  const record = sampleRecord();
  const text = recordToOkfV21(record);
  assert.match(text, /^---\ntype: fact\n/);
  const reparsed = parseOkfFileV21(text, 'user-thich-ca-phe.md');
  assert.equal(reparsed.ok, true);
  assert.equal(reparsed.data.type, 'fact');
  assert.equal(reparsed.data.title, 'User thich ca phe');
  assert.deepEqual(reparsed.data.tags, ['ca-phe', 'so-thich']);
  assert.deepEqual(reparsed.data.sources, ['chat:session-1']);
  assert.equal(reparsed.data.verified.by, 'user');
  assert.equal(reparsed.data.staleAfter, '2027-01-01');
  assert.deepEqual(reparsed.data.codeRefs, ['packages/core/src/memory/v21/types.ts']);
  assert.equal(reparsed.data.body, record.body);
  assert.equal(reparsed.data.originFormat, 'okf');
});

test('v21 okf: missing type is an error, unknown type is an error', () => {
  const noType = parseOkfDocumentV21('---\ntitle: Khong co type\n---\n\nBody.\n', 'a.md');
  assert.equal(noType.ok, false);
  assert.match(noType.error, /type/);
  const badType = parseOkfDocumentV21('---\ntype: alien\n---\n\nBody.\n', 'b.md');
  assert.equal(badType.ok, false);
  assert.match(badType.error, /alien/);
});

test('v21 okf: bad stale_after, bad verified shape, unknown field warning', () => {
  const badDate = parseOkfDocumentV21('---\ntype: fact\nstale_after: 2027-13-40\n---\n\nBody.\n', 'c.md');
  assert.equal(badDate.ok, false);
  assert.match(badDate.error, /stale_after/);
  const badVerified = parseOkfDocumentV21('---\ntype: fact\nverified:\n  at: 123\n---\n\nBody.\n', 'd.md');
  assert.equal(badVerified.ok, false);
  assert.match(badVerified.error, /verified\.by/);
  const unknown = parseOkfDocumentV21('---\ntype: fact\nweird_field: 1\n---\n\nBody.\n', 'e.md');
  assert.equal(unknown.ok, true);
  assert.equal(unknown.data.issues[0].code, 'unknown_field');
  assert.equal(unknown.data.issues[0].severity, 'warning');
  // Field la van duoc giu de round-trip.
  assert.equal(unknown.data.frontmatter.weird_field, 1);
});

test('v21 okf: missing frontmatter / unclosed frontmatter errors', () => {
  const noFm = parseOkfDocumentV21('Khong co frontmatter.\n', 'f.md');
  assert.equal(noFm.ok, false);
  assert.equal(noFm.errorCode, 'missing_frontmatter');
  const unclosed = parseOkfDocumentV21('---\ntype: fact\n\nBody khong co dong dong.\n', 'g.md');
  assert.equal(unclosed.ok, false);
});

test('v21 okf: yaml subset — inline list, block list, nested map, quotes, scalars', () => {
  const parsed = parseYamlSubsetV21([
    'type: fact',
    'title: "Tieu de: co dau hai cham"',
    "tags: ['a', \"b c\", d]",
    'count: 42',
    'flag: true',
    'nothing: null',
    'sources:',
    '- chat:session-1',
    '- https://example.com/x',
    'verified:',
    '  by: user',
    '  at: 1794000000000',
  ]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.title, 'Tieu de: co dau hai cham');
  assert.deepEqual(parsed.data.tags, ['a', 'b c', 'd']);
  assert.equal(parsed.data.count, 42);
  assert.equal(parsed.data.flag, true);
  assert.equal(parsed.data.nothing, null);
  assert.deepEqual(parsed.data.sources, ['chat:session-1', 'https://example.com/x']);
  assert.deepEqual(parsed.data.verified, { by: 'user', at: 1794000000000 });
  const serialized = serializeYamlSubsetV21({ type: 'fact', tags: ['a', 'b'], verified: { by: 'u', at: 5 } });
  assert.match(serialized, /tags:\n- a\n- b/);
  assert.match(serialized, /verified:\n  by: u\n  at: 5/);
});

test('v21 okf: yaml subset rejects block scalar and bad indent with clear errors', () => {
  const blockScalar = parseYamlSubsetV21(['type: fact', 'body: |', '  dong 1']);
  assert.equal(blockScalar.ok, false);
  assert.equal(blockScalar.errorCode, 'yaml_error');
  const badIndent = parseYamlSubsetV21(['type: fact', '  title: lech']);
  assert.equal(badIndent.ok, false);
  assert.match(blockScalar.error, /block scalar/);
});

test('v21 okf: validateOkfFrontmatterV21 — code_refs with .. warns, verified string ok', () => {
  const checked = validateOkfFrontmatterV21({
    type: 'decision',
    verified: 'user',
    code_refs: ['../etc/passwd', 'packages/core/src/x.ts'],
  });
  assert.equal(checked.frontmatter.verified.by, 'user');
  const warn = checked.issues.find((i) => i.code === 'bad_code_ref');
  assert.ok(warn, 'code_ref chua .. phai canh bao');
  assert.equal(warn.severity, 'warning');
});

test('v21 okf: parseOkfBundleV21 — duplicate id fails, warnings collected', () => {
  const { records, failed, warnings } = parseOkfBundleV21([
    { path: 'a.md', content: SAMPLE_OKF },
    { path: 'dir1/same.md', content: SAMPLE_OKF },
    { path: 'dir2/same.md', content: SAMPLE_OKF },
    { path: 'c.md', content: '---\ntitle: thieu type\n---\n\nBody.\n' },
    { path: 'd.md', content: '---\ntype: note\nweird: 1\n---\n\nGhi chu.\n' },
  ]);
  assert.equal(records.length, 3);
  assert.equal(failed.length, 2);
  assert.match(failed[0].error, /trung id/);
  assert.match(failed[1].error, /type/);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'unknown_field');
});

test('v21 okf: helpers — slugify, isIsoDate, isRecordStale, filename, hash', () => {
  assert.equal(slugifyV21('User Thích Cà Phê!'), 'user-thich-ca-phe');
  assert.equal(slugifyV21('  '), 'record');
  assert.equal(isIsoDateV21('2027-02-29'), false);
  assert.equal(isIsoDateV21('2028-02-29'), true);
  assert.equal(isIsoDateV21('2027-13-01'), false);
  assert.equal(isIsoDateV21('01/02/2027'), false);
  const stale = { ...sampleRecord(), staleAfter: '2020-01-01' };
  assert.equal(isRecordStaleV21(stale, new Date('2026-11-17T00:00:00Z')), true);
  assert.equal(isRecordStaleV21(sampleRecord(), new Date('2026-11-17T00:00:00Z')), false);
  assert.equal(okfFilenameV21(sampleRecord()), 'user-thich-ca-phe.md');
  const h1 = hashRecordV21(sampleRecord());
  const h2 = hashRecordV21({ ...sampleRecord(), body: 'Noi dung khac.' });
  assert.equal(h1.length, 64);
  assert.notEqual(h1, h2);
  assert.equal(hashRecordV21(sampleRecord()), h1);
});
