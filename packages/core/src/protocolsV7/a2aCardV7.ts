/**
 * Protocols v7 — A2A v1.0.1 Agent Card: issue, sign (JWS), verify,
 * rotate, revoke, multi-tenant registry (v1.38, Team T2).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v138.md: A2A v1.0.1 signs the Agent Card with
 * JWS (since v0.3) so a client can verify an agent's identity, and
 * adds multi-tenancy. This module is the complete v7 card layer:
 *
 *   - `buildA2aV7AgentCard` — validate + build a card (required
 *     fields, URL rules, capability/skill shape, tenant scoping).
 *   - `signA2aV7AgentCard` / `verifyA2aV7AgentCard` — JWS compact
 *     serialization (RFC 7515) with Ed25519 (Node stdlib): header
 *     `{ alg: "EdDSA", typ: "agent-card+jwt", kid }`, payload is
 *     the whole card plus `iat` / `exp`, signature over
 *     `header.payload`. Payload is canonicalised (sorted keys)
 *     before base64url so both sides compute the same bytes.
 *   - `A2aV7CardIssuer` — key lifecycle: generate, issue, rotate
 *     (old key stays verifiable until its cards expire), revoke.
 *   - `A2aV7CardRegistry` — multi-tenant card store: register /
 *     lookup / list per tenant, card revocation, expiry pruning.
 *   - `A2aV7TrustStore` — trust decisions: pinned key ids,
 *     per-tenant allowlist, trust-on-first-use (TOFU) pinning.
 *
 * No code, text or asset from any other repo is copied here.
 * This layer is self-contained (Node stdlib only) and does not
 * touch the older `a2a/` card layers: it is the v7 complete
 * surface on top of them.
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  createHash,
  type KeyObject,
} from 'node:crypto';
import {
  A2A_V7_AGENT_CARD_JWS_MEDIA_TYPE,
  A2A_V7_AGENT_CARD_MEDIA_TYPE,
  A2A_V7_CURRENT_VERSION,
  A2A_V7_DEFAULT_TENANT,
  A2A_V7_WELL_KNOWN_CARD_JWS_PATH,
  A2A_V7_WELL_KNOWN_CARD_PATH,
} from './versions';

/** Default card lifetime: 24h (same convention as the v1.07 JWS layer). */
export const A2A_V7_CARD_JWS_TTL_SECONDS = 24 * 60 * 60;
/** Maximum card lifetime the issuer will sign (7 days). */
export const A2A_V7_CARD_JWS_MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Maximum tenant id length (matches the v1.07 tenancy layer). */
export const A2A_V7_MAX_TENANT_ID_LENGTH = 64;
/** Maximum skills / capabilities on one card (keeps cards small). */
export const A2A_V7_CARD_MAX_SKILLS = 64;
export const A2A_V7_CARD_MAX_CAPABILITIES = 64;

/** Error raised by the v7 card layer. */
export class A2aV7CardError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'A2aV7CardError';
    this.code = code;
  }
}

/** One skill advertised on an Agent Card. */
export interface A2aV7AgentSkill {
  /** Stable skill id (lowercase, dashes). */
  id: string;
  /** Human-readable skill name. */
  name: string;
  /** What the skill does (one line). */
  description: string;
  /** Example prompts / inputs for the skill. */
  examples?: string[];
  /** Input / output schema hints (free-form, JSON-able). */
  inputModes?: string[];
  outputModes?: string[];
}

/** Authentication schemes an agent accepts. */
export type A2aV7AuthScheme = 'none' | 'bearer' | 'api-key' | 'oauth2' | 'mutual-tls';

/** An A2A v1.0.1 Agent Card (v7 shape). */
export interface A2aV7AgentCard {
  /** Agent name (human-readable). */
  name: string;
  /** One-line description. */
  description: string;
  /** Agent version (semver-ish). */
  version: string;
  /** Base URL of the agent (https, or http on loopback). */
  url: string;
  /** A2A protocol versions the agent speaks (newest first). */
  protocolVersions: string[];
  /** Capability tags, e.g. `coding`, `research`. */
  capabilities: string[];
  /** Skills the agent offers. */
  skills: A2aV7AgentSkill[];
  /** Default input / output modes. */
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  /** Authentication schemes accepted (empty = none required). */
  authSchemes: A2aV7AuthScheme[];
  /** Tenant this card belongs to (multi-tenancy). */
  tenant: string;
  /** Provider / organisation that runs the agent. */
  provider?: string;
  /** Extra, JSON-able metadata (never credentials). */
  metadata?: Record<string, unknown>;
}

