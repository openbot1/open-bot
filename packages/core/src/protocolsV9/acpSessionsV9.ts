/**
 * Protocols v9 — ACP (Agent Client Protocol) agent sessions
 * (v1.40, Team T2).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v140.md (section 5): ACP here is the Agent
 * Client Protocol (Zed, client/editor <-> coding agent). A
 * client runs the coding CLIs already on the user's machine —
 * Claude Code, Codex, Gemini CLI — through the user's own
 * login, exactly the auto-detect model open-bot already uses
 * for providers. The IBM/BeeAI Agent Communication Protocol
 * is a different ACP; it merged into A2A and is NOT spoken
 * here.
 *
 * This module is open-bot's own session layer, written from
 * that description — no code, text or asset from any other
 * repo is copied here:
 *
 *   - `detectAcpV9CliAgents`: finds the three known CLIs on
 *     PATH and checks whether their login-marker file exists
 *     under the user's home directory. The marker is only
 *     ever checked for EXISTENCE — its contents are never
 *     read, and no credential is copied, stored or sent
 *     anywhere. Marker presence is a heuristic ("a login
 *     was set up once"), never proof of a live session; the
 *     result says so. The probe is injectable so tests and
 *     hosts can detect without touching the real machine.
 *   - `AcpV9SessionManager`: create / prompt / suspend /
 *     resume / cancel sessions with durable state (snapshot
 *     / restore). The manager never spawns a process and
 *     never talks to a CLI: the agent's replies come from an
 *     injected runner (the host wires the real CLI driver;
 *     standalone, an echo runner answers). A session's
 *     `resumeToken` is a random UUID minted locally — it is
 *     open-bot's own handle, never the CLI's credential.
 *   - Restored sessions always come back `idle`, never
 *     `active`: no live CLI process survives a restart, and
 *     claiming otherwise would be a lie.
 *
 * No network, no process spawning, no credential access.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, sep } from 'node:path';
import type { AcpV9KnownAgent, AcpV9PermissionMode, AcpV9SessionStatus } from './versionsV9';
import { ACP_V9_KNOWN_AGENTS, isAcpV9SessionTerminal } from './versionsV9';

/** Error raised by the ACP session layer. */
export class AcpV9Error extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AcpV9Error';
    this.code = code;
  }
}

/** Max prompt characters per send (default 32 KiB). */
export const ACP_V9_MAX_PROMPT_CHARS = 32 * 1024;
/** Max messages kept per session (default 500). */
export const ACP_V9_MAX_MESSAGES_PER_SESSION = 500;
/** Max sessions kept per manager (default 128). */
export const ACP_V9_MAX_SESSIONS = 128;
/** Max events kept in the session log. */
export const ACP_V9_MAX_SESSION_EVENTS = 500;

/** How the manager probes the machine (injectable for tests/hosts). */
export interface AcpV9CliProbe {
  /** Absolute path of the binary on PATH (undefined when absent). */
  findBinary: (binaryName: string) => string | undefined;
  /** True when the path exists (file or directory). */
  markerExists: (absolutePath: string) => boolean;
  /** The user's home directory. */
  homeDir: () => string;
}

/** The real probe: PATH lookup + fs existence checks. No file is ever read. */
export function defaultAcpV9CliProbe(): AcpV9CliProbe {
  return {
    findBinary(binaryName: string): string | undefined {
      const pathValue = process.env['PATH'] ?? '';
      for (const dir of pathValue.split(delimiter)) {
        if (dir.length === 0) continue;
        const candidate = `${dir}${sep}${binaryName}`;
        if (existsSync(candidate)) return candidate;
        if (process.platform === 'win32' && existsSync(`${candidate}.exe`)) return `${candidate}.exe`;
      }
      return undefined;
    },
    markerExists(absolutePath: string): boolean {
      try {
        return existsSync(absolutePath);
      } catch {
        return false;
      }
    },
    homeDir(): string {
      return homedir();
    },
  };
}

