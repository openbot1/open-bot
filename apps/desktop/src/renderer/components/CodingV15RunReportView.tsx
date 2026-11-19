import { useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Coding agent v15 run report view (v1.37, Team T4) — renders one
 * combined run report (profile + budget + hooks dialog + verify +
 * rubric eval) as a structured view.
 *
 * Data comes via props (host builds the view-model from core
 * `buildV15RunReport()` + `v15EvalRun()` via IPC); when there is no
 * host wiring yet it uses an internal demo store — the component
 * never guesses real numbers; the demo is clearly labelled in code
 * and in the UI via the `codingV15.demo` string.
 */

export interface CodingV15RunReportDimensionView {
  name: string;
  weight: number;
  score: number;
  reason: string;
}

export interface CodingV15RunReportHookView {
  id: string;
  title: string;
  body: string;
  severity: string;
  status: string;
}

export interface CodingV15RunReportVerifyView {
  scenarioId: string;
  name: string;
  passed: boolean;
  actual: string;
}

export interface CodingV15RunReportView {
  runId: string;
  botId: string;
  profileSummary: string;
  prompt: string;
  stepsExecuted: number;
  done: boolean;
  stoppedByMaxSteps: boolean;
  filesWritten: string[];
  toolErrors: string[];
  totalTokens: number;
  costUsd: number | null;
  overCap: boolean;
  warnings: string[];
  hooksPending: CodingV15RunReportHookView[];
  hooksTotal: number;
  hooksConfirmed: number;
  hooksDismissed: number;
  verifyPassed: number;
  verifyTotal: number;
  verify: CodingV15RunReportVerifyView[] | null;
  evalTotal: number;
  evalGrade: string;
  evalDimensions: CodingV15RunReportDimensionView[];
  summary: string;
}

const T0 = Date.UTC(2026, 11, 18, 0, 0, 0);

export function demoCodingV15RunReport(): CodingV15RunReportView {
  return {
    runId: 'demo-run',
    botId: 'demo-bot',
    profileSummary: 'Demo: Fixer [ACP] — fixer, 4 tools, model gpt-5, max 25 steps (v1)',
    prompt: 'Demo: fix the login bug.',
    stepsExecuted: 3,
    done: true,
    stoppedByMaxSteps: false,
    filesWritten: ['src/auth.ts'],
    toolErrors: [],
    totalTokens: 850,
    costUsd: 0.012,
    overCap: false,
    warnings: ['[warn80] tokens 85.0% — Demo: token usage reached 85% of the cap.'],
    hooksPending: [
      {
        id: 'vhf-demo-run-1', title: 'Demo: stop hook — tests failed',
        body: 'Demo: 3 tests failed after the last edit.',
        severity: 'warning', status: 'pending',
      },
    ],
    hooksTotal: 2,
    hooksConfirmed: 1,
    hooksDismissed: 0,
    verifyPassed: 8,
    verifyTotal: 9,
    verify: [
      { scenarioId: 'v15-happy-path', name: 'Happy path', passed: true, actual: 'Demo: all checks passed.' },
      { scenarioId: 'v15-tool-error', name: 'Tool error', passed: true, actual: 'Demo: all checks passed.' },
      { scenarioId: 'v15-timeout', name: 'Step timeout', passed: false, actual: 'Demo: agent kept waiting after timeout.' },
    ],
    evalTotal: 92,
    evalGrade: 'A',
    evalDimensions: [
      { name: 'completion', weight: 0.3, score: 100, reason: 'Demo: agent finished (done=true).' },
      { name: 'correctness', weight: 0.25, score: 100, reason: 'Demo: no tool errors; wrote 1 file(s).' },
      { name: 'efficiency', weight: 0.15, score: 84, reason: 'Demo: finished in 3 step(s).' },
      { name: 'budget', weight: 0.15, score: 100, reason: 'Demo: within cap.' },
      { name: 'hooks', weight: 0.15, score: 80, reason: 'Demo: 1/2 hook feedback item(s) still pending.' },
    ],
    summary: 'Demo: run demo-run (Fixer [ACP]): 3 steps, done=true — 850 tokens, $0.01; 1 pending / 2 hook feedback; verify 8/9.',
  };
}

function formatUsd(cost: number | null): string {
  if (cost === null) return 'unknown';
  if (cost === 0) return '$0';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

export default function CodingV15RunReportView({
  report: reportProp,
}: {
  report?: CodingV15RunReportView | null;
}) {
  const t = useT();
  const [report] = useState<CodingV15RunReportView>(() => reportProp ?? demoCodingV15RunReport());

  return (
    <div>
      <h3>{t('codingV15.runReport')} — {report.runId}</h3>
      <p>{report.summary}</p>
      <p>{t('codingV15.demo')}</p>

      <h4>{t('codingV15.profile')}</h4>
      <p>{report.profileSummary}</p>
      <p>
        {t('codingV15.prompt')}: {report.prompt}
      </p>
      <p>
        {report.stepsExecuted} steps, done={String(report.done)}, stoppedByMaxSteps={String(report.stoppedByMaxSteps)}
      </p>
      <p>
        {t('codingV15.filesWritten')}: {report.filesWritten.length > 0 ? report.filesWritten.join(', ') : '—'}
      </p>
      <p>
        {t('codingV15.toolErrors')}: {report.toolErrors.length > 0 ? report.toolErrors.join(' | ') : '—'}
      </p>

      <h4>{t('codingV15.budgetReport')}</h4>
      <p>{t('codingV15.budgetReportOnly')}</p>
      <p>
        {report.totalTokens.toLocaleString('en-US')} {t('codingV15.budgetTokens')} — {t('codingV15.budgetCost')}: {formatUsd(report.costUsd)}
        {report.overCap ? ` — ${t('codingV15.budgetOverCap')}` : ''}
      </p>
      {report.warnings.length > 0 && (
        <ul>
          {report.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}

      <h4>{t('codingV15.hooksDialogTitle')}</h4>
      <p>
        {report.hooksPending.length} pending / {report.hooksTotal} total
        {` — ${report.hooksConfirmed} confirmed, ${report.hooksDismissed} dismissed`}
      </p>
      {report.hooksPending.length === 0 ? (
        <p>{t('codingV15.hooksDialogEmpty')}</p>
      ) : (
        <ul>
          {report.hooksPending.map((f) => (
            <li key={f.id}>
              <strong>[{f.severity}] {f.title}</strong> — {f.status}
              <br />
              <span>{f.body}</span>
            </li>
          ))}
        </ul>
      )}

      <h4>
        {t('codingV15.verify')} ({report.verifyPassed}/{report.verifyTotal})
      </h4>
      {!report.verify ? (
        <p>—</p>
      ) : (
        <ul>
          {report.verify.map((s) => (
            <li key={s.scenarioId}>
              {s.passed ? 'PASS' : 'FAIL'} {s.name} — {s.actual}
            </li>
          ))}
        </ul>
      )}

      <h4>
        {t('codingV15.eval')} — {report.evalTotal}/100 ({t('codingV15.grade')}: {report.evalGrade})
      </h4>
      <ul>
        {report.evalDimensions.map((d) => (
          <li key={d.name}>
            {d.name} ({Math.round(d.weight * 100)}%): {d.score} — {d.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}
