/**
 * Memory v18 — Letta blocks v3: agent tu sua block co guardrail (v1.19, Doi T1).
 *
 * Y tuong hoc tu Letta / MemGPT (agent tu sua memory blocks bang
 * tool; block la bo nho co the doc/ghi cua agent) — tu thiet ke lai
 * hoan toan cho open-bot, chay 100% local, KHONG copy code/text/tai
 * san cua bat ky repo nao.
 *
 * Ke thua, khong viet lai:
 *  - `V15BlockStore` / `applyBlockEditV15` cua memoryV15/blocks:
 *    kho block duy nhat (create/replace/append/insert/delete_range/
 *    delete, history version trong moi block); v18 KHONG tao kho
 *    block moi, chi la lop GUARDRAIL + SNAPSHOT ben tren.
 *  - `V17BlockLifecycleManager` (pin/read-only/quota): v18 ton
 *    trong — block read-only hoac pinned bi chan sua o day truoc
 *    khi goi xuong v15.
 *
 * Moi trong v18:
 *  1. Guardrail chong drift: moi lan agent sua chi duoc doi toi da
 *     `maxChangedChars` ky tu VA toi da `maxChangedFraction` phan
 *     noi dung cu (mac dinh 400 ky tu / 25%); vuot thi reject
 *     truoc khi ghi — tranh agent viet lai ca block trong mot tool
 *     call (drift am tham).
 *  2. Snapshot truoc khi sua: `V18BlockEditor` luu ban sao noi dung
 *     cu + version vao `V18BlockSnapshot` (trong bo nho, co the
 *     serialize ra JSON); `rollbackV18` khoi phuc dung ban snapshot
 *     (ghi lai history bang replace cua v15).
 *  3. Mau cam (forbidden patterns): sua chua chuoi cam (vd lenh
 *     "quen het", "bo qua huong dan", "ignore previous") thi
 *     reject + ghi audit — phong agent tu chen lenh doc hai vao
 *     chinh block cua minh (OWASP ASI06 o tang block).
 *  4. Audit log: moi edit (thanh cong / bi chan) ghi mot dong
 *     `V18BlockEditAudit` (label, actor, action, changedChars,
 *     changedFraction, decision, reason, at) — doc duoc bang
 *     `listAuditV18`, xuat JSON bang `exportAuditV18`.
 *  5. `driftReportV18` — bao cao do drift cua mot block so voi
 *     snapshot goc: so lan sua, tong ky tu doi, phan tram noi dung
 *     goc con lai (Jaccard dong) — de user thay block da troi bao
 *     xa khoi ban dau.
 */

import type { V15BlockKind, V15MemoryBlock } from '../../memoryV15/blocks';
import { V15BlockStore, applyBlockEditV15 } from '../../memoryV15/blocks';
import type { V15BlockEditOp } from '../../memoryV15/blocks';
import { normalizeGraphText } from '../graph/types';

/** Loi blocks v3 — message tieng Viet. */
export class V18BlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V18BlockError';
  }
}

/** So ky tu doi toi da trong mot lan sua (mac dinh). */
export const V18_DEFAULT_MAX_CHANGED_CHARS = 400;
/** Ty le noi dung duoc doi toi da trong mot lan sua (mac dinh 25%). */
export const V18_DEFAULT_MAX_CHANGED_FRACTION = 0.25;
/** So snapshot toi da giu cho mot block (mac dinh). */
export const V18_DEFAULT_MAX_SNAPSHOTS_PER_BLOCK = 20;

/** Cau hinh guardrail cua editor v18. */
export interface V18BlockGuardConfig {
  maxChangedChars: number;
  maxChangedFraction: number;
  maxSnapshotsPerBlock: number;
  /** Block read-only (label chuan hoa) — sua bi chan. */
  readOnlyLabels: string[];
  /** Block pinned (label chuan hoa) — sua bi chan. */
  pinnedLabels: string[];
  /** Mau cam them (regex dang chuoi, khong phan biet hoa/thuong). */
  extraForbiddenPatterns: string[];
}

/** Cau hinh mac dinh. */
export const V18_DEFAULT_BLOCK_GUARD_CONFIG: V18BlockGuardConfig = {
  maxChangedChars: V18_DEFAULT_MAX_CHANGED_CHARS,
  maxChangedFraction: V18_DEFAULT_MAX_CHANGED_FRACTION,
  maxSnapshotsPerBlock: V18_DEFAULT_MAX_SNAPSHOTS_PER_BLOCK,
  readOnlyLabels: [],
  pinnedLabels: [],
  extraForbiddenPatterns: [],
};

