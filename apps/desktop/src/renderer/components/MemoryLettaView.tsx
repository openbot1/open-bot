/**
 * MemoryLettaView — Letta-style memory v9 (v1.09, Team T2).
 *
 * "Letta" tab inside MemoryView: the agent is a persistent entity —
 * 3 tiers core/recall/archival + sleep-time consolidation. All local,
 * nothing leaves the machine.
 *
 *  - Core blocks: view/edit block content inline (replace), Letta-style
 *    append (when full, the old content is CONDENSED first, then the
 *    new text is appended — the UI says so explicitly), two-step
 *    delete, fill-level bar (chars/limit, ok/warm/full).
 *  - Recall: search recent sessions by keyword (keyword/recency scores).
 *  - Archival: search the long-term store by keyword (10 per page).
 *  - Sleep proposals: core-block update proposals created by the sleep
 *    pass — approve (append to the target block) / reject.
 *  - Sleep: run a Letta sleep pass now (prune recall, extract facts,
 *    dedupe archival, propose core updates) + show the latest run.
 *  - Entity: 3-tier stats + export the bot's memory snapshot to a JSON
 *    file (`.open-bot/memory-exports/letta-<bot>-<time>.json`).
 *
 * Props follow the MemoryView pattern (bots + botId + onSelectBot).
 * Mounted inside MemoryView under the "Letta" tab.
 */
import { useEffect, useState } from 'react';
import { useT } from '../i18n/useT';
import type {
  BotConfigLike,
  LettaArchivalHitView,
  LettaProposalView,
  LettaRecallHitView,
  LettaStatusView,
  MemoryBlockView,
} from '../types';

interface Props {
  bots: BotConfigLike[];
  botId: string | null;
  onSelectBot: (id: string) => void;
}

