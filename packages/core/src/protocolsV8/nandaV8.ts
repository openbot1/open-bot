/**
 * Protocols v8 — NANDA-style discovery + self-signed identity,
 * local-first sketch (v1.39, Team T2).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v139.md (section 6): NANDA is built on MCP
 * + A2A + NLWeb and adds discovery, identity and routing for
 * an "Internet of Agents". The survey's direction for open-bot
 * is explicit: apply it LOCAL-FIRST — a sketch registry
 * discovery on this machine plus self-signed identity for
 * agents/bots, with NO dependency on a central service.
 *
 * This module is that sketch, written from the description:
 *
 *   - `McpV8NandaRegistry`: an in-memory registry of agents
 *     (name, endpoints, capabilities, identity fingerprint).
 *     Entries expire (TTL) unless re-announced; discovery is
 *     a local query (by capability, by name, by tenant) —
 *     nothing is fetched from the network.
 *   - `McpV8NandaIdentity`: an Ed25519 keypair owned by one
 *     agent/bot. The identity document is self-signed: the
 *     agent signs its own descriptor (name, endpoints,
 *     capabilities, fingerprint) and anyone can verify the
 *     signature with the public key — no certificate authority,
 *     no central registry. The identity id is
 *     `did:openbot:<fingerprint>` (a local DID-like id, not a
 *     registered DID method).
 *   - Trust is local pinning: `McpV8NandaTrustStore` pins
 *     fingerprints the user approved. A peer is trusted only
 *     when its fingerprint is pinned AND its signature
 *     verifies. Revocation is a local list.
 *   - Server Cards (the MCP extension) are the discovery
 *     document format: `buildMcpV8ServerCard` renders a
 *     registry entry as a card a client can read without a
 *     prior handshake.
 *
 * No code, text or asset from any other repo is copied here.
 * No network is opened: discovery is in-memory, keys are
 * generated locally with node:crypto.
 */

import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';

/** Error raised by the NANDA sketch layer. */
export class McpV8NandaError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'McpV8NandaError';
    this.code = code;
  }
}

/** NANDA sketch version (local-only). */
export const NANDA_V8_SKETCH_VERSION = '0.1-local' as const;
/** Default registry entry TTL (1 hour). */
export const NANDA_V8_DEFAULT_TTL_MS = 60 * 60 * 1000;
/** Max capabilities per registry entry. */
export const NANDA_V8_MAX_CAPABILITIES = 32;

/** Fingerprint of a public key (hex SHA-256 of the DER SPKI bytes). */
export function mcpV8NandaFingerprint(publicKeyDer: Buffer): string {
  return createHash('sha256').update(publicKeyDer).digest('hex');
}

/** Local DID-like identity id for a fingerprint. */
export function mcpV8NandaIdentityId(fingerprint: string): string {
  return `did:openbot:${fingerprint}`;
}

/** An agent's self-signed identity document. */
export interface McpV8NandaIdentityDocument {
  /** Identity id (`did:openbot:<fingerprint>`). */
  id: string;
  /** Agent name. */
  name: string;
  /** Agent description. */
  description: string;
  /** Endpoints the agent serves (http(s) URLs, loopback allowed). */
  endpoints: string[];
  /** Capabilities the agent advertises. */
  capabilities: string[];
  /** Public key (PEM, SPKI). */
  publicKeyPem: string;
  /** SHA-256 fingerprint of the public key. */
  fingerprint: string;
  /** When the identity was created (ms since epoch). */
  createdAtMs: number;
  /** When the identity expires (ms since epoch; undefined = no expiry). */
  expiresAtMs?: number;
  /** Signature over the canonical document (base64url, Ed25519). */
  signature: string;
}

/** Canonical bytes signed for an identity document (stable field order). */
export function mcpV8NandaCanonicalDocument(doc: Omit<McpV8NandaIdentityDocument, 'signature'>): string {
  return JSON.stringify({
    id: doc.id,
    name: doc.name,
    description: doc.description,
    endpoints: [...doc.endpoints].sort(),
    capabilities: [...doc.capabilities].sort(),
    publicKeyPem: doc.publicKeyPem,
    fingerprint: doc.fingerprint,
    createdAtMs: doc.createdAtMs,
    ...(doc.expiresAtMs !== undefined ? { expiresAtMs: doc.expiresAtMs } : {}),
  });
}

