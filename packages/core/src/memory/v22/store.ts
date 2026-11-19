/**
 * Memory v22 — Dream fact store (v1.37, Doi T1).
 *
 * Store trong bo nho cho fact cua dreaming consolidation:
 * them / doc / loc / doi trang thai, xuat-nhap trang thai JSON
 * (de scheduler luu giua cac lan chay). Store KHONG tu quyet
 * dinh gop/supersede/het han — cac module dedupe.ts,
 * supersede.ts, expiry.ts, patterns.ts doc qua `list()` va ghi
 * qua cac method co kiem tra o day, de moi thay doi deu co
 * version tang + updatedAt moi + validation.
 *
 * An toan: text rong / confidence ngoai [0,1] / topic value
 * khong hop le bi tu choi co ly do (tra V22Result, khong
 * throw, tru truong hop lap trinh sai dau vao kieu). Store
 * khong bao gio xoa fact: fact chi doi status (superseded /
 * expired / merged / invalidated) de lich su con nguyen.
 */
import {
  V22_MAX_FACTS_PER_STORE,
  V22_MAX_FACT_TEXT_CHARS,
  V22_MAX_SESSIONS_PER_FACT,
  V22_MAX_SOURCES_PER_FACT,
  V22_MAX_TAGS_PER_FACT,
  V22_MIN_FACT_TEXT_CHARS,
  type V22DreamFact,
  type V22DreamFactInput,
  type V22FactStatus,
  type V22Result,
  V22DreamError,
} from './types';

