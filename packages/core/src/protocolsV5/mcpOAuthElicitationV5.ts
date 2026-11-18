/**
 * MCP OAuth elicitation / reconnect (v1.29, Team T2).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v129.md (MCP elicitation + OAuth for MCP
 * servers, and the Claude Agent SDK's `credential_expires_at`):
 * a server may ask the client for credentials mid-session
 * (elicitation) or reject a call because the token expired.
 * The client must then surface a clear `needs-auth` state, let
 * the user authenticate, and reconnect — without crashing the
 * session, losing in-flight background tasks, or silently
 * retrying with the dead token.
 *
 * This module is the open-bot implementation, built from scratch
 * on top of the existing `mcp/oauth.ts` token helpers without
 * touching them:
 *   - `McpAuthSession` — one MCP server connection's auth state
 *     machine: `connected` | `needs-auth` | `authenticating` |
 *     `reconnecting` | `disconnected` | `failed`. Every transition
 *     is recorded; illegal transitions throw with the from/to
 *     states named.
 *   - Elicitation: the server sends an auth challenge (a URL the
 *     user opens + a hint); the session moves to `needs-auth`,
 *     keeps a queue of calls that were blocked, and replays them
 *     after reconnect instead of dropping them.
 *   - Reconnect: `reconnect(tokenProvider)` obtains a fresh token
 *     (injected by the host — this module never touches the Vault
 *     or the network), retries with backoff, and restores
 *     `connected`. A failed reconnect leaves the session in
 *     `needs-auth` (not `failed`) until the retry budget is spent.
 *   - Token expiry: `credentialExpiresAt` is tracked; a call
 *     within the skew window is refused up-front with
 *     `needs-auth` instead of failing on the wire.
 *   - `McpAuthSessionManager` owns one session per server and
 *     answers "which servers need auth right now" for the UI.
 *
 * Nothing here copies code, text or assets from any other repo.
 * Tokens are never logged: `toJSON()` / summaries redact them.
 */

/** Auth lifecycle of one MCP server connection. */
export type McpAuthState =
  | 'connected'
  | 'needs-auth'
  | 'authenticating'
  | 'reconnecting'
  | 'disconnected'
  | 'failed';
export const MCP_AUTH_STATES: readonly McpAuthState[] = [
  'connected',
  'needs-auth',
  'authenticating',
  'reconnecting',
  'disconnected',
  'failed',
];
/** States in which a tool call may be attempted. */
export const MCP_AUTH_CALLABLE_STATES: readonly McpAuthState[] = ['connected'];
/** States in which the session still exists and can recover. */
export const MCP_AUTH_RECOVERABLE_STATES: readonly McpAuthState[] = [
  'needs-auth',
  'authenticating',
  'reconnecting',
  'disconnected',
];

/** How early (ms) a token counts as expired before its real expiry. */
export const MCP_AUTH_EXPIRY_SKEW_MS = 60_000;
/** Default reconnect attempts before the session is `failed`. */
export const MCP_AUTH_DEFAULT_MAX_RECONNECT_ATTEMPTS = 3;
/** Default base backoff between reconnect attempts (ms). */
export const MCP_AUTH_DEFAULT_RECONNECT_BASE_MS = 1000;
/** Default cap for the reconnect backoff (ms). */
export const MCP_AUTH_DEFAULT_RECONNECT_MAX_MS = 30_000;

/** Error raised by auth-session operations. */
export class McpAuthSessionError extends Error {
  readonly code: 'illegal-transition' | 'not-needs-auth' | 'expired' | 'reconnect-failed' | 'no-token-provider';
  readonly serverName?: string;
  constructor(message: string, code: McpAuthSessionError['code'], serverName?: string) {
    super(message);
    this.name = 'McpAuthSessionError';
    this.code = code;
    if (serverName) this.serverName = serverName;
  }
}

/** One recorded state transition (audit trail). */
export interface McpAuthTransition {
  sequence: number;
  at: number;
  from: McpAuthState;
  to: McpAuthState;
  reason: string;
}

/** An auth challenge the server sent via elicitation. */
export interface McpAuthChallenge {
  /** URL the user opens to authenticate (or '' when the server gave none). */
  authUrl: string;
  /** Short hint from the server (e.g. which scope is missing). */
  hint?: string;
  /** Elicitation request id, when the server sent one. */
  elicitationId?: string;
  /** Epoch ms the challenge arrived. */
  receivedAt: number;
}

/** A tool call that was blocked by `needs-auth`, queued for replay. */
export interface McpBlockedCall {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  blockedAt: number;
  /** True once replayed after a successful reconnect. */
  replayed: boolean;
}