/**
 * An agent's identity: an Ed25519 keypair plus the
 * self-signed document. The private key NEVER leaves this
 * object (it is not serialised, not logged, not exported).
 */
export class McpV8NandaIdentity {
  private privateKeyPem: string;
  private publicKeyPem: string;
  private fingerprintValue: string;
  private nameValue: string;
  private descriptionValue: string;
  private endpointsValue: string[];
  private capabilitiesValue: string[];
  private createdAtMsValue: number;
  private expiresAtMsValue: number | undefined;

  private constructor(
    privateKeyPem: string,
    publicKeyPem: string,
    name: string,
    description: string,
    endpoints: string[],
    capabilities: string[],
    createdAtMs: number,
    expiresAtMs?: number,
  ) {
    this.privateKeyPem = privateKeyPem;
    this.publicKeyPem = publicKeyPem;
    this.nameValue = name;
    this.descriptionValue = description;
    this.endpointsValue = [...endpoints];
    this.capabilitiesValue = [...capabilities];
    this.createdAtMsValue = createdAtMs;
    this.expiresAtMsValue = expiresAtMs;
    const der = Buffer.from(
      publicKeyPem
        .replace(/-----BEGIN PUBLIC KEY-----/g, '')
        .replace(/-----END PUBLIC KEY-----/g, '')
        .replace(/\s+/g, ''),
      'base64',
    );
    this.fingerprintValue = mcpV8NandaFingerprint(der);
  }

  /** Create a fresh identity (new Ed25519 keypair). */
  static create(
    name: string,
    description: string,
    endpoints: string[],
    capabilities: string[],
    options: { nowMs?: () => number; expiresInMs?: number } = {},
  ): McpV8NandaIdentity {
    const problems = validateMcpV8NandaIdentityInput(name, description, endpoints, capabilities);
    if (problems.length > 0) {
      throw new McpV8NandaError('invalid-identity', `Invalid identity: ${problems.join('; ')}`);
    }
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const now = (options.nowMs ?? Date.now)();
    return new McpV8NandaIdentity(
      privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      name,
      description,
      endpoints,
      capabilities,
      now,
      options.expiresInMs === undefined ? undefined : now + options.expiresInMs,
    );
  }

  /** Identity id (`did:openbot:<fingerprint>`). */
  id(): string {
    return mcpV8NandaIdentityId(this.fingerprintValue);
  }

  /** SHA-256 fingerprint of the public key. */
  fingerprint(): string {
    return this.fingerprintValue;
  }

  /** Agent name. */
  name(): string {
    return this.nameValue;
  }

  /** Public key (PEM, SPKI) — safe to share. */
  publicKey(): string {
    return this.publicKeyPem;
  }

  /** The self-signed identity document (shareable, verifiable). */
  document(): McpV8NandaIdentityDocument {
    const unsigned: Omit<McpV8NandaIdentityDocument, 'signature'> = {
      id: this.id(),
      name: this.nameValue,
      description: this.descriptionValue,
      endpoints: [...this.endpointsValue],
      capabilities: [...this.capabilitiesValue],
      publicKeyPem: this.publicKeyPem,
      fingerprint: this.fingerprintValue,
      createdAtMs: this.createdAtMsValue,
      ...(this.expiresAtMsValue !== undefined ? { expiresAtMs: this.expiresAtMsValue } : {}),
    };
    const signature = sign(null, Buffer.from(mcpV8NandaCanonicalDocument(unsigned), 'utf-8'), this.privateKeyPem);
    return { ...unsigned, signature: signature.toString('base64url') };
  }

  /** Sign arbitrary bytes with this identity (Ed25519). */
  signBytes(bytes: Buffer): string {
    return sign(null, bytes, this.privateKeyPem).toString('base64url');
  }
}

