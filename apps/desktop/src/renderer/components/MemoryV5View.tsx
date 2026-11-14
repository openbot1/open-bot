/**
 * MemoryV5View — memory v5 UI (v1.04, Team T1).
 *
 * Health dashboard for the memory store, all local:
 *  - Health score: total 0..100 + grade, fact counts, contradiction
 *    rate, stale facts, quarantine backlog, orphan entities,
 *    average confidence, top predicates.
 *  - Issues: one readable reason per score deduction (so the user
 *    knows why the score is low and what to do next).
 *  - Contradiction groups: contradictory fact groups, winners and
 *    losers with rank scores — losers stay in history, only demoted.
 *  - Recent consolidation runs: consolidation v2 history (score
 *    before/after, facts merged/superseded/swept).
 *  - Run consolidation v2: dedupe + ranking supersession + expired
 *    sweep + scored dream, then reload the dashboard.
 *
 * Props follow the MemoryV3View pattern (bots + botId +
 * onSelectBot). Mounted inside MemoryView under the "Memory v5" tab.
 * Data flows over IPC `memory-v5:*` (no embeddings reach the
 * renderer).
 */
import { useEffect, useState } from 'react';
import { useT } from '../i18n/useT';
import type {
  BotConfigLike,
  MemoryV5BiTemporalRowView,
  MemoryV5HealthView,
  MemoryV5ConsolidationRunView,
  MemoryV5ContradictionGroupView,
} from '../types';

