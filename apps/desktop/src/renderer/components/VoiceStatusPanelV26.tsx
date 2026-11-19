import { useState } from 'react';
import { useT } from '../i18n/useT';
import type {
  VoiceV26DegradedPolicy,
  VoiceV26ResumeContext,
  VoiceV26StatusSnapshot,
  VoiceV26UiResource,
} from '@open-bot/core';

/**
 * Voice v26 live status panel (v1.39, Team T5) — the small,
 * always-visible strip a user watches while talking:
 *
 *   - floor state: listening / thinking / speaking /
 *     interrupted (with the floor holder);
 *   - audio level meter: smoothed level + peak hold, fed by
 *     the host (synthetic levels in tests — the component never
 *     opens a mic);
 *   - latency now: current turn total vs the total budget,
 *     over-budget flag;
 *   - degraded mode: off / light / heavy, with what it trades;
 *   - active provider: the TTS provider speaking right now.
 *
 * Data comes via props (the host builds the snapshot from core
 * `VoiceSessionV26.statusSnapshot` via IPC, or from the
 * `ui://voice-v26/status` resource); when there is no host
 * wiring yet it uses an internal demo snapshot — the component
 * never guesses real numbers; the demo is clearly labelled in
 * code. The same snapshot renders as a normal panel and as an
 * MCP Apps `ui://` resource (see `uiResource` prop).
 */

export function demoVoiceV26StatusSnapshot(): VoiceV26StatusSnapshot {
  return {
    sessionId: 'demo-session-v26',
    state: 'speaking',
    floor: 'speaking',
    floorHolder: 'agent',
    level: { atMs: 1200, level: 0.62, smoothed: 0.58, peak: 0.81, speaking: true },
    latencyMs: 1650,
    latencyP50Ms: 1520,
    budgetMs: 4000,
    overBudget: false,
    degradedLevel: 'off',
    providerId: 'mock-local-tts',
    providerName: 'Mock Local TTS',
    turnId: 'turn26-2',
    turnIndex: 1,
    bargeIns: 1,
    turns: 2,
    updatedAtMs: 1200,
  };
}

export function demoVoiceV26UiResource(): VoiceV26UiResource {
  const snapshot = demoVoiceV26StatusSnapshot();
  return {
    uri: 'ui://voice-v26/status?session=demo-session-v26',
    mimeType: 'application/vnd.open-bot.voice-status+json',
    title: 'Voice status — demo-session-v26',
    description: 'Live voice status: floor state, audio level, latency vs budget, degraded mode, active provider.',
    kind: 'voice-status',
    version: 26,
    snapshot,
    i18nKeys: [
      'voice.v26.panel.title',
      'voice.v26.panel.listening',
      'voice.v26.panel.thinking',
      'voice.v26.panel.speaking',
      'voice.v26.panel.interrupted',
    ],
  };
}

function stateTone(state: VoiceV26StatusSnapshot['state']): string {
  if (state === 'interrupted') return 'bad';
  if (state === 'degraded') return 'warn';
  if (state === 'error') return 'bad';
  return 'ok';
}

function levelBar(level: number): string {
  const filled = Math.round(level * 20);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, 20 - filled));
}

