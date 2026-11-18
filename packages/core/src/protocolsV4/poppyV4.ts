/**
 * Protocols v4 — Personal Agent Protocol 1.0 "Poppy" (v1.20, Team T2).
 *
 * Idea only, learned from the public Poppy description researched
 * for this wave (see docs/protocols-v120.md): Sierra + Meta
 * announced the Personal Agent Protocol on 6 Oct 2026, published
 * draft 0.1 on 9 Oct 2026 at personalagentprotocol.org, and a 1.0
 * release was reported 13 Nov 2026. The draft (0.1, with 0.2 in
 * progress) defines:
 *  - discovery: a company publishes `/.well-known/poppy.json`
 *    over HTTPS (organisation domain, OAuth issuer, `poppy_domains`,
 *    routes, sign-in types, scopes);
 *  - agent identity: the personal agent identifies itself with a
 *    `client_id` that is an HTTPS URL serving its client metadata
 *    document (public signing keys, allowed redirect addresses) —
 *    the same OAuth Client ID Metadata Document idea MCP uses;
 *  - user identity: the agent assigns its user a stable, opaque id
 *    specific to each company; the id MUST NOT be derived from
 *    personal information (name, email, phone), even via a keyed
 *    hash — the company sees only that id, never the person;
 *  - sessions: the agent starts a session with a signed assertion
 *    (JWT bearer) naming itself (`iss`) and the user (`sub`); the
 *    company returns a signed-out session token (DPoP-bound), so it
 *    can recognise the same agent + user across sessions without
 *    treating the person as signed in;
 *  - scopes: `poppy:read` / `poppy:write`, plus narrower company
 *    scopes; the company MUST NOT grant more than the agent
 *    requested or more than the sign-in method allows;
 *  - sign-in: direct, device and mediated; one session covers the
 *    company's website, APIs (OpenAPI / MCP) and a conversation
 *    with the company's own agent; human handoff is built in;
 *  - open topics (still undecided in the draft): payments, push
 *    notifications with no open request, attachments — open-bot
 *    does NOT implement those here (payments are out of scope).
 * No code, text or asset from any other repo is copied here.
 *
 * What this module adds on top of the draft (open-bot's own
 * design, because the draft describes agent<->company, not
 * agent<->agent): a *personal-agent profile exchange* — two
 * personal agents (e.g. open-bot on the user's machine and a peer
 * agent the user also runs) exchange signed agent profiles so each
 * side knows the other's capabilities, identity and preferences
 * before delegating work. The exchange reuses the draft's identity
 * vocabulary (`client_id` URL, public keys, scopes, routes) and
 * adds version negotiation + capability intersection + preference
 * merging, all validated before anything is trusted.
 *
 * Security notes:
 * - Profiles are validated structurally here; a profile whose
 *   `signature` is present is checked for shape only (algorithm
 *   allowlist, base64url value, `kid` matching a declared public
 *   key). Real JWS verification against the key fetched from the
 *   agent's `client_id` URL belongs to the network layer, not this
 *   module — never trust a profile fetched over plain HTTP.
 * - User ids are opaque random ids; `createPoppyUserId` never
 *   touches personal data, and `validatePoppyUserId` rejects any
 *   id shaped like an email / phone number.
 * - Secrets are never placed in a profile (the validator rejects
 *   secret-shaped keys in preferences).
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  POPPY_V4_CURRENT_VERSION,
  POPPY_V4_DISCOVERY_PATH,
  POPPY_V4_SCOPES,
  compareProtocolV4Versions,
  type PoppyV4Scope,
} from './versions';

export { POPPY_V4_DISCOVERY_PATH };

/** Poppy profile version this module speaks. */
export const POPPY_V4_PROFILE_VERSION = '1.0';
/** Supported profile versions (1.0 current, 0.2/0.1 draft). */
export const POPPY_V4_PROFILE_VERSIONS = ['1.0', '0.2', '0.1'] as const;
/** Max profiles kept in one in-memory registry. */
export const POPPY_V4_MAX_REGISTRY_PROFILES = 500;
/** Max public keys on one profile. */
export const POPPY_V4_MAX_PUBLIC_KEYS = 8;
/** Max chars of a profile description / preference string. */
export const POPPY_V4_MAX_STRING_CHARS = 2000;

/** Error raised by the Poppy v4 module. */
export class PoppyV4Error extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PoppyV4Error';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Routes a company / agent can answer through (draft 0.1). */
export type PoppyRouteKind = 'website' | 'openapi' | 'mcp' | 'conversation';
export const POPPY_V4_ROUTE_KINDS: readonly PoppyRouteKind[] = [
  'website',
  'openapi',
  'mcp',
  'conversation',
];

/** Sign-in types (draft 0.1). */
export type PoppySignInType = 'direct' | 'device' | 'mediated';
export const POPPY_V4_SIGN_IN_TYPES: readonly PoppySignInType[] = [
  'direct',
  'device',
  'mediated',
];

/** Human-handoff preference. */
export type PoppyHandoffPreference = 'always' | 'on-request' | 'never';

/** One public signing key declared in a profile / metadata doc. */
export interface PoppyPublicKey {
  /** Key id — must match the `kid` of a signature that uses it. */
  kid: string;
  /** JWK `kty`: OKP (Ed25519), EC (P-256) or RSA. */
  kty: 'OKP' | 'EC' | 'RSA';
  /** JWK `crv` for OKP/EC keys (e.g. `Ed25519`, `P-256`). */
  crv?: string;
  /** JWK public material (base64url `x`, and `y` for EC). */
  x?: string;
  y?: string;
  /** PEM public key (alternative to JWK fields). */
  pem?: string;
}

