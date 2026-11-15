/**
 * MemoryV11View — memory v11 (v1.11, Doi T1).
 *
 * Tab "v11" in MemoryView: Letta-style memory v11.
 *
 *  - Shared blocks: blocks shared across bots in a group, with the
 *    supervisor who may write them, members, and fill level
 *    (warning at 80% full, over-limit blocks are flagged — shared
 *    blocks stay small on purpose).
 *  - Blocks by kind: blocks attached to the bot, compiled into
 *    `<memory_blocks>` (system kinds first: human, persona, task,
 *    project, safety, then custom).
 *  - Block history: the unified block_history table (every backend) —
 *    pick a shared block, see its versions, view the unified diff
 *    between two versions, roll back to an old version (writes a NEW
 *    version, never rewrites history).
 *  - Sleep-time consolidation: unprocessed raw facts in the inbox,
 *    last sleep pass report, run a new pass (dry run / force).
 *
 * Data flows over IPC `memory-v11:*` (main uses the v11 core modules
 * from @open-bot/core). Props follow the MemoryView pattern (bots +
 * botId + onSelectBot). All user-facing strings go through i18n
 * (`memoryV11.*` keys) — no hardcoded Vietnamese in this file.
 */
import { useEffect, useState } from 'react';
import { useT } from '../i18n/useT';
import type {
  BotConfigLike,
  V11HistoryDiffView,
  V11HistoryEntryView,
  V11RenderedBlockView,
  V11SharedBlockView,
  V11SleepRunView,
  V11SleepStatusView,
} from '../types';

interface Props {
  bots: BotConfigLike[];
  botId: string | null;
  onSelectBot: (id: string) => void;
}

