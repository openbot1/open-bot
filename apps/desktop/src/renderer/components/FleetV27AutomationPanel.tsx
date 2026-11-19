import { useMemo, useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Fleet v27 automation panel (v1.40, Team T6) — scheduled automation
 * templates + the automations created from them. Progressive
 * disclosure: the template catalog shows one line per template; each
 * template expands to its default schedule, task, and params, and the
 * automation list shows the local cron-like schedule per automation.
 *
 * Data comes via props (host builds the view-model from core
 * `buildFleetV27AutomationPanel` via IPC); when there is no host
 * wiring yet it uses an internal demo store — the component never
 * guesses real numbers; the demo is clearly labelled in code.
 */

export interface FleetV27TemplateRow {
  id: string;
  name: string;
  category: string;
  defaultCron: string;
  description: string;
}

export interface FleetV27AutomationRow {
  id: string;
  name: string;
  templateId: string;
  botId: string;
  cron: string;
  enabled: boolean;
  nextRunAtMs: number | null;
  lastRunAtMs: number | null;
  runCount: number;
}

export interface FleetV27AutomationPanelView {
  summary: string;
  templates: FleetV27TemplateRow[];
  automations: FleetV27AutomationRow[];
  suggestions: Array<{ templateId: string; score: number; reasons: string[] }>;
  dueNow: string[];
}

export function demoFleetV27AutomationPanel(): FleetV27AutomationPanelView {
  return {
    summary: 'Demo fleet v27 automation panel (no host wiring yet).',
    templates: [
      {
        id: 'pr-review-morning',
        name: 'Review PRs every morning',
        category: 'review',
        defaultCron: 'daily-08-00',
        description: 'Each morning, review open pull requests in the repo and leave a short summary per PR.',
      },
      {
        id: 'memory-digest-nightly',
        name: 'Summarise memory every night',
        category: 'memory',
        defaultCron: 'nightly-23-00',
        description: 'Each night, condense the day\'s new memories into a short digest and prune stale facts.',
      },
    ],
    automations: [
      {
        id: 'auto-0001',
        name: 'Review PRs every morning',
        templateId: 'pr-review-morning',
        botId: 'bot-review',
        cron: 'daily-08-00',
        enabled: true,
        nextRunAtMs: null,
        lastRunAtMs: null,
        runCount: 0,
      },
    ],
    suggestions: [
      {
        templateId: 'pr-review-morning',
        score: 85,
        reasons: ['matches bot tag(s): review', 'repo is a git checkout'],
      },
    ],
    dueNow: [],
  };
}

function formatTime(ms: number | null, t: (key: string) => string): string {
  if (ms === null) return t('fleet.v27.never');
  return new Date(ms).toLocaleString();
}

export default function FleetV27AutomationPanel({ panel }: { panel?: FleetV27AutomationPanelView }) {
  const t = useT();
  const view = useMemo(() => panel ?? demoFleetV27AutomationPanel(), [panel]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <section aria-label={t('fleet.v27.automationTitle')} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <header style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>{t('fleet.v27.automationTitle')}</h2>
        <span style={{ fontSize: 12, opacity: 0.7 }}>{view.summary}</span>
        <span style={{ marginLeft: 'auto', fontSize: 12 }}>
          {t('fleet.v27.dueNow', { count: view.dueNow.length })}
        </span>
      </header>

      <h3 style={{ margin: '4px 0 0', fontSize: 14 }}>{t('fleet.v27.templates')}</h3>
      <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {view.templates.map((tpl) => (
          <li key={tpl.id} style={{ border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: '8px 10px' }}>
            <button
              type="button"
              onClick={() => setExpandedId(expandedId === tpl.id ? null : tpl.id)}
              style={{ all: 'unset', cursor: 'pointer', display: 'block', width: '100%' }}
            >
              <strong>{tpl.name}</strong>
              <span style={{ display: 'block', fontSize: 13, opacity: 0.85 }}>{tpl.description}</span>
              <span style={{ display: 'block', fontSize: 12, opacity: 0.7 }}>
                {t(`fleet.v27.category.${tpl.category}`)} · {tpl.defaultCron}
              </span>
            </button>
            {expandedId === tpl.id ? (
              <dl style={{ margin: '8px 0 0', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 12px', fontSize: 13 }}>
                <dt>{t('fleet.v27.templateId')}</dt><dd style={{ margin: 0 }}>{tpl.id}</dd>
                <dt>{t('fleet.v27.defaultCron')}</dt><dd style={{ margin: 0 }}>{tpl.defaultCron}</dd>
              </dl>
            ) : null}
          </li>
        ))}
      </ul>

      <h3 style={{ margin: '4px 0 0', fontSize: 14 }}>{t('fleet.v27.suggestions')}</h3>
      {view.suggestions.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>{t('fleet.v27.noSuggestions')}</p>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {view.suggestions.map((s) => (
            <li key={s.templateId} style={{ border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: '8px 10px', fontSize: 13 }}>
              <strong>{s.templateId}</strong> — {t('fleet.v27.score', { score: s.score })}
              {s.reasons.length > 0 ? (
                <span style={{ display: 'block', opacity: 0.85 }}>{s.reasons.join('; ')}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <h3 style={{ margin: '4px 0 0', fontSize: 14 }}>{t('fleet.v27.automations')}</h3>
      {view.automations.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>{t('fleet.v27.noAutomations')}</p>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {view.automations.map((a) => (
            <li key={a.id} style={{ border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: '8px 10px', fontSize: 13 }}>
              <strong>{a.name}</strong>
              <span style={{ display: 'block', opacity: 0.85 }}>
                {a.enabled ? t('fleet.v27.enabled') : t('fleet.v27.disabled')} · {a.cron} · {t('fleet.v27.bot', { id: a.botId })}
              </span>
              <span style={{ display: 'block', opacity: 0.85 }}>
                {t('fleet.v27.nextRun')}: {formatTime(a.nextRunAtMs, t)} · {t('fleet.v27.lastRun')}: {formatTime(a.lastRunAtMs, t)} · {t('fleet.v27.runCount', { count: a.runCount })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
