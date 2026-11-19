/**
 * Memory v26 — block registry + audit log (v1.41, Doi T1).
 *
 * Registry la lop chi muc tren V25SharedBlockStore:
 *  - Moi block co 1 muc registry (label, owner, bot attach, kind,
 *    template goc, budget, xung dot mo, so lan cap nhat).
 *  - Ghi block qua registry: 1 bot cap nhat thi cac bot khac doc
 *    lai thay ngay (cung 1 store, khong copy) — day la co che
 *    shared state cua Letta-style shared blocks.
 *  - Moi lan doi (ghi/attach/detach/chuyen owner/read-only/
 *    curate/revert) deu ghi 1 muc audit append-only: ai, khi
 *    nao, version cu -> moi, noi dung cu/moi (cat ngan).
 *  - Ghi co `expectedVersion`: neu version hien tai lech thi
 *    TU CHOI ghi + tao conflict (xem conflicts.ts) — khong bao
 *    gio ghi de lang le ban cua agent khac.
 *
 * Chay 100% local, khong goi model/mang.
 */
import { V25SharedBlockStore } from '../v25/sharedBlocks';
import {
  blockWritableByV25,
  isValidBlockLabelV25,
  type V25SharedBlock,
  type V25Scope,
} from '../v25/types';
import {
  errV26,
  isValidBlockLabelV26,
  isoAtV26,
  makeV26Id,
  okV26,
  truncateV26,
  type V26AuditAction,
  type V26AuditEntry,
  type V26AuditFilter,
  type V26BlockKind,
  type V26CreateBlockInput,
  type V26RegistryEntry,
  type V26RegistryFilter,
  type V26Result,
} from './types';
import { V26ConflictStore } from './conflicts';

/** Do dai toi da cua oldValue/newValue trong 1 muc audit. */
export const V26_AUDIT_VALUE_LIMIT = 2000;

/** Ket qua ghi block qua registry. */
export interface V26RegistryWriteResult {
  block: V25SharedBlock;
  entry: V26RegistryEntry;
  audit: V26AuditEntry;
}

/** Ket qua ghi bi xung dot (da tao conflict, chua ghi). */
export interface V26RegistryConflictResult {
  conflictId: string;
  currentVersion: number;
  currentValue: string;
  currentBy: string;
}

/** Registry + audit log cho shared block. */
export class V26BlockRegistry {
  /** Store block goc (v25) — registry khong so huu du lieu, chi chi muc. */
  readonly blocks: V25SharedBlockStore;
  /** Store xung dot (dung chung, de registry tao conflict khi ghi lech). */
  readonly conflicts: V26ConflictStore;
  private readonly entries = new Map<string, V26RegistryEntry>();
  private readonly audit: V26AuditEntry[] = [];

  constructor(blocks?: V25SharedBlockStore, conflicts?: V26ConflictStore) {
    this.blocks = blocks ?? new V25SharedBlockStore();
    this.conflicts = conflicts ?? new V26ConflictStore();
  }

  get size(): number {
    return this.entries.size;
  }

  get auditSize(): number {
    return this.audit.length;
  }

  // -- registry lookup ------------------------------------------------------

  /** Lay muc registry theo block id. */
  getEntry(blockId: string): V26RegistryEntry | undefined {
    return this.entries.get(blockId);
  }

  /** Lay muc registry theo label trong scope. */
  getEntryByLabel(label: string, scope: V25Scope): V26RegistryEntry | undefined {
    const norm = label.trim().toLowerCase();
    for (const entry of this.entries.values()) {
      if (entry.label !== norm) continue;
      const s = entry.scope;
      if (scope.userId && s.userId !== scope.userId) continue;
      if (scope.agentId && s.agentId !== scope.agentId) continue;
      if (scope.runId && s.runId !== scope.runId) continue;
      if (scope.appId && s.appId !== scope.appId) continue;
      return entry;
    }
    return undefined;
  }