/** Static facts about one known CLI agent (binary + login marker). */
export interface AcpV9KnownAgentInfo {
  /** Agent key (`claude` / `codex` / `gemini`). */
  agent: AcpV9KnownAgent;
  /** Display name. */
  displayName: string;
  /** Binary name on PATH. */
  binaryName: string;
  /** Login-marker file, relative to the home directory. */
  loginMarkerRelativePath: string;
  /** What the marker means (shown in the UI, never a guarantee). */
  markerMeaning: string;
}

export const ACP_V9_KNOWN_AGENT_INFO: Record<AcpV9KnownAgent, AcpV9KnownAgentInfo> = {
  claude: {
    agent: 'claude',
    displayName: 'Claude Code',
    binaryName: 'claude',
    loginMarkerRelativePath: '.claude.json',
    markerMeaning: 'Claude Code setup file present — a login was configured on this machine at some point.',
  },
  codex: {
    agent: 'codex',
    displayName: 'Codex CLI',
    binaryName: 'codex',
    loginMarkerRelativePath: '.codex/auth.json',
    markerMeaning: 'Codex auth file present — a login was configured on this machine at some point.',
  },
  gemini: {
    agent: 'gemini',
    displayName: 'Gemini CLI',
    binaryName: 'gemini',
    loginMarkerRelativePath: '.gemini/oauth_creds.json',
    markerMeaning: 'Gemini CLI OAuth file present — a login was configured on this machine at some point.',
  },
};

/** Detection result for one CLI agent. */
export interface AcpV9CliDetection {
  agent: AcpV9KnownAgent;
  displayName: string;
  /** Absolute path of the binary (undefined when not on PATH). */
  binaryPath?: string;
  /** True when the binary was found on PATH. */
  binaryFound: boolean;
  /** Absolute path of the login marker that was checked. */
  loginMarkerPath: string;
  /** True when the login-marker file exists. Existence only — contents never read. */
  loginMarkerPresent: boolean;
  /** True when the agent can be used (binary + marker). */
  usable: boolean;
  /** Honest caveat: marker presence is not proof of a live login. */
  note: string;
}

/**
 * Detect the CLI agents installed on this machine. Never
 * reads a credential file, never spawns a process, never
 * opens a network connection. Pass a custom probe to detect
 * against a fake machine (tests) or a host-supplied view.
 */
export function detectAcpV9CliAgents(probe: AcpV9CliProbe = defaultAcpV9CliProbe()): AcpV9CliDetection[] {
  const home = probe.homeDir();
  return ACP_V9_KNOWN_AGENTS.map((agent) => {
    const info = ACP_V9_KNOWN_AGENT_INFO[agent];
    const binaryPath = probe.findBinary(info.binaryName);
    const loginMarkerPath = `${home}${sep}${info.loginMarkerRelativePath.split('/').join(sep)}`;
    const loginMarkerPresent = probe.markerExists(loginMarkerPath);
    const usable = binaryPath !== undefined && loginMarkerPresent;
    return {
      agent,
      displayName: info.displayName,
      ...(binaryPath !== undefined ? { binaryPath } : {}),
      binaryFound: binaryPath !== undefined,
      loginMarkerPath,
      loginMarkerPresent,
      usable,
      note: usable
        ? `${info.markerMeaning} Marker presence is a heuristic, not proof of a live login; the CLI itself re-authenticates when a session starts.`
        : `Not usable: ${binaryPath === undefined ? 'binary not on PATH' : ''}${binaryPath === undefined && !loginMarkerPresent ? ' and ' : ''}${!loginMarkerPresent ? 'no login marker found' : ''}. Sign in to ${info.displayName} once and try again.`,
    };
  });
}

/** One message inside an ACP session. */
export interface AcpV9SessionMessage {
  messageId: string;
  role: 'user' | 'agent';
  text: string;
  at: number;
  /** Tool names the agent used while answering (names only). */
  toolCalls?: string[];
  /** User message this agent message answers (agent messages only). */
  inReplyToMessageId?: string;
}