/** Validate identity creation input. Returns problems (empty when valid). */
export function validateMcpV8NandaIdentityInput(
  name: unknown,
  description: unknown,
  endpoints: unknown,
  capabilities: unknown,
): string[] {
  const problems: string[] = [];
  if (typeof name !== 'string' || name.trim().length === 0) {
    problems.push('Identity needs a non-empty name.');
  } else if (name.length > 128) {
    problems.push('Identity name must be at most 128 characters.');
  }
  if (typeof description !== 'string' || description.trim().length === 0) {
    problems.push('Identity needs a non-empty description.');
  }
  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    problems.push('Identity needs at least one endpoint.');
  } else {
    for (const e of endpoints) {
      if (typeof e !== 'string' || e.length === 0) {
        problems.push('Endpoints must be non-empty strings.');
        continue;
      }
      let parsed: URL;
      try {
        parsed = new URL(e);
      } catch {
        problems.push(`Endpoint "${e}" is not a valid absolute URL.`);
        continue;
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        problems.push(`Endpoint "${e}" must use http(s).`);
      }
    }
  }
  if (!Array.isArray(capabilities)) {
    problems.push('Capabilities must be an array of strings.');
  } else {
    if (capabilities.length > NANDA_V8_MAX_CAPABILITIES) {
      problems.push(`Capabilities exceed ${NANDA_V8_MAX_CAPABILITIES} entries.`);
    }
    for (const c of capabilities) {
      if (typeof c !== 'string' || c.length === 0) problems.push('Capabilities must be non-empty strings.');
    }
  }
  return problems;
}

/**
 * Verify a self-signed identity document: the fingerprint
 * must match the public key, the id must match the
 * fingerprint, and the Ed25519 signature must verify over
 * the canonical document. Returns problems (empty = valid).
 */
