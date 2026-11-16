import { useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Voice v15 panel (v1.16, Team T6) — per-stage pipeline budget
 * (VAD/STT/LLM/TTS/orchestrator: measured vs budget, alert on
 * overrun), barge-in count, semantic turn-taking rate, end-to-end.
 *
 * Data comes via props (host builds the view-model from core
 * `buildFleetV13VoicePanel` via IPC); when there is no host wiring
 * yet it uses an internal demo store — the component never guesses
 * real numbers; the demo is clearly labelled in code.
 */

export interface VoiceV15BudgetRowView {
  stage: 'vad' | 'stt' | 'llm' | 'tts' | 'orchestrator';
  budgetMs: number;
  avgMs: number | null;
  p95Ms: number | null;
  overBudgetTurns: number;
  totalTurns: number;
  alert: boolean;
  detail: string;
}

export interface VoiceV15PanelView {
  budgets: VoiceV15BudgetRowView[];
  turnCount: number;
  bargeInCount: number;
  cleanTurnRate: number | null;
  avgEndToEndMs: number | null;
  endToEndAlert: boolean;
  summary: string;
}

export function demoVoiceV15Panel(): VoiceV15PanelView {
  return {
    budgets: [
      { stage: 'vad', budgetMs: 150, avgMs: 110, p95Ms: 140, overBudgetTurns: 0, totalTurns: 3, alert: false, detail: 'avg 110ms, p95 140ms (budget 150ms), 0/3 turns over' },
      { stage: 'stt', budgetMs: 300, avgMs: 220, p95Ms: 280, overBudgetTurns: 0, totalTurns: 3, alert: false, detail: 'avg 220ms, p95 280ms (budget 300ms), 0/3 turns over' },
      { stage: 'llm', budgetMs: 800, avgMs: 500, p95Ms: 700, overBudgetTurns: 0, totalTurns: 3, alert: false, detail: 'avg 500ms, p95 700ms (budget 800ms), 0/3 turns over' },
      { stage: 'tts', budgetMs: 200, avgMs: 150, p95Ms: 190, overBudgetTurns: 0, totalTurns: 3, alert: false, detail: 'avg 150ms, p95 190ms (budget 200ms), 0/3 turns over' },
      { stage: 'orchestrator', budgetMs: 50, avgMs: 30, p95Ms: 45, overBudgetTurns: 0, totalTurns: 3, alert: false, detail: 'avg 30ms, p95 45ms (budget 50ms), 0/3 turns over' },
    ],
    turnCount: 3,
    bargeInCount: 1,
    cleanTurnRate: 0.667,
    avgEndToEndMs: 1010,
    endToEndAlert: true,
    summary: 'Demo: 3 turns: end-to-end avg 1010ms (speech-to-speech threshold 600ms), 1 barge-in, 67% clean turn ends; 0 stages over budget at p95.',
  };
}

export default function VoiceV15Panel({
  panel: panelProp,
}: {
  panel?: VoiceV15PanelView | null;
}) {
  const t = useT();
  const [panel] = useState<VoiceV15PanelView>(() => panelProp ?? demoVoiceV15Panel());

  return (
    <div>
      <h3>{t('fleetV13.voiceTitle')}</h3>
      <p>{panel.summary}</p>
      <p>{t('fleetV13.demo')}</p>
      <p>
        {t('fleetV13.bargeIn')}: {panel.bargeInCount} ·{' '}
        {t('fleetV13.cleanTurns')}: {panel.cleanTurnRate !== null ? `${Math.round(panel.cleanTurnRate * 100)}%` : '—'} ·{' '}
        {t('fleetV13.endToEnd')}: {panel.avgEndToEndMs !== null ? `${panel.avgEndToEndMs}ms` : '—'}
        {panel.endToEndAlert ? ' (alert)' : ''}
      </p>
      <h4>{t('fleetV13.voiceBudgets')}</h4>
      {panel.turnCount === 0 ? (
        <p>{t('fleetV13.voiceNoTurns')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Stage</th>
              <th>{t('fleetV13.budget')}</th>
              <th>{t('fleetV13.measured')}</th>
            </tr>
          </thead>
          <tbody>
            {panel.budgets.map((b) => (
              <tr key={b.stage}>
                <td>{b.stage}{b.alert ? ' (alert)' : ''}</td>
                <td>{b.budgetMs}ms</td>
                <td>{b.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