/** One ACP agent session. */
export interface AcpV9Session {
  /** Stable session id (`acp-<n>`, unique per manager). */
  id: string;
  /** Which CLI agent backs the session. */
  agent: AcpV9KnownAgent;
  /** Display name of the agent. */
  displayName: string;
  /** Client-side permission mode. */
  mode: AcpV9PermissionMode;
  /** Lifecycle status. */
  status: AcpV9SessionStatus;
  /** Working directory the session runs in. */
  cwd: string;
  /** Model the session asked for (if any — the CLI decides). */
  model?: string;
  /** Open-bot resume handle (random UUID minted locally, never a CLI credential). */
  resumeToken: string;
  /** Session this one resumed from (undefined for fresh sessions). */
  parentSessionId?: string;
  /** How many times this thread was resumed (0 for fresh sessions). */
  resumeCount: number;
  /** Milliseconds since epoch when created. */
  createdAt: number;
  /** Milliseconds since epoch of the last activity. */
  updatedAt: number;
  /** Messages in order (capped). */
  messages: AcpV9SessionMessage[];
  /** Why a suspended/cancelled/failed session stopped. */
  reason?: string;
}

/** One session lifecycle event. */
export interface AcpV9SessionEvent {
  seq: number;
  sessionId: string;
  kind: 'created' | 'prompted' | 'replied' | 'suspended' | 'resumed' | 'cancelled' | 'completed' | 'failed' | 'mode-changed' | 'pruned';
  at: number;
  detail?: string;
}

/** What an injected agent runner returns for one prompt. */
export interface AcpV9AgentReply {
  text: string;
  toolCalls?: string[];
}

/** An injected runner: turns a prompt into the agent's reply. */
export type AcpV9AgentRunner = (
  session: AcpV9Session,
  prompt: string,
) => AcpV9AgentReply | Promise<AcpV9AgentReply>;

/** The standalone echo runner: answers without a model, for tests/demos. */
export function acpV9EchoRunner(session: AcpV9Session, prompt: string): AcpV9AgentReply {
  return {
    text: `[${session.displayName} echo] ${prompt}`,
    toolCalls: [],
  };
}

/** Options for creating a session. */
export interface AcpV9CreateSessionOptions {
  agent: AcpV9KnownAgent;
  /** Working directory (default: the process cwd). */
  cwd?: string;
  /** Model to ask for (the CLI decides what it honours). */
  model?: string;
  /** Permission mode (default `ask`). */
  mode?: AcpV9PermissionMode;
  /**
   * Allow creating a session for an agent that was not
   * detected as usable (binary or login marker missing).
   * Default false: the manager refuses and tells the user
   * to install / sign in first. Hosts that drive the CLI
   * themselves may pass true.
   */
  allowUnverified?: boolean;
}

/** Options for the session manager. */
export interface AcpV9SessionManagerOptions {
  /** Max sessions kept (default 128). */
  maxSessions?: number;
  /** Max messages per session (default 500). */
  maxMessagesPerSession?: number;
  /** Max events kept (default 500). */
  maxEvents?: number;
  /** CLI probe (default: the real machine probe). */
  probe?: AcpV9CliProbe;
  /** Agent runner (default: echo runner). */
  runner?: AcpV9AgentRunner;
}

/** Serialisable snapshot of one session. */
export interface AcpV9SessionSnapshot {
  id: string;
  agent: AcpV9KnownAgent;
  displayName: string;
  mode: AcpV9PermissionMode;
  status: AcpV9SessionStatus;
  cwd: string;
  model?: string;
  resumeToken: string;
  parentSessionId?: string;
  resumeCount: number;
  createdAt: number;
  updatedAt: number;
  messages: AcpV9SessionMessage[];
  reason?: string;
}

/** Serialisable snapshot of the whole session manager. */
export interface AcpV9SessionManagerSnapshot {
  version: 9;
  nextId: number;
  sessions: AcpV9SessionSnapshot[];
}

/**
 * ACP agent session manager: durable sessions over the CLI
 * agents detected on the machine. The manager never spawns
 * a process and never touches a credential; the host wires a
 * real CLI driver through the runner, or leaves the echo
 * runner in place for standalone use.
 */
export class AcpV9SessionManager {
  private sessions = new Map<string, AcpV9Session>();
  private events: AcpV9SessionEvent[] = [];
  private nextId = 1;
  private seq = 1;
  private maxSessions: number;
  private maxMessagesPerSession: number;
  private maxEvents: number;
  private probe: AcpV9CliProbe;
  private runner: AcpV9AgentRunner;

