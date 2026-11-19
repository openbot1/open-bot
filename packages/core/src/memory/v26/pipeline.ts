/**
 * Memory v26 — pipeline (v1.41, Doi T1).
 *
 * Dieu phoi cac thanh phan v26 thanh 1 luong dung cho tool:
 *  - createBlockFromTemplate: khoi tao block tu template
 *    (human/persona/task/project/tu tao) + kiem tra quota +
 *    kiem tra truong bat buoc + dat budget goi y.
 *  - writeBlock: ghi co kiem tra quota + xung dot (ghi lech
 *    version => tra conflict, khong ghi de) + tu curate neu
 *    vuot budget va onExceed='curate'.
 *  - resolveConflict: giai quyet xung dot (keep-current /
 *    keep-incoming / merge-lines / manual) + ghi block + audit
 *    'resolved' + cap nhat registry.
 *  - archiveOldVersions: dua cac version cu (tru version hien
 *    tai) vao archival.
 *  - recallForDate: recall memory theo ngay.
 *  - searchAll: search archival + block hien tai cung 1 ket qua.
 *  - snapshotForPrompt: render block bot duoc doc trong ngan
 *    sach token tong (human/persona uu tien).
 *
 * Chay 100% local, khong goi model/mang.
 */
import { V26ArchiveStore } from './archival';
import { renderPromptWithBudgetV26, summariseV26 } from './budget';
import { mergeLinesV26 } from './conflicts';
import { V26Store } from './store';
import {
  errV26,
  estimateTokensV26,
  isoAtV26,
  okV26,
  type V26ArchiveHit,
  type V26BlockKind,
  type V26Conflict,
  type V26ConflictResolution,
  type V26CreateBlockInput,
  type V26CurateReport,
  type V26PromptSnapshot,
  type V26RecallDay,
  type V26RegistryEntry,
  type V26Result,
  type V26SummariseResult,
} from './types';
import type { V25Scope, V25SharedBlock } from '../v25/types';

/** Ket qua tao block tu template. */
export interface V26TemplateBlockResult {
  block: V25SharedBlock;
  entry: V26RegistryEntry;
  /** Cac truong bat buoc con thieu trong value khoi tao. */
  missingRequired: string[];
  /** Canh bao (vd trung kind chuan). */
  warning: string;
}

/** Ket qua ghi block qua pipeline. */
export interface V26WriteBlockResult {
  block: V25SharedBlock;
  entry: V26RegistryEntry;
  /** Bao cao curate neu ghi xong tu curate (null neu khong). */
  curated: V26CurateReport | null;
}

/** 1 ket qua search tong (block hien tai + archival). */
export interface V26SearchAllHit {
  kind: 'block' | 'archive';
  id: string;
  label: string;
  text: string;
  score: number;
  explanation: string;
}

/** Pipeline memory v26. */
export class V26Pipeline {
  readonly store: V26Store;

  constructor(store?: V26Store) {
    this.store = store ?? new V26Store();
  }

  // -- create from template -----------------------------------------------------

  /**
   * Tao block tu template.
   *
   * Buoc: lay template -> instantiate (thay placeholder) ->
   * kiem tra quota tao -> tao block qua registry -> dat budget
   * goi y cua template (neu chua dat) -> ghi audit 'template'.
   * Truong bat buoc thieu chi canh bao (missingRequired), khong
   * chan — bot dien sau bang write.
   */
  createBlockFromTemplate(
    templateId: string,
    input: {
      label: string;
      ownerBotId: string;
      values?: Record<string, string>;
      description?: string;
      scope?: Partial<V25Scope>;
      attachBotIds?: string[];
      readOnly?: boolean;
      tokenBudget?: number;
    },
    opts: { nowMs?: number } = {},
  ): V26Result<V26TemplateBlockResult> {
    const instantiated = this.store.templates.instantiate(templateId, input.values ?? {});
    if (!instantiated.ok) return errV26(instantiated.error);
    const { value, template, missingRequired } = instantiated.value;
    const quotaCheck = this.store.quota.checkCreate(input.ownerBotId, this.store.listBlocks());
    if (!quotaCheck.ok) return errV26(quotaCheck.error);
    const created = this.store.registry.createWithWarnings(
      {
        label: input.label,
        description: input.description ?? template.description,
        value,
        ownerBotId: input.ownerBotId,
        kind: template.kind,
        templateId: template.id,
        scope: input.scope,
        readOnly: input.readOnly ?? false,
        attachBotIds: input.attachBotIds ?? [],
        tokenBudget: input.tokenBudget ?? template.suggestedBudgetTokens,
      },
      opts,
    );
    if (!created.ok) return errV26(created.error);
    const { result, warning } = created.value;
    this.store.budgets.setBudget({
      blockId: result.block.id,
      label: result.block.label,
      maxTokens: result.entry.tokenBudget,
      warnRatio: 0.8,
      onExceed: 'warn',
      curateTargetTokens: Math.max(50, Math.floor(result.entry.tokenBudget * 0.6) || 1000),
    });
    this.store.registry.recordAudit({
      blockId: result.block.id,
      label: result.block.label,
      action: 'template',
      by: input.ownerBotId,
      at: isoAtV26(opts.nowMs ?? Date.now()),
      fromVersion: 0,
      toVersion: result.block.version,
      oldValue: '',
      newValue: result.block.value,
      reason: `created from template "${template.id}"` +
        (missingRequired.length > 0 ? ` (thieu truong bat buoc: ${missingRequired.join(', ')})` : ''),
      conflictId: '',
    });
    return okV26({ block: result.block, entry: result.entry, missingRequired, warning });
  }