/** Input for building a card (tenant + protocol versions default when omitted). */
export type A2aV7AgentCardInput = Omit<A2aV7AgentCard, 'tenant' | 'protocolVersions'> & {
  tenant?: string;
  protocolVersions?: string[];
};

/** JWS header for a signed Agent Card. */
export interface A2aV7CardJwsHeader {
  alg: 'EdDSA';
  typ: 'agent-card+jwt';
  /** Fingerprint SHA-256 hex of the signing public key (SPKI DER). */
  kid: string;
}

/** JWS payload: the whole card + time claims. */
export type A2aV7CardJwsPayload = Record<string, unknown> & {
  iat: number;
  exp: number;
};

/** Result of verifying a JWS Agent Card. */
export interface A2aV7CardVerification {
  ok: boolean;
  /** The Agent Card from the payload (undefined when verification failed). */
  card?: A2aV7AgentCard;
  /** Fingerprint of the key that signed (kid in the header). */
  keyId: string | null;
  /** True when the token is expired (exp has passed). */
  expired: boolean;
  /** Tenant the card belongs to (undefined when verification failed). */
  tenant?: string;
  /** Reason when ok=false. */
  reason?: string;
}

/** A signing key held by the issuer. */
export interface A2aV7CardKey {
  /** Fingerprint SHA-256 hex of the public key (SPKI DER). */
  keyId: string;
  /** Public key (SPKI PEM). Safe to share. */
  publicKeyPem: string;
  /** Private key (PKCS8 PEM). NEVER leaves the issuer. */
  privateKeyPem: string;
  /** Creation time (ms since epoch). */
  createdAtMs: number;
  /** Rotation time (ms since epoch), when this key stopped issuing. */
  rotatedAtMs: number | null;
  /** Key status. */
  status: 'active' | 'rotated' | 'revoked';
}

/** A registered card (card + its signed token + bookkeeping). */
export interface A2aV7RegisteredCard {
  card: A2aV7AgentCard;
  /** JWS compact token for the card. */
  jws: string;
  /** Fingerprint of the signing key. */
  keyId: string;
  /** Registration time (ms since epoch). */
  registeredAtMs: number;
  /** Expiry (ms since epoch, from the JWS exp claim). */
  expiresAtMs: number;
  /** True when this card was revoked (revocation beats expiry). */
  revoked: boolean;
  /** Revocation reason (when revoked). */
  revokeReason?: string;
}

/** base64url-encode bytes (no padding). */
export function base64UrlEncodeV7(data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** base64url-decode to a Buffer, or null when malformed. */
export function base64UrlDecodeV7(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    const pad = (4 - (padded.length % 4)) % 4;
    return Buffer.from(padded + '='.repeat(pad), 'base64');
  } catch {
    return null;
  }
}

/**
 * Canonical JSON (RFC 8785 style, subset): objects have sorted
 * keys, arrays keep order, no whitespace. Used so signer and
 * verifier compute the same bytes for the same card.
 */
export function canonicalizeJsonV7(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalizeJsonV7(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJsonV7(obj[k])}`);
  return `{${parts.join(',')}}`;
}

/** Fingerprint (SHA-256 hex) of a public key (SPKI DER). */
export function fingerprintPublicKeyV7(publicKey: KeyObject | string): string {
  const key = typeof publicKey === 'string'
    ? createPublicKey(publicKey)
    : publicKey;
  const der = key.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

/** True when the tenant id is usable (same rules as the v1.07 tenancy layer). */
export function isValidA2aV7TenantId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > A2A_V7_MAX_TENANT_ID_LENGTH) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

/** Normalise a tenant id (empty / invalid falls back to `default`). */
export function normalizeA2aV7TenantId(
  value: unknown,
  defaultTenant: string = A2A_V7_DEFAULT_TENANT,
): string {
  if (isValidA2aV7TenantId(value)) return value;
  return defaultTenant;
}

/** True when the URL may serve an agent (https, or http on loopback). */
export function isValidA2aV7AgentUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol === 'http:') {
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
  }
  return false;
}

/** Validate one skill (throws A2aV7CardError on the first problem). */
export function validateA2aV7AgentSkill(skill: unknown, index: number): asserts skill is A2aV7AgentSkill {
  if (typeof skill !== 'object' || skill === null || Array.isArray(skill)) {
    throw new A2aV7CardError('invalid-skill', `Skill #${index} must be an object.`);
  }
  const s = skill as Record<string, unknown>;
  if (typeof s.id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(s.id)) {
    throw new A2aV7CardError('invalid-skill', `Skill #${index} needs an id (lowercase letters, digits, dashes).`);
  }
  if (typeof s.name !== 'string' || s.name.trim().length === 0) {
    throw new A2aV7CardError('invalid-skill', `Skill #${index} (${s.id}) needs a non-empty name.`);
  }
  if (typeof s.description !== 'string' || s.description.trim().length === 0) {
    throw new A2aV7CardError('invalid-skill', `Skill #${index} (${s.id}) needs a non-empty description.`);
  }
  if (s.examples !== undefined && s.examples !== null && (!Array.isArray(s.examples) || s.examples.some((e) => typeof e !== 'string'))) {
    throw new A2aV7CardError('invalid-skill', `Skill #${index} (${s.id}) examples must be an array of strings.`);
  }
}

