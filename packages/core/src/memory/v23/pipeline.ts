/**
 * Memory v23 — pipeline (v1.38, Doi T1).
 *
 * Lop gop mot-lan-goi cho ca pipeline Mem0-style:
 *   hoi thoai -> extract -> consolidate -> (embed) -> store
 * va retrieval:
 *   query + scope -> scoped fusion -> hit da xep hang.
 *
 * Pipeline la cho tool `memory_v23_add` / `memory_v23_search`
 * goi truc tiep (khong phai tu rap tung buoc). Moi buoc van tach
 * rieng (extractor / consolidator / fusion / scopedRetrieval) de
 * test doc lap; pipeline chi dieu phoi + bao cao tong.
 *
 * Khong goi model chat, khong goi mang ngoai. Embedder mac dinh
 * la hash-only khi khong truyen Ollama (de pipeline chay duoc
 * ngay ca khi Ollama chua cai — provenance ghi ro `hash`).
 */

import { V23Consolidator } from './consolidator';
import type { V23ConsolidatorOptions } from './consolidator';
import { extractV23Candidates } from './extractor';
import type { V23ChatMessage, V23ExtractorOptions } from './extractor';
import { fuseV23 } from './fusion';
import type { V23FusionOptions } from './fusion';
import { V23LocalEmbedder } from './localEmbedder';
import { retrieveV23Scoped } from './scopedRetrievalV23';
import type { V23ScopedRetrievalOptions } from './scopedRetrievalV23';
import { V23SleepConsolidator } from './sleepV2';
import type { V23SleepOptions } from './sleepV2';
import { V23MemoryStore } from './store';
import type {
  V23ConsolidationReport,
  V23ExtractCandidate,
  V23FusionHit,
  V23ScopedHit,
  V23Scope,
  V23SleepReport,
} from './types';

/** Tuy chon pipeline (gom tuy chon tung buoc). */
export interface V23PipelineOptions {
  /** Tuy chon extractor. */
  extractor?: V23ExtractorOptions;
  /** Tuy chon consolidator. */
  consolidator?: V23ConsolidatorOptions;
  /** Tuy chon fusion (cho search). */
  fusion?: V23FusionOptions;
  /** Tuy chon sleep (cho runSleep). */
  sleep?: V23SleepOptions;
  /** Embed record moi ngay sau khi consolidate (mac dinh true). */
  embedNewRecords?: boolean;
  /** So record toi da embed moi lan add (mac dinh 50). */
  maxEmbedPerAdd?: number;
  /** Ham lay thoi gian (test truyen clock co dinh). */
  now?: () => number;
}

/** Ket qua mot lan add hoi thoai vao memory. */
export interface V23PipelineAddResult {
  /** So cau trich duoc thanh ung vien. */
  extracted: number;
  /** Bao cao consolidation (add/update/supersede/merge/noise/drop). */
  report: V23ConsolidationReport;
  /** So record moi duoc embed thanh cong. */
  embedded: number;
  /** So record embed loi (ghi ro ly do o `embedErrors`). */
  embedFailed: number;
  embedErrors: string[];
  /** Id cac record moi duoc them (de UI hien thi). */
  addedIds: string[];
}

/** Ket qua search qua pipeline (kem scope da dung). */
export interface V23PipelineSearchResult {
  hits: V23ScopedHit[];
  /** Scope truy van da dung (echo). */
  scope: V23Scope;
  /** Query da chuan hoa (trim). */
  query: string;
  /** Co dung embedder that (ollama) hay hash-only. */
  embeddingKind: 'ollama' | 'hash' | 'none';
}

/**
 * Pipeline v23: dieu phoi extract -> consolidate -> embed -> store
 * va scoped retrieval. Giu store + embedder + consolidator rieng
 * de tool co the dung chung mot pipeline cho nhieu call.
 */
export class V23Pipeline {
  readonly store: V23MemoryStore;
  readonly embedder: V23LocalEmbedder;
  private readonly consolidator: V23Consolidator;
  private readonly extractorOpts: V23ExtractorOptions;
  private readonly fusionOpts: V23FusionOptions;
  private readonly sleepOpts: V23SleepOptions;
  private readonly embedNewRecords: boolean;
  private readonly maxEmbedPerAdd: number;
  private readonly now: () => number;

