/**
 * Memory v21 tools for @open-bot/tools (v1.29, Doi T1).
 *
 * Agent lam viec voi portable memory bang tool call:
 *  - memory_v21_export      — xuat record ra bundle OKF / MemFS / OpenHands (ghi file, needsApproval: true)
 *  - memory_v21_import      — nhap bundle tu thu muc (dryRun de xem truoc, needsApproval: true khi ghi that)
 *  - memory_v21_convert     — convert text giua cac format + bao cao mat mat (read)
 *  - memory_v21_validate    — validate text hoac bundle, bao loi ro theo path/code (read)
 *  - memory_v21_sync        — sync 3 chieu base/local/remote tu snapshot JSON, giai quyet conflict (needsApproval: true)
 *  - memory_v21_tombstone   — xoa (ghi tombstone) / khoi phuc / liet ke tombstone (needsApproval: true)
 *  - memory_v21_version     — lich su / diff / rollback / tom tat version cua record (needsApproval: true khi rollback)
 *  - memory_v21_sleep       — chay pass consolidation xuyen session (v20 + v21) (needsApproval: true)
 *  - memory_v21_record      — CRUD record portable trong store (needsApproval: true khi ghi)
 *  - memory_v21_bundle_info — nhan dang format + tom tat bundle trong thu muc (read)
 *
 * SAFETY: moi ghi file deu qua store/format co validation; xoa chi
 * ghi tombstone (khong mat audit); convert khong bao gio am tham
 * mat field — bao cao loss day du, strict mode fail khi co mat
 * mat. Khong goi model that, khong goi API ngoai.
 *
 * Factory:
 *   createMemoryV21Tools(opts) -> Tool[]   (bound, usable)
 *   MEMORY_V21_TOOLS                       (unbound placeholder)
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool } from '@open-bot/core';
import {
  V20CoreBlockStore,
  V21CrossSessionConsolidator,
  V21MemfsStore,
  V21RecordStore,
  V21TombstoneStore,
  applySyncV21,
  convertBundleV21,
  createTombstoneV21,
  detectFormatV21,
  formatValidationIssuesV21,
  isSupportedFormatV21,
  parseMemfsFileV21,
  parseOkfBundleV21,
  parseOpenHandsBundleV21,
  recordToOkfV21,
  recordsToOpenHandsCuratedV21,
  snapshotOfRecordV21,
  validateMemfsTextV21,
  validateOkfTextV21,
  validateRecordBundleV21,
  type V21PortableFormat,
  type V21PortableRecord,
  type V21SyncSnapshotMap,
} from '@open-bot/core';

export interface MemoryV21ToolOptions {
  recordStore?: V21RecordStore;
  tombstoneStore?: V21TombstoneStore;
  blockStore?: V20CoreBlockStore;
  consolidator?: V21CrossSessionConsolidator;
  /** Thu muc mac dinh cho export/import khi tool khong truyen dir. */
  workspaceDir?: string;
  botId?: string;
}

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function toolDef(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Tool['definition'] {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  };
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getOptionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a number, got ${typeof value}`);
  }
  return value;
}

function getBoolArg(args: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean, got ${typeof value}`);
  }
  return value;
}

