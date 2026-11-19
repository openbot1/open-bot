/**
 * Memory v27 — store (v1.42, Doi T3).
 *
 * Diem vao duy nhat cho pipeline + tools: gom graph bi-temporal
 * add-only + entity registry + episode store + shared block
 * bi-temporal (tren nen V26Store) + bo dem add-only.
 *
 * Luu/load JSON xuong thu muc workspace (ghi atomic qua file tam
 * + rename, ke thua pattern v26). Khong co ham xoa vat ly nao:
 * fact chi dong hieu luc, episode chi them, entity chi gop.
 *
 * Chay 100% local, chi dung node:fs/node:path.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { V26Store } from '../v26/store';
import { V27EntityRegistry } from './entities';
import { V27EpisodeStore } from './episodes';
import { V27Graph } from './graph';
import { V27SharedBlockLayer } from './sharedBlocks';
import {
  errV27,
  isoAtV27,
  okV27,
  V27_LIMITS,
  type V27ExtractorConfig,
  type V27Stats,
  type V27StoreConfig,
  type V27StoreSnapshot,
  type V27Result,
} from './types';

/** Ten file luu store trong workspace dir. */
export const V27_STORE_FILENAME = 'memory-v27-store.json';

/** Phien ban dinh dang snapshot v27. */
export const V27_SNAPSHOT_VERSION = '27.0.0';

/** Store memory v27 — diem vao duy nhat cho pipeline + tools. */
export class V27Store {
  /** Store v26 ben duoi (shared block goc + registry + audit). */
  readonly v26: V26Store;
  readonly graph: V27Graph;
  readonly entities: V27EntityRegistry;
  readonly episodes: V27EpisodeStore;
  readonly blocks: V27SharedBlockLayer;
  readonly extractorConfig: V27ExtractorConfig;
  private duplicatesSkipped = 0;
  private edgesClosedBySupersede = 0;
  private candidatesExtractedTotal = 0;

  constructor(opts: V27StoreConfig & { v26?: V26Store } = {}) {
    this.v26 = opts.v26 ?? new V26Store();
    this.graph = new V27Graph();
    this.entities = new V27EntityRegistry({
      fuzzyThreshold: opts.extractor?.fuzzyThreshold,
    });
    this.episodes = new V27EpisodeStore();
    this.blocks = new V27SharedBlockLayer(this.v26);
    this.extractorConfig = {
      minSentenceTokens: 3,
      minSentenceChars: 8,
      fuzzyThreshold: 0.6,
      strongPatternConfidence: 0.9,
      weakPatternConfidence: 0.6,
      ...(opts.extractor ?? {}),
    };
  }

  /** So fact dang giu (ke ca da dong). */
  get factsTotal(): number {
    return this.graph.size;
  }

  /** So entity dang giu. */
  get entitiesTotal(): number {
    return this.entities.size;
  }

  /** So episode dang giu. */
  get episodesTotal(): number {
    return this.episodes.size;
  }

  /** Ghi nhan bo dem add-only (goi tu pipeline khi ingest). */
  recordIngestCounters(opts: {
    duplicates: number;
    closed: number;
    candidates: number;
  }): void {
    this.duplicatesSkipped += opts.duplicates;
    this.edgesClosedBySupersede += opts.closed;
    this.candidatesExtractedTotal += opts.candidates;
  }

  /** Thong ke tong hop. */
  stats(): V27Stats {
    const byStatus = this.graph.countByStatus();
    return {
      factsTotal: this.graph.size,
      factsActive: byStatus.active,
      factsSuperseded: byStatus.superseded,
      factsExpired: byStatus.expired,
      entitiesTotal: this.entities.size,
      entitiesByKind: this.entities.countByKind(),
      episodesTotal: this.episodes.size,
      episodesBySource: this.episodes.countBySource(),
      sharedBlocksTotal: this.blocks.registeredCount,
      timelineEntriesTotal: this.blocks.timelineTotal,
      syncEntriesTotal: this.blocks.syncTotal,
      duplicatesSkipped: this.duplicatesSkipped,
      edgesClosedBySupersede: this.edgesClosedBySupersede,
      candidatesExtractedTotal: this.candidatesExtractedTotal,
    };
  }

  /** Kiem tra tinh nhat quan toan store (graph + episode + block). */
  health(): string[] {
    const problems = this.graph.validate();
    // Episode nao co factIds thi fact phai con trong graph.
    for (const episode of this.episodes.list({})) {
      for (const factId of episode.factIds) {
        if (!this.graph.get(factId)) {
          problems.push(`episode ${episode.id}: fact "${factId}" khong con trong graph.`);
        }
      }
    }
    // Timeline entry nao cung phai tro ve block v26 con ton tai.
    const blockIds = new Set(this.v26.listBlocks().map((b) => b.id));
    const snap = this.blocks.toJSON();
    for (const entry of snap.timeline) {
      if (!blockIds.has(entry.blockId)) {
        problems.push(`timeline: block "${entry.blockId}" khong con trong store v26.`);
      }
    }
    return problems;
  }

  /** Snapshot JSON cua toan bo store (export). */
  snapshot(): V27StoreSnapshot {
    return {
      version: V27_SNAPSHOT_VERSION,
      exportedAt: isoAtV27(Date.now()),
      facts: this.graph.toJSON().facts,
      entities: this.entities.toJSON(),
      episodes: this.episodes.toJSON(),
      timeline: this.blocks.toJSON().timeline,
      syncLog: this.blocks.toJSON().syncLog,
      counters: {
        duplicatesSkipped: this.duplicatesSkipped,
        edgesClosedBySupersede: this.edgesClosedBySupersede,
        candidatesExtractedTotal: this.candidatesExtractedTotal,
      },
    };
  }

