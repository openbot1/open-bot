import { useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Admin panels v15 (v1.18, Team T6) — one panel per system (Memory
 * v17, Router v3, Composio v3, Voice v17): status + basic config,
 * behind a tab menu (progressive disclosure, clean and airy like
 * Grok Bot — never dense).
 *
 * Data comes via props (host builds the view-model from core
 * `buildFleetV15AdminPanel` via IPC); when there is no host wiring
 * yet it uses an internal demo store — the component never guesses
 * real numbers; the demo is clearly labelled in code.
 */

export interface AdminV15ConfigRowView {
  key: string;
  group: string;
  kind: 'toggle' | 'number' | 'text';
  labelKey: string;
  boolValue: boolean;
  numberValue: number;
  textValue: string;
  hintKey: string;
}

export interface AdminV15SystemView {
  status: string;
  summary: string;
  facts?: { id: string; text: string; confidence: number; source: string; status: string }[];
  quarantinedCount?: number;
  edgeCount?: number;
  sources?: { sourceId: string; kind: string; endpoint: string; detected: boolean; modelCount: number; error: string }[];
  fallbackChain?: { fromModel: string; toModel: string; reason: string }[];
  connections?: { connectionId: string; toolkit: string; accountLabel: string; status: string; error: string }[];
  triggers?: { triggerId: string; toolkit: string; triggerSlug: string; status: string }[];
  sessions?: { sessionId: string; startedAt: number; status: string; bargeIns: number; turnTakes: number }[];
  totalBargeIns?: number;
  avgTtsOnTime?: number;
}

export interface AdminPanelsV15View {
  memory: AdminV15SystemView;
  router: AdminV15SystemView;
  composio: AdminV15SystemView;
  voice: AdminV15SystemView;
  settings: AdminV15ConfigRowView[];
  summary: string;
}

type AdminTab = 'memory' | 'router' | 'composio' | 'voice';

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);

export function demoAdminPanelsV15(): AdminPanelsV15View {
  return {
    memory: {
      status: 'ok',
      summary: 'Demo: Memory v17: 3 facts (3 active), 1 temporal edge, 1 consolidation run.',
      facts: [{ id: 'f1', text: 'likes tea', confidence: 0.9, source: 'chat', status: 'active' }],
      quarantinedCount: 0,
      edgeCount: 1,
    },
    router: {
      status: 'ok',
      summary: 'Demo: Router v3: 1/2 local sources detected (3 local models), fallback chain 1 link.',
      sources: [{ sourceId: 'ollama', kind: 'ollama', endpoint: 'http://127.0.0.1:11434', detected: true, modelCount: 3, error: '' }],
      fallbackChain: [{ fromModel: 'gpt-4', toModel: 'llama3-local', reason: 'quota exhausted' }],
    },
    composio: {
      status: 'not-configured',
      summary: 'Demo: Composio v3: 0/1 connections active (user id missing, API key missing).',
      connections: [{ connectionId: 'conn-1', toolkit: 'gmail', accountLabel: 'huy@gmail', status: 'inactive', error: '' }],
      triggers: [],
    },
    voice: {
      status: 'ok',
      summary: 'Demo: Voice v17: 1 realtime session (1 active), 0 barge-ins.',
      sessions: [{ sessionId: 's1', startedAt: T0, status: 'active', bargeIns: 0, turnTakes: 1 }],
      totalBargeIns: 0,
      avgTtsOnTime: 0.9,
    },
    settings: [
      { key: 'memory.temporalKg', group: 'memory', kind: 'toggle', labelKey: 'adminV15.memoryTemporalKg', boolValue: true, numberValue: 0, textValue: '', hintKey: 'adminV15.memoryTemporalKgHint' },
      { key: 'router.localFallback', group: 'router', kind: 'toggle', labelKey: 'adminV15.routerFallback', boolValue: true, numberValue: 0, textValue: '', hintKey: 'adminV15.routerFallbackHint' },
      { key: 'composio.userIdConfigured', group: 'composio', kind: 'toggle', labelKey: 'adminV15.composioUserId', boolValue: false, numberValue: 0, textValue: '', hintKey: 'adminV15.composioUserIdHint' },
      { key: 'voice.realtimeV5', group: 'voice', kind: 'toggle', labelKey: 'adminV15.voiceRealtime', boolValue: true, numberValue: 0, textValue: '', hintKey: 'adminV15.voiceRealtimeHint' },
    ],
    summary: 'Demo: Admin v15: memory ok, router ok, Composio not-configured, voice ok.',
  };
}

