import { useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Memory + router panel v12 (v1.15, Team T6) — memory panel (fact
 * list, simple temporal KG view, quarantine review, GDPR erasure)
 * and router panel (loaded models, RAM, routing decision log,
 * budget/spend).
 *
 * Data comes via props (host builds the view-models from core
 * `buildFleetV12MemoryPanel` / `buildFleetV12RouterPanel` /
 * `planFleetV12GdprErasure` via IPC); when there is no host wiring
 * yet it uses an internal demo store — the component never guesses
 * real numbers; the demo is clearly labelled in code. Quarantine
 * review and GDPR erasure only call back to the host (`onQuarantine`,
 * `onErasureConfirm`); the host validates (only `user` may decide)
 * and performs the real store change.
 */

export interface FleetV12MemoryFactRowView {
  id: string;
  text: string;
  confidence: number;
  source: string;
  createdBy: string;
  createdAt: number;
  quarantined: boolean;
  quarantineReason: string;
}

export interface FleetV12KgEntityView {
  id: string;
  name: string;
  kind: string;
  validFrom: string;
  validTo: string;
  superseded: boolean;
  supersededBy: string;
  quarantined: boolean;
}

export interface FleetV12KgRelationView {
  id: string;
  fromId: string;
  toId: string;
  label: string;
  validFrom: string;
  validTo: string;
  superseded: boolean;
  quarantined: boolean;
}

export interface FleetV12MemoryPanelView {
  facts: FleetV12MemoryFactRowView[];
  totalFacts: number;
  quarantinedCount: number;
  entities: FleetV12KgEntityView[];
  relations: FleetV12KgRelationView[];
  activeEntityCount: number;
  supersededCount: number;
  summary: string;
}

export interface FleetV12GdprErasureView {
  userId: string;
  factCount: number;
  entityCount: number;
  relationCount: number;
  quarantinedFactCount: number;
  steps: string[];
  hasData: boolean;
  summary: string;
}

export interface FleetV12RouterModelView {
  modelId: string;
  kind: 'local' | 'cloud';
  status: 'loaded' | 'loading' | 'unloaded' | 'error';
  ramMb: number;
  contextTokens: number;
  requestsServed: number;
  loadedAt: number | null;
}

export interface FleetV12RoutingDecisionView {
  at: number;
  taskKind: string;
  chosenModelId: string;
  reason: string;
  estimatedCostUsd: number;
  latencyMs: number | null;
}

export interface FleetV12RouterPanelView {
  models: FleetV12RouterModelView[];
  loadedCount: number;
  totalRamMb: number;
  ramLimitMb: number;
  ramUsagePct: number | null;
  decisions: FleetV12RoutingDecisionView[];
  totalSpendUsd: number;
  budgetUsd: number;
  spendPct: number | null;
  budgetWarning: string;
  summary: string;
}

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);

export function demoFleetV12MemoryPanel(): FleetV12MemoryPanelView {
  return {
    facts: [
      {
        id: 'f1', text: 'Huy likes black coffee.', confidence: 0.9, source: 'user',
        createdBy: 'user-1', createdAt: T0, quarantined: false, quarantineReason: '',
      },
      {
        id: 'f2', text: 'Huy dislikes noise.', confidence: 0.4, source: 'agent',
        createdBy: 'bot-1', createdAt: T0, quarantined: true, quarantineReason: 'suspected poisoning',
      },
    ],
    totalFacts: 2,
    quarantinedCount: 1,
    entities: [
      { id: 'e1', name: 'Huy', kind: 'person', validFrom: '2026-01-01', validTo: '', superseded: false, supersededBy: '', quarantined: false },
      { id: 'e2', name: 'Old Huy', kind: 'person', validFrom: '2025-01-01', validTo: '2026-01-01', superseded: true, supersededBy: 'e1', quarantined: false },
    ],
    relations: [
      { id: 'r1', fromId: 'e1', toId: 'e3', label: 'likes', validFrom: '2026-01-01', validTo: '', superseded: false, quarantined: false },
    ],
    activeEntityCount: 1,
    supersededCount: 1,
    summary: 'Demo: 2 facts (1 quarantined), 2 KG entities (1 active, 1 superseded).',
  };
}

