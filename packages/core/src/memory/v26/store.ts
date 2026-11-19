/**
 * Memory v26 — store (v1.41, Doi T1).
 *
 * Diem vao duy nhat cho pipeline + tools: gom registry (shared
 * block + audit + conflict), budget manager, archival store,
 * template registry, quota manager.
 *
 * Luu/load JSON xuong thu muc workspace (ghi atomic qua file tam
 * + rename, ke thua pattern v25). Khong co ham xoa vat ly:
 * block chi revert version, audit/conflict chi them, archive
 * chi prune khi goi ro rang.
 *
 * Chay 100% local, chi dung node:fs/node:path.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { V25SharedBlockStore } from '../v25/sharedBlocks';
import {
  isoAtV25,
  type V25SharedBlock,
} from '../v25/types';
import { V26ArchiveStore } from './archival';
import { V26BudgetManager, planCurateV26 } from './budget';
import { V26ConflictStore } from './conflicts';
import { V26BlockRegistry } from './registry';
import { V26TemplateRegistry } from './templates';
import { V26QuotaManager } from './quota';
import {
  errV26,
  estimateTokensV26,
  okV26,
  type V26ArchiveKind,
  type V26BlockKind,
  type V26BotQuota,
  type V26CurateReport,
  type V26Health,
  type V26Result,
  type V26Stats,
  type V26StoreSnapshot,
} from './types';

/** Ten file luu store trong workspace dir. */
export const V26_STORE_FILENAME = 'memory-v26-store.json';

/** Store memory v26 — diem vao duy nhat cho pipeline + tools. */
export class V26Store {
  readonly registry: V26BlockRegistry;
  readonly conflicts: V26ConflictStore;
  readonly budgets: V26BudgetManager;
  readonly archive: V26ArchiveStore;
  readonly templates: V26TemplateRegistry;
  readonly quota: V26QuotaManager;
  private readonly curations: V26CurateReport[] = [];

  constructor(opts: { blocks?: V25SharedBlockStore } = {}) {
    this.conflicts = new V26ConflictStore();
    this.registry = new V26BlockRegistry(opts.blocks, this.conflicts);
    this.budgets = new V26BudgetManager();
    this.archive = new V26ArchiveStore();
    this.templates = new V26TemplateRegistry();
    this.quota = new V26QuotaManager();
  }

  // -- block shortcuts ---------------------------------------------------------

  /** Tat ca block hien co (de tinh quota / budget / render). */
  listBlocks(): V25SharedBlock[] {
    return this.registry.blocks.toJSON();
  }

  // -- curation ------------------------------------------------------------------

