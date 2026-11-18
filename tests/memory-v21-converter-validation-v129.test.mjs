/**
 * Tests for memory v21 — converter + validation (v1.29, Doi T1).
 * packages/core/src/memory/v21/{converter,validation}.ts
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v21-converter-validation-v129.test.mjs
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  conversionFooterV21,
  convertBundleV21,
  convertRecordV21,
  detectFormatV21,
  formatValidationIssuesV21,
  isSupportedFormatV21,
  validateOkfTextV21,
  validatePortableRecordV21,
  validateRecordBundleV21,
} from '../packages/core/dist/memory/v21/index.js';

const OKF_FACT = `---
type: fact
title: User thich ca phe
tags: [ca-phe]
sources: [chat:session-1]
verified:
  by: user
  at: 1794000000000
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
    tags: ['ca-phe'],
    sources: ['chat:session-1'],
    verified: { by: 'user', at: 1794000000000 },
    staleAfter: '2027-01-01',
    codeRefs: ['packages/core/src/memory/v21/types.ts'],
    version: 1,
    createdAt: 1794000000000,
    updatedAt: 1794000000000,
    originFormat: 'okf',
  };
}

test('v21 converter: okf -> openhands drops fields into footer + report', () => {
  const out = convertBundleV21(
    { format: 'okf', files: [{ path: 'user-thich-ca-phe.md', content: OKF_FACT }] },
    'openhands',
  );
  assert.equal(out.files.length, 1);
  assert.equal(out.files[0].path, 'MEMORY.md');
  assert.match(out.files[0].content, /^# Memory\n/);
  assert.match(out.files[0].content, /## User thich ca phe/);
  assert.match(out.files[0].content, /<!-- type: fact \| tags: ca-phe -->/);
  // Field khong co cho o OpenHands thi xuong footer, khong mat han.
  assert.match(out.files[0].content, /portable-meta:.*code_refs: packages\/core\/src\/memory\/v21\/types\.ts/);
  assert.match(out.files[0].content, /verified: user @/);
  assert.match(out.files[0].content, /stale_after: 2027-01-01/);
  assert.equal(out.report.recordsConverted, 1);
  assert.ok(out.report.fieldsDropped.includes('code_refs'));
  assert.ok(out.report.fieldsDropped.includes('verified'));
  assert.ok(out.report.fieldsDropped.includes('stale_after'));
  assert.equal(out.failed.length, 0);
});

test('v21 converter: okf -> memfs keeps body + hash header; strict fails on loss', () => {
  const out = convertBundleV21(
    { format: 'okf', files: [{ path: 'user-thich-ca-phe.md', content: OKF_FACT }] },
    'memfs',
  );
  assert.equal(out.files.length, 1);
  assert.equal(out.files[0].path, 'blocks/user-thich-ca-phe.md');
  assert.match(out.files[0].content, /^<!-- memfs:id=user-thich-ca-phe version=1 hash=[0-9a-f]{64} /);
  assert.match(out.files[0].content, /User uong ca phe den/);
  assert.ok(out.report.fieldsDropped.includes('type'));
  const strict = convertBundleV21(
    { format: 'okf', files: [{ path: 'user-thich-ca-phe.md', content: OKF_FACT }] },
    'memfs',
    { strict: true },
  );
  assert.equal(strict.files.length, 0);
  assert.equal(strict.failed.length, 1);
  assert.match(strict.failed[0].error, /strict mode/);
  // Record don le: convertRecordV21 cung ton trong strict.
  const single = convertRecordV21(sampleRecord(), 'memfs', { strict: true });
  assert.equal(single.ok, false);
  assert.equal(single.errorCode, 'conversion_loss');
  const singleOk = convertRecordV21(sampleRecord(), 'okf');
  assert.equal(singleOk.ok, true);
  assert.deepEqual(singleOk.data.report.fieldsDropped, []);
});

test('v21 converter: round-trip okf -> memfs -> okf preserves body', async () => {
  const { hashContentV21 } = await import('../packages/core/dist/memory/v21/index.js');
  const body = 'Noi dung block goc.';
  const memfsText = `<!-- memfs:id=my-note version=2 hash=${hashContentV21(body)} updatedAt=1794000000000 -->\n\n${body}\n`;
  const toOkf = convertBundleV21({ format: 'memfs', files: [{ path: 'blocks/my-note.md', content: memfsText }] }, 'okf');
  assert.equal(toOkf.report.recordsConverted, 1);
  assert.match(toOkf.files[0].content, /^---\ntype: note\n/);
  assert.match(toOkf.files[0].content, /Noi dung block goc\./);
  assert.ok(toOkf.report.warnings.some((w) => w.includes('type=note')));
  // OpenHands -> OKF: meta type duoc giu.
  const curated = '# Memory\n\n## Quyet dinh\n<!-- type: decision | tags: kien-truc -->\n\nDung Ollama local.\n';
  const fromOh = convertBundleV21({ format: 'openhands', files: [{ path: 'MEMORY.md', content: curated }] }, 'okf');
  assert.equal(fromOh.report.recordsConverted, 1);
  assert.match(fromOh.files[0].content, /type: decision/);
  assert.match(fromOh.files[0].content, /Dung Ollama local\./);
});

test('v21 converter: detectFormatV21 sniffs okf/memfs/openhands/plain', () => {
  assert.equal(detectFormatV21(OKF_FACT, 'a.md'), 'okf');
  assert.equal(detectFormatV21('<!-- memfs:id=x version=1 hash=' + 'b'.repeat(64) + ' updatedAt=1 -->\n\nBody.\n', 'blocks/x.md'), 'memfs');
  assert.equal(detectFormatV21('# Memory\n\n## Tieu de\n\nBody.\n', 'MEMORY.md'), 'openhands');
  assert.equal(detectFormatV21('# 2026-11-17\n\n### 09:00 — Hop\n\nBody.\n', '2026-11-17.md'), 'openhands');
  assert.equal(detectFormatV21('Chi la van ban thuong.\n', 'plain.md'), null);
  assert.equal(isSupportedFormatV21('okf'), true);
  assert.equal(isSupportedFormatV21('zip'), false);
});

test('v21 converter: conversionFooterV21 lists metadata that would be lost', () => {
  const footer = conversionFooterV21(sampleRecord());
  assert.match(footer, /type goc: fact/);
  assert.match(footer, /sources: chat:session-1/);
  assert.match(footer, /verified: user @/);
  assert.match(footer, /stale_after: 2027-01-01/);
  assert.match(footer, /code_refs: packages\/core\/src\/memory\/v21\/types\.ts/);
  const plain = conversionFooterV21({ ...sampleRecord(), type: 'note', sources: [], verified: undefined, staleAfter: undefined, codeRefs: [] });
  assert.equal(plain, '');
});

test('v21 validation: record validation catches every bad field with path+code', () => {
  const missing = validatePortableRecordV21({ id: 'x', title: 'T', body: 'B' });
  assert.equal(missing.ok, false);
  assert.ok(missing.issues.some((i) => i.code === 'missing_type' && i.path === 'record.type'));
  const bad = validatePortableRecordV21({
    id: 'Bad ID!',
    type: 'alien',
    title: '',
    body: '',
    staleAfter: '32/13/2027',
    codeRefs: ['../etc/passwd'],
    version: 0,
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.some((i) => i.code === 'unknown_type'));
  assert.ok(bad.issues.some((i) => i.code === 'empty_title'));
  assert.ok(bad.issues.some((i) => i.code === 'empty_body'));
  assert.ok(bad.issues.some((i) => i.code === 'bad_stale_after'));
  assert.ok(bad.issues.some((i) => i.code === 'bad_version'));
  const staleWarn = validatePortableRecordV21({ ...sampleRecord(), staleAfter: '2020-01-01' });
  assert.equal(staleWarn.ok, true);
  assert.ok(staleWarn.issues.some((i) => i.code === 'stale_record' && i.severity === 'warning'));
  const good = validatePortableRecordV21(sampleRecord());
  assert.equal(good.ok, true);
  assert.equal(good.issues.length, 0);
});

test('v21 validation: bundle duplicate ids + okf text errors + readable report', () => {
  const bundle = validateRecordBundleV21([sampleRecord(), sampleRecord()]);
  assert.equal(bundle.ok, false);
  assert.ok(bundle.issues.some((i) => i.code === 'duplicate_id' && i.path === 'records[1].id'));
  const textBad = validateOkfTextV21('Khong co frontmatter.\n');
  assert.equal(textBad.ok, false);
  assert.equal(textBad.errorCount, 1);
  assert.equal(textBad.issues[0].code, 'yaml_error');
  const textEmptyBody = validateOkfTextV21('---\ntype: note\n---\n\n');
  assert.equal(textEmptyBody.ok, false);
  assert.ok(textEmptyBody.issues.some((i) => i.code === 'empty_body'));
  const report = formatValidationIssuesV21(bundle);
  assert.match(report, /1 loi, 0 canh bao/);
  assert.match(report, /\[LOI\] records\[1\]\.id \(duplicate_id\)/);
  assert.equal(formatValidationIssuesV21({ ok: true, issues: [], errorCount: 0, warningCount: 0 }), 'Hop le: khong co loi hay canh bao.');
});
