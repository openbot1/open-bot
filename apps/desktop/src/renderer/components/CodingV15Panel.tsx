import { useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Coding agent v15 panel (v1.37, Team T4) — agent profiles, report-only
 * budget meter, hooks dialog, verify scenarios.
 *
 * Data comes via props (host builds the view-model from core
 * `CodingV15ProfileStore` / `CodingV15BudgetMeter` /
 * `CodingV15HooksDialog` / `v15RunVerifyScenarios` via IPC); when
 * there is no host wiring yet it uses an internal demo store — the
 * component never guesses real numbers; the demo is clearly labelled
 * in code and in the UI via the `codingV15.demo` string.
 *
 * Tabs:
 * - Profiles: list with kind + tool count + model + `[ACP]` label for
 *   profiles exposed via ACP; select one to apply to the next run.
 * - Budget: report-only meter bars (tokens + cost) with the 80% /
 *   100% thresholds marked; over cap never blocks — the note says so.
 * - Hooks: pending stop-hook feedback OUTSIDE the chat — confirm /
 *   dismiss / snooze from the dialog, never injected into chat.
 * - Verify: per-scenario pass/fail for the 9 built-in scenarios.
 */

export interface CodingV15ProfileView {
  id: string;
  name: string;
  kind: string;
  description: string;
  model: string;
  toolCount: number;
  /** false = "all tools" (empty allowedTools). */
  toolsRestricted: boolean;
  maxSteps: number;
  exposeViaAcp: boolean;
  acpDisplayName: string;
  builtin: boolean;
  version: number;
}

export interface CodingV15BudgetMeterView {
  runId: string;
  botId: string;
  profileId: string;
  model: string;
  totalTokens: number;
  tokensPercent: number | null;
  costUsd: number | null;
  costPercent: number | null;
  overCap: boolean;
  warnings: { level: string; dimension: string; percent: number; message: string }[];
  /** Forecast if the run continues at the current pace (optional). */
  forecast?: {
    stepsRemaining: number;
    projectedTotalTokens: number;
    projectedCostUsd: number | null;
    projectedOverCap: boolean;
    recommendation: string;
  } | null;
}

export interface CodingV15BudgetHistoryView {
  runId: string;
  botId: string;
  model: string;
  totalTokens: number;
  costUsd: number | null;
  overCap: boolean;
  records: number;
}

export interface CodingV15HookFeedbackView {
  id: string;
  runId: string;
  hookKind: string;
  source: string;
  title: string;
  body: string;
  severity: string;
  status: string;
  snoozeCount: number;
}

export interface CodingV15VerifyScenarioView {
  scenarioId: string;
  kind: string;
  name: string;
  passed: boolean;
  actual: string;
  failedChecks: string[];
}

export interface CodingV15PanelView {
  profiles: CodingV15ProfileView[];
  selectedProfileId: string | null;
  budget: CodingV15BudgetMeterView | null;
  budgetHistory: CodingV15BudgetHistoryView[];
  hooksPending: CodingV15HookFeedbackView[];
  hooksTotal: number;
  hooksConfirmed: number;
  hooksDismissed: number;
  hooksSnoozed: number;
  verify: CodingV15VerifyScenarioView[];
  verifyPassed: number;
  verifyTotal: number;
  summary: string;
}

type CodingV15Tab = 'profiles' | 'budget' | 'hooks' | 'verify';

const T0 = Date.UTC(2026, 11, 18, 0, 0, 0);

export function demoCodingV15Panel(): CodingV15PanelView {
  return {
    profiles: [
      {
        id: 'v15-general', name: 'General', kind: 'general',
        description: 'Demo: general-purpose coding agent.',
        model: '', toolCount: 0, toolsRestricted: false, maxSteps: 20,
        exposeViaAcp: true, acpDisplayName: 'General [ACP]', builtin: true, version: 1,
      },
      {
        id: 'v15-reviewer', name: 'Reviewer', kind: 'reviewer',
        description: 'Demo: strict code reviewer, read-only.',
        model: '', toolCount: 3, toolsRestricted: true, maxSteps: 12,
        exposeViaAcp: true, acpDisplayName: 'Reviewer [ACP]', builtin: true, version: 1,
      },
      {
        id: 'v15-fixer', name: 'Fixer', kind: 'fixer',
        description: 'Demo: reproduces the failure, then fixes it.',
        model: 'gpt-5', toolCount: 4, toolsRestricted: true, maxSteps: 25,
        exposeViaAcp: true, acpDisplayName: 'Fixer [ACP]', builtin: true, version: 1,
      },
    ],
    selectedProfileId: 'v15-fixer',
    budget: {
      runId: 'demo-run', botId: 'demo-bot', profileId: 'v15-fixer', model: 'gpt-5',
      totalTokens: 850, tokensPercent: 85, costUsd: 0.012, costPercent: 60,
      overCap: false,
      warnings: [{ level: 'warn80', dimension: 'tokens', percent: 85, message: 'Demo: token usage reached 85% of the cap (80% threshold).' }],
      forecast: {
        stepsRemaining: 5, projectedTotalTokens: 1500, projectedCostUsd: 0.021,
        projectedOverCap: true,
        recommendation: 'Demo: projected to exceed the token cap if the run continues at the current pace.',
      },
    },
    budgetHistory: [
      { runId: 'demo-run', botId: 'demo-bot', model: 'gpt-5', totalTokens: 850, costUsd: 0.012, overCap: false, records: 3 },
      { runId: 'demo-run-2', botId: 'demo-bot', model: 'gpt-5', totalTokens: 1200, costUsd: 0.02, overCap: true, records: 5 },
    ],
    hooksPending: [
      {
        id: 'vhf-demo-run-1', runId: 'demo-run', hookKind: 'stop', source: 'stop-hook',
        title: 'Demo: stop hook — tests failed', body: 'Demo: 3 tests failed after the last edit.',
        severity: 'warning', status: 'pending', snoozeCount: 0,
      },
    ],
    hooksTotal: 2,
    hooksConfirmed: 1,
    hooksDismissed: 0,
    hooksSnoozed: 0,
    verify: [
      { scenarioId: 'v15-happy-path', kind: 'happy_path', name: 'Happy path', passed: true, actual: 'Demo: all checks passed.', failedChecks: [] },
      { scenarioId: 'v15-tool-error', kind: 'tool_error', name: 'Tool error', passed: true, actual: 'Demo: all checks passed.', failedChecks: [] },
      { scenarioId: 'v15-timeout', kind: 'timeout', name: 'Step timeout', passed: false, actual: 'Demo: agent kept waiting after timeout.', failedChecks: ['did-not-hang'] },
    ],
    verifyPassed: 2,
    verifyTotal: 3,
    summary: 'Demo: coding agent v15: 3 profiles (Fixer selected), budget 850 tokens (85% of cap, 1 warning), 1 pending hook feedback, verify 2/3 scenarios passed.',
  };
}

function formatUsd(cost: number | null): string {
  if (cost === null) return 'unknown';
  if (cost === 0) return '$0';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

function formatPercent(percent: number | null): string {
  if (percent === null) return 'no cap';
  return `${percent.toFixed(1)}%`;
}

/** Meter bar: 0-100% fill, with 80% / 100% threshold markers. */
function MeterBar({ percent, overCap }: { percent: number | null; overCap: boolean }) {
  const fill = percent === null ? 0 : Math.min(100, percent);
  return (
    <div
      role="progressbar"
      aria-valuenow={percent === null ? undefined : Math.round(percent)}
      aria-valuemin={0}
      aria-valuemax={100}
      style={{
        position: 'relative',
        height: 12,
        border: '1px solid var(--hatch-widget-border)',
        borderRadius: 6,
        overflow: 'hidden',
        background: 'var(--hatch-widget-surface-muted)',
      }}
    >
      <div
        style={{
          width: `${fill}%`,
          height: '100%',
          background: overCap ? '#c0392b' : fill >= 80 ? '#e67e22' : 'var(--hatch-widget-accent)',
        }}
      />
      <div style={{ position: 'absolute', left: '80%', top: 0, bottom: 0, width: 1, background: 'var(--hatch-widget-text)', opacity: 0.6 }} />
    </div>
  );
}

export default function CodingV15Panel({
  panel: panelProp,
  onSelectProfile,
  onHookDecision,
}: {
  panel?: CodingV15PanelView | null;
  /** Host callback: user picked a profile to apply to the next run. */
  onSelectProfile?: (profileId: string) => void;
  /** Host callback: user decided on a hook feedback (confirm/dismiss/snooze). */
  onHookDecision?: (feedbackId: string, decision: 'confirm' | 'dismiss' | 'snooze') => void;
}) {
  const t = useT();
  const [panel] = useState<CodingV15PanelView>(() => panelProp ?? demoCodingV15Panel());
  const [tab, setTab] = useState<CodingV15Tab>('profiles');
  const selected = panel.profiles.find((p) => p.id === panel.selectedProfileId) ?? null;

  return (
    <div>
      <h3>{t('codingV15.title')}</h3>
      <p>{panel.summary}</p>
      <p>{t('codingV15.demo')}</p>
      <div role="tablist" aria-label={t('codingV15.title')}>
        {(['profiles', 'budget', 'hooks', 'verify'] as CodingV15Tab[]).map((name) => (
          <button
            key={name}
            role="tab"
            aria-selected={tab === name}
            type="button"
            onClick={() => setTab(name)}
          >
            {t(`codingV15.panelTab${name[0].toUpperCase()}${name.slice(1)}`)}
            {name === 'hooks' && panel.hooksPending.length > 0 ? ` (${panel.hooksPending.length})` : ''}
          </button>
        ))}
      </div>

      {tab === 'profiles' && (
        <div>
          <h4>{t('codingV15.listProfiles')} ({panel.profiles.length})</h4>
          {panel.profiles.length === 0 ? (
            <p>{t('codingV15.noProfiles')}</p>
          ) : (
            <ul>
              {panel.profiles.map((p) => (
                <li key={p.id}>
                  <strong>{p.acpDisplayName}</strong> — {p.kind}
                  {p.builtin ? ' (built-in)' : ''} — {p.toolsRestricted ? `${p.toolCount} tools` : t('codingV15.allTools')}
                  {` — ${t('codingV15.profileModel')}: `}
                  {p.model ? p.model : 'bot model'}
                  {` — max ${p.maxSteps} steps`}
                  {selected?.id === p.id ? ` — ${t('codingV15.selectProfile')}` : ''}
                  {onSelectProfile && selected?.id !== p.id ? (
                    <button type="button" onClick={() => onSelectProfile(p.id)}>
                      {t('codingV15.applyProfile')}
                    </button>
                  ) : null}
                  <br />
                  <span>{p.description}</span>
                </li>
              ))}
            </ul>
          )}
          {selected && (
            <p>
              {t('codingV15.selectProfile')}: {selected.acpDisplayName} — {selected.description}
            </p>
          )}
        </div>
      )}

      {tab === 'budget' && (
        <div>
          <h4>{t('codingV15.budgetReport')}</h4>
          <p>{t('codingV15.budgetReportOnly')}</p>
          {!panel.budget ? (
            <p>{t('codingV15.noBudgetHistory')}</p>
          ) : (
            <div>
              <p>
                {panel.budget.runId} — {panel.budget.model} — {panel.budget.totalTokens.toLocaleString('en-US')} {t('codingV15.budgetTokens')}
                {` (${formatPercent(panel.budget.tokensPercent)})`}
                {panel.budget.overCap ? ` — ${t('codingV15.budgetOverCap')}` : ''}
              </p>
              <MeterBar percent={panel.budget.tokensPercent} overCap={panel.budget.overCap} />
              <p>
                {t('codingV15.budgetCost')}: {formatUsd(panel.budget.costUsd)}
                {` (${formatPercent(panel.budget.costPercent)})`}
              </p>
              <MeterBar percent={panel.budget.costPercent} overCap={panel.budget.overCap} />
              {panel.budget.warnings.length > 0 && (
                <ul>
                  {panel.budget.warnings.map((w, i) => (
                    <li key={`${w.level}-${w.dimension}-${i}`}>
                      [{w.level}] {w.dimension} {w.percent.toFixed(1)}% — {w.message}
                    </li>
                  ))}
                </ul>
              )}
              {panel.budget.forecast && (
                <div>
                  <p>
                    {t('codingV15.forecast')} ({panel.budget.forecast.stepsRemaining} steps remaining):{' '}
                    {panel.budget.forecast.projectedTotalTokens.toLocaleString('en-US')} {t('codingV15.budgetTokens')}, {formatUsd(panel.budget.forecast.projectedCostUsd)}
                    {panel.budget.forecast.projectedOverCap ? ` — ${t('codingV15.budgetOverCap')}` : ''}
                  </p>
                  <p>{panel.budget.forecast.recommendation}</p>
                </div>
              )}
            </div>
          )}
          <h4>{t('codingV15.budgetHistory')} ({panel.budgetHistory.length})</h4>
          {panel.budgetHistory.length === 0 ? (
            <p>{t('codingV15.noBudgetHistory')}</p>
          ) : (
            <ul>
              {panel.budgetHistory.map((h) => (
                <li key={h.runId}>
                  {h.runId} ({h.model}): {h.totalTokens.toLocaleString('en-US')} {t('codingV15.budgetTokens')}, {formatUsd(h.costUsd)}
                  {h.overCap ? ` — ${t('codingV15.budgetOverCap')}` : ''} — {h.records} records
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === 'hooks' && (
        <div>
          <h4>{t('codingV15.hooksDialogTitle')}</h4>
          <p>
            {panel.hooksPending.length} pending / {panel.hooksTotal} total
            {` — ${panel.hooksConfirmed} confirmed, ${panel.hooksDismissed} dismissed, ${panel.hooksSnoozed} snoozed`}
          </p>
          {panel.hooksPending.length === 0 ? (
            <p>{t('codingV15.hooksDialogEmpty')}</p>
          ) : (
            <ul>
              {panel.hooksPending.map((f) => (
                <li key={f.id}>
                  <strong>[{f.severity}] {f.title}</strong> — {f.source} ({f.hookKind}, run {f.runId})
                  {f.snoozeCount > 0 ? ` (snoozed ${f.snoozeCount}x)` : ''}
                  <br />
                  <span>{f.body}</span>
                  <br />
                  {onHookDecision ? (
                    <span>
                      <button type="button" onClick={() => onHookDecision(f.id, 'confirm')}>
                        {t('codingV15.hooksDialogConfirm')}
                      </button>{' '}
                      <button type="button" onClick={() => onHookDecision(f.id, 'dismiss')}>
                        {t('codingV15.hooksDialogDismiss')}
                      </button>{' '}
                      <button type="button" onClick={() => onHookDecision(f.id, 'snooze')}>
                        {t('codingV15.hooksDialogSnooze')}
                      </button>
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === 'verify' && (
        <div>
          <h4>
            {t('codingV15.verify')} ({panel.verifyPassed}/{panel.verifyTotal})
          </h4>
          {panel.verify.length === 0 ? (
            <p>—</p>
          ) : (
            <ul>
              {panel.verify.map((s) => (
                <li key={s.scenarioId}>
                  {s.passed ? 'PASS' : 'FAIL'} {s.name} — {s.actual}
                  {s.failedChecks.length > 0 && (
                    <ul>
                      {s.failedChecks.map((c) => (
                        <li key={c}>✖ {c}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