/** A fresh token, as the host's token provider returns it. */
export interface McpFreshToken {
  /** Opaque access token — never logged, never serialised. */
  accessToken: string;
  /** Epoch ms the token expires (omit when unknown / non-expiring). */
  expiresAt?: number;
  /** Token type as returned by the provider (default `Bearer`). */
  tokenType?: string;
  /** Scopes granted (when the provider reports them). */
  scope?: string;
}

/** The host supplies this: how a fresh token is obtained. */
export type McpTokenProvider = () => Promise<McpFreshToken>;

/** Sleep override (tests drive reconnect backoff manually). */
export type McpAuthSleep = (ms: number) => Promise<void>;

const MCP_AUTH_TRANSITIONS: Record<McpAuthState, readonly McpAuthState[]> = {
  connected: ['needs-auth', 'disconnected', 'failed'],
  'needs-auth': ['authenticating', 'disconnected', 'failed'],
  authenticating: ['reconnecting', 'needs-auth', 'disconnected', 'failed'],
  reconnecting: ['connected', 'needs-auth', 'disconnected', 'failed'],
  disconnected: ['authenticating', 'needs-auth', 'connected', 'failed'],
  failed: ['authenticating'],
};

export interface McpAuthSessionOptions {
  serverName: string;
  /** Initial state (default `disconnected` — connect first). */
  initialState?: McpAuthState;
  /** Epoch ms the current credential expires (omit when unknown). */
  credentialExpiresAt?: number;
  /** Max reconnect attempts (default 3). */
  maxReconnectAttempts?: number;
  /** Base backoff between attempts (ms, default 1000). */
  reconnectBaseMs?: number;
  /** Backoff cap (ms, default 30000). */
  reconnectMaxMs?: number;
  /** Clock override (tests). */
  now?: () => number;
  /** Sleep override (tests). */
  sleep?: McpAuthSleep;
}

/**
 * One MCP server connection's auth state machine. The session
 * object itself is transport-free: the host calls
 * `markConnected()` after its real handshake, `elicit()` when
 * the server asks for auth, and `reconnect()` with a token
 * provider when the user has authenticated.
 */
export class McpAuthSession {
  readonly serverName: string;
  private state: McpAuthState;
  private credentialExpiresAt: number | undefined;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly now: () => number;
  private readonly sleep: McpAuthSleep;
  private readonly transitions: McpAuthTransition[] = [];
  private readonly blockedCalls: McpBlockedCall[] = [];
  private challenge: McpAuthChallenge | null = null;
  private reconnectAttempts = 0;
  private lastError: string | null = null;
  private callCounter = 0;
  private sequence = 0;

  constructor(options: McpAuthSessionOptions) {
    this.serverName = options.serverName;
    this.state = options.initialState ?? 'disconnected';
    this.credentialExpiresAt = options.credentialExpiresAt;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? MCP_AUTH_DEFAULT_MAX_RECONNECT_ATTEMPTS;
    this.reconnectBaseMs = options.reconnectBaseMs ?? MCP_AUTH_DEFAULT_RECONNECT_BASE_MS;
    this.reconnectMaxMs = options.reconnectMaxMs ?? MCP_AUTH_DEFAULT_RECONNECT_MAX_MS;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.record(this.state, this.state, 'Session created.');
  }

  private record(from: McpAuthState, to: McpAuthState, reason: string): void {
    this.sequence += 1;
    this.transitions.push({ sequence: this.sequence, at: this.now(), from, to, reason });
  }

  private transition(to: McpAuthState, reason: string): void {
    const from = this.state;
    if (from === to) {
      this.record(from, to, reason);
      return;
    }
    const allowed = MCP_AUTH_TRANSITIONS[from] ?? [];
    if (!(allowed as readonly McpAuthState[]).includes(to)) {
      throw new McpAuthSessionError(
        `Illegal auth transition for "${this.serverName}": ${from} -> ${to}. ` +
          `Allowed from ${from}: ${allowed.join(', ') || 'none'}.`,
        'illegal-transition',
        this.serverName,
      );
    }
    this.state = to;
    this.record(from, to, reason);
  }

  /** Current auth state. */
  getState(): McpAuthState {
    return this.state;
  }

  /** True when a tool call may be attempted right now. */
  canCall(): boolean {
    return (MCP_AUTH_CALLABLE_STATES as readonly McpAuthState[]).includes(this.state) && !this.isCredentialExpired();
  }

  /** True when the session can still recover (not `failed`). */
  isRecoverable(): boolean {
    return (MCP_AUTH_RECOVERABLE_STATES as readonly McpAuthState[]).includes(this.state);
  }

  /** Last error message (reconnect failure, etc.), or null. */
  getLastError(): string | null {
    return this.lastError;
  }