  /**
   * Tao block thuong (khong template) — kiem tra quota tao truoc.
   */
  createBlock(
    input: V26CreateBlockInput,
    opts: { nowMs?: number } = {},
  ): V26Result<{ block: V25SharedBlock; entry: V26RegistryEntry; warning: string }> {
    const quotaCheck = this.store.quota.checkCreate(input.ownerBotId, this.store.listBlocks());
    if (!quotaCheck.ok) return errV26(quotaCheck.error);
    const created = this.store.registry.createWithWarnings(input, opts);
    if (!created.ok) return errV26(created.error);
    const { result, warning } = created.value;
    if (result.entry.tokenBudget > 0) {
      this.store.budgets.setBudget({
        blockId: result.block.id,
        label: result.block.label,
        maxTokens: result.entry.tokenBudget,
        warnRatio: 0.8,
        onExceed: 'warn',
        curateTargetTokens: Math.max(50, Math.floor(result.entry.tokenBudget * 0.6)),
      });
    }
    return okV26({ block: result.block, entry: result.entry, warning });
  }

  // -- write (quota + conflict + auto-curate) --------------------------------------

  /**
   * Ghi block qua pipeline.
   *
   *  1. Kiem tra quota ghi (token/ky tu so huu cua bot).
   *  2. Luu tru version cu truoc khi ghi (archive 'block-version')
   *     neu version cu chua luu.
   *  3. Ghi qua registry (co expectedVersion => xung dot tra loi
   *     kem conflictId, khong ghi de).
   *  4. Neu ghi xong vuot budget va onExceed='curate' thi curate
   *     ngay, tra bao cao curate kem theo.
   */
  writeBlock(
    blockId: string,
    value: string,
    byBotId: string,
    opts: {
      nowMs?: number;
      reason?: string;
      expectedVersion?: number;
      baseValue?: string;
      autoCurate?: boolean;
    } = {},
  ): V26Result<V26WriteBlockResult> {
    const block = this.store.registry.blocks.get(blockId);
    if (!block) return errV26(`Khong co block "${blockId}".`);
    const quotaCheck = this.store.quota.checkWrite(byBotId, this.store.listBlocks(), blockId, value);
    if (!quotaCheck.ok) return errV26(quotaCheck.error);
    const nowMs = opts.nowMs ?? Date.now();
    this.store.archive.archiveBlockVersion(blockId, block.label, block.version, block.value, byBotId, {
      nowMs,
      note: `version ${block.version} truoc khi ghi moi`,
    });
    const written = this.store.registry.write(blockId, value, byBotId, {
      nowMs,
      reason: opts.reason ?? 'write',
      expectedVersion: opts.expectedVersion,
      baseValue: opts.baseValue,
    });
    if (!written.ok) return errV26(written.error);
    let curated: V26CurateReport | null = null;
    const budget = this.store.budgets.getBudget(blockId);
    if ((opts.autoCurate ?? true) && budget && budget.maxTokens > 0 && budget.onExceed === 'curate') {
      const status = this.store.budgets.status(blockId, block.label, written.value.block.value);
      if (status.status === 'over') {
        const cur = this.store.curateBlock(blockId, byBotId, { nowMs, reason: 'auto-curate sau khi ghi vuot budget' });
        if (cur.ok) curated = cur.value;
      }
    }
    const finalBlock = curated
      ? (this.store.registry.blocks.get(blockId) as V25SharedBlock)
      : written.value.block;
    return okV26({ block: finalBlock, entry: written.value.entry, curated });
  }

  // -- conflict resolution -----------------------------------------------------------