/** A profile signature (shape-checked here; JWS verify is network-layer). */
export interface PoppyProfileSignature {
  /** JWS algorithm, e.g. `EdDSA` / `ES256` / `RS256`. */
  algorithm: string;
  /** `kid` of the public key that verifies this signature. */
  kid: string;
  /** base64url signature value. */
  value: string;
}

/** What an agent can do, in Poppy vocabulary. */
export interface PoppyCapabilities {
  /** Routes the agent (or company) answers through. */
  routes: PoppyRouteKind[];
  /** Scopes the agent may request (`poppy:read` / `poppy:write` / custom). */
  scopes: string[];
  /** Sign-in types the agent supports. */
  signInTypes: PoppySignInType[];
  /** BCP 47 languages the agent works in (e.g. `en`, `vi`). */
  languages: string[];
  /** Max session length the agent asks for, in minutes (0 = no ask). */
  maxSessionMinutes?: number;
  /** The agent can hand a conversation to a human. */
  supportsHumanHandoff: boolean;
  /** The agent understands the `operations` extension (exact-revision actions). */
  supportsOperations?: boolean;
}

/** User preferences carried in a profile (never secrets). */
export interface PoppyPreferences {
  /** Preferred language (BCP 47). */
  language?: string;
  /** Preferred route order (subset of the agent's routes). */
  channelOrder?: PoppyRouteKind[];
  /** Minimise data shared with the other side (default true). */
  dataMinimisation?: boolean;
  /** Share conversation history with the peer (default false). */
  shareHistory?: boolean;
  /** When to hand off to a human. */
  humanHandoff?: PoppyHandoffPreference;
  /** Max minutes a delegated task may run before asking again. */
  maxTaskMinutes?: number;
  /** Free-form, non-secret notes (max 2000 chars). */
  notes?: string;
}

/**
 * A personal agent's profile — the document two personal agents
 * exchange before delegating work. Identity is the `client_id`
 * HTTPS URL (draft 0.1); capabilities and preferences are the
 * negotiable surface.
 */
export interface PoppyAgentProfile {
  /** Profile format version (`1.0` current, `0.2`/`0.1` draft). */
  profileVersion: string;
  /** Agent identity: HTTPS URL serving the client metadata doc. */
  agentId: string;
  /** Human-readable agent name. */
  name: string;
  /** Vendor / publisher (e.g. `open-bot`). */
  vendor?: string;
  /** Short description (max 2000 chars). */
  description?: string;
  /** What the agent can do. */
  capabilities: PoppyCapabilities;
  /** The user's preferences for working with this agent. */
  preferences: PoppyPreferences;
  /** Public signing keys (verify the profile signature). */
  publicKeys: PoppyPublicKey[];
  /** ISO time the profile was issued. */
  issuedAt: string;
  /** ISO time the profile expires (must be after `issuedAt`). */
  expiresAt: string;
  /** Profile signature (optional; shape-checked, see header). */
  signature?: PoppyProfileSignature;
}

// ---------------------------------------------------------------------------
// Small validators
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isBcp47(value: string): boolean {
  return /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$/.test(value);
}

function isBase64Url(value: string): boolean {
  return /^[A-Za-z0-9_-]+={0,2}$/.test(value) && value.length > 0;
}

/** Secret-shaped keys are never allowed in preferences / notes. */
const POPPY_SECRET_KEY_RE = /(password|secret|token|api[-_]?key|private[-_]?key|credential)/i;
export function poppyValueHasSecretShape(value: unknown): boolean {
  if (typeof value === 'string') return POPPY_SECRET_KEY_RE.test(value);
  if (Array.isArray(value)) return value.some((v) => poppyValueHasSecretShape(v));
  if (isRecord(value)) {
    return Object.entries(value).some(
      ([k, v]) => POPPY_SECRET_KEY_RE.test(k) || poppyValueHasSecretShape(v),
    );
  }
  return false;
}

/**
 * A scope is valid when it is `poppy:read` / `poppy:write` or a
 * company scope shaped like `vendor:action` (lowercase, no spaces).
 */
export function isPoppyScope(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false;
  if ((POPPY_V4_SCOPES as readonly string[]).includes(value)) return true;
  return /^[a-z][a-z0-9_-]*:[a-z][a-z0-9:._-]*$/.test(value);
}

// ---------------------------------------------------------------------------
// Profile validation + canonical hash
// ---------------------------------------------------------------------------

export interface PoppyProfileValidation {
  ok: boolean;
  errors: string[];
  profile: PoppyAgentProfile | null;
}

/**
 * Validate a candidate profile document. Returns every problem
 * found (not just the first) so the UI can show them all. A profile
 * is only trusted when `ok` is true AND (for profiles received over
 * the network) its signature verifies against a key fetched from
 * its `agentId` URL — that fetch/verify step lives outside this
 * module (see header).
 */