  /**
   * Curate 1 block neu vuot budget (onExceed='curate').
   *
   * Quy trinh: luu tru version cu (archive 'block-version') +
   * dua phan bi loai vao archive 'curated-out' + ghi block moi
   * (summary) + audit 'curate' + ghi bao cao curation.
   * Neu block chua vuot budget hoac onExceed='warn' thi khong
   * ghi, tra bao cao applied=false.
   */
  curateBlock(
    blockId: string,
    byBotId: string,
    opts: { nowMs?: number; reason?: string } = {},
  ): V26Result<V26CurateReport> {
    const block = this.registry.blocks.get(blockId);
    if (!block) return errV26(`Khong co block "${blockId}".`);
    const budget = this.budgets.getBudget(blockId);
    if (!budget || budget.maxTokens <= 0) {
      return errV26(`Block "${block.label}" chua dat budget token — dat budget truoc (memory_v26_budget).`);
    }
    const nowMs = opts.nowMs ?? Date.now();
    const status = this.budgets.status(blockId, block.label, block.value);
    if (status.status !== 'over') {
      const report: V26CurateReport = {
        blockId,
        label: block.label,
        at: isoAtV25(nowMs),
        by: byBotId,
        fromVersion: block.version,
        toVersion: block.version,
        originalTokens: status.tokens,
        summaryTokens: status.tokens,
        tokensSaved: 0,
        itemsTotal: 0,
        itemsKept: 0,
        applied: false,
        reason: `block moi dung ${status.tokens}/${budget.maxTokens} token, chua vuot budget`,
      };
      return okV26(report);
    }
    if (budget.onExceed !== 'curate') {
      return errV26(
        `Block "${block.label}" vuot budget (${status.tokens}/${budget.maxTokens} token) nhung onExceed='warn' — doi onExceed='curate' hoac curate tay bang cach ghi value tom tat.`,
      );
    }
    const { report, summary, dropped } = planCurateV26(
      blockId,
      block.label,
      block.value,
      block.version,
      budget,
      byBotId,
      nowMs,
    );
    if (!report.applied) return okV26(report);
    // Luu tru version cu truoc khi ghi de (khong mat du lieu).
    this.archive.archiveBlockVersion(blockId, block.label, block.version, block.value, byBotId, {
      nowMs,
      note: `version ${block.version} truoc khi curate (vuot budget ${budget.maxTokens} token)`,
    });
    if (dropped.length > 0) {
      this.archive.add({
        kind: 'curated-out',
        sourceBlockId: blockId,
        sourceLabel: block.label,
        content: dropped.join('\n'),
        at: isoAtV25(nowMs),
        by: byBotId,
        note: `phan bi loai khi curate block "${block.label}" v${block.version} -> v${block.version + 1}`,
        version: block.version,
      });
    }
    const written = this.registry.write(blockId, summary.summary, byBotId, {
      nowMs,
      action: 'curate',
      reason: opts.reason ?? report.reason,
    });
    if (!written.ok) return errV26(written.error);
    const finalReport: V26CurateReport = { ...report, toVersion: written.value.block.version };
    this.curations.push(finalReport);
    return okV26(finalReport);
  }

  /** Lich su curate (moi nhat truoc). */
  listCurations(filter: { blockId?: string; limit?: number } = {}): V26CurateReport[] {
    const out = [...this.curations].reverse();
    const filtered = filter.blockId !== undefined ? out.filter((c) => c.blockId === filter.blockId) : out;
    if (filter.limit !== undefined) return filtered.slice(0, Math.max(0, filter.limit));
    return filtered;
  }

  // -- export / import block -----------------------------------------------------

  /** Export 1 block (block + registry + audit + archive cua block) ra JSON. */
  exportBlock(blockId: string): V26Result<string> {
    const block = this.registry.blocks.get(blockId);
    if (!block) return errV26(`Khong co block "${blockId}".`);
    const entry = this.registry.getEntry(blockId);
    const payload = {
      format: 'open-bot-memory-v26-block',
      version: 26,
      exportedAt: isoAtV25(Date.now()),
      block,
      registry: entry ?? null,
      audit: this.registry.auditForBlock(blockId),
      archive: this.archive.list({ sourceBlockId: blockId }),
      budget: this.budgets.getBudget(blockId) ?? null,
    };
    return okV26(JSON.stringify(payload, null, 2));
  }

  /**
   * Import block tu JSON da export (hoac viet tay dung format).
   * Label trung trong cung scope thi doi label thanh
   * `<label>-import-<so>` de khong de len block cu. Tra block moi.
   */
  importBlock(jsonText: string, byBotId: string, opts: { nowMs?: number } = {}): V26Result<V25SharedBlock> {
    let payload: unknown;
    try {
      payload = JSON.parse(jsonText) as unknown;
    } catch {
      return errV26('JSON import khong hop le.');
    }
    if (!payload || typeof payload !== 'object') return errV26('JSON import khong hop le.');
    const raw = payload as { format?: string; block?: Partial<V25SharedBlock> };
    if (raw.format !== 'open-bot-memory-v26-block') {
      return errV26('JSON khong phai format open-bot-memory-v26-block.');
    }
    const src = raw.block;
    if (!src || typeof src.label !== 'string' || typeof src.value !== 'string') {
      return errV26('JSON import thieu block.label/value.');
    }
    const scope = src.scope ?? { userId: '', agentId: '', runId: '', appId: '' };
    let label = src.label.trim().toLowerCase();
    let suffix = 0;
    while (this.registry.blocks.getByLabel(label, scope)) {
      suffix++;
      label = `${src.label.trim().toLowerCase()}-import-${suffix}`;
      if (label.length > 64) label = label.slice(0, 64);
    }
    const created = this.registry.create(
      {
        label,
        description: src.description ?? '',
        value: src.value,
        ownerBotId: byBotId,
        kind: 'custom',
        scope,
        readOnly: false,
        maxChars: src.maxChars ?? 0,
      },
      opts,
    );
    if (!created.ok) return errV26(created.error);
    this.registry.recordAudit({
      blockId: created.value.block.id,
      label,
      action: 'imported',
      by: byBotId,
      at: isoAtV25(opts.nowMs ?? Date.now()),
      fromVersion: 0,
      toVersion: created.value.block.version,
      oldValue: '',
      newValue: created.value.block.value,
      reason: `import block "${src.label}" (label goc)`,
      conflictId: '',
    });
    return okV26(created.value.block);
  }