/** Validate a card's shape (throws A2aV7CardError on the first problem). */
export function validateA2aV7AgentCard(card: unknown): asserts card is A2aV7AgentCard {
  if (typeof card !== 'object' || card === null || Array.isArray(card)) {
    throw new A2aV7CardError('invalid-card', 'Agent Card must be an object.');
  }
  const c = card as Record<string, unknown>;
  if (typeof c.name !== 'string' || c.name.trim().length === 0) {
    throw new A2aV7CardError('invalid-card', 'Agent Card needs a non-empty name.');
  }
  if (typeof c.description !== 'string' || c.description.trim().length === 0) {
    throw new A2aV7CardError('invalid-card', 'Agent Card needs a non-empty description.');
  }
  if (typeof c.version !== 'string' || c.version.trim().length === 0) {
    throw new A2aV7CardError('invalid-card', 'Agent Card needs a non-empty version.');
  }
  if (!isValidA2aV7AgentUrl(c.url)) {
    throw new A2aV7CardError('invalid-card', 'Agent Card url must be https, or http on loopback (localhost / 127.0.0.1).');
  }
  if (!Array.isArray(c.protocolVersions) || c.protocolVersions.length === 0
    || c.protocolVersions.some((v) => typeof v !== 'string' || v.trim().length === 0)) {
    throw new A2aV7CardError('invalid-card', 'Agent Card needs at least one protocol version.');
  }
  if (!Array.isArray(c.capabilities) || c.capabilities.length === 0
    || c.capabilities.length > A2A_V7_CARD_MAX_CAPABILITIES
    || c.capabilities.some((v) => typeof v !== 'string' || v.trim().length === 0)) {
    throw new A2aV7CardError('invalid-card', `Agent Card needs 1–${A2A_V7_CARD_MAX_CAPABILITIES} non-empty capabilities.`);
  }
  if (!Array.isArray(c.skills) || c.skills.length > A2A_V7_CARD_MAX_SKILLS) {
    throw new A2aV7CardError('invalid-card', `Agent Card skills must be an array of at most ${A2A_V7_CARD_MAX_SKILLS}.`);
  }
  c.skills.forEach((skill, i) => validateA2aV7AgentSkill(skill, i));
  const skillIds = new Set((c.skills as A2aV7AgentSkill[]).map((s) => s.id));
  if (skillIds.size !== (c.skills as unknown[]).length) {
    throw new A2aV7CardError('invalid-card', 'Agent Card skill ids must be unique.');
  }
  if (!Array.isArray(c.authSchemes)
    || c.authSchemes.some((v) => !['none', 'bearer', 'api-key', 'oauth2', 'mutual-tls'].includes(v as string))) {
    throw new A2aV7CardError('invalid-card', 'Agent Card authSchemes must be one of: none, bearer, api-key, oauth2, mutual-tls.');
  }
  if (!isValidA2aV7TenantId(c.tenant)) {
    throw new A2aV7CardError('invalid-card', `Agent Card tenant must be a valid tenant id (1–${A2A_V7_MAX_TENANT_ID_LENGTH} chars, letters/digits/./_/-).`);
  }
  // `null` counts as absent here: a peer card may have been through
  // a JSON round-trip, where an absent optional comes back as null.
  if (c.provider !== undefined && c.provider !== null && (typeof c.provider !== 'string' || c.provider.trim().length === 0)) {
    throw new A2aV7CardError('invalid-card', 'Agent Card provider, when given, must be a non-empty string.');
  }
}

/**
 * Build a validated card from input. Tenant defaults to `default`;
 * protocol versions default to the v7 current track. Throws
 * A2aV7CardError on invalid input. The returned card is a copy —
 * the input is never mutated.
 */
