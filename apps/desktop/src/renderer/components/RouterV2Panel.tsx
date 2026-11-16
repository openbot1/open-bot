import { useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Router v2 panel (v1.16, Team T6) — model picker scores (task →
 * model by cost/latency/quality/fit), LRU + TTL unload plan,
 * swap-groups (which models share a GPU).
 *
 * Data comes via props (host builds the view-model from core
 * `buildFleetV13RouterPanel` via IPC); when there is no host wiring
 * yet it uses an internal demo store — the component never guesses
 * real numbers; the demo is clearly labelled in code.
 */

export interface RouterV2ModelView {
  modelId: string;
  kind: 'local' | 'cloud';
  status: 'loaded' | 'loading' | 'unloaded' | 'error';
  ramMb: number;
  vramMb: number;
  requestsServed: number;
  loadedAt: number | null;
  costPer1kUsd: number;
  avgLatencyMs: number | null;
  qualityScore: number;
  swapGroup: string;
}

export interface RouterV2PickView {
  modelId: string;
  score: number;
  costScore: number;
  latencyScore: number;
  qualityScore: number;
  fitScore: number;
  reason: string;
}

export interface RouterV2UnloadView {
  modelId: string;
  action: 'keep' | 'unload-lru' | 'unload-ttl' | 'unload-error';
  reason: string;
  idleMs: number | null;
}

export interface RouterV2PanelView {
  models: RouterV2ModelView[];
  loadedCount: number;
  totalRamMb: number;
  totalVramMb: number;
  picks: RouterV2PickView[];
  unloadPlans: RouterV2UnloadView[];
  swapGroups: { group: string; modelIds: string[]; totalRamMb: number }[];
  summary: string;
}

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);

export function demoRouterV2Panel(): RouterV2PanelView {
  return {
    models: [
      {
        modelId: 'qwen3-4b-q4_k_m', kind: 'local', status: 'loaded', ramMb: 2600, vramMb: 2500,
        requestsServed: 12, loadedAt: T0, costPer1kUsd: 0, avgLatencyMs: 120, qualityScore: 0.85, swapGroup: 'gpu-a',
      },
      {
        modelId: 'llama-3.2-3b-q4_k_m', kind: 'local', status: 'loaded', ramMb: 1900, vramMb: 1800,
        requestsServed: 4, loadedAt: T0, costPer1kUsd: 0, avgLatencyMs: 90, qualityScore: 0.8, swapGroup: 'gpu-a',
      },
      {
        modelId: 'gpt-oss-20b', kind: 'cloud', status: 'unloaded', ramMb: 0, vramMb: 0,
        requestsServed: 0, loadedAt: null, costPer1kUsd: 0.001, avgLatencyMs: 400, qualityScore: 0.9, swapGroup: '',
      },
    ],
    loadedCount: 2,
    totalRamMb: 4500,
    totalVramMb: 4300,
    picks: [
      { modelId: 'qwen3-4b-q4_k_m', score: 0.88, costScore: 1, latencyScore: 0.9, qualityScore: 0.85, fitScore: 1, reason: 'cost 100%, latency 90%, quality 85%, fit 100%' },
      { modelId: 'llama-3.2-3b-q4_k_m', score: 0.84, costScore: 1, latencyScore: 0.95, qualityScore: 0.8, fitScore: 1, reason: 'cost 100%, latency 95%, quality 80%, fit 100%' },
    ],
    unloadPlans: [
      { modelId: 'qwen3-4b-q4_k_m', action: 'keep', reason: 'keep loaded', idleMs: 0 },
      { modelId: 'llama-3.2-3b-q4_k_m', action: 'keep', reason: 'keep loaded', idleMs: 0 },
      { modelId: 'gpt-oss-20b', action: 'keep', reason: 'keep loaded', idleMs: null },
    ],
    swapGroups: [
      { group: 'gpu-a', modelIds: ['llama-3.2-3b-q4_k_m', 'qwen3-4b-q4_k_m'], totalRamMb: 4500 },
      { group: '(no group)', modelIds: ['gpt-oss-20b'], totalRamMb: 0 },
    ],
    summary: 'Demo: 2/3 models loaded (4500 MB RAM, 4300 MB VRAM); best pick for chat: qwen3-4b-q4_k_m; 0 models to unload.',
  };
}

export default function RouterV2Panel({
  panel: panelProp,
}: {
  panel?: RouterV2PanelView | null;
}) {
  const t = useT();
  const [panel] = useState<RouterV2PanelView>(() => panelProp ?? demoRouterV2Panel());

  return (
    <div>
      <h3>{t('fleetV13.routerTitle')}</h3>
      <p>{panel.summary}</p>
      <p>{t('fleetV13.demo')}</p>
      <h4>{t('fleetV13.routerModels')} ({panel.loadedCount}/{panel.models.length} {t('fleetV13.loaded')})</h4>
      {panel.models.length === 0 ? (
        <p>{t('fleetV13.routerNoModels')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Model</th>
              <th>{t('fleetV13.ram')}</th>
              <th>{t('fleetV13.vram')}</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {panel.models.map((m) => (
              <tr key={m.modelId}>
                <td>{m.modelId} ({m.kind})</td>
                <td>{m.ramMb} MB</td>
                <td>{m.vramMb} MB</td>
                <td>{m.status}{m.avgLatencyMs !== null ? ` · ${m.avgLatencyMs}ms` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p>
        {t('fleetV13.ram')}: {panel.totalRamMb} MB · {t('fleetV13.vram')}: {panel.totalVramMb} MB
      </p>

      <h4>{t('fleetV13.routerPicks')}</h4>
      {panel.picks.length === 0 ? (
        <p>—</p>
      ) : (
        <ol>
          {panel.picks.map((p) => (
            <li key={p.modelId}>
              {p.modelId}: {(p.score * 100).toFixed(0)}% — {p.reason}
            </li>
          ))}
        </ol>
      )}

      <h4>{t('fleetV13.routerUnload')}</h4>
      <ul>
        {panel.unloadPlans.map((p) => (
          <li key={p.modelId}>
            {p.modelId}: {p.action === 'keep' ? t('fleetV13.keep') : p.action} — {p.reason}
          </li>
        ))}
      </ul>

      <h4>{t('fleetV13.routerSwapGroups')}</h4>
      <ul>
        {panel.swapGroups.map((g) => (
          <li key={g.group}>
            {g.group}: {g.modelIds.join(', ')} ({g.totalRamMb} MB {t('fleetV13.ram')})
          </li>
        ))}
      </ul>
    </div>
  );
}