  /**
   * Giai quyet xung dot + ghi ket qua vao block.
   *
   * keep-current: khong ghi block (chi danh dau resolved).
   * keep-incoming / merge-lines / manual: ghi gia tri cuoi (tao
   * version moi) + audit 'resolved' + cap nhat registry.
   */
  resolveConflict(
    conflictId: string,
    resolution: V26ConflictResolution,
    resolvedBy: string,
    opts: { nowMs?: number; manualValue?: string; note?: string } = {},
  ): V26Result<{ conflict: V26Conflict; block: V25SharedBlock | null; mergeLines: number }> {
    const conflict = this.store.conflicts.get(conflictId);
    if (!conflict) return errV26(`Khong co conflict "${conflictId}".`);
    const resolved = this.store.conflicts.resolve(conflictId, resolution, resolvedBy, opts);
    if (!resolved.ok) return errV26(resolved.error);
    const { conflict: updated, finalValue, merge } = resolved.value;
    const nowMs = opts.nowMs ?? Date.now();
    if (resolution === 'keep-current') {
      this.store.conflicts.markResolvedVersion(conflictId, conflict.currentVersion);
      this.store.registry.markConflictResolved(conflict.blockId, resolvedBy, { nowMs });
      this.store.registry.recordAudit({
        blockId: conflict.blockId,
        label: conflict.label,
        action: 'resolved',
        by: resolvedBy,
        at: isoAtV26(nowMs),
        fromVersion: conflict.currentVersion,
        toVersion: conflict.currentVersion,
        oldValue: conflict.incomingValue,
        newValue: conflict.currentValue,
        reason: `resolve conflict ${conflictId}: keep-current${opts.note ? ` (${opts.note})` : ''}`,
        conflictId,
      });
      const block = this.store.registry.blocks.get(conflict.blockId) ?? null;
      return okV26({ conflict: updated, block, mergeLines: 0 });
    }
    // Ghi gia tri cuoi vao block (luu tru version cu truoc).
    const block = this.store.registry.blocks.get(conflict.blockId);
    if (!block) return errV26(`Block cua conflict "${conflictId}" khong con ton tai.`);
    this.store.archive.archiveBlockVersion(conflict.blockId, conflict.label, block.version, block.value, resolvedBy, {
      nowMs,
      note: `version ${block.version} truoc khi resolve conflict ${conflictId}`,
    });
    const written = this.store.registry.write(conflict.blockId, finalValue, resolvedBy, {
      nowMs,
      action: 'write',
      reason: `resolve conflict ${conflictId}: ${resolution}`,
    });
    if (!written.ok) return errV26(written.error);
    this.store.conflicts.markResolvedVersion(conflictId, written.value.block.version);
    this.store.registry.markConflictResolved(conflict.blockId, resolvedBy, { nowMs });
    this.store.registry.recordAudit({
      blockId: conflict.blockId,
      label: conflict.label,
      action: 'resolved',
      by: resolvedBy,
      at: isoAtV26(nowMs),
      fromVersion: conflict.currentVersion,
      toVersion: written.value.block.version,
      oldValue: conflict.currentValue,
      newValue: finalValue,
      reason: `resolve conflict ${conflictId}: ${resolution}${opts.note ? ` (${opts.note})` : ''}` +
        (merge ? ` (merge: ${merge.onlyCurrent} dong chi current, ${merge.onlyIncoming} dong chi incoming, ${merge.conflicts} xung dot dong)` : ''),
      conflictId,
    });
    return okV26({
      conflict: updated,
      block: written.value.block,
      mergeLines: merge ? merge.conflicts : 0,
    });
  }

  // -- archival / recall / search -------------------------------------------------------

  /**
   * Dua cac version cu cua 1 block vao archival (tru version
   * hien tai). Tra so version da luu.
   */
  archiveOldVersions(blockId: string, byBotId: string, opts: { nowMs?: number } = {}): V26Result<{ archived: number; skipped: number }> {
    const block = this.store.registry.blocks.get(blockId);
    if (!block) return errV26(`Khong co block "${blockId}".`);
    let archived = 0;
    let skipped = 0;
    for (const v of block.history) {
      if (v.version === block.version) {
        skipped++;
        continue;
      }
      const res = this.store.archive.archiveBlockVersion(blockId, block.label, v.version, v.value, v.updatedBy, {
        nowMs: opts.nowMs,
        note: `version ${v.version} cua block "${block.label}" (archive thu cong)`,
      });
      if (res.ok) {
        // archiveBlockVersion tra muc cu neu da ton tai — dem
        // la archived neu vua them, de don gian dem ca 2 loai
        // la archived khi goi thanh cong.
        archived++;
      } else {
        skipped++;
      }
    }
    void byBotId;
    return okV26({ archived, skipped });
  }