export function buildA2aV7AgentCard(input: A2aV7AgentCardInput): A2aV7AgentCard {
  // Omit undefined optionals (rather than setting them): a signed
  // card is JSON-serialised, and `undefined` would come back as
  // `null` — the card must validate identically before and after.
  const card: A2aV7AgentCard = {
    name: input.name,
    description: input.description,
    version: input.version,
    url: input.url,
    protocolVersions: input.protocolVersions ?? [A2A_V7_CURRENT_VERSION, '1.1'],
    capabilities: [...input.capabilities],
    skills: input.skills.map((s) => {
      const skill: A2aV7AgentSkill = { id: s.id, name: s.name, description: s.description };
      if (s.examples) skill.examples = [...s.examples];
      if (s.inputModes) skill.inputModes = [...s.inputModes];
      if (s.outputModes) skill.outputModes = [...s.outputModes];
      return skill;
    }),
    authSchemes: [...input.authSchemes],
    tenant: normalizeA2aV7TenantId(input.tenant),
  };
  if (input.defaultInputModes) card.defaultInputModes = [...input.defaultInputModes];
  if (input.defaultOutputModes) card.defaultOutputModes = [...input.defaultOutputModes];
  if (input.provider !== undefined) card.provider = input.provider;
  if (input.metadata) card.metadata = { ...input.metadata };
  validateA2aV7AgentCard(card);
  return card;
}

/** Options for signing a card. */
export interface A2aV7SignOptions {
  /** Card lifetime in seconds (default 24h, max 7 days). */
  ttlSeconds?: number;
  /** Issued-at override (seconds since epoch; default now). */
  issuedAtSeconds?: number;
  /** Key id override (default: fingerprint of the signing key). */
  keyId?: string;
}

/**
 * Sign an Agent Card into a JWS compact token:
 * `BASE64URL(header).BASE64URL(payload).BASE64URL(signature)`.
 * The payload is the whole card plus `iat` / `exp`. Throws
 * A2aV7CardError when the card is invalid or the key is unusable.
 */