/** Mau cam mac dinh (lenh doc hai co the agent tu chen vao block). */
export const V18_DEFAULT_FORBIDDEN_PATTERNS: readonly string[] = [
  'quên hết',
  'quen het',
  'bỏ qua hướng dẫn',
  'bo qua huong dan',
  'ignore previous instructions',
  'ignore all previous',
  'disregard previous',
  'xóa hết memory',
  'xoa het memory',
];

/** Snapshot noi dung block truoc mot lan sua. */
export interface V18BlockSnapshot {
  id: string;
  label: string;
  content: string;
  version: number;
  editedBy: string;
  reason: string;
  at: string;
}

/** Ket qua kiem tra guardrail (truoc khi ghi). */
export interface V18GuardCheck {
  ok: boolean;
  reason: string;
  changedChars: number;
  changedFraction: number;
  forbiddenHit: string | null;
}

/** Mot dong audit edit block. */
export interface V18BlockEditAudit {
  id: string;
  label: string;
  actor: string;
  action: string;
  decision: 'allowed' | 'rejected';
  reason: string;
  changedChars: number;
  changedFraction: number;
  snapshotId: string | null;
  at: string;
}

/** Bao cao drift cua mot block so voi snapshot goc. */
export interface V18BlockDriftReport {
  label: string;
  edits: number;
  totalChangedChars: number;
  /** Ty le dong goc con lai (Jaccard dong, 0..1). */
  originalLinesKept: number;
  /** Snapshot goc con khong. */
  hasOriginalSnapshot: boolean;
  /** Danh gia: 'stable' | 'drifting' | 'drifted'. */
  verdict: string;
}

