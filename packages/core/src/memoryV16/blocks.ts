/**
 * Memory v16 — Self-managed core memory blocks (v1.35, Doi T1).
 *
 * Y tuong hoc tu Letta (core memory: agent tu sua block persona /
 * human / task qua tool `core_memory_replace` — thay the CHINH XAC
 * mot doan text, khong ghi de mu; block co the PIN de bao ve khoi
 * sleep-time reorganizer) — tu thiet ke lai hoan toan cho open-bot,
 * chay 100% local, KHONG copy code/text/tai san cua bat ky repo nao.
 *
 * Moi so voi blocks v15 (lop block RIENG cua v16 de tranh xung dot
 * voi cac doi khac — khong dung lai code v15):
 *  1. Core blocks: 3 kind persona/human/task duoc danh dau `core`,
 *     host co the khoi tao bo mac dinh bang ensureCoreBlocksM16.
 *  2. Exact-match replace kieu `core_memory_replace`: oldText phai
 *     khop CHINH XAC 1 lan trong block; khong khop -> loi kem goi y
 *     (so lan xuat hien, doan text gan nhat); khop nhieu lan -> loi
 *     bat buoc chi ro hon. Khong co ghi de mu.
 *  3. Pinning: pin(label) bao ve block khoi moi edit thuong + khoi
 *     sleep-time reorganizer (chi edit duoc khi force + ly do);
 *     pinVersion(label, version) dong bang mot version cu thanh
 *     snapshot (khoi phuc bat cu luc nao, ke ca khi block da bi sua
 *     nhieu lan sau do).
 *  4. Char budget theo kind + tong: vuot budget kind -> tu choi
 *     edit (ke ca append); vuot tong -> canh bao trong budgetReport.
 *  5. Compile `<memory_blocks>`: block pinned len truoc, roi moi
 *     theo do uu tien kind (persona > human > task > system >
 *     custom) — pinned luon hien trong prompt.
 */

import { normalizeGraphText } from '../memory/graph/types';

/** Loi blocks v16 — message tieng Viet. */
export class M16BlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'M16BlockError';
  }
}

/** Kind cua block — quyet dinh thu tu compile vao prompt. */
export type M16BlockKind = 'persona' | 'human' | 'task' | 'system' | 'custom';

export const M16_BLOCK_KINDS: ReadonlySet<string> = new Set([
  'persona',
  'human',
  'task',
  'system',
  'custom',
]);

/** Kind core: agent tu quan ly truc tiep qua tool. */
export const M16_CORE_KINDS: ReadonlySet<string> = new Set(['persona', 'human', 'task']);

/** Gioi han kich thuoc block (ky tu). */
export const M16_MAX_BLOCK_CHARS = 8000;
/** Gioi han so block trong mot store. */
export const M16_MAX_BLOCKS = 32;
/** Gioi han do dai label. */
export const M16_MAX_LABEL_CHARS = 64;
/** Tong budget ky tu cho toan bo store (de UI canh bao context). */
export const M16_TOTAL_CHAR_BUDGET = 32000;
/** Budget ky tu mac dinh theo kind. */
export const M16_KIND_CHAR_BUDGET: Record<M16BlockKind, number> = {
  persona: 4000,
  human: 4000,
  task: 6000,
  system: 2000,
  custom: 8000,
};

/** Do uu tien compile: persona truoc, custom cuoi. */
export const M16_BLOCK_KIND_PRIORITY: Record<M16BlockKind, number> = {
  persona: 0,
  human: 1,
  task: 2,
  system: 3,
  custom: 4,
};

export function blockPromptPriorityM16(kind: M16BlockKind): number {
  return M16_BLOCK_KIND_PRIORITY[kind] ?? 99;
}

/** Noi dung mac dinh cho 3 core block khi host khoi tao. */
export const M16_DEFAULT_CORE_CONTENT: Record<'persona' | 'human' | 'task', string> = {
  persona:
    'Ban la tro ly AI cua open-bot: tra loi ngan gon, trung thuc, ' +
    'noi tieng Viet khi user noi tieng Viet. Khong tu nhan la san pham cua hang khac.',
  human:
    'Chua co thong tin ve user. Khi user chia se so thich, cong viec, muc tieu, ' +
    'hay ghi lai ngan gon vao block nay.',
  task:
    'Khong co nhiem vu dang chay. Khi user giao viec dai han, ghi tom tat muc tieu, ' +
    'tien do va buoc tiep theo vao block nay.',
};

/** Mot snapshot version cua block (de rollback). */
export interface M16BlockVersion {
  version: number;
  content: string;
  editedBy: string;
  editedAt: string;
  reason: string;
}

/** Mot snapshot version da PIN (dong bang — khoi phuc bat cu luc nao). */
export interface M16PinnedSnapshot {
  version: number;
  content: string;
  pinnedAt: string;
  pinnedBy: string;
  reason: string;
}

/** Mot memory block co version + pinning. */
export interface M16MemoryBlock {
  id: string;
  label: string;
  kind: M16BlockKind;
  content: string;
  version: number;
  /** true = block core (persona/human/task) do agent tu quan ly. */
  core: boolean;
  /** true = da pin — bao ve khoi edit thuong + sleep reorganizer. */
  pinned: boolean;
  pinnedAt: string | null;
  pinnedBy: string | null;
  /** Snapshot version da pin (null = chua pin version nao). */
  pinnedSnapshot: M16PinnedSnapshot | null;
  createdAt: string;
  updatedAt: string;
  /** Lich su version cu (moi nhat cuoi danh sach). */
  history: M16BlockVersion[];
}

/** Label hop le: chu cai/so/gach duoi/gach ngang, bat dau bang chu cai. */
export function isValidBlockLabelM16(label: string): boolean {
  const clean = (label ?? '').trim();
  if (clean.length === 0 || clean.length > M16_MAX_LABEL_CHARS) return false;
  return /^[A-Za-zÀ-ỹ_][A-Za-zÀ-ỹ0-9_\- ]*$/.test(clean);
}

export function normalizeBlockLabelM16(raw: string): string {
  return (raw ?? '').trim().replace(/\s+/g, ' ');
}

/**
 * Validate noi dung block: khong rong, khong qua lon, khong chua
 * tag `<memory_blocks>` (chong chen prompt qua block), khong chua
 * ky tu dieu khien (tru \n, \t).
 */