  /** Liet ke muc registry theo bo loc (moi cap nhat truoc). */
  list(filter: V26RegistryFilter = {}): V26RegistryEntry[] {
    const out: V26RegistryEntry[] = [];
    for (const entry of this.entries.values()) {
      if (filter.scope) {
        const s = entry.scope;
        const q = filter.scope;
        if (q.userId && s.userId !== q.userId) continue;
        if (q.agentId && s.agentId !== q.agentId) continue;
        if (q.runId && s.runId !== q.runId) continue;
        if (q.appId && s.appId !== q.appId) continue;
      }
      if (filter.botId !== undefined) {
        const mine = entry.ownerBotId === filter.botId || entry.attachedBotIds.includes(filter.botId);
        if (!mine) continue;
      }
      if (filter.ownerBotId !== undefined && entry.ownerBotId !== filter.ownerBotId) continue;
      if (filter.kind !== undefined && entry.kind !== filter.kind) continue;
      if (filter.hasOpenConflict !== undefined && entry.hasOpenConflict !== filter.hasOpenConflict) continue;
      if (filter.labelContains !== undefined) {
        if (!entry.label.includes(filter.labelContains.trim().toLowerCase())) continue;
      }
      out.push(entry);
    }
    out.sort((a, b) => (a.lastUpdatedAt < b.lastUpdatedAt ? 1 : a.lastUpdatedAt > b.lastUpdatedAt ? -1 : 0));
    if (filter.limit !== undefined) return out.slice(0, Math.max(0, filter.limit));
    return out;
  }

  /**
   * Cac block 1 bot thay duoc ngay luc nay (owner hoac attach) —
   * day la "shared state" bot nhin thay: doc tu store chung nen
   * bot khac vua ghi xong la bot nay doc thay ngay.
   */
  listVisibleForBot(botId: string, scope?: V25Scope): V26RegistryEntry[] {
    return this.list({ botId, ...(scope ? { scope } : {}) });
  }

  // -- create / register ----------------------------------------------------

  /**
   * Tao block moi + dang ky.
   *
   * Kiem tra: label hop le, owner rong, value rong, quota so
   * block (goi tu store, khong kiem o day), kind hop le.
   * Canh bao (khong chan): tao block `human`/`persona` thu 2
   * trong cung scope — tra ve `duplicateStandardKind: true`
   * trong ket qua mo rong (xem createWithWarnings).
   */
  create(input: V26CreateBlockInput, opts: { nowMs?: number } = {}): V26Result<V26RegistryWriteResult> {
    const checked = this.createWithWarnings(input, opts);
    if (!checked.ok) return checked;
    return okV26(checked.value.result);
  }

  /** Tao block + bao them canh bao (vd trung kind chuan). */
  createWithWarnings(
    input: V26CreateBlockInput,
    opts: { nowMs?: number } = {},
  ): V26Result<{ result: V26RegistryWriteResult; duplicateStandardKind: boolean; warning: string }> {
    const label = input.label.trim().toLowerCase();
    if (!isValidBlockLabelV26(label) || !isValidBlockLabelV25(label)) {
      return errV26(`Label block "${input.label}" khong hop le (a-z, 0-9, _-, 1..64 ky tu, bat dau bang chu/so).`);
    }
    const kind: V26BlockKind = input.kind ?? 'custom';
    if (kind !== 'human' && kind !== 'persona' && kind !== 'task' && kind !== 'project' && kind !== 'custom') {
      return errV26(`kind "${input.kind}" khong hop le (human/persona/task/project/custom).`);
    }
    const tokenBudget = input.tokenBudget ?? 0;
    if (!Number.isInteger(tokenBudget) || tokenBudget < 0 || tokenBudget > 1000000) {
      return errV26('tokenBudget phai la so nguyen 0..1000000 (0 = khong gioi han).');
    }
    const scope: V25Scope = {
      userId: input.scope?.userId ?? '',
      agentId: input.scope?.agentId ?? '',
      runId: input.scope?.runId ?? '',
      appId: input.scope?.appId ?? '',
    };
    let duplicateStandardKind = false;
    let warning = '';
    if (kind === 'human' || kind === 'persona') {
      const same = this.list({ scope, kind });
      if (same.length > 0) {
        duplicateStandardKind = true;
        warning = `Da co ${same.length} block "${kind}" trong scope nay (${same.map((e) => e.label).join(', ')}) — nen chi co 1 block ${kind} moi scope.`;
      }
    }
    const created = this.blocks.create(
      {
        label,
        description: input.description ?? '',
        value: input.value,
        ownerBotId: input.ownerBotId,
        scope,
        readOnly: input.readOnly ?? false,
        maxChars: input.maxChars ?? 0,
        attachBotIds: input.attachBotIds ?? [],
      },
      opts,
    );
    if (!created.ok) return errV26(created.error);
    const block = created.value;
    const nowMs = opts.nowMs ?? Date.now();
    const nowIso = isoAtV26(nowMs);
    const entry: V26RegistryEntry = {
      id: makeV26Id('reg'),
      blockId: block.id,
      label,
      kind,
      ownerBotId: block.ownerBotId,
      attachedBotIds: [...block.attachedBotIds],
      templateId: (input.templateId ?? '').trim(),
      tokenBudget,
      hasOpenConflict: false,
      openConflictId: '',
      updateCount: 0,
      lastUpdatedAt: nowIso,
      lastUpdatedBy: block.ownerBotId,
      scope: { ...block.scope },
      registeredAt: nowIso,
    };
    this.entries.set(block.id, entry);
    const auditEntry = this.recordAudit({
      blockId: block.id,
      label,
      action: 'created',
      by: block.ownerBotId,
      at: nowIso,
      fromVersion: 0,
      toVersion: block.version,
      oldValue: '',
      newValue: block.value,
      reason: `created kind=${kind}${entry.templateId ? ` template=${entry.templateId}` : ''}`,
      conflictId: '',
    });
    return okV26({
      result: { block, entry, audit: auditEntry },
      duplicateStandardKind,
      warning,
    });
  }

