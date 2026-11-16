/**
 * Protocols v2 — A2A signed Agent Card v2 (v1.16, Team T2).
 *
 * Idea only, learned from the public A2A v1.0 description in
 * docs/repo-survey-v116.md section 7: Agent Cards are signed,
 * versions are negotiated, and cards/tasks are multi-tenant.
 * No code, text or asset from any other repo is copied here.
 * This builds on the v1.15 signed cards (`protocols/a2aCard.ts`,
 * HMAC only, single tenant) without touching them: v2 adds a
 * real asymmetric signature (Ed25519, via node:crypto — the key
 * is generated and kept locally, never sent anywhere), keeps
 * HMAC as the cheap local option, and scopes cards and tasks to
 * tenants so one tenant's agent can never be mistaken for
 * another's.
 *
 * Signature model: the card is canonicalised (sorted keys,
 * stable JSON) and signed over `a2a-card-v2.<canonical-json>`.
 * Two algorithms:
 * - `hmac-sha256` — shared-secret, local-only (same trust model
 *   as v1.15). The key never leaves the host and never appears
 *   in a card.
 * - `ed25519` — public-key, verifiable by anyone holding the
 *   public key. The public key is embedded in the card
 *   (`publicKeyJwk`-style fields, base64url SPKI) so a remote
 *   peer can verify without a shared secret.
 * Verification checks, in order: structure, expiry, tenant
 * scope (when the verifier asks for one), signature, and the
 * card's declared protocol version against the negotiated one.
 *
 * Multi-tenancy: every card carries a `tenantId` (default
 * `default`). A tenant-scoped verifier only accepts cards whose
 * tenant matches; a task created from a card inherits the
 * card's tenant, and `assertSameTenant()` refuses to mix tenants
 * in one conversation. Tenant ids are opaque strings — no tenant
 * can enumerate another tenant's cards through this module.
 */

import * as crypto from 'node:crypto';

import {
  A2A_V2_CURRENT_VERSION,
  A2A_V2_UNSIGNED_VERSIONS,
  negotiateProtocolV2Version,
  type ProtocolV2Negotiation,
} from './versions';

/** Signature algorithms v2 supports. */
export const A2A_V2_SIGNATURE_ALGORITHMS = ['hmac-sha256', 'ed25519'] as const;
export type A2aV2SignatureAlgorithm = (typeof A2A_V2_SIGNATURE_ALGORITHMS)[number];

/** A2A bindings (all three are equivalent transports). */
export const A2A_V2_BINDINGS = ['jsonrpc', 'grpc', 'rest'] as const;
export type A2aV2Binding = (typeof A2A_V2_BINDINGS)[number];

/** Default tenant when a card does not name one. */
export const A2A_V2_DEFAULT_TENANT = 'default';

/** The unsigned card content. */
export interface A2aV2AgentCardInput {
  name: string;
  description: string;
  url: string;
  version: string;
  protocolVersions: string[];
  skills?: string[];
  capabilities?: Record<string, unknown>;
  /** Tenant that owns this agent (default `default`). */
  tenantId?: string;
  /** Unix ms after which the card must not be trusted. */
  expiresAtMs?: number;
}

/** A signed card: the card + its signature envelope. */
export interface SignedA2aV2AgentCard extends A2aV2AgentCardInput {
  tenantId: string;
  signature: {
    algorithm: A2aV2SignatureAlgorithm;
    /** base64url signature over the canonical payload. */
    value: string;
    /** base64url SPKI public key (ed25519 only). */
    publicKey?: string;
    /** Key id, so a verifier can pick the right key. */
    keyId: string;
    signedAtMs: number;
  };
}

/** Verification outcome. */
export interface A2aV2Verification {
  valid: boolean;
  reasons: string[];
  /** The card's tenant, when the card parsed. */
  tenantId?: string;
  /** The card's protocol versions, when the card parsed. */
  protocolVersions?: string[];
}

/** Error raised for card operations. */
export class A2aV2CardError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'A2aV2CardError';
    this.code = code;
  }
}

/** Canonical JSON: sorted keys, recursive, no whitespace. */
export function canonicaliseCardJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicaliseCardJson(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicaliseCardJson(v)}`).join(',')}}`;
}

const SIGNING_DOMAIN = 'a2a-card-v2';

function signingPayload(card: A2aV2AgentCardInput & { tenantId: string }): string {
  return `${SIGNING_DOMAIN}.${canonicaliseCardJson(card)}`;
}

/** A locally generated Ed25519 key pair (PEM strings). */
export interface A2aV2Ed25519KeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
  keyId: string;
}

/** Generate a fresh local Ed25519 key pair. The private key never leaves the host. */
export function generateA2aV2Ed25519KeyPair(): A2aV2Ed25519KeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const keyId = `ed25519-${crypto.createHash('sha256').update(publicKeyPem).digest('hex').slice(0, 12)}`;
  return { publicKeyPem, privateKeyPem, keyId };
}

