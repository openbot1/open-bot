/**
 * Memory v20 — Core memory block store (Letta-style).
 *
 * Block = doan van ban co nhan, gioi han ky tu, versioned, lich su
 * append-only. Moi sua doi deu qua `applyEdit` (co ly do bat buoc,
 * kiem tra version lac quan, gioi han ky tu) va ghi vao lich su —
 * khong co duong tat sua truc tiep `value`.
 */
import type {
  V20BlockEdit,
  V20BlockEditRequest,
  V20BlockEditResult,
  V20BlockErrorCode,
  V20CoreBlock,
} from './types';
import { V20_DEFAULT_CHAR_LIMIT, V20_MAX_BLOCKS_PER_AGENT, V20_MAX_LABEL_LENGTH, V20_MIN_REASON_LENGTH } from './types';

export class V20BlockError extends Error {
  readonly code: V20BlockErrorCode;
  constructor(code: V20BlockErrorCode, message: string) {
    super(message);
    this.name = 'V20BlockError';
    this.code = code;
  }
}

export function validateBlockLabelV20(label: string): string | null {
  const t = label.trim();
  if (!t) return 'nhan block khong duoc de trong';
  if (t.length > V20_MAX_LABEL_LENGTH) return `nhan block dai toi da ${V20_MAX_LABEL_LENGTH} ky tu`;
  if (!/^[A-Za-z0-9 _\-./]+$/.test(t)) return 'nhan block chi duoc chua chu, so, khoang trang, _, -, ., /';
  return null;
}

export function normalizeBlockIdV20(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'block';
}

export interface V20CreateBlockInput {
  label: string;
  kind: V20CoreBlock['kind'];
  scope?: V20CoreBlock['scope'];
  value: string;
  charLimit?: number;
  actor: string;
  tags?: string[];
  readonly?: boolean;
}

export class V20CoreBlockStore {
  private blocks = new Map<string, V20CoreBlock>();
  private history = new Map<string, V20BlockEdit[]>();
  private seq = 0;

  listBlocks(includeArchived = false): V20CoreBlock[] {
    const all = [...this.blocks.values()].sort((a, b) => a.label.localeCompare(b.label));
    return includeArchived ? all : all.filter((b) => !b.archived);
  }

  getBlock(idOrLabel: string): V20CoreBlock | undefined {
    const direct = this.blocks.get(idOrLabel);
    if (direct) return { ...direct };
    const norm = normalizeBlockIdV20(idOrLabel);
    for (const b of this.blocks.values()) {
      if (normalizeBlockIdV20(b.label) === norm) return { ...b };
    }
    return undefined;
  }

  createBlock(input: V20CreateBlockInput): V20BlockEditResult {
    const labelErr = validateBlockLabelV20(input.label);
    if (labelErr) return { ok: false, error: labelErr, errorCode: 'invalid_label' };
    if (this.blocks.size >= V20_MAX_BLOCKS_PER_AGENT) {
      return { ok: false, error: `toi da ${V20_MAX_BLOCKS_PER_AGENT} block`, errorCode: 'invalid_op' };
    }
    const id = normalizeBlockIdV20(input.label);
    if (this.blocks.has(id)) return { ok: false, error: `da co block nhan "${input.label}"`, errorCode: 'duplicate_label' };
    const charLimit = input.charLimit ?? V20_DEFAULT_CHAR_LIMIT;
    if (charLimit <= 0) return { ok: false, error: 'gioi han ky tu phai > 0', errorCode: 'invalid_op' };
    if (input.value.length > charLimit) {
      return { ok: false, error: `vuot gioi han ${charLimit} ky tu`, errorCode: 'over_char_limit', charsUsed: input.value.length, charsLimit: charLimit };
    }
    const now = Date.now();
    const block: V20CoreBlock = {
      id, label: input.label.trim(), kind: input.kind, scope: input.scope ?? 'agent',
      value: input.value, charLimit, version: 1, createdAt: now, updatedAt: now,
      updatedBy: input.actor, archived: false, readonly: input.readonly ?? false, tags: input.tags ?? [],
    };
    this.blocks.set(id, block);
    this.recordEdit({ blockId: id, op: 'create', actor: input.actor, actorKind: 'agent', before: '', after: input.value, reason: 'tao block moi', versionBefore: 0, versionAfter: 1, at: now });
    return { ok: true, block: { ...block }, charsUsed: input.value.length, charsLimit: charLimit };
  }