function getJsonArg<T>(args: Record<string, unknown>, name: string, required = true): T | undefined {
  const raw = getOptionalStringArg(args, name);
  if (raw === undefined) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Argument "${name}" phai la JSON hop le`);
  }
}

function getStringListArg(args: Record<string, unknown>, name: string): string[] | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new Error(`Argument "${name}" phai la danh sach chuoi`);
  }
  return [...(value as string[])];
}

function listMarkdownFilesV21(dir: string): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  if (!existsSync(dir)) return out;
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        out.push({ path: full, content: readFileSync(full, 'utf8') });
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function snapshotMapFromRecordsV21(
  records: (V21PortableRecord & { deleted?: boolean })[],
): V21SyncSnapshotMap {
  const map: V21SyncSnapshotMap = new Map();
  for (const record of records) {
    map.set(record.id, snapshotOfRecordV21(record, record.deleted ?? false));
  }
  return map;
}

export function createMemoryV21Tools(opts: MemoryV21ToolOptions = {}): Tool[] {
  const recordStore = opts.recordStore ?? new V21RecordStore();
  const tombstoneStore = opts.tombstoneStore ?? new V21TombstoneStore();
  const blockStore = opts.blockStore ?? new V20CoreBlockStore();
  const consolidator = opts.consolidator ?? new V21CrossSessionConsolidator();
  const workspaceDir = opts.workspaceDir ?? '';
  const defaultBotId = opts.botId;

  const actorOf = (ctx?: { botId?: string }): string => {
    const botId = ctx?.botId ?? defaultBotId;
    return botId ? `agent:${botId}` : 'user';
  };

  const resolveDir = (args: Record<string, unknown>): string => {
    const dir = getOptionalStringArg(args, 'dir') ?? workspaceDir;
    if (!dir) throw new Error('Can thu muc "dir" (hoac workspaceDir khi tao tools).');
    return dir;
  };

  const exportTool: Tool = {
    definition: toolDef(
      'memory_v21_export',
      'Xuat record portable ra bundle OKF (Markdown+YAML), MemFS (git-backed blocks) hoac OpenHands (MEMORY.md) tai mot thu muc. Ghi file — can duyet.',
      {
        format: { type: 'string', description: '"okf" | "memfs" | "openhands".' },
        dir: { type: 'string', description: 'Thu muc dich (tuy chon neu da co workspaceDir).' },
        recordIds: { type: 'array', description: 'Chi xuat cac id nay (mac dinh: tat ca).', items: { type: 'string' } },
      },
      ['format'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const formatRaw = getStringArg(args, 'format');
        if (!isSupportedFormatV21(formatRaw)) {
          return errorResult(`format "${formatRaw}" khong ho tro (chi co okf | memfs | openhands).`);
        }
        const format: V21PortableFormat = formatRaw;
        const dir = resolveDir(args);
        const wanted = getStringListArg(args, 'recordIds');
        const records = recordStore
          .list()
          .filter((r) => !wanted || wanted.includes(r.id));
        if (records.length === 0) return 'Khong co record nao de xuat.';
        if (format === 'memfs') {
          const store = new V21MemfsStore(dir);
          let written = 0;
          for (const record of records) {
            const res = store.writeBlock(record, actorOf());
            if (res.ok) written += 1;
          }
          return `Da xuat ${written}/${records.length} record sang MemFS tai ${dir} (manifest + hash da cap nhat).`;
        }
        mkdirSync(dir, { recursive: true });
        if (format === 'okf') {
          for (const record of records) {
            writeFileSync(join(dir, `${record.id}.md`), recordToOkfV21(record), 'utf8');
          }
          return `Da xuat ${records.length} record sang OKF tai ${dir}.`;
        }
        writeFileSync(join(dir, 'MEMORY.md'), recordsToOpenHandsCuratedV21(records), 'utf8');
        return `Da xuat ${records.length} record sang OpenHands MEMORY.md tai ${dir}.`;
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const importTool: Tool = {
    definition: toolDef(
      'memory_v21_import',
      'Nhap bundle memory tu thu muc (OKF / MemFS / OpenHands, tu nhan dang neu khong truyen format). dryRun=true chi xem truoc, khong ghi. Ghi that can duyet.',
      {
        dir: { type: 'string', description: 'Thu muc bundle.' },
        format: { type: 'string', description: '"okf" | "memfs" | "openhands" (mac dinh: tu nhan dang).' },
        dryRun: { type: 'boolean', description: 'Chi xem truoc (mac dinh false).' },
        actor: { type: 'string', description: 'Nguoi nhap (mac dinh agent/user).' },
      },
      ['dir'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const dir = resolveDir(args);
        const dryRun = getBoolArg(args, 'dryRun', false);
        const actor = getOptionalStringArg(args, 'actor') ?? actorOf();
        const formatRaw = getOptionalStringArg(args, 'format');
        let format: V21PortableFormat | undefined;
        if (formatRaw) {
          if (!isSupportedFormatV21(formatRaw)) {
            return errorResult(`format "${formatRaw}" khong ho tro.`);
          }
          format = formatRaw;
        }
        const files = listMarkdownFilesV21(dir);
        if (files.length === 0) return `Thu muc ${dir} khong co file .md nao.`;
        if (!format) {
          format = detectFormatV21(files[0].content, files[0].path) ?? 'okf';
        }
        let records: V21PortableRecord[] = [];
        const failed: { path: string; error: string }[] = [];
        if (format === 'okf') {
          const parsed = parseOkfBundleV21(files);
          records = parsed.records;
          failed.push(...parsed.failed);
        } else if (format === 'memfs') {
          for (const file of files) {
            const parsed = parseMemfsFileV21(file.content, file.path);
            if (parsed.ok && parsed.data) records.push(parsed.data);
            else failed.push({ path: file.path, error: parsed.error ?? 'loi khong ro' });
          }
        } else {
          const curated = files.find((f) => f.path.endsWith('MEMORY.md'));
          const daily = files
            .filter((f) => f !== curated)
            .map((f) => {
              const name = f.path.split('/').pop() ?? '';
              return { date: name.replace(/\.md$/, ''), content: f.content };
            })
            .filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f.date));
          const parsed = parseOpenHandsBundleV21(curated?.content ?? '', daily);
          if (!parsed.ok || !parsed.data) return errorResult(parsed.error ?? 'loi khong ro');
          records = parsed.data.records;
          failed.push(...parsed.data.failed.map((x) => ({ path: x.date, error: x.error })));
        }
        const validation = validateRecordBundleV21(records);
        if (dryRun) {
          const lines = [
            `[dry-run] format ${format}: ${records.length} record hop le, ${failed.length} file loi, validation ${validation.errorCount} loi / ${validation.warningCount} canh bao.`,
          ];
          for (const f of failed) lines.push(`  - LOI ${f.path}: ${f.error}`);
          if (!validation.ok) lines.push(formatValidationIssuesV21(validation));
          return lines.join('\n');
        }
        let imported = 0;
        let skipped = 0;
        for (const record of records) {
          const existing = recordStore.get(record.id);
          if (existing) {
            recordStore.update(
              record.id,
              {
                type: record.type,
                title: record.title,
                body: record.body,
                tags: record.tags,
                sources: record.sources,
                verified: record.verified,
                staleAfter: record.staleAfter,
                codeRefs: record.codeRefs,
              },
              actor,
              'import',
            );
            imported += 1;
          } else {
            const created = recordStore.create(record, actor, 'import');
            if (created.ok) imported += 1;
            else skipped += 1;
          }
        }
        const lines = [`Da nhap ${imported} record (${format}) tu ${dir}, bo qua ${skipped}, ${failed.length} file loi.`];
        for (const f of failed) lines.push(`  - LOI ${f.path}: ${f.error}`);
        return lines.join('\n');
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const convertTool: Tool = {
    definition: toolDef(
      'memory_v21_convert',
      'Convert mot bundle giua OKF / MemFS / OpenHands. Tra ve file da convert + bao cao field bi mat (khong am tham). strict=true se fail khi co mat mat.',
      {
        from: { type: 'string', description: '"okf" | "memfs" | "openhands".' },
        to: { type: 'string', description: '"okf" | "memfs" | "openhands".' },
        files: { type: 'string', description: 'JSON: [{path, content}] — cac file nguon.' },
        strict: { type: 'boolean', description: 'Fail khi co field bi mat (mac dinh false).' },
      },
      ['from', 'to', 'files'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const fromRaw = getStringArg(args, 'from');
        const toRaw = getStringArg(args, 'to');
        if (!isSupportedFormatV21(fromRaw) || !isSupportedFormatV21(toRaw)) {
          return errorResult('from/to phai la okf | memfs | openhands.');
        }
        const files = getJsonArg<{ path: string; content: string }[]>(args, 'files') ?? [];
        const out = convertBundleV21({ format: fromRaw, files }, toRaw, {
          strict: getBoolArg(args, 'strict', false),
        });
        const lines = [
          `Convert ${fromRaw} -> ${toRaw}: ${out.report.recordsConverted} record, ${out.report.recordsSkipped} bo qua, ${out.failed.length} file loi.`,
        ];
        if (out.report.fieldsDropped.length > 0) {
          lines.push(`Field bi mat: ${out.report.fieldsDropped.join(', ')}`);
        }
        for (const w of out.report.warnings) lines.push(`  - ${w}`);
        for (const f of out.failed) lines.push(`  - LOI ${f.path}: ${f.error}`);
        lines.push('--- files ---');
        for (const file of out.files) lines.push(`### ${file.path}\n${file.content}`);
        return lines.join('\n');
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const validateTool: Tool = {
    definition: toolDef(
      'memory_v21_validate',
      'Validate mot document (text) hoac mot bundle trong thu muc theo format. Tra ve loi/canh bao co path + code cu the.',
      {
        text: { type: 'string', description: 'Noi dung document can validate (dung chung voi format).' },
        dir: { type: 'string', description: 'Thu muc bundle can validate (thay cho text).' },
        format: { type: 'string', description: '"okf" | "memfs" | "openhands" (mac dinh okf cho text, tu nhan dang cho dir).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const text = getOptionalStringArg(args, 'text');
        const dir = getOptionalStringArg(args, 'dir');
        if (!text && !dir) return errorResult('Can "text" hoac "dir" de validate.');
        if (text) {
          const formatRaw = getOptionalStringArg(args, 'format') ?? 'okf';
          if (formatRaw === 'memfs') return formatValidationIssuesV21(validateMemfsTextV21(text, 'document'));
          return formatValidationIssuesV21(validateOkfTextV21(text, 'document'));
        }
        const files = listMarkdownFilesV21(dir as string);
        if (files.length === 0) return `Thu muc ${dir} khong co file .md nao.`;
        const format = getOptionalStringArg(args, 'format') ?? detectFormatV21(files[0].content, files[0].path) ?? 'okf';
        if (format === 'okf') {
          const parsed = parseOkfBundleV21(files);
          const validation = validateRecordBundleV21(parsed.records);
          const lines = [formatValidationIssuesV21(validation)];
          for (const f of parsed.failed) lines.push(`[LOI] ${f.path}: ${f.error}`);
          return lines.join('\n');
        }
        return `Validate bundle ${format}: ${files.length} file .md (chi tiet theo tung file chua ho tro cho format nay — dung memory_v21_convert de xem loi parse).`;
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const syncTool: Tool = {
    definition: toolDef(
      'memory_v21_sync',
      'Sync memory 3 chieu (base/local/remote) tu snapshot JSON. Phat hien conflict edit/edit, delete/edit, tombstone/edit, version fork; giai quyet theo strategy. Ghi vao store — can duyet.',
      {
        base: { type: 'string', description: 'JSON: snapshot base [{id, type, title, body, tags, sources, codeRefs, version, createdAt, updatedAt, deleted?}].' },
        local: { type: 'string', description: 'JSON: snapshot local (cung dang base).' },
        remote: { type: 'string', description: 'JSON: snapshot remote (cung dang base).' },
        strategy: { type: 'string', description: '"keep_local" | "keep_remote" | "keep_both" | "manual" (mac dinh manual).' },
      },
      ['base', 'local', 'remote'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const base = snapshotMapFromRecordsV21(getJsonArg<(V21PortableRecord & { deleted?: boolean })[]>(args, 'base') ?? []);
        const local = snapshotMapFromRecordsV21(getJsonArg<(V21PortableRecord & { deleted?: boolean })[]>(args, 'local') ?? []);
        const remote = snapshotMapFromRecordsV21(getJsonArg<(V21PortableRecord & { deleted?: boolean })[]>(args, 'remote') ?? []);
        const strategyRaw = getOptionalStringArg(args, 'strategy') ?? 'manual';
        if (!['keep_local', 'keep_remote', 'keep_both', 'manual'].includes(strategyRaw)) {
          return errorResult(`strategy "${strategyRaw}" khong hop le.`);
        }
        const { report, toApply, toCreateRenamed, pendingConflicts } = applySyncV21({
          base,
          local,
          remote,
          defaultStrategy: strategyRaw as 'keep_local' | 'keep_remote' | 'keep_both' | 'manual',
        });
        const actor = actorOf();
        for (const [id, record] of toApply) {
          if (recordStore.get(id)) recordStore.update(id, { ...record }, actor, 'sync');
          else recordStore.create(record, actor, 'sync');
        }
        for (const [id, record] of toCreateRenamed) {
          recordStore.create(record, actor, 'sync');
        }
        for (const id of report.deletedByTombstone) {
          const current = recordStore.get(id);
          if (current) {
            recordStore.delete(id, actor, 'sync: remote da xoa');
            tombstoneStore.create(current, actor, 'sync: remote da xoa', current.originFormat ?? 'okf', current.originPath);
          }
        }
        const lines = [
          `Sync xong: remote ap dung ${report.appliedRemote.length}, tao moi ${report.created.length}, xoa (tombstone) ${report.deletedByTombstone.length}, conflict ${report.conflicts.length} (${pendingConflicts.length} cho xu ly).`,
        ];
        for (const c of report.conflicts) lines.push(`  - CONFLICT ${c.recordId} (${c.kind}): ${c.detail}`);
        return lines.join('\n');
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const tombstoneTool: Tool = {
    definition: toolDef(
      'memory_v21_tombstone',
      'Quan ly tombstone xoa: action "delete" ghi tombstone (khong mat audit), "restore" khoi phuc tu tombstone, "list" liet ke tombstone. Xoa can duyet.',
      {
        action: { type: 'string', description: '"delete" | "restore" | "list".' },
        recordId: { type: 'string', description: 'Id record (can cho delete/restore).' },
        reason: { type: 'string', description: 'Ly do xoa (can cho delete, toi thieu 3 ky tu).' },
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (action === 'list') {
          const list = tombstoneStore.list();
          if (list.length === 0) return 'Khong co tombstone nao.';
          const lines = [`Co ${list.length} tombstone:`];
          for (const t of list) {
            lines.push(`  - ${t.recordId} (v${t.previousVersion}, xoa ${new Date(t.deletedAt).toISOString()} boi ${t.deletedBy}: ${t.reason})`);
          }
          return lines.join('\n');
        }
        const recordId = getStringArg(args, 'recordId');
        if (action === 'delete') {
          const reason = getStringArg(args, 'reason');
          const current = recordStore.get(recordId);
          if (!current) return errorResult(`khong tim thay record "${recordId}".`);
          const tomb = createTombstoneV21(current, actorOf(), reason, current.originFormat ?? 'okf', current.originPath);
          if (!tomb.ok || !tomb.data) return errorResult(tomb.error ?? 'loi khong ro');
          const created = tombstoneStore.create(current, actorOf(), reason, current.originFormat ?? 'okf', current.originPath);
          if (!created.ok) return errorResult(created.error ?? 'loi khong ro');
          recordStore.delete(recordId, actorOf(), reason);
          return `Da xoa "${recordId}" (tombstone v${tomb.data.previousVersion}, co the restore).`;
        }
        if (action === 'restore') {
          const restored = tombstoneStore.restore(recordId, actorOf());
          if (!restored.ok || !restored.data) return errorResult(restored.error ?? 'loi khong ro');
          const snapshot = restored.data;
          const created = recordStore.getIncludingDeleted(recordId)
            ? recordStore.restore(recordId, actorOf())
            : recordStore.create({ ...snapshot, version: 1 }, actorOf(), 'restore');
          if (!created.ok) return errorResult(created.error ?? 'loi khong ro');
          return `Da khoi phuc "${recordId}" tu tombstone (v${created.data?.version ?? 1}).`;
        }
        return errorResult(`action "${action}" khong hop le (chi co delete | restore | list).`);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const versionTool: Tool = {
    definition: toolDef(
      'memory_v21_version',
      'Version cua record: action "history" (lich su), "diff" (so 2 version theo dong), "rollback" (ve version cu, tao version moi), "summary" (tom tat). Rollback can duyet.',
      {
        action: { type: 'string', description: '"history" | "diff" | "rollback" | "summary".' },
        recordId: { type: 'string', description: 'Id record.' },
        fromVersion: { type: 'number', description: 'Version nguon (cho diff).' },
        toVersion: { type: 'number', description: 'Version dich (cho diff/rollback).' },
        reason: { type: 'string', description: 'Ly do rollback (toi thieu 3 ky tu).' },
      },
      ['action', 'recordId'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const recordId = getStringArg(args, 'recordId');
        if (action === 'history') {
          const history = recordStore.listVersions(recordId);
          if (history.length === 0) return `Record "${recordId}" khong co lich su version.`;
          const lines = [`Lich su "${recordId}" (${history.length} version):`];
          for (const v of history) {
            lines.push(`  - v${v.version} [${v.change}] ${new Date(v.at).toISOString()} boi ${v.by}: ${v.summary}`);
          }
          return lines.join('\n');
        }
        if (action === 'summary') {
          const summary = recordStore.summary(recordId);
          if (!summary) return `Record "${recordId}" khong co lich su version.`;
          return `Record "${recordId}": hien tai v${summary.currentVersion}, ${summary.totalVersions} version, sua cuoi ${new Date(summary.lastAt).toISOString()} boi ${summary.lastBy} (${summary.lastChange}: ${summary.lastSummary}), da xoa: ${summary.deleted ? 'co' : 'khong'}.`;
        }
        if (action === 'diff') {
          const fromVersion = getNumberArg(args, 'fromVersion');
          const toVersion = getNumberArg(args, 'toVersion');
          if (fromVersion === undefined || toVersion === undefined) {
            return errorResult('diff can fromVersion va toVersion.');
          }
          const diff = recordStore.diffVersions(recordId, fromVersion, toVersion);
          if (!diff.ok || !diff.data) return errorResult(diff.error ?? 'loi khong ro');
          const lines = [
            `Diff "${recordId}" v${fromVersion} -> v${toVersion}: +${diff.data.addedCount} -${diff.data.removedCount} =${diff.data.unchangedCount}`,
          ];
          for (const line of diff.data.lines.slice(0, 100)) {
            const mark = line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' ';
            lines.push(`${mark} ${line.text}`);
          }
          return lines.join('\n');
        }
        if (action === 'rollback') {
          const toVersion = getNumberArg(args, 'toVersion');
          const reason = getStringArg(args, 'reason');
          if (toVersion === undefined) return errorResult('rollback can toVersion.');
          const res = recordStore.rollback(recordId, toVersion, actorOf(), reason);
          if (!res.ok || !res.data) return errorResult(res.error ?? 'loi khong ro');
          return `Da rollback "${recordId}" ve v${toVersion} (hien tai v${res.data.version}).`;
        }
        return errorResult(`action "${action}" khong hop le.`);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const sleepTool: Tool = {
    definition: toolDef(
      'memory_v21_sleep',
      'Chay mot pass consolidation xuyen session: nhan fact tu nhieu session, boost fact lap lai, dedupe/decay/promote vao core block + ghi vao portable store, danh dau stale, xuat OKF neu can. Ghi — can duyet.',
      {
        sessions: { type: 'string', description: 'JSON: [{sessionId, facts: [{text, source, confidence, observedAt}]}].' },
        exportOkf: { type: 'boolean', description: 'Xuat fact da promote ra OKF trong bao cao (mac dinh false).' },
        trigger: { type: 'string', description: '"session_end" | "idle" | "manual" | "scheduled" | "memory_pressure" (mac dinh scheduled).' },
      },
      ['sessions'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const sessions = getJsonArg<{ sessionId: string; facts: { text: string; source: 'chat' | 'tool' | 'import' | 'sleep'; confidence: number; observedAt: number }[] }[]>(args, 'sessions') ?? [];
        const triggerRaw = getOptionalStringArg(args, 'trigger') ?? 'scheduled';
        const trigger = ['session_end', 'idle', 'manual', 'scheduled', 'memory_pressure'].includes(triggerRaw)
          ? (triggerRaw as 'session_end' | 'idle' | 'manual' | 'scheduled' | 'memory_pressure')
          : 'scheduled';
        const intake = consolidator.addSessionFacts(sessions);
        const report = consolidator.runCrossSessionPass(blockStore, recordStore, {
          exportOkf: getBoolArg(args, 'exportOkf', false),
          trigger,
        });
        const lines = [
          `Sleep v21 xong (${report.jobId}): nhan ${intake.received} fact tu ${report.sessionsSeen} session (boost ${intake.boosted}), dedupe gop ${report.duplicatesMerged}, decay ${report.factsDecayed}, prune ${report.factsPruned}, promote ${report.factsPromoted} vao block.`,
          `Xuyen session: ${report.crossSessionFacts} fact gap o >= 2 session; stale: ${report.staleMarked.length} record (${report.staleMarked.join(', ') || 'khong co'}).`,
        ];
        if (report.exportedOkfFiles.length > 0) {
          lines.push(`Xuat OKF: ${report.exportedOkfFiles.join(', ')}`);
        }
        if (report.skipped.length > 0) lines.push(`Bo qua: ${report.skipped.join(' | ')}`);
        if (report.errors.length > 0) lines.push(`Loi: ${report.errors.join(' | ')}`);
        return lines.join('\n');
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const recordTool: Tool = {
    definition: toolDef(
      'memory_v21_record',
      'CRUD record portable trong store: action "create" (truyen record JSON), "get", "list", "update" (truyen patch JSON). Ghi can duyet.',
      {
        action: { type: 'string', description: '"create" | "get" | "list" | "update".' },
        recordId: { type: 'string', description: 'Id record (cho get/update).' },
        record: { type: 'string', description: 'JSON record day du (cho create).' },
        patch: { type: 'string', description: 'JSON patch (cho update).' },
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (action === 'list') {
          const list = recordStore.list();
          if (list.length === 0) return 'Store dang rong.';
          const lines = [`Co ${list.length} record:`];
          for (const r of list) lines.push(`  - ${r.id} [${r.type}] v${r.version}: ${r.title}`);
          return lines.join('\n');
        }
        if (action === 'create') {
          const record = getJsonArg<V21PortableRecord>(args, 'record');
          if (!record) return errorResult('create can "record" JSON.');
          const res = recordStore.create(record, actorOf());
          if (!res.ok || !res.data) return errorResult(res.error ?? 'loi khong ro');
          return `Da tao record "${res.data.id}" v${res.data.version}.`;
        }
        const recordId = getStringArg(args, 'recordId');
        if (action === 'get') {
          const found = recordStore.get(recordId);
          if (!found) return errorResult(`khong tim thay record "${recordId}".`);
          return JSON.stringify(found, null, 2);
        }
        if (action === 'update') {
          const patch = getJsonArg<Partial<V21PortableRecord>>(args, 'patch');
          if (!patch) return errorResult('update can "patch" JSON.');
          const res = recordStore.update(recordId, patch, actorOf());
          if (!res.ok || !res.data) return errorResult(res.error ?? 'loi khong ro');
          return `Da cap nhat record "${res.data.id}" len v${res.data.version}.`;
        }
        return errorResult(`action "${action}" khong hop le.`);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const bundleInfoTool: Tool = {
    definition: toolDef(
      'memory_v21_bundle_info',
      'Nhan dang format + tom tat bundle trong thu muc: so file, format doan duoc, so record parse duoc / loi (chi doc).',
      {
        dir: { type: 'string', description: 'Thu muc bundle.' },
      },
      ['dir'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const dir = resolveDir(args);
        const files = listMarkdownFilesV21(dir);
        if (files.length === 0) return `Thu muc ${dir} khong co file .md nao.`;
        const format = detectFormatV21(files[0].content, files[0].path);
        const lines = [`Bundle ${dir}: ${files.length} file .md, format doan duoc: ${format ?? 'khong ro'}.`];
        if (format === 'okf') {
          const parsed = parseOkfBundleV21(files);
          lines.push(`Parse duoc ${parsed.records.length} record, ${parsed.failed.length} file loi.`);
          for (const f of parsed.failed) lines.push(`  - LOI ${f.path}: ${f.error}`);
        } else if (format === 'memfs') {
          const store = new V21MemfsStore(dir);
          const issues = store.verifyIntegrity();
          lines.push(`MemFS: ${store.listBlocks().length} block, ${store.listTombstones().length} tombstone, ${issues.length} van de toan ven.`);
          for (const issue of issues) lines.push(`  - ${issue.kind} ${issue.id}: ${issue.detail}`);
        }
        return lines.join('\n');
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  return [
    exportTool,
    importTool,
    convertTool,
    validateTool,
    syncTool,
    tombstoneTool,
    versionTool,
    sleepTool,
    recordTool,
    bundleInfoTool,
  ];
}

/** Ten tool memory v21 (thu tu nhu createMemoryV21Tools tra ve). */
export const MEMORY_V21_TOOL_NAMES = [
  'memory_v21_export',
  'memory_v21_import',
  'memory_v21_convert',
  'memory_v21_validate',
  'memory_v21_sync',
  'memory_v21_tombstone',
  'memory_v21_version',
  'memory_v21_sleep',
  'memory_v21_record',
  'memory_v21_bundle_info',
] as const;

/**
 * Placeholder (unbound) cua 10 tool memory v21 — nam trong ALL_TOOLS.
 * Goi factory khong co workspaceDir; execute tra loi ro rang thay vi
 * crash, va needsApproval giu dung nhu tool that.
 */
export const MEMORY_V21_TOOLS: Tool[] = createMemoryV21Tools();
