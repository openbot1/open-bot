/**
 * MemoryTimelineView — memory timeline tab (v1.06, Team T5 — UI v3).
 *
 * One chronological timeline of everything that happened to a bot's
 * memory: entry adds/edits, block adds/edits, block version snapshots
 * (v3 history) and consolidation runs (v5). Filter by tier (working /
 * session / episodic / semantic — see memoryTimeline.ts for the
 * derivation rule), search across titles and content, click an event
 * to see its full content. A block-version event can be restored from
 * the detail panel (same `memory-v3:block-history` restore action the
 * v3 view uses).
 *
 * Mounted inside MemoryView under the "Timeline" tab. All data flows
 * over the existing `memory:*`, `memory-blocks:*`, `memory-v3:*` and
 * `memory-v5:*` IPC channels — no new backend needed.
 */
import { useEffect, useState } from 'react';
import { useT } from '../i18n/useT';
import type {
  BotConfigLike,
  MemoryV3BlockVersionView,
} from '../types';
import {
  buildTimelineEvents,
  filterTimelineEvents,
  groupEventsByDay,
  MEMORY_TIERS,
  type MemoryTier,
  type TimelineEvent,
} from './memoryTimeline';

interface Props {
  bots: BotConfigLike[];
  botId: string | null;
  onSelectBot: (id: string) => void;
}

/** Static tier -> i18n key map (kept literal so the key scan finds every key). */
const TIER_KEYS: Record<MemoryTier, string> = {
  working: 'memory.timeline.tier.working',
  session: 'memory.timeline.tier.session',
  episodic: 'memory.timeline.tier.episodic',
  semantic: 'memory.timeline.tier.semantic',
};

/** Static kind -> i18n key map (kept literal so the key scan finds every key). */
const KIND_KEYS: Record<TimelineEvent['kind'], string> = {
  'entry-created': 'memory.timeline.kind.entryCreated',
  'entry-updated': 'memory.timeline.kind.entryUpdated',
  'block-created': 'memory.timeline.kind.blockCreated',
  'block-updated': 'memory.timeline.kind.blockUpdated',
  'block-version': 'memory.timeline.kind.blockVersion',
  consolidation: 'memory.timeline.kind.consolidation',
};

