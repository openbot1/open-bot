import { useMemo, useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Memory panel v11 (v1.14, Team T6) — a SEPARATE panel for memory, not crammed
 * into the main chat screen: view blocks, version history, rollback, ACL.
 *
 * Continues MemoryV11View (blocks v11): this panel adds version history for
 * each block (from `memory/blockHistory.ts`), rollback to a version,
 * and ACL badges (who may edit/delete/restore — system blocks are user-only).
 * Data comes via props `blocks` + `historyByBlockId` (host builds them from core
 * `buildFleetV11MemoryPanel` + IPC); when there is no host wiring yet it uses
 * an internal demo store — the component never guesses real memory content.
 */

export interface MemoryPanelV11Block {
  id: string;
  label: string;
  description: string;
  content: string;
  charLimit: number;
  readOnly: boolean;
  systemOwned?: boolean;
  createdByBotId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryPanelV11Version {
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

const T0 = '2026-11-16T00:00:00.000Z';

export function demoMemoryPanelV11Blocks(): MemoryPanelV11Block[] {
  return [
    {
      id: 'blk-human', label: 'human', description: 'About the user.',
      content: 'Name Huy. Likes building large software, local-first.',
      charLimit: 2000, readOnly: false, systemOwned: true, createdByBotId: '',
      version: 3, createdAt: T0, updatedAt: T0,
    },
    {
      id: 'blk-persona', label: 'persona', description: 'Bot personality.',
      content: 'Direct, practical assistant, speaks Vietnamese.',
      charLimit: 2000, readOnly: false, systemOwned: true, createdByBotId: '',
      version: 2, createdAt: T0, updatedAt: T0,
    },
    {
      id: 'blk-food', label: 'so-thich-an-uong', description: 'Food preferences.',
      content: 'Likes pho bo, iced milk coffee.',
      charLimit: 2000, readOnly: false, systemOwned: false, createdByBotId: '',
      version: 2, createdAt: T0, updatedAt: T0,
    },
    {
      id: 'blk-locked', label: 'quy-tac-nha', description: 'Locked rules.',
      content: 'Do not post anything to Facebook before approval.',
      charLimit: 2000, readOnly: true, systemOwned: false, createdByBotId: '',
      version: 1, createdAt: T0, updatedAt: T0,
    },
  ];
}

export function demoMemoryPanelV11History(): Record<string, MemoryPanelV11Version[]> {
  return {
    'blk-human': [
      { blockId: 'blk-human', label: 'human', version: 1, content: 'Name Huy.', description: 'About the user.', charLimit: 2000, readOnly: false, action: 'create', actor: 'user', at: T0 },
      { blockId: 'blk-human', label: 'human', version: 2, content: 'Name Huy. Likes building large software.', description: 'About the user.', charLimit: 2000, readOnly: false, action: 'update', actor: 'user', at: T0 },
      { blockId: 'blk-human', label: 'human', version: 3, content: 'Name Huy. Likes building large software, local-first.', description: 'About the user.', charLimit: 2000, readOnly: false, action: 'update', actor: 'user', at: T0 },
    ],
    'blk-food': [
      { blockId: 'blk-food', label: 'so-thich-an-uong', version: 1, content: 'Likes pho bo.', description: 'Food preferences.', charLimit: 2000, readOnly: false, action: 'create', actor: 'user', at: T0 },
      { blockId: 'blk-food', label: 'so-thich-an-uong', version: 2, content: 'Likes pho bo, iced milk coffee.', description: 'Food preferences.', charLimit: 2000, readOnly: false, action: 'update', actor: 'user', at: T0 },
    ],
  };
}

type Filter = 'all' | 'system' | 'user' | 'read-only';

export default function MemoryPanelV11({
  blocks: blocksProp,
  historyByBlockId: historyProp,
  actor = 'user',
}: {
  blocks?: MemoryPanelV11Block[] | null;
  historyByBlockId?: Record<string, MemoryPanelV11Version[]> | null;
  actor?: string;
}) {
  const t = useT();
  const [blocks, setBlocks] = useState<MemoryPanelV11Block[]>(
    () => blocksProp ?? demoMemoryPanelV11Blocks(),
  );
  const [historyByBlockId, setHistoryByBlockId] = useState<Record<string, MemoryPanelV11Version[]>>(
    () => historyProp ?? demoMemoryPanelV11History(),
  );
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmVersion, setConfirmVersion] = useState<number | null>(null);
  const [notice, setNotice] = useState('');

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return blocks.filter((b) => {
      if (filter === 'system' && !b.systemOwned) return false;
      if (filter === 'user' && b.systemOwned) return false;
      if (filter === 'read-only' && !b.readOnly) return false;
      if (needle && !`${b.label} ${b.description} ${b.content}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [blocks, filter, query]);

  const selected = blocks.find((b) => b.id === selectedId) ?? null;
  const history = selected ? [...(historyByBlockId[selected.id] ?? [])].sort((a, b) => b.version - a.version) : [];

  /** ACL (mirrors core `checkFleetV11MemoryAcl`): systemOwned is user-only; readOnly cannot edit. */
  const aclFor = (b: MemoryPanelV11Block): { canEdit: boolean; canRestore: boolean; deniedReason: string } => {
    if (b.systemOwned && actor !== 'user') {
      return { canEdit: false, canRestore: false, deniedReason: t('memoryPanelV11.systemOwned') };
    }
    if (b.readOnly) {
      return { canEdit: false, canRestore: actor === 'user', deniedReason: t('memoryPanelV11.readOnly') };
    }
    return { canEdit: true, canRestore: true, deniedReason: '' };
  };

  const rollbackTo = (version: number) => {
    if (!selected) return;
    const snapshot = (historyByBlockId[selected.id] ?? []).find((s) => s.version === version);
    if (!snapshot) return;
    const nextVersion = selected.version + 1;
    setBlocks((prev) =>
      prev.map((b) =>
        b.id === selected.id
          ? { ...b, content: snapshot.content, description: snapshot.description, version: nextVersion, updatedAt: new Date().toISOString() }
          : b,
      ),
    );
    setHistoryByBlockId((prev) => ({
      ...prev,
      [selected.id]: [
        ...(prev[selected.id] ?? []),
        {
          blockId: selected.id, label: selected.label, version: nextVersion,
          content: snapshot.content, description: snapshot.description,
          charLimit: selected.charLimit, readOnly: selected.readOnly,
          action: 'restore', actor, at: new Date().toISOString(),
        },
      ],
    }));
    setConfirmVersion(null);
    setNotice(t('memoryPanelV11.rollbackDone', { version }));
  };

  return (
    <div>
      <h3>{t('memoryPanelV11.title')}</h3>
      <p className="hint">{t('memoryPanelV11.subtitle')}</p>
      <div className="row">
        <input
          type="text"
          value={query}
          placeholder={t('memoryPanelV11.searchPlaceholder')}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={t('memoryPanelV11.searchPlaceholder')}
        />
        {(['all', 'system', 'user', 'read-only'] as Filter[]).map((f) => (
          <button
            key={f}
            className="btn secondary"
            disabled={filter === f}
            onClick={() => setFilter(f)}
          >
            {f === 'all'
              ? t('memoryPanelV11.filterAll')
              : f === 'system'
                ? t('memoryPanelV11.filterSystem')
                : f === 'user'
                  ? t('memoryPanelV11.filterUser')
                  : t('memoryPanelV11.filterReadOnly')}
          </button>
        ))}
      </div>
      <p className="hint">
        {rows.length}/{blocks.length} {t('memoryPanelV11.blocks')}
      </p>
      {rows.length === 0 ? (
        <p className="hint">{t('memoryPanelV11.noBlocks')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Label</th>
              <th>{t('memoryPanelV11.version')}</th>
              <th>{t('memoryPanelV11.aclTitle')}</th>
              <th>{t('memoryPanelV11.updatedAt')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => {
              const acl = aclFor(b);
              return (
                <tr key={b.id} onClick={() => { setSelectedId(b.id); setNotice(''); setConfirmVersion(null); }} style={{ cursor: 'pointer' }}>
                  <td>
                    <strong>{b.label}</strong>
                    {b.systemOwned ? <div className="hint">{t('memoryPanelV11.systemOwned')}</div> : null}
                    {b.readOnly ? <div className="hint">{t('memoryPanelV11.readOnly')}</div> : null}
                    {b.content.length > b.charLimit ? (
                      <div className="hint">{t('memoryPanelV11.overLimit')}</div>
                    ) : null}
                    <div className="hint">{b.description}</div>
                  </td>
                  <td>v{b.version}</td>
                  <td>
                    {t('memoryPanelV11.aclTitle')}:{' '}
                    {acl.canEdit ? t('memoryPanelV11.aclAllowed') : t('memoryPanelV11.aclDenied')}
                    {acl.deniedReason ? <div className="hint">{acl.deniedReason}</div> : null}
                  </td>
                  <td>{new Date(b.updatedAt).toLocaleString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {selected ? (
        <div>
          <h4>
            {selected.label} — {t('memoryPanelV11.history')}
          </h4>
          <p className="hint">
            {t('memoryPanelV11.content')}: {selected.content}
          </p>
          {history.length === 0 ? (
            <p className="hint">{t('memoryPanelV11.historyEmpty')}</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{t('memoryPanelV11.version')}</th>
                  <th>Action</th>
                  <th>{t('memoryPanelV11.createdBy')}</th>
                  <th>{t('memoryPanelV11.updatedAt')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {history.map((s) => {
                  const acl = aclFor(selected);
                  const isCurrent = s.version === selected.version;
                  return (
                    <tr key={s.version}>
                      <td>v{s.version}{isCurrent ? ' (current)' : ''}</td>
                      <td>{s.action}</td>
                      <td>{s.actor}</td>
                      <td>{new Date(s.at).toLocaleString()}</td>
                      <td>
                        {!isCurrent && acl.canRestore ? (
                          confirmVersion === s.version ? (
                            <span>
                              {t('memoryPanelV11.rollbackConfirm', { version: s.version })}{' '}
                              <button className="btn secondary" onClick={() => rollbackTo(s.version)}>
                                {t('memoryPanelV11.rollback')}
                              </button>{' '}
                              <button className="btn secondary" onClick={() => setConfirmVersion(null)}>
                                {t('fleet.cancel')}
                              </button>
                            </span>
                          ) : (
                            <button className="btn secondary" onClick={() => setConfirmVersion(s.version)}>
                              {t('memoryPanelV11.restoreVersion')}
                            </button>
                          )
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {notice ? <p className="hint">{notice}</p> : null}
        </div>
      ) : (
        <p className="hint">{t('memoryPanelV11.selectBlock')}</p>
      )}
    </div>
  );
}