  /**
   * Dang ky lai 1 block v25 da co (vd import tu store cu, khoi
   * phuc sau khi load) — khong tao block moi, chi them muc
   * registry. Block da dang ky roi thi tra ve muc cu.
   */
  registerExisting(
    blockId: string,
    opts: { kind?: V26BlockKind; templateId?: string; tokenBudget?: number; nowMs?: number } = {},
  ): V26Result<V26RegistryEntry> {
    const block = this.blocks.get(blockId);
    if (!block) return errV26(`Khong co block "${blockId}".`);
    const existing = this.entries.get(blockId);
    if (existing) return okV26(existing);
    const nowIso = isoAtV26(opts.nowMs ?? Date.now());
    const entry: V26RegistryEntry = {
      id: makeV26Id('reg'),
      blockId: block.id,
      label: block.label,
      kind: opts.kind ?? 'custom',
      ownerBotId: block.ownerBotId,
      attachedBotIds: [...block.attachedBotIds],
      templateId: (opts.templateId ?? '').trim(),
      tokenBudget: opts.tokenBudget ?? 0,
      hasOpenConflict: false,
      openConflictId: '',
      updateCount: Math.max(0, block.version - 1),
      lastUpdatedAt: block.updatedAt,
      lastUpdatedBy: block.history.length > 0 ? block.history[block.history.length - 1].updatedBy : block.ownerBotId,
      scope: { ...block.scope },
      registeredAt: nowIso,
    };
    this.entries.set(block.id, entry);
    return okV26(entry);
  }

  // -- read / write -----------------------------------------------------------

  /** Doc block — chi owner + bot da attach (ke thua quyen v25). */
  readForBot(blockId: string, botId: string): V26Result<V25SharedBlock> {
    return this.blocks.readForBot(blockId, botId);
  }