function formatTime(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function MemoryTimelineView({ bots, botId, onSelectBot }: Props) {
  const t = useT();
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [tiers, setTiers] = useState<ReadonlySet<MemoryTier>>(() => new Set(MEMORY_TIERS));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  const activeBot = bots.find((b) => b.id === botId) ?? bots[0] ?? null;

  const load = async (id: string | null) => {
    if (!id) {
      setEvents([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    setSelectedId(null);
    try {
      const [entries, blocks] = await Promise.all([
        window.openBot.listMemories({ botId: id, limit: 500 }),
        window.openBot.listMemoryBlocks({ botId: id }),
      ]);
      // Consolidation runs and per-block version history are
      // best-effort: a failure there must not hide entries/blocks.
      const runs = await window.openBot
        .getMemoryV5Health({ botId: id })
        .then((res) => res.recentConsolidationRuns)
        .catch(() => []);
      const versionsByBlock: Record<string, MemoryV3BlockVersionView[]> = {};
      await Promise.all(
        blocks.map(async (block) => {
          try {
            const list = await window.openBot.getMemoryV3BlockHistory({
              botId: id,
              action: 'list',
              block: block.label,
            });
            if (Array.isArray(list)) versionsByBlock[block.label] = list;
          } catch {
            /* No history for this block — the timeline still shows the block itself. */
          }
        }),
      );
      setEvents(buildTimelineEvents({ entries, blocks, versionsByBlock, runs }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memory.timeline.loadError'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(activeBot?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBot?.id]);

  const toggleTier = (tier: MemoryTier) => {
    setTiers((prev) => {
      const next = new Set(prev);
      if (next.has(tier)) next.delete(tier);
      else next.add(tier);
      return next;
    });
  };

  const restoreVersion = async (event: TimelineEvent) => {
    if (!activeBot || event.kind !== 'block-version' || !event.blockLabel || event.version === undefined) return;
    setRestoring(true);
    setError('');
    setNotice('');
    try {
      await window.openBot.getMemoryV3BlockHistory({
        botId: activeBot.id,
        action: 'restore',
        block: event.blockLabel,
        version: event.version,
      });
      setNotice(t('memory.timeline.restoredOk'));
      await load(activeBot.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memory.timeline.restoreError'));
    } finally {
      setRestoring(false);
    }
  };

  const filtered = filterTimelineEvents(events, { tiers, query });
  const groups = groupEventsByDay(filtered);
  const selected = selectedId ? events.find((e) => e.id === selectedId) ?? null : null;

  return (
    <div data-testid="memory-timeline-view">
      <p className="hint">{t('memory.timeline.intro')}</p>
      <p className="hint">{t('memory.timeline.tierHint')}</p>
      <div className="row">
        <label>
          {t('memory.bot')}
          <select
            value={activeBot?.id ?? ''}
            onChange={(e) => onSelectBot(e.target.value)}
            data-testid="memory-timeline-bot-select"
          >
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label style={{ flex: 1 }}>
          {t('memory.timeline.search')}
          <input
            type="text"
            value={query}
            data-testid="memory-timeline-search"
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('memory.timeline.searchPlaceholder')}
          />
        </label>
        <button
          type="button"
          onClick={() => void load(activeBot?.id ?? null)}
          disabled={loading}
          data-testid="memory-timeline-refresh"
        >
          {t('memory.timeline.refresh')}
        </button>
      </div>
      <div className="row" data-testid="memory-timeline-tiers" style={{ flexWrap: 'wrap' }}>
        {MEMORY_TIERS.map((tier) => (
          <label key={tier} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={tiers.has(tier)}
              onChange={() => toggleTier(tier)}
              data-testid={`memory-timeline-tier-${tier}`}
            />
            {t(TIER_KEYS[tier])}
          </label>
        ))}
        <span className="hint" data-testid="memory-timeline-count">
          {t('memory.timeline.count', { count: filtered.length })}
        </span>
      </div>
      {loading ? (
        <p className="hint">{t('memory.timeline.loading')}</p>
      ) : error ? (
        <p className="error" data-testid="memory-timeline-error">
          {error}
        </p>
      ) : !activeBot ? (
        <p className="hint">{t('memory.timeline.noBot')}</p>
      ) : events.length === 0 ? (
        <p className="hint" data-testid="memory-timeline-empty">
          {t('memory.timeline.empty')}
        </p>
      ) : filtered.length === 0 ? (
        <p className="hint" data-testid="memory-timeline-no-results">
          {t('memory.timeline.noResults')}
        </p>
      ) : (
        <div data-testid="memory-timeline-list">
          {groups.map((group) => (
            <section key={group.day}>
              <h3>{group.day}</h3>
              <ul>
                {group.events.map((event) => (
                  <li key={event.id}>
                    <button
                      type="button"
                      className="btn secondary"
                      onClick={() => setSelectedId(event.id === selectedId ? null : event.id)}
                      data-testid={`memory-timeline-event-${event.id}`}
                      style={{ textAlign: 'left', width: '100%' }}
                      aria-expanded={event.id === selectedId}
                    >
                      <span className="hint">{formatTime(event.at)}</span>{' '}
                      <strong>{event.title}</strong>{' '}
                      <span className="hint">
                        · {t(KIND_KEYS[event.kind])} · {t(TIER_KEYS[event.tier])}
                        {event.version !== undefined
                          ? ` · ${t('memory.timeline.version', { version: event.version })}`
                          : ''}
                      </span>
                      <br />
                      <span className="hint">{event.detail}</span>
                    </button>
                    {selected?.id === event.id && (
                      <div
                        className="card"
                        data-testid="memory-timeline-detail"
                        style={{ marginTop: 6, padding: 10 }}
                      >
                        <div className="row" style={{ justifyContent: 'space-between' }}>
                          <strong>{t('memory.timeline.detailTitle')}</strong>
                          <button
                            type="button"
                            className="btn secondary"
                            onClick={() => setSelectedId(null)}
                          >
                            {t('memory.timeline.closeDetail')}
                          </button>
                        </div>
                        {selected.kind === 'consolidation' && selected.run ? (
                          <p>
                            {t('memory.timeline.consolidationSummary', {
                              merged: selected.run.duplicatesMerged,
                              superseded: selected.run.losersSuperseded,
                              swept: selected.run.expiredSwept,
                              promoted: selected.run.dreamPromoted,
                              before: selected.run.scoreBefore,
                              after: selected.run.scoreAfter,
                            })}
                          </p>
                        ) : (
                          <p style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                            {selected.content || '—'}
                          </p>
                        )}
                        {selected.kind === 'block-version' && (
                          <button
                            type="button"
                            className="btn secondary"
                            onClick={() => void restoreVersion(selected)}
                            disabled={restoring}
                            data-testid="memory-timeline-restore"
                          >
                            {restoring ? t('memory.timeline.restoring') : t('memory.timeline.restoreVersion')}
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {notice ? (
        <p className="hint" data-testid="memory-timeline-notice">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