/** Signing key material: either an HMAC secret or an Ed25519 pair. */
export type A2aV2SigningKey =
  | { algorithm: 'hmac-sha256'; secret: string; keyId: string }
  | { algorithm: 'ed25519'; keyPair: A2aV2Ed25519KeyPair };

/**
 * Sign a card. The signature covers the full card content
 * (including tenant + expiry), so tampering with any field —
 * including swapping the tenant — invalidates it.
 */
export function signA2aV2AgentCard(input: A2aV2AgentCardInput, key: A2aV2SigningKey): SignedA2aV2AgentCard {
  if (!input.name || !input.description || !input.url || !input.version) {
    throw new A2aV2CardError('INVALID_CARD', 'name, description, url and version are required');
  }
  if (!input.protocolVersions || input.protocolVersions.length === 0) {
    throw new A2aV2CardError('INVALID_CARD', 'protocolVersions must list at least one version');
  }
  const card: A2aV2AgentCardInput & { tenantId: string } = {
    ...input,
    tenantId: input.tenantId ?? A2A_V2_DEFAULT_TENANT,
  };
  const payload = signingPayload(card);
  if (key.algorithm === 'hmac-sha256') {
    if (key.secret.length < 16) throw new A2aV2CardError('WEAK_KEY', 'HMAC secret must be at least 16 characters');
    const value = crypto.createHmac('sha256', key.secret).update(payload).digest('base64url');
    return { ...card, signature: { algorithm: 'hmac-sha256', value, keyId: key.keyId, signedAtMs: Date.now() } };
  }
  const privateKey = crypto.createPrivateKey(key.keyPair.privateKeyPem);
  const value = crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64url');
  const publicKey = crypto.createPublicKey(key.keyPair.publicKeyPem);
  const publicKeySpki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  return {
    ...card,
    signature: { algorithm: 'ed25519', value, publicKey: publicKeySpki, keyId: key.keyPair.keyId, signedAtMs: Date.now() },
  };
}

/** Verification key material: the verifier's view of a signing key. */
export type A2aV2VerificationKey =
  | { algorithm: 'hmac-sha256'; secret: string; keyId?: string }
  | { algorithm: 'ed25519'; publicKeyPem?: string; publicKeySpkiBase64url?: string; keyId?: string };

/**
 * Verify a signed card.
 * - `key` must match the card's algorithm (and keyId, when given).
 * - `expectedTenantId`, when given, must equal the card's tenant.
 * - `nowMs` lets tests check expiry deterministically.
 * - `negotiatedVersion`, when given, must be one of the card's
 *   declared protocol versions.
 * Returns `{ valid, reasons }` — never throws for a bad card,
 * only for a structurally unusable verifier key.
 */
export function verifyA2aV2AgentCard(
  card: unknown,
  key: A2aV2VerificationKey,
  options: { expectedTenantId?: string; nowMs?: number; negotiatedVersion?: string } = {},
): A2aV2Verification {
  const reasons: string[] = [];
  if (typeof card !== 'object' || card === null || Array.isArray(card)) {
    return { valid: false, reasons: ['card must be an object'] };
  }
  const c = card as Record<string, unknown>;
  const signature = c.signature as Record<string, unknown> | undefined;
  if (typeof signature !== 'object' || signature === null) {
    return { valid: false, reasons: ['card.signature is required'] };
  }
  const tenantId = typeof c.tenantId === 'string' ? c.tenantId : undefined;
  const protocolVersions = Array.isArray(c.protocolVersions)
    ? (c.protocolVersions as unknown[]).filter((v): v is string => typeof v === 'string')
    : undefined;
  if (typeof c.name !== 'string' || c.name.length === 0) reasons.push('card.name is required');
  if (typeof c.url !== 'string' || c.url.length === 0) reasons.push('card.url is required');
  if (!protocolVersions || protocolVersions.length === 0) reasons.push('card.protocolVersions is required');
  if (tenantId === undefined) reasons.push('card.tenantId is required');
  const nowMs = options.nowMs ?? Date.now();
  if (typeof c.expiresAtMs === 'number' && c.expiresAtMs <= nowMs) reasons.push('card is expired');
  if (options.expectedTenantId !== undefined && tenantId !== undefined && tenantId !== options.expectedTenantId) {
    reasons.push(`card tenant "${tenantId}" does not match expected tenant "${options.expectedTenantId}"`);
  }
  if (options.negotiatedVersion !== undefined && protocolVersions !== undefined
    && !protocolVersions.includes(options.negotiatedVersion)) {
    reasons.push(`card does not declare negotiated version ${options.negotiatedVersion}`);
  }
  if (signature.algorithm !== key.algorithm) {
    reasons.push(`signature algorithm "${String(signature.algorithm)}" does not match verifier key "${key.algorithm}"`);
    return { valid: false, reasons, tenantId, protocolVersions };
  }
  if (key.keyId !== undefined && signature.keyId !== key.keyId) {
    reasons.push(`signature keyId "${String(signature.keyId)}" does not match expected "${key.keyId}"`);
    return { valid: false, reasons, tenantId, protocolVersions };
  }
  if (typeof signature.value !== 'string' || signature.value.length === 0) {
    reasons.push('signature.value is required');
    return { valid: false, reasons, tenantId, protocolVersions };
  }
  const { signature: _sig, ...unsigned } = c as SignedA2aV2AgentCard & Record<string, unknown>;
  const payload = signingPayload(unsigned as A2aV2AgentCardInput & { tenantId: string });
  let signatureOk = false;
  try {
    if (key.algorithm === 'hmac-sha256') {
      const expected = crypto.createHmac('sha256', key.secret).update(payload).digest();
      const actual = Buffer.from(signature.value, 'base64url');
      signatureOk = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    } else {
      let publicKey: crypto.KeyObject;
      if (key.publicKeyPem) publicKey = crypto.createPublicKey(key.publicKeyPem);
      else if (key.publicKeySpkiBase64url) {
        publicKey = crypto.createPublicKey({ key: Buffer.from(key.publicKeySpkiBase64url, 'base64url'), format: 'der', type: 'spki' });
      } else if (typeof signature.publicKey === 'string') {
        publicKey = crypto.createPublicKey({ key: Buffer.from(signature.publicKey, 'base64url'), format: 'der', type: 'spki' });
      } else {
        reasons.push('no public key available to verify the ed25519 signature');
        return { valid: false, reasons, tenantId, protocolVersions };
      }
      signatureOk = crypto.verify(null, Buffer.from(payload, 'utf8'), publicKey, Buffer.from(signature.value, 'base64url'));
    }
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) reasons.push('signature verification failed');
  return { valid: reasons.length === 0, reasons, tenantId, protocolVersions };
}

