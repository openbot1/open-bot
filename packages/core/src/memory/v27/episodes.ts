/**
 * Memory v27 — episode store + provenance (v1.42, Doi T3).
 *
 * Y tuong hoc tu Graphiti (survey v142 muc 3): episode giu
 * nguyen lam provenance — moi fact truy duoc ve episode goc.
 * Tu thiet ke lai hoan toan cho open-bot.
 *
 * Quy tac:
 *   - Episode la bang chung goc, KHONG BAO GIO sua/xoa sau khi
 *     tao. Muon sua thi tao episode moi (add-only).
 *   - Moi fact ghi episodeId + sourceText (cau goc) + snapshot
 *     episode text ngan, de truy provenance khong can join.
 *   - Provenance chain: fact -> episode -> (source, agent, at,
 *     scope) + cac fact cung episode (fact anh em).
 *   - Episode co the "het han" theo nghia luu tru (archived flag)
 *     nhung text + fact van con — archive khong phai delete.
 */
import {
  dayKeyV27,
  errV27,
  isoAtV27,
  makeV27Id,
  normalizeTextV27,
  okV27,
  truncateV27,
  V27_LIMITS,
  type V27Episode,
  type V27EpisodeFilter,
  type V27EpisodeInput,
  type V27Result,
} from './types';
import { makeV25Scope, type V25FactEdge } from '../v25/types';

/** 1 muc provenance day du cua 1 fact. */
export interface V27Provenance {
  /** Fact dang truy. */
  fact: V25FactEdge;
  /** Episode goc sinh ra fact (null neu fact khong co episode). */
  episode: V27Episode | null;
  /** Doan text goc lam chung cu (cau trich xuat). */
  sourceText: string;
  /** Episode text day du (cat ngan 2000 ky tu). */
  episodeText: string;
  /** Cac fact anh em cung episode (tru fact dang truy). */
  siblingFacts: V25FactEdge[];
  /** Chuoi truy: "fact -> episode <id> (source, agent, at)". */
  chain: string;
}

/** Store episode: map id + chi muc theo ngay + theo agent. */
export class V27EpisodeStore {
  private readonly episodes = new Map<string, V27Episode>();

  get size(): number {
    return this.episodes.size;
  }

  /**
   * Tao episode moi. Text rong thi tu choi; text qua dai thi
   * cat o maxEpisodeChars (ghi ro da cat trong episode? text
   * cat van la text goc — khong them flag gia).
   */
  create(
    input: V27EpisodeInput,
    opts: { nowMs?: number } = {},
  ): V27Result<V27Episode> {
    const text = input.text.trim();
    if (!text) return errV27('Episode text khong duoc rong.');
    if (this.episodes.size >= V27_LIMITS.maxEpisodes) {
      return errV27(`Kho episode da day (${V27_LIMITS.maxEpisodes}) — archive truoc khi them.`);
    }
    const nowMs = opts.nowMs ?? Date.now();
    const nowIso = isoAtV27(nowMs);
    let at = nowIso;
    if (input.at) {
      const parsed = new Date(input.at);
      if (Number.isNaN(parsed.getTime())) {
        return errV27(`Thoi diem episode "${input.at}" khong phai ISO date hop le.`);
      }
      at = parsed.toISOString();
    }
    const episode: V27Episode = {
      id: makeV27Id('ep'),
      text: truncateV27(text, V27_LIMITS.maxEpisodeChars),
      source: input.source ?? 'chat',
      agentId: input.agentId ?? '',
      userId: input.userId ?? '',
      at,
      createdAt: nowIso,
      scope: makeV25Scope(input.scope ?? {}),
      factIds: [],
      entityIds: [],
      sentencesScanned: 0,
      candidatesExtracted: 0,
    };
    this.episodes.set(episode.id, episode);
    return okV27(episode);
  }

  /** Lay episode theo id. */
  get(id: string): V27Episode | undefined {
    return this.episodes.get(id);
  }

