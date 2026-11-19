/**
 * Memory v27 — pipeline (v1.42, Doi T3).
 *
 * Dieu phoi cac thanh phan v27 thanh 1 luong dung cho tool:
 *   ingestEpisode: episode moi -> single-pass extract (1 lan)
 *     -> link entity LUC GHI -> add fact vao graph (add-only,
 *     supersede dong edge cu) -> ghi provenance vao episode
 *     -> sync fact moi vao shared block da dang ky (neu co).
 *   search: hybrid search (BM25 + lexical proxy + entity boost
 *     + traversal + recency) + asOf time-travel.
 *   timeTravel: fact dung tai X + gia tri block tai X.
 *   provenance: fact -> episode goc + fact anh em.
 *   revalidate: kiem tra tinh nhat quan toan store.
 *
 * Chay 100% local, khong goi model/mang.
 */
import { extractMentionsV27, extractTextV27 } from './extraction';
import { searchEpisodesV27, searchV27 } from './search';
import type { V27Provenance } from './episodes';
import type { V27Store } from './store';
import {
  errV27,
  okV27,
  type V27AddFactResult,
  type V27Episode,
  type V27IngestResult,
  type V27Result,
  type V27SearchInput,
  type V27SearchResult,
  type V27TimeTravelResult,
} from './types';
import type { V27EpisodeInput } from './types';
import { makeV25Scope, type V25FactEdge, type V25Scope } from '../v25/types';

/** Pipeline memory v27 — diem vao duy nhat cho tools. */
export class V27Pipeline {
  constructor(private readonly store: V27Store) {}

  /** Store dang dung (de tool truy cap truc tiep khi can). */
  getStore(): V27Store {
    return this.store;
  }

  /**
   * Ingest 1 episode: toan bo luong trong 1 goi.
   *
   * 1. Tao episode (text goc, khong sua).
   * 2. Single-pass extract: 1 lan quet, candidate ADD-only.
   * 3. Link entity LUC GHI: mention trong moi cau co candidate
   *    duoc link ve entity chuan (tao moi neu chua co).
   * 4. Add fact vao graph: trung -> bo qua; mau thuan -> ADD
   *    moi + DONG cu; con lai -> ADD moi.
   * 5. Ghi provenance: episode.factIds + entityIds.
   * 6. Sync vao shared block: neu co block da dang ky lop
   *    bi-temporal trong cung scope, noi dong fact moi vao
   *    block (1 block nhan nhieu nhat 5 dong/lan ingest de
   *    khong lam block phong to).
   */
  ingestEpisode(
    input: V27EpisodeInput,
    opts: {
      nowMs?: number;
      by?: string;
      /** Label block se nhan fact moi ('' = khong sync block). */
      syncBlockLabel?: string;
      /** Scope mac dinh cho fact moi. */
      scope?: Partial<V25Scope>;
    } = {},
  ): V27Result<V27IngestResult> {
    const nowMs = opts.nowMs ?? Date.now();
    const scope = makeV25Scope({ ...(opts.scope ?? {}), ...(input.scope ?? {}) });
    const created = this.store.episodes.create(input, { nowMs });
    if (!created.ok) return created as unknown as V27Result<V27IngestResult>;
    const episode: V27Episode = created.value;

    // Pass trich xuat duy nhat — doi chieu edge active hien co.
    const extraction = extractTextV27(episode.text, {
      config: this.store.extractorConfig,
      existingActive: this.store.graph.queryCurrent({ scope }),
      maxFacts: 200,
    });

    // Link entity LUC GHI: mention trong cau co candidate.
    const entityIds = new Set<string>();
    for (const candidate of extraction.candidates) {
      const mentions = extractMentionsV27(candidate.sourceSentence);
      // Subject/object cung la mention (vd ten nguoi viet hoa).
      for (const extra of [candidate.subject, candidate.object]) {
        if (/^[A-ZÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚÝĂÂĐÊÔƠƯ]/u.test(extra.trim())) mentions.push(extra.trim());
      }
      const links = this.store.entities.linkMentions(mentions, {
        sentence: candidate.sourceSentence,
        scope,
        nowMs,
      });
      extraction.entityLinks.push(...links);
      for (const link of links) entityIds.add(link.entityId);
      candidate.entityIds = links.map((l) => l.entityId);
    }

    // Add fact vao graph (add-only).
    const addedFacts: V27AddFactResult[] = [];
    let factsAdded = 0;
    let edgesClosed = 0;
    for (const candidate of extraction.candidates) {
      const added = this.store.graph.addFact(candidate, {
        episodeId: episode.id,
        episodeText: episode.text,
        scope,
        nowMs,
        by: opts.by ?? input.agentId ?? 'system',
      });
      if (!added.ok) continue;
      addedFacts.push(added.value);
      if (added.value.added) {
        factsAdded++;
        edgesClosed += added.value.closed.length;
        // Cap nhat so fact active cua entity da link.
        for (const eid of candidate.entityIds) {
          this.store.entities.bumpFactCount(eid, 1);
        }
        for (const closed of added.value.closed) {
          const closedFact = this.store.graph.get(closed.id);
          for (const eid of closedFact?.entityIds ?? []) {
            this.store.entities.bumpFactCount(eid, -1);
          }
        }
      }
    }

    // Ghi provenance vao episode.
    const factIds = addedFacts.filter((a) => a.added).map((a) => a.edge.id);
    this.store.episodes.recordExtraction(episode.id, {
      factIds,
      entityIds: [...entityIds],
      sentencesScanned: extraction.sentencesScanned,
      candidatesExtracted: extraction.candidates.length,
    });

    // Bo dem add-only.
    this.store.recordIngestCounters({
      duplicates: extraction.duplicates,
      closed: edgesClosed,
      candidates: extraction.candidates.length,
    });

    // Sync fact moi vao shared block (neu chi dinh).
    const syncedBlocks: string[] = [];
    if (opts.syncBlockLabel) {
      const block = this.store.v26
        .listBlocks()
        .find((b) => b.label === opts.syncBlockLabel);
      if (block && this.store.blocks.isRegistered(block.id)) {
        const lines = addedFacts
          .filter((a) => a.added)
          .slice(0, 5)
          .map((a) => `${a.edge.subject} ${a.edge.predicate} ${a.edge.object}`);
        for (const line of lines) {
          const res = this.store.blocks.appendFactToBlock(
            block.id,
            line,
            opts.by ?? input.agentId ?? 'system',
            { nowMs, factIds },
          );
          if (res.ok) syncedBlocks.push(block.label);
        }
      }
    }

    return okV27({
      episode,
      extraction,
      addedFacts,
      factsAdded,
      edgesClosed,
      syncedBlocks: [...new Set(syncedBlocks)],
    });
  }

