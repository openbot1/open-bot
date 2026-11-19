/**
 * Protocols v10 — A2A v1.0 minimal handshake (v1.41, Team T2).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v141.md (section 1): A2A v1.0 complements
 * MCP (agent-to-tool) with agent-to-agent coordination, and
 * since 08/2026 both live under the Agentic AI Foundation.
 * The v9 layer already implements the full 1.1 delegation
 * track (Agent Card discovery, capability-matched delegation,
 * message + artifact exchange, task lifecycle). v10 adds the
 * lighter track the survey describes for 1.0: a minimal
 * handshake — fetch the peer's Agent Card, negotiate the
 * highest common version, intersect capabilities, agree an
 * auth scheme — and then exchange one text message. No
 * delegation, no streaming, no task lifecycle here: that is
 * what v9 1.1 is for.
 *
 * The handshake is loopback-only, exactly like v9: any
 * non-loopback URL is refused before anything is sent, and
 * the fetcher is host-supplied (this module never opens a
 * network connection itself). Agent Cards are validated
 * structurally; a card whose version cannot be negotiated,
 * whose capabilities do not intersect, or whose auth scheme
 * the host does not accept never reaches the message step.
 *
 * No code, text or asset from any other repo is copied here.
 */

import {
  A2A_V10_CURRENT_VERSION,
  A2A_V10_HANDSHAKE_VERSION,
  A2A_V10_VERSIONS,
} from './versionsV10';

/** Error raised by the A2A v10 handshake layer. */
export class A2aV10HandshakeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'A2aV10HandshakeError';
    this.code = code;
  }
}

/** Loopback hosts the handshake may talk to. */
export const A2A_V10_LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'] as const;

/** True when the URL is loopback-only (http or https on a loopback host). */
export function isA2aV10LoopbackUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (A2A_V10_LOOPBACK_HOSTS as readonly string[]).includes(host);
}

/** Auth schemes the handshake can agree on. */
export const A2A_V10_AUTH_SCHEMES = ['none', 'bearer', 'api-key', 'mutual-tls'] as const;
export type A2aV10AuthScheme = (typeof A2A_V10_AUTH_SCHEMES)[number];

/** A minimal Agent Card (the fields the handshake reads). */
export interface A2aV10AgentCard {
  /** Agent name. */
  name: string;
  /** Agent description. */
  description?: string;
  /** Protocol versions the agent speaks. */
  protocolVersions: string[];
  /** Capability ids the agent offers. */
  capabilities: string[];
  /** Auth schemes the agent accepts. */
  authSchemes: A2aV10AuthScheme[];
  /** Endpoint the handshake talks to (loopback-only). */
  url: string;
  /** Card version (the card format itself). */
  version?: string;
}

/** Validate an Agent Card structurally. Returns problems. */
export function validateA2aV10AgentCard(card: unknown): string[] {
  const problems: string[] = [];
  if (typeof card !== 'object' || card === null || Array.isArray(card)) {
    problems.push('Agent Card must be an object.');
    return problems;
  }
  const c = card as Record<string, unknown>;
  if (typeof c.name !== 'string' || c.name.length === 0) {
    problems.push('Agent Card name must be a non-empty string.');
  }
  if (typeof c.description !== 'undefined' && typeof c.description !== 'string') {
    problems.push('Agent Card description must be a string.');
  }
  if (!Array.isArray(c.protocolVersions) || c.protocolVersions.length === 0 || c.protocolVersions.some((v) => typeof v !== 'string')) {
    problems.push('Agent Card protocolVersions must be a non-empty array of strings.');
  }
  if (!Array.isArray(c.capabilities) || c.capabilities.some((v) => typeof v !== 'string')) {
    problems.push('Agent Card capabilities must be an array of strings.');
  }
  if (!Array.isArray(c.authSchemes) || c.authSchemes.length === 0 || c.authSchemes.some((v) => !(A2A_V10_AUTH_SCHEMES as readonly string[]).includes(v as string))) {
    problems.push(`Agent Card authSchemes must be a non-empty array drawn from ${A2A_V10_AUTH_SCHEMES.join(', ')}.`);
  }
  if (typeof c.url !== 'string' || c.url.length === 0) {
    problems.push('Agent Card url must be a non-empty string.');
  } else if (!isA2aV10LoopbackUrl(c.url)) {
    problems.push(`Agent Card url "${c.url}" is not loopback-only; A2A in open-bot never leaves the machine.`);
  }
  if (c.version !== undefined && typeof c.version !== 'string') {
    problems.push('Agent Card version must be a string.');
  }
  return problems;
}