export function validatePoppyAgentProfile(value: unknown): PoppyProfileValidation {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ['Profile must be an object.'], profile: null };
  const v = value as Record<string, unknown>;

  if (typeof v['profileVersion'] !== 'string' || !(POPPY_V4_PROFILE_VERSIONS as readonly string[]).includes(v['profileVersion'])) {
    errors.push(`profileVersion must be one of ${POPPY_V4_PROFILE_VERSIONS.join(', ')}.`);
  }
  if (!isHttpsUrl(v['agentId'])) errors.push('agentId must be an HTTPS URL (client_id metadata document).');
  if (typeof v['name'] !== 'string' || !v['name'].trim()) errors.push('name must be a non-empty string.');
  if (typeof v['name'] === 'string' && v['name'].length > 200) errors.push('name must be at most 200 chars.');
  if (v['vendor'] !== undefined && (typeof v['vendor'] !== 'string' || !v['vendor'].trim())) {
    errors.push('vendor, when present, must be a non-empty string.');
  }
  if (v['description'] !== undefined) {
    if (typeof v['description'] !== 'string' || v['description'].length > POPPY_V4_MAX_STRING_CHARS) {
      errors.push(`description, when present, must be a string of at most ${POPPY_V4_MAX_STRING_CHARS} chars.`);
    }
  }

  // Capabilities.
  if (!isRecord(v['capabilities'])) {
    errors.push('capabilities must be an object.');
  } else {
    const caps = v['capabilities'] as Record<string, unknown>;
    if (!Array.isArray(caps['routes']) || caps['routes'].length === 0) {
      errors.push('capabilities.routes must be a non-empty array.');
    } else if (
      (caps['routes'] as unknown[]).some(
        (r) => typeof r !== 'string' || !(POPPY_V4_ROUTE_KINDS as readonly string[]).includes(r),
      )
    ) {
      errors.push(`capabilities.routes entries must be one of ${POPPY_V4_ROUTE_KINDS.join(', ')}.`);
    }
    if (!Array.isArray(caps['scopes']) || caps['scopes'].length === 0) {
      errors.push('capabilities.scopes must be a non-empty array.');
    } else if ((caps['scopes'] as unknown[]).some((s) => !isPoppyScope(s))) {
      errors.push('capabilities.scopes entries must be poppy:read / poppy:write or vendor:action scopes.');
    }
    if (!Array.isArray(caps['signInTypes']) || caps['signInTypes'].length === 0) {
      errors.push('capabilities.signInTypes must be a non-empty array.');
    } else if (
      (caps['signInTypes'] as unknown[]).some(
        (s) => typeof s !== 'string' || !(POPPY_V4_SIGN_IN_TYPES as readonly string[]).includes(s),
      )
    ) {
      errors.push(`capabilities.signInTypes entries must be one of ${POPPY_V4_SIGN_IN_TYPES.join(', ')}.`);
    }
    if (!Array.isArray(caps['languages']) || caps['languages'].length === 0) {
      errors.push('capabilities.languages must be a non-empty array.');
    } else if ((caps['languages'] as unknown[]).some((l) => typeof l !== 'string' || !isBcp47(l))) {
      errors.push('capabilities.languages entries must be BCP 47 language tags.');
    }
    if (caps['maxSessionMinutes'] !== undefined) {
      if (typeof caps['maxSessionMinutes'] !== 'number' || caps['maxSessionMinutes'] < 0 || !Number.isInteger(caps['maxSessionMinutes'])) {
        errors.push('capabilities.maxSessionMinutes, when present, must be a non-negative integer.');
      }
    }
    if (typeof caps['supportsHumanHandoff'] !== 'boolean') {
      errors.push('capabilities.supportsHumanHandoff must be a boolean.');
    }
    if (caps['supportsOperations'] !== undefined && typeof caps['supportsOperations'] !== 'boolean') {
      errors.push('capabilities.supportsOperations, when present, must be a boolean.');
    }
  }

  // Preferences.
  if (!isRecord(v['preferences'])) {
    errors.push('preferences must be an object.');
  } else {
    const prefs = v['preferences'] as Record<string, unknown>;
    if (prefs['language'] !== undefined && (typeof prefs['language'] !== 'string' || !isBcp47(prefs['language']))) {
      errors.push('preferences.language, when present, must be a BCP 47 language tag.');
    }
    if (prefs['channelOrder'] !== undefined) {
      if (!Array.isArray(prefs['channelOrder'])) {
        errors.push('preferences.channelOrder, when present, must be an array.');
      } else if (
        (prefs['channelOrder'] as unknown[]).some(
          (r) => typeof r !== 'string' || !(POPPY_V4_ROUTE_KINDS as readonly string[]).includes(r),
        )
      ) {
        errors.push('preferences.channelOrder entries must be route kinds.');
      }
    }
    for (const key of ['dataMinimisation', 'shareHistory'] as const) {
      if (prefs[key] !== undefined && typeof prefs[key] !== 'boolean') {
        errors.push(`preferences.${key}, when present, must be a boolean.`);
      }
    }
    if (
      prefs['humanHandoff'] !== undefined &&
      !(['always', 'on-request', 'never'] as readonly string[]).includes(prefs['humanHandoff'] as string)
    ) {
      errors.push('preferences.humanHandoff, when present, must be always / on-request / never.');
    }
    if (prefs['maxTaskMinutes'] !== undefined) {
      if (typeof prefs['maxTaskMinutes'] !== 'number' || prefs['maxTaskMinutes'] <= 0 || !Number.isInteger(prefs['maxTaskMinutes'])) {
        errors.push('preferences.maxTaskMinutes, when present, must be a positive integer.');
      }
    }
    if (prefs['notes'] !== undefined && (typeof prefs['notes'] !== 'string' || prefs['notes'].length > POPPY_V4_MAX_STRING_CHARS)) {
      errors.push(`preferences.notes, when present, must be a string of at most ${POPPY_V4_MAX_STRING_CHARS} chars.`);
    }
    if (poppyValueHasSecretShape(prefs)) errors.push('preferences must not contain secret-shaped keys or values.');
  }

  // Public keys.
  if (!Array.isArray(v['publicKeys']) || v['publicKeys'].length === 0) {
    errors.push('publicKeys must be a non-empty array.');
  } else {
    if (v['publicKeys'].length > POPPY_V4_MAX_PUBLIC_KEYS) {
      errors.push(`publicKeys must have at most ${POPPY_V4_MAX_PUBLIC_KEYS} keys.`);
    }
    const kids = new Set<string>();
    for (const [i, key] of (v['publicKeys'] as unknown[]).entries()) {
      if (!isRecord(key)) {
        errors.push(`publicKeys[${i}] must be an object.`);
        continue;
      }
      if (typeof key['kid'] !== 'string' || !key['kid'].trim()) errors.push(`publicKeys[${i}].kid must be a non-empty string.`);
      else if (kids.has(key['kid'])) errors.push(`publicKeys[${i}].kid "${key['kid']}" is duplicated.`);
      else kids.add(key['kid']);
      if (!(['OKP', 'EC', 'RSA'] as readonly string[]).includes(key['kty'] as string)) {
        errors.push(`publicKeys[${i}].kty must be OKP / EC / RSA.`);
      }
      if (key['x'] !== undefined && (typeof key['x'] !== 'string' || !isBase64Url(key['x']))) {
        errors.push(`publicKeys[${i}].x, when present, must be base64url.`);
      }
      if (key['y'] !== undefined && (typeof key['y'] !== 'string' || !isBase64Url(key['y']))) {
        errors.push(`publicKeys[${i}].y, when present, must be base64url.`);
      }
      if (key['pem'] !== undefined && (typeof key['pem'] !== 'string' || !key['pem'].includes('PUBLIC KEY'))) {
        errors.push(`publicKeys[${i}].pem, when present, must be a PEM public key.`);
      }
      if (key['x'] === undefined && key['pem'] === undefined) {
        errors.push(`publicKeys[${i}] must carry x (JWK) or pem material.`);
      }
    }
  }

  // Dates + signature shape.
  if (!isIsoDate(v['issuedAt'])) errors.push('issuedAt must be an ISO date string.');
  if (!isIsoDate(v['expiresAt'])) errors.push('expiresAt must be an ISO date string.');
  if (isIsoDate(v['issuedAt']) && isIsoDate(v['expiresAt']) && Date.parse(v['expiresAt']) <= Date.parse(v['issuedAt'])) {
    errors.push('expiresAt must be after issuedAt.');
  }
  if (v['signature'] !== undefined) {
    if (!isRecord(v['signature'])) {
      errors.push('signature, when present, must be an object.');
    } else {
      const sig = v['signature'] as Record<string, unknown>;
      if (!(['EdDSA', 'ES256', 'RS256', 'ES384', 'PS256'] as readonly string[]).includes(sig['algorithm'] as string)) {
        errors.push('signature.algorithm must be EdDSA / ES256 / RS256 / ES384 / PS256.');
      }
      if (typeof sig['kid'] !== 'string' || !sig['kid'].trim()) {
        errors.push('signature.kid must be a non-empty string.');
      } else if (Array.isArray(v['publicKeys'])) {
        const known = (v['publicKeys'] as unknown[]).some(
          (k) => isRecord(k) && k['kid'] === sig['kid'],
        );
        if (!known) errors.push(`signature.kid "${sig['kid']}" matches no declared public key.`);
      }
      if (typeof sig['value'] !== 'string' || !isBase64Url(sig['value'])) {
        errors.push('signature.value must be base64url.');
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors, profile: null };
  return { ok: true, errors: [], profile: value as unknown as PoppyAgentProfile };
}

/** True when the profile is expired at `now` (default: now). */
export function isPoppyProfileExpired(profile: PoppyAgentProfile, now: Date = new Date()): boolean {
  return Date.parse(profile.expiresAt) <= now.getTime();
}

/** Deterministic JSON (sorted keys) for hashing / signing. */
export function stablePoppyJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stablePoppyJson(v)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stablePoppyJson(record[k])}`).join(',')}}`;
}