  constructor(store: V23MemoryStore, embedder?: V23LocalEmbedder, opts: V23PipelineOptions = {}) {
    this.store = store;
    this.embedder = embedder ?? new V23LocalEmbedder();
    // Noi embedder cua pipeline vao store (neu store chua co) de
    // embedRecord/embedMissing hoat dong — truoc day store tao
    // khong embedder thi pipeline embed that bai am tham.
    if (!this.store.hasEmbedder()) this.store.setEmbedder(this.embedder);
    this.consolidator = new V23Consolidator(opts.consolidator ?? {});
    this.extractorOpts = opts.extractor ?? {};
    this.fusionOpts = opts.fusion ?? {};
    this.sleepOpts = opts.sleep ?? {};
    this.embedNewRecords = opts.embedNewRecords ?? true;
    this.maxEmbedPerAdd = opts.maxEmbedPerAdd ?? 50;
    this.now = opts.now ?? Date.now;
  }

  /** Tao pipeline voi store moi trong RAM (tien cho test / tool tam). */
  static inMemory(opts: V23PipelineOptions = {}): V23Pipeline {
    const store = new V23MemoryStore({ now: opts.now ?? Date.now });
    return new V23Pipeline(store, new V23LocalEmbedder(), opts);
  }

  /** Chi trich xuat (khong ghi) — dung cho preview / tool extract. */
  preview(messages: V23ChatMessage[]): V23ExtractCandidate[] {
    return extractV23Candidates(messages, this.extractorOpts);
  }

  /**
   * Them hoi thoai vao memory: extract -> consolidate -> embed
   * record moi. Tra bao cao day du; loi embed khong lam hong
   * record (record van o store, chi chua co embedding).
   */
  async addConversation(
    messages: V23ChatMessage[],
    scope: Partial<V23Scope> = {},
    source = 'pipeline-v23',
  ): Promise<V23PipelineAddResult> {
    const candidates = extractV23Candidates(messages, this.extractorOpts);
    // Gan scope vao ung vien qua consolidator: consolidator put
    // record khong nhan scope — nen pipeline tu put thay vi dung
    // consolidator.consolidate() khi scope khac rong. De giu mot
    // duong code duy nhat, pipeline dung consolidator voi store
    // tam? Khong — dung truc tiep: preview quyet dinh roi ap dung.
    // (Xem ghi chu o duoi: scope duoc gan o buoc put.)
    const report = this.consolidateWithScope(candidates, scope, source);
    const addedIds = report.decisions
      .filter((d) => d.decision === 'add' && d.resultId)
      .map((d) => d.resultId as string);
    let embedded = 0;
    let embedFailed = 0;
    const embedErrors: string[] = [];
    if (this.embedNewRecords) {
      const fresh = this.store.listActive().filter((r) => addedIds.includes(r.id)).slice(0, this.maxEmbedPerAdd);
      for (const record of fresh) {
        if (record.embedding) {
          embedded += 1;
          continue;
        }
        const res = await this.store.embedRecord(record.id);
        if (res.ok) embedded += 1;
        else {
          embedFailed += 1;
          embedErrors.push(`${record.id}: ${res.error ?? 'embed loi'}`);
        }
      }
    }
    return { extracted: candidates.length, report, embedded, embedFailed, embedErrors, addedIds };
  }