  /** Ghi turn hoi thoai vao recall memory (archival kind='turn'). */
  addRecallTurns(
    turns: Array<{ role: string; text: string; at: string }>,
    opts: { by?: string; sourceLabel?: string } = {},
  ): V26Result<{ added: number; skipped: number; ids: string[] }> {
    return this.store.archive.archiveTurns(turns, opts);
  }

  /** Recall memory theo ngay. */
  recallForDate(dayKey: string, opts: { limit?: number } = {}): V26Result<V26RecallDay> {
    return this.store.archive.recallDay(dayKey, opts);
  }

  /**
   * Search tong: block hien tai (label + value) + archival
   * (ngay + noi dung). Ket qua gom 2 loai, sap theo diem.
   */
  searchAll(filter: {
    query?: string;
    fromDay?: string;
    toDay?: string;
    botId?: string;
    limit?: number;
  }): V26SearchAllHit[] {
    const hits: V26SearchAllHit[] = [];
    const query = (filter.query ?? '').trim().toLowerCase();
    // Block hien tai: chi block bot duoc doc (neu co botId).
    for (const block of this.store.listBlocks()) {
      if (filter.botId !== undefined) {
        const entry = this.store.registry.getEntry(block.id);
        const visible = entry
          ? entry.ownerBotId === filter.botId || entry.attachedBotIds.includes(filter.botId)
          : block.ownerBotId === filter.botId || block.attachedBotIds.includes(filter.botId);
        if (!visible) continue;
      }
      if (!query) {
        hits.push({
          kind: 'block', id: block.id, label: block.label,
          text: block.value.slice(0, 500), score: 0.5, explanation: 'block hien tai (khong co tu khoa)',
        });
        continue;
      }
      const hay = `${block.label}\n${block.value}`.toLowerCase();
      if (hay.includes(query)) {
        const occurrences = hay.split(query).length - 1;
        hits.push({
          kind: 'block', id: block.id, label: block.label,
          text: block.value.slice(0, 500),
          score: Math.min(1, 0.6 + occurrences * 0.1),
          explanation: `khop "${filter.query}" trong block hien tai (${occurrences} lan)`,
        });
      }
    }
    // Archival.
    const archived = this.store.archive.search({
      query: filter.query,
      fromDay: filter.fromDay,
      toDay: filter.toDay,
      limit: filter.limit,
    });
    for (const hit of archived) {
      hits.push({
        kind: 'archive',
        id: hit.entry.id,
        label: hit.entry.sourceLabel || hit.entry.kind,
        text: hit.entry.content.slice(0, 500),
        score: Math.round(hit.score * 0.9 * 1000) / 1000,
        explanation: `archival ${hit.entry.dayKey}: ${hit.explanation}`,
      });
    }
    hits.sort((a, b) => b.score - a.score);
    if (filter.limit !== undefined) return hits.slice(0, Math.max(0, filter.limit));
    return hits;
  }

  // -- prompt snapshot -------------------------------------------------------------------

  /**
   * Render cac block bot duoc doc vao prompt trong ngan sach
   * token tong. Thu tu uu tien: human -> persona -> project ->
   * task -> custom; block vuot phan con lai thi cat ngan.
   */
  snapshotForPrompt(botId: string, totalBudgetTokens: number, scope?: V25Scope): V26PromptSnapshot {
    const entries = this.store.registry.listVisibleForBot(botId, scope);
    const blocks = entries
      .map((e) => this.store.registry.blocks.get(e.blockId))
      .filter((b): b is V25SharedBlock => b !== undefined)
      .map((b) => ({
        label: b.label,
        kind: (this.store.registry.getEntry(b.id)?.kind ?? 'custom') as V26BlockKind,
        value: b.value,
        updatedAt: b.updatedAt,
      }));
    return renderPromptWithBudgetV26(blocks, totalBudgetTokens);
  }

  /** Tom tat 1 doan text (dung truc tiep, khong ghi block). */
  summariseText(text: string, targetTokens: number): V26SummariseResult {
    return summariseV26(text, targetTokens);
  }

  /** Uoc luong token cua text. */
  estimateTokens(text: string): number {
    return estimateTokensV26(text);
  }

  /** Merge 2 ban text theo dong (dung khi resolve conflict tay). */
  mergeLines(base: string, current: string, incoming: string): ReturnType<typeof mergeLinesV26> {
    return mergeLinesV26(base, current, incoming);
  }

  /** Kiem tra archive store co san khong (tien ich test). */
  archiveStore(): V26ArchiveStore {
    return this.store.archive;
  }
}
