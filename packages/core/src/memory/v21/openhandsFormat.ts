/**
 * Memory v21 — OpenHands-style 2-tier format.
 *
 * Y tuong hoc tu OpenHands: memory 2 tang — MEMORY.md curated
 * (da gon, dung lau) + daily log `memory/YYYY-MM-DD.md` (tho,
 * theo ngay). Tu thiet ke lai hoan toan cho open-bot, KHONG copy
 * code/text/tai san cua bat ky repo nao.
 *
 * Quy uoc dinh dang trong open-bot:
 *  - MEMORY.md: `# Memory` + cac muc `## <Tieu de>`; dong dau muc
 *    co the co meta comment `<!-- type: fact | tags: a, b -->`.
 *  - Daily log: `# 2026-11-17` + cac muc `### HH:MM — <tieu de>`
 *    hoac `### <tieu de>`; moi muc la mot entry tho.
 *  - Promote: entry daily du tin cay (xuat hien nhieu session
 *    hoac duoc danh dau) moi len curated; dedupe Jaccard voi
 *    curated hien co de khong tao trung lap.
 */
import type { V21OpenHandsEntry, V21PortableRecord, V21Result } from './types';
import { V21_PROMOTE_DEDUPE_THRESHOLD } from './types';
import { isIsoDateV21, slugifyV21 } from './okfFormat';
import { sleepTextTokensV20, jaccardSimilarityV20 } from '../v20/sleepConsolidation';

export const V21_OPENHANDS_CURATED_FILE = 'MEMORY.md';
export const V21_OPENHANDS_DAILY_DIR = 'memory';

/** Ten file daily log cho mot ngay (YYYY-MM-DD). */
export function openhandsDailyFilenameV21(date: string): string {
  return `${V21_OPENHANDS_DAILY_DIR}/${date}.md`;
}

function parseMetaCommentV21(line: string): Record<string, string> {
  const m = line.match(/^<!--\s*(.*?)\s*-->$/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const part of m[1].split('|')) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    out[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
  }
  return out;
}

function metaCommentV21(fields: Record<string, string>): string {
  const parts = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  return `<!-- ${parts.join(' | ')} -->`;
}

interface RawSection {
  heading: string;
  meta: Record<string, string>;
  body: string;
  time?: string;
}

/** Tach cac muc `##`/`###` trong mot file Markdown. */
function splitSectionsV21(text: string, level: 2 | 3): RawSection[] {
  const marker = level === 2 ? '## ' : '### ';
  const lines = text.split('\n');
  const sections: RawSection[] = [];
  let current: RawSection | null = null;
  const flush = () => {
    if (current) {
      current.body = current.body.trim();
      sections.push(current);
      current = null;
    }
  };
  for (const line of lines) {
    if (line.startsWith(marker)) {
      flush();
      const rest = line.slice(marker.length).trim();
      // Daily: `### HH:MM — Tieu de` hoac `### HH:MM Tieu de`.
      const timeMatch = rest.match(/^(\d{2}:\d{2})\s*[—–-]\s*(.*)$/) ?? rest.match(/^(\d{2}:\d{2})\s+(.*)$/);
      if (level === 3 && timeMatch) {
        current = { heading: timeMatch[2] || 'entry', meta: {}, body: '', time: timeMatch[1] };
      } else {
        current = { heading: rest, meta: {}, body: '' };
      }
      continue;
    }
    if (line.startsWith('# ') || line.startsWith('#\t')) continue;
    if (!current) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith('<!--') && trimmed.endsWith('-->') && current.body === '') {
      current.meta = parseMetaCommentV21(trimmed);
      continue;
    }
    current.body += `${line}\n`;
  }
  flush();
  return sections;
}

/** Parse MEMORY.md curated thanh cac entry. */
export function parseOpenHandsCuratedV21(
  text: string,
): V21Result<V21OpenHandsEntry[]> {
  if (!text.trim()) return { ok: true, data: [] };
  const sections = splitSectionsV21(text, 2);
  const entries: V21OpenHandsEntry[] = sections.map((s) => ({
    tier: 'curated' as const,
    heading: s.heading,
    body: s.body,
  }));
  return { ok: true, data: entries };
}

