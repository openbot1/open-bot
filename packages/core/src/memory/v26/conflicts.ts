/**
 * Memory v26 — conflict detection & resolution (v1.41, Doi T1).
 *
 * Bai toan: 2 agent doc cung 1 shared block o version N, ca 2
 * sua, agent thu 2 ghi sau se ghi de lang le cong viec cua agent
 * thu 1 neu khong co co che bao ve. Giai phap (optimistic
 * concurrency, hoc y tuong tu Letta shared blocks + Git-style
 * merge, tu thiet ke lai):
 *  - Moi lan ghi kem `expectedVersion`. Version lech => ghi bi
 *    tu choi + tao V26Conflict ghi du 3 phia: base (luc agent
 *    doc), current (tren store), incoming (agent dinh ghi).
 *  - Giai quyet bang 1 trong 4 cach:
 *      keep-current  — bo ban incoming, giu ban hien tai.
 *      keep-incoming — ghi de bang ban incoming (tao version moi).
 *      merge-lines   — hop nhat theo dong: dong chi co o 1 ben
 *                      thi giu, dong xung dot (cung vi tri, khac
 *                      noi dung) thi giu ca 2 co danh dau.
 *      manual        — user/agent tu dua ra gia tri cuoi.
 *  - Conflict da resolve van luu lai (status resolved) de audit
 *    — khong xoa lich su xung dot.
 *
 * Chay 100% local, khong goi model/mang.
 */
import {
  errV26,
  isoAtV26,
  makeV26Id,
  okV26,
  type V26Conflict,
  type V26ConflictResolution,
  type V26Result,
} from './types';

/** Input tao conflict (goi tu registry khi ghi lech version). */
export interface V26ConflictInput {
  blockId: string;
  label: string;
  baseVersion: number;
  currentVersion: number;
  baseValue: string;
  currentValue: string;
  incomingValue: string;
  by: string;
  currentBy: string;
  nowMs?: number;
}

/** Ket qua merge theo dong. */
export interface V26LineMergeResult {
  merged: string;
  /** So dong chi co o current. */
  onlyCurrent: number;
  /** So dong chi co o incoming. */
  onlyIncoming: number;
  /** So dong giong nhau ca 2 ben. */
  common: number;
  /** So cap dong xung dot (da giu ca 2, co danh dau). */
  conflicts: number;
  /** Cac dong xung dot (de hien thi). */
  conflictLines: string[];
}

/**
 * 2 dong co phai "cung 1 dong bi sua doi" khong (de danh dau
 * xung dot that su khi merge)?
 *  - 1 dong chua dong kia (vd "dong hai" trong "dong hai sua").
 *  - Hoac do tuong dong Jaccard giua cac token >= 0.34.
 * Dong them moi doc lap (vd "Dong bon moi" vs "dong hai sua")
 * tra false — merge them thang, khong danh dau xung dot gia.
 */
export function linesSimilarV26(a: string, b: string): boolean {
  const normA = a.trim().toLowerCase();
  const normB = b.trim().toLowerCase();
  if (!normA || !normB) return false;
  if (normA === normB) return true;
  if (normA.includes(normB) || normB.includes(normA)) return true;
  const tokensA = new Set(normA.split(/[^a-z0-9àáâãèéêìíòóôõùúýăâđêôơưàảãạảấầẩẫậắằẳẵặẹẻẽềềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]+/u).filter((t) => t.length > 0));
  const tokensB = new Set(normB.split(/[^a-z0-9àáâãèéêìíòóôõùúýăâđêôơưàảãạảấầẩẫậắằẳẵặẹẻẽềềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]+/u).filter((t) => t.length > 0));
  if (tokensA.size === 0 || tokensB.size === 0) return false;
  let inter = 0;
  for (const t of tokensA) if (tokensB.has(t)) inter++;
  return inter / (tokensA.size + tokensB.size - inter) >= 0.34;
}

/**
 * Hop nhat 2 ban text theo dong (line-based union merge).
 *
 * Quy tac (xac dinh, khong goi model):
 *  - Dong giong nhau o ca 2 ben: giu 1 lan, giu nguyen thu tu
 *    xuat hien dau tien.
 *  - Dong chi co o 1 ben: giu het (khong mat thong tin ben nao).
 *  - Dong "xung dot that su" (2 dong khac nhau nhung cung vi tri
 *    tuong doi — heuristic: cung so thu tu trong phan khac nhau)
 *    thi giu ca 2, dong incoming co tien to `<< incoming:` de
 *    nguoi doc biet can xem lai.
 *  - Dong trong thi bo qua (khong tao dong trang thua).
 *  - Thu tu: duyet current truoc, roi them dong chi co o
 *    incoming theo thu tu cua incoming.
 */
