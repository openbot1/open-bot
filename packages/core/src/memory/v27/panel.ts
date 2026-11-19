/**
 * Memory v27 — panel view builder (v1.42, Doi T3).
 *
 * Panel la PROJECTION: store so huu du lieu, ham nay chi dong
 * goi snapshot hien thi cho renderer (giong panel v26): fact
 * nao, entity nao, episode nao, block bi-temporal nao, xung
 * dot thoi gian nao — component chi render, khong tu tinh toan.
 * Progressive disclosure: tong quan + canh bao truoc, chi tiet
 * fact/episode/timeline sau toggle mo rong.
 *
 * Chay 100% local, khong goi model/mang.
 */
import { truncateV27 } from './types';
import type { V27Store } from './store';

/** 1 dong fact trong panel. */
export interface V27PanelFactRow {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  status: string;
  validAt: string | null;
  invalidAt: string | null;
  createdAt: string;
  episodeId: string;
  entityNames: string[];
  confidence: number;
}

/** 1 dong entity trong panel. */
export interface V27PanelEntityRow {
  id: string;
  name: string;
  kind: string;
  aliases: string[];
  mentionCount: number;
  activeFactCount: number;
  boostWeight: number;
  lastMentionedAt: string;
}

/** 1 dong episode trong panel. */
export interface V27PanelEpisodeRow {
  id: string;
  source: string;
  agentId: string;
  at: string;
  preview: string;
  factsCount: number;
  entitiesCount: number;
  sentencesScanned: number;
}

/** 1 dong shared block bi-temporal trong panel. */
export interface V27PanelBlockRow {
  blockId: string;
  label: string;
  version: number;
  timelineEntries: number;
  syncEntries: number;
  attachedBotIds: string[];
  currentValuePreview: string;
  /** Gia tri block cach day 7 ngay (de thay doi theo thoi gian). */
  value7DaysAgoPreview: string;
}

/** 1 dong lich su cua 1 fact (thay doi theo thoi gian). */
export interface V27PanelHistoryRow {
  factId: string;
  subject: string;
  predicate: string;
  object: string;
  status: string;
  validAt: string | null;
  invalidAt: string | null;
  createdAt: string;
}

/** View day du cho MemoryV27Panel. */
export interface V27PanelView {
  /** Tom tat 1 dong. */
  summary: string;
  factsTotal: number;
  factsActive: number;
  factsSuperseded: number;
  factsExpired: number;
  entitiesTotal: number;
  entitiesByKind: Record<string, number>;
  episodesTotal: number;
  sharedBlocksTotal: number;
  timelineEntriesTotal: number;
  syncEntriesTotal: number;
  duplicatesSkipped: number;
  edgesClosedBySupersede: number;
  /** Canh bao (vd store co van de nhat quan). */
  warnings: string[];
  topFacts: V27PanelFactRow[];
  topEntities: V27PanelEntityRow[];
  recentEpisodes: V27PanelEpisodeRow[];
  blocks: V27PanelBlockRow[];
  /** Lich su thay doi cua fact duoc chon (neu co). */
  history: V27PanelHistoryRow[];
}

/** Input tuy chon khi build panel view. */
export interface V27PanelOptions {
  /** So fact hien (mac dinh 10). */
  factsLimit?: number;
  /** So entity hien (mac dinh 10). */
  entitiesLimit?: number;
  /** So episode hien (mac dinh 10). */
  episodesLimit?: number;
  /** Fact nao dang xem lich su (subject + predicate). */
  historySubject?: string;
  historyPredicate?: string;
  /** Thoi diem "7 ngay truoc" de so sanh block (mac dinh now). */
  nowMs?: number;
}

