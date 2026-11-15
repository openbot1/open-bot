/**
 * MemoryManagerV10 — quản lý memory thống nhất 4 loại CoALA (v1.10, Đội T1).
 *
 * Một điểm vào duy nhất cho toàn bộ memory v10:
 *  - ingestTurn: working push → episodic record → extraction →
 *    consolidation → semantic/procedural (một turn đi hết pipeline
 *    Mem0 trong một lần gọi, trả báo cáo từng bước).
 *  - recall: retrieval hợp nhất 3 tín hiệu qua FusedRetrieverV10.
 *  - blocks: memory block version được (commit/branch/rollback/diff/log).
 *  - renderContextBlock: khối context chèn vào system prompt — working
 *    turn gần nhất + fact semantic đang đúng + procedure khớp (gọn,
 *    có giới hạn ký tự để không phình prompt).
 *  - save/load: persist toàn bộ (facts/episodes/procedures/quarantine/
 *    blocks) xuống một thư mục JSON, load lại đầy đủ.
 *
 * Manager giữ mọi store trong RAM và chỉ chạm đĩa khi save/load —
 * không có ghi lén từng turn (host quyết định khi nào save).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MemoryScope } from '../graph/types';
import type { Embedder } from '../embeddings';
import { BiTemporalGraphV10 } from './biTemporalGraph';
import { EpisodicStore, ProceduralStore, SemanticStore, WorkingMemory } from './coala';
import { consolidateCandidates } from './consolidation';
import { V10Extractor } from './extraction';
import { FusedRetrieverV10, type V10RetrievalOptions } from './retrieval';
import { V10BlockVersionStore } from './versioning';
import {
  emptyV10MemoryFile,
  type V10ConsolidationResult,
  type V10ExtractionResult,
  type V10MemoryFile,
  type V10MemoryStats,
  type V10RetrievalResult,
} from './types';

export interface MemoryManagerV10Options {
  scope: MemoryScope;
  /** Thư mục persist (optional — không có thì chỉ giữ RAM). */
  dir?: string;
  /** Embedder cho retrieval (mặc định: hash-local). */
  embedder?: Embedder;
  workingCapacity?: number;
  workingTtlMs?: number;
  episodicMax?: number;
}

export interface IngestTurnInput {
  role: string;
  text: string;
  turnId: string;
  runId?: string;
  /** Ngày tham chiếu để suy validity window (mặc định: bây giờ). */
  referenceDate?: Date;
}

export interface IngestTurnResult {
  episodeId: string;
  extraction: V10ExtractionResult;
  consolidation: V10ConsolidationResult;
  proceduresAdded: number;
  quarantinePending: number;
}

export class MemoryManagerV10 {
  readonly scope: MemoryScope;
  readonly working: WorkingMemory;
  readonly episodic: EpisodicStore;
  readonly semantic: SemanticStore;
  readonly procedural: ProceduralStore;
  readonly blocks: V10BlockVersionStore;
  private readonly extractor: V10Extractor;
  private readonly retriever: FusedRetrieverV10;
  private readonly dir: string | undefined;
  private quarantineCount = 0;

  constructor(opts: MemoryManagerV10Options) {
    this.scope = { ...opts.scope };
    this.dir = opts.dir;
    this.working = new WorkingMemory({ capacity: opts.workingCapacity, ttlMs: opts.workingTtlMs });
    this.episodic = new EpisodicStore({ maxEpisodes: opts.episodicMax });
    this.semantic = new SemanticStore();
    this.procedural = new ProceduralStore();
    this.blocks = new V10BlockVersionStore({ dir: opts.dir ? path.join(opts.dir, 'blocks') : undefined });
    this.extractor = new V10Extractor();
    this.retriever = new FusedRetrieverV10(opts.embedder);
    if (opts.dir) {
      this.loadFromDir(opts.dir);
      this.quarantineCount = this.loadQuarantineCount(opts.dir);
    }
  }

