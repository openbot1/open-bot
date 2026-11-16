import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * MCP Apps host v13 — React host component (SEP-1865, ideas only).
 *
 * Mount an app in a sandboxed iframe and speak the JSON-RPC `ui/`
 * dialect with it over postMessage:
 *
 *   - The sandbox is always `allow-scripts` (no allow-same-origin, no
 *     allow-top-navigation): the app cannot read the parent DOM, cannot
 *     navigate the main page, and cannot touch Node/Electron APIs. The
 *     default-deny CSP (`default-src 'none'`, only the app's inline
 *     script/style, network blocked except for the allowlist) is embedded
 *     in the srcdoc.
 *   - The app handshakes with `ui/initialize` (JSON-RPC 2.0): the host
 *     returns `hostContext` (theme, locale, timezone, platform, display
 *     mode, container size). Every other method before initialize is
 *     rejected. The app then uses `ui/update-model-context`,
 *     `ui/message`, `ui/open-link`, `tools/call` (every action from the
 *     UI goes through the host, same control path, no bypass).
 *   - The legacy `app-*` bridge (v1.09) is still accepted so old apps
 *     keep working.
 *   - 3 display modes: `inline` (inside the chat flow), `fullscreen`
 *     (full-screen overlay), `pip` (floating window, draggable by its
 *     header, mode switched with a button).
 *
 * This component does not validate HTML (the caller must validate first
 * with `validateAppHtml`) and never calls tools itself — `onToolsCall` /
 * `onOpenLink` are wired by the parent to the real host.
 */

export type McpAppHostV13DisplayMode = 'inline' | 'fullscreen' | 'pip';

export interface McpAppHostV13HostContext {
  theme: 'light' | 'dark' | 'system';
  locale: string;
  timezone: string;
  platform: 'win32' | 'darwin' | 'linux';
  displayMode: McpAppHostV13DisplayMode;
  container: { width: number; height: number };
  hostVersion: string;
  hostName: string;
  capabilities: string[];
}

export interface McpAppHostV13PipGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface McpAppHostV13Props {
  /** HTML already validated with validateAppHtml (required — this component does not re-validate). */
  html: string;
  title: string;
  uri: string;
  /** Tools the app may call via tools/call (empty = no tool may be called). */
  allowedTools?: readonly string[];
  /** Initial display mode. */
  initialDisplayMode?: McpAppHostV13DisplayMode;
  /** Initial pip geometry (when initialDisplayMode is pip). */
  initialPip?: McpAppHostV13PipGeometry;
  /** Host context sent to the app in ui/initialize. */
  hostContext?: Partial<McpAppHostV13HostContext>;
  /** CSP for the iframe (default: deny — default-src 'none', inline script/style only). */
  csp?: string;
  /** Whether the app may open external links (default: no). */
  allowOpenLink?: boolean;
  onClose?: () => void;
  onNotify?: (message: string, level: 'info' | 'warn' | 'error') => void;
  onToolsCall?: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
  onGetData?: () => Promise<Record<string, unknown>>;
  onOpenLink?: (url: string) => boolean;
  onModelContext?: (context: Record<string, unknown>) => void;
  onDisplayModeChange?: (mode: McpAppHostV13DisplayMode) => void;
  /** New live data — the host pushes ui/model-context-updated down to the app when it changes. */
  liveData?: Record<string, unknown>;
  liveVersion?: number;
}

const DEFAULT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const UI_METHODS: readonly string[] = [
  'ui/initialize',
  'ui/update-model-context',
  'ui/message',
  'ui/open-link',
  'tools/call',
  'ui/close',
  'ui/set-display-mode',
];

interface DialectLogRow {
  at: number;
  direction: 'in' | 'out';
  method: string;
  outcome: string;
}