/** Build the well-known Agent Card URL for a base URL (loopback-only). */
export function buildA2aV10WellKnownUrl(baseUrl: string): string {
  if (!isA2aV10LoopbackUrl(baseUrl)) {
    throw new A2aV10HandshakeError('not-loopback', `A2A base URL "${baseUrl}" is not loopback-only; refusing to fetch an Agent Card from it.`);
  }
  const trimmed = baseUrl.replace(/\/+$/, '');
  return `${trimmed}/.well-known/agent-card.json`;
}

/** Negotiate the A2A version: newest common version wins; unknown versions never win. */
export function negotiateA2aV10Version(peerVersions: readonly string[]): {
  agreed: string | undefined;
  peerHasCurrent: boolean;
  peerOnly: string[];
} {
  const local: string[] = [...A2A_V10_VERSIONS];
  const peer = [...new Set(peerVersions.filter((v) => typeof v === 'string'))];
  return {
    agreed: local.find((v) => peer.includes(v)),
    peerHasCurrent: peer.includes(A2A_V10_CURRENT_VERSION),
    peerOnly: peer.filter((v) => !local.includes(v)),
  };
}

/** Intersect two capability lists (sorted, deterministic). */
export function intersectA2aV10Capabilities(
  local: readonly string[],
  peer: readonly string[],
): string[] {
  const peerSet = new Set(peer);
  return [...new Set(local.filter((c) => peerSet.has(c)))].sort();
}

/** Intersect two auth-scheme lists (local preference order wins). */
export function agreeA2aV10AuthScheme(
  local: readonly A2aV10AuthScheme[],
  peer: readonly A2aV10AuthScheme[],
): A2aV10AuthScheme | undefined {
  return local.find((s) => peer.includes(s));
}

/** The agreed handshake: version + capabilities + auth scheme. */
export interface A2aV10Handshake {
  /** Peer's Agent Card (as validated). */
  card: A2aV10AgentCard;
  /** Agreed protocol version. */
  version: string;
  /** Capabilities both sides offer. */
  capabilities: string[];
  /** Auth scheme both sides accept. */
  authScheme: A2aV10AuthScheme;
  /** Milliseconds since epoch when the handshake completed. */
  completedAt: number;
}

/** Options for performing a handshake. */
export interface A2aV10HandshakeOptions {
  /** Capabilities this agent offers. */
  localCapabilities: string[];
  /** Auth schemes this agent accepts (preference order). */
  localAuthSchemes: A2aV10AuthScheme[];
  /** Capabilities the handshake must include (empty = any intersection is fine). */
  requiredCapabilities?: string[];
  /** Fetcher the host supplies (loopback-only; never called with a non-loopback URL). */
  fetcher: (url: string) => Promise<unknown>;
}

/**
 * Perform the minimal 1.0 handshake: fetch the peer's Agent
 * Card from its well-known URL, validate it, negotiate the
 * version, intersect capabilities, agree an auth scheme.
 * Throws on any mismatch — a handshake that cannot agree on
 * all three never reaches the message step.
 */
