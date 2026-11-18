/**
 * ACP v2 draft client adapter + agent registry/discovery + A2A
 * alignment (v1.29, Team T2).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v129.md: ACP (Agent Client Protocol) has
 * merged into A2A under the Linux Foundation — ACP is the
 * client<->agent wire (the "LSP for agents": a client drives one
 * agent through sessions, prompts, tool calls and permission
 * requests), A2A the agent<->agent wire, and the v2 draft aligns
 * the two instead of competing. Android Studio's BYOA
 * (bring-your-own-agent) shows the pattern: a client adapts any
 * agent behind one interface.
 *
 * This module is the open-bot implementation, built from scratch:
 *   - `AcpV2ClientAdapter` — a transport-free ACP v2 draft client:
 *     sessions (`new` / `prompt` / `cancel`), prompt turns with
 *     a stop / cancel handle, permission requests answered by an
 *     injected decider, and auth state (`authenticate`) that
 *     reuses the `mcpOAuthElicitationV5` session machine shape
 *     without importing it (no cycle: the host wires both).
 *   - `AcpAgentRegistry` — discovery: agents register with an
 *     Agent Card (name, description, capabilities, transports,
 *     ACP + A2A versions), clients discover by capability /
 *     name, stale entries expire, and a registry serialises to
 *     JSON for sharing.
 *   - `ByoaClientAdapter` — bring-your-own-agent: wrap any
 *     external agent (a command to spawn, or an HTTP endpoint)
 *     behind the same `AcpAgentHandle` interface the ACP client
 *     uses, so the client never cares which agent is behind it.
 *   - A2A alignment: `acpSessionToA2aTaskV5` maps an ACP session
 *     onto an A2A task (and back), and `acpCardToA2aCardV5`
 *     converts an ACP agent card to an A2A agent card, so an ACP
 *     agent can be addressed over A2A and vice versa.
 *
 * ACP v2 is a draft: every adapter carries its negotiated
 * version, refuses to speak methods the peer did not advertise,
 * and labels draft-only behaviour. Nothing here copies code,
 * text or assets from any other repo, from xAI or from Cursor.
 */

/** ACP v2 draft version this adapter speaks. */
export const ACP_V2_DRAFT_VERSION = '2.0-draft';
/** ACP v1 (legacy) — still understood for discovery. */
export const ACP_V1_VERSION = '1.0';
/** A2A version ACP v2 aligns with. */
export const ACP_V2_A2A_VERSION = '1.1';

/** Lifecycle of one ACP session. */
export type AcpV2SessionStatus = 'active' | 'idle' | 'cancelled' | 'completed' | 'failed';
export const ACP_V2_SESSION_TERMINAL: readonly AcpV2SessionStatus[] = ['cancelled', 'completed', 'failed'];
export function isAcpV2SessionTerminal(status: AcpV2SessionStatus): boolean {
  return (ACP_V2_SESSION_TERMINAL as readonly AcpV2SessionStatus[]).includes(status);
}

/** One turn inside an ACP session. */
export type AcpV2TurnRole = 'user' | 'agent';
export interface AcpV2Turn {
  sequence: number;
  role: AcpV2TurnRole;
  /** Prompt text (user) or response text (agent). */
  text: string;
  at: number;
  /** Tool calls the agent made during this turn (names only). */
  toolCalls?: string[];
}

/** A permission request an ACP agent sends to its client. */
export type AcpV2PermissionOutcome = 'allow' | 'deny';
export interface AcpV2PermissionRequest {
  requestId: string;
  sessionId: string;
  toolName: string;
  /** What the tool would do, in the agent's words. */
  description: string;
  createdAt: number;
  resolved: boolean;
  outcome?: AcpV2PermissionOutcome;
  resolvedAt?: number;
}

/** How the client answers permission requests. */
export type AcpV2PermissionDecider = (
  request: AcpV2PermissionRequest,
) => Promise<AcpV2PermissionOutcome> | AcpV2PermissionOutcome;