export function demoFleetV12RouterPanel(): FleetV12RouterPanelView {
  return {
    models: [
      { modelId: 'qwen3-4b-q4_k_m', kind: 'local', status: 'loaded', ramMb: 2600, contextTokens: 32768, requestsServed: 12, loadedAt: T0 },
      { modelId: 'llama-3.2-3b-q4_k_m', kind: 'local', status: 'loaded', ramMb: 1900, contextTokens: 131072, requestsServed: 4, loadedAt: T0 },
    ],
    loadedCount: 2,
    totalRamMb: 4500,
    ramLimitMb: 5000,
    ramUsagePct: 90,
    decisions: [
      { at: T0, taskKind: 'chat', chosenModelId: 'qwen3-4b-q4_k_m', reason: 'local-first', estimatedCostUsd: 0, latencyMs: 120 },
      { at: T0 - 1000, taskKind: 'code', chosenModelId: 'llama-3.2-3b-q4_k_m', reason: 'quality', estimatedCostUsd: 0, latencyMs: 300 },
    ],
    totalSpendUsd: 0,
    budgetUsd: 10,
    spendPct: 0,
    budgetWarning: '',
    summary: 'Demo: 2/2 models loaded, RAM 4500 MB (90% of limit), spend $0.0000 / $10.00 budget, 2 routing decisions.',
  };
}

export function demoFleetV12GdprErasure(): FleetV12GdprErasureView {
  return {
    userId: 'user-1',
    factCount: 1,
    entityCount: 1,
    relationCount: 1,
    quarantinedFactCount: 0,
    steps: [
      'Confirm the identity of user "user-1" (only that user or an admin may request erasure).',
      'Export a copy of the user data before erasing (fact: 1, entity: 1, relation: 1).',
      'Delete 1 fact (including 0 quarantined facts) from the memory store.',
      'Delete 1 entity + 1 relation from the temporal KG.',
      'Write an erasure audit log (userId + time + counts, never the erased content).',
    ],
    hasData: true,
    summary: 'Demo: will erase data of user "user-1": 1 fact, 1 entity, 1 relation.',
  };
}