/**
 * Negotiate the A2A version for a card exchange: the highest
 * version both sides declare. Unsigned versions (< 1.0) can
 * only be agreed when the caller explicitly allows unsigned
 * cards — a signed card is never downgraded silently.
 */
export function negotiateA2aV2Version(
  clientVersions: readonly string[],
  serverVersions: readonly string[],
  options: { allowUnsigned?: boolean } = {},
): ProtocolV2Negotiation & { unsignedAgreed: boolean } {
  const negotiation = negotiateProtocolV2Version('a2a', clientVersions, serverVersions);
  const unsignedAgreed = negotiation.agreed !== null
    && (A2A_V2_UNSIGNED_VERSIONS as readonly string[]).includes(negotiation.agreed);
  if (unsignedAgreed && options.allowUnsigned !== true) {
    return {
      ...negotiation,
      agreed: null,
      isLatest: false,
      isLegacy: true,
      fallbackGuidance:
        `The only common A2A version is unsigned (${negotiation.agreed}). ` +
        `Upgrade both sides to A2A ${A2A_V2_CURRENT_VERSION} for signed cards, ` +
        `or pass allowUnsigned to accept unsigned cards explicitly.`,
      unsignedAgreed,
    };
  }
  return { ...negotiation, unsignedAgreed };
}

/** Describe one A2A binding (transport) for a card. */
export function describeA2aV2Binding(binding: A2aV2Binding): { binding: A2aV2Binding; transport: string; cardPath: string } {
  switch (binding) {
    case 'jsonrpc':
      return { binding, transport: 'JSON-RPC 2.0 over HTTP(S)', cardPath: '/.well-known/agent-card.json' };
    case 'grpc':
      return { binding, transport: 'gRPC (A2A service definition)', cardPath: '/.well-known/agent-card.json' };
    case 'rest':
      return { binding, transport: 'REST over HTTP(S)', cardPath: '/.well-known/agent-card.json' };
  }
}

/** A task created from a card — it inherits the card's tenant. */
export interface A2aV2TenantTask {
  taskId: string;
  tenantId: string;
  agentName: string;
  agentUrl: string;
  state: 'created' | 'running' | 'input_required' | 'completed' | 'failed' | 'cancelled';
  createdAtMs: number;
}

/** Create a tenant-scoped task from a verified card. */
export function createA2aV2TenantTask(card: SignedA2aV2AgentCard, taskId: string): A2aV2TenantTask {
  return {
    taskId,
    tenantId: card.tenantId,
    agentName: card.name,
    agentUrl: card.url,
    state: 'created',
    createdAtMs: Date.now(),
  };
}

/**
 * Refuse to mix tenants: throws when the two tenant ids differ.
 * Call before forwarding a message, a task or a card from one
 * tenant's context into another's.
 */
export function assertSameTenant(aTenantId: string, bTenantId: string, what: string): void {
  if (aTenantId !== bTenantId) {
    throw new A2aV2CardError(
      'TENANT_MISMATCH',
      `Cannot ${what} across tenants: "${aTenantId}" vs "${bTenantId}".`,
    );
  }
}

/**
 * Scope a list of cards to one tenant. Cards without an explicit
 * tenant belong to `default` and are only visible to that tenant.
 */
export function scopeCardsToTenant(
  cards: readonly SignedA2aV2AgentCard[],
  tenantId: string,
): SignedA2aV2AgentCard[] {
  return cards.filter((card) => (card.tenantId ?? A2A_V2_DEFAULT_TENANT) === tenantId);
}