export default function MemoryV11View({ bots, botId, onSelectBot }: Props) {
  const t = useT();
  const [shared, setShared] = useState<V11SharedBlockView[]>([]);
  const [rendered, setRendered] = useState<V11RenderedBlockView[]>([]);
  const [renderedXml, setRenderedXml] = useState('');
  const [historyBlockId, setHistoryBlockId] = useState('');
  const [history, setHistory] = useState<V11HistoryEntryView[]>([]);
  const [diff, setDiff] = useState<V11HistoryDiffView | null>(null);
  const [diffFrom, setDiffFrom] = useState('');
  const [diffTo, setDiffTo] = useState('');
  /** Version dang cho xac nhan rollback (click lan 1 mo khoa, lan 2 chay). */
  const [confirmRollbackVersion, setConfirmRollbackVersion] = useState<number | null>(null);
  const [sleepStatus, setSleepStatus] = useState<V11SleepStatusView | null>(null);
  const [sleepRun, setSleepRun] = useState<V11SleepRunView | null>(null);
  const [sleepDryRun, setSleepDryRun] = useState(false);
  const [sleepForce, setSleepForce] = useState(false);
  const [runningSleep, setRunningSleep] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const activeBot = bots.find((b) => b.id === botId) ?? bots[0] ?? null;

  const load = async (id: string | null) => {
    if (!id) {
      setShared([]);
      setRendered([]);
      setRenderedXml('');
      setHistory([]);
      setSleepStatus(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const [sh, ren, st] = await Promise.all([
        window.openBot.listMemoryV11Shared({ botId: id }),
        window.openBot.renderMemoryV11Blocks({ botId: id }),
        window.openBot.getMemoryV11SleepStatus({ botId: id }),
      ]);
      setShared(sh);
      setRendered(ren.blocks);
      setRenderedXml(ren.xml);
      setSleepStatus(st);
      if (sh.length > 0 && historyBlockId === '') {
        setHistoryBlockId(sh[0].blockId);
      }
    } catch (err) {
      setError(t('memoryV11.loadError'));
      void err;
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(activeBot?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId]);

  useEffect(() => {
    if (!historyBlockId || !activeBot) {
      setHistory([]);
      return;
    }
    window.openBot
      .listMemoryV11History({ botId: activeBot.id, blockId: historyBlockId, limit: 20 })
      .then(setHistory)
      .catch(() => setHistory([]));
  }, [historyBlockId, activeBot]);

  const handleDiff = async () => {
    if (!activeBot || !historyBlockId) return;
    const from = Number.parseInt(diffFrom, 10);
    const to = Number.parseInt(diffTo, 10);
    if (!Number.isInteger(from) || !Number.isInteger(to)) return;
    try {
      const result = await window.openBot.diffMemoryV11History({
        botId: activeBot.id,
        blockId: historyBlockId,
        fromVersion: from,
        toVersion: to,
      });
      setDiff(result);
      setError('');
    } catch {
      setError(t('memoryV11.loadError'));
    }
  };

  const handleRollback = async (toVersion: number) => {
    if (!activeBot || !historyBlockId) return;
    // Click lan 1 chi mo khoa xac nhan (khong dung hop thoai he thong);
    // click lan 2 moi chay that.
    if (confirmRollbackVersion !== toVersion) {
      setConfirmRollbackVersion(toVersion);
      setNotice(t('memoryV11.historyRollbackConfirm'));
      return;
    }
    setConfirmRollbackVersion(null);
    try {
      const result = await window.openBot.rollbackMemoryV11Block({
        botId: activeBot.id,
        blockId: historyBlockId,
        toVersion,
      });
      setNotice(`v${result.fromVersion} -> v${result.newVersion}`);
      const fresh = await window.openBot.listMemoryV11History({
        botId: activeBot.id,
        blockId: historyBlockId,
        limit: 20,
      });
      setHistory(fresh);
    } catch {
      setError(t('memoryV11.loadError'));
    }
  };

  const handleSleepRun = async () => {
    if (!activeBot) return;
    setRunningSleep(true);
    setError('');
    try {
      const report = await window.openBot.runMemoryV11Sleep({
        botId: activeBot.id,
        dryRun: sleepDryRun,
        force: sleepForce,
      });
      setSleepRun(report);
      const st = await window.openBot.getMemoryV11SleepStatus({ botId: activeBot.id });
      setSleepStatus(st);
    } catch {
      setError(t('memoryV11.loadError'));
    } finally {
      setRunningSleep(false);
    }
  };

  if (loading) return <div>{t('memoryV11.loading')}</div>;

  return (
    <div>
      <h3>{t('memoryV11.title')}</h3>
      <p>{t('memoryV11.subtitle')}</p>
      <label>
        {t('memory.bot')}{' '}
        <select value={activeBot?.id ?? ''} onChange={(e) => onSelectBot(e.target.value)}>
          {bots.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name ?? b.id}
            </option>
          ))}
        </select>
      </label>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p>{notice}</p> : null}

      <h4>{t('memoryV11.sharedTitle')}</h4>
      {shared.length === 0 ? (
        <p>{t('memoryV11.sharedEmpty')}</p>
      ) : (
        <ul>
          {shared.map((s) => (
            <li key={`${s.groupId}:${s.blockId}`}>
              <strong>{s.label}</strong> (v{s.version}) — {t('memoryV11.sharedGroup')}: {s.group} —{' '}
              {t('memoryV11.sharedSupervisor')}: {s.supervisorBotId ?? t('memoryV11.sharedNoSupervisor')} —{' '}
              {t('memoryV11.sharedUsage', { chars: String(s.usage.chars), limit: String(s.usage.limit) })}
              {s.usage.state === 'warm' ? ` — ${t('memoryV11.sharedWarning')}` : null}
              {s.usage.state === 'over' ? ` — ${t('memoryV11.sharedOverLimit')}` : null}
              <br />
              {t('memoryV11.sharedMembers')}: {s.memberBotIds.join(', ') || '—'}
            </li>
          ))}
        </ul>
      )}

      <h4>{t('memoryV11.blocksTitle')}</h4>
      {rendered.length === 0 ? (
        <p>{t('memoryV11.blocksEmpty')}</p>
      ) : (
        <ul>
          {rendered.map((b) => (
            <li key={b.label}>
              <strong>{b.label}</strong> ({b.kind}, v{b.version}) — {b.chars}/{b.limit}
            </li>
          ))}
        </ul>
      )}
      {renderedXml ? <pre>{renderedXml}</pre> : null}

      <h4>{t('memoryV11.historyTitle')}</h4>
      {shared.length === 0 ? (
        <p>{t('memoryV11.historyEmpty')}</p>
      ) : (
        <div>
          <label>
            {t('memoryV11.historyTitle')}{' '}
            <select value={historyBlockId} onChange={(e) => setHistoryBlockId(e.target.value)}>
              {shared.map((s) => (
                <option key={s.blockId} value={s.blockId}>
                  {s.label} ({s.group})
                </option>
              ))}
            </select>
          </label>
          {history.length === 0 ? (
            <p>{t('memoryV11.historyEmpty')}</p>
          ) : (
            <ul>
              {history.map((h) => (
                <li key={`${h.version}:${h.at}`}>
                  {t('memoryV11.historyVersion', { version: String(h.version) })} —{' '}
                  {t('memoryV11.historyBackend')}: {h.backend}/{h.action} —{' '}
                  {t('memoryV11.historyActor')}: {h.actor} — {h.at}
                  {h.note ? ` — ${h.note}` : null} — {h.chars} chars{' '}
                  <button type="button" onClick={() => void handleRollback(h.version)}>
                    {confirmRollbackVersion === h.version
                      ? t('memoryV11.historyRollbackConfirm')
                      : t('memoryV11.historyRollback')}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div>
            <label>
              {t('memoryV11.historyDiff')}{' '}
              <input
                value={diffFrom}
                onChange={(e) => setDiffFrom(e.target.value)}
                placeholder="from"
                size={4}
              />{' '}
              <input value={diffTo} onChange={(e) => setDiffTo(e.target.value)} placeholder="to" size={4} />{' '}
              <button type="button" onClick={() => void handleDiff()}>
                {t('memoryV11.historyDiff')}
              </button>
            </label>
            {diff ? <pre>{diff.unified}</pre> : null}
          </div>
        </div>
      )}

      <h4>{t('memoryV11.sleepTitle')}</h4>
      {sleepStatus ? (
        <p>
          {t('memoryV11.sleepRawFacts')}: {sleepStatus.unprocessedRawFacts}
          {sleepStatus.lastRun
            ? ` — ${t('memoryV11.sleepLastRun')}: ${sleepStatus.lastRun.at} (${t('memoryV11.sleepFactsExtracted')}: ${sleepStatus.lastRun.factsExtracted})`
            : null}
        </p>
      ) : null}
      <label>
        <input type="checkbox" checked={sleepDryRun} onChange={(e) => setSleepDryRun(e.target.checked)} />{' '}
        {t('memoryV11.sleepDryRun')}
      </label>{' '}
      <label>
        <input type="checkbox" checked={sleepForce} onChange={(e) => setSleepForce(e.target.checked)} />{' '}
        {t('memoryV11.sleepForce')}
      </label>{' '}
      <button type="button" onClick={() => void handleSleepRun()} disabled={runningSleep || !activeBot}>
        {runningSleep ? t('memoryV11.sleepRunning') : t('memoryV11.sleepRun')}
      </button>
      {sleepRun ? (
        <ul>
          <li>
            {t('memoryV11.sleepFactsExtracted')}: {sleepRun.factsExtracted} ({sleepRun.factsDeduped} duplicates)
          </li>
          <li>
            {t('memoryV11.sleepLearnedAdded')}: {sleepRun.learnedContextLinesAdded}
          </li>
          <li>
            {t('memoryV11.sleepConsolidated')}: {sleepRun.archivalConsolidated}
          </li>
          <li>
            {t('memoryV11.sleepInvalidated')}: {sleepRun.archivalInvalidated.length}
          </li>
          {sleepRun.errors.length > 0 ? <li role="alert">{sleepRun.errors.join('; ')}</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