export function mergeLinesV26(base: string, current: string, incoming: string): V26LineMergeResult {
  const splitLines = (text: string): string[] =>
    text
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0);
  const currentLines = splitLines(current);
  const incomingLines = splitLines(incoming);
  const baseLines = splitLines(base);
  const baseSet = new Set(baseLines);
  const currentSet = new Set(currentLines);
  const incomingSet = new Set(incomingLines);

  const merged: string[] = [];
  const seen = new Set<string>();
  let onlyCurrent = 0;
  let onlyIncoming = 0;
  let common = 0;
  let conflicts = 0;
  const conflictLines: string[] = [];

  // Dong o ca 2 ben hoac chi o current: duyet theo thu tu current.
  for (const line of currentLines) {
    if (seen.has(line)) continue;
    seen.add(line);
    if (incomingSet.has(line)) {
      common++;
      merged.push(line);
    } else {
      onlyCurrent++;
      merged.push(line);
    }
  }
  // Dong chi o incoming: them vao cuoi theo thu tu incoming.
  // Neu dong incoming "doi dau" voi 1 dong current o cung vi tri
  // tuong doi (cung index trong phan khac base) VA 2 dong tuong
  // tu nhau (1 dong la sua doi cua dong kia — chung tu khoa
  // hoac 1 dong chua dong kia) thi danh dau xung dot that su.
  // Dong chi them moi (khong tuong tu dong doi ung) thi them
  // thang, khong danh dau — tranh bao xung dot gia cho 2 dong
  // them moi doc lap o 2 ben.
  const baseOnlyCurrent = currentLines.filter((l) => !baseSet.has(l));
  const baseOnlyIncoming = incomingLines.filter((l) => !baseSet.has(l));
  for (const line of incomingLines) {
    if (seen.has(line)) continue;
    seen.add(line);
    onlyIncoming++;
    const idx = baseOnlyIncoming.indexOf(line);
    const counterpart = idx >= 0 && idx < baseOnlyCurrent.length ? baseOnlyCurrent[idx] : null;
    if (counterpart !== null && counterpart !== line && linesSimilarV26(counterpart, line)) {
      // Cap dong xung dot: dong current da co trong merged, them
      // dong incoming co danh dau ngay sau dong doi ung do.
      conflicts++;
      const marked = `<< incoming (xung dot voi "${counterpart}"): ${line}`;
      conflictLines.push(marked);
      const pos = merged.indexOf(counterpart);
      if (pos >= 0) merged.splice(pos + 1, 0, marked);
      else merged.push(marked);
    } else {
      merged.push(line);
    }
  }
  return {
    merged: merged.join('\n'),
    onlyCurrent,
    onlyIncoming,
    common,
    conflicts,
    conflictLines,
  };
}

/** Store xung dot (bo nho). */
export class V26ConflictStore {
  private readonly conflicts = new Map<string, V26Conflict>();

  get size(): number {
    return this.conflicts.size;
  }

  /** Ghi nhan 1 xung dot moi (goi khi ghi lech version). */
  record(input: V26ConflictInput): V26Conflict {
    const nowMs = input.nowMs ?? Date.now();
    const conflict: V26Conflict = {
      id: makeV26Id('cf'),
      blockId: input.blockId,
      label: input.label,
      baseVersion: input.baseVersion,
      currentVersion: input.currentVersion,
      incomingVersion: input.currentVersion + 1,
      baseValue: input.baseValue,
      currentValue: input.currentValue,
      incomingValue: input.incomingValue,
      by: input.by,
      currentBy: input.currentBy,
      detectedAt: isoAtV26(nowMs),
      status: 'open',
      resolution: '',
      resolvedBy: '',
      resolvedAt: '',
      resolutionNote: '',
      resolvedVersion: 0,
    };
    this.conflicts.set(conflict.id, conflict);
    return conflict;
  }

  get(id: string): V26Conflict | undefined {
    return this.conflicts.get(id);
  }

  /** Liet ke xung dot (mo truoc). */
  list(filter: { blockId?: string; status?: 'open' | 'resolved'; by?: string; limit?: number } = {}): V26Conflict[] {
    const out: V26Conflict[] = [];
    for (const c of this.conflicts.values()) {
      if (filter.blockId !== undefined && c.blockId !== filter.blockId) continue;
      if (filter.status !== undefined && c.status !== filter.status) continue;
      if (filter.by !== undefined && c.by !== filter.by) continue;
      out.push(c);
    }
    out.sort((a, b) => (a.detectedAt < b.detectedAt ? 1 : a.detectedAt > b.detectedAt ? -1 : 0));
    if (filter.limit !== undefined) return out.slice(0, Math.max(0, filter.limit));
    return out;
  }

