/**
 * Memory v26 — panel view builder (v1.41, Doi T1).
 *
 * Panel la PROJECTION: store so huu du lieu, ham nay chi dong
 * goi snapshot hien thi cho renderer (giong FleetV26MemoryPanel
 * doi voi memory v24): block nao, budget ra sao, xung dot mo
 * nao, audit gan nhat nao — component chi render, khong tu
 * tinh toan. Progressive disclosure: tong quan + canh bao
 * truoc, chi tiet block/audit sau toggle mo rong.
 *
 * Chay 100% local, khong goi model/mang.
 */
import { estimateTokensV26 } from './types';
import type { V26Store } from './store';

/** 1 dong block trong panel. */
export interface V26PanelBlockRow {
  id: string;
  label: string;
  kind: string;
  ownerBotId: string;
  attachedBotIds: string[];
  version: number;
  tokens: number;
  maxTokens: number;
  budgetStatus: 'ok' | 'warn' | 'over' | 'unlimited';
  readOnly: boolean;
  hasOpenConflict: boolean;
  updatedAt: string;
  updatedBy: string;
  /** Xem truoc value (cat 200 ky tu). */
  preview: string;
}

/** 1 dong xung dot mo trong panel. */
export interface V26PanelConflictRow {
  id: string;
  label: string;
  baseVersion: number;
  currentVersion: number;
  by: string;
  currentBy: string;
  detectedAt: string;
}

/** 1 dong audit gan nhat trong panel. */
export interface V26PanelAuditRow {
  id: string;
  label: string;
  action: string;
  by: string;
  at: string;
  fromVersion: number;
  toVersion: number;
  reason: string;
}

/** 1 dong archival gan nhat trong panel. */
export interface V26PanelArchiveRow {
  id: string;
  kind: string;
  dayKey: string;
  sourceLabel: string;
  preview: string;
}

/** View day du cho MemoryV26Panel. */
export interface V26PanelView {
  /** Tom tat 1 dong. */
  summary: string;
  blocksTotal: number;
  blocksByKind: Record<string, number>;
  blocksOverBudget: number;
  blocksWarnBudget: number;
  conflictsOpen: number;
  auditTotal: number;
  archivedTotal: number;
  templatesTotal: number;
  tokensTotal: number;
  tokensSavedByCuration: number;
  /** Canh bao can xu ly ngay (vuot budget / xung dot mo). */
  alerts: string[];
  /** Block bot nay thay duoc (owner hoac attach). */
  rows: V26PanelBlockRow[];
  /** Block bot nay KHONG thay duoc (chi dem, khong hien noi dung). */
  hiddenBlocks: number;
  openConflicts: V26PanelConflictRow[];
  recentAudit: V26PanelAuditRow[];
  recentArchive: V26PanelArchiveRow[];
  /** Tom tat quota cua bot dang xem. */
  quotaSummary: string;
}

/**
 * Dung view panel cho 1 bot.
 *
 * `botId` rong ('') nghia la xem voi quyen admin: thay tat ca
 * block. Bot thuong chi thay block minh so huu hoac attach —
 * noi dung block cua bot khac khong lo ra panel.
 */
