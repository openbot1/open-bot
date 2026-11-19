import { useMemo, useState } from 'react';
import { useT } from '../i18n/useT';
import type { V27PanelView } from '@open-bot/core';

/**
 * Demo view mirrored locally (v1.44 fix round 4) — the renderer must
 * never value-import @open-bot/core (v1.07 CJS crash: vite inlines the
 * CJS bundle verbatim and the renderer throws at startup). Same data
 * as core `demoMemoryV27PanelView()` in `packages/core/src/memory/v27/panel.ts`;
 * only used when the host hands no snapshot (preview without a store).
 */
function demoMemoryV27PanelViewLocal(): V27PanelView {
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

/**
 * Memory v27 panel (v1.42, Doi T3) — add-only bi-temporal memory.
 *
 * The panel is a PROJECTION: the core store owns facts, entities,
 * episodes and bi-temporal shared blocks; this component only
 * renders the snapshot the host hands it (see core
 * `buildV27PanelView` / `V27PanelView`). Progressive disclosure:
 * summary + warnings first, fact/entity/episode/block rows behind
 * expand toggles. A superseded fact is shown next to its
 * replacement (history section) because the change over time is
 * the thing the user most needs to see — nothing is ever deleted.
 */

type StatusFilter = 'all' | 'active' | 'superseded' | 'expired';

export default function MemoryV27Panel({ panel }: { panel?: V27PanelView }) {
  const t = useT();
  const view = useMemo(() => panel ?? demoMemoryV27PanelViewLocal(), [panel]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [showFacts, setShowFacts] = useState(true);
  const [showEntities, setShowEntities] = useState(true);
  const [showEpisodes, setShowEpisodes] = useState(false);
  const [showBlocks, setShowBlocks] = useState(true);
  const [showHistory, setShowHistory] = useState(false);

  const visibleFacts = view.topFacts.filter(
    (f) => statusFilter === 'all' || f.status === statusFilter,
  );

  return (
    <section aria-label={t('memoryV27.title')} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <header>
        <h2 style={{ margin: 0 }}>{t('memoryV27.title')}</h2>
        <p style={{ margin: '4px 0 0', fontSize: 13 }}>{view.summary}</p>
        <p style={{ margin: '4px 0 0', fontSize: 12, opacity: 0.8 }}>{t('memoryV27.intro')}</p>
      </header>

      <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'repeat(4, auto)', gap: '4px 16px', fontSize: 13 }}>
        <dt>{t('memoryV27.facts')}</dt><dd style={{ margin: 0 }}>{view.factsTotal}</dd>
        <dt>{t('memoryV27.current')}</dt><dd style={{ margin: 0 }}>{view.factsActive}</dd>
        <dt>{t('memoryV27.superseded')}</dt><dd style={{ margin: 0 }}>{view.factsSuperseded}</dd>
        <dt>{t('memoryV27.expired')}</dt><dd style={{ margin: 0 }}>{view.factsExpired}</dd>
        <dt>{t('memoryV27.entities')}</dt><dd style={{ margin: 0 }}>{view.entitiesTotal}</dd>
        <dt>{t('memoryV27.episodes')}</dt><dd style={{ margin: 0 }}>{view.episodesTotal}</dd>
        <dt>{t('memoryV27.blocks')}</dt><dd style={{ margin: 0 }}>{view.sharedBlocksTotal}</dd>
        <dt>{t('memoryV27.timeline')}</dt><dd style={{ margin: 0 }}>{view.timelineEntriesTotal}</dd>
        <dt>{t('memoryV27.syncLog')}</dt><dd style={{ margin: 0 }}>{view.syncEntriesTotal}</dd>
        <dt>{t('memoryV27.duplicate')}</dt><dd style={{ margin: 0 }}>{view.duplicatesSkipped}</dd>
        <dt>{t('memoryV27.edgeClosed')}</dt><dd style={{ margin: 0 }}>{view.edgesClosedBySupersede}</dd>
      </dl>

      <p style={{ margin: 0, fontSize: 12, opacity: 0.8 }}>{t('memoryV27.embeddingProxyNote')}</p>

      {view.warnings.length > 0 ? (
        <article style={{ border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: '8px 10px' }}>
          <strong>{t('memoryV27.warnings')}</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 16, fontSize: 13 }}>
            {view.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </article>
      ) : null}

      <article style={{ border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: '8px 10px' }}>
        <button type="button" onClick={() => setShowFacts((v) => !v)} style={{ fontWeight: 600, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
          {t('memoryV27.topFacts')} ({visibleFacts.length})
        </button>
        {showFacts ? (
          <>
            <label style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
              {t('memoryV27.current')}:{' '}
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}>
                <option value="all">all</option>
                <option value="active">{t('memoryV27.active')}</option>
                <option value="superseded">{t('memoryV27.superseded')}</option>
                <option value="expired">{t('memoryV27.expired')}</option>
              </select>
            </label>
            <ul style={{ margin: '6px 0 0', paddingLeft: 16, fontSize: 13 }}>
              {visibleFacts.map((f) => (
                <li key={f.id}>
                  {f.subject} {f.predicate} {f.object} [{f.status}]
                  {f.entityNames.length > 0 ? <span style={{ opacity: 0.75 }}> — {f.entityNames.join(', ')}</span> : null}
                </li>
              ))}
              {visibleFacts.length === 0 ? <li>{t('memoryV27.noResults')}</li> : null}
            </ul>
          </>
        ) : null}
      </article>

      <article style={{ border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: '8px 10px' }}>
        <button type="button" onClick={() => setShowEntities((v) => !v)} style={{ fontWeight: 600, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
          {t('memoryV27.topEntities')} ({view.topEntities.length})
        </button>
        {showEntities ? (
          <ul style={{ margin: '6px 0 0', paddingLeft: 16, fontSize: 13 }}>
            {view.topEntities.map((e) => (
              <li key={e.id}>
                {e.name} [{e.kind}] — {t('memoryV27.mentionCount')}: {e.mentionCount}, {t('memoryV27.boostWeight')}: {e.boostWeight}
                {e.aliases.length > 0 ? <span style={{ opacity: 0.75 }}> ({e.aliases.join(', ')})</span> : null}
              </li>
            ))}
            {view.topEntities.length === 0 ? <li>{t('memoryV27.noResults')}</li> : null}
          </ul>
        ) : null}
      </article>

      <article style={{ border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: '8px 10px' }}>
        <button type="button" onClick={() => setShowEpisodes((v) => !v)} style={{ fontWeight: 600, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
          {t('memoryV27.recentEpisodes')} ({view.recentEpisodes.length})
        </button>
        {showEpisodes ? (
          <ul style={{ margin: '6px 0 0', paddingLeft: 16, fontSize: 13 }}>
            {view.recentEpisodes.map((e) => (
              <li key={e.id}>
                {e.preview} <span style={{ opacity: 0.75 }}>({e.source}, {e.at}, {e.factsCount} fact)</span>
              </li>
            ))}
            {view.recentEpisodes.length === 0 ? <li>{t('memoryV27.noResults')}</li> : null}
          </ul>
        ) : null}
      </article>

      <article style={{ border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: '8px 10px' }}>
        <button type="button" onClick={() => setShowBlocks((v) => !v)} style={{ fontWeight: 600, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
          {t('memoryV27.blocks')} ({view.blocks.length})
        </button>
        {showBlocks ? (
          <ul style={{ margin: '6px 0 0', paddingLeft: 16, fontSize: 13 }}>
            {view.blocks.map((b) => (
              <li key={b.blockId}>
                {b.label} (v{b.version}) — {t('memoryV27.timeline')}: {b.timelineEntries}, {t('memoryV27.syncLog')}: {b.syncEntries}
                <br />
                <span style={{ opacity: 0.75 }}>{t('memoryV27.valueAt')}: {b.currentValuePreview}</span>
              </li>
            ))}
            {view.blocks.length === 0 ? <li>{t('memoryV27.noResults')}</li> : null}
          </ul>
        ) : null}
      </article>

      {view.history.length > 0 ? (
        <article style={{ border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: '8px 10px' }}>
          <button type="button" onClick={() => setShowHistory((v) => !v)} style={{ fontWeight: 600, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
            {t('memoryV27.history')} ({view.history.length})
          </button>
          {showHistory ? (
            <ul style={{ margin: '6px 0 0', paddingLeft: 16, fontSize: 13 }}>
              {view.history.map((h) => (
                <li key={h.factId}>
                  {h.subject} {h.predicate} {h.object} [{h.status}] — {h.validAt ?? '?'} → {h.invalidAt ?? 'nay'}
                </li>
              ))}
            </ul>
          ) : null}
        </article>
      ) : null}
    </section>
  );
}
