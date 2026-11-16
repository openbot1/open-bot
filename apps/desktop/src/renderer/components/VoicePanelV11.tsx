import { useMemo, useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Voice panel v11 (v1.14, Team T6) — a SEPARATE panel for voice, not crammed
 * into the main chat screen: latency dashboard, barge-in toggle, wake word,
 * provider picker.
 *
 * Continues VoiceSessionV12Panel (session + barge-in v12) and the latency
 * pipeline (`voice/latencyPipeline.ts`): this panel groups latency by
 * stage (p50/p95/p99 + budget), barge-in config, wake-word validation,
 * and a provider picker from catalog v10 (`voice/voiceSettingsV10.ts`).
 * Data comes via props `report` (host builds it from core
 * `buildFleetV11VoicePanel` + IPC); when there is no host wiring yet it uses
 * an internal demo store — the component never guesses real latency.
 */

export interface VoicePanelV11StageSummary {
  count: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  lastMs: number;
  buckets: number[];
}

export type VoicePanelV11Stage = 'capture' | 'vad' | 'stt' | 'llm' | 'tts' | 'playback';

export interface VoicePanelV11Report {
  sessionId: string;
  mode: 'balanced' | 'low-latency';
  turns: number;
  stages: Record<VoicePanelV11Stage, VoicePanelV11StageSummary | null>;
  endToEnd: VoicePanelV11StageSummary | null;
  slowestStage: { stage: VoicePanelV11Stage; p95Ms: number } | null;
  jitterBufferMs: number;
}

export interface VoicePanelV11Provider {
  id: string;
  name: string;
  needsKey: boolean;
  available: boolean;
  keyHint: string;
  voices: { id: string; name: string; languages: string[]; isDefault: boolean }[];
}

const STAGES: VoicePanelV11Stage[] = ['capture', 'vad', 'stt', 'llm', 'tts', 'playback'];

function summary(count: number, p50: number, p95: number, p99: number, mean: number): VoicePanelV11StageSummary {
  return {
    count, minMs: Math.round(p50 * 0.6), maxMs: Math.round(p99 * 1.4), meanMs: mean,
    p50Ms: p50, p95Ms: p95, p99Ms: p99, lastMs: p50, buckets: [],
  };
}

export function demoVoicePanelV11Report(): VoicePanelV11Report {
  return {
    sessionId: 'demo-session',
    mode: 'balanced',
    turns: 12,
    stages: {
      capture: summary(12, 18, 32, 48, 21),
      vad: summary(12, 44, 78, 120, 52),
      stt: summary(12, 210, 340, 520, 248),
      llm: summary(12, 420, 780, 1100, 510),
      tts: summary(12, 150, 260, 410, 180),
      playback: summary(12, 25, 60, 90, 32),
    },
    endToEnd: summary(12, 820, 1150, 1480, 900),
    slowestStage: { stage: 'llm', p95Ms: 780 },
    jitterBufferMs: 120,
  };
}

export function demoVoicePanelV11Providers(): VoicePanelV11Provider[] {
  return [
    {
      id: 'openai', name: 'OpenAI', needsKey: true, available: false,
      keyHint: 'Add an OpenAI key in Settings to use OpenAI voices.',
      voices: [{ id: 'alloy', name: 'Alloy', languages: ['en', 'vi'], isDefault: true }],
    },
    {
      id: 'gemini', name: 'Gemini', needsKey: true, available: true,
      keyHint: 'Add a Gemini key in Settings to use Gemini voices.',
      voices: [{ id: 'puck', name: 'Puck', languages: ['en', 'vi'], isDefault: true }],
    },
    {
      id: 'system', name: 'System (offline)', needsKey: false, available: true,
      keyHint: 'Uses the operating system voice — no key needed.',
      voices: [{ id: 'vi-vn-x-south', name: 'Vietnamese — Southern', languages: ['vi'], isDefault: true }],
    },
    {
      id: 'local', name: 'Local (Ollama / Piper)', needsKey: false, available: true,
      keyHint: 'Uses a local voice model — no key needed.',
      voices: [{ id: 'piper-vi', name: 'Piper — Vietnamese', languages: ['vi'], isDefault: true }],
    },
  ];
}

const P95_BUDGET_MS = 1200;

export default function VoicePanelV11({
  report: reportProp,
  providers: providersProp,
}: {
  report?: VoicePanelV11Report | null;
  providers?: VoicePanelV11Provider[] | null;
}) {
  const t = useT();
  const [report] = useState<VoicePanelV11Report | null>(() => reportProp ?? demoVoicePanelV11Report());
  const [providers] = useState<VoicePanelV11Provider[]>(() => providersProp ?? demoVoicePanelV11Providers());
  const [bargeInEnabled, setBargeInEnabled] = useState(true);
  const [bargeInThreshold, setBargeInThreshold] = useState('0.5');
  const [wakeWord, setWakeWord] = useState('hey bot');
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
    () => providersProp?.find((p) => p.available)?.id ?? 'gemini',
  );
  const [notice, setNotice] = useState('');

  /** Validate wake word (mirror core `validateFleetV11WakeWord`). */
  const wakeErrors = useMemo(() => {
    const errors: string[] = [];
    const w = wakeWord.trim().replace(/\s+/g, ' ');
    if (w.length === 0) return [t('voicePanelV11.wakeWordInvalid', { reason: 'empty' })];
    if (w.length < 3 || w.length > 40) errors.push('3–40 chars');
    const words = w.split(' ');
    if (words.length > 3) errors.push('max 3 words');
    for (const word of words) {
      if (word.length < 2 || !/^[A-Za-z\u00C0-\u1EF90-9-]+$/.test(word)) errors.push(word);
    }
    return errors;
  }, [wakeWord, t]);

  const thresholdNum = Number.parseFloat(bargeInThreshold);
  const thresholdValid = Number.isFinite(thresholdNum) && thresholdNum >= 0 && thresholdNum <= 1;

  const selectedProvider = providers.find((p) => p.id === selectedProviderId) ?? null;
  const endToEndOver = (report?.endToEnd?.p95Ms ?? 0) > P95_BUDGET_MS;

  const save = () => {
    if (wakeErrors.length > 0 || !thresholdValid) return;
    setNotice(t('voicePanelV11.saved'));
  };

  return (
    <div>
      <h3>{t('voicePanelV11.title')}</h3>
      <p className="hint">{t('voicePanelV11.subtitle')}</p>

      <h4>{t('voicePanelV11.latencyTitle')}</h4>
      {!report ? (
        <p className="hint">{t('voicePanelV11.noData')}</p>
      ) : (
        <div>
          <p className="hint">
            {t('voicePanelV11.turns')}: {report.turns} · {t('voicePanelV11.mode')}:{' '}
            {report.mode === 'low-latency' ? t('voicePanelV11.modeLowLatency') : t('voicePanelV11.modeBalanced')} ·{' '}
            {t('voicePanelV11.jitterBuffer')}: {report.jitterBufferMs}ms ·{' '}
            {t('voicePanelV11.endToEnd')} p95: {report.endToEnd?.p95Ms ?? '—'}ms
            {endToEndOver ? ' (over budget)' : ''}
          </p>
          {report.slowestStage ? (
            <p className="hint">
              {t('voicePanelV11.slowestStage')}: {report.slowestStage.stage} (
              {report.slowestStage.p95Ms}ms)
            </p>
          ) : null}
          <table>
            <thead>
              <tr>
                <th>Stage</th>
                <th>n</th>
                <th>{t('voicePanelV11.p50')}</th>
                <th>{t('voicePanelV11.p95')}</th>
                <th>{t('voicePanelV11.p99')}</th>
              </tr>
            </thead>
            <tbody>
              {STAGES.map((stage) => {
                const s = report.stages[stage];
                return (
                  <tr key={stage}>
                    <td>{stage}</td>
                    <td>{s?.count ?? 0}</td>
                    <td>{s?.p50Ms ?? '—'}</td>
                    <td>{s?.p95Ms ?? '—'}</td>
                    <td>{s?.p99Ms ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h4>{t('voicePanelV11.bargeIn')}</h4>
      <div className="row">
        <button className="btn secondary" onClick={() => setBargeInEnabled((v) => !v)}>
          {bargeInEnabled ? t('voicePanelV11.bargeInOn') : t('voicePanelV11.bargeInOff')}
        </button>
        <label>
          {t('voicePanelV11.threshold')}{' '}
          <input
            type="text"
            value={bargeInThreshold}
            disabled={!bargeInEnabled}
            onChange={(e) => setBargeInThreshold(e.target.value)}
            aria-label={t('voicePanelV11.threshold')}
            style={{ width: 64 }}
          />
        </label>
        {!thresholdValid ? <span className="hint">0–1</span> : null}
      </div>

      <h4>{t('voicePanelV11.wakeWord')}</h4>
      <div className="row">
        <input
          type="text"
          value={wakeWord}
          placeholder={t('voicePanelV11.wakeWordPlaceholder')}
          onChange={(e) => setWakeWord(e.target.value)}
          aria-label={t('voicePanelV11.wakeWord')}
        />
      </div>
      {wakeErrors.length > 0 ? (
        <p className="hint">{t('voicePanelV11.wakeWordInvalid', { reason: wakeErrors.join(', ') })}</p>
      ) : null}

      <h4>{t('voicePanelV11.provider')}</h4>
      <div className="row">
        {providers.map((p) => (
          <button
            key={p.id}
            className="btn secondary"
            disabled={selectedProviderId === p.id}
            onClick={() => setSelectedProviderId(p.id)}
          >
            {p.name}
            {!p.available ? ' (key?)' : ''}
          </button>
        ))}
      </div>
      {selectedProvider ? (
        <p className="hint">
          {selectedProvider.name} —{' '}
          {selectedProvider.voices.map((v) => v.name).join(', ')}
          {selectedProvider.available ? '' : ` · ${selectedProvider.keyHint}`}
        </p>
      ) : (
        <p className="hint">{t('voicePanelV11.providerNone')}</p>
      )}

      <div className="row">
        <button
          className="btn secondary"
          onClick={save}
          disabled={wakeErrors.length > 0 || !thresholdValid}
        >
          {t('voicePanelV11.save')}
        </button>
        {notice ? <span className="hint">{notice}</span> : null}
      </div>
    </div>
  );
}
