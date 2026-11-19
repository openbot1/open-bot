/**
 * MCP Apps render v2 — interactive UI renderer (v1.44, Team T3).
 *
 * Renders a validated UI descriptor (see
 * `packages/core/src/mcp/appsRenderV2.ts`) as real controls — no
 * HTML, no iframe, no `innerHTML` on this path. The descriptor
 * tree is data: text, headings, buttons, inputs, selects, lists,
 * progress bars and alerts. Every interaction goes out through
 * callbacks; the coordinator wires them to
 * `AppRenderSession.dispatchAction` / `setInput` one layer up.
 *
 * Purely presentational: all state comes in via props, so the
 * panel is testable without Electron. A suspended session shows
 * its last state read-only; an errored session shows the error
 * with a close button; an unreviewed template shows the review
 * warning banner until the user acknowledges it.
 */
import { useState } from 'react';
import { useT } from '../i18n/useT';

export type McpRenderV2NodeKind =
  | 'container'
  | 'heading'
  | 'text'
  | 'alert'
  | 'divider'
  | 'image'
  | 'button'
  | 'input'
  | 'select'
  | 'progress'
  | 'list'
  | 'form';

export interface McpRenderV2Node {
  id: string;
  kind: McpRenderV2NodeKind;
  text?: string;
  tone?: 'info' | 'success' | 'warning' | 'error' | 'neutral';
  src?: string;
  alt?: string;
  name?: string;
  inputType?: 'text' | 'number' | 'password' | 'email';
  placeholder?: string;
  value?: string;
  options?: { value: string; label: string }[];
  progress?: number;
  progressLabel?: string;
  items?: string[];
  hasAction?: boolean;
  children?: McpRenderV2Node[];
}

export type McpRenderV2SessionState = 'mounting' | 'mounted' | 'suspended' | 'error' | 'unmounted';

export interface McpRenderV2Session {
  sessionId: string;
  templateId: string;
  serverName: string;
  title: string;
  state: McpRenderV2SessionState;
  nodeCount: number;
  reviewWarning: boolean;
  inputState: Record<string, string>;
  actionCount: number;
  deniedCount: number;
  error?: string;
}

interface Props {
  session: McpRenderV2Session;
  root: McpRenderV2Node;
  /** Last action denial, shown inline (from the host). */
  lastDenial?: string;
  onAction?: (nodeId: string) => void;
  onInput?: (name: string, value: string) => void;
  onSuspend?: (sessionId: string) => void;
  onResume?: (sessionId: string) => void;
  onClose?: (sessionId: string) => void;
  onBack?: () => void;
}

const SESSION_STATE_KEYS: Record<McpRenderV2SessionState, string> = {
  mounting: 'mcpV144T3.sessionState.mounting',
  mounted: 'mcpV144T3.sessionState.mounted',
  suspended: 'mcpV144T3.sessionState.suspended',
  error: 'mcpV144T3.sessionState.error',
  unmounted: 'mcpV144T3.sessionState.unmounted',
};

const TONE_STYLES: Record<string, React.CSSProperties> = {
  info: { borderLeft: '3px solid #1976d2', background: 'rgba(25,118,210,0.08)' },
  success: { borderLeft: '3px solid #2e7d32', background: 'rgba(46,125,50,0.08)' },
  warning: { borderLeft: '3px solid #ed6c02', background: 'rgba(237,108,2,0.10)' },
  error: { borderLeft: '3px solid #c0392b', background: 'rgba(192,57,43,0.08)' },
  neutral: { borderLeft: '3px solid #888', background: 'rgba(128,128,128,0.08)' },
};

function countNodes(node: McpRenderV2Node): number {
  return 1 + (node.children ?? []).reduce((sum, child) => sum + countNodes(child), 0);
}