export async function performA2aV10Handshake(
  baseUrl: string,
  options: A2aV10HandshakeOptions,
): Promise<A2aV10Handshake> {
  const cardUrl = buildA2aV10WellKnownUrl(baseUrl);
  let raw: unknown;
  try {
    raw = await options.fetcher(cardUrl);
  } catch (err) {
    throw new A2aV10HandshakeError(
      'fetch-failed',
      `Could not fetch the Agent Card from "${cardUrl}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const problems = validateA2aV10AgentCard(raw);
  if (problems.length > 0) {
    throw new A2aV10HandshakeError('invalid-card', `Agent Card from "${cardUrl}" is invalid: ${problems.join(' ')}`);
  }
  const card = raw as A2aV10AgentCard;
  const negotiated = negotiateA2aV10Version(card.protocolVersions);
  if (!negotiated.agreed) {
    throw new A2aV10HandshakeError(
      'no-common-version',
      `No common A2A version with "${card.name}" (peer offers ${card.protocolVersions.join(', ')}, open-bot speaks ${A2A_V10_VERSIONS.join(', ')}).`,
    );
  }
  const capabilities = intersectA2aV10Capabilities(options.localCapabilities, card.capabilities);
  const required = options.requiredCapabilities ?? [];
  const missing = required.filter((c) => !capabilities.includes(c));
  if (missing.length > 0) {
    throw new A2aV10HandshakeError(
      'missing-capability',
      `Peer "${card.name}" lacks required capabilities: ${missing.join(', ')} (shared: ${capabilities.join(', ') || 'none'}).`,
    );
  }
  const authScheme = agreeA2aV10AuthScheme(options.localAuthSchemes, card.authSchemes);
  if (!authScheme) {
    throw new A2aV10HandshakeError(
      'no-common-auth',
      `No common auth scheme with "${card.name}" (peer accepts ${card.authSchemes.join(', ')}, this agent accepts ${options.localAuthSchemes.join(', ')}).`,
    );
  }
  return {
    card,
    version: negotiated.agreed,
    capabilities,
    authScheme,
    completedAt: Date.now(),
  };
}

/** One text message exchanged after the handshake. */
export interface A2aV10Message {
  /** `message/text` in the minimal track. */
  kind: 'message/text';
  /** Message text. */
  text: string;
  /** Role (`user` = this agent, `agent` = the peer). */
  role: 'user' | 'agent';
  /** Milliseconds since epoch. */
  at: number;
}

/** Build a text message (validates length; empty text is refused). */
export function buildA2aV10Message(text: string, role: 'user' | 'agent' = 'user'): A2aV10Message {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new A2aV10HandshakeError('invalid-message', 'A2A message text must be a non-empty string.');
  }
  if (text.length > 64 * 1024) {
    throw new A2aV10HandshakeError('invalid-message', 'A2A message text exceeds 64 KiB.');
  }
  return { kind: 'message/text', text, role, at: Date.now() };
}

/**
 * A minimal handshake session: handshake once, then exchange
 * text messages over the host-supplied sender. The session
 * keeps the handshake and the message history only — no task
 * lifecycle, no delegation, no streaming (that is v9 1.1).
 */
export class A2aV10Session {
  private handshakeResult?: A2aV10Handshake;
  private readonly history: A2aV10Message[] = [];
  private readonly sender: (handshake: A2aV10Handshake, message: A2aV10Message) => Promise<A2aV10Message>;

  constructor(
    sender: (handshake: A2aV10Handshake, message: A2aV10Message) => Promise<A2aV10Message>,
  ) {
    if (typeof sender !== 'function') {
      throw new A2aV10HandshakeError('invalid-sender', 'A2aV10Session needs a sender function.');
    }
    this.sender = sender;
  }

  /** Whether the handshake has completed. */
  get isHandshaken(): boolean {
    return this.handshakeResult !== undefined;
  }

  /** The completed handshake (undefined until handshake() runs). */
  get handshake(): A2aV10Handshake | undefined {
    return this.handshakeResult;
  }

  /** Perform the handshake (replaces any earlier handshake). */
  async handshakeWith(baseUrl: string, options: A2aV10HandshakeOptions): Promise<A2aV10Handshake> {
    this.handshakeResult = await performA2aV10Handshake(baseUrl, options);
    return this.handshakeResult;
  }

  /** Send a text message to the peer (handshake required first). */
  async send(text: string): Promise<A2aV10Message> {
    if (!this.handshakeResult) {
      throw new A2aV10HandshakeError('not-handshaken', 'Send a message only after the handshake completes.');
    }
    const outgoing = buildA2aV10Message(text, 'user');
    this.history.push(outgoing);
    const reply = await this.sender(this.handshakeResult, outgoing);
    if (typeof reply !== 'object' || reply === null || reply.kind !== 'message/text' || typeof reply.text !== 'string') {
      throw new A2aV10HandshakeError('invalid-reply', 'Peer reply is not a valid A2A text message.');
    }
    this.history.push({ ...reply, role: 'agent', at: reply.at ?? Date.now() });
    return reply;
  }

  /** Message history (copy). */
  messages(): A2aV10Message[] {
    return this.history.map((m) => ({ ...m }));
  }

  /** Reset the session (drops the handshake and the history). */
  reset(): void {
    this.handshakeResult = undefined;
    this.history.length = 0;
  }
}

/** The handshake-track version constant (re-export for tool authors). */
export const A2A_V10_MINIMAL_HANDSHAKE_VERSION = A2A_V10_HANDSHAKE_VERSION;