  applyEdit(req: V20BlockEditRequest): V20BlockEditResult {
    const block = this.blocks.get(req.blockId) ?? this.getBlock(req.blockId);
    if (!block) return { ok: false, error: `khong tim thay block "${req.blockId}"`, errorCode: 'block_not_found' };
    if (block.archived && req.op !== 'archive') return { ok: false, error: `block "${block.label}" da luu tru`, errorCode: 'block_archived' };
    if (block.readonly && req.actorKind !== 'user') return { ok: false, error: `block "${block.label}" chi doc voi agent`, errorCode: 'block_readonly' };
    if (!req.reason || req.reason.trim().length < V20_MIN_REASON_LENGTH) return { ok: false, error: 'can ly do sua doi (toi thieu 3 ky tu)', errorCode: 'empty_reason' };
    if (req.expectedVersion !== undefined && req.expectedVersion !== block.version) {
      return { ok: false, error: `phien ban da doi: ky vong ${req.expectedVersion}, hien tai ${block.version}`, errorCode: 'version_conflict' };
    }
    const computed = this.computeNewValue(block, req);
    if (typeof computed === 'string') return { ok: false, error: computed, errorCode: this.errorCodeFor(computed) };
    const after = computed.value;
    if (after.length > block.charLimit) {
      return { ok: false, error: `vuot gioi han ${block.charLimit} ky tu (hien ${after.length})`, errorCode: 'over_char_limit', charsUsed: after.length, charsLimit: block.charLimit };
    }
    const now = Date.now();
    const next: V20CoreBlock = { ...block, value: after, version: block.version + 1, updatedAt: now, updatedBy: req.actor, archived: req.op === 'archive' ? true : block.archived };
    this.blocks.set(block.id, next);
    const edit = this.recordEdit({ blockId: block.id, op: req.op, actor: req.actor, actorKind: req.actorKind, before: block.value, after, reason: req.reason.trim(), versionBefore: block.version, versionAfter: next.version, at: now, toolCallId: req.toolCallId });
    return { ok: true, block: { ...next }, edit, charsUsed: after.length, charsLimit: block.charLimit };
  }

  private errorCodeFor(msg: string): V20BlockErrorCode {
    if (msg.includes('khoang')) return 'invalid_range';
    if (msg.includes('trong')) return 'empty_value';
    return 'invalid_op';
  }

  private computeNewValue(block: V20CoreBlock, req: V20BlockEditRequest): { value: string } | string {
    const cur = block.value;
    switch (req.op) {
      case 'replace': {
        if (req.newValue === undefined) return 'replace can newValue';
        if (!req.newValue.trim()) return 'gia tri moi khong duoc de trong';
        return { value: req.newValue };
      }
      case 'append': {
        if (!req.text) return 'append can text';
        return { value: cur ? `${cur}\n${req.text}` : req.text };
      }
      case 'prepend': {
        if (!req.text) return 'prepend can text';
        return { value: cur ? `${req.text}\n${cur}` : req.text };
      }
      case 'insert': {
        if (!req.text) return 'insert can text';
        const at = req.start ?? cur.length;
        if (at < 0 || at > cur.length) return `khoang chen ${at} nam ngoai do dai ${cur.length}`;
        return { value: cur.slice(0, at) + req.text + cur.slice(at) };
      }
      case 'delete_range': {
        const start = req.start ?? 0;
        const end = req.end ?? cur.length;
        if (start < 0 || end > cur.length || start >= end) return `khoang xoa [${start}, ${end}) khong hop le voi do dai ${cur.length}`;
        return { value: cur.slice(0, start) + cur.slice(end) };
      }
      case 'archive':
        return { value: cur };
      default:
        return `op khong ho tro: ${String(req.op)}`;
    }
  }

  private recordEdit(e: Omit<V20BlockEdit, 'id' | 'reverted'>): V20BlockEdit {
    this.seq += 1;
    const edit: V20BlockEdit = { ...e, id: `edit-${this.seq}`, reverted: false };
    const list = this.history.get(e.blockId) ?? [];
    list.push(edit);
    this.history.set(e.blockId, list);
    return edit;
  }

