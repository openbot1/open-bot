/**
 * Memory blocks editor (v1.08, Team T5 — voice v7 + UI).
 *
 * The v0.96 `MemoryBlocksView` already does block CRUD; this
 * editor is the *version* view on top of it: pick a block, see
 * every version it ever had, diff any two versions line by line,
 * and restore an old version (which writes the old content back
 * as a NEW version — history is never rewritten, like the core
 * `blockHistory` module it reads from).
 *
 * The history comes through `MemoryBlockHistoryProvider` — an
 * interface this panel defines, not a copy of anyone's code:
 *
 *   - The default provider calls `window.openBot
 *     .getMemoryBlockHistory` (IPC `memory-blocks:history`,
 *     backed by core's on-disk `.open-bot/
 *     memory-blocks-history.jsonl`). When the preload has not
 *     exposed it yet, the provider reports "unavailable" and the
 *     editor still works (create / edit / delete + the versions
 *     made in this session).
 *   - The memory-v9 history API (Team T1, running in parallel)
 *     plugs in here later by passing its own provider — the
 *     component never waits for it and never copies its code.
 *
 * Edits made in this editor are appended to the version list
 * in-session (from the update result's new version number), so
 * the version + diff UI works even when the on-disk history is
 * empty or the IPC is not there yet.
 */
import { useEffect, useState } from 'react';
import { useT } from '../i18n/useT';
import type { BotConfigLike, MemoryBlockView } from '../types';
import { diffHunks, diffLines, diffSummary, diffSummaryText, type MemoryBlockDiffLine } from './memoryBlocksDiff';

/** One version of a block (what the history provider returns). */
export interface MemoryBlockVersionView {
  blockId: string;
  label: string;
  version: number;
  content: string;
  description: string;
  charLimit: number;
  readOnly: boolean;
  action: string;
  actor: string;
  at: string;
}

/** History source the editor reads versions from. */
export interface MemoryBlockHistoryProvider {
  getHistory(botId: string, blockId: string): Promise<MemoryBlockVersionView[]>;
  /** False when the provider cannot read history at all. */
  available(): boolean;
}

/** Default provider: the main-process history IPC (may be absent on old preloads). */
export function defaultMemoryBlockHistoryProvider(): MemoryBlockHistoryProvider {
  const api = window.openBot as unknown as {
    getMemoryBlockHistory?: (payload: {
      botId: string;
      blockId: string;
      limit?: number;
    }) => Promise<MemoryBlockVersionView[]>;
  };
  return {
    available(): boolean {
      return typeof api.getMemoryBlockHistory === 'function';
    },
    async getHistory(botId: string, blockId: string): Promise<MemoryBlockVersionView[]> {
      if (typeof api.getMemoryBlockHistory !== 'function') return [];
      const rows = await api.getMemoryBlockHistory({ botId, blockId, limit: 50 });
      if (!Array.isArray(rows)) return [];
      return rows.filter(
        (r): r is MemoryBlockVersionView =>
          !!r && typeof r.version === 'number' && typeof r.content === 'string',
      );
    },
  };
}

interface Props {
  bots: BotConfigLike[];
  botId: string | null;
  onSelectBot: (id: string) => void;
  /** History source (defaults to the IPC provider above). */
  historyProvider?: MemoryBlockHistoryProvider;
}

function asVersion(block: MemoryBlockView, action: string, actor: string): MemoryBlockVersionView {
  return {
    blockId: block.id,
    label: block.label,
    version: block.version,
    content: block.content,
    description: block.description,
    charLimit: block.charLimit,
    readOnly: block.readOnly,
    action,
    actor,
    at: block.updatedAt,
  };
}