function newSessionId(): string {
  return `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function escapeCspAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export default function McpAppHostV13({
  html,
  title,
  uri,
  allowedTools = [],
  initialDisplayMode = 'inline',
  initialPip,
  hostContext: hostContextOverride,
  csp = DEFAULT_CSP,
  allowOpenLink = false,
  onClose,
  onNotify,
  onToolsCall,
  onGetData,
  onOpenLink,
  onModelContext,
  onDisplayModeChange,
  liveData,
  liveVersion,
}: McpAppHostV13Props) {
  const t = useT();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [session] = useState(() => ({ sessionId: newSessionId() }));
  const [displayMode, setDisplayMode] = useState<McpAppHostV13DisplayMode>(initialDisplayMode);
  const [previousMode, setPreviousMode] = useState<McpAppHostV13DisplayMode>('inline');
  const [pip, setPip] = useState<McpAppHostV13PipGeometry>(
    initialPip ?? { x: window.innerWidth - 368, y: window.innerHeight - 248, width: 360, height: 240 },
  );
  const [initialized, setInitialized] = useState(false);
  const [appError, setAppError] = useState('');
  const [progress, setProgress] = useState<number | undefined>(undefined);
  const [droppedCount, setDroppedCount] = useState(0);
  const [log, setLog] = useState<DialectLogRow[]>([]);
  const [modelContext, setModelContext] = useState<Record<string, unknown>>({});
  const dragRef = useRef<{ startX: number; startY: number; pipX: number; pipY: number } | null>(null);
  const allowedToolsRef = useRef(allowedTools);
  allowedToolsRef.current = allowedTools;
  const displayModeRef = useRef(displayMode);
  displayModeRef.current = displayMode;

  const hostContext: McpAppHostV13HostContext = useMemo(
    () => ({
      theme: 'system',
      locale: 'en',
      timezone: 'UTC',
      platform: 'linux',
      container: { width: 720, height: 480 },
      hostVersion: '0.2.0',
      hostName: 'open-bot',
      capabilities: ['tools-call', 'open-link', 'model-context', 'pip', 'fullscreen'],
      ...hostContextOverride,
      displayMode,
    }),
    [displayMode, hostContextOverride],
  );

  const pushLog = useCallback((direction: 'in' | 'out', method: string, outcome: string) => {
    setLog((rows) => [...rows.slice(-99), { at: Date.now(), direction, method, outcome }]);
  }, []);

  // Embed the CSP meta + session bootstrap into the srcdoc (before the app code).
  const srcDoc = useMemo(() => {
    const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${escapeCspAttr(csp)}">`;
    const bootstrap = `<script>window.__OPENBOT_UI_SESSION__=${JSON.stringify(session)};</script>`;
    const head = `${cspMeta}${bootstrap}`;
    if (/<head[\s>]/i.test(html)) return html.replace(/<head[\s>]/i, (m) => `${m}${head}`);
    if (/<html[\s>]/i.test(html)) return html.replace(/<html[\s>]/i, (m) => `${m}<head>${head}</head>`);
    return `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${html}</body></html>`;
  }, [html, csp, session]);

  const postToApp = useCallback(
    (message: Record<string, unknown>) => {
      frameRef.current?.contentWindow?.postMessage(message, '*');
      pushLog('out', String(message['method'] ?? message['type'] ?? 'message'), 'accepted');
    },
    [pushLog],
  );

  const changeMode = useCallback(
    (mode: McpAppHostV13DisplayMode) => {
      setDisplayMode((current) => {
        if (current !== 'fullscreen' && current !== 'pip') setPreviousMode(current);
        return mode;
      });
      onDisplayModeChange?.(mode);
    },
    [onDisplayModeChange],
  );

  const exitOverlay = useCallback(() => {
    changeMode(previousMode);
  }, [changeMode, previousMode]);

  // Push the new model context down to the app (ui/model-context-updated notification).
  useEffect(() => {
    if (!initialized || liveData === undefined || liveVersion === undefined) return;
    postToApp({
      jsonrpc: '2.0',
      method: 'ui/model-context-updated',
      params: { context: liveData },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveVersion, initialized]);

  // Drag the pip window by its header.
  const onPipHeaderPointerDown = (event: React.PointerEvent) => {
    dragRef.current = { startX: event.clientX, startY: event.clientY, pipX: pip.x, pipY: pip.y };
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
  };
  const onPipHeaderPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const nextX = Math.max(8, Math.min(window.innerWidth - 100, drag.pipX + (event.clientX - drag.startX)));
    const nextY = Math.max(8, Math.min(window.innerHeight - 60, drag.pipY + (event.clientY - drag.startY)));
    setPip((current) => ({ ...current, x: nextX, y: nextY }));
  };
  const onPipHeaderPointerUp = () => {
    dragRef.current = null;
  };

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
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

      // --- Dialect JSON-RPC ui/ ---
      if (rec['jsonrpc'] === '2.0' && typeof rec['method'] === 'string') {
        const method = rec['method'] as string;
        const id = rec['id'];
        const hasId = id !== undefined && id !== null && (typeof id === 'string' || typeof id === 'number');
        const params =
          rec['params'] !== undefined && typeof rec['params'] === 'object' && rec['params'] !== null
            ? (rec['params'] as Record<string, unknown>)
            : {};
        const reply = (result: unknown, error?: { code: number; message: string }) => {
          if (!hasId) return;
          postToApp({
            jsonrpc: '2.0',
            id,
            ...(error ? { error } : { result }),
          });
        };
        if (!UI_METHODS.includes(method)) {
          setDroppedCount((n) => n + 1);
          pushLog('in', method, 'method-not-found');
          reply(null, { code: -32601, message: `Method "${method}" is not supported by the host.` });
          return;
        }
        if (!initialized && method !== 'ui/initialize') {
          setDroppedCount((n) => n + 1);
          pushLog('in', method, 'not-initialized');
          reply(null, { code: -32002, message: 'App must call ui/initialize before using other methods.' });
          return;
        }
        pushLog('in', method, 'accepted');
        if (method === 'ui/initialize') {
          setInitialized(true);
          reply({
            protocolVersion: 'ui/1.0',
            sessionId: session.sessionId,
            hostContext,
            capabilities: hostContext.capabilities,
          });
          return;
        }
        if (method === 'ui/update-model-context') {
          const context =
            params['context'] !== undefined && typeof params['context'] === 'object' && params['context'] !== null
              ? (params['context'] as Record<string, unknown>)
              : null;
          if (!context) {
            reply(null, { code: -32602, message: 'ui/update-model-context requires params.context to be an object.' });
            return;
          }
          const next = { ...modelContext, ...context };
          setModelContext(next);
          onModelContext?.(next);
          reply({ ok: true, appliedKeys: Object.keys(context) });
          return;
        }
        if (method === 'ui/message') {
          const message = typeof params['message'] === 'string' ? params['message'] : '';
          const level = params['level'] === 'warn' || params['level'] === 'error' ? params['level'] : 'info';
          if (!message) {
            reply(null, { code: -32602, message: 'ui/message requires params.message to be a non-empty string.' });
            return;
          }
          onNotify?.(message, level);
          reply({ ok: true });
          return;
        }
        if (method === 'ui/open-link') {
          const url = typeof params['url'] === 'string' ? params['url'] : '';
          if (!/^https?:\/\//i.test(url)) {
            reply(null, { code: -32602, message: 'ui/open-link requires params.url to be a valid http(s) URL.' });
            return;
          }
          const opened = allowOpenLink && (onOpenLink ? onOpenLink(url) : false);
          if (!opened) {
            reply(null, { code: -32003, message: `Link "${url}" was blocked by the host.` });
            return;
          }
          reply({ ok: true, opened: true, url });
          return;
        }
        if (method === 'tools/call') {
          const toolName =
            (typeof params['name'] === 'string' ? params['name'] : '') ||
            (typeof params['tool'] === 'string' ? params['tool'] : '');
          if (!toolName) {
            reply(null, { code: -32602, message: 'tools/call requires params.name to be a tool name.' });
            return;
          }
          if (!allowedToolsRef.current.includes(toolName)) {
            reply(null, { code: -32003, message: `Tool "${toolName}" is not allowed to be called from this app.` });
            return;
          }
          const args =
            params['arguments'] !== undefined && typeof params['arguments'] === 'object' && params['arguments'] !== null
              ? (params['arguments'] as Record<string, unknown>)
              : {};
          void Promise.resolve()
            .then(() => onToolsCall?.(toolName, args) ?? null)
            .then((result) => {
              reply({
                content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }],
                isError: false,
              });
            })
            .catch((err: unknown) => {
              reply(null, { code: -32603, message: (err as Error).message });
            });
          return;
        }
        if (method === 'ui/close') {
          reply({ ok: true });
          onClose?.();
          return;
        }
        if (method === 'ui/set-display-mode') {
          const mode = params['mode'];
          if (mode !== 'inline' && mode !== 'fullscreen' && mode !== 'pip') {
            reply(null, { code: -32602, message: 'ui/set-display-mode requires params.mode to be inline, fullscreen or pip.' });
            return;
          }
          changeMode(mode);
          reply({ ok: true, displayMode: mode });
          return;
        }
        return;
      }

      // --- Legacy bridge app-* (v1.09) ---
      if (typeof rec['type'] === 'string') {
        const type = rec['type'] as string;
        if (type === 'app-ready') {
          setInitialized(true);
          pushLog('in', type, 'accepted');
          return;
        }
        if (type === 'app-progress') {
          if (typeof rec['progress'] === 'number') {
            setProgress(Math.max(0, Math.min(100, Math.round(rec['progress']))));
          }
          pushLog('in', type, 'accepted');
          return;
        }
        if (type === 'app-error') {
          setAppError(typeof rec['message'] === 'string' ? rec['message'] : t('mcpAppsTasks.appError'));
          pushLog('in', type, 'accepted');
          return;
        }
        if (type === 'app-request') {
          const action = rec['action'];
          const requestId = typeof rec['requestId'] === 'string' ? rec['requestId'] : undefined;
          const payload =
            rec['payload'] !== undefined && typeof rec['payload'] === 'object' && rec['payload'] !== null
              ? (rec['payload'] as Record<string, unknown>)
              : {};
          const replyLegacy = (result: unknown, error?: string) => {
            postToApp({
              type: 'app-response',
              ...(requestId ? { requestId } : {}),
              ok: !error,
              ...(error ? { error } : { payload: { result } }),
            });
          };
          pushLog('in', `app-request:${String(action)}`, 'accepted');
          if (action === 'close') {
            onClose?.();
            return;
          }
          if (action === 'notify') {
            onNotify?.(typeof payload['message'] === 'string' ? payload['message'] : '', 'info');
            replyLegacy(true);
            return;
          }
          if (action === 'get-data') {
            void Promise.resolve()
              .then(() => onGetData?.() ?? {})
              .then((data) => replyLegacy(data))
              .catch((err: unknown) => replyLegacy(null, (err as Error).message));
            return;
          }
          if (action === 'link-open') {
            const url = typeof payload['url'] === 'string' ? payload['url'] : '';
            const ok = /^https?:\/\//i.test(url) && allowOpenLink && (onOpenLink ? onOpenLink(url) : false);
            replyLegacy(ok, ok ? undefined : t('mcpAppsTasks.linkBlocked'));
            return;
          }
          if (action === 'tool-call') {
            const toolName = typeof payload['tool'] === 'string' ? payload['tool'] : '';
            if (!toolName || !allowedToolsRef.current.includes(toolName)) {
              replyLegacy(null, t('mcpAppsTasks.toolNotAllowed', { tool: toolName || '?' }));
              return;
            }
            const args =
              payload['arguments'] !== undefined && typeof payload['arguments'] === 'object' && payload['arguments'] !== null
                ? (payload['arguments'] as Record<string, unknown>)
                : {};
            void Promise.resolve()
              .then(() => onToolsCall?.(toolName, args) ?? null)
              .then((result) => replyLegacy(result))
              .catch((err: unknown) => replyLegacy(null, (err as Error).message));
            return;
          }
        }
        setDroppedCount((n) => n + 1);
        pushLog('in', type, 'unknown-type');
        return;
      }

      setDroppedCount((n) => n + 1);
      pushLog('in', 'unknown', 'bad-shape');
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, initialized, modelContext, allowOpenLink, hostContext]);

  const modeLabel = t(`mcpAppsV13.displayMode.${displayMode}`);
  const frameStyle: React.CSSProperties =
    displayMode === 'fullscreen'
      ? { position: 'fixed', inset: 0, zIndex: 1000, background: 'var(--background, #fff)', display: 'flex', flexDirection: 'column' }
      : displayMode === 'pip'
        ? {
            position: 'fixed',
            left: pip.x,
            top: pip.y,
            width: pip.width,
            height: pip.height,
            zIndex: 900,
            background: 'var(--background, #fff)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
            display: 'flex',
            flexDirection: 'column',
          }
        : {};

  return (
    <section
      aria-label={title}
      style={{
        border: '1px solid var(--border, #ddd)',
        borderRadius: 8,
        overflow: 'hidden',
        ...frameStyle,
      }}
    >
      <header
        style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 10px', borderBottom: '1px solid var(--border, #ddd)', cursor: displayMode === 'pip' ? 'move' : 'default', userSelect: 'none' }}
        onPointerDown={displayMode === 'pip' ? onPipHeaderPointerDown : undefined}
        onPointerMove={displayMode === 'pip' ? onPipHeaderPointerMove : undefined}
        onPointerUp={displayMode === 'pip' ? onPipHeaderPointerUp : undefined}
      >
        <strong>{title}</strong>
        <span style={{ opacity: 0.7, fontSize: 12 }}>{uri}</span>
        <span style={{ fontSize: 12 }}>
          {initialized ? t('mcpAppsTasks.appReady') : t('mcpAppsTasks.appLoading')}
          {progress !== undefined ? ` · ${progress}%` : ''}
          {' · '}
          {modeLabel}
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          {displayMode !== 'inline' ? (
            <button type="button" onClick={exitOverlay} title={t('mcpAppsV13.exitOverlay')}>
              {t('mcpAppsV13.exitOverlay')}
            </button>
          ) : null}
          {displayMode !== 'fullscreen' ? (
            <button type="button" onClick={() => changeMode('fullscreen')}>
              {t('mcpAppsV13.displayMode.fullscreen')}
            </button>
          ) : null}
          {displayMode !== 'pip' ? (
            <button type="button" onClick={() => changeMode('pip')}>
              {t('mcpAppsV13.displayMode.pip')}
            </button>
          ) : null}
          <button type="button" onClick={() => onClose?.()}>{t('mcpAppsTasks.close')}</button>
        </span>
      </header>
      {appError ? (
        <p role="alert" style={{ margin: 0, padding: '6px 10px', background: '#fde8e8' }}>{appError}</p>
      ) : null}
      <iframe
        ref={frameRef}
        title={title}
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        style={{ width: '100%', flex: 1, minHeight: displayMode === 'pip' ? 0 : 320, border: 0, display: 'block' }}
      />
      <footer style={{ padding: '6px 10px', fontSize: 12, opacity: 0.8 }}>
        <p style={{ margin: '0 0 4px' }}>{t('mcpAppsV13.sandboxNote')}</p>
        <p style={{ margin: '0 0 4px' }}>
          {t('mcpAppsTasks.droppedMessages', { count: droppedCount })}
          {' · '}
          {t('mcpAppsTasks.bridgeLog', { count: log.length })}
          {Object.keys(modelContext).length > 0 ? ` · ${t('mcpAppsV13.modelContextKeys', { count: Object.keys(modelContext).length })}` : ''}
        </p>
        {log.length > 0 ? (
          <ul style={{ margin: 0, paddingLeft: 16, maxHeight: 120, overflow: 'auto' }}>
            {log.slice(-10).map((row, i) => (
              <li key={`${row.at}-${i}`}>
                {row.direction === 'in' ? '←' : '→'} {row.method} — {row.outcome}
              </li>
            ))}
          </ul>
        ) : null}
      </footer>
    </section>
  );
}