  /** Ghi nhan ket qua trich xuat vao episode (fact/entity ids). */
  recordExtraction(
    episodeId: string,
    opts: {
      factIds: string[];
      entityIds: string[];
      sentencesScanned: number;
      candidatesExtracted: number;
    },
  ): V27Result<V27Episode> {
    const episode = this.episodes.get(episodeId);
    if (!episode) return errV27(`Khong co episode "${episodeId}".`);
    episode.factIds = [...new Set([...episode.factIds, ...opts.factIds])];
    episode.entityIds = [...new Set([...episode.entityIds, ...opts.entityIds])];
    episode.sentencesScanned = opts.sentencesScanned;
    episode.candidatesExtracted = opts.candidatesExtracted;
    return okV27(episode);
  }

  /** Liet ke episode theo bo loc (moi nhat truoc). */
  list(filter: V27EpisodeFilter = {}): V27Episode[] {
    const out: V27Episode[] = [];
    for (const episode of this.episodes.values()) {
      if (filter.scope) {
        const q = filter.scope;
        if (q.userId && episode.scope.userId !== q.userId) continue;
        if (q.agentId && episode.scope.agentId !== q.agentId) continue;
        if (q.appId && episode.scope.appId !== q.appId) continue;
      }
      if (filter.source && episode.source !== filter.source) continue;
      if (filter.agentId !== undefined && episode.agentId !== filter.agentId) continue;
      if (filter.userId !== undefined && episode.userId !== filter.userId) continue;
      const day = dayKeyV27(episode.at) ?? '';
      if (filter.fromDay && day < filter.fromDay) continue;
      if (filter.toDay && day > filter.toDay) continue;
      if (filter.textContains !== undefined) {
        if (!normalizeTextV27(episode.text).includes(normalizeTextV27(filter.textContains))) continue;
      }
      out.push(episode);
    }
    out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    if (filter.limit !== undefined) return out.slice(0, Math.max(0, filter.limit));
    return out;
  }

  /** Episode cua 1 ngay (day key YYYY-MM-DD). */
  listForDay(dayKey: string, filter: Omit<V27EpisodeFilter, 'fromDay' | 'toDay'> = {}): V27Episode[] {
    return this.list({ ...filter, fromDay: dayKey, toDay: dayKey });
  }

  /** Dem episode theo source. */
  countBySource(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const episode of this.episodes.values()) {
      out[episode.source] = (out[episode.source] ?? 0) + 1;
    }
    return out;
  }

  /**
   * Provenance day du cua 1 fact: fact -> episode goc + fact
   * anh em cung episode. Can ham lay fact theo id (truyen tu
   * graph) de khong phu thuoc vong tron.
   */
  provenance(
    fact: V25FactEdge,
    getFactById: (id: string) => V25FactEdge | undefined,
  ): V27Provenance {
    const episode = fact.episodeId ? this.episodes.get(fact.episodeId) : undefined;
    const siblingFacts: V25FactEdge[] = [];
    if (episode) {
      for (const fid of episode.factIds) {
        if (fid === fact.id) continue;
        const sibling = getFactById(fid);
        if (sibling) siblingFacts.push(sibling);
      }
    }
    const chain = episode
      ? `fact ${fact.id} -> episode ${episode.id} (${episode.source}, agent "${episode.agentId || 'system'}", at ${episode.at})`
      : `fact ${fact.id} -> (khong co episode)`;
    return {
      fact,
      episode: episode ?? null,
      sourceText: fact.sourceText,
      episodeText: episode ? truncateV27(episode.text, 2000) : '',
      siblingFacts,
      chain,
    };
  }

  /**
   * Cac episode chua fact nao link toi entity nay (de audit
   * entity co xuat hien o dau).
   */
  episodesForEntity(entityId: string): V27Episode[] {
    const out: V27Episode[] = [];
    for (const episode of this.episodes.values()) {
      if (episode.entityIds.includes(entityId)) out.push(episode);
    }
    out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return out;
  }

  toJSON(): V27Episode[] {
    return [...this.episodes.values()];
  }

  static fromJSON(data: unknown): V27EpisodeStore {
    const store = new V27EpisodeStore();
    if (!Array.isArray(data)) return store;
    for (const raw of data as V27Episode[]) {
      if (!raw || typeof raw.id !== 'string') continue;
      store.episodes.set(raw.id, {
        ...raw,
        factIds: Array.isArray(raw.factIds) ? raw.factIds : [],
        entityIds: Array.isArray(raw.entityIds) ? raw.entityIds : [],
      });
    }
    return store;
  }
}