  constructor(options: AcpV9SessionManagerOptions = {}) {
    this.maxSessions = options.maxSessions ?? ACP_V9_MAX_SESSIONS;
    this.maxMessagesPerSession = options.maxMessagesPerSession ?? ACP_V9_MAX_MESSAGES_PER_SESSION;
    this.maxEvents = options.maxEvents ?? ACP_V9_MAX_SESSION_EVENTS;
    this.probe = options.probe ?? defaultAcpV9CliProbe();
    this.runner = options.runner ?? acpV9EchoRunner;
  }

  /** Detect the CLI agents on the machine (via this manager's probe). */
  detect(): AcpV9CliDetection[] {
    return detectAcpV9CliAgents(this.probe);
  }

  /** Detection for one agent (undefined when unknown). */
  detectOne(agent: AcpV9KnownAgent): AcpV9CliDetection | undefined {
    return this.detect().find((d) => d.agent === agent);
  }

  /** All sessions, newest first. */
  list(status?: AcpV9SessionStatus): AcpV9Session[] {
    const all = [...this.sessions.values()].sort((a, b) => b.createdAt - a.createdAt);
    return (status === undefined ? all : all.filter((s) => s.status === status))
      .map((s) => ({ ...s, messages: s.messages.map((m) => ({ ...m })) }));
  }

  /** Sessions for one agent. */
  listForAgent(agent: AcpV9KnownAgent): AcpV9Session[] {
    return this.list().filter((s) => s.agent === agent);
  }

  /** Get one session (undefined when missing). */
  get(sessionId: string): AcpV9Session | undefined {
    const found = this.sessions.get(sessionId);
    if (found === undefined) return undefined;
    return { ...found, messages: found.messages.map((m) => ({ ...m })) };
  }

  /** Counts per status + totals. */
  counts(): Record<AcpV9SessionStatus, number> & { total: number; running: number } {
    const counts: Record<AcpV9SessionStatus, number> = {
      active: 0,
      idle: 0,
      suspended: 0,
      cancelled: 0,
      completed: 0,
      failed: 0,
    };
    for (const session of this.sessions.values()) counts[session.status] += 1;
    return { ...counts, total: this.sessions.size, running: counts.active + counts.idle };
  }

  /** The session event log (oldest first, capped). */
  getEvents(): AcpV9SessionEvent[] {
    return this.events.map((e) => ({ ...e }));
  }

  /** Events for one session (oldest first). */
  eventsFor(sessionId: string): AcpV9SessionEvent[] {
    return this.events.filter((e) => e.sessionId === sessionId).map((e) => ({ ...e }));
  }

  private log(sessionId: string, kind: AcpV9SessionEvent['kind'], detail?: string): void {
    this.events.push({ seq: this.seq, sessionId, kind, at: Date.now(), detail });
    this.seq += 1;
    while (this.events.length > this.maxEvents) this.events.shift();
  }

  private requireSession(sessionId: string): AcpV9Session {
    const found = this.sessions.get(sessionId);
    if (found === undefined) {
      throw new AcpV9Error('session-not-found', `No ACP session "${sessionId}".`);
    }
    return found;
  }

  private touch(session: AcpV9Session): void {
    session.updatedAt = Date.now();
  }

  private addMessage(session: AcpV9Session, role: 'user' | 'agent', text: string, extra?: Partial<AcpV9SessionMessage>): AcpV9SessionMessage {
    const message: AcpV9SessionMessage = {
      messageId: `${session.id}-m${session.messages.length + 1}`,
      role,
      text,
      at: Date.now(),
      ...(extra ?? {}),
    };
    session.messages.push(message);
    while (session.messages.length > this.maxMessagesPerSession) session.messages.shift();
    return message;
  }