  /**
   * Ingest một turn: đi hết pipeline trong một lần gọi.
   *  1. Working memory nhận turn (quên nhanh).
   *  2. Episodic ghi episode.
   *  3. Extraction rút fact + thủ tục ứng viên.
   *  4. Consolidation so với graph → ADD/UPDATE/DELETE/QUARANTINE...
   *  5. Thủ tục ứng viên vào procedural store.
   *  6. Episode đánh dấu processed kèm factIds đã tạo.
   */
  async ingestTurn(input: IngestTurnInput): Promise<IngestTurnResult> {
    const scope: MemoryScope = { ...this.scope, runId: input.runId ?? this.scope.runId };
    const now = new Date();
    this.working.push(input.role, input.text, input.turnId, now);
    const episode = this.episodic.record({
      turnId: input.turnId,
      role: input.role,
      text: input.text,
      scope,
    });
    const extraction = await this.extractor.extractTurn(input.text, scope, {
      episodeId: episode.id,
      turnId: input.turnId,
      referenceDate: input.referenceDate,
    });
    const { result: consolidation, quarantine } = consolidateCandidates(extraction.candidates, this.semantic.graph, {
      scope,
      provenance: {
        episodeId: episode.id,
        turnId: input.turnId,
        runId: scope.runId,
        botId: scope.botId,
        userId: scope.userId,
        at: now.toISOString(),
      },
    });
    this.quarantineCount += quarantine.length;
    this.persistQuarantine(quarantine);
    let proceduresAdded = 0;
    for (const proc of extraction.procedures) {
      const before = this.procedural.count();
      this.procedural.add(proc, scope, episode.id);
      if (this.procedural.count() > before) proceduresAdded += 1;
    }
    const factIds = consolidation.actions.filter((a) => a.factId).map((a) => a.factId as string);
    this.episodic.markProcessed(episode.id, factIds);
    return {
      episodeId: episode.id,
      extraction,
      consolidation,
      proceduresAdded,
      quarantinePending: this.quarantineCount,
    };
  }

  /** Recall hợp nhất 3 tín hiệu (vector + BM25 + entity). */
  async recall(query: string, opts: V10RetrievalOptions = {}): Promise<V10RetrievalResult> {
    return this.retriever.retrieve(query, this.semantic.graph, this.episodic, this.procedural, opts);
  }

  /** Timeline bi-temporal của một subject (fact nào đúng khi nào). */
  timeline(subject: string): ReturnType<BiTemporalGraphV10['timeline']> {
    return this.semantic.graph.timeline(subject, { userId: this.scope.userId, botId: this.scope.botId });
  }

  /** Fact đang đúng tại một thời điểm (vd "tháng 3/2026"). */
  factsAt(at: Date): ReturnType<BiTemporalGraphV10['queryAt']> {
    return this.semantic.graph.queryAt(at, { scope: { userId: this.scope.userId, botId: this.scope.botId } });
  }

  /** Khối context chèn vào system prompt: working + semantic hiện tại
   *  + procedure khớp (giới hạn ký tự, cắt từ cuối để giữ mới nhất). */
  async renderContextBlock(query: string, maxChars = 4000): Promise<string> {
    const lines: string[] = [];
    const workingText = this.working.renderContext();
    if (workingText) lines.push(`[Working memory — turn gần nhất]\n${workingText}`);
    const recalled = await this.recall(query, { topK: 5, includeEpisodic: false, includeProcedural: true });
    const semanticLines = recalled.hits
      .filter((h) => h.kind === 'semantic' && h.fact)
      .map((h) => `- ${h.fact?.subject} ${h.fact?.predicate.replace(/_/g, ' ')} ${h.fact?.object} (tin cậy ${h.fact?.confidence})`);
    if (semanticLines.length > 0) lines.push(`[Semantic memory — fact đang đúng]\n${semanticLines.join('\n')}`);
    const procLines = recalled.hits
      .filter((h) => h.kind === 'procedural')
      .map((h) => `- ${h.text.slice(0, 200)}`);
    if (procLines.length > 0) lines.push(`[Procedural memory — thủ tục khớp]\n${procLines.join('\n')}`);
    const joined = lines.join('\n\n');
    if (joined.length <= maxChars) return joined;
    return joined.slice(-maxChars);
  }

  /** Liệt kê quarantine item (mặc định: chỉ pending). */
  listQuarantine(onlyPending = true): V10MemoryFile['quarantine'] {
    const all = this.loadQuarantineFromDisk();
    return onlyPending ? all.filter((q) => q.status === 'pending') : all;
  }