/** Build panel view tu store v27. */
export function buildV27PanelView(
  store: V27Store,
  opts: V27PanelOptions = {},
): V27PanelView {
  const stats = store.stats();
  const nowMs = opts.nowMs ?? Date.now();
  const factsLimit = opts.factsLimit ?? 10;
  const entitiesLimit = opts.entitiesLimit ?? 10;
  const episodesLimit = opts.episodesLimit ?? 10;
  const warnings = store.health();

  const topFacts: V27PanelFactRow[] = store.graph
    .queryCurrent({})
    .slice(0, factsLimit)
    .map((fact) => ({
      id: fact.id,
      subject: fact.subject,
      predicate: fact.predicate,
      object: fact.object,
      status: fact.status,
      validAt: fact.validAt,
      invalidAt: fact.invalidAt,
      createdAt: fact.createdAt,
      episodeId: fact.episodeId,
      entityNames: fact.entityIds
        .map((id) => store.entities.get(id)?.name)
        .filter((n): n is string => Boolean(n)),
      confidence: fact.confidence,
    }));

  const topEntities: V27PanelEntityRow[] = store.entities
    .list({ limit: entitiesLimit })
    .map((entity) => ({
      id: entity.id,
      name: entity.name,
      kind: entity.kind,
      aliases: [...entity.aliases],
      mentionCount: entity.mentionCount,
      activeFactCount: entity.activeFactCount,
      boostWeight: store.entities.boostFor(entity, nowMs).weight,
      lastMentionedAt: entity.lastMentionedAt,
    }));

  const recentEpisodes: V27PanelEpisodeRow[] = store.episodes
    .list({ limit: episodesLimit })
    .map((episode) => ({
      id: episode.id,
      source: episode.source,
      agentId: episode.agentId,
      at: episode.at,
      preview: truncateV27(episode.text, 120),
      factsCount: episode.factIds.length,
      entitiesCount: episode.entityIds.length,
      sentencesScanned: episode.sentencesScanned,
    }));

  const sevenDaysAgo = new Date(nowMs - 7 * 86400000).toISOString();
  const blocks: V27PanelBlockRow[] = store.v26.listBlocks()
    .filter((b) => store.blocks.isRegistered(b.id))
    .map((block) => {
      const value7 = store.blocks.valueAt(block.id, sevenDaysAgo);
      return {
        blockId: block.id,
        label: block.label,
        version: block.version,
        timelineEntries: store.blocks.timelineFor(block.id).length,
        syncEntries: store.blocks.syncLogFor(block.id).length,
        attachedBotIds: [...block.attachedBotIds],
        currentValuePreview: truncateV27(block.value, 120),
        value7DaysAgoPreview: value7.ok ? truncateV27(value7.value, 120) : '',
      };
    });

  let history: V27PanelHistoryRow[] = [];
  if (opts.historySubject && opts.historyPredicate) {
    history = store.graph
      .historyFor(opts.historySubject, opts.historyPredicate)
      .map((fact) => ({
        factId: fact.id,
        subject: fact.subject,
        predicate: fact.predicate,
        object: fact.object,
        status: fact.status,
        validAt: fact.validAt,
        invalidAt: fact.invalidAt,
        createdAt: fact.createdAt,
      }));
  }

  const summary =
    `memory v27: ${stats.factsTotal} fact (${stats.factsActive} active, ` +
    `${stats.factsSuperseded} superseded), ${stats.entitiesTotal} entity, ` +
    `${stats.episodesTotal} episode, ${stats.sharedBlocksTotal} block bi-temporal`;

  return {
    summary,
    factsTotal: stats.factsTotal,
    factsActive: stats.factsActive,
    factsSuperseded: stats.factsSuperseded,
    factsExpired: stats.factsExpired,
    entitiesTotal: stats.entitiesTotal,
    entitiesByKind: stats.entitiesByKind,
    episodesTotal: stats.episodesTotal,
    sharedBlocksTotal: stats.sharedBlocksTotal,
    timelineEntriesTotal: stats.timelineEntriesTotal,
    syncEntriesTotal: stats.syncEntriesTotal,
    duplicatesSkipped: stats.duplicatesSkipped,
    edgesClosedBySupersede: stats.edgesClosedBySupersede,
    warnings,
    topFacts,
    topEntities,
    recentEpisodes,
    blocks,
    history,
  };
}

/** View mau de panel render khi chua co store that (demo/offline). */
export function demoMemoryV27PanelView(): V27PanelView {
  return {
    summary: 'memory v27: 3 fact (2 active, 1 superseded), 2 entity, 1 episode, 1 block bi-temporal, 1 duplicate da bo, 1 edge da dong do supersede',
    factsTotal: 3,
    factsActive: 2,
    factsSuperseded: 1,
    factsExpired: 0,
    entitiesTotal: 2,
    entitiesByKind: { person: 1, place: 1 },
    episodesTotal: 1,
    sharedBlocksTotal: 1,
    timelineEntriesTotal: 2,
    syncEntriesTotal: 2,
    duplicatesSkipped: 1,
    edgesClosedBySupersede: 1,
    warnings: [],
    topFacts: [
      {
        id: 'edge_demo_1', subject: 'Huy', predicate: 'likes', object: 'tea',
        status: 'active', validAt: null, invalidAt: null,
        createdAt: '2026-11-19T00:01:00.000Z', episodeId: 'ep_demo_1',
        entityNames: ['Huy'], confidence: 0.88,
      },
      {
        id: 'edge_demo_2', subject: 'Huy', predicate: 'lives_in', object: 'Saigon',
        status: 'active', validAt: null, invalidAt: null,
        createdAt: '2026-11-19T00:00:00.000Z', episodeId: 'ep_demo_1',
        entityNames: ['Huy', 'Saigon'], confidence: 0.9,
      },
    ],
    topEntities: [
      {
        id: 'ent_demo_huy', name: 'Huy', kind: 'person', aliases: ['Huy Nguyen'],
        mentionCount: 12, activeFactCount: 2, boostWeight: 0.72,
        lastMentionedAt: '2026-11-19T00:01:00.000Z',
      },
      {
        id: 'ent_demo_sg', name: 'Saigon', kind: 'place', aliases: [],
        mentionCount: 4, activeFactCount: 1, boostWeight: 0.54,
        lastMentionedAt: '2026-11-19T00:00:00.000Z',
      },
    ],
    recentEpisodes: [
      {
        id: 'ep_demo_1', source: 'chat', agentId: 'bot-a',
        at: '2026-11-19T00:00:00.000Z',
        preview: 'Huy likes tea. Huy lives in Saigon.',
        factsCount: 2, entitiesCount: 2, sentencesScanned: 2,
      },
    ],
    blocks: [
      {
        blockId: 'blk_demo_human', label: 'human', version: 2,
        timelineEntries: 2, syncEntries: 2, attachedBotIds: ['bot-a', 'bot-b'],
        currentValuePreview: '## Ten\nHuy\n\n## Thich\nCa phe',
        value7DaysAgoPreview: '## Ten\nHuy',
      },
    ],
    history: [
      {
        factId: 'edge_demo_0', subject: 'Huy', predicate: 'likes', object: 'coffee',
        status: 'superseded', validAt: null, invalidAt: '2026-11-19T00:01:00.000Z',
        createdAt: '2026-11-19T00:00:00.000Z',
      },
      {
        factId: 'edge_demo_1', subject: 'Huy', predicate: 'likes', object: 'tea',
        status: 'active', validAt: null, invalidAt: null,
        createdAt: '2026-11-19T00:01:00.000Z',
      },
    ],
  };
}