export default function FleetV12MemoryRouterPanel({
  memoryPanel: memoryPanelProp,
  routerPanel: routerPanelProp,
  erasure: erasureProp,
  onQuarantine,
  onErasureConfirm,
}: {
  memoryPanel?: FleetV12MemoryPanelView | null;
  routerPanel?: FleetV12RouterPanelView | null;
  erasure?: FleetV12GdprErasureView | null;
  onQuarantine?: (factId: string, decision: 'restore' | 'delete') => void;
  onErasureConfirm?: (userId: string) => void;
}) {
  const t = useT();
  const [memoryPanel, setMemoryPanel] = useState<FleetV12MemoryPanelView>(
    () => memoryPanelProp ?? demoFleetV12MemoryPanel(),
  );
  const [routerPanel] = useState<FleetV12RouterPanelView>(
    () => routerPanelProp ?? demoFleetV12RouterPanel(),
  );
  const [erasure] = useState<FleetV12GdprErasureView | null>(
    () => erasureProp ?? demoFleetV12GdprErasure(),
  );
  const [query, setQuery] = useState('');
  const [erasureConfirmed, setErasureConfirmed] = useState(false);

  const visibleFacts = memoryPanel.facts.filter((f) =>
    query.trim() === '' || f.text.toLowerCase().includes(query.trim().toLowerCase()),
  );

  const reviewQuarantine = (factId: string, decision: 'restore' | 'delete') => {
    setMemoryPanel((prev) => ({
      ...prev,
      facts: prev.facts.map((f) =>
        f.id === factId
          ? { ...f, quarantined: false, quarantineReason: '' }
          : f,
      ),
      quarantinedCount: Math.max(0, prev.quarantinedCount - 1),
    }));
    onQuarantine?.(factId, decision);
  };

  const confirmErasure = () => {
    if (!erasure) return;
    setErasureConfirmed(true);
    onErasureConfirm?.(erasure.userId);
  };

  return (
    <div>
      <h3>{t('fleetV12.memoryTitle')}</h3>
      <p>{memoryPanel.summary}</p>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('fleetV12.memoryFacts')}
      />
      <h4>{t('fleetV12.memoryFacts')} ({visibleFacts.length}/{memoryPanel.totalFacts})</h4>
      {visibleFacts.length === 0 ? (
        <p>{t('fleetV12.memoryNoFacts')}</p>
      ) : (
        <ul>
          {visibleFacts.map((f) => (
            <li key={f.id}>
              {f.text} — {Math.round(f.confidence * 100)}% · {f.source}
              {f.quarantined ? (
                <>
                  {' '}({t('fleetV12.memoryQuarantine')}: {f.quarantineReason}){' '}
                  <button type="button" onClick={() => reviewQuarantine(f.id, 'restore')}>{t('fleetV12.memoryRestore')}</button>{' '}
                  <button type="button" onClick={() => reviewQuarantine(f.id, 'delete')}>{t('fleetV12.memoryDelete')}</button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <h4>{t('fleetV12.memoryKg')}</h4>
      <ul>
        {memoryPanel.entities.map((e) => (
          <li key={e.id}>
            {e.name} ({e.kind}){e.validFrom ? ` [${e.validFrom} → ${e.validTo || '…'}]` : ''}
            {e.superseded ? ' (superseded)' : ''}
            {e.quarantined ? ` (${t('fleetV12.memoryQuarantine')})` : ''}
          </li>
        ))}
        {memoryPanel.relations.map((r) => (
          <li key={r.id}>
            {r.fromId} --{r.label}--&gt; {r.toId}
            {r.validFrom ? ` [${r.validFrom} → ${r.validTo || '…'}]` : ''}
            {r.superseded ? ' (superseded)' : ''}
          </li>
        ))}
      </ul>

      {erasure && erasure.hasData && (
        <div>
          <h4>{t('fleetV12.memoryErasure')}</h4>
          <p>{erasure.summary}</p>
          <ol>
            {erasure.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
          {erasureConfirmed ? (
            <p>{t('fleetV12.memoryErasureConfirm')} ✓</p>
          ) : (
            <button type="button" onClick={confirmErasure}>{t('fleetV12.memoryErasureConfirm')}</button>
          )}
        </div>
      )}

      <h3>{t('fleetV12.routerTitle')}</h3>
      <p>{routerPanel.summary}</p>
      {routerPanel.budgetWarning ? <p>{routerPanel.budgetWarning}</p> : null}
      <h4>{t('fleetV12.routerModels')}</h4>
      {routerPanel.models.length === 0 ? (
        <p>{t('fleetV12.routerNoModels')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t('fleetV12.model')}</th>
              <th>{t('fleetV12.routerRam')}</th>
              <th>{t('fleetV12.routerSpend')}</th>
            </tr>
          </thead>
          <tbody>
            {routerPanel.models.map((m) => (
              <tr key={m.modelId}>
                <td>{m.modelId} ({m.kind}, {m.status})</td>
                <td>{m.ramMb} MB</td>
                <td>{m.requestsServed} requests</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p>
        {t('fleetV12.routerRam')}: {routerPanel.totalRamMb} MB
        {routerPanel.ramUsagePct !== null ? ` (${Math.round(routerPanel.ramUsagePct)}%)` : ''} ·{' '}
        {t('fleetV12.routerSpend')}: ${routerPanel.totalSpendUsd.toFixed(4)}
        {routerPanel.budgetUsd > 0 ? ` / $${routerPanel.budgetUsd.toFixed(2)} ${t('fleetV12.routerBudget')}` : ''}
      </p>

      <h4>{t('fleetV12.routerDecisions')}</h4>
      {routerPanel.decisions.length === 0 ? (
        <p>—</p>
      ) : (
        <ul>
          {routerPanel.decisions.map((d, i) => (
            <li key={`${d.at}-${i}`}>
              {d.taskKind} → {d.chosenModelId} ({d.reason})
              {d.latencyMs !== null ? ` · ${d.latencyMs}ms` : ''}
              {d.estimatedCostUsd > 0 ? ` · $${d.estimatedCostUsd.toFixed(4)}` : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