export default function MemoryBlocksEditor({ bots, botId, onSelectBot, historyProvider }: Props) {
  const t = useT();
  const provider = historyProvider ?? defaultMemoryBlockHistoryProvider();
  const [blocks, setBlocks] = useState<MemoryBlockView[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [history, setHistory] = useState<MemoryBlockVersionView[]>([]);
  const [historyAvailable, setHistoryAvailable] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newContent, setNewContent] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState('');
  const [compareA, setCompareA] = useState<number | null>(null);
  const [compareB, setCompareB] = useState<number | null>(null);

  const activeBot = bots.find((b) => b.id === botId) ?? bots[0] ?? null;
  const selected = blocks.find((b) => b.id === selectedId) ?? null;

  const loadBlocks = async (id: string | null) => {
    if (!id) {
      setBlocks([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const list = await window.openBot.listMemoryBlocks({ botId: id, includeDetached: true });
      setBlocks(list);
      if (selectedId === '' && list.length > 0) setSelectedId(list[0]!.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memoryBlockEditor.loadError'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadBlocks(activeBot?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBot?.id]);

  const loadHistory = async (block: MemoryBlockView) => {
    setHistoryLoading(true);
    setHistory([]);
    setCompareA(null);
    setCompareB(null);
    setEditContent(block.content);
    setEditDescription(block.description);
    setConfirmDeleteId('');
    if (!provider.available()) {
      setHistoryAvailable(false);
      setHistory([asVersion(block, 'current', 'user')]);
      setHistoryLoading(false);
      return;
    }
    setHistoryAvailable(true);
    try {
      const rows = await provider.getHistory(activeBot!.id, block.id);
      // The on-disk history may not include the live version yet
      // (it is written on update, and the live block may be newer
      // than the last snapshot) — always show the live version on
      // top so the diff has a "now" side.
      const merged = [...rows];
      if (!merged.some((r) => r.version === block.version)) {
        merged.push(asVersion(block, 'current', 'user'));
      }
      merged.sort((a, b) => a.version - b.version);
      setHistory(merged);
      if (merged.length >= 2) {
        setCompareA(merged[merged.length - 2]!.version);
        setCompareB(merged[merged.length - 1]!.version);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memoryBlockEditor.historyError'));
      setHistory([asVersion(block, 'current', 'user')]);
    } finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => {
    if (selected) void loadHistory(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  const refresh = () => {
    setNotice('');
    void loadBlocks(activeBot?.id ?? null);
  };

  const create = async () => {
    if (!activeBot) return;
    setError('');
    try {
      const created = await window.openBot.createMemoryBlock({
        botId: activeBot.id,
        label: newLabel.trim(),
        content: newContent,
      });
      setBlocks((prev) => [...prev, created].sort((a, b) => a.label.localeCompare(b.label)));
      setNewLabel('');
      setNewContent('');
      setSelectedId(created.id);
      setNotice(t('memoryBlockEditor.created'));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memoryBlockEditor.createError'));
    }
  };

  const saveEdit = async () => {
    if (!activeBot || !selected) return;
    setError('');
    try {
      const updated = await window.openBot.updateMemoryBlock({
        botId: activeBot.id,
        id: selected.id,
        content: editContent,
        description: editDescription,
      });
      setBlocks((prev) => prev.map((b) => (b.id === selected.id ? updated : b)));
      // The edit is a new version: append it in-session so the
      // version list + diff show it at once, even before the
      // on-disk history is re-read.
      setHistory((prev) => {
        if (prev.some((v) => v.version === updated.version)) return prev;
        const next = [...prev, asVersion(updated, 'update', 'user')].sort((a, b) => a.version - b.version);
        return next;
      });
      setCompareA(selected.version);
      setCompareB(updated.version);
      setNotice(t('memoryBlockEditor.updated'));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memoryBlockEditor.saveError'));
    }
  };

  const remove = async (block: MemoryBlockView) => {
    if (!activeBot) return;
    setError('');
    try {
      const res = await window.openBot.deleteMemoryBlock({ botId: activeBot.id, id: block.id });
      if (res.deleted) {
        setBlocks((prev) => prev.filter((b) => b.id !== block.id));
        if (selectedId === block.id) {
          setSelectedId('');
          setHistory([]);
        }
        setNotice(t('memoryBlockEditor.deleted'));
      } else {
        setError(t('memoryBlockEditor.deleteError'));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memoryBlockEditor.deleteError'));
    } finally {
      setConfirmDeleteId('');
    }
  };

  const restore = async (version: MemoryBlockVersionView) => {
    if (!activeBot || !selected) return;
    setError('');
    try {
      const updated = await window.openBot.updateMemoryBlock({
        botId: activeBot.id,
        id: selected.id,
        content: version.content,
        description: version.description,
      });
      setBlocks((prev) => prev.map((b) => (b.id === selected.id ? updated : b)));
      setHistory((prev) => {
        if (prev.some((v) => v.version === updated.version)) return prev;
        return [...prev, asVersion(updated, 'restore', 'user')].sort((a, b) => a.version - b.version);
      });
      setEditContent(version.content);
      setEditDescription(version.description);
      setCompareA(version.version);
      setCompareB(updated.version);
      setNotice(t('memoryBlockEditor.restored', { version: String(version.version) }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memoryBlockEditor.restoreError'));
    }
  };

  const versionA = history.find((v) => v.version === compareA) ?? null;
  const versionB = history.find((v) => v.version === compareB) ?? null;
  const diff: MemoryBlockDiffLine[] =
    versionA && versionB && versionA.version !== versionB.version
      ? diffLines(versionA.content, versionB.content)
      : [];
  const summary = diffSummary(diff);
  const hunks = diffHunks(diff, 2);

  return (
    <div>
      <p className="hint">{t('memoryBlockEditor.intro')}</p>
      <p className="hint">{t('memoryBlockEditor.localOnly')}</p>
      <div className="row">
        <label>
          {t('memoryBlockEditor.bot')}
          <select
            value={activeBot?.id ?? ''}
            data-testid="memory-editor-bot-select"
            onChange={(e) => onSelectBot(e.target.value)}
          >
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <button className="btn secondary" data-testid="memory-editor-refresh" onClick={refresh} disabled={!activeBot}>
          {t('memoryBlockEditor.refresh')}
        </button>
      </div>
      {loading && <p className="hint">{t('memoryBlockEditor.loading')}</p>}
      {error && <p className="error">{error}</p>}
      {notice && <p className="hint" data-testid="memory-editor-notice">{notice}</p>}
      {!loading && !activeBot && <p className="hint">{t('memoryBlockEditor.noBot')}</p>}
      {activeBot && (
        <>
          <h3>{t('memoryBlockEditor.createTitle')}</h3>
          <div className="row">
            <label style={{ flex: 1 }}>
              {t('memoryBlockEditor.label')}
              <input
                type="text"
                value={newLabel}
                data-testid="memory-editor-new-label"
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder={t('memoryBlockEditor.labelPlaceholder')}
              />
            </label>
            <label style={{ flex: 2 }}>
              {t('memoryBlockEditor.content')}
              <input
                type="text"
                value={newContent}
                data-testid="memory-editor-new-content"
                onChange={(e) => setNewContent(e.target.value)}
                placeholder={t('memoryBlockEditor.contentPlaceholder')}
              />
            </label>
            <button className="btn" data-testid="memory-editor-create" onClick={() => void create()} disabled={newLabel.trim() === ''}>
              {t('memoryBlockEditor.create')}
            </button>
          </div>
          {!loading && blocks.length === 0 && (
            <p className="hint" data-testid="memory-editor-empty">{t('memoryBlockEditor.empty')}</p>
          )}
          {blocks.length > 0 && (
            <div className="row">
              <label>
                {t('memoryBlockEditor.block')}
                <select
                  value={selectedId}
                  data-testid="memory-editor-block-select"
                  onChange={(e) => setSelectedId(e.target.value)}
                >
                  {blocks.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.label} (v{b.version})
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {selected && (
            <div data-testid="memory-editor-detail">
              <h3>{selected.label}</h3>
              <p className="hint">
                {t('memoryBlockEditor.meta', {
                  version: String(selected.version),
                  used: String(selected.content.length),
                  limit: String(selected.charLimit),
                  updated: selected.updatedAt.slice(0, 10),
                })}
                {selected.readOnly ? ` · ${t('memoryBlockEditor.readOnly')}` : ''}
              </p>
              <label>
                {t('memoryBlockEditor.description')}
                <input
                  type="text"
                  value={editDescription}
                  data-testid="memory-editor-edit-description"
                  onChange={(e) => setEditDescription(e.target.value)}
                  disabled={selected.readOnly}
                />
              </label>
              <label>
                {t('memoryBlockEditor.content')}
                <textarea
                  value={editContent}
                  data-testid="memory-editor-edit-content"
                  onChange={(e) => setEditContent(e.target.value)}
                  rows={5}
                  disabled={selected.readOnly}
                />
              </label>
              <div className="row">
                <button
                  className="btn"
                  data-testid="memory-editor-save"
                  onClick={() => void saveEdit()}
                  disabled={selected.readOnly || editContent === selected.content}
                >
                  {t('memoryBlockEditor.save')}
                </button>
                {confirmDeleteId === selected.id ? (
                  <>
                    <button className="btn" data-testid="memory-editor-delete-confirm" onClick={() => void remove(selected)}>
                      {t('memoryBlockEditor.deleteConfirm')}
                    </button>
                    <button className="btn secondary" onClick={() => setConfirmDeleteId('')}>
                      {t('memoryBlockEditor.cancel')}
                    </button>
                  </>
                ) : (
                  <button
                    className="btn secondary"
                    data-testid="memory-editor-delete"
                    onClick={() => setConfirmDeleteId(selected.id)}
                    disabled={selected.readOnly}
                  >
                    {t('memoryBlockEditor.delete')}
                  </button>
                )}
              </div>

              <h3>{t('memoryBlockEditor.historyTitle')}</h3>
              {!historyAvailable && (
                <p className="hint" data-testid="memory-editor-history-unavailable">
                  {t('memoryBlockEditor.historyUnavailable')}
                </p>
              )}
              {historyLoading && <p className="hint">{t('memoryBlockEditor.historyLoading')}</p>}
              {!historyLoading && history.length === 0 && (
                <p className="hint">{t('memoryBlockEditor.historyEmpty')}</p>
              )}
              {history.length > 0 && (
                <>
                  <ul data-testid="memory-editor-history-list">
                    {history.map((v) => (
                      <li key={v.version}>
                        <strong>v{v.version}</strong> · {v.action} · {v.actor} · {v.at.slice(0, 19).replace('T', ' ')}
                        {v.version !== selected.version && (
                          <button
                            className="btn secondary"
                            style={{ marginLeft: 8, padding: '2px 8px', fontSize: 12 }}
                            data-testid={`memory-editor-restore-${v.version}`}
                            onClick={() => void restore(v)}
                            disabled={selected.readOnly}
                          >
                            {t('memoryBlockEditor.restore')}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                  {history.length >= 2 && (
                    <>
                      <h3>{t('memoryBlockEditor.diffTitle')}</h3>
                      <div className="row">
                        <label>
                          {t('memoryBlockEditor.compareA')}
                          <select
                            value={compareA ?? ''}
                            data-testid="memory-editor-compare-a"
                            onChange={(e) => setCompareA(Number(e.target.value))}
                          >
                            {history.map((v) => (
                              <option key={v.version} value={v.version}>
                                v{v.version}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          {t('memoryBlockEditor.compareB')}
                          <select
                            value={compareB ?? ''}
                            data-testid="memory-editor-compare-b"
                            onChange={(e) => setCompareB(Number(e.target.value))}
                          >
                            {history.map((v) => (
                              <option key={v.version} value={v.version}>
                                v{v.version}
                              </option>
                            ))}
                          </select>
                        </label>
                        <span className="hint" data-testid="memory-editor-diff-summary">
                          {versionA && versionB && versionA.version !== versionB.version
                            ? diffSummaryText(summary)
                            : t('memoryBlockEditor.diffSame')}
                        </span>
                      </div>
                      {versionA && versionB && versionA.version !== versionB.version && (
                        <div data-testid="memory-editor-diff" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 8 }}>
                          {hunks.length === 0 && <p className="hint">{t('memoryBlockEditor.diffSame')}</p>}
                          {hunks.map((hunk, hi) => (
                            <div key={hi} style={{ marginBottom: 8 }}>
                              {hunk.map((row, ri) => (
                                <pre
                                  key={ri}
                                  style={{
                                    margin: 0,
                                    padding: '2px 6px',
                                    fontSize: 12,
                                    whiteSpace: 'pre-wrap',
                                    wordBreak: 'break-word',
                                    background:
                                      row.type === 'add' ? '#e6f4ea' : row.type === 'del' ? '#fdecea' : 'transparent',
                                    color: row.type === 'add' ? '#137333' : row.type === 'del' ? '#a50e0e' : 'inherit',
                                  }}
                                >
                                  {row.type === 'add' ? '+ ' : row.type === 'del' ? '− ' : '  '}
                                  {row.text}
                                </pre>
                              ))}
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