/** The agent's answer to one prompt: injected by the host. */
export type AcpV2AgentRunner = (
  sessionId: string,
  prompt: string,
  signal: AbortSignal,
) => Promise<{ text: string; toolCalls?: string[] }>;

/** Error raised by ACP v2 operations. */
export class AcpV2Error extends Error {
  readonly code: 'unknown-session' | 'session-terminal' | 'unknown-agent' | 'method-not-advertised' | 'no-runner' | 'cancelled' | 'duplicate-agent';
  constructor(message: string, code: AcpV2Error['code']) {
    super(message);
    this.name = 'AcpV2Error';
    this.code = code;
  }
}

/** One ACP session, as the client reads it. */
export interface AcpV2Session {
  sessionId: string;
  agentId: string;
  /** Negotiated ACP version for this session. */
  acpVersion: string;
  status: AcpV2SessionStatus;
  createdAt: number;
  updatedAt: number;
  turns: AcpV2Turn[];
  /** Pending permission requests for this session. */
  pendingPermissions: AcpV2PermissionRequest[];
}

export interface AcpV2ClientOptions {
  /** Agent runner (the host wires the real agent behind it). */
  runner?: AcpV2AgentRunner;
  /** Permission decider (default: deny — safe). */
  permissionDecider?: AcpV2PermissionDecider;
  /** Clock override (tests). */
  now?: () => number;
  /** Id generator override (tests). */
  generateId?: () => string;
  /** Methods the peer advertised (default: the full draft surface). */
  advertisedMethods?: readonly string[];
}

