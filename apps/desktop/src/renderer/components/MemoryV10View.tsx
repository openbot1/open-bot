/**
 * MemoryV10View — memory v10 (v1.10, Team T1).
 *
 * Tab "v10" in MemoryView: Mem0 pipeline + bi-temporal graph v2 +
 * CoALA 4 kinds + Letta-Code-style versioned blocks + fused
 * 3-signal retrieval. All local, nothing leaves the machine;
 * embedding is an in-process hash (no external model call).
 *
 *  - Stats: counts for the 4 CoALA kinds (working/episodes/facts/procedures)
 *    + blocks + quarantine pending.
 *  - Recall: fused search — each hit shows an EXPLAINABLE SCORE
 *    breakdown (vector / BM25 / entity / weighted total + why it was picked).
 *    The "true at" (asOf) box asks "where in March" instead of
 *    "where right now".
 *  - Timeline: bi-temporal axis for one subject — which fact was
 *    true when, and which fact replaced it.
 *  - Blocks: versioned blocks — view current content + version
 *    history, roll back to an older version (writes a NEW version,
 *    never rewrites history).
 *  - Quarantine: conflicting facts / suspicious samples awaiting
 *    review — approve (apply) / reject (write nothing).
 *
 * Data flows over IPC `memory-v10:*` (main uses MemoryManagerV10 from
 * @open-bot/tools). Props follow the MemoryView pattern (bots + botId +
 * onSelectBot).
 */
import { useEffect, useState } from 'react';
import { useT } from '../i18n/useT';
import type {
  BotConfigLike,
  V10BlockView,
  V10QuarantineView,
  V10RetrievalHitView,
  V10StatsView,
  V10TimelineEntryView,
} from '../types';

interface Props {
  bots: BotConfigLike[];
  botId: string | null;
  onSelectBot: (id: string) => void;
}

