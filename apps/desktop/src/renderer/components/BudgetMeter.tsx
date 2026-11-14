import type { BudgetSnapshotView } from '../types';
import { useT } from '../i18n/useT';
// Renderer-local view contract (`./budgetMeterView`, a mirror of core's
// `conversation/budgetMeterView.ts`). The renderer must NOT value-import
// from `@open-bot/core`: the core bundles are CJS and vite inlines them
// verbatim (`exports` with no `exports` in scope), which throws
// `ReferenceError: exports is not defined` at startup and leaves a blank
// screen (React never mounts). See the header of `./budgetMeterView`.
import { toBudgetMeterView } from './budgetMeterView';

interface Props {
  /** Budget snapshot of the open conversation (null = no data yet). */
  snapshot: BudgetSnapshotView | null;
  /** Name of the bot shown (to tell bots apart when switching). */
  botName?: string;
  /**
   * v1.07 (Team T2): time dimension of the V3 budget meter — elapsed
   * time (ms) + limit (ms). Omitted = no time row shown (backwards
   * compatible with older callers).
   */
  elapsedMs?: number;
  /** Time limit (ms) — null/undefined = no limit. */
  timeLimitMs?: number | null;
}

function formatDuration(ms: number): string {
  const safe = Math.max(0, Math.floor(ms));
  if (safe < 1_000) return `${safe}ms`;
  const totalSeconds = Math.floor(safe / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function formatCost(costUsd: number | null, hasUnknownCost: boolean): string {
  if (costUsd === null) return hasUnknownCost ? '?' : '$0.00';
  return `$${costUsd.toFixed(4)}`;
}

function formatTokens(n: number): string {
  return n.toLocaleString('en-US');
}

/** Segment colours for the stacked meter bar. */
const SEGMENT_COLORS: Record<string, string> = {
  input: '#2563eb',
  output: '#16a34a',
  free: '#e8e8e8',
  over: '#c0392b',
};

/**
 * BudgetMeter (v1.01, Team T3; segments + levels v1.07, Team T5) —
 * token + estimated-cost meter for the open conversation.
 *
 * v1.07 renders the shared view contract (`toBudgetMeterView` in
 * `./budgetMeterView.ts`, mirroring core's
 * `conversation/budgetMeterView.ts`): the component never recomputes
 * a level or a percentage — it renders what the contract computed. The bar is now stacked segments (input /
 * output / free / over) instead of one fill, the level has five
 * steps (ok / watch / warning / critical / exceeded), and a
 * multi-model conversation shows the per-model breakdown. With no
 * caps it just counts (bar shows input/output shares, numbers
 * only). Cost stays `?` when a model has no known price — never a
 * fake $0.
 */
export default function BudgetMeter({ snapshot, botName, elapsedMs, timeLimitMs }: Props) {
  const t = useT();
  if (!snapshot) return null;
  const view = toBudgetMeterView(snapshot);
  const percent = view.percentUsed;
  const barColor =
    view.level === 'exceeded' || view.level === 'critical'
      ? '#c0392b'
      : view.level === 'warning' || view.level === 'watch'
        ? '#d48806'
        : '#2e7d32';
  const statusKey =
    view.level === 'exceeded'
      ? 'budget.exceeded'
      : view.level === 'critical'
        ? 'budget.meter.levelCritical'
        : view.level === 'warning'
          ? 'budget.warning'
          : view.level === 'watch'
            ? 'budget.meter.levelWatch'
            : 'budget.ok';
  return (
    <div
      data-testid="budget-meter"
      style={{
        margin: '0 0 8px',
        padding: '8px 10px',
        borderRadius: 8,
        border: `1px solid ${view.level === 'ok' ? '#d8d8d8' : barColor}`,
        background:
          view.level === 'ok'
            ? 'transparent'
            : view.level === 'exceeded' || view.level === 'critical'
              ? '#fdecea'
              : '#fef6e0',
        fontSize: 12,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <strong>
          {t('budget.title')}
          {botName ? ` — ${botName}` : ''}
        </strong>
        <span style={{ color: barColor, fontWeight: 600 }}>{t(statusKey)}</span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={percent !== null ? Math.round(percent) : 0}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{ display: 'flex', height: 8, borderRadius: 4, background: '#e8e8e8', marginTop: 6, overflow: 'hidden' }}
      >
        {view.segments
          .filter((segment) => segment.ratio > 0)
          .map((segment) => (
            <div
              key={segment.key}
              title={t(`budget.meter.${segment.key}`, { tokens: formatTokens(segment.tokens) })}
              style={{
                width: `${Math.min(100, segment.ratio * 100)}%`,
                height: '100%',
                background: SEGMENT_COLORS[segment.key] ?? '#888888',
                transition: 'width 0.3s',
              }}
            />
          ))}
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 6 }}>
        <span>
          {t('budget.tokens', {
            total: formatTokens(view.totalTokens),
            input: formatTokens(view.inputTokens),
            output: formatTokens(view.outputTokens),
          })}
        </span>
        <span>
          {t('budget.cost', { cost: formatCost(view.costUsd, view.hasUnknownCost) })}
          {view.hasUnknownCost ? ` ${t('budget.unknownCostHint')}` : ''}
        </span>
        {view.tokenLimit !== null && (
          <span>
            {t('budget.tokenLimit', {
              limit: formatTokens(view.tokenLimit),
              percent: percent !== null ? Math.round(percent) : 0,
            })}
          </span>
        )}
        {view.costLimitUsd !== null && (
          <span>{t('budget.costLimit', { limit: `$${view.costLimitUsd.toFixed(2)}` })}</span>
        )}
        {view.remainingTokens !== null && (
          <span>{t('budget.meter.remaining', { tokens: formatTokens(view.remainingTokens) })}</span>
        )}
        {view.model && <span>{t('budget.model', { model: view.model })}</span>}
        {elapsedMs !== undefined && (
          <span>
            {timeLimitMs !== null && timeLimitMs !== undefined
              ? t('harness.v107.budget.timeWithLimit', {
                  elapsed: formatDuration(elapsedMs),
                  limit: formatDuration(timeLimitMs),
                })
              : t('harness.v107.budget.time', { elapsed: formatDuration(elapsedMs) })}
          </span>
        )}
      </div>
      {view.byModel.length > 1 && (
        <div style={{ marginTop: 6, color: '#6b7280' }}>
          {t('budget.meter.byModel')}{' '}
          {view.byModel
            .map(
              (row) =>
                `${row.model}: ${formatTokens(row.totalTokens)} (${Math.round(row.share * 100)}%)`,
            )
            .join(' · ')}
        </div>
      )}
      {view.tokenLimit === null && view.costLimitUsd === null && (
        <div style={{ marginTop: 6, color: '#6b7280' }}>{t('budget.meter.noCap')}</div>
      )}
    </div>
  );
}
