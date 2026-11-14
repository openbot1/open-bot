import type { CriticReport } from '@open-bot/core';
import { useT } from '../i18n/useT';

interface Props {
  /** Critic report of the just-finished turn (null = critic has not run yet). */
  report: CriticReport | null;
}

/**
 * CriticInlineCard (v1.07, Team T2) — renders the verification result
 * RIGHT INSIDE THE CHAT FLOW (following the OpenHands idea: the
 * critic/verification renders inline in the conversation). The card
 * shows the verdict (✅ pass / ⚠️ partial / ❌ fail), a one-line
 * summary, and each check (✓/✗ + label + note). The host inserts
 * this component under the turn's result message (same spot as the
 * markdown `renderCriticInline` when the chat renders text only).
 */
export default function CriticInlineCard({ report }: Props) {
  const t = useT();
  if (!report) return null;
  const color =
    report.verdict === 'pass' ? '#2e7d32' : report.verdict === 'partial' ? '#d48806' : '#c0392b';
  const icon = report.verdict === 'pass' ? '✅' : report.verdict === 'partial' ? '⚠️' : '❌';
  const titleKey =
    report.verdict === 'pass'
      ? 'harness.v107.critic.pass'
      : report.verdict === 'partial'
        ? 'harness.v107.critic.partial'
        : 'harness.v107.critic.fail';
  return (
    <div
      data-testid="critic-inline-card"
      style={{
        margin: '0 0 8px',
        padding: '8px 10px',
        borderRadius: 8,
        border: `1px solid ${color}`,
        background:
          report.verdict === 'pass' ? '#eef7ee' : report.verdict === 'partial' ? '#fef6e0' : '#fdecea',
        fontSize: 12,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <strong>
          {icon} {t(titleKey)}
        </strong>
        <span style={{ color, fontWeight: 600 }}>
          {t('harness.v107.critic.score', { passed: report.passedCount, total: report.totalCount })}
        </span>
      </div>
      <div style={{ marginTop: 4 }}>{report.summary}</div>
      {report.checks.length > 0 && (
        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {report.checks.map((check) => (
            <li key={check.id}>
              {check.passed ? '✓' : '✗'} {check.label}
              {check.note ? ` — ${check.note}` : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