let v18BlockSeq = 0;
function nextV18BlockId(prefix: string): string {
  v18BlockSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${v18BlockSeq}`;
}

function nowIsoV18(): string {
  return new Date().toISOString();
}

/** Dem so ky tu khac nhau giua hai chuoi (Levenshtein rut gon: dem theo dong). */
export function changedCharsV18(before: string, after: string): number {
  if (before === after) return 0;
  const a = before.split('\n');
  const b = after.split('\n');
  const aSet = new Set(a);
  const bSet = new Set(b);
  let changed = 0;
  for (const line of a) if (!bSet.has(line)) changed += line.length + 1;
  for (const line of b) if (!aSet.has(line)) changed += line.length + 1;
  return changed;
}

/** Ty le thay doi = changedChars / max(len truoc, 1). */
export function changedFractionV18(before: string, after: string): number {
  const changed = changedCharsV18(before, after);
  const base = Math.max(before.length, 1);
  return Math.min(1, changed / base);
}

/** Jaccard dong giua hai ban noi dung (0..1). */
export function linesKeptV18(original: string, current: string): number {
  const a = new Set(original.split('\n').map((l) => l.trim()).filter((l) => l !== ''));
  const b = new Set(current.split('\n').map((l) => l.trim()).filter((l) => l !== ''));
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const line of a) if (b.has(line)) inter += 1;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 1 : inter / union;
}

/** Tim mau cam trong noi dung moi (tra ve mau khop, null neu sach). */
export function findForbiddenV18(content: string, extraPatterns: string[] = []): string | null {
  const hay = normalizeGraphText(content ?? '');
  const patterns = [...V18_DEFAULT_FORBIDDEN_PATTERNS, ...extraPatterns];
  for (const pattern of patterns) {
    const norm = normalizeGraphText(pattern);
    if (norm !== '' && hay.includes(norm)) return pattern;
  }
  return null;
}

/**
 * Tinh noi dung sau khi ap op (khong ghi): dung de kiem tra
 * guardrail truoc khi goi `applyBlockEditV15`.
 */
export function previewEditV18(
  store: V15BlockStore,
  op: V15BlockEditOp,
): { before: string; after: string; exists: boolean } {
  const label = (op.label ?? '').trim();
  const block = store.get(label);
  if (op.action === 'create') {
    return { before: '', after: op.content ?? '', exists: false };
  }
  if (!block) return { before: '', after: '', exists: false };
  const before = block.content;
  let after = before;
  switch (op.action) {
    case 'replace':
      after = op.content ?? '';
      break;
    case 'append':
      after = before === '' ? (op.text ?? '') : `${before}\n${op.text ?? ''}`;
      break;
    case 'insert': {
      const at = Math.max(0, Math.min(op.position ?? before.length, before.length));
      after = before.slice(0, at) + (op.text ?? '') + before.slice(at);
      break;
    }
    case 'delete_range': {
      const start = Math.max(0, op.start ?? 0);
      const end = Math.max(start, Math.min(op.end ?? before.length, before.length));
      after = before.slice(0, start) + before.slice(end);
      break;
    }
    case 'delete':
      after = '';
      break;
    default:
      after = before;
  }
  return { before, after, exists: true };
}

/** Editor block v3 co guardrail + snapshot + audit. */
export class V18BlockEditor {
  private readonly store: V15BlockStore;
  private readonly config: V18BlockGuardConfig;
  private readonly snapshots = new Map<string, V18BlockSnapshot[]>();
  private readonly audit: V18BlockEditAudit[] = [];

  constructor(store: V15BlockStore, config: Partial<V18BlockGuardConfig> = {}) {
    this.store = store;
    this.config = { ...V18_DEFAULT_BLOCK_GUARD_CONFIG, ...config };
  }

  /** Cau hinh hien tai (ban sao). */
  getConfig(): V18BlockGuardConfig {
    return { ...this.config, readOnlyLabels: [...this.config.readOnlyLabels], pinnedLabels: [...this.config.pinnedLabels], extraForbiddenPatterns: [...this.config.extraForbiddenPatterns] };
  }

  /** Kiem tra guardrail cho mot op (khong ghi). */
  check(op: V15BlockEditOp, actor = 'agent'): V18GuardCheck {
    const label = (op.label ?? '').trim();
    const normLabel = normalizeGraphText(label);
    if (this.config.readOnlyLabels.some((l) => normalizeGraphText(l) === normLabel)) {
      return { ok: false, reason: `Block "${label}" dang read-only — agent khong duoc sua.`, changedChars: 0, changedFraction: 0, forbiddenHit: null };
    }
    if (this.config.pinnedLabels.some((l) => normalizeGraphText(l) === normLabel)) {
      return { ok: false, reason: `Block "${label}" dang pinned — agent khong duoc sua.`, changedChars: 0, changedFraction: 0, forbiddenHit: null };
    }
    const preview = previewEditV18(this.store, op);
    if (op.action !== 'create' && !preview.exists) {
      return { ok: false, reason: `Khong tim thay block "${label}".`, changedChars: 0, changedFraction: 0, forbiddenHit: null };
    }
    const changedChars = changedCharsV18(preview.before, preview.after);
    const changedFraction = changedFractionV18(preview.before, preview.after);
    if (op.action === 'delete') {
      return { ok: false, reason: 'Agent khong duoc xoa ca block — chi user moi duoc xoa.', changedChars, changedFraction, forbiddenHit: null };
    }
    const forbidden = findForbiddenV18(preview.after, this.config.extraForbiddenPatterns);
    if (forbidden) {
      return { ok: false, reason: `Noi dung moi chua mau cam: "${forbidden}".`, changedChars, changedFraction, forbiddenHit: forbidden };
    }
    if (changedChars > this.config.maxChangedChars) {
      return { ok: false, reason: `Doi ${changedChars} ky tu, vuot gioi han ${this.config.maxChangedChars} ky tu/lan sua.`, changedChars, changedFraction, forbiddenHit: null };
    }
    if (preview.before.length > 0 && changedFraction > this.config.maxChangedFraction) {
      return { ok: false, reason: `Doi ${(changedFraction * 100).toFixed(0)}% noi dung, vuot gioi han ${(this.config.maxChangedFraction * 100).toFixed(0)}%/lan sua.`, changedChars, changedFraction, forbiddenHit: null };
    }
    return { ok: true, reason: 'Dat guardrail.', changedChars, changedFraction, forbiddenHit: null };
  }

  /**
   * Ap edit cua agent: check guardrail truoc; neu dat thi snapshot
   * noi dung cu, goi `applyBlockEditV15`, ghi audit. Neu bi chan
   * thi throw `V18BlockError` (store khong doi) va ghi audit reject.
   */
  edit(op: V15BlockEditOp, actor = 'agent', reason = ''): V15MemoryBlock {
    const label = (op.label ?? '').trim();
    const check = this.check(op, actor);
    const at = nowIsoV18();
    if (!check.ok) {
      this.audit.push({
        id: nextV18BlockId('audit'),
        label,
        actor,
        action: op.action,
        decision: 'rejected',
        reason: check.reason,
        changedChars: check.changedChars,
        changedFraction: check.changedFraction,
        snapshotId: null,
        at,
      });
      throw new V18BlockError(check.reason);
    }
    const before = this.store.get(label);
    let snapshotId: string | null = null;
    if (before) {
      const snapshot: V18BlockSnapshot = {
        id: nextV18BlockId('snap'),
        label: before.label,
        content: before.content,
        version: before.version,
        editedBy: actor,
        reason: reason || op.action,
        at,
      };
      const list = this.snapshots.get(normalizeGraphText(before.label)) ?? [];
      list.push(snapshot);
      while (list.length > this.config.maxSnapshotsPerBlock) list.shift();
      this.snapshots.set(normalizeGraphText(before.label), list);
      snapshotId = snapshot.id;
    }
    const result = applyBlockEditV15(this.store, op, actor);
    if (!result.block) throw new V18BlockError(`Edit block "${label}" khong tra ve block.`);
    this.audit.push({
      id: nextV18BlockId('audit'),
      label,
      actor,
      action: op.action,
      decision: 'allowed',
      reason: reason || 'Dat guardrail.',
      changedChars: check.changedChars,
      changedFraction: check.changedFraction,
      snapshotId,
      at,
    });
    return result.block;
  }

  /** Liệt kê snapshot cua mot block (moi nhat cuoi). */
  listSnapshots(label: string): V18BlockSnapshot[] {
    const list = this.snapshots.get(normalizeGraphText(label)) ?? [];
    return list.map((s) => ({ ...s }));
  }

  /**
   * Rollback block ve mot snapshot: khoi phuc noi dung cu bang
   * `replace` cua v15 (ghi lai history), ghi audit. Tra ve block
   * sau rollback.
   */
  rollback(label: string, snapshotId: string, actor = 'user'): V15MemoryBlock {
    const list = this.snapshots.get(normalizeGraphText(label)) ?? [];
    const snapshot = list.find((s) => s.id === snapshotId);
    if (!snapshot) throw new V18BlockError(`Khong tim thay snapshot "${snapshotId}" cua block "${label}".`);
    const block = this.store.get(label);
    if (!block) throw new V18BlockError(`Khong tim thay block "${label}" de rollback.`);
    const restored = this.store.replace(label, snapshot.content, actor, `rollback v18 ve snapshot ${snapshotId}`);
    this.audit.push({
      id: nextV18BlockId('audit'),
      label,
      actor,
      action: 'rollback',
      decision: 'allowed',
      reason: `Rollback ve snapshot ${snapshotId}.`,
      changedChars: changedCharsV18(block.content, snapshot.content),
      changedFraction: changedFractionV18(block.content, snapshot.content),
      snapshotId,
      at: nowIsoV18(),
    });
    return restored;
  }

  /** Liệt kê audit (moi nhat cuoi, loc theo label neu co). */
  listAudit(label?: string): V18BlockEditAudit[] {
    const all = this.audit.map((a) => ({ ...a }));
    if (!label) return all;
    const norm = normalizeGraphText(label);
    return all.filter((a) => normalizeGraphText(a.label) === norm);
  }

  /** Xuat audit ra JSON (de host luu file). */
  exportAudit(): { version: 1; exportedAt: string; entries: V18BlockEditAudit[] } {
    return { version: 1, exportedAt: nowIsoV18(), entries: this.listAudit() };
  }

  /** Bao cao drift cua mot block so voi snapshot dau tien con giu. */
  driftReport(label: string): V18BlockDriftReport | null {
    const block = this.store.get(label);
    if (!block) return null;
    const list = this.snapshots.get(normalizeGraphText(label)) ?? [];
    const edits = this.audit.filter(
      (a) => normalizeGraphText(a.label) === normalizeGraphText(label) && a.decision === 'allowed',
    ).length;
    const totalChangedChars = this.audit
      .filter((a) => normalizeGraphText(a.label) === normalizeGraphText(label) && a.decision === 'allowed')
      .reduce((sum, a) => sum + a.changedChars, 0);
    const original = list.length > 0 ? list[0] : null;
    const kept = original ? linesKeptV18(original.content, block.content) : 1;
    const verdict = kept >= 0.75 ? 'stable' : kept >= 0.4 ? 'drifting' : 'drifted';
    return {
      label: block.label,
      edits,
      totalChangedChars,
      originalLinesKept: kept,
      hasOriginalSnapshot: original !== null,
      verdict,
    };
  }
}

/** Tao block moi qua editor (check guardrail: khong co mau cam). */
export function createBlockV18(
  editor: V18BlockEditor,
  label: string,
  kind: V15BlockKind,
  content: string,
  actor = 'agent',
): V15MemoryBlock {
  return editor.edit({ action: 'create', label, kind, content }, actor, 'create v18');
}