  /** Chi xung dot dang mo. */
  listOpen(): V26Conflict[] {
    return this.list({ status: 'open' });
  }

  /** Xung dot dang mo cua 1 block (moi nhat truoc). */
  listOpenForBlock(blockId: string): V26Conflict[] {
    return this.list({ blockId, status: 'open' });
  }

  /**
   * Giai quyet xung dot — tra ve gia tri cuoi can ghi vao block
   * (de store/pipeline ghi tiep) + cap nhat trang thai conflict.
   *
   *  - keep-current: gia tri cuoi = currentValue (khong doi block).
   *  - keep-incoming: gia tri cuoi = incomingValue.
   *  - merge-lines: gia tri cuoi = hop nhat theo dong.
   *  - manual: gia tri cuoi = `manualValue` (bat buoc truyen).
   *
   * Ham nay KHONG tu ghi block (de pipeline/registry ghi + audit
   * 'resolved' 1 cach thong nhat); no chi tinh gia tri + danh
   * dau conflict la resolved. `resolvedVersion` do caller dien
   * sau khi ghi (goi `markResolvedVersion`).
   */
  resolve(
    id: string,
    resolution: V26ConflictResolution,
    resolvedBy: string,
    opts: { nowMs?: number; manualValue?: string; note?: string } = {},
  ): V26Result<{ conflict: V26Conflict; finalValue: string; merge: V26LineMergeResult | null }> {
    const conflict = this.conflicts.get(id);
    if (!conflict) return errV26(`Khong co conflict "${id}".`);
    if (conflict.status === 'resolved') {
      return errV26(`Conflict "${id}" da duoc giai quyet (${conflict.resolution} boi ${conflict.resolvedBy}).`);
    }
    let finalValue: string;
    let merge: V26LineMergeResult | null = null;
    if (resolution === 'keep-current') {
      finalValue = conflict.currentValue;
    } else if (resolution === 'keep-incoming') {
      finalValue = conflict.incomingValue;
    } else if (resolution === 'merge-lines') {
      merge = mergeLinesV26(conflict.baseValue, conflict.currentValue, conflict.incomingValue);
      finalValue = merge.merged;
    } else if (resolution === 'manual') {
      if (opts.manualValue === undefined || opts.manualValue.length === 0) {
        return errV26('Giai quyet manual can truyen manualValue (khong duoc rong).');
      }
      finalValue = opts.manualValue;
    } else {
      return errV26(`Cach giai quyet "${resolution}" khong hop le (keep-current/keep-incoming/merge-lines/manual).`);
    }
    conflict.status = 'resolved';
    conflict.resolution = resolution;
    conflict.resolvedBy = resolvedBy;
    conflict.resolvedAt = isoAtV26(opts.nowMs ?? Date.now());
    conflict.resolutionNote = opts.note ?? '';
    return okV26({ conflict, finalValue, merge });
  }

  /** Dien version block sau khi ghi gia tri giai quyet xong. */
  markResolvedVersion(id: string, resolvedVersion: number): V26Result<V26Conflict> {
    const conflict = this.conflicts.get(id);
    if (!conflict) return errV26(`Khong co conflict "${id}".`);
    conflict.resolvedVersion = resolvedVersion;
    return okV26(conflict);
  }

  /** Mo lai 1 conflict da resolve (vd giai quyet sai, can lam lai). */
  reopen(id: string, by: string, opts: { nowMs?: number; note?: string } = {}): V26Result<V26Conflict> {
    const conflict = this.conflicts.get(id);
    if (!conflict) return errV26(`Khong co conflict "${id}".`);
    if (conflict.status === 'open') return okV26(conflict);
    conflict.status = 'open';
    conflict.resolution = '';
    conflict.resolvedBy = by;
    conflict.resolvedAt = isoAtV26(opts.nowMs ?? Date.now());
    conflict.resolutionNote = opts.note ?? 'reopened';
    conflict.resolvedVersion = 0;
    return okV26(conflict);
  }

  /** Dem conflict theo trang thai. */
  countByStatus(): { open: number; resolved: number; total: number } {
    let open = 0;
    let resolved = 0;
    for (const c of this.conflicts.values()) {
      if (c.status === 'open') open++;
      else resolved++;
    }
    return { open, resolved, total: open + resolved };
  }

  toJSON(): V26Conflict[] {
    return [...this.conflicts.values()];
  }

  static fromJSON(data: unknown): V26ConflictStore {
    const store = new V26ConflictStore();
    if (!Array.isArray(data)) return store;
    for (const raw of data as V26Conflict[]) {
      if (!raw || typeof raw.id !== 'string') continue;
      store.conflicts.set(raw.id, { ...raw });
    }
    return store;
  }
}
