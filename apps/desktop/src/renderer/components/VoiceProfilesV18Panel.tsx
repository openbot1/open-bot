import { useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Voice profiles v18 panel (v1.20, Team T5) — multi-voice
 * profiles v2 (hold-guarded switching, alert override, language
 * pins, usage counts) + voice budget meters (voice minutes,
 * TTS/STT tokens, thresholds, auto-degrade).
 *
 * Data comes via props (host builds the view-model from core
 * `buildVoiceProfilesV18PanelView` + `VoiceBudgetMeterV18.stats`
 * via IPC); when there is no host wiring yet it uses an internal
 * demo store — the component never guesses real numbers; the demo
 * is clearly labelled in code.
 */

export interface VoiceProfilesV18RowView {
  id: string;
  displayName: string;
  botId: string;
  context?: string;
  language: string;
  rate: number;
  pitch: number;
  activeForBots: string[];
  usageTurns: number;
}

export interface VoiceProfilesV18PanelView {
  rows: VoiceProfilesV18RowView[];
  activeByBot: Record<string, string>;
  totalProfiles: number;
  activeBots: number;
  summary: string;
}

export interface VoiceBudgetV18PanelView {
  dayKey: string;
  dayVoiceMinutes: number;
  dayTtsTokens: number;
  daySttTokens: number;
  level: string;
  degradedTurns: number;
  blockedTurns: number;
  summary: string;
}

export function demoVoiceProfilesV18Panel(): VoiceProfilesV18PanelView {
  return {
    rows: [
      {
        id: 'preset-vi-nu-nhe', displayName: 'Vietnamese — female, soft', botId: 'bot-a',
        language: 'vi', rate: 1, pitch: 2, activeForBots: ['bot-a'], usageTurns: 12,
      },
      {
        id: 'preset-en-brisk', displayName: 'English — brisk', botId: 'bot-a', context: 'announcement',
        language: 'en', rate: 1.15, pitch: 1, activeForBots: [], usageTurns: 3,
      },
    ],
    activeByBot: { 'bot-a': 'preset-vi-nu-nhe' },
    totalProfiles: 2,
    activeBots: 1,
    summary: 'Demo: voice profiles v18: 2 profiles, 1 bot, 1 active bot, 0 switches (0 refused), 15 usage turns.',
  };
}

export function demoVoiceBudgetV18Panel(): VoiceBudgetV18PanelView {
  return {
    dayKey: '2026-11-16',
    dayVoiceMinutes: 4.5,
    dayTtsTokens: 1200,
    daySttTokens: 800,
    level: 'ok',
    degradedTurns: 0,
    blockedTurns: 0,
    summary: 'Demo: voice budget v18: day 2026-11-16, voiceMinutes 4.5/∞ (ok), ttsTokens 1200/∞ (ok), sttTokens 800/∞ (ok), 0 degraded turns, 0 blocked turns.',
  };
}

export default function VoiceProfilesV18Panel({
  profiles: profilesProp,
  budget: budgetProp,
}: {
  profiles?: VoiceProfilesV18PanelView | null;
  budget?: VoiceBudgetV18PanelView | null;
}) {
  const t = useT();
  const [profiles] = useState<VoiceProfilesV18PanelView>(() => profilesProp ?? demoVoiceProfilesV18Panel());
  const [budget] = useState<VoiceBudgetV18PanelView>(() => budgetProp ?? demoVoiceBudgetV18Panel());

  return (
    <div>
      <h3>{t('voice.realtime.v18.profiles.title')}</h3>
      <p>{profiles.summary}</p>
      {profiles.rows.length === 0 ? (
        <p>{t('voice.realtime.v18.profiles.create')}</p>
      ) : (
        <ul>
          {profiles.rows.map((row) => (
            <li key={row.id}>
              {row.displayName} ({row.language}, {t('voice.realtime.v18.tts.quality')}: {row.rate}x / {row.pitch})
              {row.context ? ` — ${row.context}` : ''}
              {row.activeForBots.length > 0 ? ` — ${t('voice.realtime.v18.profiles.active')}: ${row.activeForBots.join(', ')}` : ''}
              {` — ${t('voice.realtime.v18.profiles.usage')}: ${row.usageTurns}`}
            </li>
          ))}
        </ul>
      )}
      <p>
        {t('voice.realtime.v18.profiles.active')}: {profiles.activeBots} / {profiles.totalProfiles}
      </p>
      <h4>{t('voice.realtime.v18.budget.title')}</h4>
      <p>{budget.summary}</p>
      <p>
        {t('voice.realtime.v18.budget.voiceMinutes')}: {budget.dayVoiceMinutes.toFixed(1)} —{' '}
        {t('voice.realtime.v18.budget.ttsTokens')}: {budget.dayTtsTokens} —{' '}
        {t('voice.realtime.v18.budget.sttTokens')}: {budget.daySttTokens} —{' '}
        {t('voice.realtime.v18.budget.session')}: {budget.dayKey} ({budget.level})
      </p>
      <p>
        {t('voice.realtime.v18.budget.degraded')}: {budget.degradedTurns} —{' '}
        {t('voice.realtime.v18.budget.blocked')}: {budget.blockedTurns}
      </p>
    </div>
  );
}
