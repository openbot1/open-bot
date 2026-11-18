/**
 * Memory v21 — Converter hai chieu giua cac format portable.
 *
 * OKF <-> MemFS <-> OpenHands, tat ca qua `V21PortableRecord`.
 * Nguyen tac: khong bao gio am tham mat field — moi field khong
 * co cho o format dich deu ghi vao `ConversionReport` (ten field
 * + record); che do `strict` se fail ca phep convert khi co mat
 * mat thay vi cho qua.
 *
 * Ma tran mat mat (du kien, ghi ro de user biet):
 *  - OKF -> OpenHands: mat `code_refs`, `verified`, `stale_after`
 *    (ghi vao footer cua body, khong xoa han).
 *  - OKF -> MemFS: mat `type`/`sources`/`verified`/`stale_after`/
 *    `code_refs` (MemFS block chi co id/version/hash/body) — ghi
 *    vao footer cua body, bao cao day du.
 *  - MemFS -> OKF: block khong co `type` -> mac dinh `note`,
 *    bao cao la "type suy dien".
 *  - OpenHands -> OKF: entry khong co meta `type` -> `note`;
 *    daily `time`/`date` dua vao `sources` (`daily:YYYY-MM-DD`).
 *  - OpenHands -> MemFS: mat `type` (ve `note`), mat `time`.
 *  - MemFS -> OpenHands: khong mat gi dang ke (body giu nguyen).
 */
import type {
  V21ConversionReport,
  V21MemfsBlock,
  V21OpenHandsEntry,
  V21PortableFormat,
  V21PortableRecord,
  V21Result,
} from './types';
import { V21_PORTABLE_FORMATS } from './types';
import {
  okfToRecordV21,
  parseOkfDocumentV21,
  recordToOkfV21,
} from './okfFormat';
import {
  memfsBlockToRecordV21,
  parseMemfsBlockHeaderV21,
  recordToMemfsBlockV21,
} from './memfsFormat';
import {
  openhandsEntryToRecordV21,
} from './openhandsFormat';
import { hashContentV21 } from './okfFormat';

export interface V21ConvertOptions {
  /** Fail khi co bat ky field nao bi mat. Mac dinh false. */
  strict?: boolean;
  now?: number;
}

export interface V21ConvertBundleInput {
  format: V21PortableFormat;
  /** Moi file: duong dan + noi dung. */
  files: { path: string; content: string }[];
}

export interface V21ConvertBundleOutput {
  format: V21PortableFormat;
  files: { path: string; content: string }[];
  report: V21ConversionReport;
  failed: { path: string; error: string }[];
}

function emptyReportV21(from: V21PortableFormat, to: V21PortableFormat): V21ConversionReport {
  return { from, to, recordsConverted: 0, recordsSkipped: 0, fieldsDropped: [], warnings: [] };
}

function noteDroppedV21(
  report: V21ConversionReport,
  field: string,
  recordId: string,
): void {
  if (!report.fieldsDropped.includes(field)) report.fieldsDropped.push(field);
  report.warnings.push(`record "${recordId}": mat field "${field}" khi convert ${report.from} -> ${report.to}`);
}

/** Footer them vao body de khong mat thong tin khi sang format hep hon. */
export function conversionFooterV21(record: V21PortableRecord): string {
  const parts: string[] = [];
  if (record.type !== 'note') parts.push(`type goc: ${record.type}`);
  if (record.sources.length > 0) parts.push(`sources: ${record.sources.join(', ')}`);
  if (record.verified) parts.push(`verified: ${record.verified.by} @ ${new Date(record.verified.at).toISOString()}`);
  if (record.staleAfter) parts.push(`stale_after: ${record.staleAfter}`);
  if (record.codeRefs.length > 0) parts.push(`code_refs: ${record.codeRefs.join(', ')}`);
  if (parts.length === 0) return '';
  return `\n\n<!-- portable-meta: ${parts.join(' | ')} -->`;
}

/** OKF text -> record (ghi ro mat mat: khong co). */
export function okfTextToRecordV21(
  text: string,
  path: string,
  now = Date.now(),
): V21Result<V21PortableRecord> {
  const parsed = parseOkfDocumentV21(text, path);
  if (!parsed.ok || !parsed.data) return { ok: false, error: parsed.error, errorCode: parsed.errorCode };
  const id = path.replace(/\.md$/i, '').split('/').pop() ?? 'record';
  return { ok: true, data: okfToRecordV21(parsed.data, id, path, now) };
}