  // -- stats / health ------------------------------------------------------------

  /** Thong ke store. */
  stats(): V26Stats {
    const blocks = this.listBlocks();
    const blocksByKind: Record<V26BlockKind, number> = {
      human: 0, persona: 0, task: 0, project: 0, custom: 0,
    };
    let attachedTotal = 0;
    let over = 0;
    let warn = 0;
    for (const b of blocks) {
      const entry = this.registry.getEntry(b.id);
      if (entry) blocksByKind[entry.kind]++;
      else blocksByKind.custom++;
      attachedTotal += b.attachedBotIds.length;
      const st = this.budgets.status(b.id, b.label, b.value);
      if (st.status === 'over') over++;
      if (st.status === 'warn') warn++;
    }
    const conflicts = this.conflicts.countByStatus();
    const archivedByKind = this.archive.countByKind();
    const templates = this.templates.list();
    return {
      blocksTotal: blocks.length,
      blocksByKind,
      blocksWithOpenConflict: this.registry.list({ hasOpenConflict: true }).length,
      attachedTotal,
      auditTotal: this.registry.auditSize,
      conflictsTotal: conflicts.total,
      conflictsOpen: conflicts.open,
      conflictsResolved: conflicts.resolved,
      archivedTotal: this.archive.size,
      archivedByKind,
      templatesTotal: templates.length,
      templatesBuiltin: templates.filter((t) => t.builtin).length,
      curationsTotal: this.curations.length,
      tokensSavedByCuration: this.curations.reduce((sum, c) => sum + c.tokensSaved, 0),
      blocksOverBudget: over,
      blocksWarnBudget: warn,
    };
  }

  /** Health check: block vuot budget, xung dot mo, block mo coi. */
  health(): V26Health[] {
    const out: V26Health[] = [];
    const blocks = this.listBlocks();
    let over = 0;
    let warn = 0;
    for (const b of blocks) {
      const st = this.budgets.status(b.id, b.label, b.value);
      if (st.status === 'over') over++;
      if (st.status === 'warn') warn++;
      if (b.attachedBotIds.length === 0) {
        out.push({ severity: 'warn', code: 'orphan-block', detail: `Block "${b.label}" khong co bot nao attach (owner la ${b.ownerBotId} nhung khong co trong attachedBotIds).` });
      }
    }
    if (over > 0) out.push({ severity: 'error', code: 'over-budget', detail: `${over} block vuot budget token.` });
    if (warn > 0) out.push({ severity: 'warn', code: 'warn-budget', detail: `${warn} block gan vuot budget token.` });
    const open = this.conflicts.listOpen();
    if (open.length > 0) {
      out.push({ severity: 'warn', code: 'open-conflict', detail: `${open.length} xung dot chua giai quyet (${open.map((c) => c.label).join(', ')}).` });
    }
    if (out.length === 0) {
      out.push({ severity: 'info', code: 'ok', detail: `Memory v26 khoe: ${blocks.length} block, ${this.archive.size} muc luu tru, 0 xung dot mo.` });
    }
    return out;
  }