export function verifyMcpV8NandaDocument(
  doc: McpV8NandaIdentityDocument,
  nowMs: number = Date.now(),
): string[] {
  const problems: string[] = [];
  if (typeof doc.id !== 'string' || !doc.id.startsWith('did:openbot:')) {
    problems.push(`Identity id "${doc.id}" must start with "did:openbot:".`);
  }
  if (typeof doc.publicKeyPem !== 'string' || !doc.publicKeyPem.includes('BEGIN PUBLIC KEY')) {
    problems.push('Identity document needs a PEM SPKI public key.');
    return problems;
  }
  let der: Buffer;
  try {
    der = Buffer.from(
      doc.publicKeyPem
        .replace(/-----BEGIN PUBLIC KEY-----/g, '')
        .replace(/-----END PUBLIC KEY-----/g, '')
        .replace(/\s+/g, ''),
      'base64',
    );
  } catch {
    problems.push('Public key PEM is not valid base64.');
    return problems;
  }
  const fingerprint = mcpV8NandaFingerprint(der);
  if (doc.fingerprint !== fingerprint) {
    problems.push('Fingerprint does not match the public key.');
  }
  if (doc.id !== mcpV8NandaIdentityId(fingerprint)) {
    problems.push('Identity id does not match the fingerprint.');
  }
  if (doc.expiresAtMs !== undefined && nowMs >= doc.expiresAtMs) {
    problems.push('Identity document is expired.');
  }
  const { signature, ...unsigned } = doc;
  if (typeof signature !== 'string' || signature.length === 0) {
    problems.push('Identity document needs a signature.');
    return problems;
  }
  let ok = false;
  try {
    ok = verify(
      null,
      Buffer.from(mcpV8NandaCanonicalDocument(unsigned as Omit<McpV8NandaIdentityDocument, 'signature'>), 'utf-8'),
      doc.publicKeyPem,
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    ok = false;
  }
  if (!ok) problems.push('Signature does not verify over the identity document (tampered or wrong key).');
  return problems;
}

/** True when the document verifies (no problems). */
export function mcpV8NandaDocumentIsValid(
  doc: McpV8NandaIdentityDocument,
  nowMs: number = Date.now(),
): boolean {
  return verifyMcpV8NandaDocument(doc, nowMs).length === 0;
}

/** A registry entry: an agent announced on this machine. */
export interface McpV8NandaEntry {
  /** Identity id (`did:openbot:<fingerprint>`). */
  id: string;
  /** Agent name. */
  name: string;
  /** Agent description. */
  description: string;
  /** Endpoints the agent serves. */
  endpoints: string[];
  /** Capabilities the agent advertises. */
  capabilities: string[];
  /** Tenant the agent belongs to. */
  tenant: string;
  /** SHA-256 fingerprint of the agent's public key. */
  fingerprint: string;
  /** When the entry was announced (ms since epoch). */
  announcedAtMs: number;
  /** When the entry expires (ms since epoch). */
  expiresAtMs: number;
  /** The verified identity document (when announced with one). */
  document?: McpV8NandaIdentityDocument;
}

/** Registry options. */
export interface McpV8NandaRegistryOptions {
  /** Clock override (ms since epoch). */
  nowMs?: () => number;
  /** Default entry TTL (default 1 hour). */
  defaultTtlMs?: number;
  /** Max entries (default 512; oldest expired evicted first). */
  maxEntries?: number;
}

/**
 * NANDA-style registry, local-first: agents announce
 * themselves on this machine; discovery is a local query.
 * Entries expire unless re-announced. Nothing is fetched
 * from any network or central service.
 */
export class McpV8NandaRegistry {
  private entries = new Map<string, McpV8NandaEntry>();
  private nowMs: () => number;
  private defaultTtlMs: number;
  private maxEntries: number;

  constructor(options: McpV8NandaRegistryOptions = {}) {
    this.nowMs = options.nowMs ?? Date.now;
    this.defaultTtlMs = options.defaultTtlMs ?? NANDA_V8_DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? 512;
  }

  /** Number of live (unexpired) entries. */
  size(): number {
    this.sweepExpired();
    return this.entries.size;
  }

  /** Announce (or re-announce) an agent. Returns the stored entry. */
  announce(
    input: {
      id: string;
      name: string;
      description: string;
      endpoints: string[];
      capabilities: string[];
      tenant?: string;
      fingerprint: string;
      document?: McpV8NandaIdentityDocument;
    },
    ttlMs?: number,
  ): McpV8NandaEntry {
    const problems = validateMcpV8NandaIdentityInput(input.name, input.description, input.endpoints, input.capabilities);
    if (problems.length > 0) {
      throw new McpV8NandaError('invalid-entry', `Invalid registry entry: ${problems.join('; ')}`);
    }
    if (typeof input.id !== 'string' || !input.id.startsWith('did:openbot:')) {
      throw new McpV8NandaError('invalid-entry', `Registry entry id "${input.id}" must start with "did:openbot:".`);
    }
    if (input.document !== undefined) {
      const docProblems = verifyMcpV8NandaDocument(input.document, this.nowMs());
      if (docProblems.length > 0) {
        throw new McpV8NandaError('invalid-document', `Identity document does not verify: ${docProblems.join('; ')}`);
      }
      if (input.document.id !== input.id || input.document.fingerprint !== input.fingerprint) {
        throw new McpV8NandaError('invalid-document', 'Identity document id / fingerprint do not match the registry entry.');
      }
    }
    const now = this.nowMs();
    const entry: McpV8NandaEntry = {
      id: input.id,
      name: input.name,
      description: input.description,
      endpoints: [...input.endpoints],
      capabilities: [...input.capabilities],
      tenant: input.tenant ?? 'default',
      fingerprint: input.fingerprint,
      announcedAtMs: now,
      expiresAtMs: now + (ttlMs ?? this.defaultTtlMs),
      ...(input.document !== undefined ? { document: input.document } : {}),
    };
    this.entries.set(entry.id, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = [...this.entries.values()].sort((a, b) => a.announcedAtMs - b.announcedAtMs)[0];
      if (oldest === undefined) break;
      this.entries.delete(oldest.id);
    }
    return { ...entry, endpoints: [...entry.endpoints], capabilities: [...entry.capabilities] };
  }

  /** Announce directly from a verified identity document. */
  announceDocument(doc: McpV8NandaIdentityDocument, tenant = 'default', ttlMs?: number): McpV8NandaEntry {
    return this.announce(
      {
        id: doc.id,
        name: doc.name,
        description: doc.description,
        endpoints: doc.endpoints,
        capabilities: doc.capabilities,
        tenant,
        fingerprint: doc.fingerprint,
        document: doc,
      },
      ttlMs,
    );
  }

  /** Get one entry (undefined when missing or expired). */
  get(id: string): McpV8NandaEntry | undefined {
    const found = this.entries.get(id);
    if (found === undefined) return undefined;
    if (this.nowMs() >= found.expiresAtMs) {
      this.entries.delete(id);
      return undefined;
    }
    return { ...found, endpoints: [...found.endpoints], capabilities: [...found.capabilities] };
  }

  /** Remove one entry (false when missing). */
  remove(id: string): boolean {
    return this.entries.delete(id);
  }

  /** All live entries (sorted by name). */
  all(): McpV8NandaEntry[] {
    this.sweepExpired();
    return [...this.entries.values()]
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((e) => ({ ...e, endpoints: [...e.endpoints], capabilities: [...e.capabilities] }));
  }

  /** Discover agents by capability (all of the listed capabilities). */
  discoverByCapability(capabilities: readonly string[], tenant?: string): McpV8NandaEntry[] {
    return this.all().filter(
      (e) =>
        (tenant === undefined || e.tenant === tenant)
        && capabilities.every((c) => e.capabilities.includes(c)),
    );
  }

  /** Discover agents by name substring (case-insensitive). */
  discoverByName(query: string, tenant?: string): McpV8NandaEntry[] {
    const q = query.toLowerCase();
    return this.all().filter(
      (e) => (tenant === undefined || e.tenant === tenant) && e.name.toLowerCase().includes(q),
    );
  }

  /** Discover agents of one tenant. */
  discoverByTenant(tenant: string): McpV8NandaEntry[] {
    return this.all().filter((e) => e.tenant === tenant);
  }

  /** Remove expired entries. Returns the removed ids. */
  sweepExpired(): string[] {
    const now = this.nowMs();
    const removed: string[] = [];
    for (const [id, entry] of [...this.entries.entries()]) {
      if (now >= entry.expiresAtMs) {
        this.entries.delete(id);
        removed.push(id);
      }
    }
    return removed.sort();
  }
}

/** Trust store options. */
export interface McpV8NandaTrustStoreOptions {
  /** Clock override (ms since epoch). */
  nowMs?: () => number;
}

/**
 * Local trust store: fingerprints the user pinned, plus a
 * revocation list. A peer is trusted only when its
 * fingerprint is pinned, its document verifies, and it is
 * not revoked. No central authority is consulted.
 */
export class McpV8NandaTrustStore {
  private pinned = new Map<string, { note: string; pinnedAtMs: number }>();
  private revoked = new Map<string, { reason: string; revokedAtMs: number }>();
  private nowMs: () => number;

  constructor(options: McpV8NandaTrustStoreOptions = {}) {
    this.nowMs = options.nowMs ?? Date.now;
  }

  /** Pin a fingerprint (the user approved this agent). */
  pin(fingerprint: string, note = ''): void {
    if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
      throw new McpV8NandaError('invalid-fingerprint', 'Fingerprint must be a non-empty string.');
    }
    this.pinned.set(fingerprint, { note, pinnedAtMs: this.nowMs() });
  }

  /** Unpin a fingerprint (false when not pinned). */
  unpin(fingerprint: string): boolean {
    return this.pinned.delete(fingerprint);
  }

  /** True when the fingerprint is pinned. */
  isPinned(fingerprint: string): boolean {
    return this.pinned.has(fingerprint);
  }

  /** Pinned fingerprints (sorted). */
  pinnedFingerprints(): string[] {
    return [...this.pinned.keys()].sort();
  }

  /** Revoke a fingerprint (it stays revoked until unrevoked). */
  revoke(fingerprint: string, reason = ''): void {
    if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
      throw new McpV8NandaError('invalid-fingerprint', 'Fingerprint must be a non-empty string.');
    }
    this.revoked.set(fingerprint, { reason, revokedAtMs: this.nowMs() });
  }

  /** Unrevoke a fingerprint (false when not revoked). */
  unrevoke(fingerprint: string): boolean {
    return this.revoked.delete(fingerprint);
  }

  /** True when the fingerprint is revoked. */
  isRevoked(fingerprint: string): boolean {
    return this.revoked.has(fingerprint);
  }

  /** Revoked fingerprints (sorted). */
  revokedFingerprints(): string[] {
    return [...this.revoked.keys()].sort();
  }

  /**
   * Trust check for a document: pinned AND verifies AND not
   * revoked. Returns problems (empty = trusted).
   */
  checkDocument(doc: McpV8NandaIdentityDocument, nowMs?: number): string[] {
    const problems: string[] = [];
    const now = nowMs ?? this.nowMs();
    if (this.isRevoked(doc.fingerprint)) {
      problems.push(`Fingerprint ${doc.fingerprint} is revoked locally.`);
    }
    if (!this.isPinned(doc.fingerprint)) {
      problems.push(`Fingerprint ${doc.fingerprint} is not pinned locally (trust requires an explicit local pin).`);
    }
    problems.push(...verifyMcpV8NandaDocument(doc, now));
    return problems;
  }

  /** True when the document is trusted (pinned + verifies + not revoked). */
  isTrusted(doc: McpV8NandaIdentityDocument, nowMs?: number): boolean {
    return this.checkDocument(doc, nowMs).length === 0;
  }
}