export function signA2aV7AgentCard(
  card: A2aV7AgentCard,
  privateKeyPem: string,
  options: A2aV7SignOptions = {},
): string {
  validateA2aV7AgentCard(card);
  const ttl = options.ttlSeconds ?? A2A_V7_CARD_JWS_TTL_SECONDS;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > A2A_V7_CARD_JWS_MAX_TTL_SECONDS) {
    throw new A2aV7CardError('invalid-ttl', `Card TTL must be 1–${A2A_V7_CARD_JWS_MAX_TTL_SECONDS} seconds.`);
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } catch {
    throw new A2aV7CardError('bad-key', 'Signing key is not a valid private key (PKCS8 PEM expected).');
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new A2aV7CardError('bad-key', 'Signing key must be Ed25519 (alg EdDSA).');
  }
  const publicKey = createPublicKey(privateKey);
  const kid = options.keyId ?? fingerprintPublicKeyV7(publicKey);
  const iat = options.issuedAtSeconds ?? Math.floor(Date.now() / 1000);
  const header: A2aV7CardJwsHeader = { alg: 'EdDSA', typ: 'agent-card+jwt', kid };
  const payload: A2aV7CardJwsPayload = { ...card, iat, exp: iat + ttl };
  const encodedHeader = base64UrlEncodeV7(canonicalizeJsonV7(header));
  const encodedPayload = base64UrlEncodeV7(canonicalizeJsonV7(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = sign(null, Buffer.from(signingInput, 'utf-8'), privateKey);
  return `${signingInput}.${base64UrlEncodeV7(signature)}`;
}

/** Options for verifying a card token. */
export interface A2aV7VerifyOptions {
  /** Clock override (seconds since epoch; default now). */
  nowSeconds?: number;
  /** Reject cards whose tenant is not in this list (when given). */
  allowedTenants?: readonly string[];
  /** Reject cards whose protocol versions do not include one of these. */
  requiredProtocolVersions?: readonly string[];
}

/**
 * Verify a JWS Agent Card token against a public key. Checks the
 * compact shape, header (`alg` EdDSA, `typ` agent-card+jwt),
 * signature, expiry (`exp`), and the card shape itself. The key
 * must match the token's `kid` — a token signed by another key
 * fails closed. Never throws for a bad token: returns ok=false
 * with a reason. (Only a non-string token throws TypeError via
 * the caller's own type check — see below.)
 */
export function verifyA2aV7AgentCard(
  token: unknown,
  publicKeyPem: string,
  options: A2aV7VerifyOptions = {},
): A2aV7CardVerification {
  const fail = (reason: string, keyId: string | null = null, expired = false): A2aV7CardVerification =>
    ({ ok: false, keyId, expired, reason });
  if (typeof token !== 'string' || token.trim().length === 0) {
    return fail('Token must be a non-empty JWS compact string.');
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return fail('Token must have three base64url parts (header.payload.signature).');
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const headerBuf = base64UrlDecodeV7(encodedHeader);
  const payloadBuf = base64UrlDecodeV7(encodedPayload);
  const signatureBuf = base64UrlDecodeV7(encodedSignature);
  if (!headerBuf || !payloadBuf || !signatureBuf) {
    return fail('Token parts must be valid base64url.');
  }
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(headerBuf.toString('utf-8')) as Record<string, unknown>;
    payload = JSON.parse(payloadBuf.toString('utf-8')) as Record<string, unknown>;
  } catch {
    return fail('Token header / payload must be valid JSON.');
  }
  if (header.alg !== 'EdDSA') return fail(`Unsupported alg "${String(header.alg)}" (expected EdDSA).`, null);
  if (header.typ !== 'agent-card+jwt') {
    return fail(`Unsupported typ "${String(header.typ)}" (expected agent-card+jwt).`, null);
  }
  if (typeof header.kid !== 'string' || header.kid.length === 0) {
    return fail('Token header needs a non-empty kid.');
  }
  const keyId = header.kid;
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(publicKeyPem);
  } catch {
    return fail('Verification key is not a valid public key (SPKI PEM expected).', keyId);
  }
  if (fingerprintPublicKeyV7(publicKey) !== keyId) {
    return fail(`Token kid ${keyId} does not match the verification key.`, keyId);
  }
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  let signatureOk = false;
  try {
    signatureOk = verify(null, Buffer.from(signingInput, 'utf-8'), publicKey, signatureBuf);
  } catch {
    return fail('Signature verification failed (malformed signature).', keyId);
  }
  if (!signatureOk) return fail('Signature does not match the header and payload.', keyId);
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const iat = payload.iat;
  const exp = payload.exp;
  if (typeof iat !== 'number' || typeof exp !== 'number' || !Number.isFinite(iat) || !Number.isFinite(exp)) {
    return fail('Token payload needs numeric iat and exp claims.', keyId);
  }
  if (exp <= now) {
    return { ok: false, keyId, expired: true, reason: `Token expired at ${new Date(exp * 1000).toISOString()}.` };
  }
  if (iat > now + 300) {
    return fail('Token iat is more than 5 minutes in the future (clock skew).', keyId);
  }
  const { iat: _iat, exp: _exp, ...cardPart } = payload;
  try {
    validateA2aV7AgentCard(cardPart);
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'Card in the token is invalid.';
    return fail(reason, keyId);
  }
  const card = cardPart as unknown as A2aV7AgentCard;
  if (options.allowedTenants && !options.allowedTenants.includes(card.tenant)) {
    return fail(`Card tenant "${card.tenant}" is not allowed here.`, keyId);
  }
  if (options.requiredProtocolVersions
    && !card.protocolVersions.some((v) => options.requiredProtocolVersions?.includes(v))) {
    return fail(`Card speaks none of the required protocol versions (${options.requiredProtocolVersions.join(', ')}).`, keyId);
  }
  return { ok: true, card, keyId, expired: false, tenant: card.tenant };
}

/**
 * Decode a JWS Agent Card token WITHOUT verifying it (for
 * diagnostics / logging only). Returns null when the token does
 * not even decode. NEVER trust the returned card — verify first.
 */