export function validateBlockContentM16(content: string): { ok: true } | { ok: false; reason: string } {
  const text = content ?? '';
  if (text.trim() === '') return { ok: false, reason: 'Noi dung block khong duoc rong.' };
  if (text.length > M16_MAX_BLOCK_CHARS) {
    return {
      ok: false,
      reason: `Block dai ${text.length} ky tu, vuot gioi han ${M16_MAX_BLOCK_CHARS} — dung sleep-time reorganizer hoac chia nho truoc.`,
    };
  }
  if (/<\/?memory_blocks>/i.test(text)) {
    return { ok: false, reason: 'Noi dung block khong duoc chua tag <memory_blocks>.' };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) {
    return { ok: false, reason: 'Noi dung block chua ky tu dieu khien khong hop le.' };
  }
  return { ok: true };
}

function newBlockIdM16(): string {
  return `blk-v16-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`;
}

function nowIsoM16(): string {
  return new Date().toISOString();
}

/** Bao cao budget: tong + theo kind, ke ca muc vuot. */
export interface M16BudgetReport {
  totalChars: number;
  totalBudget: number;
  totalOver: boolean;
  perKind: { kind: M16BlockKind; chars: number; budget: number; over: boolean }[];
}

/** Mot muc trong audit trail cua block store (append-only). */
export interface M16BlockAuditEntry {
  at: string;
  action: string;
  label: string;
  actor: string;
  reason: string;
  /** Version cua block sau hanh dong (0 = block da xoa). */
  versionAfter: number;
  detail: string;
}

/**
 * Store block v16 — in-memory, serialize duoc sang JSON (de host
 * luu file tuy y; store khong tu ghi dia de tranh phu thuoc IO).
 */
export class M16BlockStore {
  private readonly blocks = new Map<string, M16MemoryBlock>();
  /** Audit trail append-only: moi lan sua block (moi nhat cuoi). */
  readonly auditLog: M16BlockAuditEntry[] = [];

  /** So block hien co. */
  get size(): number {
    return this.blocks.size;
  }

  list(kind?: M16BlockKind): M16MemoryBlock[] {
    const all = [...this.blocks.values()];
    const filtered = kind ? all.filter((b) => b.kind === kind) : all;
    filtered.sort(
      (a, b) =>
        // Pinned len truoc, roi theo kind, roi theo label.
        (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1) ||
        blockPromptPriorityM16(a.kind) - blockPromptPriorityM16(b.kind) ||
        a.label.localeCompare(b.label),
    );
    return filtered.map((b) => ({ ...b, history: [...b.history] }));
  }

  get(label: string): M16MemoryBlock | undefined {
    const key = normalizeGraphText(normalizeBlockLabelM16(label));
    for (const b of this.blocks.values()) {
      if (normalizeGraphText(b.label) === key) {
        return { ...b, history: [...b.history] };
      }
    }
    return undefined;
  }

  getById(id: string): M16MemoryBlock | undefined {
    const b = this.blocks.get(id);
    return b ? { ...b, history: [...b.history] } : undefined;
  }

  /** Chi block core (persona/human/task). */
  listCore(): M16MemoryBlock[] {
    return this.list().filter((b) => b.core);
  }

  /** Chi block da pin. */
  listPinned(): M16MemoryBlock[] {
    return this.list().filter((b) => b.pinned);
  }

  /** Khoi tao 3 core block mac dinh neu chua co (idempotent). */
  ensureCoreBlocks(actor = 'system'): M16MemoryBlock[] {
    const created: M16MemoryBlock[] = [];
    const defaults: { label: string; kind: 'persona' | 'human' | 'task' }[] = [
      { label: 'persona', kind: 'persona' },
      { label: 'human', kind: 'human' },
      { label: 'task', kind: 'task' },
    ];
    for (const d of defaults) {
      const existing = this.get(d.label);
      if (existing) {
        if (!existing.core) {
          // Block trung label nhung chua danh dau core -> danh dau lai.
          const inner = this.mustGet(d.label);
          inner.core = true;
          inner.updatedAt = nowIsoM16();
        }
        continue;
      }
      created.push(this.create(d.label, d.kind, M16_DEFAULT_CORE_CONTENT[d.kind], actor));
    }
    return created;
  }

  /** Tao block moi (label duy nhat, khong phan biet hoa/thuong). */
  create(
    label: string,
    kind: M16BlockKind,
    content: string,
    actor = 'user',
  ): M16MemoryBlock {
    const cleanLabel = normalizeBlockLabelM16(label);
    if (!isValidBlockLabelM16(cleanLabel)) {
      throw new M16BlockError(
        `Label block khong hop le: "${label}" (chu cai/so/gach duoi/gach ngang, toi da ${M16_MAX_LABEL_CHARS} ky tu).`,
      );
    }
    if (!M16_BLOCK_KINDS.has(kind)) {
      throw new M16BlockError(`Kind block khong hop le: "${kind}".`);
    }
    if (this.get(cleanLabel)) {
      throw new M16BlockError(`Block "${cleanLabel}" da ton tai — dung replace/append thay vi tao moi.`);
    }
    if (this.blocks.size >= M16_MAX_BLOCKS) {
      throw new M16BlockError(`Da dat gioi han ${M16_MAX_BLOCKS} block — xoa/gop block truoc.`);
    }
    const checked = validateBlockContentM16(content);
    if (!checked.ok) throw new M16BlockError(checked.reason);
    const kindBudget = M16_KIND_CHAR_BUDGET[kind];
    if (content.length > kindBudget) {
      throw new M16BlockError(
        `Block "${cleanLabel}" dai ${content.length} ky tu, vuot budget kind ${kind} (${kindBudget}) — rut gon truoc khi tao.`,
      );
    }
    const now = nowIsoM16();
    const block: M16MemoryBlock = {
      id: newBlockIdM16(),
      label: cleanLabel,
      kind,
      content,
      version: 1,
      core: M16_CORE_KINDS.has(kind),
      pinned: false,
      pinnedAt: null,
      pinnedBy: null,
      pinnedSnapshot: null,
      createdAt: now,
      updatedAt: now,
      history: [],
    };
    this.blocks.set(block.id, block);
    this.logAudit('create', cleanLabel, actor, '', 1, `Tao block kind ${kind} (${content.length} ky tu).`);
    void actor;
    return { ...block, history: [] };
  }