  /**
   * Trich xuat kho (dry-run): chay single-pass nhung KHONG ghi
   * episode/fact/entity — de xem truoc fact nao se duoc them,
   * fact nao trung, fact nao supersede edge cu.
   */
  extractDryRun(
    text: string,
    opts: { scope?: Partial<V25Scope>; nowMs?: number } = {},
  ): V27Result<ReturnType<typeof extractTextV27>> {
    const trimmed = text.trim();
    if (!trimmed) return errV27('Text trich xuat khong duoc rong.');
    const scope = makeV25Scope(opts.scope ?? {});
    const extraction = extractTextV27(trimmed, {
      config: this.store.extractorConfig,
      existingActive: this.store.graph.queryCurrent({ scope }),
      maxFacts: 200,
    });
    return okV27(extraction);
  }

  /** Hybrid search (uy quyen sang searchV27). */
  search(input: V27SearchInput, opts: { nowMs?: number } = {}): V27Result<V27SearchResult> {
    return searchV27(this.store.graph, this.store.entities, input, opts);
  }

  /** Search episode theo noi dung. */
  searchEpisodes(
    query: string,
    opts: { limit?: number; nowMs?: number } = {},
  ): V27Result<{ episodeId: string; score: number; snippet: string }[]> {
    return searchEpisodesV27(this.store.episodes, query, opts);
  }

  /**
   * Time-travel: fact dung tai X + gia tri cac block tai X.
   * Fact loc chat (valid time + transaction time); block lay
   * valueAt(X) tren timeline bi-temporal.
   */
  timeTravel(
    at: string,
    opts: { blockLabels?: string[]; scope?: Partial<V25Scope> } = {},
  ): V27Result<V27TimeTravelResult> {
    const factsRes = this.store.graph.queryAt(at, {
      ...(opts.scope ? { scope: makeV25Scope(opts.scope) } : {}),
    });
    if (!factsRes.ok) return factsRes as unknown as V27Result<V27TimeTravelResult>;
    const blockValues: Record<string, string> = {};
    const labels = opts.blockLabels ?? this.store.v26.listBlocks().map((b) => b.label);
    for (const label of labels) {
      const block = this.store.v26.listBlocks().find((b) => b.label === label);
      if (!block) continue;
      if (!this.store.blocks.isRegistered(block.id)) {
        // Block chua dang ky lop bi-temporal: lay value hien tai
        // neu block da ton tai truoc X, khong thi ''.
        blockValues[label] = Date.parse(block.createdAt) <= Date.parse(at) ? block.value : '';
        continue;
      }
      const valueRes = this.store.blocks.valueAt(block.id, at);
      if (valueRes.ok) blockValues[label] = valueRes.value;
    }
    return okV27({
      at,
      facts: factsRes.value,
      blockValues,
      factsAtTime: factsRes.value.length,
    });
  }

  /** Provenance day du cua 1 fact: fact -> episode goc. */
  provenance(factId: string): V27Result<V27Provenance> {
    const fact = this.store.graph.get(factId);
    if (!fact) return errV27(`Khong co fact "${factId}".`);
    const prov = this.store.episodes.provenance(fact, (id) => {
      const f = this.store.graph.get(id);
      return f ? (f as V25FactEdge) : undefined;
    });
    return okV27(prov);
  }

  /** Lich su thay doi cua 1 cap (subject, predicate) theo thoi gian. */
  factHistory(
    subject: string,
    predicate: string,
    scope?: V25Scope,
  ): V27Result<V25FactEdge[]> {
    if (!subject.trim() || !predicate.trim()) {
      return errV27('subject/predicate khong duoc rong.');
    }
    return okV27(this.store.graph.historyFor(subject, predicate, scope));
  }

  /** Kiem tra tinh nhat quan toan store. */
  revalidate(): { ok: boolean; problems: string[] } {
    const problems = this.store.health();
    return { ok: problems.length === 0, problems };
  }

  /** Tom tat 1 dong ve store (de hien thi/panel). */
  summary(nowMs: number = Date.now()): string {
    const stats = this.store.stats();
    void nowMs;
    return (
      `memory v27: ${stats.factsTotal} fact (${stats.factsActive} active, ` +
      `${stats.factsSuperseded} superseded, ${stats.factsExpired} expired), ` +
      `${stats.entitiesTotal} entity, ${stats.episodesTotal} episode, ` +
      `${stats.sharedBlocksTotal} shared block bi-temporal, ` +
      `${stats.duplicatesSkipped} duplicate da bo, ${stats.edgesClosedBySupersede} edge da dong do supersede`
    );
  }
}
