import { useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Router v29 panel (v1.42, Team T5) — model catalog refresh, routing
 * decision, per-model cost ledger, fallback chain and provider health.
 *
 * Data comes via props (the host builds the view-model from core
 * `routerV29` via IPC: `routeModelV29`, `ModelCostLedgerV29.summary`,
 * `ProviderHealthTrackerV29.summary`); when there is no host wiring
 * yet it uses an internal demo view-model — the component never
 * guesses real numbers; the demo is clearly labelled in code.
 */

export interface RouterV29ModelView {
  modelId: string;
  provider: string;
  kind: string;
  architecture: string;
  contextTokens: number;
  quality: number;
  typicalLatencyMs: number;
  inputPricePer1kUsd: number;
  realtime: boolean;
}

export interface RouterV29DecisionView {
  ok: boolean;
  chosenModelId: string | null;
  profile: string;
  estimatedCostUsd: number;
  estimatedLatencyMs: number;
  score: number | null;
  ranked: { modelId: string; score: number; estimatedCostUsd: number }[];
  rejectedCount: number;
}

export interface RouterV29LedgerView {
  totalUsd: number;
  totalCalls: number;
  totalMinutes: number;
  topModelId: string | null;
  dailyBudgetUsd: number | null;
  dailyUsedUsd: number;
  overDaily: boolean;
}

export interface RouterV29HealthView {
  provider: string;
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  lastLatencyMs: number | null;
  consecutiveFailures: number;
  uptimeRatio: number | null;
  lastError: string | null;
}

export interface RouterV29PanelView {
  catalog: RouterV29ModelView[];
  decision: RouterV29DecisionView;
  ledger: RouterV29LedgerView;
  health: RouterV29HealthView[];
  fallbackSteps: string[];
  fallbackUsedModel: string | null;
}

/** Demo view-model — clearly labelled, never presented as live data. */
export function demoRouterV29PanelView(): RouterV29PanelView {
  return {
    catalog: [
      { modelId: 'gpt-realtime-2.1', provider: 'openai', kind: 'realtime', architecture: 'full-duplex', contextTokens: 131072, quality: 0.95, typicalLatencyMs: 300, inputPricePer1kUsd: 0.04, realtime: true },
      { modelId: 'gpt-live', provider: 'openai', kind: 'live', architecture: 'full-duplex', contextTokens: 131072, quality: 0.93, typicalLatencyMs: 280, inputPricePer1kUsd: 0.04, realtime: true },
      { modelId: 'gemini-3.8-live', provider: 'gemini', kind: 'live', architecture: 'full-duplex', contextTokens: 131072, quality: 0.94, typicalLatencyMs: 300, inputPricePer1kUsd: 0.002, realtime: true },
      { modelId: 'qwen3-4b', provider: 'ollama', kind: 'text', architecture: 'cascaded', contextTokens: 32768, quality: 0.7, typicalLatencyMs: 350, inputPricePer1kUsd: 0, realtime: false },
    ],
    decision: {
      ok: true,
      chosenModelId: 'gemini-3.8-live',
      profile: 'balanced',
      estimatedCostUsd: 0.006,
      estimatedLatencyMs: 300,
      score: 0.59,
      ranked: [
        { modelId: 'gemini-3.8-live', score: 0.59, estimatedCostUsd: 0.006 },
        { modelId: 'gemini-3-flash-live', score: 0.55, estimatedCostUsd: 0.0015 },
        { modelId: 'gpt-realtime-2.1', score: 0.48, estimatedCostUsd: 0.12 },
      ],
      rejectedCount: 6,
    },
    ledger: {
      totalUsd: 0.62,
      totalCalls: 3,
      totalMinutes: 10,
      topModelId: 'gpt-live',
      dailyBudgetUsd: 1,
      dailyUsedUsd: 0.62,
      overDaily: false,
    },
    health: [
      { provider: 'openai', status: 'healthy', lastLatencyMs: 210, consecutiveFailures: 0, uptimeRatio: 1, lastError: null },
      { provider: 'gemini', status: 'healthy', lastLatencyMs: 180, consecutiveFailures: 0, uptimeRatio: 1, lastError: null },
      { provider: 'xai', status: 'degraded', lastLatencyMs: 1900, consecutiveFailures: 1, uptimeRatio: 0.75, lastError: 'mock probe slow' },
    ],
    fallbackSteps: ['gpt-realtime-2.1', 'gemini-3.8-live', 'gemini-2.5-flash'],
    fallbackUsedModel: 'gemini-3.8-live',
  };
}

function healthLabelKey(status: RouterV29HealthView['status']): string {
  if (status === 'healthy') return 'routerV29.providerHealthy';
  if (status === 'degraded') return 'routerV29.providerDegraded';
  if (status === 'unhealthy') return 'routerV29.providerUnhealthy';
  return 'routerV29.healthTitle';
}

function profileLabelKey(profile: string): string {
  if (profile === 'cheapest') return 'routerV29.cheapest';
  if (profile === 'fastest') return 'routerV29.fastest';
  if (profile === 'quality') return 'routerV29.bestQuality';
  return 'routerV29.balanced';
}

export default function RouterV29Panel({
  view: viewProp,
  onRefreshCatalog,
  onRouteVoice,
}: {
  view?: RouterV29PanelView | null;
  onRefreshCatalog?: () => void;
  onRouteVoice?: () => void;
}) {
  const t = useT();
  const [view] = useState<RouterV29PanelView>(() => viewProp ?? demoRouterV29PanelView());
  const realtimeCount = view.catalog.filter((m) => m.realtime).length;

  return (
    <div data-testid="router-v29-panel">
      <h2>{t('routerV29.title')}</h2>
      <p>{t('routerV29.subtitle')}</p>
      <div>
        {onRefreshCatalog ? (
          <button type="button" onClick={onRefreshCatalog}>
            {t('routerV29.catalogTitle')}
          </button>
        ) : null}
        {onRouteVoice ? (
          <button type="button" onClick={onRouteVoice}>
            {t('routerV29.realtimeVoice')}
          </button>
        ) : null}
      </div>

      <h3>{t('routerV29.routeTitle')}</h3>
      {view.decision.ok && view.decision.chosenModelId ? (
        <p>
          <strong>{t('routerV29.chooseModel')}:</strong> {view.decision.chosenModelId}
          {' · '}
          {t(profileLabelKey(view.decision.profile))}
          {' · '}
          {t('routerV29.estimatedCost')}: ${view.decision.estimatedCostUsd.toFixed(4)}
          {' · '}
          {t('routerV29.estimatedLatency')}: {view.decision.estimatedLatencyMs}ms
          {view.decision.score !== null ? ` · ${view.decision.score.toFixed(2)}` : ''}
        </p>
      ) : (
        <p>{t('routerV29.noModelFits')}</p>
      )}
      {view.fallbackUsedModel ? (
        <p>{t('routerV29.fallbackUsed', { model: view.fallbackUsedModel })}</p>
      ) : null}
      <table>
        <thead>
          <tr>
            <th>{t('routerV29.chooseModel')}</th>
            <th>{t('routerV29.estimatedCost')}</th>
            <th>{t('routerV29.estimatedLatency')}</th>
          </tr>
        </thead>
        <tbody>
          {view.decision.ranked.map((r) => (
            <tr key={r.modelId}>
              <td>{r.modelId}</td>
              <td>${r.estimatedCostUsd.toFixed(4)}</td>
              <td>{r.score.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>{t('routerV29.catalogTitle')}</h3>
      <p>
        {t('routerV29.catalogTitle')}: {view.catalog.length}
        {' · '}
        {realtimeCount} {t('routerV29.realtimeVoice')} ·{' '}
        {view.catalog.filter((m) => m.architecture === 'full-duplex').length} {t('routerV29.fullDuplex')}
      </p>
      <table>
        <thead>
          <tr>
            <th>{t('routerV29.chooseModel')}</th>
            <th>{t('routerV29.estimatedLatency')}</th>
            <th>{t('routerV29.estimatedCost')}</th>
          </tr>
        </thead>
        <tbody>
          {view.catalog.map((m) => (
            <tr key={m.modelId}>
              <td>{m.modelId} ({m.provider})</td>
              <td>{m.typicalLatencyMs}ms</td>
              <td>${m.inputPricePer1kUsd}/1k</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>{t('routerV29.costTitle')}</h3>
      <p>
        {t('routerV29.totalCost')}: ${view.ledger.totalUsd.toFixed(4)}
        {' · '}
        {view.ledger.totalCalls} calls · {view.ledger.totalMinutes} min
        {view.ledger.topModelId ? ` · ${view.ledger.topModelId}` : ''}
      </p>
      <p>
        {t('routerV29.dailyBudget')}:{' '}
        {view.ledger.dailyBudgetUsd === null ? '—' : `$${view.ledger.dailyBudgetUsd.toFixed(2)}`}
        {' · $'}
        {view.ledger.dailyUsedUsd.toFixed(4)}
        {view.ledger.overDaily ? ` · ${t('routerV29.budgetExceeded')}` : ''}
      </p>

      <h3>{t('routerV29.healthTitle')}</h3>
      <ul>
        {view.health.map((h) => (
          <li key={h.provider} data-status={h.status}>
            {h.provider}: {t(healthLabelKey(h.status))}
            {h.lastLatencyMs !== null ? ` · ${h.lastLatencyMs}ms` : ''}
            {h.uptimeRatio !== null ? ` · ${Math.round(h.uptimeRatio * 100)}%` : ''}
            {h.lastError ? ` · ${h.lastError}` : ''}
          </li>
        ))}
      </ul>

      <h3>{t('routerV29.fallbackTitle')}</h3>
      <p>{view.fallbackSteps.join(' → ')}</p>
    </div>
  );
}
