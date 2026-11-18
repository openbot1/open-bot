/**
 * Memory v21 — OKF-style format (Markdown + YAML frontmatter).
 *
 * Y tuong hoc tu Open Knowledge Format (OKF v0.2): memory la thu
 * muc file Markdown, moi file mot YAML frontmatter voi key bat
 * buoc duy nhat `type`; field tuy chon `sources`, `verified`,
 * `stale_after`, `code_refs`. Tu thiet ke lai hoan toan cho
 * open-bot, KHONG copy code/text/tai san cua bat ky repo nao.
 *
 * YAML subset tu viet (khong them dependency — core khong co
 * runtime dep): ho tro string (co/khong quote), number, boolean,
 * null, inline array `[a, b]`, block list `- item`, map long nhau
 * 1 cap (cho `verified: {by, at, note}`). YAML phuc tap hon se
 * tra loi `yaml_error` ro rang chu khong doan mo.
 */
import { createHash } from 'node:crypto';
import type {
  V21OkfFrontmatter,
  V21PortableRecord,
  V21RecordType,
  V21Result,
  V21ValidationIssue,
  V21VerifiedInfo,
} from './types';
import { V21_MAX_TITLE_CHARS, V21_RECORD_TYPES } from './types';

/** Cac field frontmatter duoc hieu; field khac -> canh bao `unknown_field`. */
export const V21_OKF_KNOWN_FIELDS = [
  'type',
  'title',
  'tags',
  'sources',
  'verified',
  'stale_after',
  'code_refs',
] as const;

/** Regex ngay ISO YYYY-MM-DD hop le lich (khong chi hinh thuc). */
export function isIsoDateV21(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === value;
}

/** Slug hoa ten file/id: chu thuong, `[^a-z0-9]+` -> `-`. */
export function slugifyV21(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'record';
}

/** SHA-256 hex cua mot chuoi (dung cho hash record/block). */
export function hashContentV21(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function hashRecordV21(record: V21PortableRecord): string {
  return hashContentV21(
    [record.type, record.title, record.body, record.tags.join(','), record.sources.join(',')].join('\n'),
  );
}

// --- YAML subset: parse ---------------------------------------------------

interface YamlScalar {
  kind: 'string' | 'number' | 'boolean' | 'null';
  value: string | number | boolean | null;
}

function parseYamlScalarV21(raw: string): YamlScalar | { error: string } {
  const text = raw.trim();
  if (text === '' || text === '~' || text === 'null') return { kind: 'null', value: null };
  if (text === 'true' || text === 'True' || text === 'TRUE') return { kind: 'boolean', value: true };
  if (text === 'false' || text === 'False' || text === 'FALSE') return { kind: 'boolean', value: false };
  if (/^-?\d+$/.test(text)) return { kind: 'number', value: Number(text) };
  if (/^-?\d+\.\d+$/.test(text)) return { kind: 'number', value: Number(text) };
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    if (text.length < 2) return { error: 'chuoi quote khong dong' };
    const inner = text.slice(1, -1);
    if (text.startsWith('"')) {
      try {
        return { kind: 'string', value: JSON.parse(text) as string };
      } catch {
        return { kind: 'string', value: inner };
      }
    }
    return { kind: 'string', value: inner.replace(/''/g, "'") };
  }
  if (/[:#\[\]{}]/.test(text) && !/^https?:\/\//.test(text) && !/^[\w./-]+$/.test(text)) {
    // Ky tu dac biet chua duoc quote — co the la YAML ma parser
    // subset khong hieu: bao loi thay vi doan sai.
    if (text.includes(': ') || text.endsWith(':') || text.includes(' #')) {
      return { error: `gia tri YAML khong ho tro (can quote): "${text}"` };
    }
  }
  return { kind: 'string', value: text };
}

function splitInlineListV21(inner: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ',') {
      parts.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim() !== '' || parts.length > 0) parts.push(cur.trim());
  return parts.filter((p) => p !== '');
}