  /**
   * Kiem tra quyen edit: block pinned chi sua duoc khi force=true
   * (kem ly do). Tra ve ly do tu choi, hoac null neu duoc phep.
   */
  editGuard(label: string, force: boolean, reason: string): string | null {
    const block = this.get(label);
    if (!block) return null;
    if (block.pinned && !force) {
      return `Block "${label}" dang PIN — chi sua duoc khi force=true kem ly do (pin bao ve khoi edit thuong).`;
    }
    if (block.pinned && force && (reason ?? '').trim() === '') {
      return `Sua block PIN "${label}" can co ly do (reason khong duoc rong).`;
    }
    return null;
  }

  private applyEdit(
    block: M16MemoryBlock,
    next: string,
    actor: string,
    reason: string,
    force: boolean,
  ): M16MemoryBlock {
    const guard = this.editGuard(block.label, force, reason);
    if (guard) throw new M16BlockError(guard);
    const checked = validateBlockContentM16(next);
    if (!checked.ok) throw new M16BlockError(checked.reason);
    const kindBudget = M16_KIND_CHAR_BUDGET[block.kind];
    if (next.length > kindBudget) {
      throw new M16BlockError(
        `Noi dung moi dai ${next.length} ky tu, vuot budget kind ${block.kind} (${kindBudget}) — rut gon truoc.`,
      );
    }
    block.history.push(this.snapshot(block, actor, reason || 'edit'));
    block.content = next;
    block.version += 1;
    block.updatedAt = nowIsoM16();
    this.logAudit('edit', block.label, actor, reason, block.version, `Doi noi dung (${next.length} ky tu): ${reason || 'edit'}.`);
    return { ...block, history: [...block.history] };
  }

  /** Ghi de toan bo noi dung block (tang version, luu snapshot cu). */
  replace(label: string, content: string, actor = 'user', reason = '', force = false): M16MemoryBlock {
    const block = this.mustGet(label);
    // Truyen reason tho vao applyEdit: guard phai thay reason rong
    // (pinned + force ma khong co ly do -> tu choi). applyEdit tu
    // default reason cho snapshot/audit sau khi guard pass.
    return this.applyEdit(block, content, actor, reason, force);
  }

  /** Noi them text vao cuoi block (tang version). */
  append(label: string, text: string, actor = 'user', reason = '', force = false): M16MemoryBlock {
    const block = this.mustGet(label);
    const next = block.content.endsWith('\n') || block.content === '' ? `${block.content}${text}` : `${block.content}\n${text}`;
    return this.applyEdit(block, next, actor, reason, force);
  }

  /** Chen text vao vi tri ky tu `position` (tang version). */
  insert(
    label: string,
    position: number,
    text: string,
    actor = 'user',
    reason = '',
    force = false,
  ): M16MemoryBlock {
    const block = this.mustGet(label);
    const pos = Math.floor(position);
    if (!Number.isInteger(pos) || pos < 0 || pos > block.content.length) {
      throw new M16BlockError(`Vi tri chen khong hop le: ${position} (do dai block ${block.content.length}).`);
    }
    const next = block.content.slice(0, pos) + text + block.content.slice(pos);
    return this.applyEdit(block, next, actor, reason, force);
  }

