/**
 * Memory v28 — migration tu cac the he memory cu (v1.44, Doi T1).
 *
 * Khi user nang cap len v28, du lieu cu khong bi bo lai:
 *  - Snapshot JSON cua v27 (fact graph bi-temporal + shared
 *    block) -> fact v28 + shared block v28.
 *  - Thu muc MemFS-lite (v0.96: `memory-blocks/*.md` +
 *    `longterm-facts.md`) -> block git v28 + fact v28.
 *  - Bundle v28 (xuat tu exportImport.ts) -> store v28 (o day
 *    chi la lop mong: import that nam o exportImport.ts).
 *
 * Migration doc JSON theo hinh dang (duck-typed, khong import
 * module v27 — tranh keo ca cay v25/v26 vao): moi ban ghi
 * khong dung dang thi ghi vao `errors` va bo qua, khong lam
 * hong ca dot migration. `dryRun=true` chi dem + bao cao,
 * khong ghi gi. Migration khong xoa du lieu goc — nguon cu
 * van nguyen sau khi chay.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseV28Frontmatter } from './gitStore';
import type { V28Store } from './store';
import {
  hashContentV28,
  isValidBlockLabelV28,
  normalizeBlockLabelV28,
  parseIsoV28,
  type V28Result,
} from './types';

/** Tuy chon migration. */
export interface V28MigrationOptions {
  /** Chi dem + bao cao, khong ghi gi. */
  dryRun?: boolean;
  /** Actor ghi vao audit/commit message. */
  actor?: string;
  /** Bot so huu block/fact duoc migration (mac dinh `migration`). */
  botId?: string;
}

/** Bao cao migration. */
export interface V28MigrationReport {
  source: 'v27-snapshot' | 'memfs-lite' | 'unknown';
  dryRun: boolean;
  factsImported: number;
  factsSkipped: number;
  blocksImported: number;
  blocksSkipped: number;
  errors: string[];
  notes: string[];
}