/** MemFS block text -> record (type suy dien `note`, bao cao ro). */
export function memfsTextToRecordV21(
  text: string,
  path: string,
  now = Date.now(),
): V21Result<{ record: V21PortableRecord; inferred: string[] }> {
  const parsed = parseMemfsBlockHeaderV21(text);
  if (!parsed.ok || !parsed.data) return { ok: false, error: parsed.error, errorCode: parsed.errorCode };
  const block: V21MemfsBlock = {
    id: parsed.data.id,
    path,
    title: parsed.data.body.split('\n')[0]?.replace(/^#\s+/, '').trim() || parsed.data.id,
    body: parsed.data.body,
    hash: parsed.data.hash,
    version: parsed.data.version,
    updatedAt: parsed.data.updatedAt,
  };
  const record = memfsBlockToRecordV21(block, now);
  return { ok: true, data: { record, inferred: ['type=note (MemFS khong luu type)'] } };
}

/** OpenHands entry -> record (type mac dinh `note` neu khong co meta). */
export function openhandsEntryToRecordWithMetaV21(
  entry: V21OpenHandsEntry,
  meta: Record<string, string> = {},
  now = Date.now(),
): { record: V21PortableRecord; inferred: string[] } {
  const record = openhandsEntryToRecordV21(entry, now);
  const inferred: string[] = [];
  const t = (meta['type'] ?? '').trim();
  if (['fact', 'preference', 'decision', 'person', 'project', 'procedure', 'note', 'custom'].includes(t)) {
    record.type = t as V21PortableRecord['type'];
  } else {
    inferred.push('type=note (khong co meta type)');
  }
  if (meta['tags']) record.tags = meta['tags'].split(',').map((x) => x.trim()).filter(Boolean);
  return { record, inferred };
}

/** Record -> OKF text (khong mat field). */
export function recordToFormatTextV21(
  record: V21PortableRecord,
  format: V21PortableFormat,
  report: V21ConversionReport,
): string {
  if (format === 'okf') return recordToOkfV21(record);
  if (format === 'memfs') {
    // MemFS block chi luu body: metadata chuyen xuong footer.
    const block = recordToMemfsBlockV21(record);
    const footer = conversionFooterV21(record);
    const body = footer ? `${record.body}${footer}` : record.body;
    const withBody: V21MemfsBlock = { ...block, body, hash: hashContentV21(body) };
    if (record.type !== 'note') noteDroppedV21(report, 'type', record.id);
    if (record.sources.length > 0) noteDroppedV21(report, 'sources', record.id);
    if (record.verified) noteDroppedV21(report, 'verified', record.id);
    if (record.staleAfter) noteDroppedV21(report, 'stale_after', record.id);
    if (record.codeRefs.length > 0) noteDroppedV21(report, 'code_refs', record.id);
    return `<!-- memfs:id=${withBody.id} version=${withBody.version} hash=${withBody.hash} updatedAt=${withBody.updatedAt} -->\n\n${withBody.body}\n`;
  }
  // openhands: moi record la mot muc `##` trong MEMORY.md.
  if (record.codeRefs.length > 0) noteDroppedV21(report, 'code_refs', record.id);
  if (record.verified) noteDroppedV21(report, 'verified', record.id);
  if (record.staleAfter) noteDroppedV21(report, 'stale_after', record.id);
  const footer = conversionFooterV21(record);
  const body = footer ? `${record.body}${footer}` : record.body;
  return `## ${record.title}\n<!-- type: ${record.type}${record.tags.length > 0 ? ` | tags: ${record.tags.join(', ')}` : ''} -->\n\n${body}\n`;
}

/** Doan format cua mot file tu noi dung + duong dan. */
export function detectFormatV21(
  text: string,
  path: string,
): V21PortableFormat | null {
  if (path.endsWith('MEMORY.md') || path.includes('/memory/') || /^\d{4}-\d{2}-\d{2}\.md$/.test(path.split('/').pop() ?? '')) {
    if (text.includes('# Memory') || text.startsWith('# 20')) return 'openhands';
  }
  if (text.startsWith('<!-- memfs:')) return 'memfs';
  const trimmed = text.trimStart();
  if (trimmed.startsWith('---\n') || trimmed.startsWith('---\r\n')) {
    const close = trimmed.indexOf('\n---', 3);
    if (close >= 0) {
      const fm = trimmed.slice(0, close);
      if (/^type:\s*\S+/m.test(fm)) return 'okf';
    }
  }
  if (path.endsWith('.md') && /^type:\s*\S+/m.test(text)) return 'okf';
  return null;
}

/** Convert mot record don le sang format dich. */
export function convertRecordV21(
  record: V21PortableRecord,
  to: V21PortableFormat,
  options: V21ConvertOptions = {},
): V21Result<{ text: string; report: V21ConversionReport }> {
  const from: V21PortableFormat = record.originFormat ?? 'okf';
  const report = emptyReportV21(from, to);
  const text = recordToFormatTextV21(record, to, report);
  if (options.strict && report.fieldsDropped.length > 0) {
    return {
      ok: false,
      error: `strict mode: mat field ${report.fieldsDropped.join(', ')} khi convert ${from} -> ${to}`,
      errorCode: 'conversion_loss',
    };
  }
  report.recordsConverted = 1;
  return { ok: true, data: { text, report } };
}

/**
 * Convert ca bundle sang format dich.
 *  - OKF/MemFS: moi record mot file.
 *  - OpenHands: tat ca record gom vao mot MEMORY.md duy nhat.
 */
export function convertBundleV21(
  input: V21ConvertBundleInput,
  to: V21PortableFormat,
  options: V21ConvertOptions = {},
): V21ConvertBundleOutput {
  const now = options.now ?? Date.now();
  const report = emptyReportV21(input.format, to);
  const failed: { path: string; error: string }[] = [];
  const records: V21PortableRecord[] = [];
  for (const file of input.files) {
    if (input.format === 'okf') {
      const parsed = okfTextToRecordV21(file.content, file.path, now);
      if (!parsed.ok || !parsed.data) {
        failed.push({ path: file.path, error: parsed.error ?? 'loi khong ro' });
        report.recordsSkipped += 1;
        continue;
      }
      records.push(parsed.data);
    } else if (input.format === 'memfs') {
      const parsed = memfsTextToRecordV21(file.content, file.path, now);
      if (!parsed.ok || !parsed.data) {
        failed.push({ path: file.path, error: parsed.error ?? 'loi khong ro' });
        report.recordsSkipped += 1;
        continue;
      }
      for (const note of parsed.data.inferred) report.warnings.push(`record "${parsed.data.record.id}": ${note}`);
      records.push(parsed.data.record);
    } else {
      // openhands: moi file la mot tap entry — tach muc `##`/`###`.
      const sections = splitOpenHandsSectionsV21(file.content);
      for (const section of sections) {
        const { record, inferred } = openhandsEntryToRecordWithMetaV21(section.entry, section.meta, now);
        for (const note of inferred) report.warnings.push(`record "${record.id}": ${note}`);
        records.push(record);
      }
    }
  }
  if (options.strict && report.fieldsDropped.length > 0) {
    // Ghi nhan: strict chi ap dung cho mat mat khi GHI ra format dich.
  }
  const seen = new Set<string>();
  const deduped = records.filter((r) => {
    if (seen.has(r.id)) {
      failed.push({ path: r.originPath ?? r.id, error: `trung id "${r.id}" trong bundle` });
      report.recordsSkipped += 1;
      return false;
    }
    seen.add(r.id);
    return true;
  });
  const outFiles: { path: string; content: string }[] = [];
  if (to === 'openhands') {
    const sorted = [...deduped].sort((a, b) => a.title.localeCompare(b.title));
    const withMeta = sorted.map((r) => ({ ...r }));
    // Ghi lai footer metadata truoc khi gop.
    const rendered = withMeta.map((r) => recordToFormatTextV21(r, 'openhands', report)).join('\n');
    outFiles.push({ path: 'MEMORY.md', content: `# Memory\n\n${rendered.trim()}\n` });
    report.recordsConverted = withMeta.length;
  } else {
    for (const record of deduped) {
      const text = recordToFormatTextV21(record, to, report);
      const filename = to === 'okf'
        ? `${record.id}.md`
        : `blocks/${record.id}.md`;
      outFiles.push({ path: filename, content: text });
      report.recordsConverted += 1;
    }
  }
  if (options.strict && report.fieldsDropped.length > 0) {
    return {
      format: to,
      files: [],
      report,
      failed: [...failed, { path: '(bundle)', error: `strict mode: mat field ${report.fieldsDropped.join(', ')}` }],
    };
  }
  return { format: to, files: outFiles, report, failed };
}

function splitOpenHandsSectionsV21(
  text: string,
): { entry: V21OpenHandsEntry; meta: Record<string, string> }[] {
  const lines = text.split('\n');
  const out: { entry: V21OpenHandsEntry; meta: Record<string, string> }[] = [];
  let current: { entry: V21OpenHandsEntry; meta: Record<string, string> } | null = null;
  const flush = () => {
    if (current) {
      current.entry.body = current.entry.body.trim();
      out.push(current);
      current = null;
    }
  };
  for (const line of lines) {
    if (line.startsWith('## ') || line.startsWith('### ')) {
      flush();
      const heading = line.replace(/^#{2,3}\s+/, '').trim();
      current = { entry: { tier: 'curated', heading, body: '' }, meta: {} };
      continue;
    }
    if (!current) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith('<!--') && trimmed.endsWith('-->') && current.entry.body === '') {
      const inner = trimmed.replace(/^<!--\s*/, '').replace(/\s*-->$/, '');
      for (const part of inner.split('|')) {
        const colon = part.indexOf(':');
        if (colon >= 0) current.meta[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
      }
      continue;
    }
    current.entry.body += `${line}\n`;
  }
  flush();
  return out;
}

/** Kiem tra mot dinh dang co duoc ho tro khong. */
export function isSupportedFormatV21(value: string): value is V21PortableFormat {
  return (V21_PORTABLE_FORMATS as readonly string[]).includes(value);
}