  /**
   * Ghi gia tri moi cho block qua registry.
   *
   * Quy trinh:
   *  1. Kiem tra quyen ghi (read-only / chua attach) — loi neu khong duoc.
   *  2. Neu `expectedVersion` co va lech version hien tai: TU CHOI
   *     ghi, tao V26Conflict (base = gia tri luc agent doc neu
   *     goi kem `baseValue`, neu khong lay lich su version do),
   *     danh dau registry hasOpenConflict, ghi audit action
   *     'conflict' — tra loi kem conflictId.
   *  3. Ghi thanh cong: tang version, dong bo registry
   *     (attached/owner/lastUpdated), ghi audit 'write' voi
   *     old/new value.
   *
   * Tra ve kieu Result binh thuong; khi xung dot, error co dang
   * `CONFLICT:<conflictId>: ...` de tool tach conflictId ra.
   */
  write(
    blockId: string,
    value: string,
    byBotId: string,
    opts: {
      nowMs?: number;
      reason?: string;
      expectedVersion?: number;
      /** Gia tri agent da doc (base) — de ghi vao conflict neu lech. */
      baseValue?: string;
      /** Hanh dong audit (mac dinh 'write'). */
      action?: V26AuditAction;
    } = {},
  ): V26Result<V26RegistryWriteResult> {
    const block = this.blocks.get(blockId);
    if (!block) return errV26(`Khong co block "${blockId}".`);
    const nowMs = opts.nowMs ?? Date.now();
    const nowIso = isoAtV26(nowMs);
    // Block co trong store v25 nhung chua co muc registry (vd load
    // tu store cu) thi dang ky lai truoc khi ghi — audit + registry
    // luon dong bo.
    if (!this.entries.has(blockId)) this.registerExisting(blockId, { nowMs });
    if (!blockWritableByV25(block, byBotId)) {
      if (block.readOnly) {
        return errV26(`Block "${block.label}" dang read-only — bot "${byBotId}" chi duoc doc (owner la "${block.ownerBotId}").`);
      }
      return errV26(`Bot "${byBotId}" chua attach block "${block.label}" — khong duoc ghi.`);
    }
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== block.version) {
      const baseVersion = opts.expectedVersion;
      const baseFromHistory = block.history.find((v) => v.version === baseVersion);
      const baseValue = opts.baseValue ?? baseFromHistory?.value ?? '';
      const conflict = this.conflicts.record({
        blockId: block.id,
        label: block.label,
        baseVersion,
        currentVersion: block.version,
        baseValue,
        currentValue: block.value,
        incomingValue: value,
        by: byBotId,
        currentBy: block.history.length > 0 ? block.history[block.history.length - 1].updatedBy : block.ownerBotId,
        nowMs,
      });
      const entry = this.entries.get(blockId);
      if (entry) {
        entry.hasOpenConflict = true;
        entry.openConflictId = conflict.id;
        entry.lastUpdatedAt = nowIso;
        entry.lastUpdatedBy = byBotId;
      }
      this.recordAudit({
        blockId: block.id,
        label: block.label,
        action: 'conflict',
        by: byBotId,
        at: nowIso,
        fromVersion: baseVersion,
        toVersion: block.version,
        oldValue: baseValue,
        newValue: value,
        reason: `expectedVersion ${baseVersion} lech version hien tai ${block.version}`,
        conflictId: conflict.id,
      });
      return errV26(
        `CONFLICT:${conflict.id}: Block "${block.label}" da doi sang version ${block.version} (ban doc version ${baseVersion}) — ghi cua bot "${byBotId}" bi tu choi, xem conflict ${conflict.id} de giai quyet.`,
      );
    }
    const oldValue = block.value;
    const fromVersion = block.version;
    const written = this.blocks.write(blockId, value, byBotId, {
      nowMs,
      reason: opts.reason ?? 'write',
      ...(opts.expectedVersion !== undefined ? { expectedVersion: opts.expectedVersion } : {}),
    });
    if (!written.ok) return errV26(written.error);
    const updated = written.value;
    const entry = this.entries.get(blockId);
    if (entry) {
      entry.attachedBotIds = [...updated.attachedBotIds];
      entry.ownerBotId = updated.ownerBotId;
      entry.updateCount += 1;
      entry.lastUpdatedAt = nowIso;
      entry.lastUpdatedBy = byBotId;
    }
    const auditEntry = this.recordAudit({
      blockId: block.id,
      label: block.label,
      action: opts.action ?? 'write',
      by: byBotId,
      at: nowIso,
      fromVersion,
      toVersion: updated.version,
      oldValue,
      newValue: value,
      reason: opts.reason ?? 'write',
      conflictId: '',
    });
    return okV26({ block: updated, entry: entry as V26RegistryEntry, audit: auditEntry });
  }

  /**
   * Ghi de khong can expectedVersion (dung cho curate/revert noi
   * bo sau khi da doc version moi nhat) — van ghi audit day du.
   */
  forceWrite(
    blockId: string,
    value: string,
    byBotId: string,
    opts: { nowMs?: number; reason?: string; action?: V26AuditAction } = {},
  ): V26Result<V26RegistryWriteResult> {
    return this.write(blockId, value, byBotId, { ...opts });
  }

  /** Chen them text vao cuoi block (append = write voi value noi). */
  append(
    blockId: string,
    text: string,
    byBotId: string,
    opts: { nowMs?: number; reason?: string; expectedVersion?: number; separator?: string } = {},
  ): V26Result<V26RegistryWriteResult> {
    const block = this.blocks.get(blockId);
    if (!block) return errV26(`Khong co block "${blockId}".`);
    const sep = opts.separator ?? (block.value.length === 0 ? '' : '\n');
    return this.write(blockId, `${block.value}${sep}${text}`, byBotId, {
      ...opts,
      action: 'append',
      reason: opts.reason ?? 'append',
    });
  }

  /**
   * Thay 1 doan trong block (replace): tim `oldText` (khop dung
   * chuoi) va thay bang `newText`. Khong tim thay thi loi.
   */
  replace(
    blockId: string,
    oldText: string,
    newText: string,
    byBotId: string,
    opts: { nowMs?: number; reason?: string; expectedVersion?: number } = {},
  ): V26Result<V26RegistryWriteResult> {
    const block = this.blocks.get(blockId);
    if (!block) return errV26(`Khong co block "${blockId}".`);
    if (!oldText) return errV26('oldText khong duoc rong.');
    if (!block.value.includes(oldText)) {
      return errV26(`Block "${block.label}" khong chua doan can thay (tim "${truncateV26(oldText, 80)}").`);
    }
    return this.write(blockId, block.value.replace(oldText, newText), byBotId, {
      ...opts,
      action: 'replace',
      reason: opts.reason ?? 'replace',
    });
  }

  /** Revert ve 1 version cu — tao version moi, ghi audit 'revert'. */
  revert(
    blockId: string,
    version: number,
    byBotId: string,
    opts: { nowMs?: number; reason?: string } = {},
  ): V26Result<V26RegistryWriteResult> {
    const block = this.blocks.get(blockId);
    if (!block) return errV26(`Khong co block "${blockId}".`);
    const target = block.history.find((v) => v.version === version);
    if (!target) return errV26(`Block "${block.label}" khong co version ${version}.`);
    if (target.version === block.version) {
      const entry = this.entries.get(blockId) as V26RegistryEntry | undefined;
      return okV26({
        block,
        entry: entry as V26RegistryEntry,
        audit: this.recordAudit({
          blockId: block.id,
          label: block.label,
          action: 'revert',
          by: byBotId,
          at: isoAtV26(opts.nowMs ?? Date.now()),
          fromVersion: block.version,
          toVersion: block.version,
          oldValue: block.value,
          newValue: block.value,
          reason: opts.reason ?? `revert to v${version} (da o version nay)`,
          conflictId: '',
        }),
      });
    }
    return this.write(blockId, target.value, byBotId, {
      nowMs: opts.nowMs,
      action: 'revert',
      reason: opts.reason ?? `revert to v${version}`,
    });
  }

  // -- attach / detach / transfer / readonly ---------------------------------

  /** Attach 1 bot vao block + audit. */
  attach(blockId: string, botId: string, byBotId: string, opts: { nowMs?: number } = {}): V26Result<V26RegistryEntry> {
    const attached = this.blocks.attach(blockId, botId);
    if (!attached.ok) return errV26(attached.error);
    const entry = this.entries.get(blockId);
    if (entry) {
      entry.attachedBotIds = [...attached.value.attachedBotIds];
      entry.lastUpdatedAt = isoAtV26(opts.nowMs ?? Date.now());
      entry.lastUpdatedBy = byBotId;
    }
    this.recordAudit({
      blockId,
      label: attached.value.label,
      action: 'attach',
      by: byBotId,
      at: isoAtV26(opts.nowMs ?? Date.now()),
      fromVersion: attached.value.version,
      toVersion: attached.value.version,
      oldValue: '',
      newValue: botId,
      reason: `attach bot "${botId}"`,
      conflictId: '',
    });
    return okV26(entry as V26RegistryEntry);
  }

  /** Detach 1 bot khoi block + audit (owner khong duoc tu detach). */
  detach(blockId: string, botId: string, byBotId: string, opts: { nowMs?: number } = {}): V26Result<V26RegistryEntry> {
    const detached = this.blocks.detach(blockId, botId);
    if (!detached.ok) return errV26(detached.error);
    const entry = this.entries.get(blockId);
    if (entry) {
      entry.attachedBotIds = [...detached.value.attachedBotIds];
      entry.lastUpdatedAt = isoAtV26(opts.nowMs ?? Date.now());
      entry.lastUpdatedBy = byBotId;
    }
    this.recordAudit({
      blockId,
      label: detached.value.label,
      action: 'detach',
      by: byBotId,
      at: isoAtV26(opts.nowMs ?? Date.now()),
      fromVersion: detached.value.version,
      toVersion: detached.value.version,
      oldValue: botId,
      newValue: '',
      reason: `detach bot "${botId}"`,
      conflictId: '',
    });
    return okV26(entry as V26RegistryEntry);
  }

  /** Chuyen quyen so huu + audit. */
  transferOwnership(blockId: string, fromBotId: string, toBotId: string, opts: { nowMs?: number } = {}): V26Result<V26RegistryEntry> {
    const moved = this.blocks.transferOwnership(blockId, fromBotId, toBotId);
    if (!moved.ok) return errV26(moved.error);
    const entry = this.entries.get(blockId);
    if (entry) {
      entry.ownerBotId = moved.value.ownerBotId;
      entry.attachedBotIds = [...moved.value.attachedBotIds];
      entry.lastUpdatedAt = isoAtV26(opts.nowMs ?? Date.now());
      entry.lastUpdatedBy = fromBotId;
    }
    this.recordAudit({
      blockId,
      label: moved.value.label,
      action: 'transfer',
      by: fromBotId,
      at: isoAtV26(opts.nowMs ?? Date.now()),
      fromVersion: moved.value.version,
      toVersion: moved.value.version,
      oldValue: fromBotId,
      newValue: toBotId,
      reason: `transfer ownership ${fromBotId} -> ${toBotId}`,
      conflictId: '',
    });
    return okV26(entry as V26RegistryEntry);
  }

  /** Bat/tat read-only (chi owner) + audit. */
  setReadOnly(blockId: string, readOnly: boolean, byBotId: string, opts: { nowMs?: number } = {}): V26Result<V26RegistryEntry> {
    const changed = this.blocks.setReadOnly(blockId, readOnly, byBotId);
    if (!changed.ok) return errV26(changed.error);
    const entry = this.entries.get(blockId);
    if (entry) {
      entry.lastUpdatedAt = isoAtV26(opts.nowMs ?? Date.now());
      entry.lastUpdatedBy = byBotId;
    }
    this.recordAudit({
      blockId,
      label: changed.value.label,
      action: 'readonly',
      by: byBotId,
      at: isoAtV26(opts.nowMs ?? Date.now()),
      fromVersion: changed.value.version,
      toVersion: changed.value.version,
      oldValue: readOnly ? 'false' : 'true',
      newValue: readOnly ? 'true' : 'false',
      reason: `set readOnly=${readOnly}`,
      conflictId: '',
    });
    return okV26(entry as V26RegistryEntry);
  }

  /** Doi budget token cua block (ghi vao registry + audit 'budget'). */
  setTokenBudget(blockId: string, maxTokens: number, byBotId: string, opts: { nowMs?: number } = {}): V26Result<V26RegistryEntry> {
    const entry = this.entries.get(blockId);
    if (!entry) return errV26(`Block "${blockId}" chua dang ky trong registry v26.`);
    if (!Number.isInteger(maxTokens) || maxTokens < 0 || maxTokens > 1000000) {
      return errV26('tokenBudget phai la so nguyen 0..1000000 (0 = khong gioi han).');
    }
    const old = entry.tokenBudget;
    entry.tokenBudget = maxTokens;
    entry.lastUpdatedAt = isoAtV26(opts.nowMs ?? Date.now());
    entry.lastUpdatedBy = byBotId;
    this.recordAudit({
      blockId,
      label: entry.label,
      action: 'budget',
      by: byBotId,
      at: isoAtV26(opts.nowMs ?? Date.now()),
      fromVersion: this.blocks.get(blockId)?.version ?? 0,
      toVersion: this.blocks.get(blockId)?.version ?? 0,
      oldValue: String(old),
      newValue: String(maxTokens),
      reason: `set tokenBudget ${old} -> ${maxTokens}`,
      conflictId: '',
    });
    return okV26(entry);
  }

  /** Cap nhat trang thai xung dot cua registry sau khi resolve. */
  markConflictResolved(blockId: string, resolvedBy: string, opts: { nowMs?: number } = {}): void {
    const entry = this.entries.get(blockId);
    if (!entry) return;
    entry.hasOpenConflict = this.conflicts.listOpen().some((c) => c.blockId === blockId);
    if (!entry.hasOpenConflict) entry.openConflictId = '';
    entry.lastUpdatedAt = isoAtV26(opts.nowMs ?? Date.now());
    entry.lastUpdatedBy = resolvedBy;
  }

  // -- audit log ---------------------------------------------------------------

  /** Ghi 1 muc audit (append-only). Cat ngan value ve 2000 ky tu. */
  recordAudit(partial: Omit<V26AuditEntry, 'id' | 'oldValue' | 'newValue'> & { oldValue: string; newValue: string }): V26AuditEntry {
    const entry: V26AuditEntry = {
      id: makeV26Id('aud'),
      blockId: partial.blockId,
      label: partial.label,
      action: partial.action,
      by: partial.by,
      at: partial.at,
      fromVersion: partial.fromVersion,
      toVersion: partial.toVersion,
      oldValue: truncateV26(partial.oldValue, V26_AUDIT_VALUE_LIMIT),
      newValue: truncateV26(partial.newValue, V26_AUDIT_VALUE_LIMIT),
      reason: partial.reason,
      conflictId: partial.conflictId ?? '',
    };
    this.audit.push(entry);
    return entry;
  }

  /** Liet ke audit log (moi nhat truoc). */
  listAudit(filter: V26AuditFilter = {}): V26AuditEntry[] {
    const out: V26AuditEntry[] = [];
    for (let i = this.audit.length - 1; i >= 0; i--) {
      const e = this.audit[i];
      if (filter.blockId !== undefined && e.blockId !== filter.blockId) continue;
      if (filter.label !== undefined && e.label !== filter.label) continue;
      if (filter.by !== undefined && e.by !== filter.by) continue;
      if (filter.action !== undefined && e.action !== filter.action) continue;
      if (filter.fromDay !== undefined || filter.toDay !== undefined) {
        const day = e.at.slice(0, 10);
        if (filter.fromDay !== undefined && day < filter.fromDay) continue;
        if (filter.toDay !== undefined && day > filter.toDay) continue;
      }
      out.push(e);
    }
    if (filter.limit !== undefined) return out.slice(0, Math.max(0, filter.limit));
    return out;
  }

  /** Audit cua 1 block (moi nhat truoc). */
  auditForBlock(blockId: string, limit?: number): V26AuditEntry[] {
    return this.listAudit({ blockId, ...(limit !== undefined ? { limit } : {}) });
  }

  /** So muc audit theo hanh dong. */
  countAuditByAction(): Record<V26AuditAction, number> {
    const out: Record<V26AuditAction, number> = {
      created: 0, write: 0, append: 0, replace: 0, curate: 0, revert: 0,
      attach: 0, detach: 0, transfer: 0, readonly: 0, budget: 0,
      template: 0, conflict: 0, resolved: 0, archived: 0, imported: 0,
    };
    for (const e of this.audit) out[e.action]++;
    return out;
  }

  // -- serialisation -----------------------------------------------------------

  toJSON(): { registry: V26RegistryEntry[]; audit: V26AuditEntry[]; blocks: V25SharedBlock[] } {
    return {
      registry: [...this.entries.values()],
      audit: [...this.audit],
      blocks: this.blocks.toJSON(),
    };
  }

  static fromJSON(data: unknown): V26BlockRegistry {
    if (!data || typeof data !== 'object') return new V26BlockRegistry();
    const raw = data as { registry?: V26RegistryEntry[]; audit?: V26AuditEntry[]; blocks?: V25SharedBlock[] };
    const blocks = Array.isArray(raw.blocks)
      ? V25SharedBlockStore.fromJSON(raw.blocks)
      : new V25SharedBlockStore();
    const registry = new V26BlockRegistry(blocks);
    if (Array.isArray(raw.registry)) {
      for (const e of raw.registry) {
        if (!e || typeof e.blockId !== 'string') continue;
        registry.entries.set(e.blockId, {
          ...e,
          attachedBotIds: Array.isArray(e.attachedBotIds) ? e.attachedBotIds : [],
        });
      }
    }
    if (Array.isArray(raw.audit)) {
      for (const e of raw.audit) {
        if (!e || typeof e.id !== 'string') continue;
        registry.audit.push(e);
      }
    }
    return registry;
  }
}