  /** Khoi phuc store tu snapshot (add-only: chi them, khong ghi de store cu). */
  static fromSnapshot(data: unknown): V27Store {
    const store = new V27Store();
    if (!data || typeof data !== 'object') return store;
    const raw = data as V27StoreSnapshot & {
      factEntities?: unknown;
      factEpisodeText?: unknown;
      registeredAt?: unknown;
    };
    if (Array.isArray(raw.facts)) {
      const graph = V27Graph.fromJSON({
        facts: raw.facts,
        factEntities: raw.factEntities ?? [],
        factEpisodeText: raw.factEpisodeText ?? [],
      });
      (store as { graph: V27Graph }).graph = graph;
    }
    if (Array.isArray(raw.entities)) {
      (store as { entities: V27EntityRegistry }).entities =
        V27EntityRegistry.fromJSON(raw.entities);
    }
    if (Array.isArray(raw.episodes)) {
      (store as { episodes: V27EpisodeStore }).episodes =
        V27EpisodeStore.fromJSON(raw.episodes);
    }
    if (Array.isArray(raw.timeline) || Array.isArray(raw.syncLog)) {
      (store as { blocks: V27SharedBlockLayer }).blocks =
        V27SharedBlockLayer.fromJSON(
          {
            timeline: raw.timeline ?? [],
            syncLog: raw.syncLog ?? [],
            registeredAt: raw.registeredAt ?? [],
          },
          store.v26,
        );
    }
    if (raw.counters) {
      store.duplicatesSkipped = raw.counters.duplicatesSkipped ?? 0;
      store.edgesClosedBySupersede = raw.counters.edgesClosedBySupersede ?? 0;
      store.candidatesExtractedTotal = raw.counters.candidatesExtractedTotal ?? 0;
    }
    return store;
  }

  /**
   * Nhap snapshot vao store HIEN CO (add-only): fact/entity/
   * episode moi duoc them vao, cai da co thi giu nguyen.
   * Tra so luong moi them duoc.
   */
  importSnapshot(data: unknown): V27Result<{
    factsAdded: number;
    entitiesAdded: number;
    episodesAdded: number;
  }> {
    if (!data || typeof data !== 'object') {
      return errV27('Snapshot khong phai object JSON hop le.');
    }
    const raw = data as V27StoreSnapshot;
    let factsAdded = 0;
    let entitiesAdded = 0;
    let episodesAdded = 0;
    if (Array.isArray(raw.facts)) {
      const fresh = raw.facts.filter((e) => e && typeof e.id === 'string' && !this.graph.get(e.id));
      factsAdded = fresh.length;
      if (fresh.length > 0) {
        // Ghi lai toan bo edge (add-only: them cai moi, khong xoa cai cu).
        const merged = V27Graph.fromJSON({
          facts: [...this.graph.toJSON().facts, ...fresh],
          factEntities: this.graph.toJSON().factEntities,
          factEpisodeText: this.graph.toJSON().factEpisodeText,
        });
        (this as { graph: V27Graph }).graph = merged;
      }
    }
    if (Array.isArray(raw.entities)) {
      for (const entity of raw.entities) {
        if (!entity || typeof entity.id !== 'string') continue;
        if (this.entities.get(entity.id)) continue;
        const created = this.entities.register(
          { name: entity.name, kind: entity.kind, aliases: entity.aliases, scope: entity.scope },
        );
        if (created.ok) entitiesAdded++;
      }
    }
    if (Array.isArray(raw.episodes)) {
      for (const episode of raw.episodes) {
        if (!episode || typeof episode.id !== 'string') continue;
        if (this.episodes.get(episode.id)) continue;
        const created = this.episodes.create({
          text: episode.text,
          source: episode.source,
          agentId: episode.agentId,
          userId: episode.userId,
          at: episode.at,
          scope: episode.scope,
        });
        if (created.ok) episodesAdded++;
      }
    }
    return okV27({ factsAdded, entitiesAdded, episodesAdded });
  }

  /** Luu store xuong thu muc (ghi atomic qua file tam + rename). */
  saveToDir(dir: string): V27Result<string> {
    try {
      mkdirSync(dir, { recursive: true });
      const path = join(dir, V27_STORE_FILENAME);
      const tmp = `${path}.tmp`;
      const payload = JSON.stringify(
        {
          ...this.snapshot(),
          factEntities: this.graph.toJSON().factEntities,
          factEpisodeText: this.graph.toJSON().factEpisodeText,
          registeredAt: this.blocks.toJSON().registeredAt,
        },
        null,
        2,
      );
      writeFileSync(tmp, payload, 'utf8');
      renameSync(tmp, path);
      return okV27(path);
    } catch (e) {
      return errV27(`Khong luu duoc store v27: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Tai store tu thu muc (khong co file thi tra store rong). */
  static loadFromDir(dir: string): V27Result<V27Store> {
    try {
      const path = join(dir, V27_STORE_FILENAME);
      if (!existsSync(path)) return okV27(new V27Store());
      const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      return okV27(V27Store.fromSnapshot(raw));
    } catch (e) {
      return errV27(`Khong tai duoc store v27: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Gioi han cau hinh (de test/panel hien). */
  get limits(): typeof V27_LIMITS {
    return V27_LIMITS;
  }
}
