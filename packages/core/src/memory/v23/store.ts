/**
 * Memory v23 — store (v1.38, Doi T1).
 *
 * Store record v23: Map trong RAM + luu file JSON (mot file, ghi
 * nguyen tu qua file tam + rename). Moi record co version, status,
 * validity window, embedding + provenance. Store tu giu entity
 * index dong bo (them/xoa/cap nhat deu cap nhat index).
 *
 * API tra ket qua co cau truc cho moi ghi (khong throw khi input
 * sai — tra `{ ok: false, error }`); chi throw khi lap trinh sai
 * kieu (vd truyen non-object). Doc (get/list/search) khong throw.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { extractEntitiesV23, V23EntityIndex } from './entityIndex';
import type { V23LocalEmbedder } from './localEmbedder';
import {
  clampMemoryV23,
  createV23Id,
  isV23RecordValidAt,
  jaccardV23,
  makeV23Scope,
  normalizeV23Text,
  todayIsoV23,
  V23_RECORD_KINDS,
} from './types';
import type {
  V23MemoryRecord,
  V23NewRecordInput,
  V23RecordKind,
  V23RecordStatus,
  V23Scope,
  V23StoreStats,
} from './types';

/** Ket qua ghi (put/update/delete) — co cau truc. */
export interface V23StoreWriteResult {
  ok: boolean;
  record?: V23MemoryRecord;
  error?: string;
}

/** Tuy chon tao store. */
export interface V23MemoryStoreOptions {
  /** Duong dan file JSON de luu (khong co = chi RAM). */
  filePath?: string;
  /** Embedder local (neu co, put se gan embedding khi thieu). */
  embedder?: V23LocalEmbedder;
  /** Co tu dong embed khi put khong (mac dinh false — tranh cham). */
  autoEmbed?: boolean;
  /** Ham lay thoi gian (test truyen clock co dinh). */
  now?: () => number;
}

/** Ban luu tren dia: version dinh dang + danh sach record. */
interface V23StoreFileData {
  format: 'openbot-memory-v23';
  version: 1;
  savedAt: number;
  records: V23MemoryRecord[];
}

const V23_STORE_FILE_FORMAT = 'openbot-memory-v23';

/** Kiem tra mot object co phai V23MemoryRecord hop le toi thieu khong. */
export function isValidV23Record(value: unknown): value is V23MemoryRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<V23MemoryRecord>;
  if (typeof r.id !== 'string' || !r.id) return false;
  if (typeof r.text !== 'string' || !normalizeV23Text(r.text)) return false;
  if (typeof r.kind !== 'string' || !(V23_RECORD_KINDS as string[]).includes(r.kind)) return false;
  if (!r.scope || typeof r.scope !== 'object') return false;
  if (!Array.isArray(r.entities) || !Array.isArray(r.tags)) return false;
  if (typeof r.confidence !== 'number' || r.confidence < 0 || r.confidence > 1) return false;
  if (typeof r.version !== 'number' || r.version < 1) return false;
  if (typeof r.createdAt !== 'number' || typeof r.updatedAt !== 'number') return false;
  return true;
}

/**
 * Store memory v23.
 *
 * Luu y ve dong bo: moi ghi cap nhat ca Map + entity index; neu
 * co filePath thi ghi file ngay (dong bo, file nho — dung cho bot
 * ca nhan, khong phai DB dong thoi cao).
 */
export class V23MemoryStore {
  private readonly records = new Map<string, V23MemoryRecord>();
  private readonly entityIndex = new V23EntityIndex();
  private readonly filePath?: string;
  private embedder?: V23LocalEmbedder;
  private readonly autoEmbed: boolean;
  private readonly now: () => number;

  constructor(opts: V23MemoryStoreOptions = {}) {
    this.filePath = opts.filePath;
    this.embedder = opts.embedder;
    this.autoEmbed = opts.autoEmbed ?? false;
    this.now = opts.now ?? Date.now;
    if (this.filePath && existsSync(this.filePath)) {
      this.loadFromFile();
    }
  }

  /** So record (mac dinh chi dem active; truyen false de dem tat ca). */
  size(activeOnly = true): number {
    if (!activeOnly) return this.records.size;
    let n = 0;
    for (const r of this.records.values()) if (r.status === 'active') n += 1;
    return n;
  }

  /** Store co embedder de gan embedding khong. */
  hasEmbedder(): boolean {
    return this.embedder !== undefined;
  }