  /** Xoa doan [start, end) cua block (tang version). */
  deleteRange(
    label: string,
    start: number,
    end: number,
    actor = 'user',
    reason = '',
    force = false,
  ): M16MemoryBlock {
    const block = this.mustGet(label);
    const s = Math.floor(start);
    const e = Math.floor(end);
    if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e <= s || e > block.content.length) {
      throw new M16BlockError(
        `Khoang xoa khong hop le: [${start}, ${end}) (do dai block ${block.content.length}).`,
      );
    }
    const next = block.content.slice(0, s) + block.content.slice(e);
    if (next.trim() === '') {
      throw new M16BlockError('Khong the xoa het noi dung block — dung delete de xoa ca block.');
    }
    return this.applyEdit(block, next, actor, reason, force);
  }

  /** Xoa ca block (block pinned khong xoa duoc neu khong force). */
  delete(label: string, force = false): boolean {
    const block = this.get(label);
    if (!block) return false;
    if (block.pinned && !force) {
      throw new M16BlockError(`Block "${label}" dang PIN — khong xoa duoc neu khong unpin hoac force=true.`);
    }
    const ok = this.blocks.delete(block.id);
    if (ok) this.logAudit('delete', block.label, 'user', '', 0, 'Xoa ca block.');
    return ok;
  }

  /**
   * Doi ten block (giu nguyen id, version, history, pin). Label moi
   * phai hop le + chua ton tai. Ghi audit.
   */
  rename(label: string, newLabel: string, actor = 'user', reason = ''): M16MemoryBlock {
    const block = this.mustGet(label);
    const clean = normalizeBlockLabelM16(newLabel);
    if (!isValidBlockLabelM16(clean)) {
      throw new M16BlockError(`Label block moi khong hop le: "${newLabel}".`);
    }
    if (normalizeGraphText(clean) === normalizeGraphText(block.label)) {
      return { ...block, history: [...block.history] };
    }
    if (this.get(clean)) {
      throw new M16BlockError(`Block "${clean}" da ton tai — khong the doi ten thanh label nay.`);
    }
    const oldLabel = block.label;
    block.label = clean;
    block.updatedAt = nowIsoM16();
    this.logAudit('rename', clean, actor, reason, block.version, `Doi ten "${oldLabel}" -> "${clean}".`);
    return { ...block, history: [...block.history] };
  }

  /** Rollback ve mot version cu (version hien tai cung vao history). */
  rollback(label: string, version: number, actor = 'user', force = false): M16MemoryBlock {
    const block = this.mustGet(label);
    const guard = this.editGuard(label, force, `rollback to v${version}`);
    if (guard) throw new M16BlockError(guard);
    if (version === block.version) return { ...block, history: [...block.history] };
    const target = block.history.find((h) => h.version === version);
    if (!target) {
      throw new M16BlockError(`Block "${label}" khong co version ${version}.`);
    }
    block.history.push(this.snapshot(block, actor, `rollback to v${version}`));
    block.content = target.content;
    block.version += 1;
    block.updatedAt = nowIsoM16();
    this.logAudit('rollback', block.label, actor, `rollback to v${version}`, block.version, `Khoi phuc noi dung version ${version}.`);
    return { ...block, history: [...block.history] };
  }

  /** Lich su version cua mot block (cu nhat dau danh sach). */
  history(label: string): M16BlockVersion[] {
    const block = this.mustGet(label);
    return [...block.history];
  }

  // ---- Pinning ----------------------------------------------------------

  /** Pin block: bao ve khoi edit thuong + sleep reorganizer. */
  pin(label: string, actor = 'user', reason = ''): M16MemoryBlock {
    const block = this.mustGet(label);
    if (block.pinned) {
      throw new M16BlockError(`Block "${label}" da duoc pin roi.`);
    }
    block.pinned = true;
    block.pinnedAt = nowIsoM16();
    block.pinnedBy = actor;
    block.history.push(this.snapshot(block, actor, reason || 'pin'));
    block.updatedAt = nowIsoM16();
    this.logAudit('pin', block.label, actor, reason, block.version, 'Pin block (bao ve khoi edit thuong + sleep reorganizer).');
    return { ...block, history: [...block.history] };
  }

  /** Bo pin block (snapshot version da pin — neu co — van giu nguyen). */
  unpin(label: string, actor = 'user', reason = ''): M16MemoryBlock {
    const block = this.mustGet(label);
    if (!block.pinned) {
      throw new M16BlockError(`Block "${label}" chua duoc pin.`);
    }
    block.pinned = false;
    block.pinnedAt = null;
    block.pinnedBy = null;
    block.history.push(this.snapshot(block, actor, reason || 'unpin'));
    block.updatedAt = nowIsoM16();
    this.logAudit('unpin', block.label, actor, reason, block.version, 'Bo pin block.');
    return { ...block, history: [...block.history] };
  }

  /**
   * Dong bang mot version cu (hoac version hien tai) thanh snapshot
   * da pin. Version phai ton tai trong history hoac la version hien tai.
   */
  pinVersion(label: string, version: number, actor = 'user', reason = ''): M16MemoryBlock {
    const block = this.mustGet(label);
    let content: string | undefined;
    if (version === block.version) {
      content = block.content;
    } else {
      const target = block.history.find((h) => h.version === version);
      content = target?.content;
    }
    if (content === undefined) {
      throw new M16BlockError(`Block "${label}" khong co version ${version} de pin.`);
    }
    block.pinnedSnapshot = {
      version,
      content,
      pinnedAt: nowIsoM16(),
      pinnedBy: actor,
      reason: (reason ?? '').slice(0, 200),
    };
    block.updatedAt = nowIsoM16();
    this.logAudit('pin_version', block.label, actor, reason, block.version, `Pin snapshot version ${version}.`);
    return { ...block, history: [...block.history] };
  }

  /** Xoa snapshot version da pin (khong anh huong pin cua block). */
  unpinVersion(label: string, actor = 'user'): M16MemoryBlock {
    const block = this.mustGet(label);
    if (!block.pinnedSnapshot) {
      throw new M16BlockError(`Block "${label}" khong co snapshot version nao dang pin.`);
    }
    block.pinnedSnapshot = null;
    block.updatedAt = nowIsoM16();
    this.logAudit('unpin_version', block.label, actor, '', block.version, 'Xoa snapshot version da pin.');
    void actor;
    return { ...block, history: [...block.history] };
  }

  /**
   * Khoi phuc noi dung tu snapshot version da pin (tang version nhu
   * rollback binh thuong; snapshot van giu nguyen de dung lai).
   */
  restorePinnedVersion(label: string, actor = 'user', force = false): M16MemoryBlock {
    const block = this.mustGet(label);
    if (!block.pinnedSnapshot) {
      throw new M16BlockError(`Block "${label}" khong co snapshot version nao dang pin de khoi phuc.`);
    }
    const guard = this.editGuard(label, force, 'restore pinned version');
    if (guard) throw new M16BlockError(guard);
    block.history.push(this.snapshot(block, actor, `restore pinned v${block.pinnedSnapshot.version}`));
    block.content = block.pinnedSnapshot.content;
    block.version += 1;
    block.updatedAt = nowIsoM16();
    this.logAudit('restore_pinned', block.label, actor, '', block.version, `Khoi phuc tu snapshot v${block.pinnedSnapshot.version}.`);
    return { ...block, history: [...block.history] };
  }

  /** Audit trail cua mot block (cu nhat dau) hoac toan bo store. */
  auditTrail(label?: string): M16BlockAuditEntry[] {
    const all = [...this.auditLog];
    if (!label) return all;
    const key = normalizeGraphText(normalizeBlockLabelM16(label));
    return all.filter((e) => normalizeGraphText(e.label) === key);
  }

  /** Tom tat audit: dem theo action + actor. */
  auditSummary(): { total: number; byAction: Record<string, number>; byActor: Record<string, number> } {
    const byAction: Record<string, number> = {};
    const byActor: Record<string, number> = {};
    for (const e of this.auditLog) {
      byAction[e.action] = (byAction[e.action] ?? 0) + 1;
      byActor[e.actor] = (byActor[e.actor] ?? 0) + 1;
    }
    return { total: this.auditLog.length, byAction, byActor };
  }

  private logAudit(
    action: string,
    label: string,
    actor: string,
    reason: string,
    versionAfter: number,
    detail: string,
  ): void {
    this.auditLog.push({
      at: nowIsoM16(),
      action,
      label,
      actor,
      reason: (reason ?? '').slice(0, 200),
      versionAfter,
      detail: (detail ?? '').slice(0, 500),
    });
  }

  /** Tong so ky tu cua tat ca block (de UI canh bao context). */
  totalChars(): number {
    let total = 0;
    for (const b of this.blocks.values()) total += b.content.length;
    return total;
  }

  /** So ky tu cua mot kind. */
  kindChars(kind: M16BlockKind): number {
    let total = 0;
    for (const b of this.blocks.values()) if (b.kind === kind) total += b.content.length;
    return total;
  }

  /** Bao cao budget theo kind + tong. */
  budgetReport(): M16BudgetReport {
    const total = this.totalChars();
    const perKind = (Object.keys(M16_KIND_CHAR_BUDGET) as M16BlockKind[]).map((kind) => {
      const chars = this.kindChars(kind);
      const budget = M16_KIND_CHAR_BUDGET[kind];
      return { kind, chars, budget, over: chars > budget };
    });
    return { totalChars: total, totalBudget: M16_TOTAL_CHAR_BUDGET, totalOver: total > M16_TOTAL_CHAR_BUDGET, perKind };
  }

  /** Serialize toan bo store (host tu luu file). */
  toJSON(): { version: 1; blocks: M16MemoryBlock[]; auditLog: M16BlockAuditEntry[] } {
    return {
      version: 1,
      blocks: [...this.blocks.values()],
      auditLog: [...this.auditLog],
    };
  }

  /** Khoi phuc store tu JSON (bo qua block loi, dem so bo qua). */
  static fromJSON(data: unknown): { store: M16BlockStore; skipped: number } {
    const store = new M16BlockStore();
    let skipped = 0;
    const raw = (data ?? {}) as { blocks?: unknown; auditLog?: unknown };
    if (!Array.isArray(raw.blocks)) return { store, skipped: 0 };
    for (const item of raw.blocks) {
      const b = item as Partial<M16MemoryBlock>;
      if (
        typeof b?.id !== 'string' ||
        typeof b?.label !== 'string' ||
        typeof b?.content !== 'string' ||
        typeof b?.version !== 'number' ||
        !M16_BLOCK_KINDS.has(b.kind ?? '')
      ) {
        skipped += 1;
        continue;
      }
      if (!isValidBlockLabelM16(b.label)) {
        skipped += 1;
        continue;
      }
      const content = b.content;
      if (
        content.trim() === '' ||
        /<\/?memory_blocks>/i.test(content) ||
        // eslint-disable-next-line no-control-regex
        /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(content)
      ) {
        skipped += 1;
        continue;
      }
      const pinnedSnapshot =
        b.pinnedSnapshot && typeof b.pinnedSnapshot.version === 'number' && typeof b.pinnedSnapshot.content === 'string'
          ? (b.pinnedSnapshot as M16PinnedSnapshot)
          : null;
      store.blocks.set(b.id, {
        id: b.id,
        label: b.label,
        kind: b.kind as M16BlockKind,
        content: b.content,
        version: b.version,
        core: b.core === true || M16_CORE_KINDS.has(b.kind as string),
        pinned: b.pinned === true,
        pinnedAt: typeof b.pinnedAt === 'string' ? b.pinnedAt : null,
        pinnedBy: typeof b.pinnedBy === 'string' ? b.pinnedBy : null,
        pinnedSnapshot,
        createdAt: typeof b.createdAt === 'string' ? b.createdAt : nowIsoM16(),
        updatedAt: typeof b.updatedAt === 'string' ? b.updatedAt : nowIsoM16(),
        history: Array.isArray(b.history) ? (b.history as M16BlockVersion[]) : [],
      });
    }
    if (Array.isArray(raw.auditLog)) {
      for (const e of raw.auditLog as M16BlockAuditEntry[]) {
        if (
          typeof e?.at === 'string' &&
          typeof e?.action === 'string' &&
          typeof e?.label === 'string' &&
          typeof e?.actor === 'string' &&
          typeof e?.versionAfter === 'number'
        ) {
          store.auditLog.push({
            at: e.at,
            action: e.action,
            label: e.label,
            actor: e.actor,
            reason: typeof e.reason === 'string' ? e.reason : '',
            versionAfter: e.versionAfter,
            detail: typeof e.detail === 'string' ? e.detail : '',
          });
        }
      }
    }
    return { store, skipped };
  }

  private mustGet(label: string): M16MemoryBlock {
    const key = normalizeGraphText(normalizeBlockLabelM16(label));
    for (const b of this.blocks.values()) {
      if (normalizeGraphText(b.label) === key) return b;
    }
    throw new M16BlockError(`Khong tim thay block "${label}".`);
  }

  private snapshot(block: M16MemoryBlock, actor: string, reason: string): M16BlockVersion {
    return {
      version: block.version,
      content: block.content,
      editedBy: actor,
      editedAt: nowIsoM16(),
      reason: (reason ?? '').slice(0, 200),
    };
  }
}

