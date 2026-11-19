import { useMemo, useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Fleet v26 memory panel (v1.39, Team T6) — MemFS tree + evidence +
 * admission, for the new memory (memory v24, Team T1).
 *
 * The panel is a PROJECTION: MemFS owns the tree, the evidence, and
 * admission; this component only renders the snapshot the host hands
 * it (see core `buildFleetV26MemoryPanel` / `FleetV26MemFsNode`).
 * Progressive disclosure: counts + orphans first, the full tree
 * behind an expand toggle, one row per node with its depth as indent.
 * A fact without evidence that is still pending admission is an
 * orphan — it is listed up front because it is the thing the user
 * most needs to decide about.
 */

export interface FleetV26MemoryRowView {
  id: string;
  name: string;
  kind: 'folder' | 'fact' | 'block';
  depth: number;
  hasEvidence: boolean;
  admission: 'admitted' | 'pending' | 'denied';
  childrenCount: number;
}

export interface FleetV26MemoryPanelView {
  summary: string;
  nodes: number;
  folders: number;
  facts: number;
  blocks: number;
  withEvidence: number;
  withoutEvidence: number;
  admitted: number;
  pending: number;
  denied: number;
  maxDepth: number;
  orphans: FleetV26MemoryRowView[];
  rows: FleetV26MemoryRowView[];
  admissionSummary: string;
}

export function demoFleetV26MemoryPanel(): FleetV26MemoryPanelView {
  const rows: FleetV26MemoryRowView[] = [
    { id: 'root', name: 'memory', kind: 'folder', depth: 0, hasEvidence: false, admission: 'admitted', childrenCount: 2 },
    { id: 'fact-plan', name: 'Current plan: ship v1.39', kind: 'fact', depth: 1, hasEvidence: true, admission: 'admitted', childrenCount: 0 },
    { id: 'fact-idea', name: 'Idea: fleet skill marketplace', kind: 'fact', depth: 1, hasEvidence: false, admission: 'pending', childrenCount: 0 },
  ];
  return {
    summary: 'MemFS: 3 node(s) (1 folders, 2 facts, 0 blocks), 1 with evidence, 2 without; admission 1 admitted / 1 pending / 0 denied; max depth 1',
    nodes: 3, folders: 1, facts: 2, blocks: 0,
    withEvidence: 1, withoutEvidence: 2,
    admitted: 1, pending: 1, denied: 0, maxDepth: 1,
    orphans: [rows[2]],
    rows,
    admissionSummary: 'Admission (default ask; memory-v24:ask; evidence for memory required): 1 decision(s) — 0 admitted, 1 asked, 0 denied',
  };
}

type AdmissionFilter = 'all' | 'admitted' | 'pending' | 'denied';

export default function FleetV26MemoryPanel({ panel }: { panel?: FleetV26MemoryPanelView }) {
  const t = useT();
  const view = useMemo(() => panel ?? demoFleetV26MemoryPanel(), [panel]);
  const [filter, setFilter] = useState<AdmissionFilter>('all');
  const [showTree, setShowTree] = useState(false);
  const [showOrphans, setShowOrphans] = useState(true);

  const visible = view.rows.filter((r) => filter === 'all' || r.admission === filter);

  return (
    <section aria-label={t('fleet.v26.memory')} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <header>
        <h2 style={{ margin: 0 }}>{t('fleet.v26.memory')}</h2>
        <p style={{ margin: '4px 0 0', fontSize: 13 }}>{view.summary}</p>
      </header>

      <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'repeat(4, auto)', gap: '4px 16px', fontSize: 13 }}>
        <dt>{t('fleet.v26.memoryNodes')}</dt><dd style={{ margin: 0 }}>{view.nodes}</dd>
        <dt>{t('fleet.v26.memoryWithEvidence')}</dt><dd style={{ margin: 0 }}>{view.withEvidence}</dd>
        <dt>{t('fleet.v26.memoryPending')}</dt><dd style={{ margin: 0 }}>{view.pending}</dd>
        <dt>{t('fleet.v26.memoryOrphans')}</dt><dd style={{ margin: 0 }}>{view.orphans.length}</dd>
      </dl>

      <p style={{ margin: 0, fontSize: 12, opacity: 0.8 }}>{view.admissionSummary}</p>

      {view.orphans.length > 0 ? (
        <article style={{ border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: '8px 10px' }}>
          <header style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <strong>{t('fleet.v26.memoryOrphansTitle', { count: view.orphans.length })}</strong>
            <button type="button" onClick={() => setShowOrphans((v) => !v)} style={{ marginLeft: 'auto' }}>
              {showOrphans ? t('fleet.v26.hideDetails') : t('fleet.v26.showDetails')}
            </button>
          </header>
          {showOrphans ? (
            <ul style={{ margin: '6px 0 0', paddingLeft: 16, fontSize: 13 }}>
              {view.orphans.map((o) => (
                <li key={o.id}>
                  {o.name} <span style={{ opacity: 0.7 }}>— {t('fleet.v26.memoryNoEvidence')}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </article>
      ) : null}

      <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ fontSize: 13 }}>
          {t('fleet.v26.memoryFilterAdmission')}{' '}
          <select value={filter} onChange={(e) => setFilter(e.target.value as AdmissionFilter)}>
            <option value="all">{t('fleet.v26.filterAll')}</option>
            <option value="admitted">{t('fleet.v26.admissionAdmitted')}</option>
            <option value="pending">{t('fleet.v26.admissionPending')}</option>
            <option value="denied">{t('fleet.v26.admissionDenied')}</option>
          </select>
        </label>
        <button type="button" onClick={() => setShowTree((v) => !v)} style={{ marginLeft: 'auto' }}>
          {showTree ? t('fleet.v26.hideTree') : t('fleet.v26.showTree')}
        </button>
      </div>

      {showTree ? (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', fontSize: 13, border: '1px solid var(--border, #ddd)', borderRadius: 8, paddingLeft: 8, paddingRight: 8 }}>
          {visible.map((row) => (
            <li key={row.id} style={{ padding: '4px 0 4px', paddingLeft: row.depth * 18, borderBottom: '1px solid var(--border, #eee)' }}>
              <span style={{ marginRight: 6 }}>{row.kind === 'folder' ? '▸' : row.kind === 'block' ? '▣' : '•'}</span>
              <span>{row.name}</span>
              <span style={{ marginLeft: 8, fontSize: 12, opacity: 0.75 }}>
                {t(`fleet.v26.admission.${row.admission}`)}
                {row.hasEvidence ? ` · ${t('fleet.v26.memoryHasEvidence')}` : ` · ${t('fleet.v26.memoryNoEvidence')}`}
                {row.childrenCount > 0 ? ` · ${row.childrenCount}` : ''}
              </span>
            </li>
          ))}
          {visible.length === 0 ? <li style={{ padding: '6px 0' }}>{t('fleet.v26.memoryEmpty')}</li> : null}
        </ul>
      ) : null}
    </section>
  );
}