/** Doc mot truong chuoi tu object khong ro kieu (tra undefined neu khong co). */
function strField(record: unknown, ...names: string[]): string | undefined {
  if (!record || typeof record !== 'object') return undefined;
  const obj = record as Record<string, unknown>;
  for (const name of names) {
    const value = obj[name];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

/** Doc mot truong so tu object khong ro kieu. */
function numField(record: unknown, ...names: string[]): number | undefined {
  if (!record || typeof record !== 'object') return undefined;
  const obj = record as Record<string, unknown>;
  for (const name of names) {
    const value = obj[name];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** Chuong trinh con dung chung: them 1 fact vao store (kem dem). */
function migrateOneFact(
  store: V28Store,
  input: { subject: string; predicate: string; object: string; text: string; confidence: number; validFrom?: string; source: 'import' },
  report: V28MigrationReport,
  opts: V28MigrationOptions,
): void {
  if (opts.dryRun === true) {
    report.factsImported += 1;
    return;
  }
  const added = store.facts.addFact({
    subject: input.subject,
    predicate: input.predicate,
    object: input.object,
    text: input.text,
    source: 'import',
    botId: opts.botId ?? 'migration',
    confidence: input.confidence,
    tags: ['migrated-v28'],
    validFrom: input.validFrom,
  });
  if (added.ok) report.factsImported += 1;
  else {
    report.factsSkipped += 1;
    report.errors.push(`fact "${input.subject} ${input.predicate} ${input.object}" loi: ${added.error}`);
  }
}

/** Chuong trinh con dung chung: them 1 block vao git store (kem dem). */
function migrateOneBlock(
  store: V28Store,
  label: string,
  content: string,
  meta: { description?: string; kind?: 'human' | 'persona' | 'note' | 'fact' | 'shared' | 'custom'; scope?: 'system' | 'user' | 'shared' },
  report: V28MigrationReport,
  opts: V28MigrationOptions,
): void {
  const normalized = normalizeBlockLabelV28(label);
  if (!isValidBlockLabelV28(normalized)) {
    report.blocksSkipped += 1;
    report.errors.push(`block label khong hop le sau normalize: "${label}"`);
    return;
  }
  const existing = store.gitStore.readBlock(normalized);
  if (existing && hashContentV28(existing.content) === hashContentV28(content)) {
    report.blocksSkipped += 1;
    report.notes.push(`block "${normalized}" da co dung noi dung — bo qua.`);
    return;
  }
  if (opts.dryRun === true) {
    report.blocksImported += 1;
    return;
  }
  const written = store.gitStore.writeBlock(normalized, content, {
    kind: meta.kind ?? 'note',
    description: meta.description ?? '',
    scope: meta.scope ?? 'user',
    actor: opts.actor ?? 'system',
    message: `migrate to v28 from ${report.source}`,
    ownerBotId: opts.botId ?? 'migration',
  });
  if (written.ok) report.blocksImported += 1;
  else {
    report.blocksSkipped += 1;
    report.errors.push(`block "${normalized}" loi: ${written.error}`);
  }
}

/**
 * Migration tu snapshot JSON cua v27.
 *
 * Chap nhan 2 dang snapshot:
 *  - Dang store snapshot: `{ facts: [...], blocks/sharedBlocks: [...] }`
 *    (fact co subject/predicate/object/text/createdAt/validFrom).
 *  - Dang graph edge list: `{ edges: [...] }` (moi edge co
 *    subject/predicate/object + valid_at/invalid_at/created_at).
 * Fact nao da bi dong o v27 (co invalid_at/valid_to) thi duoc
 * nhap vao roi vo hieu ngay — lich su duoc giu nguyen.
 */
export function migrateV27SnapshotToV28(
  snapshot: unknown,
  store: V28Store,
  opts: V28MigrationOptions = {},
): V28Result<V28MigrationReport> {
  const report: V28MigrationReport = {
    source: 'v27-snapshot',
    dryRun: opts.dryRun === true,
    factsImported: 0,
    factsSkipped: 0,
    blocksImported: 0,
    blocksSkipped: 0,
    errors: [],
    notes: [],
  };
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return {
      ok: false,
      error: 'snapshot v27 phai la object JSON (co facts/edges hoac blocks)',
    } as V28Result<V28MigrationReport>;
  }
  const root = snapshot as Record<string, unknown>;
  const factRecords: unknown[] = [
    ...(Array.isArray(root.facts) ? (root.facts as unknown[]) : []),
    ...(Array.isArray(root.edges) ? (root.edges as unknown[]) : []),
  ];
  for (const record of factRecords) {
    const subject = strField(record, 'subject', 'from', 'source');
    const predicate = strField(record, 'predicate', 'relation', 'type');
    const object = strField(record, 'object', 'to', 'target', 'value');
    if (!subject || !predicate || !object) {
      report.factsSkipped += 1;
      report.errors.push(`fact thieu subject/predicate/object: ${JSON.stringify(record).slice(0, 120)}`);
      continue;
    }
    const text = strField(record, 'text', 'sourceText') ?? `${subject} ${predicate} ${object}`;
    const validFrom = strField(record, 'validFrom', 'valid_at', 'createdAt', 'created_at');
    const validTo = strField(record, 'validTo', 'valid_to', 'invalid_at', 'expired_at');
    const wasClosed = validTo !== undefined && parseIsoV28(validTo) !== null;
    const before = report.factsImported;
    migrateOneFact(
      store,
      {
        subject,
        predicate,
        object,
        text,
        confidence: numField(record, 'confidence') ?? 0.8,
        validFrom: validFrom && parseIsoV28(validFrom) !== null ? validFrom : undefined,
        source: 'import',
      },
      report,
      opts,
    );
    // Fact da dong o v27: vo hieu ngay sau khi nhap (giu lich su).
    if (wasClosed && report.factsImported > before && opts.dryRun !== true) {
      const imported = store.facts.searchFacts(text, { limit: 1 })[0];
      if (imported) {
        store.facts.invalidateFact(imported.fact.id, { reason: 'outdated', by: 'migration' });
        report.notes.push(`fact "${text.slice(0, 60)}" da dong o v27 — nhap roi vo hieu ngay.`);
      }
    }
  }

  const blockRecords: unknown[] = [
    ...(Array.isArray(root.blocks) ? (root.blocks as unknown[]) : []),
    ...(Array.isArray(root.sharedBlocks) ? (root.sharedBlocks as unknown[]) : []),
  ];
  for (const record of blockRecords) {
    const label = strField(record, 'label', 'name');
    const content = strField(record, 'content', 'value', 'body');
    if (!label || content === undefined) {
      report.blocksSkipped += 1;
      report.errors.push(`block thieu label/content: ${JSON.stringify(record).slice(0, 120)}`);
      continue;
    }
    migrateOneBlock(
      store,
      label,
      content,
      {
        description: strField(record, 'description'),
        kind: 'shared',
        scope: 'shared',
      },
      report,
      opts,
    );
  }
  report.notes.push(
    `migration v27: ${report.factsImported} fact, ${report.blocksImported} block (bo qua ${report.factsSkipped} fact, ${report.blocksSkipped} block).`,
  );
  return { ok: true, value: report };
}

/**
 * Migration tu thu muc MemFS-lite (v0.96).
 *
 * Doc `<dir>/memory-blocks/*.md` (frontmatter + body) -> block
 * git v28; doc `<dir>/longterm-facts.md` (moi section `## key`
 * la 1 fact) -> fact v28. File khong dung dang thi ghi loi
 * va bo qua file do.
 */
export function migrateMemFsDirToV28(
  memFsDir: string,
  store: V28Store,
  opts: V28MigrationOptions = {},
): V28Result<V28MigrationReport> {
  const report: V28MigrationReport = {
    source: 'memfs-lite',
    dryRun: opts.dryRun === true,
    factsImported: 0,
    factsSkipped: 0,
    blocksImported: 0,
    blocksSkipped: 0,
    errors: [],
    notes: [],
  };
  if (!existsSync(memFsDir)) {
    return { ok: false, error: `khong co thu muc MemFS-lite: "${memFsDir}"` } as V28Result<V28MigrationReport>;
  }
  const blocksDir = join(memFsDir, 'memory-blocks');
  if (existsSync(blocksDir)) {
    for (const file of readdirSync(blocksDir)) {
      if (!file.endsWith('.md')) continue;
      const label = basename(file, '.md');
      try {
        const text = readFileSync(join(blocksDir, file), 'utf8');
        const { data, body } = parseV28Frontmatter(text);
        const content = body.replace(/\n$/, '');
        if (!content.trim()) {
          report.blocksSkipped += 1;
          report.notes.push(`block "${label}" rong — bo qua.`);
          continue;
        }
        migrateOneBlock(
          store,
          label,
          content,
          {
            description: typeof data.description === 'string' ? data.description : '',
            kind: 'note',
            scope: 'user',
          },
          report,
          opts,
        );
      } catch (error) {
        report.blocksSkipped += 1;
        report.errors.push(`doc block "${label}" loi: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } else {
    report.notes.push(`khong co thu muc memory-blocks trong "${memFsDir}" — chi migration facts (neu co).`);
  }

  const factsFile = join(memFsDir, 'longterm-facts.md');
  if (existsSync(factsFile)) {
    const text = readFileSync(factsFile, 'utf8');
    for (const section of parseMemFsFactSections(text)) {
      if (!section.key.trim() || !section.body.trim()) {
        report.factsSkipped += 1;
        continue;
      }
      migrateOneFact(
        store,
        {
          subject: 'user',
          predicate: 'knows',
          object: section.key.trim(),
          text: section.body.trim(),
          confidence: 0.7,
          source: 'import',
        },
        report,
        opts,
      );
    }
  }
  report.notes.push(
    `migration MemFS-lite: ${report.factsImported} fact, ${report.blocksImported} block (bo qua ${report.factsSkipped} fact, ${report.blocksSkipped} block).`,
  );
  return { ok: true, value: report };
}

/** Tach longterm-facts.md thanh cac section `## key` + body. */
export function parseMemFsFactSections(text: string): Array<{ key: string; body: string }> {
  const sections: Array<{ key: string; body: string }> = [];
  let current: { key: string; body: string } | null = null;
  for (const line of text.split('\n')) {
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      if (current) sections.push(current);
      current = { key: (heading[1] ?? '').trim(), body: '' };
      continue;
    }
    if (current) current.body += `${line}\n`;
  }
  if (current) sections.push(current);
  return sections.map((s) => ({ key: s.key, body: s.body.trim() }));
}
