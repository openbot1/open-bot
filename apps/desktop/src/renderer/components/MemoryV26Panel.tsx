import { useMemo, useState } from 'react';
import { useT } from '../i18n/useT';
import type { V26PanelView } from '@open-bot/core';

/**
 * Demo view mirrored locally (v1.44 fix round 4) — the renderer must
 * never value-import @open-bot/core (v1.07 CJS crash: vite inlines the
 * CJS bundle verbatim and the renderer throws at startup). Same data
 * as core `demoMemoryV26PanelView()` in `packages/core/src/memory/v26/panel.ts`;
 * only used when the host hands no snapshot (preview without a store).
 */
function demoMemoryV26PanelViewLocal(): V26PanelView {
  return {
    summary: 'Memory v26: 3 block (3 ban thay duoc), 2 muc luu tru, 1 xung dot mo, 5 muc audit, ~120 token (estimate), tiet kiem 40 token nho curate',
    blocksTotal: 3,
    blocksByKind: { human: 1, persona: 1, task: 1, project: 0, custom: 0 },
    blocksOverBudget: 1,
    blocksWarnBudget: 0,
    conflictsOpen: 1,
    auditTotal: 5,
    archivedTotal: 2,
    templatesTotal: 4,
    tokensTotal: 120,
    tokensSavedByCuration: 40,
    alerts: [
      '1 block vuot budget token: project-alpha — curate ngay.',
      '1 xung dot chua giai quyet: project-alpha — can resolve.',
    ],
    rows: [
      {
        id: 'blk_demo_human', label: 'human', kind: 'human', ownerBotId: 'bot-a',
        attachedBotIds: ['bot-a', 'bot-b'], version: 2, tokens: 30, maxTokens: 2000,
        budgetStatus: 'ok', readOnly: false, hasOpenConflict: false,
        updatedAt: '2026-11-18T10:00:00.000Z', updatedBy: 'bot-a',
        preview: '## Ten\nHuy',
      },
      {
        id: 'blk_demo_project', label: 'project-alpha', kind: 'project', ownerBotId: 'bot-a',
        attachedBotIds: ['bot-a', 'bot-b'], version: 5, tokens: 90, maxTokens: 50,
        budgetStatus: 'over', readOnly: false, hasOpenConflict: true,
        updatedAt: '2026-11-18T11:00:00.000Z', updatedBy: 'bot-b',
        preview: '## Tong quan\nDu an alpha...',
      },
    ],
    hiddenBlocks: 1,
    openConflicts: [
      {
        id: 'cf_demo', label: 'project-alpha', baseVersion: 4, currentVersion: 5,
        by: 'bot-b', currentBy: 'bot-a', detectedAt: '2026-11-18T11:00:00.000Z',
      },
    ],
    recentAudit: [
      {
        id: 'aud_demo', label: 'project-alpha', action: 'write', by: 'bot-a',
        at: '2026-11-18T11:00:00.000Z', fromVersion: 4, toVersion: 5, reason: 'write',
      },
    ],
    recentArchive: [
      {
        id: 'arc_demo', kind: 'block-version', dayKey: '2026-11-18',
        sourceLabel: 'project-alpha', preview: '## Tong quan\nDu an alpha (ban cu)...',
      },
    ],
    quotaSummary: 'Quota bot bot-a: so huu 2/50 block, attach 2/200 block, 120/50000 token',
  };
}

/**
 * Memory v26 panel (v1.41, Doi T1) — shared memory blocks da bot.
 *
 * The panel is a PROJECTION: the core store owns blocks, audit,
 * conflicts and archival; this component only renders the
 * snapshot the host hands it (see core `buildMemoryV26PanelView`
 * / `V26PanelView`). Progressive disclosure: summary + alerts
 * first, block rows / conflicts / audit / archival behind
 * expand toggles, one row per block with its token budget as a
 * bar. A block over budget or with an open conflict is listed
 * up front because it is the thing the user most needs to
 * decide about.
 */

type KindFilter = 'all' | 'human' | 'persona' | 'task' | 'project' | 'custom';

function budgetLabel(status: string, t: (key: string) => string): string {
  if (status === 'over') return t('memoryV26.overBudget');
  if (status === 'warn') return t('memoryV26.warnBudget');
  if (status === 'ok') return t('memoryV26.okBudget');
  return t('memoryV26.unlimitedBudget');
}