export default function VoiceStatusPanelV26({
  snapshot: snapshotProp,
  uiResource: uiResourceProp,
  degradedPolicy: degradedPolicyProp,
  resume: resumeProp,
  onOpenResource,
  onResume,
}: {
  snapshot?: VoiceV26StatusSnapshot | null;
  uiResource?: VoiceV26UiResource | null;
  degradedPolicy?: VoiceV26DegradedPolicy | null;
  resume?: VoiceV26ResumeContext | null;
  onOpenResource?: (uri: string) => void;
  onResume?: (resume: VoiceV26ResumeContext) => void;
}) {
  const t = useT();
  const [snapshot] = useState<VoiceV26StatusSnapshot>(
    () => snapshotProp ?? uiResourceProp?.snapshot ?? demoVoiceV26StatusSnapshot(),
  );
  const [resource] = useState<VoiceV26UiResource | null>(
    () => uiResourceProp ?? null,
  );
  const isDemo = !snapshotProp && !uiResourceProp;
  const tone = stateTone(snapshot.state);
  const level = snapshot.level;
  const degradedPolicy = degradedPolicyProp ?? null;
  const resume = resumeProp ?? null;
  const resumeStrategyKey =
    resume === null
      ? null
      : resume.strategy === 'resume-remaining'
        ? 'voice.v26.bargeIn.resumeRemaining'
        : resume.strategy === 'summarise-remainder'
          ? 'voice.v26.bargeIn.summariseRemainder'
          : resume.strategy === 'drop-remainder'
            ? 'voice.v26.bargeIn.dropRemainder'
            : 'voice.v26.bargeIn.askClarify';

  return (
    <div data-testid="voice-status-panel-v26">
      <h3>{t('voice.v26.panel.title')}</h3>
      {isDemo ? <p>{t('voice.v26.panel.demo')}</p> : null}
      <p>
        <strong data-tone={tone}>{t(`voice.v26.panel.${snapshot.state}`)}</strong>
        {' · '}
        {t(snapshot.floorHolder === 'user'
          ? 'voice.v26.panel.floorUser'
          : snapshot.floorHolder === 'agent'
            ? 'voice.v26.panel.floorAgent'
            : 'voice.v26.panel.floorNone')}
        {' · '}
        {t('voice.v26.panel.turn')}: {snapshot.turnIndex === null ? '—' : `#${snapshot.turnIndex}`}
      </p>
      <p>
        {t('voice.v26.panel.level')}:{' '}
        {level ? (
          <>
            <span aria-label="level-bar">{levelBar(level.smoothed)}</span>
            {' '}
            {Math.round(level.smoothed * 100)}%
            {' '}
            ({t('voice.v26.panel.peak')}: {Math.round(level.peak * 100)}%)
          </>
        ) : (
          '—'
        )}
      </p>
      <p>
        {t('voice.v26.panel.latency')}:{' '}
        {snapshot.latencyMs === null ? '—' : `${snapshot.latencyMs}ms`}
        {' / '}
        {t('voice.v26.panel.budget')}: {snapshot.budgetMs}ms
        {' · '}
        {snapshot.overBudget ? t('voice.v26.panel.overBudget') : t('voice.v26.panel.withinBudget')}
      </p>
      <p>
        {t('voice.v26.panel.provider')}: {snapshot.providerName ?? snapshot.providerId ?? '—'}
        {' · '}
        {t('voice.v26.panel.degraded')}: {t(`voice.v26.panel.${snapshot.degradedLevel}`)}
      </p>
      <p>
        {t('voice.v26.panel.bargeIns')}: {snapshot.bargeIns}
        {' · '}
        {t('voice.v26.panel.turns')}: {snapshot.turns}
      </p>
      <p>
        {t('voice.v26.panel.resourceUri')}:{' '}
        <code>{resource ? resource.uri : `ui://voice-v26/status?session=${snapshot.sessionId}`}</code>
      </p>
      {onOpenResource ? (
        <button
          type="button"
          onClick={() => onOpenResource(resource ? resource.uri : `ui://voice-v26/status?session=${snapshot.sessionId}`)}
        >
          {t('voice.v26.panel.openAsResource')}
        </button>
      ) : null}
      {degradedPolicy && degradedPolicy.level !== 'off' ? (
        <div>
          <h4>{t('voice.v26.panel.degraded')}</h4>
          <p>
            {t(`voice.v26.panel.${degradedPolicy.level}`)}
            {degradedPolicy.maxReplyChars !== null ? ` · max ${degradedPolicy.maxReplyChars} chars` : ''}
            {degradedPolicy.fastVoice ? ' · fast voice' : ''}
            {degradedPolicy.skipProsody ? ' · no prosody' : ''}
            {degradedPolicy.lightStt ? ' · light STT' : ''}
            {degradedPolicy.skipEval ? ' · no eval' : ''}
          </p>
        </div>
      ) : null}
      {resume && resumeStrategyKey ? (
        <div>
          <h4>{t('voice.v26.bargeIn.title')}</h4>
          <p>
            {t(resumeStrategyKey)}
            {' · '}
            {t('voice.v26.panel.speaking')}: {resume.spokenChars}/{resume.spokenChars + resume.remainingChars} chars
          </p>
          <p>
            <q>{resume.spokenText}</q>
          </p>
          {resume.remainingText ? (
            <p>
              <q>{resume.remainingText}</q>
            </p>
          ) : null}
          {onResume ? (
            <button type="button" onClick={() => onResume(resume)}>
              {t(resumeStrategyKey)}
            </button>
          ) : null}
        </div>
      ) : null}
      <table>
        <thead>
          <tr>
            <th>{t('voice.v26.panel.state')}</th>
            <th>{t('voice.v26.panel.level')}</th>
            <th>{t('voice.v26.panel.latency')}</th>
            <th>{t('voice.v26.panel.provider')}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{t(`voice.v26.panel.${snapshot.state}`)}</td>
            <td>{level ? `${Math.round(level.smoothed * 100)}%` : '—'}</td>
            <td>{snapshot.latencyMs === null ? '—' : `${snapshot.latencyMs}ms / ${snapshot.budgetMs}ms`}</td>
            <td>{snapshot.providerName ?? snapshot.providerId ?? '—'}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
