/**
 * Memory v26 — archival memory + recall memory (v1.41, Doi T1).
 *
 * Y tuong hoc tu Letta (survey v141 muc 2, chi y tuong):
 *  - Archival memory: kho luu tru tim duoc — version cu cua
 *    block, fact het hieu luc, turn hoi thoai cu, phan bi curate
 *    loai ra — khong xoa, chi chuyen khoi core memory.
 *  - Recall memory: log hoi thoai day du, query theo ngay ("hom
 *    nay / ngay X da noi gi") va theo noi dung.
 *
 * Cai dat chay 100% local, khong goi model/mang:
 *  - Moi muc co dayKey YYYY-MM-DD (UTC) lam khoa partition theo
 *    ngay + content/tags/label de search keyword.
 *  - Search: khop tu khoa (khop 1 phan, khong phan biet hoa) +
 *    loc ngay/kind/tag/bot; diem = ti le tu khoa khop + thuong
 *    neu khop tag/label; sap theo diem roi moi nhat.
 *  - Recall theo ngay: tra cac muc trong ngay + ngay ke truoc/
 *    sau co muc (de bot lan theo thoi gian).
 *  - Retention: prune muc cu hon N ngay (chi khi user goi ro
 *    rang — mac dinh khong tu xoa).
 */
import {
  dayInRangeV26,
  dayKeyV26,
  isValidDayKeyV26,
  makeV26Id,
  normalizeTextV26,
  shiftDayKeyV26,
  tokenizeV26,
  type V26ArchiveEntry,
  type V26ArchiveHit,
  type V26ArchiveInput,
  type V26ArchiveKind,
  type V26ArchiveSearchFilter,
  type V26RecallDay,
  type V26Result,
} from './types';
import { errV26, isoAtV26, okV26 } from './types';

/** So muc toi da giu trong kho neu khong cau hinh (0 = khong gioi han). */
export const V26_ARCHIVE_DEFAULT_LIMIT = 100;

/** Kho luu tru (archival + recall) trong bo nho. */
export class V26ArchiveStore {
  private readonly entries = new Map<string, V26ArchiveEntry>();

  get size(): number {
    return this.entries.size;
  }