  /**
   * Create a session for a detected agent. Refuses agents
   * that are not usable (binary or login marker missing)
   * unless `allowUnverified` is set — the user must install
   * the CLI and sign in once; open-bot never signs in for
   * them and never copies the login.
   */
  create(options: AcpV9CreateSessionOptions): AcpV9Session {
    if (!((ACP_V9_KNOWN_AGENTS as readonly string[]).includes(options.agent))) {
      throw new AcpV9Error('unknown-agent', `Unknown ACP agent "${options.agent}" (known: ${ACP_V9_KNOWN_AGENTS.join(', ')}).`);
    }
    if (this.sessions.size >= this.maxSessions) {
      throw new AcpV9Error('too-many-sessions', `Cannot create a session: ${this.sessions.size} sessions already exist (max ${this.maxSessions}). Cancel or complete one first.`);
    }
    const detection = this.detectOne(options.agent);
    if (detection !== undefined && !detection.usable && options.allowUnverified !== true) {
      throw new AcpV9Error(
        'agent-not-usable',
        `${detection.displayName} is not usable on this machine: ${detection.note}`,
      );
    }
    const mode: AcpV9PermissionMode = options.mode ?? 'ask';
    if (!((['ask', 'auto', 'read-only'] as readonly string[]).includes(mode))) {
      throw new AcpV9Error('invalid-mode', `Permission mode must be one of ask, auto, read-only (got "${mode}").`);
    }
    const id = `acp-${this.nextId}`;
    this.nextId += 1;
    const now = Date.now();
    const session: AcpV9Session = {
      id,
      agent: options.agent,
      displayName: ACP_V9_KNOWN_AGENT_INFO[options.agent].displayName,
      mode,
      status: 'idle',
      cwd: options.cwd ?? process.cwd(),
      ...(options.model !== undefined ? { model: options.model } : {}),
      resumeToken: randomUUID(),
      resumeCount: 0,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.sessions.set(id, session);
    this.log(id, 'created', `${session.displayName} (mode ${mode}, cwd ${session.cwd})`);
    return { ...session, messages: [] };
  }

  /**
   * Send a prompt to a session and record the agent's
   * reply (from the injected runner). Only `active` and
   * `idle` sessions accept prompts; the session ends the
   * turn `idle` again, ready for the next prompt.
   */
  async sendPrompt(sessionId: string, prompt: string): Promise<{ session: AcpV9Session; reply: AcpV9SessionMessage }> {
    const session = this.requireSession(sessionId);
    if (session.status !== 'active' && session.status !== 'idle') {
      throw new AcpV9Error('session-not-running', `Session "${sessionId}" is ${session.status} and cannot take a prompt.`);
    }
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new AcpV9Error('empty-prompt', 'Prompt must be a non-empty string.');
    }
    if (prompt.length > ACP_V9_MAX_PROMPT_CHARS) {
      throw new AcpV9Error('prompt-too-long', `Prompt is ${prompt.length} characters (max ${ACP_V9_MAX_PROMPT_CHARS}).`);
    }
    session.status = 'active';
    const userMessage = this.addMessage(session, 'user', prompt);
    this.log(sessionId, 'prompted', `prompt ${userMessage.messageId} (${prompt.length} chars)`);
    this.touch(session);
    let reply: AcpV9AgentReply;
    try {
      reply = await this.runner(session, prompt);
    } catch (err) {
      session.status = 'failed';
      session.reason = (err as Error).message;
      this.touch(session);
      this.log(sessionId, 'failed', session.reason);
      throw new AcpV9Error('runner-failed', `Agent runner failed for session "${sessionId}": ${(err as Error).message}`);
    }
    if (typeof reply.text !== 'string') {
      session.status = 'failed';
      session.reason = 'Agent runner returned a reply without text.';
      this.touch(session);
      this.log(sessionId, 'failed', session.reason);
      throw new AcpV9Error('runner-failed', session.reason);
    }
    const agentMessage = this.addMessage(session, 'agent', reply.text, {
      ...(reply.toolCalls !== undefined ? { toolCalls: [...reply.toolCalls] } : {}),
      inReplyToMessageId: userMessage.messageId,
    });
    session.status = 'idle';
    this.touch(session);
    this.log(sessionId, 'replied', `reply ${agentMessage.messageId}`);
    return {
      session: { ...session, messages: session.messages.map((m) => ({ ...m })) },
      reply: { ...agentMessage },
    };
  }