export default function MemoryV10View({ bots, botId, onSelectBot }: Props) {
  const t = useT();
  const [stats, setStats] = useState<V10StatsView | null>(null);
  const [blocks, setBlocks] = useState<V10BlockView[]>([]);
  const [quarantine, setQuarantine] = useState<V10QuarantineView[]>([]);
  const [recallHits, setRecallHits] = useState<V10RetrievalHitView[]>([]);
  const [recallQuery, setRecallQuery] = useState('');
  const [recallAsOf, setRecallAsOf] = useState('');
  const [timeline, setTimeline] = useState<V10TimelineEntryView[]>([]);
  const [timelineSubject, setTimelineSubject] = useState('user');
  const [rollbackForId, setRollbackForId] = useState('');
  const [rollbackVersion, setRollbackVersion] = useState('');
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const activeBot = bots.find((b) => b.id === botId) ?? bots[0] ?? null;

  const load = async (id: string | null) => {
    if (!id) {
      setStats(null);
      setBlocks([]);
      setQuarantine([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const [st, bl, qu] = await Promise.all([
        window.openBot.getMemoryV10Stats({ botId: id }),
        window.openBot.listMemoryV10Blocks({ botId: id }),
        window.openBot.listMemoryV10Quarantine({ botId: id }),
      ]);
      setStats(st);
      setBlocks(bl);
      setQuarantine(qu);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(botId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId]);

  const runRecall = async () => {
    if (!activeBot || recallQuery.trim() === '') return;
    setSearching('recall');
    setError('');
    try {
      const res = await window.openBot.searchMemoryV10({
        botId: activeBot.id,
        query: recallQuery.trim(),
        asOf: recallAsOf.trim() === '' ? undefined : recallAsOf.trim(),
      });
      setRecallHits(res.hits);
      setNotice(t('memoryV10.recallFound', { count: String(res.hits.length) }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSearching('');
    }
  };

  const runTimeline = async () => {
    if (!activeBot || timelineSubject.trim() === '') return;
    setSearching('timeline');
    setError('');
    try {
      const entries = await window.openBot.getMemoryV10Timeline({ botId: activeBot.id, subject: timelineSubject.trim() });
      setTimeline(entries);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSearching('');
    }
  };

  const decideQuarantine = async (id: string, approve: boolean) => {
    if (!activeBot) return;
    setSearching(`quarantine-${id}`);
    setError('');
    try {
      const res = await window.openBot.decideMemoryV10Quarantine({ botId: activeBot.id, id, approve });
      setNotice(t('memoryV10.quarantineDecided', { status: res.status }));
      await load(activeBot.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSearching('');
    }
  };

  const doRollback = async (blockId: string) => {
    if (!activeBot || rollbackVersion.trim() === '') return;
    const toVersion = Number(rollbackVersion);
    if (!Number.isInteger(toVersion) || toVersion < 1) {
      setError(t('memoryV10.rollbackInvalidVersion'));
      return;
    }
    setSearching(`rollback-${blockId}`);
    setError('');
    try {
      const report = await window.openBot.rollbackMemoryV10Block({ botId: activeBot.id, blockId, toVersion });
      setNotice(t('memoryV10.rollbackDone', { version: String(report.newVersion) }));
      setRollbackForId('');
      setRollbackVersion('');
      await load(activeBot.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSearching('');
    }
  };

  if (loading) return <div data-testid="memory-v10-loading">{t('memoryV10.loading')}</div>;

  return (
    <div data-testid="memory-v10-view">
      <div className="row" data-testid="memory-v10-bot-row">
        <label>
          {t('memoryV10.bot')}
          <select
            data-testid="memory-v10-bot-select"
            value={activeBot?.id ?? ''}
            onChange={(e) => onSelectBot(e.target.value)}
          >
            {bots.map((b) => (
              <option key={b.id} value={b.id}>{b.name ?? b.id}</option>
            ))}
          </select>
        </label>
        <button type="button" data-testid="memory-v10-refresh" onClick={() => void load(botId)}>
          {t('memoryV10.refresh')}
        </button>
      </div>
      {error !== '' && <div className="error" data-testid="memory-v10-error">{error}</div>}
      {notice !== '' && <div data-testid="memory-v10-notice">{notice}</div>}

      {stats && (
        <div data-testid="memory-v10-stats">
          <h3>{t('memoryV10.statsTitle')}</h3>
          <ul>
            <li>{t('memoryV10.statsWorking', { count: String(stats.workingItems) })}</li>
            <li>{t('memoryV10.statsEpisodes', { count: String(stats.episodes) })}</li>
            <li>{t('memoryV10.statsFacts', { active: String(stats.factsActive), superseded: String(stats.factsSuperseded), deleted: String(stats.factsDeleted) })}</li>
            <li>{t('memoryV10.statsProcedures', { count: String(stats.procedures) })}</li>
            <li>{t('memoryV10.statsBlocks', { blocks: String(stats.blocks), versions: String(stats.blockVersions) })}</li>
            <li>{t('memoryV10.statsQuarantine', { count: String(stats.quarantinePending) })}</li>
          </ul>
        </div>
      )}

      <div data-testid="memory-v10-recall">
        <h3>{t('memoryV10.recallTitle')}</h3>
        <div className="row">
          <input
            data-testid="memory-v10-recall-query"
            value={recallQuery}
            onChange={(e) => setRecallQuery(e.target.value)}
            placeholder={t('memoryV10.recallPlaceholder')}
          />
          <input
            data-testid="memory-v10-recall-asof"
            value={recallAsOf}
            onChange={(e) => setRecallAsOf(e.target.value)}
            placeholder={t('memoryV10.recallAsOfPlaceholder')}
          />
          <button type="button" data-testid="memory-v10-recall-search" disabled={searching === 'recall'} onClick={() => void runRecall()}>
            {t('memoryV10.search')}
          </button>
        </div>
        {recallHits.length === 0 ? (
          <p>{t('memoryV10.recallEmpty')}</p>
        ) : (
          <table data-testid="memory-v10-recall-table">
            <thead>
              <tr>
                <th>{t('memoryV10.colKind')}</th>
                <th>{t('memoryV10.colText')}</th>
                <th>{t('memoryV10.colVector')}</th>
                <th>{t('memoryV10.colBm25')}</th>
                <th>{t('memoryV10.colEntity')}</th>
                <th>{t('memoryV10.colTotal')}</th>
                <th>{t('memoryV10.colReasons')}</th>
              </tr>
            </thead>
            <tbody>
              {recallHits.map((h) => (
                <tr key={h.id} data-testid="memory-v10-recall-row">
                  <td>{h.kind}</td>
                  <td>{h.text}</td>
                  <td>{h.scores.vector.toFixed(2)}</td>
                  <td>{h.scores.bm25.toFixed(2)}</td>
                  <td>{h.scores.entity.toFixed(2)}</td>
                  <td><strong>{h.scores.total.toFixed(2)}</strong></td>
                  <td>{h.reasons.join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div data-testid="memory-v10-timeline">
        <h3>{t('memoryV10.timelineTitle')}</h3>
        <div className="row">
          <input
            data-testid="memory-v10-timeline-subject"
            value={timelineSubject}
            onChange={(e) => setTimelineSubject(e.target.value)}
            placeholder={t('memoryV10.timelinePlaceholder')}
          />
          <button type="button" data-testid="memory-v10-timeline-load" disabled={searching === 'timeline'} onClick={() => void runTimeline()}>
            {t('memoryV10.search')}
          </button>
        </div>
        {timeline.length === 0 ? (
          <p>{t('memoryV10.timelineEmpty')}</p>
        ) : (
          <table data-testid="memory-v10-timeline-table">
            <thead>
              <tr>
                <th>{t('memoryV10.colFact')}</th>
                <th>{t('memoryV10.colStatus')}</th>
                <th>{t('memoryV10.colStartsAt')}</th>
                <th>{t('memoryV10.colEndsAt')}</th>
                <th>{t('memoryV10.colReplacedBy')}</th>
              </tr>
            </thead>
            <tbody>
              {timeline.map((e, i) => (
                <tr key={`${e.fact}-${i}`} data-testid="memory-v10-timeline-row">
                  <td>{e.fact}</td>
                  <td>{e.status}</td>
                  <td>{e.startsAt.slice(0, 10)}</td>
                  <td>{e.endsAt ? e.endsAt.slice(0, 10) : '—'}</td>
                  <td>{e.replacedBy ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div data-testid="memory-v10-blocks">
        <h3>{t('memoryV10.blocksTitle')}</h3>
        {blocks.length === 0 ? (
          <p>{t('memoryV10.blocksEmpty')}</p>
        ) : (
          <ul data-testid="memory-v10-blocks-list">
            {blocks.map((b) => (
              <li key={b.id} data-testid="memory-v10-block-row">
                <strong>{b.label}</strong> ({b.kind}) — {t('memoryV10.blockVersion', { branch: b.currentBranch, version: String(b.currentVersion) })}
                <pre>{b.currentContent}</pre>
                <div className="row">
                  <button
                    type="button"
                    data-testid="memory-v10-rollback-toggle"
                    onClick={() => {
                      setRollbackForId(rollbackForId === b.id ? '' : b.id);
                      setRollbackVersion('');
                    }}
                  >
                    {t('memoryV10.rollback')}
                  </button>
                  {rollbackForId === b.id && (
                    <>
                      <input
                        data-testid="memory-v10-rollback-version"
                        value={rollbackVersion}
                        onChange={(e) => setRollbackVersion(e.target.value)}
                        placeholder={t('memoryV10.rollbackPlaceholder')}
                      />
                      <button
                        type="button"
                        data-testid="memory-v10-rollback-confirm"
                        disabled={searching === `rollback-${b.id}`}
                        onClick={() => void doRollback(b.id)}
                      >
                        {t('memoryV10.rollbackConfirm')}
                      </button>
                    </>
                  )}
                </div>
                <details>
                  <summary>{t('memoryV10.versionsTitle', { count: String(b.versions.length) })}</summary>
                  <ul>
                    {b.versions.map((v) => (
                      <li key={v.version}>
                        v{v.version} [{v.branch}] {v.message} — {v.author} ({v.createdAt.slice(0, 10)})
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div data-testid="memory-v10-quarantine">
        <h3>{t('memoryV10.quarantineTitle')}</h3>
        {quarantine.length === 0 ? (
          <p>{t('memoryV10.quarantineEmpty')}</p>
        ) : (
          <ul data-testid="memory-v10-quarantine-list">
            {quarantine.map((q) => (
              <li key={q.id} data-testid="memory-v10-quarantine-row">
                <strong>{q.candidate}</strong>
                <p>{q.detail}</p>
                <div className="row">
                  <button
                    type="button"
                    data-testid="memory-v10-quarantine-approve"
                    disabled={searching === `quarantine-${q.id}`}
                    onClick={() => void decideQuarantine(q.id, true)}
                  >
                    {t('memoryV10.approve')}
                  </button>
                  <button
                    type="button"
                    data-testid="memory-v10-quarantine-reject"
                    disabled={searching === `quarantine-${q.id}`}
                    onClick={() => void decideQuarantine(q.id, false)}
                  >
                    {t('memoryV10.reject')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