export default function McpAppsRenderV2({
  session,
  root,
  lastDenial,
  onAction,
  onInput,
  onSuspend,
  onResume,
  onClose,
  onBack,
}: Props) {
  const t = useT();
  const [warningAcked, setWarningAcked] = useState(false);
  const [busyNode, setBusyNode] = useState<string | null>(null);
  const interactive = session.state === 'mounted';
  const showWarning = session.reviewWarning && !warningAcked;

  function handleAction(nodeId: string): void {
    if (!interactive) return;
    setBusyNode(nodeId);
    onAction?.(nodeId);
    setBusyNode(null);
  }

  function renderNode(node: McpRenderV2Node, depth: number): React.ReactNode {
    const key = node.id;
    switch (node.kind) {
      case 'container':
        return (
          <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingLeft: depth > 0 ? 8 : 0 }}>
            {(node.children ?? []).map((child) => renderNode(child, depth + 1))}
          </div>
        );
      case 'heading':
        return (
          <h3 key={key} style={{ margin: '4px 0' }}>
            {node.text}
          </h3>
        );
      case 'text':
        return (
          <p key={key} style={{ margin: '2px 0' }}>
            {node.text}
          </p>
        );
      case 'alert': {
        const tone = node.tone ?? 'info';
        return (
          <div key={key} role="alert" style={{ padding: '8px 10px', borderRadius: 4, ...(TONE_STYLES[tone] ?? {}) }}>
            {node.text}
          </div>
        );
      }
      case 'divider':
        return <hr key={key} style={{ width: '100%', opacity: 0.4 }} />;
      case 'image':
        return node.src ? (
          // Images come only from validated https:// / ui:// URLs.
          // eslint-disable-next-line jsx-a11y/alt-text
          <img key={key} src={node.src} alt={node.alt ?? ''} style={{ maxWidth: '100%', borderRadius: 4 }} />
        ) : null;
      case 'button':
        return (
          <button
            key={key}
            type="button"
            disabled={!interactive || busyNode === node.id}
            onClick={() => handleAction(node.id)}
            style={{
              alignSelf: 'flex-start',
              padding: '6px 12px',
              borderRadius: 4,
              cursor: interactive ? 'pointer' : 'not-allowed',
              ...(node.tone === 'error' ? { borderColor: '#c0392b', color: '#c0392b' } : {}),
            }}
          >
            {node.text}
          </button>
        );
      case 'input': {
        const name = node.name ?? node.id;
        return (
          <label key={key} style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
            {node.text ?? name}
            <input
              type={node.inputType ?? 'text'}
              name={name}
              value={session.inputState[name] ?? node.value ?? ''}
              placeholder={node.placeholder}
              disabled={!interactive}
              onChange={(e) => onInput?.(name, e.target.value)}
              style={{ padding: '6px 8px', borderRadius: 4, border: '1px solid #aaa' }}
            />
          </label>
        );
      }
      case 'select': {
        const name = node.name ?? node.id;
        return (
          <label key={key} style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
            {node.text ?? name}
            <select
              name={name}
              value={session.inputState[name] ?? node.value ?? ''}
              disabled={!interactive}
              onChange={(e) => onInput?.(name, e.target.value)}
              style={{ padding: '6px 8px', borderRadius: 4, border: '1px solid #aaa' }}
            >
              {(node.options ?? []).map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
        );
      }
      case 'progress': {
        const pct = Math.max(0, Math.min(100, Math.round((node.progress ?? 0) * 100)));
        return (
          <div key={key}>
            {node.progressLabel ? <div style={{ fontSize: 12, opacity: 0.8 }}>{node.progressLabel}</div> : null}
            <div
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={node.progressLabel ?? node.id}
              style={{ height: 8, background: '#eee', borderRadius: 4, overflow: 'hidden', marginTop: 4 }}
            >
              <div style={{ width: `${pct}%`, height: '100%', background: '#2e7d32' }} />
            </div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>{pct}%</div>
          </div>
        );
      }
      case 'list':
        return (
          <ul key={key} style={{ margin: '2px 0', paddingLeft: 18 }}>
            {(node.items ?? []).map((item, index) => (
              <li key={`${node.id}-${index}`}>{item}</li>
            ))}
          </ul>
        );
      case 'form':
        return (
          <form
            key={key}
            onSubmit={(e) => {
              e.preventDefault();
              handleAction(node.id);
            }}
            style={{ display: 'flex', flexDirection: 'column', gap: 8, border: '1px solid #ddd', borderRadius: 6, padding: 10 }}
          >
            {(node.children ?? []).map((child) => renderNode(child, depth + 1))}
            <button type="submit" disabled={!interactive} style={{ alignSelf: 'flex-start', padding: '6px 12px', borderRadius: 4 }}>
              {t('mcpV144T3.formSubmit')}
            </button>
          </form>
        );
      default:
        return null;
    }
  }

  return (
    <section aria-label={t('mcpV144T3.renderTitle')}>
      <header style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {onBack ? <button type="button" onClick={onBack}>{t('mcpV144T3.back')}</button> : null}
        <h2 style={{ margin: 0 }}>{session.title}</h2>
        <span style={{ fontSize: 12, opacity: 0.7 }}>
          {session.serverName} · {t(SESSION_STATE_KEYS[session.state])}
          {' · '}
          {t('mcpV144T3.nodesCount', { count: countNodes(root) })}
          {' · '}
          {t('mcpV144T3.actionsCount', { count: session.actionCount })}
          {session.deniedCount > 0 ? ` · ${t('mcpV144T3.deniedCount', { count: session.deniedCount })}` : ''}
        </span>
        <span style={{ flex: 1 }} />
        {session.state === 'mounted' ? (
          <button type="button" onClick={() => onSuspend?.(session.sessionId)}>{t('mcpV144T3.suspend')}</button>
        ) : null}
        {session.state === 'suspended' ? (
          <button type="button" onClick={() => onResume?.(session.sessionId)}>{t('mcpV144T3.resume')}</button>
        ) : null}
        <button type="button" onClick={() => onClose?.(session.sessionId)}>{t('mcpV144T3.close')}</button>
      </header>

      {showWarning ? (
        <div role="alert" style={{ ...TONE_STYLES.warning, padding: '8px 10px', borderRadius: 4, marginTop: 10 }}>
          {t('mcpV144T3.reviewWarning')}
          {' '}
          <button type="button" onClick={() => setWarningAcked(true)}>{t('mcpV144T3.ackWarning')}</button>
        </div>
      ) : null}

      {session.state === 'error' && session.error ? (
        <div role="alert" style={{ ...TONE_STYLES.error, padding: '8px 10px', borderRadius: 4, marginTop: 10 }}>
          {t('mcpV144T3.appError')}: {session.error}
        </div>
      ) : null}

      {lastDenial ? (
        <div role="alert" style={{ ...TONE_STYLES.error, padding: '8px 10px', borderRadius: 4, marginTop: 10 }}>
          {t('mcpV144T3.actionDenied', { reason: lastDenial })}
        </div>
      ) : null}

      {session.state === 'suspended' ? <p style={{ opacity: 0.7 }}>{t('mcpV144T3.suspendedNote')}</p> : null}
      {session.state === 'mounting' ? <p style={{ opacity: 0.7 }}>{t('mcpV144T3.mountingNote')}</p> : null}

      <div style={{ marginTop: 12, opacity: session.state === 'suspended' ? 0.55 : 1 }}>
        {renderNode(root, 0)}
      </div>
    </section>
  );
}