  /** Change a session's permission mode (running or suspended sessions only). */
  setMode(sessionId: string, mode: AcpV9PermissionMode): AcpV9Session {
    const session = this.requireSession(sessionId);
    if (!((['ask', 'auto', 'read-only'] as readonly string[]).includes(mode))) {
      throw new AcpV9Error('invalid-mode', `Permission mode must be one of ask, auto, read-only (got "${mode}").`);
    }
    if (isAcpV9SessionTerminal(session.status)) {
      throw new AcpV9Error('session-terminal', `Session "${sessionId}" is ${session.status}; its mode cannot change.`);
    }
    session.mode = mode;
    this.touch(session);
    this.log(sessionId, 'mode-changed', `mode ${mode}`);
    return { ...session, messages: session.messages.map((m) => ({ ...m })) };
  }

  /** Suspend a running session (messages are kept; prompts are refused until resumed). */
  suspend(sessionId: string, reason?: string): AcpV9Session {
    const session = this.requireSession(sessionId);
    if (session.status !== 'active' && session.status !== 'idle') {
      throw new AcpV9Error('session-not-running', `Only an active or idle session can be suspended (session "${sessionId}" is ${session.status}).`);
    }
    session.status = 'suspended';
    session.reason = reason;
    this.touch(session);
    this.log(sessionId, 'suspended', reason);
    return { ...session, messages: session.messages.map((m) => ({ ...m })) };
  }

  /** Resume a suspended session (back to `idle`). */
  resumeSuspended(sessionId: string): AcpV9Session {
    const session = this.requireSession(sessionId);
    if (session.status !== 'suspended') {
      throw new AcpV9Error('session-not-suspended', `Only a suspended session can be resumed (session "${sessionId}" is ${session.status}).`);
    }
    session.status = 'idle';
    session.reason = undefined;
    this.touch(session);
    this.log(sessionId, 'resumed', 'suspended session resumed');
    return { ...session, messages: session.messages.map((m) => ({ ...m })) };
  }

  /**
   * Resume a thread as a NEW session: the old session is
   * retired (`completed`, reason points at the new id) and
   * the new session carries the old messages, cwd, mode and
   * model forward with `parentSessionId` set. The resume
   * token is fresh — the old token never leaves the old
   * session, and neither token is a CLI credential.
   */
  resumeSession(sessionId: string): AcpV9Session {
    const old = this.requireSession(sessionId);
    if (old.status === 'failed') {
      throw new AcpV9Error('session-failed', `Session "${sessionId}" failed (${old.reason ?? 'unknown reason'}) and cannot be resumed. Start a fresh session instead.`);
    }
    if (this.sessions.size >= this.maxSessions) {
      throw new AcpV9Error('too-many-sessions', `Cannot resume: ${this.sessions.size} sessions already exist (max ${this.maxSessions}).`);
    }
    const id = `acp-${this.nextId}`;
    this.nextId += 1;
    const now = Date.now();
    const next: AcpV9Session = {
      id,
      agent: old.agent,
      displayName: old.displayName,
      mode: old.mode,
      status: 'idle',
      cwd: old.cwd,
      ...(old.model !== undefined ? { model: old.model } : {}),
      resumeToken: randomUUID(),
      parentSessionId: old.id,
      resumeCount: old.resumeCount + 1,
      createdAt: now,
      updatedAt: now,
      messages: old.messages.map((m) => ({ ...m })),
    };
    this.sessions.set(id, next);
    old.status = 'completed';
    old.reason = `Resumed as ${id}.`;
    old.updatedAt = now;
    this.log(old.id, 'completed', old.reason);
    this.log(id, 'resumed', `resumed from ${old.id} (${old.messages.length} messages carried over)`);
    return { ...next, messages: next.messages.map((m) => ({ ...m })) };
  }

  /** Cancel a running or suspended session. */
  cancel(sessionId: string, reason?: string): AcpV9Session {
    const session = this.requireSession(sessionId);
    if (isAcpV9SessionTerminal(session.status)) {
      throw new AcpV9Error('session-terminal', `Session "${sessionId}" is already ${session.status}.`);
    }
    session.status = 'cancelled';
    session.reason = reason;
    this.touch(session);
    this.log(sessionId, 'cancelled', reason);
    return { ...session, messages: session.messages.map((m) => ({ ...m })) };
  }