  /**
   * Khoi phuc block da luu tru: tao version moi, mo co `archived`,
   * ghi lich su op 'restore' (qua recordEdit truc tiep vi applyEdit
   * chan moi op tren block archived). Tra ve false neu khong ton
   * tai / chua archived / ly do qua ngan.
   */
  restoreBlock(blockId: string, actor: string, reason: string): V20BlockEditResult {
    const block = this.blocks.get(blockId) ?? this.getBlock(blockId);
    if (!block) return { ok: false, error: `khong tim thay block "${blockId}"`, errorCode: 'block_not_found' };
    if (!block.archived) return { ok: false, error: `block "${block.label}" khong o trang thai luu tru`, errorCode: 'invalid_op' };
    if (!reason || reason.trim().length < V20_MIN_REASON_LENGTH) return { ok: false, error: 'can ly do khoi phuc (toi thieu 3 ky tu)', errorCode: 'empty_reason' };
    const now = Date.now();
    const next: V20CoreBlock = { ...block, archived: false, version: block.version + 1, updatedAt: now, updatedBy: actor };
    this.blocks.set(block.id, next);
    const edit = this.recordEdit({ blockId: block.id, op: 'restore', actor, actorKind: 'agent', before: block.value, after: block.value, reason: reason.trim(), versionBefore: block.version, versionAfter: next.version, at: now });
    return { ok: true, block: { ...next }, edit, charsUsed: next.value.length, charsLimit: next.charLimit };
  }

  getHistory(blockId: string): V20BlockEdit[] {
    return (this.history.get(blockId) ?? []).map((e) => ({ ...e }));
  }

  /**
   * Khoi phuc block ve mot version cu (v21 bo sung — v20 goi ham
   * nay tu blockVersioning.rollbackBlockV20 nhung chua dinh nghia).
   * Tao version MOI copy noi dung cu (lich su khong bi viet lai),
   * ghi edit op 'rollback' co ly do. Tra loi co cau truc thay vi
   * throw, de host/tool hien thi duoc cho user.
   */
  rollbackBlock(blockId: string, targetVersion: number, actor: string, reason: string): V20BlockEditResult {
    const block = this.blocks.get(blockId) ?? this.getBlock(blockId);
    if (!block) return { ok: false, error: `khong tim thay block "${blockId}"`, errorCode: 'block_not_found' };
    if (block.archived) return { ok: false, error: `block "${block.label}" da luu tru`, errorCode: 'block_archived' };
    if (block.readonly) return { ok: false, error: `block "${block.label}" chi doc voi agent`, errorCode: 'block_readonly' };
    if (!reason || reason.trim().length < V20_MIN_REASON_LENGTH) return { ok: false, error: 'can ly do rollback (toi thieu 3 ky tu)', errorCode: 'empty_reason' };
    if (!Number.isInteger(targetVersion) || targetVersion < 1) return { ok: false, error: `version dich phai la so nguyen >= 1 (nhan ${targetVersion})`, errorCode: 'invalid_op' };
    if (block.version === targetVersion) return { ok: false, error: `block "${block.label}" dang o version ${targetVersion}`, errorCode: 'invalid_op' };
    const history = this.history.get(block.id) ?? [];
    const target = history.find((e) => e.versionAfter === targetVersion);
    if (!target) return { ok: false, error: `block "${block.label}" khong co version ${targetVersion} (hien tai v${block.version})`, errorCode: 'version_conflict' };
    if (!target.after.trim()) return { ok: false, error: `version ${targetVersion} cua block "${block.label}" rong, khong rollback ve noi dung rong`, errorCode: 'empty_value' };
    const now = Date.now();
    const next: V20CoreBlock = { ...block, value: target.after, version: block.version + 1, updatedAt: now, updatedBy: actor };
    this.blocks.set(block.id, next);
    const edit = this.recordEdit({ blockId: block.id, op: 'rollback', actor, actorKind: 'agent', before: block.value, after: target.after, reason: reason.trim(), versionBefore: block.version, versionAfter: next.version, at: now });
    return { ok: true, block: { ...next }, edit, charsUsed: next.value.length, charsLimit: next.charLimit };
  }

  historySize(blockId: string): number {
    return this.history.get(blockId)?.length ?? 0;
  }

  totalChars(): number {
    return [...this.blocks.values()].filter((b) => !b.archived).reduce((n, b) => n + b.value.length, 0);
  }

  renderSystemPromptSection(): string {
    const active = this.listBlocks(false);
    if (!active.length) return '';
    return active.map((b) => `[${b.label}]\n${b.value}`).join('\n\n');
  }
}