/** Parse mot daily log thanh cac entry (can ngay YYYY-MM-DD). */
export function parseOpenHandsDailyV21(
  text: string,
  date: string,
): V21Result<V21OpenHandsEntry[]> {
  if (!isIsoDateV21(date)) {
    return { ok: false, error: `ngay daily log "${date}" phai la YYYY-MM-DD hop le`, errorCode: 'bad_stale_after' };
  }
  if (!text.trim()) return { ok: true, data: [] };
  const sections = splitSectionsV21(text, 3);
  return {
    ok: true,
    data: sections.map((s) => ({ tier: 'daily' as const, heading: s.heading, body: s.body, date, time: s.time })),
  };
}

function entryTypeFromMetaV21(meta: Record<string, string>): V21PortableRecord['type'] {
  const t = (meta['type'] ?? '').trim();
  if (['fact', 'preference', 'decision', 'person', 'project', 'procedure', 'note', 'custom'].includes(t)) {
    return t as V21PortableRecord['type'];
  }
  return 'note';
}

export function openhandsEntryToRecordV21(
  entry: V21OpenHandsEntry,
  now = Date.now(),
): V21PortableRecord {
  const idBase = entry.tier === 'daily' && entry.date
    ? `${entry.date}-${entry.heading}`
    : entry.heading;
  return {
    id: slugifyV21(idBase),
    type: 'note',
    title: entry.heading,
    body: entry.body,
    tags: entry.tier === 'daily' ? ['daily-log'] : [],
    sources: entry.tier === 'daily' && entry.date ? [`daily:${entry.date}`] : ['MEMORY.md'],
    codeRefs: [],
    version: 1,
    createdAt: now,
    updatedAt: now,
    originFormat: 'openhands',
    originPath:
      entry.tier === 'daily' && entry.date ? openhandsDailyFilenameV21(entry.date) : V21_OPENHANDS_CURATED_FILE,
  };
}

/** Parse ca MEMORY.md + cac daily log thanh record. */
export function parseOpenHandsBundleV21(
  curatedText: string,
  dailyFiles: { date: string; content: string }[],
  now = Date.now(),
): V21Result<{ records: V21PortableRecord[]; failed: { date: string; error: string }[] }> {
  const curated = parseOpenHandsCuratedV21(curatedText);
  if (!curated.ok || !curated.data) return { ok: false, error: curated.error, errorCode: curated.errorCode };
  const records: V21PortableRecord[] = [];
  const failed: { date: string; error: string }[] = [];
  const seen = new Set<string>();
  const pushEntry = (entry: V21OpenHandsEntry, meta: Record<string, string>) => {
    const record = openhandsEntryToRecordV21(entry, now);
    record.type = entryTypeFromMetaV21(meta);
    if (meta['tags']) record.tags = meta['tags'].split(',').map((t) => t.trim()).filter(Boolean);
    if (seen.has(record.id)) return;
    seen.add(record.id);
    records.push(record);
  };
  // Can meta de lay type/tags: parse lai section tho tu curated.
  const curatedSections = splitSectionsV21(curatedText, 2);
  curated.data.forEach((entry, idx) => pushEntry(entry, curatedSections[idx]?.meta ?? {}));
  for (const file of dailyFiles) {
    const daily = parseOpenHandsDailyV21(file.content, file.date);
    if (!daily.ok || !daily.data) {
      failed.push({ date: file.date, error: daily.error ?? 'loi khong ro' });
      continue;
    }
    const dailySections = splitSectionsV21(file.content, 3);
    daily.data.forEach((entry, idx) => pushEntry(entry, dailySections[idx]?.meta ?? {}));
  }
  return { ok: true, data: { records, failed } };
}