  /** Current auth challenge, or null when none is outstanding. */
  getChallenge(): McpAuthChallenge | null {
    return this.challenge ? { ...this.challenge } : null;
  }

  /** How many reconnect attempts have been spent in this episode. */
  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  /** True when the credential is expired (or within the skew window). */
  isCredentialExpired(nowMs?: number): boolean {
    if (this.credentialExpiresAt === undefined) return false;
    return (nowMs ?? this.now()) + MCP_AUTH_EXPIRY_SKEW_MS >= this.credentialExpiresAt;
  }

  /** Epoch ms the credential expires, or undefined when unknown. */
  getCredentialExpiresAt(): number | undefined {
    return this.credentialExpiresAt;
  }

  /** Mark the session connected (after the host's real handshake). */
  markConnected(credentialExpiresAt?: number, reason = 'Connected.'): void {
    if (credentialExpiresAt !== undefined) this.credentialExpiresAt = credentialExpiresAt;
    if (this.state === 'failed') {
      throw new McpAuthSessionError(
        `Session "${this.serverName}" is failed; authenticate first (startAuthentication) before reconnecting.`,
        'illegal-transition',
        this.serverName,
      );
    }
    this.reconnectAttempts = 0;
    this.lastError = null;
    this.challenge = null;
    this.transition('connected', reason);
  }

  /** Mark the session disconnected (transport closed, cleanly). */
  markDisconnected(reason = 'Disconnected.'): void {
    this.transition('disconnected', reason);
  }

  /**
   * The server asked for auth (elicitation) or rejected a call
   * with 401: move to `needs-auth`, keep the challenge, keep the
   * session alive. Never throws for a session that is already
   * `needs-auth` — a second challenge just replaces the first.
   */
  elicit(challenge: Omit<McpAuthChallenge, 'receivedAt'>, reason = 'Server requested authentication.'): void {
    this.challenge = { ...challenge, receivedAt: this.now() };
    if (this.state === 'needs-auth') {
      this.record('needs-auth', 'needs-auth', `${reason} (challenge updated)`);
      return;
    }
    this.transition('needs-auth', reason);
  }

  /** The credential is known-expired: same as eliciting, without a URL. */
  markCredentialExpired(reason = 'Credential expired.'): void {
    this.elicit({ authUrl: '' }, reason);
  }

  /**
   * Guard a tool call: returns normally when the call may proceed,
   * otherwise queues the call for replay and throws `not-needs-auth`
   * / `expired` with the state named. The session is never crashed
   * by a blocked call.
   */
  guardCall(toolName: string, args: Record<string, unknown> = {}): void {
    if (this.canCall()) return;
    this.callCounter += 1;
    this.blockedCalls.push({
      callId: `blocked-${this.serverName}-${this.callCounter}`,
      toolName,
      args: { ...args },
      blockedAt: this.now(),
      replayed: false,
    });
    if (this.state === 'needs-auth' || this.state === 'authenticating' || this.state === 'reconnecting') {
      throw new McpAuthSessionError(
        `Server "${this.serverName}" needs authentication before "${toolName}" can run. ` +
          `State: ${this.state}. Authenticate, then the queued call replays.`,
        'not-needs-auth',
        this.serverName,
      );
    }
    if (this.isCredentialExpired()) {
      throw new McpAuthSessionError(
        `Credential for "${this.serverName}" expired before "${toolName}" could run.`,
        'expired',
        this.serverName,
      );
    }
    throw new McpAuthSessionError(
      `Server "${this.serverName}" is ${this.state}; "${toolName}" cannot run yet.`,
      'not-needs-auth',
      this.serverName,
    );
  }

  /** Calls blocked while `needs-auth`, oldest first (copies). */
  listBlockedCalls(): McpBlockedCall[] {
    return this.blockedCalls.map((c) => ({ ...c, args: { ...c.args } }));
  }

  /** Calls still waiting for replay. */
  pendingReplayCount(): number {
    return this.blockedCalls.filter((c) => !c.replayed).length;
  }

  /**
   * Begin authentication (the user opened the auth URL). Only
   * legal from `needs-auth` / `disconnected` / `failed`.
   */
  startAuthentication(reason = 'User started authentication.'): void {
    this.transition('authenticating', reason);
  }