export function buildMemoryV26PanelView(
  store: V26Store,
  botId: string,
  opts: { maxRows?: number; maxAudit?: number; maxArchive?: number } = {},
): V26PanelView {
  const maxRows = opts.maxRows ?? 50;
  const maxAudit = opts.maxAudit ?? 10;
  const maxArchive = opts.maxArchive ?? 10;
  const stats = store.stats();
  const allBlocks = store.listBlocks();
  const visibleEntries = botId
    ? store.registry.listVisibleForBot(botId)
    : store.registry.list({});
  const visibleIds = new Set(visibleEntries.map((e) => e.blockId));
  const rows: V26PanelBlockRow[] = [];
  let tokensTotal = 0;
  for (const block of allBlocks) {
    tokensTotal += estimateTokensV26(block.value);
    if (!visibleIds.has(block.id)) continue;
    const entry = store.registry.getEntry(block.id);
    const st = store.budgets.status(block.id, block.label, block.value);
    rows.push({
      id: block.id,
      label: block.label,
      kind: entry?.kind ?? 'custom',
      ownerBotId: block.ownerBotId,
      attachedBotIds: [...block.attachedBotIds],
      version: block.version,
      tokens: st.tokens,
      maxTokens: st.maxTokens,
      budgetStatus: st.status,
      readOnly: block.readOnly,
      hasOpenConflict: entry?.hasOpenConflict ?? false,
      updatedAt: block.updatedAt,
      updatedBy: entry?.lastUpdatedBy ?? block.ownerBotId,
      preview: block.value.length > 200 ? `${block.value.slice(0, 200)}...` : block.value,
    });
  }
  rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  const alerts: string[] = [];
  const over = rows.filter((r) => r.budgetStatus === 'over');
  const warn = rows.filter((r) => r.budgetStatus === 'warn');
  const openConflicts = store.conflicts.listOpen();
  if (over.length > 0) {
    alerts.push(`${over.length} block vuot budget token: ${over.map((r) => r.label).join(', ')} — curate ngay.`);
  }
  if (warn.length > 0) {
    alerts.push(`${warn.length} block gan vuot budget: ${warn.map((r) => r.label).join(', ')}.`);
  }
  if (openConflicts.length > 0) {
    alerts.push(`${openConflicts.length} xung dot chua giai quyet: ${openConflicts.map((c) => c.label).join(', ')} — can resolve.`);
  }
  const quota = botId ? store.quota.usage(botId, allBlocks) : null;
  return {
    summary:
      `Memory v26: ${stats.blocksTotal} block (${rows.length} ban thay duoc), ` +
      `${stats.archivedTotal} muc luu tru, ${stats.conflictsOpen} xung dot mo, ` +
      `${stats.auditTotal} muc audit, ~${tokensTotal} token (estimate), ` +
      `tiet kiem ${stats.tokensSavedByCuration} token nho curate`,
    blocksTotal: stats.blocksTotal,
    blocksByKind: { ...stats.blocksByKind },
    blocksOverBudget: stats.blocksOverBudget,
    blocksWarnBudget: stats.blocksWarnBudget,
    conflictsOpen: stats.conflictsOpen,
    auditTotal: stats.auditTotal,
    archivedTotal: stats.archivedTotal,
    templatesTotal: stats.templatesTotal,
    tokensTotal,
    tokensSavedByCuration: stats.tokensSavedByCuration,
    alerts,
    rows: rows.slice(0, maxRows),
    hiddenBlocks: allBlocks.length - rows.length,
    openConflicts: openConflicts.map((c) => ({
      id: c.id,
      label: c.label,
      baseVersion: c.baseVersion,
      currentVersion: c.currentVersion,
      by: c.by,
      currentBy: c.currentBy,
      detectedAt: c.detectedAt,
    })),
    recentAudit: store.registry.listAudit({ limit: maxAudit }).map((e) => ({
      id: e.id,
      label: e.label,
      action: e.action,
      by: e.by,
      at: e.at,
      fromVersion: e.fromVersion,
      toVersion: e.toVersion,
      reason: e.reason,
    })),
    recentArchive: store.archive.list({ limit: maxArchive }).map((e) => ({
      id: e.id,
      kind: e.kind,
      dayKey: e.dayKey,
      sourceLabel: e.sourceLabel,
      preview: e.content.length > 120 ? `${e.content.slice(0, 120)}...` : e.content,
    })),
    quotaSummary: quota
      ? `Quota bot ${botId}: so huu ${quota.ownedBlocks}/${quota.quota.maxOwnedBlocks} block, attach ${quota.attachedBlocks}/${quota.quota.maxAttachedBlocks} block, ${quota.ownedTokens}/${quota.quota.maxOwnedTokens || '∞'} token${quota.over.length > 0 ? ` — VUOT: ${quota.over.join(', ')}` : ''}`
      : 'Xem voi quyen admin (thay tat ca block).',
  };
}

/** View mau de preview/test panel khong can store that. */
export function demoMemoryV26PanelView(): V26PanelView {
  return {
    summary: 'Memory v26: 3 block (3 ban thay duoc), 2 muc luu tru, 1 xung dot mo, 5 muc audit, ~120 token (estimate), tiet kiem 40 token nho curate',
    blocksTotal: 3,
    blocksByKind: { human: 1, persona: 1, task: 1, project: 0, custom: 0 },
    blocksOverBudget: 1,
    blocksWarnBudget: 0,
    conflictsOpen: 1,
    auditTotal: 5,
    archivedTotal: 2,
    templatesTotal: 4,
    tokensTotal: 120,
    tokensSavedByCuration: 40,
    alerts: [
      '1 block vuot budget token: project-alpha — curate ngay.',
      '1 xung dot chua giai quyet: project-alpha — can resolve.',
    ],
    rows: [
      {
        id: 'blk_demo_human', label: 'human', kind: 'human', ownerBotId: 'bot-a',
        attachedBotIds: ['bot-a', 'bot-b'], version: 2, tokens: 30, maxTokens: 2000,
        budgetStatus: 'ok', readOnly: false, hasOpenConflict: false,
        updatedAt: '2026-11-18T10:00:00.000Z', updatedBy: 'bot-a',
        preview: '## Ten\nHuy',
      },
      {
        id: 'blk_demo_project', label: 'project-alpha', kind: 'project', ownerBotId: 'bot-a',
        attachedBotIds: ['bot-a', 'bot-b'], version: 5, tokens: 90, maxTokens: 50,
        budgetStatus: 'over', readOnly: false, hasOpenConflict: true,
        updatedAt: '2026-11-18T11:00:00.000Z', updatedBy: 'bot-b',
        preview: '## Tong quan\nDu an alpha...',
      },
    ],
    hiddenBlocks: 1,
    openConflicts: [
      {
        id: 'cf_demo', label: 'project-alpha', baseVersion: 4, currentVersion: 5,
        by: 'bot-b', currentBy: 'bot-a', detectedAt: '2026-11-18T11:00:00.000Z',
      },
    ],
    recentAudit: [
      {
        id: 'aud_demo', label: 'project-alpha', action: 'write', by: 'bot-a',
        at: '2026-11-18T11:00:00.000Z', fromVersion: 4, toVersion: 5, reason: 'write',
      },
    ],
    recentArchive: [
      {
        id: 'arc_demo', kind: 'block-version', dayKey: '2026-11-18',
        sourceLabel: 'project-alpha', preview: '## Tong quan\nDu an alpha (ban cu)...',
      },
    ],
    quotaSummary: 'Quota bot bot-a: so huu 2/50 block, attach 2/200 block, 120/50000 token',
  };
}
