import { useCallback, useEffect, useState } from 'react';
import type {
  EvalCaseResultView,
  EvalCheckView,
  EvalSuiteReportView,
  EvalSuiteView,
  RunLogMetaView,
} from '../types';
import { useT } from '../i18n/useT';

/**
 * Eval harness UI (v1.03) — score recorded runs against expectations.
 *
 * Suites live in `<userData>/evals.json` (IPC `evals:*`, see main.ts).
 * A case is a set of checks (tool used, no errors, tokens/duration
 * under a budget, file changed, text contains). Scoring replays a
 * recorded run (IPC `runlog:replay` data, via `evals:score-case` /
 * `evals:run-suite`) — deterministic and free, never a live run.
 * The UI only picks which recorded run answers each case.
 */

async function callOpenBot<T>(channel: string, camel: string, ...args: unknown[]): Promise<T | null> {
  const api = window.openBot as unknown as Record<string, unknown>;
  const fn = api[channel] ?? api[camel];
  if (typeof fn !== 'function') return null;
  return (fn as (...a: unknown[]) => Promise<T>).apply(window.openBot, args);
}

interface Props {
  onBack: () => void;
}

const CHECK_KINDS = ['tool-used', 'tool-not-used', 'no-errors', 'tokens-under', 'duration-under', 'file-changed', 'text-contains'] as const;