function parseInlineValueV21(raw: string): unknown | { error: string } {
  const text = raw.trim();
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim();
    if (!inner) return [];
    const out: unknown[] = [];
    for (const part of splitInlineListV21(inner)) {
      const scalar = parseYamlScalarV21(part);
      if ('error' in scalar) return scalar;
      out.push(scalar.value);
    }
    return out;
  }
  if (text.startsWith('{') && text.endsWith('}')) {
    const inner = text.slice(1, -1).trim();
    if (!inner) return {};
    const out: Record<string, unknown> = {};
    for (const part of splitInlineListV21(inner)) {
      const colon = part.indexOf(':');
      if (colon < 0) return { error: `map inline thieu dau ':': "${part}"` };
      const key = part.slice(0, colon).trim();
      const scalar = parseYamlScalarV21(part.slice(colon + 1));
      if ('error' in scalar) return scalar;
      out[key] = scalar.value;
    }
    return out;
  }
  const scalar = parseYamlScalarV21(text);
  if ('error' in scalar) return scalar;
  return scalar.value;
}

/**
 * Parse khoi frontmatter (cac dong giua `---` mo/đong). Chi ho tro
 * YAML subset mo ta o dau file; dong lech thụt > 2 space, anchor,
 * multi-line `|`/`>` se bao `yaml_error`.
 */
export function parseYamlSubsetV21(
  lines: string[],
): V21Result<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) {
      i += 1;
      continue;
    }
    if (line.startsWith(' ') || line.startsWith('\t')) {
      return { ok: false, error: `dong ${i + 1}: thụt dau dong khong ho tro trong YAML subset`, errorCode: 'yaml_error' };
    }
    const colon = line.indexOf(':');
    if (colon < 0) {
      return { ok: false, error: `dong ${i + 1}: khong co dau ':' — "${line}"`, errorCode: 'yaml_error' };
    }
    const key = line.slice(0, colon).trim();
    if (!key || /\s/.test(key)) {
      return { ok: false, error: `dong ${i + 1}: key khong hop le — "${line}"`, errorCode: 'yaml_error' };
    }
    const rest = line.slice(colon + 1);
    if (rest.trim() === '') {
      // Co the la block list `- item` hoac nested map `  k: v`.
      const items: string[] = [];
      const nested: Record<string, unknown> = {};
      let j = i + 1;
      let sawList = false;
      let sawMap = false;
      while (j < lines.length) {
        const sub = lines[j];
        if (!sub.trim()) {
          j += 1;
          continue;
        }
        if (sub.startsWith('- ')) {
          sawList = true;
          const scalar = parseYamlScalarV21(sub.slice(2));
          if ('error' in scalar) return { ok: false, error: `dong ${j + 1}: ${scalar.error}`, errorCode: 'yaml_error' };
          items.push(String(scalar.value ?? ''));
          j += 1;
        } else if (sub.startsWith('  ') && !sub.startsWith('   ') && sub.trim().includes(':')) {
          sawMap = true;
          const subColon = sub.trim().indexOf(':');
          const subKey = sub.trim().slice(0, subColon).trim();
          const parsed = parseInlineValueV21(sub.trim().slice(subColon + 1));
          if (parsed && typeof parsed === 'object' && 'error' in parsed) {
            return { ok: false, error: `dong ${j + 1}: ${String(parsed.error)}`, errorCode: 'yaml_error' };
          }
          nested[subKey] = parsed;
          j += 1;
        } else {
          break;
        }
      }
      if (sawList && sawMap) {
        return { ok: false, error: `dong ${i + 1}: key "${key}" vua co list vua co map`, errorCode: 'yaml_error' };
      }
      if (sawList) {
        out[key] = items;
        i = j;
        continue;
      }
      if (sawMap) {
        out[key] = nested;
        i = j;
        continue;
      }
      out[key] = null;
      i += 1;
      continue;
    }
    const trimmed = rest.trim();
    if (trimmed === '|' || trimmed === '>') {
      return { ok: false, error: `dong ${i + 1}: block scalar '|' / '>' chua ho tro`, errorCode: 'yaml_error' };
    }
    const parsed = parseInlineValueV21(rest);
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      return { ok: false, error: `dong ${i + 1}: ${String(parsed.error)}`, errorCode: 'yaml_error' };
    }
    out[key] = parsed;
    i += 1;
  }
  return { ok: true, data: out };
}