  /** Them 1 muc luu tru. */
  add(input: V26ArchiveInput, opts: { nowMs?: number } = {}): V26Result<V26ArchiveEntry> {
    const content = input.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      return errV26('content luu tru khong duoc rong.');
    }
    const at = input.at ?? isoAtV26(opts.nowMs ?? Date.now());
    const dayKey = dayKeyV26(at);
    if (!dayKey) return errV26(`Thoi diem luu tru "${at}" khong hop le (can ISO date).`);
    const entry: V26ArchiveEntry = {
      id: makeV26Id('arc'),
      kind: input.kind,
      sourceBlockId: (input.sourceBlockId ?? '').trim(),
      sourceLabel: (input.sourceLabel ?? '').trim(),
      content,
      at,
      dayKey,
      version: input.version ?? 0,
      tags: [...(input.tags ?? [])].map((t) => t.trim()).filter((t) => t.length > 0),
      by: (input.by ?? '').trim(),
      note: (input.note ?? '').trim(),
    };
    this.entries.set(entry.id, entry);
    return okV26(entry);
  }

  get(id: string): V26ArchiveEntry | undefined {
    return this.entries.get(id);
  }

  /**
   * Luu tru 1 version cu cua block (goi truoc khi ghi/curate de
   * phan cu khong mat). Tra null-result neu version da luu roi
   * (tranh trung lap khi curate goi 2 lan).
   */
  archiveBlockVersion(
    sourceBlockId: string,
    sourceLabel: string,
    version: number,
    value: string,
    by: string,
    opts: { nowMs?: number; note?: string } = {},
  ): V26Result<V26ArchiveEntry> {
    for (const e of this.entries.values()) {
      if (e.kind === 'block-version' && e.sourceBlockId === sourceBlockId && e.version === version) {
        return okV26(e);
      }
    }
    return this.add(
      {
        kind: 'block-version',
        sourceBlockId,
        sourceLabel,
        content: value,
        at: isoAtV26(opts.nowMs ?? Date.now()),
        by,
        note: opts.note ?? `version ${version} cua block "${sourceLabel}" truoc khi doi`,
        version,
      },
      opts,
    );
  }

  /**
   * Luu tru nhieu turn hoi thoai (recall memory): moi turn la 1
   * muc kind='turn', content = "role: text".
   */
  archiveTurns(
    turns: Array<{ role: string; text: string; at: string }>,
    opts: { by?: string; sourceLabel?: string } = {},
  ): V26Result<{ added: number; skipped: number; ids: string[] }> {
    let added = 0;
    let skipped = 0;
    const ids: string[] = [];
    for (const turn of turns) {
      if (!turn.text || !turn.text.trim()) {
        skipped++;
        continue;
      }
      const res = this.add({
        kind: 'turn',
        content: `${turn.role}: ${turn.text}`,
        at: turn.at,
        by: opts.by ?? '',
        sourceLabel: opts.sourceLabel ?? '',
        note: 'recall memory: turn hoi thoai',
      });
      if (res.ok) {
        added++;
        ids.push(res.value.id);
      } else {
        skipped++;
      }
    }
    return okV26({ added, skipped, ids });
  }

  /** Liet ke muc (moi nhat truoc). */
  list(filter: { kind?: V26ArchiveKind; sourceBlockId?: string; sourceLabel?: string; limit?: number } = {}): V26ArchiveEntry[] {
    const out: V26ArchiveEntry[] = [];
    for (const e of this.entries.values()) {
      if (filter.kind !== undefined && e.kind !== filter.kind) continue;
      if (filter.sourceBlockId !== undefined && e.sourceBlockId !== filter.sourceBlockId) continue;
      if (filter.sourceLabel !== undefined && e.sourceLabel !== filter.sourceLabel) continue;
      out.push(e);
    }
    out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    if (filter.limit !== undefined) return out.slice(0, Math.max(0, filter.limit));
    return out;
  }

  /**
   * Search archival theo ngay + noi dung.
   *
   * Diem (0..1):
   *  - Khop toan bo query (cum tu) trong content: +0.5.
   *  - Moi tu khoa khop trong content: +0.3 / so tu (toi da 0.3).
   *  - Khop tag: +0.1. Khop sourceLabel: +0.1.
   *  - Khong co query: diem 1.0 (chi loc theo ngay/kind/tag).
   * Sap theo diem giam dan, dong diem thi moi nhat truoc.
   */
  search(filter: V26ArchiveSearchFilter = {}): V26ArchiveHit[] {
    if (filter.fromDay !== undefined && !isValidDayKeyV26(filter.fromDay)) {
      return [];
    }
    if (filter.toDay !== undefined && !isValidDayKeyV26(filter.toDay)) {
      return [];
    }
    const query = (filter.query ?? '').trim();
    const queryNorm = normalizeTextV26(query);
    const queryTokens = query ? tokenizeV26(query) : [];
    const hits: V26ArchiveHit[] = [];
    for (const entry of this.entries.values()) {
      if (!dayInRangeV26(entry.dayKey, filter.fromDay, filter.toDay)) continue;
      if (filter.kind !== undefined && entry.kind !== filter.kind) continue;
      if (filter.sourceBlockId !== undefined && entry.sourceBlockId !== filter.sourceBlockId) continue;
      if (filter.sourceLabel !== undefined && entry.sourceLabel !== filter.sourceLabel) continue;
      if (filter.tag !== undefined && !entry.tags.some((t) => normalizeTextV26(t) === normalizeTextV26(filter.tag as string))) continue;
      if (filter.by !== undefined && entry.by !== filter.by) continue;
      let score = 0;
      let explanation = '';
      if (!query) {
        score = 1;
        explanation = 'khop bo loc (khong co tu khoa)';
      } else {
        const contentNorm = normalizeTextV26(entry.content);
        const labelNorm = normalizeTextV26(entry.sourceLabel);
        let matchedTokens = 0;
        for (const token of queryTokens) {
          if (contentNorm.includes(token)) matchedTokens++;
        }
        if (contentNorm.includes(queryNorm)) {
          score += 0.5;
          explanation = 'khop cum tu trong noi dung';
        }
        if (queryTokens.length > 0) {
          score += (matchedTokens / queryTokens.length) * 0.3;
          if (matchedTokens > 0) explanation += `${explanation ? '; ' : ''}${matchedTokens}/${queryTokens.length} tu khoa khop`;
        }
        if (entry.tags.some((t) => normalizeTextV26(t).includes(queryNorm))) {
          score += 0.1;
          explanation += `${explanation ? '; ' : ''}khop tag`;
        }
        if (labelNorm && labelNorm.includes(queryNorm)) {
          score += 0.1;
          explanation += `${explanation ? '; ' : ''}khop ten block`;
        }
        if (score <= 0) continue;
      }
      hits.push({ entry, score: Math.round(score * 1000) / 1000, explanation: explanation || 'khop' });
    }
    hits.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.entry.at < b.entry.at ? 1 : a.entry.at > b.entry.at ? -1 : 0;
    });
    if (filter.limit !== undefined) return hits.slice(0, Math.max(0, filter.limit));
    return hits;
  }

  /**
   * Recall theo ngay: cac muc trong 1 ngay cu the.
   *
   * Tra ve ca ngay ke truoc / ke sau co muc de bot lan theo
   * thoi gian ("hom qua co gi? hom kia thi sao?").
   */
  recallDay(dayKey: string, opts: { limit?: number } = {}): V26Result<V26RecallDay> {
    if (!isValidDayKeyV26(dayKey)) {
      return errV26(`Ngay "${dayKey}" khong hop le (can YYYY-MM-DD, vd 2026-11-18).`);
    }
    const days = new Set<string>();
    for (const e of this.entries.values()) days.add(e.dayKey);
    const entries = this.list({ limit: undefined }).filter((e) => e.dayKey === dayKey);
    const limited = opts.limit !== undefined ? entries.slice(0, Math.max(0, opts.limit)) : entries;
    let prevDayWithEntries = '';
    for (let d = 1; d <= 3660; d++) {
      const cand = shiftDayKeyV26(dayKey, -d);
      if (!cand) break;
      if (days.has(cand)) {
        prevDayWithEntries = cand;
        break;
      }
    }
    let nextDayWithEntries = '';
    for (let d = 1; d <= 3660; d++) {
      const cand = shiftDayKeyV26(dayKey, d);
      if (!cand) break;
      if (days.has(cand)) {
        nextDayWithEntries = cand;
        break;
      }
    }
    const kinds = new Map<string, number>();
    for (const e of entries) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
    const kindPart = [...kinds.entries()].map(([k, n]) => `${n} ${k}`).join(', ') || 'khong co muc';
    return okV26({
      dayKey,
      total: entries.length,
      entries: limited,
      prevDayWithEntries,
      nextDayWithEntries,
      summary: `Ngay ${dayKey}: ${entries.length} muc (${kindPart})` +
        (prevDayWithEntries ? `; ngay gan nhat truoc co muc: ${prevDayWithEntries}` : '; khong co ngay truoc co muc') +
        (nextDayWithEntries ? `; ngay gan nhat sau co muc: ${nextDayWithEntries}` : '; khong co ngay sau co muc'),
    });
  }

  /** Cac ngay co muc luu tru (sap xep tang dan). */
  daysWithEntries(): string[] {
    const days = new Set<string>();
    for (const e of this.entries.values()) days.add(e.dayKey);
    return [...days].sort();
  }

  /** Dem muc theo kind. */
  countByKind(): Record<V26ArchiveKind, number> {
    const out: Record<V26ArchiveKind, number> = {
      'block-version': 0, fact: 0, turn: 0, note: 0, 'curated-out': 0,
    };
    for (const e of this.entries.values()) out[e.kind]++;
    return out;
  }

  /**
   * Xoa muc cu hon N ngay (retention, chi goi ro rang).
   * Tra so muc da xoa. Muc khong co ngay hop le thi giu lai.
   */
  pruneOlderThan(days: number, nowMs: number = Date.now()): V26Result<{ pruned: number; kept: number }> {
    if (!Number.isInteger(days) || days < 1 || days > 36500) {
      return errV26('days phai la so nguyen 1..36500.');
    }
    const cutoffMs = nowMs - days * 24 * 60 * 60 * 1000;
    let pruned = 0;
    for (const [id, e] of [...this.entries.entries()]) {
      const atMs = Date.parse(e.at);
      if (Number.isNaN(atMs)) continue;
      if (atMs < cutoffMs) {
        this.entries.delete(id);
        pruned++;
      }
    }
    return okV26({ pruned, kept: this.entries.size });
  }

  toJSON(): V26ArchiveEntry[] {
    return [...this.entries.values()];
  }

  static fromJSON(data: unknown): V26ArchiveStore {
    const store = new V26ArchiveStore();
    if (!Array.isArray(data)) return store;
    for (const raw of data as V26ArchiveEntry[]) {
      if (!raw || typeof raw.id !== 'string') continue;
      store.entries.set(raw.id, {
        ...raw,
        tags: Array.isArray(raw.tags) ? raw.tags : [],
      });
    }
    return store;
  }
}