export default function EvalHarnessView({ onBack }: Props) {
  const t = useT();
  const [suites, setSuites] = useState<EvalSuiteView[]>([]);
  const [runs, setRuns] = useState<RunLogMetaView[]>([]);
  const [selectedSuiteId, setSelectedSuiteId] = useState('');
  const [newSuiteName, setNewSuiteName] = useState('');
  const [newCaseName, setNewCaseName] = useState('');
  const [newCasePrompt, setNewCasePrompt] = useState('');
  const [checkKind, setCheckKind] = useState<(typeof CHECK_KINDS)[number]>('no-errors');
  const [checkValue, setCheckValue] = useState('');
  const [checks, setChecks] = useState<EvalCheckView[]>([]);
  const [runsByCase, setRunsByCase] = useState<Record<string, string>>({});
  const [report, setReport] = useState<EvalSuiteReportView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, runList] = await Promise.all([
        callOpenBot<EvalSuiteView[]>('evals:list', 'listEvalSuites'),
        callOpenBot<RunLogMetaView[]>('runlog:list', 'listRunLogs'),
      ]);
      if (list) {
        setSuites(list);
        if (!selectedSuiteId && list.length > 0) setSelectedSuiteId(list[0].id);
      }
      if (runList) setRuns(runList);
    } catch (err) {
      setError((err as Error).message || t('evalHarness.loadError'));
    } finally {
      setLoading(false);
    }
  }, [t, selectedSuiteId]);

  useEffect(() => {
    void load();
  }, [load]);

  const suite = suites.find((s) => s.id === selectedSuiteId) ?? null;

  async function handleCreateSuite() {
    if (!newSuiteName.trim()) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const created = await callOpenBot<EvalSuiteView>('evals:create-suite', 'createEvalSuite', {
        name: newSuiteName.trim(),
      });
      if (!created) throw new Error(t('evalHarness.createError'));
      setSuites((prev) => [...prev, created]);
      setSelectedSuiteId(created.id);
      setNewSuiteName('');
      setNotice(t('evalHarness.suiteCreated'));
    } catch (err) {
      setError((err as Error).message || t('evalHarness.createError'));
    } finally {
      setBusy(false);
    }
  }

  function handleAddCheck() {
    let check: EvalCheckView | null = null;
    if (checkKind === 'tool-used' || checkKind === 'tool-not-used') {
      if (!checkValue.trim()) return;
      check = { kind: checkKind, tool: checkValue.trim() };
    } else if (checkKind === 'no-errors') {
      check = { kind: 'no-errors' };
    } else if (checkKind === 'tokens-under') {
      const maxTokens = Number(checkValue);
      if (!Number.isFinite(maxTokens) || maxTokens <= 0) return;
      check = { kind: 'tokens-under', maxTokens };
    } else if (checkKind === 'duration-under') {
      const maxMs = Number(checkValue);
      if (!Number.isFinite(maxMs) || maxMs <= 0) return;
      check = { kind: 'duration-under', maxMs };
    } else if (checkKind === 'file-changed') {
      if (!checkValue.trim()) return;
      check = { kind: 'file-changed', path: checkValue.trim() };
    } else if (checkKind === 'text-contains') {
      if (!checkValue.trim()) return;
      check = { kind: 'text-contains', text: checkValue.trim() };
    }
    if (check) {
      setChecks((prev) => [...prev, check as EvalCheckView]);
      setCheckValue('');
    }
  }

  async function handleAddCase() {
    if (!suite || !newCaseName.trim() || checks.length === 0) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const created = await callOpenBot<import('../types').EvalCaseView>('evals:add-case', 'addEvalCase', {
        suiteId: suite.id,
        name: newCaseName.trim(),
        prompt: newCasePrompt.trim() || undefined,
        checks,
      });
      if (!created) throw new Error(t('evalHarness.createError'));
      setSuites((prev) => prev.map((s) => (s.id === suite.id ? { ...s, cases: [...s.cases, created] } : s)));
      setNewCaseName('');
      setNewCasePrompt('');
      setChecks([]);
      setNotice(t('evalHarness.caseCreated'));
    } catch (err) {
      setError((err as Error).message || t('evalHarness.createError'));
    } finally {
      setBusy(false);
    }
  }

  async function handleRunSuite() {
    if (!suite) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const result = await callOpenBot<EvalSuiteReportView>('evals:run-suite', 'runEvalSuite', {
        suiteId: suite.id,
        runsByCaseId: runsByCase,
      });
      if (!result) throw new Error(t('evalHarness.runError'));
      setReport(result);
    } catch (err) {
      setError((err as Error).message || t('evalHarness.runError'));
    } finally {
      setBusy(false);
    }
  }

  function checkLabel(check: EvalCheckView): string {
    if (check.kind === 'tool-used') return t('evalHarness.checkToolUsed', { tool: check.tool ?? '' });
    if (check.kind === 'tool-not-used') return t('evalHarness.checkToolNotUsed', { tool: check.tool ?? '' });
    if (check.kind === 'no-errors') return t('evalHarness.checkNoErrors');
    if (check.kind === 'tokens-under') return t('evalHarness.checkTokensUnder', { max: check.maxTokens ?? 0 });
    if (check.kind === 'duration-under') return t('evalHarness.checkDurationUnder', { max: check.maxMs ?? 0 });
    if (check.kind === 'file-changed') return t('evalHarness.checkFileChanged', { path: check.path ?? '' });
    return t('evalHarness.checkTextContains', { text: check.text ?? '' });
  }

  return (
    <div>
      <div className="row" style={{ alignItems: 'center', gap: 8 }}>
        <button className="btn secondary" onClick={onBack}>
          {t('marketplace.back')}
        </button>
        <h2 style={{ margin: 0, flex: 1 }}>{t('evalHarness.title')}</h2>
        <button className="btn secondary" onClick={() => void load()} disabled={loading}>
          {t('fleet.refresh')}
        </button>
      </div>
      <p style={{ color: '#666', marginTop: 4 }}>{t('evalHarness.subtitle')}</p>

      {loading && <p>{t('marketplace.loading')}</p>}
      {error && <p style={{ color: '#c00' }}>{error}</p>}
      {notice && <p style={{ color: '#080' }}>{notice}</p>}

      {!loading && !error && (
        <div>
          <div className="row" style={{ gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <label>
              {t('evalHarness.suite')}{' '}
              <select value={selectedSuiteId} onChange={(e) => { setSelectedSuiteId(e.target.value); setReport(null); }}>
                {suites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.cases.length})
                  </option>
                ))}
              </select>
            </label>
            <input
              value={newSuiteName}
              onChange={(e) => setNewSuiteName(e.target.value)}
              placeholder={t('evalHarness.newSuitePlaceholder')}
            />
            <button className="btn secondary" disabled={busy || !newSuiteName.trim()} onClick={() => void handleCreateSuite()}>
              {t('evalHarness.createSuite')}
            </button>
          </div>

          {suites.length === 0 && <p>{t('evalHarness.noSuites')}</p>}

          {suite && (
            <div>
              <h3 style={{ margin: '8px 0' }}>{suite.name}</h3>
              {suite.cases.length === 0 && <p>{t('evalHarness.noCases')}</p>}
              {suite.cases.map((c) => (
                <div key={c.id} style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, marginBottom: 10 }}>
                  <strong>{c.name}</strong>
                  <div style={{ color: '#666', fontSize: 13, marginTop: 4 }}>
                    {c.checks.map((ch) => checkLabel(ch)).join(' · ')}
                  </div>
                  <div className="row" style={{ gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <label style={{ fontSize: 13 }}>
                      {t('evalHarness.runForCase')}{' '}
                      <select
                        value={runsByCase[c.id] ?? ''}
                        onChange={(e) => setRunsByCase((prev) => ({ ...prev, [c.id]: e.target.value }))}
                      >
                        <option value="">{t('evalHarness.noRun')}</option>
                        {runs.map((r) => (
                          <option key={r.runId} value={r.runId}>
                            {(r.title ?? r.runId.slice(0, 8))} · {r.status}
                          </option>
                        ))}
                      </select>
                    </label>
                    {report && (
                      <span style={{ fontSize: 13 }}>
                        {(() => {
                          const result: EvalCaseResultView | undefined = report.results.find((r) => r.caseId === c.id);
                          if (!result) return t('evalHarness.skipped');
                          return result.passed
                            ? t('evalHarness.passed')
                            : t('evalHarness.failed', { score: Math.round(result.score * 100) });
                        })()}
                      </span>
                    )}
                  </div>
                </div>
              ))}

              <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, marginTop: 12 }}>
                <strong>{t('evalHarness.addCase')}</strong>
                <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                  <input
                    value={newCaseName}
                    onChange={(e) => setNewCaseName(e.target.value)}
                    placeholder={t('evalHarness.caseNamePlaceholder')}
                    style={{ flex: 1, minWidth: 140 }}
                  />
                  <input
                    value={newCasePrompt}
                    onChange={(e) => setNewCasePrompt(e.target.value)}
                    placeholder={t('evalHarness.casePromptPlaceholder')}
                    style={{ flex: 1, minWidth: 180 }}
                  />
                </div>
                <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <select value={checkKind} onChange={(e) => setCheckKind(e.target.value as (typeof CHECK_KINDS)[number])}>
                    {CHECK_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                  {checkKind !== 'no-errors' && (
                    <input
                      value={checkValue}
                      onChange={(e) => setCheckValue(e.target.value)}
                      placeholder={t('evalHarness.checkValuePlaceholder')}
                      style={{ flex: 1, minWidth: 140 }}
                    />
                  )}
                  <button className="btn secondary" onClick={handleAddCheck}>
                    {t('evalHarness.addCheck')}
                  </button>
                </div>
                {checks.length > 0 && (
                  <div style={{ marginTop: 8, fontSize: 13 }}>
                    {checks.map((ch, i) => (
                      <div key={i}>· {checkLabel(ch)}</div>
                    ))}
                  </div>
                )}
                <div className="row" style={{ gap: 8, marginTop: 8 }}>
                  <button className="btn" disabled={busy || !newCaseName.trim() || checks.length === 0} onClick={() => void handleAddCase()}>
                    {t('evalHarness.addCase')}
                  </button>
                  <button className="btn" disabled={busy || suite.cases.length === 0} onClick={() => void handleRunSuite()}>
                    {t('evalHarness.runSuite')}
                  </button>
                </div>
              </div>

              {report && (
                <div style={{ border: '1px solid #aaa', borderRadius: 8, padding: 12, marginTop: 12 }}>
                  <strong>{t('evalHarness.report')}</strong>
                  <div style={{ marginTop: 6 }}>
                    {t('evalHarness.reportSummary', {
                      passed: report.passed,
                      failed: report.failed,
                      skipped: report.skipped.length,
                      rate: Math.round(report.passRate * 100),
                    })}
                  </div>
                  <div style={{ color: '#666', fontSize: 13, marginTop: 4 }}>
                    {t('evalHarness.totalTokens', { count: report.totalTokens })}
                    {report.slowestMs !== null ? ` · ${t('evalHarness.slowest', { ms: report.slowestMs })}` : ''}
                  </div>
                  {report.results.map((r) => (
                    <div key={r.caseId} style={{ marginTop: 8, fontSize: 14 }}>
                      <strong style={{ color: r.passed ? '#080' : '#c00' }}>
                        {r.passed ? '✓' : '✗'} {r.caseName}
                      </strong>
                      {r.checks
                        .filter((ch) => !ch.passed)
                        .map((ch, i) => (
                          <div key={i} style={{ color: '#c00', fontSize: 13 }}>
                            {ch.detail}
                          </div>
                        ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
