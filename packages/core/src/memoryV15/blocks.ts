/**
 * Memory v15 — Letta blocks v2 (v1.16, Doi T1).
 *
 * Y tuong hoc tu Letta (core memory blocks: persona/human agent tu
 * edit qua tool; sleep-time compute — background agent reorganize
 * blocks luc idle, khong ton turn cua user) — tu thiet ke lai hoan
 * toan cho open-bot, chay 100% local, KHONG copy code/text/tai san
 * cua bat ky repo nao.
 *
 * Moi so voi blocks v0.96 / v11 / v12 (ke thua y tuong, khong dung
 * lai code — day la lop block RIENG cua v15 de tranh xung dot merge
 * voi cac doi khac):
 *  1. Versioned blocks: moi lan edit tang version + luu snapshot
 *     cu vao history (rollback duoc ve bat ky version nao).
 *  2. Agent tu edit qua tool calls co validation chat: label hop
 *     le, gioi han kich thuoc (8000 ky tu/block, toi da 32 block),
 *     cam chen tag `<memory_blocks>` (chong prompt injection qua
 *     block), cam ky tu dieu khien.
 *  3. Sleep-time reorganizer: chi chay khi idle (hoac force) — gop
 *     block nho cung kind, truncate block qua lon (giu dau + duoi),
 *     summarize block dai bang trich rut cau (extractive, khong goi
 *     model), ghi log day du moi hanh dong.
 *  4. Compile ra `<memory_blocks>` de dua vao system prompt, sap
 *     theo do uu tien kind (persona > human > task > system > custom).
 */

import { normalizeGraphText } from '../memory/graph/types';

/** Loi blocks v15 — message tieng Viet. */
export class V15BlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V15BlockError';
  }
}

/** Kind cua block — quyet dinh thu tu compile vao prompt. */
export type V15BlockKind = 'persona' | 'human' | 'task' | 'system' | 'custom';

export const V15_BLOCK_KINDS: ReadonlySet<string> = new Set([
  'persona',
  'human',
  'task',
  'system',
  'custom',
]);

/** Gioi han kich thuoc block (ky tu). */
export const V15_MAX_BLOCK_CHARS = 8000;
/** Gioi han so block trong mot store. */
export const V15_MAX_BLOCKS = 32;
/** Gioi han do dai label. */
export const V15_MAX_LABEL_CHARS = 64;
/** Nguong gop: block nho hon muc nay (cung kind) co the gop. */
export const V15_MERGE_SMALL_CHARS = 200;
/** Nguong summarize: block dai hon muc nay duoc rut gon luc sleep. */
export const V15_SUMMARIZE_CHARS = 4000;
/** Nguong idle mac dinh de sleep-time chay (5 phut). */
export const V15_SLEEP_IDLE_THRESHOLD_MS = 5 * 60 * 1000;

/** Do uu tien compile: persona truoc, custom cuoi. */
export const V15_BLOCK_KIND_PRIORITY: Record<V15BlockKind, number> = {
  persona: 0,
  human: 1,
  task: 2,
  system: 3,
  custom: 4,
};

export function blockPromptPriorityV15(kind: V15BlockKind): number {
  return V15_BLOCK_KIND_PRIORITY[kind] ?? 99;
}

/** Mot snapshot version cua block (de rollback). */
export interface V15BlockVersion {
  version: number;
  content: string;
  editedBy: string;
  editedAt: string;
  reason: string;
}

/** Mot memory block co version. */
export interface V15MemoryBlock {
  id: string;
  label: string;
  kind: V15BlockKind;
  content: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Lich su version cu (moi nhat cuoi danh sach). */
  history: V15BlockVersion[];
}

/** Label hop le: chu cai/so/gach duoi/gach ngang, bat dau bang chu cai. */
export function isValidBlockLabelV15(label: string): boolean {
  const clean = (label ?? '').trim();
  if (clean.length === 0 || clean.length > V15_MAX_LABEL_CHARS) return false;
  return /^[A-Za-zÀ-ỹ_][A-Za-zÀ-ỹ0-9_\- ]*$/.test(clean);
}

