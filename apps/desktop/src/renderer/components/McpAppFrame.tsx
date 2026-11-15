import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * MCP App frame — host-side bridge (v1.09, Team T3).
 *
 * Upgrades `McpAppsViewer` (v0.97, minimal one-way bridge) to the full
 * bridge from `packages/core/src/mcp/appsBridge.ts`:
 *
 *   - Session: on every mount the host generates a `sessionId` +
 *     `nonce` and injects them into the srcdoc via
 *     `window.__OPENBOT_APP_SESSION__` BEFORE the app code (the app
 *     must include both in every message it sends up).
 *   - Origin: a message is accepted only when `event.source` is
 *     exactly this frame's `contentWindow` and `event.origin` is
 *     `"null"` (the opaque origin of the srcdoc sandbox). Anything
 *     else is dropped and counted in `dropped`.
 *   - Type allowlist: `app-ready`, `app-request`, `app-progress`,
 *     `app-error`. Actions inside `app-request` are limited to
 *     tool-call / notify / close / get-data / link-open (link-open
 *     only accepts http(s) URLs and always asks the host via
 *     `onLinkOpen`).
 *   - Audit log: every message in both directions (including dropped
 *     ones) is shown in a compact log under the frame, so the user
 *     sees what the app sent and what the host blocked.
 *   - Tool-call status: the host pushes `app-status` down to the app
 *     whenever the `toolStatus` prop changes (running / progress /
 *     done / error).
 *   - Sandbox is always `allow-scripts` (no `allow-same-origin`, no
 *     `allow-top-navigation`): the app cannot read the parent DOM,
 *     cannot navigate the main page, and cannot touch Node/Electron APIs.
 */

export type McpAppFrameToolStatus = 'idle' | 'running' | 'progress' | 'done' | 'error' | 'cancelled';

export interface McpAppFrameProps {
  /** HTML that already passed validateAppHtml (required — this component never validates). */
  html: string;
  title: string;
  uri: string;
  /** Tools the app may call through the bridge (empty = no tool calls allowed). */
  allowedTools?: readonly string[];
  /** Status of the tool call that produced the app — the host pushes it down when it changes. */
  toolStatus?: McpAppFrameToolStatus;
  /** Progress 0..100 while toolStatus is progress. */
  toolProgress?: number;
  onClose?: () => void;
  onNotify?: (message: string) => void;
  onToolCall?: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
  onGetData?: () => Promise<Record<string, unknown>>;
  /** The host decides whether an external link may open (default: blocked). */
  onLinkOpen?: (url: string) => boolean;
  /** Latest live data — the host pushes `app-data` down when it changes. */
  liveData?: Record<string, unknown>;
  liveVersion?: number;
}

const INBOUND_TYPES: readonly string[] = ['app-ready', 'app-request', 'app-progress', 'app-error'];
const REQUEST_ACTIONS: readonly string[] = ['tool-call', 'notify', 'close', 'get-data', 'link-open'];

interface BridgeLogRow {
  at: number;
  direction: 'in' | 'out';
  type: string;
  outcome: string;
}