/** Bo dau tieng Viet: NFD + bo dau ket hop + map rieng `đ`/`Đ` (NFD khong tach duoc `đ`). */
export function stripDiacriticsV22(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

/** Chuan hoa mot doan cua topic: ha chu, bo dau tieng Viet, khoang trang -> `_`. */
function normalizeTopicSegmentV22(segment: string): string {
  return stripDiacriticsV22(segment)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

/**
 * Chuan hoa topic: giu dau `|` phan cach cac cap (vd
 * `user|thich_uong`), chuan hoa tung cap rieng. `User |
 * Thích Uống` -> `user|thich_uong`.
 */
export function normalizeTopicV22(topic: string): string {
  return topic
    .split('|')
    .map((seg) => normalizeTopicSegmentV22(seg))
    .filter((seg) => seg.length > 0)
    .join('|');
}

/**
 * Chuan hoa value: ha chu, bo dau, khoang trang / dau gach ->
 * `-` (vd `Cà-Phê Đen` -> `ca-phe-den`).
 */
export function normalizeValueV22(value: string): string {
  return stripDiacriticsV22(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

/** Kiem tra topic hop le (khong rong sau chuan hoa, <= 200 ky tu). */
export function isValidTopicV22(topic: string | undefined): boolean {
  if (topic === undefined) return true;
  if (typeof topic !== 'string') return false;
  const norm = normalizeTopicV22(topic);
  return norm.length > 0 && norm.length <= 200;
}

/** Kiem tra value hop le. */
export function isValidValueV22(value: string | undefined): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'string') return false;
  const norm = normalizeValueV22(value);
  return norm.length > 0 && norm.length <= 500;
}

/** Bo loc khi liet ke fact. */
export interface V22StoreListFilter {
  status?: V22FactStatus | V22FactStatus[];
  kind?: V22DreamFact['kind'] | V22DreamFact['kind'][];
  topic?: string;
  tag?: string;
  sessionId?: string;
  /** Chi lay fact co confidence >= nguong nay. */
  minConfidence?: number;
  /** Chi lay fact quan sat thay tu moc nay tro di (epoch ms). */
  observedAfter?: number;
}

/** Store fact cua dreaming consolidation. */
export class V22DreamStore {
  private facts = new Map<string, V22DreamFact>();
  private seq = 0;

  /** Tong so fact trong store (moi trang thai). */
  size(): number {
    return this.facts.size;
  }

  /** So fact dang active. */
  activeCount(): number {
    let n = 0;
    for (const f of this.facts.values()) if (f.status === 'active') n += 1;
    return n;
  }

  /** So fact theo tung trang thai. */
  countByStatus(): Record<V22FactStatus, number> {
    const out: Record<V22FactStatus, number> = {
      active: 0,
      superseded: 0,
      expired: 0,
      merged: 0,
      invalidated: 0,
    };
    for (const f of this.facts.values()) out[f.status] += 1;
    return out;
  }

  get(id: string): V22DreamFact | undefined {
    const fact = this.facts.get(id);
    return fact ? cloneDreamFactV22(fact) : undefined;
  }

  /** Liet ke fact theo bo loc, sap theo confidence giam dan. */
  list(filter: V22StoreListFilter = {}): V22DreamFact[] {
    const statuses = filter.status === undefined
      ? undefined
      : Array.isArray(filter.status) ? filter.status : [filter.status];
    const kinds = filter.kind === undefined
      ? undefined
      : Array.isArray(filter.kind) ? filter.kind : [filter.kind];
    const topicNorm = filter.topic === undefined ? undefined : normalizeTopicV22(filter.topic);
    const out: V22DreamFact[] = [];
    for (const fact of this.facts.values()) {
      if (statuses && !statuses.includes(fact.status)) continue;
      if (kinds && !kinds.includes(fact.kind)) continue;
      if (topicNorm !== undefined && normalizeTopicV22(fact.topic ?? '') !== topicNorm) continue;
      if (filter.tag !== undefined && !fact.tags.includes(filter.tag)) continue;
      if (filter.sessionId !== undefined && !fact.sessionIds.includes(filter.sessionId)) continue;
      if (filter.minConfidence !== undefined && fact.confidence < filter.minConfidence) continue;
      if (filter.observedAfter !== undefined && fact.observedAt < filter.observedAfter) continue;
      out.push(cloneDreamFactV22(fact));
    }
    out.sort((a, b) => b.confidence - a.confidence || b.observedAt - a.observedAt);
    return out;
  }

  /**
   * Them fact moi. Tra loi co cau truc (khong throw) khi du lieu
   * khong hop le; chi throw V22DreamError khi store da day
   * (loi lap trinh / gioi han cung).
   */
  addFact(input: V22DreamFactInput, now = Date.now()): V22Result<V22DreamFact> {
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (text.length < V22_MIN_FACT_TEXT_CHARS) {
      return { ok: false, error: `text fact qua ngan (can it nhat ${V22_MIN_FACT_TEXT_CHARS} ky tu).`, errorCode: 'invalid_text' };
    }
    if (text.length > V22_MAX_FACT_TEXT_CHARS) {
      return { ok: false, error: `text fact qua dai (toi da ${V22_MAX_FACT_TEXT_CHARS} ky tu).`, errorCode: 'invalid_text' };
    }
    const confidence = input.confidence ?? 0.5;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return { ok: false, error: 'confidence phai trong [0, 1].', errorCode: 'invalid_confidence' };
    }
    if (!isValidTopicV22(input.topic)) {
      return { ok: false, error: 'topic khong hop le (rong hoac qua dai).', errorCode: 'invalid_topic' };
    }
    if (!isValidValueV22(input.value)) {
      return { ok: false, error: 'value khong hop le (rong hoac qua dai).', errorCode: 'invalid_value' };
    }
    if (this.facts.size >= V22_MAX_FACTS_PER_STORE) {
      return { ok: false, error: `store da day (${V22_MAX_FACTS_PER_STORE} fact).`, errorCode: 'store_full' };
    }
    if (
      input.validFrom !== undefined && input.validUntil !== undefined
      && input.validUntil <= input.validFrom
    ) {
      return { ok: false, error: 'validUntil phai lon hon validFrom.', errorCode: 'invalid_input' };
    }
    this.seq += 1;
    const id = `dream-fact-${now}-${this.seq}`;
    const observedAt = input.observedAt ?? now;
    const fact: V22DreamFact = {
      id,
      kind: input.kind ?? 'fact',
      text,
      ...(input.topic !== undefined ? { topic: normalizeTopicV22(input.topic) } : {}),
      ...(input.value !== undefined ? { value: normalizeValueV22(input.value) } : {}),
      confidence,
      status: 'active',
      sources: dedupeStringsV22(input.sources ?? []).slice(0, V22_MAX_SOURCES_PER_FACT),
      tags: dedupeStringsV22(input.tags ?? []).slice(0, V22_MAX_TAGS_PER_FACT),
      sessionIds: dedupeStringsV22(input.sessionIds ?? []).slice(0, V22_MAX_SESSIONS_PER_FACT),
      observedAt,
      updatedAt: now,
      ...(input.validFrom !== undefined ? { validFrom: input.validFrom } : {}),
      ...(input.validUntil !== undefined ? { validUntil: input.validUntil } : {}),
      supersedes: [],
      mergedFrom: [],
      origin: input.origin ?? 'chat',
      version: 1,
    };
    this.facts.set(id, fact);
    return { ok: true, data: cloneDreamFactV22(fact) };
  }

  /**
   * Cap nhat confidence cua mot fact (tang version). Tra false
   * khi khong co fact hoac confidence khong hop le.
   */
  setConfidence(id: string, confidence: number, now = Date.now()): boolean {
    const fact = this.facts.get(id);
    if (!fact) return false;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return false;
    this.facts.set(id, { ...fact, confidence, updatedAt: now, version: fact.version + 1 });
    return true;
  }

  /**
   * Doi trang thai mot fact (superseded / expired / merged /
   * invalidated / active). Ghi ro quan he (supersededBy,
   * mergedInto) khi co. Tra false khi khong co fact.
   */
  setStatus(
    id: string,
    status: V22FactStatus,
    opts: { supersededBy?: string; mergedInto?: string; now?: number } = {},
  ): boolean {
    const fact = this.facts.get(id);
    if (!fact) return false;
    const now = opts.now ?? Date.now();
    const next: V22DreamFact = {
      ...fact,
      status,
      updatedAt: now,
      version: fact.version + 1,
    };
    if (opts.supersededBy !== undefined) next.supersededBy = opts.supersededBy;
    if (opts.mergedInto !== undefined) next.mergedInto = opts.mergedInto;
    if (status === 'active') {
      delete next.supersededBy;
      delete next.mergedInto;
    }
    this.facts.set(id, next);
    return true;
  }

  /** Ghi quan he supersedes hai chieu (thang -> thua). */
  linkSupersede(winnerId: string, loserId: string, now = Date.now()): boolean {
    const winner = this.facts.get(winnerId);
    if (!winner) return false;
    if (!winner.supersedes.includes(loserId)) {
      this.facts.set(winnerId, {
        ...winner,
        supersedes: [...winner.supersedes, loserId],
        updatedAt: now,
        version: winner.version + 1,
      });
    }
    return true;
  }

  /** Ghi quan he merge: keeper nhan them nguon/tag/session cua fact bi gop. */
  absorbMerged(keeperId: string, merged: V22DreamFact, now = Date.now()): boolean {
    const keeper = this.facts.get(keeperId);
    if (!keeper) return false;
    const sources = dedupeStringsV22([...keeper.sources, ...merged.sources])
      .slice(0, V22_MAX_SOURCES_PER_FACT);
    const tags = dedupeStringsV22([...keeper.tags, ...merged.tags])
      .slice(0, V22_MAX_TAGS_PER_FACT);
    const sessionIds = dedupeStringsV22([...keeper.sessionIds, ...merged.sessionIds])
      .slice(0, V22_MAX_SESSIONS_PER_FACT);
    this.facts.set(keeperId, {
      ...keeper,
      sources,
      tags,
      sessionIds,
      confidence: Math.max(keeper.confidence, merged.confidence),
      mergedFrom: dedupeStringsV22([...keeper.mergedFrom, merged.id]),
      updatedAt: now,
      version: keeper.version + 1,
    });
    return true;
  }

  /** Cap nhat text + confidence cua mot fact (pattern refresh). */
  updateFact(
    id: string,
    patch: { text?: string; confidence?: number; sources?: string[]; tags?: string[]; sessionIds?: string[] },
    now = Date.now(),
  ): V22Result<V22DreamFact> {
    const fact = this.facts.get(id);
    if (!fact) return { ok: false, error: `khong co fact "${id}".`, errorCode: 'fact_not_found' };
    if (patch.text !== undefined) {
      const text = patch.text.trim();
      if (text.length < V22_MIN_FACT_TEXT_CHARS || text.length > V22_MAX_FACT_TEXT_CHARS) {
        return { ok: false, error: 'text fact khong hop le (qua ngan hoac qua dai).', errorCode: 'invalid_text' };
      }
    }
    if (patch.confidence !== undefined && (!Number.isFinite(patch.confidence) || patch.confidence < 0 || patch.confidence > 1)) {
      return { ok: false, error: 'confidence phai trong [0, 1].', errorCode: 'invalid_confidence' };
    }
    const next: V22DreamFact = {
      ...fact,
      ...(patch.text !== undefined ? { text: patch.text.trim() } : {}),
      ...(patch.confidence !== undefined ? { confidence: patch.confidence } : {}),
      ...(patch.sources !== undefined ? { sources: dedupeStringsV22(patch.sources).slice(0, V22_MAX_SOURCES_PER_FACT) } : {}),
      ...(patch.tags !== undefined ? { tags: dedupeStringsV22(patch.tags).slice(0, V22_MAX_TAGS_PER_FACT) } : {}),
      ...(patch.sessionIds !== undefined ? { sessionIds: dedupeStringsV22(patch.sessionIds).slice(0, V22_MAX_SESSIONS_PER_FACT) } : {}),
      updatedAt: now,
      version: fact.version + 1,
    };
    this.facts.set(id, next);
    return { ok: true, data: cloneDreamFactV22(next) };
  }

  /** Xuat toan bo trang thai (JSON-safe) de luu / nap lai. */
  exportState(): { facts: V22DreamFact[]; seq: number } {
    return {
      facts: [...this.facts.values()].map((f) => cloneDreamFactV22(f)),
      seq: this.seq,
    };
  }

  /** Nap lai trang thai da xuat (ghi de toan bo store). */
  importState(state: { facts: V22DreamFact[]; seq?: number }): { imported: number; skipped: number } {
    let imported = 0;
    let skipped = 0;
    const next = new Map<string, V22DreamFact>();
    for (const raw of state.facts ?? []) {
      try {
        const fact = validateImportedFactV22(raw);
        next.set(fact.id, fact);
        imported += 1;
      } catch {
        skipped += 1;
      }
    }
    this.facts = next;
    this.seq = Math.max(this.seq, state.seq ?? 0, imported);
    return { imported, skipped };
  }

  /** Xoa sach store (chi dung trong test / reset co chu dich). */
  clear(): number {
    const n = this.facts.size;
    this.facts.clear();
    return n;
  }
}

/** Deep copy mot fact (de caller khong sua duoc state ben trong). */
export function cloneDreamFactV22(fact: V22DreamFact): V22DreamFact {
  return {
    ...fact,
    sources: [...fact.sources],
    tags: [...fact.tags],
    sessionIds: [...fact.sessionIds],
    supersedes: [...fact.supersedes],
    mergedFrom: [...fact.mergedFrom],
  };
}

/** Loai trung, bo chuoi rong, giu thu tu xuat hien. */
export function dedupeStringsV22(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Kiem tra + chuan hoa mot fact nhap tu JSON (importState /
 * snapshot restore). Throw V22DreamError khi du lieu hong —
 * caller dem vao `skipped` thay vi crash ca lan nap.
 */
export function validateImportedFactV22(raw: unknown): V22DreamFact {
  if (typeof raw !== 'object' || raw === null) {
    throw new V22DreamError('fact nhap phai la object.');
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id.trim() === '') {
    throw new V22DreamError('fact nhap thieu id.');
  }
  if (typeof r.text !== 'string' || r.text.trim().length < V22_MIN_FACT_TEXT_CHARS) {
    throw new V22DreamError(`fact ${r.id} co text khong hop le.`);
  }
  if (typeof r.confidence !== 'number' || r.confidence < 0 || r.confidence > 1) {
    throw new V22DreamError(`fact ${r.id} co confidence khong hop le.`);
  }
  const kind = typeof r.kind === 'string' && (['fact', 'preference', 'decision', 'observation', 'pattern', 'note'] as string[]).includes(r.kind)
    ? (r.kind as V22DreamFact['kind'])
    : 'fact';
  const status = typeof r.status === 'string' && (['active', 'superseded', 'expired', 'merged', 'invalidated'] as string[]).includes(r.status)
    ? (r.status as V22FactStatus)
    : 'active';
  const stringList = (value: unknown): string[] => (Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : []);
  return {
    id: (r.id as string).trim(),
    kind,
    text: (r.text as string).trim(),
    ...(typeof r.topic === 'string' && r.topic.trim() ? { topic: normalizeTopicV22(r.topic) } : {}),
    ...(typeof r.value === 'string' && r.value.trim() ? { value: normalizeValueV22(r.value) } : {}),
    confidence: r.confidence as number,
    status,
    sources: stringList(r.sources),
    tags: stringList(r.tags),
    sessionIds: stringList(r.sessionIds),
    observedAt: typeof r.observedAt === 'number' ? r.observedAt : Date.now(),
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : Date.now(),
    ...(typeof r.validFrom === 'number' ? { validFrom: r.validFrom } : {}),
    ...(typeof r.validUntil === 'number' ? { validUntil: r.validUntil } : {}),
    supersedes: stringList(r.supersedes),
    ...(typeof r.supersededBy === 'string' ? { supersededBy: r.supersededBy } : {}),
    ...(typeof r.mergedInto === 'string' ? { mergedInto: r.mergedInto } : {}),
    mergedFrom: stringList(r.mergedFrom),
    origin: typeof r.origin === 'string' && (['chat', 'tool', 'import', 'dream', 'pattern'] as string[]).includes(r.origin)
      ? (r.origin as V22DreamFact['origin'])
      : 'chat',
    version: typeof r.version === 'number' && r.version >= 1 ? Math.floor(r.version) : 1,
  };
}