  // -- snapshot / persistence ------------------------------------------------------

  /** Snapshot day du de luu JSON. */
  snapshot(): V26StoreSnapshot {
    const reg = this.registry.toJSON();
    return {
      version: 26,
      exportedAt: isoAtV25(Date.now()),
      blocks: reg.blocks,
      registry: reg.registry,
      audit: reg.audit,
      conflicts: this.conflicts.toJSON(),
      archive: this.archive.toJSON(),
      budgets: this.budgets.toJSON(),
      templates: this.templates.toJSON(),
      quota: this.quota.toJSON(),
      curations: [...this.curations],
    };
  }

  /** Khoi phuc store tu snapshot (thieu truong thi dung mac dinh). */
  static fromSnapshot(data: unknown): V26Store {
    const store = new V26Store();
    if (!data || typeof data !== 'object') return store;
    const raw = data as Partial<V26StoreSnapshot>;
    if (Array.isArray(raw.blocks) || Array.isArray(raw.registry) || Array.isArray(raw.audit)) {
      const reg = V26BlockRegistry.fromJSON({
        blocks: raw.blocks ?? [],
        registry: raw.registry ?? [],
        audit: raw.audit ?? [],
      });
      const restored = new V26Store({ blocks: reg.blocks });
      (restored as { registry: V26BlockRegistry }).registry = reg;
      if (Array.isArray(raw.conflicts)) {
        const cs = V26ConflictStore.fromJSON(raw.conflicts);
        (restored as { conflicts: V26ConflictStore }).conflicts = cs;
        (reg as { conflicts: V26ConflictStore }).conflicts = cs;
      }
      if (Array.isArray(raw.archive)) {
        (restored as { archive: V26ArchiveStore }).archive = V26ArchiveStore.fromJSON(raw.archive);
      }
      if (Array.isArray(raw.budgets)) {
        (restored as { budgets: V26BudgetManager }).budgets = V26BudgetManager.fromJSON(raw.budgets);
      }
      if (Array.isArray(raw.templates)) {
        (restored as { templates: V26TemplateRegistry }).templates = V26TemplateRegistry.fromJSON(raw.templates);
      }
      if (raw.quota) {
        (restored as { quota: V26QuotaManager }).quota = V26QuotaManager.fromJSON(raw.quota);
      }
      if (Array.isArray(raw.curations)) {
        for (const c of raw.curations) {
          if (c && typeof c.blockId === 'string') restored.curations.push(c);
        }
      }
      return restored;
    }
    return store;
  }

  /** Luu snapshot xuong workspace dir (atomic: file tam + rename). */
  saveToDir(dir: string): V26Result<string> {
    try {
      mkdirSync(dir, { recursive: true });
      const path = join(dir, V26_STORE_FILENAME);
      const tmp = `${path}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(this.snapshot(), null, 2), 'utf8');
      renameSync(tmp, path);
      return okV26(path);
    } catch (e) {
      return errV26(`Khong luu duoc store v26: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Tong token uoc luong cua tat ca block (de bao cao). */
  totalTokens(): number {
    let total = 0;
    for (const b of this.listBlocks()) total += estimateTokensV26(b.value);
    return total;
  }
}

/** Load store tu workspace dir (file khong co / hong thi store rong). */
export function loadV26StoreFromDir(dir: string): V26Result<V26Store> {
  const path = join(dir, V26_STORE_FILENAME);
  if (!existsSync(path)) return okV26(new V26Store());
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || (raw as { version?: number }).version !== 26) {
      return errV26(`File ${V26_STORE_FILENAME} khong phai snapshot memory v26.`);
    }
    return okV26(V26Store.fromSnapshot(raw));
  } catch (e) {
    return errV26(`Khong doc duoc store v26: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Kiem tra 1 archive entry co phai loai block-version khong. */
export function isBlockVersionArchiveV26(kind: V26ArchiveKind): boolean {
  return kind === 'block-version';
}