// ---------------------------------------------------------------------------
// core_memory_replace — agent tu sua block kieu Letta (exact match)
// ---------------------------------------------------------------------------

export type M16BlockEditAction =
  | 'create'
  | 'replace'
  | 'append'
  | 'insert'
  | 'delete_range'
  | 'delete'
  | 'rename'
  | 'core_memory_replace'
  | 'pin'
  | 'unpin';

export interface M16BlockEditOp {
  action: M16BlockEditAction;
  label: string;
  /** Label moi — bat buoc khi action = 'rename'. */
  newLabel?: string;
  /** Kind — bat buoc khi action = 'create'. */
  kind?: M16BlockKind;
  /** Noi dung moi — bat buoc khi create/replace. */
  content?: string;
  /** Text them/chen — bat buoc khi append/insert. */
  text?: string;
  /** Vi tri chen — bat buoc khi insert. */
  position?: number;
  /** Khoang xoa [start, end) — bat buoc khi delete_range. */
  start?: number;
  end?: number;
  /** Doan text cu phai khop CHINH XAC — bat buoc khi core_memory_replace. */
  oldText?: string;
  /** Doan text moi thay the oldText — bat buoc khi core_memory_replace. */
  newText?: string;
  /** true = cho phep sua block dang PIN (can kem reason). */
  force?: boolean;
  reason?: string;
}

export interface M16BlockEditResult {
  action: M16BlockEditAction;
  block: M16MemoryBlock | null;
  deleted: boolean;
}

export interface M16ReplacePreview {
  /** So lan oldText xuat hien trong block. */
  occurrences: number;
  /** Doan text xung quanh lan xuat hien dau (de agent tu sua). */
  context: string;
}

/**
 * Dem so lan `needle` xuat hien trong `haystack` + lay context
 * quanh lan dau (80 ky tu moi ben). Dung de bao loi cu the khi
 * core_memory_replace khong khop.
 */