/**
 * Canonical hash of a profile (signature excluded — the signature
 * signs this hash). Use it to detect tampering / to compare two
 * copies of the same profile.
 */
export function hashPoppyAgentProfile(profile: PoppyAgentProfile): string {
  const { signature: _signature, ...unsigned } = profile as PoppyAgentProfile & {
    signature?: PoppyProfileSignature;
  };
  void _signature;
  return createHash('sha256').update(stablePoppyJson(unsigned), 'utf8').digest('hex');
}

/**
 * Build a minimal valid profile for the local agent. Callers fill
 * `capabilities` / `preferences` from their own settings; the
 * defaults are the open-bot-safe ones (data minimisation on, no
 * history sharing, handoff on request).
 */
export function buildPoppyAgentProfile(options: {
  agentId: string;
  name: string;
  vendor?: string;
  description?: string;
  capabilities: PoppyCapabilities;
  preferences?: PoppyPreferences;
  publicKeys: PoppyPublicKey[];
  profileVersion?: string;
  validMinutes?: number;
  now?: Date;
}): PoppyAgentProfile {
  const now = options.now ?? new Date();
  const validMinutes = options.validMinutes ?? 60 * 24 * 30; // 30 days
  return {
    profileVersion: options.profileVersion ?? POPPY_V4_PROFILE_VERSION,
    agentId: options.agentId,
    name: options.name,
    vendor: options.vendor,
    description: options.description,
    capabilities: options.capabilities,
    preferences: {
      dataMinimisation: true,
      shareHistory: false,
      humanHandoff: 'on-request',
      ...(options.preferences ?? {}),
    },
    publicKeys: options.publicKeys,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + validMinutes * 60_000).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Discovery document (/.well-known/poppy.json)
// ---------------------------------------------------------------------------

/** One route inside a Poppy discovery document. */
export interface PoppyDiscoveryRoute {
  kind: PoppyRouteKind;
  /** Endpoint URL (HTTPS) for this route. */
  endpoint: string;
}

/** The `/.well-known/poppy.json` document (draft 0.1). */
export interface PoppyDiscoveryDoc {
  /** Spec version the company speaks (`1.0` / `0.2` / `0.1`). */
  protocolVersion: string;
  /** Organisation name. */
  organization: string;
  /** Organisation domain — must be the domain the agent requested. */
  organizationDomain: string;
  /** OAuth issuer URL (must match the OAuth server metadata). */
  issuer: string;
  /** OAuth authorization server metadata URL. */
  authorizationServer: string;
  /** Domains this issuer serves (must include `organizationDomain`). */
  poppyDomains: string[];
  /** Routes the company answers through. */
  routes: PoppyDiscoveryRoute[];
  /** Sign-in types the company offers. */
  signInTypes: PoppySignInType[];
  /** Scopes the company may grant. */
  scopes: string[];
}

export interface PoppyDiscoveryValidation {
  ok: boolean;
  errors: string[];
  doc: PoppyDiscoveryDoc | null;
}

/**
 * Validate a fetched `poppy.json`. The draft's cross-checks are
 * enforced: the organisation domain must be listed in
 * `poppy_domains`, the issuer must be HTTPS, and every route
 * endpoint must be HTTPS. (Checking the OAuth server metadata's
 * own `issuer` + `poppy_domains` needs a live fetch — the caller
 * passes that metadata in and this function compares it.)
 */
export function validatePoppyDiscoveryDoc(
  value: unknown,
  oauthMetadata?: { issuer?: unknown; poppy_domains?: unknown },
): PoppyDiscoveryValidation {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ['Discovery document must be an object.'], doc: null };
  }
  const v = value as Record<string, unknown>;
  if (typeof v['protocolVersion'] !== 'string' || !(POPPY_V4_PROFILE_VERSIONS as readonly string[]).includes(v['protocolVersion'])) {
    errors.push(`protocolVersion must be one of ${POPPY_V4_PROFILE_VERSIONS.join(', ')}.`);
  }
  if (typeof v['organization'] !== 'string' || !v['organization'].trim()) {
    errors.push('organization must be a non-empty string.');
  }
  if (typeof v['organizationDomain'] !== 'string' || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(v['organizationDomain'])) {
    errors.push('organizationDomain must be a bare domain name.');
  }
  if (!isHttpsUrl(v['issuer'])) errors.push('issuer must be an HTTPS URL.');
  if (!isHttpsUrl(v['authorizationServer'])) errors.push('authorizationServer must be an HTTPS URL.');
  if (!Array.isArray(v['poppyDomains']) || v['poppyDomains'].length === 0) {
    errors.push('poppyDomains must be a non-empty array.');
  } else if ((v['poppyDomains'] as unknown[]).some((d) => typeof d !== 'string' || !d)) {
    errors.push('poppyDomains entries must be non-empty strings.');
  } else if (
    typeof v['organizationDomain'] === 'string' &&
    !(v['poppyDomains'] as string[]).includes(v['organizationDomain'])
  ) {
    errors.push('poppyDomains must include organizationDomain.');
  }
  if (!Array.isArray(v['routes']) || v['routes'].length === 0) {
    errors.push('routes must be a non-empty array.');
  } else {
    for (const [i, route] of (v['routes'] as unknown[]).entries()) {
      if (!isRecord(route)) {
        errors.push(`routes[${i}] must be an object.`);
        continue;
      }
      if (!(POPPY_V4_ROUTE_KINDS as readonly string[]).includes(route['kind'] as string)) {
        errors.push(`routes[${i}].kind must be one of ${POPPY_V4_ROUTE_KINDS.join(', ')}.`);
      }
      if (!isHttpsUrl(route['endpoint'])) errors.push(`routes[${i}].endpoint must be an HTTPS URL.`);
    }
  }
  if (!Array.isArray(v['signInTypes']) || v['signInTypes'].length === 0) {
    errors.push('signInTypes must be a non-empty array.');
  } else if (
    (v['signInTypes'] as unknown[]).some(
      (s) => typeof s !== 'string' || !(POPPY_V4_SIGN_IN_TYPES as readonly string[]).includes(s),
    )
  ) {
    errors.push(`signInTypes entries must be one of ${POPPY_V4_SIGN_IN_TYPES.join(', ')}.`);
  }
  if (!Array.isArray(v['scopes']) || v['scopes'].length === 0) {
    errors.push('scopes must be a non-empty array.');
  } else if ((v['scopes'] as unknown[]).some((s) => !isPoppyScope(s))) {
    errors.push('scopes entries must be poppy:read / poppy:write or vendor:action scopes.');
  }
  // Cross-check against the OAuth server metadata (draft 0.1).
  if (oauthMetadata !== undefined) {
    if (typeof oauthMetadata.issuer === 'string' && typeof v['issuer'] === 'string' && oauthMetadata.issuer !== v['issuer']) {
      errors.push('OAuth metadata issuer does not match the discovery issuer.');
    }
    if (Array.isArray(oauthMetadata.poppy_domains)) {
      if (typeof v['organizationDomain'] === 'string' && !(oauthMetadata.poppy_domains as unknown[]).includes(v['organizationDomain'])) {
        errors.push('OAuth metadata poppy_domains does not include organizationDomain.');
      }
    } else {
      errors.push('OAuth metadata must list poppy_domains.');
    }
  }
  if (errors.length > 0) return { ok: false, errors, doc: null };
  return { ok: true, errors: [], doc: value as unknown as PoppyDiscoveryDoc };
}