interface Props {
  bots: BotConfigLike[];
  botId: string | null;
  onSelectBot: (id: string) => void;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function MemoryV5View({ bots, botId, onSelectBot }: Props) {
  const t = useT();
  const [health, setHealth] = useState<MemoryV5HealthView | null>(null);
  const [contradictions, setContradictions] = useState<MemoryV5ContradictionGroupView[]>([]);
  const [runs, setRuns] = useState<MemoryV5ConsolidationRunView[]>([]);
  const [loading, setLoading] = useState(true);
  const [consolidating, setConsolidating] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [atDate, setAtDate] = useState(todayIso());
  const [biTemporalRows, setBiTemporalRows] = useState<MemoryV5BiTemporalRowView[] | null>(null);
  const [querying, setQuerying] = useState(false);

  const activeBot = bots.find((b) => b.id === botId) ?? bots[0] ?? null;

  const loadHealth = async (id: string | null) => {
    if (!id) {
      setHealth(null);
      setContradictions([]);
      setRuns([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await window.openBot.getMemoryV5Health({ botId: id });
      setHealth(res.health);
      setContradictions(res.contradictionGroups);
      setRuns(res.recentConsolidationRuns);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memory.v5.loadError'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadHealth(activeBot?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBot?.id]);

  const runConsolidation = async () => {
    if (!activeBot || consolidating) return;
    setConsolidating(true);
    setError('');
    setNotice('');
    try {
      const res = await window.openBot.runMemoryV5Consolidation({ botId: activeBot.id });
      setNotice(`${t('memory.v5.consolidatedOk')} ${res.healthSummary}`);
      await loadHealth(activeBot.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memory.v5.consolidateError'));
    } finally {
      setConsolidating(false);
    }
  };

  const pct = (rate: number): string => `${(rate * 100).toFixed(1)}%`;

  const queryBiTemporal = async () => {
    if (!activeBot || querying || !atDate) return;
    setQuerying(true);
    setError('');
    try {
      const rows = await window.openBot.queryMemoryV5BiTemporal({
        botId: activeBot.id,
        at: `${atDate}T00:00:00.000Z`,
      });
      setBiTemporalRows(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memory.v5.loadError'));
    } finally {
      setQuerying(false);
    }
  };

  return (
    <div data-testid="memory-v5-view">
      <p className="hint">{t('memory.v5.intro')}</p>
      <div className="row">
        <label>
          {t('memory.bot')}
          <select
            value={activeBot?.id ?? ''}
            onChange={(e) => onSelectBot(e.target.value)}
            data-testid="memory-v5-bot-select"
          >
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => void loadHealth(activeBot?.id ?? null)}
          disabled={loading}
          data-testid="memory-v5-refresh"
        >
          {t('memory.v5.refresh')}
        </button>
        <button
          type="button"
          onClick={() => void runConsolidation()}
          disabled={!activeBot || consolidating || loading}
          data-testid="memory-v5-run-consolidation"
        >
          {consolidating ? t('memory.v5.consolidating') : t('memory.v5.runConsolidation')}
        </button>
      </div>
      {loading ? (
        <p className="hint">{t('memory.v5.refresh')}…</p>
      ) : error ? (
        <p className="error" data-testid="memory-v5-error">
          {error}
        </p>
      ) : health ? (
        <>
          {notice ? (
            <p className="hint" data-testid="memory-v5-notice">
              {notice}
            </p>
          ) : null}
          <h3 data-testid="memory-v5-title">{t('memory.v5.title')}</h3>
          <div data-testid="memory-v5-score">
            <strong>
              {t('memory.v5.score')}: {health.score}/100 ({health.grade})
            </strong>
          </div>
          <ul data-testid="memory-v5-metrics">
            <li>
              {t('memory.v5.facts')}: {health.factCount} ({t('memory.v5.activeFacts')}: {health.activeFacts})
            </li>
            <li>
              {t('memory.v5.contradictionRate')}: {pct(health.contradictionRate)} ({health.contradictionGroups}/
              {health.totalGroups})
            </li>
            <li>
              {t('memory.v5.staleFacts')}: {health.staleFacts} ({pct(health.staleRate)})
            </li>
            <li>
              {t('memory.v5.quarantinePending')}: {health.quarantinedPending}
            </li>
            <li>
              {t('memory.v5.orphanEntities')}: {health.orphanEntities}/{health.entityCount}
            </li>
            <li>
              {t('memory.v5.avgConfidence')}: {health.avgConfidence.toFixed(2)}
            </li>
            <li>
              {t('memory.v5.topPredicates')}:{' '}
              {health.topPredicates.map((p) => `${p.predicate} (${p.count})`).join(', ') || '—'}
            </li>
          </ul>
          <h3>{t('memory.v5.issuesTitle')}</h3>
          {health.issues.length === 0 ? (
            <p className="hint" data-testid="memory-v5-no-issues">
              {t('memory.v5.noIssues')}
            </p>
          ) : (
            <ul data-testid="memory-v5-issues">
              {health.issues.map((issue, i) => (
                <li key={i}>{issue}</li>
              ))}
            </ul>
          )}
          <h3>{t('memory.v5.contradictionsTitle')}</h3>
          <p className="hint">{t('memory.v5.contradictionsIntro')}</p>
          {contradictions.length === 0 ? (
            <p className="hint" data-testid="memory-v5-no-contradictions">
              {t('memory.v5.noContradictions')}
            </p>
          ) : (
            <ul data-testid="memory-v5-contradictions">
              {contradictions.map((g, i) => (
                <li key={i}>
                  <strong>
                    {g.subjectName} {g.predicate}
                  </strong>
                  <br />
                  {t('memory.v5.winner')}: “{g.winnerObject}” ({g.winnerScore.toFixed(2)})
                  {g.losers.map((l) => (
                    <span key={l.factId}>
                      <br />
                      {t('memory.v5.loser')}: “{l.objectText}” ({l.score.toFixed(2)})
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          )}
          <h3>{t('memory.v5.runsTitle')}</h3>
          {runs.length === 0 ? (
            <p className="hint" data-testid="memory-v5-no-runs">
              {t('memory.v5.noRuns')}
            </p>
          ) : (
            <ul data-testid="memory-v5-runs">
              {runs.map((r, i) => (
                <li key={i}>
                  {r.at.slice(0, 19).replace('T', ' ')} — {r.scoreBefore} → {r.scoreAfter} (
                  {t('memory.v5.score')}: {r.scoreAfter - r.scoreBefore >= 0 ? '+' : ''}
                  {r.scoreAfter - r.scoreBefore}) · {t('memory.v5.superseded')}: {r.losersSuperseded} ·{' '}
                  {t('memory.v5.merged')}: {r.duplicatesMerged} · {t('memory.v5.swept')}: {r.expiredSwept} ·{' '}
                  {t('memory.v5.dreamPromoted')}: {r.dreamPromoted}
                </li>
              ))}
            </ul>
          )}
          <h3>{t('memory.v5.bitemporalTitle')}</h3>
          <p className="hint">{t('memory.v5.bitemporalIntro')}</p>
          <div className="row">
            <label>
              {t('memory.v5.atLabel')}
              <input
                type="date"
                value={atDate}
                onChange={(e) => setAtDate(e.target.value)}
                data-testid="memory-v5-at-date"
              />
            </label>
            <button
              type="button"
              onClick={() => void queryBiTemporal()}
              disabled={!activeBot || querying}
              data-testid="memory-v5-query-at"
            >
              {t('memory.v5.queryAt')}
            </button>
          </div>
          {biTemporalRows !== null ? (
            biTemporalRows.length === 0 ? (
              <p className="hint" data-testid="memory-v5-no-facts-at">
                {t('memory.v5.noFactsAt')}
              </p>
            ) : (
              <ul data-testid="memory-v5-facts-at">
                {biTemporalRows.map((row) => (
                  <li key={row.factId}>
                    {row.subjectName} {row.predicate} “{row.objectText}” ({row.validFrom.slice(0, 10)} –{' '}
                    {row.validUntil ? row.validUntil.slice(0, 10) : '…'}){' '}
                    {row.currentAtRecordTime ? `· ${t('memory.v5.currentAtRecord')}` : ''}
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </>
      ) : null}
    </div>
  );
}
