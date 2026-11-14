import type { McpAppViewLike } from '../types';
import { useT } from '../i18n/useT';

/**
 * Security review UI for MCP Apps v2 (v1.05, wave T2).
 *
 * Before running an app, the host must show the user what the app asks for.
 * This component renders exactly the summary that core builds
 * (`buildSecurityReview` trong packages/core/src/mcp/appsV2Manifest.ts):
 * tools / roots / network / data / actions, risk level, warnings,
 * and the run policy (allowed / needs confirmation / denied).
 *
 * The component does not fetch data itself: it receives `review` via props
 * (the main process will provide the full review once the bridge has it — see
 * `buildReviewFromApp` below, a cautiously inferred version from the data
 * of the current app list: an app without a declaration counts as unreviewed,
 * display only, no tool calls).
 */

/** One permission an app asks for (mirrors AppRequestedPermission in core). */
export interface AppReviewPermissionView {
  kind: 'tools' | 'roots' | 'network' | 'data' | 'actions';
  label: string;
  detail?: string;
  risky: boolean;
}

/** A security review to render (mirrors AppSecurityReview in core). */
export interface AppSecurityReviewView {
  templateId: string;
  title: string;
  serverName: string;
  version?: string;
  review: 'unreviewed' | 'reviewed' | 'approved' | 'rejected';
  requiresWarning: boolean;
  fingerprintShort: string;
  risk: 'low' | 'medium' | 'high';
  permissions: AppReviewPermissionView[];
  warnings: string[];
  summary: string;
  /** Summarised sandbox policy v2 (when the host can compute it). */
  sandboxSummary?: string;
  /** Run policy: allowed / needs confirmation / denied. */
  runAllowed: boolean;
  runNeedsConfirmation: boolean;
  runReason: string;
}

const RISK_KEYS: Record<AppSecurityReviewView['risk'], string> = {
  low: 'mcpApps.review.risk.low',
  medium: 'mcpApps.review.risk.medium',
  high: 'mcpApps.review.risk.high',
};

const REVIEW_KEYS: Record<AppSecurityReviewView['review'], string> = {
  unreviewed: 'mcpApps.review.status.unreviewed',
  reviewed: 'mcpApps.review.status.reviewed',
  approved: 'mcpApps.review.status.approved',
  rejected: 'mcpApps.review.status.rejected',
};

const PERMISSION_KIND_KEYS: Record<AppReviewPermissionView['kind'], string> = {
  tools: 'mcpApps.review.permission.tools',
  roots: 'mcpApps.review.permission.roots',
  network: 'mcpApps.review.permission.network',
  data: 'mcpApps.review.permission.data',
  actions: 'mcpApps.review.permission.actions',
};

function riskColor(risk: AppSecurityReviewView['risk']): string {
  if (risk === 'high') return 'var(--danger, #c0392b)';
  if (risk === 'medium') return 'var(--warn, #b7791f)';
  return 'var(--text-dim)';
}

/**
 * Build a cautious review from the current app list data
 * (McpAppViewLike — no v2 declaration from the bridge yet). Any app
 * counts as unreviewed; permissions are inferred from origin:
 *  - sample: display only, no permissions.
 *  - tool-result: may call the tool that returned it (tool name shown).
 *  - manual: display only.
 * The main process later replaces this with the full `buildSecurityReview` from
 * the declaration — this component stays unchanged.
 */
export function buildReviewFromApp(app: McpAppViewLike): AppSecurityReviewView {
  const permissions: AppReviewPermissionView[] = [];
  if (app.origin === 'tool-result' && app.toolName) {
    permissions.push({
      kind: 'tools',
      label: 'Call tool',
      detail: app.toolName,
      risky: true,
    });
  }
  if (app.origin === 'sample') {
    permissions.push({
      kind: 'data',
      label: 'Built-in sample app',
      detail: 'Sample open-bot HTML, not fetched from an outside server',
      risky: false,
    });
  }
  const risk: AppSecurityReviewView['risk'] =
    app.origin === 'tool-result' ? 'medium' : 'low';
  return {
    templateId: app.id,
    title: app.title,
    serverName: app.serverName,
    review: 'unreviewed',
    requiresWarning: true,
    fingerprintShort: '—',
    risk,
    permissions,
    warnings:
      app.origin === 'tool-result'
        ? ['App not reviewed yet — check the permissions below before running it.']
        : [],
    summary: `${app.title} (${app.id}) — review: unreviewed, risk: ${risk}.`,
    runAllowed: true,
    runNeedsConfirmation: app.origin === 'tool-result',
    runReason:
      app.origin === 'tool-result'
        ? 'Unreviewed app was called as a tool — the user must confirm before running it.'
        : 'Built-in sample app — runnable.',
  };
}

interface Props {
  review: AppSecurityReviewView;
  /** User clicked "Run" after reading the review (when confirmation is needed). */
  onApprove?: () => void;
  /** User clicked "Do not run". */
  onReject?: () => void;
  /** Waiting for confirmation (button disabled). */
  busy?: boolean;
}

export default function McpAppSecurityReview({ review, onApprove, onReject, busy }: Props) {
  const t = useT();
  return (
    <div
      className="panel"
      style={{ marginBottom: 12, borderColor: review.requiresWarning ? riskColor(review.risk) : undefined }}
    >
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>{t('mcpApps.review.title')}</h3>
        <span className="badge" style={{ color: riskColor(review.risk) }}>
          {t(RISK_KEYS[review.risk])}
        </span>
      </div>
      <p style={{ margin: '8px 0 0', color: 'var(--text-dim)' }}>
        {t('mcpApps.review.app', { title: review.title, server: review.serverName })}
        {review.version ? ` · ${t('mcpApps.review.version', { version: review.version })}` : ''}
        {` · ${t(REVIEW_KEYS[review.review])}`}
        {review.fingerprintShort !== '—'
          ? ` · ${t('mcpApps.review.fingerprint', { fingerprint: review.fingerprintShort })}`
          : ''}
      </p>
      {review.permissions.length === 0 ? (
        <p style={{ margin: '8px 0 0' }}>{t('mcpApps.review.noPermissions')}</p>
      ) : (
        <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
          {review.permissions.map((permission, index) => (
            <li key={`${permission.kind}-${index}`}>
              <strong>{t(PERMISSION_KIND_KEYS[permission.kind])}</strong>
              {`: ${permission.label}`}
              {permission.detail ? ` (${permission.detail})` : ''}
              {permission.risky ? ` — ${t('mcpApps.review.risky')}` : ''}
            </li>
          ))}
        </ul>
      )}
      {review.warnings.map((warning, index) => (
        <p key={index} className="error" style={{ margin: '8px 0 0' }}>
          {warning}
        </p>
      ))}
      {review.sandboxSummary !== undefined && (
        <p style={{ margin: '8px 0 0', color: 'var(--text-dim)' }}>
          {t('mcpApps.review.sandbox', { summary: review.sandboxSummary })}
        </p>
      )}
      <p style={{ margin: '8px 0 0', color: 'var(--text-dim)' }}>
        {review.runReason}
      </p>
      {(onApprove !== undefined || onReject !== undefined) && (
        <div className="row" style={{ gap: 8, marginTop: 12 }}>
          {onApprove !== undefined && (
            <button className="btn" onClick={onApprove} disabled={busy === true || !review.runAllowed}>
              {review.runNeedsConfirmation
                ? t('mcpApps.review.approveAnyway')
                : t('mcpApps.review.approve')}
            </button>
          )}
          {onReject !== undefined && (
            <button className="btn secondary" onClick={onReject} disabled={busy === true}>
              {t('mcpApps.review.reject')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