export function normalizeBlockLabelV15(raw: string): string {
  return (raw ?? '').trim().replace(/\s+/g, ' ');
}

/**
 * Validate noi dung block: khong rong, khong qua lon, khong chua
 * tag `<memory_blocks>` (chong chen prompt qua block), khong chua
 * ky tu dieu khien (tru \n, \t).
 */
export function validateBlockContentV15(content: string): { ok: true } | { ok: false; reason: string } {
  const text = content ?? '';
  if (text.trim() === '') return { ok: false, reason: 'Noi dung block khong duoc rong.' };
  if (text.length > V15_MAX_BLOCK_CHARS) {
    return {
      ok: false,
      reason: `Block dai ${text.length} ky tu, vuot gioi han ${V15_MAX_BLOCK_CHARS} — dung sleep-time reorganizer hoac chia nho truoc.`,
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

function newBlockIdV15(): string {
  return `blk-v15-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`;
}

function nowIsoV15(): string {
  return new Date().toISOString();
}

/**
 * Store block v15 — in-memory, serialize duoc sang JSON (de host
 * luu file tuy y; store khong tu ghi dia de tranh phu thuoc IO).
 */
export class V15BlockStore {
  private readonly blocks = new Map<string, V15MemoryBlock>();
  /** Log cac lan sleep-time reorganizer chay (moi nhat cuoi). */
  readonly sleepLog: V15SleepLogEntry[] = [];

  /** So block hien co. */
  get size(): number {
    return this.blocks.size;
  }

  list(kind?: V15BlockKind): V15MemoryBlock[] {
    const all = [...this.blocks.values()];
    const filtered = kind ? all.filter((b) => b.kind === kind) : all;
    filtered.sort(
      (a, b) =>
        blockPromptPriorityV15(a.kind) - blockPromptPriorityV15(b.kind) ||
        a.label.localeCompare(b.label),
    );
    return filtered.map((b) => ({ ...b, history: [...b.history] }));
  }

  get(label: string): V15MemoryBlock | undefined {
    const key = normalizeGraphText(normalizeBlockLabelV15(label));
    for (const b of this.blocks.values()) {
      if (normalizeGraphText(b.label) === key) {
        return { ...b, history: [...b.history] };
      }
    }
    return undefined;
  }

  getById(id: string): V15MemoryBlock | undefined {
    const b = this.blocks.get(id);
    return b ? { ...b, history: [...b.history] } : undefined;
  }

  /** Tao block moi (label duy nhat, khong phan biet hoa/thuong). */
  create(
    label: string,
    kind: V15BlockKind,
    content: string,
    actor = 'user',
  ): V15MemoryBlock {
    const cleanLabel = normalizeBlockLabelV15(label);
    if (!isValidBlockLabelV15(cleanLabel)) {
      throw new V15BlockError(
        `Label block khong hop le: "${label}" (chu cai/so/gach duoi/gach ngang, toi da ${V15_MAX_LABEL_CHARS} ky tu).`,
      );
    }
    if (!V15_BLOCK_KINDS.has(kind)) {
      throw new V15BlockError(`Kind block khong hop le: "${kind}".`);
    }
    if (this.get(cleanLabel)) {
      throw new V15BlockError(`Block "${cleanLabel}" da ton tai — dung replace/append thay vi tao moi.`);
    }
    if (this.blocks.size >= V15_MAX_BLOCKS) {
      throw new V15BlockError(`Da dat gioi han ${V15_MAX_BLOCKS} block — xoa/gop block truoc.`);
    }
    const checked = validateBlockContentV15(content);
    if (!checked.ok) throw new V15BlockError(checked.reason);
    const now = nowIsoV15();
    const block: V15MemoryBlock = {
      id: newBlockIdV15(),
      label: cleanLabel,
      kind,
      content,
      version: 1,
      createdAt: now,
      updatedAt: now,
      history: [],
    };
    this.blocks.set(block.id, block);
    void actor;
    return { ...block, history: [] };
  }

  /** Ghi de toan bo noi dung block (tang version, luu snapshot cu). */
  replace(label: string, content: string, actor = 'user', reason = ''): V15MemoryBlock {
    const block = this.mustGet(label);
    const checked = validateBlockContentV15(content);
    if (!checked.ok) throw new V15BlockError(checked.reason);
    block.history.push(this.snapshot(block, actor, reason || 'replace'));
    block.content = content;
    block.version += 1;
    block.updatedAt = nowIsoV15();
    return { ...block, history: [...block.history] };
  }

  /** Noi them text vao cuoi block (tang version). */
  append(label: string, text: string, actor = 'user', reason = ''): V15MemoryBlock {
    const block = this.mustGet(label);
    const next = block.content.endsWith('\n') || block.content === '' ? `${block.content}${text}` : `${block.content}\n${text}`;
    const checked = validateBlockContentV15(next);
    if (!checked.ok) throw new V15BlockError(checked.reason);
    block.history.push(this.snapshot(block, actor, reason || 'append'));
    block.content = next;
    block.version += 1;
    block.updatedAt = nowIsoV15();
    return { ...block, history: [...block.history] };
  }

  /** Chen text vao vi tri ky tu `position` (tang version). */
  insert(
    label: string,
    position: number,
    text: string,
    actor = 'user',
    reason = '',
  ): V15MemoryBlock {
    const block = this.mustGet(label);
    const pos = Math.floor(position);
    if (!Number.isInteger(pos) || pos < 0 || pos > block.content.length) {
      throw new V15BlockError(`Vi tri chen khong hop le: ${position} (do dai block ${block.content.length}).`);
    }
    const next = block.content.slice(0, pos) + text + block.content.slice(pos);
    const checked = validateBlockContentV15(next);
    if (!checked.ok) throw new V15BlockError(checked.reason);
    block.history.push(this.snapshot(block, actor, reason || 'insert'));
    block.content = next;
    block.version += 1;
    block.updatedAt = nowIsoV15();
    return { ...block, history: [...block.history] };
  }

  /** Xoa doan [start, end) cua block (tang version). */
  deleteRange(
    label: string,
    start: number,
    end: number,
    actor = 'user',
    reason = '',
  ): V15MemoryBlock {
    const block = this.mustGet(label);
    const s = Math.floor(start);
    const e = Math.floor(end);
    if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e <= s || e > block.content.length) {
      throw new V15BlockError(
        `Khoang xoa khong hop le: [${start}, ${end}) (do dai block ${block.content.length}).`,
      );
    }
    const next = block.content.slice(0, s) + block.content.slice(e);
    if (next.trim() === '') {
      throw new V15BlockError('Khong the xoa het noi dung block — dung delete de xoa ca block.');
    }
    const checked = validateBlockContentV15(next);
    if (!checked.ok) throw new V15BlockError(checked.reason);
    block.history.push(this.snapshot(block, actor, reason || 'delete_range'));
    block.content = next;
    block.version += 1;
    block.updatedAt = nowIsoV15();
    return { ...block, history: [...block.history] };
  }

  /** Xoa ca block (khong khoi phuc duoc qua store — host giu JSON backup neu can). */
  delete(label: string): boolean {
    const block = this.get(label);
    if (!block) return false;
    return this.blocks.delete(block.id);
  }

  /** Rollback ve mot version cu (version hien tai cung vao history). */
  rollback(label: string, version: number, actor = 'user'): V15MemoryBlock {
    const block = this.mustGet(label);
    if (version === block.version) return { ...block, history: [...block.history] };
    const target = block.history.find((h) => h.version === version);
    if (!target) {
      throw new V15BlockError(`Block "${label}" khong co version ${version}.`);
    }
    block.history.push(this.snapshot(block, actor, `rollback to v${version}`));
    block.content = target.content;
    block.version += 1;
    block.updatedAt = nowIsoV15();
    return { ...block, history: [...block.history] };
  }

  /** Lich su version cua mot block (cu nhat dau danh sach). */
  history(label: string): V15BlockVersion[] {
    const block = this.mustGet(label);
    return [...block.history];
  }

  /** Tong so ky tu cua tat ca block (de UI canh bao context). */
  totalChars(): number {
    let total = 0;
    for (const b of this.blocks.values()) total += b.content.length;
    return total;
  }

  /** Serialize toan bo store (host tu luu file). */
  toJSON(): { version: 1; blocks: V15MemoryBlock[]; sleepLog: V15SleepLogEntry[] } {
    return {
      version: 1,
      blocks: [...this.blocks.values()],
      sleepLog: [...this.sleepLog],
    };
  }

  /** Khoi phuc store tu JSON (bo qua block loi, dem so bo qua). */
  static fromJSON(data: unknown): { store: V15BlockStore; skipped: number } {
    const store = new V15BlockStore();
    let skipped = 0;
    const raw = (data ?? {}) as { blocks?: unknown; sleepLog?: unknown };
    if (!Array.isArray(raw.blocks)) return { store, skipped: 0 };
    for (const item of raw.blocks) {
      const b = item as Partial<V15MemoryBlock>;
      if (
        typeof b?.id !== 'string' ||
        typeof b?.label !== 'string' ||
        typeof b?.content !== 'string' ||
        typeof b?.version !== 'number' ||
        !V15_BLOCK_KINDS.has(b.kind ?? '')
      ) {
        skipped += 1;
        continue;
      }
      // Tu choi block loi cau truc / label / kind / chen tag / ky tu
      // dieu khien — nhung CHAP NHAN block vuot gioi han do dai:
      // do la du lieu cu can sleep-time reorganizer sua (truncate),
      // khong phai du lieu rac.
      if (!isValidBlockLabelV15(b.label)) {
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
      store.blocks.set(b.id, {
        id: b.id,
        label: b.label,
        kind: b.kind as V15BlockKind,
        content: b.content,
        version: b.version,
        createdAt: typeof b.createdAt === 'string' ? b.createdAt : nowIsoV15(),
        updatedAt: typeof b.updatedAt === 'string' ? b.updatedAt : nowIsoV15(),
        history: Array.isArray(b.history) ? (b.history as V15BlockVersion[]) : [],
      });
    }
    if (Array.isArray(raw.sleepLog)) {
      for (const e of raw.sleepLog as V15SleepLogEntry[]) {
        if (typeof e?.at === 'string' && typeof e?.action === 'string') {
          store.sleepLog.push(e);
        }
      }
    }
    return { store, skipped };
  }

  private mustGet(label: string): V15MemoryBlock {
    const key = normalizeGraphText(normalizeBlockLabelV15(label));
    for (const b of this.blocks.values()) {
      if (normalizeGraphText(b.label) === key) return b;
    }
    throw new V15BlockError(`Khong tim thay block "${label}".`);
  }

  private snapshot(block: V15MemoryBlock, actor: string, reason: string): V15BlockVersion {
    return {
      version: block.version,
      content: block.content,
      editedBy: actor,
      editedAt: nowIsoV15(),
      reason: (reason ?? '').slice(0, 200),
    };
  }
}

// ---------------------------------------------------------------------------
// Agent edit qua tool-call-shaped op (validation tap trung)
// ---------------------------------------------------------------------------

export type V15BlockEditAction = 'create' | 'replace' | 'append' | 'insert' | 'delete_range' | 'delete';

export interface V15BlockEditOp {
  action: V15BlockEditAction;
  label: string;
  /** Kind — bat buoc khi action = 'create'. */
  kind?: V15BlockKind;
  /** Noi dung moi — bat buoc khi create/replace. */
  content?: string;
  /** Text them/chen — bat buoc khi append/insert. */
  text?: string;
  /** Vi tri chen — bat buoc khi insert. */
  position?: number;
  /** Khoang xoa [start, end) — bat buoc khi delete_range. */
  start?: number;
  end?: number;
  reason?: string;
}

export interface V15BlockEditResult {
  action: V15BlockEditAction;
  block: V15MemoryBlock | null;
  deleted: boolean;
}

/**
 * Ap dung mot op edit cua agent (dang tool call): validate day du
 * truoc khi doi gi — op loi thi store khong doi.
 */
export function applyBlockEditV15(
  store: V15BlockStore,
  op: V15BlockEditOp,
  actor = 'agent',
): V15BlockEditResult {
  const label = normalizeBlockLabelV15(op.label ?? '');
  if (!isValidBlockLabelV15(label)) {
    throw new V15BlockError(`Label block khong hop le: "${op.label ?? ''}".`);
  }
  switch (op.action) {
    case 'create': {
      if (!op.kind || !V15_BLOCK_KINDS.has(op.kind)) {
        throw new V15BlockError(`Tao block can kind hop le (persona/human/task/system/custom).`);
      }
      if (typeof op.content !== 'string') {
        throw new V15BlockError('Tao block can co content (string).');
      }
      const block = store.create(label, op.kind, op.content, actor);
      return { action: 'create', block, deleted: false };
    }
    case 'replace': {
      if (typeof op.content !== 'string') {
        throw new V15BlockError('Replace block can co content (string).');
      }
      const block = store.replace(label, op.content, actor, op.reason ?? '');
      return { action: 'replace', block, deleted: false };
    }
    case 'append': {
      if (typeof op.text !== 'string' || op.text === '') {
        throw new V15BlockError('Append block can co text (string, khong rong).');
      }
      const block = store.append(label, op.text, actor, op.reason ?? '');
      return { action: 'append', block, deleted: false };
    }
    case 'insert': {
      if (typeof op.text !== 'string' || op.text === '') {
        throw new V15BlockError('Insert block can co text (string, khong rong).');
      }
      if (typeof op.position !== 'number') {
        throw new V15BlockError('Insert block can co position (number).');
      }
      const block = store.insert(label, op.position, op.text, actor, op.reason ?? '');
      return { action: 'insert', block, deleted: false };
    }
    case 'delete_range': {
      if (typeof op.start !== 'number' || typeof op.end !== 'number') {
        throw new V15BlockError('Delete_range can co start va end (number).');
      }
      const block = store.deleteRange(label, op.start, op.end, actor, op.reason ?? '');
      return { action: 'delete_range', block, deleted: false };
    }
    case 'delete': {
      const deleted = store.delete(label);
      if (!deleted) throw new V15BlockError(`Khong tim thay block "${label}" de xoa.`);
      return { action: 'delete', block: null, deleted: true };
    }
    default:
      throw new V15BlockError(`Action block khong hop le: "${String(op.action)}".`);
  }
}

/** Compile cac block thanh `<memory_blocks>` de dua vao system prompt. */
export function compileBlocksV15(store: V15BlockStore, opts: { includeKinds?: V15BlockKind[] } = {}): string {
  const blocks = store.list().filter((b) => !opts.includeKinds || opts.includeKinds.includes(b.kind));
  if (blocks.length === 0) return '';
  const lines = ['<memory_blocks>'];
  for (const b of blocks) {
    lines.push(`[${b.kind}:${b.label}] (v${b.version})`);
    lines.push(b.content);
  }
  lines.push('</memory_blocks>');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Sleep-time reorganizer — chay nen luc idle
// ---------------------------------------------------------------------------

export type V15SleepAction = 'merge' | 'truncate' | 'summarize' | 'skip';

export interface V15SleepLogEntry {
  at: string;
  action: V15SleepAction;
  label: string;
  detail: string;
}

export interface V15SleepOptions {
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

export interface V15SleepReport {
  ran: boolean;
  reason: string;
  at: string;
  merged: number;
  truncated: number;
  summarized: number;
  skipped: number;
  actions: V15SleepLogEntry[];
}

/** Tach text thanh cau (don gian, xac dinh — khong goi model). */
export function splitSentencesV15(text: string): string[] {
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
export function summarizeBlockExtractiveV15(content: string, maxChars: number): string {
  const sentences = splitSentencesV15(content);
  if (sentences.length <= 4 || content.length <= maxChars) return content;
  const kept = [...sentences.slice(0, 3), sentences[sentences.length - 1]];
  const note = `\n[…sleep-time summary: giu ${kept.length}/${sentences.length} cau, rut gon tu ${content.length} ky tu.]`;
  let out = kept.join(' ') + note;
  if (out.length > maxChars) {
    out = kept.join(' ').slice(0, Math.max(0, maxChars - note.length - 3)) + '…' + note;
  }
  return out;
}

/** Truncate: giu 60% dau + chu thich + 20% cuoi. */
export function truncateBlockV15(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const headLen = Math.floor(maxChars * 0.6);
  const tailLen = Math.floor(maxChars * 0.2);
  const removed = content.length - headLen - tailLen;
  return (
    content.slice(0, headLen) +
    `\n[…sleep-time truncate: da cat ${removed} ky tu o giua.]` +
    '\n' +
    content.slice(content.length - tailLen)
  );
}

/**
 * Sleep-time reorganizer: chi chay khi idle du nguong (hoac force).
 * Thu tu: (1) gop block nho cung kind, (2) truncate block vuot gioi
 * han, (3) summarize block dai. Moi hanh dong deu tang version +
 * luu history (qua replace) va ghi log. Khong xoa block (tru block
 * da gop vao block khac).
 */
export function runSleepReorganizeV15(
  store: V15BlockStore,
  opts: V15SleepOptions = {},
): V15SleepReport {
  const now = opts.now ?? new Date();
  const at = now.toISOString();
  const threshold = opts.idleThresholdMs ?? V15_SLEEP_IDLE_THRESHOLD_MS;
  const idleMs = opts.idleMs ?? 0;
  const actor = opts.actor ?? 'sleep-agent';
  if (!opts.force && idleMs < threshold) {
    const report: V15SleepReport = {
      ran: false,
      reason: `Chua idle du ${Math.round(threshold / 1000)}s (idle ${Math.round(idleMs / 1000)}s) — bo qua luot sleep nay.`,
      at,
      merged: 0,
      truncated: 0,
      summarized: 0,
      skipped: 0,
      actions: [],
    };
    return report;
  }
  const mergeSmall = opts.mergeSmallChars ?? V15_MERGE_SMALL_CHARS;
  const summarizeAt = opts.summarizeChars ?? V15_SUMMARIZE_CHARS;
  const actions: V15SleepLogEntry[] = [];
  let merged = 0;
  let truncated = 0;
  let summarized = 0;
  let skipped = 0;

  // (1) Gop block nho cung kind: nhom theo kind, neu >= 2 block nho
  // thi gop tat ca vao block dau tien cua kind do.
  const byKind = new Map<V15BlockKind, V15MemoryBlock[]>();
  for (const b of store.list()) {
    const arr = byKind.get(b.kind) ?? [];
    arr.push(b);
    byKind.set(b.kind, arr);
  }
  for (const [kind, blocks] of byKind) {
    const small = blocks.filter((b) => b.content.length < mergeSmall);
    if (small.length < 2) continue;
    const [target, ...rest] = small;
    const combined = [target.content, ...rest.map((b) => b.content)].join('\n');
    if (combined.length > V15_MAX_BLOCK_CHARS) {
      skipped += rest.length;
      continue;
    }
    store.replace(
      target.label,
      combined,
      actor,
      `sleep-time merge: gop ${rest.map((b) => b.label).join(', ')} vao ${target.label}`,
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

  // (2) + (3) Truncate / summarize cac block con lai.
  for (const b of store.list()) {
    const current = store.get(b.label);
    if (!current) continue;
    if (current.content.length > V15_MAX_BLOCK_CHARS) {
      const next = truncateBlockV15(current.content, V15_MAX_BLOCK_CHARS);
      store.replace(current.label, next, actor, 'sleep-time truncate: block vuot gioi han');
      truncated += 1;
      actions.push({
        at,
        action: 'truncate',
        label: current.label,
        detail: `Rut tu ${current.content.length} xuong ${next.length} ky tu (giu dau + duoi).`,
      });
    } else if (current.content.length > summarizeAt) {
      const next = summarizeBlockExtractiveV15(current.content, summarizeAt);
      if (next !== current.content) {
        store.replace(current.label, next, actor, 'sleep-time summarize: rut gon extractive');
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

  const report: V15SleepReport = {
    ran: true,
    reason: `Sleep-time reorganize chay luc idle (${Math.round(idleMs / 1000)}s): gop ${merged}, truncate ${truncated}, summarize ${summarized}.`,
    at,
    merged,
    truncated,
    summarized,
    skipped,
    actions,
  };
  store.sleepLog.push(
    ...actions,
    { at, action: 'skip', label: '*', detail: report.reason },
  );
  return report;
}
