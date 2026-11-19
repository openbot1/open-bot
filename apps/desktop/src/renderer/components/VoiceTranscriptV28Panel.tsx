import { useState } from 'react';
import { useT } from '../i18n/useT';
import type {
  VoiceV28SessionSummary,
  VoiceV28TranscriptTurn,
} from '@open-bot/core';

/**
 * Voice v28 transcript panel (v1.41, Team T5) — the readable
 * record of a realtime session, next to the live session
 * panel (VoiceSessionV28Panel):
 *
 *   - the session summary: turns, words, interruptions,
 *     top phrases and key sentences;
 *   - the turns in order, user vs agent, with an
 *     [interrupted] flag on turns cut short by a barge-in
 *     and the voice / cast role that spoke agent turns.
 *
 * Data comes via props (the host builds it from core
 * `TranscriptRecorderV28` via IPC); when there is no host
 * wiring yet it uses internal demo data — the component
 * never guesses real numbers; the demo is clearly labelled
 * in code. Read-only: it never starts, stops or edits a
 * session.
 */

export function demoVoiceV28TranscriptTurns(): VoiceV28TranscriptTurn[] {
  return [
    {
      id: 'turn28-1',
      sessionId: 'demo-session-v28',
      index: 0,
      speaker: 'user',
      text: 'Please summarise the release plan for this week.',
      startedAtMs: 0,
      endedAtMs: 2000,
      durationMs: 2000,
      interrupted: false,
      voiceId: null,
      castRole: null,
    },
    {
      id: 'turn28-2',
      sessionId: 'demo-session-v28',
      index: 1,
      speaker: 'agent',
      text: 'Three items ship this week: the voice session, the report, and the new presets.',
      startedAtMs: 2000,
      endedAtMs: 6000,
      durationMs: 4000,
      interrupted: false,
      voiceId: 'mock-formal',
      castRole: 'assistant',
    },
    {
      id: 'turn28-3',
      sessionId: 'demo-session-v28',
      index: 2,
      speaker: 'user',
      text: 'Good — and the report?',
      startedAtMs: 6000,
      endedAtMs: 7000,
      durationMs: 1000,
      interrupted: true,
      voiceId: null,
      castRole: null,
    },
  ];
}

export function demoVoiceV28SessionSummary(): VoiceV28SessionSummary {
  return {
    sessionId: 'demo-session-v28',
    botId: 'demo-bot',
    startedAtMs: 0,
    endedAtMs: 7000,
    durationMs: 7000,
    turns: 3,
    userTurns: 2,
    agentTurns: 1,
    interruptions: 1,
    words: 27,
    userWords: 13,
    agentWords: 14,
    topPhrases: [
      { phrase: 'week', count: 2 },
      { phrase: 'report', count: 2 },
    ],
    keySentences: [
      'Please summarise the release plan for this week.',
      'Three items ship this week: the voice session, the report, and the new presets.',
    ],
    style: 'formal',
    voiceId: 'mock-formal',
  };
}

export default function VoiceTranscriptV28Panel({
  turns: turnsProp,
  summary: summaryProp,
}: {
  turns?: VoiceV28TranscriptTurn[] | null;
  summary?: VoiceV28SessionSummary | null;
}) {
  const t = useT();
  const [turns] = useState<VoiceV28TranscriptTurn[]>(
    () => turnsProp ?? demoVoiceV28TranscriptTurns(),
  );
  const [summary] = useState<VoiceV28SessionSummary | null>(
    () => summaryProp ?? demoVoiceV28SessionSummary(),
  );
  const isDemo = !turnsProp && !summaryProp;

  return (
    <div data-testid="voice-v28-transcript-panel">
      <h2>{t('voice.v28.transcript.title')}</h2>
      {isDemo ? <p>{t('voice.v28.style.fallback')}</p> : null}
      {summary ? (
        <div>
          <p>
            <strong>{t('voice.v28.transcript.summary')}:</strong>{' '}
            {summary.turns} {t('voice.v28.transcript.turns')} ·{' '}
            {summary.words} words · {summary.interruptions}{' '}
            {t('voice.v28.transcript.interrupted')}
          </p>
          <p>
            <strong>{t('voice.v28.transcript.topPhrases')}:</strong>{' '}
            {summary.topPhrases.length === 0
              ? '—'
              : summary.topPhrases.map((p) => `${p.phrase} (${p.count})`).join(', ')}
          </p>
          <p>
            <strong>{t('voice.v28.transcript.keySentences')}:</strong>
          </p>
          <ul>
            {summary.keySentences.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <ol>
        {turns.map((turn) => (
          <li key={turn.id}>
            <strong>{turn.speaker}</strong>
            {turn.interrupted ? ` [${t('voice.v28.transcript.interrupted')}]` : ''}
            {turn.voiceId ? ` · ${turn.voiceId}` : ''}
            {turn.castRole ? ` · ${turn.castRole}` : ''}: {turn.text || '—'}
          </li>
        ))}
      </ol>
    </div>
  );
}