function newSessionId(): string {
  return `app-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function newNonce(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  const buf = new Uint8Array(24);
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(buf);
    for (const b of buf) out += chars[b % chars.length];
  } else {
    for (let i = 0; i < 24; i++) out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

export default function McpAppFrame({
  html,
  title,
  uri,
  allowedTools = [],
  toolStatus = 'idle',
  toolProgress,
  onClose,
  onNotify,
  onToolCall,
  onGetData,
  onLinkOpen,
  liveData,
  liveVersion,
}: McpAppFrameProps) {
  const t = useT();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [session] = useState(() => ({ sessionId: newSessionId(), nonce: newNonce() }));
  const [ready, setReady] = useState(false);
  const [progress, setProgress] = useState<number | undefined>(undefined);
  const [appError, setAppError] = useState('');
  const [droppedCount, setDroppedCount] = useState(0);
  const [log, setLog] = useState<BridgeLogRow[]>([]);
  const allowedToolsRef = useRef(allowedTools);
  allowedToolsRef.current = allowedTools;

  const pushLog = (direction: 'in' | 'out', type: string, outcome: string) => {
    setLog((rows) => [...rows.slice(-99), { at: Date.now(), direction, type, outcome }]);
  };

  // Inject the session bootstrap into the srcdoc (before the app code) + CSP meta.
  const srcDoc = useMemo(() => {
    const bootstrap = `<script>window.__OPENBOT_APP_SESSION__=${JSON.stringify(session)};</script>`;
    if (/<head[\s>]/i.test(html)) return html.replace(/<head[\s>]/i, (m) => `${m}${bootstrap}`);
    if (/<html[\s>]/i.test(html)) return html.replace(/<html[\s>]/i, (m) => `${m}<head>${bootstrap}</head>`);
    return `<!doctype html><html><head><meta charset="utf-8">${bootstrap}</head><body>${html}</body></html>`;
  }, [html, session]);

  const postToApp = (message: Record<string, unknown>) => {
    frameRef.current?.contentWindow?.postMessage({ ...message, sessionId: session.sessionId }, '*');
    pushLog('out', String(message['type'] ?? 'message'), 'accepted');
  };

  // Push the tool-call status down to the app when the prop changes.
  useEffect(() => {
    if (!ready) return;
    postToApp({
      type: 'app-status',
      status: toolStatus,
      ...(toolProgress !== undefined ? { progress: toolProgress } : {}),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolStatus, toolProgress, ready]);

  // Push live data down to the app when the version changes.
  useEffect(() => {
    if (!ready || liveData === undefined || liveVersion === undefined) return;
    postToApp({ type: 'app-data', payload: { data: liveData, version: liveVersion } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveVersion, ready]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      // The srcdoc sandbox has opaque origin "null" — any other origin means the app navigated away.
      if (event.origin !== 'null' && event.origin !== '') {
        setDroppedCount((n) => n + 1);
        pushLog('in', 'unknown', 'bad-origin');
        return;
      }
      const data = event.data as unknown;
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        setDroppedCount((n) => n + 1);
        pushLog('in', 'unknown', 'bad-shape');
        return;
      }
      const rec = data as Record<string, unknown>;
      if (rec['sessionId'] !== session.sessionId || rec['nonce'] !== session.nonce) {
        setDroppedCount((n) => n + 1);
        pushLog('in', String(rec['type'] ?? 'unknown'), 'bad-session');
        return;
      }
      const type = rec['type'];
      if (typeof type !== 'string' || !INBOUND_TYPES.includes(type)) {
        setDroppedCount((n) => n + 1);
        pushLog('in', String(type ?? 'unknown'), 'unknown-type');
        return;
      }
      pushLog('in', type, 'accepted');
      if (type === 'app-ready') {
        setReady(true);
        return;
      }
      if (type === 'app-progress') {
        if (typeof rec['progress'] === 'number') {
          setProgress(Math.max(0, Math.min(100, Math.round(rec['progress']))));
        }
        return;
      }
      if (type === 'app-error') {
        setAppError(typeof rec['message'] === 'string' ? rec['message'] : t('mcpAppsTasks.appError'));
        return;
      }
      // app-request
      const action = rec['action'];
      const requestId = typeof rec['requestId'] === 'string' ? rec['requestId'] : undefined;
      if (typeof action !== 'string' || !REQUEST_ACTIONS.includes(action)) {
        setDroppedCount((n) => n + 1);
        pushLog('in', 'app-request', 'unknown-action');
        return;
      }
      const payload =
        rec['payload'] !== undefined && typeof rec['payload'] === 'object' && rec['payload'] !== null
          ? (rec['payload'] as Record<string, unknown>)
          : {};
      const reply = (result: unknown, error?: string) => {
        postToApp({
          type: 'app-response',
          ...(requestId ? { requestId } : {}),
          ok: !error,
          ...(error ? { error } : { payload: { result } }),
        });
      };
      if (action === 'close') {
        onClose?.();
        return;
      }
      if (action === 'notify') {
        onNotify?.(typeof payload['message'] === 'string' ? payload['message'] : '');
        reply(true);
        return;
      }
      if (action === 'get-data') {
        void Promise.resolve()
          .then(() => onGetData?.() ?? {})
          .then((data) => reply(data))
          .catch((err: unknown) => reply(null, (err as Error).message));
        return;
      }
      if (action === 'link-open') {
        const url = typeof payload['url'] === 'string' ? payload['url'] : '';
        const ok = /^https?:\/\//i.test(url) && (onLinkOpen ? onLinkOpen(url) : false);
        if (!ok) {
          setDroppedCount((n) => n + 1);
          pushLog('in', 'app-request', 'link-blocked');
        }
        reply(ok, ok ? undefined : t('mcpAppsTasks.linkBlocked'));
        return;
      }
      if (action === 'tool-call') {
        const toolName = typeof payload['tool'] === 'string' ? payload['tool'] : '';
        if (!toolName || !allowedToolsRef.current.includes(toolName)) {
          setDroppedCount((n) => n + 1);
          pushLog('in', 'app-request', 'tool-not-allowed');
          reply(null, t('mcpAppsTasks.toolNotAllowed', { tool: toolName || '?' }));
          return;
        }
        const args =
          payload['arguments'] !== undefined && typeof payload['arguments'] === 'object' && payload['arguments'] !== null
            ? (payload['arguments'] as Record<string, unknown>)
            : {};
        void Promise.resolve()
          .then(() => onToolCall?.(toolName, args) ?? null)
          .then((result) => reply(result))
          .catch((err: unknown) => reply(null, (err as Error).message));
        return;
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [session, onClose, onNotify, onToolCall, onGetData, onLinkOpen, t]);

  return (
    <section aria-label={title} style={{ border: '1px solid var(--border, #ddd)', borderRadius: 8, overflow: 'hidden' }}>
      <header style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 10px', borderBottom: '1px solid var(--border, #ddd)' }}>
        <strong>{title}</strong>
        <span style={{ opacity: 0.7, fontSize: 12 }}>{uri}</span>
        <span style={{ marginLeft: 'auto', fontSize: 12 }}>
          {ready ? t('mcpAppsTasks.appReady') : t('mcpAppsTasks.appLoading')}
          {progress !== undefined ? ` · ${progress}%` : ''}
          {toolStatus !== 'idle' ? ` · ${t(`mcpAppsTasks.toolStatus.${toolStatus}`)}` : ''}
        </span>
        <button type="button" onClick={() => onClose?.()}>{t('mcpAppsTasks.close')}</button>
      </header>
      {appError ? (
        <p role="alert" style={{ margin: 0, padding: '6px 10px', background: '#fde8e8' }}>{appError}</p>
      ) : null}
      <iframe
        ref={frameRef}
        title={title}
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        style={{ width: '100%', minHeight: 320, border: 0, display: 'block' }}
      />
      <footer style={{ padding: '6px 10px', fontSize: 12, opacity: 0.8 }}>
        <p style={{ margin: '0 0 4px' }}>{t('mcpAppsTasks.sandboxNote')}</p>
        <p style={{ margin: '0 0 4px' }}>
          {t('mcpAppsTasks.droppedMessages', { count: droppedCount })}
          {' · '}
          {t('mcpAppsTasks.bridgeLog', { count: log.length })}
        </p>
        {log.length > 0 ? (
          <ul style={{ margin: 0, paddingLeft: 16, maxHeight: 120, overflow: 'auto' }}>
            {log.slice(-10).map((row, i) => (
              <li key={`${row.at}-${i}`}>
                {row.direction === 'in' ? '←' : '→'} {row.type} — {row.outcome}
              </li>
            ))}
          </ul>
        ) : null}
      </footer>
    </section>
  );
}