  /** Gan / doi embedder sau khi tao store (pipeline dung de noi embedder cua no vao store). */
  setEmbedder(embedder: V23LocalEmbedder): void {
    this.embedder = embedder;
  }

  /** Entity index noi bo (dung chung cho fusion — khong tao moi). */
  getEntityIndex(): V23EntityIndex {
    return this.entityIndex;
  }

  /** Lay mot record theo id (undefined neu khong co). */
  get(id: string): V23MemoryRecord | undefined {
    const found = this.records.get(id);
    return found ? { ...found, scope: { ...found.scope }, entities: [...found.entities], tags: [...found.tags] } : undefined;
  }

  /** Liet ke record (loc theo kind/status/scope, sap theo updatedAt giam dan). */
  list(filter: {
    kind?: V23RecordKind;
    status?: V23RecordStatus;
    scope?: Partial<V23Scope>;
    validAt?: number;
    limit?: number;
  } = {}): V23MemoryRecord[] {
    const out: V23MemoryRecord[] = [];
    for (const record of this.records.values()) {
      if (filter.kind && record.kind !== filter.kind) continue;
      if (filter.status && record.status !== filter.status) continue;
      if (filter.scope) {
        if (filter.scope.userId && record.scope.userId !== filter.scope.userId) continue;
        if (filter.scope.agentId && record.scope.agentId !== filter.scope.agentId) continue;
        if (filter.scope.runId && record.scope.runId !== filter.scope.runId) continue;
        if (filter.scope.appId && record.scope.appId !== filter.scope.appId) continue;
      }
      if (filter.validAt !== undefined && !isV23RecordValidAt(record, filter.validAt)) continue;
      out.push(record);
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    const limit = filter.limit ?? 0;
    return (limit > 0 ? out.slice(0, limit) : out).map((r) => ({
      ...r,
      scope: { ...r.scope },
      entities: [...r.entities],
      tags: [...r.tags],
    }));
  }

  /** Tat ca record active (dung cho fusion / sleep). */
  listActive(): V23MemoryRecord[] {
    return this.list({ status: 'active' });
  }

  /** Them record moi (tao id + version 1 neu chua co). */
  put(input: V23NewRecordInput & { id?: string }): V23StoreWriteResult {
    const text = normalizeV23Text(input.text ?? '');
    if (!text) return { ok: false, error: 'Text record rong.' };
    if (text.length > 2000) return { ok: false, error: 'Text record vuot 2000 ky tu.' };
    const kind = input.kind ?? 'fact';
    if (!(V23_RECORD_KINDS as string[]).includes(kind)) {
      return { ok: false, error: `kind "${kind}" khong hop le.` };
    }
    const now = this.now();
    const id = input.id && !this.records.has(input.id) ? input.id : createV23Id(kind, now);
    const confidence = clampMemoryV23(input.confidence ?? 0.6, 0, 1);
    // Entity: caller truyen thi dung; khong truyen thi tu trich tu
    // text (de fusion entity signal hoat dong ngay ca khi put tay).
    const entities = input.entities !== undefined
      ? [...new Set(input.entities.map((e) => e.toLowerCase().trim()).filter(Boolean))]
      : extractEntitiesV23(text);
    const record: V23MemoryRecord = {
      id,
      kind,
      text,
      scope: makeV23Scope(input.scope ?? {}),
      entities,
      tags: [...new Set((input.tags ?? []).map((t) => t.trim()).filter(Boolean))],
      confidence,
      source: input.source ?? 'manual',
      ...(input.validFrom ? { validFrom: input.validFrom } : {}),
      ...(input.validTo ? { validTo: input.validTo } : {}),
      version: 1,
      status: 'active',
      retrievalCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(id, record);
    this.entityIndex.addRecord(id, record.entities);
    this.persist();
    return { ok: true, record: this.get(id) };
  }

  /**
   * Cap nhat record (tang version, giu createdAt). Chi cac field
   * cho phep: text/kind/entities/tags/confidence/status/validFrom/
   * validTo/supersededBy. Tra loi neu id khong co.
   */
  update(
    id: string,
    patch: Partial<Pick<V23MemoryRecord, 'text' | 'kind' | 'entities' | 'tags' | 'confidence' | 'status' | 'validFrom' | 'validTo' | 'supersededBy'>>,
  ): V23StoreWriteResult {
    const existing = this.records.get(id);
    if (!existing) return { ok: false, error: `Khong co record "${id}".` };
    if (patch.text !== undefined) {
      const text = normalizeV23Text(patch.text);
      if (!text) return { ok: false, error: 'Text record rong.' };
      if (text.length > 2000) return { ok: false, error: 'Text record vuot 2000 ky tu.' };
    }
    if (patch.kind !== undefined && !(V23_RECORD_KINDS as string[]).includes(patch.kind)) {
      return { ok: false, error: `kind "${patch.kind}" khong hop le.` };
    }
    if (patch.confidence !== undefined && (patch.confidence < 0 || patch.confidence > 1)) {
      return { ok: false, error: 'confidence phai trong [0, 1].' };
    }
    this.entityIndex.removeRecord(id, existing.entities);
    // Text doi ma khong truyen entities moi -> trich lai tu text moi.
    const nextEntities = patch.entities !== undefined
      ? [...new Set(patch.entities.map((e) => e.toLowerCase().trim()).filter(Boolean))]
      : patch.text !== undefined
        ? extractEntitiesV23(normalizeV23Text(patch.text))
        : existing.entities;
    const updated: V23MemoryRecord = {
      ...existing,
      ...(patch.text !== undefined ? { text: normalizeV23Text(patch.text) } : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      entities: nextEntities,
      ...(patch.tags !== undefined
        ? { tags: [...new Set(patch.tags.map((t) => t.trim()).filter(Boolean))] }
        : {}),
      ...(patch.confidence !== undefined ? { confidence: clampMemoryV23(patch.confidence, 0, 1) } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.validFrom !== undefined ? { validFrom: patch.validFrom } : {}),
      ...(patch.validTo !== undefined ? { validTo: patch.validTo } : {}),
      ...(patch.supersededBy !== undefined ? { supersededBy: patch.supersededBy } : {}),
      // Text doi -> embedding cu het gia tri.
      ...(patch.text !== undefined ? { embedding: undefined, embeddingKind: undefined } : {}),
      version: existing.version + 1,
      updatedAt: this.now(),
    };
    this.records.set(id, updated);
    this.entityIndex.addRecord(id, updated.entities);
    this.persist();
    return { ok: true, record: this.get(id) };
  }

  /** Xoa mem: danh status deleted (giu audit, sleep co the purge sau). */
  delete(id: string): V23StoreWriteResult {
    const existing = this.records.get(id);
    if (!existing) return { ok: false, error: `Khong co record "${id}".` };
    return this.update(id, { status: 'deleted' });
  }

  /** Khoi phuc record da xoa mem ve active. */
  restore(id: string): V23StoreWriteResult {
    const existing = this.records.get(id);
    if (!existing) return { ok: false, error: `Khong co record "${id}".` };
    if (existing.status !== 'deleted') return { ok: false, error: `Record "${id}" khong o trang thai deleted.` };
    return this.update(id, { status: 'active' });
  }

  /** Ghi nhan mot lan retrieval (tang counter, cap nhat lastRetrievedAt). */
  markRetrieved(id: string): void {
    const existing = this.records.get(id);
    if (!existing) return;
    existing.retrievalCount += 1;
    existing.lastRetrievedAt = this.now();
    // Khong persist moi lan retrieval (tranh ghi file lien tuc);
    // caller persist dinh ky (vd cuoi sleep pass / khi dong).
  }

  /** Gan embedding cho record (ghi ro provenance). */
  async embedRecord(id: string): Promise<V23StoreWriteResult> {
    const existing = this.records.get(id);
    if (!existing) return { ok: false, error: `Khong co record "${id}".` };
    if (!this.embedder) return { ok: false, error: 'Store chua co embedder.' };
    const res = await this.embedder.embed(existing.text);
    if (!res.ok || !res.vector) return { ok: false, error: res.error ?? 'Embed that bai.' };
    existing.embedding = res.vector;
    existing.embeddingKind = res.kind;
    existing.updatedAt = this.now();
    this.persist();
    return { ok: true, record: this.get(id) };
  }

  /** Embed toan bo record active chua co embedding (gioi han `limit`). */
  async embedMissing(limit = 100): Promise<{ embedded: number; failed: number }> {
    let embedded = 0;
    let failed = 0;
    const pending = this.listActive().filter((r) => !r.embedding).slice(0, Math.max(0, limit));
    for (const record of pending) {
      const res = await this.embedRecord(record.id);
      if (res.ok) embedded += 1;
      else failed += 1;
    }
    return { embedded, failed };
  }

  /** Tim record trung lap gan dung voi text (Jaccard >= threshold). */
  findNearDuplicates(text: string, threshold = 0.6): { record: V23MemoryRecord; similarity: number }[] {
    const out: { record: V23MemoryRecord; similarity: number }[] = [];
    for (const record of this.listActive()) {
      const sim = jaccardV23(text, record.text);
      if (sim >= threshold) out.push({ record: this.get(record.id) as V23MemoryRecord, similarity: sim });
    }
    out.sort((a, b) => b.similarity - a.similarity || a.record.id.localeCompare(b.record.id));
    return out;
  }

  /** Thong ke store. */
  stats(): V23StoreStats {
    const byKind: Record<string, number> = {};
    const byScopeLevel: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    let withEmbedding = 0;
    let confSum = 0;
    let oldest: number | null = null;
    let newest: number | null = null;
    for (const r of this.records.values()) {
      byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      const level = r.scope.runId ? 'run' : r.scope.agentId ? 'agent' : r.scope.userId ? 'user' : 'app';
      byScopeLevel[level] = (byScopeLevel[level] ?? 0) + 1;
      if (r.embedding) withEmbedding += 1;
      confSum += r.confidence;
      if (oldest === null || r.createdAt < oldest) oldest = r.createdAt;
      if (newest === null || r.createdAt > newest) newest = r.createdAt;
    }
    const total = this.records.size;
    return {
      total,
      active: this.size(true),
      byKind,
      byScopeLevel,
      byStatus,
      withEmbedding,
      avgConfidence: total === 0 ? 0 : Math.round((confSum / total) * 1000) / 1000,
      oldestCreatedAt: oldest,
      newestCreatedAt: newest,
    };
  }

  /** Xuat tat ca record dang JSON (de backup / chuyen doi). */
  exportJson(): string {
    const data: V23StoreFileData = {
      format: V23_STORE_FILE_FORMAT,
      version: 1,
      savedAt: this.now(),
      records: [...this.records.values()].sort((a, b) => a.id.localeCompare(b.id)),
    };
    return JSON.stringify(data, null, 2);
  }

  /** Nhap JSON (bo qua record loi, tra so nhap duoc + so loi). */
  importJson(json: string): { imported: number; skipped: number; errors: string[] } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json) as unknown;
    } catch {
      return { imported: 0, skipped: 0, errors: ['JSON khong hop le.'] };
    }
    const records = (parsed as Partial<V23StoreFileData>).records;
    if (!Array.isArray(records)) return { imported: 0, skipped: 0, errors: ['Thieu mang records.'] };
    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];
    for (const raw of records) {
      if (!isValidV23Record(raw)) {
        skipped += 1;
        errors.push(`Bo record loi (id=${(raw as { id?: unknown })?.id ?? '?'})`);
        continue;
      }
      const old = this.records.get(raw.id);
      if (old) this.entityIndex.removeRecord(raw.id, old.entities);
      this.records.set(raw.id, { ...raw, scope: { ...raw.scope }, entities: [...raw.entities], tags: [...raw.tags] });
      this.entityIndex.addRecord(raw.id, raw.entities);
      imported += 1;
    }
    if (imported > 0) this.persist();
    return { imported, skipped, errors: errors.slice(0, 20) };
  }

  /** Ghi file ngay (neu co filePath). Ghi nguyen tu qua file tam. */
  persist(): void {
    if (!this.filePath) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp-${process.pid}`;
      writeFileSync(tmp, this.exportJson(), 'utf8');
      renameSync(tmp, this.filePath);
    } catch {
      // Ghi file loi khong lam mat du lieu RAM; caller thay qua stats/file.
    }
  }

  /** Doc file vao RAM (ghi de toan bo store hien tai). */
  loadFromFile(): { loaded: number; skipped: number } {
    if (!this.filePath || !existsSync(this.filePath)) return { loaded: 0, skipped: 0 };
    let raw = '';
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch {
      return { loaded: 0, skipped: 0 };
    }
    this.records.clear();
    this.entityIndex.clear();
    const res = this.importJson(raw);
    return { loaded: res.imported, skipped: res.skipped };
  }

  /** Duong dan file luu mac dinh trong workspace (cho tool). */
  static defaultFilePath(workspaceDir: string): string {
    return join(workspaceDir, 'memory-v23.json');
  }

  /** Hom nay dang ISO (dung cho validTo mac dinh khi can). */
  static today(now = Date.now()): string {
    return todayIsoV23(now);
  }
}