// --- YAML subset: serialize ----------------------------------------------

function yamlQuoteV21(value: string): string {
  if (value === '') return '""';
  if (/^[A-Za-z0-9 _\-./:#()@%+=,;]+$/.test(value) && !/^\d/.test(value) && value !== 'true' && value !== 'false' && value !== 'null' && value !== '~') {
    return value;
  }
  return JSON.stringify(value);
}

function serializeYamlValueV21(key: string, value: unknown, lines: string[]): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${key}: []`);
      return;
    }
    lines.push(`${key}:`);
    for (const item of value) {
      lines.push(`- ${yamlQuoteV21(String(item))}`);
    }
    return;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      lines.push(`${key}: {}`);
      return;
    }
    lines.push(`${key}:`);
    for (const [k, v] of entries) {
      if (v === null || v === undefined) lines.push(`  ${k}: null`);
      else if (typeof v === 'number' || typeof v === 'boolean') lines.push(`  ${k}: ${String(v)}`);
      else lines.push(`  ${k}: ${yamlQuoteV21(String(v))}`);
    }
    return;
  }
  if (value === null || value === undefined) {
    lines.push(`${key}: null`);
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    lines.push(`${key}: ${String(value)}`);
    return;
  }
  lines.push(`${key}: ${yamlQuoteV21(String(value))}`);
}

export function serializeYamlSubsetV21(frontmatter: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(frontmatter)) {
    serializeYamlValueV21(key, value, lines);
  }
  return lines.join('\n');
}

// --- OKF document: parse / serialize --------------------------------------

export interface V21OkfParseResult {
  frontmatter: V21OkfFrontmatter;
  body: string;
  /** Canh bao khong fatal (field la, stale qua han, ...). */
  issues: V21ValidationIssue[];
}

/** Tach frontmatter `--- ... ---` o dau file. */
export function splitOkfFrontmatterV21(
  text: string,
): V21Result<{ frontmatterLines: string[]; body: string }> {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') {
    return { ok: false, error: 'thieu frontmatter mo dau `---`', errorCode: 'missing_frontmatter' };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---' || lines[i].trim() === '...') {
      end = i;
      break;
    }
  }
  if (end < 0) {
    return { ok: false, error: 'thieu dong dong frontmatter `---`', errorCode: 'yaml_error' };
  }
  return { ok: true, data: { frontmatterLines: lines.slice(1, end), body: lines.slice(end + 1).join('\n').trim() } };
}

function asStringArrayV21(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((v) => typeof v === 'string')) return null;
  return [...(value as string[])];
}

/** Kiem tra frontmatter da parse: `type` bat buoc, cac field dung kieu. */
export function validateOkfFrontmatterV21(
  raw: Record<string, unknown>,
  path = 'frontmatter',
): { frontmatter?: V21OkfFrontmatter; issues: V21ValidationIssue[] } {
  const issues: V21ValidationIssue[] = [];
  const fm: Record<string, unknown> = { ...raw };
  for (const key of Object.keys(raw)) {
    if (!(V21_OKF_KNOWN_FIELDS as readonly string[]).includes(key)) {
      issues.push({ path: `${path}.${key}`, code: 'unknown_field', message: `field "${key}" khong duoc hieu — se giu nguyen khi round-trip, khong dung de truy van`, severity: 'warning' });
    }
  }
  const typeRaw = raw['type'];
  if (typeRaw === undefined || typeRaw === null || typeRaw === '') {
    issues.push({ path: `${path}.type`, code: 'missing_type', message: 'field `type` la bat buoc trong OKF frontmatter', severity: 'error' });
    return { issues };
  }
  if (typeof typeRaw !== 'string' || !(V21_RECORD_TYPES as readonly string[]).includes(typeRaw)) {
    issues.push({ path: `${path}.type`, code: 'unknown_type', message: `type "${String(typeRaw)}" khong hop le — cho phep: ${V21_RECORD_TYPES.join(', ')}`, severity: 'error' });
    return { issues };
  }
  const frontmatter: V21OkfFrontmatter = { type: typeRaw as V21RecordType };
  if (raw['title'] !== undefined) {
    if (typeof raw['title'] !== 'string' || !raw['title'].trim()) {
      issues.push({ path: `${path}.title`, code: 'empty_title', message: 'title phai la chuoi khong rong', severity: 'error' });
    } else {
      frontmatter.title = raw['title'].trim();
      if (frontmatter.title.length > V21_MAX_TITLE_CHARS) {
        issues.push({ path: `${path}.title`, code: 'empty_title', message: `title dai qua ${V21_MAX_TITLE_CHARS} ky tu`, severity: 'warning' });
      }
    }
  }
  for (const field of ['tags', 'sources', 'code_refs'] as const) {
    if (raw[field] !== undefined) {
      const arr = asStringArrayV21(raw[field]);
      if (arr === null) {
        issues.push({ path: `${path}.${field}`, code: field === 'sources' ? 'bad_source' : 'bad_code_ref', message: `${field} phai la danh sach chuoi`, severity: 'error' });
      } else {
        if (field === 'code_refs') {
          for (const ref of arr) {
            if (!/^[\w./\-]+$/.test(ref) || ref.includes('..')) {
              issues.push({ path: `${path}.code_refs`, code: 'bad_code_ref', message: `code_ref "${ref}" khong giong duong dan source hop le`, severity: 'warning' });
            }
          }
        }
        frontmatter[field] = arr;
      }
    }
  }
  if (raw['verified'] !== undefined) {
    const v = raw['verified'];
    if (typeof v === 'string') {
      frontmatter.verified = { by: v, at: Date.now() };
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      const rec = v as Record<string, unknown>;
      if (typeof rec['by'] !== 'string' || !rec['by']) {
        issues.push({ path: `${path}.verified.by`, code: 'bad_verified', message: 'verified.by phai la chuoi khong rong', severity: 'error' });
      } else {
        const verified: V21VerifiedInfo = { by: rec['by'], at: typeof rec['at'] === 'number' ? rec['at'] : Date.now() };
        if (typeof rec['note'] === 'string') verified.note = rec['note'];
        frontmatter.verified = verified;
      }
    } else {
      issues.push({ path: `${path}.verified`, code: 'bad_verified', message: 'verified phai la chuoi hoac map {by, at, note?}', severity: 'error' });
    }
  }
  if (raw['stale_after'] !== undefined) {
    if (typeof raw['stale_after'] !== 'string' || !isIsoDateV21(raw['stale_after'])) {
      issues.push({ path: `${path}.stale_after`, code: 'bad_stale_after', message: `stale_after "${String(raw['stale_after'])}" phai la ngay ISO YYYY-MM-DD hop le`, severity: 'error' });
    } else {
      frontmatter.stale_after = raw['stale_after'];
    }
  }
  // Giu field la de round-trip khong mat du lieu.
  for (const [k, v] of Object.entries(fm)) {
    if (!(V21_OKF_KNOWN_FIELDS as readonly string[]).includes(k)) frontmatter[k] = v;
  }
  return { frontmatter, issues };
}

export function parseOkfDocumentV21(
  text: string,
  path = 'document',
): V21Result<V21OkfParseResult> {
  const split = splitOkfFrontmatterV21(text);
  if (!split.ok || !split.data) return { ok: false, error: split.error, errorCode: split.errorCode };
  const parsed = parseYamlSubsetV21(split.data.frontmatterLines);
  if (!parsed.ok || !parsed.data) return { ok: false, error: parsed.error, errorCode: parsed.errorCode };
  const checked = validateOkfFrontmatterV21(parsed.data, `${path}.frontmatter`);
  const errors = checked.issues.filter((i) => i.severity === 'error');
  if (errors.length > 0 || !checked.frontmatter) {
    return {
      ok: false,
      error: errors.map((e) => `${e.path}: ${e.message}`).join(' | '),
      errorCode: 'validation_failed',
    };
  }
  return { ok: true, data: { frontmatter: checked.frontmatter, body: split.data.body, issues: checked.issues } };
}

export function okfToRecordV21(
  parsed: V21OkfParseResult,
  id: string,
  originPath?: string,
  now = Date.now(),
): V21PortableRecord {
  const fm = parsed.frontmatter;
  return {
    id: slugifyV21(id),
    type: fm.type,
    title: fm.title ?? slugifyV21(id),
    body: parsed.body,
    tags: fm.tags ?? [],
    sources: fm.sources ?? [],
    verified: fm.verified,
    staleAfter: fm.stale_after,
    codeRefs: fm.code_refs ?? [],
    version: 1,
    createdAt: now,
    updatedAt: now,
    originFormat: 'okf',
    originPath,
  };
}

/** Parse mot file OKF thanh record (id lay tu ten file neu khong co). */
export function parseOkfFileV21(
  text: string,
  filename: string,
  now = Date.now(),
): V21Result<V21PortableRecord> {
  const parsed = parseOkfDocumentV21(text, filename);
  if (!parsed.ok || !parsed.data) return { ok: false, error: parsed.error, errorCode: parsed.errorCode };
  const id = filename.replace(/\.md$/i, '').split('/').pop() ?? 'record';
  return { ok: true, data: okfToRecordV21(parsed.data, id, filename, now) };
}

export function recordToOkfV21(record: V21PortableRecord): string {
  const fm: Record<string, unknown> = { type: record.type };
  if (record.title) fm['title'] = record.title;
  if (record.tags.length > 0) fm['tags'] = record.tags;
  if (record.sources.length > 0) fm['sources'] = record.sources;
  if (record.verified) {
    fm['verified'] = {
      by: record.verified.by,
      at: record.verified.at,
      ...(record.verified.note ? { note: record.verified.note } : {}),
    };
  }
  if (record.staleAfter) fm['stale_after'] = record.staleAfter;
  if (record.codeRefs.length > 0) fm['code_refs'] = record.codeRefs;
  return `---\n${serializeYamlSubsetV21(fm)}\n---\n\n${record.body}\n`;
}

/** Ten file OKF cho mot record (slug tu title, fallback id). */
export function okfFilenameV21(record: V21PortableRecord): string {
  const base = slugifyV21(record.title || record.id);
  return `${base}.md`;
}

/** Parse ca bundle OKF: tra ve record parse duoc + loi theo file. */
export function parseOkfBundleV21(
  files: { path: string; content: string }[],
  now = Date.now(),
): {
  records: V21PortableRecord[];
  failed: { path: string; error: string }[];
  warnings: V21ValidationIssue[];
} {
  const records: V21PortableRecord[] = [];
  const failed: { path: string; error: string }[] = [];
  const warnings: V21ValidationIssue[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const parsed = parseOkfFileV21(file.content, file.path, now);
    if (!parsed.ok || !parsed.data) {
      failed.push({ path: file.path, error: parsed.error ?? 'loi khong ro' });
      continue;
    }
    if (seen.has(parsed.data.id)) {
      failed.push({ path: file.path, error: `trung id "${parsed.data.id}" trong bundle` });
      continue;
    }
    seen.add(parsed.data.id);
    const doc = parseOkfDocumentV21(file.content, file.path);
    if (doc.ok && doc.data) warnings.push(...doc.data.issues);
    records.push(parsed.data);
  }
  return { records, failed, warnings };
}

/** Record da qua han `stale_after` chua (so voi ngay hien tai)? */
export function isRecordStaleV21(record: V21PortableRecord, today = new Date()): boolean {
  if (!record.staleAfter) return false;
  const todayStr = today.toISOString().slice(0, 10);
  return record.staleAfter < todayStr;
}