  /**
   * Reconnect after authentication: obtain a fresh token from the
   * host's provider and restore `connected`, replaying blocked
   * calls. Retries with exponential backoff; a failed attempt
   * leaves the session in `needs-auth` (recoverable) until the
   * retry budget is spent, then `failed`. Returns the calls that
   * should be replayed (the host re-issues them — this module
   * never calls a tool itself).
   */
  async reconnect(tokenProvider: McpTokenProvider): Promise<McpBlockedCall[]> {
    if (typeof tokenProvider !== 'function') {
      throw new McpAuthSessionError('A token provider function is required to reconnect.', 'no-token-provider', this.serverName);
    }
    if (this.state === 'connected') return [];
    if (this.state === 'failed' || this.state === 'disconnected') {
      // Re-auth from a dead state goes through `authenticating` first.
      this.transition('authenticating', 'Reconnect requested.');
    } else if (this.state === 'needs-auth') {
      this.transition('authenticating', 'Reconnect requested.');
    }
    this.transition('reconnecting', 'Authenticating; obtaining a fresh token.');
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= this.maxReconnectAttempts; attempt += 1) {
      this.reconnectAttempts = attempt;
      try {
        const token = await tokenProvider();
        if (!token || typeof token.accessToken !== 'string' || token.accessToken.length === 0) {
          throw new Error('Token provider returned no access token.');
        }
        this.credentialExpiresAt = token.expiresAt;
        this.reconnectAttempts = 0;
        this.lastError = null;
        this.transition('connected', `Reconnected (attempt ${attempt}).`);
        const replay = this.blockedCalls.filter((c) => !c.replayed);
        for (const call of replay) call.replayed = true;
        return replay.map((c) => ({ ...c, args: { ...c.args } }));
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        this.lastError = lastErr.message;
        if (attempt < this.maxReconnectAttempts) {
          const delay = Math.min(this.reconnectBaseMs * 2 ** (attempt - 1), this.reconnectMaxMs);
          await this.sleep(delay);
        }
      }
    }
    // Budget spent: back to `needs-auth` is wrong here — the user
    // already tried; `failed` is honest, and `failed` can still
    // re-authenticate via startAuthentication().
    this.transition('failed', `Reconnect failed after ${this.maxReconnectAttempts} attempts: ${lastErr?.message ?? 'unknown error'}.`);
    throw new McpAuthSessionError(
      `Reconnect to "${this.serverName}" failed after ${this.maxReconnectAttempts} attempts: ${lastErr?.message ?? 'unknown error'}.`,
      'reconnect-failed',
      this.serverName,
    );
  }

  /** Full transition history, oldest first (copies). */
  history(): McpAuthTransition[] {
    return this.transitions.map((t) => ({ ...t }));
  }

  /** One-line status for logs / UI — never includes a token. */
  summary(): string {
    const parts = [`${this.serverName}: ${this.state}`];
    if (this.state === 'needs-auth' && this.challenge?.authUrl) parts.push('auth URL available');
    if (this.pendingReplayCount() > 0) parts.push(`${this.pendingReplayCount()} call(s) queued`);
    if (this.lastError) parts.push(`last error: ${this.lastError}`);
    return parts.join(' · ');
  }

  /** Serialisable snapshot — tokens are never included. */
  toJSON(): {
    serverName: string;
    state: McpAuthState;
    credentialExpiresAt?: number;
    reconnectAttempts: number;
    lastError: string | null;
    blockedCallCount: number;
    pendingReplayCount: number;
    hasChallenge: boolean;
  } {
    return {
      serverName: this.serverName,
      state: this.state,
      credentialExpiresAt: this.credentialExpiresAt,
      reconnectAttempts: this.reconnectAttempts,
      lastError: this.lastError,
      blockedCallCount: this.blockedCalls.length,
      pendingReplayCount: this.pendingReplayCount(),
      hasChallenge: this.challenge !== null,
    };
  }
}

/** Owns one auth session per MCP server. */
export class McpAuthSessionManager {
  private readonly sessions = new Map<string, McpAuthSession>();

  /** Get or create the session for a server. */
  sessionFor(serverName: string, options: Omit<McpAuthSessionOptions, 'serverName'> = {}): McpAuthSession {
    let session = this.sessions.get(serverName);
    if (!session) {
      session = new McpAuthSession({ ...options, serverName });
      this.sessions.set(serverName, session);
    }
    return session;
  }

  get(serverName: string): McpAuthSession | undefined {
    return this.sessions.get(serverName);
  }

  serverNames(): string[] {
    return [...this.sessions.keys()].sort();
  }

  /** Servers currently in `needs-auth` (the UI's auth banner list). */
  serversNeedingAuth(): string[] {
    return [...this.sessions.values()]
      .filter((s) => s.getState() === 'needs-auth')
      .map((s) => s.serverName)
      .sort();
  }

  /** True when every known server can be called right now. */
  allConnected(): boolean {
    return [...this.sessions.values()].every((s) => s.canCall());
  }

  /** One-line summary per server. */
  summaries(): string[] {
    return [...this.sessions.values()].map((s) => s.summary());
  }
}