export default function MemoryLettaView({ bots, botId, onSelectBot }: Props) {
  const t = useT();
  const [blocks, setBlocks] = useState<MemoryBlockView[]>([]);
  const [status, setStatus] = useState<LettaStatusView | null>(null);
  const [proposals, setProposals] = useState<LettaProposalView[]>([]);
  const [recallHits, setRecallHits] = useState<LettaRecallHitView[]>([]);
  const [archivalHits, setArchivalHits] = useState<LettaArchivalHitView[]>([]);
  const [archivalTotal, setArchivalTotal] = useState(0);
  const [recallQuery, setRecallQuery] = useState('');
  const [archivalQuery, setArchivalQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState('');
  const [sleepRunning, setSleepRunning] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editingId, setEditingId] = useState('');
  const [editContent, setEditContent] = useState('');
  const [appendForId, setAppendForId] = useState('');
  const [appendText, setAppendText] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState('');

  const activeBot = bots.find((b) => b.id === botId) ?? bots[0] ?? null;

  const load = async (id: string | null) => {
    if (!id) {
      setBlocks([]);
      setStatus(null);
      setProposals([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const [list, st, props] = await Promise.all([
        window.openBot.listMemoryBlocks({ botId: id }),
        window.openBot.getMemoryLettaStatus({ botId: id }),
        window.openBot.listMemoryLettaProposals({ botId: id, status: 'pending' }),
      ]);
      setBlocks(list);
      setStatus(st);
      setProposals(props);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memoryLetta.loadError'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(activeBot?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBot?.id]);

  const refresh = () => {
    setNotice('');
    void load(activeBot?.id ?? null);
  };

  const startEdit = (block: MemoryBlockView) => {
    setEditingId(block.id);
    setEditContent(block.content);
    setConfirmDeleteId('');
    setNotice('');
  };

  const saveEdit = async (block: MemoryBlockView) => {
    if (!activeBot) return;
    setError('');
    try {
      const updated = await window.openBot.updateMemoryBlock({
        botId: activeBot.id,
        id: block.id,
        content: editContent,
      });
      setBlocks((prev) => prev.map((b) => (b.id === block.id ? updated : b)));
      setEditingId('');
      setNotice(t('memoryLetta.updated'));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memoryLetta.saveError'));
    }
  };

  const append = async (block: MemoryBlockView) => {
    if (!activeBot || appendText.trim() === '') return;
    setError('');
    try {
      const result = await window.openBot.appendMemoryLettaBlock({
        botId: activeBot.id,
        idOrLabel: block.id,
        text: appendText.trim(),
      });
      setBlocks((prev) => prev.map((b) => (b.id === block.id ? result.block : b)));
      setAppendText('');
      setAppendForId('');
      setNotice(
        result.condensed
          ? t('memoryLetta.appendCondensed')
          : t('memoryLetta.updated'),
      );
      void load(activeBot.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memoryLetta.saveError'));
    }
  };

  const remove = async (block: MemoryBlockView) => {
    if (!activeBot) return;
    setError('');
    try {
      await window.openBot.deleteMemoryBlock({ botId: activeBot.id, id: block.id });
      setBlocks((prev) => prev.filter((b) => b.id !== block.id));
      setConfirmDeleteId('');
      setNotice(t('memoryLetta.updated'));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memoryLetta.saveError'));
    }
  };

  const searchRecall = async () => {
    if (!activeBot) return;
    setError('');
    setSearching('recall');
    try {
      const hits = await window.openBot.searchMemoryLettaRecall({
        botId: activeBot.id,
        query: recallQuery.trim(),
        limit: 10,
      });
      setRecallHits(hits);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memoryLetta.loadError'));
    } finally {
      setSearching('');
    }
  };

  const searchArchival = async () => {
    if (!activeBot) return;
    setError('');
    setSearching('archival');
    try {
      const result = await window.openBot.searchMemoryLettaArchival({
        botId: activeBot.id,
        query: archivalQuery.trim(),
        limit: 10,
        offset: 0,
      });
      setArchivalHits(result.hits);
      setArchivalTotal(result.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memoryLetta.loadError'));
    } finally {
      setSearching('');
    }
  };

  const decideProposal = async (proposal: LettaProposalView, decision: 'approve' | 'reject') => {
    if (!activeBot) return;
    setError('');
    try {
      await window.openBot.decideMemoryLettaProposal({
        botId: activeBot.id,
        proposalId: proposal.id,
        decision,
      });
      setProposals((prev) => prev.filter((p) => p.id !== proposal.id));
      setNotice(t('memoryLetta.decided'));
      void load(activeBot.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memoryLetta.saveError'));
    }
  };

  const runSleep = async () => {
    if (!activeBot) return;
    setError('');
    setSleepRunning(true);
    try {
      const report = await window.openBot.runMemoryLettaSleep({ botId: activeBot.id });
      setNotice(t('memoryLetta.sleepDone'));
      setStatus((prev) =>
        prev === null ? prev : { ...prev, lastSleep: report, proposalsPending: prev.proposalsPending + report.proposalsCreated },
      );
      void load(activeBot.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memoryLetta.saveError'));
    } finally {
      setSleepRunning(false);
    }
  };

  const exportEntity = async () => {
    if (!activeBot) return;
    setError('');
    try {
      const result = await window.openBot.exportMemoryLettaEntity({ botId: activeBot.id });
      setNotice(`${t('memoryLetta.exported')}: ${result.filePath}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memoryLetta.saveError'));
    }
  };

  const usageOf = (block: MemoryBlockView): { fillRatio: number; state: string } => {
    const limit = block.charLimit > 0 ? block.charLimit : 2000;
    const fillRatio = block.content.length / limit;
    return { fillRatio, state: fillRatio >= 0.9 ? 'full' : fillRatio >= 0.7 ? 'warm' : 'ok' };
  };

  return (
    <div>
      <div className="row">
        <label>
          {t('memoryLetta.bot')}{' '}
          <select
            data-testid="memory-letta-bot-select"
            value={activeBot?.id ?? ''}
            onChange={(e) => onSelectBot(e.target.value)}
          >
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <button className="btn secondary" data-testid="memory-letta-refresh" onClick={refresh}>
          {t('memoryLetta.refresh')}
        </button>
      </div>
      <p className="hint">{t('memoryLetta.intro')}</p>
      {loading ? (
        <p className="hint">{t('memoryLetta.loading')}</p>
      ) : !activeBot ? (
        <p className="hint">{t('memoryLetta.noBot')}</p>
      ) : (
        <>
          {error !== '' && <p className="error">{error}</p>}
          {notice !== '' && <p className="notice">{notice}</p>}

          <h3>{t('memoryLetta.statsTitle')}</h3>
          {status && (
            <p className="hint" data-testid="memory-letta-stats">
              {t('memoryLetta.statsLine')
                .replace('{core}', String(status.stats.coreBlocks.length))
                .replace('{recall}', String(status.stats.recallSessions))
                .replace('{archival}', String(status.stats.archivalItems))
                .replace('{pending}', String(status.proposalsPending))}
            </p>
          )}
          <div className="row">
            <button className="btn secondary" data-testid="memory-letta-export" onClick={exportEntity}>
              {t('memoryLetta.exportEntity')}
            </button>
          </div>

          <h3>{t('memoryLetta.coreTitle')}</h3>
          {blocks.length === 0 ? (
            <p className="hint">{t('memoryLetta.blocksEmpty')}</p>
          ) : (
            <ul data-testid="memory-letta-blocks-list">
              {blocks.map((block) => {
                const usage = usageOf(block);
                return (
                  <li key={block.id} data-testid={`memory-letta-block-${block.label}`}>
                    <strong>{block.label}</strong>{' '}
                    <span className="hint">
                      {block.content.length}/{block.charLimit} {t('memoryLetta.chars')} · {usage.state}
                    </span>
                    <div
                      data-testid={`memory-letta-usage-${block.label}`}
                      style={{
                        height: 6,
                        background: usage.state === 'full' ? '#c0392b' : usage.state === 'warm' ? '#e67e22' : '#27ae60',
                        width: `${Math.min(100, Math.round(usage.fillRatio * 100))}%`,
                      }}
                    />
                    {editingId === block.id ? (
                      <div>
                        <textarea
                          data-testid="memory-letta-edit-content"
                          value={editContent}
                          onChange={(e) => setEditContent(e.target.value)}
                          rows={4}
                        />
                        <div className="row">
                          <button className="btn" data-testid="memory-letta-save" onClick={() => void saveEdit(block)}>
                            {t('memoryLetta.save')}
                          </button>
                          <button className="btn secondary" onClick={() => setEditingId('')}>
                            {t('memoryLetta.cancel')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div>
                        <p>{block.content === '' ? `(${t('memoryLetta.emptyBlock')})` : block.content}</p>
                        <div className="row">
                          <button className="btn secondary" data-testid="memory-letta-edit" onClick={() => startEdit(block)}>
                            {t('memoryLetta.edit')}
                          </button>
                          <button
                            className="btn secondary"
                            data-testid="memory-letta-append-toggle"
                            onClick={() => {
                              setAppendForId(appendForId === block.id ? '' : block.id);
                              setAppendText('');
                            }}
                          >
                            {t('memoryLetta.append')}
                          </button>
                          {confirmDeleteId === block.id ? (
                            <button className="btn danger" data-testid="memory-letta-delete-confirm" onClick={() => void remove(block)}>
                              {t('memoryLetta.deleteConfirm')}
                            </button>
                          ) : (
                            <button className="btn secondary" data-testid="memory-letta-delete" onClick={() => setConfirmDeleteId(block.id)}>
                              {t('memoryLetta.delete')}
                            </button>
                          )}
                        </div>
                        {appendForId === block.id && (
                          <div>
                            <textarea
                              data-testid="memory-letta-append-text"
                              value={appendText}
                              onChange={(e) => setAppendText(e.target.value)}
                              placeholder={t('memoryLetta.appendPlaceholder')}
                              rows={2}
                            />
                            <div className="row">
                              <button className="btn" data-testid="memory-letta-append-save" onClick={() => void append(block)}>
                                {t('memoryLetta.append')}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <h3>{t('memoryLetta.recallTitle')}</h3>
          <div className="row">
            <input
              data-testid="memory-letta-recall-query"
              value={recallQuery}
              onChange={(e) => setRecallQuery(e.target.value)}
              placeholder={t('memoryLetta.recallPlaceholder')}
            />
            <button className="btn secondary" data-testid="memory-letta-recall-search" onClick={() => void searchRecall()} disabled={searching === 'recall'}>
              {t('memoryLetta.recallSearch')}
            </button>
          </div>
          {recallHits.length === 0 ? (
            <p className="hint">{t('memoryLetta.recallEmpty')}</p>
          ) : (
            <ul data-testid="memory-letta-recall-list">
              {recallHits.map((hit) => (
                <li key={hit.sessionId}>
                  <span className="hint">[{hit.endedAt.slice(0, 10)} · {hit.turns} turn · score {hit.score.toFixed(2)}]</span>
                  <p>{hit.summary}</p>
                </li>
              ))}
            </ul>
          )}

          <h3>{t('memoryLetta.archivalTitle')}</h3>
          <div className="row">
            <input
              data-testid="memory-letta-archival-query"
              value={archivalQuery}
              onChange={(e) => setArchivalQuery(e.target.value)}
              placeholder={t('memoryLetta.archivalPlaceholder')}
            />
            <button className="btn secondary" data-testid="memory-letta-archival-search" onClick={() => void searchArchival()} disabled={searching === 'archival'}>
              {t('memoryLetta.archivalSearch')}
            </button>
          </div>
          {archivalHits.length === 0 ? (
            <p className="hint">{t('memoryLetta.archivalEmpty')}</p>
          ) : (
            <div>
              <p className="hint">{archivalTotal} {t('memoryLetta.results')}</p>
              <ul data-testid="memory-letta-archival-list">
                {archivalHits.map((hit) => (
                  <li key={hit.item.id}>
                    <span className="hint">[{hit.item.source} · score {hit.score.toFixed(2)}]</span>
                    <p>{hit.item.text}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <h3>{t('memoryLetta.proposalsTitle')}</h3>
          {proposals.length === 0 ? (
            <p className="hint">{t('memoryLetta.proposalsEmpty')}</p>
          ) : (
            <ul data-testid="memory-letta-proposals-list">
              {proposals.map((proposal) => (
                <li key={proposal.id} data-testid={`memory-letta-proposal-${proposal.id}`}>
                  <strong>[{proposal.targetLabel}]</strong> {proposal.proposedLine}
                  <p className="hint">{proposal.reason}</p>
                  <div className="row">
                    <button className="btn" data-testid="memory-letta-proposal-approve" onClick={() => void decideProposal(proposal, 'approve')}>
                      {t('memoryLetta.approve')}
                    </button>
                    <button className="btn secondary" data-testid="memory-letta-proposal-reject" onClick={() => void decideProposal(proposal, 'reject')}>
                      {t('memoryLetta.reject')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <h3>{t('memoryLetta.sleepTitle')}</h3>
          <div className="row">
            <button className="btn" data-testid="memory-letta-sleep-run" onClick={() => void runSleep()} disabled={sleepRunning}>
              {sleepRunning ? t('memoryLetta.sleepRunning') : t('memoryLetta.sleepRun')}
            </button>
          </div>
          {status?.lastSleep && (
            <p className="hint" data-testid="memory-letta-sleep-last">
              {t('memoryLetta.sleepLast')
                .replace('{at}', status.lastSleep.at.slice(0, 19).replace('T', ' '))
                .replace('{facts}', String(status.lastSleep.factsStored))
                .replace('{proposals}', String(status.lastSleep.proposalsCreated))}
            </p>
          )}
        </>
      )}
    </div>
  );
}