export function previewReplaceM16(content: string, needle: string): M16ReplacePreview {
  if (!needle) return { occurrences: 0, context: '' };
  let count = 0;
  let first = -1;
  let from = 0;
  for (;;) {
    const idx = content.indexOf(needle, from);
    if (idx < 0) break;
    if (first < 0) first = idx;
    count += 1;
    from = idx + needle.length;
    if (count > 50) break;
  }
  if (first < 0) return { occurrences: 0, context: '' };
  const start = Math.max(0, first - 80);
  const end = Math.min(content.length, first + needle.length + 80);
  return { occurrences: count, context: content.slice(start, end) };
}

/**
 * core_memory_replace: thay the CHINH XAC mot doan text trong block.
 * oldText phai xuat hien DUNG 1 lan — 0 lan thi loi kem context goi y,
 * nhieu lan thi loi bat buoc chi ro doan dai hon. Day la cach agent
 * tu sua core block an toan: khong bao gio ghi de mu ca block.
 */
export function coreMemoryReplaceM16(
  store: M16BlockStore,
  label: string,
  oldText: string,
  newText: string,
  actor = 'agent',
  reason = '',
  force = false,
): M16MemoryBlock {
  const block = store.get(label);
  if (!block) throw new M16BlockError(`Khong tim thay block "${label}".`);
  if (typeof oldText !== 'string' || oldText === '') {
    throw new M16BlockError('core_memory_replace can co oldText (string, khong rong).');
  }
  if (typeof newText !== 'string') {
    throw new M16BlockError('core_memory_replace can co newText (string).');
  }
  const preview = previewReplaceM16(block.content, oldText);
  if (preview.occurrences === 0) {
    throw new M16BlockError(
      `oldText khong khop chinh xac trong block "${label}" (0 lan) — kiem tra lai dau cach/xuong dong. ` +
        `Doan gan nhat: "${preview.context}". Hay doc lai block bang block_list roi thu lai.`,
    );
  }
  if (preview.occurrences > 1) {
    throw new M16BlockError(
      `oldText xuat hien ${preview.occurrences} lan trong block "${label}" — hay dung doan dai hon ` +
        `de chi ro duy nhat 1 vi tri. Lan dau o: "${preview.context}".`,
    );
  }
  const next = block.content.replace(oldText, newText);
  // Guard bang reason THO truoc khi default: block pinned + force ma
  // khong co ly do that thi tu choi — khong de default
  // 'core_memory_replace' che mat ly do rong (store.replace se thay
  // reason non-empty nen guard trong applyEdit khong bat duoc).
  const guard = store.editGuard(label, force, reason);
  if (guard) throw new M16BlockError(guard);
  return store.replace(label, next, actor, reason || 'core_memory_replace', force);
}

/**
 * Ap dung mot op edit cua agent (dang tool call): validate day du
 * truoc khi doi gi — op loi thi store khong doi.
 */
export function applyBlockEditM16(
  store: M16BlockStore,
  op: M16BlockEditOp,
  actor = 'agent',
): M16BlockEditResult {
  const label = normalizeBlockLabelM16(op.label ?? '');
  if (!isValidBlockLabelM16(label)) {
    throw new M16BlockError(`Label block khong hop le: "${op.label ?? ''}".`);
  }
  const force = op.force === true;
  const reason = op.reason ?? '';
  switch (op.action) {
    case 'create': {
      if (!op.kind || !M16_BLOCK_KINDS.has(op.kind)) {
        throw new M16BlockError('Tao block can kind hop le (persona/human/task/system/custom).');
      }
      if (typeof op.content !== 'string') {
        throw new M16BlockError('Tao block can co content (string).');
      }
      const block = store.create(label, op.kind, op.content, actor);
      return { action: 'create', block, deleted: false };
    }
    case 'replace': {
      if (typeof op.content !== 'string') {
        throw new M16BlockError('Replace block can co content (string).');
      }
      const block = store.replace(label, op.content, actor, reason, force);
      return { action: 'replace', block, deleted: false };
    }
    case 'core_memory_replace': {
      if (typeof op.oldText !== 'string' || typeof op.newText !== 'string') {
        throw new M16BlockError('core_memory_replace can co oldText va newText (string).');
      }
      const block = coreMemoryReplaceM16(store, label, op.oldText, op.newText, actor, reason, force);
      return { action: 'core_memory_replace', block, deleted: false };
    }
    case 'append': {
      if (typeof op.text !== 'string' || op.text === '') {
        throw new M16BlockError('Append block can co text (string, khong rong).');
      }
      const block = store.append(label, op.text, actor, reason, force);
      return { action: 'append', block, deleted: false };
    }
    case 'insert': {
      if (typeof op.text !== 'string' || op.text === '') {
        throw new M16BlockError('Insert block can co text (string, khong rong).');
      }
      if (typeof op.position !== 'number') {
        throw new M16BlockError('Insert block can co position (number).');
      }
      const block = store.insert(label, op.position, op.text, actor, reason, force);
      return { action: 'insert', block, deleted: false };
    }
    case 'delete_range': {
      if (typeof op.start !== 'number' || typeof op.end !== 'number') {
        throw new M16BlockError('Delete_range can co start va end (number).');
      }
      const block = store.deleteRange(label, op.start, op.end, actor, reason, force);
      return { action: 'delete_range', block, deleted: false };
    }
    case 'delete': {
      const deleted = store.delete(label, force);
      if (!deleted) throw new M16BlockError(`Khong tim thay block "${label}" de xoa.`);
      return { action: 'delete', block: null, deleted: true };
    }
    case 'rename': {
      if (typeof op.newLabel !== 'string' || op.newLabel.trim() === '') {
        throw new M16BlockError('Rename block can co newLabel (string, khong rong).');
      }
      const block = store.rename(label, op.newLabel, actor, reason);
      return { action: 'rename', block, deleted: false };
    }
    case 'pin': {
      const block = store.pin(label, actor, reason);
      return { action: 'pin', block, deleted: false };
    }
    case 'unpin': {
      const block = store.unpin(label, actor, reason);
      return { action: 'unpin', block, deleted: false };
    }
    default:
      throw new M16BlockError(`Action block khong hop le: "${String(op.action)}".`);
  }
}