  /**
   * Consolidate co scope: nhu V23Consolidator.consolidate nhung
   * record `add` duoc gan scope truyen vao (mac dinh scope rong).
   * Giu nguyen thu tu uu tien confidence cao truoc.
   */
  consolidateWithScope(
    candidates: V23ExtractCandidate[],
    scope: Partial<V23Scope> = {},
    source = 'pipeline-v23',
  ): V23ConsolidationReport {
    // Dung consolidator goc de tinh quyet dinh, nhung chan buoc
    // `add` de tu put co scope: preview truoc, roi ap dung tay.
    const preview = this.consolidator.preview(candidates, this.store);
    const started = Date.now();
    const ranAt = this.now();
    const decisions: V23ConsolidationReport['decisions'] = [];
    let added = 0;
    let updated = 0;
    let superseded = 0;
    let merged = 0;
    let noise = 0;
    let dropped = 0;
    for (const decision of preview) {
      const d = { ...decision };
      if (d.decision === 'add') {
        const res = this.store.put({
          kind: d.candidate.kind,
          text: d.candidate.text,
          scope,
          entities: d.candidate.entities,
          confidence: d.candidate.confidence,
          source,
        });
        if (res.ok && res.record) {
          d.resultId = res.record.id;
          added += 1;
        } else {
          d.decision = 'drop';
          d.reason = `add that bai: ${res.error ?? '?'}`;
          dropped += 1;
        }
      } else if ((d.decision === 'update' || d.decision === 'merge') && d.targetId) {
        // Dung lai consolidator that cho update/merge (da co target);
        // o day ap dung truc tiep de tranh chay lai toan bo.
        const target = this.store.get(d.targetId);
        if (!target) {
          d.decision = 'drop';
          d.reason = 'target bien mat truoc khi ap dung';
          dropped += 1;
        } else {
          const mergedText = target.text.length >= d.candidate.text.length
            ? target.text
            : d.candidate.text;
          const res = this.store.update(target.id, {
            text: mergedText,
            entities: [...new Set([...target.entities, ...d.candidate.entities])],
            confidence: Math.max(target.confidence, d.candidate.confidence),
          });
          if (res.ok && res.record) {
            d.resultId = res.record.id;
            if (d.decision === 'update') updated += 1;
            else merged += 1;
          } else {
            d.decision = 'drop';
            d.reason = `ap dung that bai: ${res.error ?? '?'}`;
            dropped += 1;
          }
        }
      } else if (d.decision === 'supersede' && d.targetId) {
        const target = this.store.get(d.targetId);
        if (!target) {
          d.decision = 'drop';
          d.reason = 'target bien mat truoc khi supersede';
          dropped += 1;
        } else {
          this.store.update(target.id, { status: 'superseded' });
          const res = this.store.put({
            kind: d.candidate.kind,
            text: d.candidate.text,
            scope,
            entities: d.candidate.entities,
            confidence: d.candidate.confidence,
            source,
          });
          if (res.ok && res.record) {
            this.store.update(target.id, { supersededBy: res.record.id });
            d.resultId = res.record.id;
            superseded += 1;
          } else {
            d.decision = 'drop';
            d.reason = `supersede that bai: ${res.error ?? '?'}`;
            dropped += 1;
          }
        }
      } else if (d.decision === 'noise') {
        noise += 1;
      } else {
        dropped += 1;
      }
      decisions.push(d);
    }
    return {
      candidates: candidates.length,
      added,
      updated,
      superseded,
      merged,
      noise,
      dropped,
      decisions,
      ranAt,
      durationMs: Date.now() - started,
    };
  }

  /** Search fusion don gian (khong loc scope) — dung cho tool search. */
  async search(
    query: string,
    opts: V23FusionOptions = {},
  ): Promise<V23FusionHit[]> {
    return fuseV23(this.store.listActive(), query, this.embedder, {
      ...this.fusionOpts,
      ...opts,
      entityIndex: opts.entityIndex ?? this.store.getEntityIndex(),
      now: opts.now ?? this.now,
    });
  }

  /** Search da scope (user/agent/run) — dung cho tool scope_search. */
  async searchScoped(
    query: string,
    scope: Partial<V23Scope>,
    opts: V23ScopedRetrievalOptions = {},
  ): Promise<V23PipelineSearchResult> {
    const fullScope: V23Scope = {
      userId: scope.userId ?? '',
      agentId: scope.agentId ?? '',
      runId: scope.runId ?? '',
      appId: scope.appId ?? '',
    };
    const hits = await retrieveV23Scoped(this.store, query, fullScope, this.embedder, {
      ...this.fusionOpts,
      ...opts,
      entityIndex: opts.entityIndex ?? this.store.getEntityIndex(),
      now: opts.now ?? this.now,
    });
    // Ghi nhan retrieval de sleep promote record hay duoc dung.
    for (const hit of hits) this.store.markRetrieved(hit.record.id);
    this.store.persist();
    const kind = this.embedder.lastKind;
    return {
      hits,
      scope: fullScope,
      query: query.trim(),
      embeddingKind: kind === 'ollama' ? 'ollama' : kind === 'hash' ? 'hash' : 'none',
    };
  }

  /** Chay mot pass sleep-time consolidation v2 tren store. */
  runSleep(): V23SleepReport {
    const consolidator = new V23SleepConsolidator({ ...this.sleepOpts, now: this.now });
    return consolidator.run(this.store);
  }

  /** Embed toan bo record active chua co embedding (gioi han). */
  async embedMissing(limit = 100): Promise<{ embedded: number; failed: number }> {
    return this.store.embedMissing(limit);
  }
}
