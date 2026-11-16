import { useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Memory v15 panel (v1.16, Team T6) — fact list (add-only, supersede
 * at read time), hybrid search scores (vector + BM25 + graph +
 * recency), sleep-time reorganize plans.
 *
 * Data comes via props (host builds the view-model from core
 * `buildFleetV13MemoryPanel` via IPC); when there is no host wiring
 * yet it uses an internal demo store — the component never guesses
 * real numbers; the demo is clearly labelled in code.
 */

export interface MemoryV15FactRowView {
  id: string;
  text: string;
  confidence: number;
  source: string;
  createdBy: string;
  createdAt: number;
  active: boolean;
  supersededBy: string;
  quarantined: boolean;
  quarantineReason: string;
}

export interface MemoryV15HybridRowView {
  factId: string;
  score: number;
  vectorScore: number;
  bm25Score: number;
  graphScore: number;
  recencyScore: number;
  explanation: string;
}

export interface MemoryV15ReorganizeRowView {
  blockId: string;
  action: 'merge' | 'split' | 'archive' | 'none';
  reason: string;
  factCount: number;
}

export interface MemoryV15PanelView {
  facts: MemoryV15FactRowView[];
  totalFacts: number;
  activeCount: number;
  supersededCount: number;
  quarantinedCount: number;
  hybridTop: MemoryV15HybridRowView[];
  reorganizePlans: MemoryV15ReorganizeRowView[];
  summary: string;
}

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);

export function demoMemoryV15Panel(): MemoryV15PanelView {
  return {
    facts: [
      {
        id: 'f1', text: 'Huy likes black coffee.', confidence: 0.9, source: 'user',
        createdBy: 'user-1', createdAt: T0, active: true, supersededBy: '', quarantined: false, quarantineReason: '',
      },
      {
        id: 'f2', text: 'Huy likes sweet coffee.', confidence: 0.6, source: 'agent',
        createdBy: 'bot-1', createdAt: T0, active: false, supersededBy: 'f1', quarantined: false, quarantineReason: '',
      },
      {
        id: 'f3', text: 'Huy won the lottery.', confidence: 0.4, source: 'web',
        createdBy: 'bot-1', createdAt: T0, active: false, supersededBy: '', quarantined: true, quarantineReason: 'suspected poisoning',
      },
    ],
    totalFacts: 3,
    activeCount: 1,
    supersededCount: 1,
    quarantinedCount: 1,
    hybridTop: [
      { factId: 'f1', score: 0.92, vectorScore: 0.95, bm25Score: 0.9, graphScore: 0.85, recencyScore: 0.9, explanation: 'vector 95% + BM25 90% + graph 85% + recency 90%' },
    ],
    reorganizePlans: [
      { blockId: 'persona', action: 'merge', reason: 'Demo: 1/2 facts superseded — merge the active facts while idle.', factCount: 2 },
    ],
    summary: 'Demo: 3 facts (1 active, 1 superseded, 1 quarantined); 1 block needs reorganizing while idle.',
  };
}

export default function MemoryV15Panel({
  panel: panelProp,
}: {
  panel?: MemoryV15PanelView | null;
}) {
  const t = useT();
  const [panel] = useState<MemoryV15PanelView>(() => panelProp ?? demoMemoryV15Panel());
  const [query, setQuery] = useState('');
  const [showQuarantined, setShowQuarantined] = useState(true);

  const visibleFacts = panel.facts.filter((f) => {
    if (!showQuarantined && f.quarantined) return false;
    if (query.trim() === '') return true;
    return f.text.toLowerCase().includes(query.trim().toLowerCase());
  });

  return (
    <div>
      <h3>{t('fleetV13.memoryTitle')}</h3>
      <p>{panel.summary}</p>
      <p>{t('fleetV13.demo')}</p>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('fleetV13.memorySearch')}
      />{' '}
      <label>
        <input
          type="checkbox"
          checked={showQuarantined}
          onChange={(e) => setShowQuarantined(e.target.checked)}
        />{' '}
        {t('fleetV13.quarantined')}
      </label>
      <h4>{t('fleetV13.memoryFacts')} ({visibleFacts.length}/{panel.totalFacts})</h4>
      {visibleFacts.length === 0 ? (
        <p>{t('fleetV13.memoryNoFacts')}</p>
      ) : (
        <ul>
          {visibleFacts.map((f) => (
            <li key={f.id}>
              {f.text} — {Math.round(f.confidence * 100)}% · {f.source}
              {f.active ? ` (${t('fleetV13.active')})` : ''}
              {f.supersededBy ? ` (${t('fleetV13.superseded')}: ${f.supersededBy})` : ''}
              {f.quarantined ? ` (${t('fleetV13.quarantined')}: ${f.quarantineReason})` : ''}
            </li>
          ))}
        </ul>
      )}

      <h4>{t('fleetV13.memoryHybrid')}</h4>
      {panel.hybridTop.length === 0 ? (
        <p>—</p>
      ) : (
        <ul>
          {panel.hybridTop.map((h) => (
            <li key={h.factId}>
              {h.factId}: {(h.score * 100).toFixed(0)}% — {h.explanation}
            </li>
          ))}
        </ul>
      )}

      <h4>{t('fleetV13.memoryReorganize')}</h4>
      {panel.reorganizePlans.length === 0 ? (
        <p>—</p>
      ) : (
        <ul>
          {panel.reorganizePlans.map((p) => (
            <li key={p.blockId}>
              {p.blockId} ({p.action}, {p.factCount} facts): {p.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