/** Compile cac block thanh `<memory_blocks>` de dua vao system prompt. */
export function compileBlocksM16(
  store: M16BlockStore,
  opts: { includeKinds?: M16BlockKind[]; coreOnly?: boolean } = {},
): string {
  let blocks = store.list();
  if (opts.coreOnly) blocks = blocks.filter((b) => b.core);
  if (opts.includeKinds) blocks = blocks.filter((b) => opts.includeKinds?.includes(b.kind));
  if (blocks.length === 0) return '';
  const lines = ['<memory_blocks>'];
  for (const b of blocks) {
    const pinMark = b.pinned ? ' 📌pinned' : '';
    const snapMark = b.pinnedSnapshot ? ` (snapshot v${b.pinnedSnapshot.version})` : '';
    lines.push(`[${b.kind}:${b.label}] (v${b.version}${pinMark}${snapMark})`);
    lines.push(b.content);
  }
  lines.push('</memory_blocks>');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Sleep-time reorganizer v16 — TON TRONG block pinned
// ---------------------------------------------------------------------------

export type M16SleepAction = 'merge' | 'truncate' | 'summarize' | 'skip' | 'protect';

export interface M16SleepLogEntry {
  at: string;
  action: M16SleepAction;
  label: string;
  detail: string;
}

export interface M16SleepOptions {
  /** Thoi gian tuong tac cuoi cung den nay (ms). Mac dinh 0 = khong biet -> khong chay tru force. */
  idleMs?: number;
  /** Nguong idle toi thieu de chay (mac dinh 5 phut). */
  idleThresholdMs?: number;
  /** true = chay ngay ca khi chua idle (test / goi tay). */
  force?: boolean;
  /** Nguong gop block nho (mac dinh 200 ky tu). */
  mergeSmallChars?: number;
  /** Nguong summarize block dai (mac dinh 4000 ky tu). */
  summarizeChars?: number;
  actor?: string;
  now?: Date;
}

export interface M16SleepReport {
  ran: boolean;
  reason: string;
  at: string;
  merged: number;
  truncated: number;
  summarized: number;
  protectedPinned: number;
  skipped: number;
  actions: M16SleepLogEntry[];
}

/** Nguong idle mac dinh de sleep-time chay (5 phut). */
export const M16_SLEEP_IDLE_THRESHOLD_MS = 5 * 60 * 1000;
/** Nguong gop: block nho hon muc nay (cung kind) co the gop. */
export const M16_MERGE_SMALL_CHARS = 200;
/** Nguong summarize: block dai hon muc nay duoc rut gon luc sleep. */
export const M16_SUMMARIZE_CHARS = 4000;

/** Tach text thanh cau (don gian, xac dinh — khong goi model). */
export function splitSentencesM16(text: string): string[] {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  if (clean === '') return [];
  const parts = clean.split(/(?<=[.!?…])\s+(?=[A-ZÀ-Ỹ0-9"“])/);
  const out: string[] = [];
  for (const p of parts) {
    const t = p.trim();
    if (t !== '') out.push(t);
  }
  return out.length > 0 ? out : [clean];
}

/**
 * Summarize extractive: giu 3 cau dau + cau cuoi (neu > 4 cau),
 * kem chu thich so cau da rut gon. Khong goi model, xac dinh.
 */
export function summarizeBlockExtractiveM16(content: string, maxChars: number): string {
  const sentences = splitSentencesM16(content);
  if (sentences.length <= 4 || content.length <= maxChars) return content;
  const kept = [...sentences.slice(0, 3), sentences[sentences.length - 1]];
  const note = `\n[…sleep-time summary v16: giu ${kept.length}/${sentences.length} cau, rut gon tu ${content.length} ky tu.]`;
  let out = kept.join(' ') + note;
  if (out.length > maxChars) {
    out = kept.join(' ').slice(0, Math.max(0, maxChars - note.length - 3)) + '…' + note;
  }
  return out;
}

/** Truncate: giu 60% dau + chu thich + 20% cuoi. */
export function truncateBlockM16(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const headLen = Math.floor(maxChars * 0.6);
  const tailLen = Math.floor(maxChars * 0.2);
  const removed = content.length - headLen - tailLen;
  return (
    content.slice(0, headLen) +
    `\n[…sleep-time truncate v16: da cat ${removed} ky tu o giua.]` +
    '\n' +
    content.slice(content.length - tailLen)
  );
}

/**
 * Sleep-time reorganizer v16: chi chay khi idle du nguong (hoac
 * force). KHAC v15: block PINNED duoc bao ve tuyet doi — khong gop,
 * khong truncate, khong summarize (dem vao protectedPinned, ghi log
 * `protect`). Thu tu: (1) gop block nho cung kind (bo qua pinned),
 * (2) truncate block vuot gioi han, (3) summarize block dai. Moi
 * hanh dong deu tang version + luu history (qua replace) va ghi log.
 */
export function runSleepReorganizeM16(
  store: M16BlockStore,
  opts: M16SleepOptions = {},
): M16SleepReport {
  const now = opts.now ?? new Date();
  const at = now.toISOString();
  const threshold = opts.idleThresholdMs ?? M16_SLEEP_IDLE_THRESHOLD_MS;
  const idleMs = opts.idleMs ?? 0;
  const actor = opts.actor ?? 'sleep-agent-v16';
  if (!opts.force && idleMs < threshold) {
    return {
      ran: false,
      reason: `Chua idle du ${Math.round(threshold / 1000)}s (idle ${Math.round(idleMs / 1000)}s) — bo qua luot sleep nay.`,
      at,
      merged: 0,
      truncated: 0,
      summarized: 0,
      protectedPinned: store.listPinned().length,
      skipped: 0,
      actions: [],
    };
  }
  const mergeSmall = opts.mergeSmallChars ?? M16_MERGE_SMALL_CHARS;
  const summarizeAt = opts.summarizeChars ?? M16_SUMMARIZE_CHARS;
  const actions: M16SleepLogEntry[] = [];
  let merged = 0;
  let truncated = 0;
  let summarized = 0;
  let skipped = 0;
  let protectedPinned = 0;

  // (0) Ghi nhan block pinned duoc bao ve.
  for (const b of store.listPinned()) {
    protectedPinned += 1;
    actions.push({
      at,
      action: 'protect',
      label: b.label,
      detail: `Block dang PIN — bo qua reorganize (giu nguyen v${b.version}).`,
    });
  }

  // (1) Gop block nho cung kind (chi block KHONG pin).
  const byKind = new Map<M16BlockKind, M16MemoryBlock[]>();
  for (const b of store.list()) {
    if (b.pinned) continue;
    const arr = byKind.get(b.kind) ?? [];
    arr.push(b);
    byKind.set(b.kind, arr);
  }
  for (const [kind, blocks] of byKind) {
    const small = blocks.filter((b) => b.content.length < mergeSmall);
    if (small.length < 2) continue;
    const [target, ...rest] = small;
    const combined = [target.content, ...rest.map((b) => b.content)].join('\n');
    if (combined.length > M16_MAX_BLOCK_CHARS) {
      skipped += rest.length;
      continue;
    }
    store.replace(
      target.label,
      combined,
      actor,
      `sleep-time merge v16: gop ${rest.map((b) => b.label).join(', ')} vao ${target.label}`,
    );
    for (const b of rest) {
      store.delete(b.label);
      merged += 1;
      actions.push({
        at,
        action: 'merge',
        label: b.label,
        detail: `Gop block nho (${b.content.length} ky tu, kind ${kind}) vao "${target.label}".`,
      });
    }
  }

  // (2) + (3) Truncate / summarize cac block con lai (bo qua pinned).
  for (const b of store.list()) {
    if (b.pinned) continue;
    const current = store.get(b.label);
    if (!current) continue;
    if (current.content.length > M16_MAX_BLOCK_CHARS) {
      const next = truncateBlockM16(current.content, M16_MAX_BLOCK_CHARS);
      store.replace(current.label, next, actor, 'sleep-time truncate v16: block vuot gioi han');
      truncated += 1;
      actions.push({
        at,
        action: 'truncate',
        label: current.label,
        detail: `Rut tu ${current.content.length} xuong ${next.length} ky tu (giu dau + duoi).`,
      });
    } else if (current.content.length > summarizeAt) {
      const next = summarizeBlockExtractiveM16(current.content, summarizeAt);
      if (next !== current.content) {
        store.replace(current.label, next, actor, 'sleep-time summarize v16: rut gon extractive');
        summarized += 1;
        actions.push({
          at,
          action: 'summarize',
          label: current.label,
          detail: `Rut gon tu ${current.content.length} xuong ${next.length} ky tu (giu cau dau + cuoi).`,
        });
      }
    }
  }

  return {
    ran: true,
    reason: `Sleep-time reorganize v16 chay luc idle (${Math.round(idleMs / 1000)}s): gop ${merged}, truncate ${truncated}, summarize ${summarized}, bao ve ${protectedPinned} block pinned.`,
    at,
    merged,
    truncated,
    summarized,
    protectedPinned,
    skipped,
    actions,
  };
}

// ---------------------------------------------------------------------------
// Audit export — xuat audit trail thanh text doc duoc
// ---------------------------------------------------------------------------

/**
 * Xuat audit trail cua store (hoac cua 1 block) thanh text: moi dong
 * 1 hanh dong (thoi gian, action, label, actor, version sau, ly do).
 * Dung cho UI audit + tool tra ve.
 */
export function exportAuditM16(store: M16BlockStore, label?: string): string {
  const entries = store.auditTrail(label);
  const scope = label ? `block "${label}"` : 'toan bo store';
  const lines = [`Audit trail v16 — ${scope}: ${entries.length} muc.`];
  for (const e of entries) {
    lines.push(
      `  [${e.at}] ${e.action} "${e.label}" boi ${e.actor} -> v${e.versionAfter}` +
        (e.reason ? ` (${e.reason})` : '') +
        (e.detail ? ` — ${e.detail}` : ''),
    );
  }
  const summary = store.auditSummary();
  lines.push(
    `Tom tat: ${summary.total} muc; theo action: ${Object.entries(summary.byAction)
      .map(([a, n]) => `${a} ${n}`)
      .join(', ') || '—'}; theo actor: ${Object.entries(summary.byActor)
      .map(([a, n]) => `${a} ${n}`)
      .join(', ') || '—'}.`,
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Block search — tim block theo tu khoa (label + content)
// ---------------------------------------------------------------------------

export interface M16BlockSearchHit {
  block: M16MemoryBlock;
  score: number;
  /** Ly do khop: 'label' (khop label) hay 'content' (khop noi dung). */
  matchedIn: 'label' | 'content' | 'both';
}

/**
 * Tim block theo tu khoa: khop label nang hon khop content (label
 * match = 2 diem, moi token khop trong content = 1 diem). Tra ve xep
 * theo diem giam dan. Query rong -> tra tat ca (diem 0).
 */
export function searchBlocksM16(store: M16BlockStore, query: string, limit = 10): M16BlockSearchHit[] {
  const tokens = normalizeGraphText(query ?? '')
    .split(/\s+/)
    .filter((t) => t.length > 1);
  const blocks = store.list();
  if (tokens.length === 0) {
    return blocks.slice(0, Math.max(0, limit)).map((block) => ({ block, score: 0, matchedIn: 'content' as const }));
  }
  const hits: M16BlockSearchHit[] = [];
  for (const block of blocks) {
    // Khop theo TU NGUYEN (word-boundary), khong phai substring:
    // token 'no' khong duoc khop 'notes' trong label.
    const labelWords = new Set(
      normalizeGraphText(block.label).split(/\s+/).filter((t) => t.length > 0),
    );
    const contentWords = new Set(
      normalizeGraphText(block.content).split(/\s+/).filter((t) => t.length > 0),
    );
    let score = 0;
    let inLabel = false;
    let inContent = false;
    for (const token of tokens) {
      if (labelWords.has(token)) {
        score += 2;
        inLabel = true;
      }
      if (contentWords.has(token)) {
        score += 1;
        inContent = true;
      }
    }
    if (score === 0) continue;
    hits.push({
      block,
      score,
      matchedIn: inLabel && inContent ? 'both' : inLabel ? 'label' : 'content',
    });
  }
  hits.sort((a, b) => b.score - a.score || a.block.label.localeCompare(b.block.label));
  return hits.slice(0, Math.max(0, limit));
}