export default function AdminPanelsV15({
  panel: panelProp,
}: {
  panel?: AdminPanelsV15View | null;
}) {
  const t = useT();
  const [panel] = useState<AdminPanelsV15View>(() => panelProp ?? demoAdminPanelsV15());
  const [tab, setTab] = useState<AdminTab>('memory');

  const tabs: { id: AdminTab; labelKey: string }[] = [
    { id: 'memory', labelKey: 'adminV15.memoryTitle' },
    { id: 'router', labelKey: 'adminV15.routerTitle' },
    { id: 'composio', labelKey: 'adminV15.composioTitle' },
    { id: 'voice', labelKey: 'adminV15.voiceTitle' },
  ];
  const current = panel[tab];
  const tabSettings = panel.settings.filter((s) => s.group === tab);

  return (
    <div>
      <h3>{t('adminV15.adminTitle')}</h3>
      <p>{panel.summary}</p>
      <p>{t('adminV15.demo')}</p>
      <div>
        {tabs.map((tb) => (
          <button key={tb.id} type="button" onClick={() => setTab(tb.id)}>
            {t(tb.labelKey)}
          </button>
        ))}
      </div>
      <h4>{t(tabs.find((tb) => tb.id === tab)?.labelKey ?? 'adminV15.adminTitle')}</h4>
      <p>
        {t('adminV15.status')}: {current.status}
      </p>
      <p>{current.summary}</p>

      {tab === 'memory' && (
        <>
          <p>
            {t('adminV15.facts')}: {(current.facts ?? []).length} — {t('adminV15.factsQuarantined')}: {current.quarantinedCount ?? 0} — {t('adminV15.edges')}: {current.edgeCount ?? 0}
          </p>
          {(current.facts ?? []).length === 0 ? (
            <p>{t('adminV15.noItems')}</p>
          ) : (
            <ul>
              {(current.facts ?? []).map((f) => (
                <li key={f.id}>
                  {f.text} ({f.status}, {Math.round(f.confidence * 100)}%)
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {tab === 'router' && (
        <>
          <p>
            {t('adminV15.sources')}: {(current.sources ?? []).length} — {t('adminV15.fallbackChain')}: {(current.fallbackChain ?? []).length}
          </p>
          {(current.sources ?? []).length === 0 ? (
            <p>{t('adminV15.noItems')}</p>
          ) : (
            <ul>
              {(current.sources ?? []).map((s) => (
                <li key={s.sourceId}>
                  {s.kind} ({s.endpoint}) — {s.detected ? `${s.modelCount} models` : s.error || '—'}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {tab === 'composio' && (
        <>
          <p>
            {t('adminV15.connections')}: {(current.connections ?? []).length} — {t('adminV15.triggers')}: {(current.triggers ?? []).length}
          </p>
          {(current.connections ?? []).length === 0 ? (
            <p>{t('adminV15.noItems')}</p>
          ) : (
            <ul>
              {(current.connections ?? []).map((c) => (
                <li key={c.connectionId}>
                  {c.toolkit} ({c.accountLabel}) — {c.status}
                  {c.status === 'not-configured' || c.error !== '' ? ` — ${c.error || t('adminV15.notConfigured')}` : ''}
                </li>
              ))}
            </ul>
          )}
          {current.status === 'not-configured' && (
            <p>
              {t('adminV15.userIdMissing')} — {t('adminV15.apiKeyMissing')}
            </p>
          )}
        </>
      )}
      {tab === 'voice' && (
        <>
          <p>
            {t('adminV15.sessions')}: {(current.sessions ?? []).length} — {t('adminV15.bargeIns')}: {current.totalBargeIns ?? 0} — {t('adminV15.ttsOnTime')}: {Math.round((current.avgTtsOnTime ?? 0) * 100)}%
          </p>
          {(current.sessions ?? []).length === 0 ? (
            <p>{t('adminV15.noItems')}</p>
          ) : (
            <ul>
              {(current.sessions ?? []).map((s) => (
                <li key={s.sessionId}>
                  {s.sessionId} ({s.status}) — {t('adminV15.bargeIns')}: {s.bargeIns}, {t('adminV15.turnTakes')}: {s.turnTakes}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <h4>{t('adminV15.settingsTitle')}</h4>
      {tabSettings.length === 0 ? (
        <p>{t('adminV15.noItems')}</p>
      ) : (
        <ul>
          {tabSettings.map((s) => (
            <li key={s.key}>
              {t(s.labelKey)}: {s.kind === 'toggle' ? String(s.boolValue) : s.kind === 'number' ? String(s.numberValue) : s.textValue} — {t(s.hintKey)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