/** A Server Card (MCP extension): the discovery document for one server/agent. */
export interface McpV8ServerCard {
  /** Card format version. */
  cardVersion: string;
  /** Server / agent name. */
  name: string;
  /** Description. */
  description: string;
  /** Endpoints the server serves. */
  endpoints: string[];
  /** Capabilities advertised. */
  capabilities: string[];
  /** MCP protocol version spoken. */
  protocolVersion: string;
  /** Extensions the server implements. */
  extensions: string[];
  /** Identity id when the server has a self-signed identity. */
  identityId?: string;
  /** Fingerprint when the server has a self-signed identity. */
  fingerprint?: string;
}

/** Build a Server Card from a registry entry. */
export function buildMcpV8ServerCard(
  entry: McpV8NandaEntry,
  options: { protocolVersion?: string; extensions?: string[] } = {},
): McpV8ServerCard {
  const card: McpV8ServerCard = {
    cardVersion: '1.0',
    name: entry.name,
    description: entry.description,
    endpoints: [...entry.endpoints],
    capabilities: [...entry.capabilities],
    protocolVersion: options.protocolVersion ?? '2026-07-28',
    extensions: [...(options.extensions ?? [])],
  };
  if (entry.document !== undefined) {
    card.identityId = entry.id;
    card.fingerprint = entry.fingerprint;
  }
  return card;
}

/** Validate a Server Card structurally. Returns problems (empty when valid). */
export function validateMcpV8ServerCard(card: McpV8ServerCard): string[] {
  const problems: string[] = [];
  if (card.cardVersion !== '1.0') {
    problems.push(`Server Card cardVersion must be "1.0" (got "${card.cardVersion}").`);
  }
  if (typeof card.name !== 'string' || card.name.trim().length === 0) {
    problems.push('Server Card needs a non-empty name.');
  }
  if (!Array.isArray(card.endpoints) || card.endpoints.length === 0) {
    problems.push('Server Card needs at least one endpoint.');
  }
  if (!Array.isArray(card.capabilities)) {
    problems.push('Server Card capabilities must be an array.');
  }
  if (typeof card.protocolVersion !== 'string' || card.protocolVersion.length === 0) {
    problems.push('Server Card needs a protocolVersion.');
  }
  return problems;
}