  /**
   * Duyệt một quarantine item. Approve → ứng viên được consolidate
   * lại với forceUpdate (bỏ qua ngưỡng quarantine, vì user đã duyệt);
   * reject → đánh dấu rejected, không ghi gì vào graph. Trả báo cáo
   * consolidation khi approve (null khi reject).
   */
  async reviewQuarantine(
    id: string,
    approve: boolean,
  ): Promise<{ item: V10MemoryFile['quarantine'][number]; consolidation: V10ConsolidationResult | null }> {
    const all = this.loadQuarantineFromDisk();
    const item = all.find((q) => q.id === id);
    if (!item) throw new Error(`V10 quarantine item not found: ${id}`);
    if (item.status !== 'pending') throw new Error(`Quarantine item ${id} already reviewed (${item.status}).`);
    const now = new Date().toISOString();
    let consolidation: V10ConsolidationResult | null = null;
    if (approve) {
      const outcome = consolidateCandidates([item.candidate], this.semantic.graph, {
        scope: { ...item.scope },
        provenance: {
          episodeId: 'quarantine-review',
          turnId: 'review',
          runId: item.scope.runId,
          botId: item.scope.botId,
          userId: item.scope.userId,
          at: now,
        },
        forceUpdate: true,
      });
      consolidation = outcome.result;
    }
    item.status = approve ? 'approved' : 'rejected';
    item.reviewedAt = now;
    this.saveQuarantine(all);
    this.quarantineCount = all.filter((q) => q.status === 'pending').length;
    return { item, consolidation };
  }

  /** Ghi đè toàn bộ file quarantine (dùng nội bộ + review). */
  private saveQuarantine(items: V10MemoryFile['quarantine']): void {
    if (!this.dir) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.quarantineFilePath(this.dir), JSON.stringify({ quarantine: items }, null, 2), 'utf8');
    } catch {
      // Ghi lỗi thì thôi — RAM vẫn đếm đúng.
    }
  }

  stats(): V10MemoryStats {
    return {
      workingItems: this.working.size(),
      episodes: this.episodic.count(),
      factsActive: this.semantic.graph.countByStatus('active'),
      factsSuperseded: this.semantic.graph.countByStatus('superseded'),
      factsDeleted: this.semantic.graph.countByStatus('deleted'),
      procedures: this.procedural.count(),
      blocks: this.blocks.listBlocks().length,
      blockVersions: this.blocks.listBlocks().reduce((n, b) => n + b.versions.length, 0),
      quarantinePending: this.quarantineCount,
      scope: { ...this.scope },
    };
  }

  /** Persist toàn bộ xuống thư mục (memory-v10.json + blocks/). */
  save(): void {
    if (!this.dir) return;
    fs.mkdirSync(this.dir, { recursive: true });
    const now = new Date().toISOString();
    const file: V10MemoryFile = {
      version: 1,
      facts: this.semantic.graph.allFacts(),
      episodes: this.episodic.list(),
      procedures: this.procedural.list(),
      quarantine: this.loadQuarantineFromDisk(),
      blocks: this.blocks.listBlocks(),
      createdAt: now,
      updatedAt: now,
    };
    fs.writeFileSync(path.join(this.dir, 'memory-v10.json'), JSON.stringify(file, null, 2), 'utf8');
  }

  private loadFromDir(dir: string): void {
    try {
      const raw = fs.readFileSync(path.join(dir, 'memory-v10.json'), 'utf8');
      const file = JSON.parse(raw) as V10MemoryFile;
      if (!file || file.version !== 1) return;
      // Nạp graph từ file (giữ nguyên id/status/validity).
      this.semantic.loadGraph(BiTemporalGraphV10.fromMemoryFile(file));
      this.episodic.load(file.episodes ?? []);
      this.procedural.load(file.procedures ?? []);
      for (const block of file.blocks ?? []) this.blocks.importBlock(block);
    } catch {
      // Chưa có file / file hỏng → bắt đầu rỗng.
    }
  }

  private quarantineFilePath(dir: string): string {
    return path.join(dir, 'quarantine-v10.json');
  }

  private loadQuarantineCount(dir: string): number {
    return this.loadQuarantineFromDisk(dir).filter((q) => q.status === 'pending').length;
  }

  private loadQuarantineFromDisk(dir: string = this.dir ?? ''): V10MemoryFile['quarantine'] {
    if (dir === '') return [];
    try {
      const raw = fs.readFileSync(this.quarantineFilePath(dir), 'utf8');
      const parsed = JSON.parse(raw) as { quarantine?: V10MemoryFile['quarantine'] };
      return Array.isArray(parsed.quarantine) ? parsed.quarantine : [];
    } catch {
      return [];
    }
  }

  private persistQuarantine(items: V10MemoryFile['quarantine']): void {
    if (!this.dir || items.length === 0) return;
    const existing = this.loadQuarantineFromDisk();
    this.saveQuarantine([...existing, ...items]);
  }
}

export { emptyV10MemoryFile };