export function decodeA2aV7AgentCardUnverified(token: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
} | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const headerBuf = base64UrlDecodeV7(parts[0]);
  const payloadBuf = base64UrlDecodeV7(parts[1]);
  if (!headerBuf || !payloadBuf) return null;
  try {
    return {
      header: JSON.parse(headerBuf.toString('utf-8')) as Record<string, unknown>,
      payload: JSON.parse(payloadBuf.toString('utf-8')) as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}

/** Generate a fresh Ed25519 key pair (issuer-side). */
export function generateA2aV7CardKeyPair(): { publicKeyPem: string; privateKeyPem: string; keyId: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return { publicKeyPem, privateKeyPem, keyId: fingerprintPublicKeyV7(publicKey) };
}

/**
 * Card issuer: owns the signing keys, issues signed cards,
 * rotates keys (old keys keep verifying until their cards
 * expire) and revokes keys (revoked keys verify nothing).
 */
export class A2aV7CardIssuer {
  private keys: A2aV7CardKey[] = [];
  private activeKeyId: string | null = null;

  /** Create an issuer with one fresh key (or none — call `generateKey` first). */
  constructor(withInitialKey = true) {
    if (withInitialKey) this.generateKey();
  }

  /** Generate a new key and make it the active issuing key. */
  generateKey(): A2aV7CardKey {
    const { publicKeyPem, privateKeyPem, keyId } = generateA2aV7CardKeyPair();
    const key: A2aV7CardKey = {
      keyId,
      publicKeyPem,
      privateKeyPem,
      createdAtMs: Date.now(),
      rotatedAtMs: null,
      status: 'active',
    };
    if (this.activeKeyId) {
      const prev = this.keys.find((k) => k.keyId === this.activeKeyId);
      if (prev && prev.status === 'active') {
        prev.status = 'rotated';
        prev.rotatedAtMs = Date.now();
      }
    }
    this.keys.push(key);
    this.activeKeyId = keyId;
    return { ...key };
  }

  /** The active issuing key (null when the issuer has no key). */
  activeKey(): A2aV7CardKey | null {
    if (!this.activeKeyId) return null;
    const key = this.keys.find((k) => k.keyId === this.activeKeyId);
    return key ? { ...key } : null;
  }

  /** All keys (copies — the caller never gets the live array). */
  listKeys(): A2aV7CardKey[] {
    return this.keys.map((k) => ({ ...k }));
  }

  /** Public keys only (safe to publish / share with verifiers). */
  listPublicKeys(): { keyId: string; publicKeyPem: string; status: A2aV7CardKey['status'] }[] {
    return this.keys.map((k) => ({ keyId: k.keyId, publicKeyPem: k.publicKeyPem, status: k.status }));
  }

  /** Rotate: generate a new active key; the old key stays verifiable. */
  rotate(): A2aV7CardKey {
    return this.generateKey();
  }

  /** Revoke a key: it verifies nothing afterwards (issue + verify both refuse). */
  revokeKey(keyId: string, reason?: string): boolean {
    const key = this.keys.find((k) => k.keyId === keyId);
    if (!key || key.status === 'revoked') return false;
    key.status = 'revoked';
    key.rotatedAtMs = Date.now();
    if (this.activeKeyId === keyId) this.activeKeyId = null;
    void reason;
    return true;
  }

  /** Issue a signed card with the active key. Throws when no active key exists. */
  issue(card: A2aV7AgentCard, options: A2aV7SignOptions = {}): { jws: string; keyId: string; expiresAtMs: number } {
    const active = this.keys.find((k) => k.keyId === this.activeKeyId);
    if (!active || active.status !== 'active') {
      throw new A2aV7CardError('no-active-key', 'Issuer has no active key — generate one first.');
    }
    const jws = signA2aV7AgentCard(card, active.privateKeyPem, options);
    const iat = options.issuedAtSeconds ?? Math.floor(Date.now() / 1000);
    const ttl = options.ttlSeconds ?? A2A_V7_CARD_JWS_TTL_SECONDS;
    return { jws, keyId: active.keyId, expiresAtMs: (iat + ttl) * 1000 };
  }

  /** Verify a token against the issuer's own keys (revoked keys refuse). */
  verifyOwn(token: string, options: A2aV7VerifyOptions = {}): A2aV7CardVerification {
    const decoded = decodeA2aV7AgentCardUnverified(token);
    if (!decoded || typeof decoded.header.kid !== 'string') {
      return { ok: false, keyId: null, expired: false, reason: 'Token must have a kid header.' };
    }
    const key = this.keys.find((k) => k.keyId === decoded.header.kid);
    if (!key) {
      return { ok: false, keyId: decoded.header.kid, expired: false, reason: 'Unknown key id (not issued by this issuer).' };
    }
    if (key.status === 'revoked') {
      return { ok: false, keyId: key.keyId, expired: false, reason: 'Signing key was revoked.' };
    }
    return verifyA2aV7AgentCard(token, key.publicKeyPem, options);
  }
}

/**
 * Multi-tenant card registry: one store per tenant, keyed by
 * agent name. Cards are stored with their signed token; a
 * revoked card is never served again, and expired cards are
 * pruned on demand. The registry verifies the token on
 * registration (against the caller's public key) so it never
 * stores a card it cannot vouch for.
 */
export class A2aV7CardRegistry {
  private cards = new Map<string, Map<string, A2aV7RegisteredCard>>();
  private revokedJws = new Set<string>();

  private tenantMap(tenant: string): Map<string, A2aV7RegisteredCard> {
    const t = normalizeA2aV7TenantId(tenant);
    let map = this.cards.get(t);
    if (!map) {
      map = new Map();
      this.cards.set(t, map);
    }
    return map;
  }

  /**
   * Register a card: verify the token against `publicKeyPem`
   * first (fails closed), then store it under its tenant + name.
   * Re-registering the same name replaces the old card.
   */
  register(
    card: A2aV7AgentCard,
    jws: string,
    publicKeyPem: string,
  ): A2aV7RegisteredCard {
    const verification = verifyA2aV7AgentCard(jws, publicKeyPem);
    if (!verification.ok || !verification.card) {
      throw new A2aV7CardError('unverified-card', `Cannot register an unverified card: ${verification.reason ?? 'unknown'}.`);
    }
    if (verification.card.name !== card.name || verification.card.url !== card.url) {
      throw new A2aV7CardError('card-mismatch', 'Registered card does not match its signed token (name / url differ).');
    }
    const decoded = decodeA2aV7AgentCardUnverified(jws);
    const exp = typeof decoded?.payload.exp === 'number' ? (decoded.payload.exp as number) : 0;
    const registered: A2aV7RegisteredCard = {
      card: verification.card,
      jws,
      keyId: verification.keyId ?? '',
      registeredAtMs: Date.now(),
      expiresAtMs: exp * 1000,
      revoked: false,
    };
    this.tenantMap(card.tenant).set(card.name, registered);
    return { ...registered, card: { ...registered.card } };
  }

  /** Look up a card by tenant + agent name (null when missing / revoked / expired). */
  get(tenant: string, name: string, nowMs: number = Date.now()): A2aV7RegisteredCard | null {
    const entry = this.cards.get(normalizeA2aV7TenantId(tenant))?.get(name);
    if (!entry || entry.revoked) return null;
    if (entry.expiresAtMs <= nowMs) return null;
    if (this.revokedJws.has(entry.jws)) return null;
    return { ...entry, card: { ...entry.card } };
  }

  /** All live cards for a tenant (revoked / expired excluded). */
  list(tenant: string, nowMs: number = Date.now()): A2aV7RegisteredCard[] {
    const map = this.cards.get(normalizeA2aV7TenantId(tenant));
    if (!map) return [];
    return [...map.values()]
      .filter((e) => !e.revoked && e.expiresAtMs > nowMs && !this.revokedJws.has(e.jws))
      .map((e) => ({ ...e, card: { ...e.card } }));
  }

  /** All tenants that hold at least one card. */
  tenants(): string[] {
    return [...this.cards.keys()].sort();
  }

  /** Total live cards across tenants. */
  size(nowMs: number = Date.now()): number {
    let n = 0;
    for (const tenant of this.cards.keys()) n += this.list(tenant, nowMs).length;
    return n;
  }

  /** Revoke a card by tenant + name (revocation beats expiry). */
  revoke(tenant: string, name: string, reason?: string): boolean {
    const entry = this.cards.get(normalizeA2aV7TenantId(tenant))?.get(name);
    if (!entry || entry.revoked) return false;
    entry.revoked = true;
    entry.revokeReason = reason;
    this.revokedJws.add(entry.jws);
    return true;
  }

  /** Revoke every card signed by one key (key compromise path). */
  revokeByKey(keyId: string, reason?: string): number {
    let n = 0;
    for (const map of this.cards.values()) {
      for (const entry of map.values()) {
        if (entry.keyId === keyId && !entry.revoked) {
          entry.revoked = true;
          entry.revokeReason = reason;
          this.revokedJws.add(entry.jws);
          n += 1;
        }
      }
    }
    return n;
  }

  /** Drop expired cards (returns how many were dropped). */
  pruneExpired(nowMs: number = Date.now()): number {
    let n = 0;
    for (const [tenant, map] of this.cards) {
      for (const [name, entry] of map) {
        if (entry.expiresAtMs <= nowMs) {
          map.delete(name);
          n += 1;
        }
      }
      if (map.size === 0) this.cards.delete(tenant);
    }
    return n;
  }

  /** Find live cards by capability (one tenant, or all tenants when omitted). */
  findByCapability(capability: string, tenant?: string, nowMs: number = Date.now()): A2aV7RegisteredCard[] {
    const tenants = tenant ? [normalizeA2aV7TenantId(tenant)] : this.tenants();
    const out: A2aV7RegisteredCard[] = [];
    for (const t of tenants) {
      for (const entry of this.list(t, nowMs)) {
        if (entry.card.capabilities.includes(capability)) out.push(entry);
      }
    }
    return out;
  }

  /** Serialise the registry (live cards only) for snapshots / debugging. */
  snapshot(nowMs: number = Date.now()): A2aV7RegisteredCard[] {
    const out: A2aV7RegisteredCard[] = [];
    for (const tenant of this.tenants()) out.push(...this.list(tenant, nowMs));
    return out;
  }
}

/**
 * Trust store: decides whether a verified card may be USED.
 * Verification proves the card matches its key; trust decides
 * whether that key / tenant is allowed here. Three modes:
 *   - `pin`: only explicitly pinned key ids are trusted.
 *   - `allowlist`: pinned keys OR keys of allowlisted tenants.
 *   - `tofu`: first-seen keys are pinned automatically; a key
 *     change for the same agent name is refused until re-pinned.
 */
export type A2aV7TrustMode = 'pin' | 'allowlist' | 'tofu';

export interface A2aV7TrustDecision {
  trusted: boolean;
  mode: A2aV7TrustMode;
  reason: string;
}

export class A2aV7TrustStore {
  private pinnedKeys = new Set<string>();
  private allowedTenants = new Set<string>();
  private tofuPins = new Map<string, string>();
  private mode: A2aV7TrustMode;

  constructor(mode: A2aV7TrustMode = 'tofu') {
    this.mode = mode;
  }

  /** Current trust mode. */
  getMode(): A2aV7TrustMode {
    return this.mode;
  }

  setMode(mode: A2aV7TrustMode): void {
    this.mode = mode;
  }

  /** Pin a key id (trusted in every mode). */
  pinKey(keyId: string): void {
    this.pinnedKeys.add(keyId);
  }

  /** Unpin a key id. */
  unpinKey(keyId: string): boolean {
    return this.pinnedKeys.delete(keyId);
  }

  /** Allow a tenant (allowlist mode only). */
  allowTenant(tenant: string): void {
    this.allowedTenants.add(normalizeA2aV7TenantId(tenant));
  }

  /** Disallow a tenant. */
  disallowTenant(tenant: string): boolean {
    return this.allowedTenants.delete(normalizeA2aV7TenantId(tenant));
  }

  /** Decide whether a verified card may be used. */
  decide(card: A2aV7AgentCard, keyId: string): A2aV7TrustDecision {
    if (this.pinnedKeys.has(keyId)) {
      return { trusted: true, mode: this.mode, reason: `Key ${keyId.slice(0, 12)}… is pinned.` };
    }
    if (this.mode === 'pin') {
      return { trusted: false, mode: this.mode, reason: `Key ${keyId.slice(0, 12)}… is not pinned (pin mode).` };
    }
    if (this.mode === 'allowlist') {
      if (this.allowedTenants.has(card.tenant)) {
        return { trusted: true, mode: this.mode, reason: `Tenant "${card.tenant}" is allowlisted.` };
      }
      return { trusted: false, mode: this.mode, reason: `Tenant "${card.tenant}" is not allowlisted and key is not pinned.` };
    }
    // tofu: first sight pins the key for that agent name; a
    // different key for the same name is refused until re-pinned.
    const seen = this.tofuPins.get(card.name);
    if (seen === undefined) {
      this.tofuPins.set(card.name, keyId);
      return { trusted: true, mode: this.mode, reason: `First sight of "${card.name}" — key pinned (TOFU).` };
    }
    if (seen === keyId) {
      return { trusted: true, mode: this.mode, reason: `Key matches the TOFU pin for "${card.name}".` };
    }
    return {
      trusted: false,
      mode: this.mode,
      reason: `Key changed for "${card.name}" (TOFU pin mismatch) — re-pin explicitly before trusting the new key.`,
    };
  }

  /** Forget a TOFU pin (e.g. after an explicit re-pin by the user). */
  forgetTofu(agentName: string): boolean {
    return this.tofuPins.delete(agentName);
  }

  /** Summary for the UI / logs (no private material). */
  summary(): { mode: A2aV7TrustMode; pinnedKeys: number; allowedTenants: string[]; tofuPins: number } {
    return {
      mode: this.mode,
      pinnedKeys: this.pinnedKeys.size,
      allowedTenants: [...this.allowedTenants].sort(),
      tofuPins: this.tofuPins.size,
    };
  }
}

/** Discovery paths served for Agent Cards (v7). */
export const A2A_V7_CARD_DISCOVERY = {
  json: A2A_V7_WELL_KNOWN_CARD_PATH,
  jws: A2A_V7_WELL_KNOWN_CARD_JWS_PATH,
  mediaType: A2A_V7_AGENT_CARD_MEDIA_TYPE,
  jwsMediaType: A2A_V7_AGENT_CARD_JWS_MEDIA_TYPE,
} as const;

/** One-line summary of a card, for logs and the UI. */
export function summarizeA2aV7Card(card: A2aV7AgentCard): string {
  return `${card.name} v${card.version} (${card.tenant}) — ${card.capabilities.join(', ')} — ${card.url}`;
}