export function recordsToOpenHandsCuratedV21(records: V21PortableRecord[]): string {
  const lines: string[] = ['# Memory', ''];
  const sorted = [...records].sort((a, b) => a.title.localeCompare(b.title));
  for (const record of sorted) {
    lines.push(`## ${record.title}`);
    const meta: Record<string, string> = { type: record.type };
    if (record.tags.length > 0) meta['tags'] = record.tags.join(', ');
    lines.push(metaCommentV21(meta));
    lines.push('');
    lines.push(record.body);
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

export function recordsToOpenHandsDailyV21(
  date: string,
  entries: { time?: string; title: string; body: string }[],
): string {
  const lines: string[] = [`# ${date}`, ''];
  for (const entry of entries) {
    const heading = entry.time ? `${entry.time} — ${entry.title}` : entry.title;
    lines.push(`### ${heading}`);
    lines.push('');
    lines.push(entry.body);
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

/** Them entry moi vao noi dung daily log hien co (khong ghi de). */
export function appendOpenHandsDailyV21(
  existingText: string,
  date: string,
  entry: { time?: string; title: string; body: string },
): V21Result<string> {
  if (!isIsoDateV21(date)) {
    return { ok: false, error: `ngay "${date}" phai la YYYY-MM-DD hop le`, errorCode: 'bad_stale_after' };
  }
  const base = existingText.trim() ? existingText.trimEnd() : `# ${date}`;
  const heading = entry.time ? `${entry.time} — ${entry.title}` : entry.title;
  return { ok: true, data: `${base}\n\n### ${heading}\n\n${entry.body.trim()}\n` };
}

export interface V21PromoteResult {
  promoted: V21PortableRecord[];
  skippedDuplicate: { record: V21PortableRecord; similarTo: string; similarity: number }[];
  skippedEmpty: V21PortableRecord[];
}

/**
 * Promote entry daily len curated: bo entry rong, dedupe Jaccard
 * voi curated hien co (nguong 0.6) — trung thi skip co ly do thay
 * vi tao trung lap. Entry duoc promote giu nguyen id goc, doi
 * origin thanh curated.
 */
export function promoteDailyToCuratedV21(
  dailyRecords: V21PortableRecord[],
  curatedRecords: V21PortableRecord[],
  threshold = V21_PROMOTE_DEDUPE_THRESHOLD,
): V21PromoteResult {
  const promoted: V21PortableRecord[] = [];
  const skippedDuplicate: V21PromoteResult['skippedDuplicate'] = [];
  const skippedEmpty: V21PortableRecord[] = [];
  for (const record of dailyRecords) {
    if (!record.body.trim() || !record.title.trim()) {
      skippedEmpty.push(record);
      continue;
    }
    const tokens = sleepTextTokensV20(`${record.title} ${record.body}`);
    let best: { id: string; sim: number } | null = null;
    for (const cur of curatedRecords) {
      const curTokens = sleepTextTokensV20(`${cur.title} ${cur.body}`);
      const sim = jaccardSimilarityV20(tokens, curTokens);
      if (!best || sim > best.sim) best = { id: cur.id, sim };
    }
    if (best && best.sim >= threshold) {
      skippedDuplicate.push({ record, similarTo: best.id, similarity: Math.round(best.sim * 100) / 100 });
      continue;
    }
    promoted.push({ ...record, originPath: V21_OPENHANDS_CURATED_FILE, tags: record.tags.filter((t) => t !== 'daily-log') });
  }
  return { promoted, skippedDuplicate, skippedEmpty };
}

/** Gom cac daily log thanh mot ban rollup (tom tat theo ngay). */
export function rollupDailyLogsV21(
  dailyFiles: { date: string; content: string }[],
  now = Date.now(),
): V21PortableRecord {
  const lines: string[] = [];
  const sorted = [...dailyFiles].sort((a, b) => a.date.localeCompare(b.date));
  for (const file of sorted) {
    const parsed = parseOpenHandsDailyV21(file.content, file.date);
    const count = parsed.ok && parsed.data ? parsed.data.length : 0;
    lines.push(`- ${file.date}: ${count} entry`);
  }
  return {
    id: `rollup-${sorted.length > 0 ? sorted[sorted.length - 1].date : 'empty'}`,
    type: 'note',
    title: `Rollup daily log (${sorted.length} ngay)`,
    body: lines.join('\n') || 'Khong co daily log.',
    tags: ['rollup', 'daily-log'],
    sources: sorted.map((f) => `daily:${f.date}`),
    codeRefs: [],
    version: 1,
    createdAt: now,
    updatedAt: now,
    originFormat: 'openhands',
  };
}