export default function MemoryV26Panel({ panel }: { panel?: V26PanelView }) {
  const t = useT();
  const view = useMemo(() => panel ?? demoMemoryV26PanelViewLocal(), [panel]);
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [showBlocks, setShowBlocks] = useState(true);
  const [showConflicts, setShowConflicts] = useState(true);
  const [showAudit, setShowAudit] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [expandedBlock, setExpandedBlock] = useState<string | null>(null);

  const visibleRows = view.rows.filter((r) => kindFilter === 'all' || r.kind === kindFilter);
  const attentionRows = view.rows.filter((r) => r.budgetStatus === 'over' || r.hasOpenConflict);

  return (
    <section aria-label={t('memoryV26.title')} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <header>
        <h2 style={{ margin: 0 }}>{t('memoryV26.title')}</h2>
        <p style={{ margin: '4px 0 0', fontSize: 13 }}>{view.summary}</p>
      </header>

      <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'repeat(4, auto)', gap: '4px 16px', fontSize: 13 }}>
        <dt>{t('memoryV26.blocks')}</dt><dd style={{ margin: 0 }}>{view.blocksTotal}</dd>
        <dt>{t('memoryV26.overBudgetCount')}</dt><dd style={{ margin: 0 }}>{view.blocksOverBudget}</dd>
        <dt>{t('memoryV26.openConflicts')}</dt><dd style={{ margin: 0 }}>{view.conflictsOpen}</dd>
        <dt>{t('memoryV26.archived')}</dt><dd style={{ margin: 0 }}>{view.archivedTotal}</dd>
        <dt>{t('memoryV26.auditTotal')}</dt><dd style={{ margin: 0 }}>{view.auditTotal}</dd>
        <dt>{t('memoryV26.templates')}</dt><dd style={{ margin: 0 }}>{view.templatesTotal}</dd>
        <dt>{t('memoryV26.tokensTotal')}</dt><dd style={{ margin: 0 }}>{view.tokensTotal}</dd>
        <dt>{t('memoryV26.tokensSaved')}</dt><dd style={{ margin: 0 }}>{view.tokensSavedByCuration}</dd>
      </dl>

      <p style={{ margin: 0, fontSize: 12, opacity: 0.8 }}>{view.quotaSummary}</p>

      {view.alerts.length > 0 ? (
        <article style={{ border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: '8px 10px' }}>
          <strong>{t('memoryV26.alerts')}</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 16, fontSize: 13 }}>
            {view.alerts.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </article>
      ) : null}

      {attentionRows.length > 0 ? (
        <article style={{ border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: '8px 10px' }}>
          <strong>{t('memoryV26.needsAttention')}</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 16, fontSize: 13 }}>
            {attentionRows.map((r) => (
              <li key={r.id}>
                {r.label}
                <span style={{ opacity: 0.75 }}>
                  {' — '}
                  {r.budgetStatus === 'over' ? t('memoryV26.overBudget') : ''}
                  {r.budgetStatus === 'over' && r.hasOpenConflict ? ' · ' : ''}
                  {r.hasOpenConflict ? t('memoryV26.hasConflict') : ''}
                </span>
              </li>
            ))}
          </ul>
        </article>
      ) : null}

      <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ fontSize: 13 }}>
          {t('memoryV26.filterKind')}{' '}
          <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value as KindFilter)}>
            <option value="all">{t('memoryV26.filterAll')}</option>
            <option value="human">{t('memoryV26.kindHuman')}</option>
            <option value="persona">{t('memoryV26.kindPersona')}</option>
            <option value="task">{t('memoryV26.kindTask')}</option>
            <option value="project">{t('memoryV26.kindProject')}</option>
            <option value="custom">{t('memoryV26.kindCustom')}</option>
          </select>
        </label>
        <button type="button" onClick={() => setShowBlocks((v) => !v)} style={{ marginLeft: 'auto' }}>
          {showBlocks ? t('memoryV26.hideBlocks') : t('memoryV26.showBlocks')}
        </button>
      </div>

      {showBlocks ? (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', fontSize: 13, border: '1px solid var(--border, #ddd)', borderRadius: 8, paddingLeft: 8, paddingRight: 8 }}>
          {visibleRows.map((row) => {
            const ratio = row.maxTokens > 0 ? Math.min(1, row.tokens / row.maxTokens) : 0;
            const barColor = row.budgetStatus === 'over' ? '#c0392b' : row.budgetStatus === 'warn' ? '#d68910' : '#2e7d32';
            return (
              <li key={row.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--border, #eee)' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <strong>{row.label}</strong>
                  <span style={{ opacity: 0.75 }}>
                    [{row.kind}] v{row.version} · {t('memoryV26.owner')}: {row.ownerBotId} · {row.attachedBotIds.length} {t('memoryV26.attachedBots')}
                    {row.readOnly ? ` · ${t('memoryV26.readOnly')}` : ''}
                  </span>
                  <button type="button" onClick={() => setExpandedBlock((v) => (v === row.id ? null : row.id))} style={{ marginLeft: 'auto' }}>
                    {expandedBlock === row.id ? t('memoryV26.hideDetails') : t('memoryV26.showDetails')}
                  </button>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
                  <div
                    role="progressbar"
                    aria-valuenow={Math.round(ratio * 100)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`${row.label} budget`}
                    style={{ flex: 1, height: 8, borderRadius: 4, background: 'var(--border, #eee)', overflow: 'hidden' }}
                  >
                    <div style={{ width: row.maxTokens > 0 ? `${Math.round(ratio * 100)}%` : '4%', height: '100%', background: barColor }} />
                  </div>
                  <span style={{ fontSize: 12, opacity: 0.85, whiteSpace: 'nowrap' }}>
                    {row.tokens}/{row.maxTokens > 0 ? row.maxTokens : '∞'} {t('memoryV26.tokens')} · {budgetLabel(row.budgetStatus, t)}
                  </span>
                </div>
                <div style={{ fontSize: 12, opacity: 0.75, marginTop: 2 }}>
                  {t('memoryV26.updatedBy')}: {row.updatedBy} · {row.updatedAt}
                </div>
                {expandedBlock === row.id ? (
                  <pre style={{ margin: '6px 0 0', padding: 8, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--background, transparent)', border: '1px solid var(--border, #eee)', borderRadius: 6 }}>
                    {row.preview}
                  </pre>
                ) : null}
              </li>
            );
          })}
          {visibleRows.length === 0 ? <li style={{ padding: '6px 0' }}>{t('memoryV26.empty')}</li> : null}
        </ul>
      ) : null}

      {view.hiddenBlocks > 0 ? (
        <p style={{ margin: 0, fontSize: 12, opacity: 0.8 }}>
          {t('memoryV26.hiddenBlocks', { count: view.hiddenBlocks })}
        </p>
      ) : null}

      {view.openConflicts.length > 0 ? (
        <article style={{ border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: '8px 10px' }}>
          <header style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <strong>{t('memoryV26.conflictsTitle', { count: view.openConflicts.length })}</strong>
            <button type="button" onClick={() => setShowConflicts((v) => !v)} style={{ marginLeft: 'auto' }}>
              {showConflicts ? t('memoryV26.hideDetails') : t('memoryV26.showDetails')}
            </button>
          </header>
          {showConflicts ? (
            <ul style={{ margin: '6px 0 0', paddingLeft: 16, fontSize: 13 }}>
              {view.openConflicts.map((c) => (
                <li key={c.id}>
                  {c.label}: base v{c.baseVersion} → current v{c.currentVersion} ({t('memoryV26.conflictBy')}: {c.by}, {t('memoryV26.conflictCurrentBy')}: {c.currentBy}) · {c.detectedAt}
                </li>
              ))}
            </ul>
          ) : null}
        </article>
      ) : null}

      <article style={{ border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: '8px 10px' }}>
        <header style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <strong>{t('memoryV26.auditTitle')}</strong>
          <button type="button" onClick={() => setShowAudit((v) => !v)} style={{ marginLeft: 'auto' }}>
            {showAudit ? t('memoryV26.hideDetails') : t('memoryV26.showDetails')}
          </button>
        </header>
        {showAudit ? (
          <ul style={{ margin: '6px 0 0', paddingLeft: 16, fontSize: 13 }}>
            {view.recentAudit.map((e) => (
              <li key={e.id}>
                [{e.action} · {e.at}] {e.label} v{e.fromVersion} → v{e.toVersion} ({t('memoryV26.updatedBy')}: {e.by}) — {e.reason}
              </li>
            ))}
            {view.recentAudit.length === 0 ? <li>{t('memoryV26.auditEmpty')}</li> : null}
          </ul>
        ) : null}
      </article>

      <article style={{ border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: '8px 10px' }}>
        <header style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <strong>{t('memoryV26.archiveTitle')}</strong>
          <button type="button" onClick={() => setShowArchive((v) => !v)} style={{ marginLeft: 'auto' }}>
            {showArchive ? t('memoryV26.hideDetails') : t('memoryV26.showDetails')}
          </button>
        </header>
        {showArchive ? (
          <ul style={{ margin: '6px 0 0', paddingLeft: 16, fontSize: 13 }}>
            {view.recentArchive.map((e) => (
              <li key={e.id}>
                [{e.kind} · {e.dayKey}] {e.sourceLabel || t('memoryV26.noSource')}: {e.preview}
              </li>
            ))}
            {view.recentArchive.length === 0 ? <li>{t('memoryV26.archiveEmpty')}</li> : null}
          </ul>
        ) : null}
      </article>
    </section>
  );
}