/** Discovery URL for a company domain. */
export function poppyDiscoveryUrl(domain: string): string {
  return `https://${domain}${POPPY_V4_DISCOVERY_PATH}`;
}

// ---------------------------------------------------------------------------
// Opaque per-company user ids
// ---------------------------------------------------------------------------

/**
 * Create an opaque user id for one company. Random, never derived
 * from personal data — the draft forbids deriving it from a name,
 * email or phone number, even via a keyed hash.
 */
export function createPoppyUserId(): string {
  return `pu_${randomBytes(16).toString('hex')}`;
}

/**
 * True when an id looks like it was derived from personal data
 * (contains `@`, a phone-shaped digit run, or is too short to be a
 * random opaque id). Such ids must be rejected.
 */
export function isPoppyUserIdPiiShaped(userId: unknown): boolean {
  if (typeof userId !== 'string' || !userId) return true;
  if (userId.includes('@')) return true;
  if (/\+?\d[\d\s()-]{7,}\d/.test(userId)) return true;
  if (userId.length < 16) return true;
  return false;
}

export function validatePoppyUserId(userId: unknown): { ok: boolean; reason?: string } {
  if (typeof userId !== 'string' || !userId.trim()) {
    return { ok: false, reason: 'User id must be a non-empty string.' };
  }
  if (isPoppyUserIdPiiShaped(userId)) {
    return { ok: false, reason: 'User id must be opaque: it must not look like an email, phone number or short name.' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export type PoppySessionState = 'signed-out' | 'signed-in' | 'revoked' | 'expired';

/** One Poppy session: one user, at one company, through one agent. */
export interface PoppySession {
  sessionId: string;
  agentId: string;
  userId: string;
  organizationDomain: string;
  scopes: PoppyV4Scope[] | string[];
  state: PoppySessionState;
  signInType?: PoppySignInType;
  /** DPoP-bound token (key-bound, short-lived) — value is opaque here. */
  sessionToken: string;
  createdAt: string;
  expiresAt: string;
}

/** Signed assertion the agent presents to start a session. */
export interface PoppySignedAssertion {
  /** Agent `client_id` URL. */
  iss: string;
  /** Opaque per-company user id. */
  sub: string;
  /** OAuth issuer (audience). */
  aud: string;
  /** Expiry (seconds since epoch). */
  exp: number;
  /** Issued at (seconds since epoch). */
  iat: number;
}

function validatePoppyAssertion(
  assertion: unknown,
  profile: PoppyAgentProfile,
  userId: string,
  discovery: PoppyDiscoveryDoc,
  now: Date,
): string | null {
  if (!isRecord(assertion)) return 'Assertion must be an object.';
  if (assertion['iss'] !== profile.agentId) return 'Assertion iss must equal the agent client_id.';
  if (assertion['sub'] !== userId) return 'Assertion sub must equal the opaque user id.';
  if (assertion['aud'] !== discovery.issuer) return 'Assertion aud must equal the discovery issuer.';
  if (typeof assertion['exp'] !== 'number' || assertion['exp'] * 1000 <= now.getTime()) {
    return 'Assertion is expired.';
  }
  if (typeof assertion['iat'] !== 'number' || assertion['iat'] * 1000 > now.getTime() + 300_000) {
    return 'Assertion iat is in the future.';
  }
  return null;
}

/**
 * Start a signed-out session. The company MUST NOT grant more than
 * the agent requested (`requestedScopes`) or more than the discovery
 * document offers — extra scopes are dropped and reported, never
 * silently granted.
 */
export function startPoppySession(options: {
  profile: PoppyAgentProfile;
  discovery: PoppyDiscoveryDoc;
  userId: string;
  requestedScopes: string[];
  assertion: PoppySignedAssertion;
  sessionMinutes?: number;
  now?: Date;
}): { session: PoppySession; grantedScopes: string[]; droppedScopes: string[] } {
  const now = options.now ?? new Date();
  const userCheck = validatePoppyUserId(options.userId);
  if (!userCheck.ok) throw new PoppyV4Error('BAD_USER_ID', userCheck.reason ?? 'Bad user id.');
  const assertionProblem = validatePoppyAssertion(options.assertion, options.profile, options.userId, options.discovery, now);
  if (assertionProblem) throw new PoppyV4Error('BAD_ASSERTION', assertionProblem);
  const offered = new Set(options.discovery.scopes);
  const grantedScopes = options.requestedScopes.filter((s) => offered.has(s) && isPoppyScope(s));
  const droppedScopes = options.requestedScopes.filter((s) => !grantedScopes.includes(s));
  if (grantedScopes.length === 0) {
    throw new PoppyV4Error('NO_SCOPES', 'No requested scope is offered by this company.');
  }
  const minutes = options.sessionMinutes ?? options.profile.capabilities.maxSessionMinutes ?? 60;
  return {
    session: {
      sessionId: randomUUID(),
      agentId: options.profile.agentId,
      userId: options.userId,
      organizationDomain: options.discovery.organizationDomain,
      scopes: grantedScopes,
      state: 'signed-out',
      sessionToken: `poppy_${randomBytes(24).toString('base64url')}`,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + minutes * 60_000).toISOString(),
    },
    grantedScopes,
    droppedScopes,
  };
}

/** Move a signed-out session to signed-in (user completed sign-in). */
export function signInPoppySession(
  session: PoppySession,
  signInType: PoppySignInType,
  now: Date = new Date(),
): PoppySession {
  if (session.state === 'revoked') throw new PoppyV4Error('SESSION_REVOKED', 'Session is revoked.');
  if (Date.parse(session.expiresAt) <= now.getTime()) {
    return { ...session, state: 'expired' };
  }
  if (session.state !== 'signed-out') {
    throw new PoppyV4Error('BAD_SESSION_STATE', `Cannot sign in a ${session.state} session.`);
  }
  return { ...session, state: 'signed-in', signInType };
}

/** Revoke a session (user or agent revokes; returns to signed-out per draft, recorded as revoked). */
export function revokePoppySession(session: PoppySession): PoppySession {
  return { ...session, state: 'revoked' };
}

/** True when the session may act (signed-in, not expired). */
export function isPoppySessionUsable(session: PoppySession, now: Date = new Date()): boolean {
  return session.state === 'signed-in' && Date.parse(session.expiresAt) > now.getTime();
}

// ---------------------------------------------------------------------------
// Profile exchange between two personal agents
// ---------------------------------------------------------------------------

export type PoppyExchangeState = 'offered' | 'accepted' | 'rejected' | 'expired';

/** Capability intersection of two profiles (what both sides can do). */
export interface PoppyCapabilityIntersection {
  routes: PoppyRouteKind[];
  scopes: string[];
  signInTypes: PoppySignInType[];
  languages: string[];
  humanHandoff: boolean;
  operations: boolean;
}

/** One preference conflict found while merging two profiles. */
export interface PoppyPreferenceConflict {
  key: string;
  localValue: unknown;
  remoteValue: unknown;
  resolution: string;
}

/** A profile exchange between two personal agents. */
export interface PoppyProfileExchange {
  exchangeId: string;
  fromAgentId: string;
  toAgentId: string;
  /** Negotiated profile version (the lower both sides speak). */
  negotiatedVersion: string;
  /** True when negotiation downgraded from 1.0 to a draft. */
  downgraded: boolean;
  offeredProfile: PoppyAgentProfile;
  remoteProfile: PoppyAgentProfile;
  intersection: PoppyCapabilityIntersection;
  mergedPreferences: PoppyPreferences;
  conflicts: PoppyPreferenceConflict[];
  state: PoppyExchangeState;
  createdAt: string;
}

/** Intersect two capability sets. */
export function intersectPoppyCapabilities(
  a: PoppyCapabilities,
  b: PoppyCapabilities,
): PoppyCapabilityIntersection {
  const routes = a.routes.filter((r) => b.routes.includes(r));
  const scopes = a.scopes.filter((s) => b.scopes.includes(s));
  const signInTypes = a.signInTypes.filter((s) => b.signInTypes.includes(s));
  const languages = a.languages.filter((l) => b.languages.includes(l));
  return {
    routes,
    scopes,
    signInTypes,
    languages,
    humanHandoff: a.supportsHumanHandoff && b.supportsHumanHandoff,
    operations: Boolean(a.supportsOperations) && Boolean(b.supportsOperations),
  };
}

/**
 * Merge two preference sets. The remote side's explicit preferences
 * win for the shared session (it is the peer the user is delegating
 * to); the local side's defaults fill gaps. Conflicts are recorded
 * instead of silently dropped — the strictest privacy choice wins
 * for `dataMinimisation` / `shareHistory`.
 */
export function mergePoppyPreferences(
  local: PoppyPreferences,
  remote: PoppyPreferences,
): { merged: PoppyPreferences; conflicts: PoppyPreferenceConflict[] } {
  const conflicts: PoppyPreferenceConflict[] = [];
  const merged: PoppyPreferences = { ...local };
  const note = (key: string, lv: unknown, rv: unknown, resolution: string): void => {
    conflicts.push({ key, localValue: lv, remoteValue: rv, resolution });
  };
  if (remote.language !== undefined) {
    if (local.language !== undefined && local.language !== remote.language) {
      note('language', local.language, remote.language, 'Remote language wins for the shared session.');
    }
    merged.language = remote.language;
  }
  if (remote.channelOrder !== undefined) merged.channelOrder = remote.channelOrder;
  if (remote.dataMinimisation !== undefined) {
    if (local.dataMinimisation === false && remote.dataMinimisation === true) {
      note('dataMinimisation', false, true, 'Strictest (true) wins.');
    }
    merged.dataMinimisation = Boolean(local.dataMinimisation) || Boolean(remote.dataMinimisation);
    if (local.dataMinimisation === true) merged.dataMinimisation = true;
  }
  if (remote.shareHistory !== undefined) {
    if (local.shareHistory === true && remote.shareHistory === false) {
      note('shareHistory', true, false, 'Strictest (false) wins.');
    }
    merged.shareHistory = Boolean(local.shareHistory) && Boolean(remote.shareHistory);
  }
  if (remote.humanHandoff !== undefined) {
    if (local.humanHandoff !== undefined && local.humanHandoff !== remote.humanHandoff) {
      note('humanHandoff', local.humanHandoff, remote.humanHandoff, 'Remote handoff preference wins.');
    }
    merged.humanHandoff = remote.humanHandoff;
  }
  if (remote.maxTaskMinutes !== undefined) {
    if (local.maxTaskMinutes !== undefined) {
      merged.maxTaskMinutes = Math.min(local.maxTaskMinutes, remote.maxTaskMinutes);
      if (local.maxTaskMinutes !== remote.maxTaskMinutes) {
        note('maxTaskMinutes', local.maxTaskMinutes, remote.maxTaskMinutes, 'Smaller limit wins.');
      }
    } else {
      merged.maxTaskMinutes = remote.maxTaskMinutes;
    }
  }
  if (remote.notes !== undefined) merged.notes = remote.notes;
  return { merged, conflicts };
}

/**
 * Offer a profile exchange: validate both profiles, negotiate the
 * profile version (lower wins; 1.0 vs 0.x downgrades with a flag),
 * intersect capabilities and merge preferences. Throws on invalid
 * or expired profiles, or when the intersection is empty (the two
 * agents share no route, scope or language — there is nothing to
 * exchange for).
 */
export function offerPoppyProfileExchange(
  localProfile: PoppyAgentProfile,
  remoteProfile: PoppyAgentProfile,
  now: Date = new Date(),
): PoppyProfileExchange {
  const localCheck = validatePoppyAgentProfile(localProfile);
  if (!localCheck.ok) {
    throw new PoppyV4Error('INVALID_LOCAL_PROFILE', localCheck.errors.join(' '));
  }
  const remoteCheck = validatePoppyAgentProfile(remoteProfile);
  if (!remoteCheck.ok) {
    throw new PoppyV4Error('INVALID_REMOTE_PROFILE', remoteCheck.errors.join(' '));
  }
  if (isPoppyProfileExpired(localProfile, now)) {
    throw new PoppyV4Error('LOCAL_PROFILE_EXPIRED', 'Local profile is expired.');
  }
  if (isPoppyProfileExpired(remoteProfile, now)) {
    throw new PoppyV4Error('REMOTE_PROFILE_EXPIRED', 'Remote profile is expired.');
  }
  if (localProfile.agentId === remoteProfile.agentId) {
    throw new PoppyV4Error('SAME_AGENT', 'Cannot exchange a profile with yourself.');
  }
  const cmp = compareProtocolV4Versions('poppy', localProfile.profileVersion, remoteProfile.profileVersion);
  const negotiatedVersion = cmp <= 0 ? localProfile.profileVersion : remoteProfile.profileVersion;
  const downgraded = negotiatedVersion !== POPPY_V4_PROFILE_VERSION;
  const intersection = intersectPoppyCapabilities(localProfile.capabilities, remoteProfile.capabilities);
  if (intersection.routes.length === 0) {
    throw new PoppyV4Error('NO_COMMON_ROUTE', 'Profiles share no route — nothing to exchange for.');
  }
  if (intersection.scopes.length === 0) {
    throw new PoppyV4Error('NO_COMMON_SCOPE', 'Profiles share no scope — nothing to exchange for.');
  }
  if (intersection.languages.length === 0) {
    throw new PoppyV4Error('NO_COMMON_LANGUAGE', 'Profiles share no language — nothing to exchange for.');
  }
  const { merged, conflicts } = mergePoppyPreferences(localProfile.preferences, remoteProfile.preferences);
  return {
    exchangeId: randomUUID(),
    fromAgentId: localProfile.agentId,
    toAgentId: remoteProfile.agentId,
    negotiatedVersion,
    downgraded,
    offeredProfile: localProfile,
    remoteProfile,
    intersection,
    mergedPreferences: merged,
    conflicts,
    state: 'offered',
    createdAt: now.toISOString(),
  };
}

export function acceptPoppyProfileExchange(exchange: PoppyProfileExchange): PoppyProfileExchange {
  if (exchange.state !== 'offered') {
    throw new PoppyV4Error('BAD_EXCHANGE_STATE', `Cannot accept an exchange in state ${exchange.state}.`);
  }
  return { ...exchange, state: 'accepted' };
}

export function rejectPoppyProfileExchange(exchange: PoppyProfileExchange): PoppyProfileExchange {
  if (exchange.state !== 'offered') {
    throw new PoppyV4Error('BAD_EXCHANGE_STATE', `Cannot reject an exchange in state ${exchange.state}.`);
  }
  return { ...exchange, state: 'rejected' };
}

// ---------------------------------------------------------------------------
// In-memory profile registry
// ---------------------------------------------------------------------------

export interface PoppyProfileRegistry {
  register(profile: PoppyAgentProfile): void;
  get(agentId: string): PoppyAgentProfile | undefined;
  list(): PoppyAgentProfile[];
  remove(agentId: string): boolean;
  pruneExpired(now?: Date): number;
  size(): number;
}

/** Create an in-memory registry of exchanged profiles (no disk, no network). */
export function createPoppyProfileRegistry(): PoppyProfileRegistry {
  const byId = new Map<string, PoppyAgentProfile>();
  return {
    register(profile: PoppyAgentProfile): void {
      const check = validatePoppyAgentProfile(profile);
      if (!check.ok) throw new PoppyV4Error('INVALID_PROFILE', check.errors.join(' '));
      if (byId.size >= POPPY_V4_MAX_REGISTRY_PROFILES && !byId.has(profile.agentId)) {
        throw new PoppyV4Error('REGISTRY_FULL', `Registry holds at most ${POPPY_V4_MAX_REGISTRY_PROFILES} profiles.`);
      }
      byId.set(profile.agentId, profile);
    },
    get(agentId: string): PoppyAgentProfile | undefined {
      return byId.get(agentId);
    },
    list(): PoppyAgentProfile[] {
      return [...byId.values()];
    },
    remove(agentId: string): boolean {
      return byId.delete(agentId);
    },
    pruneExpired(now: Date = new Date()): number {
      let removed = 0;
      for (const [id, profile] of [...byId.entries()]) {
        if (isPoppyProfileExpired(profile, now)) {
          byId.delete(id);
          removed += 1;
        }
      }
      return removed;
    },
    size(): number {
      return byId.size;
    },
  };
}