  /** Mark a session completed (the agent finished its work). */
  complete(sessionId: string, reason?: string): AcpV9Session {
    const session = this.requireSession(sessionId);
    if (isAcpV9SessionTerminal(session.status)) {
      throw new AcpV9Error('session-terminal', `Session "${sessionId}" is already ${session.status}.`);
    }
    session.status = 'completed';
    session.reason = reason;
    this.touch(session);
    this.log(sessionId, 'completed', reason);
    return { ...session, messages: session.messages.map((m) => ({ ...m })) };
  }

  /** Drop terminal sessions older than the given age (default: none dropped without an age). */
  pruneTerminal(olderThanMs?: number): number {
    if (olderThanMs === undefined) return 0;
    const cutoff = Date.now() - olderThanMs;
    let pruned = 0;
    for (const session of [...this.sessions.values()]) {
      if (isAcpV9SessionTerminal(session.status) && session.updatedAt < cutoff) {
        this.sessions.delete(session.id);
        this.log(session.id, 'pruned', `terminal session older than ${olderThanMs}ms`);
        pruned += 1;
      }
    }
    return pruned;
  }

  /** Serialise the manager (the host mirrors this to disk). */
  snapshot(): AcpV9SessionManagerSnapshot {
    return {
      version: 9,
      nextId: this.nextId,
      sessions: this.list().map((s) => ({
        id: s.id,
        agent: s.agent,
        displayName: s.displayName,
        mode: s.mode,
        status: s.status,
        cwd: s.cwd,
        ...(s.model !== undefined ? { model: s.model } : {}),
        resumeToken: s.resumeToken,
        ...(s.parentSessionId !== undefined ? { parentSessionId: s.parentSessionId } : {}),
        resumeCount: s.resumeCount,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        messages: s.messages.map((m) => ({ ...m })),
        ...(s.reason !== undefined ? { reason: s.reason } : {}),
      })),
    };
  }

  /**
   * Restore a snapshot. Restored sessions always come back
   * `idle` when they were `active` — no live CLI process
   * survives a restart. Unknown agents and malformed rows
   * are dropped and reported.
   */
  restore(snapshot: AcpV9SessionManagerSnapshot): { restored: number; dropped: string[] } {
    if (snapshot.version !== 9 || !Array.isArray(snapshot.sessions)) {
      throw new AcpV9Error('invalid-snapshot', 'ACP session snapshot must have version 9 and a sessions array.');
    }
    const dropped: string[] = [];
    let restored = 0;
    for (const snap of snapshot.sessions) {
      if (!((ACP_V9_KNOWN_AGENTS as readonly string[]).includes(snap.agent))) {
        dropped.push(`${snap.id}: unknown agent "${snap.agent}"`);
        continue;
      }
      if (typeof snap.resumeToken !== 'string' || snap.resumeToken.length === 0) {
        dropped.push(`${snap.id}: missing resume token`);
        continue;
      }
      const session: AcpV9Session = {
        id: snap.id,
        agent: snap.agent,
        displayName: snap.displayName,
        mode: snap.mode,
        status: snap.status === 'active' ? 'idle' : snap.status,
        cwd: snap.cwd,
        ...(snap.model !== undefined ? { model: snap.model } : {}),
        resumeToken: snap.resumeToken,
        ...(snap.parentSessionId !== undefined ? { parentSessionId: snap.parentSessionId } : {}),
        resumeCount: snap.resumeCount,
        createdAt: snap.createdAt,
        updatedAt: snap.updatedAt,
        messages: snap.messages.map((m) => ({ ...m })),
        ...(snap.reason !== undefined ? { reason: snap.reason } : {}),
      };
      this.sessions.set(session.id, session);
      restored += 1;
    }
    if (typeof snapshot.nextId === 'number' && snapshot.nextId > this.nextId) this.nextId = snapshot.nextId;
    return { restored, dropped };
  }
}