let acpV2Counter = 0;
function defaultAcpV2Id(prefix: string): string {
  acpV2Counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${acpV2Counter.toString(36)}`;
}

/**
 * Transport-free ACP v2 draft client. The host injects a runner
 * (how prompts reach the agent) and a permission decider (how
 * the user answers); the adapter owns sessions, turns, cancels
 * and permission bookkeeping, and refuses methods the peer did
 * not advertise.
 */
export class AcpV2ClientAdapter {
  private readonly sessions = new Map<string, AcpV2Session>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly runner?: AcpV2AgentRunner;
  private readonly permissionDecider: AcpV2PermissionDecider;
  private readonly now: () => number;
  private readonly generateId: (prefix: string) => string;
  private readonly advertisedMethods: ReadonlySet<string>;

  constructor(options: AcpV2ClientOptions = {}) {
    this.runner = options.runner;
    this.permissionDecider = options.permissionDecider ?? (() => 'deny');
    this.now = options.now ?? Date.now;
    this.generateId = options.generateId ?? defaultAcpV2Id;
    this.advertisedMethods = new Set(
      options.advertisedMethods ?? [
        'session/new',
        'session/load',
        'session/prompt',
        'session/cancel',
        'agent/authenticate',
        'fs/read_text_file',
        'fs/write_text_file',
      ],
    );
  }

  /** True when the peer advertised this ACP method. */
  supportsMethod(method: string): boolean {
    return this.advertisedMethods.has(method);
  }

  private requireMethod(method: string): void {
    if (!this.supportsMethod(method)) {
      throw new AcpV2Error(
        `ACP method "${method}" was not advertised by this agent; refusing to send it.`,
        'method-not-advertised',
      );
    }
  }

  /** Start a session with one agent. Returns the session id. */
  newSession(agentId: string, acpVersion: string = ACP_V2_DRAFT_VERSION): string {
    this.requireMethod('session/new');
    const sessionId = this.generateId('acp-session');
    const at = this.now();
    this.sessions.set(sessionId, {
      sessionId,
      agentId,
      acpVersion,
      status: 'active',
      createdAt: at,
      updatedAt: at,
      turns: [],
      pendingPermissions: [],
    });
    return sessionId;
  }

  /** Read one session (a copy), or undefined. */
  getSession(sessionId: string): AcpV2Session | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    return {
      ...s,
      turns: s.turns.map((t) => ({ ...t, toolCalls: t.toolCalls ? [...t.toolCalls] : undefined })),
      pendingPermissions: s.pendingPermissions.map((p) => ({ ...p })),
    };
  }

  /** Throwing variant of `getSession()`. */
  requireSession(sessionId: string): AcpV2Session {
    const s = this.sessions.get(sessionId);
    if (!s) throw new AcpV2Error(`Unknown ACP session "${sessionId}".`, 'unknown-session');
    return s;
  }

  /** All sessions, newest first. */
  listSessions(status?: AcpV2SessionStatus): AcpV2Session[] {
    const all = [...this.sessions.values()].sort((a, b) => b.createdAt - a.createdAt);
    return (status ? all.filter((s) => s.status === status) : all).map((s) => this.getSession(s.sessionId) as AcpV2Session);
  }

  /**
   * Send a prompt turn. The runner's answer is appended as an
   * agent turn; the session becomes `idle` until the next prompt.
   * Throws `session-terminal` on a finished session and
   * `cancelled` when the turn is cancelled mid-flight.
   */
  async prompt(sessionId: string, text: string): Promise<{ text: string; toolCalls: string[] }> {
    this.requireMethod('session/prompt');
    const session = this.requireSession(sessionId);
    if (isAcpV2SessionTerminal(session.status)) {
      throw new AcpV2Error(`ACP session "${sessionId}" is ${session.status}; start a new session.`, 'session-terminal');
    }
    if (!this.runner) {
      throw new AcpV2Error('No agent runner is bound to this ACP client adapter.', 'no-runner');
    }
    const controller = new AbortController();
    this.controllers.set(sessionId, controller);
    session.status = 'active';
    session.turns.push({ sequence: session.turns.length + 1, role: 'user', text, at: this.now() });
    try {
      const answer = await this.runner(sessionId, text, controller.signal);
      session.turns.push({
        sequence: session.turns.length + 1,
        role: 'agent',
        text: answer.text,
        at: this.now(),
        toolCalls: answer.toolCalls ? [...answer.toolCalls] : undefined,
      });
      session.status = 'idle';
      session.updatedAt = this.now();
      return { text: answer.text, toolCalls: answer.toolCalls ? [...answer.toolCalls] : [] };
    } catch (err) {
      if (controller.signal.aborted) {
        session.status = 'cancelled';
        session.updatedAt = this.now();
        throw new AcpV2Error(`ACP session "${sessionId}" prompt was cancelled.`, 'cancelled');
      }
      session.status = 'failed';
      session.updatedAt = this.now();
      throw err;
    } finally {
      this.controllers.delete(sessionId);
    }
  }

  /** Cancel the running turn of a session (and the session itself). Returns false when nothing was running. */
  cancel(sessionId: string): boolean {
    this.requireMethod('session/cancel');
    const session = this.requireSession(sessionId);
    if (isAcpV2SessionTerminal(session.status)) return false;
    this.controllers.get(sessionId)?.abort();
    session.status = 'cancelled';
    session.updatedAt = this.now();
    return true;
  }

  /** Mark a session completed (the agent finished its work). */
  complete(sessionId: string): void {
    const session = this.requireSession(sessionId);
    if (isAcpV2SessionTerminal(session.status)) return;
    session.status = 'completed';
    session.updatedAt = this.now();
  }

  /**
   * The agent asks permission for a tool call. The injected
   * decider answers; the request is recorded resolved either way.
   * The default decider denies — an agent never gets a tool call
   * the client did not explicitly allow.
   */
  async requestPermission(
    sessionId: string,
    toolName: string,
    description: string,
  ): Promise<AcpV2PermissionOutcome> {
    const session = this.requireSession(sessionId);
    const request: AcpV2PermissionRequest = {
      requestId: this.generateId('acp-perm'),
      sessionId,
      toolName,
      description,
      createdAt: this.now(),
      resolved: false,
    };
    session.pendingPermissions.push(request);
    const outcome = await this.permissionDecider({ ...request });
    request.resolved = true;
    request.outcome = outcome;
    request.resolvedAt = this.now();
    session.pendingPermissions = session.pendingPermissions.filter((p) => p.requestId !== request.requestId);
    session.updatedAt = this.now();
    return outcome;
  }
}

/** What an agent offers, in registry (discovery) form. */
export interface AcpAgentCard {
  agentId: string;
  name: string;
  description: string;
  /** Capabilities the agent claims (e.g. `coding`, `research`, `voice`). */
  capabilities: string[];
  /** Transports the agent speaks (e.g. `stdio`, `http`, `acp`). */
  transports: string[];
  /** ACP versions the agent speaks (newest first). */
  acpVersions: string[];
  /** A2A versions the agent speaks (newest first). */
  a2aVersions: string[];
  /** Endpoint / command the client uses to reach the agent. */
  endpoint?: string;
  /** Epoch ms the entry was registered / refreshed. */
  registeredAt: number;
  /** Epoch ms after which the entry is stale (omit = never). */
  expiresAt?: number;
}

export interface AcpAgentRegistryOptions {
  /** Clock override (tests). */
  now?: () => number;
  /** Default TTL for entries (ms, omit = never expires). */
  defaultTtlMs?: number;
}

/**
 * Agent registry / discovery for ACP v2 + A2A. Agents register
 * with a card; clients discover by capability or name. Entries
 * expire (stale agents disappear from discovery, not from the
 * registry — `get()` still finds them until pruned).
 */
export class AcpAgentRegistry {
  private readonly agents = new Map<string, AcpAgentCard>();
  private readonly now: () => number;
  private readonly defaultTtlMs?: number;

  constructor(options: AcpAgentRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.defaultTtlMs = options.defaultTtlMs;
  }

  /** Register (or re-register) an agent. Returns the stored card. */
  register(card: Omit<AcpAgentCard, 'registeredAt' | 'expiresAt'> & { expiresAt?: number }): AcpAgentCard {
    if (!card.agentId || !card.name) {
      throw new AcpV2Error('An ACP agent card needs a non-empty agentId and name.', 'duplicate-agent');
    }
    const at = this.now();
    const stored: AcpAgentCard = {
      ...card,
      capabilities: [...card.capabilities],
      transports: [...card.transports],
      acpVersions: [...card.acpVersions],
      a2aVersions: [...card.a2aVersions],
      registeredAt: at,
      expiresAt: card.expiresAt ?? (this.defaultTtlMs ? at + this.defaultTtlMs : undefined),
    };
    this.agents.set(card.agentId, stored);
    return { ...stored };
  }

  get(agentId: string): AcpAgentCard | undefined {
    const card = this.agents.get(agentId);
    return card ? { ...card } : undefined;
  }

  /** True when the entry exists and has not expired. */
  isLive(agentId: string): boolean {
    const card = this.agents.get(agentId);
    if (!card) return false;
    return card.expiresAt === undefined || this.now() < card.expiresAt;
  }

  /** Remove one agent. Returns true when removed. */
  unregister(agentId: string): boolean {
    return this.agents.delete(agentId);
  }

  /** Live agents only, sorted by name. */
  list(): AcpAgentCard[] {
    return [...this.agents.values()]
      .filter((c) => this.isLive(c.agentId))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({ ...c }));
  }

  /** Discover live agents that claim a capability. */
  discoverByCapability(capability: string): AcpAgentCard[] {
    return this.list().filter((c) => c.capabilities.includes(capability));
  }

  /** Discover live agents whose name / description matches (case-insensitive substring). */
  search(query: string): AcpAgentCard[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.list();
    return this.list().filter(
      (c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q),
    );
  }

  /** Discover live agents speaking a given ACP version. */
  discoverByAcpVersion(version: string): AcpAgentCard[] {
    return this.list().filter((c) => c.acpVersions.includes(version));
  }

  /** Drop expired entries. Returns how many were dropped. */
  pruneExpired(): number {
    let n = 0;
    for (const [id, card] of [...this.agents.entries()]) {
      if (card.expiresAt !== undefined && this.now() >= card.expiresAt) {
        this.agents.delete(id);
        n += 1;
      }
    }
    return n;
  }

  /** Number of entries (live + stale). */
  get size(): number {
    return this.agents.size;
  }

  toJSON(): AcpAgentCard[] {
    return this.list();
  }

  static fromJSON(cards: unknown): AcpAgentRegistry {
    const registry = new AcpAgentRegistry();
    if (!Array.isArray(cards)) return registry;
    for (const raw of cards) {
      if (!raw || typeof raw !== 'object') continue;
      const c = raw as Partial<AcpAgentCard>;
      if (typeof c.agentId !== 'string' || typeof c.name !== 'string') continue;
      registry.register({
        agentId: c.agentId,
        name: c.name,
        description: typeof c.description === 'string' ? c.description : '',
        capabilities: Array.isArray(c.capabilities) ? (c.capabilities as string[]) : [],
        transports: Array.isArray(c.transports) ? (c.transports as string[]) : [],
        acpVersions: Array.isArray(c.acpVersions) ? (c.acpVersions as string[]) : [],
        a2aVersions: Array.isArray(c.a2aVersions) ? (c.a2aVersions as string[]) : [],
        endpoint: typeof c.endpoint === 'string' ? c.endpoint : undefined,
      });
    }
    return registry;
  }
}

/** The one interface every agent — ACP-native or BYOA — presents to a client. */
export interface AcpAgentHandle {
  agentId: string;
  name: string;
  /** ACP versions this handle speaks. */
  acpVersions: string[];
  /** Start a session and return its id. */
  newSession(): string;
  /** Send one prompt turn; resolves with the agent's answer. */
  prompt(sessionId: string, text: string): Promise<string>;
  /** Cancel a session's running turn. */
  cancel(sessionId: string): boolean;
}

/** How a BYOA agent is reached. */
export type ByoaAgentBackend =
  | { kind: 'command'; command: string; args?: string[] }
  | { kind: 'http'; endpoint: string }
  | { kind: 'in-process'; runner: AcpV2AgentRunner };

export interface ByoaClientAdapterOptions extends AcpV2ClientOptions {
  agentId: string;
  name: string;
  backend: ByoaAgentBackend;
  capabilities?: string[];
}

/**
 * Bring-your-own-agent: wrap any external agent behind the ACP
 * client interface. A `command` backend records the spawn
 * command (the host spawns it — this module never spawns a
 * process); an `http` backend records the endpoint; an
 * `in-process` backend uses the runner directly. The client
 * code never sees the difference.
 */
export class ByoaClientAdapter implements AcpAgentHandle {
  readonly agentId: string;
  readonly name: string;
  readonly acpVersions: string[] = [ACP_V2_DRAFT_VERSION, ACP_V1_VERSION];
  readonly backend: ByoaAgentBackend;
  readonly capabilities: string[];
  private readonly client: AcpV2ClientAdapter;

  constructor(options: ByoaClientAdapterOptions) {
    this.agentId = options.agentId;
    this.name = options.name;
    this.backend = options.backend;
    this.capabilities = [...(options.capabilities ?? [])];
    // An in-process backend carries its own runner: use it for the
    // inner client unless the caller bound a top-level runner.
    const runner = options.runner ?? (options.backend.kind === 'in-process' ? options.backend.runner : undefined);
    this.client = new AcpV2ClientAdapter({ ...options, runner });
  }

  /** Human-readable description of how this agent is reached (safe to log). */
  describeBackend(): string {
    if (this.backend.kind === 'command') {
      return `command: ${this.backend.command}${(this.backend.args ?? []).length ? ` ${(this.backend.args as string[]).join(' ')}` : ''}`;
    }
    if (this.backend.kind === 'http') return `http: ${this.backend.endpoint}`;
    return 'in-process runner';
  }

  newSession(): string {
    return this.client.newSession(this.agentId);
  }

  async prompt(sessionId: string, text: string): Promise<string> {
    const answer = await this.client.prompt(sessionId, text);
    return answer.text;
  }

  cancel(sessionId: string): boolean {
    return this.client.cancel(sessionId);
  }

  /** The underlying ACP client (for permission requests, history). */
  getClient(): AcpV2ClientAdapter {
    return this.client;
  }

  /** An Agent Card for this BYOA agent, ready for the registry. */
  toAgentCard(): Omit<AcpAgentCard, 'registeredAt' | 'expiresAt'> {
    return {
      agentId: this.agentId,
      name: this.name,
      description: `Bring-your-own-agent (${this.describeBackend()}).`,
      capabilities: [...this.capabilities],
      transports: this.backend.kind === 'http' ? ['http', 'acp'] : ['stdio', 'acp'],
      acpVersions: [...this.acpVersions],
      a2aVersions: [ACP_V2_A2A_VERSION],
      endpoint: this.backend.kind === 'http' ? this.backend.endpoint : undefined,
    };
  }
}

/** A2A task view of an ACP session (alignment mapping). */
export interface A2aTaskViewOfAcpSession {
  /** A2A task id — the ACP session id, namespaced. */
  id: string;
  /** A2A context id — the agent id, namespaced. */
  contextId: string;
  state: 'submitted' | 'working' | 'completed' | 'canceled' | 'failed' | 'input-required';
  /** The session's turns, as A2A history messages. */
  history: { role: 'user' | 'agent'; parts: { kind: 'text'; text: string }[] }[];
  /** ACP versions negotiated for the session. */
  acpVersion: string;
  /** A2A version this mapping targets. */
  a2aVersion: string;
}

/** Map an ACP session onto its A2A task view. */
export function acpSessionToA2aTaskV5(session: AcpV2Session): A2aTaskViewOfAcpSession {
  const state: A2aTaskViewOfAcpSession['state'] =
    session.status === 'active'
      ? 'working'
      : session.status === 'idle'
        ? 'submitted'
        : session.status === 'completed'
          ? 'completed'
          : session.status === 'cancelled'
            ? 'canceled'
            : 'failed';
  return {
    id: `a2a-task:${session.sessionId}`,
    contextId: `a2a-context:${session.agentId}`,
    state,
    history: session.turns.map((t) => ({
      role: t.role,
      parts: [{ kind: 'text' as const, text: t.text }],
    })),
    acpVersion: session.acpVersion,
    a2aVersion: ACP_V2_A2A_VERSION,
  };
}

/** Map an A2A task state back onto an ACP session status (best effort). */
export function a2aTaskStateToAcpSessionV5(
  state: A2aTaskViewOfAcpSession['state'],
): AcpV2SessionStatus {
  switch (state) {
    case 'working':
      return 'active';
    case 'submitted':
    case 'input-required':
      return 'idle';
    case 'completed':
      return 'completed';
    case 'canceled':
      return 'cancelled';
    case 'failed':
      return 'failed';
  }
}

/** A2A agent card view of an ACP agent card. */
export interface A2aCardViewOfAcpCard {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: { streaming: boolean; pushNotifications: boolean };
  skills: { id: string; name: string; description: string }[];
  /** The ACP versions, carried so an A2A client can open an ACP session. */
  acpVersions: string[];
}

/** Convert an ACP agent card to its A2A agent card view. */
export function acpCardToA2aCardV5(card: AcpAgentCard): A2aCardViewOfAcpCard {
  return {
    name: card.name,
    description: card.description,
    url: card.endpoint ?? '',
    version: card.acpVersions[0] ?? ACP_V2_DRAFT_VERSION,
    capabilities: {
      streaming: card.transports.includes('http'),
      pushNotifications: false,
    },
    skills: card.capabilities.map((capability) => ({
      id: capability,
      name: capability,
      description: `${card.name} can do ${capability}.`,
    })),
    acpVersions: [...card.acpVersions],
  };
}
