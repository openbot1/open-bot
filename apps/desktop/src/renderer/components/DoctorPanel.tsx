import { useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * DoctorPanel (v1.05, Team T3) — runs `open-bot doctor` inside the
 * app: checks Node, configured providers, local Ollama, MCP servers,
 * RAM, disk and the headless port. Results come from IPC 'doctor:run'
 * (main runs runDoctorChecks with the real userData + Vault).
 *
 * Read-only panel — it changes nothing and never shows a secret
 * (doctor details never contain keys).
 */

interface DoctorCheckView {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  hint?: string;
}

interface DoctorReportView {
  ok: boolean;
  summary: { ok: number; warn: number; fail: number };
  checks: DoctorCheckView[];
  checkedAt: string;
  durationMs: number;
}

export default function DoctorPanel() {
  const t = useT();
  const [report, setReport] = useState<DoctorReportView | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  const run = async () => {
    if (typeof window.openBot.runDoctor !== 'function') return;
    setRunning(true);
    setError('');
    try {
      const res = await window.openBot.runDoctor();
      setReport(res);
    } catch {
      setReport(null);
      setError(t('doctor.error'));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div data-testid="doctor-panel">
      <p className="hint">{t('doctor.intro')}</p>
      <button
        type="button"
        className="btn secondary"
        data-testid="doctor-run"
        disabled={running}
        onClick={() => void run()}
      >
        {running ? t('doctor.running') : t('doctor.run')}
      </button>
      {error && <p className="error">{error}</p>}
      {report && (
        <div style={{ marginTop: 12 }}>
          <p
            className={report.ok ? 'hint' : 'error'}
            data-testid="doctor-verdict"
          >
            {report.ok
              ? t('doctor.verdictOk', { ok: report.summary.ok, warn: report.summary.warn })
              : t('doctor.verdictFail', { fail: report.summary.fail, warn: report.summary.warn })}
          </p>
          <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0' }}>
            {report.checks.map((check) => (
              <li key={check.id} style={{ margin: '6px 0' }}>
                <span aria-hidden>{check.status === 'ok' ? '✓ ' : check.status === 'warn' ? '! ' : '✗ '}</span>
                <strong>{check.label}:</strong> {check.detail}
                {check.hint && <div className="hint">↳ {check.hint}</div>}
              </li>
            ))}
          </ul>
          <p className="hint">
            {t('doctor.checkedAt', { time: new Date(report.checkedAt).toLocaleTimeString() })}
          </p>
        </div>
      )}
    </div>
  );
}
